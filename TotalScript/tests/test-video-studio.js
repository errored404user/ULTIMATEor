// 1.79.0 — Video Studio: a local video → keyframes + contact sheet + VIDEO BRIEF
// → the AI recreates it. The analysis (shot cuts, block-motion camera labels,
// HUD-like static overlay, flashes, loop detection, kind classifier, keyframe
// picking, palette) is pure over small grayscale samples, so it is exercised
// here on synthetic clips rendered pixel by pixel - no video element needed.
// The window is smoke-tested in jsdom (no canvas there, so decode/send paths
// are not driven). Run: NODE_PATH=/tmp/harness/node_modules node tests/test-video-studio.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
process.chdir(root);
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra !== undefined ? "  →  " + String(extra).slice(0, 240) : "")); } };

// ── 1. pure engine ───────────────────────────────────────────────────────────
global.window = global; global.document = {};
vm.runInThisContext(read("src/core/videostudio.js"));
const V = window.TotalVideoStudio;
ok("module exports the engine + window API", V && V.VERSION === "1.79.0" && ["open", "close", "isOpen", "analyze", "detectShots", "blockMotion", "cameraLabel", "staticOverlay", "classifyKind", "pickKeyframes", "palette", "buildMessage", "sampleFromCanvasData", "contactSheet", "decodeFile"].every((k) => typeof V[k] === "function") && V.KIND_IDS.length === 6);

const W = 160, H = 90;
function frame(t, px) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = px(x, y); const p = (y * W + x) * 4; data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255; }
  return V.sampleFromCanvasData(data, W, H, t);
}
const noise = (x, y) => ((x * 73856093) ^ (y * 19349663)) % 97;
const scene = (ox, oy) => (x, y) => { const v = 80 + noise(((x + ox) % W + W) % W, ((y + oy) % H + H) % H); return [v * 0.6, v * 0.7, v]; };
const withHud = (fn) => (x, y) => {
  if (y < 12 && x < 60) return ((x + y) % 4 < 2) ? [255, 255, 255] : [20, 20, 20];
  if (y > H - 12 && x > W - 60) return ((x * y) % 5 < 2) ? [250, 220, 80] : [30, 30, 30];
  return fn(x, y);
};

// Clip 1: HUD over a scene; the camera holds 3 s then pans right 3 s (content slides left).
const c1 = []; for (let i = 0; i <= 24; i++) { const t = i * 0.25; c1.push(frame(t, withHud(t < 3 ? scene(0, 0) : scene(Math.round((t - 3) * 8), 0)))); }
const a1 = V.analyze(c1, { duration: 6 });
ok("clip 1: one shot (no cut) whose camera row reads static → pan right with time ranges", a1.ok && a1.shots.length === 1 && /^static \(0\.0 s-3\.0 s\) \u2192 pan right \(3\.0 s-6\.0 s\)$/.test(a1.shots[0].camera), a1.shots.map((s) => s.camera).join(" | "));
ok("clip 1: the HUD in two corners is found as a static overlay (top-left + bottom-right), not the whole frame", a1.overlay.fraction > 0.05 && a1.overlay.fraction < 0.4 && a1.overlay.regions.includes("top-left") && a1.overlay.regions.includes("bottom-right"), JSON.stringify(a1.overlay));
ok("clip 1: camera moves in about half the clip, no subject motion, no flashes, no loop", a1.features.cameraFraction >= 0.4 && a1.features.cameraFraction <= 0.6 && a1.features.subjectFraction === 0 && a1.features.flashiness === 0 && !a1.features.loops, JSON.stringify(a1.features));
ok("clip 1: keyframes start with the opening frame, are sorted and cover the pan", a1.keyframes[0].index === 0 && a1.keyframes.every((k, i, arr) => !i || k.index > arr[i - 1].index) && a1.keyframes.some((k) => k.t >= 3.5), JSON.stringify(a1.keyframes));

// Clip 2: static camera, a red square sweeps back and forth over a textured background (loops).
const c2 = []; for (let i = 0; i <= 24; i++) { const t = i * 0.25; const cx = 40 + Math.round(60 * (0.5 - 0.5 * Math.cos((t / 3) * Math.PI * 2))); c2.push(frame(t, (x, y) => (Math.abs(x - cx) < 10 && Math.abs(y - 45) < 10) ? [230, 60, 60] : scene(0, 0)(x, y))); }
const a2 = V.analyze(c2, { duration: 6 });
ok("clip 2: subject motion with a held camera classifies as ANIMATION and loops", a2.kind.kind === "animation" && a2.features.loops === true && a2.features.subjectFraction >= 0.6 && a2.features.cameraFraction === 0, JSON.stringify({ kind: a2.kind, f: a2.features }));
ok("clip 2: a static textured background is NOT reported as a HUD overlay in the reasons", !a2.kind.reasons.some((r) => /static overlay/.test(r)), a2.kind.reasons.join(" | "));

