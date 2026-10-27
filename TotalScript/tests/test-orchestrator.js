"use strict";
// 1.69.0 — provider-intelligence / orchestration layer (src/core/orchestrator.js)
// unit tests + wiring pins (manifest, codecraft.html, main.js, chat.rs).
// Pure-function tests; nothing here contacts a provider.
// Run from the TotalScript root: node tests/test-orchestrator.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const O = require(path.join(root, "src/core/orchestrator.js"));
const main = read("src/core/main.js"), rs = read("agent/src/chat.rs"), manifest = JSON.parse(read("manifest.json")), html = read("codecraft.html");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : "")); } }
const T = (text, prev) => O.classifyTask(text, prev ? { prev } : undefined);

// ── 1. task understanding: explain vs implement vs plan vs fix ──
const CASES = [
  ["script a door that opens when touched", { intent: "implement", primary: "luau", needsTools: true, mutates: true, followUp: false }],
  ["why does my script error?", { intent: "explain", explainOnly: true, needsTools: false, mutates: false }],
  ["explain how RemoteEvents work", { intent: "explain", explainOnly: true, mutates: false }],
  ["plan how to build an obby lobby, dont build yet", { intent: "plan", planOnly: true, mutates: false }],
  ["plan and then build a shop GUI", { intent: "implement", planOnly: false, mutates: true }],
  ["the door is broken", { intent: "fix", mutates: true, needsTools: true }],
  ["it doesnt work", { intent: "fix" }],
  ["review my DataStore code for bugs", { intent: "review", mutates: false, needsTools: true }],
  ["continue", { intent: "continue", isContinue: true }],
  ["make a coin pickup system, only one script and don't touch the lighting", { intent: "implement" }],
];
for (const [text, want] of CASES) {
  const got = T(text, want.intent === "fix" || want.intent === "continue" ? T("script a door that opens") : undefined);
  const bad = Object.keys(want).filter((k) => got[k] !== want[k]);
  ok(`classifyTask(${JSON.stringify(text)}) → ${Object.entries(want).map(([k, v]) => k + "=" + v).join(" ")}`, bad.length === 0, bad.map((k) => k + "=" + got[k]));
}
{
  const t = T("make a coin pickup system, only one script and don't touch the lighting");
  ok("explicit constraints are captured verbatim (only one script / don't touch the lighting)", t.constraints.length === 2 && /only one script/.test(t.constraints[0]) && /don't touch the lighting/.test(t.constraints[1]), t.constraints);
}
// ── 2. continuity: follow-ups inherit category + constraints; fresh requests do not ──
{
  const first = T("build a sword with a swing animation, only use one Script");
  const fu = T("make it faster too", first);
  ok("follow-up ('make it faster too') inherits the previous task's categories and constraints", fu.followUp && fu.inherited && fu.categories.join() === first.categories.join() && fu.constraints.includes(first.constraints[0]), fu);
  const fresh = T("script a door that opens when touched", first);
  ok("a new full request is NOT treated as a follow-up", !fresh.followUp && !fresh.inherited, fresh);
  const cont = T("continue", first);
  ok("'continue' inherits mutates/categories from the referenced task", cont.isContinue && cont.inherited && cont.mutates === first.mutates && cont.categories.join() === first.categories.join());
  const longFu = T("that is nice, now also create a completely new leaderboard system with DataStore saving and a GUI", first);
  ok("long requests with a leading pronoun are classified on their own merits (strong implement verb)", !longFu.followUp || longFu.intent === "implement", longFu);
}
// ── 3. Layer C task brief: caps ──
{
  const t = T("make a coin pickup system, only one script and don't touch the lighting");
  const full = O.taskLayer(t, { tight: false }), tight = O.taskLayer(t, { tight: true });
  ok("taskLayer full ≤ 700 chars and names outcome + constraints", full.length <= 700 && /Expected outcome/.test(full) && /only one script/.test(full), full.length);
  ok("taskLayer tight ≤ 360 chars and shorter than full", tight.length <= 360 && tight.length < full.length, tight.length);
  ok("taskLayer is labelled as TotalScript's note, not the user's words", /^\(Task brief from TotalScript, not the user\.\)/.test(full) && /^\(Task brief from TotalScript, not the user\.\)/.test(tight));
  ok("explain-only / plan-only tasks get NO rider (nothing to verify in Studio)", O.taskLayer(T("why does my script error?")) === "" && O.taskLayer(T("plan how to build an obby lobby, dont build yet")) === "");
}
// ── 4. provider error taxonomy ──
const ERR = [
  ["HTTP 429 Too Many Requests, retry after 20 seconds", "rate_limit", true, 20000],
  ["This conversation has reached the maximum context length", "context_limit", false],
  ["401 Unauthorized: invalid api key", "auth", false],
  ["You have exceeded your current quota, please check your plan and billing", "quota", false],
  ["weekly_limit reached", "quota", false],
  ["concurrency_limit: only one active conversation", "rate_limit", true],
  ["Our systems are overloaded (503) — try again later", "busy", true],
  ["TypeError: Failed to fetch", "network", true],
  ["400 strict_mode: unknown parameter", "invalid_request", false],
  ["Your message was flagged by the content filter", "moderation", false],
  ["The model `gpt-9` does not exist or you do not have access to it", "unsupported_model", false],
  ["Request cancelled by user", "cancelled", false],
  ["???", "unknown", false],
];
for (const [text, cls, retryable, waitMs] of ERR) {
  const r = O.classifyProviderError(text);
  ok(`classifyProviderError(${JSON.stringify(text)}) = ${cls}${retryable ? " (retryable)" : ""}`, r.cls === cls && r.retryable === retryable && (waitMs === undefined || r.waitMs === waitMs) && typeof r.hint === "string" && r.hint.length > 10, r);
}
ok("every error class has a retryable flag and a user hint", Object.keys(O.ERROR_CLASSES).length >= 11 && Object.values(O.ERROR_CLASSES).every((m) => typeof m.retryable === "boolean" && m.hint.length > 10));
ok("retryDelay: bounded back-off (2 attempts) for transient classes, null for permanent ones", O.retryDelay("rate_limit", 1) === 15000 && O.retryDelay("rate_limit", 2) === 45000 && O.retryDelay("rate_limit", 3) === null && O.retryDelay("busy", 1) === 6000 && O.retryDelay("network", 2) === 12000 && O.retryDelay("auth", 1) === null && O.retryDelay("quota", 1) === null && O.retryDelay("context_limit", 1) === null && O.retryDelay("cancelled", 1) === null);
ok("retryDelay honours a server-provided wait (retry-after) up to 120 s", O.retryDelay("rate_limit", 1, 30000) === 30500 && O.retryDelay("rate_limit", 1, 600000) === 120000);
// ── 5. tool argument validation against the registry schema ──
{
  const schema = { type: "object", required: ["path"], properties: { path: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 5 }, ok: { type: "boolean" }, mode: { type: "string", enum: ["a", "b"] }, list: { type: "array", items: { type: "string" } } }, additionalProperties: false };
  const v = O.validateToolArgs(schema, { path: "x", n: "3", ok: "true", mode: "B ", list: [1, "x"], zzz: 1, _totalInternal: true });
  ok("coerces stringified numbers/booleans, enum case, array items; drops unknown keys when additionalProperties=false; keeps _or* internals", v.problems.length === 0 && v.args.n === 3 && v.args.ok === true && v.args.mode === "b" && v.args.list[0] === "1" && !("zzz" in v.args) && v.args._totalInternal === true && v.dropped.join() === "zzz", v);
  const bad = O.validateToolArgs(schema, { path: "x", n: "abc", mode: "zzz" });
  ok("reports uncoercible type and enum violations without running", bad.problems.length === 2 && /must be integer/.test(bad.problems[0].msg) && /must be one of "a", "b"/.test(bad.problems[1].msg), bad.problems);
  ok("range violations are reported", O.validateToolArgs(schema, { path: "x", n: 9 }).problems.some((p) => /<= 5/.test(p.msg)));
  const msg = O.argProblemsMessage("execute_luau", bad, "execute_luau {code: string}");
  ok("INVALID_PARAMS feedback states the call was NOT run and includes the schema line", /ERROR INVALID_PARAMS calling 'execute_luau'/.test(msg) && /NOT run/.test(msg) && /execute_luau \{code: string\}/.test(msg));
  ok("schema-less tools pass through untouched", O.validateToolArgs(null, { a: 1 }).args.a === 1 && O.validateToolArgs({}, { a: 1 }).problems.length === 0);
}
// ── 6. false-success detection ──
ok("claimsCompletion: 'Done! I created…' / 'has been added' / 'is now in place' are completion claims", O.claimsCompletion("Done! I created the script in ServerScriptService.") && O.claimsCompletion("The leaderboard has been added to StarterGui.") && O.claimsCompletion("Everything is now in place and working."));
ok("claimsCompletion: future tense / plans / questions are NOT completion claims", !O.claimsCompletion("I will now create the script.") && !O.claimsCompletion("Here is the plan:\n1. create…") && !O.claimsCompletion("Should I create it in ServerScriptService?") && !O.claimsCompletion("Let me check the current state first."));
ok("FEEDBACK.falseSuccess is marked as TotalScript's note and demands either real commands or an honest statement", /System note from TotalScript, not the user/.test(O.FEEDBACK.falseSuccess) && /NO command has run/.test(O.FEEDBACK.falseSuccess) && /state plainly that nothing was executed/i.test(O.FEEDBACK.falseSuccess));
ok("FEEDBACK.providerRetry(cls, attempt, seconds) tells the model the previous message was re-sent and nothing ran twice", typeof O.FEEDBACK.providerRetry === "function" && /re-sent it - attempt 2/.test(O.FEEDBACK.providerRetry("busy", 2, 6)) && /Nothing was executed twice/.test(O.FEEDBACK.providerRetry("busy", 2, 6)));
// ── 7. secret redaction ──
{
  const s = O.redact("sk-abcdefghijklmnopqrstuvwxyz123456 Bearer eyJhbGciOiJIUzI1NiJ9.abc.def cc_" + "a".repeat(48) + " token=abcd1234efgh5678 plain words stay");
  ok("redact() masks OpenAI/CodeCraft/JWT/bearer/token=… secrets and keeps plain words", !/sk-abc|eyJ|cc_a|abcd1234/.test(s) && /plain words stay/.test(s), s);
  const d = O.redactData({ apiKey: "secret123", nested: { authorization: "Bearer x", text: "hello", api_key: "k" }, list: [{ password: "p" }] });
  ok("redactData() masks secret-named keys recursively without touching other fields", d.apiKey === "[redacted]" && d.nested.text === "hello" && d.nested.api_key === "[redacted]" && d.list[0].password === "[redacted]" && /redacted/.test(d.nested.authorization), d);
}
// ── 8. capability records come from adapter flags only ──
{
  const c = O.capabilities({ id: "x", displayName: "X", supportsVision: true, attachImages() {}, timings: { WARMUP_MS: 10000, RESPONSE_TIMEOUT_MS: 300000 }, sysMaxChars: 14000, compactCommandList: true, maxBatchCommands: 4, scanError() {}, findContinueBtn() {}, clickContinueBtn() {} });
  ok("capabilities(): vision needs supportsVision + attachImages, tightPrompt from sysMaxChars/compact flag, timings copied", c.vision === true && c.tightPrompt === true && c.maxBatchCommands === 4 && c.timings.warmupMs === 10000 && c.timings.responseTimeoutMs === 300000 && c.errorScan && c.nativeContinue);
  ok("capabilities(): nothing is invented for a bare adapter", (() => { const b = O.capabilities({ id: "y", displayName: "Y" }); return b.vision === false && b.streamTap === false && !b.sysMaxChars && b.tightPrompt === false && b.nativeContinue === false; })());
}
ok("orchestrator VERSION pinned", O.VERSION === "1.75.0", O.VERSION);

