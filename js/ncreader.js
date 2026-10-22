/**
 * Minimal NetCDF reader for the browser.
 *
 * Supports
 *   - NetCDF-3 (classic / 64-bit offset) via netcdfjs
 *   - NetCDF-4 (HDF5 based, incl. zlib compression) via h5wasm
 *
 * Both are wrapped in the same small interface:
 *   ds.dims            -> { name: size }
 *   ds.vars            -> { name: { name, dims: [..], shape: [..], attrs: {..} } }
 *   ds.read(name)      -> Float64Array with scale_factor/add_offset applied and
 *                         fill / missing values replaced by NaN (C order)
 *   ds.readRaw(name)   -> raw values as a plain numeric array-like (used for time)
 *   ds.close()
 */

const NC_DEFAULT_FILL_LIMIT = 1e30; // netCDF default fill for floats is 9.96921e36

function attrScalar(v) {
  if (v === undefined || v === null) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return v;
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    if (v.length === 1) return attrScalar(v[0]);
    return Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
  }
  return v;
}

function toNumberArray(arr) {
  if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]);
    return out;
  }
  if (typeof arr === "number" || typeof arr === "bigint") return new Float64Array([Number(arr)]);
  if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) return Float64Array.from(arr.flat(Infinity));
  return arr;
}

