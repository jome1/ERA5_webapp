function netcdf(variables) {
  const bytes = [];
  const encode = new TextEncoder();
  const uint = (value) => bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  const text = (value) => {
    const data = encode.encode(value);
    uint(data.length);
    bytes.push(...data);
    while (bytes.length % 4) bytes.push(0);
  };
  bytes.push(67, 68, 70, 1);
  uint(0);
  uint(10); uint(3);
  for (const [name, size] of [["time", 2], ["lat", 1], ["lon", 2]]) {
    text(name); uint(size);
  }
  uint(0); uint(0);
  uint(11); uint(variables.length);
  const offsets = [];
  for (const variable of variables) {
    text(variable.name);
    uint(3); uint(0); uint(1); uint(2);
    uint(12); uint(1);
    text("units"); uint(2); text(variable.units);
    uint(5); uint(16);
    offsets.push(bytes.length); uint(0);
  }
  for (let i = 0; i < variables.length; i++) {
    const offset = bytes.length;
    for (let j = 0; j < 4; j++) bytes[offsets[i] + j] = (offset >>> (24 - 8 * j)) & 255;
    for (const value of variables[i].data) {
      const buffer = new ArrayBuffer(4);
      new DataView(buffer).setFloat32(0, value);
      bytes.push(...new Uint8Array(buffer));
    }
  }
  return new File([new Uint8Array(bytes)], "test.nc");
}

async function waitFor(test, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assertRange(expected, label) {
  const trace = document.getElementById("map").data[0];
  const actual = [trace.zmin, trace.zmax];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertTitle(expected) {
  const actual = document.getElementById("map").layout.title.text;
  if (actual !== `<b>${expected}</b>`) {
    throw new Error(`Expected map title ${expected}, got ${actual}`);
  }
}

export async function runAppTests() {
  if (document.title !== "netCDF viewer" || document.querySelector("h1").textContent !== "netCDF viewer") {
    throw new Error("Incorrect website name");
  }
  const state = window.__windApp.state;
  const file = netcdf([
    { name: "wind10", units: "m/s", data: [1, 3, 5, 7] },
    { name: "wind100", units: "m/s", data: [10, 12, 14, 16] },
    { name: "u10", units: "m/s", data: [-30, -30, -30, -30] },
    { name: "v10", units: "m/s", data: [40, 40, 40, 40] },
    { name: "temperature", units: "K", data: [-40, -30, -20, -10] },
  ]);
  window.__windApp.routeFiles([file]);
  await waitFor(() => state.fileName === file.name && !state.busy, "first file");
  assertRange([3, 50], "derived speed mean");
  assertTitle("ws10");

  const select = document.getElementById("varSelect");
  async function choose(id) {
    select.value = id;
    select.dispatchEvent(new Event("change"));
    await waitFor(() => state.varId === id && document.getElementById("map").data[0].colorbar.title.text.startsWith(id + " "), id);
  }
  await choose("wind100");
  assertRange([3, 50], "other wind speed mean");
  assertTitle("wind100");
  const mode = document.getElementById("modeSelect");
  mode.value = "single";
  mode.dispatchEvent(new Event("change"));
  await waitFor(() => document.getElementById("map").data[0].zmin === 1, "single mode");
  assertRange([1, 50], "wind speed timestep");
  assertTitle("wind100");
  document.getElementById("tsPlus").click();
  await waitFor(() => state.step === 2, "next timestep");
  assertRange([1, 50], "next timestep");
  assertTitle("wind100");
  await choose("temperature");
  assertRange([-40, -10], "non-wind timestep");
  assertTitle("temperature");
  mode.value = "mean";
  mode.dispatchEvent(new Event("change"));
  await waitFor(() => document.getElementById("map").data[0].zmax === -20, "non-wind mean");
  assertRange([-30, -20], "non-wind mean");
  assertTitle("temperature");

  const replacement = netcdf([{ name: "wnd", units: "m/s", data: [20, 22, 24, 26] }]);
  window.__windApp.routeFiles([replacement]);
  await waitFor(() => !state.busy && state.varId === "wnd", "replacement file");
  assertRange([22, 24], "replacement file range");
  return "app tests passed";
}
