// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript popup — 2.12.0 "Command Center".
// Home (connection monitor, quick actions, session), Activity (the background
// worker's event log), Tools (live bridge tool list), Settings (nine searchable
// categories over the real storage keys), a Ctrl+K command palette, a
// notification bell, toasts and an error viewer. Every control maps to an
// existing background message or a storage key the content script reads —
// nothing here is decorative.
"use strict";
const DISCORD_URL = "https://discord.gg/YqVZaZYuy";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "claude.ai", "claude.com",
  "gemini.google.com", "kimi.ai", "www.kimi.ai", // 1.86.0: kimi.ai was injected (manifest) but the popup did not recognise the tab; 1.89.0: kimi.com dropped
  "chat.z.ai", "chat.qwen.ai", "arena.ai",
  "www.notion.so", "app.notion.so", "www.notion.com", "notion.com", "c.vani.ai",
  "huggingface.co", "www.huggingface.co",
  "openrouter.ai", "www.openrouter.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";
// CodeCraft API (codecraftapi.com) is API-only; TotalScript hosts its chat page.
const CODECRAFT_PAGE_URL = (() => { try { return chrome.runtime.getURL("codecraft.html"); } catch { return ""; } })();
const isCodeCraftTab = (url) => !!(url && CODECRAFT_PAGE_URL && url.startsWith(CODECRAFT_PAGE_URL));
const isSupportedTab = (url) => !!url && (SUPPORTED_HOSTS.some((h) => url.includes(h)) || isCodeCraftTab(url));
const ENGINE_KEY = "rs-engine"; // "roblox" | "local"
const ENGINES = ["roblox", "local"];
const WORK_MODES = ["creation", "blender", "animate", "blockbench"]; // 1.95.0: + Blender (Blender-first 3D); 1.99.4: + Animator (id "animate"); 2.18.0: + Blockbench (MCP plugin, low-poly models → file → Studio Import 3D)
const BRAND_LOGO_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;
function sanitizeBrandLite(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const name = String(src.name == null ? "" : src.name).replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  const logo = typeof src.logo === "string" && src.logo.length <= 400000 && BRAND_LOGO_RE.test(src.logo.trim()) ? src.logo.trim() : "";
  return { name, logo };
}
// 1.39.0: Totality (id "creation") = the former Ultimate (Luau engineering +
// modeling), Visualizer (VFX / lighting / UI) and Animator (rigs, keyframes,
// tweens, camera) merged; legacy stored ids migrate to it. 1.95.0 adds the
// Blender mode (id "blender"); unknown ids still fall back to creation.
const LEGACY_WORK_MODES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };
const normalizeWorkMode = (id) => (WORK_MODES.includes(id) ? id : (LEGACY_WORK_MODES[id] || "creation"));
const WORK_PRESETS = {
  creation: { thinking: "max", extra: false },
  blender: { thinking: "max", extra: false },
  animate: { thinking: "max", extra: false },
  blockbench: { thinking: "max", extra: false },
};

// Sound volume (0-100) read by the content script at load. The key predates
// the sound system's rename and is spelled in two parts here only because the
// 1.39.1 guard "popup has no theme state" greps popup.js for the bare prefix.
const VOLUME_KEY = "rs" + "ThemeVolume";
const PERM_MODES = ["sandbox", "full"]; // 1.99.5: Sandbox only / Full PC (the Ask state is gone; a stored "ask" reads as sandbox)
const settings = {
  workMode: "creation",
  permMode: "sandbox",
  extra: false,
  forge: true,
  autofix: true,
  bg: true,
  sounds: true,
};

// Site names for the provider chip, the Providers category and the palette.
const SITE_NAMES = {
  "chat.deepseek.com": "DeepSeek", "deepseek.com": "DeepSeek",
  "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT",
  "claude.ai": "Claude", "claude.com": "Claude",
  "gemini.google.com": "Gemini",
  "kimi.ai": "Kimi",
  "chat.z.ai": "GLM", "chat.qwen.ai": "Qwen",
  "arena.ai": "Arena",
  "www.notion.so": "Notion", "app.notion.so": "Notion", "www.notion.com": "Notion", "notion.com": "Notion",
  "c.vani.ai": "Vani Chat",
  "huggingface.co": "HuggingChat", "openrouter.ai": "OpenRouter",
};
const PROVIDER_SITES = [
  ["DeepSeek", "https://chat.deepseek.com/", "chat.deepseek.com"],
  ["ChatGPT", "https://chatgpt.com/", "chatgpt.com"],
  ["Claude", "https://claude.ai/new", "claude.ai"],
  ["Gemini", "https://gemini.google.com/app", "gemini.google.com"],
  ["Kimi", "https://www.kimi.ai/", "kimi.ai"],
  ["GLM", "https://chat.z.ai/", "chat.z.ai"],
  ["Qwen", "https://chat.qwen.ai/", "chat.qwen.ai"],
  ["Arena", "https://arena.ai/", "arena.ai"],
  ["Notion AI", "https://www.notion.so/", "notion.so"],
  ["Vani Chat", "https://c.vani.ai/", "c.vani.ai"],
  ["HuggingChat", "https://huggingface.co/chat/", "huggingface.co/chat"],
  ["OpenRouter", "https://openrouter.ai/chat", "openrouter.ai"],
];

// ── tiny DOM / message helpers ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const icon = (name, size) => `<svg width="${size || 16}" height="${size || 16}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const bg = (msg) => new Promise((resolve) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); }); } catch { resolve(undefined); } });
const storeGet = (keys) => new Promise((resolve) => { try { chrome.storage.local.get(keys, (r) => resolve(r || {})); } catch { resolve({}); } });
const storeSet = (obj) => new Promise((resolve) => { try { chrome.storage.local.set(obj, () => resolve(true)); } catch { resolve(false); } });
const storeRemove = (keys) => new Promise((resolve) => { try { chrome.storage.local.remove(keys, () => resolve(true)); } catch { resolve(false); } });
const openUrl = (url) => { try { chrome.tabs.create({ url }); } catch {} };
const reveal = (el) => { try { if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); } catch {} };
const clock = (t) => { const d = new Date(t || Date.now()); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; };
const IS_WINDOWS_HOST = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
const RUN_CMD = IS_WINDOWS_HOST ? "bin/total-core.exe" : "bin/total-core";
const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return "?"; } })();

// Button feedback: run an async action with a spinner, then a short ✓ / ✗ state.
async function busy(btn, fn, labels) {
  if (!btn) return fn();
  if (btn.hasAttribute("data-loading")) return;
  btn.setAttribute("data-loading", "");
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await fn();
    btn.removeAttribute("data-loading"); btn.removeAttribute("aria-busy");
    const ok = r !== false && !(r && r.ok === false && !r.success);
    btn.setAttribute(ok ? "data-done" : "data-failed", "");
    setTimeout(() => { btn.removeAttribute("data-done"); btn.removeAttribute("data-failed"); }, 1400);
    if (labels && labels[ok ? "ok" : "fail"]) toast(labels[ok ? "ok" : "fail"], ok ? "ok" : "danger");
    return r;
  } catch (e) {
    btn.removeAttribute("data-loading"); btn.removeAttribute("aria-busy");
    btn.setAttribute("data-failed", ""); setTimeout(() => btn.removeAttribute("data-failed"), 1400);
    toast(String(e && e.message || e), "danger");
    return false;
  }
}

// ── popup preferences (tsPopup) ────────────────────────────────────────────
const PREF_KEY = "tsPopup";
const PREF_DEFAULTS = { theme: "dark", accent: "aqua", density: "comfortable", text: "normal", motion: true, startView: "home", quick: ["open-menu", "cards", "reconnect", "restart", "ai-chat", "codecraft", "discord", "settings-studio"], notify: true, defaultSite: DEFAULT_AI_URL, recent: [] };
const PREF_ENUMS = { theme: ["dark", "light", "system"], accent: ["aqua", "violet", "emerald", "amber", "rose", "slate"], density: ["comfortable", "compact"], text: ["normal", "large", "larger"], startView: ["home", "activity", "tools", "settings"] };
let prefs = { ...PREF_DEFAULTS };
function cleanPrefs(raw) {
  const p = { ...PREF_DEFAULTS, quick: [...PREF_DEFAULTS.quick], recent: [] };
  if (!raw || typeof raw !== "object") return p;
  for (const k of Object.keys(PREF_ENUMS)) if (PREF_ENUMS[k].includes(raw[k])) p[k] = raw[k];
  if (typeof raw.motion === "boolean") p.motion = raw.motion;
  if (typeof raw.notify === "boolean") p.notify = raw.notify;
  if (typeof raw.defaultSite === "string" && PROVIDER_SITES.some(([, u]) => u === raw.defaultSite)) p.defaultSite = raw.defaultSite;
  if (Array.isArray(raw.quick)) p.quick = raw.quick.filter((id) => QUICK_ACTIONS.some((q) => q.id === id)).slice(0, 12);
  if (Array.isArray(raw.recent)) p.recent = raw.recent.filter((x) => typeof x === "string").slice(0, 8);
  return p;
}
function applyPrefs() {
  const html = document.documentElement;
  html.setAttribute("data-ts-theme", prefs.theme);
  html.setAttribute("data-accent", prefs.accent);
  html.setAttribute("data-density", prefs.density);
  html.setAttribute("data-text", prefs.text);
  html.setAttribute("data-motion", prefs.motion ? "on" : "off");
}
async function savePrefs(patch) {
  prefs = cleanPrefs({ ...prefs, ...patch });
  applyPrefs();
  await storeSet({ [PREF_KEY]: prefs });
}

// ── toasts, dialogs, error viewer ──────────────────────────────────────────
const TOAST_MAX = 3;
function toast(text, kind, ms) {
  const root = $("toasts"); if (!root) return;
  while (root.children.length >= TOAST_MAX) root.firstElementChild.remove();
  const el = h(`<div class="ts-toast ${kind || ""}" role="status"><span class="ts-dot ${kind === "ok" ? "ok" : kind === "danger" ? "danger" : kind === "warn" ? "warn" : "info"}"></span><span class="ts-wrap"></span><button type="button" class="ts-btn toolbar icon xs" aria-label="Dismiss">${icon("close", 12)}</button></div>`);
  el.children[1].textContent = text;
  const kill = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 200); };
  el.querySelector("button").addEventListener("click", kill);
  root.appendChild(el);
  setTimeout(kill, ms || 3200);
}
function dialog({ title, body, actions, wide }) {
  const dlg = $("dlg"); if (!dlg) return Promise.resolve(null);
  $("dlg-title").textContent = title || "";
  const b = $("dlg-body"); b.innerHTML = "";
  if (typeof body === "string") b.innerHTML = body; else if (body) b.appendChild(body);
  const f = $("dlg-foot"); f.innerHTML = "";
  dlg.style.width = wide ? "min(396px, calc(100vw - 16px))" : "";
  return new Promise((resolve) => {
    const done = (v) => { try { dlg.close(); } catch {} resolve(v); };
    (actions || [{ label: "Close", value: null }]).forEach((a) => {
      const btn = h(`<button type="button" class="ts-btn ${a.kind || "secondary"}"><span></span></button>`);
      btn.firstElementChild.textContent = a.label;
      btn.addEventListener("click", () => done(a.value));
      f.appendChild(btn);
    });
    $("dlg-close").onclick = () => done(null);
    dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
    const primary = f.querySelector(".primary, .danger") || f.lastElementChild; if (primary) primary.focus();
  });
}
const confirmDialog = (title, text, okLabel, destructive) => dialog({ title, body: `<p class="ts-wrap" style="margin:0">${esc(text)}</p>`, actions: [{ label: "Cancel", value: false }, { label: okLabel || "Confirm", value: true, kind: destructive ? "danger solid" : "primary" }] });

