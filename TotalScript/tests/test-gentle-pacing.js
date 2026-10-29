#!/usr/bin/env node
// 1.99.0 — Gentle mode against DeepSeek account suspensions.
// Why: DeepSeek's abuse detection suspends web-chat accounts (typically 48 h to
// 3 days, "Due to violation of user policies, your account has been suspended
// until <date>") for bot-like cadence - dozens of messages an hour, instant
// follow-ups, stop/edit/regenerate loops, "using the chat as an API through an
// extension". An agent loop that fires the next tool result the millisecond a
// reply ends is exactly that profile. This test pins the fix:
//   - orchestrator: `account_block` error class (never retried), suspendedUntil(),
//     paceDelay() budget math (gap + rolling-hour cap);
//   - deepseek.js: P.pacing contract + scanAccountBlock() (toast / modal /
//     interstitial, chat-turn text ignored) feeding scanError();
//   - main.js: pacing wait in submitAndGetBase, the user's own send bypasses the
//     hourly budget, no dead/provider re-sends on gentle providers, the
//     account_block branch, the settings row + storage key, one-time notice.
// Whole-bundle behaviour (measured gaps, suspension stop, switch) is in
// tests/gentle-e2e.js. Nothing here touches the live site.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : "")); } }

// ── orchestrator ──
const g = { window: {}, console }; vm.createContext(g);
vm.runInContext(read("src/core/orchestrator.js") + ";globalThis.O = (typeof TotalOrchestrator !== 'undefined' ? TotalOrchestrator : window.TotalOrchestrator);", g);
const O = g.O;
const SUSPENDED = "Due to violation of user policies, your account has been suspended until September 20, 2026 02:55. If you have any questions, please Contact Us.";
ok("account_block class exists, not retryable, hint names gentle mode + the API route", O.ERROR_CLASSES.account_block && O.ERROR_CLASSES.account_block.retryable === false && /gentle mode/.test(O.ERROR_CLASSES.account_block.hint) && /API key/.test(O.ERROR_CLASSES.account_block.hint));
ok("suspension wording → account_block (before the generic 'violation' → moderation rule)", O.classifyProviderError(SUSPENDED).cls === "account_block" && O.classifyProviderError(SUSPENDED).retryable === false);
for (const t of ["You are sending messages too frequently. Please wait a moment.", "Your account has been temporarily suspended.", "Account is restricted", "Votre compte a été suspendu", "请求过于频繁，请稍后再试", "账号已被封禁"]) ok("throttle / suspension wording → account_block: " + t.slice(0, 40), O.classifyProviderError(t).cls === "account_block", O.classifyProviderError(t).cls);
ok("ordinary errors unchanged: 429 → rate_limit, server busy → busy, content policy → moderation", O.classifyProviderError("429 too many requests").cls === "rate_limit" && O.classifyProviderError("The server is busy, please try again later").cls === "busy" && O.classifyProviderError("blocked by content policy").cls === "moderation");
ok("retryDelay(account_block) is null on the first attempt (never re-sent)", O.retryDelay("account_block", 1, 0) === null);
const until = O.suspendedUntil(SUSPENDED);
ok("suspendedUntil parses the date", until && typeof until.getTime === "function" && until.getUTCFullYear() === 2026 && until.getUTCMonth() === 8 && until.getUTCDate() === 20, String(until));
ok("suspendedUntil → null without a date", O.suspendedUntil("account suspended") === null);
// paceDelay
const PC = { minGapMs: 6000, maxGapMs: 15000, perHour: 40 };
ok("paceDelay: empty log → no wait", JSON.stringify(O.paceDelay([], 1e9, PC, 0.5)) === JSON.stringify({ waitMs: 0, reason: null, sentLastHour: 0 }));
ok("paceDelay: gap = minGap at jitter 0", O.paceDelay([1000000], 1001000, PC, 0).waitMs === 5000 && O.paceDelay([1000000], 1001000, PC, 0).reason === "gap");
ok("paceDelay: gap = maxGap at jitter 1", O.paceDelay([1000000], 1001000, PC, 1).waitMs === 14000);
ok("paceDelay: old send → no gap wait", O.paceDelay([1000000], 1020000, PC, 1).waitMs === 0);
const full = Array.from({ length: 40 }, (_, i) => 1000000 + i * 60000); // 40 sends over 39 min
const nowF = 1000000 + 40 * 60000;
const b = O.paceDelay(full, nowF, PC, 0);
ok("paceDelay: 40 sends in the hour → budget wait until the oldest expires (20 min)", b.reason === "budget" && b.waitMs === 3600000 - 40 * 60000 && b.sentLastHour === 40, b);
ok("paceDelay: 39 sends → only the gap applies", O.paceDelay(full.slice(1), nowF, PC, 0).reason === null || O.paceDelay(full.slice(1), nowF, PC, 0).reason === "gap");
ok("paceDelay: sends older than an hour fall out of the budget", O.paceDelay(full, 1000000 + 3600000 + 38 * 60000 + 30000, PC, 0).sentLastHour === 1);
ok("paceDelay: no perHour → never budget-blocked", O.paceDelay(full, nowF, { minGapMs: 1000, maxGapMs: 1000 }, 0).reason === null);

