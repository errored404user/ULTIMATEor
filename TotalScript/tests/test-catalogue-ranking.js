// 2.3.0 — CATALOGUE RANKING + REGISTRY HYGIENE.
// The 2.3.0 audit measured the embedded catalogue a model really receives on
// the default 20 000-char budget: 267 of 653 commands had a signature and the
// signature budget inside each family went to the ALPHABETICALLY first names
// (anchored_set, billboard_gui_create, animation_add_keyframe...) while
// ui_screen_generate, structure_build, fx_create_vfx were names-only; 229 of
// the 386 names-only commands had a REQUIRED parameter (a blind call always
// failed); no signature ever carried an enum although the header promised
// "c?:x|y"; search_commands ranked 93 dead NOT_IMPLEMENTED stubs first.
// This test runs the real buildCatalogue / registry and pins the fixes.
// Run: node tests/test-catalogue-ranking.js   (from TotalScript/)
const fs = require("fs"), vm = require("vm");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 600) : "")); } };
const main = fs.readFileSync("src/core/main.js", "utf8");
global.window = global; global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/main.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib|command_registry)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const cut = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
const block = cut("  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET") + cut("  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──") + "\n" + cut("  const WORK_MODES = {", "  const WORK_MODE_IDS");
const ctx = { window: null, console, RS: { TOOL_NOTES: {} }, bareToolName: (n) => String(n).split("/").pop(), RobloxScriptSkills, RSAnim, PublicSkills: undefined, TotalTaskList: undefined, WORK_MODE_IDS: ["creation"] };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(block + "\nthis.buildCatalogue=buildCatalogue;this.commandFamily=commandFamily;this.nameFromLine=nameFromLine;this.sigFromLine=sigFromLine;this.sigEnum=sigEnum;this.sigRequired=sigRequired;this.signaturePriority=signaturePriority;this.groupByFamily=groupByFamily;this.UNIVERSAL_COMMANDS=UNIVERSAL_COMMANDS;", ctx);
const skillLines = RobloxScriptSkills.describeCommands(), animLines = RSAnim.describeCommands();
const names = [...animLines, ...skillLines].map(ctx.nameFromLine).filter(Boolean);
const native = [{ name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } }, { name: "list_commands", inputSchema: { type: "object", properties: {} } }];
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function stats(budget) {
  const t = Date.now();
  const text = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "CAT", nativeTools: native, virtualLines: [...animLines, ...skillLines], webLines: [], focusBlock: "", focusNames: [], compact: true, limit: budget, lineLimit: 420, modeId: "creation" });
  const ms = Date.now() - t;
  const fam = {}; let sig = 0, nameOnly = 0, missing = 0;
  const sigOf = new Set(), nameOf = new Set();
  for (const n of names) {
    const f = ctx.commandFamily(n); fam[f] = fam[f] || { total: 0, sig: 0 }; fam[f].total++;
    if (new RegExp("(^|[\\s·])" + esc(n) + "\\s\\{").test(text)) { sig++; fam[f].sig++; sigOf.add(n); }
    else if (new RegExp("(^|[\\s,:])" + esc(n) + "(\\{|,|$|\\s)", "m").test(text)) { nameOnly++; nameOf.add(n); }
    else missing++;
  }
  return { text, ms, fam, sig, nameOnly, missing, sigOf, nameOf };
}
const S20 = stats(24000), S14 = stats(16000);
console.log("  24k: " + Object.entries(S20.fam).map(([k, v]) => `${k} ${v.sig}/${v.total}`).join("  "));
console.log(`  24k total: ${S20.sig} signatures, ${S20.nameOnly} names-only, ${S20.missing} missing, ${S20.text.length} chars, ${S20.ms} ms`);

