// 1.52.0 — Animation Studio overlay (src/core/animstudio.js) + its wiring in main.js / overlay.css / manifest / codecraft.html.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-anim-studio.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), css = read("overlay.css"), manifest = read("manifest.json"), codecraft = read("codecraft.html");
const studio = read("src/core/animstudio.js");
let n = 0; const ok = (name, cond, detail) => { n++; if (!cond) { console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); process.exit(1); } };

// ── registration ───────────────────────────────────────────────────────────
const m = JSON.parse(manifest);
const lists = m.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
ok("12 provider lists load main.js (1.89.0: 17 before the provider removal)", lists.length === 12, lists.length);
for (const js of lists) {
  const lib = js.indexOf("src/core/animlib.js"), eng = js.indexOf("src/core/animengine.js"), gs = js.indexOf("src/core/guistudio.js"), as = js.indexOf("src/core/animstudio.js"), mn = js.indexOf("src/core/main.js");
  ok("animengine.js loads right after animlib.js and before main.js", lib >= 0 && eng === lib + 1 && mn > eng, js);
  ok("animstudio.js loads right after guistudio.js and before main.js", gs >= 0 && as === gs + 1 && mn > as, js);
}
ok("codecraft.html loads the engine and the studio in order", codecraft.indexOf('<script src="src/core/animengine.js"></script>') > codecraft.indexOf('<script src="src/core/animlib.js"></script>') && codecraft.indexOf('<script src="src/core/animstudio.js"></script>') > codecraft.indexOf('<script src="src/core/guistudio.js"></script>') && codecraft.indexOf('<script src="src/core/animstudio.js"></script>') < codecraft.indexOf('<script src="src/core/main.js"></script>'));

// ── main.js wiring ──────────────────────────────────────────────────────────
for (const s of [
  'id="rs-anim-btn"',
  'root.querySelector("#rs-anim-btn")',
  "if (window.__rsOpenAnimStudio) window.__rsOpenAnimStudio();",
  '(e.key === "K" || e.key === "k") && !e.altKey',
  'if (typeof TotalAnimStudio !== "undefined" && TotalAnimStudio.isOpen()) return;',
  "function openAnimStudio() {",
  'if (typeof TotalAnimStudio === "undefined" || typeof TotalAnimEngine === "undefined") { ui.toast("Animation Studio module missing — reload the extension"); return; }',
  "TotalAnimStudio.open({",
  "send: (text, onStatus) => sendPainting(text, null, onStatus),",
  "runTool: guiStudioRunTool,",
  "studioReady: () => { try { return currentEngineIsLive(); } catch { return false; } },",
  "window.__rsOpenAnimStudio = openAnimStudio;",
  'const ANIM_ENGINE_OPS = new Set(["generate", "refine", "sequence", "validate", "export_rbxmx", "build", "set", "compatibility", "polish", "layer"]);',
  'if (op === "polish") {', 'if (op === "layer") {', 'clips: () => A.animClips,',
  'if (name.startsWith("animation_") && typeof TotalAnimEngine !== "undefined" && ANIM_ENGINE_OPS.has(name.slice("animation_".length))) {',
  "return await runAnimEngine(name.slice(\"animation_\".length), args);",
  "async function runAnimEngine(op, args) {",
  'res = await animStudioCall("build", part, 45000);', "const part = Object.assign({}, payload, { keys: chunks[i], append: i > 0, more: i < chunks.length - 1 });",
  "const payload = TotalAnimEngine.toBuildArgs(clip, rigInfo, { overwrite: true });",
  'const info = await animStudioCall("rig_info", {});',
  "TotalAnimStudio.loadClip(clip, meta || {});",
  "but Studio refused the build: ${b.error}",
  "the clip was generated and validated but NOT built.",
  "This is a file on the user's machine - no asset id exists until it is published.",
]) ok("main.js wiring: " + s.slice(0, 70), main.includes(s), s);
ok("engine ops are intercepted BEFORE the generic animation_* Luau branch", main.indexOf("ANIM_ENGINE_OPS.has(name.slice") < main.indexOf('if (!RSAnim.ANIM_OPS.includes(op)) {'));
ok("the Animation Studio reuses the GUI Studio tool runner (internal, no AI turn)", main.includes("return runTool({ tool: name, arguments: Object.assign({}, args || {}, { _totalInternal: true }) });"));
ok("the shortcut yields to an open GUI Studio / Paint", /e\.key === "K"[^\n]*TotalGuiStudio\.isOpen\(\)\) return;[^\n]*TotalPaint\.isOpen\(\)\) return;/.test(main));

