// 2.0.4 — Paint (src/core/paint.js) was removed on request ("remove paint feature too"). This test pins
// (A) that nothing of the window is left anywhere the browser loads, (B) that the shared hand-off send
// path the Video Studio and the Prompt Enhancer ride still exists and is wired, and (C) that the
// Customize hide toggles no longer offer (or keep) a 'paint' entry.
// Run: node tests/test-paint-removed.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const exists = (f) => fs.existsSync(path.join(R, f));
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); } };

const main = read("src/core/main.js"), css = read("overlay.css"), manifest = JSON.parse(read("manifest.json")), html = read("codecraft.html");

// ── A. the module and every reference to it are gone ──
ok("A1 src/core/paint.js no longer exists", !exists("src/core/paint.js"));
const lists = manifest.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
ok("A2 no manifest bundle loads paint.js (12 bundles)", lists.length === 12 && lists.every((js) => !js.some((f) => /paint\.js/.test(f))));
ok("A3 codecraft.html does not load it", !/paint\.js/.test(html));
ok("A4 load order still holds without it: project_analyzer → reasoning → … → videostudio → main", lists.every((js) => { const i = (f) => js.indexOf("src/core/" + f); return i("project_analyzer.js") >= 0 && i("reasoning.js") === i("project_analyzer.js") + 1 && i("videostudio.js") > i("reasoning.js") && i("main.js") === i("videostudio.js") + 1; }));
ok("A5 main.js: no TotalPaint / __rsOpenPaint / openPaint / paintCaptureStudio / #rs-paint-btn / Ctrl+Shift+P", !/TotalPaint|__rsOpenPaint|openPaint\b|paintCaptureStudio|rs-paint-btn|Shift\+P\b/.test(main));
ok("A6 main.js: no Ctrl/⌘+Shift+P keydown listener", !/e\.key === "P" \|\| e\.key === "p"/.test(main));
ok("A7 main.js: the Ctrl+Shift+V listener no longer defers to a Paint window", !/TotalPaint\.isOpen/.test(main) && /e\.key === "V" \|\| e\.key === "v"/.test(main));
ok("A8 overlay.css: #rs-paint, .rsp-*, rs-paint-open and #rs-paint-btn are gone", !/#rs-paint\b|\.rsp-|rs-paint-open|#rs-paint-btn/.test(css));
ok("A9 overlay.css: the bar-button chain now reads settings / enhance / video", (css.match(/:is\(:is\(#rs-settings-btn, #rs-enhance-btn\), #rs-video-btn\)/g) || []).length >= 20 && !/#rs-paint-btn/.test(css));
ok("A10 the bar still has Enhancer, Video and Settings buttons in that order", main.indexOf('id="rs-enhance-btn"') > 0 && main.indexOf('id="rs-video-btn"') > main.indexOf('id="rs-enhance-btn"') && main.indexOf('id="rs-settings-btn"') > main.indexOf('id="rs-video-btn"'));
const srcFiles = [];
(function walk(d) { for (const e of fs.readdirSync(path.join(R, d), { withFileTypes: true })) { const p = d + "/" + e.name; if (e.isDirectory()) { if (!/node_modules|target|__pycache__/.test(e.name)) walk(p); } else if (/\.(js|html|css|json)$/.test(e.name)) srcFiles.push(p); } })("src");
["manifest.json", "codecraft.html", "overlay.css", "popup.js", "popup.html", "background.js"].forEach((f) => { if (exists(f)) srcFiles.push(f); });
const leftovers = srcFiles.filter((f) => /TotalPaint|__rsOpenPaint|core\/paint\.js|#rs-paint\b/.test(read(f)));
ok("A11 no shipped source file references the module, its global, opener or host", leftovers.length === 0, leftovers);
ok("A12 beginner help no longer advertises a brush / Paint button", !/<b>Paint<\/b>/.test(main) && !/brush icon/.test(main));

// ── B. the shared hand-off path survives for Video Studio + Enhancer ──
ok("B1 sendHandoff exists (renamed from sendPainting) with agent auto-start, busy wait, image attach and loop kick", /async function sendHandoff\(text, images, onStatus\)/.test(main) && !/sendPainting/.test(main) && /await startSession\(\{ restart: !P\.chatIsEmpty\(\) \}\);/.test(main.slice(main.indexOf("async function sendHandoff"), main.indexOf("async function sendHandoff") + 3000)));
ok("B2 Video Studio opener rides it", /TotalVideoStudio\.open\(\{\s*send: sendHandoff,/.test(main));
ok("B3 Enhancer send rides it when a session runs", main.includes("if (A.started) return sendHandoff(text, null, onStatus);"));
ok("B4 hand-off diagnostics are no longer labelled paint.*", !/diag\("paint\./.test(main) && /diag\("handoff\.sent"/.test(main));
ok("B5 screen_capture helpers kept for their other callers", /function studioCaptureTool\(\)/.test(main) && (main.match(/studioCaptureTool\(\)/g) || []).length >= 2 && /async function screenCaptureArgs\(/.test(main) && (main.match(/screenCaptureArgs\(/g) || []).length >= 2);

// ── C. Customize hide toggles ──
ok("C1 BRAND_HIDEABLE has eight entries and no 'paint'", main.includes('const BRAND_HIDEABLE = ["think", "voice", "discord", "logo", "badge", "status", "corners", "motion"];') && !/paint: "Paint"/.test(main));
ok("C2 overlay.css §16 hide rules have no paint rule", !/data-rs-hide~="paint"/.test(css) && /html\[data-rs-hide~="discord"\] #rs-discord \{ display: none !important; \}/.test(css));
ok("C3 sanitiser keeps filtering by BRAND_HIDEABLE (old presets with 'paint' lose only that entry)", /out\.hide = BRAND_HIDEABLE\.filter\(\(k\) => hide\.includes\(k\)\);/.test(main));

console.log(`test-paint-removed: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
