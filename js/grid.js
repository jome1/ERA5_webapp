/**
 * Turns an opened NetCDF dataset into a regular (time, y, x) wind field.
 */
import { decodeTimes, parseTimeUnits } from "./ncreader.js";

const X_NAMES = ["x", "lon", "longitude", "long", "nav_lon", "rlon"];
const Y_NAMES = ["y", "lat", "latitude", "nav_lat", "rlat"];
const T_NAMES = ["time", "valid_time", "t", "times", "date"];
const PREFERRED = ["wnd100m", "wind", "wnd"];
const UV_PAIRS = [
  ["u100", "v100", "ws100"],
  ["u10", "v10", "ws10"],
  ["u10n", "v10n", "ws10n"],
  ["u", "v", "ws"],
  ["ua", "va", "ws"],
  ["uas", "vas", "ws"],
];

function findDim(dims, ds, names, test) {
  for (const n of names) if (dims.includes(n)) return n;
  for (const d of dims) if (names.includes(d.toLowerCase())) return d;
  for (const d of dims) {
    const cv = ds.vars[d];
    if (cv && test(cv.attrs)) return d;
  }
  return null;
}

const isLon = (a) =>
  a.standard_name === "longitude" || a.axis === "X" || /degrees?_?e(ast)?$/i.test(String(a.units || ""));
const isLat = (a) =>
  a.standard_name === "latitude" || a.axis === "Y" || /degrees?_?n(orth)?$/i.test(String(a.units || ""));
const isTime = (a) => a.standard_name === "time" || a.axis === "T" || parseTimeUnits(a.units) !== null;

/** Classify dims of a variable. Returns null if it is not a map variable. */
export function classify(ds, name) {
  const v = ds.vars[name];
  if (!v || v.dims.length < 2) return null;
  const xd = findDim(v.dims, ds, X_NAMES, isLon);
  const yd = findDim(v.dims, ds, Y_NAMES, isLat);
  if (!xd || !yd || xd === yd) return null;
  const td = findDim(v.dims.filter((d) => d !== xd && d !== yd), ds, T_NAMES, isTime);
  return { x: xd, y: yd, t: td };
}

/** List of plottable variables (incl. derived wind speed from u/v pairs). */
export function listVariables(ds) {
  const coordNames = new Set(Object.keys(ds.dims));
  const list = [];
  for (const name of Object.keys(ds.vars)) {
    if (coordNames.has(name)) continue;
    const c = classify(ds, name);
    if (c) list.push({ id: name, label: name, sources: [name] });
  }
  const names = new Set(list.map((l) => l.id));
  for (const [u, v, out] of UV_PAIRS) {
    if (names.has(u) && names.has(v)) {
      const cu = classify(ds, u);
      const cv = classify(ds, v);
      if (cu && cv && ds.vars[u].shape.join() === ds.vars[v].shape.join()) {
        list.unshift({ id: `__speed_${u}_${v}`, label: `${out} = √(${u}² + ${v}²)`, short: out, sources: [u, v] });
      }
    }
  }
  return list;
}

export function defaultVariable(list) {
  for (const p of PREFERRED) {
    const hit = list.find((l) => l.id === p);
    if (hit) return hit.id;
  }
  const derived = list.find((l) => l.id.startsWith("__speed_"));
  if (derived) return derived.id;
  return list.length ? list[0].id : null;
}

/** Normalise longitudes so the grid is contiguous; returns order + new lons. */
function normaliseLons(lons) {
  const n = lons.length;
  const asIs = Array.from(lons);
  const wrap180 = asIs.map((l) => ((((l + 180) % 360) + 360) % 360) - 180);
  const wrap360 = asIs.map((l) => ((l % 360) + 360) % 360);
  const maxGap = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    let g = 0;
    for (let i = 1; i < s.length; i++) g = Math.max(g, s[i] - s[i - 1]);
    return g;
  };
  if (n < 2) return { lons: asIs, order: [0], frame: "180" };
  const looksGeographic = asIs.every((l) => l >= -360 && l <= 720);
  let chosen = asIs;
  let frame = "native";
  if (looksGeographic) {
    // choose the representation with the smallest internal gap (contiguous region)
    const g180 = maxGap(wrap180);
    const g360 = maxGap(wrap360);
    if (g180 <= g360 + 1e-9) {
      chosen = wrap180;
      frame = "180";
    } else {
      chosen = wrap360;
      frame = "360";
    }
  }
  const order = chosen.map((_, i) => i).sort((a, b) => chosen[a] - chosen[b]);
  return { lons: order.map((i) => chosen[i]), order, frame };
}

