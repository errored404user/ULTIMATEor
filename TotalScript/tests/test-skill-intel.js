// Skill Intelligence (1.88.0): the built-in expert library, deterministic
// discovery / ranking / selection, the `skill` command answer, the expert rider,
// and the Prompt Enhancer's deterministic layer (intent + constraints, modes,
// must-keep list, expert excerpts, post-rewrite checks). Dependency-free; run
// from the TotalScript root: node tests/test-skill-intel.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra != null ? "  — " + String(extra).slice(0, 300) : "")); } };

// ── load: skills pack (for the live command names) + module under test ──
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"))[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/skill_intel.js"), { filename: "skill_intel.js" });
vm.runInThisContext(read("src/core/public_skills.js"), { filename: "public_skills.js" });
const SI = window.TotalSkillIntel, PS = window.PublicSkills, PACK = RobloxScriptSkills;
ok("module exposes window.TotalSkillIntel (analyze / select / answer / rider / plan / validateEnhanced)", SI && ["analyze", "select", "answer", "rider", "plan", "validateEnhanced", "rankPublic", "expertText", "listText"].every((k) => typeof SI[k] === "function") && SI.VERSION === "1.99.9");
ok("module is DOM-free at top level", !/^\s*(const|let|var)?\s*\w*\s*=?\s*document\./m.test(read("src/core/skill_intel.js")) && !/\bdocument\./.test(read("src/core/skill_intel.js")));

