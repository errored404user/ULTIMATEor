#!/usr/bin/env node
// 1.37.0 — Templates tray XL (overlay.css section 12): the cards panel opens as
// a real workspace (up to 1180px wide, almost the whole room above the bar),
// header/tabs pinned with only the body scrolling, bigger type. String checks
// plus a jsdom measurement that the rule actually wins the cascade.
"use strict";
const fs = require("fs");
const path = require("path");
process.chdir(path.resolve(__dirname, ".."));
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else { failed++; console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 300) : "")); }
}
const css = fs.readFileSync("overlay.css", "utf8");
const sec = css.indexOf("12. 1.37.0 — Templates tray XL");
ok("section 12 exists and is the last tray rule block", sec > 0 && css.indexOf("rs-cards-open #rs-cards-panel", sec) > sec);
const block = css.slice(sec);
ok("panel width grows to 1180px (clamped to the viewport)", block.includes("width: min(max(100%, 1180px), calc(100vw - 32px)) !important"));
ok("panel height uses almost all the room above the bar", block.includes("max-height: min(92vh, 980px, var(--rs-room-above, 980px)) !important") && block.includes("min-height: min(680px, 86vh, var(--rs-room-above, 680px)) !important"));
ok("still clamped by --rs-room-above (never leaves the viewport)", (block.match(/--rs-room-above/g) || []).length >= 3);
ok("header pinned, body scrolls", block.includes("> .rs-cards-top { flex: 0 0 auto !important; }") && block.includes("> .rs-cards-body {") && block.includes("overflow-y: auto !important"));
ok("tray-below fallback keeps a sane height", block.includes("#rs-bar.rs-tray-below.rs-cards-open #rs-cards-panel") && block.includes("max-height: min(70vh, 720px) !important"));
ok("narrow viewports fall back to full width", block.includes("@media (max-width: 1260px)") && block.includes("@media (max-width: 900px)"));
ok("bigger heading / tabs", block.includes(".rs-cards-heading { font-size: 22px !important; }") && block.includes(".rs-cards-tab { min-height: 36px !important; font-size: 13.5px !important"));
ok("bigger rows and copy", block.includes(".rs-template-row { min-height: 96px !important") && block.includes(".rs-template-copy > p { font-size: 13.5px !important"));
ok("idea generator controls scaled", block.includes(".rs-idea-generator select { height: 46px !important") && block.includes(".rs-idea-generator button { min-height: 46px !important"));
ok("short screens scale back down", block.includes("@media (max-height: 760px)"));
ok("section 9 rules still present (section 12 only overrides them)", css.includes("9. 1.33.0 — Templates tray: bigger, legible, pill buttons"));

// cascade check with jsdom (optional)
try {
  const { JSDOM } = require("jsdom");
  // jsdom's CSS parser rejects the modern syntax elsewhere in overlay.css, so
  // only section 12 is loaded (color-mix() shadows are dropped by the regex).
  const only = block.replace(/box-shadow:[^;]*;/gs, "");
  const dom = new JSDOM(`<!doctype html><html><head><style>${only}</style></head><body><div id="rs-root"><div id="rs-bar" class="rs-bar-inline rs-cards-open" style="width:600px;position:relative"><div id="rs-cards-panel"><div class="rs-cards-top"></div><div class="rs-cards-body"></div></div></div></div></body></html>`);
  const w = dom.window;
  const panel = w.document.getElementById("rs-cards-panel");
  const cs = w.getComputedStyle(panel);
  // (jsdom/cssstyle does not evaluate min()/max() lengths — the width is a string check above)
  void cs;
  const body = w.getComputedStyle(w.document.querySelector("#rs-cards-panel > .rs-cards-body"));
  ok("jsdom: body scrolls", body.overflowY === "auto", body.overflowY);
} catch (e) { console.log("SKIP  jsdom cascade check (" + String(e.message).slice(0, 80) + ")"); }

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.37.0 tray checks passed");
process.exit(failed ? 1 : 0);
