#!/usr/bin/env node
// ORscript 1.47.0 — Quality Gate pack.
//
// Static checks on src/core/skills/studio_quality.js (catalogue, registration in
// every bundle + codecraft.html, style guides, Luau shape), on main.js (local
// style_guide answer, Ask-mode ops, the QUALITY evidence gate, next-step hints,
// help topic), on config.js (Creation prompt teaches the gate in both budgets and
// the budgets still hold) and on the version pins. Runtime behaviour (audit
// scores, quality_fix, lighting, brief) runs in tests/quality-sim.py (lupa) and is
// invoked from here when python3 + lupa are available.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { spawnSync } = require("child_process");
process.chdir(path.join(__dirname, ".."));
let failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  -> " + extra}`); if (!cond) failed++; };
const read = (p) => fs.readFileSync(p, "utf8");
const VERSION = "1.62.0";
const PACK_VERSION = "1.47.0"; // the pack itself last changed in 1.47.0
const pack = read("src/core/skills/studio_quality.js"), main = read("src/core/main.js"), config = read("src/core/config.js"), readme = read("README.md");
const manifest = JSON.parse(read("manifest.json"));

// ── A. load the pack on top of the real skill chain ──
globalThis.window = globalThis; globalThis.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
const S = vm.runInThisContext("RobloxScriptSkills");
ok("pack registers six commands in order", JSON.stringify(S.QUALITY_COMMANDS) === JSON.stringify(["style_guide", "brief_set", "brief_get", "style_lighting_apply", "quality_audit", "quality_fix"]), JSON.stringify(S.QUALITY_COMMANDS));
ok("all six are SKILL_OPS with a catalogue entry carrying params + description", S.QUALITY_COMMANDS.every((n) => S.SKILL_OPS.includes(n) && S.SKILL_COMMANDS.some((c) => c.name === n && c.params && c.description.length > 80)));
ok("QUALITY_VERSION / pass score / 16 genres exported", S.QUALITY_VERSION === PACK_VERSION && S.QUALITY_PASS_SCORE === 85 && S.QUALITY_GENRES.length === 16 && typeof S.styleGuideLocal === "function" && typeof S.resolveStyleGenre === "function");
ok("genre aliases resolve (castle, neon, forest, snow, simulator, obby, beach, Sci-Fi, unknown)", ["castle", "neon", "forest", "snow", "simulator", "obby", "beach", "Sci-Fi", "nothing-here"].map((g) => S.resolveStyleGenre(g)).join() === "medieval,cyberpunk,nature,winter,cartoon,cartoon,tropical,scifi,", ["castle", "neon", "forest", "snow", "simulator", "obby", "beach", "Sci-Fi", "nothing-here"].map((g) => S.resolveStyleGenre(g)).join());
const sg = S.styleGuideLocal({ genre: "cyberpunk" });
ok("style_guide data: palette roles hex + rgb + color3, lighting recipe, ui tokens, recipe of 5", sg.ok && sg.data.palette.accent.hex === "#ff00aa" && sg.data.palette.accent.color3 === "Color3.fromRGB(255, 0, 170)" && sg.data.lighting.preset === "cyberpunk" && sg.data.ui.tokens_preset === "neon" && sg.data.recipe.length === 5, JSON.stringify(sg.data.palette.accent));
ok("every genre's recipe names brief_set, style_lighting_apply, design_tokens_set and quality_audit", S.QUALITY_GENRES.every((g) => { const r = S.styleGuideLocal({ genre: g }).data.recipe.join("\n"); return /brief_set/.test(r) && /style_lighting_apply/.test(r) && /design_tokens_set/.test(r) && /quality_audit/.test(r); }));
ok("no two genres share the same base colour", new Set(S.QUALITY_GENRES.map((g) => S.styleGuideLocal({ genre: g }).data.palette.base.hex)).size === 16);
for (const [op, args] of [["quality_audit", {}], ["quality_audit", { path: "Workspace.Castle", scope: "build" }], ["quality_fix", { fixes: ["anchor", "ui"], dry_run: true }], ["brief_set", { title: "X", genre: "horror" }], ["brief_get", {}], ["style_lighting_apply", { genre: "space" }], ["style_guide", { genre: "cozy" }]]) {
  const b = S.buildLuau(op, args);
  ok(`${op} builds Luau with the prelude, a pcall wrapper and JSON result helpers`, b && b.code && /^local HttpService=game:GetService\('HttpService'\)/.test(b.code) && /local okRun,resRun=pcall\(function\(\)/.test(b.code) && /local function ok\(d,t\)/.test(b.code) && !/\bcontinue\b/.test(b.code) && !/\+=/.test(b.code), b && (b.err || b.code.slice(0, 120)));
}
ok("quality_audit Luau checks the documented families", ["isDefaultGrey", "monotone_material", "flat_palette", "boxy", "unanchored", "no_primary_part", "default_names", "loose_parts", "off_brief_palette", "lighting_untouched", "no_atmosphere", "no_post_stack", "raw_default_frames", "legacy_borders", "no_uicorner", "default_font", "unscaled_text", "offset_only_roots", "no_layout", "legacy_wait", "localscript_in_server", "localplayer_in_server", "datastore_without_pcall", "modules_without_strict", "debug_prints", "script_default_names"].every((k) => pack.includes(k)));
ok("quality_audit skips Humanoid models, Terrain, Baseplate and OR_GFX; score = 100 - deductions; grade bands", pack.includes("inHumanoid(d)") && pack.includes("n=='OR_GFX' or n=='Terrain'") && pack.includes("d.Name=='Baseplate'") && pack.includes("local score=math.max(0,100-ded)") && pack.includes("(score>=90 and 'A') or (score>=80 and 'B')"));
ok("every finding carries severity, weight, message, fix and examples", /F\[#F\+1\]=\{severity=sev,kind=kind,weight=w,message=msg,fix=fix,examples=paths\}/.test(pack));
ok("quality_fix is undoable (ChangeHistoryService recording) and never anchors seats / jointed parts", pack.includes("wp('ORscript quality_fix')") && pack.includes("not d:FindFirstChildWhichIsA('JointInstance')") && pack.includes("not d:IsA('Seat')"));
ok("brief lives in ServerStorage._ORBrief and the audit reads it", pack.includes("ServerStorage:FindFirstChild('_ORBrief')") && pack.includes("local brief=briefRead()"));
ok("style_lighting_apply reuses OR_Atmosphere / OR_Bloom / OR_ColorCorrection instead of stacking", pack.includes("one('Atmosphere','OR_Atmosphere'") && pack.includes("one('BloomEffect','OR_Bloom'") && pack.includes("one('ColorCorrectionEffect','OR_ColorCorrection'") && pack.includes("e:SetAttribute('OR_Style',A.genre)"));
ok("pack is Luau-literal-safe (no backticks / template interpolation inside generated Lua)", !/\$\{[^}]*\}[^`]*\n[^`]*end\)/.test(pack.split("const HEAD")[1].split("const B = {}")[0].replace(/\$\{q\(QUALITY_VERSION\)\}|\$\{PASS_SCORE\}/g, "")));

// ── B. registration ──
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("every main.js bundle loads studio_quality.js after studio_project.js and before main.js", bundles.length >= 10 && bundles.every((b) => { const i = b.js.indexOf("src/core/skills/studio_project.js"); return i >= 0 && b.js[i + 1] === "src/core/skills/studio_quality.js" && b.js.indexOf("src/core/main.js") > i + 1; }));
ok("codecraft.html loads the pack after studio_project.js", (() => { const h = read("codecraft.html"); return h.indexOf("studio_quality.js") > h.indexOf("studio_project.js") && h.indexOf("studio_quality.js") < h.indexOf("src/core/main.js"); })());

// ── C. main.js wiring ──
ok("style_guide is answered locally (no Studio round-trip) and still reaches __rsAfterTool", main.includes('if (name === "style_guide" && typeof RobloxScriptSkills.styleGuideLocal === "function") {') && main.includes("const res0 = `Output of 'style_guide':\\n${JSON.stringify(r)}`;"));
ok("quality_fix / style_lighting_apply / brief_set are Ask-mode ops", /"quality_fix","style_lighting_apply","brief_set",/.test(main));
const gateBlock = main.slice(main.indexOf("  const MODE_GATES = {"), main.indexOf("  // 1.38.0: skill programs that legitimately run long"));
const gctx = { window: { __rsWorkMode: () => "creation" }, normalizeWorkMode: () => "creation", bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "CREATION" } } };
vm.createContext(gctx); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", gctx);
const G = (names) => gctx.modeGateNudge(new Set(names));
ok("QUALITY gate is the fourth creation gate", gctx.MODE_GATES.creation.map((g) => g.id).join() === "scripts,look,motion,quality");
ok("quality gate fires for generators / screens / blueprints without quality_audit", /- QUALITY: you built or generated content/.test(G(["model_build", "or_screenshot"])) && /- QUALITY:/.test(G(["ui_screen_generate", "or_screenshot"])) && /- QUALITY:/.test(G(["blueprint_install", "blueprint_verify"])));
ok("quality gate is silenced by quality_audit and never trips on small edits", !/QUALITY:/.test(G(["model_build", "or_screenshot", "quality_audit"])) && G(["part_create", "material_set", "or_screenshot"]) === "" && G(["multi_edit", "script_read", "script_check"]) === "" && G(["quality_fix", "quality_audit"]) === "");
ok("the nudge demands >= 85 and the score in the report", /re-run until the score is >= 85 and put the score in the report/.test(gateBlock));
ok("next-step hints route to the gate", main.includes('quality_audit: "Next: quality_fix for the mechanical findings, then quality_audit again until >= 85"') && main.includes('_default: "Next: quality_audit for a 0-100 score, diagnostics_audit for health"') && main.includes('style_guide: "Next: brief_set {title, genre}'));
ok("orscript_help has a quality topic with aliases", main.includes('quality:{title:"Quality Gate (1.47 quality pack)"') && /quality:\/quality\|audit score\|style guide\|art direction\|palette\|brief\|/.test(main));

