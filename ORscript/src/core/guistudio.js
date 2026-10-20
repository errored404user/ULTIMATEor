/* ORscript GUI Studio — design it, build it in Studio.
 *
 * A visual Roblox GUI designer in a fixed overlay above the chat site (the
 * sibling of ORscript Paint): a device canvas (phone / tablet / desktop /
 * Studio) with drag-to-create, move / resize handles, snapping and guides,
 * multi-select, nesting, list / grid layout emulation, a property inspector
 * for every Roblox GUI property the spec engine understands, a hierarchy
 * tree, a token theme panel, 24 ready components, 10 screen templates,
 * undo / redo, JSON import / export, a Luau exporter, round-trip with a live
 * Studio (ui_export_spec) and two hand-offs: BUILD (runs ui_build_spec in
 * Studio directly, no model needed) and SEND TO AI (the spec plus an intent).
 *
 * Public API (window.ORGuiStudio):
 *   open(hooks)   hooks = {
 *     send(text, onStatus) -> Promise<boolean>        // main.js: start agent if needed, type+send
 *     runTool(name, args) -> Promise<string>           // main.js: run a Studio command now, returns feedback text
 *     studioReady() -> boolean, engine() -> string, toast(msg), diag(event, data)
 *   }
 *   close(), isOpen(), getSpec(), loadSpec(spec), toLuau(spec), buildMessage(intent)
 */
