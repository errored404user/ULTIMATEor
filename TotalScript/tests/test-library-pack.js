// 2.4.0 — "Now tier 2": kit_save / kit_place / kit_library / project_style
// (src/core/skills/studio_library.js), perf_audit / perf_fix
// (src/core/skills/studio_perf.js) and animation_retarget / animation_library
// (src/core/animlib.js). Static half: registration, schemas, JS-side validation,
// builder shape (lib + body for the Luau library cache), style-preset ids vs the
// real enums of every consumer pack, contract classification, catalogue family,
// wiring into manifest / codecraft / prompt / hints / SLOW_SKILL_RE / skill
// intel, and honest-output rules. The Luau itself runs in tests/library-sim.py,
// tests/perf-sim.py and tests/retarget-sim.py (lupa + roblox_sim DataModel).
// Run: node tests/test-library-pack.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 600) : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/command_contract.js") + ";globalThis.__CC=TotalCommandContract;", { filename: "command_contract.js" });
vm.runInThisContext(read("src/core/skill_intel.js"), { filename: "skill_intel.js" });
const S = RobloxScriptSkills, CC = globalThis.__CC, A = RSAnim, SI = global.TotalSkillIntel;
const LIB_NAMES = ["kit_save", "kit_place", "kit_library", "project_style"];
const PERF_NAMES = ["perf_audit", "perf_fix"];
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
const libSrc = read("src/core/skills/studio_library.js");
const perfSrc = read("src/core/skills/studio_perf.js");
const animSrc = read("src/core/animlib.js");
const mainSrc = read("src/core/main.js");
const configSrc = read("src/core/config.js");

// ── A. registration ───────────────────────────────────────────────────────────
ok("A1 library pack exports LIBRARY_COMMANDS (4) + VERSION 2.14.0 + LIB + STYLE_PRESETS (12) + validateLibrary", JSON.stringify(S.LIBRARY_COMMANDS) === JSON.stringify(LIB_NAMES) && S.LIBRARY_VERSION === "2.14.0" && typeof S.LIBRARY_LIB === "string" && Object.keys(S.STYLE_PRESETS).length === 12 && typeof S.validateLibrary === "function", { v: S.LIBRARY_VERSION, n: Object.keys(S.STYLE_PRESETS || {}).length });
ok("A2 perf pack exports PERF_COMMANDS (2) + VERSION 2.14.0 + LIB + FIX_OPS (7) + DEFAULT_OPS (6, no streaming) + validatePerf", JSON.stringify(S.PERF_COMMANDS) === JSON.stringify(PERF_NAMES) && S.PERF_VERSION === "2.14.0" && typeof S.PERF_LIB === "string" && S.PERF_FIX_OPS.length === 7 && S.PERF_DEFAULT_OPS.length === 6 && !S.PERF_DEFAULT_OPS.includes("streaming") && S.PERF_FIX_OPS.includes("streaming") && typeof S.validatePerf === "function");
ok("A3 all six are registered ONCE, visible, with real descriptions + params", [...LIB_NAMES, ...PERF_NAMES].every((n) => byName.has(n) && !byName.get(n).hidden && byName.get(n).description.length > 120 && Object.keys(byName.get(n).params).length >= 2) && S.SKILL_COMMANDS.filter((c) => LIB_NAMES.includes(c.name) || PERF_NAMES.includes(c.name)).length === 6);
ok("A4 SKILL_COMMANDS spliced, not reassigned, in both packs", [libSrc, perfSrc].every((s) => /const arr = RobloxScriptSkills\.SKILL_COMMANDS;[\s\S]*?for \(const c of C\) arr\.push\(c\);/.test(s) && !/RobloxScriptSkills\.SKILL_COMMANDS\s*=/.test(s)));
ok("A5 required params: kit_save.path, kit_place.name; project_style / kit_library / perf_* have none (op defaults)", byName.get("kit_save").params.path.req === true && byName.get("kit_place").params.name.req === true && !Object.values(byName.get("project_style").params).some((p) => p.req) && !Object.values(byName.get("kit_library").params).some((p) => p.req) && !Object.values(byName.get("perf_audit").params).some((p) => p.req) && !Object.values(byName.get("perf_fix").params).some((p) => p.req));
ok("A6 animlib registers animation_retarget + animation_library in ANIM_COMMANDS / ANIM_OPS and the Luau dispatch", A.ANIM_OPS.includes("retarget") && A.ANIM_OPS.includes("library") && /retarget = api\.retarget, library = api\.library,/.test(animSrc) && /^function api\.retarget\(a\)/m.test(animSrc) && /^function api\.library\(a\)/m.test(animSrc));

