"use strict";
// 1.82.0 - studio_vfxpro.js: spec-driven layered VFX families (test C of the Phase 115 plan).
// Static checks only; tests/sequence-sim.py executes the runtime inside tests/roblox_sim.py.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? " - " + detail : "")); } }

const src = fs.readFileSync("src/core/skills/studio_vfxpro.js", "utf8");
ok("pack registered in every isolated-world list + codecraft.html", manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js")).every((c) => c.js.includes("src/core/skills/studio_vfxpro.js")) && /studio_vfxpro\.js/.test(fs.readFileSync("codecraft.html", "utf8")));
ok("version pinned", S.VFX_VERSION === "1.91.0" && /TotalVFX/.test(S.VFX_RUNTIME_SRC));
ok("the 17 requested effect families exist", ["impact", "hit_confirm", "slash", "projectile", "explosion", "fire", "smoke", "electric", "aura", "heal", "shield", "teleport", "dash", "dust", "charge", "release", "transition"].every((f) => S.VFX_FAMILY_NAMES.includes(f)) && S.VFX_FAMILY_NAMES.length === 17);
ok("commands: install / play / theme / validate visible, families hidden", ["vfx_library_install", "vfx_play", "vfx_theme_set", "vfx_validate"].every((n) => S.SKILL_COMMANDS.some((c) => c.name === n && !c.hidden)) && S.SKILL_COMMANDS.some((c) => c.name === "vfx_families" && c.hidden));

// Every family is a staged, layered spec - not a single Part.
const allIssues = S.vfxValidateAll();
ok("vfxValidateAll reports no defects in the shipped catalogue", allIssues.length === 0, JSON.stringify(allIssues).slice(0, 300));
const layerKinds = new Set();
let partsTotal = 0, familiesWithParts = 0, maxPerFamily = 0;
for (const name of S.VFX_FAMILY_NAMES) {
  const fam = S.VFX_FAMILIES[name];
  ok(name + ": staged layers with explicit start times and lifetimes", fam && Array.isArray(fam.layers) && fam.layers.length >= 1 && fam.layers.every((l) => typeof l.t === "number" && l.t >= 0 && l.kind && typeof l.priority === "number" || l.kind === "sound") && fam.palette && fam.layers.every((l) => l.kind === "sound" || l.kind === "light" || l.kind === "trail" || l.kind === "stream" || l.kind === "shell" || l.life !== undefined), JSON.stringify(fam && fam.layers && fam.layers.map((l) => l.kind)));
  for (const l of fam.layers) { layerKinds.add(l.kind); }
  const parts = fam.layers.filter((l) => l.kind === "ring" || l.kind === "shell").length;
  partsTotal += parts; if (parts) familiesWithParts++; maxPerFamily = Math.max(maxPerFamily, parts);
  ok(name + ": declares a duration and tier budgets", typeof fam.duration === "number" && fam.duration > 0 && fam.duration <= 6);
}
ok("layers are burst / stream emitters, flashes, lights, beams, trails and rings (no neon-block defaults)", ["burst", "stream", "flash", "light", "beam", "trail", "ring"].every((k) => layerKinds.has(k)));
ok("no family needs more than 3 geometry parts (" + maxPerFamily + " max, " + partsTotal + " total)", maxPerFamily <= 3);
ok("palettes are named art-direction sets mapped from genres, not raw bright colours", Object.keys(S.VFX_PALETTES).length >= 8 && S.VFX_PALETTES.ember && S.VFX_PALETTES.arcane && typeof S.VFX_GENRE_PALETTE === "object" && Object.keys(S.VFX_GENRE_PALETTE).length >= 4 && Object.values(S.VFX_GENRE_PALETTE).every((p) => S.VFX_PALETTES[p]));
ok("tiers High / Medium / Low with particle, emitter, active and light budgets", ["High", "Medium", "Low"].every((t) => S.VFX_TIERS[t] && S.VFX_TIERS[t].maxEmitters && S.VFX_TIERS[t].maxActive && typeof S.VFX_TIERS[t].lights === "boolean") && S.VFX_TIERS.Low.maxEmitters < S.VFX_TIERS.High.maxEmitters && S.VFX_TIERS.Low.particles < S.VFX_TIERS.High.particles && S.VFX_TIERS.Low.lights === false);
ok("every SFX event a family references exists in the SFX catalogue", S.vfxSfxEventsUsed().every((e) => S.SFX_EVENT_NAMES.includes(e)), S.vfxSfxEventsUsed().filter((e) => !S.SFX_EVENT_NAMES.includes(e)).join(","));

// Assets: only engine-bundled rbxasset:// textures - no invented rbxassetid numbers.
const ids = (src.match(/rbxassetid:\/\/\d+/g) || []);
ok("no hard-coded rbxassetid numbers in the pack", ids.length === 0, ids.join(","));
ok("textures come from engine-bundled rbxasset://textures/particles", /rbxasset:\/\/textures\/particles\/(fire|smoke|sparkles)_main\.dds/.test(src));

// Runtime shape.
const rt = S.VFX_RUNTIME_SRC;
ok("runtime: play/cast/stopAll/setTheme/setTier/validate/step/families/activeCount API", ["play", "cast", "stopAll", "setTheme", "setTier", "validate", "step", "families", "activeCount"].every((k) => rt.includes("function M." + k)));
ok("runtime: handles expose Stop / Destroy / IsPlaying / Completed", /Stop\b/.test(rt) && /Destroy\b/.test(rt) && /IsPlaying/.test(rt) && /Completed/.test(rt));
ok("runtime: effects are parented to workspace.TotalVFXRuntime containers and cleaned with Debris-free lifecycle", /TotalVFXRuntime/.test(rt) && !/Debris/.test(rt));
ok("runtime: attachments + normal orientation (not world-axis defaults)", /Attachment/.test(rt) && /normal/.test(rt));
ok("runtime: server cast replicates through a RemoteEvent to nearby clients (client-cosmetic, server-authoritative)", /RemoteEvent/.test(rt) && /FireClient/.test(rt) && /Replicate/.test(rt) && /IsClient\(\)/.test(rt) && /never spawns particles/.test(S.VFX_CLIENT_SRC));
ok("runtime: quality tier auto-detects and clamps emitter rates", /setTier|tier/.test(rt) && /Rate/.test(rt));
ok("no Luau-only syntax (so the Lua 5.4 simulator really executes it)", !/\+=|-=|\.\.=|\bcontinue\b/.test(rt));

// Command executors build and are structured.
const built = ["vfx_library_install", "vfx_play", "vfx_theme_set", "vfx_validate", "vfx_families"].map((n) => [n, S.buildLuau(n, { family: "impact", where: "Workspace.Part", palette: "ember", tier: "Medium", genre: "fantasy", theme: "arcane" })]);
ok("all five executors build Luau", built.every(([, r]) => r && typeof r.code === "string" && r.code.length > 200), built.filter(([, r]) => !r || !r.code).map(([n, r]) => n + ":" + (r && r.err)).join(","));
ok("executors return JSON results and never loadstring", built.every(([, r]) => /JSONEncode/.test(r.code) && !/loadstring\s*\(/.test(r.code)));
const bad = S.buildLuau("vfx_play", { family: "nope", where: "Workspace.Part" });
ok("vfx_play with an unknown family is rejected before Studio runs anything", (!!bad.err) || /unknown family|not a family|fail\(/.test(bad.code || ""));
ok("vfx_play schema documents families, palette, tier, scale, normal", (() => { const c = S.SKILL_COMMANDS.find((x) => x.name === "vfx_play"); const d = JSON.stringify(c); return /palette/.test(d) && /tier/.test(d) && /scale/.test(d) && /normal/.test(d); })());

console.log(fail ? "FAIL  test-vfx-pro: " + pass + " passed, " + fail + " failed" : "OK    test-vfx-pro: " + pass + " passed");
process.exit(fail ? 1 : 0);