// ── deepseek.js ──
let JSDOM, installDomShims;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims } = require("./lib/e2e-page.js")); } catch { JSDOM = null; }
const ds = read("src/providers/deepseek.js");
ok("deepseek.js: pacing contract 6–15 s gap, 40/hour, noResend, label + apiHint pointing at platform.deepseek.com", /pacing: \{ minGapMs: 6000, maxGapMs: 15000, perHour: 40, noResend: true, label: "DeepSeek gentle mode", apiHint: "[^"]*platform\.deepseek\.com[^"]*" \}/.test(ds));
ok("deepseek.js: scanAccountBlock exported and consulted first by scanError", /scanAccountBlock,/.test(ds) && /function scanError\(\) \{\n\s+const blocked = scanAccountBlock\(\);\n\s+if \(blocked\) return blocked;/.test(ds));
if (!JSDOM) console.log("skip jsdom half (npm i --no-save jsdom)");
else {
  const load = (body) => {
    const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: "https://chat.deepseek.com/a/chat/s/abc", pretendToBeVisual: true, runScripts: "outside-only" });
    const w = dom.window; installDomShims(w); w.__rsDiag = [];
    w.eval(read("src/core/parser.js") + ";window.RSParse = RSParse;");
    w.eval(ds);
    const P = w.RSProvider; P.init({ diag: () => {} });
    return { w, d: w.document, P };
  };
  const composer = '<div id="composer" data-rect="200,600,800,120"><textarea id="site-ta" data-rect="210,610,700,40"></textarea><div role="button" class="ds-button--primary" aria-label="Send" data-rect="900,660,36,36"></div></div>';
  const chat = '<div class="chat"><div data-virtual-list-item-key="1"><div class="ds-message d29f3d7d"><div class="fbb737a4">why do accounts get suspended?</div></div></div><div data-virtual-list-item-key="2"><div class="ds-message"><div class="ds-markdown"><p>Users report: "' + SUSPENDED + '"</p></div></div></div></div>';
  { const { P } = load(chat + composer); ok("jsdom: the suspension sentence INSIDE a chat turn is model content, not a block", P.scanAccountBlock() === null && P.scanError() === null); }
  { const { P } = load(chat + composer + '<div class="ds-toast" data-rect="400,20,500,40">' + SUSPENDED + '</div>'); const r = P.scanAccountBlock(); ok("jsdom: a visible toast with the notice is detected and surfaces through scanError()", r && /suspended until September 20, 2026/.test(r) && P.scanError() === r, r); }
  { const { P } = load(chat + composer + '<div role="dialog" data-rect="300,200,600,200"><h2>Notice</h2><p>You are sending messages too frequently. Please wait a moment before trying again.</p></div>'); ok("jsdom: a throttle dialog is detected", /too frequently/.test(P.scanAccountBlock() || ""), P.scanAccountBlock()); }
  { const { P } = load('<div class="login-page" data-rect="0,0,1280,800"><h1>DeepSeek</h1><p>' + SUSPENDED + '</p><button>Contact Us</button></div>'); ok("jsdom: the interstitial page (no composer) is detected from the body text", /suspended until/.test(P.scanAccountBlock() || ""), P.scanAccountBlock()); }
  { const { P } = load(chat + composer + '<div class="ds-toast" data-rect="400,20,500,40">Copied to clipboard</div>'); ok("jsdom: an unrelated toast is not a block", P.scanAccountBlock() === null); }
}

