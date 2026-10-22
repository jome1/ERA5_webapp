/**
 * Wind Map Viewer — browser port of ERA5_wind_app.py
 *
 * - Drag & drop a NetCDF file -> mean / single-timestep wind map
 * - Hover a cell -> value + blue outline; click a cell -> red outline + time series
 * - Timestep stepping and animation, time-series range selection
 * - Drag & drop GeoJSON files -> polygon outlines on the same map
 */
import h5wasm from "../lib/hdf5_hl.js";
import { NetCDFReader } from "../lib/netcdfjs.esm.js";
import { openNetCDF } from "./ncreader.js";
import { listVariables, defaultVariable, buildField, timeMean, minMax } from "./grid.js";
import { geojsonToOutlines } from "./geo.js";

const Plotly = window.Plotly;
const topojson = window.topojson;
const $ = (id) => document.getElementById(id);

const GEO_COLORS = ["#ff2bd6", "#ff8c00", "#00e5ff", "#ffffff", "#ffd400", "#ff4d4d", "#9dff00"];

const state = {
  ds: null,
  fileName: null,
  varList: [],
  varId: null,
  field: null,
  mean: null,
  meanRange: [0, 1],
  stepRange: [0, 1],
  mode: "mean",
  step: 1, // 1-based like the original app
  selected: null, // {i, j}
  hover: null, // {i, j}
  geo: [], // {name, geojson, color, nPolys}
  world: null, // {coast: [[lon,lat],...][], borders: ...}
  animating: false,
  animTimer: null,
  mapReady: false,
  busy: false,
};

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */
function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

/* ------------------------------------------------------------------ */
/* Coastlines / borders (Natural Earth 1:50m via world-atlas)          */
/* ------------------------------------------------------------------ */
async function loadWorld() {
  try {
    const topo = await (await fetch("lib/countries-50m.json")).json();
    const obj = topo.objects.countries;
    const coast = topojson.mesh(topo, obj, (a, b) => a === b).coordinates;
    const borders = topojson.mesh(topo, obj, (a, b) => a !== b).coordinates;
    state.world = { coast, borders };
  } catch (e) {
    console.warn("Could not load coastlines", e);
    state.world = { coast: [], borders: [] };
  }
}

/** Convert a list of lines into Plotly x/y arrays (null separated), clipped to a box. */
function linesToXY(lines, box, shift360) {
  const x = [];
  const y = [];
  const inBox = (lo, la) => !box || (lo >= box[0] && lo <= box[1] && la >= box[2] && la <= box[3]);
  for (const line of lines) {
    let open = false;
    for (let k = 0; k < line.length; k++) {
      let lo = line[k][0];
      const la = line[k][1];
      if (shift360 && lo < 0) lo += 360;
      const ok = inBox(lo, la);
      if (ok) {
        if (!open && k > 0) {
          // include previous point so the line enters the box nicely
          let plo = line[k - 1][0];
          if (shift360 && plo < 0) plo += 360;
          if (Math.abs(plo - lo) < 180) {
            x.push(plo);
            y.push(line[k - 1][1]);
          }
        }
        // break the line when it jumps across the antimeridian
        if (open && Math.abs(x[x.length - 1] - lo) > 180) {
          x.push(null);
          y.push(null);
        }
        x.push(lo);
        y.push(la);
        open = true;
      } else if (open) {
        if (Math.abs(x[x.length - 1] - lo) < 180) {
          x.push(lo);
          y.push(la);
        }
        x.push(null);
        y.push(null);
        open = false;
      }
    }
    if (open) {
      x.push(null);
      y.push(null);
    }
  }
  return { x, y };
}

/* ------------------------------------------------------------------ */
/* Map building                                                        */
/* ------------------------------------------------------------------ */
function cellEdges(c) {
  // edges between cell centres (handles irregular spacing)
  const n = c.length;
  const e = new Float64Array(n + 1);
  if (n === 1) {
    e[0] = c[0] - 0.05;
    e[1] = c[0] + 0.05;
    return e;
  }
  for (let k = 1; k < n; k++) e[k] = (c[k - 1] + c[k]) / 2;
  e[0] = c[0] - (c[1] - c[0]) / 2;
  e[n] = c[n - 1] + (c[n - 1] - c[n - 2]) / 2;
  return e;
}

function currentGrid() {
  const f = state.field;
  if (state.mode === "mean") return state.mean;
  const n = f.nx * f.ny;
  const t = state.step - 1;
  return f.data.subarray(t * n, (t + 1) * n);
}

