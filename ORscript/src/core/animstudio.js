/* ORscript Animation Studio — describe it, preview it, build it in Studio.
 *
 * The visual front-end of the animation engine (animengine.js): a prompt box
 * with quality / rig / duration / loop controls, a schematic skeleton preview
 * (front + side orthographic views of the engine's semantic skeleton; NOT the
 * Roblox renderer), a timeline with draggable keyframes and stage bands, a
 * joint editor (X/Y/Z degrees + root offset per selected key), transport
 * controls (play / pause / stop / loop / scrub / speed / fps / duration),
 * refine-by-feedback, variation, regenerate, undo / redo, before/after ghost,
 * validation report, project save / open (.oranim.json), .rbxmx export and
 * two Studio actions: BUILD (writes the KeyframeSequence through animation_build,
 * no AI turn) and PREVIEW IN STUDIO (animation_preview on the built clip), plus
 * SEND TO AI (hand-off text through the normal chat).
 *
 * Public API (window.ORAnimStudio):
 *   open(hooks)   hooks = { send(text, onStatus), runTool(name, args) -> Promise<string>,
 *                           studioReady() -> boolean, engine() -> string, toast(msg), diag(event, data) }
 *   close(), isOpen(), getClip(), loadClip(clip), generate(prompt, opts), buildMessage()
 */