/**
 * Build the field for a variable id from listVariables.
 * Returns { name, units, lons, lats, nx, ny, nt, times, data(Float32Array t*ny*nx), frame }
 */
export function buildField(ds, varInfo) {
  const first = varInfo.sources[0];
  const c = classify(ds, first);
  const v = ds.vars[first];

  // coordinate values
  const coordVals = (dim) => {
    if (ds.vars[dim] && ds.vars[dim].dims.length === 1) return Array.from(ds.read(dim));
    return Array.from({ length: ds.dims[dim] }, (_, i) => i);
  };
  const rawLons = coordVals(c.x);
  const rawLats = coordVals(c.y);
  const nx = rawLons.length;
  const ny = rawLats.length;
  const nt = c.t ? ds.dims[c.t] ?? v.shape[v.dims.indexOf(c.t)] : 1;

  let times = null;
  if (c.t && ds.vars[c.t]) {
    times = decodeTimes(ds.readRaw(c.t), ds.vars[c.t].attrs);
  }
  if (!times) times = Array.from({ length: nt }, (_, i) => i + 1); // fall back to index

  const lonInfo = normaliseLons(rawLons);
  const latOrder = rawLats.map((_, i) => i).sort((a, b) => rawLats[a] - rawLats[b]);
  const lats = latOrder.map((i) => rawLats[i]);

  // strides in the source array
  const shape = v.shape;
  const strides = new Array(shape.length);
  let s = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    strides[k] = s;
    s *= shape[k];
  }
  const ax = v.dims.indexOf(c.x);
  const ay = v.dims.indexOf(c.y);
  const at = c.t ? v.dims.indexOf(c.t) : -1;
  const extra = v.dims.filter((d, k) => k !== ax && k !== ay && k !== at);
  // other dims (e.g. level, ensemble member) are fixed at index 0

  const arrays = varInfo.sources.map((name) => ds.read(name));
  const data = new Float32Array(nt * ny * nx);
  const sx = strides[ax];
  const sy = strides[ay];
  const st = at >= 0 ? strides[at] : 0;
  const xOff = Int32Array.from(lonInfo.order, (i) => i * sx);
  const isSpeed = arrays.length === 2;
  const A = arrays[0];
  const B = arrays[1];
  for (let t = 0; t < nt; t++) {
    const tBase = t * st;
    for (let j = 0; j < ny; j++) {
      const rowBase = tBase + latOrder[j] * sy;
      const outBase = (t * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const idx = rowBase + xOff[i];
        data[outBase + i] = isSpeed ? Math.hypot(A[idx], B[idx]) : A[idx];
      }
    }
  }

  const units = String(v.attrs.units || "m/s").replace(/^m s(\*\*|\^)?-1$/, "m/s");
  return {
    name: varInfo.short || varInfo.id,
    label: varInfo.label,
    units,
    lons: lonInfo.lons,
    lats,
    nx,
    ny,
    nt,
    times,
    timeIsDate: times.length > 0 && times[0] instanceof Date,
    data,
    frame: lonInfo.frame,
    dimNames: c,
    extraDims: extra,
  };
}

/** Mean over time ignoring NaN, plus min/max helpers. */
export function timeMean(field) {
  const { nx, ny, nt, data } = field;
  const n = nx * ny;
  const sum = new Float64Array(n);
  const cnt = new Uint32Array(n);
  for (let t = 0; t < nt; t++) {
    const base = t * n;
    for (let k = 0; k < n; k++) {
      const v = data[base + k];
      if (!Number.isNaN(v)) {
        sum[k] += v;
        cnt[k]++;
      }
    }
  }
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  return out;
}

export function minMax(arr) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < arr.length; k++) {
    const v = arr[k];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 0.5, hi + 0.5];
  return [lo, hi];
}
