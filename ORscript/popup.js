// SPDX-License-Identifier: GPL-3.0-or-later
const DISCORD_URL = "https://discord.gg/YqVZaZYuy";
const THEMES = ["night", "blood-moon", "sakura", "starglaze", "autumn", "pixelated", "void", "epicface", "headooh", "ragequit", "killfeed", "shitpost", "skillissue", "pogchamp", "glitchlord", "npcenergy"];
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "claude.ai", "claude.com",
  "gemini.google.com", "www.kimi.com", "kimi.com",
  "build.nvidia.com/moonshotai/kimi-k3", "chat.z.ai", "chat.qwen.ai", "arena.ai",
  "www.meta.ai", "meta.ai",
  "gpt.crax.lol", "www.notion.so", "app.notion.so", "www.notion.com", "notion.com", "oxalpha.com", "www.oxalpha.com", "oxalpha.org", "www.oxalpha.org", "c.vani.ai",
  "agent.minimax.io", "overchat.ai", "www.overchat.ai", "huggingface.co", "www.huggingface.co",
  "chat.mistral.ai", "mistral.ai", "openrouter.ai", "www.openrouter.ai", "console.groq.com",
  "dashboard.cohere.com", "api.together.ai", "fireworks.ai", "app.fireworks.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";
// CodeCraft API (codecraftapi.com) is API-only; ORscript hosts its chat page.
const CODECRAFT_PAGE_URL = (() => { try { return chrome.runtime.getURL("codecraft.html"); } catch { return ""; } })();
const isCodeCraftTab = (url) => !!(url && CODECRAFT_PAGE_URL && url.startsWith(CODECRAFT_PAGE_URL));
const isSupportedTab = (url) => !!url && (SUPPORTED_HOSTS.some((h) => url.includes(h)) || isCodeCraftTab(url));
const ENGINE_KEY = "rs-engine"; // "roblox" | "local"
const ENGINES = ["roblox", "local"];
const WORK_MODES = ["ultimate", "visualizer", "animator"];
// Every mode wants the deeper self-review loop; specialists run on top of Ultimate.
const WORK_PRESETS = {
  ultimate:   { thinking: "max",  extra: false },
  visualizer: { thinking: "max",  extra: false },
  animator:   { thinking: "max",  extra: false },
};
const WORK_HELP = {
  ultimate:   "Flagship mode: senior Luau engineer and 3D modeler in one. Reads the project first, architects server-authoritative systems with typed modules, remotes and DataStores, blocks out and details models to scale, and verifies with playtests, console reads and screenshots.",
  visualizer: "VFX, lighting and UI specialist. Sets the mood with lighting and post-FX, layers particles, beams, trails and lights, builds UI from a design system, then screenshots and polishes until it looks shipped.",
  animator:   "Animation specialist. Drives the animation editor (rigs, poses, keyframes, easing, markers), tweens, springs, IK and camera beats, and previews every clip before calling it done.",
};

const PERM_MODES = ["sandbox", "ask", "full"];
const settings = {
  workMode: "ultimate",
  permMode: "sandbox",
  theme: "night",
  extra: false,
  forge: true,
  autofix: true,
  bg: true,
  sounds: true,
};

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
}
function renderEngine(v) {
  const isLocal = v === "local";
  const rob = document.getElementById("engine-roblox");
  const loc = document.getElementById("engine-local");
  const label = document.getElementById("engine-label");
  const hintRow = document.getElementById("hint-row");
  const restart = document.getElementById("restart");
  // Segmented control: .on class carries the active styling (see popup.html CSS)
  if (rob) rob.classList.toggle("on", !isLocal);
  if (loc) loc.classList.toggle("on",  isLocal);
  if (label) label.textContent = isLocal ? "AgentScript" : "Roblox";
  if (restart) restart.textContent = isLocal ? "⟳ Restart AgentScript server" : "⟳ Restart Roblox server";
  if (hintRow) {
    const engEl = document.getElementById("hint-engine");
    if (engEl) engEl.textContent = isLocal ? "your project folder" : "Roblox Studio";
  }
}