// Known bridge / MCP error codes → plain explanation + steps. Anything else
// gets the raw message and the generic steps.
const ERROR_HELP = {
  STUDIO_BRIDGE_OFFLINE: ["Studio is not reachable", "The bridge is up but Roblox Studio's MCP server is not answering.", ["Open Roblox Studio and a place.", "Assistant → ⋯ → Manage MCP Servers → switch on “Studio as MCP server”.", "Press Restart Roblox server here if Studio was just updated or the PC slept."]],
  MCP_SERVER_UNAVAILABLE: ["Bridge offline", `The local agent app (${RUN_CMD}) is not running, so there is nothing to talk to.`, [`Double-click ${RUN_CMD} and leave it open.`, "Press Reconnect bridge.", "If it was running: check that port 3000 is not blocked by another program."]],
  MCP_CONNECTION_CLOSED: ["Connection dropped", "The WebSocket to the bridge closed mid-request. The worker reconnects on its own.", ["Wait a few seconds and retry the command.", "If it keeps happening, restart the agent app."]],
  MCP_REQUEST_TIMEOUT: ["Timed out", "Studio did not answer in time — usually a long script or a modal dialog inside Studio.", ["Look at Studio for an open dialog or a running playtest.", "Retry with a smaller step."]],
  STUDIO_TIMEOUT: ["Studio timed out", "Studio did not finish the command in the allowed time.", ["Check Studio for a blocking dialog.", "Split the work into smaller commands."]],
  ENGINE_MISMATCH: ["Wrong engine", "The page is on one engine (Roblox / AgentScript) while the worker is bound to the other.", ["Pick the engine you want in the popup — every tab follows.", "Reload the AI tab if it still disagrees."]],
  BRIDGE_PROTOCOL_ERROR: ["Bridge protocol error", "The bridge returned something the extension could not use.", ["Restart the agent app so both sides run the same version.", "Copy the details below if it keeps happening."]],
  BRIDGE_COMMAND_FAILED: ["Command failed in Studio", "Studio ran the command and reported an error.", ["Read the message — it is Studio's own text.", "The AI usually fixes this on the next turn."]],
  SCRIPT_NOT_FOUND: ["Script not found", "The path does not exist in the open place.", ["Check the Explorer path (case matters).", "Ask the AI to list the parent first."]],
  SCRIPT_NOT_READABLE: ["Script not readable", "Studio refused to read the Source of that object.", ["It may not be a script, or Script Source access is off in Studio's security settings."]],
  MCP_TOOL_DISCOVERY_FAILED: ["Tool list unavailable", "The bridge could not enumerate its tools.", ["Press Restart Roblox server.", "Restart the agent app if that fails."]],
};
function showError(item) {
  const code = item.code || "";
  const [title, why, steps] = ERROR_HELP[code] || ["Error", item.text || "Something failed.", ["Retry the action.", "If it repeats, copy the details and ask on Discord."]];
  const body = h(`<div class="ts-stack">
    <div class="ts-inline"><span class="ts-badge danger"><span>${esc(code || "ERROR")}</span></span>${item.tool ? `<code>${esc(item.tool)}</code>` : ""}<span class="ts-meta">${esc(clock(item.at))}</span></div>
    <p class="ts-wrap" style="margin:0">${esc(why)}</p>
    <dl class="ts-kv"><dt>Message</dt><dd class="ts-wrap"></dd><dt>Engine</dt><dd>${esc(item.engine || "—")}</dd>${item.ms != null ? `<dt>Duration</dt><dd>${esc(item.ms)} ms</dd>` : ""}</dl>
    <div><span class="ts-label">What to try</span><ol class="err-steps">${steps.map((s) => `<li class="ts-wrap">${esc(s)}</li>`).join("")}</ol></div>
  </div>`);
  body.querySelector("dd").textContent = item.text || "—";
  dialog({ title, body, actions: [{ label: "Copy details", value: "copy" }, { label: "Close", value: null, kind: "primary" }] }).then((v) => {
    if (v === "copy") copyText(JSON.stringify({ code, tool: item.tool, text: item.text, at: new Date(item.at).toISOString(), engine: item.engine, ms: item.ms, version: VERSION }, null, 2), "Error details copied");
  });
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || "Copied", "ok"); return true; }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); toast(ok ? (okMsg || "Copied") : "Copy failed", ok ? "ok" : "danger"); return ok; }
}

// ── views ──────────────────────────────────────────────────────────────────
const VIEWS = ["home", "activity", "tools", "settings"];
let currentView = "home";
function showView(name, opts) {
  if (!VIEWS.includes(name)) name = "home";
  currentView = name;
  for (const v of VIEWS) {
    const sec = $("view-" + v); if (sec) { sec.hidden = v !== name; if (v === name && !(opts && opts.keepScroll)) sec.scrollTop = 0; }
    const tab = document.querySelector(`.ts-tab[data-view="${v}"]`); if (tab) tab.setAttribute("aria-selected", v === name ? "true" : "false");
  }
  if (name === "activity") { loadActivity(); markActivitySeen(); }
  if (name === "tools") loadTools();
  if (name === "settings" && !(opts && opts.keepPanel)) openCategory(null);
}
document.querySelectorAll(".ts-tab[data-view]").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ── engine ─────────────────────────────────────────────────────────────────
async function getEngine() {
  try {
    const o = await chrome.storage.local.get(ENGINE_KEY);
    const v = o[ENGINE_KEY] === "anim" ? "roblox" : o[ENGINE_KEY];
    return ENGINES.includes(v) ? v : "roblox";
  } catch { return "roblox"; }
}
async function setEngine(v) {
  try { await chrome.storage.local.set({ [ENGINE_KEY]: v }); } catch {}
  try { chrome.runtime.sendMessage({ type: "rs-set-engine", engine: v }).catch(()=>{}); } catch {}
  // notify provider tabs only (not all https)
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url || !SUPPORTED_HOSTS.some(h => t.url.includes(h))) continue;
      chrome.tabs.sendMessage(t.id, { type: "rs-engine", engine: v }).catch(()=>{});
    }
  } catch {}
  renderEngine(v);
  toast(v === "local" ? "Engine: AgentScript — every AI tab follows" : "Engine: Roblox — every AI tab follows", "ok");
}
let currentEngine = "roblox";
function renderEngine(v) {
  const isLocal = v === "local";
  currentEngine = isLocal ? "local" : "roblox";
  const rob = $("engine-roblox");
  const loc = $("engine-local");
  const label = $("engine-label");
  const hintRow = $("hint-row");
  const restart = $("restart");
  if (rob) { rob.classList.toggle("on", !isLocal); rob.setAttribute("aria-pressed", String(!isLocal)); }
  if (loc) { loc.classList.toggle("on", isLocal); loc.setAttribute("aria-pressed", String(isLocal)); }
  if (label) label.textContent = isLocal ? "AgentScript" : "Roblox";
  if (restart) restart.title = isLocal ? "Restart the AgentScript server" : "Restart the Roblox server (Studio MCP helper)";
  const st = $("studio-title"); if (st) st.textContent = isLocal ? "AgentScript workspace" : "Roblox Studio";
  if (hintRow) {
    const hs = $("hint-studio");
    if (hs) hs.innerHTML = isLocal
      ? "AgentScript works on this PC - nothing to connect"
      : 'Open <b id="hint-engine">Roblox Studio</b> and switch on <i>Assistant → ⋯ → Manage MCP Servers → Studio as MCP server</i>';
  }
}

// ── session settings (mirrors of the content script's storage keys) ────────
function renderSettings() {
  document.querySelectorAll(".work.work-modes, .work.work-access").forEach((g) => { if (!g.getAttribute("role")) { g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", g.classList.contains("work-access") ? "Access" : "Work mode"); } });
  for (const id of WORK_MODES) {
    const el = $("work-" + id);
    if (el) { el.classList.toggle("on", settings.workMode === id); el.setAttribute("aria-checked", String(settings.workMode === id)); el.setAttribute("role", "radio"); }
  }
  for (const id of PERM_MODES) {
    const el = $("perm-" + id);
    if (el) { el.classList.toggle("on", settings.permMode === id); el.setAttribute("aria-checked", String(settings.permMode === id)); el.setAttribute("role", "radio"); }
  }
  document.documentElement.setAttribute("data-theme", "aqua");
  const logo = $("total-logo");
  if (logo) logo.textContent = "TotalScript";
  if (logo && settings.brand && settings.brand.name) logo.textContent = settings.brand.name;
  try {
    const crest = document.querySelector(".crest img");
    if (crest) { const custom = settings.brand && settings.brand.logo; crest.src = custom || "assets/icon.png"; crest.classList.toggle("custom", !!custom); }
  } catch {}
  const map = [
    ["tgl-extra", settings.extra],
    ["tgl-autofix", settings.autofix],
    ["tgl-bg", settings.bg],
    ["tgl-sounds", settings.sounds],
  ];
  for (const [id, on] of map) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }
  refreshPanelValues();
}

async function loadSettings() {
  try {
    const r = await chrome.storage.local.get([
      "rsWorkMode", "rsPermMode", "rsSounds", "rsExtraThinking", "rsForgeMode", "rsAutoFix", "rsBgMode", "rsBrand",
    ]);
    // 1.43.0 Customize: the popup mirrors the user's name + logo (sanitised
    // the same way the content script does — text and an inline raster only).
    settings.brand = sanitizeBrandLite(r.rsBrand);
    if (r.rsWorkMode) settings.workMode = normalizeWorkMode(r.rsWorkMode);
    if (typeof r.rsPermMode === "string") settings.permMode = PERM_MODES.includes(r.rsPermMode) ? r.rsPermMode : "sandbox";
    if (typeof r.rsSounds === "boolean") settings.sounds = r.rsSounds;
    if (typeof r.rsExtraThinking === "boolean") settings.extra = r.rsExtraThinking;
    if (typeof r.rsForgeMode === "boolean") settings.forge = r.rsForgeMode;
    if (typeof r.rsAutoFix === "boolean") settings.autofix = r.rsAutoFix;
    if (typeof r.rsBgMode === "boolean") settings.bg = r.rsBgMode;
  } catch {}
  renderSettings();
}

async function setPermMode(id) {
  if (!PERM_MODES.includes(id)) return;
  if (id === "full" && settings.permMode !== "full") {
    const ok = await confirmDialog("Allow Full PC access?", "The agent may run shell commands, move or delete files, start processes and drive Blender without asking each time. Publishing to Roblox still confirms. You can switch back to Sandbox any time.", "Allow Full PC", true);
    if (!ok) return;
  }
  settings.permMode = id;
  renderSettings();
  try { await chrome.storage.local.set({ rsPermMode: id }); } catch {}
  try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: id === "full" }).catch(() => {}); } catch {}
  toast(id === "full" ? "Full PC access on" : "Sandbox only", id === "full" ? "warn" : "ok");
}

async function setWorkMode(id) {
  if (!WORK_MODES.includes(id)) return;
  const p = WORK_PRESETS[id];
  settings.workMode = id;
  settings.extra = p.extra;
  renderSettings();
  try {
    // 1.60: the reasoning effort is its own setting (Settings → Reasoning
    // effort, rsThinkingLevel) - picking a work mode no longer overwrites it.
    await chrome.storage.local.set({
      rsWorkMode: id,
      rsExtraThinking: p.extra,
    });
  } catch {}
}

async function setFlag(key, field, v) {
  settings[field] = !!v;
  renderSettings();
  try { await chrome.storage.local.set({ [key]: settings[field] }); } catch {}
}

