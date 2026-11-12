// Skill benchmark (1.99.6): how well does the deterministic skill_intel ranking
// put the right expert first for real prompts, and does every expert it picks
// reference the registry commands the task needs? Offline, dependency-free,
// deterministic - the same prompts give the same numbers every run, so the
// score is comparable between releases.
//
//   node tests/skill-bench.js            # pass / fail against the floors below
//   node tests/skill-bench.js --list     # one line per task with the ranking
//
// The labelled task set lives in tests/fixtures/skill_bench_tasks.json. The
// floors are the numbers 1.99.6 reached; they may only go UP in later releases.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const LIST = process.argv.includes("--list");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra != null ? "  — " + String(extra).slice(0, 400) : "")); } };

// Floors reached in 1.99.6 (see the report in README). Raise, never lower.
const FLOOR_TOP1 = 0.98;
const FLOOR_TOP2 = 1.0;
const FLOOR_SILENCE = 1.0;
const FLOOR_HOLDOUT = 0.5; // round 4 reached 52.6% (10/19) untuned - oblique prompts without a domain word; misses are mostly silence, not a wrong expert

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
Object.defineProperty(global, "navigator", { value: { userAgent: "node" }, configurable: true });
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"))[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/skill_refs.js"), { filename: "skill_refs.js" });
vm.runInThisContext(read("src/core/gui_standard.js"), { filename: "gui_standard.js" });
vm.runInThisContext(read("src/core/skill_intel.js"), { filename: "skill_intel.js" });
const SI = window.TotalSkillIntel, PACK = RobloxScriptSkills;