// ── A. ranking ───────────────────────────────────────────────────────────────
ok("A1 signaturePriority tiers: generators -3, audits -1, setters +2, plain 0", ctx.signaturePriority("ui_screen_generate") === -3 && ctx.signaturePriority("structure_build") === -3 && ctx.signaturePriority("fx_create_vfx") === -3 && ctx.signaturePriority("ui_audit") === -1 && ctx.signaturePriority("ui_layout_report") === -1 && ctx.signaturePriority("anchored_set") === 2 && ctx.signaturePriority("color_set") === 2 && ctx.signaturePriority("part_create") === 0);
ok("A2 within a family the entries are ordered by tier then name (no longer alphabetical)", (() => { const g = ctx.groupByFamily([{ name: "ui_tween" }, { name: "anchored_set" }, { name: "ui_screen_generate" }, { name: "ui_audit" }, { name: "billboard_gui_create" }].map((e) => Object.assign({ sig: e.name + " {}" }, e)), "creation", new Set()); const ui = g.find((x) => x.id === "ui"); return ui && ui.entries.map((e) => e.name).join(",") === "ui_screen_generate,ui_audit,billboard_gui_create,ui_tween"; })(), JSON.stringify(ctx.groupByFamily([{ name: "ui_tween", sig: "" }, { name: "ui_screen_generate", sig: "" }], "creation", new Set()).map((g) => g.entries.map((e) => e.name))));
ok("A3 focus names outrank everything inside the family", (() => { const g = ctx.groupByFamily([{ name: "ui_screen_generate", sig: "" }, { name: "ui_tween", sig: "" }], "creation", new Set(["ui_tween"])); const ui = g.find((x) => x.id === "ui"); return ui.entries[0].name === "ui_tween"; })());
const GENERATORS = ["ui_screen_generate", "ui_from_spec", "ui_art_build", "ui_design_system_create", "structure_build", "vehicle_build", "weapon_build", "furniture_build", "mesh_shape_create", "model_detail", "model_variant", "model_build", "fx_create_vfx", "animation_create", "map_generate", "terrain_generate", "cutscene_create", "lighting_set_preset", "blueprint_install", "audio_setup_sound_hierarchy"];
ok("A4 24k default budget: every generator / system command carries a SIGNATURE (was: names-only for ui_screen_generate, ui_art_build, the whole model kit, fx_create_vfx)", GENERATORS.every((n) => S20.sigOf.has(n)), GENERATORS.filter((n) => !S20.sigOf.has(n)));
ok("A5 24k default budget: UI gets >= 40 signatures (was 11 at 20k), BUILD >= 40 (was 24), ANIMATION >= 20 (was 11), VFX >= 14 (was 10)", S20.fam.ui.sig >= 40 && S20.fam.build.sig >= 40 && S20.fam.animation.sig >= 20 && S20.fam.vfx.sig >= 14, Object.fromEntries(Object.entries(S20.fam).map(([k, v]) => [k, v.sig + "/" + v.total])));
ok("A6 24k default budget: >= 300 commands with a signature in total (was 267 at 20k) and nothing is missing from the catalogue", S20.sig >= 300 && S20.missing === 0, { sig: S20.sig, missing: S20.missing });
ok("A7 the output still respects the budget and the line limit (chars <= 24000, lines <= 420) and builds in < 250 ms", S20.text.length <= 24000 && S20.text.split("\n").length <= 420 && S20.ms < 250, { chars: S20.text.length, lines: S20.text.split("\n").length, ms: S20.ms });
const universal = new Set(ctx.UNIVERSAL_COMMANDS);
const tierBreaks = (S) => { const out = []; for (const f of Object.keys(S.fam)) { const inFam = names.filter((n) => ctx.commandFamily(n) === f && !universal.has(n) && !/^(model_build|ui_build)$/.test(n)); const shown = inFam.filter((n) => S.sigOf.has(n)), hidden = inFam.filter((n) => !S.sigOf.has(n)); if (!shown.length || !hidden.length) continue; const maxShown = Math.max(...shown.map(ctx.signaturePriority)), minHidden = Math.min(...hidden.map(ctx.signaturePriority)); if (maxShown > minHidden) out.push(f + ":" + maxShown + ">" + minHidden); } return out; };
ok("A8 16k budget (plain-names fallback): in every family the signatures are a tier-prefix - no setter gets a signature while a generator of the same family is names-only", tierBreaks(S14).length === 0 && S14.missing === 0 && S14.fam.ui.sig >= 8 && ["structure_build", "furniture_build", "mesh_shape_create", "generate_procedural_model"].filter((n) => S14.sigOf.has(n)).length >= 2, { breaks: tierBreaks(S14), ui: S14.fam.ui.sig, missing: S14.missing });
ok("A8b 24k: same tier-prefix property holds", tierBreaks(S20).length === 0, tierBreaks(S20));
ok("A9 the share per pass is proportional to what a family still has left (floor 420 chars, shrinking to 140 on tight budgets so 19 families are not drained by the first four), over up to 6 passes - no flat 60% split, no family-order drain", /const floorChars = Math\.max\(140, Math\.min\(420, Math\.floor\(sigBudget \/ Math\.max\(1, groups\.length\)\)\)\);/.test(main) && /shareChars = \(g, passBudget\) => Math\.max\(floorChars, Math\.floor\(passBudget \* left\(g\) \/ leftTotal\)\)/.test(main) && /for \(let pass = 0; pass < 6 && sigBudget >= 140; pass\+\+\)/.test(main) && !/\(compact \? 0\.6 : 1\)/.test(main));
ok("A9b compact 9k catalogue (tiny composers) still carries lighting / VFX / UI / animation signatures with every name reserved first", (() => { const tc = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: [...animLines, ...skillLines], webLines: [], focusBlock: "━━━ TOTALITY WORK MODE FOCUS — x ━━━\n\n", focusNames: [], compact: true, limit: 9000, lineLimit: 200, modeId: "creation" }); const cf = [...tc.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]); return ["LIGHTING & ATMOSPHERE", "VFX & PARTICLES", "UI & HUD", "ANIMATION"].every((f) => cf.includes(f)) && tc.length <= 9000; })());