function gridToZ(grid) {
  const f = state.field;
  const z = new Array(f.ny);
  for (let j = 0; j < f.ny; j++) z[j] = Array.from(grid.subarray(j * f.nx, (j + 1) * f.nx));
  return z;
}

function mapTitle() {
  const f = state.field;
  if (!f) return "";
  if (state.mode === "mean") return `Mean Wind Speed (${f.name})`;
  return `Wind Speed - Timestep ${state.step} (${f.name})`;
}

function dataBox() {
  const f = state.field;
  if (!f) {
    const b = geoBounds();
    if (b) {
      const px = Math.max((b[1] - b[0]) * 0.15, 0.5);
      const py = Math.max((b[3] - b[2]) * 0.15, 0.5);
      return [b[0] - px, b[1] + px, b[2] - py, b[3] + py];
    }
    return [-180, 180, -90, 90];
  }
  const ex = cellEdges(f.lons);
  const ey = cellEdges(f.lats);
  const lonMin = ex[0];
  const lonMax = ex[ex.length - 1];
  const latMin = ey[0];
  const latMax = ey[ey.length - 1];
  const px = (lonMax - lonMin) * 0.1;
  const py = (latMax - latMin) * 0.1;
  return [lonMin - px, lonMax + px, latMin - py, latMax + py];
}

function geoBounds() {
  let b = null;
  for (const g of state.geo) {
    for (const xy of [g.outlines]) {
      for (let k = 0; k < xy.x.length; k++) {
        const x = xy.x[k];
        const y = xy.y[k];
        if (x === null) continue;
        if (!b) b = [x, x, y, y];
        else {
          b[0] = Math.min(b[0], x);
          b[1] = Math.max(b[1], x);
          b[2] = Math.min(b[2], y);
          b[3] = Math.max(b[3], y);
        }
      }
    }
  }
  return b;
}

function shift360() {
  return state.field ? state.field.frame === "360" : false;
}

function buildGeoTraces() {
  const shift = shift360();
  return state.geo.map((g) => {
    const xy = geojsonToOutlinesShifted(g, shift);
    return {
      type: "scatter",
      mode: "lines",
      x: xy.x,
      y: xy.y,
      line: { color: g.color, width: 2 },
      name: g.name,
      hoverinfo: "skip",
      showlegend: true,
      connectgaps: false,
    };
  });
}

function geojsonToOutlinesShifted(g, shift) {
  if (!shift) return g.outlines;
  return {
    x: g.outlines.x.map((v) => (v !== null && v < 0 ? v + 360 : v)),
    y: g.outlines.y,
  };
}

function worldTraces(box) {
  if (!state.world) return [];
  // generous clip box so panning out still shows context
  let clip = null;
  if (box && state.field) {
    const w = box[1] - box[0];
    const h = box[3] - box[2];
    const m = Math.max(w, h, 20);
    clip = [box[0] - m, box[1] + m, box[2] - m, box[3] + m];
  }
  const shift = shift360();
  const coast = linesToXY(state.world.coast, clip, shift);
  const borders = linesToXY(state.world.borders, clip, shift);
  return [
    { type: "scatter", mode: "lines", x: coast.x, y: coast.y, line: { color: "#111", width: 0.8 }, hoverinfo: "skip", showlegend: false, name: "coast" },
    { type: "scatter", mode: "lines", x: borders.x, y: borders.y, line: { color: "#333", width: 0.6, dash: "dot" }, hoverinfo: "skip", showlegend: false, name: "borders" },
  ];
}

function rectShape(i, j, color, width) {
  const ex = state._ex;
  const ey = state._ey;
  return {
    type: "rect",
    xref: "x",
    yref: "y",
    x0: ex[i],
    x1: ex[i + 1],
    y0: ey[j],
    y1: ey[j + 1],
    line: { color, width },
    fillcolor: "rgba(0,0,0,0)",
    layer: "above",
  };
}

function shapes() {
  const s = [];
  if (!state.field) return s;
  if (state.hover) s.push(rectShape(state.hover.i, state.hover.j, "#1f4fff", 1.5));
  if (state.selected) s.push(rectShape(state.selected.i, state.selected.j, "#ff0000", 2.5));
  return s;
}