// ── B. builder shape ──────────────────────────────────────────────────────────
const b1 = S.buildLuau("kit_save", { path: "Workspace.Shop", name: "shop" });
ok("B1 kit_save builder returns { code, lib, body } with code === lib + '\\n' + body (runSkillLuau cache contract)", b1 && !b1.err && b1.code === b1.lib + "\n" + b1.body && b1.lib === S.LIBRARY_LIB);
ok("B2 library lib > 25k chars, body < 200 (the lib uploads once per place)", b1.lib.length > 25000 && b1.body.length < 200, { lib: b1.lib.length, body: b1.body.length });
ok("B3 body = JSONDecode of the args in a [==[ ]==] long string + KT.run(op)", /HttpService:JSONDecode\(\[==\[\{"path":"Workspace\.Shop","name":"shop"\}\]==\]\)/.test(b1.body) && /return KT\.run\("kit_save", __a\)/.test(b1.body));
const b2 = S.buildLuau("perf_audit", {});
ok("B4 perf builder: same shape, PERF.run(op), lib > 12k", b2 && !b2.err && b2.code === b2.lib + "\n" + b2.body && b2.lib === S.PERF_LIB && /return PERF\.run\("perf_audit", __a\)/.test(b2.body) && b2.lib.length > 12000);
ok("B5 args containing ']==]' are refused by both packs", [S.buildLuau("kit_save", { path: "Workspace.X", name: "a", description: "a]==]print(1)--" }), S.buildLuau("perf_audit", { path: "x]==]y" })].every((r) => r && r.err && /]==]/.test(r.err)) && /letters, digits/.test(S.buildLuau("kit_save", { path: "Workspace.X", name: "a]==]b" }).err));
ok("B6 both Luau libraries are pure ASCII and never end with a return (they are prefixes of the command body)", [S.LIBRARY_LIB, S.PERF_LIB].every((l) => /^[\x00-\x7f]*$/.test(l) && !/\breturn\s+\w+\s*$/.test(l.trim())));
ok("B7 no Luau-only syntax (+= / continue / backticks) in the libs - the lupa sims run them", [S.LIBRARY_LIB, S.PERF_LIB].every((l) => !/\+=|\bcontinue\b|`/.test(l)));

// ── C. JS-side validation (refused before Luau) ───────────────────────────────
const err = (n, a) => { const r = S.buildLuau(n, a); return r && r.err || ""; };
ok("C1 kit_save without path / kit_place without name are refused", /path is required/.test(err("kit_save", {})) && /name is required/.test(err("kit_place", {})));
ok("C2 kit_place needs a placement (position | cframe | points) and caps count", /position/.test(err("kit_place", { name: "a" })) && /count/.test(err("kit_place", { name: "a", position: [0, 0, 0], count: 5000 })));
ok("C3 kit_library refuses unknown ops; project_style refuses unknown presets / ops and lists the valid ones", /list\|info\|delete\|tag\|rename/.test(err("kit_library", { op: "zap" })) && /medieval, fantasy, scifi, cyberpunk/.test(err("project_style", { op: "set", preset: "nope" })) && err("project_style", { op: "zap" }).length > 0);
ok("C4 perf_audit.limit must be >= 100; perf_fix.ops must be an array of known ops", /limit/.test(err("perf_audit", { limit: 5 })) && /array/.test(err("perf_fix", { ops: "anchor_free" })) && /delete_everything/.test(err("perf_fix", { ops: ["delete_everything"] })) && !err("perf_fix", { ops: ["anchor_free", "streaming"], dry_run: true }));
ok("C5 animation_retarget: to must be R6|R15, scale_positions positive, bone_map an object; animation_library: op whitelist, name for rename / delete, new_name for rename, tag needs tags or notes", /R6 or R15/.test(A.buildLuau("retarget", {}).err || "") && /scale_positions/.test(A.buildLuau("retarget", { to: "R6", scale_positions: -1 }).err || "") && /bone_map/.test(A.buildLuau("retarget", { to: "R6", bone_map: [1] }).err || "") && /op must be/.test(A.buildLuau("library", { op: "zap" }).err || "") && /'name' is required for delete/.test(A.buildLuau("library", { op: "delete" }).err || "") && /new_name/.test(A.buildLuau("library", { op: "rename", name: "a" }).err || "") && /tags/.test(A.buildLuau("library", { op: "tag", name: "a" }).err || ""));
const rt = A.buildLuau("retarget", { to: "r6", name: "Slam", save_as: "SlamSix" });
ok("C6 retarget args are normalised (to upper-cased) and shipped as op:retarget; library ships lop (the sub op) so the dispatcher op stays 'library'", rt.code && /"op":"retarget","to":"R6","name":"Slam","save_as":"SlamSix"/.test(rt.body) && /"op":"library","lop":"search","query":"idle"/.test(A.buildLuau("library", { op: "search", query: "idle" }).body) && /local op = tostring\(a\.lop or "list"\)/.test(animSrc));

// ── D. style presets vs the real enums of every consumer ──────────────────────
const P = S.STYLE_PRESETS;
const FIELDS = ["genre", "ui_theme", "ui_tokens", "vfx", "lighting", "model", "weapon", "furniture", "terrain", "material", "trim_material", "font", "palette"];
ok("D1 every preset fills every field (genre ui_theme ui_tokens vfx lighting model weapon furniture terrain material trim_material font palette)", Object.values(P).every((p) => FIELDS.every((f) => p[f] !== undefined && p[f] !== "")), Object.entries(P).filter(([, p]) => !FIELDS.every((f) => p[f])).map(([k]) => k));
ok("D2 ui_theme ids exist in art_theme (ARTUI_THEMES)", Object.values(P).every((p) => S.ARTUI_THEMES.includes(p.ui_theme)), Object.values(P).map((p) => p.ui_theme).filter((t) => !S.ARTUI_THEMES.includes(t)));
ok("D3 vfx palette ids exist in TotalVFX (VFX_PALETTES)", Object.values(P).every((p) => Object.keys(S.VFX_PALETTES).includes(p.vfx)), Object.values(P).map((p) => p.vfx).filter((t) => !S.VFX_PALETTES[t]));
ok("D4 ui_tokens ids exist in design_tokens (DESIGN_PRESETS)", Object.values(P).every((p) => S.DESIGN_PRESETS.includes(p.ui_tokens)), Object.values(P).map((p) => p.ui_tokens).filter((t) => !S.DESIGN_PRESETS.includes(t)));
ok("D5 model / weapon / furniture styles exist in the model kit enums", Object.values(P).every((p) => S.MODELKIT_ENUMS.STYLES.includes(p.model) && S.MODELKIT_ENUMS.WEAPON_STYLES.includes(p.weapon) && S.MODELKIT_ENUMS.FURNITURE_STYLES.includes(p.furniture)), Object.values(P).map((p) => [p.model, p.weapon, p.furniture]));
ok("D6 terrain palettes exist in the environment pack; lighting presets exist in lighting_set_preset", Object.values(P).every((p) => S.ENVIRONMENT_ENUMS.PALETTES.includes(p.terrain)) && (() => { const m = read("src/core/skills/studio_skills.js").match(/const LIGHTING_PRESETS_JS = \{([\s\S]*?)\n\};/); const ids = [...m[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((x) => x[1]); return Object.values(P).every((p) => ids.includes(p.lighting)); })(), Object.values(P).map((p) => [p.terrain, p.lighting]));
ok("D7 palettes are 6 hex colours (primary secondary accent neutral dark light)", Object.values(P).every((p) => Array.isArray(p.palette) && p.palette.length === 6 && p.palette.every((h) => /^#[0-9a-f]{6}$/i.test(h))));
ok("D8 the Luau writes the shared store ServerStorage._TotalStyle with FIELDS + <role>_hex + Color3 roles + Style JSON, and fans out to Total_Art.art_theme / TotalVFX.DefaultPalette / _TotalBrief", /_TotalStyle/.test(S.LIBRARY_LIB) && /_hex/.test(S.LIBRARY_LIB) && /Color3\.fromHex|Color3\.fromRGB/.test(S.LIBRARY_LIB) && /art_theme/.test(S.LIBRARY_LIB) && /DefaultPalette/.test(S.LIBRARY_LIB) && /_TotalBrief/.test(S.LIBRARY_LIB));

// ── E. consumers read the project style when no style is given ───────────────
const mkSrc = read("src/core/skills/studio_modelkit.js");
ok("E1 model kit: projectStyle(field) helper + a.style falls back to _TotalStyle model / weapon / furniture", /local function projectStyle\(field\)/.test(mkSrc) && /a\.style = projectStyle\("model"\)/.test(mkSrc) && /a\.style = projectStyle\("weapon"\)/.test(mkSrc) && /a\.style = projectStyle\("furniture"\)/.test(mkSrc));
const vfxInstall = S.buildLuau("vfx_library_install", {});
ok("E2 vfx_library_install without a palette reads _TotalStyle.vfx into DefaultPalette (only when none is set); with a palette it does not", vfxInstall.code && /_TotalStyle/.test(vfxInstall.code) && /GetAttribute\('vfx'\)/.test(vfxInstall.code) && !/_TotalStyle/.test(S.buildLuau("vfx_library_install", { palette: "frost" }).code));
ok("E3 kit store lives in ServerStorage._TotalKits with Total_Kit / Total_Source / Total_Class / Total_Tags attributes and an Asset child", /_TotalKits/.test(S.LIBRARY_LIB) && /Total_Kit/.test(S.LIBRARY_LIB) && /Total_Source/.test(S.LIBRARY_LIB) && /Total_Tags/.test(S.LIBRARY_LIB) && /Total_AssetName/.test(S.LIBRARY_LIB));

// ── F. perf pack rules ────────────────────────────────────────────────────────
ok("F1 SCORE_RULES documented in the Luau (11 rules) and returned by perf_audit", (S.PERF_LIB.match(/\{ id = "[a-z_]+", text = /g) || []).length === 11 && /rules = PERF\.SCORE_RULES/.test(S.PERF_LIB));
ok("F2 free-part detection excludes anchored, jointed, constrained, character, vehicle, Tool / Accessory parts", /GetJoints\(\) > 0 then return false/.test(S.PERF_LIB) && /WeldConstraint|Constraint/.test(S.PERF_LIB) && /Humanoid/.test(S.PERF_LIB) && /VehicleSeat/.test(S.PERF_LIB) && /IsA\("Tool"\) or n:IsA\("Accessory"\)/.test(S.PERF_LIB) && /Players:GetPlayers\(\)/.test(S.PERF_LIB));
ok("F3 perf_fix never rewrites scripts, respects TotalVFX-owned emitters, keeps the 8 strongest shadow lights, waypoints, re-scores, and only streams on explicit request", !/\.Source\s*=/.test(S.PERF_LIB) && /TotalVFX/.test(S.PERF_LIB) && /math\.min\(8, #lights\)/.test(S.PERF_LIB) && /SetWaypoint/.test(S.PERF_LIB) && /score_after/.test(S.PERF_LIB) && /if want\.streaming then/.test(S.PERF_LIB) && !/"anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers", "streaming" \}/.test(S.PERF_LIB.match(/if type\(ops\) ~= "table" or #ops == 0 then ops = \{[^}]*\}/)[0]));
ok("F4 honest output: the audit text says the score is a heuristic, not a measured frame time; no '/100 quality' wording", /not a measured frame time/.test(S.PERF_LIB) && !/quality score/i.test(S.PERF_LIB));
ok("F5 busy-loop scanner handles while true without wait, while wait(), legacy wait() in loops; same-line header not double counted", /loop without wait/.test(S.PERF_LIB) && /while wait\(\) do/.test(S.PERF_LIB) && /wait\(\) in loop/.test(S.PERF_LIB) && /inLoop and lineNo ~= loopLine/.test(S.PERF_LIB));

// ── G. contract + catalogue family ───────────────────────────────────────────
const c = (n) => CC.get ? CC.get(n) : CC.contract(n);
ok("G1 contract: kit_save / kit_place / kit_library / project_style / perf_fix mutating, perf_audit read-only (audit suffix); none destructive", ["kit_save", "kit_place", "kit_library", "project_style", "perf_fix"].every((n) => c(n) && c(n).mutating) && c("perf_audit") && !c("perf_audit").mutating && [...LIB_NAMES, ...PERF_NAMES].every((n) => !c(n).destructive));
ok("G2 contract typing: vectors are 'any' (position / cframe / points / grid / palette roles), perf_fix.ops is an array", c("kit_place").params.position.type === "any" && c("kit_place").params.points.type === "any" && c("kit_place").params.grid.type === "any" && c("project_style").params.primary.type === "any" && c("perf_fix").params.ops.type === "array");
const famBlock = mainSrc.slice(mainSrc.indexOf("const COMMAND_FAMILIES = ["), mainSrc.indexOf("];", mainSrc.indexOf("const COMMAND_FAMILIES = [")) + 2);
const fams = eval(famBlock.replace("const COMMAND_FAMILIES =", "") + ";");
const famOf = (n) => (fams.find((f) => f.re.test(n)) || {}).id;
ok("G3 families: kit_* + project_style -> build, perf_* -> play (not 'other')", LIB_NAMES.every((n) => famOf(n) === "build") && PERF_NAMES.every((n) => famOf(n) === "play"), LIB_NAMES.concat(PERF_NAMES).map(famOf));
ok("G4 SLOW_SKILL_RE grants the long budget to kit_place / perf_audit / perf_fix (whole-place walks)", /SLOW_SKILL_RE = \/.*\|kit_place\|perf_audit\|perf_fix\)\$\//.test(mainSrc));

// ── H. wiring ─────────────────────────────────────────────────────────────────
ok("H1 manifest: studio_library.js + studio_perf.js in all " + bundles.length + " bundles, after studio_verify.js and before main.js", bundles.length === 11 && bundles.every((b) => { const i = b.js.indexOf("src/core/skills/studio_verify.js"), j = b.js.indexOf("src/core/skills/studio_library.js"), k = b.js.indexOf("src/core/skills/studio_perf.js"), m = b.js.indexOf("src/core/main.js"); return i > -1 && j === i + 1 && k === j + 1 && k < m; }));
ok("H2 codecraft.html loads both packs after studio_verify.js", (() => { const h = read("codecraft.html"); const i = h.indexOf("studio_verify.js"), j = h.indexOf("studio_library.js"), k = h.indexOf("studio_perf.js"); return i > -1 && j > i && k > j; })());
ok("H3 system prompt: one '- LIBRARY, STYLE & PERF:' line names kit_save / kit_place / kit_library / project_style / perf_audit / perf_fix / animation_retarget / animation_library and the set-once rule", (() => { const m = configSrc.match(/^- LIBRARY, STYLE & PERF: .*$/m); return m && ["kit_save", "kit_place", "kit_library", "project_style", "perf_audit", "perf_fix", "animation_retarget", "animation_library"].every((n) => m[0].includes(n)) && /set it once/.test(m[0]); })());
ok("H4 next-step hints for kit_save / kit_place / project_style / perf_audit / perf_fix / animation_retarget", ["kit_save", "kit_place", "project_style", "perf_audit", "perf_fix", "animation_retarget"].every((n) => new RegExp("^\\s+" + n + ': "Next: ', "m").test(mainSrc)));
ok("H5 skill intel: performance procedure measures with perf_audit and fixes with perf_fix; world building sets project_style once and reuses kits", /perf_audit/.test(SI.expertText("performance")) && /perf_fix/.test(SI.expertText("performance")) && /project_style/.test(SI.expertText("world_building")) && /kit_place/.test(SI.expertText("world_building")) && SI.expertText("world_building").length < 3500);
ok("H6 the animation catalogue describes both new tools with their params (to req; op / name / query / tags / new_name)", (() => { const r = A.ANIM_COMMANDS.find((x) => x.name === "animation_retarget"), l = A.ANIM_COMMANDS.find((x) => x.name === "animation_library"); return r && r.params.to.req === true && r.params.save_as && r.params.bone_map && l && ["op", "name", "query", "rig", "tag", "tags", "notes", "new_name"].every((k) => l.params[k]); })());

console.log(`\n${fail ? "FAIL" : "OK"}    test-library-pack: ${pass} passed, ${fail} failed (static - the Luau runs in tests/library-sim.py, tests/perf-sim.py, tests/retarget-sim.py)`);
process.exit(fail ? 1 : 0);
