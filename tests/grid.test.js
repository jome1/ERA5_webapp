import { listVariables, isWindSpeed, windSpeedRanges } from "../js/grid.js";

function dataset(variables) {
  const dims = { time: 2, lat: 1, lon: 2 };
  const vars = {
    time: { dims: ["time"], shape: [2], attrs: {} },
    lat: { dims: ["lat"], shape: [1], attrs: {} },
    lon: { dims: ["lon"], shape: [2], attrs: {} },
  };
  const data = { time: [0, 1], lat: [0], lon: [0, 1] };
  for (const [name, value] of Object.entries(variables)) {
    vars[name] = { dims: ["time", "lat", "lon"], shape: [2, 1, 2], attrs: value.attrs };
    data[name] = value.data;
  }
  return { dims, vars, read: (name) => data[name], readRaw: (name) => data[name] };
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function runGridTests() {
  const ds = dataset({
    wnd100m: { attrs: { units: "m/s" }, data: [1, 3, 5, 7] },
    speed: { attrs: { standard_name: "wind_speed", units: "m s**-1" }, data: [10, 12, 14, 16] },
    u10: { attrs: { standard_name: "eastward_wind", long_name: "Eastward wind speed", units: "m s-1" }, data: [-30, -30, -30, -30] },
    v10: { attrs: { standard_name: "northward_wind", units: "m s-1" }, data: [40, 40, 40, 40] },
    current: { attrs: { units: "m/s" }, data: [-100, -100, 100, 100] },
    ws50: { attrs: { units: "km/h" }, data: [200, 200, 200, 200] },
    unknown: { attrs: {}, data: [300, 300, 300, 300] },
    ws20: { attrs: { units: "m/s" }, data: [NaN, NaN, NaN, NaN] },
  });
  const list = listVariables(ds);
  const eligible = list.filter((info) => isWindSpeed(ds, info)).map((info) => info.id);
  assertEqual(eligible, ["__speed_u10_v10", "wnd100m", "speed", "ws20"], "wind-speed identification");
  assertEqual(windSpeedRanges(ds, list), { mean: [3, 50], step: [1, 50] }, "shared ranges");

  const constant = dataset({
    wnd: { attrs: { units: "m/s" }, data: [5, NaN, 5, NaN] },
  });
  assertEqual(windSpeedRanges(constant, listVariables(constant)), { mean: [4.5, 5.5], step: [4.5, 5.5] }, "constant and missing values");
  const missing = dataset({
    wnd: { attrs: { units: "m/s" }, data: [NaN, NaN, NaN, NaN] },
  });
  assertEqual(windSpeedRanges(missing, listVariables(missing)), { mean: [0, 1], step: [0, 1] }, "all missing");
  const other = dataset({
    temperature: { attrs: { units: "K" }, data: [1, 2, 3, 4] },
  });
  assertEqual(windSpeedRanges(other, listVariables(other)), null, "no wind speeds");
  const defaultUnits = dataset({
    wnd100m: { attrs: {}, data: [1, 2, 3, 4] },
  });
  assertEqual(windSpeedRanges(defaultUnits, listVariables(defaultUnits)), { mean: [2, 3], step: [1, 4] }, "default wind units");
  return "grid tests passed";
}