// ── D. prompts + budgets ──
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
const full = RS.WORK_MODE_PROMPTS.creation.full, tight = RS.WORK_MODE_PROMPTS.creation.tight;
ok("full profile carries the QUALITY GATE (art direction first + score before hand-off) and the 16 genres", /QUALITY GATE \(1\.47 quality pack/.test(full) && /ART DIRECTION FIRST: before the first build \/ UI \/ lighting command run style_guide \{genre\}/.test(full) && /SCORE BEFORE YOU HAND OFF: quality_audit \{path\}/.test(full) && /quality_audit again until score ≥ 85/.test(full) && /medieval, fantasy, scifi, cyberpunk, horror, cozy, nature, desert, winter, tropical, city, cartoon/.test(full));
ok("full HAND-OFF and NEVER list include the score", /and always the final quality_audit score\./.test(full) && /a build, screen or system handed off without a quality_audit score ≥ 85/.test(full));
ok("tight profile has a one-line QUALITY GATE and the NEVER item", /^QUALITY GATE: style_guide \{genre\} \+ brief_set before the first build \/ UI \/ lighting command/m.test(tight) && /re-audit until ≥ 85; report the score\./.test(tight) && /no quality_audit score\.`?$/m.test(tight.trim()));
ok("checklist reminder names the gate", /style_guide \+ brief_set before building, quality_audit ≥ 85 before hand-off\.$/.test(RS.workModeChecklist("creation")));
const pb = RS.WORK_MODE_PLAYBOOKS.creation;
ok("BUILD / UI SCREEN / NEW SYSTEM playbooks route through quality_audit; still twelve", (pb.match(/^- [A-Z]/gm) || []).length === 12 && /- BUILD: .*style_guide \{genre\} \+ brief_set .*quality_audit \{path\} → quality_fix → re-audit ≥ 85 .*polish\.$/m.test(pb) && /- UI SCREEN: style_guide \{genre\} → design_tokens_set .*quality_audit \{path\} ≥ 85 → or_screenshot → fix what it shows\.$/m.test(pb) && /- NEW SYSTEM: .*quality_audit \{scope:"scripts"\} ≥ 85 → start_stop_play \+ get_console_output → report\.$/m.test(pb));
window.__rsWorkMode = () => "creation";
const sizes = { full: RS.workModePrompt("creation").length, tight: RS.workModePrompt("creation", { tight: true }).length, chatgpt: RS.buildSystemPrompt({ siteName: "chatgpt", providerId: "chatgpt", engine: "roblox", maxChars: 14000 }).length, gemini: RS.buildSystemPrompt({ siteName: "gemini", providerId: "gemini", engine: "roblox" }).length };
ok(`budgets hold: tight ${sizes.tight} < 3600, full ${sizes.full} < 18500, ChatGPT ${sizes.chatgpt} <= 14000, Gemini ${sizes.gemini} < 48000`, sizes.tight < 3600 && sizes.full < 18500 && sizes.chatgpt <= 14000 && sizes.gemini < 48000, JSON.stringify(sizes));

// ── E. version pins + docs ──
ok(`manifest / plugin / crate pinned at ${VERSION}`, manifest.version === VERSION && read("plugin/ORscript.lua").includes(`local VERSION = "${VERSION}"`) && new RegExp('^version = "' + VERSION.replace(/\./g, "\\.") + '"', "m").test(read("agent/Cargo.toml")));
ok("README changelog opens with 1.47.0 and documents the six commands", /\*\*1\.47\.0 — /.test(readme) && readme.indexOf("**1.47.0 — ") < readme.indexOf("**1.46.0 — ") && ["style_guide", "brief_set", "brief_get", "style_lighting_apply", "quality_audit", "quality_fix"].every((n) => readme.includes("`" + n)));

// ── F. runtime (lupa) ──
const py = spawnSync("python3", ["-c", "import lupa"], { encoding: "utf8" });
if (py.status === 0) {
  const sim = spawnSync("python3", ["tests/quality-sim.py"], { encoding: "utf8", timeout: 120000 });
  const tail = (sim.stdout || "").trim().split("\n").slice(-1)[0];
  ok("tests/quality-sim.py passes in the Roblox simulator (" + tail + ")", sim.status === 0 && /^\d+\/\d+ checks passed$/.test(tail), (sim.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 600) || sim.stderr);
} else {
  console.log("SKIP  lupa not installed - runtime simulation skipped (pip install lupa)");
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall quality pack checks passed");
process.exit(0);
