// 2.12.0 — extension UI rebuild: functional walk of the popup "Command Center"
// in jsdom with the dev-tool chrome shim (tools/popup-shots/chrome-shim.js).
// Interaction checks: views, connection monitor, quick actions, session cards,
// activity center + error viewer, tools list, settings categories / search /
// reset, command palette, keyboard shortcuts, Turkish text, and the rule that
// every visible button does something observable (no decorative controls).
const fs = require("fs");
const path = require("path");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (!JSDOM) { console.log("SKIP  jsdom not installed (npm i jsdom)"); process.exit(0); }
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; process.exitCode = 1; } console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "  — " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const popupHtml = read("popup.html");
const popupJs = read("popup.js");
const shim = read("tools/popup-shots/chrome-shim.js");

const TAB_DS = { id: 1, active: true, url: "https://chat.deepseek.com/a/chat/s/1", title: "DeepSeek" };
const CONNECTED = { connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, roblox_connected: true, lifecycle: "READY", tools: 25, servers: [{ id: "roblox", alive: true, tools: 4 }, { id: "local", alive: true, tools: 21 }] };
const TR = "Workspace.Oyuncu.Çıkış_Kapısı — İşlem başarısız: güvenlik şartı";
const now = Date.now();
const ACTIVITY = [
  { at: now - 90000, kind: "conn", level: "ok", text: "Bridge connected (Roblox)", ms: 41, engine: "roblox" },
  { at: now - 60000, kind: "tool", level: "error", text: "script_read failed: Instance not found at " + TR, tool: "roblox/script_read", ms: 88, code: "SCRIPT_NOT_FOUND", engine: "roblox" },
  { at: now - 10000, kind: "conn", level: "warn", text: "Bridge connection dropped — reconnecting", code: "MCP_CONNECTION_CLOSED", engine: "roblox" },
];
const TOOLS = [
  { name: "roblox/execute_luau", description: "Run Luau inside the open place.", inputSchema: { properties: { code: {}, timeout: {} } } },
  { name: "roblox/script_read", description: "Read a script's Source — görüntüle (ç ğ ı İ ö ş ü)." },
  { name: "local/read_file", description: "Read a file from the AgentScript workspace." },
  { name: "blender/get_scene_info", description: "Scene summary from the Blender addon." },
];

async function boot(shot) {
  const dom = new JSDOM(popupHtml.replace('<script src="popup.js"></script>', ""), { url: "chrome-extension://harness/popup.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.__SHOT = shot || {};
  // jsdom gaps: <dialog> methods, scrollIntoView, clipboard, URL.createObjectURL.
  if (!w.HTMLDialogElement.prototype.showModal) { w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; }
  if (!w.Element.prototype.scrollIntoView) w.Element.prototype.scrollIntoView = () => {};
  w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { w.__clip = t; } }, configurable: true });
  w.close = () => { w.__closed = true; };
  w.HTMLAnchorElement.prototype.click = function () { w.__anchorClicks = (w.__anchorClicks || 0) + 1; }; // jsdom cannot navigate to blob: downloads
  const inputClick = w.HTMLInputElement.prototype.click; w.HTMLInputElement.prototype.click = function () { if (this.type === "file") w.__fileDialogs = (w.__fileDialogs || 0) + 1; else inputClick.call(this); };
  w.eval(shim);
  const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
  w.eval(popupJs);
  // Wait for the first status round-trip to land (the shim answers on a
  // macrotask; a fixed 60 ms was flaky on a cold jsdom), then one more tick
  // for the dependent renders. Hard cap so a broken popup still fails fast.
  for (let t = 0; t < 150 && w.document.getElementById("state").textContent === "Bridge: …"; t++) await sleep(10);
  await sleep(40);
  return { w, d: w.document, errors, calls: w.__shotCalls };
}
const visible = (el) => { for (let n = el; n; n = n.parentElement) if (n.hidden || n.getAttribute("aria-hidden") === "true") return false; return true; };

