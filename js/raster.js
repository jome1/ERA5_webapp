/**
 * GeoTIFF "available land" raster -> coarse boolean grid for Plotly.
 *
 * A pixel counts as available when it is finite, not the file's NoData value
 * and not 0. The file is read lazily from disk (never fully loaded into
 * memory), internal overviews are used when present, and any view window is
 * max-pooled (a cell is available if any source pixel is) to a bounded grid.
 * North-up rasters only. Projected rasters are reprojected on the fly to
 * WGS84 lon/lat (proj4js, CRS definition from the GeoTIFF geokeys): the
 * viewport is first pooled in the source CRS, then resampled onto a lon/lat grid.
 */

import { toProj4 } from "../lib/geokeys-to-proj4.js";

const PIXEL_BUDGET = 2e7; // max source pixels held in memory per read

export async function openRaster(file) {
  const GeoTIFF = window.GeoTIFF;
  if (!GeoTIFF) throw new Error("GeoTIFF library not loaded.");
  const tiff = await GeoTIFF.fromBlob(file);
  const main = await tiff.getImage();
  const keys = main.getGeoKeys() || {};

  const projected = !!keys.ProjectedCSTypeGeoKey || keys.GTModelTypeGeoKey === 1;
  let fwd = null; // lon/lat -> source file units
  let inv = null; // source file units -> lon/lat
  if (projected) {
    const proj4 = window.proj4;
    if (!proj4) throw new Error("proj4 library not loaded.");
    const conv = toProj4(keys);
    if (!conv.proj4 || (conv.errors && Object.keys(conv.errors).length)) {
      throw new Error(`Unsupported raster CRS (${keys.ProjectedCSTypeGeoKey || "user-defined"}); reproject it to WGS84 (EPSG:4326) first.`);
    }
    const { x: ux, y: uy } = conv.conversionParameters; // file units -> proj4 units
    let tr;
    try {
      tr = proj4("EPSG:4326", conv.proj4);
    } catch (e) {
      throw new Error(`Unsupported raster CRS (${keys.ProjectedCSTypeGeoKey || "user-defined"}); reproject it to WGS84 (EPSG:4326) first.`);
    }
    fwd = (lon, lat) => {
      const p = tr.forward([lon, lat]);
      return [p[0] / ux, p[1] / uy];
    };
    inv = (x, y) => tr.inverse([x * ux, y * uy]);
  }
  let origin;
  let res;
  try {
    main.getBoundingBox(); // throws for rotated rasters
    origin = main.getOrigin();
    res = main.getResolution();
  } catch (e) {
    throw new Error("Raster has no usable georeferencing or is rotated / skewed.");
  }
  const width = main.getWidth();
  const height = main.getHeight();
  const resX = res[0];
  const resY = -res[1];
  if (!(resX > 0 && resY > 0)) throw new Error("Only north-up rasters are supported.");
  const pointIsPixel = keys.GTRasterTypeGeoKey === 2;
  const left = origin[0] - (pointIsPixel ? resX / 2 : 0);
  const top = origin[1] + (pointIsPixel ? resY / 2 : 0);
  const srcBounds = [left, left + width * resX, top - height * resY, top];
  const noData = main.getGDALNoData();

  // main image + overviews with the same extent, coarsest first
  const count = await tiff.getImageCount();
  const levels = [{ img: main, w: width, h: height, sx: resX, sy: resY }];
  for (let k = 1; k < count; k++) {
    const img = await tiff.getImage(k);
    const w = img.getWidth();
    const h = img.getHeight();
    if (w >= width || Math.abs(w / width - h / height) > 0.02) continue;
    levels.push({ img, w, h, sx: (resX * width) / w, sy: (resY * height) / h });
  }
  levels.sort((a, b) => a.w - b.w);

  /** Pool window [xmin,xmax,ymin,ymax] (source CRS units) to at most maxCells cells on its longest side. */
  async function pool(win, maxCells, onProgress) {
    const wx0 = Math.max(win[0], srcBounds[0]);
    const wx1 = Math.min(win[1], srcBounds[1]);
    const wy0 = Math.max(win[2], srcBounds[2]);
    const wy1 = Math.min(win[3], srcBounds[3]);
    if (!(wx1 > wx0 && wy1 > wy0)) return null;

    // coarsest level that still has >= maxCells pixels across the window
    const span = (L) => Math.max((wx1 - wx0) / L.sx, (wy1 - wy0) / L.sy);
    let L = levels[levels.length - 1];
    for (const cand of levels) {
      if (span(cand) >= maxCells) {
        L = cand;
        break;
      }
    }

    const px0 = Math.max(0, Math.floor((wx0 - left) / L.sx));
    const px1 = Math.min(L.w, Math.ceil((wx1 - left) / L.sx));
    const py0 = Math.max(0, Math.floor((top - wy1) / L.sy));
    const py1 = Math.min(L.h, Math.ceil((top - wy0) / L.sy));
    const w = px1 - px0;
    const h = py1 - py0;
    const f = Math.max(1, Math.ceil(Math.max(w, h) / maxCells));
    const nx = Math.ceil(w / f);
    const ny = Math.ceil(h / f);
    const rowsPerRead = Math.max(f, Math.floor(PIXEL_BUDGET / w / f) * f);

    const z = new Array(ny); // south -> north
    let nAvail = 0;
    for (let y0 = py0; y0 < py1; y0 += rowsPerRead) {
      const y1 = Math.min(py1, y0 + rowsPerRead);
      const band = await L.img.readRasters({ window: [px0, y0, px1, y1], samples: [0], interleave: true });
      for (let ry = y0; ry < y1; ry += f) {
        const r = (ry - py0) / f;
        const row = new Array(nx).fill(null);
        const yEnd = Math.min(y1, ry + f);
        for (let y = ry; y < yEnd; y++) {
          const base = (y - y0) * w;
          for (let x = 0; x < w; x++) {
            const v = band[base + x];
            if (v !== 0 && v === v && v !== noData) {
              const c = (x / f) | 0;
              if (row[c] === null) {
                row[c] = 1;
                nAvail++;
              }
            }
          }
        }
        z[ny - 1 - r] = row;
      }
      if (onProgress) onProgress((y1 - py0) / h);
    }

    const dx = L.sx * f;
    const dy = L.sy * f;
    return {
      nx,
      ny,
      x0: left + px0 * L.sx + dx / 2,
      dx,
      y0: top - py0 * L.sy - (ny - 0.5) * dy,
      dy,
      z,
      nAvail,
      win: [left + px0 * L.sx, left + px1 * L.sx, top - py1 * L.sy, top - py0 * L.sy],
      reduced: f > 1 || L.w < width,
    };
  }

  if (!projected) return { name: file.name, bounds: srcBounds, render: pool };

  const finite = (v) => Number.isFinite(v);
  /** Bounding box of a point set, ignoring points that fail to project. */
  const bbox = (pts) => {
    const b = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of pts) {
      if (!p || !finite(p[0]) || !finite(p[1])) continue;
      b[0] = Math.min(b[0], p[0]);
      b[1] = Math.max(b[1], p[0]);
      b[2] = Math.min(b[2], p[1]);
      b[3] = Math.max(b[3], p[1]);
    }
    return b[0] <= b[1] && b[2] <= b[3] ? b : null;
  };
  const gridPts = (b, n, fn) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        if (i && i < n && j && j < n) continue; // edges only
        out.push(fn(b[0] + ((b[1] - b[0]) * i) / n, b[2] + ((b[3] - b[2]) * j) / n));
      }
    }
    return out;
  };
  const bounds = bbox(gridPts(srcBounds, 40, (x, y) => inv(x, y)));
  if (!bounds) throw new Error("Could not transform the raster extent to WGS84.");

  async function render(win, maxCells, onProgress) {
    const wx0 = Math.max(win[0], bounds[0]);
    const wx1 = Math.min(win[1], bounds[1]);
    const wy0 = Math.max(win[2], bounds[2]);
    const wy1 = Math.min(win[3], bounds[3]);
    if (!(wx1 > wx0 && wy1 > wy0)) return null;

    // lon/lat window -> enclosing window in the source CRS (all grid points, not just edges)
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) pts.push(fwd(wx0 + ((wx1 - wx0) * i) / 16, wy0 + ((wy1 - wy0) * j) / 16));
    }
    const sw = bbox(pts);
    if (!sw) return null;
    // pooled cells are about half an output cell, so every output cell sees a pixel
    const src = await pool(sw, maxCells * 2, onProgress);
    if (!src) return null;

    const step = Math.max(wx1 - wx0, wy1 - wy0) / maxCells;
    const nx = Math.max(1, Math.ceil((wx1 - wx0) / step));
    const ny = Math.max(1, Math.ceil((wy1 - wy0) / step));
    const sx0 = src.x0 - src.dx / 2;
    const sy0 = src.y0 - src.dy / 2;
    const offs = [0.25, 0.75];
    const z = new Array(ny); // south -> north
    let nAvail = 0;
    for (let j = 0; j < ny; j++) {
      const row = new Array(nx).fill(null);
      for (let i = 0; i < nx; i++) {
        let hit = false;
        for (let a = 0; a < 2 && !hit; a++) {
          for (let b = 0; b < 2 && !hit; b++) {
            const p = fwd(wx0 + (i + offs[a]) * step, wy0 + (j + offs[b]) * step);
            const ci = Math.floor((p[0] - sx0) / src.dx);
            const cj = Math.floor((p[1] - sy0) / src.dy);
            if (ci >= 0 && ci < src.nx && cj >= 0 && cj < src.ny && src.z[cj][ci] === 1) hit = true;
          }
        }
        if (hit) {
          row[i] = 1;
          nAvail++;
        }
      }
      z[j] = row;
    }
    return {
      nx,
      ny,
      x0: wx0 + step / 2,
      dx: step,
      y0: wy0 + step / 2,
      dy: step,
      z,
      nAvail,
      win: [wx0, wx0 + nx * step, wy0, wy0 + ny * step],
      reduced: true,
    };
  }

  return { name: file.name, bounds, render };
}