/** Apply CF decoding: fill values -> NaN, then scale_factor / add_offset. */
function decode(raw, attrs) {
  raw = toNumberArray(raw);
  const n = raw.length;
  const out = new Float64Array(n);
  const fills = [];
  for (const key of ["_FillValue", "missing_value"]) {
    const f = attrs[key];
    if (f === undefined || f === null) continue;
    if (Array.isArray(f)) fills.push(...f.map(Number));
    else if (!Number.isNaN(Number(f))) fills.push(Number(f));
  }
  const scale = attrs.scale_factor !== undefined && attrs.scale_factor !== null ? Number(attrs.scale_factor) : 1;
  const offset = attrs.add_offset !== undefined && attrs.add_offset !== null ? Number(attrs.add_offset) : 0;
  const nf = fills.length;
  const f0 = fills[0];
  const f1 = fills[1];
  for (let i = 0; i < n; i++) {
    const v = Number(raw[i]);
    if (Number.isNaN(v) || Math.abs(v) > NC_DEFAULT_FILL_LIMIT || (nf > 0 && v === f0) || (nf > 1 && v === f1)) {
      out[i] = NaN;
    } else {
      out[i] = v * scale + offset;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* NetCDF-3                                                           */
/* ------------------------------------------------------------------ */
async function openNetCDF3(buffer, libs) {
  const reader = new libs.NetCDFReader(buffer);
  const dims = {};
  const dimNames = [];
  for (const d of reader.dimensions) {
    let size = d.size;
    if (reader.recordDimension && reader.recordDimension.name === d.name) {
      size = reader.recordDimension.length;
    }
    dims[d.name] = size;
    dimNames.push(d.name);
  }
  const vars = {};
  for (const v of reader.variables) {
    const attrs = {};
    for (const a of v.attributes) attrs[a.name] = a.value === null ? NaN : attrScalar(a.value);
    const vd = v.dimensions.map((i) => dimNames[i]);
    vars[v.name] = { name: v.name, dims: vd, shape: vd.map((d) => dims[d]), attrs };
  }
  const flat = (name) => {
    let d = reader.getDataVariable(name);
    if (Array.isArray(d) && d.length && (Array.isArray(d[0]) || ArrayBuffer.isView(d[0]))) {
      d = Float64Array.from(d.flatMap((x) => Array.from(x)));
    }
    return d;
  };
  return {
    format: "NetCDF-3",
    dims,
    vars,
    readRaw: (name) => toNumberArray(flat(name)),
    read: (name) => decode(flat(name), vars[name].attrs),
    close: () => {},
  };
}

/* ------------------------------------------------------------------ */
/* NetCDF-4 / HDF5                                                     */
/* ------------------------------------------------------------------ */
let h5counter = 0;

async function openNetCDF4(buffer, libs) {
  const h5wasm = libs.h5wasm;
  const Module = await h5wasm.ready;
  const fname = `upload_${Date.now()}_${h5counter++}.nc`;
  Module.FS.writeFile(fname, new Uint8Array(buffer));
  const file = new h5wasm.File(fname, "r");

  const readAttrs = (obj) => {
    const out = {};
    let entries = {};
    try {
      entries = obj.attrs;
    } catch (e) {
      return out;
    }
    for (const [k, a] of Object.entries(entries)) {
      if (k === "DIMENSION_LIST" || k === "REFERENCE_LIST") continue;
      try {
        let v = a.value;
        if (v === null) v = NaN;
        else if (ArrayBuffer.isView(v) && v.length === 1 && v[0] === null) v = NaN;
        out[k] = attrScalar(v);
      } catch (e) {
        /* ignore unreadable attributes */
      }
    }
    return out;
  };

  // Collect datasets in the root group
  const datasets = {};
  for (const key of file.keys()) {
    let obj;
    try {
      obj = file.get(key);
    } catch (e) {
      continue;
    }
    if (!obj || obj.type !== "Dataset") continue;
    datasets[key] = { obj, attrs: readAttrs(obj), shape: obj.shape || [] };
  }

  // Dimensions: datasets that are HDF5 dimension scales
  const dimById = {};
  const dims = {};
  for (const [name, d] of Object.entries(datasets)) {
    if (d.attrs.CLASS === "DIMENSION_SCALE") {
      dims[name] = d.shape[0] ?? 0;
      if (d.attrs._Netcdf4Dimid !== undefined) dimById[Number(d.attrs._Netcdf4Dimid)] = name;
    }
  }

  const vars = {};
  for (const [name, d] of Object.entries(datasets)) {
    const a = d.attrs;
    const isPhantomDim =
      a.CLASS === "DIMENSION_SCALE" && typeof a.NAME === "string" && a.NAME.startsWith("This is a netCDF dimension");
    if (isPhantomDim) continue;
    const shape = d.shape.map(Number);
    let vdims = null;

    // 1) netCDF-C writes _Netcdf4Coordinates = list of dim ids
    const coordsAttr = a._Netcdf4Coordinates;
    if (coordsAttr !== undefined) {
      const ids = Array.isArray(coordsAttr) ? coordsAttr : [coordsAttr];
      if (ids.length === shape.length && ids.every((i) => dimById[Number(i)] !== undefined)) {
        vdims = ids.map((i) => dimById[Number(i)]);
      }
    }
    // 2) a dimension scale is its own dimension
    if (!vdims && a.CLASS === "DIMENSION_SCALE" && shape.length === 1) vdims = [name];
    // 3) fall back to matching lengths against known dimensions
    if (!vdims) {
      const used = new Set();
      vdims = shape.map((n, axis) => {
        const cand = Object.keys(dims).filter((k) => dims[k] === n && !used.has(k));
        const pick = cand[0] ?? `dim_${axis}_${n}`;
        used.add(pick);
        if (!(pick in dims)) dims[pick] = n;
        return pick;
      });
    }
    // strip internal attributes
    const attrs = {};
    for (const [k, v] of Object.entries(a)) if (!k.startsWith("_Netcdf4") && k !== "CLASS" && k !== "NAME") attrs[k] = v;
    vars[name] = { name, dims: vdims, shape, attrs };
  }

  const raw = (name) => datasets[name].obj.value;

  return {
    format: "NetCDF-4",
    dims,
    vars,
    readRaw: (name) => toNumberArray(raw(name)),
    read: (name) => decode(raw(name), vars[name].attrs),
    close: () => {
      try {
        file.close();
      } catch (e) {}
      try {
        Module.FS.unlink(fname);
      } catch (e) {}
    },
  };
}

export async function openNetCDF(buffer, libs) {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  const ascii = String.fromCharCode(...head.slice(0, 3));
  if (ascii === "CDF") {
    if (head[3] === 5) throw new Error("NetCDF-3 64-bit data (CDF5) is not supported. Convert to NetCDF-4.");
    return openNetCDF3(buffer, libs);
  }
  if (head[0] === 0x89 && head[1] === 0x48 && head[2] === 0x44 && head[3] === 0x46) {
    return openNetCDF4(buffer, libs);
  }
  // HDF5 superblock may also start at 512, 1024, ... bytes
  for (let off = 512; off < Math.min(buffer.byteLength, 1 << 20); off *= 2) {
    const h = new Uint8Array(buffer, off, 4);
    if (h[0] === 0x89 && h[1] === 0x48 && h[2] === 0x44 && h[3] === 0x46) return openNetCDF4(buffer, libs);
  }
  throw new Error("This does not look like a NetCDF file (neither NetCDF-3 nor NetCDF-4/HDF5).");
}

/* ------------------------------------------------------------------ */
/* CF time decoding                                                    */
/* ------------------------------------------------------------------ */
const UNIT_MS = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
  minute: 60000, minutes: 60000, min: 60000, mins: 60000,
  hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000, h: 3600000,
  day: 86400000, days: 86400000, d: 86400000,
  millisecond: 1, milliseconds: 1, ms: 1,
};

export function parseTimeUnits(units) {
  if (typeof units !== "string") return null;
  const m = units.trim().match(/^(\w+)\s+since\s+(.+)$/i);
  if (!m) return null;
  const ms = UNIT_MS[m[1].toLowerCase()];
  if (!ms) return null;
  let ref = m[2].trim();
  // normalise "1900-1-1 0:0:0.0" -> "1900-01-01T00:00:00"
  const dm = ref.match(/^(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{1,2}:?\d{0,2})?$/i);
  if (!dm) return null;
  const [, Y, Mo, D, hh = "0", mi = "0", ss = "0", frac = "0"] = dm;
  let base = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(hh), Number(mi), Number(ss), Math.round(Number("0." + frac) * 1000));
  if (Number(Y) < 100) {
    const d = new Date(base);
    d.setUTCFullYear(Number(Y));
    base = d.getTime();
  }
  const tz = dm[8];
  if (tz && /^[+-]/.test(tz)) {
    const t = tz.replace(":", "");
    const sign = t[0] === "-" ? -1 : 1;
    const hours = Number(t.slice(1, 3) || 0);
    const mins = Number(t.slice(3, 5) || 0);
    base -= sign * (hours * 60 + mins) * 60000;
  }
  return { ms, base };
}

export function decodeTimes(values, attrs) {
  const u = parseTimeUnits(attrs && attrs.units);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = u ? new Date(u.base + Number(values[i]) * u.ms) : null;
  }
  return u ? out : null;
}
