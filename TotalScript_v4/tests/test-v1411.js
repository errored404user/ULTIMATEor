// 1.41.1 / 1.41.2 — cascade-resolved layout checks for the Templates panel.
//
// jsdom cannot parse the whole overlay.css and its own cascade ignores
// specificity for !important rules, so every earlier CSS test was a string
// check - which is exactly how 1.41.0 shipped with a rail that rendered
// stacked on top in the real browser (an older 2-1-0 rule forced
// display:flex) and 1.41.1 with a panel that never closed (data-cards-tab
// kept the grid rules matching a [hidden] panel, so the bar vanished behind a
// 680px block in its own flow).
//
// This test resolves the `display` property the way a browser does: collect
// every rule whose selector matches the element (jsdom's Element.matches),
// then pick the winner by !important → specificity → source order. It does so
// for the panel in each real state (open / closed, anchored / inline / below).
//
//   NODE_PATH=/tmp/harness/node_modules node tests/test-v1411.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "overlay.css"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "core", "main.js"), "utf8");

const failed = [];
let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed.push(name); console.log("FAIL " + name + (extra !== undefined ? "  → " + String(extra).slice(0, 200) : "")); }
}

// ── tiny cascade resolver ───────────────────────────────────────────────────
// Strip comments and @media blocks (none of the rules under test live in one;
// the 860px stack only changes grid-template-*, never display).
function stripMedia(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const at = src.indexOf("@media", i);
    if (at < 0) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let j = src.indexOf("{", at), depth = 0;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}
const flat = stripMedia(css.replace(/\/\*[\s\S]*?\*\//g, ""));
const rules = [];
{
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, order = 0;
  while ((m = re.exec(flat))) {
    const body = m[2];
    const d = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!important)?\s*(?=;|$)/.exec(body);
    if (!d) continue;
    // last display declaration in the block wins inside the block
    const all = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!important)?\s*(?=;|$)/g)];
    const last = all[all.length - 1];
    for (const sel of m[1].split(/,(?![^(]*\))/)) {
      const s = sel.trim();
      if (!s || s.startsWith("@")) continue;
      rules.push({ sel: s, value: last[1].trim(), important: !!last[2], order: order++ });
    }
  }
}
function specificity(sel) {
  // good enough for this stylesheet: ids / (classes + attrs + pseudo-classes) / elements
  let s = sel.replace(/::[\w-]+(\([^)]*\))?/g, " ") // pseudo-elements → count as element below
    .replace(/\\./g, "x");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
  s = s.replace(/\[[^\]]*\]/g, " ");
  const classes = (s.match(/\.[\w-]+/g) || []).length;
  // :not(X)/:is(X)/:has(X) → count X's parts; :not itself counts nothing
  let pseudoFn = 0;
  s = s.replace(/:(not|is|where|has)\(([^)]*)\)/g, (_, fn, inner) => {
    if (fn !== "where") { const sp = specificity(inner); pseudoFn += sp[0] * 100 + sp[1] * 10 + sp[2]; }
    return " ";
  });
  const pseudos = (s.match(/:[\w-]+/g) || []).length;
  const els = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length + (sel.match(/::[\w-]+/g) || []).length;
  const b = classes + attrs + pseudos;
  return [ids + Math.floor(pseudoFn / 100), b + Math.floor((pseudoFn % 100) / 10), els + (pseudoFn % 10)];
}
function cmp(a, b) {
  if (a.important !== b.important) return a.important ? 1 : -1;
  for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return a.spec[i] - b.spec[i];
  return a.order - b.order;
}
function resolveDisplay(el) {
  let best = null;
  for (const r of rules) {
    let hit = false;
    try { hit = el.matches(r.sel); } catch { continue; }
    if (!hit) continue;
    const c = { ...r, spec: specificity(r.sel) };
    if (!best || cmp(c, best) > 0) best = c;
  }
  return best;
}

