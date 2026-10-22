// ORscript — GUI Studio pack (1.48.0)
//
// The command side of the visual GUI builder (src/core/guistudio.js). One
// Luau "spec engine" turns a nested JSON tree - classes, UDim2 arrays, hex
// colours, modifiers (corner / stroke / gradient / padding / layout / aspect /
// text-fit) and behaviours (click → toggle / open / close / tween / sound /
// remote) - into a ScreenGui in ONE ChangeHistory step, and the inverse
// (ui_export_spec) reads any GUI back into the same spec so the builder can
// edit what the model (or the user) already made. Around that: alignment and
// distribution, anchor presets that keep the visual position, offset → scale
// conversion, a responsive fixer, text fitting, Z-order repair, token
// re-skinning, 20 ready-made components, tweens, state toggles, bulk edits
// and a GUI search.
//
// Patches RobloxScriptSkills after studio_gui.js / studio_design.js.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  if (RobloxScriptSkills.GUISTUDIO_VERSION) return;

  const GUISTUDIO_VERSION = "1.48.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
  const jj = (v) => q(JSON.stringify(v == null ? {} : v));

  // ───────────────────────── token presets ─────────────────────────
  // Same vocabulary as the builder's Theme tab. Colours are hex; the Luau side
  // resolves token NAMES used anywhere a colour is expected ("primary").
  const TOKEN_PRESETS = {
    midnight: { bg: "#0f1115", surface: "#171a21", surface2: "#1f2430", primary: "#4f7cff", accent: "#7c5cff", text: "#f2f4f8", muted: "#9aa3b2", danger: "#ff5c5c", success: "#2fbf72", font: "GothamMedium", title_font: "GothamBold", radius: 10, stroke: "#2a3140", stroke_t: 0.2 },
    clean_light: { bg: "#e9ecf3", surface: "#fafbfd", surface2: "#eceff5", primary: "#2f6bff", accent: "#0a9f80", text: "#16181d", muted: "#5f6676", danger: "#d9342b", success: "#1f8f5f", font: "GothamMedium", title_font: "GothamBold", radius: 12, stroke: "#d5dae4", stroke_t: 0 },
    candy: { bg: "#ffe4ef", surface: "#fff7fa", surface2: "#ffd9e8", primary: "#f0468f", accent: "#f59e1b", text: "#3a2230", muted: "#8a6677", danger: "#e63b5c", success: "#2db563", font: "FredokaOne", title_font: "FredokaOne", radius: 18, stroke: "#f7b8d0", stroke_t: 0 },
    neon: { bg: "#070812", surface: "#0e1020", surface2: "#151936", primary: "#00d4ee", accent: "#ff2bd6", text: "#eafdff", muted: "#8a95bd", danger: "#ff3366", success: "#2fe08a", font: "Jura", title_font: "Arcade", radius: 6, stroke: "#00d4ee", stroke_t: 0.55 },
    royal_gold: { bg: "#120d08", surface: "#1e150c", surface2: "#2a1d10", primary: "#d4a017", accent: "#f3d36b", text: "#fff3d6", muted: "#b39a6b", danger: "#c0392b", success: "#5fbf6f", font: "Garamond", title_font: "Antique", radius: 8, stroke: "#d4a017", stroke_t: 0.25 },
    forest: { bg: "#0d1a12", surface: "#15271c", surface2: "#1d3426", primary: "#4caf50", accent: "#c9a227", text: "#eef7ef", muted: "#8fa894", danger: "#d9534f", success: "#7bd389", font: "Merriweather", title_font: "Bangers", radius: 10, stroke: "#2f4f3a", stroke_t: 0.1 },
    horror: { bg: "#050505", surface: "#111111", surface2: "#1b1b1b", primary: "#a51212", accent: "#e53935", text: "#e2e2e2", muted: "#8d8d8d", danger: "#ff1744", success: "#6aa83a", font: "SpecialElite", title_font: "Creepster", radius: 2, stroke: "#4a0a0a", stroke_t: 0.1 },
    ocean: { bg: "#06212e", surface: "#0b3140", surface2: "#114257", primary: "#1fb6ff", accent: "#ffd166", text: "#eaf7ff", muted: "#86a9b8", danger: "#ff6b6b", success: "#2ed573", font: "GothamMedium", title_font: "GothamBlack", radius: 14, stroke: "#1fb6ff", stroke_t: 0.5 },
    sakura: { bg: "#ffe9ef", surface: "#fff8fa", surface2: "#ffdfe8", primary: "#e4457f", accent: "#a855b8", text: "#4a2a3a", muted: "#8e6a7a", danger: "#d9304a", success: "#3f9f47", font: "Nunito", title_font: "Nunito", radius: 16, stroke: "#f3b3c8", stroke_t: 0 },
    retro: { bg: "#1b1b2f", surface: "#24243e", surface2: "#2d2d4a", primary: "#ff9f1c", accent: "#2ec4b6", text: "#fdf6e3", muted: "#b3ae9f", danger: "#e71d36", success: "#5fd98a", font: "Sarpanch", title_font: "Arcade", radius: 0, stroke: "#ff9f1c", stroke_t: 0.45 },
  };
  const TOKEN_KEYS = ["bg", "surface", "surface2", "primary", "accent", "text", "muted", "danger", "success", "font", "title_font", "radius", "stroke", "stroke_t"];
  function tokensFor(a) {
    const base = Object.assign({}, TOKEN_PRESETS[String((a && (a.preset || a.theme)) || "midnight").toLowerCase()] || TOKEN_PRESETS.midnight);
    const t = a && a.tokens;
    if (t && typeof t === "object") for (const k of Object.keys(t)) if (t[k] != null && t[k] !== "") base[k] = t[k];
    return base;
  }

  // ───────────────────────── components (JS → spec) ─────────────────────────
  // Every component is an ordinary spec node, so ui_component and the builder's
  // palette share one Luau engine. `t` = tokens.
  const COMPONENT_KINDS = ["button", "icon_button", "toggle", "slider", "progress_bar", "window", "modal", "toast", "tabs", "dropdown", "tooltip", "badge", "currency_hud", "health_bar", "hotbar", "text_input", "checkbox", "card", "list", "grid", "divider", "avatar", "title", "stat_row"];
  function compNode(kind, a, t) {
    const name = a.name || kind.replace(/(^|_)(\w)/g, (m, s, c) => c.toUpperCase());
    const label = a.label != null ? String(a.label) : a.text != null ? String(a.text) : "";
    const size = Array.isArray(a.size) && a.size.length === 4 ? a.size : null;
    const pos = Array.isArray(a.position) && a.position.length === 4 ? a.position : null;
    const anchor = Array.isArray(a.anchor) && a.anchor.length === 2 ? a.anchor : null;
    const base = (n) => { if (size) n.size = size; if (pos) n.position = pos; if (anchor) n.anchor = anchor; if (a.z != null) n.z = a.z; return n; };
    const sub = (s) => s + "";
    const K = {
      button: () => base({ class: "TextButton", name, text: label || "Button", size: [0, 180, 0, 44], bg: "primary", text_color: "auto", font: "title_font", text_size: 18, corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, actions: [{ on: "hover", do: "hover_grow" }].concat(a.action ? [Object.assign({ on: "click" }, typeof a.action === "string" ? { do: a.action, target: a.target, remote: a.remote, message: a.message, effect: a.effect } : a.action)] : []) }),
      icon_button: () => base({ class: "ImageButton", name, size: [0, 40, 0, 40], bg: "surface2", image: a.image || "rbxassetid://6031094678", image_color: "text", corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 8, actions: [{ on: "hover", do: "hover_grow" }].concat(a.action ? [Object.assign({ on: "click" }, typeof a.action === "string" ? { do: a.action, target: a.target, remote: a.remote, message: a.message, effect: a.effect } : a.action)] : []) }),
      toggle: () => base({ class: "TextButton", name, text: "", size: [0, 56, 0, 30], bg: a.on ? "primary" : "surface2", corner: 15, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, attrs: { OR_Toggle: !!a.on }, actions: [{ on: "click", do: "switch" }], children: [{ class: "Frame", name: "Knob", size: [0, 24, 0, 24], position: a.on ? [1, -27, 0.5, 0] : [0, 3, 0.5, 0], anchor: [0, 0.5], bg: "#ffffff", corner: 12 }] }),
      slider: () => base({ class: "Frame", name, size: [0, 220, 0, 24], bg_t: 1, attrs: { OR_Slider: true, OR_Value: Number(a.value != null ? a.value : 0.5) }, actions: [{ on: "drag", do: "slider" }], children: [
        { class: "Frame", name: "Track", size: [1, 0, 0, 6], position: [0, 0, 0.5, 0], anchor: [0, 0.5], bg: "surface2", corner: 3, children: [{ class: "Frame", name: "Fill", size: [Number(a.value != null ? a.value : 0.5), 0, 1, 0], bg: "primary", corner: 3 }] },
        { class: "TextButton", name: "Knob", text: "", size: [0, 18, 0, 18], position: [Number(a.value != null ? a.value : 0.5), 0, 0.5, 0], anchor: [0.5, 0.5], bg: "#ffffff", corner: 9, stroke: { color: "primary", thickness: 2 } },
      ] }),
      progress_bar: () => base({ class: "Frame", name, size: [0, 240, 0, 18], bg: "surface2", corner: 9, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, attrs: { OR_Progress: Number(a.value != null ? a.value : 0.6) }, children: [
        { class: "Frame", name: "Fill", size: [Number(a.value != null ? a.value : 0.6), 0, 1, 0], bg: a.color || "success", corner: 9, gradient: { from: a.color || "success", to: "#ffffff", rotation: 0, transparency: [0, 0.35] } },
        { class: "TextLabel", name: "Label", text: label || Math.round(Number(a.value != null ? a.value : 0.6) * 100) + "%", size: [1, 0, 1, 0], bg_t: 1, text_color: "text", font: "title_font", text_size: 12 },
      ] }),
      window: () => base({ class: "Frame", name, size: [0, 420, 0, 300], position: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], bg: "surface", corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, actions: [{ on: "enable", do: "tween_in", effect: "pop" }], children: [
        { class: "Frame", name: "TitleBar", size: [1, 0, 0, 44], bg: "surface2", corner: "radius", children: [
          { class: "TextLabel", name: "Title", text: label || "Window", size: [1, -60, 1, 0], position: [0, 16, 0, 0], bg_t: 1, text_color: "text", font: "title_font", text_size: 18, align_x: "Left" },
          { class: "TextButton", name: "Close", text: "×", size: [0, 30, 0, 30], position: [1, -8, 0.5, 0], anchor: [1, 0.5], bg: "danger", text_color: "auto", font: "title_font", text_size: 20, corner: 8, actions: [{ on: "click", do: "close", target: "parent.parent" }, { on: "hover", do: "hover_grow" }] },
        ] },
        { class: "Frame", name: "Body", size: [1, -24, 1, -68], position: [0, 12, 0, 56], bg_t: 1, layout: { kind: "list", direction: "Vertical", gap: 8 } },
      ] }),
      modal: () => base({ class: "Frame", name, size: [1, 0, 1, 0], bg: "#000000", bg_t: 0.45, z: 50, children: [
        { class: "Frame", name: "Dialog", size: [0, 360, 0, 200], position: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], bg: "surface", corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 16, actions: [{ on: "enable", do: "tween_in", effect: "pop" }], children: [
          { class: "TextLabel", name: "Title", text: label || "Are you sure?", size: [1, 0, 0, 32], bg_t: 1, text_color: "text", font: "title_font", text_size: 20 },
          { class: "TextLabel", name: "Message", text: a.message || "This cannot be undone.", size: [1, 0, 0, 60], position: [0, 0, 0, 40], bg_t: 1, text_color: "muted", font: "font", text_size: 15, wrap: true },
          { class: "TextButton", name: "Cancel", text: a.cancel || "Cancel", size: [0.48, 0, 0, 40], position: [0, 0, 1, 0], anchor: [0, 1], bg: "surface2", text_color: "text", font: "title_font", text_size: 15, corner: 8, actions: [{ on: "click", do: "close", target: "parent.parent" }] },
          { class: "TextButton", name: "Confirm", text: a.confirm || "Confirm", size: [0.48, 0, 0, 40], position: [1, 0, 1, 0], anchor: [1, 1], bg: "primary", text_color: "auto", font: "title_font", text_size: 15, corner: 8, actions: [{ on: "click", do: a.remote ? "remote" : "close", target: "parent.parent", remote: a.remote }] },
        ] },
      ] }),
      toast: () => base({ class: "Frame", name, size: [0, 320, 0, 56], position: [0.5, 0, 1, -24], anchor: [0.5, 1], bg: "surface", corner: "radius", stroke: { color: "primary", thickness: 1, transparency: 0.3 }, padding: 12, actions: [{ on: "enable", do: "tween_in", effect: "slide_up" }, { on: "enable", do: "auto_hide", seconds: Number(a.seconds || 3) }], children: [
        { class: "Frame", name: "Bar", size: [0, 4, 1, 0], bg: "primary", corner: 2 },
        { class: "TextLabel", name: "Text", text: label || "Saved!", size: [1, -16, 1, 0], position: [0, 16, 0, 0], bg_t: 1, text_color: "text", font: "font", text_size: 15, align_x: "Left" },
      ] }),
      tabs: () => { const names = Array.isArray(a.tabs) && a.tabs.length ? a.tabs.map(String) : ["Shop", "Inventory", "Settings"]; return base({ class: "Frame", name, size: [0, 420, 0, 260], bg: "surface", corner: "radius", attrs: { OR_Tabs: true }, children: [
        { class: "Frame", name: "TabBar", size: [1, 0, 0, 40], bg: "surface2", corner: "radius", layout: { kind: "list", direction: "Horizontal", gap: 4 }, padding: 4, children: names.map((n, i) => ({ class: "TextButton", name: "Tab_" + n.replace(/\W+/g, ""), text: n, size: [1 / names.length, -4, 1, 0], bg: i === 0 ? "primary" : "surface2", text_color: i === 0 ? "#ffffff" : "muted", font: "title_font", text_size: 14, corner: 8, attrs: { OR_TabFor: "Page_" + n.replace(/\W+/g, "") }, actions: [{ on: "click", do: "tab" }] })) },
        { class: "Frame", name: "Pages", size: [1, 0, 1, -44], position: [0, 0, 0, 44], bg_t: 1, children: names.map((n, i) => ({ class: "Frame", name: "Page_" + n.replace(/\W+/g, ""), size: [1, 0, 1, 0], bg_t: 1, visible: i === 0, padding: 12, children: [{ class: "TextLabel", name: "Hint", text: n + " page", size: [1, 0, 0, 24], bg_t: 1, text_color: "muted", font: "font", text_size: 14 }] })) },
      ] }); },
      dropdown: () => { const opts = Array.isArray(a.options) && a.options.length ? a.options.map(String) : ["Option A", "Option B", "Option C"]; return base({ class: "Frame", name, size: [0, 200, 0, 40], bg_t: 1, z: 20, attrs: { OR_Dropdown: true }, children: [
        { class: "TextButton", name: "Current", text: opts[0], size: [1, 0, 1, 0], bg: "surface2", text_color: "text", font: "font", text_size: 15, corner: 8, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, actions: [{ on: "click", do: "toggle", target: "parent.Menu" }] },
        { class: "Frame", name: "Menu", size: [1, 0, 0, opts.length * 34 + 8], position: [0, 0, 1, 4], bg: "surface", corner: 8, visible: false, padding: 4, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, layout: { kind: "list", gap: 2 }, children: opts.map((o) => ({ class: "TextButton", name: "Opt_" + o.replace(/\W+/g, ""), text: o, size: [1, 0, 0, 32], bg: "surface", text_color: "text", font: "font", text_size: 14, corner: 6, actions: [{ on: "click", do: "pick_option" }, { on: "hover", do: "hover_tint" }] })) },
      ] }); },
      tooltip: () => base({ class: "TextLabel", name, text: label || "Tooltip", size: [0, 160, 0, 32], position: [0.5, 0, 0, -8], anchor: [0.5, 1], bg: "#000000", bg_t: 0.2, text_color: "auto", font: "font", text_size: 13, corner: 6, visible: false, z: 100, padding: 6, actions: [{ on: "parent_hover", do: "show_while_hover" }] }),
      badge: () => base({ class: "TextLabel", name, text: label || "NEW", size: [0, 44, 0, 20], position: [1, 6, 0, -6], anchor: [1, 0], bg: "danger", text_color: "auto", font: "title_font", text_size: 11, corner: 10, z: 5 }),
      currency_hud: () => base({ class: "Frame", name, size: [0, 170, 0, 40], position: [1, -16, 0, 16], anchor: [1, 0], bg: "surface", bg_t: 0.1, corner: 20, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 6, children: [
        { class: "ImageLabel", name: "Icon", size: [0, 28, 0, 28], position: [0, 2, 0.5, 0], anchor: [0, 0.5], bg_t: 1, image: a.image || "rbxassetid://6034973115", image_color: "accent" },
        { class: "TextLabel", name: "Amount", text: label || "1,250", size: [1, -60, 1, 0], position: [0, 36, 0, 0], bg_t: 1, text_color: "text", font: "title_font", text_size: 18, align_x: "Left", attrs: { OR_Stat: a.stat || "Coins" } },
        { class: "TextButton", name: "Plus", text: "+", size: [0, 26, 0, 26], position: [1, -2, 0.5, 0], anchor: [1, 0.5], bg: "success", text_color: "auto", font: "title_font", text_size: 18, corner: 13, actions: [{ on: "hover", do: "hover_grow" }] },
      ] }),
      health_bar: () => base({ class: "Frame", name, size: [0, 260, 0, 22], position: [0.5, 0, 1, -40], anchor: [0.5, 1], bg: "#000000", bg_t: 0.4, corner: 11, stroke: { color: "#ffffff", thickness: 1, transparency: 0.7 }, attrs: { OR_Health: true }, actions: [{ on: "enable", do: "bind_health" }], children: [
        { class: "Frame", name: "Fill", size: [1, -4, 1, -4], position: [0, 2, 0, 2], bg: a.color || "#3ddc84", corner: 9, gradient: { from: a.color || "#3ddc84", to: "#ffffff", rotation: 90, transparency: [0, 0.4] } },
        { class: "TextLabel", name: "Label", text: "100 / 100", size: [1, 0, 1, 0], bg_t: 1, text_color: "auto", font: "title_font", text_size: 12, stroke: { color: "#000000", thickness: 1, transparency: 0.4 } },
      ] }),
      hotbar: () => { const n = Math.max(1, Math.min(10, Number(a.slots || 6))); return base({ class: "Frame", name, size: [0, n * 56 + 8, 0, 64], position: [0.5, 0, 1, -16], anchor: [0.5, 1], bg: "surface", bg_t: 0.15, corner: 12, padding: 4, layout: { kind: "list", direction: "Horizontal", gap: 4, h_align: "Center", v_align: "Center" }, attrs: { OR_Hotbar: n }, children: Array.from({ length: n }, (_, i) => ({ class: "ImageButton", name: "Slot" + (i + 1), size: [0, 52, 0, 52], bg: "surface2", corner: 8, stroke: { color: i === 0 ? "primary" : "stroke", thickness: i === 0 ? 2 : 1, transparency: i === 0 ? 0 : "stroke_t" }, attrs: { OR_Slot: i + 1 }, actions: [{ on: "click", do: "select_slot" }], children: [{ class: "TextLabel", name: "Key", text: String((i + 1) % 10), size: [0, 14, 0, 14], position: [0, 4, 0, 2], bg_t: 1, text_color: "muted", font: "title_font", text_size: 11 }] })) }); },
      text_input: () => base({ class: "TextBox", name, text: "", placeholder: a.placeholder || label || "Type here…", size: [0, 240, 0, 40], bg: "surface2", text_color: "text", placeholder_color: "muted", font: "font", text_size: 15, corner: 8, padding: { left: 12, right: 12 }, align_x: "Left", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, props: { ClearTextOnFocus: false }, actions: [{ on: "focus", do: "focus_ring" }] }),
      checkbox: () => base({ class: "TextButton", name, text: "", size: [0, 200, 0, 28], bg_t: 1, attrs: { OR_Checked: !!a.on }, actions: [{ on: "click", do: "check" }], children: [
        { class: "Frame", name: "Box", size: [0, 22, 0, 22], position: [0, 0, 0.5, 0], anchor: [0, 0.5], bg: a.on ? "primary" : "surface2", corner: 6, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, children: [{ class: "TextLabel", name: "Tick", text: "✓", size: [1, 0, 1, 0], bg_t: 1, text_color: "auto", font: "title_font", text_size: 16, visible: !!a.on }] },
        { class: "TextLabel", name: "Label", text: label || "Enable music", size: [1, -32, 1, 0], position: [0, 32, 0, 0], bg_t: 1, text_color: "text", font: "font", text_size: 15, align_x: "Left" },
      ] }),
      card: () => base({ class: "Frame", name, size: [0, 180, 0, 220], bg: "surface", corner: "radius", stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: 10, actions: [{ on: "hover", do: "hover_grow" }], children: [
        { class: "ImageLabel", name: "Thumb", size: [1, 0, 0, 110], bg: "surface2", corner: 8, image: a.image || "", scale_type: "Crop" },
        { class: "TextLabel", name: "Title", text: label || "Item name", size: [1, 0, 0, 24], position: [0, 0, 0, 118], bg_t: 1, text_color: "text", font: "title_font", text_size: 16, align_x: "Left" },
        { class: "TextLabel", name: "Sub", text: a.subtitle || "Rare • Lv 3", size: [1, 0, 0, 18], position: [0, 0, 0, 142], bg_t: 1, text_color: "muted", font: "font", text_size: 13, align_x: "Left" },
        { class: "TextButton", name: "Action", text: a.cta || (a.price != null ? sub(a.price) + " R$" : "Buy"), size: [1, 0, 0, 34], position: [0, 0, 1, 0], anchor: [0, 1], bg: "primary", text_color: "auto", font: "title_font", text_size: 14, corner: 8, actions: [{ on: "click", do: a.remote ? "remote" : "print", remote: a.remote, message: "card clicked" }] },
      ] }),
      list: () => base({ class: "ScrollingFrame", name, size: [0, 260, 0, 300], bg: "surface", corner: "radius", padding: 8, layout: { kind: "list", gap: 6 }, scroll: { auto: "Y", thickness: 4 }, children: (Array.isArray(a.items) && a.items.length ? a.items.map(String) : ["First", "Second", "Third"]).map((it) => ({ class: "TextButton", name: "Row_" + it.replace(/\W+/g, ""), text: it, size: [1, 0, 0, 36], bg: "surface2", text_color: "text", font: "font", text_size: 14, corner: 8, align_x: "Left", padding: { left: 10 }, actions: [{ on: "hover", do: "hover_tint" }] })) }),
      grid: () => { const n = Math.max(1, Math.min(60, Number(a.slots || 12))); return base({ class: "ScrollingFrame", name, size: [0, 320, 0, 260], bg: "surface", corner: "radius", padding: 8, layout: { kind: "grid", cell: [0, 68, 0, 68], gap: 6 }, scroll: { auto: "Y", thickness: 4 }, children: Array.from({ length: n }, (_, i) => ({ class: "ImageButton", name: "Cell" + (i + 1), bg: "surface2", corner: 8, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, actions: [{ on: "hover", do: "hover_grow" }] })) }); },
      divider: () => base({ class: "Frame", name, size: [1, 0, 0, 1], bg: "stroke", bg_t: 0.2 }),
      avatar: () => base({ class: "ImageLabel", name, size: [0, 48, 0, 48], bg: "surface2", corner: 24, stroke: { color: "primary", thickness: 2 }, image: a.image || "", attrs: { OR_Avatar: true }, actions: [{ on: "enable", do: "bind_avatar" }] }),
      title: () => base({ class: "TextLabel", name, text: label || "Title", size: [0, 320, 0, 44], bg_t: 1, text_color: "text", font: "title_font", text_size: 28, stroke: { color: "#000000", thickness: 1, transparency: 0.6 } }),
      stat_row: () => base({ class: "Frame", name, size: [0, 240, 0, 32], bg: "surface2", corner: 8, padding: { left: 10, right: 10 }, children: [
        { class: "TextLabel", name: "Key", text: label || "Kills", size: [0.5, 0, 1, 0], bg_t: 1, text_color: "muted", font: "font", text_size: 14, align_x: "Left" },
        { class: "TextLabel", name: "Value", text: a.value != null ? String(a.value) : "0", size: [0.5, 0, 1, 0], position: [0.5, 0, 0, 0], bg_t: 1, text_color: "text", font: "title_font", text_size: 14, align_x: "Right", attrs: { OR_Stat: a.stat || label || "Kills" } },
      ] }),
    };
    const fn = K[kind];
    if (!fn) return null;
    const node = fn();
    if (a.tokens_inline === false) return node;
    return node;
  }

  // ───────────────────────── Luau prelude ─────────────────────────
  // Behaviour runtime: one LocalScript per ScreenGui that reads the bindings
  // list (StringValue JSON) so re-builds never pile up scripts.
  const BEHAVIOUR_SRC = `-- OR GUI Studio behaviours (data-driven; edit OR_UIBindings.Value, not this file)
local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local HttpService = game:GetService("HttpService")
local UserInputService = game:GetService("UserInputService")
local gui = script.Parent
local bindVal = gui:FindFirstChild("OR_UIBindings")
local okB, bindings = pcall(function() return HttpService:JSONDecode(bindVal and bindVal.Value or "[]") end)
if not okB or type(bindings) ~= "table" then bindings = {} end
local FAST = TweenInfo.new(0.16, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local POP = TweenInfo.new(0.28, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local function byPath(root, p)
	if p == nil or p == "" then return nil end
	if p == "self" then return root end
	local cur = root
	for seg in string.gmatch(tostring(p), "[^%.]+") do
		if seg == "parent" then cur = cur.Parent
		elseif seg == "gui" then cur = gui
		else cur = cur and cur:FindFirstChild(seg, false) or (gui:FindFirstChild(seg, true)) end
		if not cur then return nil end
	end
	return cur
end
local function scaleOf(o)
	local s = o:FindFirstChildOfClass("UIScale")
	if not s then s = Instance.new("UIScale") s.Parent = o end
	return s
end
local function show(o, effect)
	if not o then return end
	o.Visible = true
	if effect == "pop" or effect == nil then
		local s = scaleOf(o) s.Scale = 0.85 TweenService:Create(s, POP, { Scale = 1 }):Play()
	elseif effect == "slide_up" then
		local target = o.Position o.Position = target + UDim2.new(0, 0, 0, 40)
		TweenService:Create(o, POP, { Position = target }):Play()
	elseif effect == "fade" and o:IsA("CanvasGroup") then
		o.GroupTransparency = 1 TweenService:Create(o, FAST, { GroupTransparency = 0 }):Play()
	end
end
local function hide(o)
	if not o then return end
	local s = o:FindFirstChildOfClass("UIScale")
	if s then
		local tw = TweenService:Create(s, FAST, { Scale = 0.9 }) tw:Play() tw.Completed:Wait() s.Scale = 1
	end
	o.Visible = false
end
local function setTab(btn)
	local host = btn:FindFirstAncestorWhichIsA("GuiObject")
	while host and not host:GetAttribute("OR_Tabs") do host = host:FindFirstAncestorWhichIsA("GuiObject") end
	if not host then return end
	local pages = host:FindFirstChild("Pages", true)
	for _, b in ipairs(btn.Parent:GetChildren()) do
		if b:IsA("TextButton") then
			local on = b == btn
			TweenService:Create(b, FAST, { BackgroundColor3 = on and (gui:GetAttribute("OR_Primary") or Color3.fromRGB(79, 124, 255)) or (gui:GetAttribute("OR_Surface2") or Color3.fromRGB(31, 36, 48)) }):Play()
			b.TextColor3 = on and Color3.new(1, 1, 1) or (gui:GetAttribute("OR_Muted") or Color3.fromRGB(154, 163, 178))
			local page = pages and pages:FindFirstChild(tostring(b:GetAttribute("OR_TabFor") or ""))
			if page then page.Visible = on end
		end
	end
end
local function remoteFor(name)
	local folder = ReplicatedStorage:FindFirstChild("OR_UIEvents")
	if not folder then folder = Instance.new("Folder") folder.Name = "OR_UIEvents" folder.Parent = ReplicatedStorage end
	local ev = folder:FindFirstChild(name)
	if not ev then ev = Instance.new("RemoteEvent") ev.Name = name ev.Parent = folder end
	return ev
end
local function run(root, b)
	local act = b["do"]
	local target = byPath(root, b.target or "self") or root
	if act == "toggle" then if target.Visible then hide(target) else show(target, b.effect) end
	elseif act == "open" or act == "show" then show(target, b.effect)
	elseif act == "close" or act == "hide" then hide(target)
	elseif act == "destroy" then target:Destroy()
	elseif act == "print" then print(tostring(b.message or (root.Name .. " clicked")))
	elseif act == "sound" then
		local s = Instance.new("Sound") s.SoundId = tostring(b.sound or "rbxassetid://6895079853") s.Volume = tonumber(b.volume) or 0.5 s.Parent = root s:Play()
		s.Ended:Connect(function() s:Destroy() end)
	elseif act == "remote" then
		local ev = remoteFor(tostring(b.remote or root.Name)) ev:FireServer(b.payload)
	elseif act == "switch" then
		local on = not root:GetAttribute("OR_Toggle") root:SetAttribute("OR_Toggle", on)
		local knob = root:FindFirstChild("Knob")
		TweenService:Create(root, FAST, { BackgroundColor3 = on and gui:GetAttribute("OR_Primary") or gui:GetAttribute("OR_Surface2") }):Play()
		if knob then TweenService:Create(knob, FAST, { Position = on and UDim2.new(1, -27, 0.5, 0) or UDim2.new(0, 3, 0.5, 0) }):Play() end
		if b.remote then remoteFor(tostring(b.remote)):FireServer(on) end
	elseif act == "check" then
		local on = not root:GetAttribute("OR_Checked") root:SetAttribute("OR_Checked", on)
		local box = root:FindFirstChild("Box") local tick = box and box:FindFirstChild("Tick")
		if box then TweenService:Create(box, FAST, { BackgroundColor3 = on and gui:GetAttribute("OR_Primary") or gui:GetAttribute("OR_Surface2") }):Play() end
		if tick then tick.Visible = on end
	elseif act == "tab" then setTab(root)
	elseif act == "pick_option" then
		local menu = root.Parent local dd = menu and menu.Parent
		local cur = dd and dd:FindFirstChild("Current")
		if cur then cur.Text = root.Text end
		if menu then menu.Visible = false end
		if dd then dd:SetAttribute("OR_Value", root.Text) end
	elseif act == "select_slot" then
		local bar = root.Parent
		for _, s in ipairs(bar:GetChildren()) do
			local st = s:FindFirstChildOfClass("UIStroke")
			if st then st.Thickness = (s == root) and 2 or 1 st.Transparency = (s == root) and 0 or 0.4 st.Color = (s == root) and gui:GetAttribute("OR_Primary") or gui:GetAttribute("OR_Stroke") end
		end
		bar:SetAttribute("OR_Selected", root:GetAttribute("OR_Slot"))
	end
end
for _, b in ipairs(bindings) do
	local root = gui
	local last = nil
	for seg in string.gmatch(tostring(b.path or ""), "[^%.]+") do root = root and root:FindFirstChild(seg) last = seg end
	if not root and last then root = gui:FindFirstChild(last, true) end
	if root then
		local on = b.on or "click"
		if on == "click" and root:IsA("GuiButton") then root.Activated:Connect(function() run(root, b) end)
		elseif on == "hover" and b["do"] == "hover_grow" then
			root.MouseEnter:Connect(function() TweenService:Create(scaleOf(root), FAST, { Scale = tonumber(b.scale) or 1.05 }):Play() end)
			root.MouseLeave:Connect(function() TweenService:Create(scaleOf(root), FAST, { Scale = 1 }):Play() end)
		elseif on == "hover" and b["do"] == "hover_tint" then
			local base = root.BackgroundColor3
			root.MouseEnter:Connect(function() TweenService:Create(root, FAST, { BackgroundColor3 = base:Lerp(Color3.new(1, 1, 1), 0.08) }):Play() end)
			root.MouseLeave:Connect(function() TweenService:Create(root, FAST, { BackgroundColor3 = base }):Play() end)
		elseif on == "hover" then
			root.MouseEnter:Connect(function() run(root, b) end)
		elseif on == "enable" and b["do"] == "tween_in" then
			if root.Visible then show(root, b.effect) end
			root:GetPropertyChangedSignal("Visible"):Connect(function() if root.Visible then show(root, b.effect) end end)
		elseif on == "enable" and b["do"] == "auto_hide" then
			task.delay(tonumber(b.seconds) or 3, function() if root.Parent then hide(root) end end)
		elseif on == "enable" and b["do"] == "pulse" then
			local s = scaleOf(root)
			TweenService:Create(s, TweenInfo.new(tonumber(b.seconds) or 0.8, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Scale = tonumber(b.scale) or 1.06 }):Play()
		elseif on == "enable" and b["do"] == "bind_health" then
			task.spawn(function()
				local plr = Players.LocalPlayer
				local fill = root:FindFirstChild("Fill") local label = root:FindFirstChild("Label")
				local function hook(char)
					local hum = char:WaitForChild("Humanoid", 10) if not hum then return end
					local function upd()
						local f = math.clamp(hum.Health / math.max(1, hum.MaxHealth), 0, 1)
						if fill then TweenService:Create(fill, FAST, { Size = UDim2.new(f, -4, 1, -4) }):Play() end
						if label then label.Text = string.format("%d / %d", math.floor(hum.Health + 0.5), math.floor(hum.MaxHealth + 0.5)) end
					end
					hum.HealthChanged:Connect(upd) upd()
				end
				if plr.Character then hook(plr.Character) end
				plr.CharacterAdded:Connect(hook)
			end)
		elseif on == "enable" and b["do"] == "bind_avatar" then
			task.spawn(function()
				local plr = Players.LocalPlayer
				local okT, img = pcall(function() return Players:GetUserThumbnailAsync(plr.UserId, Enum.ThumbnailType.HeadShot, Enum.ThumbnailSize.Size100x100) end)
				if okT and root:IsA("ImageLabel") then root.Image = img end
			end)
		elseif on == "enable" then
			run(root, b)
		elseif on == "focus" and root:IsA("TextBox") then
			local st = root:FindFirstChildOfClass("UIStroke")
			root.Focused:Connect(function() if st then TweenService:Create(st, FAST, { Color = gui:GetAttribute("OR_Primary"), Transparency = 0 }):Play() end end)
			root.FocusLost:Connect(function() if st then TweenService:Create(st, FAST, { Color = gui:GetAttribute("OR_Stroke"), Transparency = 0.2 }):Play() end end)
		elseif on == "parent_hover" then
			local host = root.Parent
			if host and host:IsA("GuiObject") then
				host.MouseEnter:Connect(function() root.Visible = true end)
				host.MouseLeave:Connect(function() root.Visible = false end)
			end
		elseif on == "drag" and b["do"] == "slider" then
			local knob = root:FindFirstChild("Knob") local track = root:FindFirstChild("Track") local fill = track and track:FindFirstChild("Fill")
			local dragging = false
			local function setFrom(x)
				local f = math.clamp((x - root.AbsolutePosition.X) / math.max(1, root.AbsoluteSize.X), 0, 1)
				root:SetAttribute("OR_Value", f)
				if knob then knob.Position = UDim2.new(f, 0, 0.5, 0) end
				if fill then fill.Size = UDim2.new(f, 0, 1, 0) end
			end
			if knob then
				knob.MouseButton1Down:Connect(function() dragging = true end)
				UserInputService.InputEnded:Connect(function(i) if i.UserInputType == Enum.UserInputType.MouseButton1 or i.UserInputType == Enum.UserInputType.Touch then dragging = false end end)
				UserInputService.InputChanged:Connect(function(i) if dragging and (i.UserInputType == Enum.UserInputType.MouseMovement or i.UserInputType == Enum.UserInputType.Touch) then setFrom(i.Position.X) end end)
			end
			if track then track.InputBegan:Connect(function(i) if i.UserInputType == Enum.UserInputType.MouseButton1 or i.UserInputType == Enum.UserInputType.Touch then setFrom(i.Position.X) end end) end
		end
	end
end
`;

  const HEAD = `local HttpService=game:GetService('HttpService')
local StarterGui=game:GetService('StarterGui')
local ChangeHistoryService=game:GetService('ChangeHistoryService')
local GUISTUDIO_VERSION=${q(GUISTUDIO_VERSION)}
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.',''):gsub('^SG%.','StarterGui.') local lp=p:lower() if lp=='game' then return game end if lp=='startergui' or lp=='sg' then return StarterGui end local cur=game for seg in string.gmatch(p,'[^%.]+') do local nxt=cur:FindFirstChild(seg) if not nxt and cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS then nxt=svc end end if not nxt and cur==game then nxt=StarterGui:FindFirstChild(seg) end if not nxt then return nil end cur=nxt end return cur end
local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end
local function wp(label) local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording(label or 'ORscript GUI') end) return okW and w or nil end
local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end
local function short(i) local okN,n=pcall(function() return i:GetFullName() end) n=okN and n or tostring(i) return (n:gsub('^StarterGui%.','SG.')) end
local function getp(i,k) local okP,v=pcall(function() return i[k] end) if okP then return v end return nil end
local function setp(i,k,v) return pcall(function() i[k]=v end) end
local function en(v) if v==nil then return nil end local okE,nm=pcall(function() return v.Name end) if okE and nm~=nil then return tostring(nm) end return nil end
local function hexToC3(h) h=tostring(h or ''):gsub('#','') if #h==3 then h=h:sub(1,1):rep(2)..h:sub(2,2):rep(2)..h:sub(3,3):rep(2) end if #h<6 then return nil end local r,g,b=tonumber(h:sub(1,2),16),tonumber(h:sub(3,4),16),tonumber(h:sub(5,6),16) if not (r and g and b) then return nil end return Color3.fromRGB(r,g,b) end
local function c3hex(c) if typeof(c)~='Color3' then return nil end return string.format('#%02x%02x%02x',math.floor(c.R*255+0.5),math.floor(c.G*255+0.5),math.floor(c.B*255+0.5)) end
local TOKENS={}
local function tokenv(k) local v=TOKENS[tostring(k)] return v end
local function color(v,d) if v==nil then return d end if typeof(v)=='Color3' then return v end if type(v)=='table' then if v.r or v.R then return Color3.fromRGB(tonumber(v.r or v.R) or 0,tonumber(v.g or v.G) or 0,tonumber(v.b or v.B) or 0) end if #v>=3 then local a,b,c=tonumber(v[1]) or 0,tonumber(v[2]) or 0,tonumber(v[3]) or 0 if a<=1 and b<=1 and c<=1 and (a+b+c)>0 and (a%1~=0 or b%1~=0 or c%1~=0) then return Color3.new(a,b,c) end return Color3.fromRGB(a,b,c) end end local s=tostring(v) if s:sub(1,1)=='#' then return hexToC3(s) or d end local t=tokenv(s) if t~=nil then if type(t)=='string' and t:sub(1,1)=='#' then return hexToC3(t) or d end return color(t,d) end if #s==6 and tonumber(s,16) then return hexToC3('#'..s) or d end return d end
local function num(v,d) if v==nil then return d end if type(v)=='number' then return v end local t=tokenv(tostring(v)) if type(t)=='number' then return t end return tonumber(v) or d end
local function str(v,d) if v==nil then return d end local s=tostring(v) local t=tokenv(s) if type(t)=='string' then return t end return s end
local function u2(v,d) if type(v)=='table' and #v>=4 then return UDim2.new(tonumber(v[1]) or 0,tonumber(v[2]) or 0,tonumber(v[3]) or 0,tonumber(v[4]) or 0) end if type(v)=='table' and #v==2 then return UDim2.new(0,tonumber(v[1]) or 0,0,tonumber(v[2]) or 0) end return d end
local function lumC(c) return 0.2126*c.R+0.7152*c.G+0.0722*c.B end
local function fillBehind(inst,parent) local c=inst while c and c:IsA('GuiObject') do if c.BackgroundTransparency<0.6 then local g=c:FindFirstChildOfClass('UIGradient') if g then local ks=g.Color.Keypoints return ks[1].Value:Lerp(ks[#ks].Value,0.5) end return c.BackgroundColor3 end c=(c==inst and parent) or c.Parent end return nil end
local function linC(c) local function ch(v) if v<=0.03928 then return v/12.92 end return ((v+0.055)/1.055)^2.4 end return 0.2126*ch(c.R)+0.7152*ch(c.G)+0.0722*ch(c.B) end
local function crC(a,b) local la,lb=linC(a),linC(b) local hi,lo=math.max(la,lb),math.min(la,lb) return (hi+0.05)/(lo+0.05) end
local function autoText(inst,parent) local bg=fillBehind(inst,parent) local tx=color('text',Color3.new(0.95,0.96,0.97)) local white,dark=Color3.new(1,1,1),Color3.fromRGB(21,23,28) if bg==nil then if linC(tx)>=0.4 then return tx end return white end if crC(white,bg)>=3 then if linC(tx)>=0.5 and crC(tx,bg)>=3 then return tx end return white end if linC(tx)<0.3 and crC(tx,bg)>=4 then return tx end return dark end
local function fontOf(name) local n=str(name,'GothamMedium') local okF,f=pcall(function() return Enum.Font[n] end) if okF and f then return f end return Enum.Font.GothamMedium end
local function enumOf(kind,v,d) if v==nil then return d end local s=tostring(v):gsub('^Enum%.[%w_]+%.','') local okE,e=pcall(function() return Enum[kind][s] end) if okE and e then return e end return d end
local function modChild(inst,cls) local c=inst:FindFirstChildOfClass(cls) if not c then c=Instance.new(cls) c.Parent=inst end return c end
local function udimArr(u) return {u.X.Scale,u.X.Offset,u.Y.Scale,u.Y.Offset} end
local function viewport() local okV,cam=pcall(function() return workspace.CurrentCamera end) if okV and cam and cam.ViewportSize and cam.ViewportSize.X>0 then return cam.ViewportSize end return Vector2.new(1920,1080) end
local function absSize(o) local okA,v=pcall(function() return o.AbsoluteSize end) if okA and v and (v.X>0 or v.Y>0) then return v end return nil end
local function parentSize(o) local p=o.Parent if p and p:IsA('GuiObject') then return absSize(p) or viewport() end return viewport() end
local function absPos(o) local okA,v=pcall(function() return o.AbsolutePosition end) if okA and v then return v end return Vector2.new(0,0) end
local GUI_CLASSES={Frame=true,TextLabel=true,TextButton=true,TextBox=true,ImageLabel=true,ImageButton=true,ScrollingFrame=true,CanvasGroup=true,ViewportFrame=true,VideoFrame=true}
local BEHAVIOUR_SRC=${q(BEHAVIOUR_SRC)}
local BIND={}
local function applyNode(n,parent,created,pathPrefix)
 if type(n)~='table' then return nil end
 local cls=tostring(n.class or n.class_name or 'Frame') if not GUI_CLASSES[cls] then cls='Frame' end
 local inst=Instance.new(cls)
 inst.Name=tostring(n.name or cls)
 inst.Size=u2(n.size,UDim2.new(0,200,0,50)) inst.Position=u2(n.position,UDim2.new(0,0,0,0))
 if type(n.anchor)=='table' then inst.AnchorPoint=Vector2.new(tonumber(n.anchor[1]) or 0,tonumber(n.anchor[2]) or 0) end
 if n.z~=nil then inst.ZIndex=math.floor(num(n.z,1)) end
 if n.visible==false then inst.Visible=false end
 inst.BorderSizePixel=0
 local bg=n.bg if bg==nil then bg=n.background end
 if bg~=nil then inst.BackgroundColor3=color(bg,inst.BackgroundColor3) end
 local bt=n.bg_t if bt==nil then bt=n.background_transparency end
 if bt~=nil then inst.BackgroundTransparency=num(bt,0) elseif bg==nil and (cls=='TextLabel' or cls=='ImageLabel') then inst.BackgroundTransparency=1 end
 if n.rotation then inst.Rotation=num(n.rotation,0) end
 if n.clips~=nil then inst.ClipsDescendants=n.clips and true or false end
 if n.hug or n.automatic_size then setp(inst,'AutomaticSize',enumOf('AutomaticSize',n.automatic_size or 'XY',Enum.AutomaticSize.XY)) end
 if inst:IsA('TextLabel') or inst:IsA('TextButton') or inst:IsA('TextBox') then
  inst.Text=tostring(n.text~=nil and n.text or (cls=='TextBox' and '' or inst.Name))
  inst.Font=fontOf(n.font or 'font')
  if n.text_color=='auto' then inst.TextColor3=autoText(inst,parent) else inst.TextColor3=color(n.text_color or 'text',Color3.new(1,1,1)) end
  if n.text_size then inst.TextSize=num(n.text_size,14) inst.TextScaled=false else inst.TextScaled=(n.text_scaled~=false) end
  if n.text_scaled==true then inst.TextScaled=true end
  if n.text_t then inst.TextTransparency=num(n.text_t,0) end
  if n.text_fit then local c=modChild(inst,'UITextSizeConstraint') c.MinTextSize=num(type(n.text_fit)=='table' and n.text_fit.min or 10,10) c.MaxTextSize=num(type(n.text_fit)=='table' and n.text_fit.max or (n.text_size or 28),28) inst.TextScaled=true end
  inst.TextXAlignment=enumOf('TextXAlignment',n.align_x,Enum.TextXAlignment.Center) inst.TextYAlignment=enumOf('TextYAlignment',n.align_y,Enum.TextYAlignment.Center)
  if n.wrap~=nil then inst.TextWrapped=n.wrap and true or false end
  if n.rich then inst.RichText=true end
  if n.text_stroke then inst.TextStrokeTransparency=num(type(n.text_stroke)=='table' and n.text_stroke.transparency or 0.5,0.5) inst.TextStrokeColor3=color(type(n.text_stroke)=='table' and n.text_stroke.color or '#000000',Color3.new()) end
  if cls=='TextBox' then if n.placeholder then inst.PlaceholderText=tostring(n.placeholder) end if n.placeholder_color then inst.PlaceholderColor3=color(n.placeholder_color,inst.PlaceholderColor3) end if n.multiline then inst.MultiLine=true inst.TextYAlignment=Enum.TextYAlignment.Top end end
 end
 if inst:IsA('ImageLabel') or inst:IsA('ImageButton') then
  local img=n.image or n.texture if img~=nil and tostring(img)~='' then local s=tostring(img) if tonumber(s) then s='rbxassetid://'..s end inst.Image=s end
  if n.image_color then inst.ImageColor3=color(n.image_color,Color3.new(1,1,1)) end
  if n.image_t then inst.ImageTransparency=num(n.image_t,0) end
  if n.scale_type then inst.ScaleType=enumOf('ScaleType',n.scale_type,Enum.ScaleType.Stretch) end
  if type(n.slice)=='table' and #n.slice>=4 then inst.ScaleType=Enum.ScaleType.Slice inst.SliceCenter=Rect.new(tonumber(n.slice[1]) or 0,tonumber(n.slice[2]) or 0,tonumber(n.slice[3]) or 0,tonumber(n.slice[4]) or 0) if n.slice_scale then inst.SliceScale=num(n.slice_scale,1) end end
 end
 if cls=='ScrollingFrame' then local sc=type(n.scroll)=='table' and n.scroll or {} inst.ScrollBarThickness=num(sc.thickness,6) inst.ScrollBarImageColor3=color(sc.color or 'muted',Color3.fromRGB(160,160,160)) if sc.auto then setp(inst,'AutomaticCanvasSize',enumOf('AutomaticSize',sc.auto,Enum.AutomaticSize.Y)) inst.CanvasSize=UDim2.new(0,0,0,0) elseif sc.canvas then inst.CanvasSize=u2(sc.canvas,UDim2.new(0,0,2,0)) else setp(inst,'AutomaticCanvasSize',Enum.AutomaticSize.Y) inst.CanvasSize=UDim2.new(0,0,0,0) end setp(inst,'ScrollingDirection',enumOf('ScrollingDirection',sc.direction,Enum.ScrollingDirection.Y)) end
 if cls=='CanvasGroup' and n.group_t then inst.GroupTransparency=num(n.group_t,0) end
 if type(n.attrs)=='table' then for k,v in pairs(n.attrs) do pcall(function() inst:SetAttribute(tostring(k),v) end) end end
 if type(n.props)=='table' then for k,v in pairs(n.props) do local key=tostring(k) if type(v)=='table' and #v==4 then setp(inst,key,u2(v)) elseif type(v)=='table' and #v==3 then setp(inst,key,color(v)) elseif type(v)=='string' and v:sub(1,5)=='Enum.' then local parts=string.split(v,'.') pcall(function() inst[key]=Enum[parts[2]][parts[3]] end) elseif type(v)=='string' and v:sub(1,1)=='#' and #v==7 then setp(inst,key,hexToC3(v)) else setp(inst,key,v) end end end
 inst.Parent=parent
 if n.corner~=nil then local c=modChild(inst,'UICorner') local r=n.corner if type(r)=='table' then c.CornerRadius=UDim.new(num(r.scale,0),num(r.offset,8)) else c.CornerRadius=UDim.new(0,num(r,8)) end end
 if n.stroke~=nil then local s=modChild(inst,'UIStroke') local st=type(n.stroke)=='table' and n.stroke or {color=n.stroke} s.Color=color(st.color or 'stroke',Color3.new(1,1,1)) s.Thickness=num(st.thickness,1) s.Transparency=num(st.transparency,0) s.ApplyStrokeMode=enumOf('ApplyStrokeMode',st.mode,Enum.ApplyStrokeMode.Border) if st.line_join then setp(s,'LineJoinMode',enumOf('LineJoinMode',st.line_join,Enum.LineJoinMode.Round)) end end
 if type(n.gradient)=='table' then local g=modChild(inst,'UIGradient') local a=color(n.gradient.from or n.gradient[1] or 'primary',Color3.new(1,1,1)) local b=color(n.gradient.to or n.gradient[2] or 'accent',Color3.new(0,0,0)) local stops={ColorSequenceKeypoint.new(0,a)} if type(n.gradient.mid)~='nil' then stops[#stops+1]=ColorSequenceKeypoint.new(0.5,color(n.gradient.mid,a)) end stops[#stops+1]=ColorSequenceKeypoint.new(1,b) g.Color=ColorSequence.new(stops) g.Rotation=num(n.gradient.rotation,90) if type(n.gradient.transparency)=='table' then g.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,num(n.gradient.transparency[1],0)),NumberSequenceKeypoint.new(1,num(n.gradient.transparency[2],0))}) end end
 if n.padding~=nil then local p=modChild(inst,'UIPadding') if type(n.padding)=='table' then local pd=n.padding p.PaddingLeft=UDim.new(0,num(pd.left or pd.l or pd.x,0)) p.PaddingRight=UDim.new(0,num(pd.right or pd.r or pd.x,0)) p.PaddingTop=UDim.new(0,num(pd.top or pd.t or pd.y,0)) p.PaddingBottom=UDim.new(0,num(pd.bottom or pd.b or pd.y,0)) else local v=num(n.padding,8) p.PaddingLeft=UDim.new(0,v) p.PaddingRight=UDim.new(0,v) p.PaddingTop=UDim.new(0,v) p.PaddingBottom=UDim.new(0,v) end end
 if type(n.layout)=='table' or type(n.layout)=='string' then local ly=type(n.layout)=='table' and n.layout or {kind=n.layout} local kind=tostring(ly.kind or ly.type or 'list'):lower() local lay if kind=='grid' then lay=modChild(inst,'UIGridLayout') lay.CellSize=u2(ly.cell or ly.cell_size,UDim2.new(0,80,0,80)) lay.CellPadding=u2(ly.cell_padding or (ly.gap and {0,ly.gap,0,ly.gap}) or nil,UDim2.new(0,6,0,6)) elseif kind=='page' then lay=modChild(inst,'UIPageLayout') else lay=modChild(inst,'UIListLayout') lay.Padding=UDim.new(0,num(ly.gap or ly.padding,8)) if ly.wraps~=nil then setp(lay,'Wraps',ly.wraps and true or false) end end lay.FillDirection=enumOf('FillDirection',ly.direction,kind=='grid' and Enum.FillDirection.Horizontal or Enum.FillDirection.Vertical) lay.HorizontalAlignment=enumOf('HorizontalAlignment',ly.h_align,Enum.HorizontalAlignment.Left) lay.VerticalAlignment=enumOf('VerticalAlignment',ly.v_align,Enum.VerticalAlignment.Top) lay.SortOrder=enumOf('SortOrder',ly.sort,Enum.SortOrder.LayoutOrder) end
 if n.aspect then local c=modChild(inst,'UIAspectRatioConstraint') c.AspectRatio=num(n.aspect,1) c.DominantAxis=enumOf('DominantAxis',n.aspect_axis,Enum.DominantAxis.Width) end
 if type(n.min_size)=='table' or type(n.max_size)=='table' then local c=modChild(inst,'UISizeConstraint') if type(n.min_size)=='table' then c.MinSize=Vector2.new(tonumber(n.min_size[1]) or 0,tonumber(n.min_size[2]) or 0) end if type(n.max_size)=='table' then c.MaxSize=Vector2.new(tonumber(n.max_size[1]) or math.huge,tonumber(n.max_size[2]) or math.huge) end end
 if n.scale then modChild(inst,'UIScale').Scale=num(n.scale,1) end
 if n.layout_order then inst.LayoutOrder=math.floor(num(n.layout_order,0)) end
 local myPath=(pathPrefix and pathPrefix~='' and (pathPrefix..'.') or '')..inst.Name
 created[#created+1]=short(inst)
 if type(n.actions)=='table' then for _,act in ipairs(n.actions) do if type(act)=='table' then local b={} for k,v in pairs(act) do b[k]=v end b.path=myPath BIND[#BIND+1]=b end end end
 if type(n.children)=='table' then for i,ch in ipairs(n.children) do if type(ch)=='table' and ch.layout_order==nil and (type(n.layout)=='table' or type(n.layout)=='string') then ch.layout_order=i end applyNode(ch,inst,created,myPath) end end
 return inst
end
local function installBehaviours(sg)
 for k,v in pairs(TOKENS) do if type(v)=='string' and v:sub(1,1)=='#' then local c=hexToC3(v) if c then pcall(function() sg:SetAttribute('OR_'..k:sub(1,1):upper()..k:sub(2),c) end) end end end
 local old=sg:FindFirstChild('OR_UIBindings') local list={} if old then local okJ,prev=pcall(function() return HttpService:JSONDecode(old.Value) end) if okJ and type(prev)=='table' then list=prev end end
 for _,b in ipairs(BIND) do list[#list+1]=b end
 if #list==0 then return 0 end
 local sv=old or Instance.new('StringValue') sv.Name='OR_UIBindings' sv.Value=HttpService:JSONEncode(list) sv.Parent=sg
 local ls=sg:FindFirstChild('OR_UIBehaviours') if not ls then ls=Instance.new('LocalScript') ls.Name='OR_UIBehaviours' ls.Parent=sg end
 ls.Source=BEHAVIOUR_SRC
 return #list
end
local function relPath(host,sg) if not sg or host==sg then return '' end local segs={} local cur=host while cur and cur~=sg do table.insert(segs,1,cur.Name) cur=cur.Parent end return table.concat(segs,'.') end
local function ensureScreen(a,parentArg)
 local parent=parentArg and resolve(parentArg) or nil
 if parent and parent:IsA('LayerCollector') then return parent,parent,false end
 if parent and parent:IsA('GuiObject') then local sg=parent:FindFirstAncestorWhichIsA('LayerCollector') return parent,sg,false end
 local host=parent or StarterGui
 local scr=type(a.screen)=='table' and a.screen or {}
 local name=tostring(scr.name or a.name or a.screen or 'OR_UI')
 local sg=host:FindFirstChild(name)
 if sg and a.replace then sg:Destroy() sg=nil end
 local fresh=false
 if not sg then sg=Instance.new('ScreenGui') sg.Name=name sg.ResetOnSpawn=(scr.reset_on_spawn==true) sg.IgnoreGuiInset=(scr.ignore_inset~=false) sg.ZIndexBehavior=Enum.ZIndexBehavior.Sibling if scr.display_order then sg.DisplayOrder=math.floor(num(scr.display_order,0)) end sg.Parent=host fresh=true end
 if scr.enabled==false then sg.Enabled=false end
 return sg,sg,fresh
end
local function exportNode(inst,depth,maxDepth,counter)
 counter.n=counter.n+1
 local n={class=inst.ClassName,name=inst.Name}
 if inst:IsA('GuiObject') then
  n.size=udimArr(inst.Size) n.position=udimArr(inst.Position)
  if inst.AnchorPoint.X~=0 or inst.AnchorPoint.Y~=0 then n.anchor={inst.AnchorPoint.X,inst.AnchorPoint.Y} end
  if inst.ZIndex~=1 then n.z=inst.ZIndex end
  if not inst.Visible then n.visible=false end
  if inst.BackgroundTransparency<1 then n.bg=c3hex(inst.BackgroundColor3) end
  if inst.BackgroundTransparency~=0 then n.bg_t=inst.BackgroundTransparency end
  if inst.Rotation~=0 then n.rotation=inst.Rotation end
  if inst.ClipsDescendants then n.clips=true end
  if inst.LayoutOrder~=0 then n.layout_order=inst.LayoutOrder end
  local asz=getp(inst,'AutomaticSize') if asz and asz~=Enum.AutomaticSize.None then n.automatic_size=asz.Name end
  if inst:IsA('TextLabel') or inst:IsA('TextButton') or inst:IsA('TextBox') then
   n.text=inst.Text n.text_color=c3hex(inst.TextColor3) n.font=inst.Font.Name
   if inst.TextScaled then n.text_scaled=true else n.text_size=inst.TextSize end
   if inst.TextXAlignment~=Enum.TextXAlignment.Center then n.align_x=inst.TextXAlignment.Name end
   if inst.TextYAlignment~=Enum.TextYAlignment.Center then n.align_y=inst.TextYAlignment.Name end
   if inst.TextWrapped then n.wrap=true end
   if inst.TextTransparency~=0 then n.text_t=inst.TextTransparency end
   if inst.TextStrokeTransparency<1 then n.text_stroke={color=c3hex(inst.TextStrokeColor3),transparency=inst.TextStrokeTransparency} end
   if inst:IsA('TextBox') then n.placeholder=inst.PlaceholderText end
  end
  if inst:IsA('ImageLabel') or inst:IsA('ImageButton') then n.image=inst.Image if inst.ImageTransparency~=0 then n.image_t=inst.ImageTransparency end local ic=c3hex(inst.ImageColor3) if ic~='#ffffff' then n.image_color=ic end if inst.ScaleType~=Enum.ScaleType.Stretch then n.scale_type=en(inst.ScaleType) end if inst.ScaleType==Enum.ScaleType.Slice then local r=inst.SliceCenter n.slice={r.Min.X,r.Min.Y,r.Max.X,r.Max.Y} end end
  if inst:IsA('ScrollingFrame') then n.scroll={thickness=inst.ScrollBarThickness} local acs=getp(inst,'AutomaticCanvasSize') if acs and acs~=Enum.AutomaticSize.None then n.scroll.auto=en(acs) else n.scroll.canvas=udimArr(inst.CanvasSize) end end
 end
 local kids={}
 for _,c in ipairs(inst:GetChildren()) do
  local cn=c.ClassName
  if cn=='UICorner' then n.corner=c.CornerRadius.Scale>0 and {scale=c.CornerRadius.Scale,offset=c.CornerRadius.Offset} or c.CornerRadius.Offset
  elseif cn=='UIStroke' then n.stroke={color=c3hex(c.Color),thickness=c.Thickness,transparency=c.Transparency,mode=en(c.ApplyStrokeMode)}
  elseif cn=='UIGradient' then local okK,kp=pcall(function() return c.Color.Keypoints end) n.gradient={rotation=c.Rotation} if okK and type(kp)=='table' and #kp>0 then n.gradient.from=c3hex(kp[1].Value) n.gradient.to=c3hex(kp[#kp].Value) end local okT,tk=pcall(function() return c.Transparency.Keypoints end) if okT and type(tk)=='table' and #tk>=2 and (tk[1].Value~=0 or tk[#tk].Value~=0) then n.gradient.transparency={tk[1].Value,tk[#tk].Value} end
  elseif cn=='UIPadding' then n.padding={left=c.PaddingLeft.Offset,right=c.PaddingRight.Offset,top=c.PaddingTop.Offset,bottom=c.PaddingBottom.Offset}
  elseif cn=='UIListLayout' then n.layout={kind='list',direction=en(c.FillDirection),gap=c.Padding.Offset,h_align=en(c.HorizontalAlignment),v_align=en(c.VerticalAlignment),sort=en(c.SortOrder)}
  elseif cn=='UIGridLayout' then n.layout={kind='grid',cell=udimArr(c.CellSize),cell_padding=udimArr(c.CellPadding),direction=en(c.FillDirection),h_align=en(c.HorizontalAlignment),v_align=en(c.VerticalAlignment),sort=en(c.SortOrder)}
  elseif cn=='UIPageLayout' then n.layout={kind='page'}
  elseif cn=='UIAspectRatioConstraint' then n.aspect=c.AspectRatio
  elseif cn=='UISizeConstraint' then n.min_size={c.MinSize.X,c.MinSize.Y} if c.MaxSize.X<math.huge or c.MaxSize.Y<math.huge then n.max_size={c.MaxSize.X<math.huge and c.MaxSize.X or 0,c.MaxSize.Y<math.huge and c.MaxSize.Y or 0} end
  elseif cn=='UITextSizeConstraint' then n.text_fit={min=c.MinTextSize,max=c.MaxTextSize}
  elseif cn=='UIScale' then if c.Scale~=1 then n.scale=c.Scale end
  elseif c:IsA('GuiObject') then if depth<maxDepth and counter.n<counter.max then kids[#kids+1]=exportNode(c,depth+1,maxDepth,counter) else counter.skipped=counter.skipped+1 end
  elseif c:IsA('LuaSourceContainer') then n.scripts=n.scripts or {} n.scripts[#n.scripts+1]=c.Name end
 end
 local attrs=inst:GetAttributes() local hasA=false local A={} for k,v in pairs(attrs) do if type(v)=='string' or type(v)=='number' or type(v)=='boolean' then A[k]=v hasA=true end end if hasA then n.attrs=A end
 if #kids>0 then n.children=kids end
 return n
end
local function guiList(a)
 local list={}
 if type(a.paths)=='table' then for _,p in ipairs(a.paths) do local i=resolve(p) if i and i:IsA('GuiObject') then list[#list+1]=i end end
 elseif a.parent or a.path then local par=need(a.parent or a.path,'parent') for _,c in ipairs(par:GetChildren()) do if c:IsA('GuiObject') and (not a.class or c.ClassName==tostring(a.class)) and (not a.match or c.Name:lower():find(tostring(a.match):lower(),1,true)) then list[#list+1]=c end end end
 return list
end
local function setPosKeepingStyle(inst,px,py)
 local ps=parentSize(inst) local pp=inst.Parent and inst.Parent:IsA('GuiObject') and absPos(inst.Parent) or Vector2.new(0,0)
 local rx,ry=px-pp.X,py-pp.Y
 local pos=inst.Position
 local useScaleX=(pos.X.Offset==0 and pos.X.Scale~=0) local useScaleY=(pos.Y.Offset==0 and pos.Y.Scale~=0)
 local sz=absSize(inst) or Vector2.new(0,0)
 local ax,ay=rx+inst.AnchorPoint.X*sz.X,ry+inst.AnchorPoint.Y*sz.Y
 inst.Position=UDim2.new(useScaleX and ax/math.max(1,ps.X) or 0,useScaleX and 0 or math.floor(ax+0.5),useScaleY and ay/math.max(1,ps.Y) or 0,useScaleY and 0 or math.floor(ay+0.5))
end`;

  // ───────────────────────── builders ─────────────────────────
  const B = {};
  function withTokens(a) { return "for k,v in pairs(HttpService:JSONDecode(" + jj(tokensFor(a)) + ")) do TOKENS[k]=v end\n"; }

  B.ui_build_spec = (a) => {
    let spec = a.spec;
    if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch { throw new Error("spec must be a JSON object (got an unparsable string)"); } }
    if (!spec || typeof spec !== "object") throw new Error("missing required param 'spec' (object with children[] / root[])");
    const roots = Array.isArray(spec) ? spec : (spec.children || spec.root || spec.nodes || spec.widgets || []);
    if (!Array.isArray(roots) || !roots.length) throw new Error("spec needs children[] (at least one node like {class:'Frame', name:'Panel', size:[0,300,0,200]})");
    const tok = tokensFor({ preset: spec.preset || a.preset || (spec.tokens && spec.tokens.preset), tokens: Object.assign({}, spec.tokens || {}, a.tokens || {}) });
    const screen = Object.assign({}, typeof spec.screen === "object" && spec.screen ? spec.screen : {}, typeof a.screen === "object" && a.screen ? a.screen : {});
    if (typeof spec.screen === "string") screen.name = spec.screen;
    if (typeof a.screen === "string") screen.name = a.screen;
    if (spec.name && !screen.name && !a.parent) screen.name = spec.name;
    if (a.name && !screen.name) screen.name = a.name;
    return [
      "for k,v in pairs(HttpService:JSONDecode(" + jj(tok) + ")) do TOKENS[k]=v end",
      "local A=HttpService:JSONDecode(" + jj({ screen, replace: a.replace === true || spec.replace === true, parent: a.parent || spec.parent || null, clear: a.clear === true }) + ")",
      "local ROOTS=HttpService:JSONDecode(" + jj(roots) + ")",
      "local rec=wp('ORscript GUI build')",
      "local host,sg,fresh=ensureScreen(A,A.parent)",
      "if A.clear and not fresh then for _,c in ipairs(host:GetChildren()) do if c:IsA('GuiObject') then c:Destroy() end end if sg then local o=sg:FindFirstChild('OR_UIBindings') if o then o:Destroy() end end end",
      "local created={}",
      "local PFX=relPath(host,sg)",
      "for _,n in ipairs(ROOTS) do applyNode(n,host,created,PFX) end",
      "local nb=sg and installBehaviours(sg) or 0",
      "wpDone(rec)",
      "return ok({version=GUISTUDIO_VERSION,path=short(host),screen=sg and short(sg) or nil,count=#created,items=created,behaviours=nb,fresh=fresh},'built '..#created..' GUI object(s) under '..short(host)..(nb>0 and (' with '..nb..' behaviour binding(s) in OR_UIBehaviours') or '')..'. Next: quality_audit {path='..string.format('%q',short(host))..'}')",
    ].join("\n");
  };

  B.ui_component = (a) => {
    const kind = String(a.kind || a.type || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!COMPONENT_KINDS.includes(kind)) throw new Error("unknown component kind '" + kind + "'. Kinds: " + COMPONENT_KINDS.join(", "));
    const tok = tokensFor(a);
    const node = compNode(kind, a, tok);
    return B.ui_build_spec({ spec: { children: [node], tokens: tok }, parent: a.parent || a.path || null, screen: a.screen || (a.parent ? undefined : "OR_UI") });
  };

  B.ui_export_spec = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", depth: Number(a.depth || 12), max: Number(a.max_nodes || 400) }) + ")",
    "local root=A.path~='' and need(A.path,'path') or nil",
    "if not root then local list={} for _,c in ipairs(StarterGui:GetChildren()) do if c:IsA('LayerCollector') then list[#list+1]={name=c.Name,path=short(c),children=#c:GetChildren(),enabled=c.Enabled} end end return ok({screens=list},'pass path: '..#list..' ScreenGui(s) in StarterGui') end",
    "local counter={n=0,max=A.max,skipped=0}",
    "local spec",
    "if root:IsA('LayerCollector') then local kids={} for _,c in ipairs(root:GetChildren()) do if c:IsA('GuiObject') and counter.n<counter.max then kids[#kids+1]=exportNode(c,1,A.depth,counter) end end spec={screen={name=root.Name,ignore_inset=getp(root,'IgnoreGuiInset')==true,reset_on_spawn=getp(root,'ResetOnSpawn')==true,display_order=getp(root,'DisplayOrder') or 0},children=kids}",
    "elseif root:IsA('GuiObject') then spec={screen={name=(root:FindFirstAncestorWhichIsA('LayerCollector') or root).Name},children={exportNode(root,1,A.depth,counter)}}",
    "else return fail('path must be a ScreenGui / SurfaceGui / GuiObject (got '..root.ClassName..')') end",
    "local tk={} for k,v in pairs(root:GetAttributes()) do if type(k)=='string' and k:sub(1,3)=='OR_' and typeof(v)=='Color3' then tk[k:sub(4):lower()]=c3hex(v) end end if next(tk) then spec.tokens=tk end",
    "local bv=root:FindFirstChild('OR_UIBindings') if bv then local okJ,bl=pcall(function() return HttpService:JSONDecode(bv.Value) end) if okJ then spec.bindings=bl end end",
    "return ok({version=GUISTUDIO_VERSION,path=short(root),nodes=counter.n,skipped=counter.skipped,spec=spec},'exported '..counter.n..' node(s) from '..short(root)..(counter.skipped>0 and (' ('..counter.skipped..' skipped by depth / max_nodes)') or '')..' - feed `spec` back to ui_build_spec {spec, replace:true} or open it in GUI Studio')",
  ].join("\n");

  B.ui_align = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ paths: a.paths || null, parent: a.parent || a.path || null, class: a.class || null, match: a.match || null, mode: String(a.mode || a.align || "center").toLowerCase(), to: String(a.to || "parent").toLowerCase() }) + ")",
    "local list=guiList(A) if #list==0 then return fail('nothing to align: pass paths[] or parent') end",
    "local rec=wp('ORscript GUI align')",
    "local b0,b1 if A.to=='selection' and #list>1 then local x0,y0,x1,y1=math.huge,math.huge,-math.huge,-math.huge for _,i in ipairs(list) do local p=absPos(i) local s=absSize(i) or Vector2.new(0,0) x0=math.min(x0,p.X) y0=math.min(y0,p.Y) x1=math.max(x1,p.X+s.X) y1=math.max(y1,p.Y+s.Y) end b0=Vector2.new(x0,y0) b1=Vector2.new(x1,y1) else local par=list[1].Parent local pp=par and par:IsA('GuiObject') and absPos(par) or Vector2.new(0,0) local ps=parentSize(list[1]) b0=pp b1=pp+ps end",
    "local moved={}",
    "for _,i in ipairs(list) do local p=absPos(i) local s=absSize(i) or Vector2.new(0,0) local nx,ny=p.X,p.Y local m=A.mode",
    " if m=='left' then nx=b0.X elseif m=='right' then nx=b1.X-s.X elseif m=='center_x' or m=='centerx' or m=='hcenter' then nx=(b0.X+b1.X)/2-s.X/2 elseif m=='top' then ny=b0.Y elseif m=='bottom' then ny=b1.Y-s.Y elseif m=='center_y' or m=='centery' or m=='vcenter' or m=='middle' then ny=(b0.Y+b1.Y)/2-s.Y/2 elseif m=='center' then nx=(b0.X+b1.X)/2-s.X/2 ny=(b0.Y+b1.Y)/2-s.Y/2 else wpDone(rec) return fail('mode must be left|right|top|bottom|center|center_x|center_y') end",
    " setPosKeepingStyle(i,nx,ny) moved[#moved+1]={path=short(i),position=udimArr(i.Position)} end",
    "wpDone(rec)",
    "return ok({mode=A.mode,moved=moved},'aligned '..#moved..' object(s) '..A.mode..' to '..A.to)",
  ].join("\n");

  B.ui_distribute = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ paths: a.paths || null, parent: a.parent || a.path || null, class: a.class || null, match: a.match || null, axis: String(a.axis || "x").toLowerCase(), gap: a.gap != null ? Number(a.gap) : null }) + ")",
    "local list=guiList(A) if #list<2 then return fail('need at least two objects (paths[] or parent)') end",
    "local ax=A.axis=='y' and 'Y' or 'X'",
    "table.sort(list,function(p,q) return absPos(p)[ax]<absPos(q)[ax] end)",
    "local rec=wp('ORscript GUI distribute')",
    "local total=0 for _,i in ipairs(list) do total=total+(absSize(i) or Vector2.new(0,0))[ax] end",
    "local first=absPos(list[1]) local last=absPos(list[#list]) local lastS=absSize(list[#list]) or Vector2.new(0,0)",
    "local gap=A.gap if gap==nil then gap=((last[ax]+lastS[ax])-first[ax]-total)/(#list-1) end",
    "local cur=first[ax] local moved={}",
    "for _,i in ipairs(list) do local p=absPos(i) if ax=='X' then setPosKeepingStyle(i,cur,p.Y) else setPosKeepingStyle(i,p.X,cur) end cur=cur+(absSize(i) or Vector2.new(0,0))[ax]+gap moved[#moved+1]=short(i) end",
    "wpDone(rec)",
    "return ok({axis=A.axis,gap=gap,moved=moved},'distributed '..#moved..' object(s) along '..A.axis..' with gap '..string.format('%.1f',gap))",
  ].join("\n");

  B.ui_anchor_preset = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", preset: String(a.preset || a.anchor || "center").toLowerCase().replace(/[\s-]+/g, "_"), keep: a.keep !== false, margin: Number(a.margin || 0) }) + ")",
    "local inst=need(A.path,'path') if not inst:IsA('GuiObject') then return fail('path must be a GuiObject') end",
    "local P={top_left={0,0},top={0.5,0},top_center={0.5,0},top_right={1,0},left={0,0.5},center_left={0,0.5},center={0.5,0.5},middle={0.5,0.5},right={1,0.5},center_right={1,0.5},bottom_left={0,1},bottom={0.5,1},bottom_center={0.5,1},bottom_right={1,1}}",
    "local ap=P[A.preset] if not ap then return fail('preset must be one of top_left, top, top_right, left, center, right, bottom_left, bottom, bottom_right') end",
    "local rec=wp('ORscript GUI anchor')",
    "local p=absPos(inst) local s=absSize(inst) or Vector2.new(0,0)",
    "inst.AnchorPoint=Vector2.new(ap[1],ap[2])",
    "if A.keep then setPosKeepingStyle(inst,p.X,p.Y) else local m=A.margin local mx=ap[1]==0 and m or (ap[1]==1 and -m or 0) local my=ap[2]==0 and m or (ap[2]==1 and -m or 0) inst.Position=UDim2.new(ap[1],mx,ap[2],my) end",
    "wpDone(rec)",
    "return ok({path=short(inst),anchor={ap[1],ap[2]},position=udimArr(inst.Position)},'anchor '..A.preset..' on '..short(inst)..(A.keep and ' (visual position kept)' or ' (snapped to the edge)'))",
  ].join("\n");

  B.ui_to_scale = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", recursive: a.recursive !== false, size: a.size !== false, position: a.position !== false, decimals: Number(a.decimals || 4), keep_px_under: Number(a.keep_px_under || 0) }) + ")",
    "local root=need(A.path,'path')",
    "local list={} if root:IsA('GuiObject') then list[1]=root end if A.recursive then for _,d in ipairs(root:GetDescendants()) do if d:IsA('GuiObject') then list[#list+1]=d end end end",
    "if #list==0 then return fail('no GuiObjects under '..short(root)) end",
    "local rec=wp('ORscript GUI to scale')",
    "local mul=10^A.decimals local function r(v) return math.floor(v*mul+0.5)/mul end",
    "local changed=0",
    "for _,i in ipairs(list) do local ps=parentSize(i) local did=false",
    " if A.size then local sz=i.Size if sz.X.Offset~=0 or sz.Y.Offset~=0 then local ax=absSize(i) or Vector2.new(sz.X.Scale*ps.X+sz.X.Offset,sz.Y.Scale*ps.Y+sz.Y.Offset) local kx=(A.keep_px_under>0 and ax.X<A.keep_px_under) local ky=(A.keep_px_under>0 and ax.Y<A.keep_px_under) i.Size=UDim2.new(kx and 0 or r(ax.X/math.max(1,ps.X)),kx and ax.X or 0,ky and 0 or r(ax.Y/math.max(1,ps.Y)),ky and ax.Y or 0) did=true end end",
    " if A.position then local po=i.Position if po.X.Offset~=0 or po.Y.Offset~=0 then i.Position=UDim2.new(r(po.X.Scale+po.X.Offset/math.max(1,ps.X)),0,r(po.Y.Scale+po.Y.Offset/math.max(1,ps.Y)),0) did=true end end",
    " if did then changed=changed+1 end end",
    "wpDone(rec)",
    "return ok({path=short(root),objects=#list,changed=changed,viewport={viewport().X,viewport().Y}},'converted '..changed..'/'..#list..' object(s) under '..short(root)..' to Scale (viewport '..viewport().X..'x'..viewport().Y..')')",
  ].join("\n");

  B.ui_responsive_fix = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", min_text: Number(a.min_text || 10), max_text: Number(a.max_text || 32), aspect_roots: a.aspect_roots !== false, to_scale: a.to_scale !== false, dry_run: a.dry_run === true }) + ")",
    "local root=need(A.path,'path')",
    "local objs={} if root:IsA('GuiObject') then objs[1]=root end for _,d in ipairs(root:GetDescendants()) do if d:IsA('GuiObject') then objs[#objs+1]=d end end",
    "local rec=(not A.dry_run) and wp('ORscript GUI responsive') or nil",
    "local out={to_scale=0,text_fit=0,aspect=0,text_scaled=0,min_size=0}",
    "local vp=viewport()",
    "for _,i in ipairs(objs) do local ps=parentSize(i)",
    " if A.to_scale then local sz=i.Size local po=i.Position local isSmallIcon=(absSize(i) and absSize(i).X<=48 and absSize(i).Y<=48) if not isSmallIcon and (sz.X.Offset~=0 or sz.Y.Offset~=0) then out.to_scale=out.to_scale+1 if not A.dry_run then local ax=absSize(i) or Vector2.new(sz.X.Scale*ps.X+sz.X.Offset,sz.Y.Scale*ps.Y+sz.Y.Offset) i.Size=UDim2.new(math.floor(ax.X/math.max(1,ps.X)*10000+0.5)/10000,0,math.floor(ax.Y/math.max(1,ps.Y)*10000+0.5)/10000,0) end end if po.X.Offset~=0 or po.Y.Offset~=0 then if not A.dry_run then i.Position=UDim2.new(math.floor((po.X.Scale+po.X.Offset/math.max(1,ps.X))*10000+0.5)/10000,0,math.floor((po.Y.Scale+po.Y.Offset/math.max(1,ps.Y))*10000+0.5)/10000,0) end end end",
    " if i:IsA('TextLabel') or i:IsA('TextButton') or i:IsA('TextBox') then if not i.TextScaled then out.text_scaled=out.text_scaled+1 if not A.dry_run then i.TextScaled=true end end if not i:FindFirstChildOfClass('UITextSizeConstraint') then out.text_fit=out.text_fit+1 if not A.dry_run then local c=Instance.new('UITextSizeConstraint') c.MinTextSize=A.min_text c.MaxTextSize=math.max(A.min_text,math.min(A.max_text,(i.TextSize>0 and i.TextSize or A.max_text))) c.Parent=i end end end",
    " local par=i.Parent local isRoot=par and par:IsA('LayerCollector')",
    " if A.aspect_roots and isRoot and not i:FindFirstChildOfClass('UIAspectRatioConstraint') then local s=absSize(i) if s and s.X>0 and s.Y>0 and not (i.Size.X.Scale>=0.99 and i.Size.Y.Scale>=0.99) then out.aspect=out.aspect+1 if not A.dry_run then local c=Instance.new('UIAspectRatioConstraint') c.AspectRatio=s.X/s.Y c.Parent=i end end end",
    " if isRoot and not i:FindFirstChildOfClass('UISizeConstraint') then local s=absSize(i) if s and s.X>0 and s.Y>0 and s.X<vp.X*0.9 then out.min_size=out.min_size+1 if not A.dry_run then local c=Instance.new('UISizeConstraint') c.MinSize=Vector2.new(math.floor(s.X*0.5),math.floor(s.Y*0.5)) c.Parent=i end end end",
    "end",
    "if rec then wpDone(rec) end",
    "local total=out.to_scale+out.text_fit+out.aspect+out.text_scaled+out.min_size",
    "return ok({path=short(root),objects=#objs,changes=out,total=total,dry_run=A.dry_run},(A.dry_run and 'would apply ' or 'applied ')..total..' responsive fix(es) under '..short(root)..': '..out.to_scale..' offset->scale, '..out.text_scaled..' TextScaled, '..out.text_fit..' UITextSizeConstraint, '..out.aspect..' aspect ratio, '..out.min_size..' min size')",
  ].join("\n");

  B.ui_text_fit = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", min: Number(a.min || 10), max: Number(a.max || 28), recursive: a.recursive !== false }) + ")",
    "local root=need(A.path,'path') local list={} local function isT(i) return i:IsA('TextLabel') or i:IsA('TextButton') or i:IsA('TextBox') end",
    "if isT(root) then list[1]=root end if A.recursive then for _,d in ipairs(root:GetDescendants()) do if isT(d) then list[#list+1]=d end end end",
    "if #list==0 then return fail('no text objects under '..short(root)) end",
    "local rec=wp('ORscript GUI text fit')",
    "for _,i in ipairs(list) do i.TextScaled=true i.TextWrapped=true local c=modChild(i,'UITextSizeConstraint') c.MinTextSize=A.min c.MaxTextSize=math.max(A.min,A.max) end",
    "wpDone(rec)",
    "return ok({path=short(root),count=#list,min=A.min,max=A.max},'text fit '..A.min..'-'..A.max..'px on '..#list..' text object(s)')",
  ].join("\n");

  B.ui_zorder_fix = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", start: Number(a.start || 1), step: Number(a.step || 1) }) + ")",
    "local root=need(A.path,'path')",
    "local sg=root:IsA('LayerCollector') and root or root:FindFirstAncestorWhichIsA('LayerCollector')",
    "local rec=wp('ORscript GUI z-order')",
    "if sg then setp(sg,'ZIndexBehavior',Enum.ZIndexBehavior.Sibling) end",
    "local n=0 local z=A.start",
    "local function walk(node) local kids={} for _,c in ipairs(node:GetChildren()) do if c:IsA('GuiObject') then kids[#kids+1]=c end end table.sort(kids,function(p,q) if p.ZIndex~=q.ZIndex then return p.ZIndex<q.ZIndex end return p.LayoutOrder<q.LayoutOrder end) for _,c in ipairs(kids) do c.ZIndex=z z=z+A.step n=n+1 walk(c) end end",
    "walk(root)",
    "wpDone(rec)",
    "return ok({path=short(root),count=n,last=z-A.step},'ZIndex re-numbered on '..n..' object(s) (Sibling behaviour, '..A.start..'..'..(z-A.step)..')')",
  ].join("\n");

  B.ui_tokens_apply = (a) => {
    const tok = tokensFor(a);
    return [
      withTokens(a),
      "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", fonts: a.fonts !== false, radius: a.radius !== false, strokes: a.strokes !== false, text: a.text !== false, roles: a.roles || {} }) + ")",
      "local root=need(A.path,'path')",
      "local list={} if root:IsA('GuiObject') then list[1]=root end for _,d in ipairs(root:GetDescendants()) do if d:IsA('GuiObject') then list[#list+1]=d end end",
      "local rec=wp('ORscript GUI tokens')",
      "local function lum(c) return 0.2126*c.R+0.7152*c.G+0.0722*c.B end",
      "local surface=color('surface') local surface2=color('surface2') local primary=color('primary') local text=color('text') local muted=color('muted') local stroke=color('stroke')",
      "local n=0",
      "for _,i in ipairs(list) do local role=A.roles[i.Name] or i:GetAttribute('OR_Role')",
      " local isBtn=i:IsA('GuiButton') local isText=i:IsA('TextLabel') or i:IsA('TextButton') or i:IsA('TextBox')",
      " local par=i.Parent local isRoot=par and par:IsA('LayerCollector')",
      " if i.BackgroundTransparency<1 then if role then local c=color(role) if c then i.BackgroundColor3=c end elseif isBtn and i:IsA('TextButton') and (i.Text~='' and i.Text~='×') then i.BackgroundColor3=primary elseif isBtn then i.BackgroundColor3=surface2 elseif isRoot then i.BackgroundColor3=surface else i.BackgroundColor3=(lum(i.BackgroundColor3)>lum(surface)) and surface2 or surface end end",
      " if isText and A.text then if i.BackgroundTransparency<0.6 and (i.BackgroundColor3==primary or i.BackgroundColor3==color('accent',primary) or i.BackgroundColor3==color('success',primary) or i.BackgroundColor3==color('danger',primary)) then i.TextColor3=autoText(i,i.Parent) elseif i.TextTransparency<1 and lum(i.TextColor3)<0.45 and lum(text)<0.45 then i.TextColor3=text elseif i.TextSize<=13 and not i.TextScaled then i.TextColor3=muted else i.TextColor3=text end if A.fonts then i.Font=fontOf((isBtn or (i.TextSize>=20)) and 'title_font' or 'font') end end",
      " if A.radius and (isBtn or i.BackgroundTransparency<1) then local c=i:FindFirstChildOfClass('UICorner') local r=num('radius',10) if c then if c.CornerRadius.Scale==0 then c.CornerRadius=UDim.new(0,r) end else local cc=Instance.new('UICorner') cc.CornerRadius=UDim.new(0,r) cc.Parent=i end end",
      " if A.strokes then local s=i:FindFirstChildOfClass('UIStroke') if s then s.Color=stroke s.Transparency=num('stroke_t',0.2) end end",
      " n=n+1 end",
      "for k,v in pairs(TOKENS) do if type(v)=='string' and v:sub(1,1)=='#' then local c=hexToC3(v) if c then pcall(function() root:SetAttribute('OR_'..k:sub(1,1):upper()..k:sub(2),c) end) end end end",
      "wpDone(rec)",
      "return ok({path=short(root),count=n,tokens=HttpService:JSONDecode(" + jj(tok) + ")},'re-skinned '..n..' object(s) under '..short(root)..' with the token set (bg '..tostring(TOKENS.bg)..', primary '..tostring(TOKENS.primary)..', font '..tostring(TOKENS.font)..')')",
    ].join("\n");
  };

  B.ui_tween = (a) => {
    const effect = String(a.effect || "fade_in").toLowerCase();
    const EFFECTS = ["fade_in", "fade_out", "slide_in", "slide_up", "pop", "pulse", "shake", "spin", "hover_grow", "bounce"];
    if (!EFFECTS.includes(effect)) throw new Error("effect must be one of " + EFFECTS.join(", "));
    const trigger = String(a.trigger || (effect === "hover_grow" ? "hover" : "enable")).toLowerCase();
    const src = `-- OR ui_tween: ${effect} on ${trigger}
local TweenService = game:GetService("TweenService")
local o = script.Parent
local D = ${Number(a.duration || 0.35)}
local function scaleOf() local s = o:FindFirstChildOfClass("UIScale") if not s then s = Instance.new("UIScale") s.Parent = o end return s end
local basePos = o.Position
local function play()
	local e = "${effect}"
	if e == "fade_in" then
		local t0 = o.BackgroundTransparency o.BackgroundTransparency = 1 TweenService:Create(o, TweenInfo.new(D), { BackgroundTransparency = t0 }):Play()
		for _, d in ipairs(o:GetDescendants()) do if d:IsA("TextLabel") or d:IsA("TextButton") then local t = d.TextTransparency d.TextTransparency = 1 TweenService:Create(d, TweenInfo.new(D), { TextTransparency = t }):Play() end end
	elseif e == "fade_out" then
		TweenService:Create(o, TweenInfo.new(D), { BackgroundTransparency = 1 }):Play()
	elseif e == "slide_in" then
		o.Position = basePos - UDim2.new(0.4, 0, 0, 0) TweenService:Create(o, TweenInfo.new(D, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), { Position = basePos }):Play()
	elseif e == "slide_up" then
		o.Position = basePos + UDim2.new(0, 0, 0, 60) TweenService:Create(o, TweenInfo.new(D, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), { Position = basePos }):Play()
	elseif e == "pop" then
		local s = scaleOf() s.Scale = 0.6 TweenService:Create(s, TweenInfo.new(D, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1 }):Play()
	elseif e == "bounce" then
		local s = scaleOf() s.Scale = 0.3 TweenService:Create(s, TweenInfo.new(D, Enum.EasingStyle.Bounce, Enum.EasingDirection.Out), { Scale = 1 }):Play()
	elseif e == "pulse" then
		TweenService:Create(scaleOf(), TweenInfo.new(math.max(0.2, D), Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, ${a.loop === false ? 0 : -1}, true), { Scale = ${Number(a.scale || 1.06)} }):Play()
	elseif e == "shake" then
		task.spawn(function() for i = 1, 6 do o.Position = basePos + UDim2.new(0, (i % 2 == 0) and 6 or -6, 0, 0) task.wait(D / 6) end o.Position = basePos end)
	elseif e == "spin" then
		TweenService:Create(o, TweenInfo.new(math.max(0.3, D), Enum.EasingStyle.Linear, Enum.EasingDirection.Out, ${a.loop === false ? 0 : -1}), { Rotation = 360 }):Play()
	end
end
if "${trigger}" == "hover" then
	o.MouseEnter:Connect(function() if "${effect}" == "hover_grow" then TweenService:Create(scaleOf(), TweenInfo.new(0.15), { Scale = ${Number(a.scale || 1.05)} }):Play() else play() end end)
	o.MouseLeave:Connect(function() if "${effect}" == "hover_grow" then TweenService:Create(scaleOf(), TweenInfo.new(0.15), { Scale = 1 }):Play() end end)
elseif "${trigger}" == "click" and o:IsA("GuiButton") then
	o.Activated:Connect(play)
else
	if o.Visible then play() end
	o:GetPropertyChangedSignal("Visible"):Connect(function() if o.Visible then play() end end)
end
`;
    return [
      "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", src, effect, trigger }) + ")",
      "local inst=need(A.path,'path') if not inst:IsA('GuiObject') then return fail('path must be a GuiObject') end",
      "local rec=wp('ORscript GUI tween')",
      "local ls=inst:FindFirstChild('OR_Tween_'..A.effect) if not ls then ls=Instance.new('LocalScript') ls.Name='OR_Tween_'..A.effect ls.Parent=inst end ls.Source=A.src",
      "wpDone(rec)",
      "return ok({path=short(inst),script=ls.Name,effect=A.effect,trigger=A.trigger},A.effect..' tween on '..A.trigger..' attached to '..short(inst)..' ('..ls.Name..')')",
    ].join("\n");
  };

  B.ui_state_toggle = (a) => {
    const mode = String(a.mode || "toggle").toLowerCase();
    if (!/^(toggle|open|close|destroy)$/.test(mode)) throw new Error("mode must be toggle|open|close|destroy");
    const src = `-- OR ui_state_toggle: ${mode}
local TweenService = game:GetService("TweenService")
local btn = script.Parent
local TARGET = ${q(a.target || "")}
local function find()
	local gui = btn:FindFirstAncestorWhichIsA("LayerCollector") or game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
	local p = TARGET:gsub("^StarterGui%.", "") p = p:gsub("^SG%.", "")
	local segs = {} for seg in string.gmatch(p, "[^%.]+") do segs[#segs + 1] = seg end
	local cur = gui
	local start = (segs[1] == gui.Name) and 2 or 1
	for i = start, #segs do cur = cur and cur:FindFirstChild(segs[i]) end
	if not cur and #segs > 0 then cur = gui:FindFirstChild(segs[#segs], true) end
	return cur
end
local function scaleOf(o) local s = o:FindFirstChildOfClass("UIScale") if not s then s = Instance.new("UIScale") s.Parent = o end return s end
local function show(o) o.Visible = true ${a.tween === false ? "" : 'local s = scaleOf(o) s.Scale = 0.85 TweenService:Create(s, TweenInfo.new(0.25, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1 }):Play()'} end
local function hide(o) ${a.tween === false ? "" : 'local s = scaleOf(o) local tw = TweenService:Create(s, TweenInfo.new(0.15), { Scale = 0.9 }) tw:Play() tw.Completed:Wait() s.Scale = 1'} o.Visible = false end
btn.Activated:Connect(function()
	local t = find() if not t then warn("ui_state_toggle: target not found: " .. TARGET) return end
	local m = "${mode}"
	if m == "destroy" then t:Destroy() elseif m == "open" then show(t) elseif m == "close" then hide(t) elseif t.Visible then hide(t) else show(t) end
end)
`;
    return [
      "local A=HttpService:JSONDecode(" + jj({ button: a.button || a.path || "", target: a.target || "", mode, src }) + ")",
      "local btn=need(A.button,'button') if not btn:IsA('GuiButton') then return fail('button must be a TextButton / ImageButton') end",
      "local tgt=need(A.target,'target')",
      "local rec=wp('ORscript GUI toggle')",
      "local ls=btn:FindFirstChild('OR_Toggle') if not ls then ls=Instance.new('LocalScript') ls.Name='OR_Toggle' ls.Parent=btn end ls.Source=A.src",
      "wpDone(rec)",
      "return ok({button=short(btn),target=short(tgt),mode=A.mode},short(btn)..' now '..A.mode..'s '..short(tgt))",
    ].join("\n");
  };

  B.ui_find = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ query: String(a.query || a.text || a.name || ""), class: a.class || null, parent: a.parent || a.path || null, limit: Number(a.limit || 60) }) + ")",
    "local root=A.parent and need(A.parent,'parent') or StarterGui local ql=A.query:lower() local out={}",
    "for _,d in ipairs(root:GetDescendants()) do if #out>=A.limit then break end if d:IsA('GuiObject') or d:IsA('LayerCollector') then local hit=(ql=='') or d.Name:lower():find(ql,1,true) or ((d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox')) and tostring(d.Text):lower():find(ql,1,true)) if hit and (not A.class or d.ClassName==A.class) then local row={path=short(d),class=d.ClassName} if d:IsA('GuiObject') then row.size=udimArr(d.Size) row.position=udimArr(d.Position) row.visible=d.Visible if d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox') then row.text=tostring(d.Text):sub(1,60) end end out[#out+1]=row end end end",
    "return ok({query=A.query,count=#out,items=out},#out..' match(es) for '..string.format('%q',A.query)..' under '..short(root))",
  ].join("\n");

  B.ui_bulk_set = (a) => {
    if (!a.properties || typeof a.properties !== "object") throw new Error("missing required param 'properties' (object of Property -> value)");
    return [
      withTokens(a),
      "local A=HttpService:JSONDecode(" + jj({ paths: a.paths || null, parent: a.parent || a.path || null, class: a.class || null, match: a.match || null, recursive: a.recursive === true, properties: a.properties }) + ")",
      "local list=guiList(A)",
      "if A.recursive and (A.parent) then local par=need(A.parent,'parent') list={} for _,d in ipairs(par:GetDescendants()) do if d:IsA('GuiObject') and (not A.class or d.ClassName==A.class) and (not A.match or d.Name:lower():find(tostring(A.match):lower(),1,true)) then list[#list+1]=d end end end",
      "if #list==0 then return fail('no targets: pass paths[] or parent (+ class / match / recursive)') end",
      "local rec=wp('ORscript GUI bulk set')",
      "local n=0 local failed={}",
      "for _,i in ipairs(list) do for k,v in pairs(A.properties) do local key=tostring(k) local okS",
      " if type(v)=='table' and #v==4 then okS=setp(i,key,u2(v)) elseif type(v)=='table' and #v==3 then okS=setp(i,key,color(v)) elseif type(v)=='table' and #v==2 then okS=setp(i,key,Vector2.new(tonumber(v[1]) or 0,tonumber(v[2]) or 0)) elseif type(v)=='string' and v:sub(1,5)=='Enum.' then local parts=string.split(v,'.') okS=pcall(function() i[key]=Enum[parts[2]][parts[3]] end) elseif type(v)=='string' and (v:sub(1,1)=='#' or tokenv(v)~=nil) and (key:find('Color') or key:find('Colour')) then okS=setp(i,key,color(v)) elseif key=='Font' then okS=setp(i,'Font',fontOf(v)) else okS=setp(i,key,v) end",
      " if okS then n=n+1 else failed[#failed+1]=short(i)..'.'..key end end end",
      "wpDone(rec)",
      "return ok({targets=#list,set=n,failed=failed},'set '..n..' propert'..(n==1 and 'y' or 'ies')..' on '..#list..' object(s)'..(#failed>0 and (' ('..#failed..' failed: '..table.concat(failed,', ',1,math.min(#failed,5))..')') or ''))",
    ].join("\n");
  };

  B.ui_screen_create = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ name: a.name || "OR_UI", ignore_inset: a.ignore_inset !== false, reset_on_spawn: a.reset_on_spawn === true, display_order: Number(a.display_order || 0), enabled: a.enabled !== false, replace: a.replace === true }) + ")",
    "local rec=wp('ORscript GUI screen')",
    "local sg=StarterGui:FindFirstChild(A.name) if sg and A.replace then sg:Destroy() sg=nil end local fresh=false",
    "if not sg then sg=Instance.new('ScreenGui') sg.Name=A.name sg.Parent=StarterGui fresh=true end",
    "sg.IgnoreGuiInset=A.ignore_inset sg.ResetOnSpawn=A.reset_on_spawn sg.DisplayOrder=A.display_order sg.Enabled=A.enabled sg.ZIndexBehavior=Enum.ZIndexBehavior.Sibling",
    "wpDone(rec)",
    "return ok({path=short(sg),fresh=fresh},(fresh and 'created ' or 'updated ')..short(sg)..' (IgnoreGuiInset '..tostring(A.ignore_inset)..', ResetOnSpawn '..tostring(A.reset_on_spawn)..', DisplayOrder '..A.display_order..')')",
  ].join("\n");

  B.ui_layout_report = (a) => [
    "local A=HttpService:JSONDecode(" + jj({ path: a.path || "", max: Number(a.max_nodes || 120) }) + ")",
    "local root=need(A.path,'path') local vp=viewport() local rows={} local n=0",
    "local function walk(i,depth) if n>=A.max then return end if i:IsA('GuiObject') then n=n+1 local p=absPos(i) local s=absSize(i) or Vector2.new(0,0) local off=(p.X<0 or p.Y<0 or p.X+s.X>vp.X or p.Y+s.Y>vp.Y) rows[#rows+1]={path=short(i),class=i.ClassName,x=math.floor(p.X),y=math.floor(p.Y),w=math.floor(s.X),h=math.floor(s.Y),depth=depth,visible=i.Visible,off_screen=off,offset_only=(i.Size.X.Scale==0 and i.Size.Y.Scale==0)} end for _,c in ipairs(i:GetChildren()) do walk(c,depth+1) end end",
    "walk(root,0)",
    "local off=0 local offsetOnly=0 for _,r in ipairs(rows) do if r.off_screen then off=off+1 end if r.offset_only then offsetOnly=offsetOnly+1 end end",
    "local overlaps={} for i2=1,#rows do for j=i2+1,#rows do local p,q2=rows[i2],rows[j] if p.depth==q2.depth and p.visible and q2.visible and p.x<q2.x+q2.w and q2.x<p.x+p.w and p.y<q2.y+q2.h and q2.y<p.y+p.h then overlaps[#overlaps+1]={p.path,q2.path} if #overlaps>=20 then break end end end end",
    "return ok({path=short(root),viewport={vp.X,vp.Y},count=#rows,off_screen=off,offset_only=offsetOnly,overlaps=overlaps,boxes=rows},#rows..' box(es) under '..short(root)..' at '..vp.X..'x'..vp.Y..': '..off..' off-screen, '..offsetOnly..' offset-only, '..#overlaps..' sibling overlap(s)')",
  ].join("\n");

  // ───────────────────────── catalogue ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const SPEC_DOC = "Node: {class: Frame|TextLabel|TextButton|TextBox|ImageLabel|ImageButton|ScrollingFrame|CanvasGroup, name, size:[sx,ox,sy,oy], position:[..], anchor:[x,y], z, visible, bg:'#hex'|token|[r,g,b], bg_t, text, text_color, font, text_size|text_scaled, text_fit:{min,max}, align_x, align_y, wrap, image, image_color, scale_type, slice:[l,t,r,b], corner, stroke:{color,thickness,transparency}, gradient:{from,to,rotation,transparency:[a,b]}, padding:n|{left,right,top,bottom}, layout:{kind:list|grid, direction, gap, cell:[..], h_align, v_align}, aspect, min_size, max_size, scale, attrs:{}, props:{AnyProperty:value}, actions:[{on:click|hover|enable|focus|drag|parent_hover, do:toggle|open|close|destroy|print|sound|remote|tween_in|auto_hide|pulse|hover_grow|hover_tint|switch|check|tab|pick_option|select_slot|slider|bind_health|bind_avatar|show_while_hover|focus_ring, target:'Sibling'|'parent.Name'|'gui.Path', effect:pop|slide_up|fade, seconds, remote}], children:[...]}. Colour tokens: bg surface surface2 primary accent text muted danger success stroke; 'font'/'title_font'/'radius'/'stroke_t' tokens too. RULES: text on a primary/accent/success/danger fill → text_color:'auto'; pills/badges need bg_t:0; HUD screens (no full-screen backdrop) → screen.ignore_inset:false so nothing sits under the Roblox top bar.";
  const C = [
    { name: "ui_build_spec", description: "GUI STUDIO ENGINE - build a whole ScreenGui (or a subtree under parent) from ONE nested JSON spec in one undoable step: classes, UDim2 arrays, hex / token colours (text_color 'auto' = readable on whatever fill is behind), text + fonts, images + 9-slice, UICorner / UIStroke / UIGradient / UIPadding / list + grid layouts / aspect + size constraints / text fit, attributes, any raw property, AND behaviours (click toggles / opens / closes / destroys / sounds / RemoteEvents, hover grow / tint, enable tween-in / auto-hide / pulse, toggles, checkboxes, tabs, dropdowns, sliders, hotbar slots, health + avatar binding) compiled into a single data-driven LocalScript OR_UIBehaviours. Tokens (preset midnight | clean_light | candy | neon | royal_gold | forest | horror | ocean | sakura | retro, or custom) are stored on the ScreenGui as OR_* attributes. " + SPEC_DOC, params: { spec: S("object", true, "{screen:{name, ignore_inset, reset_on_spawn, display_order} | 'Name', preset, tokens:{}, children:[node...]}"), parent: S("string", false, "existing ScreenGui or GuiObject path to build under (default StarterGui + spec.screen.name)"), replace: S("boolean", false, "destroy a same-named ScreenGui first"), clear: S("boolean", false, "remove existing GuiObjects under the target before building"), preset: S("string", false, "token preset override"), tokens: S("object", false, "token overrides {primary:'#4f7cff', font:'GothamBold', radius:12, ...}") } },
    { name: "ui_export_spec", description: "Read an existing ScreenGui / GuiObject back into the ui_build_spec JSON (classes, UDim2s, colours as hex, text / fonts, images, every UI modifier, attributes, OR_UIBindings). Round-trips with ui_build_spec {spec, replace:true} and opens in GUI Studio for visual editing. With no path it lists the ScreenGuis in StarterGui.", params: { path: S("string", false, "ScreenGui or GuiObject path"), depth: S("number", false, "max nesting depth (default 12)"), max_nodes: S("number", false, "cap on exported nodes (default 400)") } },
    { name: "ui_component", description: "Drop a finished, token-styled component with its behaviour already wired (same engine as ui_build_spec): button, icon_button, toggle, slider, progress_bar, window (title bar + close), modal (confirm / cancel), toast (auto-hide), tabs {tabs:[]}, dropdown {options:[]}, tooltip, badge, currency_hud, health_bar (binds Humanoid), hotbar {slots}, text_input, checkbox, card {price, image}, list {items:[]}, grid {slots}, divider, avatar (player headshot), title, stat_row. Pass parent to place it inside an existing frame; otherwise it goes into ScreenGui OR_UI.", params: { kind: S("string", true, COMPONENT_KINDS.join("|")), parent: S("string", false, "GuiObject / ScreenGui path"), name: S("string", false), label: S("string", false, "text / title"), size: S("array", false, "[sx,ox,sy,oy]"), position: S("array", false, "[sx,ox,sy,oy]"), anchor: S("array", false, "[x,y]"), preset: S("string", false, "token preset"), tokens: S("object", false), action: S("string", false, "button click action: toggle|open|close|destroy|print|remote (with target / remote)"), target: S("string", false, "target for action, e.g. 'gui.ShopWindow'"), remote: S("string", false, "RemoteEvent name under ReplicatedStorage.OR_UIEvents"), value: S("number", false, "slider / progress 0-1"), tabs: S("array", false), options: S("array", false), items: S("array", false), slots: S("number", false), image: S("string", false), on: S("boolean", false, "toggle / checkbox initial state") } },
    { name: "ui_align", description: "Align GUI objects (paths[] or every child of parent, optional class / match filter) left | right | top | bottom | center | center_x | center_y relative to their parent (default) or to the selection's bounding box (to:'selection'). Keeps each object's Scale-vs-Offset style.", params: { paths: S("array", false), parent: S("string", false), class: S("string", false), match: S("string", false, "name contains"), mode: S("string", true, "left|right|top|bottom|center|center_x|center_y"), to: S("string", false, "parent|selection") } },
    { name: "ui_distribute", description: "Space GUI objects evenly along x or y (paths[] or children of parent). Without gap the first and last stay put and the gaps equalise; with gap they pack from the first object.", params: { paths: S("array", false), parent: S("string", false), class: S("string", false), match: S("string", false), axis: S("string", false, "x|y (default x)"), gap: S("number", false, "pixels") } },
    { name: "ui_anchor_preset", description: "Set AnchorPoint from a 3x3 preset (top_left, top, top_right, left, center, right, bottom_left, bottom, bottom_right) and keep the object exactly where it is on screen (keep:true, default) or snap it to that edge with a margin (keep:false, margin).", params: { path: S("string", true), preset: S("string", true), keep: S("boolean", false), margin: S("number", false) } },
    { name: "ui_to_scale", description: "Convert Offset sizes / positions to Scale (relative to each parent, viewport-aware) so the GUI resizes with the screen. recursive by default; keep_px_under keeps small icons in pixels.", params: { path: S("string", true), recursive: S("boolean", false), size: S("boolean", false), position: S("boolean", false), keep_px_under: S("number", false, "px - sizes below stay Offset (icons)"), decimals: S("number", false) } },
    { name: "ui_responsive_fix", description: "One-shot responsive pass over a GUI tree: offset -> scale (icons <= 48 px kept), TextScaled + UITextSizeConstraint on every text object, UIAspectRatioConstraint + UISizeConstraint on root frames. dry_run:true only counts.", params: { path: S("string", true), min_text: S("number", false), max_text: S("number", false), aspect_roots: S("boolean", false), to_scale: S("boolean", false), dry_run: S("boolean", false) } },
    { name: "ui_text_fit", hidden: true, description: "TextScaled + TextWrapped + UITextSizeConstraint(min,max) on a text object or every text object under path.", params: { path: S("string", true), min: S("number", false), max: S("number", false), recursive: S("boolean", false) } },
    { name: "ui_zorder_fix", hidden: true, description: "Re-number ZIndex depth-first (Sibling behaviour) so later / nested objects draw on top and overlapping buttons stay clickable.", params: { path: S("string", true), start: S("number", false), step: S("number", false) } },
    { name: "ui_tokens_apply", description: "Re-skin a GUI tree with a token set (preset midnight | clean_light | candy | neon | royal_gold | forest | horror | ocean | sakura | retro, or tokens {bg, surface, surface2, primary, accent, text, muted, danger, success, stroke, stroke_t, font, title_font, radius}): backgrounds by role (root -> surface, buttons -> primary / surface2), text + fonts, UICorner radius, UIStroke colour. roles {Name:'accent'} pins a colour per object name.", params: { path: S("string", true), preset: S("string", false), tokens: S("object", false), roles: S("object", false), fonts: S("boolean", false), radius: S("boolean", false), strokes: S("boolean", false), text: S("boolean", false) } },
    { name: "ui_tween", description: "Attach a LocalScript animation to a GuiObject: fade_in | fade_out | slide_in | slide_up | pop | bounce | pulse | shake | spin | hover_grow, triggered on enable (Visible), click or hover.", params: { path: S("string", true), effect: S("string", true), trigger: S("string", false, "enable|click|hover"), duration: S("number", false), scale: S("number", false), loop: S("boolean", false) } },
    { name: "ui_state_toggle", description: "Make a button open / close / toggle / destroy another GUI object (with a pop tween) via a LocalScript on the button - the classic 'Shop button opens ShopWindow'.", params: { button: S("string", true, "TextButton / ImageButton path"), target: S("string", true, "GuiObject path"), mode: S("string", false, "toggle|open|close|destroy"), tween: S("boolean", false) } },
    { name: "ui_find", description: "Search StarterGui (or parent) for GUI objects by name / text substring and optional class; returns paths with size / position / text.", params: { query: S("string", false), class: S("string", false), parent: S("string", false), limit: S("number", false) } },
    { name: "ui_bulk_set", description: "Set the same properties on many GUI objects at once (paths[] or parent + class / match, recursive). Colours as '#hex', token names, or [r,g,b]; UDim2 as [sx,ox,sy,oy]; Vector2 as [x,y]; enums as 'Enum.X.Y'; Font by name.", params: { paths: S("array", false), parent: S("string", false), class: S("string", false), match: S("string", false), recursive: S("boolean", false), properties: S("object", true), preset: S("string", false) } },
    { name: "ui_screen_create", description: "Create or update a ScreenGui with production defaults (IgnoreGuiInset on, ResetOnSpawn off, Sibling Z-order), DisplayOrder and Enabled.", params: { name: S("string", true), ignore_inset: S("boolean", false), reset_on_spawn: S("boolean", false), display_order: S("number", false), enabled: S("boolean", false), replace: S("boolean", false) } },
    { name: "ui_layout_report", description: "Text 'screenshot' of a GUI: absolute pixel boxes per object at the current viewport, off-screen objects, offset-only sizes and overlapping siblings - read it before and after layout changes when you cannot see the screen.", params: { path: S("string", true), max_nodes: S("number", false) } },
  ];

  function buildGuiStudio(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildGuiStudio(op, args);
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.GUISTUDIO_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.GUISTUDIO_VERSION = GUISTUDIO_VERSION;
  RobloxScriptSkills.GUI_TOKEN_PRESETS = TOKEN_PRESETS;
  RobloxScriptSkills.GUI_TOKEN_KEYS = TOKEN_KEYS;
  RobloxScriptSkills.GUI_COMPONENT_KINDS = COMPONENT_KINDS.slice();
  RobloxScriptSkills.guiComponentNode = function (kind, args) { const a = args || {}; return compNode(String(kind || "").toLowerCase(), a, tokensFor(a)); };
  RobloxScriptSkills.guiTokensFor = tokensFor;
  RobloxScriptSkills.GUI_BEHAVIOUR_SRC = BEHAVIOUR_SRC;
})();