// ── B. names-only tail ───────────────────────────────────────────────────────
const tail = S20.text.slice(S20.text.indexOf("NAMES ONLY"));
ok("B1 the NAMES ONLY header explains [a,b] runs / name{a} = required parameters", /NAMES ONLY \(call them directly - \[a,b\] before a run of names = the REQUIRED parameters of those names, \[-\] = none required, name\{a\} = that name needs a/.test(tail));
// parse "[path] a, b · [-] c · d{x}" rows back into (name -> required[]) and compare with the pack
const tailReq = new Map();
for (const line of tail.split("\n").slice(1)) {
  const i = line.indexOf(": "); if (i < 0) continue;
  for (const seg of line.slice(i + 2).split(" · ")) {
    const m = seg.match(/^\[([^\]]*)\] (.*)$/);
    if (m) { const req = m[1] === "-" ? [] : m[1].split(","); for (const n of m[2].split(", ")) tailReq.set(n.trim(), req); continue; }
    const s1 = seg.match(/^([a-z0-9_]+)(?:\{([^}]*)\})?$/); if (s1) tailReq.set(s1[1], s1[2] ? s1[2].split(",") : []);
  }
}
const byName = new Map(RobloxScriptSkills.SKILL_COMMANDS.map((c) => [c.name, c]));
const wrongReq = [...tailReq.entries()].filter(([n, req]) => { const c = byName.get(n); if (!c) return false; const want = Object.entries(c.params || {}).filter(([, p]) => p && p.req === true).map(([k]) => k).sort().join(","); return want !== [...req].sort().join(","); });
ok("B2 every names-only command carries its exact required-parameter set (0 mismatches over " + tailReq.size + " names; 229 of 386 used to show none)", tailReq.size > 150 && wrongReq.length === 0, wrongReq.slice(0, 8));
ok("B3 sigRequired parses required names and drops enums / optionals", JSON.stringify(ctx.sigRequired("x {path, kind:ocean|lake, count?, mode:a|b?, +3?}")) === JSON.stringify(["path", "kind"]) && ctx.sigRequired("x {}").length === 0);

