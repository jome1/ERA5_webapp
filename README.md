# Wind Map Viewer (web)

A browser version of `ERA5_wind_app.py`. Open the page, drag a NetCDF wind file onto it, and explore:

- **Mean** or **single-timestep** wind speed map (Viridis, fixed colour range per mode, like the desktop app)
- **Hover** a cell to see its value (blue outline), **click** a cell to select it (red outline) and plot its **time series** with the mean as a dashed red line
- Timestep stepping (−/+, number box, slider, ← → keys) and **animation**
- "Show timesteps from … to …" range for the time series
- **GeoJSON overlay** – drop one or more `.geojson` files and their polygons are drawn as **outlines only** on the same map (each file gets its own colour; *Clear* removes them)
- **Available-land raster** – drop a GeoTIFF (`.tif`, WGS84 lon/lat, north-up); pixels that are non-zero and not NoData are drawn semi-transparent grey above the wind map and below the polygon outlines (*Clear* removes it). Large rasters are fine: the file is read lazily (not loaded into memory), internal overviews are used when present, and the visible area is re-rendered at finer detail as you zoom (max-pooled to ≤1500 cells per side, so small patches never disappear)
- Scroll to zoom, drag to pan, camera icon to save a PNG

Everything runs locally in the browser – files are never uploaded anywhere. There is no server, so the site can be hosted for free on GitHub Pages.

## Supported files

| | |
|---|---|
| NetCDF-4 / HDF5 (incl. compressed) | ✅ via [h5wasm](https://github.com/usnistgov/h5wasm) |
| NetCDF-3 classic / 64-bit offset | ✅ via [netcdfjs](https://github.com/cheminfo/netcdfjs) |
| NetCDF-3 CDF5 | ❌ (convert with `nccopy -k nc4 in.nc out.nc`) |
| GeoJSON `Polygon`, `MultiPolygon`, `GeometryCollection` | ✅ outlines incl. holes, coordinates in WGS84 lon/lat |

Variable selection follows the desktop app: `wnd100m` → `wind` → `wnd` → first variable. If the file contains wind components (`u100`/`v100`, `u10`/`v10`, …), a derived wind speed `√(u² + v²)` is offered and selected by default, so raw ERA5 downloads work directly. Coordinates may be called `x/y`, `lon/lat` or `longitude/latitude`; time may be `time` or `valid_time`. Packed data (`scale_factor`/`add_offset`), `_FillValue`, descending latitudes and 0–360° longitudes are handled.

The whole file is read into browser memory, so files up to a few hundred MB work well; very large files (> ~1.5 GB) may exceed browser limits — subset them first (e.g. with `cdo sellonlatbox` or xarray).

Try it with the files in `samples/`.

## Deploy on GitHub Pages

1. Create a new repository on GitHub (e.g. `wind-map-viewer`) and upload the contents of this folder to it (keep the folder structure; `index.html` must be at the top level).
   ```bash
   cd wind-map-viewer
   git init && git add . && git commit -m "Wind Map Viewer"
   git branch -M main
   git remote add origin https://github.com/<your-user>/wind-map-viewer.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, choose **main** and **/ (root)**, then **Save**.
3. After a minute the app is live at `https://<your-user>.github.io/wind-map-viewer/`.

> Private repositories need a paid GitHub plan for Pages. A public repository is fine because your data is never stored in the repo or on the server — it stays in your browser.

## Run locally

Browsers block ES modules from `file://`, so use a tiny local web server:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Project layout

```
index.html          page layout
css/style.css       styling
js/app.js           UI, map, time series, drag & drop, animation
js/ncreader.js      NetCDF-3 / NetCDF-4 reading + CF decoding (fill, scale, time units)
js/grid.js          picks variable/dims, builds the (time, lat, lon) field, mean
js/raster.js      GeoTIFF available-land raster -> display grid
js/geo.js           GeoJSON → polygon outlines
lib/                vendored libraries (Plotly, h5wasm, netcdfjs, topojson-client,
                    Natural Earth 1:50m coastlines from world-atlas) – no CDN needed
samples/            small example NetCDF and GeoJSON files
```
