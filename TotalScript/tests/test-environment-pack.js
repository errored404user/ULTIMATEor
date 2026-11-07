// 2.2.4 — ENVIRONMENT PACK: terrain_generate / terrain_shape / terrain_path /
// terrain_water / terrain_paint_biome / terrain_info / environment_scatter /
// road_build / map_generate (src/core/skills/studio_environment.js).
// Static half: registration, schemas, JS-side validation, builder shape (lib +
// body for the Luau library cache), contract compatibility, wiring into the
// manifest / prompts / hints / families, and the honest-output rules. The Luau
// itself runs in tests/environment-sim.py (lupa + roblox_sim voxel Terrain).
// Run: node tests/test-environment-pack.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 500) : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/command_contract.js") + ";globalThis.__CC=TotalCommandContract;", { filename: "command_contract.js" });
const S = RobloxScriptSkills;
const CC = globalThis.__CC;
const NAMES = ["terrain_generate", "terrain_shape", "terrain_path", "terrain_water", "terrain_paint_biome", "terrain_info", "environment_scatter", "road_build", "map_generate"];
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));

// ── A. registration ───────────────────────────────────────────────────────────
ok("A1 pack exports ENVIRONMENT_COMMANDS (9 names, in order) + VERSION 2.10.0 + LIB + ENUMS + validateEnvironment", JSON.stringify(S.ENVIRONMENT_COMMANDS) === JSON.stringify(NAMES) && S.ENVIRONMENT_VERSION === "2.10.0" && typeof S.ENVIRONMENT_LIB === "string" && S.ENVIRONMENT_ENUMS && typeof S.validateEnvironment === "function", { cmds: S.ENVIRONMENT_COMMANDS, v: S.ENVIRONMENT_VERSION });
ok("A2 all nine are registered ONCE in SKILL_COMMANDS, visible, with description + params", NAMES.every((n) => byName.has(n) && !byName.get(n).hidden && byName.get(n).description.length > 60 && byName.get(n).params && Object.keys(byName.get(n).params).length >= 3) && S.SKILL_COMMANDS.filter((c) => NAMES.includes(c.name)).length === 9);
ok("A3 SKILL_COMMANDS was spliced, not reassigned (other packs' references stay valid) and SKILL_OPS lists the new names", /const arr = RobloxScriptSkills\.SKILL_COMMANDS;[\s\S]*?for \(const c of C\) arr\.push\(c\);/.test(read("src/core/skills/studio_environment.js")) && !/RobloxScriptSkills\.SKILL_COMMANDS\s*=/.test(read("src/core/skills/studio_environment.js")) && (!S.SKILL_OPS || NAMES.every((n) => S.SKILL_OPS.includes(n))));
ok("A4 no name collides with an earlier pack or a NOT_IMPLEMENTED stub (road_path_build / tree_forest_scatter stay the hidden stubs that now point here)", byName.get("road_path_build") && byName.get("road_path_build").hidden && byName.get("tree_forest_scatter") && byName.get("tree_forest_scatter").hidden && !NAMES.includes("road_path_build"));
ok("A5 every command declares required params correctly (points for terrain_path / road_build, op for terrain_shape; the rest optional with defaults)", byName.get("terrain_path").params.points.req === true && byName.get("road_build").params.points.req === true && byName.get("terrain_shape").params.op.req === true && !Object.values(byName.get("terrain_generate").params).some((p) => p.req) && !Object.values(byName.get("map_generate").params).some((p) => p.req));
ok("A6 enums exported for the prompts / tests: 12 biomes, 12 shape ops, 6 path kinds, 10 palettes, 15 prop kinds, 12 map presets, 3 water kinds", S.ENVIRONMENT_ENUMS.BIOMES.length === 12 && S.ENVIRONMENT_ENUMS.SHAPE_OPS.length === 12 && S.ENVIRONMENT_ENUMS.PATH_KINDS.length === 6 && S.ENVIRONMENT_ENUMS.PALETTES.length === 10 && S.ENVIRONMENT_ENUMS.PROP_KINDS.length === 15 && S.ENVIRONMENT_ENUMS.MAP_PRESETS.length === 12 && S.ENVIRONMENT_ENUMS.WATER_KINDS.length === 3, Object.fromEntries(Object.entries(S.ENVIRONMENT_ENUMS).map(([k, v]) => [k, v.length])));

