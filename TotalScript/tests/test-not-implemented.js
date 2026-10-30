// 1.87.0: the x100 pack's 93 fake-success commands (builders that returned
// ok({...},'X configured'), created an empty Script, or only looked a player
// up) are hidden from the catalogue and FAIL before any Luau runs, naming a
// real alternative. Run: node tests/test-not-implemented.js
const fs = require("fs");
const vm = require("vm");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d != null ? "  — " + d : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"))[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
vm.runInThisContext(fs.readFileSync("src/core/command_contract.js", "utf8") + ";globalThis.__CC=TotalCommandContract;", { filename: "command_contract.js" });
const S = RobloxScriptSkills;
const CC = globalThis.__CC;

const src = fs.readFileSync("src/core/skills/studio_100.js", "utf8");
const table = src.match(/const NOT_IMPLEMENTED = \{([\s\S]*?)\n  \};/);
ok("studio_100.js carries the NOT_IMPLEMENTED table", !!table);
const names = table ? [...table[1].matchAll(/^\s+([a-z0-9_]+): "/gm)].map((m) => m[1]) : [];
ok("93 names are listed (90 'configured' stubs + projectile_launcher, weapon_recoil_set, status_effect_apply)", names.length === 93, names.length);
ok("no 'configured' fake-success builder is left in any pack", !fs.readdirSync("src/core/skills").some((f) => /configured'\)"/.test(fs.readFileSync("src/core/skills/" + f, "utf8"))));
ok("no B.<name> builder remains for a NOT_IMPLEMENTED name", !names.some((n) => new RegExp("B\\." + n + "\\s*=").test(src)));

const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
ok("every listed name is still registered (old transcripts / task lists resolve)", names.every((n) => byName.has(n)));
ok("every listed name is hidden from the catalogue and says so in its description", names.every((n) => byName.get(n).hidden === true && /Not implemented in this build/.test(byName.get(n).description)));
const builds = names.map((n) => S.buildLuau(n, { name: "x", part: "Workspace.P", target: "P" }));
ok("buildLuau returns an error for all 93 - no Luau is ever produced", builds.every((b) => b && b.err && !b.code));
ok("the error is explicit: NOT_IMPLEMENTED, 'NOT run', 'nothing was created', and names an alternative", builds.every((b) => /^ERROR NOT_IMPLEMENTED calling '[a-z0-9_]+'/.test(b.err) && /NOT run/.test(b.err) && /nothing was created/.test(b.err) && /Use .+ instead\.$/.test(b.err)));
const hintedCommands = new Set();
for (const b of builds) for (const m of String(b.err).matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)) hintedCommands.add(m[1]);
const missing = [...hintedCommands].filter((h) => !byName.has(h) && !/^(execute_luau|snake_case|tween_|fx_|vfx_|sfx_)$/.test(h) && !/^tween_$/.test(h));
ok("every real command named in a hint exists in the registry", missing.length === 0, missing.join(","));
const k = CC.classify("zipline_create", builds[0].err);
ok("the command contract classifies the error as deterministic (no identical resend)", k.ok === false && k.deterministic === true, JSON.stringify(k));

// The 6 real builders of the pack still produce Luau with a side effect.
const real = [...src.matchAll(/^  B\.([a-z0-9_]+) = function/gm)].map((m) => m[1]);
ok("6 real builders remain in studio_100.js (the 7th, cutscene_camera_track, moved to studio_cutscene.js in 1.77.0)", real.length === 6, real.join(","));
ok("the real builders still produce Luau that creates / changes something", real.every((n) => { const b = S.buildLuau(n, {}); return b && b.code && /Instance\.new|AssemblyLinearVelocity|\.CFrame\s*=/.test(b.code); }));
ok("real builders are still visible", real.every((n) => byName.get(n) && !byName.get(n).hidden));
ok("visible catalogue stays within budget: 597 after the 1.87.0 stub purge + 3 bench commands (1.99.6) = 600, never above 600", (() => { const v = S.SKILL_COMMANDS.filter((c) => !c.hidden).length; return v <= 600 && v > 550; })(), S.SKILL_COMMANDS.filter((c) => !c.hidden).length);

// No NOT_IMPLEMENTED name may satisfy an evidence gate or be recommended by the prompt.
const mainSrc = fs.readFileSync("src/core/main.js", "utf8"), reasoningSrc = fs.readFileSync("src/core/reasoning.js", "utf8"), configSrc = fs.readFileSync("src/core/config.js", "utf8");
const gateLines = [...mainSrc.matchAll(/^\s*(proof|did): \/.*$/gm)].map((m) => m[0]).concat([...reasoningSrc.matchAll(/^\s*const (VERIFY_RE|AUDIT_RE|MUTATE_RE) = .*$/gm)].map((m) => m[0]));
ok("the evidence gates (main.js proof/did per family, reasoning.js VERIFY/AUDIT/MUTATE) exist", gateLines.length >= 8, gateLines.length);
const gateHits = names.filter((n) => gateLines.some((l) => l.includes(n)));
ok("no not-implemented command satisfies an evidence gate (a no-op counted as 'verified' / 'built' before)", gateHits.length === 0, gateHits.join(","));
const promptHits = names.filter((n) => configSrc.includes(n));
ok("the system prompt no longer recommends not-implemented commands (audit_script_errors, staircase_generate, roof_structure_build, ik_control_setup, camera_shake_preset)", promptHits.length === 0 && /script_check \/ script_analysis/.test(configSrc) && /model_build \(stairs, roofs\)/.test(configSrc), promptHits.join(","));
ok("main.js: a builder refusal is annotated ([diagnosis]) and recorded as a FAILED tool call (session / activity), not returned raw", mainSrc.includes('const errRes = contractAnnotate(name, String(built.err), prepS);') && mainSrc.includes('window.__rsAfterTool(name, args, false, errRes);'));
const annotated = CC.annotate("zipline_create", builds[0].err, null);
ok("annotated refusal carries '[diagnosis] api_incompatibility (deterministic …)' so the loop guard never re-sends it", /\[diagnosis\] api_incompatibility \(deterministic/.test(annotated), annotated.slice(-200));
console.log(`test-not-implemented: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
