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
// 1.99.3 additions (false-suspension fix + human cadence):
//   - throttle wording ("too frequently") is class `throttled` (cool-down + one
//     retry + tighter pacing), never `account_block`; ACCOUNT_SUSPEND_RE /
//     THROTTLE_RE split, ACCOUNT_BLOCK_RE kept as the union;
//   - scanAccountBlock ignores TotalScript's OWN surfaces (rs-* ids/classes) -
//     its banners quote the provider and its dialogs hold the user's words;
//   - paceDelay: breakEvery/breakMinMs/breakMaxMs, perDay, checkpointEvery,
//     streakLength(), tightenPacing(); send log persisted per provider
//     (rsSendLog:<id>) and shared across tabs; MAX_TRUNC 2 on paced sites.
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
for (const t of ["Your account has been temporarily suspended.", "Account is restricted", "Votre compte a été suspendu", "账号已被封禁"]) ok("suspension wording → account_block: " + t.slice(0, 40), O.classifyProviderError(t).cls === "account_block", O.classifyProviderError(t).cls);
// 1.99.3: a throttle is NOT a suspension (this was the false "account blocked" verdict)
for (const t of ["You are sending messages too frequently. Please wait a moment.", "请求过于频繁，请稍后再试", "Vous envoyez des messages trop fréquemment", "You have sent requests too fast"]) ok("throttle wording → throttled (not account_block): " + t.slice(0, 40), O.classifyProviderError(t).cls === "throttled" && O.classifyProviderError(t).retryable === true, O.classifyProviderError(t).cls);
ok("ACCOUNT_BLOCK_RE still the union (deepseek.js RE.accountBlock keeps matching both for scanAccountBlock)", O.ACCOUNT_BLOCK_RE.test("too frequently") && O.ACCOUNT_BLOCK_RE.test("account suspended") && O.ACCOUNT_SUSPEND_RE.test("account suspended") && !O.ACCOUNT_SUSPEND_RE.test("too frequently") && O.THROTTLE_RE.test("too frequently") && !O.THROTTLE_RE.test("account suspended"));
ok("retryDelay(throttled): one retry after >= 3 min (site-stated wait honoured up to 10 min), never a second", O.retryDelay("throttled", 1, 0) === 180000 && O.retryDelay("throttled", 1, 400000) === 400500 && O.retryDelay("throttled", 1, 9e6) === 600000 && O.retryDelay("throttled", 2, 0) === null);
ok("throttled hint says it is not a suspension", /not a suspension/.test(O.ERROR_CLASSES.throttled.hint));
ok("ordinary errors unchanged: 429 → rate_limit, server busy → busy, content policy → moderation", O.classifyProviderError("429 too many requests").cls === "rate_limit" && O.classifyProviderError("The server is busy, please try again later").cls === "busy" && O.classifyProviderError("blocked by content policy").cls === "moderation");
ok("retryDelay(account_block) is null on the first attempt (never re-sent)", O.retryDelay("account_block", 1, 0) === null);
const until = O.suspendedUntil(SUSPENDED);
ok("suspendedUntil parses the date", until && typeof until.getTime === "function" && until.getUTCFullYear() === 2026 && until.getUTCMonth() === 8 && until.getUTCDate() === 20, String(until));
ok("suspendedUntil → null without a date", O.suspendedUntil("account suspended") === null);
// paceDelay
const PC = { minGapMs: 6000, maxGapMs: 15000, perHour: 40 };
{ const e = O.paceDelay([], 1e9, PC, 0.5); ok("paceDelay: empty log → no wait", e.waitMs === 0 && e.reason === null && e.sentLastHour === 0 && e.sentToday === 0 && e.streak === 0 && e.checkpoint === false, e); }
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
// 1.99.3: breaks, daily cap, checkpoint, streak, tightenPacing
{
  const PB = { minGapMs: 8000, maxGapMs: 20000, perHour: 30, breakEvery: 6, breakMinMs: 45000, breakMaxMs: 120000, perDay: 160, checkpointEvery: 36 };
  const mk = (n, step, now) => Array.from({ length: n }, (_, i) => now - (n - i) * step);
  const now = 5e9;
  ok("streakLength: sends < 10 min apart chain; a 10 min hole ends the streak; an old last send = 0", O.streakLength(mk(5, 15000, now), now) === 5 && O.streakLength([now - 1e6, now - 9e5].concat(mk(3, 15000, now)), now) === 3 && O.streakLength([now - 700000], now) === 0 && O.streakLength([], now) === 0);
  const six = mk(6, 15000, now);                   // 6 sends in a row, last one 15 s ago
  const b6 = O.paceDelay(six, now, PB, 0);
  ok("paceDelay: after breakEvery sends in a streak the next waits the break (45 s - 15 s elapsed = 30 s) instead of the 8 s gap", b6.reason === "break" && b6.waitMs === 30000 && b6.streak === 6, b6);
  ok("paceDelay: break length follows the jitter (120 s at jitter 1)", O.paceDelay(six, now, PB, 1).waitMs === 105000);
  ok("paceDelay: break already served (last send 2 min ago) → no wait", O.paceDelay(mk(6, 15000, now - 120000), now, PB, 1).waitMs === 0);
  ok("paceDelay: 5 sends → ordinary gap, not a break", O.paceDelay(mk(5, 15000, now), now, PB, 0).reason === null);
  ok("paceDelay: a 10 min hole resets the streak (6 sends but only 2 since the hole)", O.paceDelay(mk(4, 15000, now - 2e6).concat(mk(2, 15000, now)), now, PB, 0).streak === 2 && O.paceDelay(mk(4, 15000, now - 2e6).concat(mk(2, 15000, now)), now, PB, 0).reason === null);
  const day = Array.from({ length: 160 }, (_, i) => now - 86400000 + 1000 + i * 500000);   // 160 spread over the last 24 h, last one ~hours ago
  const bd = O.paceDelay(day, now, { perDay: 160 }, 0);
  ok("paceDelay: perDay reached → reason day, wait until the oldest falls out of the 24 h window", bd.reason === "day" && bd.waitMs === 1000 && bd.sentToday === 160, bd);
  ok("paceDelay: 159 in 24 h → not day-blocked", O.paceDelay(day.slice(1), now, { perDay: 160 }, 0).reason === null);
  const cp = O.paceDelay(mk(36, 15000, now), now, PB, 0);
  ok("paceDelay: checkpointEvery sends in one streak → checkpoint: true (a click is required) on top of the usual budget wait", cp.checkpoint === true && cp.streak === 36 && cp.reason === "budget" && cp.sentLastHour === 36, cp);
  ok("paceDelay: the same streak without an hourly budget still takes the break (36 = 6x6)", O.paceDelay(mk(36, 15000, now), now, Object.assign({}, PB, { perHour: 0 }), 0).reason === "break");
  ok("paceDelay: checkpoint not raised at 35 or 37, nor when the streak is stale (> 10 min)", O.paceDelay(mk(35, 15000, now), now, PB, 0).checkpoint === false && O.paceDelay(mk(37, 15000, now), now, PB, 0).checkpoint === false && O.paceDelay(mk(36, 15000, now - 700000), now, PB, 0).checkpoint === false);
  ok("paceDelay: old contract shape (no new fields) behaves exactly as before", O.paceDelay(mk(36, 15000, now), now, PC, 0).checkpoint === false && O.paceDelay(mk(36, 15000, now), now, PC, 0).reason === null && O.paceDelay(mk(36, 15000, now), now, PC, 0).waitMs === 0);
  const t1 = O.tightenPacing(PB, 1), t2 = O.tightenPacing(PB, 2), t9 = O.tightenPacing(PB, 9);
  ok("tightenPacing: 1 strike doubles the gaps, halves the hour budget, halves breakEvery", t1.minGapMs === 16000 && t1.maxGapMs === 40000 && t1.perHour === 15 && t1.breakEvery === 3 && t1.strikes === 1 && t1.noResend === PB.noResend);
  ok("tightenPacing: 2 strikes x4; capped at 3 strikes (x8, perHour floor 4, breakEvery floor 2)", t2.minGapMs === 32000 && t2.perHour === 7 && t9.strikes === 3 && t9.minGapMs === 64000 && t9.perHour === 4 && t9.breakEvery === 3);
  ok("tightenPacing: 0 strikes = a copy of the contract (input untouched)", JSON.stringify(O.tightenPacing(PB, 0)) === JSON.stringify(PB) && PB.minGapMs === 8000 && !("strikes" in PB));
}