function baseLayout(box) {
  const hasData = !!state.field;
  return {
    margin: { l: 55, r: 15, t: 40, b: 40 },
    title: { text: hasData ? `<b>${mapTitle()}</b>` : "", font: { size: 14 } },
    xaxis: {
      range: [box[0], box[1]],
      title: { text: "Longitude (°)", font: { size: 11 } },
      showgrid: true,
      gridcolor: "rgba(0,0,0,0.15)",
      griddash: "dash",
      zeroline: false,
      ticksuffix: "°",
      constrain: "domain",
    },
    yaxis: {
      range: [box[2], box[3]],
      title: { text: "Latitude (°)", font: { size: 11 } },
      showgrid: true,
      gridcolor: "rgba(0,0,0,0.15)",
      griddash: "dash",
      zeroline: false,
      ticksuffix: "°",
      scaleanchor: "x",
      scaleratio: 1, // Plate Carrée, like the original cartopy map
      constrain: "domain",
    },
    plot_bgcolor: "#f3f4f1",
    paper_bgcolor: "#ffffff",
    dragmode: "pan",
    hovermode: "closest",
    showlegend: state.geo.length > 0,
    legend: { orientation: "h", x: 0, y: 1.0, yanchor: "bottom", bgcolor: "rgba(255,255,255,0.8)", font: { size: 11 } },
    shapes: shapes(),
    annotations: hasData
      ? []
      : [
          {
            text: state.geo.length ? "Drop a NetCDF file to add wind data" : "Drop a NetCDF file to begin",
            xref: "paper",
            yref: "paper",
            x: 0.5,
            y: 0.5,
            showarrow: false,
            font: { size: 16, color: "#888" },
            bgcolor: "rgba(255,255,255,0.85)",
          },
        ],
    uirevision: state.fileName || "empty",
  };
}

function heatmapTrace() {
  const f = state.field;
  const [zmin, zmax] = state.mode === "mean" ? state.meanRange : state.stepRange;
  return {
    type: "heatmap",
    x: f.lons,
    y: f.lats,
    z: gridToZ(currentGrid()),
    zmin,
    zmax,
    colorscale: "Viridis",
    zsmooth: false,
    hoverongaps: false,
    hovertemplate: `lon %{x:.3f}°, lat %{y:.3f}°<br><b>%{z:.2f} ${f.units}</b><extra></extra>`,
    colorbar: {
      orientation: "h",
      thickness: 14,
      len: 0.8,
      y: -0.12,
      yanchor: "top",
      title: { text: `${f.name} (${f.units})`, side: "bottom", font: { size: 12 } },
    },
  };
}

async function drawMap({ resetView = false } = {}) {
  const box = dataBox();
  const traces = [];
  if (state.field) traces.push(heatmapTrace());
  traces.push(...worldTraces(box));
  traces.push(...buildGeoTraces());
  const layout = baseLayout(box);
  if (resetView) layout.uirevision = `${state.fileName || "empty"}-${Date.now()}`;
  layout.margin.b = state.field ? 95 : 40;
  await Plotly.react("map", traces, layout, {
    responsive: true,
    scrollZoom: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
    toImageButtonOptions: { filename: "wind_map", scale: 2 },
  });
  if (!state.mapReady) {
    bindMapEvents();
    state.mapReady = true;
  }
}

/** Fast path: only update colours + title (used for stepping / animation). */
async function updateHeatmap() {
  if (!state.field) return;
  const [zmin, zmax] = state.mode === "mean" ? state.meanRange : state.stepRange;
  await Plotly.update("map", { z: [gridToZ(currentGrid())], zmin: [zmin], zmax: [zmax] }, { "title.text": `<b>${mapTitle()}</b>` }, [0]);
}

function updateShapes() {
  if (!state.mapReady) return;
  Plotly.relayout("map", { shapes: shapes() });
}

/* ------------------------------------------------------------------ */
/* Map events                                                          */
/* ------------------------------------------------------------------ */
function bindMapEvents() {
  const el = $("map");
  let hoverPending = null;
  el.on("plotly_hover", (ev) => {
    const p = ev.points && ev.points[0];
    if (!p || p.data.type !== "heatmap" || !state.field) return;
    const [j, i] = p.pointIndex;
    if (state.hover && state.hover.i === i && state.hover.j === j) return;
    state.hover = { i, j };
    const f = state.field;
    $("coords").textContent = `${selectedText()}   |   Hover: (${f.lons[i].toFixed(3)}, ${f.lats[j].toFixed(3)})  ${fmt(p.z)} ${f.units}`;
    if (!hoverPending) {
      hoverPending = requestAnimationFrame(() => {
        hoverPending = null;
        updateShapes();
      });
    }
  });
  el.on("plotly_unhover", () => {
    if (!state.hover) return;
    state.hover = null;
    $("coords").textContent = selectedText();
    updateShapes();
  });
  el.on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (!p || p.data.type !== "heatmap" || !state.field) return;
    const [j, i] = p.pointIndex;
    state.selected = { i, j };
    $("coords").textContent = selectedText();
    updateShapes();
    drawTimeSeries();
  });
}