// ── 1. catalogue integrity ──
const E = SI.EXPERTS;
ok("library is deep, not wide: 12-24 experts", E.length >= 12 && E.length <= 24, E.length);
ok("ids unique, snake_case; every expert has title / env / summary / triggers / procedure / pitfalls / verify / brief", new Set(E.map((x) => x.id)).size === E.length && E.every((x) => /^[a-z][a-z0-9_]+$/.test(x.id) && ["roblox", "blender", "general"].includes(x.env) && x.title && x.summary.length <= 160 && Object.keys(x.triggers).length >= 8 && x.procedure.length >= 5 && x.procedure.length <= 10 && x.pitfalls.length >= 2 && x.verify.length >= 1 && x.brief.length >= 2));
ok("every procedure ends with an explicit stop condition and names where to look first", E.every((x) => /\bstop when\b|round-trip is only passed/i.test(x.procedure[x.procedure.length - 1]) && /\b(read|look|locate|inventory|check|get|scout|measure|inspect|pin|collect|pick|index)\b/i.test(x.procedure[0])), E.filter((x) => !/\bstop when\b|round-trip is only passed/i.test(x.procedure[x.procedure.length - 1])).map((x) => x.id).join(","));
ok("domain coverage: Roblox scripting / remotes / data / gameplay / UI / animation / VFX / SFX / cinematics / building / debug / perf / project, Blender modelling + pipeline, creative, general", ["luau_scripting", "networking", "data_persistence", "gameplay_systems", "ui_ux", "animation", "vfx", "sfx", "cinematics", "world_building", "debug_repair", "performance", "project_analysis", "blender_modeling", "blender_to_roblox", "creative_production", "general_engineering"].every((id) => E.some((x) => x.id === id)));
// Real-command audit: visible pack commands + animlib + Blender tools + core virtual tools.
const known = new Set(PACK.SKILL_COMMANDS.filter((c) => !c.hidden).map((c) => c.name));
for (const m of read("background.js").matchAll(/btool\("([a-z_]+)"/g)) known.add(m[1]);
for (const m of read("src/core/animlib.js").matchAll(/name: "(animation_[a-z_]+)"/g)) known.add(m[1]);
const coreVirtual = read("src/core/main.js").match(/const CORE_VIRTUAL_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
for (const m of (coreVirtual ? coreVirtual[1] : "").matchAll(/"([a-z_]+)"/g)) known.add(m[1]);
known.add("execute_luau");
const refs = E.flatMap((x) => x.commands.map((c) => [x.id, c]));
ok("experts reference commands (>= 120 references in total, every expert with a command list except the two general ones)", refs.length >= 120 && E.every((x) => x.commands.length >= 6 || x.env === "general"), refs.length);
const unknownRefs = refs.filter(([, c]) => !known.has(c));
ok("EVERY referenced command exists in this build (visible pack / animlib / Blender tools / core virtual)", unknownRefs.length === 0, JSON.stringify(unknownRefs.slice(0, 8)));
const notImpl = (read("src/core/skills/studio_100.js").match(/const NOT_IMPLEMENTED = \{([\s\S]*?)\n  \};/) || ["", ""])[1];
const notImplNames = new Set([...notImpl.matchAll(/^\s+([a-z0-9_]+): "/gm)].map((m) => m[1]));
ok("no expert recommends a NOT_IMPLEMENTED (hidden) command", notImplNames.size === 93 && !refs.some(([, c]) => notImplNames.has(c)));
ok("no expert claims invented facts about asset ids / uploads (sfx + pipeline say ids come from the user)", /never invents audio ids/.test(SI.expertText("sfx")) && /no invented texture ids/.test(SI.expertText("blender_to_roblox")) && /exported file alone is not success/.test(SI.expertText("blender_to_roblox")));
ok("near-duplicate check: no two experts share more than 60 % of their trigger words", (() => { for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) { const a = new Set(Object.keys(E[i].triggers)), b = Object.keys(E[j].triggers); const shared = b.filter((w) => a.has(w)).length; if (shared / Math.min(a.size, b.length) > 0.6) return false; } return true; })());
ok("complements point at real ids", E.every((x) => (x.complements || []).every((c) => E.some((y) => y.id === c))));

// ── 2. analysis ──
const A = (t, ctx) => SI.analyze(t, ctx || { engine: "roblox" });
ok("env: Studio wording → roblox; Blender wording → blender; general code → general; creative → general; empty on the RS engine → roblox", A("make a shop gui").env === "roblox" && A("export my sword from blender as fbx").env === "blender" && A("write a python script that parses csv").env === "general" && A("write a poem about autumn").env === "general" && A("do the thing").env === "roblox");
ok("env: focus=general overrides engine fallback; engine=local without Studio words → general", A("do the thing", { engine: "roblox", focus: "general" }).env === "general" && A("make a shop", { engine: "local" }).env === "general");
ok("intent: fix / explain / plan / review / implement / question", A("fix the datastore script, attempt to index nil").intent === "fix" && A("what is a RemoteEvent?").intent === "explain" && A("plan the architecture for a tycoon, no code yet").intent === "plan" && A("review my shop script").intent === "review" && A("make a sword").intent === "implement" && A("is this ok?").intent === "explain" && A("banana?").intent === "question");
ok("intent reuses the orchestrator task record when given (no second opinion)", A("make a sword", { engine: "roblox", task: { intent: "plan", categories: ["gameplay"] } }).intent === "plan" && A("x", { task: { intent: "fix", categories: ["debug", "luau"] } }).taskCategories.join(",") === "debug,luau");
ok("complexity: short → simple; a few sentences / 'system' → standard; long multi-part → complex", A("make a sword").complexity === "simple" && A("make a shop system with coins. Add a daily reward. Save it.").complexity === "standard" && A("Build a complete multiplayer round system with a lobby, waves of enemies, a shop between waves, leaderstats and datastore saving, plus a HUD that shows wave number, timer and coins, and an end screen with rewards. Everything must be server authoritative and work on mobile. Also add a spectator camera.").complexity === "complex");
const c1 = A("make a red door 7 studs tall named \"BossDoor\" in game.Workspace.Castle, no scripts, don't use unions, under 20 words, in R15, as a table, write it in Turkish; file door.rbxm");
ok("constraints: exclusions (no scripts, no unions)", c1.constraints.exclusions.includes("scripts") && c1.constraints.exclusions.includes("unions"), JSON.stringify(c1.constraints.exclusions));
ok("constraints: numbers with units, quoted strings, Studio paths, files, technology, output format, language", c1.constraints.numbers.includes("7 studs") && c1.constraints.quotes.includes("BossDoor") && c1.constraints.paths.includes("game.Workspace.Castle") && c1.constraints.files.includes("door.rbxm") && c1.constraints.tech.includes("R15") && c1.constraints.formats.some((f) => /as a table|under 20 words/.test(f)) && /turkish/i.test(c1.constraints.langHint), JSON.stringify(c1.constraints));
const c2 = A("fix this:\n```lua\nlocal x = nil\nprint(x.Name)\n```\nit errors");
ok("code blocks are counted and kept out of the prose analysis", c2.constraints.codeBlocks === 1 && c2.codeBlocks[0].startsWith("```lua") && c2.intent === "fix" && !c2.constraints.numbers.length);
ok("exclusion extraction ignores stop words ('no idea', 'not sure', 'don't know')", A("no idea what to do, not sure, don't know, make a sword without a gui").constraints.exclusions.join(",") === "gui");
ok("malformed input never throws (null / number / object / huge)", (() => { try { SI.analyze(null); SI.analyze(42); SI.analyze({}); SI.analyze("x ".repeat(20000)); SI.select(null); SI.plan(undefined); SI.validateEnhanced(null, null); SI.rider(null); SI.answer(null); return true; } catch (e) { return String(e); } })() === true);

// ── 3. selection ──
const sel = (t, o) => SI.select(SI.analyze(t, { engine: "roblox" }), o);
const primary = (t) => { const s = sel(t); return s.picked.length ? s.picked[0].id : ""; };
const CASES = [
  ["fix the datastore script, it says attempt to index nil", "debug_repair"],
  ["make an idle animation for my r15 rig", "animation"],
  ["create a cutscene intro with camera shake", "cinematics"],
  ["build a low poly medieval house 20 studs wide", "world_building"],
  ["save player coins with a datastore and leaderstats", "data_persistence"],
  ["add a remote event so the client can request a purchase, validate on the server", "networking"],
  ["make a main menu with play and settings buttons, dark theme, mobile friendly", "ui_ux"],
  ["add a fire explosion particle effect when the barrel breaks", "vfx"],
  ["add footstep sounds and background music with a sound group", "sfx"],
  ["my game lags on mobile, 20 fps, optimize it", "performance"],
  ["model a hard surface sci-fi crate in blender with clean topology", "blender_modeling"],
  ["export my blender sword to roblox as fbx and import it into studio", "blender_to_roblox"],
  ["write a backstory for the villain of my game", "creative_production"],
  ["write a python script that parses a csv and prints totals", "general_engineering"],
  ["add a sword with 25 damage and a 0.8s cooldown", "gameplay_systems"],
  ["refactor my codebase: show the require graph and the architecture", "project_analysis"],
];
const wrong = CASES.filter(([t, id]) => primary(t) !== id).map(([t, id]) => `${t.slice(0, 30)} → ${primary(t)} (want ${id})`);
ok("primary specialist per request (" + CASES.length + " cases)", wrong.length === 0, wrong.join(" | "));
ok("deterministic: the same request ranks identically twice; ties break by library order", JSON.stringify(sel("make a sword")) === JSON.stringify(sel("make a sword")) && sel("nothing in particular").picked.length === 0);
ok("irrelevant experts excluded: a poem gets no Roblox expert; a DataStore task gets no Blender expert; Blender work gets no Roblox UI expert", !sel("write a poem about autumn").picked.some((p) => SI.EXPERTS.find((x) => x.id === p.id).env === "roblox") && !sel("save player coins with a datastore").picked.some((p) => p.id.startsWith("blender")) && !sel("model a sci-fi crate in blender").picked.some((p) => p.id === "ui_ux"));
const swordSel = sel("add a sword with 25 damage and a 0.8s cooldown, server authoritative, no gui");
ok("complementary selection: gameplay primary + remotes/security complementary (listed by the primary); roles and reasons explained", swordSel.picked[0].id === "gameplay_systems" && swordSel.picked[0].role === "primary" && swordSel.picked.some((p) => p.id === "networking" && p.role === "complementary") && /^Gameplay systems .*\(primary: sword, damage, cooldown\) · Server \/ client & remotes \(security\) \(complementary: server authoritative\)$/.test(swordSel.explain) && swordSel.picked[0].why.includes("sword"));
ok("over-injection guard: never more than `max` picks, default 3; weak matches land in `excluded` with a reason", sel("make a complete game with animation, ui, vfx, sfx, datastore, remotes, npcs and a cutscene").picked.length <= 3 && sel("make a complete game with animation, ui, vfx, sfx, datastore, remotes, npcs and a cutscene", { max: 2 }).picked.length === 2 && sel("make a complete game with animation, ui, vfx, sfx, datastore, remotes, npcs and a cutscene").excluded.every((e) => typeof e.reason === "string" && e.reason));
ok("conflict: 'debug' only when the intent is a fix / review / inspect ('build a debug menu' is a build task)", primary("build a debug menu gui with buttons") === "ui_ux" && primary("fix the error in my gui script") === "debug_repair");
ok("explain string says when nothing matched (no fake specialist)", /no expert matched clearly/.test(sel("hello there").explain));
// installed public skills in the same ranking
const pubItems = [
  { id: "ps_1", kind: "ability", name: "boss_arena_builder", title: "Boss Arena Builder", tags: ["arena", "boss"], triggers: ["boss arena"], description: "Builds circular boss arenas with pillars and a throne platform.", enabled: true },
  { id: "ps_2", kind: "skill", name: "lantern_row", title: "Lantern Row", description: "Places lanterns along a path.", enabled: true }, // legacy: no tags / triggers
  { id: "ps_3", kind: "mode", name: "horror", title: "Horror", description: "Horror mode", enabled: true },
  { id: "ps_4", kind: "ability", name: "disabled_thing", title: "Disabled", tags: ["sword"], description: "sword sword sword", enabled: false },
  null, {}, { name: 5 },
];
const pr = SI.rankPublic(SI.analyze("build a boss arena with lanterns around it"), pubItems, 2);
ok("installed public skills ranked by name / tags / triggers / description; modes, disabled and malformed items ignored; legacy items without tags still rank", pr.length === 2 && pr[0].name === "boss_arena_builder" && pr[0].why.includes("boss arena") && pr[1].name === "lantern_row" && !pr.some((p) => p.name === "disabled_thing"), JSON.stringify(pr));
ok("select() carries the public matches (max 2) next to the experts", sel("build a boss arena with lanterns", { publicItems: pubItems }).publicItems.map((p) => p.name).join(",") === "boss_arena_builder,lantern_row");

// ── 4. `skill` command answers + rider ──
ok("answer: alias 'debug' → debug_repair full procedure with real commands, pitfalls, verify, related skills and the 'nothing ran' sentence", (() => { const t = SI.answer({ name: "debug" }); return /^SKILL debug_repair — Debug & repair \[roblox\]/.test(t) && /PROCEDURE:\n1\. /.test(t) && /PITFALLS:/.test(t) && /VERIFY BEFORE REPORTING:/.test(t) && /COMMANDS THIS SKILL USES \(all exist in this build\): get_console_output/.test(t) && /RELATED SKILLS: skill \{name: "luau_scripting"\}/.test(t) && /guidance only: nothing ran/.test(t) && /user's explicit instructions win/.test(t); })());
ok("answer: no name → catalogue of all experts with ids; unknown topic → best matches; free text → ranked list", /^SKILLS — \d+ built-in expert procedures/.test(SI.answer({})) && SI.answer({}).split("\n").length === E.length + 1 && /SKILLS matching "save player coins"/.test(SI.answer({ name: "save player coins" })) && /^- data_persistence/m.test(SI.answer({ name: "save player coins" })) && /No skill matched "zzqqxx"/.test(SI.answer({ name: "zzqqxx" })));
ok("answer accepts id / topic / query / string args", SI.answer("ui").startsWith("SKILL ui_ux") && SI.answer({ topic: "remotes" }).startsWith("SKILL networking") && SI.answer({ query: "blender" }).startsWith("SKILL blender_modeling"));
ok("expert texts are bounded (each under 3.5 kB) - details on demand, not a wall", E.every((x) => SI.expertText(x.id).length < 3500));
const rFull = SI.rider(swordSel, {}), rTight = SI.rider(swordSel, { tight: true });
ok("rider: labelled as TotalScript's note, names the specialist, points at the full skill(s), states precedence; tight is shorter", /^\(Expert note from TotalScript, not the user\.\) Specialist: Gameplay systems/.test(rFull) && /skill \{name: "gameplay_systems"\}, skill \{name: "networking"\}/.test(rFull) && /override this note/.test(rFull) && /win over this note/.test(rTight) && rTight.length < rFull.length);
ok("rider: bounded (full ≤ 640 chars, tight ≤ 360) across every expert", E.every((x) => { const s = SI.select({ domains: [{ id: x.id, score: 20, why: ["t"] }], text: "" }); return SI.rider(s, {}).length <= 640 && SI.rider(s, { tight: true }).length <= 360; }));
ok("rider: nothing when nothing matched (unrelated turns get no injection)", SI.rider(sel("hello there"), {}) === "" && SI.rider(null) === "" && SI.rider({ picked: [] }) === "");

// ── 5. enhancer layer: modes, strategy, must-keep, excerpts ──
ok("MODES: auto, quick, expert, deep, creative, debug (no more)", SI.MODES.map((m) => m.id).join(",") === "auto,quick,expert,deep,creative,debug");
const pm = (t, ctx) => SI.pickMode(SI.analyze(t, Object.assign({ engine: "roblox" }, ctx || {})));
ok("auto mode: fix → debug; creative writing → creative; complex system → deep; short question → quick; short build → expert (simple stays short through the strategy, not by skipping)", pm("fix the datastore script, attempt to index nil") === "debug" && pm("write a backstory for the villain", { focus: "general" }) === "creative" && pm("Build a complete multiplayer round system with a lobby, waves of enemies, a shop between waves, leaderstats and datastore saving, plus a HUD that shows wave number, timer and coins, and an end screen with rewards. Everything must be server authoritative and work on mobile. Also add a spectator camera.") === "deep" && pm("what is a RemoteEvent?") === "quick" && pm("make a shop gui") === "expert");
const strat = Object.fromEntries(SI.MODES.map((m) => [m.id, SI.modeStrategy(m.id, { env: "roblox" })]));
ok("strategies differ per mode and change the approach: quick ≤ 4 lines / no headings; deep adds COMPONENTS / DATA & FLOW / FAILURE MODES / ACCEPTANCE TESTS; creative forbids technical detail; debug asks for root cause + minimal fix; expert keeps simple requests short", new Set(Object.values(strat)).size === 5 && /at most 4 lines/.test(strat.quick) && /No headings/.test(strat.quick) && /COMPONENTS/.test(strat.deep) && /FAILURE MODES/.test(strat.deep) && /ACCEPTANCE TESTS/.test(strat.deep) && /Do not add technical requirements/.test(strat.creative) && /minimal fix, not a rewrite/.test(strat.debug) && /keep a simple request short/.test(strat.expert) && strat.auto === strat.expert);
const keep = SI.preserveLines(c1);
ok("must-keep line lists exclusions as 'no X', numbers, exact strings, paths, files, technology, format, language", /^MUST KEEP \(found in the rough request; restate each one, never drop or invert\): /.test(keep) && /exclusions: no scripts; no unions/.test(keep) && /numbers: 7 studs/.test(keep) && /exact strings: "BossDoor"/.test(keep) && /paths: game\.Workspace\.Castle/.test(keep) && /files: door\.rbxm/.test(keep) && /technology: R15/.test(keep) && /output format: /.test(keep) && /language: /.test(keep), keep);
ok("must-keep is empty when there is nothing to keep (no boilerplate)", SI.preserveLines(A("make a sword")) === "" && SI.preserveLines(null) === "");
const ex = SI.expertise(swordSel, {});
ok("expertise block: short excerpts (brief lines) per picked expert, no command names, bounded, with the 'never add features' rule", /^DOMAIN EXPERTISE \(use it to make implied requirements explicit and to pick defaults - never to add features the user did not ask for\):/.test(ex) && /- Gameplay systems/.test(ex) && /- Server \/ client & remotes/.test(ex) && !/`/.test(ex) && !/\b[a-z]+_[a-z]+_[a-z]+\b/.test(ex) && ex.length <= 900);
ok("expertise block is empty when nothing matched (skipped, not padded)", SI.expertise(sel("hello there"), {}) === "" && SI.expertise(null) === "");
const plan1 = SI.plan("add a sword with 25 damage and a 0.8s cooldown, server authoritative, no gui", { engine: "roblox", mode: "auto" });
ok("plan(): auto → expert, selection + strategy + preserve + expertise + focus in one call", plan1.mode === "expert" && plan1.modeAuto === true && plan1.selection.picked[0].id === "gameplay_systems" && /MODE: Expert/.test(plan1.strategy) && /no gui/.test(plan1.preserve) && plan1.expertise.length > 0 && plan1.focus === "roblox");
const plan2 = SI.plan("add a sword with 25 damage", { engine: "roblox", mode: "quick" });
ok("plan(): explicit Quick overrides auto, loads at most one specialist and NO expertise block (simple stays simple)", plan2.mode === "quick" && plan2.modeAuto === false && plan2.selection.picked.length <= 1 && plan2.expertise === "" && /MODE: Quick/.test(plan2.strategy));
ok("plan(): explicit Creative on a Roblox request still works (mode is the user's call) and the focus follows the environment", SI.plan("make a sword", { engine: "roblox", mode: "creative" }).mode === "creative" && SI.plan("write a poem", { engine: "roblox", focus: "general" }).focus === "general");
ok("plan(): user guidance / notes never feed the analysis (only the request text does)", JSON.stringify(SI.plan("make a sword", { engine: "roblox", notes: "no gui" }).analysis.constraints.exclusions) === "[]");

// ── 6. post-rewrite checks ──
const V = (r, e, o) => SI.validateEnhanced(r, e, o || {});
ok("clean rewrite that keeps every detail → ok with no issues", (() => { const v = V("make a red door 7 studs tall named \"BossDoor\", no scripts", "GOAL - build a red door named \"BossDoor\"\nSCOPE - 7 studs tall, in Workspace\nCONSTRAINTS - no scripts at all"); return v.ok && v.issues.length === 0; })());
ok("dropped number / quoted string / path / file / tech → warn each", (() => { const v = V("door 7 studs tall named \"BossDoor\" in game.Workspace.Castle, from door.rbxm, R15", "GOAL - a door"); const kinds = v.issues.map((i) => i.kind); return !v.ok && ["numbers", "exact strings", "paths", "files", "technology"].every((k) => kinds.includes(k)); })());
ok("exclusion dropped → warn; exclusion inverted ('no gui' → 'include a gui') → warn; restated with negation → fine", !V("make a sword, no gui", "GOAL - sword").ok && V("make a sword, no gui", "GOAL - sword\nLOOK - include a small gui").issues.some((i) => i.kind === "exclusion" && /without its negation/.test(i.text)) && V("make a sword, no gui", "GOAL - sword\nCONSTRAINTS - no gui").ok);
ok("code block changed → warn + `repaired` re-attaches the ORIGINAL block verbatim; untouched block → nothing", (() => { const r = "fix:\n```lua\nlocal x = nil\nprint(x.Name)\n```"; const bad = V(r, "GOAL - fix the snippet"); const good = V(r, "GOAL - fix\n```lua\nlocal x = nil\nprint(x.Name)\n```"); return bad.issues.some((i) => i.kind === "code") && bad.dropped === 1 && /CODE FROM MY REQUEST \(keep exactly as written\):\n```lua\nlocal x = nil\nprint\(x\.Name\)\n```/.test(bad.repaired) && good.dropped === 0 && good.repaired === "GOAL - fix\n```lua\nlocal x = nil\nprint(x.Name)\n```"; })());
ok("phantom command names (not in this build, not in the request) → warn; real ones pass; prose snake_case idioms ignored", V("make a shop", "use shop_mega_generate then ui_screen_generate", { knownCommands: new Set(["ui_screen_generate"]) }).issues.some((i) => i.kind === "commands" && /shop_mega_generate/.test(i.text) && !/ui_screen_generate/.test(i.text)) && V("make a shop", "use ui_screen_generate; name the stat max_health; use snake_case", { knownCommands: new Set(["ui_screen_generate"]) }).ok);
ok("technology flip (R6 → R15) → warn; questions instead of assumptions → warn; chatter preamble → info", V("animate my r6 rig", "GOAL - an R15 animation").issues.some((i) => i.kind === "flip") && V("make a shop", "What items? Which currency?").issues.some((i) => i.kind === "questions") && V("make a shop", "Sure! Here is the prompt:\nGOAL - shop").issues.some((i) => i.kind === "preamble" && i.severity === "info"));
ok("over-length → info only (never blocks); empty rewrite → warn", (() => { const v = V("make a sword", ("REQUIREMENT - detail. ").repeat(80)); return v.issues.some((i) => i.kind === "length" && i.severity === "info") && !v.issues.some((i) => i.kind === "length" && i.severity === "warn") && !V("make a sword", "").ok && V("make a sword", "").issues.some((i) => i.kind === "empty"); })());
ok("no numeric 'quality score' anywhere - checks are named issues with severities", !/score\s*[:=]\s*\d|quality ?score|\/100|out of 10/i.test(JSON.stringify(V("make a red door 7 studs", "GOAL - door"))) && !/qualityScore|scoreOutOf/.test(read("src/core/skill_intel.js")));

// ── 7. wiring: config.js request layers, main.js, enhancer.js, manifest, studio_bridge, public_skills ──
vm.runInThisContext(read("src/core/config.js") + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
const base = RS.enhancerRequest({ rough: "make a shop", focus: "roblox", agentStarted: true });
const layered = RS.enhancerRequest({ rough: "make a shop", focus: "roblox", agentStarted: true, strategy: plan1.strategy, preserve: plan1.preserve, expertise: plan1.expertise });
ok("config.js: without the layers the request is byte-identical to the 1.72 contract (pins untouched)", base === RS.enhancerRequest({ rough: "make a shop", focus: "roblox", agentStarted: true, strategy: "", preserve: "", expertise: "" }) && !/MODE: |MUST KEEP|DOMAIN EXPERTISE/.test(base));
ok("config.js: strategy, must-keep and expertise sit after the structure and before the Length line; markers + fenced rough still close the request", layered.indexOf("Structure (use these headings") < layered.indexOf("MODE: Expert") && layered.indexOf("MODE: Expert") < layered.indexOf("MUST KEEP") && layered.indexOf("MUST KEEP") < layered.indexOf("DOMAIN EXPERTISE") && layered.indexOf("DOMAIN EXPERTISE") < layered.indexOf("Length: as long as needed") && layered.endsWith('ROUGH REQUEST:\n"""\nmake a shop\n"""'));
ok("config.js: a fully layered request stays under 4.5 kB + rough (token efficiency)", layered.length - "make a shop".length < 4500, layered.length);
ok("config.js: GUI brief detector still ignores layered enhancer requests", RS.detectGuiIntent(layered).gui === false);
const main = read("src/core/main.js");
ok("main.js: `skill` answers from TotalSkillIntel with the current request as context (one-line packs only as the fallback)", /if \(name === "skill"\) \{\n\s+\/\/ 1\.88\.0[\s\S]{0,900}a2\.context = ctxText\.slice\(0, 600\);\n\s+return "Output of 'skill':\\n" \+ TotalSkillIntel\.answer\(a2\);/.test(main) && !/const res0 = `Output of 'skill'/.test(main));
ok("main.js: enhancePromptViaAI builds the request through enhancerPlan (strategy / preserve / expertise) and keeps the plain 1.72 call as the fallback; runs validateEnhanced after parsing; returns mode / experts / checks", /function enhancerPlan\(rough, o\)/.test(main) && /RS\.enhancerRequest\(\{ rough, focus, notes: o\.notes, short: !!o\.short, agentStarted: !!A\.started, strategy: plan\.strategy, preserve: plan\.preserve, expertise: plan\.expertise \}\)/.test(main) && /: RS\.enhancerRequest\(\{ rough, focus, notes: o\.notes, short: !!o\.short, agentStarted: !!A\.started \}\);/.test(main) && /TotalSkillIntel\.validateEnhanced\(rough, parsed\.text, \{ analysis: plan\.analysis, knownCommands: enhancerKnownCommands\(\), mode: plan\.mode \}\)/.test(main) && /checks: checks \? \{ ok: checks\.ok, issues: checks\.issues, repaired: checks\.dropped \? checks\.repaired : "" \} : null/.test(main));
ok("main.js: the plan reads installed public skills for ranking and the enhancer gets an `analyze` hook (sync preview)", /PublicSkills\.list\(\{ enabled: true \}\)/.test(main) && /analyze: \(rough, o\) => \{ const p = enhancerPlan\(rough, o \|\| \{\}\);/.test(main));
ok("main.js: specialist selected at classify time from the same text as the task record (reuses its intent); follow-ups keep it; expert rider rides with the task brief inside the send budget; never on explain-only turns", /A\.skillSel = TotalSkillIntel\.select\(TotalSkillIntel\.analyze\(text, \{ engine: activeEngine\(\), task: A\.task, mode: normalizeWorkMode\(window\.__rsWorkMode && window\.__rsWorkMode\(\)\) \}\), \{ max: 2 \}\)/.test(main) && /if \(!\(A\.task\.followUp \|\| A\.task\.isContinue\) \|\| !A\.skillSel\) A\.skillSel = null;/.test(main) && /if \(rider && A\.skillSel && A\.skillSel\.picked && A\.skillSel\.picked\.length && !A\.task\.explainOnly && typeof TotalSkillIntel !== "undefined"\) \{\n\s+const note = TotalSkillIntel\.rider\(A\.skillSel, \{ tight \}\);\n\s+if \(note && toSend\.length \+ note\.length \+ 2 <= cap\)/.test(main));
ok("main.js: task text exposed for the public-skills catalogue ranking (window.__rsTaskText)", /window\.__rsTaskText = \(\) => String\(text \|\| ""\)\.slice\(0, 2000\)/.test(main));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("manifest: skill_intel.js loads after public_skills.js and before enhancer.js / main.js in every main.js bundle; codecraft.html too", bundles.length >= 10 && bundles.every((c) => { const i = c.js.indexOf("src/core/skill_intel.js"); return i > c.js.indexOf("src/core/public_skills.js") && i < c.js.indexOf("src/core/enhancer.js") && i < c.js.indexOf("src/core/main.js"); }) && (() => { const h = read("codecraft.html"); return h.indexOf('src="src/core/skill_intel.js"') > h.indexOf('src="src/core/public_skills.js"') && h.indexOf('src="src/core/skill_intel.js"') < h.indexOf('src="src/core/enhancer.js"'); })());
ok("studio_bridge.js: the `skill` catalogue entry names the expert ids (what the model can ask for)", /name: "skill", description: "Load one built-in expert procedure \(no Studio call\): luau_scripting, networking, data_persistence/.test(read("src/core/studio_bridge.js")));
const enh = read("src/core/enhancer.js");
ok("enhancer.js: mode chips (radiogroup), insight line, checks panel, Previous version + Restore dropped code actions; mode persisted in rsEnhancer prefs; failure keeps the previous result / original", /class="rse-row rse-mode" role="radiogroup" aria-label="Mode"/.test(enh) && /class="rse-insight" aria-live="polite"/.test(enh) && /class="rse-checks" aria-live="polite"/.test(enh) && /data-act="previous"/.test(enh) && /b\.dataset\.act = "repair"; b\.textContent = "Restore dropped code"/.test(enh) && /rsEnhancer: \{ focus: S\.focus, short: S\.short, mode: S\.mode \}/.test(enh) && /your previous result is still here\./.test(enh) && /your original text is untouched\./.test(enh));
ok("enhancer.js: Re-enhance keeps the previous result (S.prev) and never writes into the rough textarea; opts carry the mode", /if \(S\.result\.trim\(\) && S\.result !== S\.rough\) S\.prev = S\.result;/.test(enh) && /const opts = \{ focus: S\.focus, mode: S\.mode, short: S\.short, notes: S\.notes\.trim\(\), cancelled: \(\) => S\.cancelled \};/.test(enh) && !/D\.rough\.value = S\.result/.test(enh));
ok("overlay.css styles the new enhancer pieces", [".rse-mode-hint", ".rse-insight", ".rse-checks", ".rse-check-list li[data-severity=\"warn\"]", ".rse-repair"].every((s) => read("overlay.css").includes(s)));

// ── 8. public skills: triggers, legacy compat, relevance-capped catalogue ──
const legacy = PS.validate({ kind: "ability", name: "old_one", description: "An ability saved before triggers existed.", instructions: "Do the old thing carefully and report." });
ok("legacy item (no triggers / tags) validates; triggers default to [] - missing metadata never crashes loading", legacy.ok && Array.isArray(legacy.item.triggers) && legacy.item.triggers.length === 0);
const withTr = PS.validate({ kind: "ability", name: "boss_arena_builder", description: "Builds circular boss arenas.", instructions: "Build the arena with pillars and a throne platform.", triggers: ["Boss Arena", "arena", "ARENA", "throne room"] });
ok("triggers normalised (lower-case, de-duplicated, max 12) and `when:` accepted as an alias", withTr.ok && withTr.item.triggers.join(",") === "boss arena,arena,throne room" && PS.validate({ kind: "ability", name: "x_alias", description: "alias field for triggers test.", instructions: "Do the aliased thing now please.", when: "a, b" }).item.triggers.join(",") === "a,b");
PS.replaceAll([]);
const many = []; for (let i = 0; i < 15; i++) many.push({ kind: "ability", name: "proc_" + String.fromCharCode(97 + i) + "_thing", description: `Procedure number ${i} for generic tasks nobody asked about.`, instructions: "Do steps one two three and report what happened.", tags: i === 14 ? ["arena"] : [] });
many[7].triggers = ["boss arena"]; many[7].description = "Builds a circular boss arena with pillars.";
for (const d of many) PS.upsert(d);
const blockAll = PS.catalogueBlock({ compact: true, task: "build a boss arena please" });
ok("catalogueBlock: with 15 installed only 12 are listed, the ones relevant to the task first, the rest counted with a pointer to public_skill_list", /PUBLIC SKILLS - 15 user-made commands/.test(blockAll) && (blockAll.match(/^proc_[a-z]_thing \{\}/gm) || []).length === 12 && blockAll.indexOf("proc_h_thing") < blockAll.indexOf("proc_a_thing") && /…and 3 more installed - public_skill_list \{\} shows all of them/.test(blockAll), blockAll.slice(0, 300));
ok("catalogueBlock: at or under the cap every command is listed exactly as before (no 'more' line)", (() => { PS.replaceAll(many.slice(0, 12)); const b = PS.catalogueBlock({ compact: true }); return (b.match(/^proc_[a-z]_thing \{\}/gm) || []).length === 12 && !/more installed/.test(b); })());
PS.replaceAll(many);
ok("relevant(): a trigger phrase qualifies, a lone tag hit stays under the noise floor; deterministic; empty text → []", PS.relevant("build a boss arena please", 3).map((r) => r.name).join(",") === "proc_h_thing" && PS.relevant("", 3).length === 0 && JSON.stringify(PS.relevant("boss arena", 3)) === JSON.stringify(PS.relevant("boss arena", 3)));
ok("exportText carries triggers and parseText reads them back", (() => { PS.replaceAll([]); PS.upsert(withTr.item); const t = PS.exportText("boss_arena_builder"); const p = PS.parseText(t); PS.replaceAll([]); const v2 = PS.validate(p.ok ? p.def : {}); return /^triggers: boss arena, arena, throne room$/m.test(t) && p.ok && v2.ok && v2.item.triggers.join(",") === "boss arena,arena,throne room"; })());
ok("DEFINITION_DOC tells the model about triggers[] (optional, ranking only)", /triggers\[\] \(optional: words \/ short phrases that say WHEN to use it - used for ranking\)/.test(PS.DEFINITION_DOC));

console.log(`\n${fail ? "FAIL" : "OK"}    test-skill-intel: ${pass} passed, ${fail} failed`);