function renderSettings() {
  for (const id of WORK_MODES) {
    const el = document.getElementById("work-" + id);
    if (el) el.classList.toggle("on", settings.workMode === id);
  }
  const help = document.getElementById("work-help");
  if (help) help.textContent = WORK_HELP[settings.workMode] || WORK_HELP.ultimate;
  for (const id of PERM_MODES) {
    const el = document.getElementById("perm-" + id);
    if (el) el.classList.toggle("on", settings.permMode === id);
  }
  for (const id of THEMES) {
    const el = document.getElementById("theme-" + id);
    if (el) el.classList.toggle("on", settings.theme === id);
  }
  document.documentElement.setAttribute("data-theme", settings.theme);
  const logo = document.getElementById("or-logo");
  if (logo) {
    const names = { night: "Night", "blood-moon": "Blood Moon", sakura: "Sakura", starglaze: "Starglaze", autumn: "Autumn", pixelated: "Pixelated" };
    logo.textContent = settings.theme==="void"?"VoidScript":"OrScript";
  }
  const map = [
    ["tgl-extra", settings.extra],
    ["tgl-autofix", settings.autofix],
    ["tgl-bg", settings.bg],
    ["tgl-sounds", settings.sounds],
  ];
  for (const [id, on] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }
}

async function loadSettings() {
  try {
    const r = await chrome.storage.local.get([
      "rsWorkMode", "rsPermMode", "rsTheme", "rsSounds", "rsExtraThinking", "rsForgeMode", "rsAutoFix", "rsBgMode",
    ]);
    if (WORK_MODES.includes(r.rsWorkMode)) settings.workMode = r.rsWorkMode;
    if (PERM_MODES.includes(r.rsPermMode)) settings.permMode = r.rsPermMode;
    if (THEMES.includes(r.rsTheme)) settings.theme = r.rsTheme;
    if (typeof r.rsSounds === "boolean") settings.sounds = r.rsSounds;
    if (typeof r.rsExtraThinking === "boolean") settings.extra = r.rsExtraThinking;
    if (typeof r.rsForgeMode === "boolean") settings.forge = r.rsForgeMode;
    if (typeof r.rsAutoFix === "boolean") settings.autofix = r.rsAutoFix;
    if (typeof r.rsBgMode === "boolean") settings.bg = r.rsBgMode;
  } catch {}
  renderSettings();
}

async function setTheme(id) {
  if (!THEMES.includes(id)) return;
  settings.theme = id;
  renderSettings();
  try { await chrome.storage.local.set({ rsTheme: id }); } catch {}
}

async function setPermMode(id) {
  if (!PERM_MODES.includes(id)) return;
  settings.permMode = id;
  renderSettings();
  try { await chrome.storage.local.set({ rsPermMode: id }); } catch {}
  try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: id === "full" }).catch(() => {}); } catch {}
}

async function setWorkMode(id) {
  if (!WORK_MODES.includes(id)) return;
  const p = WORK_PRESETS[id];
  settings.workMode = id;
  settings.extra = p.extra;
  renderSettings();
  try {
    await chrome.storage.local.set({
      rsWorkMode: id,
      rsThinkingLevel: p.thinking,
      rsExtraThinking: p.extra,
    });
  } catch {}
}