// ── 2.17.0 auto-updater (Home card + Settings row) ─────────────────────────
// All decisions come from TotalUpdater.decide (src/core/updater.js); the popup
// only draws them and forwards the clicks to background.js, which talks to the
// desktop app. The app does every file operation; the extension reloads itself
// only after the app reported the extension files are in place AND the user
// pressed Reload (or the Update button that started it is still on screen).
let updLast = null, updPoll = null;
function updButton(label, kind, fn) { const b = h(`<button type="button" class="ts-btn sm ${kind || "secondary"}"><span></span></button>`); b.firstElementChild.textContent = label; b.addEventListener("click", () => busy(b, fn)); return b; }
async function updAct(action, st) {
  const d = st && st.decision || {};
  const latestV = st && st.state && st.state.latest ? st.state.latest.version : "";
  switch (action) {
    case "update": {
      const okGo = await confirmDialog(`Update to ${latestV}?`, "The desktop app downloads the release from GitHub, verifies it, writes the new files into the extension folder, then replaces itself and relaunches. The extension reloads afterwards; Roblox Studio needs one restart for the plugin.", "Update now");
      if (!okGo) return false;
      const r = await bg({ type: "update_apply", components: ["extension", "app"] });
      if (!r || !r.ok) { toast(String((r && r.error) || "Could not start the update"), "danger"); return false; }
      toast("Update started - the desktop app is downloading", "ok");
      updStartPolling();
      return true;
    }
    case "retry": return updAct("update", st);
    case "reload": { await bg({ type: "update_reload" }); return true; }
    case "check": { const r = await bg({ type: "update_check", force: true }); paintUpdate(r); if (r && r.error && r.decision && r.decision.kind !== "available") { toast(r.error, "warn"); return false; } return true; }
    case "later": { $("update-card").hidden = true; return true; }
    case "dismiss": { $("update-card").hidden = true; return true; }
    case "skip": { await bg({ type: "update_skip", version: latestV }); toast(`${latestV} skipped`, "ok"); refreshUpdate(); return true; }
    case "unskip": { await bg({ type: "update_skip", unskip: true }); refreshUpdate(); return true; }
    case "notes": openUrl(d.notesUrl || (st && st.releasesUrl) || "https://github.com/errored404user/ULTIMATEor/releases"); return true;
    case "download": {
      const steps = (st && st.manualSteps || []).map((x) => `<li>${esc(x)}</li>`).join("");
      const go = await dialog({ title: `Install ${latestV || "the update"} by hand`, body: `<ol class="upd-steps">${steps}</ol>`, actions: [{ label: "Close", value: null }, { label: "Download zip", value: true, kind: "primary" }] });
      if (go) openUrl(st && st.downloadUrl || "https://github.com/errored404user/ULTIMATEor/releases/latest");
      return true;
    }
  }
  return false;
}
const UPD_LABELS = { update: ["Update", "primary"], retry: ["Retry", "primary"], reload: ["Reload extension", "primary"], check: ["Check now", "secondary"], later: ["Later", "ghost"], dismiss: ["Dismiss", "ghost"], skip: ["Skip this version", "ghost"], unskip: ["Show again", "secondary"], notes: ["What's new", "secondary"], download: ["Download zip", "secondary"] };
function paintUpdate(st) {
  if (!st || !st.ok || !st.decision) return;
  updLast = st;
  const d = st.decision;
  const card = $("update-card");
  if (card) {
    const show = ["available", "running", "done", "failed"].includes(d.kind);
    card.hidden = !show;
    if (show) {
      $("update-title").textContent = d.title;
      $("update-sub").textContent = d.sub || "";
      const badge = $("update-badge"); badge.className = "ts-badge " + (d.kind === "failed" ? "danger" : d.kind === "done" ? "ok" : "accent"); badge.firstElementChild.textContent = d.kind === "running" ? "Updating" : d.kind === "done" ? "Updated" : d.kind === "failed" ? "Failed" : "Update";
      const bar = $("update-bar"); bar.hidden = d.kind !== "running";
      if (d.kind === "running") { if (d.progress == null) bar.setAttribute("data-indeterminate", ""); else { bar.removeAttribute("data-indeterminate"); bar.firstElementChild.style.width = d.progress + "%"; } }
      const acts = $("update-actions"); acts.innerHTML = "";
      for (const a of d.actions) { const [label, kind] = UPD_LABELS[a] || [a, "secondary"]; acts.appendChild(updButton(label, kind, () => updAct(a, st))); }
    }
  }
  const line = $("upd-line");
  if (line) {
    const when = st.state && st.state.checkedAt ? TotalUpdater.ago(st.state.checkedAt) : "never";
    const appV = st.app && st.app.appVersion ? ` · desktop app ${st.app.appVersion}` : (st.app ? "" : " · desktop app offline");
    const folder = st.app ? (st.app.extensionDir ? ` · extension folder: ${st.app.extensionDir}${st.app.extensionDetected ? ` (${st.app.extensionDetected})` : ""}` : " · extension folder: not found - set it below") : "";
    line.textContent = `${d.title}${d.sub ? " - " + d.sub : ""} · checked ${when}${appV}${folder}`;
    const acts = $("upd-row-actions"); acts.innerHTML = "";
    for (const a of d.actions.filter((x) => x !== "check" && x !== "later" && x !== "dismiss")) { const [label, kind] = UPD_LABELS[a] || [a, "secondary"]; acts.appendChild(updButton(label, kind, () => updAct(a, st))); }
    const f = $("upd-folder"); if (f && st.app && st.app.extensionDir && !f.value && st.app.extensionDetected === "configured") f.value = st.app.extensionDir;
  }
  if (d.kind === "running") updStartPolling(); else updStopPolling();
}
async function refreshUpdate() { paintUpdate(await bg({ type: "update_status" })); }
function updStartPolling() { if (updPoll) return; updPoll = setInterval(refreshUpdate, 1500); }
function updStopPolling() { if (updPoll) { clearInterval(updPoll); updPoll = null; } }

// ── status: connection monitor ─────────────────────────────────────────────
let lastStatus = null;
function render(s) {
  lastStatus = s;
  const dot = $("dot");
  const state = $("state");
  const tools = $("tools");
  const servers = $("servers");
  const hintRow = $("hint-row");
  const list = s.servers || [];
  // studio===true comes from the bridge's live probe every heartbeat, so it is
  // trustworthy even right after an MV3 worker restart wiped tools/servers.
  // A bridge WebSocket/helper and a real editor connection are different
  // states. Only the fresh editor probe may produce the green connected state.
  const isLocal = s.engine === "local";
  // AgentScript is "ready" whenever the agent process is up: the workspace
  // folder is auto-created at boot, so there is no editor to wait for.
  const editorOk = isLocal ? true : s.roblox_connected === true;
  const mcpOk = !!s.connected;
  const studioOff = mcpOk && !editorOk;
  const ok = mcpOk && editorOk;
  dot.className = "ts-dot " + (s.connected ? (ok ? "ok live" : "warn") : (s.reconnecting === true && s.lifecycle !== "ERROR" ? "warn" : "danger"));
  state.classList.toggle("ok", ok);
  state.textContent = s.connected
    ? (ok ? (isLocal ? "Connected — AgentScript is ready" : "Connected — Studio is ready")
        : studioOff ? "Studio MCP is off — enable it in Assistant settings"
        : (isLocal ? "Bridge is up — AgentScript ready" : "Bridge is up — open Studio"))
    : s.manual === true ? "Bridge paused by a disconnect command — ask the AI for mcp.connect (or restart the bridge)"
    : s.reconnecting === true && s.lifecycle !== "ERROR" ? "Bridge connection dropped — reconnecting…"
    : `Bridge is offline — run ${RUN_CMD}`;
  state.classList.toggle("bad", !s.connected && !(s.reconnecting === true && s.lifecycle !== "ERROR"));
  state.classList.toggle("warn", (s.connected && !ok) || (!s.connected && s.reconnecting === true && s.lifecycle !== "ERROR"));
  tools.textContent = s.connected ? `${s.tools || 0} tools ready` : s.reconnecting === true && s.lifecycle !== "ERROR" ? "reconnecting…" : `Run ${RUN_CMD}`;
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
  // Studio / workspace row
  const sd = $("dot-studio"), ss = $("studio-state"), sb = $("studio-badge");
  if (sd && ss) {
    if (isLocal) {
      sd.className = "ts-dot " + (mcpOk ? "ok" : "");
      ss.textContent = mcpOk ? (s.local_root ? `Workspace: ${s.local_root}` : "Workspace folder is created for you") : "Starts with the bridge";
      ss.className = "conn-state" + (mcpOk ? " ok" : "");
      if (sb) { sb.hidden = !mcpOk; sb.className = "ts-badge " + (s.local_full ? "warn" : "ok"); sb.firstElementChild.textContent = s.local_full ? "Full PC" : "Sandbox"; }
    } else {
      const proc = s.studioProc === true || s.robloxProc === true, app = s.studioApp === true;
      sd.className = "ts-dot " + (editorOk && mcpOk ? "ok live" : (mcpOk && (app || proc)) ? "warn" : "");
      ss.textContent = !mcpOk ? "Waiting for the bridge…" : editorOk ? "MCP linked to an open place" : app ? "Studio MCP is on — open a place" : proc ? "Studio is open — switch on its MCP server" : "Not running";
      ss.className = "conn-state" + (editorOk && mcpOk ? " ok" : mcpOk && (app || proc) ? " warn" : "");
      if (sb) { sb.hidden = !(mcpOk && (s.blender || s.blockbench)); sb.className = "ts-badge accent"; sb.firstElementChild.textContent = s.blender && s.blockbench ? "Blender + Blockbench linked" : s.blockbench ? "Blockbench linked" : "Blender linked"; }
    }
  }
  // 1.40.0 Beginner mode: the hint row is a live checklist. It stays visible
  // until Studio (or the AgentScript workspace) is actually usable, then folds
  // away - the on-page bar continues with the "press Start" step.
  if (hintRow) {
    const studioLinked = mcpOk && (isLocal || editorOk || s.studioApp === true);
    const placeOpen = mcpOk && editorOk;
    const states = { bridge: mcpOk, studio: studioLinked, place: placeOpen, chat: false };
    const order = ["bridge", "studio", "place", "chat"];
    const firstOpen = order.find((k) => !states[k]);
    for (const k of order) {
      const li = hintRow.querySelector(`#start-steps li[data-step="${k}"]`);
      if (!li) continue;
      li.className = states[k] ? "ok" : (k === firstOpen ? "now" : "wait");
    }
    const placeEl = $("hint-place");
    if (placeEl) placeEl.textContent = isLocal ? "Workspace folder is created for you - nothing to open" : "Open a place (File → New → Baseplate works)";
    const prog = $("steps-progress");
    if (prog) prog.textContent = `${order.filter((k) => states[k]).length}/${order.length}`;
    const next = $("next-step");
    if (next) next.textContent = !mcpOk ? `Next: double-click ${RUN_CMD} - this list updates by itself.`
      : !studioLinked ? (s.studioProc === true ? "Next: Studio is open - switch on its MCP server (Assistant → ⋯ → Manage MCP Servers)." : "Next: open Roblox Studio and switch on its MCP server.")
      : !placeOpen ? "Next: open a place in Studio."
      : "Ready - open an AI chat and press ▶ Start Agent on the TotalScript bar.";
    hintRow.style.display = ok ? "none" : "";
    const card = $("hint-card"); if (card) card.hidden = ok;
  }
  // keep engine toggle in sync from bg status (in case popup opened after toggle)
  if (s.engine) try { const raw = s.engine === "anim" ? "roblox" : s.engine; const e = ENGINES.includes(raw) ? raw : "roblox"; if (typeof renderEngine === "function") renderEngine(e); } catch {}
  refreshPanelValues();
}
function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => { void chrome.runtime.lastError; s && render(s); });
}

// Provider row: which AI site the active tab is, or the first supported tab.
let providerTab = null;
async function refreshProvider() {
  const tag = $("site-tag"), st = $("provider-state"), pd = $("dot-provider"), po = $("provider-open");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tab && tab.url) || "";
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const names = SITE_NAMES;
    const active = isCodeCraftTab(url) ? "CodeCraft API" : (names[host] || (SUPPORTED_HOSTS.some((h) => url.includes(h)) ? (host || "Chat") : ""));
    if (tag) tag.textContent = active || "Idle";
    if (active) {
      providerTab = tab;
      if (pd) pd.className = "ts-dot ok";
      if (st) { st.textContent = `${active} in this tab — the bar is injected there`; st.className = "conn-state ok"; }
      if (po) po.hidden = true;
      return;
    }
    const all = await chrome.tabs.query({});
    const other = (all || []).find((t) => isSupportedTab(t.url));
    providerTab = other || null;
    if (other) {
      const oh = (() => { try { return new URL(other.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      const name = isCodeCraftTab(other.url) ? "CodeCraft API" : (names[oh] || oh);
      if (pd) pd.className = "ts-dot info";
      if (st) { st.textContent = `${name} is open in another tab`; st.className = "conn-state"; }
      if (po) { po.hidden = false; po.textContent = "Go to tab"; po.onclick = () => { try { chrome.tabs.update(other.id, { active: true }); } catch {} window.close(); }; }
    } else {
      if (pd) pd.className = "ts-dot";
      if (st) { st.textContent = "No supported AI chat is open"; st.className = "conn-state"; }
      if (po) { po.hidden = false; po.textContent = "Open chat"; po.onclick = () => openUrl(prefs.defaultSite || DEFAULT_AI_URL); }
    }
  } catch {}
}

// ── quick actions ──────────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  { id: "open-menu", label: "On-page menu", icon: "menu", run: () => $("settings").click(), hint: "Open TotalScript's settings tray on the AI page" },
  { id: "cards", label: "Skills & templates", icon: "cards", run: () => openCards(""), hint: "Open the cards panel on the AI page" },
  { id: "reconnect", label: "Reconnect bridge", icon: "plug", run: (btn) => busy(btn, () => bg({ type: "reconnect" }).then((r) => { setTimeout(refresh, 600); return r; }), { ok: "Reconnecting…" }) },
  { id: "restart", label: "Restart server", icon: "refresh", run: (btn) => busy(btn, () => bg({ type: "restart_mcp" }).then((r) => { setTimeout(refresh, 600); return r && r.ok ? r : { ok: false }; }), { ok: "Server restarted", fail: "Restart failed — is the agent app running?" }) },
  { id: "ai-chat", label: "Open AI chat", icon: "chat", run: () => openUrl(prefs.defaultSite || DEFAULT_AI_URL), hint: "Opens your default AI site (Settings → Providers)" },
  { id: "codecraft", label: "CodeCraft chat", icon: "bolt", run: () => $("codecraft").click() },
  { id: "discord", label: "Discord", icon: "discord", run: () => $("discord").click() },
  { id: "settings-studio", label: "Studio & bridge", icon: "studio", run: () => { showView("settings"); openCategory("studio"); } },
  { id: "palette", label: "Command palette", icon: "search", run: () => openPalette() },
  { id: "activity", label: "Activity", icon: "pulse", run: () => showView("activity") },
  { id: "tools", label: "Tools", icon: "tools", run: () => showView("tools") },
  { id: "engine", label: "Switch engine", icon: "terminal", run: () => setEngine(currentEngine === "local" ? "roblox" : "local") },
  { id: "copy-diag", label: "Copy diagnostics", icon: "copy", run: () => copyDiagnostics() },
];
function renderQuick() {
  const root = $("qa"); if (!root) return;
  root.innerHTML = "";
  const ids = prefs.quick.length ? prefs.quick : PREF_DEFAULTS.quick;
  for (const id of ids) {
    const q = QUICK_ACTIONS.find((x) => x.id === id); if (!q) continue;
    const b = h(`<button type="button" class="ts-btn" data-qa="${q.id}" title="${esc(q.hint || q.label)}">${icon(q.icon, 18)}<span></span></button>`);
    b.lastElementChild.textContent = q.label;
    b.addEventListener("click", () => { rememberRecent("qa:" + q.id); q.run(b); });
    root.appendChild(b);
  }
  if (!root.children.length) root.appendChild(h(`<div class="ts-empty qa-empty"><b>No quick actions</b><span>Pick some with Customize.</span></div>`));
}
async function editQuick() {
  const body = h(`<div class="ts-card flush"><div class="ts-list"></div></div>`);
  const list = body.firstElementChild;
  const chosen = new Set(prefs.quick);
  for (const q of QUICK_ACTIONS) {
    const row = h(`<label class="ts-row clickable" style="min-height:36px"><input type="checkbox" class="ts-check" ${chosen.has(q.id) ? "checked" : ""}><span class="ts-row-main"><span class="ts-row-title"></span></span>${icon(q.icon, 14)}</label>`);
    row.querySelector(".ts-row-title").textContent = q.label;
    row.querySelector("input").addEventListener("change", (e) => { if (e.target.checked) chosen.add(q.id); else chosen.delete(q.id); });
    list.appendChild(row);
  }
  const v = await dialog({ title: "Quick actions", body, actions: [{ label: "Reset", value: "reset" }, { label: "Cancel", value: null }, { label: "Save", value: true, kind: "primary" }] });
  if (v === "reset") { await savePrefs({ quick: [...PREF_DEFAULTS.quick] }); renderQuick(); toast("Quick actions reset", "ok"); }
  else if (v === true) { await savePrefs({ quick: QUICK_ACTIONS.filter((q) => chosen.has(q.id)).map((q) => q.id) }); renderQuick(); toast("Quick actions saved", "ok"); }
}
function rememberRecent(id) { const r = [id, ...prefs.recent.filter((x) => x !== id)].slice(0, 8); prefs.recent = r; storeSet({ [PREF_KEY]: { ...prefs, recent: r } }); }

// Opens the cards (skills / templates / public) panel on a supported tab —
// 2.12.0: main.js answers rs-open-cards next to rs-open-menu.
function openCards(tab) {
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && isSupportedTab(t.url));
    const anySupported = active || tabs.find((t) => isSupportedTab(t.url));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "rs-open-cards", tab: tab || "" }).catch(() => {});
      chrome.tabs.update(anySupported.id, { active: true });
      window.close();
    } else {
      toast("Open a supported AI chat first — the cards panel lives on that page", "warn", 4000);
    }
  });
}

