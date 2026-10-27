// Task list (1.25.0): per-project checklist with an Enable/Disable toggle in
// Settings. Dependency-free; run from the TotalScript root: node tests/test-tasklist.js
// The live flow (task_next → build → task_update, pill, Tasks tab, Settings
// toggle) is covered by `TASKS=1 node tests/notion-e2e.js` (jsdom).
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra ? "  — " + extra : "")); } };

const store = {};
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb({ ...store }), set: (o) => Object.assign(store, o) } } };
vm.runInThisContext(read("src/core/tasklist.js"), { filename: "tasklist.js" });
const TL = window.TotalTaskList;
ok("module exposes window.TotalTaskList + __rsTaskList hook", TL && typeof TL.run === "function" && typeof window.__rsTaskList === "function");
ok("disabled by default: no tools, no prompt, no state tag, hook null", !TL.isEnabled() && TL.toolEntries().length === 0 && TL.promptBlock() === "" && TL.stateTag() === "" && window.__rsTaskList() === null);
ok("task_* refuse while disabled", /disabled/.test(TL.run("task_add", { text: "x" })) && TL.list().length === 0);

TL.setEnabled(true);
ok("setEnabled persists rsTaskList.enabled", store.rsTaskList && store.rsTaskList.enabled === true && TL.isEnabled());
ok("four task_* tools appear once enabled", TL.toolEntries().map((t) => t.name).sort().join() === "task_add,task_list,task_next,task_update" && TL.toolEntries().every((t) => t.taskList && t.server === "totalscript"));

let added = TL.add("- [ ] Build the lobby\n2. Add a shop GUI\n* [x] Already done thing", { by: "user" });
ok("add() parses bullets / numbers / checkbox markers, one task per line", added.length === 3 && added[0].text === "Build the lobby" && added[1].text === "Add a shop GUI" && added[2].text === "Already done thing");
ok("checkbox [x] on add is NOT auto-done (add keeps user intent explicit)", TL.list()[2].status === "todo");
ok("find by id, #n, index and text", TL.find("#2").text === "Add a shop GUI" && TL.find(1).text === "Build the lobby" && TL.find("add a shop gui").id === TL.list()[1].id && TL.find("nope") === null);

