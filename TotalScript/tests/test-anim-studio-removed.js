// 2.0.3 — The Animation Studio window (src/core/animstudio.js) was removed because it broke animation
// creation: tool results, a stub hint and the help text steered the AI toward "open the Animation Studio"
// instead of building the clip. This test pins (A) that nothing of the window is left anywhere the
// browser or the AI can see it, (B) that the AI-facing texts no longer steer toward a window, and
// (C) that the animation_* commands + the main.js engine dispatcher still work without it.
// Run: node tests/test-anim-studio-removed.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const exists = (f) => fs.existsSync(path.join(R, f));
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); } };

const main = read("src/core/main.js"), css = read("overlay.css"), manifest = JSON.parse(read("manifest.json")), html = read("codecraft.html");
const animlib = read("src/core/animlib.js"), animengine = read("src/core/animengine.js");

// ── A. the module and every reference to it are gone ──
ok("A1 src/core/animstudio.js no longer exists", !exists("src/core/animstudio.js"));
const lists = manifest.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/animlib.js")); // the 11 provider bundles (the rest are tiny helper scripts)
ok("A2 no manifest bundle loads animstudio.js (11 bundles)", lists.length === 11 && lists.every((js) => !js.some((f) => /animstudio/.test(f))));
ok("A3 codecraft.html does not load it", !/animstudio/.test(html));
ok("A4 the engine + animlib still load in every bundle, in order (animlib → animengine → … → reasoning → … → videostudio → main)", lists.every((js) => {
  const i = (f) => js.indexOf("src/core/" + f);
  return i("animlib.js") >= 0 && i("animengine.js") > i("animlib.js") && i("reasoning.js") > i("animengine.js") && i("videostudio.js") > i("reasoning.js") && i("main.js") === i("videostudio.js") + 1;
}));
ok("A5 main.js: no TotalAnimStudio / __rsOpenAnimStudio / openAnimStudio / studioRunTool / #rs-anim-btn / Ctrl+Shift+K", !/TotalAnimStudio|__rsOpenAnimStudio|openAnimStudio|studioRunTool|rs-anim-btn|rs-anim"|Shift\+K/.test(main));
ok("A6 main.js: no Ctrl/⌘+Shift+K keydown listener is registered", !/e\.key === "K" \|\| e\.key === "k"/.test(main));
ok("A7 overlay.css: the #rs-anim host, .rsa-* classes, rs-anim-open and #rs-anim-btn are gone", !/#rs-anim\b|\.rsa-|rs-anim-open|#rs-anim-btn|#rs-anim \{/.test(css));
ok("A8 overlay.css: the bar-button chain now reads settings / enhance / video (2.0.4: paint left too)", (css.match(/:is\(:is\(#rs-settings-btn, #rs-enhance-btn\), #rs-video-btn\)/g) || []).length >= 20);
ok("A9 the bar still has Enhancer, Video and Settings buttons in that order", main.indexOf('id="rs-enhance-btn"') > 0 && main.indexOf('id="rs-video-btn"') > main.indexOf('id="rs-enhance-btn"') && main.indexOf('id="rs-settings-btn"') > main.indexOf('id="rs-video-btn"'));
const srcFiles = [];
(function walk(d) { for (const e of fs.readdirSync(path.join(R, d), { withFileTypes: true })) { const p = d + "/" + e.name; if (e.isDirectory()) { if (!/node_modules|target|__pycache__/.test(e.name)) walk(p); } else if (/\.(js|html|css|json)$/.test(e.name)) srcFiles.push(p); } })("src");
["manifest.json", "codecraft.html", "overlay.css", "popup.js", "popup.html", "background.js"].forEach((f) => { if (exists(f)) srcFiles.push(f); });
const leftovers = srcFiles.filter((f) => /animstudio|TotalAnimStudio|__rsOpenAnimStudio/.test(read(f)));
ok("A10 no shipped source file references the module or its globals", leftovers.length === 0, leftovers);

// ── B. nothing the AI reads steers it toward a window ──
const promptSources = ["src/core/config.js", "src/core/animlib.js", "src/core/animengine.js", "src/core/skill_intel.js", "src/core/skill_refs.js", "src/core/work_modes.js", "src/core/public_skills.js"].filter(exists).concat(fs.readdirSync(path.join(R, "src/core/skills")).map((f) => "src/core/skills/" + f));
const steer = promptSources.filter((f) => /Animation Studio|animation studio|Anim Studio/.test(read(f).replace(/ANIMATION STUDIO HAND-OFF/g, "")));
ok("B1 prompt / skill / catalogue sources never mention an Animation Studio window", steer.length === 0, steer);
ok("B2 studio_100 stub hint for character_emote_play names a registry command, not a window", /character_emote_play: "animation_motion_preset",/.test(read("src/core/skills/studio_100.js")));
ok("B3 main.js tool-result texts: the offline notes tell the AI to reconnect + animation_build / animation_export_rbxmx (no bar button, no shortcut)", main.includes('Reconnect Studio and run animation_build {name: "${"%NAME%"}"}, or animation_export_rbxmx {name} to hand the user a file.') && /animation_build \{name\} per clip, or animation_export_rbxmx \{name\} for each/.test(main) && !/Open the Animation Studio/.test(main));
ok("B4 main.js help / comments: 'Animation Studio' only survives nowhere", !/Animation Studio/.test(main));
ok("B5 animlib still advertises the engine commands as the FIRST CHOICE (the AI writes the animation through them)", /FIRST CHOICE/.test(animlib) && ["animation_generate", "animation_refine", "animation_sequence", "animation_set", "animation_compatibility", "animation_polish", "animation_layer", "animation_validate", "animation_export_rbxmx", "animation_build"].every((c) => animlib.includes(c)));

// ── C. the commands and the dispatcher still work without the window ──
const E = require(path.join(R, "src/core/animengine.js"));
const RSAnim = vm.runInNewContext(animlib + "\nRSAnim", { console });
const clip = E.generate("heavy two-handed slam", { quality: "balanced", rigType: "R15" });
ok("C1 engine still generates a validated clip", clip && clip.keys.length >= 4 && clip.report && clip.report.ok === true, clip && clip.report);
ok("C2 engine exposes no studio-only surface and keeps the command-facing API", typeof E.generate === "function" && typeof E.setInterp === "function" && typeof E.toBuildArgs === "function" && typeof E.toRbxmx === "function" && !("openStudio" in E));
const start = main.indexOf("  // ── 1.52.0 ANIMATION ENGINE (src/core/animengine.js)"), end = main.indexOf("  async function runTool(call) {");
ok("C3 dispatcher block found in main.js", start > 0 && end > start);
const block = main.slice(start, end);
ok("C4 dispatcher keeps clips in session memory only (A.animClips + animRemember(clip)) and never hands them to an overlay", /A\.animClips = A\.animClips \|\| \{\};/.test(block) && /function animRemember\(clip\) \{/.test(block) && (block.match(/animRemember\(\w+\)/g) || []).length >= 20 && !/loadClip|loadSet/.test(block));
function makeCtx(studio) {
  const log = [];
  const ctx = {
    TotalAnimEngine: E, RSAnim, A: { stop: false }, console,
    document: { createElement: () => ({ click() { log.push("download"); }, set href(v) {}, set download(v) { log.push("file:" + v); } }) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: function (parts) { this.size = String(parts[0]).length; },
    setTimeout: () => 0,
    runSkillLuau: async (built, budget) => {
      const body = built.body || built.code;
      const op = (body.match(/local OP = "([a-z_]+)"/) || body.match(/"op"\s*:\s*"([a-z_]+)"/) || [, "?"])[1];
      log.push("luau:" + op);
      if (studio.offline) return "ERROR calling 'execute_luau': STUDIO_BRIDGE_OFFLINE: total-core is not running";
      if (op === "rig_info") return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, data: studio.rig, text: "rig" });
      if (op === "build") { studio.builds.push(body.length); return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, data: { name: "x", keyframes: 9, bones: 15, path: "ServerStorage.RobloxScript.AnimLib.x", length: 1.2 }, text: "built" }); }
      return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, text: "ok" });
    },
    log,
  };
  vm.createContext(ctx);
  vm.runInContext(block + "\nglobalThis.__run = runAnimEngine;", ctx);
  return ctx;
}
const R15RIG = { rigType: "R15", path: "Workspace.Rig", name: "Rig", root: "HumanoidRootPart", bones: ["LowerTorso", "UpperTorso", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm", "RightLowerArm", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"].map((b) => ({ name: b, parent: "x", kind: "Motor6D" })), animations: [] };
(async () => {
  let c = makeCtx({ rig: R15RIG, builds: [] });
  let out = await c.__run("generate", { prompt: "looping idle with calm breathing", quality: "balanced" });
  ok("C5 online: animation_generate builds through rig_info + build and reports BUILT", /BUILT in Studio/.test(out) && c.log.includes("luau:rig_info") && c.log.includes("luau:build"), out.slice(0, 200));
  ok("C6 online: the clip is remembered for follow-up commands", Object.keys(c.A.animClips).length === 1 && c.A.animLast === Object.keys(c.A.animClips)[0]);
  out = await c.__run("refine", { feedback: "smoother, a bit slower" });
  ok("C7 online: animation_refine works on the remembered clip", /Applied|Before → after|before → after/i.test(out) && !/ERROR/.test(out), out.slice(0, 200));
  out = await c.__run("export_rbxmx", {});
  ok("C8 animation_export_rbxmx still downloads a file", /Saved .*\.rbxmx/.test(out) && c.log.includes("download"), out.slice(0, 200));
  c = makeCtx({ rig: R15RIG, builds: [], offline: true });
  out = await c.__run("generate", { prompt: "heavy two-handed slam" });
  ok("C9 offline: generated + validated, NOT built, and the note points at animation_build / animation_export_rbxmx - never at a window or shortcut", /NOT built/.test(out) && /animation_build/.test(out) && /animation_export_rbxmx/.test(out) && !/Animation Studio|Ctrl\+Shift\+K|bar button/.test(out), out.slice(0, 400));
  out = await c.__run("set", { prompts: ["idle", "walk"] });
  ok("C10 offline: animation_set keeps every clip in memory and its note names the commands only", Object.keys(c.A.animClips).length >= 3 && !/Animation Studio/.test(out) && /animation_build/.test(out), out.slice(0, 300));
  console.log(`test-anim-studio-removed: ${n} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