// ── main.js ──
const main = read("src/core/main.js");
ok("main.js: pacing wait lives in submitAndGetBase (P.pacing + gentlePacingOn + ORCH.paceDelay) and stamps the send when it lands", /if \(P\.pacing && gentlePacingOn\(\) && ORCH && ORCH\.paceDelay\) \{/.test(main) && /A\._pacedSend && \(messageSent \|\| landed\(\)\)/.test(main) && /diag\("send\.paced"/.test(main));
ok("main.js: the user's own message bypasses the hourly budget (A.userSend on both start paths), still gap-paced", (main.match(/A\.userSend = true;/g) || []).length === 2 && /if \(userSend && plan\.reason === "budget"\) plan = ORCH\.paceDelay\(A\.sendLog, Date\.now\(\), \{ minGapMs: P\.pacing\.minGapMs, maxGapMs: P\.pacing\.maxGapMs \}/.test(main));
ok("main.js: the person's send through the site counts toward the cadence (onUserMessage pushes into A.sendLog)", /if \(P\.pacing\) \(A\.sendLog = A\.sendLog \|\| \[\]\)\.push\(Date\.now\(\)\);/.test(main));
ok("main.js: Stop cancels a pacing wait", /if \(A\.stop\) \{ diag\("send\.pacedCancelled", \{\}\); return P\.assistantCount\(\); \}/.test(main));
ok("main.js: no re-sends on gentle providers - resendAllowed() gates both dead retries and the transient provider retry", /const resendAllowed = \(\) => !\(P\.pacing && P\.pacing\.noResend && gentlePacingOn\(\)\);/.test(main) && (main.match(/deadRetries < 1 && resendAllowed\(\) && !A\.stop && A\.started/g) || []).length === 2 && /cls\.retryable && resendAllowed\(\) && ORCH && A\.lastSent/.test(main));
ok("main.js: account_block branch stops cold with the until-date and the API hint, before the generic 'request failed' banner", /if \(cls && cls\.cls === "account_block"\) \{[\s\S]{0,900}ORCH\.suspendedUntil\(res\.detail\)[\s\S]{0,900}blocked this account\$\{until \? " until " \+ until\.toLocaleString\(\) : ""\}[\s\S]{0,400}break;\n\s+\}\n\s+ui\.steeringProgress\("error", "The provider request failed"/.test(main));
ok("main.js: one-time notice (rsGentleNoticeShown) explains the risk and the switch", /chrome\.storage\.local\.get\(\["rsGentleNoticeShown"\]/.test(main) && /suspends web-chat accounts for bot-like use/.test(main) && /Settings → Gentle pacing/.test(main));
ok("main.js: settings row 'Gentle pacing' rendered only for providers with a pacing contract; storage key rsGentlePacing read, watched and written", /\$\{pacingContract\(\) \? `<div class="rs-tgl-row rs-adv" data-mode="gentle"/.test(main) && /"rsGentlePacing"\], \(r\) => \{\n\s+if \(typeof r\.rsGentlePacing === "boolean"\) gentlePacing = r\.rsGentlePacing;/.test(main) && /changes\.rsGentlePacing && typeof changes\.rsGentlePacing\.newValue === "boolean"/.test(main) && /function setGentlePacing\(v\)\{ gentlePacing=!!v; try\{chrome\.storage\.local\.set\(\{rsGentlePacing: gentlePacing\}\);\}catch\{\}; buildMenu\(\); \}/.test(main) && /else if\(m==="gentle"\) setGentlePacing\(!gentlePacing\);/.test(main));
ok("main.js: the switch is exposed as window.__rsGentlePacing and read by gentlePacingOn()", /window\.__rsGentlePacing = \(\) => gentlePacing;/.test(main) && /function gentlePacingOn\(\) \{\n\s+try \{ return !\(window\.__rsGentlePacing && window\.__rsGentlePacing\(\) === false\); \}/.test(main));
ok("overlay.css: .rs-banner.info styled", /\.rs-banner\.info \{/.test(read("overlay.css")));
ok("no other provider publishes a pacing contract yet (opt-in per provider)", fs.readdirSync(path.join(root, "src/providers")).filter((f) => f !== "deepseek.js").every((f) => !/^\s*pacing: \{/m.test(read("src/providers/" + f))));
ok("desktop app already offers the official DeepSeek API (api.deepseek.com/v1, user key) - the route the notice points to", /id: "deepseek", name: "DeepSeek", base_url: "https:\/\/api\.deepseek\.com\/v1", needs_key: true/.test(read("agent/src/chat.rs")));

console.log(`\ntest-gentle-pacing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
