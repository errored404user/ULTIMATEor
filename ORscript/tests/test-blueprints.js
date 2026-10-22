#!/usr/bin/env node
// Static + build checks for the System Blueprints pack (1.31.0):
// src/core/skills/blueprints_lib_a.js + blueprints_lib_b.js (the Luau library) and
// src/core/skills/studio_blueprints.js (the blueprint_* commands). Registration, bundles,
// catalogue shape, every blueprint's contract (Config / Service with Start + SelfTest /
// optional client), generated Luau shape, dependency ordering, prompt / help / mode wiring
// and the version pins. Runtime behaviour (install -> verify -> boot -> play -> remove) is
// covered by tests/blueprints-sim.py (lupa).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    failed++;
    console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 400) : ""));
  }
}

// ── bundles ───────────────────────────────────────────────────────────────────
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
const LIBS = ["src/core/skills/blueprints_lib_a.js", "src/core/skills/blueprints_lib_b.js", "src/core/skills/studio_blueprints.js"];
ok("every main.js bundle loads lib_a, lib_b, studio_blueprints.js after studio_gfx.js and before main.js", bundles.length >= 10 && bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_gfx.js");
  return i >= 0 && b.js[i + 1] === LIBS[0] && b.js[i + 2] === LIBS[1] && b.js[i + 3] === LIBS[2] && b.js.indexOf("src/core/main.js") > i + 3;
}));
ok("codecraft.html loads the three files in order after studio_gfx.js", (() => {
  const h = fs.readFileSync("codecraft.html", "utf8");
  const idx = LIBS.map((f) => h.indexOf(f));
  return idx[0] > h.indexOf("studio_gfx.js") && idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < h.indexOf("src/core/main.js");
})());
for (const f of LIBS) ok(f + " exists and is valid JS", fs.existsSync(f) && (() => { try { new vm.Script(fs.readFileSync(f, "utf8")); return true; } catch (e) { return false; } })());

const files = bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = vm.runInThisContext("typeof RobloxScriptSkills !== 'undefined' ? RobloxScriptSkills : undefined");
const LIB = global.__ORBlueprintLib;
ok("window.__ORBlueprintLib exposes Core sources + 12 blueprints at 1.31.0", LIB && LIB.VERSION === "1.31.0" && typeof LIB.CORE_SRC === "string" && typeof LIB.CORE_SERVER_SRC === "string" && typeof LIB.CORE_CLIENT_SRC === "string" && Object.keys(LIB.BLUEPRINTS).length === 12);
ok("RobloxScriptSkills exposes the blueprint tables", S && Array.isArray(S.BLUEPRINT_COMMANDS) && Array.isArray(S.BLUEPRINT_NAMES) && Array.isArray(S.BLUEPRINT_CATALOG) && S.BLUEPRINT_VERSION === "1.31.0" && typeof S.blueprintOrder === "function");

const EXPECTED = ["blueprint_list", "blueprint_install", "blueprint_configure", "blueprint_verify", "blueprint_remove", "blueprint_status"];
const NAMES = ["currency", "shop", "pets", "combat", "rounds", "checkpoints", "quests", "tycoon", "leaderboards", "admin", "anticheat", "sprint"];
ok("6 blueprint commands", S.BLUEPRINT_COMMANDS.length === 6 && EXPECTED.every((n) => S.BLUEPRINT_COMMANDS.includes(n)), S.BLUEPRINT_COMMANDS.join(","));
ok("12 blueprints by name", S.BLUEPRINT_NAMES.length === 12 && NAMES.every((n) => S.BLUEPRINT_NAMES.includes(n)), S.BLUEPRINT_NAMES.join(","));
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
ok("commands registered in SKILL_COMMANDS with descriptions + params", EXPECTED.every((n) => byName.has(n) && byName.get(n).description.length > 80 && byName.get(n).params && typeof byName.get(n).params === "object"));
ok("SKILL_OPS contains the blueprint ops; design + gfx packs still registered", EXPECTED.every((n) => S.SKILL_OPS.includes(n)) && S.SKILL_OPS.includes("ui_screen_generate") && S.SKILL_OPS.includes("gfx_capture"));
ok("no duplicate command names after registration", new Set(S.SKILL_COMMANDS.map((c) => c.name)).size === S.SKILL_COMMANDS.length);
const isReq = (p) => p && (p.req === true || p.required === true);
ok("required params flagged (install.name, configure.name, remove.name); list/status/verify fully optional", isReq(byName.get("blueprint_install").params.name) && isReq(byName.get("blueprint_configure").params.name) && isReq(byName.get("blueprint_remove").params.name) && !Object.values(byName.get("blueprint_list").params).some(isReq) && !Object.values(byName.get("blueprint_verify").params).some(isReq) && Object.keys(byName.get("blueprint_status").params).length === 0);
ok("schemas enumerate every blueprint name", NAMES.every((n) => String(byName.get("blueprint_install").params.name.desc).includes(n) && String(byName.get("blueprint_configure").params.name.desc).includes(n)));