// Clip 3: three differently coloured scenes, each zooming in, hard cuts at 2 s and 4 s.
const c3 = []; for (let i = 0; i <= 30; i++) { const t = i * 0.2; const shot = Math.floor(t / 2); const z = 1 + ((t % 2) / 2) * 0.5; c3.push(frame(t, (x, y) => { const sx = Math.round((x - W / 2) / z + W / 2), sy = Math.round((y - H / 2) / z + H / 2); const v = noise(((sx + shot * 37) % W + W) % W, ((sy + shot * 11) % H + H) % H); return shot === 0 ? [v * 2, v, v] : shot === 1 ? [v, v * 2, v] : [v, v, v * 2]; })); }
const a3 = V.analyze(c3, { duration: 6 });
ok("clip 3: both hard cuts are found (3 shots at 0 / 2 / 4 s) and each shot reads zoom in", a3.shots.length === 3 && a3.shots[1].start === 2 && a3.shots[2].start === 4 && a3.shots.every((s) => s.camera === "zoom in"), JSON.stringify(a3.shots.map((s) => [s.start, s.end, s.camera])));
ok("clip 3: classified CUTSCENE with high confidence; the last shot runs to the clip end", a3.kind.kind === "cutscene" && a3.kind.confidence >= 0.8 && a3.shots[2].end === 6, JSON.stringify(a3.kind));

// Clip 4: a light burst flashes every second over a static scene.
const c4 = []; for (let i = 0; i <= 24; i++) { const t = i * 0.25; const flash = i % 4 === 0; c4.push(frame(t, (x, y) => { const d = Math.hypot(x - 80, y - 45); if (flash && d < 30 + noise(x, y) % 10) return [255, 200, 80]; return scene(0, 0)(x, y); })); }
const a4 = V.analyze(c4, { duration: 6 });
ok("clip 4: repeated brightness bursts classify as VFX", a4.kind.kind === "vfx" && a4.features.flashiness >= 0.4, JSON.stringify({ kind: a4.kind, flash: a4.features.flashiness }));

// Clip 5: a flat dark menu with a title bar and two buttons, held still.
const c5 = []; for (let i = 0; i <= 12; i++) c5.push(frame(i * 0.5, (x, y) => { if (y > 20 && y < 30 && x > 50 && x < 110) return [240, 240, 240]; if ((y > 40 && y < 48 || y > 55 && y < 63) && x > 60 && x < 100) return (x % 3) ? [200, 200, 200] : [40, 40, 40]; return [20, 22, 30]; }));
const a5 = V.analyze(c5, { duration: 6 });
ok("clip 5: a still, flat screen with crisp edges classifies as GUI", a5.kind.kind === "gui" && a5.features.flatness >= 0.6 && a5.features.avgMotion < 1, JSON.stringify({ kind: a5.kind, f: a5.features }));
ok("clip 5: palette lists the dark background first with its area share", a5.palette.length >= 2 && a5.palette[0].hex === "#202020" && a5.palette[0].share > 50, JSON.stringify(a5.palette));

// Clip 6: a textured scene held still - a MAP, not a GUI (texture everywhere, nothing flat).
const c6 = []; for (let i = 0; i <= 12; i++) c6.push(frame(i * 0.5, scene(0, 0)));
const a6 = V.analyze(c6, { duration: 6 });
ok("clip 6: a still textured scene classifies as MAP", a6.kind.kind === "map" && a6.features.flatness < 0.6, JSON.stringify({ kind: a6.kind, flat: a6.features.flatness }));

ok("empty input is an honest failure, not a crash", V.analyze([]).ok === false && V.analyze(null).ok === false);
ok("cameraLabel: null motion is static; pan direction follows the content slide (content left ⇒ camera pans right)", V.cameraLabel(null, 0) === "static" && V.cameraLabel({ movingFraction: 0.8, coherence: 0.9, radial: 0, global: { dx: -2, dy: 0 } }, 20) === "pan right" && V.cameraLabel({ movingFraction: 0.8, coherence: 0.9, radial: 0, global: { dx: 2, dy: 0 } }, 20) === "pan left" && V.cameraLabel({ movingFraction: 0.8, coherence: 0.3, radial: 0.1, global: { dx: 0, dy: 0 } }, 20) === "handheld / shake" && V.cameraLabel({ movingFraction: 0.8, coherence: 0.5, radial: 0.9, global: { dx: 0, dy: 0 } }, 20) === "zoom in");
ok("pickKeyframes respects the budget and keeps time order", (() => { const k = V.pickKeyframes(c3, [{ start: 0, end: 9 }, { start: 10, end: 19 }, { start: 20, end: 30 }], 4); return k.length === 4 && k[0] === 0 && k.every((v, i) => !i || v > k[i - 1]); })());

