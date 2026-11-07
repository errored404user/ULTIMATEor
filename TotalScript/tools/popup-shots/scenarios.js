// Scenarios for shoot.js — each renders popup.html with a seeded extension state.
const TAB_DS = { id: 1, active: true, url: "https://chat.deepseek.com/a/chat/s/1", title: "DeepSeek" };
const CONNECTED = { connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, roblox_connected: true, lifecycle: "READY", tools: 25, servers: [{ id: "roblox", alive: true, tools: 4 }, { id: "local", alive: true, tools: 21 }] };
const now = Date.now();
const ACTIVITY = [
  { at: now - 90000, kind: "conn", level: "ok", text: "Bridge connected (Roblox)", ms: 41, engine: "roblox" },
  { at: now - 80000, kind: "tool", level: "ok", text: "get_place_tree ok", tool: "roblox/get_place_tree", ms: 212, engine: "roblox" },
  { at: now - 60000, kind: "tool", level: "error", text: "script_read failed: Instance not found at Workspace.Oyuncu.Çıkış_Kapısı", tool: "roblox/script_read", ms: 88, code: "SCRIPT_NOT_FOUND", engine: "roblox" },
  { at: now - 30000, kind: "engine", level: "info", text: "Engine switched to AgentScript", engine: "local" },
  { at: now - 10000, kind: "conn", level: "warn", text: "Bridge connection dropped — reconnecting", code: "MCP_CONNECTION_CLOSED", engine: "local" },
];
const TOOLS = [
  { name: "roblox/execute_luau", description: "Run Luau inside the open place. Returns Output lines and the serialized result.", inputSchema: { properties: { code: {}, timeout: {} } } },
  { name: "roblox/script_read", description: "Read a script's Source by Explorer path — görüntüle, değiştir, kaydet (Türkçe karakter testi: ç ğ ı İ ö ş ü).", inputSchema: { properties: { path: {} } } },
  { name: "roblox/get_place_tree", description: "Explorer tree up to a depth." },
  { name: "local/read_file", description: "Read a file from the AgentScript workspace." },
  { name: "local/run_command", description: "Run a shell command in the workspace (Full PC only). A very long description that keeps going to test the two-line clamp and the expand-on-click behaviour of the tool row in the popup." },
  { name: "blender/get_scene_info", description: "Scene summary from the Blender addon." },
];
module.exports = [
  { name: "popup-offline", shot: { tabs: [TAB_DS] } },
  { name: "popup-connected", shot: { tabs: [TAB_DS], status: CONNECTED, storage: { rsWorkMode: "blender", rsPermMode: "full" } } },
  { name: "popup-home-full", fullPage: true, shot: { tabs: [TAB_DS], status: CONNECTED } },
  { name: "popup-activity", shot: { tabs: [TAB_DS], status: CONNECTED, activity: ACTIVITY }, steps: ["document.querySelector('.ts-tab[data-view=activity]').click()"] },
  { name: "popup-error-viewer", shot: { tabs: [TAB_DS], status: CONNECTED, activity: ACTIVITY }, steps: ["document.querySelector('.ts-tab[data-view=activity]').click()", "document.querySelector('.act-item.clickable').click()"] },
  { name: "popup-tools", shot: { tabs: [TAB_DS], status: CONNECTED, tools: TOOLS }, steps: ["document.querySelector('.ts-tab[data-view=tools]').click()", "document.querySelector('.tool-item').click()"] },
  { name: "popup-settings", shot: { tabs: [TAB_DS], status: CONNECTED }, steps: ["document.querySelector('.ts-tab[data-view=settings]').click()"] },
  { name: "popup-settings-agents", fullPage: true, shot: { tabs: [TAB_DS], status: CONNECTED }, steps: ["document.querySelector('.ts-tab[data-view=settings]').click()", "document.querySelector('.cat[data-cat=agents]').click()"] },
  { name: "popup-settings-search", shot: { tabs: [TAB_DS], status: CONNECTED }, steps: ["document.querySelector('.ts-tab[data-view=settings]').click()", "const i=document.getElementById('set-search'); i.value='auto'; i.dispatchEvent(new Event('input'))"] },
  { name: "popup-support-donate", fullPage: true, shot: { tabs: [TAB_DS], status: CONNECTED }, steps: ["document.querySelector('.ts-tab[data-view=settings]').click()", "document.querySelector('.cat[data-cat=support]').click()"] },
  { name: "popup-palette", shot: { tabs: [TAB_DS], status: CONNECTED, tools: TOOLS }, steps: ["document.getElementById('palette-btn').click()", "const i=document.getElementById('palette-input'); i.value='re'; i.dispatchEvent(new Event('input'))"] },
  { name: "popup-light-violet", shot: { tabs: [TAB_DS], status: CONNECTED, storage: { tsPopup: { theme: "light", accent: "violet" } } } },
  { name: "popup-compact-large", shot: { tabs: [TAB_DS], status: CONNECTED, storage: { tsPopup: { density: "compact", text: "large" } } } },
  { name: "popup-shortcuts", fullPage: true, shot: { tabs: [TAB_DS], status: CONNECTED }, steps: ["document.querySelector('.ts-tab[data-view=settings]').click()", "document.querySelector('.cat[data-cat=shortcuts]').click()"] },
];
