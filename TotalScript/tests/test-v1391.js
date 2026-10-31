// 1.39.1 — Settings: the theme picker and the memory feature are removed.
// "Remove themes in settings" / "Remove memory feature in settings".
// Run from the TotalScript root: node tests/test-v1391.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const main = read("src/core/main.js");
const css = read("overlay.css");
const popupHtml = read("popup.html");
const popupJs = read("popup.js");
const cfg = read("src/core/config.js");
const readme = read("README.md");
const mf = JSON.parse(read("manifest.json"));

let failed = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || extra === undefined ? "" : "  → " + String(extra).slice(0, 160)}`);
  if (!cond) failed++;
}

// ── A. Themes: picker gone from the settings tray ─────────────────────────────
const tray = main.slice(main.indexOf('<section class="rs-menu-sec rs-work-sec">') > 0 ? main.indexOf('<section class="rs-menu-sec rs-work-sec">') : main.indexOf("rs-menu-sec"));
ok("tray has no Themes section", !main.includes("rs-theme-sec") && !main.includes("<span>Themes</span>"));
ok("tray has no theme cards / Surprise Me / exit preview / sound strip", !main.includes("data-theme-card") && !main.includes("Surprise Me") && !main.includes("data-theme-random") && !main.includes("data-theme-exit-preview") && !main.includes("data-theme-sound-preview") && !main.includes("rs-theme-tools"));
ok("tray has no theme volume / effects / intensity controls", !main.includes("data-theme-volume") && !main.includes("data-meme-effects") && !main.includes("data-meme-intensity") && !main.includes("data-theme-sounds"));
ok("picker handlers removed", !main.includes('querySelectorAll("[data-theme-card]")') && !main.includes("previewOrTheme") && !main.includes("exitThemePreview") && !main.includes("themePreviewId") && !main.includes("function setOrTheme") && !main.includes("applyThemeVolume") && !main.includes("setMemeEffects") && !main.includes("setMemeIntensity") && !main.includes("SFX_LABELS"));
ok("skin pinned to Aqua, rsTheme never read or written", main.includes('const totalTheme = "aqua";') && !/\brsTheme\b/.test(main) && !main.includes("changes.rsTheme"));
ok("themes help topic removed", !/\n\s+themes:\{title:/.test(main) && !main.includes('"Themes & appearance"'));
ok("skin engine still present (applyOrSkin, corner rail, sound packs)", main.includes("function applyOrSkin()") && main.includes('setAttribute("data-rs-theme", totalTheme)') && main.includes("rs-theme-corners") && main.includes("const THEME_SOUNDS = {") && main.includes("function playSfx(kind, themeId)") && main.includes("THEME_SOUNDS[themeId || totalTheme]"));
ok("stored sound / effect prefs still honoured", main.includes('chrome.storage.local.get(["rsSounds", "rsThemeVolume", "rsMemeEffects", "rsMemeIntensity"]') && main.includes("changes.rsSounds"));

// ── B. Themes: popup ──────────────────────────────────────────────────────────
ok("popup has no Visual skin row", !popupHtml.includes("Visual skin") && !popupHtml.includes('id="theme-row"') && !/id="theme-[a-z-]+"/.test(popupHtml) && !popupHtml.includes("theme-art"));
ok("popup html is pinned to the aqua tokens (night kept as the fallback skin)", popupHtml.includes('<html data-theme="aqua">') && popupHtml.includes('html[data-theme="aqua"]{--bg:') && !/html\[data-theme="(?!aqua"|night")[a-z-]+"\]/.test(popupHtml) && !popupHtml.includes("#theme-row"));
ok("popup.js has no theme state", !popupJs.includes("const THEMES") && !popupJs.includes("rsTheme") && !popupJs.includes("setTheme(") && !popupJs.includes("settings.theme") && popupJs.includes('setAttribute("data-theme", "aqua")') && popupJs.includes('logo.textContent = "TotalScript"'));
ok("popup Sounds toggle still exists", popupHtml.includes('id="tgl-sounds"') && popupJs.includes("rsSounds"));

// ── C. Themes: CSS ────────────────────────────────────────────────────────────
ok("picker-only CSS removed", !css.includes(".rs-theme-card") && !css.includes(".rs-theme-tools") && !css.includes(".rs-theme-sound-list") && !css.includes(".rs-theme-sound-name") && !css.includes(".rs-theme-row") && !css.includes(".rs-theme-sec") && !css.includes(".rs-theme-art"));
ok("night skin CSS intact", css.includes('html[data-rs-theme="night"] {') && css.includes('html[data-rs-theme="night"] { --totalx-tile:') && /html\[data-rs-theme="night"\] \{ --totalx-orn: url\("data:image\/svg\+xml;utf8,<svg/.test(css) && css.includes("#rs-root .rs-corner-tl::before"));
ok("CSS braces balanced after the block removal", css.split("{").length === css.split("}").length);

// ── D. Memory: settings section + machinery gone ──────────────────────────────
ok("tray has no Coding memory / Session recap section", !main.includes("rs-memory-sec") && !main.includes("<span>Coding memory</span>") && !main.includes("<span>Session recap</span>") && !/id="rs-mem-(key|coding|project|preferences|task|save|status|recap|recap-on|recap-forget)"/.test(main));
ok("custom memory state removed", !main.includes("customMemory") && !main.includes("rsCustomMemory") && !main.includes("getCustomMemory") && !main.includes("syncMenuMemory") && !main.includes("clearTaskMemory") && !main.includes("switchMemoryProject") && !main.includes("__rsClearTaskMemory"));
ok("session recap recorder removed", !main.includes("rsAutoMemory") && !main.includes("rsAutoRecap") && !main.includes("autoRecap") && !main.includes("recordSessionTool") && !main.includes("flushSessionRecap") && !main.includes("__rsRecapChanged") && !main.includes("RECAP_MAX_SESSIONS") && !main.includes("sessionTouchedPath"));
ok("repeat guard (which lived next to the recorder) survives", main.includes("function applyRepeatGuard(call, feedback)") && main.includes("[LOOP GUARD]"));
ok("prompt builder is no longer given a memory block", !/memory:\s*ui\.getCustomMemory\(\)/.test(main) && !/\bmemory:\s*[a-zA-Z_.()]+,\n/.test(main.slice(main.indexOf("RS.buildSystemPrompt({"), main.indexOf("RS.buildSystemPrompt({") + 600)));
ok("memory CSS removed", !css.includes(".rs-memory-sec") && !css.includes(".rs-memory-label") && !css.includes(".rs-mem-recap"));
ok("in-Studio handbook commands are untouched", read("src/core/skills/studio_ultimate.js").includes('name: "memory_update_section"') && cfg.includes("PROJECT MEMORY: RobloxScript has a durable, shared memory document"));

// ── E. config.js: no memory text reaches the prompt when none is passed ───────
{
  const sandbox = { console, window: undefined, chrome: { runtime: { getManifest: () => mf, getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cfg + ";globalThis.__RS = (typeof RS !== 'undefined') ? RS : (window.RS || null);", sandbox);
  const RS = sandbox.__RS || sandbox.RS;
  ok("config.js loads in a vm", !!RS && typeof RS.buildSystemPrompt === "function");
  if (RS && typeof RS.buildSystemPrompt === "function") {
    const text = RS.buildSystemPrompt({ siteName: "Test", customPrompt: "", providerNotes: "", providerId: "chatgpt", engine: "roblox", embedCatalogue: false });
    ok("system prompt has no 'My coding memory' / 'Recent sessions' block", !/My coding memory|Recent sessions \(auto-recorded/.test(text), text.length + " chars");
  }
}

// ── F. Pins / docs ────────────────────────────────────────────────────────────
ok("manifest 1.39.1+", /^1\.39\.[1-9]\d*$|^1\.[4-9]\d\.|^[2-9]\.\d+\.\d+$/.test(mf.version), mf.version);
ok("plugin + crate pinned to the manifest version", read("plugin/TotalScript.lua").includes('local VERSION = "' + mf.version + '"') && read("agent/Cargo.toml").includes('version = "' + mf.version + '"') && read("agent/Cargo.lock").includes('name = "total-agent"\nversion = "' + mf.version + '"'));
ok("README changelog 1.39.1 + test listed", readme.includes("**1.39.1 — Settings: themes and memory removed.**") && readme.includes("`total-agent` " + mf.version) && readme.includes("test-v1391.js"));

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.39.1 checks passed");
process.exit(failed ? 1 : 0);
