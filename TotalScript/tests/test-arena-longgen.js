#!/usr/bin/env node
// 2.0.0 — Arena (arena.ai) long generations. The stop button is Arena's
// authoritative whole-generation signal; before 2.0.0 the adapter read any
// 10 s without visible text as a "wedged" stop button, so slow / thinking
// models were finalised early (empty reply → nudge / resend / restart while
// Arena was still generating). Loads the real adapter in jsdom with a scripted
// DOM and a fake clock; plus main.js / timings pins. Mocked: no live Arena.
//   NODE_PATH=/path/to/jsdom node tests/test-arena-longgen.js
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } };
const src = read("src/providers/arena.js");
const main = read("src/core/main.js");

// ── source pins ──────────────────────────────────────────────────────────────
ok("arena.js: WEDGE_MS is 2 minutes and THINK_MAX_MS 15 minutes (was a 10 s wedge window)", /const WEDGE_MS = 120000;/.test(src) && /const THINK_MAX_MS = 900000;/.test(src) && !/const WEDGE_MS = 10000;/.test(src));
ok("arena.js: genActive trusts the stop button - no text yet → generating until THINK_MAX_MS; frozen text → until WEDGE_MS", /if \(_streamMax <= 1\) return now - _stopSince < THINK_MAX_MS;\n\s*return now - _streamAt < WEDGE_MS;/.test(src));
ok("arena.js: timings declare HARD_STABLE_MS 45 s and PRESTART_MS 150 s; the rest unchanged", /HARD_STABLE_MS: 45000,/.test(src) && /PRESTART_MS: 150000,/.test(src) && /GEN_IDLE_MS: 650,/.test(src) && /STABLE_MS: 3200,/.test(src) && /RESPONSE_TIMEOUT_MS: 300000,/.test(src));
ok("arena.js: genDebug exported for diagnostics (stop / stopForMs / textLen / frozenMs)", /const genDebug = \(\) => \(\{ stop: !!stopButton\(\), stopForMs/.test(src) && /isGenerating, isBusyNow, isHardGenerating, genDebug,/.test(src));
ok("main.js: HARD_STABLE_MS read from provider timings, defaulting to STABLE_MS (no change for other providers)", /const HARD_STABLE_MS = T\.HARD_STABLE_MS \|\| T\.STABLE_MS;/.test(main));
ok("main.js: the wedged-stop fallback (stuckDone) uses HARD_STABLE_MS only while P.isHardGenerating() and only when the provider set a different value", /const stableNeed = \(HARD_STABLE_MS !== STABLE_MS && P\.isHardGenerating && P\.isHardGenerating\(\)\) \? HARD_STABLE_MS : STABLE_MS;\n\s*const stuckDone = started && d\.reply && Date\.now\(\) - lastChangeAt > stableNeed &&/.test(main));
ok("main.js: PRESTART_MS still comes from provider timings (T.PRESTART_MS || 60000)", /const PRESTART_MS = T\.PRESTART_MS \|\| 60000;/.test(main));
const others = ["chatgpt", "claude", "deepseek", "gemini", "glm", "kimi", "meta", "notion", "qwen", "vani", "multichat", "codecraft"].map((p) => read("src/providers/" + p + ".js"));
ok("no other adapter declares HARD_STABLE_MS (opt-in, Arena only)", others.every((s) => !/HARD_STABLE_MS/.test(s)));

// ── jsdom: the real adapter on a scripted DOM with a fake clock ─────────────
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
if (!JSDOM) { console.log("skip jsdom (not installed)"); console.log(`\ntest-arena-longgen: ${n - failed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
const html = `<!doctype html><html><body>
<main>
<ol id="list" class="flex flex-col-reverse">
  <div class="h-0"></div>
  <div class="mx-auto max-w-[800px]" id="turn-a"><div>Response provided by vendor</div><div class="prose" id="prose-a"></div></div>
  <div class="mx-auto max-w-[800px] justify-end" id="turn-u"><div class="prose">Create a part</div></div>
</ol>
<form><textarea></textarea><button id="btn" aria-label="Stop generation">stop</button></form>
</main></body></html>`;
const dom = new JSDOM(html, { url: "https://arena.ai/c/0a1b2c3d-0000-4000-8000-000000000000", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window, d = w.document;
w.Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 120, height: 32, left: 0, top: 0, right: 120, bottom: 32, toJSON() {} }; };
w.chrome = { runtime: { id: "harness", getURL: (p) => p, sendMessage() {}, onMessage: { addListener() {} } }, storage: { local: { get: (k, cb) => cb && cb({}), set() {} } } };
let now = 1_000_000_000_000;
const RealDate = w.Date;
w.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
const errs = [];
try { w.eval(src); } catch (e) { errs.push(String(e && e.message || e)); }
const P = w.RSProvider;
ok("arena adapter loads in jsdom", !!P && errs.length === 0, errs);
const btn = d.getElementById("btn"), prose = d.getElementById("prose-a");
const tick = (ms) => { now += ms; };

// 1. Thinking phase: stop button up, NO text for 60 s → still generating.
P.invalidateItems && P.invalidateItems();
ok("t=0: stop button up, empty reply → generating", P.isGenerating() === true && P.isHardGenerating() === true, P.genDebug && P.genDebug());
tick(12000); P.invalidateItems && P.invalidateItems();
ok("t=12 s, still no text → STILL generating (pre-2.0 this flipped false at 10 s)", P.isGenerating() === true, P.genDebug());
tick(48000); P.invalidateItems && P.invalidateItems();
ok("t=60 s, still no text → still generating (thinking budget is 15 min)", P.isGenerating() === true, P.genDebug());
// 2. First tokens arrive, then the model pauses 30 s mid-reply.
prose.textContent = "Let me think about the layout first."; P.invalidateItems && P.invalidateItems();
ok("first text seen → generating, text length tracked", P.isGenerating() === true && P.genDebug().textLen > 1, P.genDebug());
tick(30000); P.invalidateItems && P.invalidateItems();
ok("t+30 s frozen text with the stop button still up → generating (mid-reply pause, not a wedge)", P.isGenerating() === true, P.genDebug());
tick(95000); P.invalidateItems && P.invalidateItems();
ok("t+125 s frozen text with the stop button still up → NOT generating (the only wedge we still guard)", P.isGenerating() === false, P.genDebug());
// 3. Growth resumes → generating again; stop button disappears → idle after the growth window.
prose.textContent += "\nNow the command:"; P.invalidateItems && P.invalidateItems();
ok("growth resumes → generating again", P.isGenerating() === true, P.genDebug());
btn.remove(); tick(700); P.invalidateItems && P.invalidateItems();
ok("stop button gone + 700 ms without growth → not generating (GEN_IDLE_MS 650 unchanged)", P.isGenerating() === false && P.isHardGenerating() === false, P.genDebug());
// 4. A brand-new turn with the stop button back: the thinking budget restarts.
const list = d.getElementById("list");
const turn = d.createElement("div"); turn.className = "mx-auto max-w-[800px]"; turn.innerHTML = '<div class="prose" id="prose-b"></div>'; list.insertBefore(turn, list.firstElementChild.nextSibling);
const b2 = d.createElement("button"); b2.setAttribute("aria-label", "Stop generation"); b2.textContent = "stop"; d.querySelector("form").appendChild(b2);
P.invalidateItems && P.invalidateItems();
ok("new turn + stop button → generating again from t=0 of that turn", P.isGenerating() === true, P.genDebug());
tick(900000 + 1000); P.invalidateItems && P.invalidateItems();
ok("after 15 min with no text at all → not generating (THINK_MAX_MS bound, a truly wedged button cannot hang the loop)", P.isGenerating() === false, P.genDebug());

console.log(`\ntest-arena-longgen: ${n - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
