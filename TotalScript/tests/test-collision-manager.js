// Behavioural check for src/core/ui_collision_manager.js (run: node tests/test-collision-manager.js).
// Regression for the Notion "bar shows for a second, then vanishes" bug: a
// transparent, click-through full-viewport shell (Notion's overlay container)
// must never hide the TotalScript root; an opaque backdrop or a dialog drawn over
// the bar must.
const fs = require("fs");
const vm = require("vm");

// ── minimal DOM stub ────────────────────────────────────────────────────────
class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.id = opts.id || "";
    this.className = opts.className || "";
    this.attrs = opts.attrs || {};
    this.rect = opts.rect || { left: 0, top: 0, width: 0, height: 0 };
    this.cs = Object.assign({ display: "block", visibility: "visible", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backdropFilter: "none", webkitBackdropFilter: "none", boxShadow: "none", borderTopWidth: "0px", borderTopColor: "rgba(0, 0, 0, 0)", pointerEvents: "auto", position: "static" }, opts.cs || {});
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
    this.dataset = {};
  }
  append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  getBoundingClientRect() { const r = this.rect; return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height }; }
  matches(sel) { return sel.split(",").some((s) => matchOne(this, s.trim())); }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
}
function matchOne(el, sel) {
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  let m;
  if ((m = /^\[([\w-]+)\*="([^"]+)"\s*i?\]$/.exec(sel))) {
    const v = m[1] === "class" ? el.className : el.getAttribute(m[1]);
    return typeof v === "string" && v.toLowerCase().includes(m[2].toLowerCase());
  }
  if ((m = /^\[([\w-]+)="([^"]+)"\]$/.exec(sel))) return el.getAttribute(m[1]) === m[2];
  if ((m = /^\.([\w-]+)$/.exec(sel))) return el.className.split(/\s+/).includes(m[1]);
  if ((m = /^\.([\w-]+) \[([\w-]+)="([^"]+)"\]$/.exec(sel))) return el.getAttribute(m[2]) === m[3] && !!(el.parentElement && el.parentElement.closest("." + m[1]));
  return false;
}
function all(root, out = []) { for (const c of root.children) { out.push(c); all(c, out); } return out; }

function makeWorld() {
  const html = new El("html");
  const body = new El("body");
  html.append(body);
  const root = new El("div", { id: "rs-root" });
  const bar = new El("div", { id: "rs-bar", rect: { left: 300, top: 650, width: 600, height: 44 } });
  root.append(bar);
  html.append(root);
  const g = {
    innerWidth: 1200, innerHeight: 720, location: { href: "https://www.notion.so/chat" },
    document: { documentElement: html, body, hidden: false, getElementById: (id) => all(html).find((e) => e.id === id) || null,
      querySelectorAll: (sel) => all(html).filter((e) => e.matches(sel)), addEventListener() {}, removeEventListener() {} },
    getComputedStyle: (el) => el.cs,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => 1, cancelAnimationFrame() {}, setInterval: () => 1, clearInterval() {},
    console,
  };
  g.globalThis = g; g.window = g;
  return { g, html, body, root, bar };
}

let failed = 0;
const ok = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); if (!cond) failed++; };
const src = fs.readFileSync("src/core/ui_collision_manager.js", "utf8");

function run(setup, provider = "notion") {
  const w = makeWorld();
  setup(w);
  const ctx = vm.createContext(w.g);
  vm.runInContext(src, ctx);
  const mgr = w.g.TotalUICollisionManager.instance;
  mgr.initialize({ root: w.root, provider });
  return { state: mgr.state, hidden: w.root.style.props.visibility === "hidden" };
}

// 1. Notion shell: transparent, pointer-events:none, full viewport, no painted content.
{
  const r = run(({ body }) => {
    body.append(new El("div", { className: "notion-overlay-container notion-default-overlay-container", rect: { left: 0, top: 0, width: 1200, height: 720 }, cs: { position: "fixed", pointerEvents: "none" } }));
  });
  ok("transparent full-viewport overlay container does not hide the UI", !r.hidden && r.state === "VISIBLE", r.state);
}
// 2. Same shell but painted (dimmed backdrop) → genuine modal backdrop over the bar.
{
  const r = run(({ body }) => {
    body.append(new El("div", { className: "notion-overlay-container", rect: { left: 0, top: 0, width: 1200, height: 720 }, cs: { position: "fixed", backgroundColor: "rgba(15, 15, 15, 0.6)" } }));
  });
  ok("opaque backdrop covering the bar hides the UI", r.hidden && r.state === "TEMPORARILY_HIDDEN", r.state);
}
// 3. A dialog that does not touch the bar → stay visible.
{
  const r = run(({ body }) => {
    body.append(new El("div", { attrs: { role: "dialog" }, rect: { left: 400, top: 100, width: 400, height: 300 }, cs: { position: "fixed", backgroundColor: "rgb(255,255,255)" } }));
  });
  ok("dialog away from the bar keeps the UI visible", !r.hidden && r.state === "VISIBLE", r.state);
}
// 4. A dialog drawn over the bar → hide.
{
  const r = run(({ body }) => {
    body.append(new El("div", { attrs: { role: "dialog" }, rect: { left: 350, top: 500, width: 500, height: 200 }, cs: { position: "fixed", backgroundColor: "rgb(255,255,255)" } }));
  });
  ok("dialog over the bar hides the UI", r.hidden && r.state === "TEMPORARILY_HIDDEN", r.state);
}
// 5. The chat surface itself carries an "overlay" class and wraps the editor → never a modal.
{
  const r = run(({ body, g }) => {
    const surface = new El("div", { className: "notion-ai-overlay-surface", rect: { left: 0, top: 0, width: 1200, height: 720 }, cs: { position: "absolute", backgroundColor: "rgb(255,255,255)" } });
    const editor = new El("div", { attrs: { contenteditable: "true" }, rect: { left: 300, top: 600, width: 600, height: 40 } });
    surface.append(editor);
    body.append(surface);
    g.RSProvider = { getEditor: () => editor };
  });
  ok("painted wrapper that contains the composer is ignored", !r.hidden && r.state === "VISIBLE", r.state);
}
// 6. A popover overlapping the bar nudges instead of hiding.
{
  const r = run(({ body }) => {
    body.append(new El("div", { attrs: { role: "menu" }, rect: { left: 320, top: 620, width: 200, height: 120 }, cs: { position: "absolute", backgroundColor: "rgb(255,255,255)" } }));
  });
  ok("popover over the bar repositions instead of hiding", !r.hidden && r.state === "REPOSITIONING", r.state);
}

// 7. Opaque full-viewport page surface (chat view before its editor mounts) → visible.
{
  const r = run(({ body }) => {
    body.append(new El("div", { className: "notion-ai-fullpage-overlay", rect: { left: 0, top: 0, width: 1200, height: 720 }, cs: { position: "absolute", backgroundColor: "rgb(255, 255, 255)" } }));
  });
  ok("opaque page surface without a dialog role keeps the UI visible", !r.hidden && r.state !== "TEMPORARILY_HIDDEN", r.state);
}

process.exitCode = failed ? 1 : 0;