function fmt(v) {
  return v === null || v === undefined || Number.isNaN(v) ? "NaN" : Number(v).toFixed(2);
}

function selectedText() {
  if (!state.selected || !state.field) return "Selected: --";
  const f = state.field;
  return `Selected: (${f.lons[state.selected.i].toFixed(3)}, ${f.lats[state.selected.j].toFixed(3)})`;
}

/* ------------------------------------------------------------------ */
/* Time series                                                         */
/* ------------------------------------------------------------------ */
function drawEmptyTimeSeries(msg = "Click on the map to see time series") {
  Plotly.react(
    "ts",
    [],
    {
      margin: { l: 50, r: 20, t: 40, b: 50 },
      xaxis: { visible: false },
      yaxis: { visible: false },
      annotations: [{ text: msg, xref: "paper", yref: "paper", x: 0.5, y: 0.5, showarrow: false, font: { size: 15, color: "#888" } }],
      paper_bgcolor: "#fff",
      plot_bgcolor: "#fff",
    },
    { responsive: true, displaylogo: false }
  );
}

function clampRange() {
  const f = state.field;
  let a = parseInt($("tsFirst").value, 10);
  let b = parseInt($("tsLast").value, 10);
  if (!Number.isFinite(a)) a = 1;
  if (!Number.isFinite(b)) b = f.nt;
  a = Math.min(Math.max(1, a), f.nt);
  b = Math.min(Math.max(1, b), f.nt);
  if (b < a) [a, b] = [b, a];
  $("tsFirst").value = a;
  $("tsLast").value = b;
  return [a, b];
}

function drawTimeSeries() {
  const f = state.field;
  if (!f || !state.selected) {
    drawEmptyTimeSeries();
    return;
  }
  const { i, j } = state.selected;
  const [a, b] = clampRange();
  const n = f.nx * f.ny;
  const xs = [];
  const ys = [];
  let sum = 0;
  let cnt = 0;
  for (let t = a - 1; t < b; t++) {
    const v = f.data[t * n + j * f.nx + i];
    xs.push(f.times[t]);
    ys.push(Number.isNaN(v) ? null : v);
    if (!Number.isNaN(v)) {
      sum += v;
      cnt++;
    }
  }
  const mean = cnt ? sum / cnt : NaN;
  const traces = [
    {
      type: "scatter",
      mode: "lines",
      x: xs,
      y: ys,
      line: { color: "#1f3fff", width: 1.5 },
      name: f.name,
      hovertemplate: `%{x}<br><b>%{y:.2f} ${f.units}</b><extra></extra>`,
    },
  ];
  const layout = {
    margin: { l: 60, r: 20, t: 45, b: 60 },
    title: { text: `<b>Time Series at (${f.lons[i].toFixed(2)}°, ${f.lats[j].toFixed(2)}°)</b>`, font: { size: 14 } },
    xaxis: { title: { text: f.timeIsDate ? "Time" : "Timestep", font: { size: 11 } }, type: f.timeIsDate ? "date" : "linear", gridcolor: "rgba(0,0,0,0.1)" },
    yaxis: { title: { text: `${f.name} (${f.units})`, font: { size: 11 } }, gridcolor: "rgba(0,0,0,0.1)", zeroline: false },
    showlegend: false,
    paper_bgcolor: "#fff",
    plot_bgcolor: "#fff",
    hovermode: "x unified",
    shapes: Number.isFinite(mean)
      ? [{ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: mean, y1: mean, line: { color: "red", width: 2, dash: "dash" } }]
      : [],
    annotations: Number.isFinite(mean)
      ? [
          {
            text: `Mean wind speed = ${mean.toFixed(2)} ${f.units}`,
            xref: "paper",
            yref: "paper",
            x: 0.02,
            y: 0.98,
            xanchor: "left",
            yanchor: "top",
            showarrow: false,
            font: { color: "red", size: 13 },
            bgcolor: "rgba(245,222,179,0.6)",
            bordercolor: "rgba(0,0,0,0.25)",
            borderpad: 5,
          },
        ]
      : [],
  };
  Plotly.react("ts", traces, layout, { responsive: true, displaylogo: false, toImageButtonOptions: { filename: "wind_timeseries", scale: 2 } });
}