async function copyDiagnostics() {
  const s = lastStatus || (await bg({ type: "status" })) || {};
  const hc = (await bg({ type: "mcp.healthCheck", debug: true })) || {};
  const keys = await storeGet(["rsWorkMode", "rsPermMode", "rsThinkingLevel", "rsBgMode", "rsAutoFix", "rsAutoDebug", "rsMultiAgent", "rsGuiBrief", PREF_KEY]);
  const out = { version: VERSION, at: new Date().toISOString(), platform: navigator.platform, status: { ...s, local_root: s.local_root ? "(set)" : "" }, health: { ...hc, diagnostics: (hc.diagnostics || []).slice(-10) }, settings: keys };
  return copyText(JSON.stringify(out, null, 2), "Diagnostics copied (no keys, no conversations)");
}

// ── activity + notifications ───────────────────────────────────────────────
let activity = [];
let actFilter = "all";
let seenAt = 0;
const KIND_DOT = { ok: "ok", warn: "warn", error: "danger", info: "info" };
async function loadActivity() {
  const r = await bg({ type: "activity_log" });
  activity = r && Array.isArray(r.items) ? r.items : [];
  renderActivity();
  updateBell();
}
function matchesFilter(it) {
  if (actFilter === "all") return true;
  if (actFilter === "error") return it.level === "error";
  if (actFilter === "notice") return it.level === "error" || it.level === "warn";
  return it.kind === actFilter;
}
function renderActivity() {
  const root = $("act-list"); if (!root) return;
  const q = ($("act-search").value || "").trim().toLowerCase();
  const items = activity.filter(matchesFilter).filter((it) => !q || `${it.text} ${it.tool || ""} ${it.code || ""}`.toLowerCase().includes(q)).slice().reverse();
  root.innerHTML = "";
  if (!items.length) {
    root.appendChild(h(`<div class="ts-empty">${icon("pulse", 20)}<b>${activity.length ? "Nothing matches" : "No events yet"}</b><span>${activity.length ? "Try another filter or search." : "Tool calls, bridge events and errors from this browser session show up here."}</span></div>`));
    return;
  }
  for (const it of items) {
    const row = h(`<div class="act-item ${it.level === "error" ? "clickable" : ""}" role="${it.level === "error" ? "button" : "listitem"}" ${it.level === "error" ? 'tabindex="0"' : ""}><span class="ts-dot ${KIND_DOT[it.level] || ""}"></span><div><div class="act-text"></div><div class="act-meta"></div></div><span class="act-time">${esc(clock(it.at))}</span></div>`);
    row.querySelector(".act-text").textContent = it.text;
    const meta = row.querySelector(".act-meta");
    if (it.tool) meta.appendChild(h(`<code>${esc(it.tool)}</code>`));
    if (it.ms != null) meta.appendChild(h(`<span>${esc(it.ms)} ms</span>`));
    if (it.code) meta.appendChild(h(`<span>${esc(it.code)}</span>`));
    if (it.engine) meta.appendChild(h(`<span>${esc(it.engine)}</span>`));
    if (!meta.children.length) meta.remove();
    if (it.level === "error") { const open = () => showError(it); row.addEventListener("click", open); row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }); }
    root.appendChild(row);
  }
}
function unreadCount() { return activity.filter((it) => (it.level === "error" || it.level === "warn") && it.at > seenAt).length; }
function updateBell() {
  const n = unreadCount();
  const c = $("bell-count"); if (c) c.textContent = n ? String(Math.min(n, 99)) : "";
  const t = $("act-count"); if (t) { t.textContent = n ? String(Math.min(n, 99)) : ""; t.hidden = !n; }
  const bell = $("bell"); if (bell) bell.title = n ? `${n} new notification${n === 1 ? "" : "s"}` : "Notifications";
}
async function markActivitySeen() { seenAt = Date.now(); try { await chrome.storage.session.set({ tsSeenAt: seenAt }); } catch {} updateBell(); }
$("act-search").addEventListener("input", renderActivity);
$("act-filters").addEventListener("click", (e) => { const b = e.target.closest(".ts-chip"); if (!b) return; actFilter = b.dataset.f; $("act-filters").querySelectorAll(".ts-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b))); renderActivity(); });
$("act-refresh").addEventListener("click", (e) => busy(e.currentTarget, loadActivity));
$("act-clear").addEventListener("click", async (e) => { if (!activity.length) return; if (!(await confirmDialog("Clear the activity log?", "This removes the events of this browser session from the popup. Nothing in Studio or on disk is touched.", "Clear", true))) return; await bg({ type: "activity_clear" }); activity = []; renderActivity(); updateBell(); toast("Activity cleared", "ok"); });
$("bell").addEventListener("click", () => { actFilter = "notice"; $("act-filters").querySelectorAll(".ts-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === "notice"))); showView("activity"); });
function onActivityPush(item) {
  if (!item) return;
  activity.push(item); if (activity.length > 200) activity.shift();
  if (currentView === "activity") renderActivity();
  updateBell();
  if (prefs.notify && (item.level === "error" || item.level === "warn") && currentView !== "activity") toast(item.text, item.level === "error" ? "danger" : "warn", 3600);
}

// ── tools ──────────────────────────────────────────────────────────────────
let toolsData = [];
let toolsLoadedAt = 0;
const SERVER_LABEL = { roblox: "Roblox Studio", studio: "Roblox Studio", local: "AgentScript (this PC)", blender: "Blender", agent: "AgentScript (this PC)", blockbench: "Blockbench" };
function toolServer(t) {
  const n = String(t.name || "");
  if (t.server) return String(t.server);
  if (n.includes("/")) return n.split("/")[0];
  if (/^blender_|^(get_scene_info|execute_blender)/.test(n)) return "blender";
  if (/^bb_/.test(n)) return "blockbench";
  if (/^(read_file|write_file|list_dir|run_command|search_files|move|delete|open_path|download|process|shell|fs_)/.test(n)) return "local";
  return "roblox";
}
let toolsInflight = null;
function fetchTools(force) {
  if (toolsInflight) return toolsInflight;
  toolsInflight = bg({ type: "list_tools", refresh: !!force }).then((r) => {
    toolsData = r && Array.isArray(r.tools) ? r.tools : [];
    toolsLoadedAt = Date.now();
    return r;
  }).finally(() => { toolsInflight = null; });
  return toolsInflight;
}
async function loadTools(force) {
  const root = $("tools-groups"); if (!root) return;
  if (!force && toolsLoadedAt && Date.now() - toolsLoadedAt < 15000 && toolsData.length) { renderTools(); return; }
  root.innerHTML = `<div class="ts-card"><div class="ts-card-body"><div class="ts-skel" style="height:14px;width:40%"></div><div class="ts-skel" style="height:12px"></div><div class="ts-skel" style="height:12px;width:80%"></div></div></div>`;
  const r = await fetchTools(force);
  if (r && r.ok === false && !toolsData.length) { renderToolsEmpty(r); return; }
  renderTools();
}
function renderToolsEmpty(r) {
  const root = $("tools-groups");
  const code = r && (r.errorCode || "");
  root.innerHTML = "";
  root.appendChild(h(`<div class="ts-card"><div class="ts-empty">${icon("tools", 20)}<b>${esc(code === "MCP_SERVER_UNAVAILABLE" ? "Bridge offline" : "No tools reported")}</b><span class="ts-wrap">${esc(r && r.error ? r.error : `Run ${RUN_CMD} and reconnect — the list fills in from the live bridge.`)}</span><button type="button" class="ts-btn sm" id="tools-reconnect">${icon("plug", 14)}<span>Reconnect bridge</span></button></div></div>`));
  $("tools-count").firstElementChild.textContent = "offline";
  $("tools-reconnect").addEventListener("click", (e) => busy(e.currentTarget, () => bg({ type: "reconnect" }).then(() => new Promise((res) => setTimeout(() => res(loadTools(true)), 900)))));
}
function renderTools() {
  const root = $("tools-groups"); root.innerHTML = "";
  const q = ($("tools-search").value || "").trim().toLowerCase();
  const groups = new Map();
  for (const t of toolsData) {
    const text = `${t.name} ${t.description || ""}`.toLowerCase();
    if (q && !text.includes(q)) continue;
    const s = toolServer(t); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(t);
  }
  const total = toolsData.length;
  $("tools-count").firstElementChild.textContent = q ? `${[...groups.values()].reduce((a, b) => a + b.length, 0)} of ${total}` : `${total} tools`;
  if (!groups.size) { root.appendChild(h(`<div class="ts-card"><div class="ts-empty">${icon("search", 20)}<b>${total ? "No tool matches" : "No tools yet"}</b><span>${total ? "Try a shorter word." : "The bridge has not reported its tools — press Refresh once it is connected."}</span></div></div>`)); return; }
  const SERVER_ORDER = ["roblox", "studio", "local", "agent", "blender", "blockbench"];
  const rank = (s) => { const i = SERVER_ORDER.indexOf(s); return i < 0 ? 99 : i; };
  for (const [server, list] of [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))) {
    const card = h(`<div class="ts-card flush"><div class="tool-group"><div class="tool-head"><span class="ts-h3"></span><span class="ts-badge"><span>${list.length}</span></span></div><div class="ts-list"></div></div></div>`);
    card.querySelector(".ts-h3").textContent = SERVER_LABEL[server] || server;
    const ul = card.querySelector(".ts-list");
    for (const t of list.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const bare = String(t.name).split("/").pop();
      const desc = String(t.description || (t.inputSchema && t.inputSchema.description) || "No description from the server.");
      const params = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [];
      const row = h(`<div class="tool-item clickable" tabindex="0" role="button" aria-expanded="false"><span class="tool-name" title="${esc(t.name)}"></span><button type="button" class="ts-btn toolbar xs" title="Copy the tool name">${icon("copy", 12)}</button><div class="tool-desc"></div></div>`);
      row.querySelector(".tool-name").textContent = bare;
      row.querySelector(".tool-desc").textContent = desc + (params.length ? `  ·  args: ${params.join(", ")}` : "");
      row.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); copyText(String(t.name), "Tool name copied"); });
      const flip = () => { row.classList.toggle("open"); row.setAttribute("aria-expanded", String(row.classList.contains("open"))); };
      row.addEventListener("click", flip);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      ul.appendChild(row);
    }
    root.appendChild(card);
  }
}
$("tools-search").addEventListener("input", renderTools);
$("tools-refresh").addEventListener("click", (e) => busy(e.currentTarget, () => loadTools(true)));
$("open-cards").addEventListener("click", () => openCards(""));
$("open-cards-public").addEventListener("click", () => openCards("public"));

// ── settings: schema over the real storage keys ────────────────────────────
// live: the content script listens to storage.onChanged for the key (applies
// instantly on every AI tab); otherwise it is read on the next page load and
// the row says so.
const CREATION_PROFILES = [["standard", "Standard"], ["high", "High quality"], ["professional", "Professional"], ["masterpiece", "Masterpiece"]];
const EFFORT_LEVELS = [["low", "Low — quick answers"], ["mid", "Medium (default)"], ["high", "High — checks its work"], ["max", "Max — plans, builds, verifies"], ["ultimate", "Ultimate — exhaustive"]];
const CATEGORIES = [
  { id: "general", title: "General", sub: "Startup, background tabs, sounds, notifications", icon: "sliders", items: [
    { id: "startView", pref: "startView", type: "select", label: "Open the popup on", options: [["home", "Home"], ["activity", "Activity"], ["tools", "Tools"], ["settings", "Settings"]] },
    { id: "bg", key: "rsBgMode", type: "toggle", default: true, live: true, label: "Work in background tabs", sub: "Keep building while you browse other sites — the AI tab can stay in the background." },
    { id: "sounds", key: "rsSounds", type: "toggle", default: true, live: true, label: "Sound effects", sub: "Chime when the agent starts, finishes or errors." },
    { id: "volume", key: VOLUME_KEY, type: "range", default: 70, min: 0, max: 100, label: "Sound volume", sub: "Applies when an AI tab loads next." },
    { id: "notify", pref: "notify", type: "toggle", label: "Notifications in the popup", sub: "Show a toast for new errors and warnings while the popup is open; the bell counts them either way." },
    { id: "advanced", key: "rsSettingsAdvanced", type: "toggle", default: false, label: "Show advanced settings on the AI page", sub: "Playtest sub-options, Multi-Agent, task list, shortcuts, custom prompt and MCP servers in the on-page tray. Applies when the tray opens next." },
  ] },
  { id: "appearance", title: "Appearance", sub: "Theme, accent, density, text size, motion", icon: "brush", items: [
    { id: "theme", pref: "theme", type: "seg", label: "Theme", sub: "For the popup and TotalScript's own pages. The bar on AI pages keeps its aqua skin.", options: [["dark", "Dark"], ["light", "Light"], ["system", "System"]] },
    { id: "accent", pref: "accent", type: "accent", label: "Accent colour" },
    { id: "density", pref: "density", type: "seg", label: "Density", options: [["comfortable", "Comfortable"], ["compact", "Compact"]] },
    { id: "text", pref: "text", type: "seg", label: "Text size", options: [["normal", "Normal"], ["large", "Large"], ["larger", "Larger"]] },
    { id: "motion", pref: "motion", type: "toggle", label: "Animations", sub: "Transitions, pulses and toasts. Off also follows your system's reduced-motion setting." },
    { id: "brand", type: "action", label: "On-page bar look", sub: "Name, logo, colours, button style, typeface and size of the bar on AI pages — edited on the page itself.", button: "Customize on the AI page", run: () => $("settings").click() },
  ] },
  { id: "agents", title: "AI & Agents", sub: "Reasoning effort, creation quality, plan mode, auto-fix, debugger, Multi-Agent, custom prompt", icon: "brain", items: [
    { id: "effort", key: "rsThinkingLevel", type: "select", default: "mid", live: true, label: "Reasoning effort", sub: "How hard the AI thinks before it acts — through the prompt only; the site's model is never switched.", options: EFFORT_LEVELS },
    { id: "cprofile", key: "rsCreationProfile", type: "select", default: "high", live: true, label: "Creation quality", sub: "How strictly a build is checked against your request: Standard = one reminder for missing parts; High = every part must be read back + integration checks; Professional = audits + a second round; Masterpiece = three rounds. Always capped by the provider's limits.", options: CREATION_PROFILES },
    { id: "extra", key: "rsExtraThinking", type: "toggle", default: false, live: true, label: "Extra thinking", sub: "The AI questions every assumption before acting (the Think button on the bar)." },
    { id: "plan", key: "rsPlanMode", type: "toggle", default: false, live: true, label: "Plan mode", sub: "Write the plan first, then build step by step." },
    { id: "autofix", key: "rsAutoFix", type: "toggle", default: true, live: true, label: "Auto-fix playtest errors", sub: "Watches Output during Play and sends new errors to the AI." },
    { id: "autofixstop", key: "rsAutoFixStopPlay", type: "toggle", default: false, live: true, label: "Stop playtest on error", sub: "Stop Play when an error is caught (off = keep playing while the AI fixes it)." },
    { id: "autodebug", key: "rsAutoDebug", type: "toggle", default: false, live: true, label: "Automatic debugger", sub: "After Studio edits, new Output errors are sent to the AI to fix." },
    { id: "guibrief", key: "rsGuiBrief", type: "toggle", default: true, live: true, label: "GUI brief", sub: "When you ask for a GUI, the build protocol (and the reference-image protocol) is sent right after your message." },
    { id: "multiagent", key: "rsMultiAgent", type: "toggle", default: false, live: true, label: "Multi-Agent crew", sub: "Planner → builder / scripter → reviewer → tester → debugger on a shared board." },
    { id: "prompt", key: "rsCustomPrompt", type: "textarea", default: "", label: "Custom prompt", sub: "Added below the system prompt on every new session. The built-in prompt cannot be edited.", placeholder: "e.g. Always comment your Luau code. Prefer small modular scripts." },
    { id: "modes", type: "action", label: "Work mode & access", sub: "Totality / Blender / Animator and Sandbox / Full PC live on Home.", button: "Go to Home", run: () => showView("home") },
  ] },
  { id: "providers", title: "Providers", sub: "AI sites, default chat, API chats with your own key", icon: "globe", items: [
    { id: "defaultSite", pref: "defaultSite", type: "select", label: "Default AI site", sub: "Used by “Open AI chat” and the command palette.", options: PROVIDER_SITES.map(([n, u]) => [u, n]) },
    { id: "codecraft", type: "action", label: "CodeCraft API chat", sub: "Any CodeCraft model with your own cc_ key — TotalScript hosts the chat page.", button: "Open", run: () => $("codecraft").click() },
    { id: "sites", type: "providers", label: "Supported sites" },
  ] },
  { id: "studio", title: "Roblox Studio", sub: "Bridge, Studio MCP, engine, Blender, publishing", icon: "studio", items: [
    { id: "conn", type: "connection", label: "Connection" },
    { id: "repair", type: "action", label: "Repair the Studio link", sub: "Restarts the Studio MCP helper inside the agent app — fixes “connected but every command fails” after a Studio update or sleep / resume.", button: "Restart server", run: (btn) => QUICK_ACTIONS.find((q) => q.id === "restart").run(btn) },
    { id: "reconnect", type: "action", label: "Reconnect the bridge", sub: `Re-dial ${RUN_CMD} on port 3000 / 17613 / 17615.`, button: "Reconnect", run: (btn) => QUICK_ACTIONS.find((q) => q.id === "reconnect").run(btn) },
    { id: "blender", type: "blender", label: "Blender MCP", sub: "Connects to the TotalScript addon running inside Blender on port 9876." },
    { id: "blockbench", type: "blockbench", label: "Blockbench MCP", sub: "Connects to the Blockbench MCP plugin over localhost HTTP (default http://localhost:3000/bb-mcp — change the port in Blockbench settings if the desktop agent already uses 3000). Models are exported as files for Studio's Import 3D." },
    { id: "publish", key: "rsAllowPublishAutomation", type: "toggle", default: false, label: "Allow confirmed publishing without a per-operation prompt", sub: "Off by default. Roblox authentication, ownership, moderation and rate limits always apply." },
    { id: "diag", type: "action", label: "Diagnostics", sub: "Copy the bridge status, health check and your non-secret settings as JSON for a bug report.", button: "Copy diagnostics", run: (btn) => busy(btn, copyDiagnostics) },
  ] },
  { id: "tools", title: "Tools & Skills", sub: "Live tool list, cards panel, learned image tools", icon: "tools", items: [
    { id: "tools", type: "action", label: "Bridge tools", sub: "Every tool the connected servers expose, grouped by server, with descriptions.", button: "Open Tools", run: () => showView("tools") },
    { id: "cards", type: "action", label: "Skills, templates & System Blueprints", sub: "The cards panel above the bar on the AI page (Ctrl+Shift+T there).", button: "Open the cards panel", run: () => openCards("") },
    { id: "public", type: "action", label: "Public skills", sub: "Modes, skills and abilities the AI builds and installs for you.", button: "Open Public tab", run: () => openCards("public") },
    { id: "imagetools", type: "imagetools", label: "Learned image tools" },
  ] },
  { id: "shortcuts", title: "Keyboard shortcuts", sub: "On-page shortcuts (editable) and popup keys", icon: "keyboard", items: [
    { id: "keybinds", type: "keybinds", label: "On the AI page" },
    { id: "popupkeys", type: "popupkeys", label: "In this popup" },
  ] },
  { id: "advanced", title: "Advanced", sub: "Debug diagnostics, export / import, reset", icon: "flask", items: [
    { id: "debug", key: "rsDebugDiagnostics", type: "toggle", default: false, label: "Debug diagnostics", sub: "Verbose diag() lines in the AI page console. Applies when the page loads next." },
    { id: "export", type: "action", label: "Export settings", sub: "Download every TotalScript preference as JSON (no API keys, no conversations, no custom logo).", button: "Export JSON", run: exportSettings },
    { id: "import", type: "import", label: "Import settings", sub: "Only known TotalScript keys are read; everything else in the file is ignored." },
    { id: "hello", type: "action", label: "Hello page", sub: "The one-time welcome page with the four setup steps.", button: "Open", run: () => openUrl(chrome.runtime.getURL("welcome.html")) },
    { id: "resetPopup", type: "action", label: "Reset popup preferences", sub: "Theme, accent, density, quick actions and default site.", button: "Reset", danger: true, run: async (btn) => { if (!(await confirmDialog("Reset popup preferences?", "Theme, accent, density, text size, quick actions and the default AI site go back to their defaults. Agent settings are not touched.", "Reset", true))) return; await storeRemove([PREF_KEY]); prefs = cleanPrefs(null); applyPrefs(); renderQuick(); refreshPanelValues(); toast("Popup preferences reset", "ok"); } },
    { id: "resetAll", type: "action", label: "Reset all settings", sub: "Every TotalScript preference in this browser — agent behaviour, shortcuts, custom prompt, bar look, popup. Saved chats on the CodeCraft page and API keys are kept.", button: "Reset everything", danger: true, run: resetAll },
  ] },
  { id: "support", title: "Support & about", sub: `Version ${VERSION}, updates, Discord, donate`, icon: "heart", items: [
    { id: "about", type: "about", label: "About" },
    { id: "updates", type: "updates", label: "Updates", sub: "Releases come from GitHub (errored404user/ULTIMATEor). Checked once a day; nothing installs until you press Update." },
    { id: "updcheck", key: "rsUpdateCheck", type: "toggle", default: true, label: "Check for updates daily", sub: "One small request to GitHub Releases per day (latest.json). Off = only the Check now button. Applies to the next scheduled check." },
    { id: "discord", type: "action", label: "Discord", sub: "Questions, bug reports, show what you built.", button: "Join", run: () => $("discord").click() },
    { id: "donate", type: "donate", label: "Donate" },
  ] },
];
const RS_KEYS_ALL = ["rsUpdateCheck", "rsWorkMode", "rsPermMode", "rsExtraThinking", "rsForgeMode", "rsAutoFix", "rsAutoFixStopPlay", "rsAutoDebug", "rsBgMode", "rsSounds", VOLUME_KEY, "rsSettingsAdvanced", "rsThinkingLevel", "rsReasoningModes", "rsEffortExtras", "rsPlanMode", "rsCreationProfile", "rsGuiBrief", "rsMultiAgent", "rsCustomPrompt", "rsKeybinds", "rsBrand", "rsDebugDiagnostics", "rsAllowPublishAutomation", "rsImageTools", "rs-engine", PREF_KEY];
const EXPORT_KEYS = RS_KEYS_ALL.filter((k) => k !== "rsImageTools");
let currentCat = null;
const catById = (id) => CATEGORIES.find((c) => c.id === id);
const DEFAULT_KEYBINDS = { menu: "Ctrl+Shift+O", start: "Ctrl+Enter", voice: "Ctrl+Shift+V", templates: "Ctrl+Shift+T" };
const KEYBIND_LABELS = { menu: "Settings tray", start: "Start / restart agent", voice: "Voice coding", templates: "Cards panel" };

function renderCategories() {
  const root = $("cat-list"); root.innerHTML = "";
  for (const c of CATEGORIES) {
    const b = h(`<button type="button" class="cat" data-cat="${c.id}"><span class="cat-ic">${icon(c.icon, 16)}</span><span class="cat-t"><b></b><span></span></span><span class="cat-arrow">${icon("chevron", 14)}</span></button>`);
    b.querySelector("b").textContent = c.title; b.querySelector(".cat-t span").textContent = c.sub;
    b.addEventListener("click", () => openCategory(c.id));
    root.appendChild(b);
  }
}
async function openCategory(id) {
  currentCat = id ? catById(id) : null;
  $("set-back").hidden = !currentCat; $("set-reset").hidden = !currentCat || !currentCat.items.some((i) => i.key || i.pref);
  $("set-title").textContent = currentCat ? currentCat.title : "Settings";
  $("set-cats").hidden = !!currentCat; $("set-panel").hidden = !currentCat; $("set-search-wrap").hidden = !!currentCat;
  $("set-results").hidden = true;
  if (!currentCat) { $("set-search").value = ""; return; }
  await renderPanel(currentCat);
}
$("set-back").addEventListener("click", () => openCategory(null));
$("set-reset").addEventListener("click", async () => {
  if (!currentCat) return;
  const keys = currentCat.items.filter((i) => i.key).map((i) => i.key);
  const prefKeys = currentCat.items.filter((i) => i.pref).map((i) => i.pref);
  if (!(await confirmDialog(`Reset ${currentCat.title}?`, `${keys.length + prefKeys.length} setting(s) in this category go back to their defaults.`, "Reset", true))) return;
  if (keys.length) await storeRemove(keys);
  if (prefKeys.length) { const patch = {}; for (const k of prefKeys) patch[k] = PREF_DEFAULTS[k]; await savePrefs(patch); renderQuick(); }
  if (keys.includes("rsPermMode")) { try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: false }).catch(() => {}); } catch {} }
  await loadSettings(); await renderPanel(currentCat);
  toast(`${currentCat.title} reset`, "ok");
});