// ── 2. the brief ─────────────────────────────────────────────────────────────
const msg = V.buildMessage(a1, { goal: "the pause menu at the end", frames: a1.keyframes, name: "clip.mp4", width: 1280, height: 720 });
ok("brief: marker, clip facts, detected kind with confidence + reasons, the user's words", msg.startsWith(V.BRIEF_MARK) && /CLIP: "clip\.mp4", 6\.0 s, 1280x720, 1 shot\(s\)/.test(msg) && /KIND: CUTSCENE - Camera \/ cutscene .* - detected, \d+% confidence: .*camera moves in 50% of the clip/.test(msg) && msg.includes("THE USER SAYS: the pause menu at the end"), msg.slice(0, 600));
ok("brief: palette by area, static overlay regions, timeline rows with the camera runs", /PALETTE \(by area\): #[0-9a-f]{6} \d+%/.test(msg) && /STATIC OVERLAY: \d+% of the frame never changes but carries detail \(top-left/.test(msg) && /TIMELINE \(shot \u00b7 time range \u00b7 camera \u00b7 motion \u00b7 look\):\n  1\. 0\.0 s - 6\.0 s \u00b7 camera: static \(0\.0 s-3\.0 s\) \u2192 pan right \(3\.0 s-6\.0 s\) \u00b7 motion: medium/.test(msg), msg);
ok("brief: image index A = contact sheet then one letter per keyframe with its time + shot", /IMAGES: 7 image\(s\) attached, in this order:\n  A = contact sheet: 6 keyframes/.test(msg) && /\n  B = keyframe at 0\.0 s \(shot 1\)/.test(msg) && /\n  G = keyframe at /.test(msg), msg);
ok("brief: cutscene protocol uses the real commands and the CLONE rule + plan-then-first-command", /cutscene_create \{name\} once, then ONE cutscene_shot_add per shot/.test(msg) && /cutscene_preview, take screen_capture/.test(msg) && /CLONE, do not approximate: same order, same timings \(\u00b110%\)/.test(msg) && /First reply = a 3-6 line plan mapping each shot \/ keyframe to the commands you will run, then start with the first command in the SAME reply/.test(msg), msg);
const over = V.buildMessage(a1, { kind: "gui", frames: a1.keyframes, contactSheet: false, exact: false, imagesAttached: false });
ok("brief: user override is stated, gui protocol names ui_art_theme_set / ui_art_build / ui_build_spec / quality_audit, 'same idea' relaxes the clone rule, no-images note", /KIND: GUI - .* - chosen by the user \(the analysis guessed cutscene/.test(over) && /ui_art_theme_set first/.test(over) && /ONE ui_art_build \{spec\}/.test(over) && /ui_build_spec \{spec, replace:true\}/.test(over) && /quality_audit \{path\} \u2265 85/.test(over) && /Keep the idea, timing and mood; you may simplify shapes/.test(over) && /No images could be attached on this site/.test(over), over);
for (const k of V.KIND_IDS) {
  const m = V.buildMessage(a2, { kind: k, frames: a2.keyframes });
  const must = { gui: /ui_art_build|ui_build_spec/, animation: /animation_create \{name, length: 6\}|animation_add_keyframe/, cutscene: /cutscene_shot_add/, vfx: /fx_create_vfx|fx_burst/, map: /model_build|terrain_fill_region/, gameplay: /execute_luau|ui_build_spec/ }[k];
  ok(`brief: ${k} protocol present and under 4000 chars`, must.test(m) && m.includes(`RECREATION PROTOCOL (${k}):`) && m.length < 4000, m.length);
}
ok("brief: the looping animation clip tells the model to loop", /The clip loops: make the last pose equal the first and set it looping/.test(V.buildMessage(a2, { kind: "animation", frames: a2.keyframes })));

// ── 3. wiring ────────────────────────────────────────────────────────────────
const manifest = JSON.parse(read("manifest.json"));
const lists = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js")).map((c) => c.js);
ok("manifest: videostudio.js loads after animstudio.js and right before main.js in all 17 provider lists", lists.length === 17 && lists.every((js) => js.indexOf("src/core/videostudio.js") > js.indexOf("src/core/animstudio.js") && js.indexOf("src/core/main.js") === js.indexOf("src/core/videostudio.js") + 1));
const codecraft = read("codecraft.html");
ok("codecraft.html loads videostudio.js after animstudio.js", codecraft.indexOf('<script src="src/core/videostudio.js"></script>') > codecraft.indexOf('<script src="src/core/animstudio.js"></script>'));
const main = read("src/core/main.js");
ok("bar: Video button between Animation Studio and GUI Studio, Ctrl+Shift+V shortcut, opener exported", main.indexOf('id="rs-video-btn"') > main.indexOf('id="rs-anim-btn"') && main.indexOf('id="rs-video-btn"') < main.indexOf('id="rs-gui-btn"') && main.includes("(Ctrl+Shift+V)") && main.includes('root.querySelector("#rs-video-btn")') && main.includes("window.__rsOpenVideoStudio = openVideoStudio;") && /e\.key === "V" \|\| e\.key === "v"/.test(main));
ok("opener rides the Paint send path (agent auto-start, images where accepted) and passes engine / canAttachImages / maxImages / toast / diag", /TotalVideoStudio\.open\(\{\s*send: sendPainting,\s*engine: \(\) => activeEngine\(\),\s*canAttachImages:[\s\S]*?maxImages:[\s\S]*?toast:[\s\S]*?diag,\s*\}\)/.test(main));
const css = read("overlay.css");
ok("overlay.css: Video Studio window styles + hides the bar while open", ["#rs-video {", "#rs-video.open {", "html.rs-video-open #rs-root { visibility: hidden !important; }", ".rsv-drop {", ".rsv-keygrid {", ".rsv-primary {", "html.rs-light #rs-video .rsv-shell"].every((s) => css.includes(s)));
ok("overlay.css: bar button styled with the others by nesting the pinned selectors (older pins stay intact)", (css.match(/:is\(:is\(:is\(:is\(#rs-settings-btn, #rs-paint-btn, #rs-gui-btn\), #rs-anim-btn\), #rs-enhance-btn\), #rs-video-btn\)/g) || []).length >= 20 && (css.match(/:is\(:is\(:is\(#rs-settings-btn, #rs-paint-btn, #rs-gui-btn\), #rs-anim-btn\), #rs-enhance-btn\)/g) || []).length >= 20);

// ── 4. window smoke test (jsdom; no canvas) ──────────────────────────────────
try {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole(); // jsdom has no media playback: swallow its "pause not implemented" notices
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.chrome = { runtime: { getURL: (p) => "chrome-extension://x/" + p } };
  w.eval(read("src/core/videostudio.js"));
  const VS = w.TotalVideoStudio;
  const calls = [];
  VS.open({ send: async () => true, engine: () => "roblox", canAttachImages: () => true, maxImages: () => 4, toast: (m) => calls.push(m), diag: () => {} });
  const host = w.document.getElementById("rs-video");
  ok("window: opens as a dialog with drop zone, file input, kind select (6 kinds + auto), goal box, keyframe slider, both image toggles, Analyse + Send", VS.isOpen() && host && host.classList.contains("open") && host.getAttribute("role") === "dialog" && host.querySelector("[data-drop]") && host.querySelector("[data-file]").accept.includes("video/*") && host.querySelector("[data-kind]").options.length === 7 && host.querySelector("[data-goal]") && host.querySelector("[data-nkeys]").max === "8" && host.querySelector("[data-sheet]").checked && host.querySelector("[data-individual]").checked && host.querySelector('[data-act="analyse"]') && host.querySelector('[data-act="send"]'));
  ok("window: Analyse and Send stay disabled until a video is loaded / analysed; site note reflects the image cap", host.querySelector('[data-act="analyse"]').disabled && host.querySelector('[data-act="send"]').disabled && /about 4 image\(s\) per message/.test(host.querySelector("[data-sitenote]").textContent));
  ok("window: the bar is hidden while open (html.rs-video-open)", w.document.documentElement.classList.contains("rs-video-open"));
  host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("window: Escape closes it and restores the bar", !VS.isOpen() && !host.classList.contains("open") && !w.document.documentElement.classList.contains("rs-video-open"));
  VS.open(); host.querySelector('[data-act="close"]').click();
  ok("window: reopen reuses the same host; close button works", w.document.querySelectorAll("#rs-video").length === 1 && !VS.isOpen());
} catch (e) {
  ok("window smoke test ran (jsdom available)", false, e && e.message);
}

// ── 5. release bookkeeping ───────────────────────────────────────────────────
const readme = read("README.md");
ok("README: 1.79.0 entry + this test listed", /\*\*1\.79\.0 — Video Studio: show it a video/.test(readme) && readme.includes("test-video-studio.js"));
ok("version pins 1.81.0", manifest.version === "1.81.0" && /^version = "1\.81\.0"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.81.0"'));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