// ── CSS ─────────────────────────────────────────────────────────────────────
for (const s of [
  "#rs-anim { position: fixed; inset: 0; z-index: 2147483600; display: none;",
  "#rs-anim.open { display: flex;",
  "#rs-anim [hidden] { display: none !important; }",
  "html.rs-anim-open #rs-root { visibility: hidden !important; }",
  ".rsa-body { flex: 1; display: grid; grid-template-columns: 300px minmax(0, 1fr) 300px; min-height: 0; }",
  ".rsa-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }",
  ".rsa-timeline { flex: none; height: 84px; width: 100%; display: block;",
  ".rsa-empty {", "pointer-events: none;",
  ".rsa-score.good", ".rsa-issue.error", ".rsa-joint.on", ".rsa-btn.primary",
]) ok("overlay.css: " + s.slice(0, 60), css.includes(s), s);
ok("bar button styled with the other bar buttons (nested :is keeps the pinned selector intact for test-paint / test-gui-studio)", (css.match(/:is\(:is\(#rs-settings-btn, #rs-paint-btn, #rs-gui-btn\), #rs-anim-btn\)/g) || []).length >= 20 && !/#rs-gui-btn, #rs-anim-btn\)/.test(css));

// ── overlay in jsdom ───────────────────────────────────────────────────────
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, url: "https://chatgpt.com/" });
const w = dom.window;
w.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 84, right: 800, bottom: 84 }; };
w.HTMLElement.prototype.scrollIntoView = function () {};
const downloads = [];
w.URL.createObjectURL = (blob) => { downloads.push(blob); return "blob:x"; }; w.URL.revokeObjectURL = () => {};
w.prompt = () => null; w.confirm = () => true;
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 800; } });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 400; } });
const canvasOps = [];
w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : (...a) => { canvasOps.push(String(k)); return undefined; }), set: () => true }); };
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const load = (f) => { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); };
load("src/core/animengine.js"); load("src/core/animstudio.js");
ok("scripts load without window errors", errors.length === 0, errors);
const AS = w.TotalAnimStudio, E = w.TotalAnimEngine;
ok("window.TotalAnimStudio + window.TotalAnimEngine exported", AS && typeof AS.open === "function" && E && typeof E.generate === "function");

const sent = [], calls = [], diags = [];
const toasts = { some: (f) => f(host.querySelector(".rsa-toast").textContent), slice: () => host.querySelector(".rsa-toast").textContent, push: () => {} };
let host;
let studioLive = true, buildReply = () => "Built 'X' in Studio (ok)";
AS.open({
  send: async (t, s) => { sent.push(t); s && s("status"); return true; },
  runTool: async (name, args) => { calls.push([name, args]); if (name === "animation_build") return buildReply(args); if (name === "animation_preview") return "Output of 'execute_luau':\n{\"ok\":true,\"text\":\"previewing\"}"; return "ERROR calling '" + name + "': unexpected"; },
  studioReady: () => studioLive, engine: () => "chatgpt", toast: (x) => toasts.push(x), diag: (e, d) => diags.push([e, d]),
});
host = w.document.getElementById("rs-anim");
const q = (sel) => host.querySelector(sel);
const ref = (k) => host.querySelector(`[data-ref="${k}"]`);
const act = (k) => host.querySelector(`[data-act="${k}"]`);
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
const input = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
ok("open() renders synchronously: host visible, chat hidden flag set", host && host.classList.contains("open") && w.document.documentElement.classList.contains("rs-anim-open") && AS.isOpen());
ok("empty state visible before any clip", ref("empty") && !ref("empty").hidden && /Describe/i.test(ref("empty").textContent));
ok("Studio-only buttons are shown when runTool exists", !ref("buildBtn").hidden && !ref("previewBtn").hidden && !ref("sendBtn").hidden);
ok("every control is a real control (no dead buttons): each data-act in the DOM has a case in doAction", [...host.querySelectorAll("[data-act]")].every((b) => studio.includes(`case "${b.dataset.act}":`)) && host.querySelectorAll("[data-act]").length >= 18, [...host.querySelectorAll("[data-act]")].map((b) => b.dataset.act));