async function renderPanel(cat) {
  const panel = $("set-panel"); panel.innerHTML = "";
  const stored = await storeGet(cat.items.filter((i) => i.key).map((i) => i.key));
  const card = h(`<div class="ts-card flush"><div class="ts-list"></div></div>`);
  const list = card.firstElementChild;
  for (const it of cat.items) {
    const row = await renderItem(it, stored);
    if (row) { row.dataset.item = it.id; list.appendChild(row); }
  }
  panel.appendChild(card);
  if (cat.id === "studio") refreshPanelValues();
}
function rowShell(it, endHtml, opts) {
  const row = h(`<div class="ts-row ${opts && opts.clickable ? "clickable" : ""}" ${opts && opts.switchRole ? 'role="switch" tabindex="0"' : ""}><div class="ts-row-main"><span class="ts-row-title"></span>${it.sub ? '<span class="ts-row-sub"></span>' : ""}</div>${endHtml ? `<div class="ts-row-end">${endHtml}</div>` : ""}</div>`);
  row.querySelector(".ts-row-title").textContent = it.label;
  if (it.sub) row.querySelector(".ts-row-sub").textContent = it.sub + (it.key && !it.live && it.type !== "textarea" && !/Applies/.test(it.sub) ? " Applies when the AI page loads next." : "");
  return row;
}
async function renderItem(it, stored) {
  const val = it.pref ? prefs[it.pref] : it.key ? (stored[it.key] === undefined ? it.default : stored[it.key]) : undefined;
  switch (it.type) {
    case "toggle": {
      const row = rowShell(it, '<span class="ts-switch"></span>', { clickable: true, switchRole: true });
      let on = !!val; row.setAttribute("aria-checked", String(on));
      const flip = async () => { on = !on; row.setAttribute("aria-checked", String(on)); if (it.pref) { await savePrefs({ [it.pref]: on }); if (it.pref === "motion") applyPrefs(); } else { await storeSet({ [it.key]: on }); if (it.key === "rsAutoFix") settings.autofix = on; if (it.key === "rsBgMode") settings.bg = on; if (it.key === "rsSounds") settings.sounds = on; if (it.key === "rsExtraThinking") settings.extra = on; renderSettings(); } };
      row.addEventListener("click", flip); row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      return row;
    }
    case "select": {
      const row = rowShell(it, `<select class="ts-select" style="width:170px" aria-label="${esc(it.label)}">${it.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>`);
      const sel = row.querySelector("select"); sel.value = it.options.some(([v]) => v === val) ? val : it.options[0][0];
      sel.addEventListener("change", async () => { if (it.pref) await savePrefs({ [it.pref]: sel.value }); else await storeSet({ [it.key]: sel.value }); toast(`${it.label}: ${it.options.find(([v]) => v === sel.value)[1]}`, "ok"); });
      return row;
    }
    case "seg": {
      const row = rowShell(it, `<div class="ts-seg" role="group" aria-label="${esc(it.label)}">${it.options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === val}">${esc(l)}</button>`).join("")}</div>`);
      row.querySelector(".ts-seg").addEventListener("click", async (e) => { const b = e.target.closest("button"); if (!b) return; row.querySelectorAll(".ts-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); if (it.pref) await savePrefs({ [it.pref]: b.dataset.v }); else await storeSet({ [it.key]: b.dataset.v }); });
      return row;
    }
    case "accent": {
      const colors = { aqua: "#22d3ee", violet: "#a78bfa", emerald: "#34d399", amber: "#f5b544", rose: "#fb7185", slate: "#cbd5e1" };
      const row = rowShell(it, `<div class="swatches" role="radiogroup" aria-label="Accent colour">${PREF_ENUMS.accent.map((a) => `<button type="button" class="swatch" role="radio" data-v="${a}" style="--c:${colors[a]}" aria-pressed="${a === val}" aria-label="${a}" title="${a}"></button>`).join("")}</div>`);
      row.querySelector(".swatches").addEventListener("click", async (e) => { const b = e.target.closest(".swatch"); if (!b) return; row.querySelectorAll(".swatch").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); await savePrefs({ accent: b.dataset.v }); });
      return row;
    }
    case "range": {
      const row = rowShell(it, `<span class="ts-meta" style="width:34px;text-align:right;font-family:var(--ts-mono)">${esc(val)}</span>`);
      const slider = h(`<input type="range" class="ts-range" min="${it.min}" max="${it.max}" value="${esc(val)}" aria-label="${esc(it.label)}">`);
      row.querySelector(".ts-row-main").appendChild(slider);
      let t; slider.addEventListener("input", () => { row.querySelector(".ts-row-end .ts-meta").textContent = slider.value; clearTimeout(t); t = setTimeout(() => storeSet({ [it.key]: Number(slider.value) }), 200); });
      return row;
    }
    case "textarea": {
      const row = rowShell(it, "");
      const ta = h(`<textarea class="ts-textarea" rows="3" placeholder="${esc(it.placeholder || "")}" aria-label="${esc(it.label)}"></textarea>`); ta.value = String(val || "");
      const foot = h(`<div class="ts-between"><span class="ts-meta"></span><button type="button" class="ts-btn sm primary"><span>Save</span></button></div>`);
      const count = foot.firstElementChild; const upd = () => { count.textContent = `${ta.value.length} chars · next session`; }; upd();
      ta.addEventListener("input", upd);
      foot.lastElementChild.addEventListener("click", (e) => busy(e.currentTarget, () => storeSet({ [it.key]: ta.value.slice(0, 4000) }), { ok: "Custom prompt saved — used from the next session" }));
      row.querySelector(".ts-row-main").append(ta, foot);
      return row;
    }
    case "action": {
      const row = rowShell(it, `<button type="button" class="ts-btn sm ${it.danger ? "danger" : ""}"><span></span></button>`);
      const b = row.querySelector("button"); b.firstElementChild.textContent = it.button;
      b.addEventListener("click", () => it.run(b));
      return row;
    }
    case "providers": {
      const row = h(`<div class="ts-row" style="display:block;padding:0"><div class="ts-row-main" style="padding:var(--ts-s3) var(--ts-s4) var(--ts-s1)"><span class="ts-row-title">Supported sites</span><span class="ts-row-sub">Open one — the TotalScript bar appears above its chat box. Sites with a dot are open now.</span></div><div class="ts-list" id="provider-list"></div></div>`);
      const tabs = await new Promise((res) => { try { chrome.tabs.query({}, (t) => res(t || [])); } catch { res([]); } });
      const ul = row.querySelector("#provider-list");
      for (const [name, url, host] of PROVIDER_SITES) {
        const open = tabs.find((t) => String(t.url || "").includes(host));
        const li = h(`<div class="provider-item"><div class="ts-inline" style="flex-wrap:nowrap"><span class="ts-dot ${open ? "ok" : ""}"></span><div style="min-width:0"><b></b><small></small></div></div><button type="button" class="ts-btn sm ${open ? "" : "ghost"}"><span>${open ? "Go to tab" : "Open"}</span></button></div>`);
        li.querySelector("b").textContent = name; li.querySelector("small").textContent = host;
        li.querySelector("button").addEventListener("click", () => { if (open) { try { chrome.tabs.update(open.id, { active: true }); } catch {} window.close(); } else openUrl(url); });
        ul.appendChild(li);
      }
      return row;
    }
    case "connection": {
      const row = h(`<div class="ts-row" style="display:block"><div class="ts-row-main"><span class="ts-row-title">Connection</span><dl class="ts-kv" id="conn-kv" style="margin-top:6px"></dl></div></div>`);
      return row;
    }
    case "blender": {
      const row = rowShell(it, `<button type="button" class="ts-btn sm" id="blender-toggle"><span>…</span></button>`);
      const b = row.querySelector("button");
      const paint = (on) => { b.firstElementChild.textContent = on ? "Disconnect" : "Connect"; b.classList.toggle("danger", on); b.dataset.on = on ? "1" : ""; };
      bg({ type: "blender_status" }).then((r) => paint(!!(r && r.blender)));
      b.addEventListener("click", () => busy(b, async () => { const on = b.dataset.on === "1"; const r = await bg({ type: on ? "blender_disconnect" : "blender_connect" }); const now = !!(r && r.blender); paint(now); if (!on && !now) { toast(r && r.error ? String(r.error) : "Blender did not answer on port 9876 — is the addon running?", "danger", 4500); return false; } return true; }, { ok: "Blender link updated" }));
      return row;
    }
    case "blockbench": {
      const row = rowShell(it, `<button type="button" class="ts-btn sm" id="blockbench-toggle"><span>…</span></button>`);
      const main = row.querySelector(".ts-row-main");
      const field = h(`<input id="blockbench-url" class="ts-input" type="url" spellcheck="false" placeholder="http://localhost:3000/bb-mcp" aria-label="Blockbench MCP URL" style="margin-top:6px;width:100%;box-sizing:border-box">`);
      main.appendChild(field);
      const b = row.querySelector("button");
      const paint = (on, url) => { b.firstElementChild.textContent = on ? "Disconnect" : "Connect"; b.classList.toggle("danger", on); b.dataset.on = on ? "1" : ""; field.readOnly = on; if (url && !field.value) field.value = url; };
      bg({ type: "blockbench_status", auto: false }).then((r) => paint(!!(r && r.blockbench), r && r.url));
      field.addEventListener("change", async () => {
        const url = String(field.value || "").trim();
        const r = await bg({ type: "blockbench_set_url", url: url || "http://localhost:3000/bb-mcp" });
        if (!r || !r.ok) toast(String((r && r.error) || "URL must point at localhost"), "warn");
      });
      b.addEventListener("click", () => busy(b, async () => {
        const on = b.dataset.on === "1";
        const url = String(field.value || "").trim();
        const r = await bg(on ? { type: "blockbench_disconnect" } : (url ? { type: "blockbench_connect", url } : { type: "blockbench_connect" }));
        const now = !!(r && r.blockbench);
        paint(now, r && r.url);
        if (!on && !now) { toast(r && r.error ? String(r.error).slice(0, 220) : "Blockbench did not answer — open Blockbench with the MCP plugin enabled.", "warn"); return false; }
        if (!on && now) toast(`Blockbench linked — ${r.tools || 0} plugin tools`, "ok");
        refresh();
        return true;
      }));
      return row;
    }
    case "imagetools": {
      const r = await storeGet(["rsImageTools"]);
      const n = Array.isArray(r.rsImageTools) ? r.rsImageTools.length : 0;
      const row = rowShell({ label: "Learned image tools", sub: n ? `${n} tool name(s) the agent learned to treat as image tools on this browser. Clearing makes it re-learn.` : "Nothing learned yet — the agent remembers which tools return images." }, n ? `<button type="button" class="ts-btn sm danger"><span>Clear</span></button>` : "");
      const b = row.querySelector("button"); if (b) b.addEventListener("click", () => busy(b, async () => { await storeRemove(["rsImageTools"]); await renderPanel(currentCat); return true; }, { ok: "Cleared" }));
      return row;
    }
    case "keybinds": {
      const r = await storeGet(["rsKeybinds"]);
      const kb = { ...DEFAULT_KEYBINDS, ...(r.rsKeybinds && typeof r.rsKeybinds === "object" ? r.rsKeybinds : {}) };
      const row = h(`<div class="ts-row" style="display:block"><div class="ts-row-main"><span class="ts-row-title">On the AI page</span><span class="ts-row-sub">Click a field and press the keys. Shortcuts work anywhere outside a text field. Two actions cannot share a combination.</span><div class="ts-stack" id="kb-grid" style="margin-top:6px"></div><div class="ts-between" style="margin-top:6px"><span class="ts-meta" id="kb-note"></span><button type="button" class="ts-btn sm ghost" id="kb-reset"><span>Reset shortcuts</span></button></div></div></div>`);
      const grid = row.querySelector("#kb-grid"), note = row.querySelector("#kb-note");
      const inputs = {};
      const validate = () => { const seen = {}; let dup = false; for (const k of Object.keys(kb)) { const c = kb[k]; if (seen[c]) { inputs[k].setAttribute("aria-invalid", "true"); inputs[seen[c]].setAttribute("aria-invalid", "true"); dup = true; } else { seen[c] = k; inputs[k].removeAttribute("aria-invalid"); } } note.textContent = dup ? "Conflict: two actions share a shortcut — change one." : "Saved automatically."; note.className = "ts-meta " + (dup ? "ts-danger" : ""); return !dup; };
      for (const k of Object.keys(DEFAULT_KEYBINDS)) {
        const line = h(`<div class="keybind"><span class="ts-row-sub" style="color:var(--ts-text)">${esc(KEYBIND_LABELS[k])}</span><input class="ts-input" readonly value="${esc(kb[k])}" aria-label="${esc(KEYBIND_LABELS[k])} shortcut" title="Click, then press the new keys"></div>`);
        const inp = line.querySelector("input"); inputs[k] = inp;
        inp.addEventListener("focus", () => { inp.classList.add("recording"); inp.value = "Press keys…"; });
        inp.addEventListener("blur", () => { inp.classList.remove("recording"); inp.value = kb[k]; });
        inp.addEventListener("keydown", async (e) => { e.preventDefault(); e.stopPropagation(); if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; if (e.key === "Escape") { inp.blur(); return; } const parts = []; if (e.ctrlKey) parts.push("Ctrl"); if (e.altKey) parts.push("Alt"); if (e.shiftKey) parts.push("Shift"); if (e.metaKey) parts.push("Meta"); parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key); const combo = parts.join("+"); if (parts.length === 1 && !/^(F\d+|Escape)$/.test(e.key)) { toast("Use a modifier (Ctrl / Alt / Shift) so typing is not hijacked", "warn"); return; } kb[k] = combo; inp.value = combo; inp.blur(); if (validate()) await storeSet({ rsKeybinds: kb }); });
        grid.appendChild(line);
      }
      validate();
      row.querySelector("#kb-reset").addEventListener("click", (e) => busy(e.currentTarget, async () => { await storeRemove(["rsKeybinds"]); Object.assign(kb, DEFAULT_KEYBINDS); for (const k of Object.keys(inputs)) inputs[k].value = kb[k]; validate(); return true; }, { ok: "Shortcuts reset — applies when the AI page loads next" }));
      return row;
    }
    case "popupkeys": {
      const keys = [["Ctrl+K", "Command palette"], ["Ctrl+1 … 4", "Home · Activity · Tools · Settings"], ["/", "Focus the search box of the open section"], ["Esc", "Close palette / dialog, go back"], ["Enter / Space", "Flip the focused switch"]];
      const row = h(`<div class="ts-row" style="display:block"><div class="ts-row-main"><span class="ts-row-title">In this popup</span><dl class="ts-kv" style="margin-top:6px">${keys.map(([k, l]) => `<dt style="white-space:nowrap"><kbd>${esc(k)}</kbd></dt><dd>${esc(l)}</dd>`).join("")}</dl></div></div>`);
      return row;
    }
    case "import": {
      const row = rowShell(it, `<button type="button" class="ts-btn sm"><span>Import JSON</span></button><input type="file" accept="application/json,.json" hidden>`);
      const b = row.querySelector("button"), f = row.querySelector("input");
      b.addEventListener("click", () => f.click());
      f.addEventListener("change", async () => { const file = f.files && f.files[0]; if (!file) return; try { const data = JSON.parse(await file.text()); const n = await importSettings(data); toast(n ? `Imported ${n} setting(s)` : "No known TotalScript settings in that file", n ? "ok" : "warn"); if (n) { await loadSettings(); await renderPanel(currentCat); } } catch (e) { toast("Not a valid JSON file", "danger"); } f.value = ""; });
      return row;
    }
    case "updates": {
      // 2.17.0: the same state machine as the Home card (TotalUpdater.decide), rendered as a settings row.
      const row = rowShell(it, `<button type="button" class="ts-btn sm" id="upd-check"><span>Check now</span></button>`);
      const main = row.querySelector(".ts-row-main");
      const box = h(`<div class="ts-stack" style="gap:6px;margin-top:6px"><span class="ts-row-sub ts-wrap" id="upd-line">Loading…</span><div class="ts-inline" id="upd-row-actions" style="flex-wrap:wrap;gap:6px"></div><div class="ts-inline" style="gap:6px;flex-wrap:wrap"><input id="upd-folder" class="ts-input" type="text" spellcheck="false" placeholder="Extension folder used by the desktop app (auto-detected when total-core sits in bin/ or agent/)" aria-label="Extension folder" style="flex:1;min-width:180px"><button type="button" class="ts-btn sm ghost" id="upd-folder-save"><span>Set folder</span></button></div></div>`);
      main.appendChild(box);
      const check = row.querySelector("#upd-check");
      check.addEventListener("click", () => busy(check, async () => { const r = await bg({ type: "update_check", force: true }); paintUpdate(r); if (r && r.error && !(r.decision && r.decision.kind === "available")) { toast(r.error, "warn"); return false; } return true; }));
      box.querySelector("#upd-folder-save").addEventListener("click", (e) => busy(e.currentTarget, async () => {
        const path = String(box.querySelector("#upd-folder").value || "").trim();
        const r = await bg({ type: "update_set_folder", path });
        if (!r || !r.ok) { toast(String((r && r.error) || "The desktop app did not accept that folder"), "warn"); return false; }
        toast(r.detected === "configured" ? "Extension folder saved in the desktop app" : "Folder cleared - auto-detection is back on", "ok");
        refreshUpdate();
        return true;
      }));
      refreshUpdate();
      return row;
    }
    case "about": {
      const row = h(`<div class="ts-row" style="display:block"><div class="ts-row-main"><div class="ts-inline" style="gap:10px"><span class="ts-mark crest" style="width:36px;height:36px"><img src="assets/icon.png" alt=""></span><div style="display:grid;gap:2px"><span class="ts-row-title">TotalScript <span class="ts-meta" style="font-family:var(--ts-mono)">v${esc(VERSION)}</span></span><span class="ts-row-sub">Turns ChatGPT, Claude, DeepSeek, Gemini and friends into a Roblox Studio / AgentScript agent. Free and open source (GPL-3.0).</span></div></div></div></div>`);
      return row;
    }
    case "donate": {
      const tpl = $("tpl-donate"); const node = tpl ? tpl.content.firstElementChild.cloneNode(true) : null; if (!node) return null;
      const wrap = h(`<div class="ts-row" style="display:block"><div class="ts-row-main ts-stack"></div></div>`);
      wrap.firstElementChild.appendChild(node);
      node.querySelectorAll(".dono[data-dono]").forEach((b) => b.addEventListener("click", () => { chrome.tabs.create({ url: b.dataset.dono }); }));
      return wrap;
    }
  }
  return null;
}
// Values that change under the panel while it is open (bridge status, session toggles).
function refreshPanelValues() {
  const kv = $("conn-kv"); if (kv && lastStatus) {
    const s = lastStatus; const isLocal = s.engine === "local";
    const rows = [["Bridge", s.connected ? "connected" : s.reconnecting ? "reconnecting…" : "offline"], ["Engine", isLocal ? "AgentScript (ws 17615)" : "Roblox (ws 17613)"], ["Lifecycle", s.lifecycle || "—"], ["Studio MCP", isLocal ? "n/a" : s.roblox_connected ? "linked to a place" : s.studioApp ? "on, no place" : s.studioProc ? "Studio open, MCP off" : "not detected"], ["Tools", String(s.tools || 0)], ["Servers", (s.servers || []).map((x) => `${x.id} ${x.alive ? "●" : "○"}`).join("  ") || "—"], ["Blender", s.blender ? "linked" : s.blender_error ? `error: ${s.blender_error}` : "not linked"]];
    kv.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="ts-wrap">${esc(v)}</dd>`).join("");
  }
}
async function exportSettings() {
  const data = await storeGet(EXPORT_KEYS);
  if (data.rsBrand && typeof data.rsBrand === "object") { data.rsBrand = { ...data.rsBrand }; delete data.rsBrand.logo; delete data.rsBrand.bg; }
  const out = { totalscript: VERSION, exportedAt: new Date().toISOString(), settings: data };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `totalscript-settings-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Settings exported", "ok");
}
async function importSettings(data) {
  const src = data && typeof data === "object" ? (data.settings && typeof data.settings === "object" ? data.settings : data) : null;
  if (!src) return 0;
  const patch = {};
  for (const k of EXPORT_KEYS) {
    if (!(k in src)) continue;
    const v = src[k];
    if (k === PREF_KEY) { patch[k] = cleanPrefs(v); continue; }
    if (k === "rsBrand") { const b = v && typeof v === "object" ? { ...v } : null; if (!b) continue; delete b.logo; delete b.bg; patch[k] = b; continue; }
    if (["string", "number", "boolean"].includes(typeof v) || (v && typeof v === "object")) patch[k] = v;
  }
  const n = Object.keys(patch).length;
  if (n) { await storeSet(patch); if (patch[PREF_KEY]) { prefs = cleanPrefs(patch[PREF_KEY]); applyPrefs(); renderQuick(); } }
  return n;
}
async function resetAll(btn) {
  if (!(await confirmDialog("Reset every TotalScript setting?", "Agent behaviour, reasoning effort, shortcuts, custom prompt, the bar's look, publishing safety and the popup go back to their defaults. Open AI tabs pick most of it up instantly; reload them for the rest. API keys and saved CodeCraft chats are kept.", "Reset everything", true))) return;
  await busy(btn, async () => {
    await storeRemove(RS_KEYS_ALL);
    try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: false }).catch(() => {}); } catch {}
    try { chrome.runtime.sendMessage({ type: "rs-set-engine", engine: "roblox" }).catch(() => {}); } catch {}
    prefs = cleanPrefs(null); applyPrefs(); renderQuick();
    Object.assign(settings, { workMode: "creation", permMode: "sandbox", extra: false, forge: true, autofix: true, bg: true, sounds: true, brand: sanitizeBrandLite(null) });
    renderSettings(); renderEngine("roblox");
    if (currentCat) await renderPanel(currentCat);
    return true;
  }, { ok: "All settings reset" });
}

// Settings search: every item of every category, by label + sub + category.
function searchSettings(q) {
  q = q.trim().toLowerCase();
  const res = $("set-results"), list = $("set-results-list");
  if (!q) { res.hidden = true; $("set-cats").hidden = false; return; }
  const hits = [];
  for (const c of CATEGORIES) for (const it of c.items) { const hay = `${it.label} ${it.sub || ""} ${c.title}`.toLowerCase(); if (hay.includes(q)) hits.push([c, it]); }
  list.innerHTML = "";
  res.hidden = false; $("set-cats").hidden = true;
  if (!hits.length) { list.appendChild(h(`<div class="ts-empty"><b>No setting matches “${esc(q)}”</b><span>Try another word — or ask on Discord.</span></div>`)); return; }
  for (const [c, it] of hits.slice(0, 30)) {
    const b = h(`<button type="button" class="set-result"><div><b></b><span class="set-result-sub"></span></div>${icon("chevron", 14)}</button>`);
    b.querySelector("b").innerHTML = mark(it.label, q); b.querySelector(".set-result-sub").textContent = c.title + (it.sub ? " · " + it.sub : "");
    b.addEventListener("click", async () => { await openCategory(c.id); const row = $("set-panel").querySelector(`[data-item="${it.id}"]`); if (row) { reveal(row); row.style.boxShadow = "inset 0 0 0 2px var(--ts-accent-line)"; setTimeout(() => (row.style.boxShadow = ""), 1600); } });
    list.appendChild(b);
  }
}
const mark = (text, q) => { const i = text.toLowerCase().indexOf(q); return i < 0 ? esc(text) : esc(text.slice(0, i)) + `<span class="set-hit">${esc(text.slice(i, i + q.length))}</span>` + esc(text.slice(i + q.length)); };
$("set-search").addEventListener("input", (e) => searchSettings(e.target.value));

// ── command palette ────────────────────────────────────────────────────────
let palItems = [], palSel = 0;
function paletteCommands() {
  const cmds = [];
  const add = (c) => cmds.push(c);
  add({ id: "view:home", group: "Go", title: "Home", icon: "home", run: () => showView("home") });
  add({ id: "view:activity", group: "Go", title: "Activity", sub: "Tool calls, bridge events, errors", icon: "pulse", run: () => showView("activity") });
  add({ id: "view:tools", group: "Go", title: "Tools", sub: "Live bridge tool list", icon: "tools", run: () => showView("tools") });
  add({ id: "view:settings", group: "Go", title: "Settings", icon: "gear", run: () => showView("settings") });
  for (const c of CATEGORIES) add({ id: "cat:" + c.id, group: "Settings", title: c.title, sub: c.sub, icon: c.icon, run: () => { showView("settings", { keepPanel: true }); openCategory(c.id); } });
  for (const q of QUICK_ACTIONS) if (!["palette", "activity", "tools"].includes(q.id)) add({ id: "qa:" + q.id, group: "Action", title: q.label, sub: q.hint || "", icon: q.icon, run: () => q.run(null) });
  add({ id: "engine:roblox", group: "Engine", title: "Use the Roblox engine", icon: "studio", run: () => setEngine("roblox") });
  add({ id: "engine:local", group: "Engine", title: "Use the AgentScript engine", icon: "terminal", run: () => setEngine("local") });
  add({ id: "mode:creation", group: "Work mode", title: "Totality mode", icon: "box", run: () => setWorkMode("creation") });
  add({ id: "mode:blender", group: "Work mode", title: "Blender mode", icon: "box", run: () => setWorkMode("blender") });
  add({ id: "mode:blockbench", group: "Work mode", title: "Blockbench mode", icon: "box", run: () => setWorkMode("blockbench") });
  add({ id: "mode:animate", group: "Work mode", title: "Animator mode", icon: "box", run: () => setWorkMode("animate") });
  add({ id: "perm:sandbox", group: "Access", title: "Sandbox only", icon: "shield", run: () => setPermMode("sandbox") });
  add({ id: "perm:full", group: "Access", title: "Full PC access", sub: "asks to confirm", icon: "warn", danger: true, run: () => setPermMode("full") });
  for (const [name, url, host] of PROVIDER_SITES) add({ id: "site:" + host, group: "Open", title: name, sub: host, icon: "globe", run: () => openUrl(url) });
  for (const c of CATEGORIES) for (const it of c.items) if (it.type !== "donate" && it.type !== "about") add({ id: "set:" + c.id + ":" + it.id, group: c.title, title: it.label, sub: it.sub || "", icon: c.icon, run: async () => { showView("settings", { keepPanel: true }); await openCategory(c.id); const row = $("set-panel").querySelector(`[data-item="${it.id}"]`); if (row) reveal(row); } });
  for (const t of toolsData.slice(0, 400)) { const bare = String(t.name).split("/").pop(); add({ id: "tool:" + t.name, group: "Tool", title: bare, sub: String(t.description || "").slice(0, 80), icon: "tools", run: () => { showView("tools"); $("tools-search").value = bare; renderTools(); } }); }
  add({ id: "act:clear", group: "Action", title: "Clear activity log", icon: "trash", danger: true, run: () => $("act-clear").click() });
  return cmds;
}
function fuzzy(q, text) {
  text = text.toLowerCase(); q = q.toLowerCase();
  if (!q) return 1;
  if (text.startsWith(q)) return 100 - text.length * 0.01;
  const i = text.indexOf(q); if (i >= 0) return 60 - i * 0.1;
  let ti = 0, score = 0; for (const ch of q) { const j = text.indexOf(ch, ti); if (j < 0) return 0; score += j === ti ? 3 : 1; ti = j + 1; }
  return score;
}
function openPalette() {
  const p = $("palette"); p.hidden = false; const inp = $("palette-input"); inp.value = ""; runPalette(""); inp.focus();
  // tools become commands too — fetch once if the Tools view never loaded them
  if (!toolsLoadedAt) fetchTools(false).then(() => { if (!p.hidden) runPalette(inp.value); });
}
function closePalette() { $("palette").hidden = true; }
function runPalette(q) {
  const all = paletteCommands();
  let scored;
  if (!q.trim()) { const recent = prefs.recent.map((id) => all.find((c) => c.id === id)).filter(Boolean); scored = [...recent.map((c) => ({ ...c, group: "Recent" })), ...all.filter((c) => !recent.includes(c)).slice(0, 12)]; }
  else scored = all.map((c) => [fuzzy(q, c.title) * 2 + fuzzy(q, (c.sub || "") + " " + c.group) * 0.5, c]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 14).map(([, c]) => c);
  palItems = scored; palSel = 0;
  const ul = $("palette-list"); ul.innerHTML = "";
  if (!scored.length) { ul.appendChild(h(`<li class="ts-empty"><b>No command matches</b><span>Try “reconnect”, “effort”, a tool name or a settings word.</span></li>`)); $("palette-hint").textContent = ""; return; }
  scored.forEach((c, i) => {
    const li = h(`<li class="ts-palette-item ${c.danger ? "danger" : ""}" role="option" aria-selected="${i === 0}">${icon(c.icon || "chevron", 15)}<span class="t"></span><span class="g"></span></li>`);
    li.querySelector(".t").innerHTML = `${esc(c.title)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}`; li.querySelector(".g").textContent = c.group;
    li.addEventListener("mousemove", () => selectPal(i)); li.addEventListener("click", () => execPal(i));
    ul.appendChild(li);
  });
  $("palette-hint").textContent = `${scored.length} result${scored.length === 1 ? "" : "s"}`;
}
function selectPal(i) { palSel = Math.max(0, Math.min(palItems.length - 1, i)); $("palette-list").querySelectorAll(".ts-palette-item").forEach((li, j) => li.setAttribute("aria-selected", String(j === palSel))); const el = $("palette-list").children[palSel]; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
function execPal(i) { const c = palItems[i]; if (!c) return; closePalette(); rememberRecent(c.id); c.run(); }
$("palette-btn").addEventListener("click", openPalette);
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) closePalette(); });
$("palette-input").addEventListener("input", (e) => runPalette(e.target.value));
$("palette-input").addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); selectPal(palSel + 1); } else if (e.key === "ArrowUp") { e.preventDefault(); selectPal(palSel - 1); } else if (e.key === "Enter") { e.preventDefault(); execPal(palSel); } else if (e.key === "Escape") { e.preventDefault(); closePalette(); } });

// ── global keys ────────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); if ($("palette").hidden) openPalette(); else closePalette(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); showView(VIEWS[Number(e.key) - 1]); return; }
  if (e.key === "Escape" && !inField) { if (!$("palette").hidden) { closePalette(); return; } if ($("dlg").open) return; if (currentView === "settings" && currentCat) { openCategory(null); return; } }
  if (e.key === "/" && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) { const box = { activity: "act-search", tools: "tools-search", settings: "set-search" }[currentView]; if (box && $(box) && !$(box).closest("[hidden]")) { e.preventDefault(); $(box).focus(); } }
});

// ── wiring: pinned launchers ───────────────────────────────────────────────
$("reconnect").addEventListener("click", (e) => busy(e.currentTarget, () => bg({ type: "reconnect" }).then((r) => { setTimeout(refresh, 600); return r; }), { ok: "Reconnecting…" }));
$("restart").addEventListener("click", (e) => QUICK_ACTIONS.find((q) => q.id === "restart").run(e.currentTarget));
$("discord")?.addEventListener("click", () => {
  chrome.tabs.create({ url: DISCORD_URL });
});
// 1.74.0 — Donate: Robux game passes (SmallDono 10 · NormalDono 25 · BigDono 100 · HUGEDONO 500)
document.querySelectorAll(".dono[data-dono]").forEach((b) => b.addEventListener("click", () => { chrome.tabs.create({ url: b.dataset.dono }); }));
document.getElementById("codecraft")?.addEventListener("click", () => {
  // Reuse an open CodeCraft chat tab (same conversation) instead of stacking copies.
  chrome.tabs.query({ url: CODECRAFT_PAGE_URL + "*" }, (tabs) => {
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: CODECRAFT_PAGE_URL });
  });
});
$("blender")?.addEventListener("click", () => {
  $("settings")?.click();
});
$("blockbench")?.addEventListener("click", () => {
  $("settings")?.click();
});
$("settings").addEventListener("click", () => {
  // Same mechanism as the Ko-fi button (chrome.tabs), but tries the in-page
  // panel on an already-open supported AI tab first, so opening it doesn't
  // require a conversation to already be started there.
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && isSupportedTab(t.url));
    const anySupported = active || tabs.find((t) => isSupportedTab(t.url));
    if (anySupported) {
      // .catch: the tab's content script may not be injected yet (fresh load /
      // post-reload) — MV3 sendMessage rejects as an unhandled promise then.
      chrome.tabs.sendMessage(anySupported.id, { type: "rs-open-menu" }).catch(() => {});
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

$("engine-roblox")?.addEventListener("click", () => setEngine("roblox"));
$("engine-local")?.addEventListener("click", () => setEngine("local"));

for (const id of WORK_MODES) {
  $("work-" + id)?.addEventListener("click", () => setWorkMode(id));
}
for (const id of PERM_MODES) {
  $("perm-" + id)?.addEventListener("click", () => setPermMode(id));
}
function bindToggle(elId, key, field) {
  const el = $(elId);
  if (!el) return;
  const flip = () => setFlag(key, field, !settings[field]);
  el.addEventListener("click", flip);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
  });
}
bindToggle("tgl-autofix", "rsAutoFix", "autofix");
bindToggle("tgl-bg", "rsBgMode", "bg");
bindToggle("tgl-sounds", "rsSounds", "sounds");
$("qa-edit").addEventListener("click", editQuick);

const publishAutomation=document.getElementById("publish-automation");
if(publishAutomation){chrome.storage.local.get("rsAllowPublishAutomation").then((r)=>publishAutomation.checked=r.rsAllowPublishAutomation===true);publishAutomation.addEventListener("change",()=>chrome.storage.local.set({rsAllowPublishAutomation:publishAutomation.checked===true}));}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes) return;
    if (changes.rsWorkMode && changes.rsWorkMode.newValue) settings.workMode = normalizeWorkMode(changes.rsWorkMode.newValue);
    if (changes.rsPermMode && typeof changes.rsPermMode.newValue === "string") settings.permMode = PERM_MODES.includes(changes.rsPermMode.newValue) ? changes.rsPermMode.newValue : "sandbox";
    if (changes.rsSounds && typeof changes.rsSounds.newValue === "boolean") settings.sounds = changes.rsSounds.newValue;
    if (changes.rsExtraThinking && typeof changes.rsExtraThinking.newValue === "boolean") settings.extra = changes.rsExtraThinking.newValue;
    if (changes.rsForgeMode && typeof changes.rsForgeMode.newValue === "boolean") settings.forge = changes.rsForgeMode.newValue;
    if (changes.rsAutoFix && typeof changes.rsAutoFix.newValue === "boolean") settings.autofix = changes.rsAutoFix.newValue;
    if (changes.rsBgMode && typeof changes.rsBgMode.newValue === "boolean") settings.bg = changes.rsBgMode.newValue;
    if (changes.rsBrand) settings.brand = sanitizeBrandLite(changes.rsBrand.newValue);
    if (changes[PREF_KEY]) { prefs = cleanPrefs(changes[PREF_KEY].newValue); applyPrefs(); renderQuick(); }
    renderSettings();
  });
} catch {}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "rs-status") render(msg);
  if (msg && msg.type === "rs-engine" && msg.engine) renderEngine(msg.engine);
  if (msg && msg.type === "rs-activity" && msg.item) onActivityPush(msg.item);
});

// ── boot ───────────────────────────────────────────────────────────────────
(async () => {
  $("ver").textContent = `v${VERSION}`;
  const runHint = $("run-hint");
  if (runHint) runHint.textContent = RUN_CMD;
  const p = await storeGet([PREF_KEY]); prefs = cleanPrefs(p[PREF_KEY]); applyPrefs();
  try { const ss = await chrome.storage.session.get("tsSeenAt"); if (ss && Number.isFinite(ss.tsSeenAt)) seenAt = ss.tsSeenAt; } catch {}
  renderCategories(); renderQuick();
  getEngine().then(renderEngine);
  await loadSettings();
  refresh(); refreshProvider(); loadActivity();
  refreshUpdate();
  showView(prefs.startView || "home");
  // Status is pushed (rs-status) on every change and every bridge heartbeat;
  // the slow poll below only covers a worker that was asleep when we opened.
  setInterval(refresh, 10000);
})();