async function setFlag(key, field, v) {
  settings[field] = !!v;
  renderSettings();
  try { await chrome.storage.local.set({ [key]: settings[field] }); } catch {}
}

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;
const runHint = document.getElementById("run-hint");
const IS_WINDOWS_HOST = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
const RUN_CMD = IS_WINDOWS_HOST ? "bin/or-core.exe" : "bin/or-core";
if (runHint) {
  runHint.textContent = RUN_CMD;
}
(async () => {
  try {
    const el = document.getElementById("site-tag");
    if (!el) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tab && tab.url) || "";
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const names = {
      "chat.deepseek.com": "DeepSeek", "deepseek.com": "DeepSeek",
      "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT",
      "claude.ai": "Claude", "claude.com": "Claude",
      "gemini.google.com": "Gemini",
      "kimi.com": "Kimi", "kimi.ai": "Kimi",
      "build.nvidia.com": "NVIDIA NIM · Kimi K3",
      "chat.z.ai": "GLM", "chat.qwen.ai": "Qwen",
      "arena.ai": "Arena",
      "meta.ai": "Meta AI",
      "gpt.crax.lol": "Crax", "www.notion.so": "Notion", "app.notion.so": "Notion", "www.notion.com": "Notion", "notion.com": "Notion",
      "oxalpha.com": "Ox Alpha", "www.oxalpha.com": "Ox Alpha", "c.vani.ai": "Vani Chat",
    };
    el.textContent = isCodeCraftTab(url) ? "CodeCraft API" : (names[host] || (SUPPORTED_HOSTS.some((h) => url.includes(h)) ? (host || "Chat") : "Idle"));
  } catch {}
})();

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const hintRow = document.getElementById("hint-row");
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
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.classList.toggle("ok", ok);
  state.textContent = s.connected
    ? (ok ? (isLocal ? "Connected — AgentScript is ready" : "Connected — Studio is ready")
        : studioOff ? "Studio MCP is off — enable it in Assistant settings"
        : (isLocal ? "Bridge is up — AgentScript ready" : "Bridge is up — open Studio"))
    : `Bridge is offline — run ${RUN_CMD}`;
  tools.textContent = s.connected ? `${s.tools || 0} tools ready` : `Run ${RUN_CMD}`;
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
  if (hintRow) hintRow.style.display = ok ? "none" : "";
  // keep engine toggle in sync from bg status (in case popup opened after toggle)
  if (s.engine) try { const raw = s.engine === "anim" ? "roblox" : s.engine; const e = ENGINES.includes(raw) ? raw : "roblox"; if (typeof renderEngine === "function") renderEngine(e); } catch {}
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart Roblox server";
    setTimeout(refresh, 600);
  });
});
document.getElementById("discord")?.addEventListener("click", () => {
  chrome.tabs.create({ url: DISCORD_URL });
});
document.getElementById("codecraft")?.addEventListener("click", () => {
  // Reuse an open CodeCraft chat tab (same conversation) instead of stacking copies.
  chrome.tabs.query({ url: CODECRAFT_PAGE_URL + "*" }, (tabs) => {
    if (tabs && tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: CODECRAFT_PAGE_URL });
  });
});
document.getElementById("blender")?.addEventListener("click", () => {
  document.getElementById("settings")?.click();
});
document.getElementById("settings").addEventListener("click", () => {
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

document.getElementById("engine-roblox")?.addEventListener("click", () => setEngine("roblox"));
document.getElementById("engine-local")?.addEventListener("click", () => setEngine("local"));

for (const id of WORK_MODES) {
  document.getElementById("work-" + id)?.addEventListener("click", () => setWorkMode(id));
}
for (const id of PERM_MODES) {
  document.getElementById("perm-" + id)?.addEventListener("click", () => setPermMode(id));
}
for (const id of THEMES) {
  document.getElementById("theme-" + id)?.addEventListener("click", () => setTheme(id));
}
function bindToggle(elId, key, field) {
  const el = document.getElementById(elId);
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

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes) return;
    if (changes.rsWorkMode && WORK_MODES.includes(changes.rsWorkMode.newValue)) settings.workMode = changes.rsWorkMode.newValue;
    if (changes.rsPermMode && PERM_MODES.includes(changes.rsPermMode.newValue)) settings.permMode = changes.rsPermMode.newValue;
    if (changes.rsTheme && THEMES.includes(changes.rsTheme.newValue)) settings.theme = changes.rsTheme.newValue;
    if (changes.rsSounds && typeof changes.rsSounds.newValue === "boolean") settings.sounds = changes.rsSounds.newValue;
    if (changes.rsExtraThinking && typeof changes.rsExtraThinking.newValue === "boolean") settings.extra = changes.rsExtraThinking.newValue;
    if (changes.rsForgeMode && typeof changes.rsForgeMode.newValue === "boolean") settings.forge = changes.rsForgeMode.newValue;
    if (changes.rsAutoFix && typeof changes.rsAutoFix.newValue === "boolean") settings.autofix = changes.rsAutoFix.newValue;
    if (changes.rsBgMode && typeof changes.rsBgMode.newValue === "boolean") settings.bg = changes.rsBgMode.newValue;
    renderSettings();
  });
} catch {}

getEngine().then(renderEngine);
loadSettings();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "rs-status") render(msg);
  if (msg && msg.type === "rs-engine" && msg.engine) renderEngine(msg.engine);
});
refresh();
setInterval(refresh, 2000);

const publishAutomation=document.getElementById("publish-automation");
if(publishAutomation){chrome.storage.local.get("rsAllowPublishAutomation").then((r)=>publishAutomation.checked=r.rsAllowPublishAutomation===true);publishAutomation.addEventListener("change",()=>chrome.storage.local.set({rsAllowPublishAutomation:publishAutomation.checked===true}));}
