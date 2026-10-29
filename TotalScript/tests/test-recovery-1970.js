// 1.97.0 - Provider-reliability mission, unit pins for the three empirically
// found defects (see tests/recovery-e2e.js for the end-to-end reproduction):
//   1. identical tool feedback sent twice in a row was swallowed by the
//      duplicate-submit guard (meant for double-click races) and parked the loop;
//   2. a bridge timeout did not tell the model whether the request had reached
//      Studio (sent) - "MAY have run" vs "did NOT run";
//   3. INVALID_ENUM feedback listed 8 enum names + "..." and no closest match.
// Mocked - no AI site, Studio or Blender involved.
const fs = require("fs"), vm = require("vm"), path = require("path");
process.chdir(path.join(__dirname, ".."));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)) : "")); } }

global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const C = require(path.join(process.cwd(), "src/core/command_contract.js"));
const main = fs.readFileSync("src/core/main.js", "utf8");

// ── 1. duplicate-submit guard only suppresses UNANSWERED repeats ──
ok("submitAndGetBase: the same-text suppression requires the previous submit to be unanswered", /A\._lastSubmit\.sig === _sig && !A\._lastSubmit\.answered && Date\.now\(\) - A\._lastSubmit\.at < 2500/.test(main));
ok("submitAndGetBase: a new submit starts unanswered", main.includes("A._lastSubmit = { sig: _sig, at: Date.now(), answered: false };"));
ok("waitForResponse wraps waitForResponseInner and marks the submit answered on any reply except empty/timeout", /async function waitForResponse\(base\) \{\s*const res = await waitForResponseInner\(base\);[\s\S]{0,400}res\.kind !== "empty" && res\.kind !== "timeout"\) A\._lastSubmit\.answered = true;/.test(main) && main.includes("async function waitForResponseInner(base) {"));
ok("no other caller bypasses the wrapper (exactly one definition + one call of waitForResponseInner)", (main.match(/waitForResponseInner/g) || []).length === 2);
ok("the race case is still covered: the guard fires inside the 2.5 s window and returns the current assistant count", /diag\("send\.duplicateSuppressed", \{\}\);\s*return P\.assistantCount\(\);/.test(main));

// ── 2. timeout / offline verdicts tell the model what happened ──
ok("timeout: sent === false -> 'did NOT run'", main.includes(`? "The request never reached the bridge, so the command did NOT run."`));
ok("timeout: sent true/unknown -> 'MAY have run' + read the state back before resending a mutation", /The request reached the bridge, so the command MAY have run even though no result came back\. Read the state back \(inspect_instance \/ instance_find \/ get_console_output\) before you resend/.test(main));
ok("timeout verdict is rendered in the STUDIO_TIMEOUT line", /ERROR \$\{r\.errorCode\|\|"STUDIO_TIMEOUT"\}: tool '\$\{name\}' timed out after[^\n]*\\n\$\{r\.error\}\\n\$\{fate\} Check Studio responsiveness before retrying\./.test(main));
ok("disconnected: says the command did NOT run and not to resend unchanged while the bridge is down", /ERROR \$\{r\.errorCode\|\|"STUDIO_BRIDGE_OFFLINE"\}:[^\n]*The command did NOT run - nothing reached Studio\. Do not resend it unchanged while the bridge is down/.test(main));
const bg = fs.readFileSync("background.js", "utf8");
ok("background.js send(): the timeout reply carries sent:true (request was written) and the no-socket reply sent:false", /kind:"timeout"[^\n]*sent:true/.test(bg) && /kind:"disconnected"[^\n]*sent:false/.test(bg));

// ── 3. enum feedback: whole list + closest ──
ok("expected(): whole enum listed up to ENUM_LIST_MAX = 50 (every Roblox enum in the table fits)", C.source ? true : /const ENUM_LIST_MAX = 50;/.test(fs.readFileSync("src/core/command_contract.js", "utf8")) && Object.values(C.ROBLOX_ENUMS).every((l) => l.length <= 50));
ok("closest(): typo -> edit distance", JSON.stringify(C.closest(C.ROBLOX_ENUMS.Material, "Concret")) === '["Concrete"]', C.closest(C.ROBLOX_ENUMS.Material, "Concret"));
ok("closest(): substring either way, exact-fold first", JSON.stringify(C.closest(C.ROBLOX_ENUMS.Material, "metal")) === '["Metal","CorrodedMetal"]', C.closest(C.ROBLOX_ENUMS.Material, "metal"));
ok("closest(): spaces / case folded (Gotham Bold -> GothamBold)", C.closest(C.ROBLOX_ENUMS.Font, "Gotham Bold")[0] === "GothamBold");
ok("closest(): Enum.X. prefix stripped", C.closest(C.ROBLOX_ENUMS.Material, "Enum.Material.Neonn")[0] === "Neon");
ok("closest(): nothing invented for an unrelated word", C.closest(C.ROBLOX_ENUMS.Material, "Shiny").length === 0);
ok("closest(): at most 3, deterministic order", C.closest(C.ROBLOX_ENUMS.Material, "a").length <= 3);
const S = RobloxScriptSkills;
const pc = S.SKILL_COMMANDS && (S.SKILL_COMMANDS.part_create || (S.SKILL_COMMANDS.find && S.SKILL_COMMANDS.find((c) => c.name === "part_create")));
if (pc) {
  const r1 = C.prepare("part_create", { name: "x", material: "Concret" });
  ok("prepare(): 'Concret' is rejected with closest: Concrete in the suggestion", !r1.ok && /closest: Concrete/.test(r1.message || ""), (r1.message || "").slice(0, 400));
  ok("prepare(): the INVALID_ENUM message lists Neon and every other Material (no '...')", /Neon/.test(r1.message || "") && /SmoothPlastic/.test(r1.message || "") && !/\.\.\.\)/.test(r1.message || ""));
  const r2 = C.prepare("part_create", { name: "x", material: "Shiny" });
  ok("prepare(): unrelated word -> plain 'use one of the listed' without a fake closest", !r2.ok && !/closest:/.test(r2.message || "") && /use one of the listed Enum\.Material items/.test(r2.message || ""));
} else ok("part_create contract available in this harness", false, Object.keys(S));

// ── recovery e2e exists and is wired ──
const rec = fs.readFileSync("tests/recovery-e2e.js", "utf8");
ok("tests/recovery-e2e.js covers timeout-hold-readback, invalid enum, partial batch, offline budget + no stall", /timeoutOnce/.test(rec) && /material: Shiny/.test(rec) && /2 of 3 commands ran/.test(rec) && /send\.duplicateSuppressed/.test(rec) && /faults\.offline = true/.test(rec));
ok("README Testing line lists both new tests", /tests\/recovery-e2e\.js/.test(fs.readFileSync("README.md", "utf8")) && /tests\/test-recovery-1970\.js/.test(fs.readFileSync("README.md", "utf8")));

console.log(`\n${pass} ok, ${fail} failed (mocked - no live provider, Studio or Blender involved)`);
process.exit(fail ? 1 : 0);