// ── deepseek.js ──
let JSDOM, installDomShims;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims } = require("./lib/e2e-page.js")); } catch { JSDOM = null; }
const ds = read("src/providers/deepseek.js");
ok("deepseek.js: pacing contract 8–20 s gap, 30/hour, break every 6 (45–120 s), 160/day, checkpoint at 36 (1.99.3), noResend, apiPage → in-extension DeepSeek API chat, apiHint pointing at platform.deepseek.com", /pacing: \{ minGapMs: 8000, maxGapMs: 20000, perHour: 30, breakEvery: 6, breakMinMs: 45000, breakMaxMs: 120000, perDay: 160, checkpointEvery: 36, noResend: true, label: "DeepSeek gentle mode", apiPage: "codecraft\.html\?api=deepseek", apiLabel: "Open DeepSeek API chat", apiHint: "[^"]*platform\.deepseek\.com[^"]*" \}/.test(ds));
ok("deepseek.js: scanAccountBlock / scanError skip TotalScript's own rs-* surfaces (SELF_SEL) and the interstitial check reads the page WITHOUT them", /const SELF_SEL = '\[id\^="rs-"\], \[class\^="rs-"\], \[class\*=" rs-"\]';/.test(ds) && (ds.match(/\|\| foreign\(el\) \|\| self\(el\)\) continue;/g) || []).length === 2 && /const t = pageTextWithoutSelf\(\);/.test(ds));
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
  // 1.99.3: TotalScript's own UI is never evidence of a block (the self-trigger false suspension)
  const ownBanner = '<div id="rs-root" data-rect="0,700,1280,100"><div id="rs-bar" data-rect="0,700,1280,60">Idle</div><div class="rs-banner warn" data-rect="0,760,1280,40"><div class="rs-banner-t">DeepSeek blocked this account until 9/20/2026</div><div class="rs-banner-m">DeepSeek said: "' + SUSPENDED + '". TotalScript stopped and will not resend anything.</div></div></div>';
  { const { P } = load(chat + composer + ownBanner); ok("jsdom: TotalScript's own account banner (class rs-banner matches [class*=banner]) is NOT re-detected as a block", P.scanAccountBlock() === null && P.scanError() === null, P.scanAccountBlock()); }
  { const { P } = load(chat + composer + '<div id="rs-root" data-rect="0,700,1280,100"><div class="rs-banner warn" data-rect="0,760,1280,40">DeepSeek said: "You are sending messages too frequently." This is a throttle, not a suspension.</div></div>'); ok("jsdom: TotalScript's own throttle banner is not re-detected either", P.scanAccountBlock() === null); }
  { const { P } = load(chat + composer + '<div id="rs-enhance" role="dialog" data-rect="300,200,600,300"><textarea>my account has been suspended on another site, help me write an appeal</textarea><p>my account has been suspended on another site, help me write an appeal</p></div>'); ok("jsdom: the user's own words inside a TotalScript dialog (enhancer, role=dialog) are not a block", P.scanAccountBlock() === null); }
  { const { P } = load('<div class="login-page" data-rect="0,0,1280,800"><h1>DeepSeek</h1><p>Sign in to continue</p></div><div id="rs-root" data-rect="0,700,1280,100"><div class="rs-banner warn" data-rect="0,760,1280,40">DeepSeek said: "' + SUSPENDED + '"</div></div>'); ok("jsdom: interstitial check (no composer) ignores TotalScript's own text - a plain sign-in page is not a block", P.scanAccountBlock() === null, P.scanAccountBlock()); }
  { const { P } = load(chat + composer + ownBanner + '<div role="dialog" data-rect="300,200,600,200"><h2>Notice</h2><p>' + SUSPENDED + '</p></div>'); ok("jsdom: a REAL site dialog is still detected next to TotalScript's own banner", /suspended until/.test(P.scanAccountBlock() || ""), P.scanAccountBlock()); }
}