(() => {
  "use strict";
  if (window.ORGuiStudio) return;

  const SVG = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    select: SVG('<path d="M5 4l6 15 2-6 6-2z"/>'),
    frame: SVG('<rect x="4" y="5" width="16" height="14" rx="2"/>'),
    text: SVG('<path d="M5 6h14"/><path d="M12 6v13"/><path d="M9 19h6"/>'),
    button: SVG('<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M8 12h8"/>'),
    image: SVG('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>'),
    ibutton: SVG('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 15l3-3 2 2 3-4 2 5"/>'),
    textbox: SVG('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 10v4"/>'),
    scroll: SVG('<rect x="4" y="4" width="13" height="16" rx="2"/><path d="M20 7v10"/><path d="M8 9h5M8 12h5M8 15h5"/>'),
    canvas: SVG('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/>'),
    undo: SVG('<path d="M9 14H4V9"/><path d="M4 14a8 8 0 1 1 3 6"/>'),
    redo: SVG('<path d="M15 14h5V9"/><path d="M20 14a8 8 0 1 0-3 6"/>'),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    zoomIn: SVG('<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6M20 20l-4-4"/>'),
    zoomOut: SVG('<circle cx="11" cy="11" r="7"/><path d="M8 11h6M20 20l-4-4"/>'),
    fit: SVG('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    grid: SVG('<path d="M4 4h16v16H4z"/><path d="M4 10h16M4 15h16M10 4v16M15 4v16"/>'),
    magnet: SVG('<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 4h4v7H6zM14 4h4v7h-4z"/>'),
    import: SVG('<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
    open: SVG('<path d="M4 7h5l2 2h9v10H4z"/>'),
    save: SVG('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'),
    code: SVG('<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M14 4l-4 16"/>'),
    trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    dup: SVG('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    up: SVG('<path d="M6 15l6-6 6 6"/>'),
    down: SVG('<path d="M6 9l6 6 6-6"/>'),
    in: SVG('<path d="M5 12h12"/><path d="M13 8l4 4-4 4"/>'),
    out: SVG('<path d="M19 12H7"/><path d="M11 8l-4 4 4 4"/>'),
    eye: SVG('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: SVG('<path d="M3 3l18 18"/><path d="M10 6a10 10 0 0 1 12 6s-1 2-3 4M6 8c-3 2-4 4-4 4s4 7 10 7c2 0 3-.5 4-1"/>'),
    build: SVG('<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>'),
    send: SVG('<path d="M4 12l16-8-6 16-2-7z"/><path d="M12 13l8-9"/>'),
    clear: SVG('<path d="M4 7h16"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    copy: SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    align_l: SVG('<path d="M4 4v16"/><rect x="7" y="7" width="12" height="4"/><rect x="7" y="13" width="7" height="4"/>'),
    align_cx: SVG('<path d="M12 4v16"/><rect x="6" y="7" width="12" height="4"/><rect x="8" y="13" width="8" height="4"/>'),
    align_r: SVG('<path d="M20 4v16"/><rect x="5" y="7" width="12" height="4"/><rect x="10" y="13" width="7" height="4"/>'),
    align_t: SVG('<path d="M4 4h16"/><rect x="7" y="7" width="4" height="12"/><rect x="13" y="7" width="4" height="7"/>'),
    align_cy: SVG('<path d="M4 12h16"/><rect x="7" y="6" width="4" height="12"/><rect x="13" y="8" width="4" height="8"/>'),
    align_b: SVG('<path d="M4 20h16"/><rect x="7" y="5" width="4" height="12"/><rect x="13" y="10" width="4" height="7"/>'),
    dist_x: SVG('<path d="M4 4v16M20 4v16"/><rect x="9" y="8" width="6" height="8"/>'),
    dist_y: SVG('<path d="M4 4h16M4 20h16"/><rect x="8" y="9" width="8" height="6"/>'),
  };

  const DEVICES = [
    { id: "phone", label: "Phone 812×375", w: 812, h: 375, inset: 36 },
    { id: "tablet", label: "Tablet 1024×768", w: 1024, h: 768, inset: 36 },
    { id: "desktop", label: "Desktop 1366×768", w: 1366, h: 768, inset: 36 },
    { id: "studio", label: "Studio 1920×1080", w: 1920, h: 1080, inset: 36 },
  ];
  const ELEMENT_TOOLS = [
    { id: "select", label: "Select", key: "V", cls: null, hint: "Click to select, drag to move, handles to resize. Drag on empty space for a marquee." },
    { id: "frame", label: "Frame", key: "F", cls: "Frame", hint: "Drag out a Frame (container)." },
    { id: "text", label: "Text", key: "T", cls: "TextLabel", hint: "Drag out a TextLabel." },
    { id: "button", label: "Button", key: "B", cls: "TextButton", hint: "Drag out a TextButton." },
    { id: "image", label: "Image", key: "I", cls: "ImageLabel", hint: "Drag out an ImageLabel (set the asset id in Props)." },
    { id: "ibutton", label: "ImgBtn", key: "M", cls: "ImageButton", hint: "Drag out an ImageButton." },
    { id: "textbox", label: "TextBox", key: "X", cls: "TextBox", hint: "Drag out a TextBox (input)." },
    { id: "scroll", label: "Scroll", key: "S", cls: "ScrollingFrame", hint: "Drag out a ScrollingFrame." },
    { id: "canvas", label: "Canvas", key: "C", cls: "CanvasGroup", hint: "Drag out a CanvasGroup (group fades)." },
  ];
  // Simple mode: click-to-add elements and a short list of components with plain names.
  const SIMPLE_ELEMENTS = [
    { cls: "TextButton", label: "Button", sub: "something to click", icon: "button" },
    { cls: "TextLabel", label: "Text", sub: "a label or title", icon: "text" },
    { cls: "Frame", label: "Panel", sub: "a box to hold things", icon: "frame" },
    { cls: "ImageLabel", label: "Image", sub: "icon or picture", icon: "image" },
    { cls: "TextBox", label: "Text input", sub: "the player types here", icon: "textbox" },
    { cls: "ScrollingFrame", label: "Scrolling list", sub: "scrolls when full", icon: "scroll" },
  ];
  const SIMPLE_COMPONENTS = [["window", "Window"], ["modal", "Popup dialog"], ["toggle", "On / off switch"], ["slider", "Slider"], ["progress_bar", "Progress bar"], ["health_bar", "Health bar"], ["currency_hud", "Coins counter"], ["hotbar", "Hotbar"], ["card", "Shop card"], ["tabs", "Tabs"], ["toast", "Notification"], ["title", "Big title"]];
  const FRIENDLY = { Frame: "Panel", TextLabel: "Text", TextButton: "Button", ImageLabel: "Image", ImageButton: "Image button", TextBox: "Text input", ScrollingFrame: "Scrolling list", CanvasGroup: "Group" };
  const DEFAULT_SIZE = { Frame: [320, 200], TextLabel: [240, 40], TextButton: [200, 52], ImageLabel: [120, 120], ImageButton: [64, 64], TextBox: [260, 44], ScrollingFrame: [300, 240], CanvasGroup: [320, 200] };
  const CLASS_ICON = { Frame: "frame", TextLabel: "text", TextButton: "button", ImageLabel: "image", ImageButton: "ibutton", TextBox: "textbox", ScrollingFrame: "scroll", CanvasGroup: "canvas" };
  const CLASSES = Object.keys(CLASS_ICON);
  const FONTS = ["Gotham", "GothamMedium", "GothamBold", "GothamBlack", "SourceSans", "SourceSansBold", "Arial", "ArialBold", "Roboto", "RobotoMono", "FredokaOne", "Bangers", "Arcade", "PressStart2P", "Creepster", "Garamond", "Antique", "Merriweather", "Nunito", "Oswald", "Ubuntu", "Michroma", "Jura", "Fantasy", "Sarpanch", "Highway", "Bodoni", "SciFi", "Code", "Cartoon", "Legacy"];
  const FONT_CSS = { Gotham: "Montserrat, 'Segoe UI', Arial, sans-serif", GothamMedium: "Montserrat, 'Segoe UI', Arial, sans-serif", GothamBold: "Montserrat, 'Segoe UI', Arial, sans-serif", GothamBlack: "Montserrat, 'Segoe UI', Arial, sans-serif", SourceSans: "'Source Sans Pro', 'Segoe UI', Arial, sans-serif", SourceSansBold: "'Source Sans Pro', 'Segoe UI', Arial, sans-serif", Arial: "Arial, sans-serif", ArialBold: "Arial, sans-serif", Roboto: "Roboto, Arial, sans-serif", RobotoMono: "'Roboto Mono', Consolas, monospace", Code: "Consolas, monospace", FredokaOne: "'Fredoka One', 'Comic Sans MS', cursive", Bangers: "Bangers, Impact, sans-serif", Arcade: "'Press Start 2P', monospace", PressStart2P: "'Press Start 2P', monospace", Creepster: "Creepster, 'Chiller', fantasy", Garamond: "Garamond, 'Times New Roman', serif", Antique: "'Bookman Old Style', serif", Merriweather: "Merriweather, Georgia, serif", Nunito: "Nunito, 'Segoe UI', sans-serif", Oswald: "Oswald, Impact, sans-serif", Michroma: "Michroma, 'Arial Black', sans-serif", Fantasy: "fantasy", Cartoon: "'Comic Sans MS', cursive", Legacy: "Arial, sans-serif", Bodoni: "'Bodoni MT', Didot, serif", Highway: "'Arial Narrow', sans-serif", SciFi: "Orbitron, 'Arial Black', sans-serif" };
  const BOLD_FONTS = new Set(["GothamBold", "GothamBlack", "SourceSansBold", "ArialBold", "Bangers", "FredokaOne", "Oswald", "Michroma"]);
  const TOKEN_KEYS = ["bg", "surface", "surface2", "primary", "accent", "text", "muted", "danger", "success", "stroke"];
  const FALLBACK_PRESETS = { midnight: { bg: "#0f1115", surface: "#171a21", surface2: "#1f2430", primary: "#4f7cff", accent: "#7c5cff", text: "#f2f4f8", muted: "#9aa3b2", danger: "#ff5c5c", success: "#3ddc84", font: "GothamMedium", title_font: "GothamBold", radius: 10, stroke: "#2a3140", stroke_t: 0.2 } };
  const ACTION_DOS = ["toggle", "open", "close", "destroy", "print", "sound", "remote", "tween_in", "auto_hide", "pulse", "hover_grow", "hover_tint", "switch", "check", "tab", "pick_option", "select_slot", "slider", "bind_health", "bind_avatar", "show_while_hover", "focus_ring"];
  const ACTION_ONS = ["click", "hover", "enable", "focus", "drag", "parent_hover"];
  const SCALE_TYPES = ["Stretch", "Fit", "Crop", "Tile", "Slice"];
  const GRID = 8;

  const skills = () => (typeof RobloxScriptSkills !== "undefined" ? RobloxScriptSkills : null);
  const presets = () => (skills() && skills().GUI_TOKEN_PRESETS) || FALLBACK_PRESETS;
  const componentKinds = () => (skills() && skills().GUI_COMPONENT_KINDS) || [];

  // ───────────────────────── state ─────────────────────────
  let seq = 0;
  const uid = () => "n" + (++seq).toString(36) + Date.now().toString(36).slice(-3);
  const S = {
    open: false, hooks: null, tool: "select", device: DEVICES[2], zoom: 1, grid: true, snap: true,
    screen: { name: "OR_UI", ignore_inset: true, reset_on_spawn: false, display_order: 0 },
    preset: "midnight", tokens: Object.assign({}, FALLBACK_PRESETS.midnight),
    nodes: [], sel: [], history: [], redo: [], clipboard: null, sideTab: "props", intent: "",
    studioScreens: [],
    simple: (() => { try { return localStorage.getItem("rsg-mode") !== "advanced"; } catch { return true; } })(),
  };
  const byId = new Map();
  let D = null; // DOM refs
  let drag = null; // active pointer op
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let toastTimer = 0;
  const toast = (m) => {
    try {
      if (S.open && D && D.toast) { D.toast.textContent = String(m); D.toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => D.toast.classList.remove("show"), 2600); return; }
      if (S.hooks && S.hooks.toast) S.hooks.toast(m); else console.log("[GUI Studio]", m);
    } catch {}
  };
  const diag = (e, d) => { try { S.hooks && S.hooks.diag && S.hooks.diag("gui." + e, d || {}); } catch {} };
  const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

  function tokenColor(v, fallback) {
    if (v == null || v === "") return fallback || null;
    if (Array.isArray(v) && v.length >= 3) return "#" + v.slice(0, 3).map((n) => clamp(Math.round(Number(n) || 0), 0, 255).toString(16).padStart(2, "0")).join("");
    const s = String(v);
    if (s[0] === "#") return s;
    if (S.tokens[s] != null && String(S.tokens[s])[0] === "#") return S.tokens[s];
    if (/^[0-9a-f]{6}$/i.test(s)) return "#" + s;
    return fallback || null;
  }
  function tokenNum(v, fallback) { if (v == null || v === "") return fallback; if (typeof v === "number") return v; const t = S.tokens[String(v)]; if (typeof t === "number") return t; const n = Number(v); return Number.isFinite(n) ? n : fallback; }
  function tokenFont(v) { if (v == null || v === "") return S.tokens.font || "GothamMedium"; const t = S.tokens[String(v)]; return typeof t === "string" ? t : String(v); }

  // ───────────────────────── model ─────────────────────────
  function makeNode(cls, props = {}) {
    const n = Object.assign({ id: uid(), class: cls, name: cls, size: [0, 200, 0, 50], position: [0, 0, 0, 0], children: [] }, props);
    if (!n.children) n.children = [];
    if (cls === "TextLabel" || cls === "TextButton" || cls === "TextBox") { if (n.text == null) n.text = cls === "TextBox" ? "" : cls === "TextButton" ? "Button" : "Label"; if (n.text_color == null) n.text_color = cls === "TextButton" ? "#ffffff" : "text"; if (n.font == null) n.font = cls === "TextButton" ? "title_font" : "font"; if (n.text_size == null && !n.text_scaled) n.text_size = 16; }
    if (cls === "TextLabel" && n.bg == null && n.bg_t == null) n.bg_t = 1;
    if (cls === "ImageLabel" && n.bg == null && n.bg_t == null) { n.bg = "surface2"; }
    if (cls === "TextButton" && n.bg == null) { n.bg = "primary"; if (n.corner == null) n.corner = "radius"; }
    if (cls === "ImageButton" && n.bg == null) { n.bg = "surface2"; if (n.corner == null) n.corner = "radius"; }
    if (cls === "Frame" && n.bg == null) { n.bg = "surface"; if (n.corner == null) n.corner = "radius"; }
    if (cls === "ScrollingFrame" && n.bg == null) { n.bg = "surface2"; if (n.corner == null) n.corner = "radius"; if (!n.scroll) n.scroll = { auto: "Y", thickness: 6 }; }
    if (cls === "TextBox" && n.bg == null) { n.bg = "surface2"; if (n.corner == null) n.corner = 8; if (n.placeholder == null) n.placeholder = "Type here…"; }
    return n;
  }
  function adopt(node, parent) {
    // import a spec node (recursively) → model node with ids
    const n = Object.assign({}, node);
    n.id = n.id || uid();
    if (!CLASSES.includes(n.class)) n.class = "Frame";
    n.name = String(n.name || n.class);
    if (!Array.isArray(n.size) || n.size.length !== 4) n.size = [0, 200, 0, 50];
    if (!Array.isArray(n.position) || n.position.length !== 4) n.position = [0, 0, 0, 0];
    n.size = n.size.map(Number); n.position = n.position.map(Number);
    n.children = Array.isArray(node.children) ? node.children.map((c) => adopt(c, n)) : [];
    n._parent = parent ? parent.id : null;
    return n;
  }
  function reindex() {
    byId.clear();
    const walk = (list, parentId) => { for (const n of list) { n._parent = parentId; byId.set(n.id, n); walk(n.children || [], n.id); } };
    walk(S.nodes, null);
  }
  function parentOf(n) { return n._parent ? byId.get(n._parent) : null; }
  function siblingsOf(n) { const p = parentOf(n); return p ? p.children : S.nodes; }
  function pathOf(n) { const parts = []; let c = n; while (c) { parts.unshift(c.name); c = parentOf(c); } return parts.join("."); }
  function isDescendant(n, maybeAncestor) { let c = parentOf(n); while (c) { if (c === maybeAncestor) return true; c = parentOf(c); } return false; }
  function strip(n) {
    const out = {};
    for (const k of Object.keys(n)) { if (k === "id" || k[0] === "_" || k === "children") continue; const v = n[k]; if (v === undefined || v === null || v === "") continue; out[k] = v; }
    if (n.children && n.children.length) out.children = n.children.map(strip);
    return out;
  }
  function getSpec() { return { screen: Object.assign({}, S.screen), preset: S.preset, tokens: Object.assign({}, S.tokens), children: S.nodes.map(strip) }; }
  function loadSpec(spec, opts = {}) {
    if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch { toast("That is not valid JSON"); return false; } }
    if (!spec || typeof spec !== "object") return false;
    if (!opts.silent) pushHistory();
    const roots = Array.isArray(spec) ? spec : (spec.children || spec.root || spec.nodes || spec.widgets || []);
    if (spec.screen) { if (typeof spec.screen === "string") S.screen.name = spec.screen; else Object.assign(S.screen, spec.screen); }
    else if (spec.name) S.screen.name = String(spec.name);
    if (spec.preset && presets()[spec.preset]) { S.preset = spec.preset; S.tokens = Object.assign({}, presets()[spec.preset]); }
    if (spec.tokens && typeof spec.tokens === "object") Object.assign(S.tokens, spec.tokens);
    S.nodes = roots.map((r) => adopt(r, null));
    S.sel = [];
    reindex(); renderAll();
    diag("load", { nodes: byId.size });
    return true;
  }

  // ───────────────────────── history ─────────────────────────
  function snapshot() { return JSON.stringify({ nodes: S.nodes.map(strip), screen: S.screen, preset: S.preset, tokens: S.tokens, sel: S.sel.map((n) => pathOf(n)) }); }
  function restore(json) {
    const d = JSON.parse(json);
    S.nodes = d.nodes.map((r) => adopt(r, null)); S.screen = d.screen; S.preset = d.preset; S.tokens = d.tokens;
    reindex();
    S.sel = (d.sel || []).map((p) => findByPath(p)).filter(Boolean);
    renderAll();
  }
  function pushHistory() { S.history.push(snapshot()); if (S.history.length > 120) S.history.shift(); S.redo.length = 0; syncButtons(); }
  function undo() { const j = S.history.pop(); if (!j) return; S.redo.push(snapshot()); restore(j); diag("undo"); syncButtons(); }
  function redo() { const j = S.redo.pop(); if (!j) return; S.history.push(snapshot()); restore(j); diag("redo"); syncButtons(); }
  function findByPath(path) { const parts = String(path).split("."); let list = S.nodes, cur = null; for (const p of parts) { cur = list.find((n) => n.name === p); if (!cur) return null; list = cur.children; } return cur; }

  // ───────────────────────── geometry ─────────────────────────
  // All boxes in device pixels (unzoomed). Parent content box accounts for
  // UIPadding; children of a list / grid parent are laid out by the emulator.
  const geo = new Map(); // id → {x,y,w,h, cx,cy,cw,ch}
  function screenBox() { const d = S.device; const inset = S.screen.ignore_inset === false ? d.inset : 0; return { x: 0, y: inset, w: d.w, h: d.h - inset }; }
  function padOf(n) { const p = n.padding; if (p == null) return { l: 0, r: 0, t: 0, b: 0 }; if (typeof p === "object") return { l: tokenNum(p.left != null ? p.left : p.l != null ? p.l : p.x, 0), r: tokenNum(p.right != null ? p.right : p.r != null ? p.r : p.x, 0), t: tokenNum(p.top != null ? p.top : p.t != null ? p.t : p.y, 0), b: tokenNum(p.bottom != null ? p.bottom : p.b != null ? p.b : p.y, 0) }; const v = tokenNum(p, 8); return { l: v, r: v, t: v, b: v }; }
  function contentOf(box, n) { const p = padOf(n); return { x: box.x + p.l, y: box.y + p.t, w: Math.max(0, box.w - p.l - p.r), h: Math.max(0, box.h - p.t - p.b) }; }
  function udim(arr, pw, ph) { return { x: arr[0] * pw + arr[1], y: arr[2] * ph + arr[3] }; }
  function layoutChildren(parent, content) {
    const kids = parent.children || [];
    const ly = parent.layout && (typeof parent.layout === "object" ? parent.layout : { kind: parent.layout });
    if (!ly) { for (const c of kids) measure(c, content); return; }
    const kind = String(ly.kind || "list").toLowerCase();
    const gap = tokenNum(ly.gap != null ? ly.gap : ly.padding, kind === "grid" ? 6 : 8);
    const horiz = String(ly.direction || (kind === "grid" ? "Horizontal" : "Vertical")).toLowerCase().startsWith("h");
    const hA = String(ly.h_align || "Left").toLowerCase(), vA = String(ly.v_align || "Top").toLowerCase();
    const sorted = kids.slice().sort((a, b) => (a.layout_order || 0) - (b.layout_order || 0));
    if (kind === "grid") {
      const cell = Array.isArray(ly.cell) && ly.cell.length === 4 ? ly.cell : [0, 80, 0, 80];
      const cw = cell[0] * content.w + cell[1], ch = cell[2] * content.h + cell[3];
      const perRow = Math.max(1, Math.floor((content.w + gap) / (cw + gap)));
      sorted.forEach((c, i) => { const col = i % perRow, row = Math.floor(i / perRow); const x = content.x + col * (cw + gap), y = content.y + row * (ch + gap); place(c, { x, y, w: cw, h: ch }); });
      return;
    }
    // list
    let sizes = sorted.map((c) => { const s = udim(c.size, content.w, content.h); return { w: Math.max(0, s.x), h: Math.max(0, s.y) }; });
    const total = sizes.reduce((a, s) => a + (horiz ? s.w : s.h), 0) + gap * Math.max(0, sorted.length - 1);
    let cursor = horiz ? content.x : content.y;
    if (horiz && hA === "center") cursor = content.x + (content.w - total) / 2; else if (horiz && hA === "right") cursor = content.x + content.w - total;
    if (!horiz && vA === "center") cursor = content.y + (content.h - total) / 2; else if (!horiz && vA === "bottom") cursor = content.y + content.h - total;
    sorted.forEach((c, i) => {
      const s = sizes[i];
      let x, y;
      if (horiz) { x = cursor; y = vA === "center" ? content.y + (content.h - s.h) / 2 : vA === "bottom" ? content.y + content.h - s.h : content.y; cursor += s.w + gap; }
      else { y = cursor; x = hA === "center" ? content.x + (content.w - s.w) / 2 : hA === "right" ? content.x + content.w - s.w : content.x; cursor += s.h + gap; }
      place(c, { x, y, w: s.w, h: s.h });
    });
  }
  function place(n, box) { geo.set(n.id, box); layoutChildren(n, contentOf(box, n)); }
  function measure(n, content) {
    const s = udim(n.size, content.w, content.h), p = udim(n.position, content.w, content.h);
    const ax = n.anchor ? Number(n.anchor[0]) || 0 : 0, ay = n.anchor ? Number(n.anchor[1]) || 0 : 0;
    let w = Math.max(0, s.x), h = Math.max(0, s.y);
    if (n.aspect) { const r = tokenNum(n.aspect, 1); h = w / r; }
    place(n, { x: content.x + p.x - ax * w, y: content.y + p.y - ay * h, w, h });
  }
  function computeGeometry() { geo.clear(); const sb = screenBox(); for (const n of S.nodes) measure(n, sb); }
  function parentContent(n) { const p = parentOf(n); if (!p) return screenBox(); const b = geo.get(p.id); return contentOf(b, p); }
  function inLayout(n) { const p = parentOf(n); return !!(p && p.layout); }
  function usesScale(arr, axis) { const i = axis === "x" ? 0 : 2; return arr[i + 1] === 0 && arr[i] !== 0; }
  function setBox(n, box) {
    // write back x/y/w/h (device px, top-left) into the node's UDim2s keeping its scale/offset style
    const pc = parentContent(n);
    const ax = n.anchor ? Number(n.anchor[0]) || 0 : 0, ay = n.anchor ? Number(n.anchor[1]) || 0 : 0;
    const px = box.x - pc.x + ax * box.w, py = box.y - pc.y + ay * box.h;
    const pos = n.position.slice(), size = n.size.slice();
    if (usesScale(pos, "x")) { pos[0] = round(px / Math.max(1, pc.w)); pos[1] = 0; } else { pos[0] = pos[0]; pos[1] = Math.round(px - pos[0] * pc.w); }
    if (usesScale(pos, "y")) { pos[2] = round(py / Math.max(1, pc.h)); pos[3] = 0; } else { pos[3] = Math.round(py - pos[2] * pc.h); }
    if (usesScale(size, "x")) { size[0] = round(box.w / Math.max(1, pc.w)); size[1] = 0; } else { size[1] = Math.round(box.w - size[0] * pc.w); }
    if (usesScale(size, "y")) { size[2] = round(box.h / Math.max(1, pc.h)); size[3] = 0; } else { size[3] = Math.round(box.h - size[2] * pc.h); }
    n.position = pos; n.size = size;
  }
  function toScale(n, what) {
    const pc = parentContent(n), b = geo.get(n.id); if (!b) return;
    if (what !== "size") { const ax = n.anchor ? Number(n.anchor[0]) || 0 : 0, ay = n.anchor ? Number(n.anchor[1]) || 0 : 0; n.position = [round((b.x - pc.x + ax * b.w) / Math.max(1, pc.w)), 0, round((b.y - pc.y + ay * b.h) / Math.max(1, pc.h)), 0]; }
    if (what !== "position") n.size = [round(b.w / Math.max(1, pc.w)), 0, round(b.h / Math.max(1, pc.h)), 0];
  }
  function toOffset(n, what) {
    const pc = parentContent(n), b = geo.get(n.id); if (!b) return;
    if (what !== "size") { const ax = n.anchor ? Number(n.anchor[0]) || 0 : 0, ay = n.anchor ? Number(n.anchor[1]) || 0 : 0; n.position = [0, Math.round(b.x - pc.x + ax * b.w), 0, Math.round(b.y - pc.y + ay * b.h)]; }
    if (what !== "position") n.size = [0, Math.round(b.w), 0, Math.round(b.h)];
  }

  // ───────────────────────── rendering ─────────────────────────
  function styleFor(n, box) {
    const st = [];
    const bgT = n.bg_t != null ? tokenNum(n.bg_t, 0) : (n.bg == null && (n.class === "TextLabel" || n.class === "ImageLabel") ? 1 : 0);
    const bg = tokenColor(n.bg, n.class === "TextLabel" ? null : "#1f2430");
    if (n.gradient && bgT < 1) { const g = typeof n.gradient === "object" ? n.gradient : {}; const a = tokenColor(g.from || g[0], tokenColor("primary", "#4f7cff")), b = tokenColor(g.to || g[1], tokenColor("accent", "#7c5cff")); const rot = tokenNum(g.rotation, 90) + 90; st.push(`background:linear-gradient(${rot}deg, ${a}, ${b})`); if (bgT > 0) st.push(`opacity:${1 - bgT}`); }
    else if (bg && bgT < 1) st.push(`background:${hexA(bg, 1 - bgT)}`);
    else st.push("background:transparent");
    if (n.corner != null) { const c = n.corner; st.push(`border-radius:${typeof c === "object" ? (tokenNum(c.scale, 0) * Math.min(box.w, box.h) + tokenNum(c.offset, 8)) : tokenNum(c, 8)}px`); }
    if (n.stroke != null) { const s = typeof n.stroke === "object" ? n.stroke : { color: n.stroke }; const col = tokenColor(s.color || "stroke", "#ffffff"); const t = tokenNum(s.thickness, 1); const tr = tokenNum(s.transparency, 0); st.push(`box-shadow:0 0 0 ${t}px ${hexA(col, 1 - tr)}`); }
    if (n.visible === false) st.push("opacity:.25;outline:1px dashed rgba(255,255,255,.35)");
    if (n.rotation) st.push(`transform:rotate(${n.rotation}deg)`);
    if (n.clips || n.class === "ScrollingFrame" || n.class === "CanvasGroup") st.push("overflow:hidden");
    return st.join(";");
  }
  function hexA(hex, a) { if (!hex || hex[0] !== "#" || hex.length < 7) return hex || "transparent"; const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return a >= 1 ? hex : `rgba(${r},${g},${b},${clamp(a, 0, 1)})`; }
  function textStyle(n, box) {
    const font = tokenFont(n.font); const fam = FONT_CSS[font] || FONT_CSS.Gotham;
    const size = n.text_scaled || n.text_size == null ? Math.max(8, Math.min(box.h * 0.7, box.w / Math.max(3, String(n.text || "").length * 0.6))) : tokenNum(n.text_size, 14);
    const col = tokenColor(n.text_color || "text", "#ffffff");
    const ax = String(n.align_x || "Center").toLowerCase(), ay = String(n.align_y || "Center").toLowerCase();
    const jc = ax === "left" ? "flex-start" : ax === "right" ? "flex-end" : "center";
    const ai = ay === "top" ? "flex-start" : ay === "bottom" ? "flex-end" : "center";
    const sh = n.text_stroke ? `text-shadow:0 0 1px ${tokenColor(typeof n.text_stroke === "object" ? n.text_stroke.color : "#000000", "#000")},0 0 2px ${tokenColor(typeof n.text_stroke === "object" ? n.text_stroke.color : "#000000", "#000")};` : "";
    const op = n.text_t ? `opacity:${1 - tokenNum(n.text_t, 0)};` : "";
    return `font-family:${fam};font-weight:${BOLD_FONTS.has(font) ? 700 : 500};font-size:${size}px;color:${col};justify-content:${jc};align-items:${ai};text-align:${ax};${n.wrap ? "white-space:normal;" : "white-space:nowrap;"}${sh}${op}`;
  }
  function renderNode(n, pb) {
    const box = geo.get(n.id); if (!box) return "";
    pb = pb || { x: 0, y: 0 };
    const selected = S.sel.includes(n);
    const inner = [];
    if (n.class === "TextLabel" || n.class === "TextButton" || n.class === "TextBox") {
      const txt = n.class === "TextBox" && !n.text ? (n.placeholder || "") : n.text;
      inner.push(`<div class="rsg-txt${n.class === "TextBox" && !n.text ? " ph" : ""}" style="${textStyle(n, box)}">${esc(txt)}</div>`);
    }
    if (n.class === "ImageLabel" || n.class === "ImageButton") {
      const img = String(n.image || "");
      const tint = tokenColor(n.image_color, null);
      if (/^(https?:|data:)/.test(img)) inner.push(`<img class="rsg-img" src="${esc(img)}" alt="" style="object-fit:${n.scale_type === "Fit" ? "contain" : n.scale_type === "Crop" ? "cover" : "fill"};opacity:${1 - tokenNum(n.image_t, 0)}">`);
      else inner.push(`<div class="rsg-imgph" style="${tint ? "color:" + tint : ""}">${I.image}<span>${esc(img ? img.replace(/^rbxassetid:\/\//, "id ") : "image")}</span></div>`);
    }
    if (n.class === "ScrollingFrame") inner.push(`<div class="rsg-scrollbar" style="width:${tokenNum(n.scroll && n.scroll.thickness, 6)}px"></div>`);
    const kids = (n.children || []).slice().sort((a, b) => (a.z || 1) - (b.z || 1)).map((c) => renderNode(c, box)).join("");
    const handles = selected && S.sel.length === 1 && !inLayout(n) ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `<i class="rsg-h rsg-h-${h}" data-h="${h}"></i>`).join("") : "";
    return `<div class="rsg-n${selected ? " sel" : ""}${inLayout(n) ? " inlayout" : ""}" data-id="${n.id}" style="left:${box.x - pb.x}px;top:${box.y - pb.y}px;width:${box.w}px;height:${box.h}px;z-index:${(n.z || 1)};${styleFor(n, box)}">${inner.join("")}${kids}${handles}${selected ? `<b class="rsg-tag">${esc(n.name)} · ${Math.round(box.w)}×${Math.round(box.h)}</b>` : ""}</div>`;
  }
  function renderStage() {
    if (!D) return;
    computeGeometry();
    const d = S.device; const sb = screenBox();
    D.screen.style.width = d.w + "px"; D.screen.style.height = d.h + "px";
    D.screen.style.transform = `scale(${S.zoom})`;
    D.screen.style.setProperty("--rsg-inv", String(round(1 / S.zoom, 3)));
    D.screen.classList.toggle("grid", S.grid);
    D.screen.style.setProperty("--rsg-bg", tokenColor("bg", "#0f1115"));
    const inset = S.screen.ignore_inset === false ? `<div class="rsg-inset" style="height:${d.inset}px"></div>` : `<div class="rsg-inset ghost" style="height:${d.inset}px"></div>`;
    const roots = S.nodes.slice().sort((a, b) => (a.z || 1) - (b.z || 1)).map((r) => renderNode(r, null)).join("");
    const empty = S.nodes.length ? "" : `<div class="rsg-empty-stage"><b>Start with a ready screen</b><div class="rsg-start">${TEMPLATES.map((t) => `<button type="button" data-tpl="${t.id}">${esc(t.label)}</button>`).join("")}</div><span>…or add your own: ${S.simple ? "click <b>Button</b>, <b>Text</b> or <b>Panel</b> on the left" : "pick a tool on the left and drag it out here"}.</span>${S.simple ? "" : `<span>V select · F frame · B button · T text · I image · Shift+drag multi-select · Del delete · Ctrl+Z undo</span>`}</div>`;
    D.screen.innerHTML = inset + roots + empty + `<div class="rsg-marquee" hidden></div><div class="rsg-guides"></div>`;
    D.marquee = D.screen.querySelector(".rsg-marquee"); D.guides = D.screen.querySelector(".rsg-guides");
    D.stageWrap.style.width = Math.round(d.w * S.zoom) + "px"; D.stageWrap.style.height = Math.round(d.h * S.zoom) + "px";
    void sb;
  }
  function renderTree() {
    if (!D) return;
    const row = (n, depth) => `<div class="rsg-tr${S.sel.includes(n) ? " sel" : ""}" data-id="${n.id}" style="--d:${depth}"><span class="rsg-tr-ic">${I[CLASS_ICON[n.class]] || I.frame}</span><span class="rsg-tr-name" title="${esc(pathOf(n))}">${esc(n.name)}</span><span class="rsg-tr-cls">${esc(n.class)}${n.layout ? " · layout" : ""}${n.actions && n.actions.length ? " · ⚡" + n.actions.length : ""}</span><button type="button" class="rsg-tr-eye" data-eye="${n.id}" title="${n.visible === false ? "Hidden — click to show" : "Visible — click to hide"}">${n.visible === false ? I.eyeOff : I.eye}</button></div>` + (n.children || []).map((c) => row(c, depth + 1)).join("");
    D.tree.innerHTML = S.nodes.length ? S.nodes.map((n) => row(n, 0)).join("") : `<div class="rsg-empty">Nothing yet — pick a tool on the left and drag on the screen, or drop a component / template.</div>`;
  }
  function renderCode() {
    if (!D || S.sideTab !== "code") return;
    const spec = getSpec();
    D.codeJson.value = JSON.stringify(spec, null, 2);
    D.codeLua.value = toLuau(spec);
  }
  function renderAll() { renderStage(); renderTree(); renderProps(); renderCode(); syncButtons(); syncTheme(); }

  // ───────────────────────── props panel ─────────────────────────
  // A <div>, not a <label>: several rows hold more than one control (and inner
  // <label class="rsg-mini"> checkboxes), and a wrapping label would re-toggle
  // the first checkbox on every click inside the row.
  function field(label, html, hint) { return `<div class="rsg-f" ${hint ? `title="${esc(hint)}"` : ""}><span>${esc(label)}</span>${html}</div>`; }
  const inp = (k, v, type = "text", extra = "") => `<input data-k="${k}" type="${type}" value="${esc(v == null ? "" : v)}" ${extra}>`;
  const num = (k, v, extra = "") => inp(k, v, "number", `step="any" ${extra}`);
  const chk = (k, v) => `<input data-k="${k}" type="checkbox" ${v ? "checked" : ""}>`;
  const sel = (k, v, opts, allowEmpty) => `<select data-k="${k}">${allowEmpty ? `<option value="">—</option>` : ""}${opts.map((o) => `<option value="${esc(o)}" ${String(v) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  function colorField(k, v, allowToken) {
    const hex = tokenColor(v, "#000000");
    const isTok = typeof v === "string" && v[0] !== "#" && S.tokens[v] != null;
    return `<span class="rsg-color"><input data-k="${k}" data-kind="color" type="color" value="${esc(hex)}">${allowToken !== false ? sel(k + "@tok", isTok ? v : "", TOKEN_KEYS, true) : ""}<input data-k="${k}" data-kind="raw" type="text" value="${esc(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v)}" placeholder="#hex / token"></span>`;
  }
  function udimField(k, arr) { return `<span class="rsg-udim"><input data-k="${k}.0" type="number" step="0.01" value="${arr[0]}" title="Scale X"><input data-k="${k}.1" type="number" step="1" value="${arr[1]}" title="Offset X"><input data-k="${k}.2" type="number" step="0.01" value="${arr[2]}" title="Scale Y"><input data-k="${k}.3" type="number" step="1" value="${arr[3]}" title="Offset Y"></span>`; }
  function renderProps() {
    if (!D) return;
    if (S.sideTab !== "props") return;
    const active = document.activeElement;
    const keep = active && D.props.contains(active) && active.dataset && active.dataset.k ? { k: active.dataset.k, kind: active.dataset.kind || "" } : null;
    const scroll = D.side ? D.side.scrollTop : 0;
    renderPropsInner();
    if (D.side) D.side.scrollTop = scroll;
    if (keep) { const el = D.props.querySelector(`[data-k="${keep.k}"]${keep.kind ? `[data-kind="${keep.kind}"]` : ':not([data-kind])'}`); if (el) { try { el.focus({ preventScroll: true }); } catch {} } }
  }
  function targetOptions(n) {
    const out = [];
    const walk = (list) => { for (const x of list) { if (x !== n && !isDescendant(x, n)) out.push({ value: "gui." + pathOf(x), label: x.name + " (" + (FRIENDLY[x.class] || x.class) + ")" }); walk(x.children || []); } };
    walk(S.nodes); return out;
  }
  function renderPropsSimple(n) {
    const isText = /^(TextLabel|TextButton|TextBox)$/.test(n.class), isImg = /^(ImageLabel|ImageButton)$/.test(n.class), isBtn = /Button$/.test(n.class);
    const box = geo.get(n.id) || { x: 0, y: 0, w: 0, h: 0 };
    const pc = parentContent(n);
    const bgHidden = n.bg_t != null ? tokenNum(n.bg_t, 0) >= 1 : (n.bg == null && n.class === "TextLabel");
    const a0 = (n.actions || [])[0] || null;
    const simpleDos = [["", "nothing"], ["open", "open something"], ["close", "close something"], ["toggle", "show / hide something"], ["destroy", "remove something"], ["pulse", "pulse (attention)"]];
    const tOpts = targetOptions(n);
    const sk = (k, v, type = "text", extra = "") => `<input data-sk="${k}" type="${type}" value="${esc(v == null ? "" : v)}" ${extra}>`;
    D.props.innerHTML = `
      <div class="rsg-sec"><h4>${esc(FRIENDLY[n.class] || n.class)} <small>${esc(pathOf(n))}</small></h4>
        ${field("Name", sk("name", n.name), "How it is called in Studio")}
        ${isText ? field("Text", `<textarea data-sk="text" rows="2">${esc(n.text || "")}</textarea>`) : ""}
        ${isImg ? field("Image id", sk("image", n.image || "", "text", 'placeholder="rbxassetid://… or a number"')) : ""}
      </div>
      <div class="rsg-sec"><h4>Look</h4>
        ${field("Fill colour", `<span class="rsg-color"><input data-sk="bg" type="color" value="${esc(tokenColor(n.bg, "#1f2430") || "#1f2430")}"><label class="rsg-mini"><input data-sk="bg_none" type="checkbox" ${bgHidden ? "checked" : ""}> no fill</label></span>`)}
        ${isText ? field("Text colour", `<input data-sk="text_color" type="color" value="${esc(tokenColor(n.text_color || "text", "#ffffff"))}">`) : ""}
        ${isText ? field("Text size", `<span class="rsg-inline">${sk("text_size", n.text_size != null ? n.text_size : "", "number", 'min="6" placeholder="auto"')}<span class="rsg-mini">px (empty = fit)</span></span>`) : ""}
        ${field("Rounded corners", `<span class="rsg-inline">${sk("corner", n.corner != null ? (typeof n.corner === "number" ? n.corner : tokenNum(n.corner, 10)) : 0, "number", 'min="0"')}<span class="rsg-mini">px</span></span>`)}
        ${field("Visible", `<input data-sk="visible" type="checkbox" ${n.visible === false ? "" : "checked"}>`)}
      </div>
      <div class="rsg-sec"><h4>Size &amp; place <small>or just drag it</small></h4>
        ${field("Width × Height", `<span class="rsg-inline">${sk("w", Math.round(box.w), "number", 'min="1"')}${sk("h", Math.round(box.h), "number", 'min="1"')}</span>`)}
        ${inLayout(n) ? `<p class="rsg-hint">Placed automatically by its parent's layout.</p>` : field("X · Y", `<span class="rsg-inline">${sk("x", Math.round(box.x - pc.x), "number")}${sk("y", Math.round(box.y - pc.y), "number")}</span>`, "Pixels from the top-left of the parent")}
        <div class="rsg-row"><button type="button" class="rsg-btn sm" data-act="centerInParent">Centre it</button><button type="button" class="rsg-btn sm" data-act="fillParent">Fill the screen</button></div>
      </div>
      ${isBtn ? `<div class="rsg-sec"><h4>When clicked</h4>
        ${field("Do", `<select data-sk="act_do">${simpleDos.map(([v, l]) => `<option value="${v}" ${(a0 ? a0.do : "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${a0 && a0.do && a0.do !== "pulse" ? field("Which one", `<select data-sk="act_target"><option value="">pick an element…</option>${tOpts.map((o) => `<option value="${esc(o.value)}" ${a0.target === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`, "Add a Window or Panel first, then pick it here") : ""}
        <p class="rsg-hint">Anything more (sounds, remotes, tweens) — ask the AI in the box below, or switch to Advanced.</p>
      </div>` : ""}
      <div class="rsg-sec">
        <div class="rsg-row"><button type="button" class="rsg-btn sm" data-act="dup">${I.dup} Duplicate</button><button type="button" class="rsg-btn sm danger" data-act="delete">${I.trash} Delete</button><button type="button" class="rsg-btn sm" data-mode="advanced">More options…</button></div>
      </div>`;
  }
  function applySimple(n, k, el) {
    const v = el.value;
    if (k === "name") { n.name = v.trim() || n.class; reindex(); return; }
    if (k === "text") { n.text = v; return; }
    if (k === "image") { n.image = v.trim(); return; }
    if (k === "bg") { n.bg = v; if (n.bg_t != null && tokenNum(n.bg_t, 0) >= 1) delete n.bg_t; return; }
    if (k === "bg_none") { if (el.checked) n.bg_t = 1; else { delete n.bg_t; if (n.bg == null) n.bg = "surface"; } return; }
    if (k === "text_color") { n.text_color = v; return; }
    if (k === "text_size") { if (v === "") { delete n.text_size; n.text_scaled = true; } else { n.text_size = Math.max(6, Number(v) || 16); delete n.text_scaled; } return; }
    if (k === "corner") { const c = Number(v) || 0; if (c <= 0) delete n.corner; else n.corner = c; return; }
    if (k === "visible") { if (el.checked) delete n.visible; else n.visible = false; return; }
    if (k === "w" || k === "h" || k === "x" || k === "y") {
      computeGeometry(); const b = Object.assign({}, geo.get(n.id)); const pc = parentContent(n); const num = Number(v) || 0;
      if (k === "w") b.w = Math.max(1, num); if (k === "h") b.h = Math.max(1, num); if (k === "x") b.x = pc.x + num; if (k === "y") b.y = pc.y + num;
      setBox(n, b); return;
    }
    if (k === "act_do") { if (!v) { delete n.actions; return; } n.actions = n.actions || []; const a = n.actions[0] || { on: "click" }; a.on = "click"; a.do = v; if (v === "pulse") { delete a.target; a.seconds = 3; } n.actions[0] = a; return; }
    if (k === "act_target") { if (n.actions && n.actions[0]) { if (v) n.actions[0].target = v; else delete n.actions[0].target; } return; }
  }
  function renderPropsInner() {
    const n = S.sel.length === 1 ? S.sel[0] : null;
    if (S.simple && n) { renderPropsSimple(n); return; }
    if (S.simple && !n && S.sel.length < 2) {
      D.props.innerHTML = `<div class="rsg-sec"><h4>How it works</h4><ol class="rsg-steps"><li>Click <b>Button</b>, <b>Text</b>, <b>Panel</b>… on the left — it appears in the middle of the screen.</li><li>Drag it where you want; drag a corner to resize. Click it to edit text and colours here.</li><li>Pick a <b>Theme</b> above to recolour everything.</li><li>Press <b>Build in Studio</b> to see it in Roblox, or <b>Send to AI</b> to have it scripted.</li></ol><p class="rsg-hint">Double-click text to edit it · Delete removes · Ctrl+Z undoes · Shift+click selects several.</p><div class="rsg-row"><button type="button" class="rsg-btn sm" data-mode="advanced">Advanced mode</button></div></div>`;
      return;
    }
    if (!n) {
      D.props.innerHTML = S.sel.length > 1
        ? `<div class="rsg-sec"><h4>${S.sel.length} selected</h4><div class="rsg-row rsg-align"><button type="button" data-act="align:left" title="Align left">${I.align_l}</button><button type="button" data-act="align:center_x" title="Align centre X">${I.align_cx}</button><button type="button" data-act="align:right" title="Align right">${I.align_r}</button><button type="button" data-act="align:top" title="Align top">${I.align_t}</button><button type="button" data-act="align:center_y" title="Align centre Y">${I.align_cy}</button><button type="button" data-act="align:bottom" title="Align bottom">${I.align_b}</button><button type="button" data-act="dist:x" title="Distribute horizontally">${I.dist_x}</button><button type="button" data-act="dist:y" title="Distribute vertically">${I.dist_y}</button></div><div class="rsg-row"><button type="button" class="rsg-btn" data-act="group">Group into Frame</button><button type="button" class="rsg-btn" data-act="sameSize">Same size</button><button type="button" class="rsg-btn danger" data-act="delete">Delete</button></div></div>`
        : `<div class="rsg-sec"><h4>Screen</h4>${field("ScreenGui name", inp("screen.name", S.screen.name))}${field("IgnoreGuiInset", chk("screen.ignore_inset", S.screen.ignore_inset !== false), "Draw under the top bar (full screen)")}${field("ResetOnSpawn", chk("screen.reset_on_spawn", !!S.screen.reset_on_spawn))}${field("DisplayOrder", num("screen.display_order", S.screen.display_order || 0))}<p class="rsg-hint">Select an element to edit it. Drag on the screen with a tool to create one. Multi-select with Shift-click or a marquee for align / distribute.</p></div>`;
      return;
    }
    const isText = /^(TextLabel|TextButton|TextBox)$/.test(n.class), isImg = /^(ImageLabel|ImageButton)$/.test(n.class);
    const box = geo.get(n.id) || { w: 0, h: 0 };
    const ly = n.layout && typeof n.layout === "object" ? n.layout : n.layout ? { kind: n.layout } : null;
    const st = n.stroke && typeof n.stroke === "object" ? n.stroke : n.stroke ? { color: n.stroke } : null;
    const gr = n.gradient && typeof n.gradient === "object" ? n.gradient : null;
    const anchorGrid = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]].map(([x, y]) => `<button type="button" class="rsg-ap${n.anchor && Number(n.anchor[0]) === x && Number(n.anchor[1]) === y || (!n.anchor && x === 0 && y === 0) ? " on" : ""}" data-anchor="${x},${y}" title="AnchorPoint ${x}, ${y}"></button>`).join("");
    const actions = (n.actions || []).map((a, i) => `<div class="rsg-action" data-ai="${i}"><select data-ak="on">${ACTION_ONS.map((o) => `<option ${a.on === o ? "selected" : ""}>${o}</option>`).join("")}</select><select data-ak="do">${ACTION_DOS.map((o) => `<option ${a.do === o ? "selected" : ""}>${o}</option>`).join("")}</select><input data-ak="target" placeholder="target (Name / parent.X / gui.Path)" value="${esc(a.target || "")}"><input data-ak="extra" placeholder="effect / remote / message / seconds" value="${esc(a.effect || a.remote || a.message || a.seconds || "")}"><button type="button" data-adel="${i}" title="Remove">${I.close}</button></div>`).join("");
    D.props.innerHTML = `
      <div class="rsg-sec"><h4>${esc(n.class)} <small>${esc(pathOf(n))}</small></h4>
        ${field("Name", inp("name", n.name))}
        ${field("Class", sel("class", n.class, CLASSES))}
        ${field("Visible", chk("visible", n.visible !== false))}
        ${field("ZIndex", num("z", n.z != null ? n.z : 1, 'step="1"'))}
        ${field("LayoutOrder", num("layout_order", n.layout_order != null ? n.layout_order : 0, 'step="1"'))}
      </div>
      <div class="rsg-sec"><h4>Transform <small>${Math.round(box.w)}×${Math.round(box.h)} px</small></h4>
        ${field("Position", udimField("position", n.position), "Scale X · Offset X · Scale Y · Offset Y")}
        ${field("Size", udimField("size", n.size), "Scale X · Offset X · Scale Y · Offset Y")}
        <div class="rsg-row"><button type="button" class="rsg-btn sm" data-act="toScale">→ Scale</button><button type="button" class="rsg-btn sm" data-act="toOffset">→ Offset</button><button type="button" class="rsg-btn sm" data-act="fillParent">Fill parent</button><button type="button" class="rsg-btn sm" data-act="centerInParent">Centre</button></div>
        ${field("AnchorPoint", `<span class="rsg-anchor">${anchorGrid}</span>`, "Keeps the element where it is on screen")}
        ${field("Rotation", num("rotation", n.rotation || 0))}
        ${field("Aspect ratio", num("aspect", n.aspect || "", 'placeholder="off"'), "UIAspectRatioConstraint (width / height)")}
        ${field("Clips descendants", chk("clips", !!n.clips))}
        ${field("Automatic size", sel("automatic_size", n.automatic_size || "", ["X", "Y", "XY"], true))}
      </div>
      <div class="rsg-sec"><h4>Appearance</h4>
        ${field("Background", colorField("bg", n.bg))}
        ${field("Bg transparency", num("bg_t", n.bg_t != null ? n.bg_t : (n.class === "TextLabel" ? 1 : 0), 'min="0" max="1" step="0.05"'))}
        ${field("Corner radius", inp("corner", n.corner != null ? (typeof n.corner === "object" ? JSON.stringify(n.corner) : n.corner) : ""), "px, or token 'radius'")}
        ${field("Stroke", `<span class="rsg-inline">${colorField("stroke.color", st ? st.color || "stroke" : "")}${num("stroke.thickness", st ? st.thickness != null ? st.thickness : 1 : "", 'placeholder="px" min="0"')}${num("stroke.transparency", st ? st.transparency != null ? st.transparency : 0 : "", 'placeholder="0-1" min="0" max="1" step="0.05"')}</span>`, "UIStroke: colour · thickness · transparency (clear colour to remove)")}
        ${field("Gradient", `<span class="rsg-inline">${colorField("gradient.from", gr ? gr.from : "")}${colorField("gradient.to", gr ? gr.to : "")}${num("gradient.rotation", gr ? gr.rotation != null ? gr.rotation : 90 : "", 'placeholder="deg"')}</span>`, "UIGradient from → to, rotation (clear 'from' to remove)")}
        ${field("Padding", inp("padding", n.padding != null ? (typeof n.padding === "object" ? JSON.stringify(n.padding) : n.padding) : ""), "UIPadding px, or {\"left\":8,\"top\":4}")}
        ${field("UIScale", num("scale", n.scale || "", 'placeholder="1"'))}
      </div>
      ${isText ? `<div class="rsg-sec"><h4>Text</h4>
        ${field("Text", `<textarea data-k="text" rows="2">${esc(n.text || "")}</textarea>`)}
        ${n.class === "TextBox" ? field("Placeholder", inp("placeholder", n.placeholder || "")) : ""}
        ${field("Colour", colorField("text_color", n.text_color || "text"))}
        ${field("Font", `<span class="rsg-inline">${sel("font", tokenFont(n.font), FONTS)}${sel("font@tok", n.font === "font" || n.font === "title_font" ? n.font : "", ["font", "title_font"], true)}</span>`, "Pick a font or bind to the theme token")}
        ${field("Size", `<span class="rsg-inline">${num("text_size", n.text_size != null ? n.text_size : "", 'placeholder="scaled" min="1"')}<label class="rsg-mini">${chk("text_scaled", !!n.text_scaled || n.text_size == null)} scaled</label></span>`)}
        ${field("Text fit", `<span class="rsg-inline">${num("text_fit.min", n.text_fit ? n.text_fit.min : "", 'placeholder="min"')}${num("text_fit.max", n.text_fit ? n.text_fit.max : "", 'placeholder="max"')}</span>`, "UITextSizeConstraint")}
        ${field("Align", `<span class="rsg-inline">${sel("align_x", n.align_x || "Center", ["Left", "Center", "Right"])}${sel("align_y", n.align_y || "Center", ["Top", "Center", "Bottom"])}</span>`)}
        ${field("Wrap / Rich", `<span class="rsg-inline"><label class="rsg-mini">${chk("wrap", !!n.wrap)} wrap</label><label class="rsg-mini">${chk("rich", !!n.rich)} rich</label></span>`)}
        ${field("Text stroke", `<span class="rsg-inline">${colorField("text_stroke.color", n.text_stroke ? (typeof n.text_stroke === "object" ? n.text_stroke.color : "#000000") : "")}${num("text_stroke.transparency", n.text_stroke && typeof n.text_stroke === "object" ? n.text_stroke.transparency : "", 'placeholder="0-1" step="0.05"')}</span>`)}
      </div>` : ""}
      ${isImg ? `<div class="rsg-sec"><h4>Image</h4>
        ${field("Asset", inp("image", n.image || "", "text", 'placeholder="rbxassetid://… or id"'))}
        ${field("Tint", colorField("image_color", n.image_color || ""))}
        ${field("Transparency", num("image_t", n.image_t || 0, 'min="0" max="1" step="0.05"'))}
        ${field("ScaleType", sel("scale_type", n.scale_type || "Stretch", SCALE_TYPES))}
        ${field("9-slice", inp("slice", n.slice ? n.slice.join(",") : "", "text", 'placeholder="l,t,r,b"'))}
      </div>` : ""}
      ${n.class === "ScrollingFrame" ? `<div class="rsg-sec"><h4>Scrolling</h4>${field("Auto canvas", sel("scroll.auto", n.scroll && n.scroll.auto || "Y", ["X", "Y", "XY"]))}${field("Bar thickness", num("scroll.thickness", n.scroll && n.scroll.thickness != null ? n.scroll.thickness : 6))}</div>` : ""}
      <div class="rsg-sec"><h4>Layout <small>children</small></h4>
        ${field("Kind", sel("layout.kind", ly ? ly.kind || "list" : "", ["list", "grid"], true))}
        ${ly ? field("Direction", sel("layout.direction", ly.direction || (String(ly.kind) === "grid" ? "Horizontal" : "Vertical"), ["Vertical", "Horizontal"])) : ""}
        ${ly ? field("Gap", num("layout.gap", ly.gap != null ? ly.gap : 8)) : ""}
        ${ly && String(ly.kind) === "grid" ? field("Cell", udimField("layout.cell", Array.isArray(ly.cell) && ly.cell.length === 4 ? ly.cell : [0, 80, 0, 80])) : ""}
        ${ly ? field("Align", `<span class="rsg-inline">${sel("layout.h_align", ly.h_align || "Left", ["Left", "Center", "Right"])}${sel("layout.v_align", ly.v_align || "Top", ["Top", "Center", "Bottom"])}</span>`) : ""}
      </div>
      <div class="rsg-sec"><h4>Behaviours <small>${(n.actions || []).length}</small></h4>
        <div class="rsg-actions">${actions}</div>
        <div class="rsg-row"><button type="button" class="rsg-btn sm" data-act="addAction">${I.plus} Add behaviour</button></div>
        <p class="rsg-hint">click → toggle / open / close a target (its Name, <code>parent</code>, or <code>gui.Path</code>), hover → hover_grow, enable → tween_in / auto_hide / pulse, remote → fires ReplicatedStorage.OR_UIEvents.&lt;name&gt;.</p>
      </div>
      <div class="rsg-sec"><h4>Actions</h4>
        <div class="rsg-row"><button type="button" class="rsg-btn sm" data-act="dup">${I.dup} Duplicate</button><button type="button" class="rsg-btn sm" data-act="raise">${I.up} Raise</button><button type="button" class="rsg-btn sm" data-act="lower">${I.down} Lower</button><button type="button" class="rsg-btn sm" data-act="indent">${I.in} Into previous</button><button type="button" class="rsg-btn sm" data-act="outdent">${I.out} Out of parent</button><button type="button" class="rsg-btn sm danger" data-act="delete">${I.trash} Delete</button></div>
        ${field("Attributes", `<textarea data-k="attrs" rows="2" placeholder='{"OR_Role":"accent"}'>${esc(n.attrs ? JSON.stringify(n.attrs) : "")}</textarea>`, "Instance attributes (JSON)")}
        ${field("Raw props", `<textarea data-k="props" rows="2" placeholder='{"ClearTextOnFocus":false}'>${esc(n.props ? JSON.stringify(n.props) : "")}</textarea>`, "Any other Roblox property (JSON)")}
      </div>`;
  }
  function setPath(obj, key, value) {
    const parts = key.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { const p = parts[i]; if (cur[p] == null || typeof cur[p] !== "object") cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}; cur = cur[p]; }
    const last = parts[parts.length - 1];
    if (value === undefined) { if (Array.isArray(cur)) cur[Number(last)] = 0; else delete cur[last]; } else cur[last] = value;
  }
  function applyProp(n, key, raw, el) {
    const kind = el.dataset.kind;
    if (key.endsWith("@tok")) { const base = key.slice(0, -4); if (raw) setPath(n, base, raw); else if (base === "font") setPath(n, base, tokenFont(n.font)); return; }
    if (key === "screen.name") { S.screen.name = raw || "OR_UI"; return; }
    if (key.startsWith("screen.")) { const k = key.slice(7); S.screen[k] = el.type === "checkbox" ? el.checked : (el.type === "number" ? Number(raw) : raw); return; }
    if (kind === "color" || kind === "raw") {
      let v = raw;
      if (kind === "raw") { if (v === "") v = undefined; else if (/^\[/.test(v)) { try { v = JSON.parse(v); } catch {} } }
      if (key === "stroke.color" && v === undefined) { delete n.stroke; return; }
      if (key === "gradient.from" && v === undefined) { delete n.gradient; return; }
      if (key === "text_stroke.color" && v === undefined) { delete n.text_stroke; return; }
      setPath(n, key, v); return;
    }
    if (el.type === "checkbox") {
      if (key === "visible") { if (el.checked) delete n.visible; else n.visible = false; return; }
      if (key === "text_scaled") { if (el.checked) { n.text_scaled = true; delete n.text_size; } else { delete n.text_scaled; n.text_size = n.text_size || 16; } return; }
      setPath(n, key, el.checked || undefined); return;
    }
    if (/^(position|size|layout\.cell)\.\d$/.test(key)) { setPath(n, key, Number(raw) || 0); return; }
    if (key === "corner" || key === "padding") { if (raw === "") delete n[key]; else if (/^[{[]/.test(raw)) { try { n[key] = JSON.parse(raw); } catch {} } else if (Number.isFinite(Number(raw))) n[key] = Number(raw); else n[key] = raw; return; }
    if (key === "attrs" || key === "props") { if (!raw.trim()) delete n[key]; else { try { n[key] = JSON.parse(raw); el.classList.remove("bad"); } catch { el.classList.add("bad"); } } return; }
    if (key === "slice") { const a = raw.split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x)); if (a.length === 4) { n.slice = a; n.scale_type = "Slice"; } else delete n.slice; return; }
    if (key === "layout.kind") { if (!raw) delete n.layout; else { n.layout = Object.assign({ kind: raw }, typeof n.layout === "object" ? n.layout : {}); n.layout.kind = raw; if (raw === "grid" && !n.layout.cell) n.layout.cell = [0, 80, 0, 80]; } return; }
    if (key === "class") { n.class = raw; if (/^(TextLabel|TextButton|TextBox)$/.test(raw) && n.text == null) n.text = n.name; return; }
    if (el.type === "number" || key === "text_size" || key === "aspect" || key === "scale" || key === "z" || key === "bg_t") { if (raw === "") { setPath(n, key, undefined); if (key === "text_size") n.text_scaled = true; } else { setPath(n, key, Number(raw)); if (key === "text_size") delete n.text_scaled; } return; }
    if (key === "name") { n.name = raw.trim() || n.class; return; }
    setPath(n, key, raw === "" ? undefined : raw);
  }

  // ───────────────────────── theme panel ─────────────────────────
  function renderTheme() {
    if (!D || S.sideTab !== "theme") return;
    const P = presets();
    D.theme.innerHTML = `<div class="rsg-sec"><h4>Preset</h4><div class="rsg-presets">${Object.keys(P).map((k) => `<button type="button" class="rsg-preset${S.preset === k ? " on" : ""}" data-preset="${k}" style="--a:${P[k].primary};--b:${P[k].accent};--s:${P[k].surface}"><i></i>${esc(k.replace(/_/g, " "))}</button>`).join("")}</div></div>
      <div class="rsg-sec"><h4>Tokens</h4>${TOKEN_KEYS.map((k) => field(k, `<span class="rsg-color"><input data-tok="${k}" type="color" value="${esc(tokenColor(S.tokens[k], "#000000"))}"><input data-tok="${k}" data-kind="raw" type="text" value="${esc(S.tokens[k] || "")}"></span>`)).join("")}
        ${field("stroke_t", `<input data-tok="stroke_t" type="number" min="0" max="1" step="0.05" value="${esc(S.tokens.stroke_t != null ? S.tokens.stroke_t : 0.2)}">`)}
        ${field("radius", `<input data-tok="radius" type="number" min="0" step="1" value="${esc(S.tokens.radius != null ? S.tokens.radius : 10)}">`)}
        ${field("font", `<select data-tok="font">${FONTS.map((f) => `<option ${S.tokens.font === f ? "selected" : ""}>${f}</option>`).join("")}</select>`)}
        ${field("title_font", `<select data-tok="title_font">${FONTS.map((f) => `<option ${S.tokens.title_font === f ? "selected" : ""}>${f}</option>`).join("")}</select>`)}
        <p class="rsg-hint">Elements that reference a token (e.g. <code>primary</code>, <code>title_font</code>, <code>radius</code>) restyle live. Build sends the tokens along so <code>ui_tokens_apply</code> can re-skin later.</p>
      </div>`;
  }
  function syncTheme() { if (D && D.presetSel) D.presetSel.value = S.preset; }

  // ───────────────────────── templates ─────────────────────────
  function comp(kind, args) { const sk = skills(); if (!sk || !sk.guiComponentNode) return makeNode("Frame", { name: kind }); const n = sk.guiComponentNode(kind, Object.assign({ preset: S.preset }, args || {})); return n || makeNode("Frame", { name: kind }); }
  const TEMPLATES = [
    { id: "hud", label: "Game HUD", screen: "HUD", build: () => [comp("currency_hud", { name: "Coins", label: "1,250", stat: "Coins" }), Object.assign(comp("currency_hud", { name: "Gems", label: "48", stat: "Gems", image: "rbxassetid://6031075931" }), { position: [1, -16, 0, 64] }), comp("health_bar", { name: "Health" }), comp("hotbar", { name: "Hotbar", slots: 6 }), Object.assign(comp("avatar", { name: "Avatar" }), { position: [0, 16, 0, 16] }), { class: "TextLabel", name: "PlayerName", text: "Player", size: [0, 160, 0, 24], position: [0, 72, 0, 20], bg_t: 1, text_color: "text", font: "title_font", text_size: 16, align_x: "Left", text_stroke: { color: "#000000", transparency: 0.5 } }, Object.assign(comp("button", { name: "ShopButton", label: "Shop", action: "toggle", target: "gui.Shop" }), { size: [0, 120, 0, 40], position: [0, 16, 0, 108] })] },
    { id: "menu", label: "Main menu", screen: "MainMenu", build: () => [{ class: "Frame", name: "Backdrop", size: [1, 0, 1, 0], bg: "bg", gradient: { from: "bg", to: "surface2", rotation: 90 }, children: [
      { class: "TextLabel", name: "Title", text: "MY GAME", size: [0, 520, 0, 90], position: [0.5, 0, 0.28, 0], anchor: [0.5, 0.5], bg_t: 1, text_color: "text", font: "title_font", text_size: 64, text_stroke: { color: "#000000", transparency: 0.4 } },
      { class: "TextLabel", name: "Subtitle", text: "Season 1 · Update 1.0", size: [0, 400, 0, 28], position: [0.5, 0, 0.28, 56], anchor: [0.5, 0.5], bg_t: 1, text_color: "muted", font: "font", text_size: 18 },
      { class: "Frame", name: "Buttons", size: [0, 260, 0, 220], position: [0.5, 0, 0.62, 0], anchor: [0.5, 0.5], bg_t: 1, layout: { kind: "list", gap: 12, h_align: "Center" }, children: [
        Object.assign(comp("button", { name: "Play", label: "PLAY", action: "destroy", target: "gui.Backdrop" }), { size: [1, 0, 0, 52] }),
        Object.assign(comp("button", { name: "Shop", label: "Shop", action: "toggle", target: "gui.ShopWindow" }), { size: [1, 0, 0, 44], bg: "surface2", text_color: "text" }),
        Object.assign(comp("button", { name: "Settings", label: "Settings", action: "toggle", target: "gui.SettingsWindow" }), { size: [1, 0, 0, 44], bg: "surface2", text_color: "text" }),
      ] },
      { class: "TextLabel", name: "Version", text: "v1.0.0", size: [0, 100, 0, 20], position: [1, -12, 1, -10], anchor: [1, 1], bg_t: 1, text_color: "muted", font: "font", text_size: 12, align_x: "Right" },
    ] }, Object.assign(comp("window", { name: "ShopWindow", label: "Shop" }), { visible: false }), Object.assign(comp("window", { name: "SettingsWindow", label: "Settings" }), { visible: false })] },
    { id: "shop", label: "Shop", screen: "Shop", build: () => { const w = comp("window", { name: "ShopWindow", label: "Shop" }); w.size = [0, 640, 0, 420]; const body = w.children.find((c) => c.name === "Body"); body.layout = undefined; body.children = [Object.assign(comp("tabs", { name: "Categories", tabs: ["Weapons", "Pets", "Gamepasses"] }), { size: [1, 0, 1, 0], bg_t: 1 })]; const page = body.children[0].children[1].children[0]; page.layout = { kind: "grid", cell: [0, 150, 0, 200], gap: 10 }; page.children = ["Sword", "Bow", "Staff", "Dagger"].map((nm, i) => comp("card", { name: nm, label: nm, subtitle: ["Common", "Rare", "Epic", "Legendary"][i], price: 100 * (i + 1), remote: "BuyItem" })); return [w, Object.assign(comp("button", { name: "OpenShop", label: "Shop", action: "toggle", target: "gui.ShopWindow" }), { position: [0, 20, 1, -20], anchor: [0, 1] })]; } },
    { id: "inventory", label: "Inventory", screen: "Inventory", build: () => { const w = comp("window", { name: "InventoryWindow", label: "Inventory" }); w.size = [0, 560, 0, 400]; const body = w.children.find((c) => c.name === "Body"); body.layout = undefined; body.children = [Object.assign(comp("grid", { name: "Slots", slots: 24 }), { size: [0.62, 0, 1, 0] }), { class: "Frame", name: "Detail", size: [0.36, 0, 1, 0], position: [1, 0, 0, 0], anchor: [1, 0], bg: "surface2", corner: 10, padding: 12, layout: { kind: "list", gap: 8 }, children: [{ class: "ImageLabel", name: "Preview", size: [1, 0, 0, 120], bg: "surface", corner: 8 }, { class: "TextLabel", name: "ItemName", text: "Select an item", size: [1, 0, 0, 24], bg_t: 1, text_color: "text", font: "title_font", text_size: 16 }, { class: "TextLabel", name: "Desc", text: "Details appear here.", size: [1, 0, 0, 60], bg_t: 1, text_color: "muted", font: "font", text_size: 13, wrap: true, align_y: "Top" }, Object.assign(comp("button", { name: "Equip", label: "Equip", action: "remote", remote: "EquipItem" }), { size: [1, 0, 0, 40] })] }]; return [w]; } },
    { id: "settings", label: "Settings", screen: "Settings", build: () => { const w = comp("window", { name: "SettingsWindow", label: "Settings" }); w.size = [0, 440, 0, 380]; const body = w.children.find((c) => c.name === "Body"); body.children = [comp("checkbox", { name: "Music", label: "Music", on: true }), comp("checkbox", { name: "Sfx", label: "Sound effects", on: true }), { class: "TextLabel", name: "VolumeLabel", text: "Volume", size: [1, 0, 0, 20], bg_t: 1, text_color: "muted", font: "font", text_size: 13, align_x: "Left" }, Object.assign(comp("slider", { name: "Volume", value: 0.7 }), { size: [1, 0, 0, 24] }), { class: "TextLabel", name: "QualityLabel", text: "Graphics", size: [1, 0, 0, 20], bg_t: 1, text_color: "muted", font: "font", text_size: 13, align_x: "Left" }, comp("dropdown", { name: "Graphics", options: ["Low", "Medium", "High", "Ultra"] }), comp("toggle", { name: "Shadows", on: true })]; return [w]; } },
    { id: "leaderboard", label: "Leaderboard", screen: "Leaderboard", build: () => [{ class: "Frame", name: "Board", size: [0, 300, 0, 360], position: [1, -16, 0, 16], anchor: [1, 0], bg: "surface", bg_t: 0.1, corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 10, children: [
      { class: "TextLabel", name: "Title", text: "TOP PLAYERS", size: [1, 0, 0, 28], bg_t: 1, text_color: "text", font: "title_font", text_size: 18 },
      Object.assign(comp("list", { name: "Rows", items: ["1. Builderman — 12,400", "2. Noob123 — 9,870", "3. xX_Pro_Xx — 8,120", "4. Guest — 5,000", "5. You — 4,210"] }), { size: [1, 0, 1, -36], position: [0, 0, 0, 36], bg_t: 1 }),
    ] }] },
    { id: "quests", label: "Quest log", screen: "Quests", build: () => [{ class: "Frame", name: "QuestPanel", size: [0, 320, 0, 260], position: [0, 16, 0.5, 0], anchor: [0, 0.5], bg: "surface", bg_t: 0.08, corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 12, layout: { kind: "list", gap: 10 }, children: [
      { class: "TextLabel", name: "Title", text: "QUESTS", size: [1, 0, 0, 24], bg_t: 1, text_color: "text", font: "title_font", text_size: 18, align_x: "Left" },
      ...["Collect 10 coins", "Defeat the slime king", "Reach level 5"].map((t, i) => ({ class: "Frame", name: "Quest" + (i + 1), size: [1, 0, 0, 58], bg: "surface2", corner: 8, padding: 8, children: [{ class: "TextLabel", name: "Text", text: t, size: [1, 0, 0, 20], bg_t: 1, text_color: "text", font: "font", text_size: 14, align_x: "Left" }, Object.assign(comp("progress_bar", { name: "Progress", value: [0.6, 0.1, 0.9][i], label: ["6 / 10", "0 / 1", "lv 4"][i] }), { size: [1, 0, 0, 14], position: [0, 0, 1, 0], anchor: [0, 1] })] })),
    ] }] },
    { id: "dialogue", label: "Dialogue box", screen: "Dialogue", build: () => [{ class: "Frame", name: "Dialogue", size: [0.6, 0, 0, 150], position: [0.5, 0, 1, -24], anchor: [0.5, 1], bg: "surface", bg_t: 0.05, corner: 14, stroke: { color: "primary", thickness: 2, transparency: 0.4 }, padding: 16, actions: [{ on: "enable", do: "tween_in", effect: "slide_up" }], children: [
      Object.assign(comp("avatar", { name: "Portrait" }), { size: [0, 72, 0, 72], actions: [] }),
      { class: "TextLabel", name: "Speaker", text: "Merchant", size: [1, -90, 0, 24], position: [0, 90, 0, 0], bg_t: 1, text_color: "primary", font: "title_font", text_size: 18, align_x: "Left" },
      { class: "TextLabel", name: "Line", text: "Welcome, traveller! Looking for something sharp?", size: [1, -90, 0, 60], position: [0, 90, 0, 28], bg_t: 1, text_color: "text", font: "font", text_size: 16, align_x: "Left", align_y: "Top", wrap: true },
      Object.assign(comp("button", { name: "Next", label: "Next ▸", action: "close", target: "parent" }), { size: [0, 110, 0, 34], position: [1, 0, 1, 0], anchor: [1, 1] }),
    ] }] },
    { id: "loading", label: "Loading screen", screen: "Loading", build: () => [{ class: "Frame", name: "Loading", size: [1, 0, 1, 0], bg: "bg", z: 100, children: [
      { class: "TextLabel", name: "Logo", text: "MY GAME", size: [0, 500, 0, 80], position: [0.5, 0, 0.42, 0], anchor: [0.5, 0.5], bg_t: 1, text_color: "text", font: "title_font", text_size: 56 },
      Object.assign(comp("progress_bar", { name: "Progress", value: 0.35, label: "Loading… 35%" }), { size: [0, 420, 0, 16], position: [0.5, 0, 0.58, 0], anchor: [0.5, 0.5] }),
      { class: "TextLabel", name: "Tip", text: "Tip: press E to interact", size: [0, 400, 0, 20], position: [0.5, 0, 0.58, 30], anchor: [0.5, 0.5], bg_t: 1, text_color: "muted", font: "font", text_size: 13 },
    ] }] },
    { id: "rewards", label: "Daily rewards", screen: "DailyRewards", build: () => { const w = comp("window", { name: "RewardsWindow", label: "Daily rewards" }); w.size = [0, 600, 0, 300]; const body = w.children.find((c) => c.name === "Body"); body.layout = { kind: "grid", cell: [0, 76, 0, 100], gap: 8, h_align: "Center" }; body.children = Array.from({ length: 7 }, (_, i) => ({ class: "Frame", name: "Day" + (i + 1), bg: i === 0 ? "primary" : "surface2", corner: 10, stroke: { color: i === 0 ? "accent" : "stroke", thickness: i === 0 ? 2 : 1 }, children: [{ class: "TextLabel", name: "Day", text: "Day " + (i + 1), size: [1, 0, 0, 20], position: [0, 0, 0, 6], bg_t: 1, text_color: i === 0 ? "#ffffff" : "muted", font: "title_font", text_size: 12 }, { class: "ImageLabel", name: "Icon", size: [0, 36, 0, 36], position: [0.5, 0, 0.5, 2], anchor: [0.5, 0.5], bg_t: 1, image: "rbxassetid://6034973115", image_color: "accent" }, { class: "TextLabel", name: "Amount", text: String(50 * (i + 1)), size: [1, 0, 0, 18], position: [0, 0, 1, -6], anchor: [0, 1], bg_t: 1, text_color: "text", font: "title_font", text_size: 13 }] })); body.children.push(Object.assign(comp("button", { name: "Claim", label: "CLAIM", action: "remote", remote: "ClaimDaily" }), { size: [0, 160, 0, 40] })); return [w]; } },
  ];
  function applyTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id); if (!t) return;
    pushHistory();
    const nodes = t.build();
    S.screen.name = t.screen;
    S.nodes = nodes.map((n) => adopt(n, null));
    S.sel = []; reindex(); renderAll();
    toast(`Template "${t.label}" loaded`);
    diag("template", { id, nodes: byId.size });
  }
  function insertComponent(kind) {
    pushHistory();
    const node = adopt(comp(kind, {}), null);
    const parent = S.sel.length === 1 && /^(Frame|ScrollingFrame|CanvasGroup)$/.test(S.sel[0].class) ? S.sel[0] : (S.sel.length === 1 ? parentOf(S.sel[0]) : null);
    const list = parent ? parent.children : S.nodes;
    node.name = uniqueName(list, node.name);
    if (!node.position || (node.position.every((v) => v === 0))) { const pc = parent ? contentOf(geo.get(parent.id) || screenBox(), parent) : screenBox(); const sz = udim(node.size, pc.w, pc.h); node.position = [0, Math.round((pc.w - sz.x) / 2), 0, Math.round((pc.h - sz.y) / 2)]; if (parent && parent.layout) node.position = [0, 0, 0, 0]; }
    list.push(node); node._parent = parent ? parent.id : null;
    reindex(); S.sel = [node]; renderAll();
    diag("component", { kind });
  }
  function insertElement(cls) {
    pushHistory();
    const node = makeNode(cls, {});
    const parent = S.sel.length === 1 && /^(Frame|ScrollingFrame|CanvasGroup)$/.test(S.sel[0].class) ? S.sel[0] : (S.sel.length === 1 ? parentOf(S.sel[0]) : null);
    const list = parent ? parent.children : S.nodes;
    const base = cls === "TextLabel" ? "Label" : cls === "TextButton" ? "Button" : cls === "ImageLabel" ? "Image" : cls === "ImageButton" ? "IconButton" : cls === "TextBox" ? "Input" : cls === "ScrollingFrame" ? "List" : cls === "CanvasGroup" ? "Group" : "Panel";
    node.name = uniqueName(list, base);
    const sz = DEFAULT_SIZE[cls] || [200, 50];
    const pc = parent ? contentOf(geo.get(parent.id) || screenBox(), parent) : screenBox();
    node.size = [0, sz[0], 0, sz[1]];
    node.position = parent && parent.layout ? [0, 0, 0, 0] : [0, Math.round((pc.w - sz[0]) / 2), 0, Math.round((pc.h - sz[1]) / 2)];
    list.push(node); node._parent = parent ? parent.id : null;
    reindex(); S.sel = [node]; setTool("select"); renderAll();
    toast(`${FRIENDLY[cls] || cls} added — drag it to move, drag a corner to resize`);
    diag("create", { cls, nested: !!parent, click: true });
  }
  function uniqueName(list, base) { let name = base, i = 2; while (list.some((n) => n.name === name)) name = base + i++; return name; }

  // ───────────────────────── editing ops ─────────────────────────
  function deleteSel() { if (!S.sel.length) return; pushHistory(); for (const n of S.sel) { const list = siblingsOf(n); const i = list.indexOf(n); if (i >= 0) list.splice(i, 1); } S.sel = []; reindex(); renderAll(); }
  function duplicateSel() { if (!S.sel.length) return; pushHistory(); const made = []; for (const n of S.sel) { const list = siblingsOf(n); const copy = adopt(JSON.parse(JSON.stringify(strip(n))), parentOf(n)); copy.name = uniqueName(list, n.name); copy.position = n.position.slice(); copy.position[1] += 16; copy.position[3] += 16; list.splice(list.indexOf(n) + 1, 0, copy); made.push(copy); } reindex(); S.sel = made; renderAll(); }
  function reorder(n, dir) { const list = siblingsOf(n); const i = list.indexOf(n); const j = i + dir; if (j < 0 || j >= list.length) return; pushHistory(); list.splice(i, 1); list.splice(j, 0, n); reindex(); renderAll(); }
  function indent(n) { const list = siblingsOf(n); const i = list.indexOf(n); const prev = list[i - 1]; if (!prev) { toast("No previous sibling to move into"); return; } pushHistory(); const box = geo.get(n.id); list.splice(i, 1); prev.children.push(n); n._parent = prev.id; reindex(); computeGeometry(); if (box) setBox(n, box); reindex(); renderAll(); }
  function outdent(n) { const p = parentOf(n); if (!p) return; pushHistory(); const box = geo.get(n.id); const list = p.children; list.splice(list.indexOf(n), 1); const gp = siblingsOf(p); gp.splice(gp.indexOf(p) + 1, 0, n); n._parent = p._parent; reindex(); computeGeometry(); if (box) setBox(n, box); reindex(); renderAll(); }
  function reparent(n, newParent) {
    if (newParent === n || (newParent && isDescendant(newParent, n))) return;
    const box = geo.get(n.id); const list = siblingsOf(n); list.splice(list.indexOf(n), 1);
    const target = newParent ? newParent.children : S.nodes; target.push(n); n._parent = newParent ? newParent.id : null;
    reindex(); computeGeometry(); if (box) setBox(n, box);
  }
  function alignSel(mode) {
    if (S.sel.length < 2) return; pushHistory();
    const boxes = S.sel.map((n) => geo.get(n.id));
    const x0 = Math.min(...boxes.map((b) => b.x)), x1 = Math.max(...boxes.map((b) => b.x + b.w)), y0 = Math.min(...boxes.map((b) => b.y)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    S.sel.forEach((n, i) => { const b = Object.assign({}, boxes[i]); if (mode === "left") b.x = x0; if (mode === "right") b.x = x1 - b.w; if (mode === "center_x") b.x = (x0 + x1) / 2 - b.w / 2; if (mode === "top") b.y = y0; if (mode === "bottom") b.y = y1 - b.h; if (mode === "center_y") b.y = (y0 + y1) / 2 - b.h / 2; setBox(n, b); });
    renderAll();
  }
  function distributeSel(axis) {
    if (S.sel.length < 3) { toast("Select three or more to distribute"); return; } pushHistory();
    const items = S.sel.map((n) => ({ n, b: Object.assign({}, geo.get(n.id)) })).sort((a, b) => (axis === "x" ? a.b.x - b.b.x : a.b.y - b.b.y));
    const first = items[0].b, last = items[items.length - 1].b;
    const total = items.reduce((s, it) => s + (axis === "x" ? it.b.w : it.b.h), 0);
    const span = axis === "x" ? last.x + last.w - first.x : last.y + last.h - first.y;
    const gap = (span - total) / (items.length - 1);
    let cur = axis === "x" ? first.x : first.y;
    for (const it of items) { if (axis === "x") { it.b.x = cur; cur += it.b.w + gap; } else { it.b.y = cur; cur += it.b.h + gap; } setBox(it.n, it.b); }
    renderAll();
  }
  function groupSel() {
    if (S.sel.length < 2) return; pushHistory();
    const boxes = S.sel.map((n) => geo.get(n.id));
    const x0 = Math.min(...boxes.map((b) => b.x)), x1 = Math.max(...boxes.map((b) => b.x + b.w)), y0 = Math.min(...boxes.map((b) => b.y)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const parent = parentOf(S.sel[0]); const list = parent ? parent.children : S.nodes;
    const g = makeNode("Frame", { name: uniqueName(list, "Group"), bg_t: 1, corner: undefined });
    delete g.corner; delete g.bg;
    g._parent = parent ? parent.id : null; list.push(g); reindex(); computeGeometry(); setBox(g, { x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 });
    reindex(); computeGeometry();
    for (const n of S.sel.slice()) reparent(n, g);
    reindex(); S.sel = [g]; renderAll();
  }

  // ───────────────────────── pointer interaction ─────────────────────────
  function stagePoint(ev) { const r = D.screen.getBoundingClientRect(); return { x: (ev.clientX - r.left) / S.zoom, y: (ev.clientY - r.top) / S.zoom }; }
  function nodeAt(el) { while (el && el !== D.screen) { if (el.dataset && el.dataset.id) return byId.get(el.dataset.id); el = el.parentElement; } return null; }
  // Figma-style picking: a plain click selects at the level you are "in" (top-level
  // first, then siblings of the current selection); double-click drills one level
  // down; Alt / Ctrl-click grabs the deepest element under the pointer directly.
  function pickForClick(hit, deep) {
    if (!hit || deep) return hit;
    const chain = []; let c = hit; while (c) { chain.unshift(c); c = parentOf(c); }
    const ctx = new Set();
    for (const sN of S.sel) { let p = parentOf(sN); while (p) { ctx.add(p.id); p = parentOf(p); } }
    for (const n of chain) { const p = parentOf(n); if (!p || ctx.has(p.id) || S.sel.includes(n)) return n; }
    return chain[0];
  }
  function snapV(v, lines) { if (!S.snap) return v; for (const l of lines) if (Math.abs(v - l) <= 6) return l; if (S.grid) return Math.round(v / GRID) * GRID; return v; }
  function snapLine(v, lines) { if (!S.snap) return v; for (const l of lines) if (Math.abs(v - l) <= 6) return l; return v; }
  function guideLines(exclude) {
    const xs = new Set(), ys = new Set(); const sb = screenBox();
    xs.add(sb.x); xs.add(sb.x + sb.w / 2); xs.add(sb.x + sb.w); ys.add(sb.y); ys.add(sb.y + sb.h / 2); ys.add(sb.y + sb.h);
    for (const [id, b] of geo) { if (exclude.has(id)) continue; xs.add(b.x); xs.add(b.x + b.w / 2); xs.add(b.x + b.w); ys.add(b.y); ys.add(b.y + b.h / 2); ys.add(b.y + b.h); }
    return { xs: [...xs], ys: [...ys] };
  }
  function showGuides(gx, gy) { if (!D.guides) return; D.guides.innerHTML = (gx != null ? `<i class="v" style="left:${gx}px"></i>` : "") + (gy != null ? `<i class="h" style="top:${gy}px"></i>` : ""); }
  function containerAt(pt, exclude) {
    // deepest container (Frame/Scroll/Canvas) under the point that is not excluded
    let best = null, bestDepth = -1;
    const walk = (list, depth) => { for (const n of list) { if (exclude.has(n.id)) continue; const b = geo.get(n.id); if (!b) continue; if (pt.x >= b.x && pt.y >= b.y && pt.x <= b.x + b.w && pt.y <= b.y + b.h) { if (/^(Frame|ScrollingFrame|CanvasGroup)$/.test(n.class) && depth > bestDepth) { best = n; bestDepth = depth; } walk(n.children, depth + 1); } } };
    walk(S.nodes, 0); return best;
  }
  function onDown(ev) {
    if (ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest(".rsg-start")) return;
    const pt = stagePoint(ev); const target = ev.target;
    try { if (D.screen.setPointerCapture && ev.pointerId != null) D.screen.setPointerCapture(ev.pointerId); } catch {}
    const tool = ELEMENT_TOOLS.find((t) => t.id === S.tool);
    if (target.classList && target.classList.contains("rsg-h") && S.sel.length === 1) { // resize
      const n = S.sel[0]; const b = Object.assign({}, geo.get(n.id));
      drag = { kind: "resize", h: target.dataset.h, n, start: pt, box: b, pushed: false }; ev.preventDefault(); return;
    }
    if (tool && tool.cls) { // create
      const parent = containerAt(pt, new Set());
      drag = { kind: "create", cls: tool.cls, start: pt, parent, pushed: false }; ev.preventDefault(); return;
    }
    const hit = pickForClick(nodeAt(target), ev.altKey || ev.ctrlKey || ev.metaKey);
    if (hit) {
      if (ev.shiftKey) { S.sel = S.sel.includes(hit) ? S.sel.filter((n) => n !== hit) : S.sel.concat(hit); renderAll(); return; }
      if (!S.sel.includes(hit)) { S.sel = [hit]; renderAll(); }
      if (S.sel.some(inLayout)) { drag = { kind: "none" }; return; }
      drag = { kind: "move", start: pt, items: S.sel.map((n) => ({ n, box: Object.assign({}, geo.get(n.id)) })), pushed: false }; ev.preventDefault(); return;
    }
    S.sel = []; renderAll();
    drag = { kind: "marquee", start: pt }; D.marquee.hidden = false;
  }
  function onMove(ev) {
    if (!drag || drag.kind === "none") { if (!drag && D.screen.contains(ev.target)) { const n = nodeAt(ev.target); D.status.textContent = n ? `${pathOf(n)} · ${n.class} · ${Math.round((geo.get(n.id) || {}).w || 0)}×${Math.round((geo.get(n.id) || {}).h || 0)}` : ""; } return; }
    const pt = stagePoint(ev); const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (drag.kind === "move") {
      if (!drag.pushed && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) { pushHistory(); drag.pushed = true; }
      if (!drag.pushed) return;
      const ex = new Set(); for (const it of drag.items) { ex.add(it.n.id); const walk = (l) => { for (const c of l) { ex.add(c.id); walk(c.children || []); } }; walk(it.n.children || []); } const gl = guideLines(ex);
      let gx = null, gy = null;
      drag.items.forEach((it, i) => {
        let nx = it.box.x + dx, ny = it.box.y + dy;
        if (i === 0) { const cands = [[nx, 0], [nx + it.box.w / 2, it.box.w / 2], [nx + it.box.w, it.box.w]]; for (const [v, off] of cands) { const s = snapLine(v, gl.xs); if (s !== v) { nx = s - off; gx = s; break; } } const candsY = [[ny, 0], [ny + it.box.h / 2, it.box.h / 2], [ny + it.box.h, it.box.h]]; for (const [v, off] of candsY) { const s = snapLine(v, gl.ys); if (s !== v) { ny = s - off; gy = s; break; } } if (gx == null && S.grid && S.snap) nx = Math.round(nx / GRID) * GRID; if (gy == null && S.grid && S.snap) ny = Math.round(ny / GRID) * GRID; drag.snapDx = nx - (it.box.x + dx); drag.snapDy = ny - (it.box.y + dy); } else { nx += drag.snapDx || 0; ny += drag.snapDy || 0; }
        setBox(it.n, { x: nx, y: ny, w: it.box.w, h: it.box.h });
      });
      renderStage(); showGuides(gx, gy);
      const host = containerAt(pt, new Set(drag.items.map((it) => it.n.id))); drag.host = host; D.status.textContent = host && host !== parentOf(drag.items[0].n) ? `Drop into ${pathOf(host)} (hold Alt to keep parent)` : `${Math.round(drag.items[0].box.x + dx)}, ${Math.round(drag.items[0].box.y + dy)}`;
      return;
    }
    if (drag.kind === "resize") {
      if (!drag.pushed) { pushHistory(); drag.pushed = true; }
      const b = Object.assign({}, drag.box); const h = drag.h; const gl = guideLines(new Set([drag.n.id]));
      if (h.includes("e")) b.w = Math.max(4, snapV(b.x + b.w + dx, gl.xs) - b.x);
      if (h.includes("s")) b.h = Math.max(4, snapV(b.y + b.h + dy, gl.ys) - b.y);
      if (h.includes("w")) { const nx = Math.min(snapV(b.x + dx, gl.xs), b.x + b.w - 4); b.w = b.x + b.w - nx; b.x = nx; }
      if (h.includes("n")) { const ny = Math.min(snapV(b.y + dy, gl.ys), b.y + b.h - 4); b.h = b.y + b.h - ny; b.y = ny; }
      if (ev.shiftKey && drag.box.h > 0) { const r = drag.box.w / drag.box.h; if (h === "e" || h === "w") b.h = b.w / r; else b.w = b.h * r; }
      setBox(drag.n, b); renderStage(); D.status.textContent = `${Math.round(b.w)} × ${Math.round(b.h)}`; return;
    }
    if (drag.kind === "create" || drag.kind === "marquee") {
      const x = Math.min(pt.x, drag.start.x), y = Math.min(pt.y, drag.start.y), w = Math.abs(dx), hgt = Math.abs(dy);
      D.marquee.hidden = false; Object.assign(D.marquee.style, { left: x + "px", top: y + "px", width: w + "px", height: hgt + "px" });
      D.status.textContent = `${Math.round(w)} × ${Math.round(hgt)}`;
    }
  }
  function onUp(ev) {
    if (!drag) return;
    const pt = stagePoint(ev); const d = drag; drag = null; showGuides(null, null);
    if (d.kind === "move" && d.pushed) {
      if (!ev.altKey) { const host = d.host === undefined ? containerAt(pt, new Set(d.items.map((it) => it.n.id))) : d.host; for (const it of d.items) { if (host !== parentOf(it.n) && !(host && isDescendant(host, it.n))) reparent(it.n, host); } }
      reindex(); renderAll(); return;
    }
    if (d.kind === "resize") { renderAll(); return; }
    if (d.kind === "create" || d.kind === "marquee") {
      D.marquee.hidden = true;
      const x = Math.min(pt.x, d.start.x), y = Math.min(pt.y, d.start.y), w = Math.abs(pt.x - d.start.x), h = Math.abs(pt.y - d.start.y);
      if (d.kind === "marquee") { S.sel = [...byId.values()].filter((n) => { const b = geo.get(n.id); return b && b.x >= x && b.y >= y && b.x + b.w <= x + w && b.y + b.h <= y + h; }); S.sel = S.sel.filter((n) => !S.sel.some((o) => o !== n && isDescendant(n, o))); renderAll(); return; }
      pushHistory();
      const parent = d.parent; const list = parent ? parent.children : S.nodes;
      const node = makeNode(d.cls, { name: uniqueName(list, d.cls === "TextLabel" ? "Label" : d.cls === "TextButton" ? "Button" : d.cls === "ImageLabel" ? "Image" : d.cls === "ImageButton" ? "IconButton" : d.cls === "TextBox" ? "Input" : d.cls === "ScrollingFrame" ? "List" : d.cls === "CanvasGroup" ? "Group" : "Frame") });
      node._parent = parent ? parent.id : null; list.push(node); reindex(); computeGeometry();
      const small = w < 6 && h < 6; const defW = d.cls === "TextButton" ? 160 : 200, defH = d.cls === "TextButton" || d.cls === "TextBox" ? 44 : d.cls === "TextLabel" ? 32 : 120;
      const box = small ? { x: snapV(x, []), y: snapV(y, []), w: defW, h: defH } : { x: snapV(x, []), y: snapV(y, []), w: Math.max(8, snapV(x + w, []) - snapV(x, [])), h: Math.max(8, snapV(y + h, []) - snapV(y, [])) };
      if (parent && parent.layout) { node.size = [0, box.w, 0, box.h]; node.position = [0, 0, 0, 0]; } else setBox(node, box);
      S.sel = [node]; if (!ev.shiftKey) setTool("select"); renderAll();
      diag("create", { cls: d.cls, nested: !!parent });
    }
  }
  function onKey(e) {
    if (!S.open) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase(); const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") { if (typing) { e.target.blur(); return; } e.preventDefault(); close(); return; }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSel(); return; }
    if (mod && e.key.toLowerCase() === "c") { if (S.sel.length) { S.clipboard = S.sel.map((n) => strip(n)); toast(`${S.sel.length} copied`); } return; }
    if (mod && e.key.toLowerCase() === "v") { if (S.clipboard) { pushHistory(); const parent = S.sel.length === 1 && /^(Frame|ScrollingFrame|CanvasGroup)$/.test(S.sel[0].class) ? S.sel[0] : null; const list = parent ? parent.children : S.nodes; const made = S.clipboard.map((c) => { const n = adopt(JSON.parse(JSON.stringify(c)), parent); n.name = uniqueName(list, n.name); n.position = n.position.slice(); n.position[1] += 24; n.position[3] += 24; list.push(n); return n; }); reindex(); S.sel = made; renderAll(); } return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); S.sel = S.nodes.slice(); renderAll(); return; }
    if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); groupSel(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); downloadJson(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSel(); return; }
    if (/^Arrow/.test(e.key) && S.sel.length) { e.preventDefault(); const step = e.shiftKey ? 10 : 1; const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0; pushHistory(); for (const n of S.sel) { if (inLayout(n)) continue; const b = Object.assign({}, geo.get(n.id)); b.x += dx; b.y += dy; setBox(n, b); } renderAll(); return; }
    if (e.key === "+" || e.key === "=") { zoomBy(1.2); return; } if (e.key === "-") { zoomBy(1 / 1.2); return; } if (e.key === "0") { fitZoom(); return; }
    const t = ELEMENT_TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase()); if (t && !mod) { if (S.simple && t.cls) insertElement(t.cls); else setTool(t.id); }
  }

  // ───────────────────────── luau export ─────────────────────────
  function luaStr(s) { return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"'; }
  function luaColor(v) { const h = tokenColor(v, "#ffffff"); return `Color3.fromRGB(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`; }
  function luaU2(a) { return `UDim2.new(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`; }
  function toLuau(spec) {
    spec = spec || getSpec();
    const out = []; let k = 0; const bindings = [];
    const saveTokens = S.tokens; if (spec.tokens) S.tokens = Object.assign({}, presets()[spec.preset] || FALLBACK_PRESETS.midnight, spec.tokens);
    const emit = (n, parentVar, path) => {
      const v = "o" + (++k); const isText = /^(TextLabel|TextButton|TextBox)$/.test(n.class), isImg = /^(ImageLabel|ImageButton)$/.test(n.class);
      out.push(`local ${v} = Instance.new(${luaStr(n.class)})`, `${v}.Name = ${luaStr(n.name)}`, `${v}.Size = ${luaU2(n.size)}`, `${v}.Position = ${luaU2(n.position)}`, `${v}.BorderSizePixel = 0`);
      if (n.anchor) out.push(`${v}.AnchorPoint = Vector2.new(${n.anchor[0]}, ${n.anchor[1]})`);
      if (n.z != null) out.push(`${v}.ZIndex = ${n.z}`); if (n.visible === false) out.push(`${v}.Visible = false`); if (n.layout_order) out.push(`${v}.LayoutOrder = ${n.layout_order}`);
      if (n.bg != null) out.push(`${v}.BackgroundColor3 = ${luaColor(n.bg)}`);
      const bt = n.bg_t != null ? tokenNum(n.bg_t, 0) : (n.bg == null && (n.class === "TextLabel" || n.class === "ImageLabel") ? 1 : null); if (bt != null) out.push(`${v}.BackgroundTransparency = ${bt}`);
      if (n.rotation) out.push(`${v}.Rotation = ${n.rotation}`); if (n.clips) out.push(`${v}.ClipsDescendants = true`); if (n.automatic_size) out.push(`${v}.AutomaticSize = Enum.AutomaticSize.${n.automatic_size}`);
      if (isText) { out.push(`${v}.Text = ${luaStr(n.text != null ? n.text : "")}`, `${v}.Font = Enum.Font.${tokenFont(n.font)}`, `${v}.TextColor3 = ${luaColor(n.text_color || "text")}`); if (n.text_size != null && !n.text_scaled) out.push(`${v}.TextSize = ${tokenNum(n.text_size, 14)}`, `${v}.TextScaled = false`); else out.push(`${v}.TextScaled = true`); if (n.align_x) out.push(`${v}.TextXAlignment = Enum.TextXAlignment.${n.align_x}`); if (n.align_y) out.push(`${v}.TextYAlignment = Enum.TextYAlignment.${n.align_y}`); if (n.wrap) out.push(`${v}.TextWrapped = true`); if (n.rich) out.push(`${v}.RichText = true`); if (n.text_t) out.push(`${v}.TextTransparency = ${n.text_t}`); if (n.text_stroke) out.push(`${v}.TextStrokeTransparency = ${typeof n.text_stroke === "object" && n.text_stroke.transparency != null ? n.text_stroke.transparency : 0.5}`, `${v}.TextStrokeColor3 = ${luaColor(typeof n.text_stroke === "object" ? n.text_stroke.color : "#000000")}`); if (n.class === "TextBox") { if (n.placeholder) out.push(`${v}.PlaceholderText = ${luaStr(n.placeholder)}`); if (n.placeholder_color) out.push(`${v}.PlaceholderColor3 = ${luaColor(n.placeholder_color)}`); out.push(`${v}.ClearTextOnFocus = false`); } }
      if (isImg) { if (n.image) out.push(`${v}.Image = ${luaStr(/^\d+$/.test(String(n.image)) ? "rbxassetid://" + n.image : n.image)}`); if (n.image_color) out.push(`${v}.ImageColor3 = ${luaColor(n.image_color)}`); if (n.image_t) out.push(`${v}.ImageTransparency = ${n.image_t}`); if (n.scale_type) out.push(`${v}.ScaleType = Enum.ScaleType.${n.scale_type}`); if (n.slice) out.push(`${v}.SliceCenter = Rect.new(${n.slice.join(", ")})`); }
      if (n.class === "ScrollingFrame") { const sc = n.scroll || {}; out.push(`${v}.ScrollBarThickness = ${tokenNum(sc.thickness, 6)}`, `${v}.AutomaticCanvasSize = Enum.AutomaticSize.${sc.auto || "Y"}`, `${v}.CanvasSize = UDim2.new(0, 0, 0, 0)`); }
      if (n.attrs) for (const [ak, av] of Object.entries(n.attrs)) out.push(`${v}:SetAttribute(${luaStr(ak)}, ${typeof av === "string" ? luaStr(av) : av})`);
      if (n.props) for (const [pk, pv] of Object.entries(n.props)) out.push(`pcall(function() ${v}.${pk} = ${typeof pv === "string" ? (pv.startsWith("Enum.") ? pv : luaStr(pv)) : Array.isArray(pv) ? (pv.length === 4 ? luaU2(pv) : pv.length === 3 ? luaColor(pv) : `Vector2.new(${pv[0]}, ${pv[1]})`) : pv} end)`);
      out.push(`${v}.Parent = ${parentVar}`);
      if (n.corner != null) out.push(`do local c = Instance.new("UICorner") c.CornerRadius = UDim.new(${typeof n.corner === "object" ? `${tokenNum(n.corner.scale, 0)}, ${tokenNum(n.corner.offset, 8)}` : `0, ${tokenNum(n.corner, 8)}`}) c.Parent = ${v} end`);
      if (n.stroke != null) { const s = typeof n.stroke === "object" ? n.stroke : { color: n.stroke }; out.push(`do local s = Instance.new("UIStroke") s.Color = ${luaColor(s.color || "stroke")} s.Thickness = ${tokenNum(s.thickness, 1)} s.Transparency = ${tokenNum(s.transparency, 0)} s.Parent = ${v} end`); }
      if (n.gradient) { const g = n.gradient; out.push(`do local g = Instance.new("UIGradient") g.Color = ColorSequence.new(${luaColor(g.from || "primary")}, ${luaColor(g.to || "accent")}) g.Rotation = ${tokenNum(g.rotation, 90)}${Array.isArray(g.transparency) ? ` g.Transparency = NumberSequence.new(${g.transparency[0]}, ${g.transparency[1]})` : ""} g.Parent = ${v} end`); }
      if (n.padding != null) { const p = padOf(n); out.push(`do local p = Instance.new("UIPadding") p.PaddingLeft = UDim.new(0, ${p.l}) p.PaddingRight = UDim.new(0, ${p.r}) p.PaddingTop = UDim.new(0, ${p.t}) p.PaddingBottom = UDim.new(0, ${p.b}) p.Parent = ${v} end`); }
      if (n.layout) { const ly = typeof n.layout === "object" ? n.layout : { kind: n.layout }; const grid = String(ly.kind) === "grid"; out.push(grid ? `do local l = Instance.new("UIGridLayout") l.CellSize = ${luaU2(Array.isArray(ly.cell) && ly.cell.length === 4 ? ly.cell : [0, 80, 0, 80])} l.CellPadding = UDim2.new(0, ${tokenNum(ly.gap, 6)}, 0, ${tokenNum(ly.gap, 6)}) l.FillDirection = Enum.FillDirection.${ly.direction || "Horizontal"} l.HorizontalAlignment = Enum.HorizontalAlignment.${ly.h_align || "Left"} l.VerticalAlignment = Enum.VerticalAlignment.${ly.v_align || "Top"} l.SortOrder = Enum.SortOrder.LayoutOrder l.Parent = ${v} end` : `do local l = Instance.new("UIListLayout") l.Padding = UDim.new(0, ${tokenNum(ly.gap, 8)}) l.FillDirection = Enum.FillDirection.${ly.direction || "Vertical"} l.HorizontalAlignment = Enum.HorizontalAlignment.${ly.h_align || "Left"} l.VerticalAlignment = Enum.VerticalAlignment.${ly.v_align || "Top"} l.SortOrder = Enum.SortOrder.LayoutOrder l.Parent = ${v} end`); }
      if (n.aspect) out.push(`do local a = Instance.new("UIAspectRatioConstraint") a.AspectRatio = ${tokenNum(n.aspect, 1)} a.Parent = ${v} end`);
      if (n.text_fit) out.push(`do local t = Instance.new("UITextSizeConstraint") t.MinTextSize = ${tokenNum(n.text_fit.min, 10)} t.MaxTextSize = ${tokenNum(n.text_fit.max, 28)} t.Parent = ${v} end`);
      if (n.scale) out.push(`do local u = Instance.new("UIScale") u.Scale = ${tokenNum(n.scale, 1)} u.Parent = ${v} end`);
      const myPath = path ? path + "." + n.name : n.name;
      if (Array.isArray(n.actions)) for (const a of n.actions) bindings.push(Object.assign({}, a, { path: myPath }));
      (n.children || []).forEach((c, i) => { if (n.layout && c.layout_order == null) c = Object.assign({}, c, { layout_order: i + 1 }); emit(c, v, myPath); });
    };
    const scr = Object.assign({ name: "OR_UI" }, typeof spec.screen === "object" ? spec.screen : { name: spec.screen || "OR_UI" });
    out.push(`-- Generated by ORscript GUI Studio (${new Date().toISOString().slice(0, 10)}). Paste into the Studio command bar or a Script.`, `local StarterGui = game:GetService("StarterGui")`, `local HttpService = game:GetService("HttpService")`, `local old = StarterGui:FindFirstChild(${luaStr(scr.name)}) if old then old:Destroy() end`, `local gui = Instance.new("ScreenGui")`, `gui.Name = ${luaStr(scr.name)}`, `gui.IgnoreGuiInset = ${scr.ignore_inset !== false}`, `gui.ResetOnSpawn = ${scr.reset_on_spawn === true}`, `gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling`, `gui.DisplayOrder = ${Number(scr.display_order || 0)}`);
    for (const tk of TOKEN_KEYS) if (S.tokens[tk]) out.push(`gui:SetAttribute(${luaStr("OR_" + tk[0].toUpperCase() + tk.slice(1))}, ${luaColor(S.tokens[tk])})`);
    for (const r of spec.children || []) emit(r, "gui", "");
    if (bindings.length) {
      const src = (skills() && skills().GUI_BEHAVIOUR_SRC) || "-- behaviours need the ORscript GUI Studio pack (src/core/skills/studio_guistudio.js)";
      out.push(`do local b = Instance.new("StringValue") b.Name = "OR_UIBindings" b.Value = ${luaStr(JSON.stringify(bindings))} b.Parent = gui end`, `do local ls = Instance.new("LocalScript") ls.Name = "OR_UIBehaviours" ls.Source = [==[\n${src}\n]==] ls.Parent = gui end`);
    }
    out.push(`gui.Parent = StarterGui`, `print("GUI Studio: built " .. gui.Name)`);
    S.tokens = saveTokens;
    return out.join("\n");
  }

  // ───────────────────────── hand-off ─────────────────────────
  function buildMessage(intent) {
    const spec = getSpec(); const count = byId.size;
    const lines = [
      "GUI STUDIO HAND-OFF (ORscript): the user designed a Roblox GUI visually. The JSON spec below is EXACT - do not redesign it, build it.",
      `Screen: ${spec.screen.name} · ${count} object(s) · tokens preset ${spec.preset} · behaviours ${countActions(S.nodes)}.`,
      "Steps: (1) run ui_build_spec with EXACTLY this spec and replace:true; (2) run quality_audit {path:\"StarterGui." + spec.screen.name + "\"} and fix anything < 85; (3) then " + (intent && intent.trim() ? "do this: " + intent.trim() : "report the paths and what each behaviour does") + ".",
      "Use the spec verbatim as the `spec` param (one command, no splitting):",
      "```json",
      JSON.stringify({ command: "ui_build_spec", params: { spec, replace: true } }),
      "```",
    ];
    return lines.join("\n");
  }
  function countActions(list) { let n = 0; const walk = (l) => { for (const x of l) { n += (x.actions || []).length; walk(x.children || []); } }; walk(list); return n; }
  async function sendToAI() {
    if (!S.hooks || !S.hooks.send) { toast("Sending is not wired on this page"); return; }
    if (!S.nodes.length) { toast("Design something first"); return; }
    setStatus("Sending the design to the AI…"); D.sendBtn.disabled = true;
    try { const ok = await S.hooks.send(buildMessage(S.intent), setStatus); setStatus(ok ? "Sent — the AI is building it in Studio" : "Could not send (see the chat)"); if (ok) { diag("sent", { nodes: byId.size }); setTimeout(() => close(), 600); } }
    catch (e) { setStatus("Send failed: " + (e && e.message || e)); }
    finally { D.sendBtn.disabled = false; }
  }
  function parseFeedback(fb) { const s = String(fb || ""); const i = s.indexOf("{"); if (i < 0) return null; try { return JSON.parse(s.slice(i)); } catch { const j = s.lastIndexOf("}"); try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; } } }
  async function buildInStudio() {
    if (!S.hooks || !S.hooks.runTool) { toast("Direct build is not available here — use Send to AI"); return; }
    if (!S.nodes.length) { toast("Design something first"); return; }
    setStatus("Building in Roblox Studio…"); D.buildBtn.disabled = true;
    try {
      const fb = await S.hooks.runTool("ui_build_spec", { spec: getSpec(), replace: true });
      const r = parseFeedback(fb);
      if (r && r.ok) { setStatus(`Built ${r.data && r.data.count} object(s) in ${r.data && r.data.screen}${r.data && r.data.behaviours ? " · " + r.data.behaviours + " behaviours" : ""}`); toast("Built in Studio"); diag("built", { count: r.data && r.data.count }); }
      else { const err = (r && r.error) || String(fb || "").replace(/^Output of '[^']+':\s*/, "").slice(0, 240); setStatus("Studio said: " + err); toast("Build failed — " + err.slice(0, 80)); diag("buildFail", { err: err.slice(0, 120) }); }
    } catch (e) { setStatus("Build failed: " + (e && e.message || e)); }
    finally { D.buildBtn.disabled = false; }
  }
  async function importFromStudio() {
    if (!S.hooks || !S.hooks.runTool) { toast("Import needs the Studio bridge"); return; }
    setStatus("Reading ScreenGuis from Studio…");
    try {
      const fb = await S.hooks.runTool("ui_export_spec", {}); const r = parseFeedback(fb);
      if (!r || !r.ok) { setStatus("Studio said: " + ((r && r.error) || String(fb).slice(0, 160))); return; }
      const screens = (r.data && r.data.screens) || [];
      if (!screens.length) { setStatus("No ScreenGui in StarterGui yet"); return; }
      S.studioScreens = screens; D.importSel.innerHTML = screens.map((s) => `<option value="${esc(s.path)}">${esc(s.name)} (${s.children})</option>`).join(""); D.importBox.hidden = false; setStatus(`${screens.length} ScreenGui(s) — pick one`);
    } catch (e) { setStatus("Import failed: " + (e && e.message || e)); }
  }
  async function importPath(path) {
    D.importBox.hidden = true; setStatus(`Importing ${path}…`);
    try {
      const fb = await S.hooks.runTool("ui_export_spec", { path }); const r = parseFeedback(fb);
      if (!r || !r.ok) { setStatus("Studio said: " + ((r && r.error) || String(fb).slice(0, 160))); return; }
      loadSpec(r.data.spec); setStatus(`Imported ${r.data.nodes} object(s) from ${path}`); diag("imported", { nodes: r.data.nodes });
    } catch (e) { setStatus("Import failed: " + (e && e.message || e)); }
  }
  function downloadJson() { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(getSpec(), null, 2)], { type: "application/json" })); a.download = `${S.screen.name || "gui"}.orgui.json`; document.body.appendChild(a); a.click(); a.remove(); toast("JSON saved"); }
  function openJson() { const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json"; inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { if (loadSpec(String(rd.result))) toast("Design loaded"); }; rd.readAsText(f); }; inp.click(); }
  async function copyText(t, label) { try { await navigator.clipboard.writeText(t); toast(label + " copied"); } catch { toast("Clipboard blocked — use the Code tab"); } }
  function setStatus(m) { if (D) D.sendStatus.textContent = m || ""; }

  // ───────────────────────── view helpers ─────────────────────────
  function setMode(m) {
    S.simple = m !== "advanced";
    try { localStorage.setItem("rsg-mode", S.simple ? "simple" : "advanced"); } catch {}
    if (!D) return;
    D.host.classList.toggle("rsg-simple", S.simple);
    D.host.querySelectorAll(".rsg-mode button").forEach((b) => b.classList.toggle("on", (b.dataset.mode === "advanced") !== S.simple));
    if (S.simple && S.sideTab === "code") setSideTab("props");
    setTool("select"); renderAll();
    diag("mode", { simple: S.simple });
  }
  function setTool(id) { S.tool = id; D.host.querySelectorAll(".rsg-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === id)); D.stage.dataset.tool = id; const t = ELEMENT_TOOLS.find((x) => x.id === id); D.hint.textContent = S.simple ? (S.nodes.length ? "Click an element to edit it · drag to move · corners resize" : "Click something on the left to add it, or pick a template") : (t ? t.hint : ""); }
  function setDevice(id) { S.device = DEVICES.find((d) => d.id === id) || DEVICES[2]; fitZoom(); }
  function fitZoom() { const r = D.stage.getBoundingClientRect(); const z = Math.min((r.width - 48) / S.device.w, (r.height - 48) / S.device.h); S.zoom = clamp(z || 1, 0.15, 3); renderStage(); D.zoomLbl.textContent = Math.round(S.zoom * 100) + "%"; }
  function zoomBy(f) { S.zoom = clamp(S.zoom * f, 0.15, 4); renderStage(); D.zoomLbl.textContent = Math.round(S.zoom * 100) + "%"; }
  function syncButtons() { if (!D) return; const u = D.host.querySelector('[data-act="undo"]'), r = D.host.querySelector('[data-act="redo"]'); if (u) u.disabled = !S.history.length; if (r) r.disabled = !S.redo.length; D.countLbl.textContent = `${byId.size} object${byId.size === 1 ? "" : "s"}`; }
  function setSideTab(t) { S.sideTab = t; D.host.querySelectorAll(".rsg-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); D.props.hidden = t !== "props"; D.tree.hidden = t !== "tree"; D.theme.hidden = t !== "theme"; D.code.hidden = t !== "code"; renderProps(); renderTheme(); renderCode(); }

  // ───────────────────────── build DOM ─────────────────────────
  function build() {
    const host = document.createElement("div"); host.id = "rs-gui"; host.setAttribute("role", "dialog"); host.setAttribute("aria-label", "ORscript GUI Studio");
    const tools = ELEMENT_TOOLS.map((t) => `<button type="button" class="rsg-tool" data-tool="${t.id}" title="${esc(t.label)} (${t.key}) — ${esc(t.hint)}">${I[t.id]}<span>${esc(t.label)}</span></button>`).join("");
    const comps = componentKinds().map((k) => `<button type="button" class="rsg-comp" data-comp="${k}" title="Insert ${k.replace(/_/g, " ")}">${esc(k.replace(/_/g, " "))}</button>`).join("");
    const kinds = componentKinds();
    const simpleAdd = SIMPLE_ELEMENTS.map((t) => `<button type="button" class="rsg-add" data-add="${t.cls}" title="Add a ${esc(t.label)}">${I[t.icon]}<span><b>${esc(t.label)}</b><small>${esc(t.sub)}</small></span></button>`).join("");
    const simpleComps = SIMPLE_COMPONENTS.filter(([k]) => !kinds.length || kinds.includes(k)).map(([k, l]) => `<button type="button" class="rsg-comp rsg-comp-lg" data-comp="${k}" title="Add a ${esc(l)}">${esc(l)}</button>`).join("");
    const logo = (window.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("assets/icon128.png") : "";
    host.innerHTML = `
      <div class="rsg-shell">
        <div class="rsg-toast" role="status" aria-live="polite"></div>
        <div class="rsg-title">
          <span class="rsg-brand"><img class="rsg-logo" alt="" src="${esc(logo)}">ORscript GUI Studio</span>
          <span class="rsg-mode" title="Simple: click to add, few options. Advanced: every property, drag-to-draw tools, code."><button type="button" data-mode="simple" class="${S.simple ? "on" : ""}">Simple</button><button type="button" data-mode="advanced" class="${S.simple ? "" : "on"}">Advanced</button></span>
          <span class="rsg-sub rsg-adv">Design it → build it in Studio</span>
          <div class="rsg-title-actions">
            <button type="button" class="rsg-ib" data-act="undo" title="Undo (Ctrl+Z)">${I.undo}</button>
            <button type="button" class="rsg-ib" data-act="redo" title="Redo (Ctrl+Y)">${I.redo}</button>
            <span class="rsg-sep"></span>
            <select class="rsg-device" title="Device">${DEVICES.map((d) => `<option value="${d.id}" ${d.id === S.device.id ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select>
            <button type="button" class="rsg-ib" data-act="zoomOut" title="Zoom out (-)">${I.zoomOut}</button>
            <button type="button" class="rsg-ib" data-act="fit" title="Fit (0)">${I.fit}</button>
            <button type="button" class="rsg-ib" data-act="zoomIn" title="Zoom in (+)">${I.zoomIn}</button>
            <span class="rsg-zoom">100%</span>
            <span class="rsg-sep"></span>
            <button type="button" class="rsg-ib tgl on rsg-adv" data-act="grid" title="Grid (8 px)">${I.grid}</button>
            <button type="button" class="rsg-ib tgl on rsg-adv" data-act="snap" title="Snap to grid + guides">${I.magnet}</button>
            <span class="rsg-sep rsg-adv"></span>
            <button type="button" class="rsg-ib rsg-adv" data-act="import" title="Import a ScreenGui from the open Studio place">${I.import}</button>
            <button type="button" class="rsg-ib rsg-adv" data-act="open" title="Open a saved design (.orgui.json)">${I.open}</button>
            <button type="button" class="rsg-ib rsg-adv" data-act="save" title="Save design as JSON (Ctrl+S)">${I.save}</button>
            <button type="button" class="rsg-ib rsg-adv" data-act="copyLua" title="Copy a ready-to-paste Luau builder script">${I.code}</button>
            <button type="button" class="rsg-ib" data-act="clear" title="Clear the design">${I.clear}</button>
            <span class="rsg-sep"></span>
            <button type="button" class="rsg-ib rsg-close" data-act="close" title="Close (Esc)">${I.close}</button>
          </div>
        </div>
        <div class="rsg-body">
          <div class="rsg-tools">
            <div class="rsg-tools-simple">
              <div class="rsg-tools-h">Add</div>${simpleAdd}
              <div class="rsg-tools-h">Ready-made</div><div class="rsg-comps">${simpleComps || '<div class="rsg-empty">Component pack not loaded</div>'}</div>
            </div>
            <div class="rsg-tools-full">
              <div class="rsg-tools-h">Elements</div>${tools}
              <div class="rsg-tools-h">Components</div><div class="rsg-comps">${comps || '<div class="rsg-empty">Component pack not loaded</div>'}</div>
            </div>
          </div>
          <div class="rsg-main">
            <div class="rsg-ribbon">
              <label class="rsg-rf rsg-adv"><span>Screen</span><input class="rsg-screen-name" value="${esc(S.screen.name)}" title="ScreenGui name"></label>
              <label class="rsg-rf"><span>Theme</span><select class="rsg-preset-sel">${Object.keys(presets()).map((k) => `<option value="${k}" ${k === S.preset ? "selected" : ""}>${esc(k.replace(/_/g, " "))}</option>`).join("")}</select></label>
              <label class="rsg-rf"><span>Template</span><select class="rsg-template-sel"><option value="">Pick a screen…</option>${TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}</select></label>
              <span class="rsg-hint-tool"></span>
              <span class="rsg-count"></span>
            </div>
            <div class="rsg-stage" data-tool="select"><div class="rsg-stage-wrap"><div class="rsg-screen"></div></div></div>
            <div class="rsg-foot">
              <span class="rsg-status"></span>
              <div class="rsg-import" hidden><select class="rsg-import-sel"></select><button type="button" class="rsg-btn sm" data-act="importGo">Import</button><button type="button" class="rsg-btn sm" data-act="importCancel">Cancel</button></div>
              <input class="rsg-intent" placeholder="Optional for the AI: what should happen next? e.g. wire the Buy buttons to a shop system with DataStore">
              <button type="button" class="rsg-btn primary rsg-build" data-act="build" title="Run ui_build_spec in the connected Studio right now (no AI turn)">${I.build} Build in Studio</button>
              <button type="button" class="rsg-btn accent rsg-send" data-act="send" title="Send the exact spec to the AI with your instructions">${I.send} Send to AI</button>
              <span class="rsg-send-status"></span>
            </div>
          </div>
          <div class="rsg-side">
            <div class="rsg-tabs"><button type="button" class="rsg-tab on" data-tab="props">Props</button><button type="button" class="rsg-tab" data-tab="tree">Tree</button><button type="button" class="rsg-tab" data-tab="theme">Theme</button><button type="button" class="rsg-tab rsg-adv" data-tab="code">Code</button></div>
            <div class="rsg-props"></div>
            <div class="rsg-tree" hidden></div>
            <div class="rsg-theme" hidden></div>
            <div class="rsg-code" hidden>
              <div class="rsg-row"><b>JSON spec</b><button type="button" class="rsg-btn sm" data-act="copyJson">${I.copy} Copy</button><button type="button" class="rsg-btn sm" data-act="applyJson">Apply edits</button></div>
              <textarea class="rsg-code-json" spellcheck="false"></textarea>
              <div class="rsg-row"><b>Luau</b><button type="button" class="rsg-btn sm" data-act="copyLua">${I.copy} Copy</button></div>
              <textarea class="rsg-code-lua" readonly spellcheck="false"></textarea>
            </div>
          </div>
        </div>
      </div>`;
    host.classList.toggle("rsg-simple", S.simple);
    document.documentElement.appendChild(host);
    D = {
      host, toast: host.querySelector(".rsg-toast"), side: host.querySelector(".rsg-side"), stage: host.querySelector(".rsg-stage"), stageWrap: host.querySelector(".rsg-stage-wrap"), screen: host.querySelector(".rsg-screen"), props: host.querySelector(".rsg-props"), tree: host.querySelector(".rsg-tree"), theme: host.querySelector(".rsg-theme"), code: host.querySelector(".rsg-code"),
      codeJson: host.querySelector(".rsg-code-json"), codeLua: host.querySelector(".rsg-code-lua"), hint: host.querySelector(".rsg-hint-tool"), status: host.querySelector(".rsg-status"), sendStatus: host.querySelector(".rsg-send-status"), zoomLbl: host.querySelector(".rsg-zoom"), countLbl: host.querySelector(".rsg-count"),
      presetSel: host.querySelector(".rsg-preset-sel"), templateSel: host.querySelector(".rsg-template-sel"), deviceSel: host.querySelector(".rsg-device"), screenName: host.querySelector(".rsg-screen-name"), intent: host.querySelector(".rsg-intent"), buildBtn: host.querySelector(".rsg-build"), sendBtn: host.querySelector(".rsg-send"), importBox: host.querySelector(".rsg-import"), importSel: host.querySelector(".rsg-import-sel"),
    };
    // events
    host.addEventListener("click", (e) => {
      const md = e.target.closest("[data-mode]"); if (md) { setMode(md.dataset.mode); return; }
      const ad = e.target.closest("[data-add]"); if (ad) { insertElement(ad.dataset.add); return; }
      const tp = e.target.closest("[data-tpl]"); if (tp) { if (!S.nodes.length || confirm("Replace the current design with this template?")) applyTemplate(tp.dataset.tpl); return; }
      const tb = e.target.closest("[data-tool]"); if (tb) { setTool(tb.dataset.tool); return; }
      const cb = e.target.closest("[data-comp]"); if (cb) { insertComponent(cb.dataset.comp); return; }
      const tab = e.target.closest(".rsg-tab"); if (tab) { setSideTab(tab.dataset.tab); return; }
      const pre = e.target.closest("[data-preset]"); if (pre) { pushHistory(); S.preset = pre.dataset.preset; S.tokens = Object.assign({}, presets()[S.preset]); renderAll(); renderTheme(); return; }
      const ap = e.target.closest("[data-anchor]"); if (ap && S.sel.length === 1) { pushHistory(); const n = S.sel[0]; const box = Object.assign({}, geo.get(n.id)); const [x, y] = ap.dataset.anchor.split(",").map(Number); n.anchor = x === 0 && y === 0 ? undefined : [x, y]; if (!n.anchor) delete n.anchor; computeGeometry(); setBox(n, box); renderAll(); return; }
      const eye = e.target.closest("[data-eye]"); if (eye) { const n = byId.get(eye.dataset.eye); if (n) { pushHistory(); if (n.visible === false) delete n.visible; else n.visible = false; renderAll(); } return; }
      const tr = e.target.closest(".rsg-tr"); if (tr) { const n = byId.get(tr.dataset.id); if (n) { S.sel = e.shiftKey ? (S.sel.includes(n) ? S.sel.filter((x) => x !== n) : S.sel.concat(n)) : [n]; renderAll(); } return; }
      const adel = e.target.closest("[data-adel]"); if (adel && S.sel.length === 1) { pushHistory(); S.sel[0].actions.splice(Number(adel.dataset.adel), 1); renderAll(); return; }
      const ab = e.target.closest("[data-act]"); if (ab) act(ab.dataset.act);
    });
    host.addEventListener("change", (e) => {
      const el = e.target;
      if (el.classList.contains("rsg-device")) { setDevice(el.value); return; }
      if (el.classList.contains("rsg-preset-sel")) { pushHistory(); S.preset = el.value; S.tokens = Object.assign({}, presets()[el.value]); renderAll(); renderTheme(); return; }
      if (el.classList.contains("rsg-template-sel")) { if (el.value) { if (!S.nodes.length || confirm("Replace the current design with this template?")) applyTemplate(el.value); el.value = ""; } return; }
      if (el.classList.contains("rsg-screen-name")) { S.screen.name = el.value.trim() || "OR_UI"; renderCode(); return; }
      if (el.classList.contains("rsg-intent")) { S.intent = el.value; return; }
      if (el.classList.contains("rsg-import-sel")) return;
      if (el.dataset.tok) { pushHistory(); const k = el.dataset.tok; S.tokens[k] = el.type === "number" ? Number(el.value) : el.value; if (el.type === "color" || el.dataset.kind === "raw") { const peer = D.theme.querySelector(`[data-tok="${k}"]${el.type === "color" ? '[data-kind="raw"]' : ':not([data-kind])'}`); if (peer) peer.value = el.value; } renderAll(); return; }
      if (el.dataset.sk != null && S.sel.length === 1) { pushHistory(); applySimple(S.sel[0], el.dataset.sk, el); renderAll(); return; }
      if (el.dataset.ak != null && S.sel.length === 1) { pushHistory(); const i = Number(el.closest(".rsg-action").dataset.ai); const a = S.sel[0].actions[i]; const k = el.dataset.ak; if (k === "extra") { const v = el.value.trim(); delete a.effect; delete a.remote; delete a.message; delete a.seconds; if (v) { if (a.do === "remote") a.remote = v; else if (a.do === "print") a.message = v; else if (a.do === "auto_hide" || a.do === "pulse") a.seconds = Number(v) || 3; else a.effect = v; } } else if (k === "target") { if (el.value.trim()) a.target = el.value.trim(); else delete a.target; } else a[k] = el.value; renderAll(); return; }
      if (el.dataset.k != null) {
        if (el.dataset.k.startsWith("screen.")) { applyProp(null, el.dataset.k, el.value, el); renderAll(); return; }
        if (S.sel.length !== 1) return;
        pushHistory(); const n = S.sel[0]; const key = el.dataset.k;
        if (el.dataset.kind === "color") { const raw = D.props.querySelector(`[data-k="${key}"][data-kind="raw"]`); if (raw) raw.value = el.value; const tok = D.props.querySelector(`[data-k="${key}@tok"]`); if (tok) tok.value = ""; }
        applyProp(n, key, el.value, el);
        if (key === "name") { reindex(); }
        renderAll();
      }
    });
    host.addEventListener("input", (e) => { const el = e.target; if ((el.dataset.sk === "bg" || el.dataset.sk === "text_color") && S.sel.length === 1) { const n = S.sel[0]; n[el.dataset.sk] = el.value; if (el.dataset.sk === "bg" && n.bg_t != null && tokenNum(n.bg_t, 0) >= 1) delete n.bg_t; renderStage(); } if (el.dataset.kind === "color" && S.sel.length === 1) { const n = S.sel[0]; setPath(n, el.dataset.k, el.value); renderStage(); } if (el.dataset.tok && el.type === "color") { S.tokens[el.dataset.tok] = el.value; renderStage(); } if (el.classList.contains("rsg-intent")) S.intent = el.value; });
    D.stage.addEventListener("pointerdown", (e) => { if (e.target === D.stage || e.target === D.stageWrap) { if (S.sel.length) { S.sel = []; renderAll(); } return; } onDown(e); });
    window.addEventListener("pointermove", (e) => { if (S.open) onMove(e); });
    window.addEventListener("pointerup", (e) => { if (S.open) onUp(e); });
    D.stage.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
    D.screen.addEventListener("dblclick", (e) => {
      const deep = nodeAt(e.target); if (!deep) return;
      const cur = S.sel.length === 1 ? S.sel[0] : null;
      if (cur && cur !== deep && isDescendant(deep, cur)) { let c = deep; while (parentOf(c) && parentOf(c) !== cur) c = parentOf(c); S.sel = [c]; renderAll(); return; } // drill one level
      if (cur !== deep) { S.sel = [deep]; renderAll(); return; }
      if (/^(TextLabel|TextButton|TextBox)$/.test(deep.class)) { const t = prompt("Text", deep.text || ""); if (t != null) { pushHistory(); deep.text = t; renderAll(); } }
    });
    document.addEventListener("keydown", onKey, true);
    host.addEventListener("pointerdown", (e) => e.stopPropagation());
    host.addEventListener("keydown", (e) => e.stopPropagation());
    window.addEventListener("resize", () => { if (S.open) fitZoom(); });
    setTool("select");
  }
  function act(name) {
    const n = S.sel.length === 1 ? S.sel[0] : null;
    switch (name) {
      case "undo": return undo(); case "redo": return redo(); case "zoomIn": return zoomBy(1.2); case "zoomOut": return zoomBy(1 / 1.2); case "fit": return fitZoom();
      case "grid": S.grid = !S.grid; D.host.querySelector('[data-act="grid"]').classList.toggle("on", S.grid); return renderStage();
      case "snap": S.snap = !S.snap; D.host.querySelector('[data-act="snap"]').classList.toggle("on", S.snap); return;
      case "import": return importFromStudio(); case "importGo": return importPath(D.importSel.value); case "importCancel": D.importBox.hidden = true; return;
      case "open": return openJson(); case "save": return downloadJson(); case "copyLua": return copyText(toLuau(getSpec()), "Luau"); case "copyJson": return copyText(JSON.stringify(getSpec(), null, 2), "JSON");
      case "applyJson": if (loadSpec(D.codeJson.value)) toast("Applied"); return;
      case "clear": if (S.nodes.length && !confirm("Clear the whole design?")) return; pushHistory(); S.nodes = []; S.sel = []; reindex(); return renderAll();
      case "close": return close(); case "build": return buildInStudio(); case "send": return sendToAI();
      case "delete": return deleteSel(); case "dup": return duplicateSel(); case "group": return groupSel();
      case "sameSize": if (S.sel.length > 1) { pushHistory(); const b0 = geo.get(S.sel[0].id); for (const x of S.sel.slice(1)) { const b = Object.assign({}, geo.get(x.id)); b.w = b0.w; b.h = b0.h; setBox(x, b); } renderAll(); } return;
      case "raise": if (n) reorder(n, 1); return; case "lower": if (n) reorder(n, -1); return; case "indent": if (n) indent(n); return; case "outdent": if (n) outdent(n); return;
      case "toScale": if (n) { pushHistory(); toScale(n); renderAll(); } return; case "toOffset": if (n) { pushHistory(); toOffset(n); renderAll(); } return;
      case "fillParent": if (n) { pushHistory(); n.size = [1, 0, 1, 0]; n.position = [0, 0, 0, 0]; delete n.anchor; renderAll(); } return;
      case "centerInParent": if (n) { pushHistory(); n.anchor = [0.5, 0.5]; n.position = [0.5, 0, 0.5, 0]; renderAll(); } return;
      case "addAction": if (n) { pushHistory(); n.actions = n.actions || []; n.actions.push(/Button$/.test(n.class) ? { on: "click", do: "toggle", target: "" } : { on: "enable", do: "tween_in", effect: "pop" }); renderAll(); } return;
      default: if (name.startsWith("align:")) return alignSel(name.slice(6)); if (name.startsWith("dist:")) return distributeSel(name.slice(5));
    }
  }

  // ───────────────────────── public ─────────────────────────
  function open(hooks) {
    S.hooks = hooks || S.hooks || {};
    if (!D) build();
    S.open = true; D.host.classList.add("open"); document.documentElement.classList.add("rs-gui-open");
    const canStudio = !!(S.hooks.runTool); D.buildBtn.hidden = !canStudio; D.host.querySelector('[data-act="import"]').hidden = !canStudio;
    const ready = S.hooks.studioReady ? !!S.hooks.studioReady() : true; D.buildBtn.title = ready ? "Run ui_build_spec in the connected Studio right now (no AI turn)" : "Studio is not connected yet — Build will try anyway, or use Send to AI";
    D.intent.value = S.intent; setStatus("");
    renderAll();
    requestAnimationFrame(() => { fitZoom(); D.host.focus(); });
    diag("open", { nodes: byId.size, engine: S.hooks.engine ? S.hooks.engine() : "" });
  }
  function close() { if (!S.open) return; S.open = false; D.host.classList.remove("open"); document.documentElement.classList.remove("rs-gui-open"); diag("close", { nodes: byId.size }); }
  function isOpen() { return S.open; }

  window.ORGuiStudio = { open, close, isOpen, getSpec, loadSpec, toLuau, buildMessage, setMode, TEMPLATES, DEVICES, ELEMENT_TOOLS, SIMPLE_ELEMENTS, SIMPLE_COMPONENTS, _state: S, _geo: geo, _computeGeometry: computeGeometry, _setBox: setBox, _makeNode: makeNode, _adopt: adopt, _reindex: reindex };
})();
