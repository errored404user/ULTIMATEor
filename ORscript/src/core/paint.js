/* ORscript Paint — draw it, the AI builds it.
 *
 * A full raster paint studio (tools, layers, params, undo/redo, zoom/pan,
 * import/export) that lives in a fixed overlay above the chat site. Every
 * committed operation is also logged as a vector primitive so the hand-off to
 * the AI carries BOTH the PNG (for sites that accept images) and a structured
 * description — shapes, labels, arrows, relations, palette and an occupancy
 * map — so even a text-only model can act on the drawing precisely.
 *
 * Public API (window.ORPaint):
 *   open(hooks)   hooks = {
 *     send(text, images, onStatus) -> Promise<boolean>   // main.js: start agent if needed, type+send
 *     captureStudio() -> Promise<[{mimeType,data}]|null> // optional: Studio viewport as a layer
 *     engine() -> "roblox" | "local" | "anim"
 *     canAttachImages() -> boolean
 *     workMode() -> string, toast(msg), diag(event, data)
 *   }
 *   close(), isOpen(), describe() (analysis text), buildMessage()
 */
(() => {
  "use strict";
  if (window.ORPaint) return;

  const SVG = (d, extra = "") => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const ICONS = {
    pencil: SVG('<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M13 7l3 3"/>'),
    brush: SVG('<path d="M20 4c-3 1-8 6-10 9l2 2c3-2 8-7 9-10z"/><path d="M8 15c-2 0-4 1-4 4 0 1-1 1-1 1s4 1 6-1c1-1 1-2 1-2z"/>'),
    marker: SVG('<path d="M6 20h12"/><path d="M8 17l8-11 2 2-8 11z"/><path d="M14 8l2 2"/>'),
    spray: SVG('<path d="M9 10h6v10H9z"/><path d="M11 10V7h2v3"/><path d="M16 4h.01M18 6h.01M19 3h.01M15 7h.01M19 8h.01"/>'),
    eraser: SVG('<path d="M4 16l8-8 6 6-5 5H8z"/><path d="M14 8l4-4 2 2-4 4"/><path d="M13 19h7"/>'),
    fill: SVG('<path d="M5 12l7-7 7 7-7 7z"/><path d="M12 5V3"/><path d="M19 14c1 1.5 2 3 2 4a2 2 0 1 1-4 0c0-1 1-2.5 2-4z"/>'),
    picker: SVG('<path d="M4 20l1-4 9-9 3 3-9 9z"/><path d="M14 7l3-3 3 3-3 3"/>'),
    line: SVG('<path d="M5 19L19 5"/>'),
    arrow: SVG('<path d="M5 19L19 5"/><path d="M11 5h8v8"/>'),
    rect: SVG('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
    ellipse: SVG('<ellipse cx="12" cy="12" rx="8" ry="6"/>'),
    triangle: SVG('<path d="M12 5l8 14H4z"/>'),
    star: SVG('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
    text: SVG('<path d="M5 6h14"/><path d="M12 6v13"/><path d="M9 19h6"/>'),
    select: SVG('<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2"/>'),
    hand: SVG('<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.4L4 13.5A1.4 1.4 0 0 1 6.3 12L8 14z"/>'),
    undo: SVG('<path d="M9 14H4V9"/><path d="M4 14a8 8 0 1 1 3 6"/>'),
    redo: SVG('<path d="M15 14h5V9"/><path d="M20 14a8 8 0 1 0-3 6"/>'),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    eye: SVG('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: SVG('<path d="M3 3l18 18"/><path d="M10 6a10 10 0 0 1 12 6s-1 2-3 4M6 8c-3 2-4 4-4 4s4 7 10 7c2 0 3-.5 4-1"/>'),
    camera: SVG('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    image: SVG('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>'),
    send: SVG('<path d="M4 12l16-8-6 16-2-7z"/><path d="M12 13l8-9"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    up: SVG('<path d="M6 15l6-6 6 6"/>'),
    down: SVG('<path d="M6 9l6 6 6-6"/>'),
    merge: SVG('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>'),
    dup: SVG('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    grid: SVG('<path d="M4 4h16v16H4z"/><path d="M4 10h16M4 15h16M10 4v16M15 4v16"/>'),
    zoomIn: SVG('<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6M20 20l-4-4"/>'),
    zoomOut: SVG('<circle cx="11" cy="11" r="7"/><path d="M8 11h6M20 20l-4-4"/>'),
    fit: SVG('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    save: SVG('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'),
    copy: SVG('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"/>'),
    clear: SVG('<path d="M4 20h16"/><path d="M7 16L17 6l2 2L9 18z"/><path d="M14 9l1 1"/>'),
    flipH: SVG('<path d="M12 3v18"/><path d="M8 7L3 12l5 5z"/><path d="M16 7l5 5-5 5z"/>'),
    flipV: SVG('<path d="M3 12h18"/><path d="M7 8l5-5 5 5z"/><path d="M7 16l5 5 5-5z"/>'),
  };

  const TOOLS = [
    { id: "pencil", key: "P", label: "Pencil", hint: "Hard-edged freehand line" },
    { id: "brush", key: "B", label: "Brush", hint: "Round brush with softness" },
    { id: "marker", key: "M", label: "Marker", hint: "Translucent highlighter" },
    { id: "spray", key: "S", label: "Spray", hint: "Airbrush speckle" },
    { id: "eraser", key: "E", label: "Eraser", hint: "Erase on the active layer" },
    { id: "fill", key: "F", label: "Fill", hint: "Flood fill a region" },
    { id: "picker", key: "I", label: "Picker", hint: "Pick a colour from the canvas" },
    { id: "line", key: "L", label: "Line", hint: "Straight line (Shift = 45°)" },
    { id: "arrow", key: "A", label: "Arrow", hint: "Arrow — points at things" },
    { id: "rect", key: "R", label: "Rectangle", hint: "Rectangle (Shift = square)" },
    { id: "ellipse", key: "O", label: "Ellipse", hint: "Ellipse (Shift = circle)" },
    { id: "triangle", key: "G", label: "Triangle", hint: "Triangle" },
    { id: "star", key: "K", label: "Star", hint: "Star / marker symbol" },
    { id: "text", key: "T", label: "Text", hint: "Type a label" },
    { id: "select", key: "V", label: "Select", hint: "Rectangle select — drag to move, Del to clear" },
    { id: "hand", key: "H", label: "Hand", hint: "Pan (or hold Space)" },
  ];
  const STROKE_TOOLS = new Set(["pencil", "brush", "marker", "spray", "eraser"]);
  const SHAPE_TOOLS = new Set(["line", "arrow", "rect", "ellipse", "triangle", "star"]);

  const PALETTE = [
    "#000000", "#3b3b3b", "#7a7a7a", "#b8b8b8", "#ffffff", "#8b0000", "#ff0000", "#ff6a00", "#ffb000", "#ffe600",
    "#9bff00", "#1fbf3a", "#006b2b", "#00d1c1", "#00a3ff", "#0044ff", "#1b1b8a", "#7a2bff", "#c800ff", "#ff2bb0",
    "#ff8fb1", "#8b5a2b", "#c69c6d", "#f5e1c0",
  ];
  // Nearest-name table for the AI description (plain English colour words).
  const NAMED = [
    ["black", "#000000"], ["dark gray", "#3b3b3b"], ["gray", "#7a7a7a"], ["light gray", "#b8b8b8"], ["white", "#ffffff"],
    ["dark red", "#8b0000"], ["red", "#ff0000"], ["orange", "#ff6a00"], ["amber", "#ffb000"], ["yellow", "#ffe600"],
    ["lime", "#9bff00"], ["green", "#1fbf3a"], ["dark green", "#006b2b"], ["teal", "#00d1c1"], ["sky blue", "#00a3ff"],
    ["blue", "#0044ff"], ["navy", "#1b1b8a"], ["violet", "#7a2bff"], ["magenta", "#c800ff"], ["pink", "#ff2bb0"],
    ["light pink", "#ff8fb1"], ["brown", "#8b5a2b"], ["tan", "#c69c6d"], ["beige", "#f5e1c0"], ["cyan", "#00ffff"],
    ["purple", "#800080"], ["olive", "#808000"], ["maroon", "#800000"], ["gold", "#d4af37"], ["silver", "#c0c0c0"],
  ];
  const INTENTS = [
    { id: "auto", label: "Auto-detect", short: "decide what the drawing is", hint: "The AI decides whether this is a 3D structure, a map, a UI, terrain, a character, a diagram or an annotation." },
    { id: "structure", label: "3D structure / model", short: "a front or isometric sketch of a 3D object to build", hint: "Buildings, props, vehicles, machines — built from parts." },
    { id: "layout", label: "Top-down map / level", short: "a top-down level layout: X→X, Y→Z", hint: "Rooms, walls, paths, spawn points, zones." },
    { id: "ui", label: "UI / GUI mockup", short: "a screen mockup to recreate as a GUI", hint: "Frames, buttons, labels, bars — proportions as drawn." },
    { id: "terrain", label: "Terrain / landscape", short: "a terrain map: colours = materials, shapes = regions", hint: "Grass, water, rock, sand, snow — sculpted terrain." },
    { id: "character", label: "Character / creature", short: "a character or creature to build as a rig/model", hint: "Body proportions and colours as drawn." },
    { id: "diagram", label: "Systems diagram", short: "a logic/architecture diagram: boxes = modules, arrows = flow", hint: "Scripts, remotes, data flow — implemented as code." },
    { id: "annotate", label: "Annotate Studio screenshot", short: "instructions drawn over the live viewport", hint: "Import the viewport, then circle/arrow/label what to change." },
    { id: "animation", label: "Animation / poses", short: "poses and motion arrows to animate", hint: "Keyframes from stick-figure poses and arrows." },
  ];
  const SIZE_PRESETS = [[1280, 720, "16:9 HD"], [1920, 1080, "Full HD"], [1024, 1024, "Square"], [960, 540, "Small 16:9"], [800, 600, "4:3"], [640, 640, "Pixel 640"]];
  const BACKGROUNDS = [["white", "White"], ["black", "Black"], ["paper", "Grid paper"], ["dark-grid", "Dark grid"], ["transparent", "Transparent"]];

  // ───────────────────────── state ─────────────────────────
  const S = {
    open: false, hooks: null,
    tool: "brush", lastTool: "brush", color: "#1fbf3a", color2: "#ffffff", size: 10, opacity: 100, hardness: 80,
    density: 40, tolerance: 24, fontSize: 28, bold: true, shapeMode: "stroke", cornerRadius: 0, arrowHead: 3, dash: false,
    smoothing: 55, symmetry: "none", pressure: true, grid: { on: true, size: 32, snap: false },
    bg: "white", w: 1280, h: 720, zoom: 1, pan: { x: 0, y: 0 },
    layers: [], active: 0, history: [], redo: [], prims: [], recent: [],
    intent: "auto", caption: "", scale: "", attach: true, trace: true, selfCheck: true, planFirst: false,
    selection: null, floating: null, clip: null, textInput: null,
  };
  let D = null; // dom refs
  let raf = 0, dirty = true;
  let stroke = null; // in-progress op
  let spaceDown = false;
  let seq = 0;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const diag = (e, d) => { try { S.hooks && S.hooks.diag && S.hooks.diag("paint." + e, d || {}); } catch {} };
  const toast = (m) => { try { S.hooks && S.hooks.toast ? S.hooks.toast(m) : console.log("[paint]", m); } catch {} };

  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join(""); }
  function colorName(hex) {
    const [r, g, b] = hexToRgb(hex); let best = "colour", bd = 1e9;
    for (const [name, h] of NAMED) { const [r2, g2, b2] = hexToRgb(h); const d = (r - r2) ** 2 * 0.3 + (g - g2) ** 2 * 0.59 + (b - b2) ** 2 * 0.11; if (d < bd) { bd = d; best = name; } }
    return best;
  }

  // ───────────────────────── layers / history ─────────────────────────
  function makeLayer(name, kind = "paint") {
    const c = document.createElement("canvas"); c.width = S.w; c.height = S.h;
    return { id: ++seq, name, kind, canvas: c, ctx: c.getContext("2d", { willReadFrequently: true }), visible: true, opacity: 1, locked: false };
  }
  const L = () => S.layers[S.active];
  function pushHistory(kind = "pixels", layerIdx = S.active) {
    try {
      const l = S.layers[layerIdx]; if (!l) return;
      S.history.push({ kind, layerIdx, data: l.ctx.getImageData(0, 0, S.w, S.h), prims: S.prims.length, layers: null });
      // bytes cap (~150 MB): drop the oldest
      let bytes = 0; for (let i = S.history.length - 1; i >= 0; i--) { bytes += S.history[i].data ? S.history[i].data.data.length : 0; if (bytes > 150e6) { S.history.splice(0, i + 1); break; } }
      if (S.history.length > 60) S.history.shift();
      S.redo.length = 0;
    } catch (e) { diag("history.err", { e: String(e) }); }
    syncButtons();
  }
  function pushStructural() {
    S.history.push({ kind: "layers", layers: S.layers.map((l) => ({ ...l, data: l.ctx.getImageData(0, 0, S.w, S.h) })), active: S.active, w: S.w, h: S.h, prims: S.prims.length });
    if (S.history.length > 60) S.history.shift();
    S.redo.length = 0; syncButtons();
  }
  function snapshotFor(entry) {
    if (entry.kind === "layers") return { kind: "layers", layers: S.layers.map((l) => ({ ...l, data: l.ctx.getImageData(0, 0, S.w, S.h) })), active: S.active, w: S.w, h: S.h, prims: S.prims.length };
    const l = S.layers[entry.layerIdx] || L();
    return { kind: "pixels", layerIdx: entry.layerIdx, data: l.ctx.getImageData(0, 0, S.w, S.h), prims: S.prims.length };
  }
  function applyEntry(entry) {
    if (entry.kind === "layers") {
      S.w = entry.w; S.h = entry.h;
      S.layers = entry.layers.map((src) => { const l = makeLayer(src.name, src.kind); l.visible = src.visible; l.opacity = src.opacity; l.locked = src.locked; l.ctx.putImageData(src.data, 0, 0); return l; });
      S.active = clamp(entry.active, 0, S.layers.length - 1);
      renderLayerList();
    } else {
      const l = S.layers[entry.layerIdx]; if (l) l.ctx.putImageData(entry.data, 0, 0);
    }
    S.prims.length = Math.min(S.prims.length, entry.prims);
    dirty = true; syncButtons();
  }
  function undo() { const e = S.history.pop(); if (!e) return; commitFloating(); S.redo.push(snapshotFor(e)); applyEntry(e); diag("undo"); }
  function redo() { const e = S.redo.pop(); if (!e) return; S.history.push(snapshotFor(e)); applyEntry(e); diag("redo"); }

  // ───────────────────────── geometry helpers ─────────────────────────
  function toCanvas(ev) {
    const r = D.view.getBoundingClientRect();
    let x = (ev.clientX - r.left - S.pan.x) / S.zoom, y = (ev.clientY - r.top - S.pan.y) / S.zoom;
    return { x, y, p: ev.pressure && ev.pointerType === "pen" ? ev.pressure : 1 };
  }
  function snap(pt) { if (!S.grid.on || !S.grid.snap) return pt; const g = S.grid.size; return { ...pt, x: Math.round(pt.x / g) * g, y: Math.round(pt.y / g) * g }; }
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const sqSeg = (p, a, b) => { let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y; if (dx || dy) { const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = b.x; y = b.y; } else if (t > 0) { x += dx * t; y += dy * t; } } dx = p.x - x; dy = p.y - y; return dx * dx + dy * dy; };
    const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) { const [a, b] = stack.pop(); let mi = -1, md = 0; for (let i = a + 1; i < b; i++) { const d = sqSeg(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } } if (mi > 0 && md > eps * eps) { keep[mi] = true; stack.push([a, mi], [mi, b]); } }
    return pts.filter((_, i) => keep[i]);
  }
  function bboxOf(pts) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }; }
  function symmetryTransforms() {
    const t = [[1, 0, 0]];
    if (S.symmetry === "h" || S.symmetry === "hv") t.push([-1, 0, 0]);
    if (S.symmetry === "v" || S.symmetry === "hv") t.push([0, -1, 0]);
    if (S.symmetry === "hv") t.push([-1, -1, 0]);
    if (S.symmetry === "radial") { t.length = 0; for (let i = 0; i < 8; i++) t.push([0, 0, (Math.PI * 2 * i) / 8]); }
    return t;
  }
  function withSymmetry(ctx, fn) {
    for (const [fx, fy, rot] of symmetryTransforms()) {
      ctx.save(); ctx.translate(S.w / 2, S.h / 2);
      if (rot) ctx.rotate(rot); else ctx.scale(fx === -1 ? -1 : 1, fy === -1 ? -1 : 1);
      ctx.translate(-S.w / 2, -S.h / 2); fn(ctx); ctx.restore();
    }
  }

  // ───────────────────────── painting ─────────────────────────
  let scratch = null, scratchCtx = null;
  function ensureScratch() {
    if (!scratch) { scratch = document.createElement("canvas"); scratchCtx = scratch.getContext("2d", { willReadFrequently: true }); }
    if (scratch.width !== S.w || scratch.height !== S.h) { scratch.width = S.w; scratch.height = S.h; }
  }
  function strokeWidth(p) { return Math.max(0.5, S.size * (S.pressure ? 0.35 + 0.65 * (p || 1) : 1)); }
  function drawPath(ctx, pts, tool) {
    if (!pts.length) return;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (tool === "pencil") { ctx.strokeStyle = S.color; ctx.lineWidth = Math.max(1, S.size * 0.6); }
    else if (tool === "marker") { ctx.strokeStyle = S.color; ctx.lineWidth = S.size * 1.6; ctx.lineCap = "butt"; }
    else if (tool === "eraser") { ctx.strokeStyle = "#000"; ctx.lineWidth = S.size; }
    if (tool === "brush") {
      // dab stamping with softness
      const hard = S.hardness / 100;
      let last = null;
      for (const p of pts) {
        const w = strokeWidth(p.p), r = w / 2;
        const dab = (x, y) => {
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, S.color); g.addColorStop(Math.max(0.01, hard), S.color); g.addColorStop(1, S.color + "00");
          ctx.fillStyle = hard >= 0.99 ? S.color : g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        };
        if (!last) dab(p.x, p.y);
        else { const d = dist(last, p), step = Math.max(1, r * 0.35), n = Math.ceil(d / step); for (let i = 1; i <= n; i++) dab(last.x + (p.x - last.x) * i / n, last.y + (p.y - last.y) * i / n); }
        last = p;
      }
      return;
    }
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) { const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }; ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y); }
    const l = pts[pts.length - 1]; ctx.lineTo(l.x, l.y); ctx.stroke();
  }
  function sprayDabs(ctx, p) {
    ctx.fillStyle = S.color; const r = S.size, n = Math.max(2, Math.round(S.density / 4));
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r; ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0.6 + Math.random() * 1.2, 0, Math.PI * 2); ctx.fill(); }
  }
  function constrain(a, b, shift, tool) {
    if (!shift) return b;
    if (tool === "line" || tool === "arrow") { const dx = b.x - a.x, dy = b.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy); return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }; }
    const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)); return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
  }
  function drawShape(ctx, tool, a, b) {
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = S.size; ctx.strokeStyle = S.color; ctx.fillStyle = S.shapeMode === "both" ? S.color2 : S.color;
    ctx.setLineDash(S.dash ? [S.size * 2, S.size * 1.5] : []);
    const doFill = S.shapeMode !== "stroke", doStroke = S.shapeMode !== "fill";
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.beginPath();
    if (tool === "line" || tool === "arrow") {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (tool === "arrow") { const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = Math.max(10, S.size * S.arrowHead); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45)); ctx.lineTo(b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fillStyle = S.color; ctx.fill(); }
      return;
    }
    if (tool === "rect") { const r = Math.min(S.cornerRadius, w / 2, h / 2); if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
    else if (tool === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
    else if (tool === "triangle") { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
    else if (tool === "star") { const cx = x + w / 2, cy = y + h / 2, R = Math.max(w, h) / 2, r = R * 0.45; for (let i = 0; i < 10; i++) { const rr = i % 2 ? r : R, an = -Math.PI / 2 + i * Math.PI / 5; ctx[i ? "lineTo" : "moveTo"](cx + Math.cos(an) * rr, cy + Math.sin(an) * rr); } ctx.closePath(); }
    if (doFill) ctx.fill(); if (doStroke) ctx.stroke(); ctx.setLineDash([]);
  }
  function floodFill(layer, x, y) {
    x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= S.w || y >= S.h) return 0;
    // Boundaries come from everything visible (so a sketch on another layer contains the fill); pixels go into the active layer.
    const comp = compositeCanvas(false), cd = comp.getContext("2d").getImageData(0, 0, S.w, S.h).data;
    const out = layer.ctx.getImageData(0, 0, S.w, S.h), od = out.data;
    const i0 = (y * S.w + x) * 4, tr = cd[i0], tg = cd[i0 + 1], tb = cd[i0 + 2], ta = cd[i0 + 3];
    const tol = (S.tolerance / 100) * 255 * 1.2, [fr, fg, fb] = hexToRgb(S.color), fa = Math.round(S.opacity * 2.55);
    const match = (i) => Math.abs(cd[i] - tr) <= tol && Math.abs(cd[i + 1] - tg) <= tol && Math.abs(cd[i + 2] - tb) <= tol && Math.abs(cd[i + 3] - ta) <= tol;
    const seen = new Uint8Array(S.w * S.h); const stack = [x, y]; let filled = 0;
    while (stack.length) {
      let py = stack.pop(), px = stack.pop(); let i = py * S.w + px;
      while (px >= 0 && !seen[i] && match(i * 4)) { px--; i--; }
      px++; i++; let up = false, down = false;
      while (px < S.w && !seen[i] && match(i * 4)) {
        seen[i] = 1; od[i * 4] = fr; od[i * 4 + 1] = fg; od[i * 4 + 2] = fb; od[i * 4 + 3] = fa; filled++;
        if (py > 0) { const j = i - S.w; if (!seen[j] && match(j * 4)) { if (!up) { stack.push(px, py - 1); up = true; } } else up = false; }
        if (py < S.h - 1) { const j = i + S.w; if (!seen[j] && match(j * 4)) { if (!down) { stack.push(px, py + 1); down = true; } } else down = false; }
        px++; i++;
      }
    }
    layer.ctx.putImageData(out, 0, 0);
    return filled;
  }
  function compositeCanvas(withBg) {
    const c = document.createElement("canvas"); c.width = S.w; c.height = S.h; const ctx = c.getContext("2d");
    if (withBg) paintBackground(ctx, 0, 0, S.w, S.h, 1, true);
    for (const l of S.layers) if (l.visible) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.canvas, 0, 0); }
    ctx.globalAlpha = 1; return c;
  }
  function paintBackground(ctx, x, y, w, h, z, forExport) {
    if (S.bg === "transparent") { if (forExport) return; const s = 12; ctx.fillStyle = "#cfcfcf"; ctx.fillRect(x, y, w, h); ctx.fillStyle = "#f4f4f4"; for (let yy = 0; yy < h; yy += s) for (let xx = ((yy / s) % 2) * s; xx < w; xx += s * 2) ctx.fillRect(x + xx, y + yy, s, s); return; }
    ctx.fillStyle = S.bg === "black" || S.bg === "dark-grid" ? "#111214" : "#ffffff"; ctx.fillRect(x, y, w, h);
    if (S.bg === "paper" || S.bg === "dark-grid") { ctx.strokeStyle = S.bg === "paper" ? "rgba(70,120,200,.22)" : "rgba(255,255,255,.10)"; ctx.lineWidth = 1; const g = 32 * z; ctx.beginPath(); for (let xx = 0; xx <= w; xx += g) { ctx.moveTo(x + xx + 0.5, y); ctx.lineTo(x + xx + 0.5, y + h); } for (let yy = 0; yy <= h; yy += g) { ctx.moveTo(x, y + yy + 0.5); ctx.lineTo(x + w, y + yy + 0.5); } ctx.stroke(); }
  }

  // ───────────────────────── render loop ─────────────────────────
  function render() {
    raf = 0; if (!S.open || !D) return; if (!dirty) return; dirty = false;
    const view = D.view, ctx = view.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const rect = D.stage.getBoundingClientRect(); const vw = Math.max(1, Math.round(rect.width)), vh = Math.max(1, Math.round(rect.height));
    if (view.width !== vw * dpr || view.height !== vh * dpr) { view.width = vw * dpr; view.height = vh * dpr; view.style.width = vw + "px"; view.style.height = vh + "px"; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
    const z = S.zoom, px = S.pan.x, py = S.pan.y, cw = S.w * z, ch = S.h * z;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 24; ctx.fillStyle = "#000"; ctx.fillRect(px, py, cw, ch); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(px, py, cw, ch); ctx.clip();
    paintBackground(ctx, px, py, cw, ch, z, false);
    ctx.imageSmoothingEnabled = z < 3;
    S.layers.forEach((l, i) => {
      if (!l.visible) return; ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, px, py, cw, ch);
      if (i === S.active && stroke && stroke.preview) { ctx.globalAlpha = l.opacity * (stroke.alpha ?? 1); if (stroke.erase) { ctx.globalAlpha = l.opacity; } ctx.drawImage(scratch, px, py, cw, ch); }
      if (i === S.active && S.floating) { ctx.globalAlpha = l.opacity; ctx.drawImage(S.floating.canvas, px + S.floating.x * z, py + S.floating.y * z, S.floating.canvas.width * z, S.floating.canvas.height * z); }
    });
    ctx.globalAlpha = 1;
    if (S.grid.on) { ctx.strokeStyle = S.bg === "black" || S.bg === "dark-grid" ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)"; ctx.lineWidth = 1; const g = S.grid.size * z; if (g >= 6) { ctx.beginPath(); for (let x = 0; x <= cw + 0.5; x += g) { ctx.moveTo(px + x + 0.5, py); ctx.lineTo(px + x + 0.5, py + ch); } for (let y = 0; y <= ch + 0.5; y += g) { ctx.moveTo(px, py + y + 0.5); ctx.lineTo(px + cw, py + y + 0.5); } ctx.stroke(); } }
    if (S.selection) { const s = S.selection; ctx.save(); ctx.setLineDash([6, 4]); ctx.lineWidth = 1; ctx.strokeStyle = "#fff"; ctx.strokeRect(px + s.x * z + 0.5, py + s.y * z + 0.5, s.w * z, s.h * z); ctx.strokeStyle = "#000"; ctx.lineDashOffset = 6; ctx.strokeRect(px + s.x * z + 0.5, py + s.y * z + 0.5, s.w * z, s.h * z); ctx.restore(); }
    ctx.restore();
    // brush cursor
    if (S.cursor && (STROKE_TOOLS.has(S.tool))) { const r = (S.tool === "pencil" ? S.size * 0.6 : S.tool === "marker" ? S.size * 1.6 : S.tool === "spray" ? S.size * 2 : S.size) * z / 2; ctx.beginPath(); ctx.arc(S.cursor.x, S.cursor.y, Math.max(2, r), 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1; ctx.stroke(); ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]); }
    D.status.textContent = `${S.w}×${S.h} · ${Math.round(S.zoom * 100)}% · ${TOOLS.find((t) => t.id === S.tool).label} ${S.tool === "text" ? S.fontSize : S.size}px · ${S.layers.length} layer${S.layers.length === 1 ? "" : "s"} · ${S.prims.length} element${S.prims.length === 1 ? "" : "s"}${S.cursor ? ` · ${Math.round((S.cursor.x - S.pan.x) / S.zoom)},${Math.round((S.cursor.y - S.pan.y) / S.zoom)}` : ""}`;
  }
  function invalidate() { dirty = true; if (!raf) raf = requestAnimationFrame(render); }
  function fitZoom() {
    const r = D.stage.getBoundingClientRect(); const z = Math.min((r.width - 40) / S.w, (r.height - 40) / S.h, 4);
    S.zoom = Math.max(0.05, Math.floor(z * 100) / 100); S.pan.x = Math.round((r.width - S.w * S.zoom) / 2); S.pan.y = Math.round((r.height - S.h * S.zoom) / 2); invalidate();
  }
  function zoomAt(factor, cx, cy) {
    const r = D.stage.getBoundingClientRect(); cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
    const nz = clamp(S.zoom * factor, 0.05, 32); const k = nz / S.zoom; S.pan.x = cx - (cx - S.pan.x) * k; S.pan.y = cy - (cy - S.pan.y) * k; S.zoom = nz; invalidate();
  }

  // ───────────────────────── pointer handling ─────────────────────────
  function onDown(ev) {
    if (ev.button === 1 || spaceDown || S.tool === "hand") { stroke = { kind: "pan", sx: ev.clientX, sy: ev.clientY, px: S.pan.x, py: S.pan.y }; D.view.setPointerCapture(ev.pointerId); return; }
    if (ev.button === 2) { ev.preventDefault(); }
    commitTextInput();
    const raw = toCanvas(ev), pt = snap(raw); const right = ev.button === 2; const useColor = right ? S.color2 : S.color;
    const layer = L(); if (!layer) return;
    if (layer.locked) { toast("Layer is locked"); return; }
    D.view.setPointerCapture(ev.pointerId);
    const swap = right && S.color !== S.color2; const saved = S.color; if (swap) S.color = useColor;
    if (S.tool === "picker") { pickColor(pt, right); if (swap) S.color = saved; stroke = { kind: "pick", right }; return; }
    if (S.tool === "fill") { pushHistory(); const n = floodFill(layer, pt.x, pt.y); S.prims.push({ t: "fill", c: S.color, a: S.opacity, at: [pt.x, pt.y], area: n / (S.w * S.h), layer: S.active }); if (swap) S.color = saved; invalidate(); stroke = { kind: "done" }; return; }
    if (S.tool === "text") { if (swap) S.color = saved; openTextInput(pt, ev); stroke = { kind: "done" }; return; }
    if (S.tool === "select") {
      if (S.floating && inRect(pt, { x: S.floating.x, y: S.floating.y, w: S.floating.canvas.width, h: S.floating.canvas.height })) { stroke = { kind: "moveFloat", start: pt, ox: S.floating.x, oy: S.floating.y }; return; }
      if (S.selection && inRect(pt, S.selection)) { liftSelection(); stroke = { kind: "moveFloat", start: pt, ox: S.floating.x, oy: S.floating.y }; return; }
      commitFloating(); S.selection = null; stroke = { kind: "select", start: pt }; invalidate(); return;
    }
    ensureScratch(); scratchCtx.setTransform(1, 0, 0, 1, 0, 0); scratchCtx.clearRect(0, 0, S.w, S.h); scratchCtx.globalCompositeOperation = "source-over";
    if (STROKE_TOOLS.has(S.tool)) {
      stroke = { kind: "stroke", tool: S.tool, pts: [raw], raw: [raw], preview: true, alpha: S.tool === "eraser" ? 1 : S.opacity / 100 * (S.tool === "marker" ? 0.45 : 1), erase: S.tool === "eraser", color: S.color, swap, saved, shift: ev.shiftKey };
      if (S.tool === "eraser") { stroke.preview = false; pushHistory(); }
      drawStrokeProgress(true);
    } else if (SHAPE_TOOLS.has(S.tool)) {
      stroke = { kind: "shape", tool: S.tool, a: pt, b: pt, preview: true, alpha: S.opacity / 100, color: S.color, swap, saved };
      drawShapeProgress();
    }
    invalidate();
  }
  function onMove(ev) {
    const r = D.view.getBoundingClientRect(); S.cursor = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (!stroke) { invalidate(); return; }
    if (stroke.kind === "pan") { S.pan.x = stroke.px + ev.clientX - stroke.sx; S.pan.y = stroke.py + ev.clientY - stroke.sy; invalidate(); return; }
    const raw = toCanvas(ev);
    if (stroke.kind === "stroke") {
      const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const e of events) { const p = toCanvas(e); stroke.raw.push(p); const last = stroke.pts[stroke.pts.length - 1]; const sm = S.smoothing / 100 * (S.tool === "spray" ? 0 : 0.85); stroke.pts.push(sm > 0 ? { x: last.x + (p.x - last.x) * (1 - sm), y: last.y + (p.y - last.y) * (1 - sm), p: p.p } : p); }
      drawStrokeProgress(false); invalidate(); return;
    }
    if (stroke.kind === "shape") { stroke.b = constrain(stroke.a, snap(raw), ev.shiftKey, stroke.tool); drawShapeProgress(); invalidate(); return; }
    if (stroke.kind === "select") { const a = stroke.start, b = snap(raw); S.selection = normRect(a, b); invalidate(); return; }
    if (stroke.kind === "moveFloat" && S.floating) { S.floating.x = stroke.ox + (raw.x - stroke.start.x); S.floating.y = stroke.oy + (raw.y - stroke.start.y); if (S.grid.on && S.grid.snap) { S.floating.x = Math.round(S.floating.x / S.grid.size) * S.grid.size; S.floating.y = Math.round(S.floating.y / S.grid.size) * S.grid.size; } S.selection = { x: S.floating.x, y: S.floating.y, w: S.floating.canvas.width, h: S.floating.canvas.height }; invalidate(); return; }
  }
  function onUp(ev) {
    if (!stroke) return; const st = stroke; stroke = null;
    try { D.view.releasePointerCapture(ev.pointerId); } catch {}
    if (st.kind === "stroke") {
      const layer = L();
      if (st.tool === "eraser") { /* already applied live */ }
      else { pushHistory(); layer.ctx.save(); layer.ctx.globalAlpha = st.alpha; layer.ctx.drawImage(scratch, 0, 0); layer.ctx.restore(); }
      const pts = simplify(st.raw, Math.max(1.5, S.size * 0.15)); const bb = bboxOf(st.raw);
      S.prims.push({ t: st.tool, c: st.color, w: S.size, a: S.opacity, pts: pts.map((p) => [Math.round(p.x), Math.round(p.y)]), len: pathLen(st.raw), bb: [Math.round(bb.x0), Math.round(bb.y0), Math.round(bb.x1), Math.round(bb.y1)], sym: S.symmetry, layer: S.active });
      if (st.swap) S.color = st.saved;
    } else if (st.kind === "shape") {
      const layer = L(); if (dist(st.a, st.b) >= 2) { pushHistory(); layer.ctx.save(); layer.ctx.globalAlpha = st.alpha; layer.ctx.drawImage(scratch, 0, 0); layer.ctx.restore();
        S.prims.push({ t: st.tool, c: st.color, c2: S.shapeMode === "both" ? S.color2 : null, mode: (st.tool === "line" || st.tool === "arrow") ? "stroke" : S.shapeMode, w: S.size, a: S.opacity, dash: S.dash, from: [Math.round(st.a.x), Math.round(st.a.y)], to: [Math.round(st.b.x), Math.round(st.b.y)], bb: [Math.round(Math.min(st.a.x, st.b.x)), Math.round(Math.min(st.a.y, st.b.y)), Math.round(Math.max(st.a.x, st.b.x)), Math.round(Math.max(st.a.y, st.b.y))], sym: S.symmetry, layer: S.active }); }
      if (st.swap) S.color = st.saved;
    } else if (st.kind === "select") { if (S.selection && (S.selection.w < 2 || S.selection.h < 2)) S.selection = null; }
    invalidate(); syncButtons();
  }
  function drawStrokeProgress(first) {
    const st = stroke; if (!st) return;
    if (st.tool === "eraser") { const ctx = L().ctx; ctx.save(); ctx.globalCompositeOperation = "destination-out"; withSymmetry(ctx, (c) => drawPath(c, st.pts.slice(-3), "eraser")); ctx.restore(); return; }
    if (st.tool === "spray") { withSymmetry(scratchCtx, (c) => sprayDabs(c, st.pts[st.pts.length - 1])); return; }
    scratchCtx.clearRect(0, 0, S.w, S.h);
    withSymmetry(scratchCtx, (c) => drawPath(c, st.pts, st.tool));
  }
  function drawShapeProgress() { const st = stroke; scratchCtx.clearRect(0, 0, S.w, S.h); withSymmetry(scratchCtx, (c) => drawShape(c, st.tool, st.a, st.b)); }
  function pathLen(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]); return l; }
  function normRect(a, b) { return { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), w: Math.round(Math.abs(b.x - a.x)), h: Math.round(Math.abs(b.y - a.y)) }; }
  function inRect(p, r) { return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h; }
  function pickColor(pt, secondary) {
    const comp = compositeCanvas(true); const d = comp.getContext("2d").getImageData(clamp(Math.floor(pt.x), 0, S.w - 1), clamp(Math.floor(pt.y), 0, S.h - 1), 1, 1).data;
    const hex = rgbToHex(d[0], d[1], d[2]); if (secondary) S.color2 = hex; else setColor(hex); toast(`Picked ${hex} (${colorName(hex)})`);
  }

  // selection / floating
  function liftSelection() {
    const s = S.selection; if (!s || S.floating) return; const layer = L(); pushHistory();
    const c = document.createElement("canvas"); c.width = Math.max(1, s.w); c.height = Math.max(1, s.h);
    c.getContext("2d").drawImage(layer.canvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h); layer.ctx.clearRect(s.x, s.y, s.w, s.h);
    S.floating = { canvas: c, x: s.x, y: s.y, from: { ...s } };
  }
  function commitFloating() {
    if (!S.floating) return; const f = S.floating; const layer = L(); layer.ctx.drawImage(f.canvas, Math.round(f.x), Math.round(f.y));
    if (f.from && (Math.round(f.x) !== f.from.x || Math.round(f.y) !== f.from.y)) S.prims.push({ t: "move", from: [f.from.x, f.from.y, f.from.w, f.from.h], to: [Math.round(f.x), Math.round(f.y)], layer: S.active });
    S.floating = null; invalidate();
  }
  function deleteSelection() { if (S.floating) { pushHistory(); S.floating = null; S.selection = null; invalidate(); return; } const s = S.selection; if (!s) return; pushHistory(); L().ctx.clearRect(s.x, s.y, s.w, s.h); S.prims.push({ t: "erase-rect", bb: [s.x, s.y, s.x + s.w, s.y + s.h], layer: S.active }); S.selection = null; invalidate(); }
  function copySelection(cut) { const s = S.selection; if (!s) return; const c = document.createElement("canvas"); c.width = s.w; c.height = s.h; const src = S.floating ? S.floating.canvas : L().canvas; c.getContext("2d").drawImage(src, S.floating ? 0 : s.x, S.floating ? 0 : s.y, s.w, s.h, 0, 0, s.w, s.h); S.clip = c; if (cut) deleteSelection(); toast(cut ? "Cut" : "Copied"); }
  function pasteClip(img) { const c = img || S.clip; if (!c) return; commitFloating(); pushHistory(); const w = c.width, h = c.height; const vis = visibleCenter(); S.floating = { canvas: cloneCanvas(c), x: Math.round(vis.x - w / 2), y: Math.round(vis.y - h / 2), from: null }; S.selection = { x: S.floating.x, y: S.floating.y, w, h }; setTool("select"); S.prims.push({ t: "paste", bb: [S.floating.x, S.floating.y, S.floating.x + w, S.floating.y + h], layer: S.active }); invalidate(); }
  function cloneCanvas(c) { const n = document.createElement("canvas"); n.width = c.width; n.height = c.height; n.getContext("2d").drawImage(c, 0, 0); return n; }
  function visibleCenter() { const r = D.stage.getBoundingClientRect(); return { x: clamp((r.width / 2 - S.pan.x) / S.zoom, 0, S.w), y: clamp((r.height / 2 - S.pan.y) / S.zoom, 0, S.h) }; }

  // text tool
  function openTextInput(pt, ev) {
    commitTextInput();
    const ta = document.createElement("textarea"); ta.className = "rsp-text-input"; ta.rows = 1; ta.placeholder = "Type a label… Enter = place, Esc = cancel";
    const r = D.view.getBoundingClientRect(); ta.style.left = (ev.clientX - r.left) + "px"; ta.style.top = (ev.clientY - r.top) + "px";
    ta.style.font = `${S.bold ? 700 : 400} ${Math.max(10, S.fontSize * S.zoom)}px Inter, "Segoe UI", Arial, sans-serif`; ta.style.color = S.color;
    D.stage.appendChild(ta); S.textInput = { el: ta, pt }; setTimeout(() => ta.focus(), 0);
    ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextInput(); } else if (e.key === "Escape") { e.preventDefault(); cancelTextInput(); } });
    ta.addEventListener("blur", () => setTimeout(() => { if (S.textInput && S.textInput.el === ta) commitTextInput(); }, 150));
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; ta.style.width = Math.max(120, ta.value.length * S.fontSize * S.zoom * 0.62 + 24) + "px"; });
  }
  function cancelTextInput() { if (!S.textInput) return; S.textInput.el.remove(); S.textInput = null; }
  function commitTextInput() {
    const ti = S.textInput; if (!ti) return; const text = ti.el.value.replace(/\s+$/, ""); ti.el.remove(); S.textInput = null; if (!text.trim()) return;
    const layer = L(); pushHistory(); const ctx = layer.ctx; ctx.save(); ctx.globalAlpha = S.opacity / 100; ctx.fillStyle = S.color; ctx.textBaseline = "top";
    ctx.font = `${S.bold ? 700 : 400} ${S.fontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    const lines = text.split("\n"); let maxW = 0; lines.forEach((ln, i) => { ctx.fillText(ln, ti.pt.x, ti.pt.y + i * S.fontSize * 1.2); maxW = Math.max(maxW, ctx.measureText(ln).width); }); ctx.restore();
    S.prims.push({ t: "text", text, c: S.color, size: S.fontSize, at: [Math.round(ti.pt.x), Math.round(ti.pt.y)], bb: [Math.round(ti.pt.x), Math.round(ti.pt.y), Math.round(ti.pt.x + maxW), Math.round(ti.pt.y + lines.length * S.fontSize * 1.2)], layer: S.active });
    invalidate();
  }

  // ───────────────────────── layers UI ─────────────────────────
  function addLayer(name, kind, atBottom) { if (S.layers.length >= 8) { toast("Maximum 8 layers"); return null; } pushStructural(); const l = makeLayer(name || `Layer ${S.layers.length + 1}`, kind); if (atBottom) { S.layers.unshift(l); S.active = 0; } else { S.layers.splice(S.active + 1, 0, l); S.active += 1; } renderLayerList(); invalidate(); return l; }
  function deleteLayer() { if (S.layers.length <= 1) { toast("Keep at least one layer"); return; } pushStructural(); S.layers.splice(S.active, 1); S.active = clamp(S.active - 1, 0, S.layers.length - 1); renderLayerList(); invalidate(); }
  function duplicateLayer() { if (S.layers.length >= 8) return; pushStructural(); const src = L(); const l = makeLayer(src.name + " copy", src.kind); l.ctx.drawImage(src.canvas, 0, 0); l.opacity = src.opacity; S.layers.splice(S.active + 1, 0, l); S.active += 1; renderLayerList(); invalidate(); }
  function mergeDown() { if (S.active === 0) return; pushStructural(); const top = L(), below = S.layers[S.active - 1]; below.ctx.save(); below.ctx.globalAlpha = top.opacity; below.ctx.drawImage(top.canvas, 0, 0); below.ctx.restore(); S.layers.splice(S.active, 1); S.active -= 1; renderLayerList(); invalidate(); }
  function moveLayer(dir) { const j = S.active + dir; if (j < 0 || j >= S.layers.length) return; pushStructural(); const a = S.layers[S.active]; S.layers[S.active] = S.layers[j]; S.layers[j] = a; S.active = j; renderLayerList(); invalidate(); }
  function renderLayerList() {
    if (!D) return; D.layers.innerHTML = "";
    [...S.layers].reverse().forEach((l) => {
      const i = S.layers.indexOf(l); const row = document.createElement("div"); row.className = "rsp-layer" + (i === S.active ? " on" : "") + (l.visible ? "" : " hidden-layer"); row.dataset.i = i;
      const th = document.createElement("canvas"); th.width = 40; th.height = 24; const tc = th.getContext("2d"); tc.fillStyle = "#777"; tc.fillRect(0, 0, 40, 24); tc.drawImage(l.canvas, 0, 0, 40, 24);
      row.appendChild(th);
      const name = document.createElement("input"); name.className = "rsp-layer-name"; name.value = l.name; name.title = "Rename"; name.addEventListener("change", () => { l.name = name.value.trim() || l.name; }); name.addEventListener("keydown", (e) => e.stopPropagation()); row.appendChild(name);
      const eye = document.createElement("button"); eye.type = "button"; eye.className = "rsp-ib"; eye.title = l.visible ? "Hide" : "Show"; eye.innerHTML = l.visible ? ICONS.eye : ICONS.eyeOff; eye.addEventListener("click", (e) => { e.stopPropagation(); l.visible = !l.visible; renderLayerList(); invalidate(); }); row.appendChild(eye);
      row.addEventListener("click", () => { commitFloating(); S.active = i; renderLayerList(); syncParams(); });
      D.layers.appendChild(row);
    });
    const l = L(); if (l && D.layerOpacity) { D.layerOpacity.value = Math.round(l.opacity * 100); D.layerOpacityVal.textContent = Math.round(l.opacity * 100) + "%"; }
  }

  // ───────────────────────── import / export ─────────────────────────
  function loadImageFile(file) { return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = rej; img.src = url; }); }
  function loadDataUrl(url) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = url; }); }
  function placeImageLayer(img, name, asBackground) {
    const maxW = 1600, maxH = 1000; let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (asBackground && (w !== S.w || h !== S.h)) { const k = Math.min(1, maxW / w, maxH / h); resizeCanvas(Math.round(w * k), Math.round(h * k), true); }
    const l = addLayer(name, "image", asBackground); if (!l) return;
    const k = Math.min(S.w / w, S.h / h, 1); const dw = Math.round(w * k), dh = Math.round(h * k);
    l.ctx.drawImage(img, Math.round((S.w - dw) / 2), Math.round((S.h - dh) / 2), dw, dh); l.locked = false;
    S.prims.push({ t: "image", name, bb: [Math.round((S.w - dw) / 2), Math.round((S.h - dh) / 2), Math.round((S.w + dw) / 2), Math.round((S.h + dh) / 2)], layer: S.layers.indexOf(l) });
    renderLayerList(); invalidate();
  }
  async function importStudio() {
    if (!S.hooks || !S.hooks.captureStudio) { toast("Studio capture is not available on this page"); return; }
    setStatus("Capturing the Studio viewport…");
    try {
      const imgs = await S.hooks.captureStudio(); const im = imgs && imgs[0]; if (!im) throw new Error("no image");
      const img = await loadDataUrl(`data:${im.mimeType || "image/png"};base64,${im.data}`);
      placeImageLayer(img, "Studio viewport", true); S.intent = "annotate"; D.intent.value = "annotate"; syncIntentHint(); fitZoom(); setStatus("Viewport imported as the bottom layer — draw your changes on top.");
    } catch (e) { setStatus("Could not capture Studio: " + (e && e.message || e)); }
  }
  function exportPng() { return compositeCanvas(true).toDataURL("image/png"); }
  function exportImage() {
    const c = compositeCanvas(true); const url = c.toDataURL("image/png"), base64 = url.split(",")[1];
    // keep payloads sane for upload: fall back to JPEG when the PNG is big
    if (base64.length > 2.5e6) { const j = c.toDataURL("image/jpeg", 0.9); return { mimeType: "image/jpeg", data: j.split(",")[1] }; }
    return { mimeType: "image/png", data: base64 };
  }
  function downloadPng() { const a = document.createElement("a"); a.href = exportPng(); a.download = `orscript-paint-${Date.now()}.png`; document.body.appendChild(a); a.click(); a.remove(); toast("PNG saved"); }
  async function copyPng() { try { const blob = await new Promise((r) => compositeCanvas(true).toBlob(r, "image/png")); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("Image copied"); } catch (e) { toast("Clipboard blocked by the page — use Save PNG"); } }
  function resizeCanvas(w, h, keepLayers) {
    w = clamp(Math.round(w), 64, 4096); h = clamp(Math.round(h), 64, 4096); if (w === S.w && h === S.h) return;
    pushStructural(); const old = S.layers; S.w = w; S.h = h;
    S.layers = old.map((l) => { const n = makeLayer(l.name, l.kind); n.visible = l.visible; n.opacity = l.opacity; if (keepLayers !== false) n.ctx.drawImage(l.canvas, 0, 0); return n; });
    renderLayerList(); D.sizeW.value = w; D.sizeH.value = h; fitZoom();
  }
  function clearAll() { pushStructural(); for (const l of S.layers) l.ctx.clearRect(0, 0, S.w, S.h); S.prims.length = 0; S.selection = null; S.floating = null; invalidate(); }
  function flip(axis) { pushHistory(); const l = L(); const c = cloneCanvas(l.canvas); l.ctx.save(); l.ctx.clearRect(0, 0, S.w, S.h); l.ctx.translate(axis === "h" ? S.w : 0, axis === "v" ? S.h : 0); l.ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1); l.ctx.drawImage(c, 0, 0); l.ctx.restore(); S.prims.push({ t: "flip", axis, layer: S.active }); invalidate(); }

  // ───────────────────────── analysis (vector trace → words) ─────────────────────────
  const pct = (v, total) => Math.round((v / total) * 100);
  function describePrim(p, idx) {
    const where = (bb) => `x ${pct(bb[0], S.w)}–${pct(bb[2], S.w)}%, y ${pct(bb[1], S.h)}–${pct(bb[3], S.h)}% (w ${pct(bb[2] - bb[0], S.w)}% × h ${pct(bb[3] - bb[1], S.h)}%)`;
    const col = (c) => c ? `${colorName(c)} ${c}` : "";
    const a = p.a != null && p.a < 100 ? `, ${p.a}% opacity` : "";
    if (p.t === "fill") return `#${idx} flood fill, ${col(p.c)} covering ~${Math.round(p.area * 100)}% of the canvas, seeded at ${pct(p.at[0], S.w)}%,${pct(p.at[1], S.h)}%`;
    if (p.t === "text") return `#${idx} TEXT "${p.text.replace(/\n/g, " / ")}" in ${col(p.c)}, ${p.size}px, at ${pct(p.at[0], S.w)}%,${pct(p.at[1], S.h)}%`;
    if (p.t === "image") return `#${idx} imported image "${p.name}" at ${where(p.bb)}`;
    if (p.t === "move") return `#${idx} moved region ${p.from[2]}×${p.from[3]}px from ${pct(p.from[0], S.w)}%,${pct(p.from[1], S.h)}% to ${pct(p.to[0], S.w)}%,${pct(p.to[1], S.h)}%`;
    if (p.t === "erase-rect") return `#${idx} erased rectangle at ${where(p.bb)}`;
    if (p.t === "paste") return `#${idx} pasted image region at ${where(p.bb)}`;
    if (p.t === "flip") return `#${idx} flipped layer ${p.axis === "h" ? "horizontally" : "vertically"}`;
    if (p.t === "line" || p.t === "arrow") {
      const ang = Math.round(Math.atan2(p.to[1] - p.from[1], p.to[0] - p.from[0]) * 180 / Math.PI);
      const dir = Math.abs(ang) <= 20 ? "pointing right" : Math.abs(ang) >= 160 ? "pointing left" : ang > 70 && ang < 110 ? "pointing down" : ang < -70 && ang > -110 ? "pointing up" : ang > 0 ? (ang < 90 ? "pointing down-right" : "pointing down-left") : (ang > -90 ? "pointing up-right" : "pointing up-left");
      return `#${idx} ${p.t === "arrow" ? "ARROW" : "straight line"} ${col(p.c)}${a}, from ${pct(p.from[0], S.w)}%,${pct(p.from[1], S.h)}% to ${pct(p.to[0], S.w)}%,${pct(p.to[1], S.h)}% (${dir}, ${Math.round(Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]))}px${p.dash ? ", dashed" : ""})`;
    }
    if (SHAPE_TOOLS.has(p.t)) {
      const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1]; const sq = Math.abs(w - h) / Math.max(w, h, 1) < 0.1;
      const name = p.t === "rect" ? (sq ? "SQUARE" : "RECTANGLE") : p.t === "ellipse" ? (sq ? "CIRCLE" : "ELLIPSE") : p.t.toUpperCase();
      const fill = p.mode === "fill" ? "filled" : p.mode === "both" ? `filled ${col(p.c2)} with ${col(p.c)} outline` : "outline only";
      return `#${idx} ${name}, ${fill === "outline only" ? col(p.c) + " outline" : fill}${a}${p.dash ? ", dashed" : ""}, at ${where(p.bb)}`;
    }
    if (STROKE_TOOLS.has(p.t)) {
      const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1]; const chord = Math.hypot(p.pts[p.pts.length - 1][0] - p.pts[0][0], p.pts[p.pts.length - 1][1] - p.pts[0][1]);
      const diagl = Math.hypot(w, h); let kind = "freehand stroke";
      if (p.t === "eraser") kind = "eraser stroke";
      else if (p.len > 0 && chord / p.len > 0.96 && p.len > 20) kind = "straight-ish freehand line";
      else if (chord < Math.max(14, diagl * 0.12) && diagl > 24) kind = Math.abs(w - h) / Math.max(w, h, 1) < 0.25 ? "closed round blob (hand-drawn circle)" : "closed freehand loop";
      else if (p.pts.length <= 3 && p.len < 12) kind = "dot";
      else if (p.len > 2.5 * diagl) kind = "scribble / shaded area";
      const tool = p.t === "marker" ? "marker" : p.t === "spray" ? "spray" : p.t === "pencil" ? "pencil" : "brush";
      const path = p.pts.length <= 12 ? ` path ${p.pts.map(([x, y]) => `${pct(x, S.w)},${pct(y, S.h)}`).join("→")}` : "";
      return `#${idx} ${kind} (${tool}, ${col(p.c)}, ${p.w}px${a}), at ${where(p.bb)}${path}`;
    }
    return `#${idx} ${p.t}`;
  }
  function relations(prims) {
    const out = []; const boxes = prims.map((p, i) => ({ i: i + 1, p, bb: p.bb })).filter((b) => b.bb && !["eraser", "erase-rect", "move", "paste", "flip", "image"].includes(b.p.t));
    const inside = (a, b) => a.bb[0] >= b.bb[0] - 2 && a.bb[1] >= b.bb[1] - 2 && a.bb[2] <= b.bb[2] + 2 && a.bb[3] <= b.bb[3] + 2 && (a.bb[2] - a.bb[0]) * (a.bb[3] - a.bb[1]) < (b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]) * 0.9;
    const center = (b) => [(b.bb[0] + b.bb[2]) / 2, (b.bb[1] + b.bb[3]) / 2];
    const nearest = (pt, excl) => { let best = null, bd = 1e9; for (const b of boxes) { if (b === excl || b.p.t === "text" || b.p.t === "arrow" || b.p.t === "line") continue; const c = center(b); const d = Math.hypot(c[0] - pt[0], c[1] - pt[1]) - Math.min(b.bb[2] - b.bb[0], b.bb[3] - b.bb[1]) / 2; if (d < bd) { bd = d; best = b; } } return bd < Math.max(S.w, S.h) * 0.12 ? best : null; };
    for (const a of boxes) for (const b of boxes) if (a !== b && inside(a, b) && a.p.t !== "text") out.push(`#${a.i} is inside #${b.i}`);
    for (const t of boxes.filter((b) => b.p.t === "text")) { const n = nearest(center(t), t); const host = boxes.find((b) => b !== t && inside(t, b)); if (host) out.push(`label "${t.p.text}" (#${t.i}) sits inside #${host.i}`); else if (n) out.push(`label "${t.p.text}" (#${t.i}) is next to #${n.i}`); }
    for (const ar of boxes.filter((b) => b.p.t === "arrow")) { const from = nearest(ar.p.from, ar), to = nearest(ar.p.to, ar); if (from || to) out.push(`arrow #${ar.i} goes from ${from ? "#" + from.i : "empty space"} to ${to ? "#" + to.i : "empty space"}`); }
    return out.slice(0, 40);
  }
  function occupancyMap() {
    const cols = Math.min(48, Math.max(16, Math.round(S.w / 30))), rows = Math.max(8, Math.round(cols * S.h / S.w));
    // Sample 4×4 sub-cells per cell so thin 2–3px outlines are not averaged away; a cell takes the dominant colour of its inked sub-cells.
    const SUB = 4, comp = compositeCanvas(false); const small = document.createElement("canvas"); small.width = cols * SUB; small.height = rows * SUB; const sc = small.getContext("2d"); sc.imageSmoothingEnabled = true; sc.drawImage(comp, 0, 0, small.width, small.height);
    const d = sc.getImageData(0, 0, small.width, small.height).data; const legend = new Map(); const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; const lines = []; let any = false;
    for (let y = 0; y < rows; y++) {
      let line = "";
      for (let x = 0; x < cols; x++) {
        const votes = new Map();
        for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) { const i = ((y * SUB + sy) * small.width + (x * SUB + sx)) * 4; if (d[i + 3] < 70) continue; const name = colorName(rgbToHex(d[i], d[i + 1], d[i + 2])); votes.set(name, (votes.get(name) || 0) + 1); }
        if (!votes.size) { line += "."; continue; }
        const name = [...votes].sort((a, b) => b[1] - a[1])[0][0];
        if (!legend.has(name)) legend.set(name, letters[legend.size % letters.length]); line += legend.get(name); any = true;
      }
      lines.push(line);
    }
    if (!any) return "";
    return `OCCUPANCY MAP (${cols}×${rows} cells, each cell ≈ ${Math.round(S.w / cols)}×${Math.round(S.h / rows)}px; '.' = empty; legend: ${[...legend].map(([n, l]) => `${l}=${n}`).join(", ")}):\n${lines.join("\n")}`;
  }
  function describe() {
    const prims = S.prims.filter((p) => p.t !== "eraser");
    const palette = new Map(); for (const p of prims) if (p.c) { const n = colorName(p.c); palette.set(n, (palette.get(n) || 0) + 1); }
    const texts = prims.filter((p) => p.t === "text");
    const lines = [];
    lines.push(`CANVAS: ${S.w}×${S.h}px, ${BACKGROUNDS.find((b) => b[0] === S.bg)[1].toLowerCase()} background${S.grid.on ? `, grid ${S.grid.size}px${S.grid.snap ? " (snapped)" : ""}` : ""}, ${S.layers.length} layer${S.layers.length === 1 ? "" : "s"} (${S.layers.map((l) => l.name + (l.visible ? "" : " hidden")).join(", ")}). Coordinates below are % of canvas width/height from the top-left.`);
    if (palette.size) lines.push(`PALETTE: ${[...palette].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(", ")}`);
    if (!prims.length) lines.push("DRAWN ELEMENTS: none (blank canvas).");
    else {
      lines.push(`DRAWN ELEMENTS (${prims.length}, in drawing order):`);
      const shown = prims.length > 70 ? prims.slice(0, 50).concat(prims.slice(-20)) : prims; let k = 0;
      prims.forEach((p, i) => { if (!shown.includes(p)) { if (k++ === 0) lines.push(`  … ${prims.length - 70} more elements omitted …`); return; } lines.push("  " + describePrim(p, i + 1)); });
    }
    if (texts.length) lines.push(`TEXT LABELS: ${texts.map((t) => `"${t.text.replace(/\n/g, " / ")}"`).join(", ")}`);
    const rel = relations(prims); if (rel.length) lines.push("RELATIONS: " + rel.join("; "));
    let occ = ""; try { occ = occupancyMap(); } catch (e) { diag("occupancyFail", { err: String(e && e.message || e).slice(0, 120) }); } if (occ) lines.push(occ);
    return lines.join("\n");
  }
  function intentGuidance(id, engine) {
    const local = engine === "local";
    const G = {
      auto: "First decide what the drawing is (3D structure, top-down level, UI mockup, terrain, character, systems diagram, animation, or an annotated screenshot). State your reading in one line, then act as the matching mode below would.",
      structure: local ? "Treat it as a design sketch; produce the corresponding code/asset files (e.g. an SVG/HTML component, a 3D scene description, or data) that reproduce it." : "Treat it as a front/isometric sketch of a 3D object. Build it from Parts/WedgeParts/Cylinders/Spheres (or a Model with named parts) with proportions matching the drawing; outline-only shapes are hollow or framed, filled shapes are solid; canvas X = world X, canvas Y = world Y (up is up); place it near the spawn/origin on the ground.",
      layout: local ? "Treat it as a top-down layout; generate the level/scene data or code the project uses for maps." : "Treat it as a TOP-DOWN level map: canvas X = world X, canvas Y = world Z, up on the canvas = -Z. Closed regions are floors/zones, thick or dark lines are walls (default 12 studs high, 1 stud thick), labels are room/area names, circles are spawn points or pillars, arrows are doors/paths in that direction. Build on a baseplate; keep everything to scale.",
      ui: local ? "Treat it as a UI wireframe; implement it in the project's UI stack (HTML/CSS/React/etc.) with the same layout, proportions, colours and label text." : "Treat it as a screen mockup. Recreate it as a ScreenGui in StarterGui: rectangles → Frames/TextButtons/TextLabels (text drawn inside a box is its Text), ellipses → round elements (UICorner 1,0), lines → separators/bars, proportions via UDim2 Scale so it matches the canvas percentages, colours exactly as drawn, rounded corners where sketched.",
      terrain: local ? "Treat it as a terrain/biome map; generate the heightmap/biome data or procedural code accordingly." : "Treat it as a terrain map from above: colours → Terrain materials (green grass, dark green leafy/forest, blue water, sky blue shallow water/ice, brown mud/soil, gray/dark gray rock, white snow, yellow/beige sand, red/orange lava or brick); larger shapes first, then details; keep region proportions; add gentle height variation (darker = lower unless labelled). Use terrain fill/paint commands, not Parts.",
      character: local ? "Treat it as a character/creature concept; produce the corresponding asset/data/code." : "Treat it as a character or creature sketch. Build a Model from Parts with the drawn proportions and colours (head, torso, limbs, extras as separate named parts, Motor6Ds or welds). If humanoid-shaped, add HumanoidRootPart + Humanoid so it can be animated.",
      diagram: local ? "Treat boxes as modules/files/services and arrows as calls/data flow; implement the architecture as code with those names." : "Treat boxes as systems/scripts/modules and arrows as data/event flow: client↔server arrows → RemoteEvents/RemoteFunctions, labels → script/module names, cylinders/ellipses → data stores or services. Implement it as real scripts in the right containers (ServerScriptService, ReplicatedStorage, StarterPlayerScripts…).",
      annotate: "The BOTTOM layer is a screenshot of the CURRENT scene; everything drawn on top is an instruction about it: circles/outlines = the thing to change, arrows = move/point it there (or a direction), X / scribble = delete, rectangles = add something of that size there, text = what to do. Identify the real instances under each mark (inspect the scene) and apply the changes to the live scene; do not rebuild what is already there.",
      animation: local ? "Treat poses as keyframes and arrows as motion; produce animation data/code." : "Treat each stick figure / pose as a keyframe in order (left→right or by numbers), arrows as motion direction and intensity, dashed shapes as ghosted previous positions. Use the animation commands to create the keyframe sequence on the selected or nearest rig and play it to verify.",
    };
    return G[id] || G.auto;
  }
  function buildMessage() {
    const engine = (S.hooks && S.hooks.engine && S.hooks.engine()) || "roblox"; const intent = INTENTS.find((i) => i.id === S.intent) || INTENTS[0];
    const hasStudioBg = S.layers.some((l) => l.name === "Studio viewport" && l.visible);
    const attachNote = S.attach && S.hooks && S.hooks.canAttachImages && S.hooks.canAttachImages() ? "The drawing is attached as an image AND described below; use both (the description is exact, the image shows style)." : "No image can be attached on this site — the description below is the complete, exact drawing. Work from it.";
    const out = [];
    out.push(`🎨 ORSCRIPT PAINT — I drew this for you. ${attachNote}`);
    out.push(`INTENT: ${intent.label} — ${intent.short}${hasStudioBg && S.intent !== "annotate" ? " (note: a Studio screenshot is the bottom layer)" : ""}`);
    out.push(`MY NOTE: ${S.caption.trim() || "(none — infer from the drawing)"}`);
    if (S.scale.trim()) out.push(`SCALE: ${S.scale.trim()}`); else if (engine !== "local") out.push(`SCALE: not specified — pick a sensible one (e.g. ${S.intent === "ui" ? "canvas = full screen" : S.intent === "layout" || S.intent === "terrain" ? "1% of canvas width ≈ 2 studs" : "the whole drawing ≈ 20–60 studs"}) and say which you chose.`);
    if (S.trace) out.push(describe()); else out.push(`CANVAS: ${S.w}×${S.h}px`);
    out.push("HOW TO ACT:");
    out.push(`1. Start your reply with "I see:" and 2–4 lines naming the elements and what they mean (count them; do not skip any), then immediately begin building — one command per reply as usual.`);
    out.push(`2. ${intentGuidance(S.intent, engine)}`);
    out.push(`3. Colours as drawn (nearest material/BrickColor/Color3), text labels become names/texts, arrows are directions or relations, proportions and relative positions must match the percentages above. Unlabelled scribbles are rough area fills, not objects.`);
    if (S.planFirst) out.push(`4. Before building, post a short numbered plan and wait for my "go".`);
    else if (engine !== "local" && S.selfCheck) out.push(`4. When finished, take a screen_capture (or or_screenshot) and compare it against my drawing; fix any missing or misplaced element (up to 2 rounds), then summarise what you built in one line.`);
    else out.push(`4. When finished, summarise what you built in one line.`);
    return out.join("\n");
  }

  // ───────────────────────── send ─────────────────────────
  async function sendToAI() {
    if (!S.hooks || !S.hooks.send) { toast("Sending is not wired on this page"); return; }
    if (!S.prims.length && !S.layers.some((l) => l.kind === "image")) { setStatus("Draw something first."); return; }
    commitTextInput(); commitFloating();
    D.sendBtn.disabled = true; setStatus("Preparing…");
    const text = buildMessage(); const images = S.attach ? [exportImage()] : null;
    diag("send", { chars: text.length, image: !!images, prims: S.prims.length, intent: S.intent });
    try {
      const ok = await S.hooks.send(text, images, setStatus);
      if (ok) { setStatus("Sent — the AI is reading your drawing. Closing…"); setTimeout(() => close(), 900); }
      else setStatus("The chat did not accept the message. Try again or save the PNG.");
    } catch (e) { setStatus("Send failed: " + (e && e.message || e)); diag("send.err", { e: String(e) }); }
    D.sendBtn.disabled = false;
  }
  function setStatus(msg) { if (D) D.sendStatus.textContent = msg || ""; }

  // ───────────────────────── UI build ─────────────────────────
  function build() {
    const host = document.createElement("div"); host.id = "rs-paint"; host.setAttribute("role", "dialog"); host.setAttribute("aria-label", "ORscript Paint");
    const toolBtns = TOOLS.map((t) => `<button type="button" class="rsp-tool" data-tool="${t.id}" title="${esc(t.label)} (${t.key}) — ${esc(t.hint)}">${ICONS[t.id]}<span>${esc(t.label)}</span></button>`).join("");
    const palette = PALETTE.map((c) => `<button type="button" class="rsp-sw" data-color="${c}" style="--c:${c}" title="${colorName(c)} ${c} (left = primary, right = secondary)"></button>`).join("");
    host.innerHTML = `
      <div class="rsp-shell">
        <div class="rsp-title">
          <span class="rsp-brand"><img class="rsp-logo" alt="" src="${esc((window.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("assets/logo.svg") : "")}">ORscript Paint</span>
          <span class="rsp-sub">Draw it → the AI builds it</span>
          <div class="rsp-title-actions">
            <button type="button" class="rsp-ib" data-act="undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
            <button type="button" class="rsp-ib" data-act="redo" title="Redo (Ctrl+Y)">${ICONS.redo}</button>
            <span class="rsp-sep"></span>
            <button type="button" class="rsp-ib" data-act="zoomOut" title="Zoom out (-)">${ICONS.zoomOut}</button>
            <button type="button" class="rsp-ib" data-act="fit" title="Fit (0)">${ICONS.fit}</button>
            <button type="button" class="rsp-ib" data-act="zoomIn" title="Zoom in (+)">${ICONS.zoomIn}</button>
            <span class="rsp-sep"></span>
            <button type="button" class="rsp-ib" data-act="studio" title="Import the Studio viewport as a layer to annotate">${ICONS.camera}</button>
            <button type="button" class="rsp-ib" data-act="import" title="Import an image file as a layer">${ICONS.image}</button>
            <button type="button" class="rsp-ib" data-act="save" title="Save PNG (Ctrl+S)">${ICONS.save}</button>
            <button type="button" class="rsp-ib" data-act="copy" title="Copy image to clipboard">${ICONS.copy}</button>
            <button type="button" class="rsp-ib" data-act="clear" title="Clear canvas">${ICONS.clear}</button>
            <span class="rsp-sep"></span>
            <button type="button" class="rsp-ib rsp-close" data-act="close" title="Close (Esc)">${ICONS.close}</button>
          </div>
        </div>
        <div class="rsp-body">
          <div class="rsp-tools">${toolBtns}</div>
          <div class="rsp-main">
            <div class="rsp-ribbon">
              <div class="rsp-colors">
                <div class="rsp-current" title="Primary (left click) / secondary (right click). Click to swap (X)"><span class="rsp-c1"></span><span class="rsp-c2"></span></div>
                <div class="rsp-palette">${palette}</div>
                <label class="rsp-custom" title="Custom colour"><input type="color" class="rsp-color-input" value="${S.color}"><span>Custom</span></label>
                <div class="rsp-recent" title="Recent colours"></div>
              </div>
              <div class="rsp-params"></div>
            </div>
            <div class="rsp-stage"><canvas class="rsp-view"></canvas></div>
            <div class="rsp-status"></div>
          </div>
          <div class="rsp-side">
            <section class="rsp-sec">
              <h4>Layers <span class="rsp-sec-actions"><button type="button" class="rsp-ib" data-act="layerAdd" title="Add layer">${ICONS.plus}</button><button type="button" class="rsp-ib" data-act="layerDup" title="Duplicate">${ICONS.dup}</button><button type="button" class="rsp-ib" data-act="layerMerge" title="Merge down">${ICONS.merge}</button><button type="button" class="rsp-ib" data-act="layerUp" title="Move up">${ICONS.up}</button><button type="button" class="rsp-ib" data-act="layerDown" title="Move down">${ICONS.down}</button><button type="button" class="rsp-ib" data-act="layerDel" title="Delete layer">${ICONS.trash}</button></span></h4>
              <div class="rsp-layers"></div>
              <label class="rsp-row"><span>Layer opacity</span><input type="range" class="rsp-layer-opacity" min="0" max="100" value="100"><b class="rsp-layer-opacity-val">100%</b></label>
              <div class="rsp-row rsp-flips"><button type="button" class="rsp-ib" data-act="flipH" title="Flip layer horizontally">${ICONS.flipH}</button><button type="button" class="rsp-ib" data-act="flipV" title="Flip layer vertically">${ICONS.flipV}</button></div>
            </section>
            <section class="rsp-sec">
              <h4>Canvas</h4>
              <div class="rsp-row"><select class="rsp-preset">${SIZE_PRESETS.map(([w, h, n]) => `<option value="${w}x${h}">${n} · ${w}×${h}</option>`).join("")}<option value="custom">Custom…</option></select></div>
              <div class="rsp-row rsp-size"><input type="number" class="rsp-size-w" min="64" max="4096" value="${S.w}"><span>×</span><input type="number" class="rsp-size-h" min="64" max="4096" value="${S.h}"><button type="button" class="rsp-mini" data-act="applySize">Apply</button></div>
              <div class="rsp-row"><span>Background</span><select class="rsp-bg">${BACKGROUNDS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></div>
              <div class="rsp-row"><label><input type="checkbox" class="rsp-grid-on" ${S.grid.on ? "checked" : ""}> Grid</label><input type="number" class="rsp-grid-size" min="4" max="256" value="${S.grid.size}" title="Grid size (px)"><label><input type="checkbox" class="rsp-grid-snap"> Snap</label></div>
              <div class="rsp-row"><span>Symmetry</span><select class="rsp-symmetry"><option value="none">Off</option><option value="h">Mirror ↔</option><option value="v">Mirror ↕</option><option value="hv">Mirror both</option><option value="radial">Radial ×8</option></select></div>
            </section>
            <section class="rsp-sec rsp-send">
              <h4>Send to AI</h4>
              <div class="rsp-row"><span>What is it?</span><select class="rsp-intent">${INTENTS.map((i) => `<option value="${i.id}">${esc(i.label)}</option>`).join("")}</select></div>
              <div class="rsp-hint"></div>
              <textarea class="rsp-caption" rows="3" placeholder="Tell the AI what to do with it (optional): e.g. “this is a castle, make the towers 40 studs tall”"></textarea>
              <input type="text" class="rsp-scale" placeholder="Scale hint (optional): e.g. 1 grid cell = 4 studs, or canvas width = 200 studs">
              <div class="rsp-row rsp-opts">
                <label title="Attach the PNG to the message (if this site accepts images)"><input type="checkbox" class="rsp-attach" checked> Attach image</label>
                <label title="Include the exact vector description of every element"><input type="checkbox" class="rsp-trace" checked> Vector trace</label>
                <label title="After building, the AI takes a screenshot and compares it with your drawing"><input type="checkbox" class="rsp-selfcheck" checked> Self-check</label>
                <label title="The AI posts a plan and waits for your go"><input type="checkbox" class="rsp-plan"> Plan first</label>
              </div>
              <button type="button" class="rsp-send-btn">${ICONS.send}<span>Send to AI</span></button>
              <div class="rsp-send-status"></div>
              <details class="rsp-preview"><summary>Preview what the AI receives</summary><pre class="rsp-preview-text"></pre></details>
            </section>
          </div>
        </div>
      </div>
      <input type="file" class="rsp-file" accept="image/*" hidden>`;
    document.documentElement.appendChild(host);
    const q = (s) => host.querySelector(s);
    D = { host, view: q(".rsp-view"), stage: q(".rsp-stage"), status: q(".rsp-status"), params: q(".rsp-params"), layers: q(".rsp-layers"), layerOpacity: q(".rsp-layer-opacity"), layerOpacityVal: q(".rsp-layer-opacity-val"), sizeW: q(".rsp-size-w"), sizeH: q(".rsp-size-h"), preset: q(".rsp-preset"), bg: q(".rsp-bg"), gridOn: q(".rsp-grid-on"), gridSize: q(".rsp-grid-size"), gridSnap: q(".rsp-grid-snap"), symmetry: q(".rsp-symmetry"), intent: q(".rsp-intent"), hint: q(".rsp-hint"), caption: q(".rsp-caption"), scale: q(".rsp-scale"), attach: q(".rsp-attach"), trace: q(".rsp-trace"), selfCheck: q(".rsp-selfcheck"), plan: q(".rsp-plan"), sendBtn: q(".rsp-send-btn"), sendStatus: q(".rsp-send-status"), preview: q(".rsp-preview"), previewText: q(".rsp-preview-text"), file: q(".rsp-file"), colorInput: q(".rsp-color-input"), recent: q(".rsp-recent"), c1: q(".rsp-c1"), c2: q(".rsp-c2") };

    // events
    host.addEventListener("click", (e) => {
      const t = e.target.closest(".rsp-tool[data-tool]"); if (t) { setTool(t.dataset.tool); return; }
      const sw = e.target.closest(".rsp-sw"); if (sw) { setColor(sw.dataset.color); return; }
      const cur = e.target.closest(".rsp-current"); if (cur) { swapColors(); return; }
      const a = e.target.closest("[data-act]"); if (a) act(a.dataset.act);
    });
    host.addEventListener("contextmenu", (e) => { const sw = e.target.closest(".rsp-sw"); if (sw) { e.preventDefault(); S.color2 = sw.dataset.color; syncColors(); } else if (e.target === D.view) e.preventDefault(); });
    D.colorInput.addEventListener("input", () => setColor(D.colorInput.value));
    D.view.addEventListener("pointerdown", onDown); D.view.addEventListener("pointermove", onMove); D.view.addEventListener("pointerup", onUp); D.view.addEventListener("pointercancel", onUp);
    D.view.addEventListener("pointerleave", () => { S.cursor = null; invalidate(); });
    D.stage.addEventListener("wheel", (e) => { e.preventDefault(); const r = D.view.getBoundingClientRect(); if (e.ctrlKey || e.metaKey || !e.shiftKey) zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); else { S.pan.x -= e.deltaY; invalidate(); } }, { passive: false });
    D.layerOpacity.addEventListener("input", () => { const l = L(); if (l) { l.opacity = D.layerOpacity.value / 100; D.layerOpacityVal.textContent = D.layerOpacity.value + "%"; invalidate(); } });
    D.preset.addEventListener("change", () => { if (D.preset.value === "custom") return; const [w, h] = D.preset.value.split("x").map(Number); resizeCanvas(w, h); });
    D.bg.addEventListener("change", () => { S.bg = D.bg.value; invalidate(); });
    D.gridOn.addEventListener("change", () => { S.grid.on = D.gridOn.checked; invalidate(); });
    D.gridSize.addEventListener("change", () => { S.grid.size = clamp(Number(D.gridSize.value) || 32, 4, 256); invalidate(); });
    D.gridSnap.addEventListener("change", () => { S.grid.snap = D.gridSnap.checked; });
    D.symmetry.addEventListener("change", () => { S.symmetry = D.symmetry.value; });
    D.intent.addEventListener("change", () => { S.intent = D.intent.value; syncIntentHint(); });
    D.caption.addEventListener("input", () => { S.caption = D.caption.value; });
    D.scale.addEventListener("input", () => { S.scale = D.scale.value; });
    for (const k of ["attach", "trace", "selfCheck", "plan"]) D[k].addEventListener("change", () => { S[k === "plan" ? "planFirst" : k] = D[k].checked; });
    D.sendBtn.addEventListener("click", sendToAI);
    D.preview.addEventListener("toggle", () => { if (D.preview.open) D.previewText.textContent = buildMessage(); });
    D.file.addEventListener("change", async () => { const f = D.file.files && D.file.files[0]; D.file.value = ""; if (!f) return; try { placeImageLayer(await loadImageFile(f), f.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 24) || "Image", false); } catch { toast("Could not read that image"); } });
    // keep the host page's shortcuts out
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => { if (e.target.matches("input, textarea, select")) { if (e.key === "Escape") { e.target.blur(); } e.stopPropagation(); return; } });
    host.addEventListener("keydown", onKey);
    host.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; D.stage.classList.remove("rsp-panning"); } });
    host.addEventListener("paste", async (e) => { const it = [...(e.clipboardData && e.clipboardData.items || [])].find((i) => i.type.startsWith("image/")); if (!it) return; e.preventDefault(); try { const img = await loadImageFile(it.getAsFile()); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0); pasteClip(c); } catch {} });
    host.addEventListener("dragover", (e) => { e.preventDefault(); });
    host.addEventListener("drop", async (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) { try { placeImageLayer(await loadImageFile(f), f.name.slice(0, 24), false); } catch {} } });
    window.addEventListener("resize", () => { if (S.open) invalidate(); });
    host.tabIndex = -1;
    syncColors(); syncIntentHint(); renderParams(); syncButtons();
  }
  function onKey(e) {
    if (e.target.matches("input, textarea, select")) return;
    const k = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
    if (e.code === "Space" && !spaceDown) { spaceDown = true; D.stage.classList.add("rsp-panning"); e.preventDefault(); return; }
    if (k === "escape") { if (S.textInput) cancelTextInput(); else if (S.floating || S.selection) { commitFloating(); S.selection = null; invalidate(); } else close(); e.preventDefault(); return; }
    if (mod && k === "z" && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { redo(); e.preventDefault(); return; }
    if (mod && k === "s") { downloadPng(); e.preventDefault(); return; }
    if (mod && k === "c") { copySelection(false); e.preventDefault(); return; }
    if (mod && k === "x") { copySelection(true); e.preventDefault(); return; }
    if (mod && k === "v") { if (S.clip) { pasteClip(); e.preventDefault(); } return; }
    if (mod && k === "a") { commitFloating(); S.selection = { x: 0, y: 0, w: S.w, h: S.h }; setTool("select"); invalidate(); e.preventDefault(); return; }
    if (mod && k === "enter") { sendToAI(); e.preventDefault(); return; }
    if (mod) return;
    if (k === "delete" || k === "backspace") { deleteSelection(); e.preventDefault(); return; }
    if (k === "[") { setSize(S.size - (S.size > 20 ? 5 : 1)); return; } if (k === "]") { setSize(S.size + (S.size >= 20 ? 5 : 1)); return; }
    if (k === "+" || k === "=") { zoomAt(1.2); return; } if (k === "-") { zoomAt(1 / 1.2); return; } if (k === "0") { fitZoom(); return; }
    if (k === "x") { swapColors(); return; }
    const t = TOOLS.find((t) => t.key.toLowerCase() === k); if (t) { setTool(t.id); e.preventDefault(); }
  }
  function act(name) {
    const map = { undo, redo, fit: fitZoom, zoomIn: () => zoomAt(1.25), zoomOut: () => zoomAt(0.8), studio: importStudio, import: () => D.file.click(), save: downloadPng, copy: copyPng, close,
      clear: () => { if (confirm("Clear the whole canvas?")) clearAll(); }, layerAdd: () => addLayer(), layerDup: duplicateLayer, layerMerge: mergeDown, layerUp: () => moveLayer(1), layerDown: () => moveLayer(-1), layerDel: deleteLayer,
      flipH: () => flip("h"), flipV: () => flip("v"), applySize: () => resizeCanvas(Number(D.sizeW.value), Number(D.sizeH.value)) };
    if (map[name]) map[name]();
  }
  function setTool(id) { commitTextInput(); if (id !== "select") commitFloating(); if (S.tool !== id) S.lastTool = S.tool; S.tool = id; D.host.querySelectorAll(".rsp-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === id)); D.stage.dataset.tool = id; renderParams(); invalidate(); }
  function setColor(hex) { S.color = hex; if (!S.recent.includes(hex)) { S.recent.unshift(hex); S.recent.length = Math.min(S.recent.length, 10); } syncColors(); }
  function swapColors() { const t = S.color; S.color = S.color2; S.color2 = t; syncColors(); }
  function syncColors() { if (!D) return; D.c1.style.background = S.color; D.c2.style.background = S.color2; D.colorInput.value = /^#[0-9a-f]{6}$/i.test(S.color) ? S.color : "#000000"; D.host.querySelectorAll(".rsp-sw").forEach((b) => b.classList.toggle("on", b.dataset.color === S.color)); D.recent.innerHTML = S.recent.map((c) => `<button type="button" class="rsp-sw rsp-sw-sm" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join(""); }
  function setSize(v) { S.size = clamp(Math.round(v), 1, 200); renderParams(); invalidate(); }
  function syncButtons() { if (!D) return; const u = D.host.querySelector('[data-act="undo"]'), r = D.host.querySelector('[data-act="redo"]'); if (u) u.disabled = !S.history.length; if (r) r.disabled = !S.redo.length; }
  function syncIntentHint() { const i = INTENTS.find((x) => x.id === S.intent); D.hint.textContent = i ? i.hint : ""; }
  function syncParams() { renderParams(); }
  function renderParams() {
    if (!D) return; const t = S.tool; const P = [];
    const range = (key, label, min, max, suffix = "") => P.push(`<label class="rsp-p"><span>${label}</span><input type="range" data-p="${key}" min="${min}" max="${max}" value="${S[key]}"><b>${S[key]}${suffix}</b></label>`);
    const check = (key, label) => P.push(`<label class="rsp-p rsp-p-check"><input type="checkbox" data-p="${key}" ${S[key] ? "checked" : ""}><span>${label}</span></label>`);
    const select = (key, label, opts) => P.push(`<label class="rsp-p"><span>${label}</span><select data-p="${key}">${opts.map(([v, n]) => `<option value="${v}" ${S[key] === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>`);
    if (STROKE_TOOLS.has(t) || SHAPE_TOOLS.has(t)) range("size", t === "eraser" ? "Eraser size" : "Size", 1, 200, "px");
    if (t !== "eraser" && t !== "picker" && t !== "select" && t !== "hand") range("opacity", "Opacity", 1, 100, "%");
    if (t === "brush") range("hardness", "Hardness", 0, 100, "%");
    if (t === "spray") range("density", "Density", 5, 100);
    if (t === "fill") range("tolerance", "Tolerance", 0, 100, "%");
    if (t === "pencil" || t === "brush" || t === "marker") range("smoothing", "Smoothing", 0, 95, "%");
    if (STROKE_TOOLS.has(t) && t !== "spray") check("pressure", "Pen pressure");
    if (t === "text") { range("fontSize", "Font size", 8, 160, "px"); check("bold", "Bold"); }
    if (t === "rect" || t === "ellipse" || t === "triangle" || t === "star") select("shapeMode", "Style", [["stroke", "Outline"], ["fill", "Filled"], ["both", "Fill + outline"]]);
    if (t === "rect") range("cornerRadius", "Corner radius", 0, 120, "px");
    if (t === "arrow") range("arrowHead", "Arrow head", 1, 8, "×");
    if (SHAPE_TOOLS.has(t)) check("dash", "Dashed");
    if (t === "select") P.push(`<span class="rsp-p-note">Drag to select · drag inside to move · Del clears · Ctrl+C/X/V · Esc deselects</span>`);
    if (t === "hand") P.push(`<span class="rsp-p-note">Drag to pan · wheel zooms · 0 fits</span>`);
    if (t === "picker") P.push(`<span class="rsp-p-note">Left = primary · right = secondary</span>`);
    D.params.innerHTML = P.join("");
    D.params.querySelectorAll("[data-p]").forEach((el) => {
      const key = el.dataset.p; const apply = () => { if (el.type === "checkbox") S[key] = el.checked; else if (el.tagName === "SELECT") S[key] = el.value; else { S[key] = Number(el.value); const b = el.parentElement.querySelector("b"); if (b) b.textContent = el.value + (b.textContent.replace(/^[\d.-]+/, "")); } invalidate(); };
      el.addEventListener("input", apply); el.addEventListener("change", apply);
    });
  }

  // ───────────────────────── open / close ─────────────────────────
  function open(hooks) {
    S.hooks = hooks || S.hooks || {};
    if (!D) build();
    if (!S.layers.length) { S.layers = [makeLayer("Layer 1")]; S.active = 0; renderLayerList(); }
    S.open = true; D.host.classList.add("open"); document.documentElement.classList.add("rs-paint-open");
    const canImg = !!(S.hooks.canAttachImages && S.hooks.canAttachImages()); D.attach.disabled = !canImg; D.attach.checked = canImg && S.attach; S.attach = D.attach.checked; D.attach.parentElement.title = canImg ? "Attach the PNG to the message" : "This site cannot receive images — the vector trace carries the drawing";
    const eng = S.hooks.engine ? S.hooks.engine() : "roblox"; D.selfCheck.parentElement.hidden = eng === "local";
    const studioBtn = D.host.querySelector('[data-act="studio"]'); if (studioBtn) studioBtn.hidden = !S.hooks.captureStudio;
    setTool(S.tool); fitZoom(); setStatus(""); D.host.focus(); diag("open", { w: S.w, h: S.h, layers: S.layers.length, canImg });
  }
  function close() { if (!S.open) return; commitTextInput(); S.open = false; D.host.classList.remove("open"); document.documentElement.classList.remove("rs-paint-open"); diag("close", { prims: S.prims.length }); }
  function isOpen() { return S.open; }

  window.ORPaint = { open, close, isOpen, describe, buildMessage, exportImage, TOOLS, INTENTS, _state: S };
})();