// ── fixture: the real DOM shape (bar may be in #rs-root or inside the host composer) ──
function fixture({ open, inline, below, tab = "library", rendered = true, light = false }) {
  const dom = new JSDOM(`<!doctype html><html data-rs-theme="night" class="${light ? "rs-light" : ""}"><body>
    <div id="rs-root"><div id="host-composer"></div></div></body></html>`);
  const doc = dom.window.document;
  const bar = doc.createElement("div");
  bar.id = "rs-bar";
  if (inline) bar.classList.add("rs-bar-inline"); else bar.classList.add("rs-bar-anchored");
  if (open) bar.classList.add("rs-cards-open");
  if (below) bar.classList.add("rs-tray-below");
  const panel = doc.createElement("div");
  panel.id = "rs-cards-panel";
  if (!open) panel.setAttribute("hidden", "");
  if (rendered) panel.setAttribute("data-cards-tab", tab);
  panel.innerHTML = '<div class="rs-cards-top"></div><div class="rs-cards-body"><div class="rs-template-library"></div></div>';
  bar.appendChild(panel);
  (inline ? doc.getElementById("host-composer") : doc.getElementById("rs-root")).appendChild(bar);
  return { panel, top: panel.firstElementChild, body: panel.lastElementChild };
}

ok("resolver sees the display rules of the stylesheet", rules.length > 200, rules.length);

// A) open panel → grid, in every mount / tray state and on every tab
for (const inline of [false, true]) for (const below of [false, true]) for (const tab of ["library", "activity", "public", "tasks"]) {
  const f = fixture({ open: true, inline, below, tab });
  const r = resolveDisplay(f.panel);
  ok(`open ${inline ? "inline" : "anchored"}${below ? " tray-below" : ""} ${tab}: panel display resolves to grid (rail in its own column)`, r && r.value === "grid", r && (r.value + " ← " + r.sel));
}

// B) closed panel → none, even though data-cards-tab is still on it (1.41.2 bug)
for (const inline of [false, true]) for (const below of [false, true]) {
  const f = fixture({ open: false, inline, below, rendered: true });
  const r = resolveDisplay(f.panel);
  ok(`closed ${inline ? "inline" : "anchored"}${below ? " tray-below" : ""} (data-cards-tab left over): panel display resolves to none`, r && r.value === "none", r && (r.value + " ← " + r.sel));
}
// and a stale rs-cards-open class on the bar (between two placement passes) still hides a [hidden] panel
{
  const f = fixture({ open: false, inline: true, below: false, rendered: true });
  f.panel.parentElement.classList.add("rs-cards-open");
  const r = resolveDisplay(f.panel);
  ok("closed panel with a stale rs-cards-open class on the bar still resolves to none", r && r.value === "none", r && (r.value + " ← " + r.sel));
}
// never-rendered panel (first paint, no attribute) → none
{
  const f = fixture({ open: false, inline: false, below: false, rendered: false });
  const r = resolveDisplay(f.panel);
  ok("never-rendered hidden panel resolves to none", r && r.value === "none", r && (r.value + " ← " + r.sel));
}

// C) the rail is a flex column and the content column is a block/flex box, never display:none
{
  const f = fixture({ open: true, inline: true, below: false });
  const rt = resolveDisplay(f.top), rb = resolveDisplay(f.body);
  ok("open: rail (.rs-cards-top) resolves to flex", rt && rt.value === "flex", rt && (rt.value + " ← " + rt.sel));
  ok("open: content column (.rs-cards-body) is visible", rb ? rb.value !== "none" : true, rb && (rb.value + " ← " + rb.sel));
}

// D) regression pins for the two fixes
const sec = css.slice(css.indexOf("§15 · 1.41.0 Workspace panel"));
ok("§15 grid declared on the open-state selectors (1.41.1)", sec.includes("#rs-bar.rs-bar-inline.rs-cards-open #rs-cards-panel[data-cards-tab],\n#rs-bar.rs-tray-below.rs-cards-open #rs-cards-panel[data-cards-tab] {\n  display: grid !important;"));
ok("§15 [hidden][data-cards-tab] kill rule present and after the grid rules (1.41.2)", sec.indexOf("#rs-cards-panel[hidden][data-cards-tab],") > sec.indexOf("display: grid !important;") && /#rs-bar\.rs-tray-below\.rs-bar-inline\.rs-cards-open #rs-cards-panel\[hidden\]\[data-cards-tab\] \{ display: none !important; \}/.test(sec));
ok("setCardsOpen(false) drops data-cards-tab so a closed panel cannot match the grid rules", main.includes('if (!open) { try { cardsPanel.removeAttribute("data-cards-tab"); } catch {} }'));

// E) version pins (manifest-driven, >= 1.41.2)
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const semver = (v) => String(v).split(".").map(Number).reduce((acc, x, i) => acc + x * [1e6, 1e3, 1][i], 0);
ok("manifest >= 1.41.2", semver(mf.version) >= 1041002, mf.version);
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
ok("README changelog + test listed", readme.includes("**1.41.2 — Templates panel closes for real.**") && readme.includes("node tests/test-v1411.js"));

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
