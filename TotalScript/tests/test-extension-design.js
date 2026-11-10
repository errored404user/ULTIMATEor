// 2.12.0 — extension UI rebuild: design-system and architecture pins.
// Static checks over ui/tokens.css, ui/components.css, ui/popup.css, popup.html,
// welcome.html, codecraft.html, overlay.css, background.js and main.js, plus a
// jsdom run of the settings-tray decorateMenu() (search + section chips).
const fs = require("fs");
const path = require("path");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; process.exitCode = 1; } console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "  — " + extra : "")); };

const tokens = read("ui/tokens.css"), comps = read("ui/components.css"), pcss = read("ui/popup.css");
const popupHtml = read("popup.html"), popupJs = read("popup.js"), welcome = read("welcome.html"), welcomeJs = read("welcome.js");
const codecraft = read("codecraft.html"), ccCss = read("ui/codecraft.css"), overlay = read("overlay.css");
const bg = read("background.js"), main = read("src/core/main.js");
const manifest = JSON.parse(read("manifest.json"));

// ── A. design tokens ──
const TOKEN_GROUPS = { bg: /--ts-bg:/, surfaces: /--ts-surface-2:/, text: /--ts-text-3:/, accent: /--ts-accent-soft:/, lines: /--ts-line-strong:/, shadows: /--ts-shadow-2:/, type: /--ts-fs-lg:/, spacing: /--ts-s4:/, radii: /--ts-r-pill:/, control: /--ts-ctl-h:/, toggle: /--ts-toggle-w:/, durations: /--ts-dur-3:/, easing: /--ts-ease:/, focus: /--ts-focus:/, fonts: /--ts-font:/, mono: /--ts-mono:/ };
ok("A1 tokens.css defines every token group (bg, surfaces, text, accent, lines, shadows, type, spacing, radii, control sizes, toggle, durations, easing, focus, fonts)", Object.values(TOKEN_GROUPS).every((re) => re.test(tokens)), Object.keys(TOKEN_GROUPS).filter((k) => !TOKEN_GROUPS[k].test(tokens)).join(","));
ok("A2 dark is the default, light + system are opt-in on data-ts-theme (the legacy data-theme=aqua skin flag stays untouched)", /html\[data-ts-theme="light"\]/.test(tokens) && /html\[data-ts-theme="system"\]/.test(tokens) && /prefers-color-scheme: light/.test(tokens) && !/html\[data-theme="(light|system|dark)"\]/.test(tokens));
ok("A3 six accents via data-accent", ["aqua", "violet", "emerald", "amber", "rose", "slate"].every((a) => new RegExp(`\\[data-accent="${a}"\\]`).test(tokens)));
ok("A4 density, text scale and motion switches are token-level", /\[data-density="compact"\]/.test(tokens) && /\[data-text="large"\]/.test(tokens) && /\[data-text="larger"\]/.test(tokens) && /--ts-scale/.test(tokens) && /\[data-motion="off"\]/.test(tokens) && /prefers-reduced-motion: reduce/.test(tokens));
ok("A5 tokens: no cheap glow (no box-shadow with the accent spread > 4px, no text-shadow)", !/text-shadow/.test(tokens) && !/0 0 \d{2,}px/.test(tokens));

// ── B. component kit ──
const COMPONENTS = [".ts-btn", ".ts-btn.primary", ".ts-btn.secondary", ".ts-btn.ghost", ".ts-btn.danger", ".ts-btn.icon", ".ts-btn.toolbar", ".ts-btn.sm", ".ts-btn.toggle", ".ts-btn.dropdown", ".ts-split", ".ts-seg", ".ts-input", ".ts-select", ".ts-textarea", ".ts-search", ".ts-range", ".ts-row", ".ts-switch", ".ts-card", ".ts-empty", ".ts-dot", ".ts-badge", ".ts-count", ".ts-tabs", ".ts-tab", ".ts-chip", ".ts-toast", ".ts-dialog", ".ts-palette", ".ts-skel", ".ts-kv"];
ok("B1 components.css ships the shared kit (buttons × variants, split, seg, inputs, rows, switch, cards, empty, dot, badge, count, tabs, chips, toast, dialog, palette, skeleton, kv)", COMPONENTS.every((c) => comps.includes(c + " ") || comps.includes(c + ",") || comps.includes(c + "{") || comps.includes(c + ":") || comps.includes(c + "[")), COMPONENTS.filter((c) => !(comps.includes(c + " ") || comps.includes(c + ",") || comps.includes(c + "{") || comps.includes(c + ":") || comps.includes(c + "["))).join(" "));
ok("B2 button states: hover, active, focus-visible ring, disabled, loading spinner, success, error", /\.ts-btn:hover/.test(comps) && /\.ts-btn:active/.test(comps) && /\.ts-btn:focus-visible/.test(comps) && /\.ts-btn:disabled|\.ts-btn\[disabled\]/.test(comps) && /\[data-loading\]/.test(comps) && /\[data-done\]/.test(comps) && /\[data-failed\]/.test(comps));
ok("B3 text never clips mid-glyph: overflow-wrap anywhere on wrapping text, ellipsis only on single-line truncation classes", /\.ts-wrap\s*\{[^}]*overflow-wrap: anywhere/.test(comps) && /\.ts-trunc\s*\{[^}]*text-overflow: ellipsis/.test(comps) && /font-variant-ligatures: none/.test(comps));
ok("B4 reduced motion honoured in the kit", /prefers-reduced-motion/.test(comps) || /\[data-motion="off"\]/.test(comps));