// ── C. enums in signatures ───────────────────────────────────────────────────
ok("C1 sigEnum picks a 2-6 option pipe list out of a description and ignores long lists", ctx.sigEnum("ocean|lake|pond (default lake)") === "ocean|lake|pond" && ctx.sigEnum("toggle|open|close|destroy") === "toggle|open|close|destroy" && ctx.sigEnum("house|tower|castle_wall|gatehouse|bridge|staircase|spiral_staircase") === null && ctx.sigEnum("a plain sentence") === null && ctx.sigEnum("layout kind (list, grid, page) default list") === "list|grid|page" && ctx.sigEnum("one of: up, down") === "up|down" && ctx.sigEnum("the part (anchored or not)") === null);
const tw = ctx.sigFromLine(skillLines.find((l) => /^terrain_water:/.test(l)));
ok("C2 terrain_water signature carries kind:ocean|lake|pond", /kind:ocean\|lake\|pond\?/.test(tw), tw);
const withEnum = [...S20.text.matchAll(/[a-z_]+ \{[^}]*:[a-z0-9_]+\|[a-z0-9_|]+[^}]*\}/g)].length;
ok("C3 the 24k catalogue now carries >= 14 signatures with an inline enum (was 1; only ~32 descriptions list <= 6 options at all)", withEnum >= 14, withEnum);
const sigLines = S20.text.slice(S20.text.indexOf("SIGNATURES BY FAMILY"), S20.text.indexOf("NAMES ONLY")).split("\n");
ok("C4 optional tails are capped (+N?) so no signature line exceeds 200 chars and no signature lists more than 8 optionals", sigLines.every((l) => l.length <= 200) && !/\{[^}]*(?:\?,[^}]*){9,}\}/.test(sigLines.join("\n")) && /\+\d+\?\}/.test(sigLines.join("\n")), sigLines.filter((l) => l.length > 200).slice(0, 2));
ok("C5 the HOW TO READ header documents the +N notation", /\+3 = three more optional parameters/.test(S20.text));

// ── D. registry hygiene ──────────────────────────────────────────────────────
const reg = TotalCommandRegistry;
for (const c of RobloxScriptSkills.SKILL_COMMANDS) reg.register({ id: c.name, name: c.name, description: c.description || "", category: c.category, parameters: c.inputSchema || c.parameters || { type: "object", properties: {} }, environment: "ROBLOX_STUDIO", aliases: c.aliases || [], examples: c.examples || [], virtual: true, hidden: c.hidden === true }, { replace: true });
const hidden = new Set(RobloxScriptSkills.SKILL_COMMANDS.filter((c) => c.hidden).map((c) => c.name));
ok("D1 main.js passes hidden into the registry and normalize() keeps it", /virtual:true,hidden:c\.hidden===true\}/.test(main) && reg.get("staircase_generate") && reg.get("staircase_generate").hidden === true);
const q = (s) => reg.search(s, { limit: 8 }).map((c) => c.id);
ok("D2 search('staircase' / 'bridge' / 'fence' / 'vehicle' / 'elevator') never returns a hidden stub", [...q("staircase"), ...q("bridge"), ...q("fence"), ...q("vehicle"), ...q("elevator"), ...q("gear")].every((id) => !hidden.has(id)), { staircase: q("staircase"), elevator: q("elevator") });
ok("D3 the real commands still rank (structure_build for staircase / bridge / fence, vehicle_build for vehicle)", q("staircase").includes("structure_build") && q("bridge").includes("structure_build") && q("fence").includes("structure_build") && q("vehicle").includes("vehicle_build"));
ok("D4 hidden commands stay callable by id (get) and searchable with includeHidden", !!reg.get("staircase_generate") && reg.search("staircase", { includeHidden: true }).some((c) => c.id === "staircase_generate"));

// ── E. constraints_clear ─────────────────────────────────────────────────────
const b = RobloxScriptSkills.buildLuau("constraints_clear", { path: "workspace.Rig" });
ok("E1 constraints_clear uses IsA('Constraint') (BaseConstraint never existed) and keeps Motor6D unless include_joints", b && !b.err && /IsA\('Constraint'\)/.test(b.code) && !/BaseConstraint/.test(b.code) && /not d:IsA\('Motor6D'\)/.test(b.code) && /local joints=false/.test(b.code));
ok("E2 constraints_clear {include_joints:true} destroys Motor6D too and the description says so", /local joints=true/.test(RobloxScriptSkills.buildLuau("constraints_clear", { path: "workspace.Rig", include_joints: true }).code) && /Motor6D rig joints are kept unless include_joints:true/.test(byName.get("constraints_clear").description));

console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-catalogue-ranking: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