// ── B. builder shape (library cache) ──────────────────────────────────────────
const b = S.buildLuau("terrain_generate", { biome: "island", size: 256, seed: 7 });
ok("B1 builder returns { code, lib, body } with code === lib + '\\n' + body (runSkillLuau's cache contract)", b && !b.err && b.code === b.lib + "\n" + b.body && b.lib === S.ENVIRONMENT_LIB);
ok("B2 library is > 4000 chars and the program > 18000, body small: the lib uploads ONCE per place and each call ships only the body", b.lib.length > 4000 && b.code.length > 18000 && b.body.length < 600, { lib: b.lib.length, code: b.code.length, body: b.body.length });
ok("B3 body = JSONDecode of the args in a [==[ ]==] long string + ENV.run(op) (no string concatenation of user values into Luau)", /HttpService:JSONDecode\(\[==\[\{"biome":"island","size":256,"seed":7\}\]==\]\)/.test(b.body) && /return ENV\.run\("terrain_generate", __a\)/.test(b.body));
ok("B4 args containing ']==]' are refused rather than breaking out of the long string", (() => { const r = S.buildLuau("environment_scatter", { name: "x]==]print(1)--" }); return r && r.err && /]==]/.test(r.err); })());
ok("B5 library is pure ASCII (StringValue byte length == char length, so the cache probe '#m.Value == bytes' holds)", !/[^\x00-\x7f]/.test(S.ENVIRONMENT_LIB));
ok("B6 library has no Luau-only syntax the plain-Lua parse check cannot see (+=, continue, //, backticks)", !/\+=|\bcontinue\b|[^/]\/\/[^/]|`/.test(S.ENVIRONMENT_LIB));
ok("B7 library keeps one namespace (local ENV = {}) and no globals (no bare assignments at top level)", /local ENV = \{\}/.test(S.ENVIRONMENT_LIB) && !/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=]/m.test(S.ENVIRONMENT_LIB.replace(/^\s*--.*$/gm, "").split("\n").filter((l) => /^[A-Za-z_]/.test(l) && !/^(local|function|return|end|if|for|while|repeat|until|else|elseif|do)\b/.test(l)).join("\n")));
ok("B8 every result goes through okj / failj → JSON {ok, data, text} or {ok:false, error} (dispatcher parses it)", /local function okj\(d, t\) return HttpService:JSONEncode\(\{ ok = true, data = d or \{\}, text = t or "" \}\)/.test(S.ENVIRONMENT_LIB) && /local function failj\(m\) return HttpService:JSONEncode\(\{ ok = false, error = tostring\(m\) \}\)/.test(S.ENVIRONMENT_LIB) && /function ENV\.run\(op, a\)/.test(S.ENVIRONMENT_LIB));
ok("B9 hard limits live in the Luau too (MAX_COLUMNS 512 per axis, MAX_VOXELS 9e6) and the writer yields on long runs (task.wait)", /ENV\.MAX_COLUMNS = 512/.test(S.ENVIRONMENT_LIB) && /ENV\.MAX_VOXELS = 9000000/.test(S.ENVIRONMENT_LIB) && /task\.wait\(\)/.test(S.ENVIRONMENT_LIB));
ok("B10 writer works in 32x32 column chunks with Region3:ExpandToGrid-compatible 4-stud snapping (no giant single WriteVoxels)", /local chunk = 32/.test(S.ENVIRONMENT_LIB) && /Terrain:WriteVoxels\(region, res, mats, occs\)/.test(S.ENVIRONMENT_LIB) && /local function snap\(v\)/.test(S.ENVIRONMENT_LIB));

// ── C. JS-side validation (fails BEFORE any Luau is sent) ─────────────────────
const err = (op, a) => { const r = S.buildLuau(op, a); return r && r.err ? r.err : null; };
ok("C1 unknown biome / op / kind / palette / preset are refused with the full list", /plains, hills/.test(err("terrain_generate", { biome: "moon" }) || "") && /mountain, hill/.test(err("terrain_shape", { op: "spike" }) || "") && /river, canal/.test(err("terrain_path", { kind: "tunnel", points: [[0, 0], [1, 1]] }) || "") && /temperate, desert/.test(err("terrain_paint_biome", { palette: "neon" }) || "") && /island_survival/.test(err("map_generate", { preset: "island_adventure" }) || ""));
ok("C2 terrain_shape without op fails naming the ops; terrain_path / road_build need >= 2 waypoints (<= 64)", /op is required/.test(err("terrain_shape", {}) || "") && /at least 2/.test(err("terrain_path", { points: [[0, 0]] }) || "") && /at least 2/.test(err("road_build", {}) || "") && /64/.test(err("road_build", { points: Array.from({ length: 65 }, (_, i) => [i, i]) }) || ""));
ok("C3 waypoints must be [x,z] or [x,y,z] numbers", /waypoint/.test(err("terrain_path", { points: [[0, 0], ["a", 1]] }) || "") && !err("terrain_path", { points: [[0, 0], [10, 5, 10]] }));
ok("C4 environment_scatter: unknown prop kind refused with the 15 built-ins; count 1-800; no kinds = pine default (Luau) and template accepted", /pine, oak/.test(err("environment_scatter", { kinds: ["spruce"] }) || "") && /800/.test(err("environment_scatter", { kinds: ["pine"], count: 5000 }) || "") && !err("environment_scatter", {}) && /list = \{ a\.kind or "pine" \}/.test(S.ENVIRONMENT_LIB) && !err("environment_scatter", { template: "Workspace.Tree", count: 5 }));
ok("C5 map_generate size is bounded 64-2048 and terrain_generate size is bounded per axis (2048)", /64/.test(err("map_generate", { size: 10 }) || "") && /2048/.test(err("map_generate", { size: 5000 }) || "") && /2048/.test(err("terrain_generate", { size: [3000, 100] }) || ""));
ok("C6 terrain_water: unknown kind refused; ocean / lake / pond accepted", /ocean/.test(err("terrain_water", { kind: "sea" }) || "") && !err("terrain_water", { kind: "ocean", level: 0 }) && !err("terrain_water", { kind: "pond" }));
ok("C7 valid calls for all nine commands build without error", NAMES.every((n) => !err(n, { op: "hill", points: [[0, 0], [20, 20]], kinds: ["pine"] })));

// ── D. command contract compatibility ────────────────────────────────────────
const prep = (n, a) => CC.prepare(n, a);
ok("D1 contract accepts a scalar size (256) and a [x,z] size without 'problems' (size declared as any, not a 3-vector)", prep("terrain_generate", { size: 256 }).ok && prep("terrain_generate", { size: [300, 200] }).ok && prep("terrain_generate", { size: 256 }).problems.length === 0);
ok("D2 contract keeps centre arrays, points arrays and object rules untouched", (() => { const r = prep("terrain_path", { kind: "river", points: [[0, 0], [10, 5, 10]], center: [1, 2, 3] }); return r.ok && JSON.stringify(r.args.points) === "[[0,0],[10,5,10]]"; })() && prep("terrain_paint_biome", { rules: { top: "Grass" } }).ok);
ok("D3 terrain material params validate against TerrainMaterial (Sand ok, Neon refused); road_build.material against Material (Asphalt ok)", prep("terrain_path", { points: [[0, 0], [1, 1]], material: "Sand" }).ok && !prep("terrain_path", { points: [[0, 0], [1, 1]], material: "Neon" }).ok && prep("road_build", { points: [[0, 0], [1, 1]], material: "Asphalt" }).ok);
ok("D4 road colour given as 0-1 floats is scaled to 0-255 by the contract (the Luau uses Color3.fromRGB)", (() => { const r = prep("road_build", { points: [[0, 0], [1, 1]], color: [0.2, 0.2, 0.2] }); return r.ok && r.args.color[0] === 51; })() && /Color3\.fromRGB\(num\(a\.color\[1\]/.test(S.ENVIRONMENT_LIB));
ok("D5 count is coerced to an integer; string numbers are coerced for number params", prep("environment_scatter", { kinds: ["pine"], count: "12" }).args.count === 12 && prep("terrain_shape", { op: "hill", radius: "40" }).args.radius === 40);
ok("D6 contract classifies terrain_info as non-mutating and map_generate / terrain_generate / terrain_shape as mutating (verify after)", (() => { const info = CC.contract("terrain_info"); return info && info.mutating === false && ["map_generate", "terrain_generate", "terrain_shape", "environment_scatter", "road_build"].every((n) => CC.contract(n).mutating === true); })());

// ── E. wiring ─────────────────────────────────────────────────────────────────
const main = read("src/core/main.js"), config = read("src/core/config.js"), s100 = read("src/core/skills/studio_100.js"), intel = read("src/core/skill_intel.js");
ok("E1 manifest lists studio_environment.js right after studio_images.js in all 12 bundles + codecraft.html", bundles.length === 12 && bundles.every((c) => c.js.indexOf("src/core/skills/studio_environment.js") === c.js.indexOf("src/core/skills/studio_images.js") + 1 && c.js.indexOf("src/core/skills/studio_environment.js") < c.js.indexOf("src/core/main.js")) && /studio_images\.js"><\/script>\s*<script src="src\/core\/skills\/studio_environment\.js">/.test(read("codecraft.html")));
ok("E2 tests/test-command-dedup.js loads the new pack (duplicate-id guard covers it)", /"studio_images\.js","studio_environment\.js"(,"studio_[a-z]+\.js")*\]/.test(read("tests/test-command-dedup.js")));
ok("E3 SLOW_SKILL_RE grants the 90 s budget to the heavy environment commands (big WriteVoxels runs)", /SLOW_SKILL_RE = \/.*terrain_\(generate\|shape\|path\|water\|paint_biome\|info\)\|environment_scatter\|road_build\|map_generate(\|[a-z_|]+)?\)\$\//.test(main));
ok("E4 catalogue family: map_generate + environment_scatter join TERRAIN & ENVIRONMENT; road_build stays in MODELING & BUILD (road_ prefix)", /\{ id: "terrain", label: "TERRAIN & ENVIRONMENT", re: \/\^\(terrain_\|map_generate\$\|environment_scatter\$\)\/ \}/.test(main) && /re: \/\^\((kit_\|project_style\$\|)?part_\|model_\|[^}]*road_/.test(main));
ok("E5 next-step hints for terrain_generate / map_generate / terrain_shape / terrain_path / environment_scatter name only registered commands", (() => { const m = main.match(/const NEXT_STEP = \{([\s\S]*?)\n    \};/); if (!m) return false; const hints = ["terrain_generate", "map_generate", "terrain_shape", "terrain_path", "environment_scatter"].map((k) => (m[1].match(new RegExp("^\\s+" + k + ': "([^"]+)"', "m")) || [])[1]); return hints.every(Boolean) && hints.every((h) => [...h.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((x) => x[1]).every((n) => byName.has(n) || n === "total_screenshot")); })());
ok("E6 config prompt: the terrain line teaches map_generate / terrain_generate / terrain_shape / terrain_path / terrain_water / environment_scatter / road_build / terrain_info and the compact SKILLS index lists the new names", /PROCEDURAL TERRAIN & ENVIRONMENT: \\`map_generate\\`/.test(config) && ["terrain_generate", "terrain_shape", "terrain_path", "terrain_water", "environment_scatter", "road_build", "terrain_info", "terrain_paint_biome"].every((n) => config.includes("\\`" + n + "\\`")) && /SKILLS \(full params come from list_commands[^\n]*terrain_generate, terrain_shape, terrain_path, terrain_water, environment_scatter, road_build, map_generate/.test(config));
ok("E7 studio_100 NOT_IMPLEMENTED stubs road_path_build / tree_forest_scatter now point at road_build / terrain_path / environment_scatter", /road_path_build: "road_build \{points, width\}[^"]*terrain_path \{kind:'road'\}/.test(s100) && /tree_forest_scatter: "environment_scatter \{kinds:/.test(s100));
ok("E8 skill_intel world_building expert teaches the new terrain workflow (and stays under its 3.5 kB budget)", /map_generate \{preset\}/.test(intel) && /environment_scatter/.test(intel) && (() => { vm.runInThisContext(intel, { filename: "skill_intel.js" }); return window.TotalSkillIntel.expertText("world_building").length < 3500; })());
ok("E9 the stub hint names resolve to registered commands (test-not-implemented's hint rule)", ["road_build", "terrain_path", "environment_scatter"].every((n) => byName.has(n)));

// ── F. honesty / behaviour rules in the Luau ──────────────────────────────────
const L = S.ENVIRONMENT_LIB;
ok("F1 environment_scatter fails (not ok) when nothing could be placed and says why; props never float (every placement is a raycast hit)", /nothing placed: %d spots hit no ground/.test(L) && /ENV\.groundAt\(x, z, o\.yTop or 400, exclude\)/.test(L) && /if not pos then reason = "air"/.test(L));
ok("F2 scatter excludes the Environment folder from its raycasts (props do not stack on earlier props or roads)", /local exclude = \{ o\.container\.Parent or o\.container \}/.test(L));
ok("F3 shapes / paths / lakes only rewrite the columns they touch (touch mask) and keep water above the new surface", /touch = function\(i, j\) return touched\[i\] ~= nil and touched\[i\]\[j\] == true end/.test(L) && /touch = function\(i, j\) return near\[i\] ~= nil and near\[i\]\[j\] ~= nil end/.test(L) && /elseif p\.keep and oldM == WATER then m, occ = WATER, oldO end/.test(L));
ok("F4 terrain_paint_biome changes materials only (occupancy copied back untouched)", /Only materials changed - occupancy, caves and overhangs are exactly as before/.test(L));
ok("F5 terrain_info is read-only (no WriteVoxels / Fill / Destroy in its command body)", (() => { const i = L.indexOf("function CMD.terrain_info"), j = L.indexOf("function CMD.", i + 10); const body = L.slice(i, j > 0 ? j : undefined); return !/WriteVoxels|Fill(Block|Ball|Cylinder)|Destroy\(|Instance\.new/.test(body); })());
ok("F6 no asset ids / uploads: props are Part / WedgePart models with EnvKind attributes; roads are anchored Parts", /no asset ids/.test(L) && !/rbxassetid:\/\/\d{4,}/.test(L) && /SetAttribute\("EnvKind", kind\)/.test(L));
ok("F7 map_generate records preset / seed / size / center on Workspace.Environment so the same call rebuilds the same map", /SetAttribute\("MapPreset", presetName\)/.test(L) && /SetAttribute\("MapSeed", seed\)/.test(L) && /SetAttribute\("MapSize", size\)/.test(L));
ok("F8 every command description ends with what it does NOT do / where its limits are (no 'perfect' / 'AAA' claims)", NAMES.every((n) => !/perfect|AAA|flawless|photoreal/i.test(byName.get(n).description)));
ok("F9 terrain_generate refuses > 2048 studs per axis in Luau too and suggests tiling", /generate the map in tiles/.test(L));
ok("F10 README documents 2.10.0 with the nine commands and the simulator caveat", (() => { const r = read("README.md"); return /2\.10\.0/.test(r) && NAMES.every((n) => r.includes(n)) && /roblox_sim|mock|simulat/i.test(r.slice(r.indexOf("2.10.0"), r.indexOf("2.10.0") + 6000)); })());

console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-environment-pack: ${pass} passed, ${fail} failed (static - the Luau runs in tests/environment-sim.py; a real Studio run is still the final word)`);
process.exit(fail ? 1 : 0);