const n1 = TL.next();
ok("next() is the first todo", n1 && n1.text === "Build the lobby");
let out = TL.run("task_next", {});
ok("task_next marks it doing and returns an instruction with the id", /"status": "doing"/.test(out) && out.includes(`task_update {\\"id\\":\\"${n1.id}\\",\\"status\\":\\"done\\"`), out.slice(0, 200));
ok("stateTag shows progress and the next task", TL.stateTag() === ` | TASKS 0/3 next #1 "Build the lobby"`, TL.stateTag());
out = TL.run("task_update", { id: "#1", status: "complete", notes: "lobby built and verified" });
ok("task_update accepts status synonyms and notes; points to the next task", /"status": "done"/.test(out) && /"next": "#2 Add a shop GUI"/.test(out) && TL.list()[0].doneAt > 0, out.slice(0, 200));
ok("task_update rejects an unknown status", /ERROR in task_update: status must be one of/.test(TL.run("task_update", { id: "#2", status: "banana" })));
ok("task_update with an unknown id errors with a hint", /no task matches 'zzz'/.test(TL.run("task_update", { id: "zzz", status: "done" })));
out = TL.run("task_add", { text: "Wire the shop to DataStore", first: true });
ok("task_add from the agent is tagged by=ai and can insert at the top", /"by": "ai"/.test(out) && TL.list()[0].text === "Wire the shop to DataStore");
ok("only one task can be doing at a time", (TL.update("#3", { status: "doing" }), TL.update("#4", { status: "doing" }), TL.list().filter((t) => t.status === "doing").length === 1 && TL.list()[3].status === "doing"));
ok("move() reorders", TL.move("#1", 1) && TL.list()[1].text === "Wire the shop to DataStore" && TL.move("#1", -5) === false);
ok("progress() counts", (() => { const p = TL.progress(); return p.total === 4 && p.done === 1 && p.open === 3; })());
ok("promptBlock lists tasks with marks and the rules", /━━━ TASK LIST \(user-enabled; 1\/4 done, 1 in progress\) ━━━/.test(TL.promptBlock()) && /\[x\] #\d+ Build the lobby — lobby built and verified/.test(TL.promptBlock()) && /task_next/.test(TL.promptBlock()) && TL.promptBlock({ compact: true }).length < TL.promptBlock().length);
ok("task_list filters by status", /"n":/.test(TL.run("task_list", { status: "done" })) && !/Add a shop GUI/.test(TL.run("task_list", { status: "done" })));
ok("remove() and clearDone()", (TL.remove("#2"), TL.list().length === 3) && (TL.update("#2", { status: "skipped" }), TL.clearDone() === 2) && TL.list().length === 1);

// export / import
TL.replaceAll([{ text: "A", status: "done" }, { text: "B" }]);
const exp = JSON.parse(TL.exportJson());
ok("exportJson is a tagged document with text/status/notes only", exp.format === "totalscript-task-list" && exp.tasks.length === 2 && exp.tasks[0].status === "done" && exp.tasks[0].id === undefined);
ok("importText accepts the export, plain lines and markdown checkboxes", TL.importText(JSON.stringify(exp)).added === 2 && TL.importText("- [x] C\n- D").added === 2 && TL.list().length === 6 && TL.list()[4].status === "done" && TL.list()[5].text === "D");
ok("importText replace mode", TL.importText("only", { replace: true }).ok && TL.list().length === 1 && !TL.importText("").ok);
let events = 0; const off = TL.onChange(() => events++); TL.add("evt"); TL.setEnabled(false); off();
ok("onChange fires for add/enable and can be unsubscribed; tasks survive disable", events === 2 && !TL.isEnabled() && TL.list().length === 2 && store.rsTaskList.tasks.length === 2);
ok("disabled again: tools gone, task_next refuses", TL.toolEntries().length === 0 && /disabled/.test(TL.run("task_next", {})));
TL.setEnabled(true);
ok("all-done state tag", (TL.replaceAll([{ text: "x", status: "done" }]), TL.stateTag() === " | TASKS 1/1 all done") && /All tasks are done/.test(TL.run("task_next", {})));

// ── wiring pins ────────────────────────────────────────────────────────────
const main = read("src/core/main.js");
const config = read("src/core/config.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => (c.js || []).includes("src/core/main.js"));
ok("manifest loads tasklist.js before main.js in every main.js bundle", bundles.length > 0 && bundles.every((c) => { const i = c.js.indexOf("src/core/tasklist.js"); return i >= 0 && i < c.js.indexOf("src/core/main.js"); }));
ok("runTool routes task_* to TotalTaskList.run and reports via __rsAfterTool", /if \(\/\^task_\(list\|next\|add\|update\)\$\/\.test\(toolName\) && typeof TotalTaskList !== "undefined"\)/.test(main) && main.includes("const r = TotalTaskList.run(toolName, args);"));
ok("task tools injected into the catalogue only while enabled; refreshed on enable/load", main.includes("for (const virtual of TotalTaskList.toolEntries())") && main.includes("t.publicSkill || t.taskList") && /total-tasklist-change[^\n]*why === "enabled" \|\| why === "loaded"/.test(main));
ok("SYSTEM_STATE carries the TASKS tag", main.includes("env += TotalTaskList.stateTag();"));
ok("list_commands shows a TASK LIST line in the universal tier when enabled", main.includes("TASK LIST (user enabled it in Settings;"));
ok("Settings has the Task list toggle row wired to setTaskList", main.includes('data-mode="tasklist"') && main.includes('else if(m==="tasklist") setTaskList(!taskListOn());') && /function setTaskList\(v\)\{/.test(main) && main.includes("TotalTaskList.setEnabled(!!v);"));
ok("bar has the task pill, synced on change and opening the Tasks tab", main.includes('id="rs-task-pill"') && /function syncTaskPill\(\)/.test(main) && main.includes('if (wasTasks) closeCardsWindow(); else openCardsWindow("tasks");')); // 1.73.0: the pill opens the Tasks tab in the centred Templates window
ok("cards panel: Tasks tab only while enabled, with add/run/plan/import/export/disable", main.includes('data-tab="tasks">Tasks') && main.includes('if (cardsTab === "tasks" && !taskListOn()) cardsTab = "library";') && /function tasksHtml\(\)/.test(main) && ["data-task-run-all", "data-task-run-next", "data-task-ai-plan", "data-task-clear-done", "data-task-export", "data-task-import", "data-task-disable", "data-task-add-form", "data-task-edit"].every((a) => main.includes(a)) && ["toggle", "doing", "skip", "up", "down", "delete", "run"].every((a) => main.includes(`a==="${a}"`)));
ok("Run prompts tell the AI to mark doing → done via task_update", /function taskRunPrompt\(t, idx\)/.test(main) && main.includes('"status":"doing"}, then do the work with real commands and verify it, then call task_update'));
ok("config.js appends the task block to the system prompt and the Notion preferences", config.includes("TotalTaskList.promptBlock({ compact: !!(maxChars && maxChars < 16000) })") && config.includes("TASK LIST preference (my setting is on)") && config.includes("${crewPref}${publicPref}${taskPref}"));
ok("totalscript_help knows the tasklist topic and matches it before roadmap", /tasklist:\{title:"Task list"/.test(main) && /aliases=\{tasklist:\/task list\|tasklist\|checklist/.test(main));
ok("overlay.css styles the pill, rows and progress bar", css.includes("#rs-task-pill") && css.includes(".rs-task-row") && css.includes(".rs-task-progress") && css.includes('#rs-task-pill[data-done="all"]'));

console.log(`\n${pass} passed, ${fail} failed`);
