"use strict";
// Blender MCP card (Settings → MCP servers) rework: two-state markup, inline
// error note, non-clipping status pill, non-wrapping primary button.
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src/core/main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "overlay.css"), "utf8");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("ok   " + m); };
const grab = (name) => { const i = main.indexOf("    function " + name + "("); assert(i > 0, name + " defined"); let d = 0; const j = main.indexOf("{", i); for (let k = j; k < main.length; k++) { if (main[k] === "{") d++; else if (main[k] === "}") { d--; if (!d) return main.slice(i, k + 1); } } };
ok(main.includes("${blenderCardHtml()}"), "menu renders the card through blenderCardHtml()");
for (const on of [false, true]) {
  const A = { toolList: on ? [{ name: "get_scene_info", server: "blender" }, { name: "blender_add_cube" }, { name: "execute_luau" }] : [] };
  const html = new Function("A", "blenderConnected", grab("blenderToolCount") + "\n" + grab("blenderCardHtml") + "\nreturn blenderCardHtml();")(A, () => on);
  const tag = on ? "connected" : "offline";
  ok(html.includes(`data-state="${on ? "on" : "off"}"`), tag + ": card carries data-state");
  ok(html.indexOf("rs-blender-pill") < html.indexOf("rs-blender-sub"), tag + ": status pill sits in the title row, not on the card edge");
  ok(html.includes(on ? ">Connected<" : ">Offline<"), tag + ": pill text");
  ok(html.includes('id="rs-mcp-blender"') && html.includes('id="rs-blender-site"') && html.includes('id="rs-blender-note"'), tag + ": connect / site / note ids present");
  if (on) {
    ok(html.includes("rs-blender-caps") && !html.includes("rs-blender-steps"), "connected: capability chips, no checklist");
    ok(html.includes("2 tools"), "connected: Blender tool count chip");
    ok(html.includes('id="rs-mcp-blender-off"') && html.includes(">Reconnect<"), "connected: Reconnect + Disconnect");
  } else {
    ok(html.includes("rs-blender-steps") && !html.includes("rs-blender-caps"), "offline: three-step checklist, no chips");
    ok(/<li>.*?<b>1<\/b>.*?<kbd>N<\/kbd>/.test(html) && html.includes("Start MCP Server") && (html.match(/<li>/g) || []).length === 3, "offline: steps N-panel → Start MCP Server → Connect");
    ok(html.includes(">Connect Blender<") && !html.includes("rs-mcp-blender-off"), "offline: Connect Blender only");
  }
}
ok(main.includes("function setBlenderBusy(") && main.includes("function showBlenderNote("), "connect handler has busy + inline note helpers");
ok(main.includes("Nothing is listening on port 9876"), "connection-refused error explained in plain words");
const card = css.slice(css.indexOf("/* ── Blender MCP card"), css.indexOf("/* ── atelier skin"));
ok(/\.rs-blender-card \{[^}]*box-sizing: border-box;[^}]*overflow: hidden;/s.test(card), "card: border-box + overflow hidden (nothing clips past the edge)");
ok(/#rs-mcp-blender \{[^}]*flex: 1 1 130px;[^}]*min-width: 0;/s.test(card) && /\.rs-blender-actions > button \{[^}]*white-space: nowrap;/s.test(card), "primary button grows, never wraps");
ok(/\.rs-blender-actions \{[^}]*flex-wrap: wrap;/s.test(card), "secondary buttons wrap under the primary on narrow menus");
for (const sel of [".rs-blender-steps", ".rs-blender-caps", ".rs-blender-note", ".rs-blender-pill i", "html.rs-light .rs-blender-card", "prefers-reduced-motion"]) ok(card.includes(sel), "css has " + sel);
console.log(`PASS  test-blender-card: ${n} checks`);