/* ------------------------------------------------------------------ */
/* Timestep controls & animation                                       */
/* ------------------------------------------------------------------ */
function fmtTime(t) {
  if (t instanceof Date) return t.toISOString().replace("T", " ").replace(/:00\.000Z$/, "").replace(/\.000Z$/, "") + " UTC";
  return "";
}

function syncTimestepUI() {
  const f = state.field;
  $("tsInput").value = state.step;
  $("tsSlider").value = state.step;
  $("tsTime").textContent = f ? fmtTime(f.times[state.step - 1]) : "";
}

async function setStep(s, { fromAnimation = false } = {}) {
  if (!state.field) return;
  if (!fromAnimation && state.animating) stopAnimation();
  s = Math.min(Math.max(1, Math.round(s) || 1), state.field.nt);
  state.step = s;
  syncTimestepUI();
  await updateHeatmap();
}

function startAnimation() {
  if (!state.field) return;
  if (state.step >= state.field.nt) state.step = 0; // restart from beginning when at the end
  state.animating = true;
  $("animBtn").textContent = "Stop Animation";
  animateStep();
}

function stopAnimation() {
  state.animating = false;
  $("animBtn").textContent = "Start Animation";
  if (state.animTimer) clearTimeout(state.animTimer);
  state.animTimer = null;
}

async function animateStep() {
  if (!state.animating) return;
  if (state.step >= state.field.nt) {
    stopAnimation();
    return;
  }
  await setStep(state.step + 1, { fromAnimation: true });
  if (!state.animating) return;
  state.animTimer = setTimeout(animateStep, Number($("speedSelect").value));
}

/* ------------------------------------------------------------------ */
/* Loading files                                                       */
/* ------------------------------------------------------------------ */
async function loadNetCDF(file) {
  if (state.busy) return;
  state.busy = true;
  stopAnimation();
  setStatus(`Reading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);
  try {
    const buf = await file.arrayBuffer();
    const ds = await openNetCDF(buf, { h5wasm, NetCDFReader });
    const list = listVariables(ds);
    if (!list.length) throw new Error("No variable with longitude/latitude dimensions found in this file.");
    if (state.ds) state.ds.close();
    state.ds = ds;
    state.fileName = file.name;
    state.varList = list;
    const sel = $("varSelect");
    sel.innerHTML = "";
    for (const v of list) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.label;
      sel.appendChild(o);
    }
    sel.value = defaultVariable(list);
    sel.disabled = list.length < 2;
    $("ncName").textContent = file.name;
    $("ncName").title = file.name;
    $("ncChip").classList.add("loaded");
    await selectVariable(sel.value, { resetView: true });
    const f = state.field;
    setStatus(`${ds.format} · ${f.nx}×${f.ny} cells · ${f.nt} timesteps${f.extraDims.length ? ` · using first index of ${f.extraDims.join(", ")}` : ""}`, "ok");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to load NetCDF file: ${e.message || e}`, "error");
    alert(`Failed to load NetCDF file:\n${e.message || e}`);
  } finally {
    state.busy = false;
  }
}

async function selectVariable(id, { resetView = false } = {}) {
  const info = state.varList.find((v) => v.id === id);
  setStatus(`Processing ${info.label}…`);
  await new Promise((r) => setTimeout(r, 0)); // let the status paint
  const field = buildField(state.ds, info);
  state.varId = id;
  state.field = field;
  state.mean = timeMean(field);
  state.meanRange = minMax(state.mean);
  state.stepRange = minMax(field.data);
  state._ex = cellEdges(field.lons);
  state._ey = cellEdges(field.lats);
  state.selected = null;
  state.hover = null;
  state.step = 1;

  $("modeSelect").disabled = false;
  $("tsInput").max = field.nt;
  $("tsSlider").max = field.nt;
  $("tsMax").textContent = `/ ${field.nt}`;
  $("tsFirst").max = field.nt;
  $("tsLast").max = field.nt;
  $("tsFirst").value = 1;
  $("tsLast").value = field.nt;
  $("coords").textContent = "Selected: --";
  syncTimestepUI();
  drawEmptyTimeSeries();
  await drawMap({ resetView });
}