// ── wiring pins ──
const bundles = manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.some((j) => j.includes("src/core/main.js")));
ok("manifest: orchestrator.js precedes main.js in every core bundle (" + bundles.length + ")", bundles.length >= 16 && bundles.every((b) => b.js.indexOf("src/core/orchestrator.js") > 0 && b.js.indexOf("src/core/orchestrator.js") < b.js.indexOf("src/core/main.js") && b.js.indexOf("src/core/reasoning.js") < b.js.indexOf("src/core/orchestrator.js")));
ok("codecraft.html loads orchestrator.js after reasoning.js and before main.js", html.indexOf('src="src/core/reasoning.js"') < html.indexOf('src="src/core/orchestrator.js"') && html.indexOf('src="src/core/orchestrator.js"') < html.indexOf('src="src/core/main.js"'));
const PINS = [
  ["ORCH handle", /const ORCH = \(typeof TotalOrchestrator !== "undefined" && TotalOrchestrator\) \|\| null;/],
  ["task state on A", /task: null,[\s\S]{0,200}lastSent: null,/],
  ["diag payloads are redacted", /ORCH\.redactData\(/],
  ["provider_error classified", /ORCH\.classifyProviderError\(/],
  ["bounded provider retry resends the SAME message", /loop\.providerRetry/],
  ["false-success nudge", /loop\.falseSuccess/],
  ["explain-only tasks accept command-less replies", /loop\.commandlessAccepted/],
  ["task rider on first tool result", /task\.riderSent/],
  ["task rider respects the provider send budget", /task\.riderSkipped/],
  ["tool args validated against the registry schema before execution", /ORCH\.validateToolArgs\(/],
  ["invalid args are reported, not executed", /tool\.invalidArgs/],
  ["coercions logged", /tool\.argsCoerced/],
  ["task classification on send", /task\.classified/],
  ["capability record exposed for the debug overlay", /__rsProviderCaps/],
  ["provider caps diag", /provider\.caps/],
  ["context_limit class is honoured by errorResult", /cls\.cls === "context_limit"\) return \{ kind: "context_limit"/],
];
for (const [name, re] of PINS) ok("main.js: " + name, re.test(main));
ok("main.js: retries are bounded by ORCH.retryDelay (null after the class's max attempts) and never run after Stop", /ORCH\.retryDelay\(cls\.cls, providerRetries \+ 1, cls\.waitMs\)/.test(main) && /!A\.stop && A\.started \? ORCH\.retryDelay/.test(main));
ok("main.js: provider retries never happen without the exact text that was sent (A.lastSent)", /A\.lastSent\s*&&/.test(main) && /A\.lastSent = \{ text/.test(main));
ok("main.js: no automatic provider switching (Phase 91 rule still enforced)", /__rsAllowSiteSwitch === true/.test(main) || !/switchProvider\(/.test(main));
const RS_PINS = [/enum ErrClass/, /fn classify_error\(/, /fn trim_history\(/, /fn missing_required\(/, /fn retry_after_secs\(/, /retry-after/, /last_fail_count >= 4/, /MISSING_PARAMS/, /ErrClass::ContextLength/, /ErrClass::UnsupportedParam/, /mod recovery_tests/];
for (const re of RS_PINS) ok("chat.rs: " + re.source, re.test(rs));
ok("chat.rs: mid-stream failures are never resent (tokens already shown)", /if l\.starts_with\("stream error"\) \{ return ErrClass::Permanent; \}/.test(rs));
ok("chat.rs: transient retries are bounded and cancellable", /transient_retries\s*<\s*2|transient_retries\s*>=\s*2/.test(rs) && /cancel\.load\(Ordering::Relaxed\)[^\n]*break Err\(err\)/.test(rs));

console.log(`\ntest-orchestrator: ${pass + fail} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