// generate
input(ref("prompt"), "fluid anime sword combo with anticipation, a spin and a heavy landing");
ref("quality").value = "high";
click(act("generate"));
let clip = AS.getClip();
ok("Generate builds a clip from the prompt box", clip && clip.keys.length >= 12 && clip.quality === "high" && clip.rigType === "R15", clip && [clip.keys.length, clip.quality]);
ok("empty state hidden, meta shows the clip, score rendered", ref("empty").hidden && ref("meta").textContent.includes(clip.name) && /\d+/.test(ref("score").textContent));
ok("stages rendered as chips", host.querySelectorAll(".rsa-stage").length === clip.stages.length && clip.stages.length >= 4, clip.stages.length);
ok("joint list rendered (15 semantic joints) with the selected joint highlighted", host.querySelectorAll(".rsa-joint").length === 15 && host.querySelector(".rsa-joint.on"));
ok("the schematic preview drew on the canvas (front + side views)", canvasOps.includes("beginPath") && canvasOps.includes("stroke") && canvasOps.includes("fillText"));
ok("autosave went to localStorage", w.localStorage.getItem("rsAnimProject") && JSON.parse(w.localStorage.getItem("rsAnimProject")).clip.name === clip.name);
ok("report lists issues or an all-clear", ref("report").textContent.length > 10);

// key selection + joint editing
const keysBefore = clip.keys.length;
AS._selectKey(2);
const inspectorInputs = [...ref("inspector").querySelectorAll("input[data-axis]")];
ok("inspector shows X/Y/Z (+ root pos) number inputs for the selected key/joint", inspectorInputs.length >= 3, inspectorInputs.length);
const jointBtn = host.querySelector('.rsa-joint[data-joint="l_elbow"]'); click(jointBtn);
ok("clicking a joint selects it", AS._state.selJoint === "l_elbow" && host.querySelector('.rsa-joint.on').dataset.joint === "l_elbow");
const xIn = ref("inspector").querySelector('input[data-axis="0"]');
input(xIn, "77");
clip = AS.getClip();
ok("editing X writes the joint rotation into the selected key and marks the clip edited", clip.keys[2].poses.l_elbow && Math.round(clip.keys[2].poses.l_elbow.rot[0]) === 77 && clip.edited === true, clip.keys[2].poses.l_elbow);
click(act("undo"));
ok("undo restores the previous value", !(AS.getClip().keys[2].poses.l_elbow && Math.round(AS.getClip().keys[2].poses.l_elbow.rot[0]) === 77));
click(act("redo"));
ok("redo re-applies it", Math.round(AS.getClip().keys[2].poses.l_elbow.rot[0]) === 77);
click(act("dupKey"));
ok("duplicate key adds one key", AS.getClip().keys.length === keysBefore + 1, AS.getClip().keys.length);
click(act("delKey"));
ok("delete key removes the selected key", AS.getClip().keys.length === keysBefore);

// timeline interaction: pointerdown on a key selects it, drag moves it
const tl = ref("timeline"); const c0 = AS.getClip(); const W = 800, L = 10, span = W - 20;
const kx = (i) => L + (c0.keys[i].t / c0.duration) * span;
tl.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: kx(3), clientY: 40, button: 0 }));
ok("pointerdown on a key selects it", AS._state.sel === 3, AS._state.sel);
tl.dispatchEvent(new w.MouseEvent("pointermove", { bubbles: true, clientX: kx(3) + 25, clientY: 40 }));
tl.dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, clientX: kx(3) + 25, clientY: 40 }));
const moved = AS.getClip().keys.map((k) => k.t);
ok("dragging a key moves it in time (order preserved)", AS.getClip().keys.length === c0.keys.length && moved.every((t, i) => i === 0 || t >= moved[i - 1]) && Math.abs(moved[AS._state.sel] - c0.keys[3].t) > 0.02, [c0.keys[3].t, moved[AS._state.sel]]);
tl.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 70, button: 0 }));
tl.dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, clientX: 400, clientY: 70 }));
ok("pointerdown off a key scrubs the playhead", Math.abs(AS._state.t - (390 / span) * AS.getClip().duration) < 0.05, AS._state.t);

