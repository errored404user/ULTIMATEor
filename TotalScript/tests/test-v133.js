// 1.33.0: embedded command catalogue, real inspect/query pack (hidden legacy
// aliases), runtime-dead command fixes, typography-tolerant parser + path
// cleaning (run: node tests/test-v133.js).
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
assert(bundles.length >= 9, "main bundles present");
for (const b of bundles) {
  assert(b.js.includes("src/core/skills/studio_inspect.js"), "studio_inspect.js missing from a bundle: " + b.matches.join(","));
  assert(!b.js.includes("src/core/skills/studio_extra100.js"), "the 100-filler pack must be gone from " + b.matches.join(","));
  assert(b.js.indexOf("src/core/skills/studio_inspect.js") > b.js.indexOf("src/core/skills/studio_100.js"), "studio_inspect.js loads after studio_100.js (it hides that pack's duplicates)");
}
assert(!fs.existsSync("src/core/skills/studio_extra100.js"), "studio_extra100.js deleted");
const codecraft = fs.readFileSync("codecraft.html", "utf8");
assert(codecraft.includes("src/core/skills/studio_inspect.js") && !codecraft.includes("studio_extra100"), "codecraft.html loads the new pack");

const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;

// ── Inspect pack ──────────────────────────────────────────────────────────
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
assert(byName.has("inspect_service") && !byName.get("inspect_service").hidden, "inspect_service is a visible command");
assert(byName.has("query_instances") && !byName.get("query_instances").hidden, "query_instances is a visible command");
assert(byName.get("inspect_service").params.service.req === true, "inspect_service requires service");
const hidden = S.hiddenCommandNames();
assert(hidden.size >= 108, "legacy aliases + duplicate setters are hidden (" + hidden.size + ")");
for (const n of ["inspect_workspace", "query_scripts", "query_unanchored_parts", "query_lighting_settings", "spawn_location", "click_detector", "billboard", "web_api", "can_touch_set"]) {
  assert(hidden.has(n), n + " is hidden");
  assert(S.SKILL_OPS.includes(n), n + " stays callable (SKILL_OPS)");
}
for (const n of ["size_set", "color_set", "walkspeed_set", "anchored_set", "api_request", "set_property", "collision_set", "humanoid_health_set"]) assert(!hidden.has(n), n + " stays visible");
const visible = S.SKILL_COMMANDS.filter((c) => !c.hidden).length;
assert(visible < 700 && visible > 550, "visible Studio commands trimmed to ~" + visible); // 1.87.0: -93 (the x100 pack's fake-success stubs are hidden NOT_IMPLEMENTED names now - tests/test-not-implemented.js); 1.82.0: +15 VFX / SFX / sequence commands; 1.77.0: +8 real cutscene commands (the stub became 9 commands, one hidden alias); 1.78.0: +7 art-direction commands (2 more hidden)
const described = S.describeCommands();
assert(!described.some((l) => /^inspect_workspace:/.test(l)), "describeCommands hides legacy aliases by default");
assert(described.some((l) => /^inspect_service:/.test(l)) && described.some((l) => /^query_instances:/.test(l)), "describeCommands lists the new commands");
assert(S.describeCommands({ includeHidden: true }).some((l) => /^inspect_workspace:/.test(l)), "includeHidden exposes legacy aliases for exact lookups");

