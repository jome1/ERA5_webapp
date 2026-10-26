/**
 * GeoJSON -> polygon outlines (rings as null-separated x/y arrays for Plotly).
 * Only outlines are produced (exterior rings and holes), never fills.
 */

const WGS84 = /(4326|CRS84|WGS ?84)/i;

export function geojsonToOutlines(gj) {
  const x = [];
  const y = [];
  const warnings = [];
  const features = [];
  let nPolygons = 0;
  let nOther = 0;

  const crsName = gj && gj.crs && gj.crs.properties && gj.crs.properties.name;
  if (crsName && !WGS84.test(crsName)) {
    warnings.push(`File declares CRS "${crsName}"; GeoJSON is expected in WGS84 lon/lat.`);
  }

  const addRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      x.push(Number(pt[0]));
      y.push(Number(pt[1]));
    }
    // close the ring visually if it isn't already
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a && b && (a[0] !== b[0] || a[1] !== b[1])) {
      x.push(Number(a[0]));
      y.push(Number(a[1]));
    }
    x.push(null);
    y.push(null);
  };

  const geom = (g) => {
    if (!g) return;
    switch (g.type) {
      case "Polygon":
        nPolygons++;
        for (const ring of g.coordinates || []) addRing(ring);
        break;
      case "MultiPolygon":
        for (const poly of g.coordinates || []) {
          nPolygons++;
          for (const ring of poly) addRing(ring);
        }
        break;
      case "GeometryCollection":
        for (const sub of g.geometries || []) geom(sub);
        break;
      default:
        nOther++;
    }
  };

  const walk = (obj) => {
    if (!obj) return;
    if (obj.type === "FeatureCollection") for (const f of obj.features || []) walk(f);
    else if (obj.type === "Feature") {
      const start = x.length;
      geom(obj.geometry);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = start; k < x.length; k++) {
        if (x[k] === null) continue;
        x0 = Math.min(x0, x[k]); x1 = Math.max(x1, x[k]);
        y0 = Math.min(y0, y[k]); y1 = Math.max(y1, y[k]);
      }
      if (x1 >= x0) features.push({ props: obj.properties || {}, lon: (x0 + x1) / 2, lat: (y0 + y1) / 2 });
    } else geom(obj);
  };

  if (Array.isArray(gj)) gj.forEach(walk);
  else walk(gj);

  if (nOther) warnings.push(`${nOther} non-polygon geometr${nOther === 1 ? "y was" : "ies were"} skipped.`);

  // sanity check: projected coordinates?
  let bad = false;
  for (let k = 0; k < x.length; k++) {
    if (x[k] === null) continue;
    if (Math.abs(x[k]) > 540 || Math.abs(y[k]) > 90) {
      bad = true;
      break;
    }
  }
  if (bad) warnings.push("Some coordinates are outside lon/lat range — the file may use a projected CRS.");

  const columns = [];
  for (const f of features) {
    for (const k of Object.keys(f.props)) if (!columns.includes(k)) columns.push(k);
  }

  return { outlines: { x, y }, nPolygons, warnings, features, columns };
}
