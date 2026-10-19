// ORscript Paint — wiring + headless logic checks (no browser needed).
const fs = require("fs");
const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const manifest = JSON.parse(read("manifest.json"));
let bundles = 0;
for (const cs of manifest.content_scripts) {
  if (cs.world === "MAIN" || !cs.js.includes("src/core/main.js")) continue;
  const pi = cs.js.indexOf("src/core/paint.js"), mi = cs.js.indexOf("src/core/main.js");
  assert(pi >= 0, `bundle ${cs.matches[0]} must load src/core/paint.js`);
  assert(pi < mi, `paint.js must load before main.js in ${cs.matches[0]}`);
  bundles += 1;
}
assert(bundles >= 14, `expected >=14 bundles with paint.js, got ${bundles}`);
assert(fs.existsSync(path.join(root, "src/core/paint.js")), "paint.js missing");

const main = read("src/core/main.js");
for (const s of [
  'id="rs-paint-btn"',
  "async function sendPainting(text, images, onStatus)",
  "async function paintCaptureStudio()",
  "ORPaint.open({",
  "send: sendPainting,",
  "captureStudio: paintCaptureStudio,",
  "await startSession({ restart: !P.chatIsEmpty() });",
  "if (A.started && !A.running && !A.userStopped) agentLoop(base);",
  "window.__rsOpenPaint = openPaint;",
  'root.querySelector("#rs-paint-btn")',
]) assert(main.includes(s), `main.js missing: ${s}`);
assert(main.indexOf('id="rs-paint-btn"') < main.indexOf('id="rs-settings-btn"'), "paint button must sit right before the settings button");

const css = read("overlay.css");
for (const s of ["#rs-paint {", "#rs-paint.open {", ".rsp-shell {", ".rsp-tools {", ".rsp-stage {", ".rsp-side {", ".rsp-send-btn {", ".rsp-sw {", ".rsp-layer {", ".rsp-text-input {", "html.rs-paint-open #rs-root", ":is(#rs-settings-btn, #rs-paint-btn, #rs-gui-btn)"])
  assert(css.includes(s), `overlay.css missing: ${s}`);

// Load the module with a minimal DOM-free stub: only the public surface that does not touch the DOM is exercised.
const src = read("src/core/paint.js");
const win = {};
const stubDoc = { documentElement: { classList: { add() {}, remove() {} } }, createElement: () => ({ getContext: () => null, style: {}, classList: { add() {}, remove() {}, toggle() {} } }), querySelector: () => null, addEventListener() {} };
new Function("window", "document", "navigator", "localStorage", "chrome", "console", src)(win, stubDoc, { clipboard: {} }, { getItem: () => null, setItem() {} }, { runtime: { getURL: (p) => p } }, console);
const ORPaint = win.ORPaint;
assert(ORPaint && typeof ORPaint.open === "function" && typeof ORPaint.buildMessage === "function", "ORPaint surface missing");
assert(ORPaint.TOOLS.length >= 16, "expected >=16 tools");
assert(ORPaint.INTENTS.length >= 9, "expected >=9 intents");
for (const t of ["pencil", "brush", "spray", "eraser", "fill", "picker", "line", "arrow", "rect", "ellipse", "triangle", "star", "text", "select", "hand"]) assert(ORPaint.TOOLS.some((x) => x.id === t), `tool missing: ${t}`);

// buildMessage() on synthetic state (no canvas): prims drive the vector description.
const S = ORPaint._state;
S.w = 1000; S.h = 500; S.bg = "white"; S.grid = { on: true, size: 50, snap: false }; S.layers = [{ name: "Layer 1", visible: true, opacity: 1 }]; S.intent = "structure"; S.caption = "a tower"; S.scale = "1 cell = 4 studs";
S.prims = [
  { t: "rect", c: "#ff0000", a: 100, mode: "fill", bb: [100, 100, 400, 300], layer: 0 },
  { t: "ellipse", c: "#0000ff", a: 100, mode: "stroke", bb: [500, 100, 700, 300], layer: 0 },
  { t: "arrow", c: "#000000", a: 100, from: [400, 250], to: [500, 200], bb: [400, 200, 500, 250], layer: 0 },
  { t: "text", text: "spawn", c: "#000000", size: 28, at: [120, 120], bb: [120, 120, 220, 150], layer: 0 },
];
const msg = ORPaint.buildMessage({ noMap: true });
for (const s of ["ORSCRIPT PAINT", "INTENT:", "MY NOTE: a tower", "SCALE: 1 cell = 4 studs", "DRAWN ELEMENTS (4", "RECTANGLE, filled", "CIRCLE", "ARROW", 'TEXT LABELS: "spawn"', "RELATIONS:", "HOW TO ACT", "I see:"])
  assert(msg.includes(s), `buildMessage missing: ${s} \n--\n${msg.slice(0, 600)}`);
assert(msg.includes("#1") && msg.includes("#4"), "elements must be numbered");
console.log(`PASS  paint: ${bundles} bundles, ${ORPaint.TOOLS.length} tools, ${ORPaint.INTENTS.length} intents, message ${msg.length} chars`);
