// Benchmark pack (1.99.6) — static + build-time checks on
// src/core/skills/studio_bench.js and its wiring: catalogue, registration in
// every bundle, programs build for sample / empty args, rubric integrity, the
// SYSTEMS gate in main.js, skill_intel references, help topic, next-step hints.
// Run-time behaviour against a DataModel lives in tests/bench-sim.py (lupa).
// node tests/test-bench-pack.js  (from the TotalScript root)
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra != null ? "  — " + String(extra).slice(0, 400) : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
Object.defineProperty(global, "navigator", { value: { userAgent: "node" }, configurable: true });
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
for (const f of bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
for (const f of ["src/core/skill_refs.js", "src/core/gui_standard.js", "src/core/skill_intel.js"]) vm.runInThisContext(read(f), { filename: f });
const S = RobloxScriptSkills, SI = window.TotalSkillIntel;
const pack = read("src/core/skills/studio_bench.js"), main = read("src/core/main.js");

// ── A. catalogue + registration ──
ok("A1 three bench commands registered in SKILL_COMMANDS, in order, none hidden", JSON.stringify(S.BENCH_COMMANDS) === JSON.stringify(["bench_targets", "bench_run", "bench_history"]) && S.BENCH_COMMANDS.every((n) => S.SKILL_COMMANDS.some((c) => c.name === n && !c.hidden)));
ok("A2 BENCH_VERSION 1.99.6, pass score 85, 33 checks, 5 categories", S.BENCH_VERSION === "1.99.6" && S.BENCH_PASS_SCORE === 85 && S.BENCH_CHECKS.length === 33 && JSON.stringify(S.BENCH_CATEGORIES) === JSON.stringify(["security", "performance", "robustness", "architecture", "ui_wiring"]));
ok("A3 every main.js bundle loads studio_bench.js right after studio_quality.js (" + bundles.length + " bundles)", bundles.length >= 10 && bundles.every((b) => b.js.indexOf("src/core/skills/studio_bench.js") === b.js.indexOf("src/core/skills/studio_quality.js") + 1 && b.js.indexOf("src/core/skills/studio_bench.js") < b.js.indexOf("src/core/main.js")));
ok("A4 codecraft.html loads the pack after studio_quality.js", (() => { const h = read("codecraft.html"); return h.indexOf("studio_bench.js") > h.indexOf("studio_quality.js") && h.indexOf("studio_bench.js") > 0; })());
ok("A5 params are typed and documented (suite / path / label / save / clear)", (() => { const c = Object.fromEntries(S.SKILL_COMMANDS.filter((x) => S.BENCH_COMMANDS.includes(x.name)).map((x) => [x.name, x])); return c.bench_run.params.suite.type === "string" && c.bench_run.params.path.req === false && c.bench_run.params.save.type === "boolean" && c.bench_history.params.clear.type === "boolean" && c.bench_targets.params.category.type === "string" && [c.bench_run, c.bench_history, c.bench_targets].every((x) => x.description.length > 80); })());
ok("A6 descriptions tell the truth: read-only apart from the history, complements quality_audit / project_health_report", /Read-only apart from that history value/.test(pack) && /Complements quality_audit \(look\) and project_health_report \(hygiene\)/.test(pack));

// ── B. rubric ──
const T = S.benchTargetsLocal({});
const checks = T.data.categories.flatMap((c) => c.checks.map((k) => Object.assign({ cat: c.id }, k)));
ok("B1 category weights sum to 100 and every check has weight / severity / fix", T.ok && T.data.categories.reduce((n, c) => n + c.weight, 0) === 100 && checks.length === 33 && checks.every((k) => k.weight > 0 && ["high", "medium", "low"].includes(k.severity) && k.fix.length > 20));
const known = new Set(S.SKILL_COMMANDS.filter((c) => !c.hidden).map((c) => c.name));
for (const m of read("background.js").matchAll(/btool\("([a-z_]+)"/g)) known.add(m[1]);
known.add("execute_luau");
const stubs = new Set(Object.keys((() => { const m = read("src/core/skills/studio_100.js").match(/const NOT_IMPLEMENTED = \{([\s\S]*?)\n  \};/); const o = {}; for (const x of (m ? m[1] : "").matchAll(/^\s+([a-z_]+):/gm)) o[x[1]] = 1; return o; })()));
const fixCmds = checks.flatMap((k) => [...k.fix.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)].map((x) => x[1])).filter((n) => !/^(no_|per_|one_|server_|client_|ui_wiring|game_|data_|ui_text|text_size)/.test(n));
ok("B2 every command named in a fix exists in the registry and none is a NOT_IMPLEMENTED stub (" + new Set(fixCmds).size + " names)", fixCmds.every((n) => known.has(n) || !/_/.test(n)) && fixCmds.every((n) => !stubs.has(n)), fixCmds.filter((n) => !known.has(n)).join(","));
ok("B3 bench_targets filters by category and rejects unknown ones", S.benchTargetsLocal({ category: "robustness" }).data.categories.map((c) => c.id).join() === "robustness" && S.benchTargetsLocal({ category: "looks" }).ok === false && /unknown category/.test(S.benchTargetsLocal({ category: "looks" }).error));
ok("B4 benchCheck(id) exposes a check; unknown is null", S.benchCheck("remote_unvalidated").cat === "security" && S.benchCheck("nope") === null);
ok("B5 the rubric text is bounded (fits one tool result) and names the workflow", T.text.length < 7000 && /Workflow: bench_targets/.test(T.text));

// ── C. programs ──
const progs = {};
for (const op of S.BENCH_COMMANDS) progs[op] = S.buildLuau(op, {});
ok("C1 every command builds Luau for empty args, with the cached-library split for the two Studio programs", S.BENCH_COMMANDS.every((op) => progs[op].code && !progs[op].err) && progs.bench_run.lib && progs.bench_run.body && progs.bench_history.lib && /TOTAL_RUN_bench_run/.test(progs.bench_run.code));
ok("C2 bench_run with path / suite / label / save:false builds and carries the config", (() => { const r = S.buildLuau("bench_run", { path: "Workspace.Map", suite: "performance", label: "after fix", save: false, max_findings: 10 }); return r.code && /Workspace\.Map/.test(r.code) && /"suite":"performance"/.test(r.code) && /"save":false/.test(r.code) && /"label":"after fix"/.test(r.code); })());
ok("C3 unknown suite is refused at build time (nothing is sent to Studio)", /unknown suite 'looks'/.test(S.buildLuau("bench_run", { suite: "looks" }).err || ""));
ok("C4 generated Luau has no backticks, no `continue`, no compound assignment", S.BENCH_COMMANDS.every((op) => !/`/.test(progs[op].code) && !/\bcontinue\b/.test(progs[op].code) && !/(?<!%s)[+\-*\/]=(?!=)/.test(progs[op].code.replace(/[~=<>]=/g, ""))));
ok("C5 bench_run only writes ServerStorage._TotalBench (no Destroy / Parent= / property writes on scanned instances)", (() => { const body = progs.bench_run.code.split("local function TOTAL_RUN_bench_run")[1] || ""; return !/:Destroy\(\)/.test(body) && !/\.Parent\s*=/.test(body) && /st\.Value=HttpService:JSONEncode\(hist\)/.test(body); })());
ok("C6 bench_history clear destroys only the _TotalBench value", /if st then st:Destroy\(\) end/.test(progs.bench_history.code) && /_TotalBench/.test(progs.bench_history.code));
ok("C7 bench_run output leads with BENCH n/100 (grade) and reports the delta against the previous run", /'BENCH '\.\.overall\.\.'\/100 \('\.\.grade\(overall\)/.test(progs.bench_run.code) && /delta=overall-prev\.overall/.test(progs.bench_run.code));

// ── D. main.js wiring ──
const gateBlock = main.slice(main.indexOf("  const MODE_GATES = {"), main.indexOf("  // 1.38.0: skill programs that legitimately run long"));
const gctx = { window: { __rsWorkMode: () => "creation" }, normalizeWorkMode: () => "creation", bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "CREATION" } } };
vm.createContext(gctx); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", gctx);
const G = (names) => gctx.modeGateNudge(new Set(names));
ok("D1 SYSTEMS is the fifth creation gate; proof is bench_run only", gctx.MODE_GATES.creation.map((g) => g.id).join() === "scripts,look,motion,quality,systems" && gctx.MODE_GATES.creation[4].proof.source === "^(bench_run)$");
ok("D2 the gate fires for remotes / saves / modules / blueprints without bench_run", /- SYSTEMS: you installed remotes/.test(G(["remote_scaffold", "script_read"])) && /- SYSTEMS:/.test(G(["datastore_setup", "script_check"])) && /- SYSTEMS:/.test(G(["module_scaffold"])) && /- SYSTEMS:/.test(G(["blueprint_install", "blueprint_verify", "quality_audit"])));
ok("D3 bench_run silences it and small edits never trip it", !/SYSTEMS:/.test(G(["remote_scaffold", "bench_run"])) && !/SYSTEMS:/.test(G(["remote_fire", "remotes_list"])) && G(["part_create", "material_set", "total_screenshot"]) === "" && !/SYSTEMS:/.test(G(["script_create", "script_read", "script_check"])));
ok("D4 blender / animate modes do not carry the systems gate (creation only)", !gctx.MODE_GATES.blender.some((g) => g.id === "systems") && !gctx.MODE_GATES.animate.some((g) => g.id === "systems"));
ok("D5 the nudge demands grade A (>= 85) and the BENCH score in the report", /re-run until the grade is A \(>= 85\) and put the BENCH score in the report/.test(gateBlock));
ok("D6 bench_* commands fall in the PLAYTEST & DEBUG family", /\|profiler\|bench\(mark\|_\)\|/.test(main));
ok("D7 next-step hints for bench_targets / bench_run / bench_history and the system installers point at bench_run", /bench_targets: "Next: build to the rubric/.test(main) && /bench_run: "Next: apply the FIX command of the top finding/.test(main) && /bench_history: "Next: bench_run after the next change/.test(main) && /remote_scaffold: "Next: [^"]*bench_run \{suite:\\"security\\"\}/.test(main) && /datastore_profile_scaffold: "Next: [^"]*bench_run \{suite:\\"robustness\\"\}/.test(main) && /blueprint_install: "Next: blueprint_verify, then bench_run/.test(main));
ok("D8 help topic `bench` exists with the five categories and the alias regex routes benchmark / scorecard / backdoor questions to it", /bench:\{title:"Benchmark \(1\.99\.6 bench pack\)"/.test(main) && /bench:\/benchmark\|bench_\|scorecard\|security score\|exploit\(able\)\?\|backdoor/.test(main) && /"Security: remotes with no handler/.test(main) && /"UI wiring: buttons no LocalScript references/.test(main));

// ── E. skill_intel ──
const txt = (id) => SI.expertText(id);
ok("E1 networking / performance / data / debug / project experts reference bench_run; project also bench_history, networking bench_targets", /`bench_run` with suite "security"/.test(txt("networking")) && /bench_targets/.test(txt("networking")) && /`bench_run` with suite "performance"/.test(txt("performance")) && /`bench_run` with suite "robustness"/.test(txt("data_persistence")) && /bench_run/.test(txt("debug_repair")) && /bench_run/.test(txt("project_analysis")) && /bench_history/.test(txt("project_analysis")));
ok("E2 COMMANDS THIS SKILL USES lists bench_run for those experts (so the audit 'every command exists' covers it)", ["networking", "performance", "data_persistence", "debug_repair", "project_analysis"].every((id) => /COMMANDS THIS SKILL USES[^\n]*\bbench_run\b/.test(txt(id))));
ok("E3 'benchmark my place' / 'rate my code' / 'before release' rank project_analysis first", ["benchmark my place and tell me what to fix", "rate my scripts against best practices", "polish everything before release"].every((q) => (SI.select(SI.analyze(q, { engine: "roblox" }), { max: 2 }).picked[0] || {}).id === "project_analysis"));

// ── F. README ──
const readme = read("README.md");
ok("F1 README documents bench_targets / bench_run / bench_history, the SYSTEMS gate and tests/bench-sim.py", /bench_run/.test(readme) && /bench_targets/.test(readme) && /bench_history/.test(readme) && /SYSTEMS gate/.test(readme) && /bench-sim\.py/.test(readme) && /test-bench-pack\.js/.test(readme));

console.log("\n" + (fail ? "FAILED  " : "OK    ") + "test-bench-pack: " + pass + " passed, " + fail + " failed");