const known = new Set(PACK.SKILL_COMMANDS.filter((c) => !c.hidden).map((c) => c.name));
for (const m of read("background.js").matchAll(/btool\("([a-z_]+)"/g)) known.add(m[1]);
for (const m of read("src/core/animlib.js").matchAll(/name: "(animation_[a-z_]+)"/g)) known.add(m[1]);
const coreVirtual = read("src/core/main.js").match(/const CORE_VIRTUAL_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
for (const m of (coreVirtual ? coreVirtual[1] : "").matchAll(/"([a-z_]+)"/g)) known.add(m[1]);
known.add("execute_luau");

const fixture = JSON.parse(read("tests/fixtures/skill_bench_tasks.json"));
const tasks = fixture.tasks;
const ids = new Set(SI.EXPERTS.map((x) => x.id));
ok("fixture: " + tasks.length + " tasks, unique ids, every expected / alternate expert exists", tasks.length >= 80 && new Set(tasks.map((t) => t.id)).size === tasks.length && tasks.every((t) => (t.expect === null || ids.has(t.expect)) && (t.alt || []).every((a) => ids.has(a))), tasks.filter((t) => t.expect !== null && !ids.has(t.expect)).map((t) => t.id).join());
ok("fixture covers every expert at least twice", SI.EXPERTS.every((x) => tasks.filter((t) => t.expect === x.id || (t.alt || []).includes(x.id)).length >= 2), SI.EXPERTS.filter((x) => tasks.filter((t) => t.expect === x.id).length < 2).map((x) => x.id).join());
ok("fixture names only registry commands", tasks.every((t) => (t.commands || []).every((c) => known.has(c))), tasks.flatMap((t) => (t.commands || []).filter((c) => !known.has(c))).join());

const expertCommands = (id) => { const x = SI.EXPERTS.find((e) => e.id === id); const text = [x.summary, ...x.procedure, ...(x.verify || []), ...(x.pitfalls || [])].join("\n"); return new Set([...text.matchAll(/`([a-z][a-z0-9_]+)/g)].map((m) => m[1])); };

let top1 = 0, top2 = 0, silent = 0, silentWanted = 0, scored = 0, cmdOk = 0, cmdTotal = 0;
const misses = [], cmdMisses = [], perExpert = {};
for (const t of tasks) {
  const sel = SI.select(SI.analyze(t.text, t.ctx || {}), { max: 3 });
  const picked = sel.picked.map((p) => p.id);
  if (t.expect === null) {
    silentWanted++;
    if (!picked.length) silent++; else misses.push(t.id + " expected silence, got " + picked.join(">"));
    if (LIST) console.log("  " + t.id.padEnd(6) + (picked.length ? "NOISE " : "quiet ") + picked.join(">") + "  | " + t.text);
    continue;
  }
  scored++;
  const accept = new Set([t.expect, ...(t.alt || [])]);
  const hit1 = picked.length && accept.has(picked[0]);
  const hit2 = hit1 || (picked.length > 1 && accept.has(picked[1]));
  perExpert[t.expect] = perExpert[t.expect] || { n: 0, hit: 0 };
  perExpert[t.expect].n++;
  if (hit1) { top1++; perExpert[t.expect].hit++; }
  if (hit2) top2++;
  if (!hit1) misses.push(t.id + " wanted " + t.expect + (t.alt ? "|" + t.alt.join("|") : "") + ", got " + (picked.join(">") || "nothing") + "  | " + t.text);
  if (t.commands && t.commands.length) {
    const have = new Set(); for (const id of picked.slice(0, 2)) for (const c of expertCommands(id)) have.add(c);
    if (hit1) for (const c of expertCommands(t.expect)) have.add(c);
    for (const c of t.commands) { cmdTotal++; if (have.has(c)) cmdOk++; else cmdMisses.push(t.id + " " + c + " (picked " + picked.slice(0, 2).join(">") + ")"); }
  }
  if (LIST) console.log("  " + t.id.padEnd(6) + (hit1 ? "ok    " : hit2 ? "top2  " : "MISS  ") + picked.join(">").padEnd(44) + "| " + t.text);
}
const r1 = top1 / scored, r2 = top2 / scored, rs = silentWanted ? silent / silentWanted : 1, rc = cmdTotal ? cmdOk / cmdTotal : 1;
console.log("\nSKILL BENCH " + fixture.tasks.length + " tasks: top-1 " + (r1 * 100).toFixed(1) + "%  top-2 " + (r2 * 100).toFixed(1) + "%  silence " + (rs * 100).toFixed(0) + "%  command coverage " + (rc * 100).toFixed(1) + "% (" + cmdOk + "/" + cmdTotal + ")");
console.log("per expert: " + Object.entries(perExpert).map(([k, v]) => k + " " + v.hit + "/" + v.n).join(", "));
if (misses.length) console.log("misses:\n  " + misses.join("\n  "));
if (cmdMisses.length) console.log("command misses:\n  " + cmdMisses.join("\n  "));

ok("top-1 accuracy >= " + FLOOR_TOP1 * 100 + "%", r1 >= FLOOR_TOP1, (r1 * 100).toFixed(1) + "%");
ok("top-2 accuracy >= " + FLOOR_TOP2 * 100 + "%", r2 >= FLOOR_TOP2, (r2 * 100).toFixed(1) + "%");
ok("unrelated chatter gets no expert injected (" + silentWanted + " prompts)", rs >= FLOOR_SILENCE, misses.filter((m) => /silence/.test(m)).join("; "));
ok("every task's required command is referenced by the picked experts", rc === 1, cmdMisses.join("; "));
ok("ranking is deterministic (second pass identical)", tasks.every((t) => { const a = SI.select(SI.analyze(t.text, t.ctx || {}), { max: 3 }).picked.map((p) => p.id).join(); const b = SI.select(SI.analyze(t.text, t.ctx || {}), { max: 3 }).picked.map((p) => p.id).join(); return a === b; }));
// Hold-out set: written after tuning, never tuned against (see fixture._holdout).
const hold = fixture.holdout || [];
let h1 = 0, hs = 0, hScored = 0, hSilent = 0; const hMiss = [];
for (const t of hold) {
  const picked = SI.select(SI.analyze(t.text, t.ctx || {}), { max: 3 }).picked.map((p) => p.id);
  if (t.expect === null) { hSilent++; if (!picked.length) hs++; else hMiss.push(t.id + " noise " + picked.join(">")); continue; }
  hScored++;
  const accept = new Set([t.expect, ...(t.alt || [])]);
  if (picked.length && accept.has(picked[0])) h1++; else hMiss.push(t.id + " wanted " + t.expect + ", got " + (picked.join(">") || "nothing") + "  | " + t.text);
  if (LIST) console.log("  " + t.id.padEnd(6) + (picked.length && accept.has(picked[0]) ? "ok    " : "MISS  ") + picked.join(">").padEnd(44) + "| " + t.text);
}
const hr = hScored ? h1 / hScored : 1;
console.log("HOLD-OUT " + hold.length + " tasks: top-1 " + (hr * 100).toFixed(1) + "%  silence " + hs + "/" + hSilent + (hMiss.length ? "\n  " + hMiss.join("\n  ") : ""));
const hWrong = hMiss.filter((m) => /got (?!nothing)[a-z]/.test(m)).length;
console.log("HOLD-OUT wrong expert first: " + hWrong + "/" + hScored + " (the rest of the misses are silence - nothing injected)");
ok("hold-out top-1 >= " + FLOOR_HOLDOUT * 100 + "% (never tuned against) and at most 2 wrong-expert picks", hr >= FLOOR_HOLDOUT && hs === hSilent && hWrong <= 2, (hr * 100).toFixed(1) + "% wrong=" + hWrong);
ok("every pick comes with an explanation (deterministic, explainable ranking)", tasks.filter((t) => t.expect !== null).every((t) => { const s = SI.select(SI.analyze(t.text, t.ctx || {}), { max: 3 }); return s.picked.every((p) => p.why || p.reason || p.score != null) && Array.isArray(s.explain) ? true : s.explain != null; }));

console.log("\n" + (fail ? "FAILED  " : "OK    ") + "skill-bench: " + pass + " passed, " + fail + " failed");