// Legacy aliases delegate to the new builders with preset args.
const legacy = S.buildLuau("query_scripts_in_server", {}).code;
assert(legacy.includes('"mode":"query"') && legacy.includes('"class":"Script,ModuleScript"') && legacy.includes('"root":"ServerScriptService"'), "query_scripts_in_server → query_instances preset");
const insp = S.buildLuau("inspect_lighting", { target: "Workspace.House" }).code;
assert(insp.includes('"mode":"inspect"') && insp.includes('"service":"Workspace.House"'), "legacy target overrides the service");
assert(S.buildLuau("query_instances", { name: "]==]x" }).code.includes("] == ]x"), "long-bracket payload cannot close early");
assert(/local function resolve\(/.test(insp) && /local function ok\(/.test(insp) && /local function fail\(/.test(insp), "inspect programs carry their own prelude");
assert(!/\bcontinue\b|\+=/.test(S.buildLuau("query_instances", { kind: "counts" }).code), "inspect Luau avoids Lua-5.4-incompatible syntax");

// ── Runtime-dead packs fixed ──────────────────────────────────────────────
assert(typeof S.X200_HEAD === "string" && S.X200_HEAD.includes("local function partOf"), "studio_200 exports its prelude");
const x100 = S.buildLuau("weapon_hitbox_create", { part: "Workspace.Sword" }).code;
assert(x100.startsWith(S.X200_HEAD), "studio_100 programs are prefixed with the x200 prelude (they call resolve/ok/fail/partOf)");
assert(!/game:GetService\('OrderedDataStoreService'\)|game:GetService\('SessionLockStoreService'\)/.test(S.X200_HEAD), "prelude no longer fetches non-existent services");
assert(S.X200_HEAD.includes("optService('NavigationService')"), "optional services are pcall-guarded");
for (const n of ["exposure_set", "film_grain", "film_contrast", "film_motion_blur"]) assert(!S.buildLuau(n, {}).code.includes("Instance.new('Film')"), n + " no longer creates the non-existent Film class");
const bind = S.buildLuau("input_bind", { key: "F", action: "Dash" }).code;
assert(bind.includes("mkScript('LocalScript','Total_Bind_Dash',sps,src)") && bind.includes("[==[") && bind.includes("Dash_Fired"), "input_bind writes a LocalScript via a long-bracket source + creates the remote");
const cap = S.buildLuau("capture_id", { path: "Workspace.Hat" }).code;
assert(cap.includes('local p="Workspace.Hat"') && !cap.includes("a.path or a.target"), "capture_id no longer references the JS-side args from Lua");
const api = S.buildLuau("api_request", { url: "https://x.y/z", headers: { "X-Key": "1" } }).code;
assert(api.includes("'Web API request failed: ' .. tostring(res)") && api.includes("X-Key"), "api_request concatenates with .. and honours headers");
const rep = S.buildLuau("instance_reparent", { path: "Workspace.A", parent: "Workspace.A.B" }).code;
assert(rep.includes("par:IsDescendantOf(inst)"), "instance_reparent refuses to parent into its own descendant");
const x200 = fs.readFileSync("src/core/skills/studio_200.js", "utf8");
assert(!/' \+ tostring\(/.test(x200), "no Lua string concatenation written with + in studio_200");

// ── main.js / config.js wiring ────────────────────────────────────────────
const main = fs.readFileSync("src/core/main.js", "utf8");
const config = fs.readFileSync("src/core/config.js", "utf8");
assert(main.includes("hidden:!!t.hidden"), "ensureTools carries the hidden flag");
assert(main.includes("(!t.hidden || String(t.name || \"\").toLowerCase() === commandQuery)"), "list_commands lists hidden tools only on exact query");
assert(main.includes("RobloxScriptSkills.describeCommands({ includeHidden: !!commandQuery })"), "list_commands includes hidden skill lines only when querying");
assert(config.includes(".filter((t) => t && !t.hidden)"), "compactTools (reminder) skips hidden tools");
assert(main.includes("function embeddedCatalogue(engine)"), "embedded catalogue builder exists");
assert(main.includes("const EMBED_CATALOGUE_DEFAULT_CHARS = 20000;"), "embedded catalogue default budget");
assert(main.includes("if (P.compactCommandList || P.embedCatalogue === false) return \"\";"), "compact providers keep the forced bootstrap catalogue");
assert(main.includes("systemPrompt({ embedCatalogue: false })"), "system-prompt resends do not repeat the catalogue");
assert(main.includes("heading: \"━━━ COMMAND CATALOGUE (embedded; this IS the list_commands result"), "catalogue heading");
assert(main.includes("Math.max(12000, Number(P.commandListMaxChars) || 32000)"), "non-compact list_commands budget lowered to 32k");
assert(main.includes("const REMIND_TOOLS_EVERY = P.compactCommandList ? 50 : 25;"), "reminder cadence relaxed");
assert(config.includes("const REMINDER_MAX_CHARS = 9000;"), "reminder budget lowered");
assert(main.includes('"workspace_stats", "inspect_service", "query_instances",'), "new inspect commands are universal");
assert(config.includes("inspect_service {service, depth?, limit?}"), "mandates cite inspect_service");

// config.js behaviour
vm.runInThisContext(fs.readFileSync("src/core/config.js", "utf8") + "\n;globalThis.__RS=RS;", { filename: "config.js" });
const RSX = globalThis.__RS;
const cat = "━━━ COMMAND CATALOGUE (embedded; this IS the list_commands result - do NOT call list_commands {} to fetch it again) ━━━\nroblox commands - 5 total.\nUNIVERSAL — a {x}  ·  b {y?}";
const withCat = RSX.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox", catalogue: cat });
const noCat = RSX.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
assert(withCat.includes("COMMAND CATALOGUE (embedded") && withCat.trim().endsWith("━━━ END COMMAND CATALOGUE ━━━"), "catalogue appended to the full prompt");
assert(withCat.includes("The COMMAND CATALOGUE at the end of this message IS the list_commands result"), "embedded first-action text");
assert(!withCat.includes("Your very first action is to write \\`list_commands\\`") && !withCat.includes("Your very first action is to write `list_commands`"), "list-first instruction removed when embedded");
assert(noCat.includes("Your very first action is to write `list_commands`"), "list-first instruction kept without a catalogue");
assert(!noCat.includes("COMMAND CATALOGUE"), "no catalogue block without a catalogue");
// Tight budget (ChatGPT 14k): compact core + catalogue (catalogue exempt from maxChars).
const tight = RSX.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000, catalogue: cat });
assert(tight.includes("The COMMAND CATALOGUE at the END of this message IS the list_commands result") && tight.trim().endsWith("━━━ END COMMAND CATALOGUE ━━━"), "compact core embeds the catalogue too");
assert(!tight.includes("Your FIRST action: list_commands {}"), "compact core drops list-first when embedded");
const tightNo = RSX.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
assert(tightNo.includes("Your FIRST action: list_commands {}") && !tightNo.includes("COMMAND CATALOGUE"), "compact core unchanged without a catalogue");
const local = RSX.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "local", catalogue: cat });
assert(local.includes("COMMAND CATALOGUE at the end of this message IS the list_commands result") && local.trim().endsWith("━━━ END COMMAND CATALOGUE ━━━"), "AgentScript prompt embeds the catalogue");
assert(RSX.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "local" }).includes("Your very first action is to write `list_commands`"), "AgentScript prompt keeps list-first without a catalogue");
// Notion keeps its own preferences flow.
assert(RSX.buildSystemPrompt({ siteName: "Notion", providerId: "notion", engine: "roblox", catalogue: cat }).includes("list_commands"), "Notion preferences untouched");
// Reminder skips hidden tools.
const rem = RSX.compactTools([{ name: "a", inputSchema: {} }, { name: "zz_hidden", hidden: true, inputSchema: {} }], 4000);
assert(rem.includes("a {}") && !rem.includes("zz_hidden"), "reminder omits hidden tools");