// ── main.js ──
const main = read("src/core/main.js");
ok("main.js: pacing wait lives in submitAndGetBase (P.pacing + gentlePacingOn + ORCH.paceDelay) and stamps the send when it lands", /if \(P\.pacing && gentlePacingOn\(\) && ORCH && ORCH\.paceDelay\) \{/.test(main) && /A\._pacedSend && \(messageSent \|\| landed\(\)\)/.test(main) && /diag\("send\.paced"/.test(main));
ok("main.js: the user's own message bypasses budget / break / day / checkpoint (A.userSend on both start paths), still gap-paced (1.99.3)", (main.match(/A\.userSend = true;/g) || []).length === 2 && /if \(userSend && plan\.reason !== "gap"\) plan = ORCH\.paceDelay\(A\.sendLog, Date\.now\(\), \{ minGapMs: pacing\.minGapMs, maxGapMs: pacing\.maxGapMs \}/.test(main) && /if \(userSend\) plan\.checkpoint = false;/.test(main));
ok("main.js: the person's send through the site counts toward the cadence (onUserMessage → sendLogRecord)", /if \(P\.pacing\) sendLogRecord\(Date\.now\(\)\);/.test(main));
// 1.99.4
ok("main.js: send log persisted per provider (rsSendLog:<id>, 24 h), merged on every paced send (other tabs / pre-reload) and appended when a send lands", /function sendLogKey\(\) \{ return "rsSendLog:" \+ \(P && P\.id \|\| "provider"\); \}/.test(main) && /await sendLogLoad\(\);/.test(main) && /A\._pacedSend = false; sendLogRecord\(Date\.now\(\)\);/.test(main) && /const cut = Date\.now\(\) - 86400000;/.test(main));
ok("main.js: the applied contract is tightened by this session's strikes (effectivePacing → ORCH.tightenPacing(P.pacing, A.paceStrikes))", /return ORCH && ORCH\.tightenPacing \? ORCH\.tightenPacing\(P\.pacing, A\.paceStrikes \|\| 0\) : P\.pacing;/.test(main) && /const pacing = effectivePacing\(\);/.test(main));
ok("main.js: checkpoint waits for a CLICK (humanCheckpoint banner with a Continue action), Stop resolves it false and cancels the send", /const go = await humanCheckpoint\(plan\);\n\s+if \(!go \|\| A\.stop\) \{ diag\("send\.pacedCancelled", \{ at: "checkpoint" \}\); return P\.assistantCount\(\); \}/.test(main) && /\{ label: "Continue", onClick: \(\) => finish\(true\) \}/.test(main) && /if \(A\.stop\) \{ clearInterval\(tick\); finish\(false\); \}/.test(main));
ok("main.js: break / day reasons reported to the person (toast + status)", /plan\.reason === "break"\) ui\.toast/.test(main) && /plan\.reason === "day"\) ui\.toast/.test(main) && /Taking a break \(/.test(main) && /Daily budget reached \(/.test(main));
ok("main.js: throttled branch BEFORE the generic retry and the account_block branch - strike, cool-down, ONE unchanged resend, then a 'not a suspension' banner", (() => { const i = main.indexOf('if (cls && cls.cls === "throttled") {'); const j = main.indexOf('if (cls && cls.cls === "account_block") {'); const k = main.indexOf("const wait = cls && cls.retryable && resendAllowed()"); return i > 0 && i < k && k < j; })() && /A\.paceStrikes = \(A\.paceStrikes \|\| 0\) \+ 1;/.test(main) && /ORCH\.retryDelay\("throttled", A\.throttleRetries \+ 1, cls\.waitMs\)/.test(main) && /base = await submitAndGetBase\(again\.text, again\.images\);/.test(main) && /This is a throttle, not a suspension\./.test(main));
ok("main.js: the account_block status no longer says 'or throttled'", /`\$\{P\.displayName\} suspended this account`/.test(main) && !/suspended or throttled this account/.test(main));
ok("main.js: fewer Continue clicks (MAX_TRUNC 2) and fewer system re-statements (every 20 results) on paced providers; defaults unchanged elsewhere", /const MAX_TRUNC = P\.pacing && gentlePacingOn\(\) \? 2 : 6;/.test(main) && /const RESEND_SYS_EVERY_RESULTS = P\.pacing \? 20 : 12;/.test(main));
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