async function loadGeoJSON(file) {
  try {
    const text = await file.text();
    const gj = JSON.parse(text);
    const { outlines, nPolygons, warnings } = geojsonToOutlines(gj);
    if (!outlines.x.length) throw new Error("No Polygon / MultiPolygon geometries found.");
    const color = GEO_COLORS[state.geo.length % GEO_COLORS.length];
    state.geo.push({ name: file.name, outlines, color, nPolys: nPolygons });
    updateGeoChip();
    await drawMap({ resetView: !state.field });
    setStatus(`Added ${nPolygons} polygon${nPolygons === 1 ? "" : "s"} from ${file.name}${warnings.length ? " · " + warnings.join(" ") : ""}`, warnings.length ? "error" : "ok");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to load GeoJSON ${file.name}: ${e.message || e}`, "error");
    alert(`Failed to load GeoJSON file:\n${e.message || e}`);
  }
}

function updateGeoChip() {
  const n = state.geo.length;
  const polys = state.geo.reduce((s, g) => s + g.nPolys, 0);
  $("gjName").textContent = n ? `${n === 1 ? state.geo[0].name : n + " files"} · ${polys} polygon${polys === 1 ? "" : "s"}` : "Drop .geojson files to overlay polygon outlines";
  $("gjName").title = state.geo.map((g) => g.name).join(", ");
  $("gjChip").classList.toggle("loaded", n > 0);
  $("gjClear").hidden = n === 0;
}

function routeFiles(files) {
  const list = Array.from(files || []);
  const nc = list.filter((f) => /\.(nc|nc4|cdf|netcdf|h5|hdf5)$/i.test(f.name));
  const gj = list.filter((f) => /\.(geojson|json)$/i.test(f.name));
  const other = list.filter((f) => !nc.includes(f) && !gj.includes(f));
  (async () => {
    for (const f of gj) await loadGeoJSON(f);
    if (nc.length) await loadNetCDF(nc[nc.length - 1]);
    if (other.length) setStatus(`Ignored ${other.map((f) => f.name).join(", ")} — use .nc or .geojson files`, "error");
  })();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function wire() {
  // Drag & drop anywhere on the page
  let depth = 0;
  const overlay = $("dropOverlay");
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    routeFiles(e.dataTransfer.files);
  });

  $("ncInput").addEventListener("change", (e) => {
    routeFiles(e.target.files);
    e.target.value = "";
  });
  $("gjInput").addEventListener("change", (e) => {
    routeFiles(e.target.files);
    e.target.value = "";
  });
  $("gjClear").addEventListener("click", async () => {
    state.geo = [];
    updateGeoChip();
    await drawMap();
    setStatus("Polygon overlays cleared");
  });

  $("varSelect").addEventListener("change", async (e) => {
    stopAnimation();
    await selectVariable(e.target.value);
    setStatus(`Showing ${state.field.label}`, "ok");
  });

  $("modeSelect").addEventListener("change", async (e) => {
    stopAnimation();
    state.mode = e.target.value;
    $("timestepCtl").hidden = state.mode !== "single";
    syncTimestepUI();
    await updateHeatmap();
  });

  $("tsMinus").addEventListener("click", () => setStep(state.step - 1));
  $("tsPlus").addEventListener("click", () => setStep(state.step + 1));
  $("tsInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") setStep(parseInt(e.target.value, 10));
  });
  $("tsInput").addEventListener("change", (e) => setStep(parseInt(e.target.value, 10)));
  $("tsSlider").addEventListener("input", (e) => setStep(parseInt(e.target.value, 10)));
  $("animBtn").addEventListener("click", () => (state.animating ? stopAnimation() : startAnimation()));

  for (const id of ["tsFirst", "tsLast"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") drawTimeSeries();
    });
    $(id).addEventListener("change", () => drawTimeSeries());
  }

  // Arrow keys step through time in single-timestep mode
  window.addEventListener("keydown", (e) => {
    if (state.mode !== "single" || !state.field) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (e.key === "ArrowRight") setStep(state.step + 1);
    if (e.key === "ArrowLeft") setStep(state.step - 1);
  });
}

async function init() {
  wire();
  drawEmptyTimeSeries();
  setStatus("Loading coastlines…");
  await loadWorld();
  await drawMap();
  setStatus("Ready — drop a NetCDF (.nc) and/or GeoJSON file");
  // warm up the HDF5 engine in the background
  h5wasm.ready.catch((e) => console.warn("h5wasm failed to initialise", e));
  window.__windApp = { state, routeFiles }; // handy for debugging
}

init();