// ── Parser typography + bridge path cleaning ──────────────────────────────
const RSParse = vm.runInThisContext(fs.readFileSync("src/core/parser.js", "utf8") + "\n;RSParse", { filename: "parser.js" });
assert(typeof RSParse.normalizeTypography === "function", "normalizeTypography exported");
assert(RSParse.normalizeTypography("\u201Cget_children\u201D\u00A0{\u200B\u201Cpath\u201D: \u201Cgame.Workspace\u201D}") === '"get_children" {"path": "game.Workspace"}', "curly double quotes, NBSP and zero-width chars normalised");
assert(RSParse.normalizeTypography("print('don\u2019t')") === "print('don\u2019t')", "apostrophes (single curly quotes) are left alone");
const curly = RSParse.parseToolCalls("```json\n{\u201Ccommand\u201D: \u201Cget_children\u201D, \u201Cparams\u201D: {\u201Cpath\u201D: \u201Cgame.Workspace\u201D}}\n```");
assert(Array.isArray(curly) && curly.length === 1 && curly[0].tool === "get_children" && curly[0].arguments.path === "game.Workspace", "curly-quoted JSON command parses");
const lua = RSParse.parseToolCalls("###LUA###\nprint(\u201Chi\u201D)\n###END_LUA###");
assert(Array.isArray(lua) && lua.length === 1 && /print\("hi"\)/.test(lua[0].arguments.code), "curly quotes inside LUA blocks become straight quotes");

const bridgeSrc = fs.readFileSync("src/core/studio_bridge.js", "utf8");
assert(bridgeSrc.includes("function cleanPath("), "cleanPath exists");
const cleanPath = vm.runInThisContext("(" + bridgeSrc.slice(bridgeSrc.indexOf("function cleanPath("), bridgeSrc.indexOf("\n  }\n", bridgeSrc.indexOf("function cleanPath(")) + 4) + ")", { filename: "cleanPath.js" });
assert(cleanPath("`game.Workspace.House`") === "game.Workspace.House", "backticks stripped");
assert(cleanPath("\u201Cgame.Workspace\u201D.") === "game.Workspace", "curly quotes + trailing dot stripped (both orders)");
assert(cleanPath('game:GetService("Workspace").House') === "Workspace.House", "GetService form normalised");
assert(cleanPath("Workspace > House") === "Workspace.House", "arrow separators normalised");
assert(cleanPath("game\\Workspace\u00A0.. House") === "game.Workspace.House", "backslash, NBSP and doubled dots normalised");

console.log("OK   test-v133: inspect pack, runtime fixes, embedded catalogue, typography (" + visible + " visible Studio commands, " + hidden.size + " hidden)");