(async () => {
  // ── A. offline home ──
  {
    const { w, d, errors } = await boot({ tabs: [TAB_DS] });
    ok("A1 boots with no page errors (offline)", errors.length === 0, errors.join(" | "));
    ok("A2 version pill reads the manifest", d.getElementById("ver").textContent === "v2.16.1");
    ok("A3 connection monitor says the bridge is offline with the run hint", /Bridge is offline — run bin\/total-core/.test(d.getElementById("state").textContent));
    ok("A4 getting-started checklist shows 0/4 and the first step is current", d.getElementById("steps-progress").textContent === "0/4" && d.querySelector('#start-steps li[data-step="bridge"]').className === "now");
    ok("A5 provider row recognises the DeepSeek tab", /DeepSeek in this tab/.test(d.getElementById("provider-state").textContent) && d.getElementById("site-tag").textContent === "DeepSeek");
    ok("A6 Home is the default view and the tab bar reflects it", !d.getElementById("view-home").hidden && d.querySelector('.ts-tab[data-view="home"]').getAttribute("aria-selected") === "true");
    ok("A7 quick actions render from the default list (8 real buttons)", d.querySelectorAll("#qa .ts-btn").length === 8);
    // Totality selected by default; perm sandbox
    ok("A8 session cards reflect defaults (Totality on, Sandbox on)", d.getElementById("work-creation").classList.contains("on") && d.getElementById("perm-sandbox").classList.contains("on"));
    // toggles write storage
    d.getElementById("tgl-autofix").click(); await sleep(10);
    const st = await w.chrome.storage.local.get(["rsAutoFix"]);
    ok("A9 Auto-fix switch writes rsAutoFix=false and flips aria-checked", st.rsAutoFix === false && d.getElementById("tgl-autofix").getAttribute("aria-checked") === "false");
    d.getElementById("work-blender").click(); await sleep(10);
    const st2 = await w.chrome.storage.local.get(["rsWorkMode", "rsExtraThinking"]);
    ok("A10 work card writes rsWorkMode=blender (+ preset) and moves the selection", st2.rsWorkMode === "blender" && st2.rsExtraThinking === false && d.getElementById("work-blender").classList.contains("on"));
    // Full PC asks first
    d.getElementById("perm-full").click(); await sleep(20);
    const dlg = d.getElementById("dlg");
    ok("A11 Full PC opens a confirm dialog instead of switching silently", dlg.hasAttribute("open") && /Full PC/.test(d.getElementById("dlg-title").textContent));
    d.querySelector("#dlg-foot .danger").click(); await sleep(20);
    const st3 = await w.chrome.storage.local.get(["rsPermMode"]);
    ok("A12 confirming writes rsPermMode=full and tells the worker (rs-set-full enabled:true)", st3.rsPermMode === "full" && w.__shotCalls.some((c) => c.type === "rs-set-full" && c.enabled === true));
    // engine
    d.getElementById("engine-local").click(); await sleep(10);
    ok("A13 engine segment writes rs-engine=local, sends rs-set-engine and relabels Studio row", (await w.chrome.storage.local.get(["rs-engine"]))["rs-engine"] === "local" && w.__shotCalls.some((c) => c.type === "rs-set-engine" && c.engine === "local") && d.getElementById("engine-label").textContent === "AgentScript" && d.getElementById("studio-title").textContent === "AgentScript workspace");
    // keyboard: Ctrl+2 → activity, / focuses search
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    ok("A14 Ctrl+2 switches to Activity", !d.getElementById("view-activity").hidden && d.getElementById("view-home").hidden);
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "/", bubbles: true }));
    ok("A15 '/' focuses the section's search box", d.activeElement === d.getElementById("act-search"));
    ok("A16 status is pushed, not polled every 2 s (single initial status + rs-status listener)", !/setInterval\(refresh, 2000\)/.test(popupJs) && /msg\.type === "rs-status"\) render\(msg\)/.test(popupJs) && w.__shotCalls.filter((c) => c.type === "status").length === 1);
  }

  // ── B. connected + activity + error viewer + tools ──
  {
    const { w, d, errors } = await boot({ tabs: [TAB_DS], status: CONNECTED, activity: ACTIVITY, tools: TOOLS });
    ok("B1 connected state is green and the checklist card folds away", /Connected — Studio is ready/.test(d.getElementById("state").textContent) && d.getElementById("hint-card").hidden && d.getElementById("dot").classList.contains("ok"));
    ok("B2 server detail lists both servers", /roblox \(4 tools\)/.test(d.getElementById("servers").textContent) && /local \(21 tools\)/.test(d.getElementById("servers").textContent));
    ok("B3 bell counts unread warnings/errors (2)", d.getElementById("bell-count").textContent === "2");
    d.querySelector('.ts-tab[data-view="activity"]').click(); await sleep(30);
    const items = [...d.querySelectorAll("#act-list .act-item")];
    ok("B4 activity lists 3 events newest first", items.length === 3 && /reconnecting/.test(items[0].textContent) && /Bridge connected/.test(items[2].textContent));
    ok("B5 Turkish text survives untouched in the log (ç ğ ı İ ö ş ü)", d.getElementById("act-list").textContent.includes(TR));
    ok("B6 opening Activity marks notifications seen", d.getElementById("bell-count").textContent === "");
    d.querySelector('#act-filters .ts-chip[data-f="error"]').click(); await sleep(5);
    ok("B7 Errors filter leaves only the failed tool call", d.querySelectorAll("#act-list .act-item").length === 1 && /script_read failed/.test(d.getElementById("act-list").textContent));
    d.querySelector('#act-filters .ts-chip[data-f="all"]').click();
    const s = d.getElementById("act-search"); s.value = "çıkış"; s.dispatchEvent(new w.Event("input")); await sleep(5);
    ok("B8 search is Unicode-aware (lowercase 'çıkış' finds 'Çıkış')", d.querySelectorAll("#act-list .act-item").length === 1);
    s.value = ""; s.dispatchEvent(new w.Event("input")); await sleep(5);
    d.querySelector("#act-list .act-item.clickable").click(); await sleep(10);
    const body = d.getElementById("dlg-body").textContent;
    ok("B9 error viewer explains SCRIPT_NOT_FOUND with message, engine, duration and steps", d.getElementById("dlg").hasAttribute("open") && d.getElementById("dlg-title").textContent === "Script not found" && body.includes("SCRIPT_NOT_FOUND") && body.includes(TR) && /88 ms/.test(body) && /Check the Explorer path/.test(body));
    d.querySelector("#dlg-foot .ts-btn").click(); await sleep(10);
    ok("B10 Copy details puts a JSON record with the code on the clipboard", typeof w.__clip === "string" && JSON.parse(w.__clip).code === "SCRIPT_NOT_FOUND");
    // clear asks first
    d.getElementById("act-clear").click(); await sleep(10);
    ok("B11 Clear asks for confirmation", d.getElementById("dlg").hasAttribute("open") && /Clear the activity log/.test(d.getElementById("dlg-title").textContent));
    d.querySelector("#dlg-foot .danger").click(); await sleep(10);
    ok("B12 confirmed clear sends activity_clear and empties the list", w.__shotCalls.some((c) => c.type === "activity_clear") && d.querySelector("#act-list .ts-empty"));
    // tools
    d.querySelector('.ts-tab[data-view="tools"]').click(); await sleep(40);
    const heads = [...d.querySelectorAll("#tools-groups .tool-head .ts-h3")].map((x) => x.textContent);
    ok("B13 tools grouped by server in Roblox → AgentScript → Blender order", heads.join("|") === "Roblox Studio|AgentScript (this PC)|Blender" && d.querySelectorAll(".tool-item").length === 4);
    ok("B14 tool row shows the bare name and the args from the schema", d.querySelector(".tool-item .tool-name").textContent === "execute_luau" && /args: code, timeout/.test(d.querySelector(".tool-item .tool-desc").textContent));
    const ts = d.getElementById("tools-search"); ts.value = "görüntüle"; ts.dispatchEvent(new w.Event("input"));
    ok("B15 tool search matches Turkish description text", d.querySelectorAll(".tool-item").length === 1 && d.getElementById("tools-count").textContent === "1 of 4");
    ts.value = ""; ts.dispatchEvent(new w.Event("input"));
    d.getElementById("tools-refresh").click(); await sleep(30);
    ok("B16 Refresh asks the bridge with refresh:true", w.__shotCalls.some((c) => c.type === "list_tools" && c.refresh === true));
    d.getElementById("open-cards").click(); await sleep(10);
    ok("B17 'Open the cards panel' goes to the supported tab and closes the popup", w.__shotCalls.some((c) => c.type === "tabs.update" && c.id === 1) && w.__closed === true);
    ok("B18 no page errors across the connected walk", errors.length === 0, errors.join(" | "));
  }

  // ── C. settings center ──
  {
    const { w, d, errors } = await boot({ tabs: [TAB_DS], status: CONNECTED });
    d.querySelector('.ts-tab[data-view="settings"]').click(); await sleep(10);
    const cats = [...d.querySelectorAll("#cat-list .cat b")].map((b) => b.textContent);
    ok("C1 nine categories in the agreed order", cats.join("|") === "General|Appearance|AI & Agents|Providers|Roblox Studio|Tools & Skills|Keyboard shortcuts|Advanced|Support & about");
    const q = d.getElementById("set-search"); q.value = "auto-fix"; q.dispatchEvent(new w.Event("input"));
    ok("C2 search finds the setting with its category", !d.getElementById("set-results").hidden && /Auto-fix playtest errors/.test(d.getElementById("set-results-list").textContent) && /AI & Agents/.test(d.getElementById("set-results-list").textContent));
    d.querySelector("#set-results-list .set-result").click(); await sleep(40);
    ok("C3 picking a result opens the category panel with that row", !d.getElementById("set-panel").hidden && d.getElementById("set-title").textContent === "AI & Agents" && d.querySelector('#set-panel [data-item="autofix"]'));
    // toggle in panel writes the real key
    const row = d.querySelector('#set-panel [data-item="plan"]'); row.click(); await sleep(10);
    ok("C4 Plan mode switch writes rsPlanMode=true", (await w.chrome.storage.local.get(["rsPlanMode"])).rsPlanMode === true && row.getAttribute("aria-checked") === "true");
    const sel = d.querySelector('#set-panel [data-item="effort"] select'); sel.value = "max"; sel.dispatchEvent(new w.Event("change")); await sleep(10);
    ok("C5 Reasoning effort select writes rsThinkingLevel=max", (await w.chrome.storage.local.get(["rsThinkingLevel"])).rsThinkingLevel === "max");
    const ta = d.querySelector('#set-panel [data-item="prompt"] textarea'); ta.value = "Her zaman Türkçe yorum yaz: ğüşıöç"; ta.dispatchEvent(new w.Event("input"));
    d.querySelector('#set-panel [data-item="prompt"] .ts-btn.primary').click(); await sleep(10);
    ok("C6 custom prompt saves to rsCustomPrompt unchanged (Turkish intact)", (await w.chrome.storage.local.get(["rsCustomPrompt"])).rsCustomPrompt === "Her zaman Türkçe yorum yaz: ğüşıöç");
    // per-category reset
    d.getElementById("set-reset").click(); await sleep(10);
    ok("C7 per-category Reset confirms first", d.getElementById("dlg").hasAttribute("open") && /Reset AI & Agents/.test(d.getElementById("dlg-title").textContent));
    d.querySelector("#dlg-foot .danger").click(); await sleep(40);
    const after = await w.chrome.storage.local.get(["rsPlanMode", "rsThinkingLevel", "rsCustomPrompt"]);
    ok("C8 reset removes only that category's keys", after.rsPlanMode === undefined && after.rsThinkingLevel === undefined && after.rsCustomPrompt === undefined);
    // appearance writes tsPopup and applies attributes
    d.getElementById("set-back").click(); await sleep(5);
    d.querySelector('.cat[data-cat="appearance"]').click(); await sleep(30);
    d.querySelector('#set-panel [data-item="theme"] .ts-seg button[data-v="light"]').click(); await sleep(10);
    d.querySelector('#set-panel [data-item="accent"] .swatch[data-v="violet"]').click(); await sleep(10);
    d.querySelector('#set-panel [data-item="density"] .ts-seg button[data-v="compact"]').click(); await sleep(10);
    const pp = (await w.chrome.storage.local.get(["tsPopup"])).tsPopup;
    ok("C9 theme / accent / density persist in tsPopup and apply to <html> (data-theme=aqua untouched)", pp.theme === "light" && pp.accent === "violet" && pp.density === "compact" && d.documentElement.getAttribute("data-ts-theme") === "light" && d.documentElement.getAttribute("data-accent") === "violet" && d.documentElement.getAttribute("data-density") === "compact" && d.documentElement.getAttribute("data-theme") === "aqua");
    d.querySelector('#set-panel [data-item="motion"]').click(); await sleep(10);
    ok("C10 Animations off sets data-motion=off", d.documentElement.getAttribute("data-motion") === "off");
    // shortcuts: conflict detection + modifier rule
    d.getElementById("set-back").click(); await sleep(5);
    d.querySelector('.cat[data-cat="shortcuts"]').click(); await sleep(30);
    const inputs = [...d.querySelectorAll("#kb-grid input")];
    ok("C11 four on-page shortcuts listed with their defaults", inputs.length === 4 && inputs.map((i) => i.value).join("|") === "Ctrl+Shift+O|Ctrl+Enter|Ctrl+Shift+V|Ctrl+Shift+T");
    inputs[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); await sleep(10);
    ok("C12 assigning a duplicate combo flags a conflict and does not save", inputs[0].getAttribute("aria-invalid") === "true" && inputs[1].getAttribute("aria-invalid") === "true" && /Conflict/.test(d.getElementById("kb-note").textContent) && (await w.chrome.storage.local.get(["rsKeybinds"])).rsKeybinds === undefined);
    inputs[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", altKey: true, bubbles: true })); await sleep(10);
    ok("C13 a unique combo saves rsKeybinds", (await w.chrome.storage.local.get(["rsKeybinds"])).rsKeybinds.menu === "Alt+K");
    inputs[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: "j", bubbles: true })); await sleep(10);
    ok("C14 a bare letter is refused (needs a modifier)", (await w.chrome.storage.local.get(["rsKeybinds"])).rsKeybinds.menu === "Alt+K");
    // export / import round trip
    d.getElementById("set-back").click(); await sleep(5);
    d.querySelector('.cat[data-cat="advanced"]').click(); await sleep(30);
    await w.chrome.storage.local.set({ rsBrand: { name: "Benim", logo: "data:image/png;base64,AAAA" } });
    let exported = null; const origBlob = w.Blob; w.Blob = function (parts, o) { exported = parts.join(""); return new origBlob(parts, o); };
    d.querySelector('#set-panel [data-item="export"] .ts-btn').click(); await sleep(20);
    const ex = JSON.parse(exported);
    ok("C15 export carries settings but strips the brand logo and the learned image tools", ex.settings.rsBrand.name === "Benim" && ex.settings.rsBrand.logo === undefined && !("rsImageTools" in ex.settings) && ex.totalscript === "2.16.1");
    // reset all confirms + removes keys
    d.querySelector('#set-panel [data-item="resetAll"] .ts-btn').click(); await sleep(10);
    ok("C16 Reset everything confirms first", d.getElementById("dlg").hasAttribute("open") && /Reset every TotalScript setting/.test(d.getElementById("dlg-title").textContent));
    d.querySelector("#dlg-foot .danger").click(); await sleep(60);
    const gone = await w.chrome.storage.local.get(["rsBrand", "rsKeybinds", "tsPopup", "rs-engine"]);
    ok("C17 reset-all removes agent, shortcut, popup and engine keys and resets Full PC on the worker", gone.rsBrand === undefined && gone.rsKeybinds === undefined && gone.tsPopup === undefined && gone["rs-engine"] === undefined && w.__shotCalls.some((c) => c.type === "rs-set-full" && c.enabled === false) && d.documentElement.getAttribute("data-ts-theme") === "dark");
    // support: donate card (pinned markup) is live
    d.getElementById("set-back").click(); await sleep(5);
    d.querySelector('.cat[data-cat="support"]').click(); await sleep(30);
    const donos = d.querySelectorAll("#set-panel #donate-card .dono[data-dono]");
    donos[3].click();
    ok("C18 Support renders the donate card and the passes open on roblox.com", donos.length === 4 && w.__shotCalls.some((c) => c.type === "tabs.create" && /game-pass\/1941672495/.test(c.url)));
    ok("C19 no page errors across the settings walk", errors.length === 0, errors.join(" | "));
  }

  // ── D. command palette ──
  {
    const { w, d, errors } = await boot({ tabs: [TAB_DS], status: CONNECTED, tools: TOOLS });
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    ok("D1 Ctrl+K opens the palette and focuses its input", !d.getElementById("palette").hidden && d.activeElement === d.getElementById("palette-input"));
    const inp = d.getElementById("palette-input");
    inp.value = "agentscript"; inp.dispatchEvent(new w.Event("input"));
    const first = d.querySelector("#palette-list .ts-palette-item");
    ok("D2 fuzzy search ranks 'Use the AgentScript engine' first", first && /AgentScript engine/.test(first.textContent));
    inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(10);
    ok("D3 Enter runs it: engine switched, palette closed, remembered as recent", d.getElementById("palette").hidden && d.getElementById("engine-label").textContent === "AgentScript" && (await w.chrome.storage.local.get(["tsPopup"])).tsPopup.recent[0] === "engine:local");
    d.getElementById("palette-btn").click(); await sleep(30);
    inp.value = "execute_luau"; inp.dispatchEvent(new w.Event("input"));
    ok("D4 live tools are commands too", /execute_luau/.test(d.querySelector("#palette-list .ts-palette-item").textContent));
    inp.value = "gui brief"; inp.dispatchEvent(new w.Event("input"));
    inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(40);
    ok("D5 a setting command deep-links into its category", !d.getElementById("view-settings").hidden && d.getElementById("set-title").textContent === "AI & Agents" && d.querySelector('#set-panel [data-item="guibrief"]'));
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("D6 Escape closes the palette", d.getElementById("palette").hidden);
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("D7 Escape in a category goes back to the category list", d.getElementById("set-panel").hidden && !d.getElementById("set-cats").hidden);
    ok("D8 no page errors across the palette walk", errors.length === 0, errors.join(" | "));
  }

  // ── E. every visible button does something observable ──
  {
    const { w, d } = await boot({ tabs: [TAB_DS], status: CONNECTED, activity: ACTIVITY, tools: TOOLS });
    const dead = [];
    const store = () => JSON.stringify(Object.keys(w.chrome.storage.local).length) + JSON.stringify(w.__store || "");
    const snapshot = () => [w.__shotCalls.length, d.body.innerHTML, d.documentElement.outerHTML.slice(0, 400), w.__closed === true, w.__clip || "", w.__anchorClicks || 0, w.__fileDialogs || 0, d.activeElement && d.activeElement.id].join("\u0001");
    const alreadyOn = (b) => b.getAttribute("aria-selected") === "true" || b.getAttribute("aria-pressed") === "true" || b.classList.contains("on") || b.getAttribute("aria-checked") === "true";
    const views = ["home", "activity", "tools", "settings"];
    for (const v of views) {
      d.querySelector(`.ts-tab[data-view="${v}"]`).click(); await sleep(30);
      const buttons = [...d.querySelectorAll(`#view-${v} button, header button, nav button`)].filter(visible);
      for (const b of buttons) {
        if (b.closest("#donate-card") || b.closest(".swatches") || alreadyOn(b)) continue; // external tabs / already-selected state — covered above
        const before = snapshot();
        b.click(); await sleep(25);
        if (snapshot() === before) dead.push(`${v}:#${b.id || b.className}:${b.textContent.trim().slice(0, 24)}`);
        try { d.getElementById("dlg").removeAttribute("open"); d.getElementById("palette").hidden = true; } catch {}
        w.__closed = false;
        if (v === "settings" && !d.getElementById("set-panel").hidden) { /* stay in panel for its buttons */ }
      }
    }
    // settings category panels
    for (const cat of ["general", "appearance", "agents", "providers", "studio", "tools", "shortcuts", "advanced", "support"]) {
      d.querySelector('.ts-tab[data-view="settings"]').click(); await sleep(10);
      d.querySelector(`.cat[data-cat="${cat}"]`).click(); await sleep(40);
      for (const b of [...d.querySelectorAll("#set-panel button")].filter(visible)) {
        if (b.closest("#donate-card") || b.closest(".swatches") || b.closest(".ts-seg") || alreadyOn(b)) continue;
        const before = snapshot();
        b.click(); await sleep(30);
        if (snapshot() === before) dead.push(`settings/${cat}:#${b.id || b.className}:${b.textContent.trim().slice(0, 24)}`);
        try { d.getElementById("dlg").removeAttribute("open"); } catch {}
        w.__closed = false;
        if (d.getElementById("set-panel").hidden) { d.querySelector(`.cat[data-cat="${cat}"]`).click(); await sleep(30); }
      }
    }
    ok("E1 every visible button changes state, sends a message, opens a dialog/tab or navigates (no decorative buttons)", dead.length === 0, dead.join(", "));
  }

  console.log(`test-extension-ui: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the popup keeps a slow status timer alive
})().catch((e) => { console.error("FAIL harness:", e && e.stack || e); process.exit(1); });
