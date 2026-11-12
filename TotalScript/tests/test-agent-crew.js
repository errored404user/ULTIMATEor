// 1.22.0 — Multi-Agent rework: total_agent is a crew protocol with a shared board
// (plan / findings / verification), a role guard for read-only roles and a
// completion gate. Runs the real module under node + string checks on the
// wiring in main.js / config.js / manifest.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let multi = true;
globalThis.__rsMultiAgent = () => multi;
const Crew = require(path.join(ROOT, "src/core/agent_crew.js"));

let n = 0;
function ok(name, cond) { n++; if (!cond) { console.log("FAIL  " + name); process.exitCode = 1; } else console.log("PASS  " + name); }

// ── module behaviour ────────────────────────────────────────────────────────
Crew.reset();
ok("unknown role is rejected with the role list", /^ERROR/.test(Crew.handoff({ role: "wizard" })) && /planner, builder, scripter, reviewer, tester, debugger, done/.test(Crew.handoff({ role: "wizard" })));
ok("aliases resolve", Crew.normalizeRole("coder") === "scripter" && Crew.normalizeRole("QA") === "tester" && Crew.normalizeRole("architect") === "planner" && Crew.normalizeRole("finish") === "done");

const planner = Crew.handoff({ role: "planner", task: "plan a lobby" });
ok("planner handoff shows role + brief + empty plan", /ROLE=planner \(Planner\)/.test(planner) && /PLAN: \(none yet/.test(planner) && /read-only/.test(planner));
ok("planner is blocked from mutating", /^ERROR ROLE GUARD/.test(Crew.guard("part_create", { name: "Floor" }) || ""));
ok("planner may read", Crew.guard("get_studio_state", {}) === null && Crew.guard("script_read", { path: "x" }) === null);
Crew.reset(); Crew.handoff({ role: "planner" });
ok("read-only Luau is allowed, writing Luau is not",
  Crew.guard("execute_luau", { code: "return #workspace:GetDescendants()" }) === null &&
  /^ERROR ROLE GUARD/.test(Crew.guard("execute_luau", { code: "local p = Instance.new('Part') p.Parent = workspace" }) || ""));
ok("second insisted mutation auto-promotes instead of dead-locking",
  Crew.guard("part_create", { name: "Floor" }) === null && Crew.role() === "builder" &&
  /Auto-handoff/.test(Crew.afterTool("part_create", { name: "Floor" }, "Output of 'part_create':\nOK")));

Crew.reset();
Crew.handoff({ role: "planner" });
const b = Crew.handoff({ role: "builder", goal: "Lobby with a door", plan: ["Build the floor and walls", "Door model with hinge", "Door script (ProximityPrompt)"], step: 1, task: "floor" });
ok("board shows GOAL, numbered PLAN with the current step marked", /GOAL: Lobby with a door/.test(b) && /1\. \[>\] Build the floor/.test(b) && /3\. \[ \] Door script/.test(b) && /CURRENT STEP 1\/3/.test(b));
ok("plan accepts numbered text too", (() => { Crew.handoff({ role: "builder", plan: "1. alpha\n2) beta\n3. gamma" }); const s = Crew.summary(); return s.plan.length === 3 && /gamma/.test(s.plan[2]); })());
Crew.handoff({ role: "builder", plan: ["Build the floor and walls", "Door model with hinge", "Door script (ProximityPrompt)"], step: 1 });
ok("builder may mutate", Crew.guard("part_create", {}) === null && Crew.guard("execute_luau", { code: "Instance.new('Part')" }) === null);

let fb = "";
for (let i = 0; i < 4; i++) fb = Crew.afterTool("part_create", {}, "Output of 'part_create':\nOK");
ok("after 4 changes the board asks for a review", /\[CREW\] 4 changes since the last review/.test(fb) && /"role":"reviewer"/.test(fb));
ok("done is refused before verification", /^ERROR in total_agent: NOT DONE YET/.test(Crew.handoff({ role: "done", summary: "x" })) && /TESTER has not verified/.test(Crew.handoff({ role: "done" })));
ok("two failed edits in a row point to the debugger", (() => { Crew.handoff({ role: "scripter", step: 3 }); Crew.afterTool("script_set_source", {}, "ERROR in script_set_source: bad path"); const t = Crew.afterTool("script_set_source", {}, "ERROR in script_set_source: bad path"); return /\[CREW\] 2 failed changes/.test(t) && /"role":"debugger"/.test(t); })());

ok("reviewer records findings and is read-only", (() => { const r = Crew.handoff({ role: "reviewer", findings: ["Door has no PrimaryPart", "Script uses wait()"] }); return /FINDINGS:/.test(r) && /1\. \[open\] Door has no PrimaryPart/.test(r) && /^ERROR ROLE GUARD/.test(Crew.guard("set_property", {}) || ""); })());
ok("reviewer console errors → debugger hint", /"role":"debugger"/.test(Crew.afterTool("total_debug", {}, "Output of 'total_debug':\n2 error(s):\n- Door.Script:3: attempt to index nil")));
ok("debugger resolves findings by index", (() => { const d = Crew.handoff({ role: "debugger", fixed: [1, 2], task: "fix" }); return /\[fixed\] Door has no PrimaryPart/.test(d) && /all fixed/.test(d); })());
ok("debugger clean console → tester hint", /"role":"tester"/.test(Crew.afterTool("total_debug", {}, "Output of 'total_debug':\nOutput is clean (no errors).\nContinue building.")));
ok("tester may playtest but not edit", (() => { Crew.handoff({ role: "tester" }); return Crew.guard("start_stop_play", {}) === null && Crew.guard("total_screenshot", {}) === null && /^ERROR ROLE GUARD/.test(Crew.guard("part_create", {}) || ""); })());
ok("tester playtest asks for the console next", /get_console_output or total_debug/.test(Crew.afterTool("start_stop_play", {}, "Output of 'start_stop_play':\nstarted")));
ok("tester clean console verifies the run", (() => { const t = Crew.afterTool("total_debug", {}, "Output of 'total_debug':\nOutput is clean (no errors)."); return /run verified/.test(t) && Crew.summary().verified === true; })());
ok("done still blocked by unfinished plan steps, then passes with step_done / force", (() => {
  const blocked = Crew.handoff({ role: "done", summary: "built lobby" });
  const done = Crew.handoff({ role: "done", summary: "built lobby", step_done: 3 });
  return /plan step\(s\) not marked done/.test(blocked) && /^Output of 'total_agent':\nCREW DONE/.test(done) && /Report to the user now/.test(done) && Crew.role() === "";
})());
ok("state tag + badge reflect the board", (() => { Crew.reset(); Crew.handoff({ role: "scripter", plan: ["a", "b"], step: 2 }); const tag = Crew.stateTag(); const badge = Crew.badge(); return tag === "ON:scripter 1/2" && badge.text === "LUAU" && badge.role === "scripter"; })());
ok("mutations invalidate verification", (() => { Crew.handoff({ role: "tester" }); Crew.afterTool("total_debug", {}, "Output is clean (no errors)"); Crew.handoff({ role: "builder" }); Crew.afterTool("part_create", {}, "Output of 'part_create':\nOK"); return Crew.summary().verified === false; })());
ok("guard and hints are inert when Multi-Agent is off", (() => { multi = false; const g = Crew.guard("part_create", {}); const t = Crew.afterTool("part_create", {}, "Output of 'part_create':\nOK"); multi = true; return g === null && t === "Output of 'part_create':\nOK" && Crew.stateTag() !== "OFF"; })());
ok("prompt block documents roles, guard and completion gate", /planner .*builder .*scripter .*reviewer .*tester .*debugger/.test(Crew.promptBlock()) && /ROLE GUARD/.test(Crew.promptBlock()) && /REFUSED until the tester verified/.test(Crew.promptBlock()));

// ── wiring ──────────────────────────────────────────────────────────────────
const main = read("src/core/main.js");
const cfg = read("src/core/config.js");
const manifest = JSON.parse(read("manifest.json"));
const css = read("overlay.css");
ok("manifest loads agent_crew.js before main.js on every provider", manifest.content_scripts.filter((cs) => (cs.js || []).includes("src/core/main.js")).every((cs) => { const i = cs.js.indexOf("src/core/agent_crew.js"); return i >= 0 && i < cs.js.indexOf("src/core/main.js"); }));
ok("total_agent routes through the crew", main.includes("TotalAgentCrew.handoff(args)"));
ok("runTool applies the role guard before execution", main.includes("TotalAgentCrew.guard(bareName, args)") && main.indexOf("TotalAgentCrew.guard(bareName, args)") < main.indexOf('bareName === "web_fetch"'));
ok("agent loop appends board hints to every result", main.includes("TotalAgentCrew.afterTool(call.tool, call.arguments, feedback)"));
ok("SYSTEM_STATE and total_status expose the crew", main.includes("multi = TotalAgentCrew.stateTag()") && main.includes("TotalAgentCrew.summary()"));
ok("a new session resets the board", /async function startSession[\s\S]{0,600}TotalAgentCrew\.reset\(\)/.test(main));
ok("bar shows the crew badge", main.includes('id="rs-crew-badge"') && main.includes("function syncCrewBadge()") && css.includes("#rs-crew-badge[data-role=\"tester\"]"));
ok("system prompt embeds the crew protocol", cfg.includes("TotalAgentCrew.promptBlock()") && cfg.includes("MULTI-AGENT"));
ok("settings toggle describes the crew", main.includes("planner → builder / scripter → reviewer → tester → debugger"));
console.log(`\n${n} checks`);