// ── C. popup page ──
ok("C1 popup links tokens → components → popup.css in that order and keeps the pinned skin flag", popupHtml.indexOf('href="ui/tokens.css"') > 0 && popupHtml.indexOf('href="ui/tokens.css"') < popupHtml.indexOf('href="ui/components.css"') && popupHtml.indexOf('href="ui/components.css"') < popupHtml.indexOf('href="ui/popup.css"') && popupHtml.includes('<html data-theme="aqua">'));
ok("C2 popup is a four-section command center (Home · Activity · Tools · Settings) with palette, bell, dialog and toasts", ["view-home", "view-activity", "view-tools", "view-settings", "palette", "palette-input", "bell", "bell-count", "dlg", "toasts"].every((id) => popupHtml.includes(`id="${id}"`)));
ok("C3 connection monitor rows: bridge, Studio/workspace, AI provider, engine segment", ["dot", "state", "dot-studio", "studio-state", "dot-provider", "provider-state", "engine-roblox", "engine-local", "servers", "tools"].every((id) => popupHtml.includes(`id="${id}"`)));
ok("C4 icons are inline SVG symbols (no emoji glyphs that render as tofu)", /<symbol id="i-gear"/.test(popupHtml) && !/data-ic="/.test(popupHtml) && !/[\u{1F300}-\u{1FAFF}]/u.test(popupHtml.replace(/<!--[\s\S]*?-->/g, "")));
ok("C5 no inline event handlers / inline scripts (MV3 CSP)", !/\son[a-z]+="/i.test(popupHtml) && !/<script>[^<]/.test(popupHtml) && /<script src="popup.js"><\/script>/.test(popupHtml));
ok("C6 popup.js: prefs live under one key (tsPopup) with validated enums, no unbounded lists (recent ≤ 8, quick ≤ 12, toasts ≤ 3)", /const PREF_KEY = "tsPopup"/.test(popupJs) && /PREF_ENUMS/.test(popupJs) && /\.slice\(0, 8\)/.test(popupJs) && /\.slice\(0, 12\)/.test(popupJs) && /const TOAST_MAX = 3/.test(popupJs));
ok("C7 popup.js: Ctrl+K palette (no Ctrl+Shift combos that collide with the on-page shortcuts), Ctrl+1…4 views, '/' focuses search", /e\.key\.toLowerCase\(\) === "k"/.test(popupJs) && /\/\^\[1-4\]\$\//.test(popupJs) && /e\.key === "\/"/.test(popupJs) && !/shiftKey && e\.key\.toLowerCase\(\) === "[otv]"/.test(popupJs));
ok("C8 popup.js: settings schema maps every toggle/select/range/textarea to a real storage key or popup pref (no orphan settings)", (() => { const items = [...popupJs.matchAll(/\{ id: "([a-zA-Z-]+)", (?:key: ([A-Za-z_"]+)|pref: "([a-z]+)")?,? ?type: "(toggle|select|range|textarea|seg|accent)"/g)]; return items.length >= 20 && items.every((m) => m[2] || m[3]); })());
const LIVE = ["rsExtraThinking", "rsPlanMode", "rsAutoDebug", "rsGuiBrief", "rsMultiAgent", "rsAutoFix", "rsAutoFixStopPlay", "rsBgMode", "rsThinkingLevel", "rsSounds"];
ok("C9 keys the popup labels as live are really listened to by the content script (storage.onChanged)", LIVE.every((k) => new RegExp(`changes\\.${k}\\b`).test(main)), LIVE.filter((k) => !new RegExp(`changes\\.${k}\\b`).test(main)).join(","));
ok("C10 keys read only at page load are labelled 'applies when the AI page loads next' (not claimed live)", /rsSettingsAdvanced", type: "toggle", default: false, label:/.test(popupJs) && !/key: "rsSettingsAdvanced", type: "toggle", default: false, live: true/.test(popupJs) && !/key: "rsDebugDiagnostics"[^}]*live: true/.test(popupJs) && !/key: "rsCustomPrompt"[^}]*live: true/.test(popupJs) && /Applies when the AI page loads next/.test(popupJs));
ok("C11 error viewer explains the real bridge error codes", ["STUDIO_BRIDGE_OFFLINE", "MCP_SERVER_UNAVAILABLE", "MCP_REQUEST_TIMEOUT", "STUDIO_TIMEOUT", "ENGINE_MISMATCH", "BRIDGE_PROTOCOL_ERROR", "BRIDGE_COMMAND_FAILED", "SCRIPT_NOT_FOUND", "SCRIPT_NOT_READABLE", "MCP_CONNECTION_CLOSED"].every((c) => popupJs.includes(c + ":")) && ["STUDIO_BRIDGE_OFFLINE", "SCRIPT_NOT_FOUND", "MCP_CONNECTION_CLOSED", "BRIDGE_PROTOCOL_ERROR"].every((c) => bg.includes(c)));
ok("C12 diagnostics export never includes secrets or conversations (local_root masked, no API keys read)", /local_root: s\.local_root \? "\(set\)" : ""/.test(popupJs) && !/ccApiKey|deepseekApiKey|apiKey/.test(popupJs));
ok("C13 pinned work-mode / access / donate markup is intact", popupHtml.includes('<button type="button" class="work-card" data-work="creation" id="work-creation">') && (popupHtml.match(/class="work-card" data-work="/g) || []).length === 4 && popupHtml.includes('<div class="card" id="donate-card">') && (popupHtml.match(/class="dono dono-\d"/g) || []).length === 4);

// ── D. other extension pages ──
ok("D1 welcome.html uses the shared tokens + kit and keeps the hello pins", welcome.includes('href="ui/tokens.css"') && welcome.includes('href="ui/components.css"') && /class="ts-btn primary" id="open-ai"/.test(welcome) && /<h1 id="hello-title">Hello! <span>/.test(welcome) && /shown once, right after installation/.test(welcome) && !/box-shadow:[^;]*rgba\(34,211,238/.test(welcome));
ok("D2 welcome.js follows the popup's Appearance choice", /tsPopup/.test(welcomeJs) && /data-ts-theme/.test(welcomeJs) && /data-accent/.test(welcomeJs));
ok("D3 codecraft.html links the tokens before its own sheet; codecraft.css takes font/mono/focus/duration from them and keeps its amber palette + light flag", codecraft.indexOf('href="ui/tokens.css"') > 0 && codecraft.indexOf('href="ui/tokens.css"') < codecraft.indexOf('href="ui/codecraft.css"') && /--cc-font: var\(--ts-font/.test(ccCss) && /--cc-mono: var\(--ts-mono/.test(ccCss) && /--cc-focus: var\(--ts-focus/.test(ccCss) && /--cc-accent: #f5c542/.test(ccCss) && /html\.rs-light/.test(ccCss) && /:focus-visible/.test(ccCss));
ok("D4 manifest unchanged where it matters: MV3, popup.html, permissions, no new host permissions, CSP allows the stylesheets (self)", manifest.manifest_version === 3 && manifest.action.default_popup === "popup.html" && !manifest.side_panel && !manifest.commands && /style-src 'self'/.test(manifest.content_security_policy.extension_pages));

// ── E. overlay (settings tray) ──
ok("E1 main.js: decorateMenu() builds search + section chips after buildMenu renders, from .rs-sec-label text (no duplicate markup)", /function decorateMenu\(\)/.test(main) && /try \{ decorateMenu\(\); \} catch \{\}/.test(main) && /rs-menu-chip/.test(main) && /\.rs-sec-label > span/.test(main));
ok("E2 main.js: popup → rs-open-cards opens the cards window next to rs-open-menu", /msg\.type === "rs-open-cards"/.test(main) && /ui\.openTray\(tab\)/.test(main));
ok("E3 overlay.css: 2.12.0 block is appended LAST (wins the cascade), styles the nav, focus rings, wrapping, ligatures off, reduced motion; hero image kept", overlay.indexOf("/* ═══", overlay.lastIndexOf("2.12.0 — settings tray navigation")) === -1 && overlay.lastIndexOf("2.12.0 — settings tray navigation") > overlay.length - 9000 && /\.rs-menu-nav \{ position: sticky/.test(overlay) && /#rs-menu \[data-rs-filtered\] \{ display: none !important; \}/.test(overlay) && /font-variant-ligatures: none/.test(overlay) && /#rs-menu button:focus-visible/.test(overlay) && overlay.includes(".rs-menu-head") && overlay.includes("ui/hero.jpg"));
ok("E4 overlay.css: tray row labels wrap per WORD, never letter-by-letter — flex-row labels (.rs-tip-opt / .rs-site-name / .rs-mcp-name / toast message) use break-word, `anywhere` (one-glyph min-content) is gone from the 2.18.0 block and the section label keeps its ::before rule left-aligned", (() => {
  const block = overlay.slice(overlay.lastIndexOf("2.12.0 — settings tray navigation"));
  return !/overflow-wrap:\s*anywhere/.test(block) && /#rs-menu \.rs-tip-opt > span:first-child, #rs-menu \.rs-site-name > span:first-child, #rs-menu \.rs-mcp-name \{ overflow-wrap: break-word; \}/.test(block) && /\.rs-toast-m \{ min-width: 0; overflow-wrap: break-word; \}/.test(overlay) && !/\.rs-sec-label \{[^}]*space-between/.test(block) && /\.rs-sec-label > span:first-child \{ flex: none; white-space: nowrap; margin-right: auto; \}/.test(block) && !/#rs-root pre[^{]*\{[^}]*white-space: pre-wrap/.test(block);
})());
ok("E5 popup / welcome: descriptive row text (title, sub, connection state, checklist, toggle sub, activity text) uses break-word too; `anywhere` stays only on code / pre / kv / .ts-wrap where any-character breaks are wanted", /\.ts-row-title \{[^}]*overflow-wrap: break-word/.test(comps) && /\.ts-row-sub \{[^}]*overflow-wrap: break-word/.test(comps) && /\.tgl-sub \{[^}]*overflow-wrap: break-word/.test(pcss) && /\.act-text \{[^}]*overflow-wrap: break-word/.test(pcss) && /\.conn-state \{[^}]*overflow-wrap: break-word/.test(pcss) && /#start-steps li \{[^}]*overflow-wrap: break-word/.test(pcss) && /ol li span\{[^}]*overflow-wrap:break-word/.test(welcome) && /\.ts-page pre \{[^}]*overflow-wrap: anywhere/.test(comps));

// ── F. background: activity center ──
ok("F1 background.js: bounded activity ring (200) in chrome.storage.session, serialised writes, pushed as rs-activity", /const ACTIVITY_MAX = 200/.test(bg) && /const ACTIVITY_KEY = "tsActivity"/.test(bg) && /chrome\.storage\.session\.set\(\{ \[ACTIVITY_KEY\]: ring \}\)/.test(bg) && /while \(ring\.length > ACTIVITY_MAX\) ring\.shift\(\)/.test(bg) && /type: "rs-activity", item/.test(bg) && /activityWrite = activityWrite\.then/.test(bg));
ok("F2 background.js: activity_log / activity_clear messages", /case "activity_log":/.test(bg) && /case "activity_clear":/.test(bg) && /clearActivity\(\)/.test(bg));
ok("F3 background.js: hooks at the real events (socket open/close, tool result, server restart, engine switch, add/remove server, Blender link, reconnect)", (bg.match(/pushActivity\(/g) || []).length >= 11 && /pushActivity\("conn", "ok", `Bridge connected/.test(bg) && /pushActivity\("tool", "error"/.test(bg) && /pushActivity\("engine", "info"/.test(bg) && /pushActivity\("blender"/.test(bg) && /pushActivity\("server"/.test(bg));
ok("F4 background.js: entries carry text/tool/code/ms only — no prompt or conversation payload, text capped at 300 chars", /text: String\(text \|\| ""\)\.slice\(0, 300\)/.test(bg) && !/pushActivity\([^)]*msg\.arguments/.test(bg) && !/pushActivity\([^)]*r\.text/.test(bg));
ok("F5 popup leans on pushes: one initial status, rs-status / rs-activity listeners, slow 10 s safety poll only", /setInterval\(refresh, 10000\)/.test(popupJs) && !/setInterval\(refresh, 2000\)/.test(popupJs) && /msg\.type === "rs-activity" && msg\.item\) onActivityPush/.test(popupJs));

// ── G. jsdom: decorateMenu on a synthetic tray ──
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (JSDOM) {
  const src = main.slice(main.indexOf("    function decorateMenu() {"), main.indexOf("    function buildMenu() {"));
  const dom = new JSDOM(`<!DOCTYPE html><div id="rs-menu">
    <div class="rs-menu-head"><span class="rs-menu-logo">Settings</span></div>
    <section class="rs-menu-sec"><div class="rs-sec-label"><span>Switch AI</span></div><button class="rs-site-opt">DeepSeek</button><button class="rs-site-opt">Claude</button></section>
    <section class="rs-menu-sec"><div class="rs-sec-label"><span>Agent modes</span></div><div class="rs-mode-row" data-mode="autofix">Auto-fix playtest hataları</div><div class="rs-mode-row" data-mode="plan">Plan mode</div></section>
    <section class="rs-menu-sec rs-adv"><div class="rs-sec-label"><span>Keyboard shortcuts</span></div><label><input data-keybind="menu"></label></section>
    <section class="rs-menu-sec"><div class="rs-sec-label"><span>Donate</span></div><button class="rs-tip-opt">Küçük teşekkür</button></section>
  </div>`, { pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.Element.prototype.scrollIntoView = function () { w.__scrolled = this.id; };
  const fn = new w.Function("menuEl", "document", src + "\n decorateMenu(); return menuEl;");
  const menuEl = d.getElementById("rs-menu");
  fn(menuEl, d);
  const nav = menuEl.querySelector(".rs-menu-nav");
  ok("G1 decorateMenu inserts the nav right after the head with one chip per labelled section", nav && nav.previousElementSibling.className === "rs-menu-head" && [...nav.querySelectorAll(".rs-menu-chip")].map((c) => c.textContent).join("|") === "Switch AI|Agent modes|Keyboard shortcuts|Donate");
  ok("G2 advanced-only sections get an rs-adv chip (hidden in the simple view by CSS)", nav.querySelector(".rs-menu-chip.rs-adv").textContent === "Keyboard shortcuts");
  const input = nav.querySelector("input");
  input.value = "hatalar"; input.dispatchEvent(new w.Event("input"));
  const hidden = [...menuEl.querySelectorAll("[data-rs-filtered]")];
  ok("G3 searching 'hatalar' (Turkish) keeps the Auto-fix row and hides the other rows and sections", !menuEl.querySelector('[data-mode="autofix"]').hasAttribute("data-rs-filtered") && menuEl.querySelector('[data-mode="plan"]').hasAttribute("data-rs-filtered") && menuEl.querySelectorAll("section[data-rs-filtered]").length === 3 && hidden.length >= 4 && menuEl.classList.contains("rs-menu-searching"));
  input.value = "şeker"; input.dispatchEvent(new w.Event("input"));
  ok("G4 no match → every section hidden + an empty-state line (and it clears again)", menuEl.querySelectorAll("section[data-rs-filtered]").length === 4 && menuEl.querySelector(".rs-menu-empty") && (input.value = "", input.dispatchEvent(new w.Event("input")), menuEl.querySelectorAll("[data-rs-filtered]").length === 0 && !menuEl.querySelector(".rs-menu-empty")));
  nav.querySelectorAll(".rs-menu-chip")[3].click();
  ok("G5 a chip scrolls to its section and marks itself current", w.__scrolled === "rs-menu-sec-3" && nav.querySelectorAll(".rs-menu-chip")[3].classList.contains("on"));
  const stop = { stopped: false }; const ev = new w.KeyboardEvent("keydown", { key: "a", bubbles: true }); ev.stopPropagation = () => { stop.stopped = true; }; input.dispatchEvent(ev);
  ok("G6 typing in the tray search never leaks to the page's keyboard shortcuts", stop.stopped);
} else console.log("SKIP  G (jsdom not installed)");

console.log(`test-extension-design: ${passed} passed, ${failed} failed`);