// transport
click(act("play"));
ok("play starts the transport", AS._state.playing === true);
click(act("stop"));
ok("stop resets to 0", AS._state.playing === false && AS._state.t === 0);
input(ref("speed"), "0.5"); ok("speed select changes playback speed", AS._state.speed === 0.5);
input(ref("duration"), "4");
ok("duration box retimes the clip", Math.abs(AS.getClip().duration - 4) < 1e-6, AS.getClip().duration);
input(ref("fps"), "60"); ok("fps box updates the clip", AS.getClip().fps === 60);

// refine + variation + regenerate + fix
input(ref("feedback"), "faster attacks, more anticipation, heavier landing");
click(act("refine"));
clip = AS.getClip();
ok("refine applies feedback (confirm() accepted the manual-edit warning)", clip.feedback && clip.feedback.length === 1 && clip.feedback[0].applied.length >= 3, clip.feedback);
const before = JSON.stringify(clip.keys);
const fpBefore = AS.getClip().fingerprint;
click(act("variation"));
ok("variation changes the keys", JSON.stringify(AS.getClip().keys) !== before);
ok("1.53 New take: button label, take counter advanced, fingerprint differs, persona readout filled", ref("varBtn").textContent === "New take" && AS.getClip().take === 1 && AS.getClip().fingerprint && AS.getClip().fingerprint !== fpBefore && /^Persona: .*take 2.*id [0-9a-f]{8}/.test(ref("persona").textContent), [AS.getClip().take, ref("persona").textContent]);
const fpTake2 = AS.getClip().fingerprint;
click(act("variation"));
ok("1.53 a second New take is a third distinct fingerprint (history is passed as `avoid`)", AS.getClip().take === 2 && AS.getClip().fingerprint !== fpTake2 && AS.getClip().fingerprint !== fpBefore);
const preMirror = AS.getClip(); const fpTake3 = preMirror.fingerprint;
click(act("mirror"));
ok("1.53 Mirror swaps handedness, suffixes the name, re-validates and shows it in the persona line", AS.getClip().mirrored === true && /_Mirror$/.test(AS.getClip().name) && AS.getClip().report && /mirrored/.test(ref("persona").textContent) && Math.abs(AS.getClip().keys[2].poses.l_shoulder.rot[0] - preMirror.keys[2].poses.r_shoulder.rot[0]) < 1e-9, AS.getClip().name);
click(act("mirror"));
ok("1.53 Mirror again restores the original handedness and name", AS.getClip().mirrored === false && AS.getClip().name === preMirror.name);
click(act("undo")); click(act("undo"));
ok("1.53 two undos step back over both Mirror clicks to the third take", AS.getClip().take === 2 && AS.getClip().fingerprint === fpTake3 && AS.getClip().mirrored === false, [AS.getClip().take, AS.getClip().fingerprint]);
click(act("undo"));
ok("1.53 a third undo steps back over New take to the second take", AS.getClip().take === 1 && AS.getClip().fingerprint === fpTake2, [AS.getClip().take, AS.getClip().fingerprint]);
click(act("regen"));
ok("regenerate reruns the prompt", AS.getClip().prompt === clip.prompt && AS.getClip().keys.length >= 12);
click(act("fix"));
ok("auto-fix toasted a result", toasts.some((t) => /Fixed|Nothing to fix/.test(t)), toasts.slice(-2));

// save / open roundtrip
click(act("save"));
ok("save downloads a .oranim.json project", downloads.length >= 1 && downloads[downloads.length - 1].type === "application/json");
const saved = E.serializeProject(AS.getClip());
const parsed = E.parseProject(saved);
ok("project JSON round-trips through parseProject", parsed.name === AS.getClip().name && parsed.keys.length === AS.getClip().keys.length);
ok("open project button targets the hidden file input", act("open") && ref("file") && ref("file").type === "file" && ref("file").accept.includes(".json"));

// export
click(act("export"));
ok("export downloads an .rbxmx", downloads[downloads.length - 1].type === "application/xml");
const xml = E.toRbxmx(AS.getClip(), E.defaultRigInfo("R15"));
ok("export XML is a KeyframeSequence with Pose tree rooted at HumanoidRootPart", xml.includes('class="KeyframeSequence"') && xml.includes("HumanoidRootPart") && xml.includes('class="Pose"') && xml.includes("LowerTorso"));