(() => {
  "use strict";
  if (window.ORAnimStudio) return;
  const E = () => window.ORAnimEngine;
  const SVG = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    play: SVG('<path d="M7 5v14l12-7z" fill="currentColor" stroke="none"/>'), pause: SVG('<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>'), stop: SVG('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>'),
    loop: SVG('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    undo: SVG('<path d="M9 14H4V9"/><path d="M4 14a8 8 0 1 1 3 6"/>'), redo: SVG('<path d="M15 14h5V9"/><path d="M20 14a8 8 0 1 0-3 6"/>'), close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    save: SVG('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'), open: SVG('<path d="M4 7h5l2 2h9v10H4z"/>'), export: SVG('<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 19h14"/>'),
    dup: SVG('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'), trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    ghost: SVG('<path d="M12 3a7 7 0 0 0-7 7v10l3-2 2 2 2-2 2 2 2-2 3 2V10a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10" r="1" fill="currentColor"/><circle cx="14.5" cy="10" r="1" fill="currentColor"/>'),
  };
  const assetUrl = (p) => { try { if (window.chrome && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(p); } catch {} return p; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const JOINT_LABEL = { root: "Root (LowerTorso)", waist: "Waist (UpperTorso)", neck: "Neck (Head)", l_shoulder: "L Shoulder", l_elbow: "L Elbow", l_wrist: "L Wrist", r_shoulder: "R Shoulder", r_elbow: "R Elbow", r_wrist: "R Wrist", l_hip: "L Hip", l_knee: "L Knee", l_ankle: "L Ankle", r_hip: "R Hip", r_knee: "R Knee", r_ankle: "R Ankle" };
  const PRESETS = [
    ["Idle loop", "calm looping idle, subtle breathing and weight shift"], ["Walk cycle", "natural walk cycle, loop"], ["Run cycle", "fast run cycle, loop"], ["Jump", "jump with anticipation, air pose and a solid landing"],
    ["Sword combo", "extremely fluid anime sword combo with anticipation, rapid strikes, a spinning finisher and a dramatic landing"], ["3-hit punch", "3 hit punch combo, snappy"], ["Kick", "roundhouse kick with anticipation and recovery"],
    ["Dodge roll", "quick dodge roll to the left"], ["Block", "raise a two handed block and hold"], ["Spell cast", "cast a fireball with a charge up"], ["Wave", "friendly wave emote"], ["Zombie walk", "shambling zombie walk, loop"],
  ];
  const STORAGE_KEY = "rsAnimProject";

  const S = { open: false, hooks: {}, clip: null, prev: null, history: [], future: [], sel: -1, selJoint: "r_shoulder", t: 0, playing: false, speed: 1, ghost: false, rigInfo: null, built: null, drag: null, raf: 0, lastTs: 0, busy: false, view: "both" };
  let D = null;
  let toastTimer = 0;
  const toast = (m) => { if (!D) return; D.toast.textContent = m; D.toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => D.toast.classList.remove("show"), 2600); try { S.hooks.diag && S.hooks.diag("anim.toast", { m }); } catch {} };
  const diag = (ev, data) => { try { S.hooks.diag && S.hooks.diag("animStudio." + ev, data || {}); } catch {} };
  const fmt = (n, d) => Number(n).toFixed(d == null ? 2 : d);

  // ───────────────────────── state helpers ─────────────────────────
  function pushHistory() { if (!S.clip) return; S.history.push(JSON.stringify(S.clip)); if (S.history.length > 60) S.history.shift(); S.future.length = 0; }
  function undo() { if (!S.history.length) return toast("Nothing to undo"); S.future.push(JSON.stringify(S.clip)); setClip(JSON.parse(S.history.pop()), { keepT: true, silent: true }); toast("Undo"); }
  function redo() { if (!S.future.length) return toast("Nothing to redo"); S.history.push(JSON.stringify(S.clip)); setClip(JSON.parse(S.future.pop()), { keepT: true, silent: true }); toast("Redo"); }
  function setClip(clip, opts) {
    opts = opts || {};
    if (!opts.silent && S.clip && !opts.noPrev) S.prev = S.clip;
    S.clip = clip;
    if (!clip.report) clip.report = E().validate(clip);
    if (!opts.keepT) S.t = 0;
    S.t = clamp(S.t, 0, clip.duration);
    if (S.sel >= clip.keys.length) S.sel = clip.keys.length - 1;
    if (S.sel < 0 && clip.keys.length) S.sel = 0;
    S.built = null;
    autosave();
    renderAll();
  }
  function autosave() { try { if (S.clip) localStorage.setItem(STORAGE_KEY, JSON.stringify({ t: Date.now(), clip: S.clip })); } catch {} }
  function loadAutosave() { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return null; const j = JSON.parse(raw); return j && j.clip && Array.isArray(j.clip.keys) ? j.clip : null; } catch { return null; } }

  // ───────────────────────── generation ─────────────────────────
  function readOpts() {
    const dur = parseFloat(D.duration.value);
    return { quality: D.quality.value, rigType: D.rig.value, duration: Number.isFinite(dur) && dur > 0 ? dur : undefined, loop: D.loop.checked ? true : (D.loopAuto ? undefined : false), fps: parseInt(D.fps.value, 10) || undefined };
  }
  function generate(prompt, opts) {
    const text = String(prompt == null ? D.prompt.value : prompt).trim();
    if (!text) { toast("Describe the animation first"); D.prompt.focus(); return null; }
    const o = Object.assign(readOpts(), opts || {});
    if (D.loopAuto) delete o.loop;
    let clip;
    try { clip = E().generate(text, o); } catch (e) { toast("Generation failed: " + (e && e.message || e)); diag("generateError", { error: String(e) }); return null; }
    pushHistory();
    S.sel = 0; S.selJoint = clip.intent && clip.intent.category === "attack" ? "r_shoulder" : "root";
    setClip(clip);
    D.prompt.value = text;
    D.loopAuto = false; D.loop.checked = !!clip.loop; D.duration.value = clip.duration; D.fps.value = clip.fps; D.rig.value = clip.rigType; D.quality.value = clip.quality;
    toast(`Generated ${clip.name}: ${clip.keys.length} keys, score ${clip.report.score}/100`);
    diag("generate", { prompt: text.slice(0, 80), keys: clip.keys.length, score: clip.report.score, quality: clip.quality, rig: clip.rigType });
    return clip;
  }
  function refine(feedback) {
    if (!S.clip) return toast("Generate a clip first");
    const fb = String(feedback == null ? D.feedback.value : feedback).trim();
    if (!fb) { toast("Type what to change (e.g. faster attacks, heavier landing)"); D.feedback.focus(); return; }
    if (S.clip.edited && !confirm("Refining regenerates the clip from its prompt and will drop manual key edits. Continue?")) return;
    pushHistory();
    const out = E().applyFeedback(S.clip, fb);
    setClip(out, { keepT: true });
    D.feedback.value = "";
    toast("Applied: " + out.feedback[out.feedback.length - 1].applied.join(", "));
    diag("refine", { fb: fb.slice(0, 80), score: out.report.score });
  }
  function variation() {
    if (!S.clip) return toast("Generate a clip first");
    pushHistory();
    const prevFp = S.clip.fingerprint; const seen = (S.history || []).map((h) => { try { return JSON.parse(h).fingerprint; } catch { return null; } }).filter(Boolean).concat(prevFp ? [prevFp] : []);
    const out = E().generate(S.clip.intent, { quality: S.clip.quality, rigType: S.clip.rigType, name: S.clip.name.replace(/_take\d+$/, ""), fps: S.clip.fps, loop: S.clip.loop, params: S.clip.params, duration: S.clip.intent && S.clip.intent.duration, priority: S.clip.priority, take: (S.clip.take || 0) + 1, mirror: !!S.clip.mirrored, travel: !!S.clip.travel, avoid: seen });
    out.feedback = S.clip.feedback || [];
    setClip(out, { keepT: true });
    toast(`New take ${(out.take || 0) + 1}: ${(out.persona && out.persona.traits || []).slice(0, 3).join(", ")}`);
    diag("variation", { take: out.take, fp: out.fingerprint });
  }
  function mirrorClip() {
    if (!S.clip) return toast("Generate a clip first");
    pushHistory();
    const out = E().mirror(S.clip); out.report = E().validate(out); out.fingerprint = E().fingerprint(out);
    setClip(out, { keepT: true });
    toast(out.mirrored ? "Mirrored: left and right swapped" : "Mirror removed: back to the original handedness");
    diag("mirror", { mirrored: out.mirrored });
  }
  function regenerate() { if (!S.clip) return toast("Generate a clip first"); generate(S.clip.prompt, { quality: S.clip.quality, rigType: S.clip.rigType, duration: S.clip.intent && S.clip.intent.duration, loop: S.clip.loop, fps: S.clip.fps }); }

  // ───────────────────────── editing ─────────────────────────
  function selectKey(i) { S.sel = clamp(i, 0, (S.clip ? S.clip.keys.length : 1) - 1); if (S.clip && S.clip.keys[S.sel]) S.t = S.clip.keys[S.sel].t; renderAll(); }
  function nearestKey(t) { if (!S.clip) return -1; let best = -1, bd = Infinity; S.clip.keys.forEach((k, i) => { const d = Math.abs(k.t - t); if (d < bd) { bd = d; best = i; } }); return best; }
  function setJointValue(axis, value) {
    if (!S.clip || S.sel < 0) return;
    const k = S.clip.keys[S.sel]; const p = k.poses[S.selJoint] || { rot: [0, 0, 0] };
    const rot = p.rot.slice(); let pos = p.pos ? p.pos.slice() : null;
    if (axis < 3) rot[axis] = clamp(Number(value) || 0, -1800, 1800); else { pos = pos || [0, 0, 0]; pos[axis - 3] = clamp(Number(value) || 0, -5, 5); }
    pushHistory();
    setClip(E().setJoint(S.clip, S.sel, S.selJoint, rot, pos), { keepT: true, noPrev: true });
  }
  function resetJoint() { if (!S.clip || S.sel < 0) return; pushHistory(); setClip(E().setJoint(S.clip, S.sel, S.selJoint, [0, 0, 0], S.selJoint === "root" ? [0, 0, 0] : null), { keepT: true, noPrev: true }); }
  function duplicateKey() { if (!S.clip || S.sel < 0) return; pushHistory(); const c = E().duplicateKey(S.clip, S.sel); setClip(c, { keepT: true, noPrev: true }); S.sel = Math.min(S.sel + 1, c.keys.length - 1); renderAll(); toast("Key duplicated (one frame later)"); }
  function deleteKey() { if (!S.clip || S.sel < 0) return; if (S.clip.keys.length <= 2) return toast("A clip needs at least two keys"); pushHistory(); setClip(E().deleteKey(S.clip, S.sel), { keepT: true, noPrev: true }); toast("Key deleted"); }
  function setEasing(style, dir) { if (!S.clip || S.sel < 0) return; pushHistory(); const c = JSON.parse(JSON.stringify(S.clip)); c.keys[S.sel].ease = [style, dir]; c.edited = true; c.report = E().validate(c); setClip(c, { keepT: true, noPrev: true }); }
  function retime(newDur) { if (!S.clip) return; const d = Number(newDur); if (!(d > 0.1 && d <= 60)) return toast("Duration must be 0.1–60 s"); if (Math.abs(d - S.clip.duration) < 1e-6) return; pushHistory(); setClip(E().retime(S.clip, d), { noPrev: true }); toast(`Retimed to ${d}s`); }
  function setFps(v) { if (!S.clip) return; const f = clamp(parseInt(v, 10) || 30, 10, 120); if (f === S.clip.fps) return; pushHistory(); const c = JSON.parse(JSON.stringify(S.clip)); c.fps = f; c.edited = true; c.report = E().validate(c); setClip(c, { keepT: true, noPrev: true }); }
  function setLoop(on) { if (!S.clip) return; pushHistory(); let c = JSON.parse(JSON.stringify(S.clip)); c.loop = !!on; if (on) c = E().refine(c).clip; c.edited = true; c.report = E().validate(c); setClip(c, { keepT: true, noPrev: true }); }
  function autoFix() { if (!S.clip) return; pushHistory(); const r = E().refine(S.clip); setClip(r.clip, { keepT: true }); toast(r.changed ? "Fixed: " + r.clip.fixes.slice(-3).join("; ") : "Nothing to fix automatically"); }

  // ───────────────────────── transport ─────────────────────────
  function play() { if (!S.clip) return; if (S.t >= S.clip.duration - 1e-6) S.t = 0; S.playing = true; S.lastTs = 0; cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(tick); renderTransport(); }
  function pause() { S.playing = false; cancelAnimationFrame(S.raf); renderTransport(); }
  function stop() { S.playing = false; cancelAnimationFrame(S.raf); S.t = 0; renderAll(); }
  function tick(ts) {
    if (!S.playing || !S.clip) return;
    if (!S.lastTs) S.lastTs = ts;
    const dt = Math.min(0.1, (ts - S.lastTs) / 1000) * S.speed; S.lastTs = ts;
    S.t += dt;
    if (S.t >= S.clip.duration) { if (S.clip.loop || D.loopPlay.classList.contains("on")) S.t = S.t % S.clip.duration; else { S.t = S.clip.duration; S.playing = false; } }
    renderPreview(); renderTransport(); renderTimeline();
    if (S.playing) S.raf = requestAnimationFrame(tick);
  }
  function scrub(t) { S.t = clamp(t, 0, S.clip ? S.clip.duration : 0); renderPreview(); renderTransport(); renderTimeline(); }

  // ───────────────────────── Studio / AI / files ─────────────────────────
  async function buildInStudio() {
    if (!S.clip) return toast("Generate a clip first");
    if (!S.hooks.runTool) return toast("Studio actions are unavailable here");
    if (S.busy) return;
    S.busy = true; setStatus("Building in Studio…"); D.buildBtn.disabled = true;
    try {
      const res = await S.hooks.runTool("animation_build", { clip: S.clip });
      const text = String(res || "");
      const okRes = !/^ERROR/i.test(text) && !/"ok"\s*:\s*false/.test(text);
      if (okRes) { S.built = { name: S.clip.name, at: Date.now() }; setStatus("Built in Studio: " + S.clip.name); toast("Built in Studio — " + S.clip.name); }
      else { setStatus(text.slice(0, 220)); toast("Build failed — see the status line"); }
      diag("build", { ok: okRes, res: text.slice(0, 200) });
    } catch (e) { setStatus("Build error: " + (e && e.message || e)); toast("Build error"); }
    finally { S.busy = false; D.buildBtn.disabled = false; renderStatus(); }
  }
  async function previewInStudio() {
    if (!S.clip) return toast("Generate a clip first");
    if (!S.hooks.runTool) return toast("Studio actions are unavailable here");
    if (S.busy) return;
    if (!S.built || S.built.name !== S.clip.name) { await buildInStudio(); if (!S.built) return; }
    S.busy = true; setStatus("Previewing in Studio…");
    try { const res = await S.hooks.runTool("animation_preview", {}); const text = String(res || ""); setStatus(/^ERROR/i.test(text) ? text.slice(0, 220) : "Playing in the Studio viewport"); toast(/^ERROR/i.test(text) ? "Preview failed" : "Previewing in Studio"); }
    catch (e) { setStatus("Preview error: " + (e && e.message || e)); }
    finally { S.busy = false; }
  }
  function buildMessage() {
    if (!S.clip) return "";
    const c = S.clip; const r = c.report || E().validate(c);
    const lines = [
      "ANIMATION STUDIO HAND-OFF (ORscript): the user authored this clip in the Animation Studio. Treat it as the reference - review it, do not redesign it.",
      `Clip: ${c.name} - ${c.duration}s, ${c.keys.length} keys @ ${c.fps} fps, ${c.rigType}, ${c.loop ? "looping" : "one-shot"}, priority ${c.priority}, quality ${c.quality}.`,
      `Prompt: ${c.prompt}`,
    ];
    if (c.stages && c.stages.length > 1) lines.push("Stages: " + c.stages.map((s) => `${s.name} ${s.t0}-${s.t1}s`).join(", "));
    if (c.feedback && c.feedback.length) lines.push("Feedback applied: " + c.feedback.map((f) => f.text).join(" | "));
    lines.push(`Validation: score ${r.score}/100, ${r.errors} errors, ${r.warnings} warnings` + (r.issues.filter((i) => i.level !== "info").slice(0, 4).map((i) => "; " + i.msg).join("")));
    if (c.limitations && c.limitations.length) lines.push("Limits: " + c.limitations.join(" | "));
    if (c.persona && c.persona.traits) lines.push(`Persona: ${c.persona.traits.join(", ")}${c.take ? `; take ${c.take + 1}` : ""}${c.mirrored ? "; mirrored" : ""}${c.travel ? "; root motion" : ""}; fingerprint ${c.fingerprint || "?"}`);
    lines.push(S.built && S.built.name === c.name ? `It is ALREADY BUILT in Studio as ServerStorage.RobloxScript.AnimLib.${c.name} (active animation). Run animation_preview, then animation_simulate {all:true}; refine with animation_refine {feedback} if needed.` : `Build it with animation_generate {prompt: "${c.prompt.replace(/"/g, "'")}", name: "${c.name}", quality: "${c.quality}", duration: ${c.duration}, loop: ${c.loop}} then animation_preview.`);
    const intent = D && D.intent.value.trim(); if (intent) lines.push("User notes: " + intent);
    return lines.join("\n");
  }
  async function sendToAI() {
    if (!S.clip) return toast("Generate a clip first");
    if (!S.hooks.send) return toast("Chat hand-off is unavailable here");
    const msg = buildMessage(); setStatus("Sending to the AI…");
    try { const ok = await S.hooks.send(msg, (m) => setStatus(m)); if (ok !== false) { toast("Sent to the AI"); close(); } else setStatus("Not sent - is the session started?"); }
    catch (e) { setStatus("Send failed: " + (e && e.message || e)); }
  }
  function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: type || "application/octet-stream" })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function exportRbxmx() {
    if (!S.clip) return toast("Generate a clip first");
    const r = S.clip.report || E().validate(S.clip);
    if (!r.ok) return toast("Fix the validation errors before exporting");
    const info = S.rigInfo && S.rigInfo.rigType === S.clip.rigType ? S.rigInfo : E().defaultRigInfo(S.clip.rigType);
    const xml = E().toRbxmx(S.clip, info);
    download(S.clip.name + ".rbxmx", xml, "application/xml");
    toast(`Saved ${S.clip.name}.rbxmx (${S.clip.rigType} bone names)`);
    diag("export", { bytes: xml.length, rig: info.rigType });
  }
  function saveProject() { if (!S.clip) return toast("Generate a clip first"); download(S.clip.name + ".oranim.json", E().serializeProject(S.clip), "application/json"); toast("Project saved"); }
  function openProject(file) {
    const rd = new FileReader();
    rd.onload = () => { try { const clip = E().parseProject(String(rd.result)); pushHistory(); setClip(clip); D.prompt.value = clip.prompt || ""; D.quality.value = clip.quality || "balanced"; D.rig.value = clip.rigType || "R15"; D.duration.value = clip.duration; D.fps.value = clip.fps; D.loop.checked = !!clip.loop; D.loopAuto = false; toast("Project opened: " + clip.name); } catch (e) { toast("Not an ORscript animation project: " + (e && e.message || e)); } };
    rd.readAsText(file);
  }

  // ───────────────────────── rendering ─────────────────────────
  function renderAll() { if (!D) return; renderPreview(); renderTransport(); renderTimeline(); renderJoints(); renderInspector(); renderReport(); renderStages(); renderStatus(); }
  function setStatus(m) { if (D) D.status.textContent = m || ""; }
  function renderStatus() {
    if (!D) return;
    const c = S.clip;
    D.meta.textContent = c ? `${c.name} · ${c.duration}s · ${c.keys.length} keys · ${c.fps} fps · ${c.rigType} · ${c.loop ? "loop" : "one-shot"} · ${c.priority}${c.edited ? " · edited" : ""}` : "No clip yet - describe one and press Generate";
    const ready = S.hooks.studioReady ? !!S.hooks.studioReady() : false;
    D.studioDot.className = "rsa-dot " + (ready ? "on" : "off"); D.studioDot.title = ready ? "Studio connected" : "Studio not connected - Build / Preview will fail; export .rbxmx still works";
    D.undoBtn.disabled = !S.history.length; D.redoBtn.disabled = !S.future.length;
    D.empty.hidden = !!c;
  }
  function project(pt, view, box) { // semantic (x right, y up, z back) → canvas
    const sx = view === "front" ? pt[0] : -pt[2];
    return [box.x + box.w / 2 + sx * box.s, box.y + box.h - (pt[1]) * box.s - box.pad];
  }
  const BONES = [["root", "waist"], ["waist", "neck"], ["neck", "neck_tip"], ["waist", "l_shoulder"], ["l_shoulder", "l_elbow"], ["l_elbow", "l_wrist"], ["l_wrist", "l_wrist_tip"], ["waist", "r_shoulder"], ["r_shoulder", "r_elbow"], ["r_elbow", "r_wrist"], ["r_wrist", "r_wrist_tip"], ["root", "l_hip"], ["l_hip", "l_knee"], ["l_knee", "l_ankle"], ["l_ankle", "l_ankle_tip"], ["root", "r_hip"], ["r_hip", "r_knee"], ["r_knee", "r_ankle"], ["r_ankle", "r_ankle_tip"]];
  function drawSkeleton(ctx, pts, view, box, style) {
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const [a, b] of BONES) {
      const A = project(pts[a], view, box), B = project(pts[b], view, box);
      const left = a.startsWith("l_"), right = a.startsWith("r_");
      ctx.strokeStyle = style.ghost ? "rgba(255,255,255,.22)" : left ? "#7fb2ff" : right ? "#ff9f6e" : "#e8e8ec";
      ctx.lineWidth = style.ghost ? 2 : (a === "root" || a === "waist" ? 5 : 3.5);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    }
    const head = project(pts.neck_tip, view, box), neck = project(pts.neck, view, box);
    const r = Math.max(4, Math.hypot(head[0] - neck[0], head[1] - neck[1]) * 0.55);
    ctx.beginPath(); ctx.arc(head[0], head[1], r, 0, Math.PI * 2); ctx.fillStyle = style.ghost ? "rgba(255,255,255,.12)" : "rgba(232,232,236,.9)"; ctx.fill();
    if (style.weapon === "sword" && !style.ghost) { const w = project(pts.r_wrist, view, box), t = project(pts.r_wrist_tip, view, box); const dx = t[0] - w[0], dy = t[1] - w[1]; ctx.strokeStyle = "#c9d6ff"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(t[0] + dx * 3.2, t[1] + dy * 3.2); ctx.stroke(); }
    if (!style.ghost) { ctx.fillStyle = "#ffd166"; for (const j of ["l_wrist_tip", "r_wrist_tip", "l_ankle_tip", "r_ankle_tip"]) { const p = project(pts[j], view, box); ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
  }
  function renderPreview() {
    if (!D) return;
    const cv = D.canvas; const W = cv.clientWidth || 600, H = cv.clientHeight || 360; const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0d0d10"; ctx.fillRect(0, 0, W, H);
    const views = S.view === "both" ? ["front", "side"] : [S.view];
    const vw = W / views.length;
    const poses = S.clip ? E().sampleAt(S.clip, S.t) : null;
    const ghost = S.ghost && S.prev ? E().sampleAt(S.prev, clamp(S.t, 0, S.prev.duration)) : null;
    views.forEach((view, i) => {
      const box = { x: i * vw, y: 0, w: vw, h: H, pad: 24, s: Math.min(vw / 7.5, (H - 48) / 6.4) };
      const gy = box.y + box.h - box.pad;
      ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(box.x + 12, gy); ctx.lineTo(box.x + box.w - 12, gy); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillText(view === "front" ? "FRONT  (x →)" : "SIDE  (forward →)", box.x + 12, 14);
      if (i) { ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.beginPath(); ctx.moveTo(box.x, 0); ctx.lineTo(box.x, H); ctx.stroke(); }
      if (!poses) return;
      const weapon = S.clip.intent && S.clip.intent.weapon;
      if (ghost) drawSkeleton(ctx, E().forwardKinematics(ghost), view, box, { ghost: true });
      drawSkeleton(ctx, E().forwardKinematics(poses), view, box, { weapon });
    });
    if (S.clip) { ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillText(`schematic skeleton preview · t=${fmt(S.t, 2)}s${S.ghost && S.prev ? " · ghost = previous version" : ""}`, 12, H - 8); }
  }
  function renderTransport() {
    if (!D) return;
    D.playBtn.innerHTML = S.playing ? I.pause : I.play; D.playBtn.title = S.playing ? "Pause (Space)" : "Play (Space)";
    D.time.textContent = `${fmt(S.t, 2)} / ${S.clip ? fmt(S.clip.duration, 2) : "0.00"} s`;
    D.scrub.max = S.clip ? String(S.clip.duration) : "1"; D.scrub.step = S.clip ? String(1 / S.clip.fps) : "0.01"; if (document.activeElement !== D.scrub) D.scrub.value = String(S.t);
    const ready = !!S.clip;
    for (const b of [D.playBtn, D.stopBtn, D.loopPlay, D.speed, D.scrub, D.ghostBtn, D.fixBtn, D.exportBtn, D.saveBtn, D.buildBtn, D.previewBtn, D.sendBtn, D.varBtn, D.regenBtn, D.refineBtn, D.feedback]) b.disabled = !ready;
    D.ghostBtn.classList.toggle("on", S.ghost); D.ghostBtn.disabled = !(S.prev && S.clip);
  }
  function renderTimeline() {
    if (!D) return;
    const cv = D.timeline; const W = cv.clientWidth || 600, H = cv.clientHeight || 76; const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#101014"; ctx.fillRect(0, 0, W, H);
    if (!S.clip) return;
    const c = S.clip; const L = 10, R = W - 10, span = R - L; const x = (t) => L + (t / c.duration) * span;
    // stage bands
    (c.stages || []).forEach((s, i) => { ctx.fillStyle = i % 2 ? "rgba(120,160,255,.08)" : "rgba(255,159,110,.08)"; ctx.fillRect(x(s.t0), 0, Math.max(1, x(s.t1) - x(s.t0)), 16); ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = "9px ui-monospace, Consolas, monospace"; const label = s.name.replace(/:.*$/, ""); if (x(s.t1) - x(s.t0) > label.length * 5.5) ctx.fillText(label, x(s.t0) + 3, 11); });
    // ticks
    ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1; const step = c.duration > 4 ? 1 : c.duration > 1.5 ? 0.5 : 0.1;
    for (let t = 0; t <= c.duration + 1e-9; t += step) { ctx.beginPath(); ctx.moveTo(x(t), 18); ctx.lineTo(x(t), H - 14); ctx.stroke(); ctx.fillStyle = "rgba(255,255,255,.4)"; ctx.font = "9px ui-monospace, Consolas, monospace"; ctx.fillText(fmt(t, 1), x(t) + 2, H - 3); }
    // issues
    for (const iss of (c.report && c.report.issues || [])) if (Number.isFinite(iss.t) && iss.level !== "info") { ctx.fillStyle = iss.level === "error" ? "rgba(255,90,90,.9)" : "rgba(255,200,80,.8)"; ctx.fillRect(x(iss.t) - 1, 18, 2, 6); }
    // keys
    const cy = H / 2 + 6;
    c.keys.forEach((k, i) => {
      const kx = S.drag && S.drag.index === i ? x(S.drag.t) : x(k.t); const sel = i === S.sel;
      ctx.beginPath(); ctx.moveTo(kx, cy - 8); ctx.lineTo(kx + 7, cy); ctx.lineTo(kx, cy + 8); ctx.lineTo(kx - 7, cy); ctx.closePath();
      ctx.fillStyle = sel ? "#ffd166" : k.tag === "impact" ? "#ff7b6b" : k.synthetic ? "rgba(200,200,210,.55)" : "#9ec1ff"; ctx.fill();
      if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
    // playhead
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x(S.t), 16); ctx.lineTo(x(S.t), H - 14); ctx.stroke();
  }
  function timelineHit(ev) { const r = D.timeline.getBoundingClientRect(); const W = r.width, L = 10, span = W - 20; const t = clamp(((ev.clientX - r.left) - L) / span, 0, 1) * (S.clip ? S.clip.duration : 1); let hit = -1; if (S.clip) S.clip.keys.forEach((k, i) => { const kx = L + (k.t / S.clip.duration) * span; if (Math.abs(kx - (ev.clientX - r.left)) <= 8) hit = i; }); return { t, hit }; }
  function renderJoints() {
    if (!D) return;
    const type = S.clip ? S.clip.rigType : "R15"; const map = E().boneMap(E().defaultRigInfo(type)).map;
    D.joints.innerHTML = E().JOINTS.map((j) => `<button type="button" class="rsa-joint${j === S.selJoint ? " on" : ""}${map[j] ? "" : " off"}" data-joint="${j}" title="${map[j] ? "Pose name " + esc(map[j]) : "not on an " + type + " rig (folded into its parent)"}">${esc(JOINT_LABEL[j])}<small>${esc(map[j] || "folded")}</small></button>`).join("");
  }
  function renderInspector() {
    if (!D) return;
    const k = S.clip && S.clip.keys[S.sel];
    if (!k) { D.inspector.innerHTML = `<div class="rsa-muted">Select a keyframe on the timeline.</div>`; return; }
    const p = k.poses[S.selJoint] || { rot: [0, 0, 0] }; const L = E().LIMITS[S.selJoint];
    const num = (label, val, idx, min, max, step) => `<label class="rsa-num"><span>${label}</span><input type="number" data-axis="${idx}" value="${Number(val).toFixed(idx < 3 ? 1 : 2)}" min="${min}" max="${max}" step="${step}"></label>`;
    D.inspector.innerHTML = `
      <div class="rsa-kv"><b>Key ${S.sel + 1}/${S.clip.keys.length}</b><span>t = ${fmt(k.t, 3)} s · ${esc(k.tag || "key")}${k.stage ? " · " + esc(k.stage) : ""}${k.synthetic ? " · auto" : ""}</span></div>
      <div class="rsa-row"><label class="rsa-sel">Easing <select data-ease="style">${["CubicV2", "Linear", "Constant", "Elastic", "Bounce"].map((s) => `<option${(k.ease || [])[0] === s ? " selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="rsa-sel"><select data-ease="dir">${["Out", "In", "InOut"].map((s) => `<option${(k.ease || [])[1] === s ? " selected" : ""}>${s}</option>`).join("")}</select></label></div>
      <div class="rsa-kv"><b>${esc(JOINT_LABEL[S.selJoint])}</b><span>degrees · limits x ${L.x[0]}..${L.x[1]} · y ${L.y[0]}..${L.y[1]} · z ${L.z[0]}..${L.z[1]}</span></div>
      <div class="rsa-nums">${num("X flex", p.rot[0], 0, L.x[0], L.x[1], 1)}${num("Y twist", p.rot[1], 1, L.y[0], L.y[1], 1)}${num("Z roll", p.rot[2], 2, L.z[0], L.z[1], 1)}</div>
      ${S.selJoint === "root" ? `<div class="rsa-nums">${num("pos X", (p.pos || [0, 0, 0])[0], 3, -5, 5, 0.05)}${num("pos Y", (p.pos || [0, 0, 0])[1], 4, -5, 5, 0.05)}${num("pos Z", (p.pos || [0, 0, 0])[2], 5, -5, 5, 0.05)}</div>` : ""}
      <div class="rsa-row"><button type="button" class="rsa-btn" data-act="resetJoint">Reset joint</button><button type="button" class="rsa-btn" data-act="dupKey" title="Duplicate this key one frame later">${I.dup} Duplicate key</button><button type="button" class="rsa-btn danger" data-act="delKey">${I.trash} Delete key</button></div>
      <div class="rsa-muted">Tip: X = forward/back swing (limbs) or lean (torso), Y = twist, Z = sideways. Values are converted to each rig's real joint frames on build.</div>`;
  }
  function renderReport() {
    if (!D) return;
    const r = S.clip && S.clip.report;
    if (!r) { D.report.innerHTML = ""; D.score.textContent = "–"; D.score.className = "rsa-score"; return; }
    D.score.textContent = String(r.score); D.score.className = "rsa-score " + (r.errors ? "bad" : r.score >= 90 ? "good" : "mid");
    const items = r.issues.slice(0, 40).map((i, idx) => `<li class="rsa-issue ${i.level}" data-issue="${idx}" ${Number.isFinite(i.t) ? `data-t="${i.t}"` : ""}>${esc(i.msg)}</li>`).join("");
    const fixes = S.clip.fixes && S.clip.fixes.length ? `<div class="rsa-fixes">Auto-fixes: ${esc(S.clip.fixes.join("; "))}</div>` : "";
    const lim = S.clip.limitations && S.clip.limitations.length ? `<div class="rsa-fixes">Limits: ${esc(S.clip.limitations.join(" | "))}</div>` : "";
    const fb = S.clip.feedback && S.clip.feedback.length ? `<div class="rsa-fixes">Feedback: ${esc(S.clip.feedback.map((f) => f.text + " → " + f.applied.join(", ")).join(" | "))}</div>` : "";
    D.report.innerHTML = (items ? `<ul class="rsa-issues">${items}</ul>` : `<div class="rsa-ok">No issues - joint limits, continuity, timing and loop seam all pass.</div>`) + fixes + lim + fb;
    if (D.persona) { const P = S.clip.persona; D.persona.textContent = P && P.traits ? `Persona: ${P.traits.join(" · ")}${S.clip.take ? ` · take ${S.clip.take + 1}` : ""}${S.clip.mirrored ? " · mirrored" : ""}${S.clip.travel ? " · root motion" : ""} · id ${S.clip.fingerprint || "?"}` : ""; }
  }
  function renderStages() {
    if (!D) return;
    const c = S.clip;
    D.stages.innerHTML = c && c.stages ? c.stages.map((s) => `<button type="button" class="rsa-stage" data-t0="${s.t0}">${esc(s.name.replace(/:.*$/, ""))}<small>${fmt(s.t0, 2)}–${fmt(s.t1, 2)}s</small></button>`).join("") : "";
  }

  // ───────────────────────── DOM ─────────────────────────
  function build() {
    const host = document.createElement("div"); host.id = "rs-anim"; host.tabIndex = -1;
    const logo = assetUrl("assets/gui-studio-mark.png");
    host.innerHTML = `
      <div class="rsa-shell" role="dialog" aria-label="Animation Studio">
        <div class="rsa-toast" aria-live="polite"></div>
        <div class="rsa-title">
          <span class="rsa-brand" title="Animation Studio by ORscript"><img class="rsa-logo" alt="" src="${esc(logo)}">Animation Studio<small>by ORscript</small></span>
          <span class="rsa-meta" data-ref="meta"></span>
          <span class="rsa-dot off" data-ref="studioDot"></span>
          <div class="rsa-title-actions">
            <button type="button" class="rsa-ib" data-act="undo" data-ref="undoBtn" title="Undo (Ctrl+Z)">${I.undo}</button>
            <button type="button" class="rsa-ib" data-act="redo" data-ref="redoBtn" title="Redo (Ctrl+Y)">${I.redo}</button>
            <span class="rsa-sep"></span>
            <button type="button" class="rsa-ib" data-act="open" title="Open a saved project (.oranim.json)">${I.open}</button>
            <button type="button" class="rsa-ib" data-act="save" data-ref="saveBtn" title="Save the project (.oranim.json)">${I.save}</button>
            <button type="button" class="rsa-ib" data-act="export" data-ref="exportBtn" title="Export a Roblox KeyframeSequence (.rbxmx) - drag it into Studio or import it">${I.export}</button>
            <span class="rsa-sep"></span>
            <button type="button" class="rsa-ib rsa-close" data-act="close" title="Close (Esc)">${I.close}</button>
          </div>
        </div>
        <div class="rsa-body">
          <aside class="rsa-left">
            <div class="rsa-h">Describe the animation</div>
            <textarea data-ref="prompt" rows="4" placeholder="e.g. extremely fluid anime sword combo with anticipation, rapid strikes, a spinning finisher and a dramatic landing"></textarea>
            <div class="rsa-chips">${PRESETS.map((p) => `<button type="button" class="rsa-chip" data-preset="${esc(p[1])}">${esc(p[0])}</button>`).join("")}</div>
            <div class="rsa-grid">
              <label>Quality<select data-ref="quality"><option value="fast">Fast</option><option value="balanced" selected>Balanced</option><option value="high">High Quality</option><option value="cinematic">Cinematic</option></select></label>
              <label>Rig<select data-ref="rig"><option value="R15" selected>R15</option><option value="R6">R6</option></select></label>
              <label>Duration (s)<input data-ref="duration" type="number" min="0.1" max="60" step="0.1" placeholder="auto"></label>
              <label>FPS<input data-ref="fps" type="number" min="10" max="120" step="1" placeholder="auto"></label>
              <label class="rsa-check"><input data-ref="loop" type="checkbox"> Loop</label>
            </div>
            <button type="button" class="rsa-btn primary big" data-act="generate">Generate</button>
            <div class="rsa-row"><button type="button" class="rsa-btn" data-act="regen" data-ref="regenBtn" title="Regenerate from the same prompt (discards manual edits)">Regenerate</button><button type="button" class="rsa-btn" data-act="variation" data-ref="varBtn" title="New take: same prompt, a different persona and choreography (fingerprint guaranteed to differ)">New take</button><button type="button" class="rsa-btn" data-act="mirror" data-ref="mirrorBtn" title="Swap left and right (left-handed version)">Mirror</button></div>
            <div class="rsa-persona" data-ref="persona" title="Who this clip is: the seeded persona behind its asymmetry, fidget, easing and tempo"></div>
            <div class="rsa-h">Refine with feedback</div>
            <div class="rsa-row"><input data-ref="feedback" type="text" placeholder="faster attacks, more anticipation, heavier landing"><button type="button" class="rsa-btn" data-act="refine" data-ref="refineBtn">Refine</button></div>
            <div class="rsa-h">Stages</div>
            <div class="rsa-stages" data-ref="stages"></div>
            <div class="rsa-h">Validation <span class="rsa-score" data-ref="score">–</span><button type="button" class="rsa-btn mini" data-act="fix" data-ref="fixBtn" title="Clamp limits, bridge jumps, close the loop">Auto-fix</button></div>
            <div class="rsa-report" data-ref="report"></div>
          </aside>
          <main class="rsa-main">
            <div class="rsa-stagewrap">
              <canvas class="rsa-canvas" data-ref="canvas"></canvas>
              <div class="rsa-empty" data-ref="empty"><b>Describe an animation, then Generate</b><span>Idle loops, walk / run cycles, jumps, combat combos, dodges, blocks, spell casts, emotes. Pick a preset on the left to start.</span><span>Preview is a schematic skeleton - use Preview in Studio for the real rig.</span></div>
              <div class="rsa-viewsel"><button type="button" class="rsa-chip on" data-view="both">Front + Side</button><button type="button" class="rsa-chip" data-view="front">Front</button><button type="button" class="rsa-chip" data-view="side">Side</button></div>
            </div>
            <div class="rsa-transport">
              <button type="button" class="rsa-ib" data-act="play" data-ref="playBtn" title="Play (Space)">${I.play}</button>
              <button type="button" class="rsa-ib" data-act="stop" data-ref="stopBtn" title="Stop">${I.stop}</button>
              <button type="button" class="rsa-ib tgl" data-act="loopPlay" data-ref="loopPlay" title="Loop playback in this preview">${I.loop}</button>
              <select data-ref="speed" title="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
              <input data-ref="scrub" type="range" min="0" max="1" step="0.01" value="0" title="Scrub">
              <span class="rsa-time" data-ref="time">0.00 / 0.00 s</span>
              <button type="button" class="rsa-ib tgl" data-act="ghost" data-ref="ghostBtn" title="Before / after: show the previous version as a ghost">${I.ghost}</button>
            </div>
            <canvas class="rsa-timeline" data-ref="timeline" title="Click to scrub · drag a key to retime it · click a key to edit it"></canvas>
            <div class="rsa-foot">
              <span class="rsa-status" data-ref="status"></span>
              <input data-ref="intent" type="text" placeholder="Notes for the AI (optional)">
              <button type="button" class="rsa-btn" data-act="send" data-ref="sendBtn" title="Hand the clip to the AI in the chat">Send to AI</button>
              <button type="button" class="rsa-btn" data-act="previewStudio" data-ref="previewBtn" title="Build if needed, then play it on the rig in Studio">Preview in Studio</button>
              <button type="button" class="rsa-btn primary" data-act="build" data-ref="buildBtn" title="Write the KeyframeSequence into Studio now (animation_build)">Build in Studio</button>
            </div>
          </main>
          <aside class="rsa-right">
            <div class="rsa-h">Joints</div>
            <div class="rsa-joints" data-ref="joints"></div>
            <div class="rsa-h">Selected key</div>
            <div class="rsa-inspector" data-ref="inspector"></div>
          </aside>
        </div>
        <input type="file" accept=".json,application/json" data-ref="file" hidden>
      </div>`;
    document.body.appendChild(host);
    D = { host, toast: host.querySelector(".rsa-toast") };
    host.querySelectorAll("[data-ref]").forEach((el) => { D[el.getAttribute("data-ref")] = el; });
    D.loopAuto = true;
    // actions
    host.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]"); if (act) { e.preventDefault(); return doAction(act.getAttribute("data-act")); }
      const preset = e.target.closest("[data-preset]"); if (preset) { D.prompt.value = preset.getAttribute("data-preset"); D.loopAuto = true; D.duration.value = ""; generate(); return; }
      const joint = e.target.closest("[data-joint]"); if (joint) { S.selJoint = joint.getAttribute("data-joint"); renderJoints(); renderInspector(); return; }
      const view = e.target.closest("[data-view]"); if (view) { S.view = view.getAttribute("data-view"); host.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b === view)); renderPreview(); return; }
      const st = e.target.closest("[data-t0]"); if (st) { scrub(parseFloat(st.getAttribute("data-t0"))); S.sel = nearestKey(S.t); renderAll(); return; }
      const iss = e.target.closest("[data-issue]"); if (iss && iss.hasAttribute("data-t")) { scrub(parseFloat(iss.getAttribute("data-t"))); S.sel = nearestKey(S.t); renderAll(); }
    });
    host.addEventListener("change", (e) => {
      const t = e.target;
      if (t === D.speed) { S.speed = parseFloat(t.value) || 1; return; }
      if (t === D.loop) { D.loopAuto = false; if (S.clip) setLoop(t.checked); return; }
      if (t === D.fps && S.clip) { setFps(t.value); return; }
      if (t === D.duration && S.clip) { retime(t.value); return; }
      if (t.hasAttribute && t.hasAttribute("data-axis")) { setJointValue(parseInt(t.getAttribute("data-axis"), 10), t.value); return; }
      if (t.hasAttribute && t.hasAttribute("data-ease")) { const k = S.clip.keys[S.sel]; const style = D.inspector.querySelector('[data-ease="style"]').value, dir = D.inspector.querySelector('[data-ease="dir"]').value; if (k) setEasing(style, dir); return; }
      if (t === D.file && t.files && t.files[0]) { openProject(t.files[0]); t.value = ""; }
    });
    D.scrub.addEventListener("input", () => { if (S.playing) pause(); scrub(parseFloat(D.scrub.value) || 0); });
    D.prompt.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generate(); } });
    D.feedback.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); refine(); } });
    // timeline interaction
    D.timeline.addEventListener("pointerdown", (e) => {
      if (!S.clip) return; const { t, hit } = timelineHit(e);
      if (S.playing) pause();
      if (hit >= 0) { S.sel = hit; S.drag = { index: hit, t: S.clip.keys[hit].t, moved: false }; try { D.timeline.setPointerCapture(e.pointerId); } catch {} S.t = S.clip.keys[hit].t; renderAll(); }
      else { scrub(t); }
    });
    D.timeline.addEventListener("pointermove", (e) => { if (!S.drag || !S.clip) return; const { t } = timelineHit(e); const step = 1 / S.clip.fps; S.drag.t = Math.round(t / step) * step; S.drag.moved = true; S.t = S.drag.t; renderTimeline(); renderPreview(); renderTransport(); });
    const endDrag = (e) => { if (!S.drag) return; const d = S.drag; S.drag = null; try { D.timeline.releasePointerCapture(e.pointerId); } catch {} if (d.moved && Math.abs(d.t - S.clip.keys[d.index].t) > 1e-6) { pushHistory(); const c = E().moveKey(S.clip, d.index, d.t); setClip(c, { keepT: true, noPrev: true }); S.sel = nearestKey(d.t); renderAll(); } else renderTimeline(); };
    D.timeline.addEventListener("pointerup", endDrag); D.timeline.addEventListener("pointercancel", endDrag);
    host.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName || "").toLowerCase(); const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && !typing && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && !typing && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (typing) return;
      if (e.key === " ") { e.preventDefault(); if (S.playing) pause(); else play(); }
      else if (e.key === "ArrowRight" && S.clip) { e.preventDefault(); if (e.shiftKey) selectKey(S.sel + 1); else scrub(S.t + 1 / S.clip.fps); }
      else if (e.key === "ArrowLeft" && S.clip) { e.preventDefault(); if (e.shiftKey) selectKey(S.sel - 1); else scrub(S.t - 1 / S.clip.fps); }
      else if (e.key === "Delete" && S.clip) { e.preventDefault(); deleteKey(); }
      else if (e.key === "Home") { e.preventDefault(); scrub(0); } else if (e.key === "End" && S.clip) { e.preventDefault(); scrub(S.clip.duration); }
    });
    window.addEventListener("resize", () => { if (S.open) { renderPreview(); renderTimeline(); } });
    renderAll();
  }
  function doAction(name) {
    switch (name) {
      case "generate": return generate();
      case "regen": return regenerate();
      case "variation": return variation();
      case "mirror": return mirrorClip();
      case "refine": return refine();
      case "fix": return autoFix();
      case "undo": return undo();
      case "redo": return redo();
      case "open": return D.file.click();
      case "save": return saveProject();
      case "export": return exportRbxmx();
      case "close": return close();
      case "play": return S.playing ? pause() : play();
      case "stop": return stop();
      case "loopPlay": D.loopPlay.classList.toggle("on"); return;
      case "ghost": S.ghost = !S.ghost; renderPreview(); renderTransport(); return;
      case "resetJoint": return resetJoint();
      case "dupKey": return duplicateKey();
      case "delKey": return deleteKey();
      case "build": return buildInStudio();
      case "previewStudio": return previewInStudio();
      case "send": return sendToAI();
      default: return;
    }
  }

  // ───────────────────────── public ─────────────────────────
  function open(hooks) {
    if (!E()) { try { (hooks && hooks.toast || alert)("Animation engine module missing — reload the extension"); } catch {} return; }
    S.hooks = hooks || S.hooks || {};
    if (!D) build();
    S.open = true; D.host.classList.add("open"); document.documentElement.classList.add("rs-anim-open");
    const canStudio = !!S.hooks.runTool; D.buildBtn.hidden = !canStudio; D.previewBtn.hidden = !canStudio; D.sendBtn.hidden = !S.hooks.send;
    if (!S.clip) { const saved = loadAutosave(); if (saved) { try { saved.report = E().validate(saved); S.clip = saved; D.prompt.value = saved.prompt || ""; D.quality.value = saved.quality || "balanced"; D.rig.value = saved.rigType || "R15"; D.loop.checked = !!saved.loop; D.loopAuto = false; D.duration.value = saved.duration; D.fps.value = saved.fps; S.sel = 0; } catch { S.clip = null; } } }
    renderAll();
    requestAnimationFrame(() => { renderPreview(); renderTimeline(); D.host.focus(); });
    diag("open", { clip: S.clip ? S.clip.name : null, engine: S.hooks.engine ? S.hooks.engine() : "" });
  }
  function close() { if (!S.open) return; pause(); S.open = false; D.host.classList.remove("open"); document.documentElement.classList.remove("rs-anim-open"); diag("close", {}); }
  function isOpen() { return S.open; }
  function getClip() { return S.clip; }
  function loadClip(clip, meta) {
    if (!clip || !Array.isArray(clip.keys)) return false;
    if (D) pushHistory(); else S.history.push(S.clip ? JSON.stringify(S.clip) : null), S.history = S.history.filter(Boolean);
    S.sel = 0;
    if (D) { setClip(clip); D.prompt.value = clip.prompt || ""; D.quality.value = clip.quality || "balanced"; D.rig.value = clip.rigType || "R15"; D.loop.checked = !!clip.loop; D.loopAuto = false; D.duration.value = clip.duration; D.fps.value = clip.fps; }
    else { S.clip = clip; autosave(); }
    if (meta && meta.built) S.built = { name: clip.name, at: Date.now() };
    if (meta && meta.rigInfo) S.rigInfo = meta.rigInfo;
    return true;
  }
  function setRigInfo(info) { S.rigInfo = info || null; }
  window.ORAnimStudio = { open, close, isOpen, getClip, loadClip, setRigInfo, generate: (p, o) => { if (!D) build(); return generate(p, o); }, buildMessage, PRESETS, _state: S, _refine: refine, _variation: variation, _selectKey: selectKey, _setJointValue: setJointValue, _retime: retime, _play: play, _pause: pause, _stop: stop, _scrub: scrub, _undo: undo, _redo: redo, _exportRbxmx: exportRbxmx, _timelineHit: timelineHit };
})();
