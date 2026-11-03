/**
 * GeoTIFF "available land" raster -> coarse boolean grid for Plotly.
 *
 * A pixel counts as available when it is finite, not the file's NoData value
 * and not 0. The file is read lazily from disk (never fully loaded into
 * memory), internal overviews are used when present, and any view window is
 * max-pooled (a cell is available if any source pixel is) to a bounded grid.
 * Only north-up rasters in a geographic CRS (lon/lat degrees) are supported.
 */

const PIXEL_BUDGET = 2e7; // max source pixels held in memory per read

export async function openRaster(file) {
  const GeoTIFF = window.GeoTIFF;
  if (!GeoTIFF) throw new Error("GeoTIFF library not loaded.");
  const tiff = await GeoTIFF.fromBlob(file);
  const main = await tiff.getImage();
  const keys = main.getGeoKeys() || {};

  if (keys.ProjectedCSTypeGeoKey || keys.GTModelTypeGeoKey === 1) {
    throw new Error("Raster is in a projected CRS; reproject it to WGS84 (EPSG:4326) first.");
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
  const bounds = [left, left + width * resX, top - height * resY, top];
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

  /** Render window [xmin,xmax,ymin,ymax] to at most maxCells cells on its longest side. */
  async function render(win, maxCells, onProgress) {
    const wx0 = Math.max(win[0], bounds[0]);
    const wx1 = Math.min(win[1], bounds[1]);
    const wy0 = Math.max(win[2], bounds[2]);
    const wy1 = Math.min(win[3], bounds[3]);
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

  return { name: file.name, bounds, render };
}