// build / preview through the tool runner
(async () => {
  await act("build").click(); await new Promise((r) => setTimeout(r, 5));
  ok("Build calls animation_build with the clip (no AI turn)", calls.some(([nm, a]) => nm === "animation_build" && a.clip && a.clip.keys.length === AS.getClip().keys.length), calls.map((c) => c[0]));
  ok("successful build is remembered and reflected in status", AS._state.built && AS._state.built.name === AS.getClip().name && /Built in Studio/.test(ref("status").textContent), ref("status").textContent);
  const msg = AS.buildMessage();
  ok("hand-off text names the clip as already built and asks for a preview, not a redesign", msg.startsWith("ANIMATION STUDIO HAND-OFF (TotalScript):") && msg.includes("ALREADY BUILT in Studio as ServerStorage.RobloxScript.AnimLib." + AS.getClip().name) && msg.includes("animation_preview") && msg.includes("Validation: score"), msg.slice(0, 300));
  const nCalls = calls.length;
  await act("previewStudio").click(); await new Promise((r) => setTimeout(r, 5));
  ok("Preview in Studio runs animation_preview without rebuilding an already-built clip", calls.length === nCalls + 1 && calls[calls.length - 1][0] === "animation_preview" && /Playing in the Studio viewport/.test(ref("status").textContent), calls.slice(nCalls));
  // failure path
  buildReply = () => "ERROR calling 'animation_build': Studio rig unavailable - STUDIO_BRIDGE_OFFLINE";
  click(act("variation")); // invalidates built
  ok("editing invalidates the built flag", !AS._state.built);
  await act("build").click(); await new Promise((r) => setTimeout(r, 5));
  ok("a failed build is reported in the status line and not marked built", !AS._state.built && /STUDIO_BRIDGE_OFFLINE/.test(ref("status").textContent) && toasts.some((t) => /Build failed/.test(t)), ref("status").textContent);
  const msg2 = AS.buildMessage();
  ok("hand-off for an unbuilt clip asks the AI to build it from the engine", !msg2.includes("ALREADY BUILT") && /animation_build|animation_generate/.test(msg2), msg2.slice(-300));
  // send
  await act("send").click(); await new Promise((r) => setTimeout(r, 5));
  ok("Send hands the text to the chat and closes the studio", sent.length === 1 && sent[0].startsWith("ANIMATION STUDIO HAND-OFF (TotalScript):") && !AS.isOpen() && !w.document.documentElement.classList.contains("rs-anim-open"));
  // reopen restores from autosave + loadClip from the tool path
  AS.open({ send: async () => true, runTool: null, studioReady: () => false, engine: () => "", toast: (x) => toasts.push(x), diag: () => {} });
  ok("reopen keeps the clip; Studio buttons hidden when no tool runner", AS.isOpen() && AS.getClip() && ref("buildBtn").hidden && ref("previewBtn").hidden);
  const ext = E.generate("looping idle with calm breathing", { quality: "balanced", rigType: "R6" });
  ok("loadClip (used by animation_generate) swaps the clip and the form", AS.loadClip(ext, { built: true, rigInfo: E.defaultRigInfo("R6") }) && AS.getClip().name === ext.name && ref("rig").value === "R6" && ref("loop").checked && AS._state.built.name === ext.name);
  // ── 1.56: sets of separate clips, one character ──────────────────────────
  AS.open({ send: async () => true, runTool: async (name, args) => { calls.push([name, args]); return "Built (ok)"; }, studioReady: () => true, engine: () => "chatgpt", toast: (x) => toasts.push(x), diag: (e, d) => diags.push([e, d]) });
  ok("Clips tab + Check set / Build all / Export all controls + same-character checkbox exist", q('[data-rtab="clips"]') && q('[data-rpanel="clips"]') && act("buildAll") && act("exportAll") && act("checkSet") && ref("sameChar") && ref("sameChar").checked && ref("compat") && ref("clipList"));
  for (const s of ["case \"buildAll\":", "case \"exportAll\":", "case \"checkSet\":", "function generateSetHere(", "E().splitSet(text)", "E().generateSet(text", "function loadSet(set, meta)", "loadSet, switchClip, checkSet, buildAll, exportAll"]) ok("studio: " + s, studio.includes(s));
  for (const s of [".rsa-cliplist {", ".rsa-clipitem.on {", ".rsa-badge.ok {", ".rsa-count {"]) ok("overlay.css 1.56: " + s, css.includes(s));
  const before = Object.keys(AS._state.library || {}).length;
  ref("prompt").value = "idle, walk and jump animations for my knight"; ref("rig").value = "R15";
  click(act("generate")); await new Promise((r) => setTimeout(r, 5));
  const lib = AS._state.library || {};
  const setNames = Object.keys(lib).filter((k) => /Knight/i.test(k) || /Idle|Walk|Jump/.test(k));
  ok("a multi-animation prompt makes SEPARATE clips (not one merged clip)", Object.keys(lib).length >= before + 2 && setNames.length >= 3 && /Idle/.test(AS.getClip().name), Object.keys(lib));
  ok("the first clip of the set is open and the Clips tab is shown", AS.getClip() && lib[AS.getClip().name] && AS._state.rtab === "clips" && !q('[data-rpanel="clips"]').hidden, AS._state.rtab);
  ok("clip list rows rendered, current clip highlighted, count badge updated", host.querySelectorAll(".rsa-clipitem").length >= 3 && q(".rsa-clipitem.on") && parseInt(ref("clipCount").textContent, 10) >= 3);
  ok("set clips share one persona seed and the session adopted it", Number.isFinite(AS._state.personaSeed) && Object.values(lib).filter((c) => c.personaSeed === AS._state.personaSeed).length >= 3);
  ok("compatibility report rendered in the Check tab", AS._state.compat && /\/100/.test(ref("compatScore").textContent) && ref("compat").innerHTML.length > 20, ref("compatScore").textContent);
  ok("set clips stand on the ground (no 0.5 stud sink)", Object.values(lib).filter((c) => c.personaSeed === AS._state.personaSeed).every((c) => { const f = E.forwardKinematics(c, 0); const low = Math.min(...Object.values(f).map((p) => p[1])); return low > -0.12 && low < 0.3; }));
  // switching clips
  const other = Object.keys(lib).find((k) => k !== AS.getClip().name && lib[k].personaSeed === AS._state.personaSeed);
  const row = host.querySelector(`.rsa-clipitem[data-clip="${other}"]`);
  click(row);
  ok("clicking a row opens that clip and the form follows", AS.getClip().name === other && q(".rsa-clipitem.on").getAttribute("data-clip") === other && ref("duration").value == String(lib[other].duration), AS.getClip().name);
  // a later single prompt keeps the same character while the box is ticked
  ref("prompt").value = "sword slash attack"; click(act("generate")); await new Promise((r) => setTimeout(r, 5));
  ok("a later single clip reuses the session character seed (Same character ticked)", AS.getClip().personaSeed === AS._state.personaSeed, [AS.getClip().personaSeed, AS._state.personaSeed]);
  // check set + build all + export all
  const compat = AS.checkSet();
  ok("Check set runs compatibility over the session clips and switches to the Check tab", compat && Number.isFinite(compat.score) && compat.clips >= 4 && AS._state.rtab === "check", compat && compat.score);
  const callsBefore = calls.length, dlBefore = downloads.length;
  await act("buildAll").click(); await new Promise((r) => setTimeout(r, 10));
  const builtCalls = calls.slice(callsBefore).filter((c) => c[0] === "animation_build");
  ok("Build all = one animation_build per clip, each marked built", builtCalls.length >= 4 && Object.keys(AS._state.builtNames).length >= 4 && host.querySelectorAll(".rsa-badge.ok").length >= 4, builtCalls.length);
  click(act("exportAll")); await new Promise((r) => setTimeout(r, 2000));
  ok("Export all downloads one .rbxmx per clip", downloads.length - dlBefore >= 4, downloads.length - dlBefore);
  // loadSet from the chat path
  const chatSet = E.generateSet(["crouch idle", "crouch walk"], { rigType: "R6" });
  ok("loadSet (chat animation_set) registers every clip, opens the first, keeps the report", AS.loadSet(chatSet, { built: ["CrouchIdle"] }) && AS.getClip().name === chatSet.clips[0].name && AS._state.library[chatSet.clips[1].name] && AS._state.compat === chatSet.report && AS._state.rtab === "clips");
  // remove from list
  click(host.querySelector(`[data-delclip="${chatSet.clips[1].name}"]`));
  ok("× removes a clip from the session list", !AS._state.library[chatSet.clips[1].name]);
  ok("Esc closes", (host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })), !AS.isOpen()));
  ok("no window errors during the whole session", errors.length === 0, errors);
  console.log(`test-anim-studio: ${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL (exception)", e && e.stack || e); process.exit(1); });