// ── library contract ──────────────────────────────────────────────────────────
const BP = LIB.BLUEPRINTS;
ok("every blueprint has system/title/summary/tags/depends/bus/api/remotes/config/service", NAMES.every((k) => {
  const b = BP[k];
  return b && /^[A-Z][A-Za-z]+$/.test(b.system) && b.title && b.summary.length > 60 && Array.isArray(b.tags) && Array.isArray(b.depends) && b.bus && Array.isArray(b.bus.fires) && Array.isArray(b.bus.listens) && Array.isArray(b.api) && b.api.length >= 3 && Array.isArray(b.remotes) && b.config && typeof b.config === "object" && typeof b.service === "string" && b.service.length > 1500 && (b.client === null || typeof b.client === "string");
}));
ok("every Service returns a table with Start() and SelfTest() and requires Core + its Config", NAMES.every((k) => {
  const src = BP[k].service;
  const sys = BP[k].system;
  return src.includes("function " + sys + ".Start()") && src.includes("function " + sys + ".SelfTest()") && src.includes("return " + sys + "\n") && src.includes('require(ReplicatedStorage:WaitForChild("OR_Systems"):WaitForChild("Core"))') && src.includes("require(ReplicatedStorage.OR_Systems." + sys + ".Config)");
}));
ok("Start() is idempotent (started guard) in every Service", NAMES.every((k) => /local started = false/.test(BP[k].service) && /if started then return/.test(BP[k].service)));
ok("SelfTest() returns {name, ok} checks everywhere", NAMES.every((k) => /checks\[#checks \+ 1\] = \{ name = name, ok = cond and true or false \}/.test(BP[k].service)));
ok("dependencies reference existing blueprints and form a DAG", NAMES.every((k) => BP[k].depends.every((d) => BP[d])) && S.blueprintOrder("all").order.length === 12 && S.blueprintOrder("tycoon").order.join(",") === "currency,tycoon" && S.blueprintOrder("shop").order.join(",") === "currency,shop" && S.blueprintOrder("pets", false).order.join(",") === "pets");
ok("shop / pets / tycoon depend on currency; the rest are standalone", BP.shop.depends.includes("currency") && BP.pets.depends.includes("currency") && BP.tycoon.depends.includes("currency") && ["combat", "rounds", "checkpoints", "quests", "leaderboards", "admin", "anticheat", "sprint", "currency"].every((k) => BP[k].depends.length === 0));
ok("Bus topics line up (every listened topic is fired by some blueprint or Core)", (() => {
  const fired = new Set(["Data.Loaded", "Data.Released", "Currency.Request", "Currency.Earned"]);
  for (const k of NAMES) for (const t of BP[k].bus.fires) fired.add(t);
  const missing = [];
  for (const k of NAMES) for (const t of BP[k].bus.listens) if (!fired.has(t)) missing.push(k + ":" + t);
  return missing.length === 0 || missing.join(",");
})() === true);
ok("Core source: Signal, Bus, Remote, Util, Leaderstats, Data (session lock, autosave, BindToClose), Products (ProcessReceipt), Notify, Use, Installed", ["Signal.new", "Core.Bus.On", "Core.Bus.Fire", "function Core.Remote(", "Core.Util.WeightedPick", "Core.Leaderstats.Set", "UpdateAsync", "__lock", "BindToClose", "function Core.Data.Start()", "Core.Products.Register", "ProcessReceipt", "function Core.Notify(", "function Core.Use(", "function Core.Installed()", 'Core.Version = "1.31.0"'].every((k) => LIB.CORE_SRC.includes(k)));
ok("CoreServer boots Data then every Service in a pcall; CoreClient routes OR_Notify to the design toast feed or SetCore", LIB.CORE_SERVER_SRC.includes("Core.Data.Start()") && LIB.CORE_SERVER_SRC.includes("Core.Use(sys.Name)") && LIB.CORE_SERVER_SRC.includes("pcall") && LIB.CORE_CLIENT_SRC.includes("OR_Notify") && LIB.CORE_CLIENT_SRC.includes("NotifyLocal") && LIB.CORE_CLIENT_SRC.includes("SendNotification"));
const allLua = [LIB.CORE_SRC, LIB.CORE_SERVER_SRC, LIB.CORE_CLIENT_SRC].concat(NAMES.map((k) => BP[k].service), NAMES.map((k) => BP[k].client || ""), [BP.combat.toolClient || ""]);
ok("library Luau is free of JS interpolation, backticks, 'continue' and compound assignment (Lua 5.4 parser safe)", allLua.every((src) => !/\$\{/.test(src) && !/`/.test(src) && !/\bcontinue\b/.test(src) && !/[+\-*/]=\s/.test(src.replace(/==/g, "").replace(/~=/g, "").replace(/<=/g, "").replace(/>=/g, ""))));
ok("server authority: no Service trusts the client for money/damage (remotes validated server-side)", BP.currency.service.includes("OnServerInvoke") && !BP.currency.service.includes("OnServerEvent:Connect(function(player, name, amount") && BP.combat.service.includes("the server decides what was hit") && BP.shop.service.includes("All validation server-side"));
ok("combat ships a weapon Tool client; sprint / rounds / pets ship clients; currency / shop / admin / anticheat are server-only", typeof BP.combat.toolClient === "string" && BP.combat.toolClient.includes("FireServer") && [BP.sprint.client, BP.rounds.client, BP.pets.client].every((c) => typeof c === "string") && [BP.currency.client, BP.shop.client, BP.admin.client, BP.anticheat.client].every((c) => c === null));
ok("never persist 'wired' flags as attributes on GUI (weak tables / locals instead)", !allLua.some((src) => /SetAttribute\(["']OR_Wired/.test(src)));
ok("configs are JSON-safe (no functions, no undefined)", NAMES.every((k) => { const j = JSON.stringify(BP[k].config); return j && !/undefined/.test(j) && JSON.parse(j); }));
ok("anticheat reads OR_MaxSpeed published by sprint; checkpoints exposes a skip product; shop uses the shared receipt dispatcher", BP.anticheat.service.includes('GetAttribute("OR_MaxSpeed")') && BP.sprint.service.includes('SetAttribute("OR_MaxSpeed"') && BP.checkpoints.service.includes("SkipProductId") && BP.checkpoints.service.includes("Core.Products.Register") && BP.shop.service.includes("Core.Products.Register"));

// ── generated Luau shape ──────────────────────────────────────────────────────
const build = (op, args) => S.buildLuau(op, args);
const luaOk = (r) => r && !r.err && typeof r.code === "string";
const list = build("blueprint_list", {});
ok("blueprint_list builds: catalogue JSON + installed scan, no Core sources embedded", luaOk(list) && list.code.includes("installedSystems()") && list.code.includes('"currency"') && list.code.includes("local CORE_SRC,CORE_SERVER_SRC,CORE_CLIENT_SRC='','',''") && !list.code.includes("function Core.Data.Start()"));
const inst = build("blueprint_install", { name: "pets", config: { MaxPets: 10 } });
ok("blueprint_install pets embeds Core + currency + pets sources, in dependency order, then verifies", luaOk(inst) && inst.code.indexOf("local CORE_SRC='") < inst.code.indexOf("local HttpService") && inst.code.includes("ensureCore(opts.force,report)") && inst.code.indexOf("installSystem('currency'") < inst.code.indexOf("installSystem('pets'") && inst.code.includes("verifySystem") && inst.code.includes("MaxPets") && inst.code.includes("report.next_steps"));
ok("install programs write the documented layout + attributes", ["rsRoot()", "sssRoot()", "spsRoot()", "'OR_Blueprint'", "'OR_BlueprintVersion'", "'OR_Depends'", "'OR_ConfigJSON'", "writeConfig(", "'Remotes'", "'OR_Tools'", "ChangeHistoryService"].every((k) => inst.code.includes(k)));
ok("install all orders dependencies first and includes demo builders + tools", (() => { const r = build("blueprint_install", { name: "all" }); return luaOk(r) && r.code.indexOf("installSystem('currency'") < r.code.indexOf("installSystem('shop'") && ["DEMO.checkpoints", "DEMO.tycoon", "DEMO.leaderboards", "DEMO.rounds", "TOOLS.combat", "TOOLS.shop"].every((k) => r.code.includes(k)); })());
ok("install rejects unknown names / missing name at build time", /unknown blueprint\(s\): spaceships/.test(build("blueprint_install", { name: "spaceships" }).err || "") && /name is required/.test(build("blueprint_install", {}).err || ""));
ok("install_dependencies:false warns instead of installing the dependency", (() => { const r = build("blueprint_install", { name: "shop", install_dependencies: false }); return luaOk(r) && !r.code.includes("installSystem('currency'") && r.code.includes("shop depends on currency"); })());
ok("per-system config when installing several", (() => { const r = build("blueprint_install", { name: ["tycoon", "admin"], config: { tycoon: { Plots: 2 }, admin: { Prefix: "!" } } }); return luaOk(r) && /installSystem\('tycoon'[\s\S]*?"Plots":2/.test(r.code) && /installSystem\('admin'[\s\S]*?"Prefix":"!"/.test(r.code); })());
const conf = build("blueprint_configure", { name: "pets", config: { MaxPets: 5 } });
ok("blueprint_configure merges + rewrites Config + re-verifies; needs config or reset", luaOk(conf) && conf.code.includes("deepMerge(deepMerge(deepCopy(defaults),existing),over)") && conf.code.includes("writeConfig(sys,sys.Name,cfg)") && conf.code.includes("pcall(verifySystem,'pets')") && /config object is required/.test(build("blueprint_configure", { name: "pets" }).err || "") && luaOk(build("blueprint_configure", { name: "pets", reset: true })));
ok("blueprint_verify: all installed by default, specific names on request, freshRequire + SelfTest", (() => { const a = build("blueprint_verify", {}); const b = build("blueprint_verify", { name: "combat" }); return luaOk(a) && a.code.includes("installedSystems()") && luaOk(b) && b.code.includes('["combat"]') && a.code.includes("freshRequire") && a.code.includes("SelfTest"); })());
ok("blueprint_remove: folders + tools + demo, dependency warnings, Core when empty, never player data", (() => { const r = build("blueprint_remove", { name: "pets" }); return luaOk(r) && ["depends on", "OR_Tools", "OR_BlueprintDemo", "core_removed", "never deleted"].every((k) => r.code.includes(k)) && /name is required/.test(build("blueprint_remove", {}).err || ""); })());
ok("blueprint_status builds and lists the not-installed catalogue", (() => { const r = build("blueprint_status", {}); return luaOk(r) && r.code.includes("statusReport()") && r.code.includes("not_installed"); })());
ok("every blueprint program wraps the body in pcall and reports failures as JSON", EXPECTED.every((n) => { const r = build(n, { name: "pets", config: { a: 1 } }); return luaOk(r) && r.code.includes("local okRun,resRun=pcall(function()") && r.code.includes("return fail("); }));
ok("every blueprint program is free of Luau-only syntax and JS interpolation", EXPECTED.every((n) => { const r = build(n, { name: "pets", config: { a: 1 } }); return luaOk(r) && !/\$\{/.test(r.code) && !/`/.test(r.code) && !/\bcontinue\b/.test(r.code); }));
ok("Config serialiser in Luau: %q strings, sorted keys, arrays, identifiers vs [\"keys\"]", inst.code.includes("string.format('%q',v)") && inst.code.includes("table.sort(keys") && inst.code.includes("isIdent(k)") && inst.code.includes("KEYWORDS"));
ok("non-blueprint ops fall through to the previous builders (gfx + design + base)", luaOk(build("gfx_brief", {})) && luaOk(build("ui_audit", { path: "StarterGui" })) && luaOk(build("lighting_inspect", {})));

// ── prompt / help / mode wiring ───────────────────────────────────────────────
const mainSrc = fs.readFileSync("src/core/main.js", "utf8");
const configSrc = fs.readFileSync("src/core/config.js", "utf8");
ok("creation work mode focuses blueprint_* commands", /focus:\s*\/\^\(script_\|model_\|memory_\|blueprint_\|/.test(mainSrc));
ok("feature help has a 'blueprints' topic with the catalogue + workflow + alias triggers", /blueprints:\{title:"System Blueprints/.test(mainSrc) && mainSrc.includes("blueprint_install {name:\\\"pets\\\"}") && /blueprints:\/blueprint\|complete system/.test(mainSrc));
ok("mandates teach the blueprint workflow (install -> configure -> extend -> UI -> verify) in both budgets", configSrc.includes("SYSTEM BLUEPRINTS (1.31 BUILD pack") && configSrc.includes("SYSTEMS: a complete game system") && ["blueprint_list", "blueprint_install", "blueprint_configure", "blueprint_verify", "blueprint_status", "blueprint_remove"].every((k) => configSrc.includes(k)));
ok("luau-parse-check covers the blueprint programs and the library sources", (() => { const t = fs.readFileSync("tests/luau-parse-check.py", "utf8"); return t.includes("BLUEPRINT_COMMANDS") && t.includes("__ORBlueprintLib") && t.includes("blueprint lib"); })());
const readme = fs.readFileSync("README.md", "utf8");
ok("README documents the blueprints pack", readme.includes("blueprint_install") && readme.includes("1.31.0") && readme.includes("blueprints-sim.py"));
ok("manifest version is 1.67.0", manifest.version === "1.67.0", manifest.version);
ok("plugin / crate pinned at 1.67.0", /1\.67\.0/.test(fs.readFileSync("plugin/ORscript.lua", "utf8")) && /^version = "1\.67\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")));

// ── simulator ─────────────────────────────────────────────────────────────────
const sim = fs.readFileSync("tests/roblox_sim.py", "utf8");
ok("tests/roblox_sim.py models the runtime APIs the systems use (ordered stores, receipts, Touched/Died/Chatted, setfenv, Random, OverlapParams)", ["GetOrderedDataStore", "GetPlayerFromCharacter", "BindToClose", "Died=1", "Touched=1", "Chatted=1", "debug.setupvalue", "_G.Random", "_G.OverlapParams", "GetPartBoundsInBox", "SpawnLocation", "StarterPlayerScripts"].every((k) => sim.includes(k)));
ok("blueprints-sim.py exists and boots CoreServer against the model", (() => { const t = fs.readFileSync("tests/blueprints-sim.py", "utf8"); return t.includes("from roblox_sim import make_runtime") && t.includes("CoreServer") && t.includes("blueprint_remove"); })());

console.log("\n" + (failed ? failed + " check(s) failed" : "all blueprint pack checks passed"));
process.exit(failed ? 1 : 0);
