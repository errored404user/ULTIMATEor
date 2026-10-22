/* ORscript Animation Studio — describe it, preview it, build it in Studio.
 *
 * The visual front-end of the animation engine (animengine.js): a prompt box
 * with quality / rig / duration / loop controls, a schematic rig preview
 * (1.54: orbitable 3D viewport with ground grid, shadow, onion skin and IK
 * handles on hands / feet, plus fixed front / side / top views; still the
 * engine's semantic skeleton, NOT the Roblox renderer), a timeline with
 * draggable keyframes and stage bands, a key workbench (1.64: key strip, breakdown
 * / tween machine, moving holds, frame nudge, KeyframeMarkers, ease presets,
 * overlap / follow-through, retime, motion arcs, timing read), Blender-style
 * key tools (insert / copy / paste / paste flipped / lock, auto-key, pose
 * library) and clip tools (Smooth, Plant feet, Simplify, Reverse, Bake, Cycle
 * offset, Layer = NLA-style upper-body layering), a
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
  const I = { collapse: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    play: SVG('<path d="M7 5v14l12-7z" fill="currentColor" stroke="none"/>'), pause: SVG('<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>'), stop: SVG('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>'),
    loop: SVG('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    undo: SVG('<path d="M9 14H4V9"/><path d="M4 14a8 8 0 1 1 3 6"/>'), redo: SVG('<path d="M15 14h5V9"/><path d="M20 14a8 8 0 1 0-3 6"/>'), close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    save: SVG('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'), open: SVG('<path d="M4 7h5l2 2h9v10H4z"/>'), export: SVG('<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 19h14"/>'),
    dup: SVG('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'), trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    key: SVG('<path d="M12 3l8 9-8 9-8-9z"/>'), copy: SVG('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"/>'), paste: SVG('<rect x="5" y="5" width="14" height="16" rx="1.5"/><path d="M9 5V3h6v2"/><path d="M9 12h6M9 16h6"/>'), flip: SVG('<path d="M12 3v18"/><path d="M8 7L3 12l5 5"/><path d="M16 7l5 5-5 5"/>'), lock: SVG('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'), onion: SVG('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'), cam: SVG('<path d="M4 8h4l2-3h4l2 3h4v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
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

  const S = { rtab: "pose", editorOpen: true, arcs: false, personaSeed: null, builtNames: {}, compat: null, open: false, hooks: {}, clip: null, prev: null, history: [], future: [], sel: -1, selJoint: "r_shoulder", t: 0, playing: false, speed: 1, ghost: false, rigInfo: null, built: null, drag: null, raf: 0, lastTs: 0, busy: false, view: "3d", cam: { yaw: 35, pitch: 18, zoom: 1, pan: [0, 0] }, onion: true, autoKey: false, clipboard: null, handles: [], cams: [], library: {}, ikDrag: null, orbit: null, gdrag: null };
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
    if (D && clip.name) remember(clip);
    renderAll();
  }
  function autosave() { try { if (S.clip) localStorage.setItem(STORAGE_KEY, JSON.stringify({ t: Date.now(), clip: S.clip })); } catch {} }
  function loadAutosave() { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return null; const j = JSON.parse(raw); return j && j.clip && Array.isArray(j.clip.keys) ? j.clip : null; } catch { return null; } }

  // ───────────────────────── generation ─────────────────────────
  function readOpts() {
    const dur = parseFloat(D.duration.value);
    return { quality: D.quality.value, rigType: D.rig.value, duration: Number.isFinite(dur) && dur > 0 ? dur : undefined, loop: D.loop.checked ? true : (D.loopAuto ? undefined : false), fps: parseInt(D.fps.value, 10) || undefined };
  }
  // 1.61 vocabulary browser: everything the engine knows, grouped, click-to-insert (prefix for moods/styles, chain for motions)
  const BROWSE = [
    ["Everyday", "chain", ["drink a potion", "eat", "open a heavy door", "knock on the door", "answer the phone", "take a selfie", "type on a laptop", "read a book", "stir a cauldron", "sweep the floor", "paint a picture", "dig a hole", "chop wood", "push a crate", "pull a rope", "carry a box", "lift a heavy box", "drive a car", "ride a bike", "row a boat", "go fishing", "check the watch", "look around", "think hard", "stretch", "shiver", "yawn", "sneeze", "cough", "wipe the sweat", "scratch", "sit down", "sleep"]],
    ["Social & emotes", "chain", ["wave", "wave both arms", "clap", "cheer", "bow", "curtsy", "salute", "nod", "shake head", "shrug", "facepalm", "point", "taunt", "laugh", "cry", "hug", "handshake", "high five", "fist bump", "thumbs up", "blow a kiss", "pray", "kneel", "pet the dog", "hero pose", "dab", "floss", "twirl", "conduct an orchestra", "give a speech", "beckon"]],
    ["Sport & fitness", "chain", ["jumping jacks", "squats", "sit ups", "pushups", "lunge", "flex", "deadlift", "boxing", "kick a ball", "catch a ball", "baseball swing", "basketball jump shot", "juggle", "meditate", "run in place", "jog", "swim", "climb", "crawl", "dodge roll", "backflip", "front flip", "slide"]],
    ["Combat", "chain", ["sword slash", "8 hit anime sword combo", "3 hit punch combo", "roundhouse kick", "heavy axe slash", "spin attack", "finisher", "block", "parry", "dodge", "cast a fireball", "charge up and transform", "throw a grenade", "shoot pistol", "fire rifle two shots", "draw a bow and release", "hit reaction", "knockback", "death falling backwards", "dash forward", "fly"]],
    ["Cycles", "set", ["idle", "walk cycle", "run cycle", "sneak walk", "zombie walk", "strafe left", "walk backwards", "crouch idle", "sit idle", "sleep", "tread water", "fly idle"]],
    ["Moods", "prefix", ["tired", "proud", "drunk", "scared", "angry", "happy", "sad", "old", "injured", "cold", "energetic", "nervous", "sneaky"]],
    ["Styles & speed", "prefix", ["anime", "realistic", "cartoony", "heavy", "fluid", "robotic", "cute", "ninja", "slow", "fast", "slow motion", "snappy", "subtle", "exaggerated"]],
    ["Body grammar", "chain", ["raise the left arm", "lift both arms", "extend the right arm forward", "spread both arms", "shake the right fist", "kick the right leg forward", "lift the left knee", "turn head left", "tilt head right", "nod", "lean back", "lean forward", "twist the torso", "crouch", "bounce"]],
    ["Compose", "raw", ["… then …", "… while walking", "… while running", "… twice", "… three times", "… with the left hand", "… mirrored", "… with root motion", "… for my knight: idle, walk, run and jump", "… upper body only"]],
  ];
  function vocabBrowserHtml() {
    return BROWSE.map(([title, mode, items]) => `<div class="rsa-browse-g"><div class="rsa-browse-t">${esc(title)}</div><div class="rsa-chips">${items.map((w) => `<button type="button" class="rsa-chip" data-ins="${esc(w)}" data-mode="${mode}">${esc(w)}</button>`).join("")}</div></div>`).join("") +
      `<div class="rsa-muted rsa-browse-foot">Any other verb works too: synonyms are understood ("guzzle", "pirouette", "shovel", "waltz"), and unknown motion verbs are rendered as body-region primitives ("wring", "teeter", "sniff", "shimmy", "tremble", "slump"). Chain with "then", layer with "while", repeat with "twice" / "x3".</div>`;
  }
  function insertVocab(word, mode) {
    const cur = String(D.prompt.value || "").trim(); let next;
    if (mode === "raw") { const w = word.replace(/^…\s*/, ""); next = cur ? (/^then\b|^while\b|^with\b|^twice|^three|^mirrored|^upper|^for my/.test(w) ? cur + " " + w : cur + " " + w) : w.replace(/\s*…$/, ""); }
    else if (mode === "prefix") next = cur ? (new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(cur) ? cur : word + " " + cur) : word + " idle";
    else if (mode === "set") next = cur ? cur + ", " + word : word;
    else next = cur ? cur + " then " + word : word;
    D.prompt.value = next.replace(/\s+/g, " ").trim(); D.loopAuto = true; D.duration.value = ""; D.prompt.focus(); renderUnderstood();
  }
  function vocabLine() {
    const v = E().vocabulary ? E().vocabulary() : null; if (!v) return "";
    const n = (x) => x >= 1000 ? (Math.floor(x / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k+" : String(x);
    return `${v.acts} motions · ${v.categories} move types · ${v.moods} moods · ${n(v.synonyms)} synonyms · ${v.verbClasses}+ verbs · ${v.styles} styles · pose grammar · chains & layers → <b>unlimited</b>`;
  }
  function inspire() { if (!E().inspire) return; const p = E().inspire(); D.prompt.value = p; D.loopAuto = true; D.duration.value = ""; renderUnderstood(); toast("Try: " + p + " - press Generate"); diag("inspire", { prompt: p }); }
  function toggleBrowse() { const open = D.browse.hidden; D.browse.hidden = !open; D.browseBtn.classList.toggle("on", open); D.browseBtn.setAttribute("aria-pressed", open ? "true" : "false"); }
  // live read-back of what the engine understood while typing (before Generate)
  let understoodTimer = 0;
  function renderUnderstood() {
    if (!D || !D.understood) return;
    const text = String(D.prompt.value || "").trim();
    if (!text) { D.understood.textContent = ""; D.understood.hidden = true; return; }
    let i; try { i = E().parseIntent(text); } catch { D.understood.hidden = true; return; }
    const bits = [];
    const setN = E().splitSet ? (E().splitSet(text) || []).length : 0;
    if (setN > 1) bits.push(`${setN} separate clips (one character)`);
    const cat = i.category;
    if (cat === "sequence") bits.push(`${(i.parts || i.clauses || []).length || "several"} motions in a row`);
    else if (cat === "act") bits.push((i.acts || []).join(" + "));
    else if (cat === "gesture") bits.push((i.gesture && i.gesture.synth ? "interpreted " : "gesture ") + ((i.gesture || {}).hits || []).join(", "));
    else if (cat === "improv") bits.push("no motion word yet - will improvise " + (i.improv || []).join(" → "));
    else bits.push(cat.replace(/_/g, " ") + (i.upperText ? " + " + i.upperText : ""));
    if (i.mood) bits.push("mood " + i.mood);
    if (i.style && i.style !== "default") bits.push(i.style);
    if (i.speed && Math.abs(i.speed - 1) > 0.05) bits.push((i.speed > 1 ? "faster ×" : "slower ×") + Number(i.speed).toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
    if (i.repeat) bits.push("×" + i.repeat);
    if (i.swaps && i.swaps.length) bits.push("understood " + i.swaps.slice(0, 3).join(", "));
    if (i.loop) bits.push("loop");
    D.understood.innerHTML = `<span class="rsa-understood-k">${cat === "improv" ? "?" : "→"}</span> ${esc(bits.join(" · "))}`;
    D.understood.classList.toggle("warn", cat === "improv");
    D.understood.hidden = false;
  }
  function generate(prompt, opts) {
    const text = String(prompt == null ? D.prompt.value : prompt).trim();
    if (!text) { toast("Describe the animation first"); D.prompt.focus(); return null; }
    const o = Object.assign(readOpts(), opts || {});
    if (D.loopAuto) delete o.loop;
    if (D.sameChar && D.sameChar.checked && Number.isFinite(S.personaSeed) && !Number.isFinite(o.personaSeed)) o.personaSeed = S.personaSeed;
    // 1.56: "idle, walk, run and jump animations" → a SET of separate clips (one character), never one merged clip
    const setPrompts = !(opts && opts.take) && E().splitSet ? E().splitSet(text) : null;
    if (setPrompts && setPrompts.length > 1) return generateSetHere(text, setPrompts, o);
    let clip;
    try { clip = E().generate(text, o); } catch (e) { toast("Generation failed: " + (e && e.message || e)); diag("generateError", { error: String(e) }); return null; }
    if (!Number.isFinite(S.personaSeed) && Number.isFinite(clip.personaSeed)) S.personaSeed = clip.personaSeed;
    pushHistory();
    S.sel = 0; S.selJoint = clip.intent && clip.intent.category === "attack" ? "r_shoulder" : "root";
    setClip(clip);
    D.prompt.value = text;
    D.loopAuto = false; D.loop.checked = !!clip.loop; D.duration.value = clip.duration; D.fps.value = clip.fps; D.rig.value = clip.rigType; D.quality.value = clip.quality;
    const cat = clip.intent && clip.intent.category;
    const what = cat === "sequence" ? `${(clip.parts || []).length} motions in a row` : cat === "act" ? (clip.intent.acts || []).join(" + ") : cat === "improv" ? "improvised " + (clip.intent.improv || []).join(" → ") : cat === "gesture" ? "gesture: " + ((clip.intent.gesture || {}).hits || []).join(", ") : clip.layered ? `${clip.layered.base} + ${clip.layered.upper}` : cat;
    const swaps = clip.intent && clip.intent.swaps && clip.intent.swaps.length ? "; understood " + clip.intent.swaps.slice(0, 2).join(", ") : "";
    toast(`Generated ${clip.name} (${what}${clip.intent && clip.intent.mood ? ", mood " + clip.intent.mood : ""}${swaps}): ${clip.keys.length} keys, ${clip.duration}s, score ${clip.report.score}/100`);
    renderUnderstood();
    if (cat === "improv" || clip.report.errors) setRightTab("check");
    diag("generate", { prompt: text.slice(0, 80), keys: clip.keys.length, score: clip.report.score, quality: clip.quality, rig: clip.rigType, category: cat });
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
  function generateSetHere(text, prompts, o) {
    let set;
    const avoid = Object.values(libraryClips()).map((c) => c.fingerprint).filter(Boolean);
    try { set = E().generateSet(text, Object.assign({}, o, { duration: undefined, loop: undefined, avoid })); } catch (e) { toast("Set generation failed: " + (e && e.message || e)); diag("generateError", { error: String(e), set: true }); return null; }
    if (!Number.isFinite(S.personaSeed)) S.personaSeed = set.personaSeed;
    pushHistory();
    for (const c of set.clips) remember(c);
    S.compat = set.report; S.sel = 0; S.selJoint = "root";
    setClip(set.clips[0]);
    D.prompt.value = text; D.loopAuto = false; D.loop.checked = !!set.clips[0].loop; D.duration.value = set.clips[0].duration; D.fps.value = set.clips[0].fps; D.rig.value = set.clips[0].rigType; D.quality.value = set.clips[0].quality;
    toast(`${set.clips.length} separate clips, one character: ${set.clips.map((c) => c.name).join(", ")} - compatibility ${set.report.score}/100`);
    setRightTab("clips");
    diag("generateSet", { prompts, names: set.clips.map((c) => c.name), score: set.report.score });
    return set.clips[0];
  }
  function switchClip(name) {
    const lib = libraryClips(); const c = lib[name]; if (!c) return toast("That clip is gone");
    if (S.clip && S.clip.name === name) return;
    if (S.clip) remember(S.clip);
    pushHistory(); S.sel = 0;
    setClip(c, { noPrev: true });
    D.prompt.value = c.prompt || ""; D.quality.value = c.quality || "balanced"; D.rig.value = c.rigType || "R15"; D.loop.checked = !!c.loop; D.loopAuto = false; D.duration.value = c.duration; D.fps.value = c.fps;
    if (S.builtNames[name]) S.built = { name, at: S.builtNames[name] };
    toast("Opened " + name);
  }
  function forgetClip(name) { if (S.library) delete S.library[name]; delete S.builtNames[name]; if (S.clip && S.clip.name === name) { /* keep it open, it just leaves the list */ } renderClipList(); renderLayerPick(); toast("Removed " + name + " from the list"); }
  function checkSet() {
    const clips = Object.values(libraryClips()); if (S.clip && !clips.some((c) => c.name === S.clip.name)) clips.push(S.clip);
    if (clips.length < 2) { toast("Generate at least two clips (or type several at once) to check compatibility"); return null; }
    S.compat = E().compatibility(clips); renderCompat(); setRightTab("check");
    toast(`Compatibility ${S.compat.score}/100 - ${S.compat.issues.length} note${S.compat.issues.length === 1 ? "" : "s"}`);
    diag("checkSet", { n: clips.length, score: S.compat.score });
    return S.compat;
  }
  async function buildAll() {
    if (!S.hooks.runTool) return toast("Studio actions are unavailable here");
    if (S.busy) return;
    const clips = Object.values(libraryClips()); if (S.clip && !clips.some((c) => c.name === S.clip.name)) clips.unshift(S.clip);
    if (!clips.length) return toast("Nothing to build yet");
    S.busy = true; D.buildAllBtn.disabled = true; const okNames = [], bad = [];
    try {
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]; setStatus(`Building ${i + 1}/${clips.length}: ${c.name}…`);
        const r = c.report || E().validate(c); if (!r.ok) { bad.push(c.name + " (validation errors)"); continue; }
        let text = ""; try { text = String(await S.hooks.runTool("animation_build", { clip: c }) || ""); } catch (e) { text = "ERROR " + (e && e.message || e); }
        if (!/^ERROR/i.test(text) && !/"ok"\s*:\s*false/.test(text)) { okNames.push(c.name); S.builtNames[c.name] = Date.now(); if (S.clip && S.clip.name === c.name) S.built = { name: c.name, at: Date.now() }; }
        else bad.push(c.name + ": " + text.slice(0, 120));
      }
    } finally { S.busy = false; D.buildAllBtn.disabled = false; }
    setStatus(`Built ${okNames.length}/${clips.length} in Studio${bad.length ? " - failed: " + bad.join("; ") : ""}`);
    toast(bad.length ? `Built ${okNames.length}/${clips.length} - see the status line` : `Built all ${okNames.length} clips in Studio (one KeyframeSequence each)`);
    renderClipList(); renderStatus(); diag("buildAll", { ok: okNames, bad });
  }
  function exportAll() {
    const clips = Object.values(libraryClips()); if (S.clip && !clips.some((c) => c.name === S.clip.name)) clips.unshift(S.clip);
    if (!clips.length) return toast("Nothing to export yet");
    let n = 0, skipped = 0;
    clips.forEach((c, i) => { const r = c.report || E().validate(c); if (!r.ok) { skipped++; return; } const info = S.rigInfo && S.rigInfo.rigType === c.rigType ? S.rigInfo : E().defaultRigInfo(c.rigType); setTimeout(() => download(c.name + ".rbxmx", E().toRbxmx(c, info), "application/xml"), i * 350); n++; });
    toast(`Exporting ${n} .rbxmx file${n === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped: validation errors)` : ""} - allow multiple downloads if the browser asks`);
    diag("exportAll", { n, skipped });
  }
  function renderClipList() {
    if (!D) return;
    const lib = libraryClips(); const names = Object.keys(lib); const cur = S.clip && S.clip.name;
    if (cur && !lib[cur] && S.clip) names.unshift(cur);
    D.clipCount.textContent = String(names.length);
    const cat = (c) => c.intent && c.intent.category === "sequence" ? "sequence" : c.layered ? "layered" : c.intent && c.intent.category || "clip";
    const pri = (c) => c.priority || (E().setPriority ? E().setPriority(c) : "Action");
    D.clipList.innerHTML = names.length ? names.map((n) => { const c = lib[n] || S.clip; const same = Number.isFinite(S.personaSeed) && c.personaSeed === S.personaSeed; return `<div class="rsa-clipitem${n === cur ? " on" : ""}" data-clip="${esc(n)}" title="${esc(c.prompt || "")}"><b>${esc(n)}</b><span>${esc(cat(c))} · ${c.duration}s · ${c.loop ? "loop" : "one-shot"} · ${esc(pri(c))}${c.intent && c.intent.mood ? " · " + esc(c.intent.mood) : ""}</span><em>${S.builtNames[n] ? `<i class="rsa-badge ok">built</i>` : ""}${same ? `<i class="rsa-badge">same char</i>` : Number.isFinite(S.personaSeed) ? `<i class="rsa-badge warn" title="generated with a different character seed - Check set shows how it blends">other char</i>` : ""}<button type="button" class="rsa-ib mini" data-delclip="${esc(n)}" title="Remove from the list (does not delete anything in Studio)">×</button></em></div>`; }).join("") : `<div class="rsa-muted">No clips yet. Generate one, or several at once.</div>`;
  }
  function renderCompat() {
    if (!D) return;
    const r = S.compat;
    if (!r) { D.compatScore.textContent = "–"; D.compatScore.className = "rsa-score"; D.compat.innerHTML = `<div class="rsa-muted">Two or more clips → Check set (or type several animations at once) to see whether they blend as one character.</div>`; return; }
    D.compatScore.textContent = r.score + "/100"; D.compatScore.className = "rsa-score " + (r.score >= 90 ? "good" : r.score >= 70 ? "mid" : "bad");
    const rows = [r.issues.length ? `<ul class="rsa-issues">${r.issues.map((i) => `<li class="rsa-issue ${esc(i.level)}">${esc(i.msg)}</li>`).join("")}</ul>` : `<div class="rsa-ok">${r.clips || ""} clips fit together: same rig, fps and character, no root pops.</div>`];
    if (r.pairs && r.pairs.length) rows.push(`<div class="rsa-muted">From ${esc(r.idle)}: ` + r.pairs.map((p) => `${esc(p.to)} ${p.deg}° (${esc(p.joint)})${p.height > 0.05 ? `, root Δ${p.height}` : ""} → Play(${p.fade})`).join(" · ") + `</div>`);
    if (r.priorities) rows.push(`<div class="rsa-muted">Priorities: ` + r.priorities.map((p) => `${esc(p.name)} = ${p.priority}${p.loop ? " (loop)" : ""}`).join(", ") + `</div>`);
    D.compat.innerHTML = rows.join("");
  }
  async function buildInStudio() {
    if (!S.clip) return toast("Generate a clip first");
    if (!S.hooks.runTool) return toast("Studio actions are unavailable here");
    if (S.busy) return;
    S.busy = true; setStatus("Building in Studio…"); D.buildBtn.disabled = true;
    try {
      const res = await S.hooks.runTool("animation_build", { clip: S.clip });
      const text = String(res || "");
      const okRes = !/^ERROR/i.test(text) && !/"ok"\s*:\s*false/.test(text);
      if (okRes) { S.built = { name: S.clip.name, at: Date.now() }; S.builtNames[S.clip.name] = Date.now(); renderClipList(); setStatus("Built in Studio: " + S.clip.name); toast("Built in Studio — " + S.clip.name); }
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
  function renderAll() { if (!D) return; renderPanels(); renderPreview(); renderTransport(); renderTimeline(); renderEditor(); renderJoints(); renderInspector(); renderReport(); renderStages(); renderStatus(); renderTools(); renderClipList(); renderCompat(); }
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
  // ───────────────────────── viewport: orbitable 3D schematic rig ─────────────────────────
  // Semantic frame: x right, y up, z back. Fixed views keep the 1.52 conventions (front: x →, side: forward →); "3d" orbits.
  const VIEW_CAM = { front: { yaw: 0, pitch: 0 }, side: { yaw: 90, pitch: 0 }, top: { yaw: 0, pitch: 89 }, back: { yaw: 180, pitch: 0 } };
  const BONES = [["root", "waist"], ["waist", "neck"], ["neck", "neck_tip"], ["waist", "l_shoulder"], ["l_shoulder", "l_elbow"], ["l_elbow", "l_wrist"], ["l_wrist", "l_wrist_tip"], ["waist", "r_shoulder"], ["r_shoulder", "r_elbow"], ["r_elbow", "r_wrist"], ["r_wrist", "r_wrist_tip"], ["root", "l_hip"], ["l_hip", "l_knee"], ["l_knee", "l_ankle"], ["l_ankle", "l_ankle_tip"], ["root", "r_hip"], ["r_hip", "r_knee"], ["r_knee", "r_ankle"], ["r_ankle", "r_ankle_tip"]];
  const EFFECTOR_OF = { l_wrist_tip: "l_hand", r_wrist_tip: "r_hand", l_ankle_tip: "l_foot", r_ankle_tip: "r_foot" };
  function makeCamera(view, box, focus) {
    const base = view === "3d" ? S.cam : Object.assign({}, VIEW_CAM[view] || VIEW_CAM.front, { zoom: S.cam.zoom, pan: S.cam.pan });
    const yaw = (base.yaw || 0) * Math.PI / 180, pitch = (base.pitch || 0) * Math.PI / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const right = [cy, 0, -sy], depth0 = [sy, 0, cy];
    const up = [sp * depth0[0], cp, sp * depth0[2]], depth = [cp * depth0[0], -sp, cp * depth0[2]];
    const s = Math.min(box.w / 8.2, box.h / 7.2) * (base.zoom || 1);
    const target = [focus[0], 2.55 + (base.pan ? base.pan[1] : 0), focus[2]], cx = box.x + box.w / 2 + (base.pan ? base.pan[0] : 0) * s, cz = box.y + box.h / 2 + 6;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const persp = view === "3d";
    const project = (p) => { const d = [p[0] - target[0], p[1] - target[1], p[2] - target[2]]; const z = dot(d, depth); const k = persp ? 16 / (16 + z) : 1; return [cx + dot(d, right) * s * k, cz - dot(d, up) * s * k, z, k]; };
    return { project, right, up, depth, s, target, persp, yaw: base.yaw || 0, pitch: base.pitch || 0 };
  }
  function drawGrid(ctx, cam, box) {
    const t = cam.target; const N = 4;
    ctx.save(); ctx.lineWidth = 1;
    for (let i = -N; i <= N; i++) {
      const a = cam.project([t[0] + i, 0, t[2] - N]), b = cam.project([t[0] + i, 0, t[2] + N]), c = cam.project([t[0] - N, 0, t[2] + i]), d = cam.project([t[0] + N, 0, t[2] + i]);
      ctx.strokeStyle = i === 0 ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.09)";
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
    }
    // forward arrow (-z) so the facing direction is never ambiguous
    const o = cam.project([t[0], 0, t[2]]), f = cam.project([t[0], 0, t[2] - 1.6]);
    ctx.strokeStyle = "rgba(126,178,255,.6)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(f[0], f[1]); ctx.stroke();
    ctx.fillStyle = "rgba(126,178,255,.7)"; ctx.font = "9px ui-monospace, Consolas, monospace"; ctx.fillText("fwd", f[0] + 3, f[1] - 3);
    ctx.restore();
  }
  // ── 1.67 blocky Roblox-style rig ──
  // Every bone is drawn as a block in the JOINT'S OWN frame (fkFull gives the
  // world rotation of each joint, so twist / roll show). Proportions follow the
  // Rig Builder block rigs scaled to the schematic skeleton (torso 2 wide : limb
  // 1 : depth 1, head 1.2 cube, LowerTorso a fifth of the torso, feet flat
  // blocks under the shin) and the blocks wear the standard rig-test decals:
  // red FRONT / F, blue BACK / B, yellow right side, green left side, white
  // top / bottom, Medium-stone-grey head with a face. Faces are lit per normal
  // and painted far → near with back-face culling.
  // [joint, y0, y1, halfX, halfZ, kind, extra]  (local studs; y along the bone)
  const PARTS_R15 = [
    ["root", -0.2, 0.12, 0.667, 0.333, "torso", { label: "F", back: "B" }],
    ["waist", -0.08, 1.2, 0.667, 0.333, "torso", { label: "FRONT", back: "BACK" }],
    ["neck", 0.02, 0.82, 0.4, 0.4, "head", { head: true }],
    ["l_shoulder", -0.02, -0.58, 0.333, 0.333, "limb"], ["l_elbow", -0.02, -0.58, 0.333, 0.333, "limb"], ["l_wrist", -0.02, -0.3, 0.333, 0.333, "limb"],
    ["r_shoulder", -0.02, -0.58, 0.333, 0.333, "limb"], ["r_elbow", -0.02, -0.58, 0.333, 0.333, "limb"], ["r_wrist", -0.02, -0.3, 0.333, 0.333, "limb"],
    ["l_hip", -0.02, -0.73, 0.4, 0.36, "limb"], ["l_knee", -0.02, -0.73, 0.4, 0.36, "limb"], ["l_ankle", -0.15, 0.04, 0.4, 0.4, "limb", { zc: -0.06 }],
    ["r_hip", -0.02, -0.73, 0.4, 0.36, "limb"], ["r_knee", -0.02, -0.73, 0.4, 0.36, "limb"], ["r_ankle", -0.15, 0.04, 0.4, 0.4, "limb", { zc: -0.06 }],
  ];
  // R6: one torso block, one block per limb (no seams, one letter), cube head.
  const PARTS_R6 = [
    ["waist", -0.4, 1.2, 0.667, 0.333, "torso", { label: "FRONT", back: "BACK" }],
    ["neck", 0.02, 0.86, 0.42, 0.42, "head", { head: true }],
    ["l_shoulder", 0.0, -0.6, 0.333, 0.333, "limb"], ["l_elbow", 0.0, -0.6, 0.333, 0.333, "limb", { nolabel: true }], ["l_wrist", 0.0, -0.35, 0.333, 0.333, "limb", { nolabel: true }],
    ["r_shoulder", 0.0, -0.6, 0.333, 0.333, "limb"], ["r_elbow", 0.0, -0.6, 0.333, 0.333, "limb", { nolabel: true }], ["r_wrist", 0.0, -0.35, 0.333, 0.333, "limb", { nolabel: true }],
    ["l_hip", 0.0, -0.75, 0.4, 0.36, "limb"], ["l_knee", 0.0, -0.75, 0.4, 0.36, "limb", { nolabel: true }], ["l_ankle", -0.15, 0.02, 0.4, 0.4, "limb", { zc: -0.06, nolabel: true }],
    ["r_hip", 0.0, -0.75, 0.4, 0.36, "limb"], ["r_knee", 0.0, -0.75, 0.4, 0.36, "limb", { nolabel: true }], ["r_ankle", -0.15, 0.02, 0.4, 0.4, "limb", { zc: -0.06, nolabel: true }],
  ];
  // Rig-test decal colours (BrickColor): Bright red front, Bright blue back, Bright yellow right, Bright green left, Institutional white top/bottom, Medium stone grey head.
  const SIDE_COLOUR = { front: [196, 40, 28], back: [13, 105, 172], right: [245, 205, 48], left: [75, 151, 75], top: [229, 229, 224], bottom: [205, 205, 200] };
  const HEAD_COLOUR = [163, 162, 165];
  const CHILD_OF = { root: "waist", waist: "neck", neck: "neck_tip", l_shoulder: "l_elbow", l_elbow: "l_wrist", l_wrist: "l_wrist_tip", r_shoulder: "r_elbow", r_elbow: "r_wrist", r_wrist: "r_wrist_tip", l_hip: "l_knee", l_knee: "l_ankle", l_ankle: "l_ankle_tip", r_hip: "r_knee", r_knee: "r_ankle", r_ankle: "r_ankle_tip" };
  const FACES = [ // [normal, corner indices, side] - corners: bit0 x+, bit1 y+, bit2 z+ ; semantic frame: +x = rig's right, -z = front
    [[1, 0, 0], [1, 3, 7, 5], "right"], [[-1, 0, 0], [0, 4, 6, 2], "left"], [[0, 1, 0], [2, 6, 7, 3], "top"], [[0, -1, 0], [0, 1, 5, 4], "bottom"], [[0, 0, 1], [4, 5, 7, 6], "back"], [[0, 0, -1], [0, 2, 3, 1], "front"],
  ];
  const rgba = (c, a, m) => `rgba(${Math.round(Math.min(255, c[0] * (m == null ? 1 : m)))},${Math.round(Math.min(255, c[1] * (m == null ? 1 : m)))},${Math.round(Math.min(255, c[2] * (m == null ? 1 : m)))},${a})`;
  function drawRig(ctx, rig, cam, style) {
    const pts = rig.pts || rig, world = rig.world || null; const ghost = !!style.ghost; const r6 = style.rigType === "R6";
    const P = {}; for (const k of Object.keys(pts)) P[k] = cam.project(pts[k]);
    ctx.save(); ctx.lineJoin = "round";
    if (!ghost && style.shadow !== false) { // flattened contact shadow on the ground plane
      ctx.strokeStyle = "rgba(0,0,0,.42)"; ctx.lineWidth = 9; ctx.lineCap = "round";
      for (const [a, b] of BONES) { const A = cam.project([pts[a][0], 0, pts[a][2]]), B = cam.project([pts[b][0], 0, pts[b][2]]); ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); }
    }
    if (!world) { ctx.restore(); return P; } // (legacy caller passed bare points)
    const mulV = E().math.mulV;
    const camPos = [cam.target[0] - cam.depth[0] * 16, cam.target[1] - cam.depth[1] * 16, cam.target[2] - cam.depth[2] * 16];
    const light = (() => { const v = [-cam.right[0] * 0.45 + cam.up[0] * 0.8 - cam.depth[0] * 0.65, -cam.right[1] * 0.45 + cam.up[1] * 0.8 - cam.depth[1] * 0.65, -cam.right[2] * 0.45 + cam.up[2] * 0.8 - cam.depth[2] * 0.65]; const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; })();
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const boxes = [];
    for (const part of (r6 ? PARTS_R6 : PARTS_R15)) {
      const [j, y0, y1, hx, hz, kind, extra] = part; const w = world[j]; if (!w) continue;
      const zc = (extra && extra.zc) || 0;
      const loc = (bx, by, bz) => [bx ? hx : -hx, by ? y1 : y0, zc + (bz ? hz : -hz)];
      const corners = []; const proj = [];
      for (let i = 0; i < 8; i++) { const l = loc(i & 1, i & 2, i & 4); const o = mulV(w.R, l); const q = [w.p[0] + o[0], w.p[1] + o[1], w.p[2] + o[2]]; corners.push(q); proj.push(cam.project(q)); }
      const centre = corners.reduce((a, q) => [a[0] + q[0] / 8, a[1] + q[1] / 8, a[2] + q[2] / 8], [0, 0, 0]);
      const cz = cam.project(centre)[2];
      const sel = !!style.selJoint && !ghost && (j === style.selJoint || CHILD_OF[j] === style.selJoint);
      const head = kind === "head";
      boxes.push({ j, w, corners, proj, cz, head, sel, hx, hz, y0, y1, zc, label: head || (extra && extra.nolabel) ? "" : (extra && extra.label) || "F", back: head || (extra && extra.nolabel) ? "" : (extra && extra.back) || "B" });
    }
    boxes.sort((a, b) => b.cz - a.cz); // far → near
    const labelOn = (b, f, text) => { // decal letter centred on the face, rotated with the face's horizontal edge
      const pp = f.idx.map((i) => b.proj[i]);
      const cx = (pp[0][0] + pp[1][0] + pp[2][0] + pp[3][0]) / 4, cy = (pp[0][1] + pp[1][1] + pp[2][1] + pp[3][1]) / 4;
      // horizontal edge of the face: the two BOTTOM corners that differ only in x (front/back) or z (sides); flipped so the text always reads left → right
      const hb = f.side === "front" || f.side === "back" ? 1 : 4;
      const xi = [f.idx.find((i) => !(i & 2) && !(i & hb)), f.idx.find((i) => !(i & 2) && (i & hb))];
      const a = b.proj[xi[0]], c = b.proj[xi[1]]; let ang = Math.atan2(c[1] - a[1], c[0] - a[0]); if (Math.cos(ang) < 0) ang += Math.PI;
      const wPx = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const yi = [f.idx.find((i) => !(i & 2)), f.idx.find((i) => i & 2)]; const hPx = Math.hypot(b.proj[yi[1]][0] - b.proj[yi[0]][0], b.proj[yi[1]][1] - b.proj[yi[0]][1]);
      const size = Math.min(hPx * 0.55, (wPx * 1.5) / Math.max(1, text.length)); if (size < 5) return;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.font = `700 ${size.toFixed(1)}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillText(text, 0, 0); ctx.restore();
    };
    for (const b of boxes) {
      const faces = [];
      for (const [nLoc, idx, side] of FACES) {
        const n = mulV(b.w.R, nLoc);
        const fc = idx.reduce((a, i) => [a[0] + b.corners[i][0] / 4, a[1] + b.corners[i][1] / 4, a[2] + b.corners[i][2] / 4], [0, 0, 0]);
        const toCam = cam.persp ? [camPos[0] - fc[0], camPos[1] - fc[1], camPos[2] - fc[2]] : [-cam.depth[0], -cam.depth[1], -cam.depth[2]];
        if (dot(n, toCam) <= 0) continue; // back face
        faces.push({ idx, n, z: cam.project(fc)[2], side });
      }
      faces.sort((u, v) => v.z - u.z);
      for (const f of faces) {
        const pp = f.idx.map((i) => b.proj[i]);
        ctx.beginPath(); ctx.moveTo(pp[0][0], pp[0][1]); for (const q of pp.slice(1)) ctx.lineTo(q[0], q[1]); ctx.closePath();
        if (ghost) { ctx.fillStyle = style.tint || "rgba(255,255,255,.07)"; ctx.fill(); ctx.strokeStyle = style.tint || "rgba(255,255,255,.22)"; ctx.lineWidth = 1; ctx.stroke(); continue; }
        const lum = 0.6 + 0.4 * Math.max(0, dot(f.n, light));
        ctx.fillStyle = rgba(b.head ? HEAD_COLOUR : SIDE_COLOUR[f.side], 1, lum); ctx.fill();
        ctx.strokeStyle = b.sel ? "#ffd166" : "rgba(0,0,0,.45)"; ctx.lineWidth = b.sel ? 2 : 1; ctx.stroke();
        if (!b.head && f.side === "front" && b.label) labelOn(b, f, b.label);
        else if (!b.head && f.side === "back" && b.back) labelOn(b, f, b.back);
        if (b.head && f.side === "front") { // the face: two eyes + a smile on the front of the head
          const s = cam.s * (b.proj[0][3] || 1); const at = (x, y) => { const o = mulV(b.w.R, [x, y, b.zc - b.hz - 0.002]); return cam.project([b.w.p[0] + o[0], b.w.p[1] + o[1], b.w.p[2] + o[2]]); };
          const eh = b.y0 + (b.y1 - b.y0) * 0.62, ex = b.hx * 0.38; ctx.fillStyle = "rgba(20,20,26,.92)";
          for (const sx of [-1, 1]) { const e = at(sx * ex, eh); ctx.beginPath(); ctx.ellipse(e[0], e[1], Math.max(1.2, s * 0.045), Math.max(1.6, s * 0.075), 0, 0, Math.PI * 2); ctx.fill(); }
          ctx.strokeStyle = "rgba(20,20,26,.92)"; ctx.lineWidth = Math.max(1, s * 0.03); ctx.beginPath();
          for (let i = 0; i <= 8; i++) { const t = -1 + i / 4; const m = at(t * b.hx * 0.42, b.y0 + (b.y1 - b.y0) * 0.3 - (1 - t * t) * (b.y1 - b.y0) * 0.09); if (i) ctx.lineTo(m[0], m[1]); else ctx.moveTo(m[0], m[1]); }
          ctx.stroke();
        }
      }
    }
    if (style.weapon === "sword" && !ghost) { const w = P.r_wrist, t = P.r_wrist_tip; const dx = t[0] - w[0], dy = t[1] - w[1]; ctx.strokeStyle = "#c9d6ff"; ctx.lineWidth = 3; ctx.lineCap = "square"; ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(t[0] + dx * 2.6, t[1] + dy * 2.6); ctx.stroke(); ctx.strokeStyle = "#8a6a2a"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(t[0] - dy * 0.35, t[1] + dx * 0.35); ctx.lineTo(t[0] + dy * 0.35, t[1] - dx * 0.35); ctx.stroke(); }
    ctx.restore();
    return P;
  }
  function drawHandles(ctx, P) {
    S.handles = [];
    for (const j of E().JOINTS) { const p = P[j]; if (!p) continue; const sel = j === S.selJoint; ctx.beginPath(); ctx.arc(p[0], p[1], sel ? 5 : 3.2, 0, Math.PI * 2); ctx.fillStyle = sel ? "#ffd166" : "rgba(255,255,255,.55)"; ctx.fill(); if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); } S.handles.push({ j, x: p[0], y: p[1], kind: "joint" }); }
    for (const tip of Object.keys(EFFECTOR_OF)) { const p = P[tip]; if (!p) continue; ctx.beginPath(); ctx.arc(p[0], p[1], 5.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,209,102,.9)"; ctx.fill(); ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1; ctx.stroke(); S.handles.push({ j: tip, eff: EFFECTOR_OF[tip], x: p[0], y: p[1], kind: "effector" }); }
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
    const rootPos = poses && poses.root && poses.root.pos ? poses.root.pos : [0, 0, 0];
    const focus = [rootPos[0], 0, rootPos[2]];
    let onion = null;
    if (S.onion && S.clip && !S.playing && S.clip.keys.length > 1) { const keys = S.clip.keys; const prev = keys.filter((k) => k.t < S.t - 1e-4).pop(), next = keys.find((k) => k.t > S.t + 1e-4); onion = { prev: prev && prev.poses, next: next && next.poses }; }
    S.cams = [];
    views.forEach((view, i) => {
      const box = { x: i * vw, y: 0, w: vw, h: H };
      const cam = makeCamera(view, box, focus); S.cams.push({ view, box, cam });
      drawGrid(ctx, cam, box);
      ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.fillText(view === "front" ? "FRONT  (x →)" : view === "side" ? "SIDE  (forward →)" : view === "top" ? "TOP" : view === "back" ? "BACK  (x ←)" : `3D  yaw ${Math.round(cam.yaw)}° pitch ${Math.round(cam.pitch)}°`, box.x + 12, 14);
      if (i) { ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.beginPath(); ctx.moveTo(box.x, 0); ctx.lineTo(box.x, H); ctx.stroke(); }
      if (!poses) return;
      const weapon = S.clip.intent && S.clip.intent.weapon, rigType = S.clip.rigType;
      if (ghost) drawRig(ctx, E().fkFull(ghost), cam, { ghost: true, rigType });
      if (onion && onion.prev) drawRig(ctx, E().fkFull(onion.prev), cam, { ghost: true, rigType, tint: "rgba(126,178,255,.3)" });
      if (onion && onion.next) drawRig(ctx, E().fkFull(onion.next), cam, { ghost: true, rigType, tint: "rgba(255,159,110,.3)" });
      if (S.arcs) drawArcs(ctx, cam);
      const P = drawRig(ctx, E().fkFull(poses), cam, { weapon, rigType, selJoint: S.selJoint });
      if (i === views.length - 1 && !S.playing) drawHandles(ctx, P);
    });
    if (S.clip) {
      ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.font = "10px ui-monospace, Consolas, monospace";
      const hint = S.view === "3d" ? "drag: orbit · wheel: zoom · shift-drag: pan · double-click: reset" : "drag: pan · wheel: zoom";
      ctx.fillText(`blocky rig preview (${S.clip.rigType}) · t=${fmt(S.t, 2)}s · ${hint} · drag a yellow hand/foot: IK${S.ghost && S.prev ? " · white ghost = previous version" : ""}${S.onion ? " · blue/orange = previous/next key" : ""}${S.arcs ? " · arcs = motion trails" : ""}`, 12, H - 8);
      if (S.ikDrag) { ctx.fillStyle = "#ffd166"; ctx.fillText(`IK ${S.ikDrag.eff}: target ${S.ikDrag.target.map((v) => v.toFixed(2)).join(", ")} · ${S.ikDrag.reached ? "reached" : "out of reach by " + fmt(S.ikDrag.distance, 2) + " studs"}`, 12, H - 22); }
    }
  }
  // viewport input: orbit / pan / zoom, joint picking, IK dragging of hands + feet
  function canvasPoint(ev) { const r = D.canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  function hitHandle(pt) { let best = null, bd = 10; for (const h of S.handles || []) { const d = Math.hypot(h.x - pt[0], h.y - pt[1]) - (h.kind === "effector" ? 2 : 0); if (d < bd) { bd = d; best = h; } } return best; }
  function camAt(pt) { const cs = S.cams || []; return cs.find((c) => pt[0] >= c.box.x && pt[0] <= c.box.x + c.box.w) || cs[cs.length - 1] || null; }
  function ensureKeyAtPlayhead() { // auto-key: edits at a time with no key create one there first; otherwise edits land on the selected key
    if (!S.clip) return false;
    const step = 1 / S.clip.fps; const at = S.clip.keys.findIndex((k) => Math.abs(k.t - S.t) < step / 2);
    if (at >= 0) { S.sel = at; return true; }
    if (!S.autoKey) { if (S.sel >= 0 && S.clip.keys[S.sel]) S.t = S.clip.keys[S.sel].t; return S.sel >= 0; }
    const r = E().insertKey(S.clip, S.t); S.clip = r.clip; S.sel = r.index; S.t = S.clip.keys[S.sel].t; return true;
  }
  function viewportDown(ev) {
    if (!D || ev.button !== 0) return; const pt = canvasPoint(ev); const cell = camAt(pt); if (!cell) return;
    if (S.playing) pause();
    const h = S.clip ? hitHandle(pt) : null;
    if (h && h.kind === "effector" && S.sel >= 0) {
      pushHistory(); S.clip = JSON.parse(JSON.stringify(S.clip)); ensureKeyAtPlayhead();
      const key = S.clip.keys[S.sel]; const pts = E().forwardKinematics(key.poses);
      S.ikDrag = { eff: h.eff, tip: h.j, start: pt, target0: pts[h.j].slice(), target: pts[h.j].slice(), poses0: JSON.parse(JSON.stringify(key.poses)), cam: cell.cam, reached: true, distance: 0 };
      try { D.canvas.setPointerCapture(ev.pointerId); } catch {}
      renderAll(); return;
    }
    if (h && h.kind === "joint") { S.selJoint = h.j; renderJoints(); renderInspector(); renderPreview(); renderEditor(); return; }
    S.orbit = { start: pt, yaw0: S.cam.yaw, pitch0: S.cam.pitch, pan0: S.cam.pan.slice(), mode: ev.shiftKey || cell.view !== "3d" ? "pan" : "orbit", s: cell.cam.s };
    try { D.canvas.setPointerCapture(ev.pointerId); } catch {}
  }
  function viewportMove(ev) {
    if (!D) return; const pt = canvasPoint(ev);
    if (S.ikDrag) {
      const d = S.ikDrag, cam = d.cam; const dx = (pt[0] - d.start[0]) / cam.s, dy = -(pt[1] - d.start[1]) / cam.s;
      d.target = [0, 1, 2].map((i) => d.target0[i] + cam.right[i] * dx + cam.up[i] * dy);
      const res = E().ikSolve(d.poses0, d.eff, d.target); d.reached = res.reached; d.distance = res.distance;
      const key = S.clip.keys[S.sel]; for (const j of res.joints) key.poses[j] = res.poses[j];
      renderPreview(); renderInspector(); renderEditor(); return;
    }
    if (S.orbit) {
      const o = S.orbit, dx = pt[0] - o.start[0], dy = pt[1] - o.start[1];
      if (o.mode === "orbit") { S.cam.yaw = (o.yaw0 + dx * 0.5) % 360; S.cam.pitch = clamp(o.pitch0 - dy * 0.4, -89, 89); }
      else S.cam.pan = [o.pan0[0] + dx / o.s, o.pan0[1] - dy / o.s];
      renderPreview(); return;
    }
    const h = S.clip && !S.playing ? hitHandle(pt) : null; D.canvas.style.cursor = h ? (h.kind === "effector" ? "grab" : "pointer") : (S.view === "3d" ? "move" : "default");
  }
  function viewportUp(ev) {
    if (!D) return;
    try { D.canvas.releasePointerCapture(ev.pointerId); } catch {}
    if (S.ikDrag) {
      const d = S.ikDrag; S.ikDrag = null; const c = S.clip; c.edited = true; c.report = E().validate(c); c.fingerprint = E().fingerprint(c);
      setClip(c, { keepT: true, noPrev: true }); toast(`IK ${d.eff.replace("_", " ")}: ${d.reached ? "target reached" : "out of reach by " + fmt(d.distance, 2) + " studs"}`); diag("ik", { eff: d.eff, reached: d.reached });
      return;
    }
    S.orbit = null;
  }
  function viewportWheel(ev) { if (!D) return; ev.preventDefault(); S.cam.zoom = clamp(S.cam.zoom * Math.exp(-ev.deltaY * 0.0012), 0.35, 4); renderPreview(); }
  function resetCamera() { S.cam = { yaw: 35, pitch: 18, zoom: 1, pan: [0, 0] }; renderPreview(); }
  function setView(view) { S.view = view; if (D) D.host.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-view") === view)); renderPreview(); }
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
      ctx.fillStyle = sel ? "#ffd166" : k.tag === "impact" ? "#ff7b6b" : k.tag === "hold" ? "#7bd88f" : k.tag === "breakdown" ? "#c79bff" : k.synthetic ? "rgba(200,200,210,.55)" : "#9ec1ff"; ctx.fill();
      if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (k.markers && k.markers.length) { ctx.fillStyle = "#ffd166"; ctx.fillRect(kx - 0.5, cy - 16, 1, 7); ctx.beginPath(); ctx.moveTo(kx, cy - 16); ctx.lineTo(kx + 6, cy - 13.5); ctx.lineTo(kx, cy - 11); ctx.closePath(); ctx.fill(); } // 1.64 marker flag
    });
    // playhead
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x(S.t), 16); ctx.lineTo(x(S.t), H - 14); ctx.stroke();
  }
  function timelineHit(ev) { const r = D.timeline.getBoundingClientRect(); const W = r.width, L = 10, span = W - 20; const t = clamp(((ev.clientX - r.left) - L) / span, 0, 1) * (S.clip ? S.clip.duration : 1); let hit = -1; if (S.clip) S.clip.keys.forEach((k, i) => { const kx = L + (k.t / S.clip.duration) * span; if (Math.abs(kx - (ev.clientX - r.left)) <= 8) hit = i; }); return { t, hit }; }
  // ───────────────────────── 1.64 key workbench (replaces the dope sheet + graph editor) ─────────────────────────
  // Professional key tools on one strip: key chips (select / inspect), breakdown (tween machine), moving holds, frame
  // nudge, KeyframeMarkers, ease presets for the whole clip, overlap / follow-through, retime, motion arcs and a timing read.
  const TAG_GLYPH = { impact: "!", hold: "=", breakdown: "~", start: "|", end: "|", loop_end: "|", copy: "+", land: "!", contact: "." };
  function renderEditor() {
    if (!D || !D.keystrip) return;
    const c = S.clip;
    for (const b of D.host.querySelectorAll(".rsa-bench [data-act]")) if (b.getAttribute("data-act") !== "toggleEditor") b.disabled = !c;
    for (const el of [D.bias, D.holdFrames, D.markerName, D.lagFrames, D.retimeTo]) if (el) el.disabled = !c;
    if (!c) { D.keystrip.innerHTML = `<span class="rsa-muted">Generate a clip - its keys line up here. Click a key to edit it, use the tools below to time it like a pro.</span>`; D.markerList.innerHTML = ""; D.timing.innerHTML = ""; return; }
    D.keystrip.innerHTML = c.keys.map((k, i) => { const mk = (k.markers || []).length; const tag = k.tag || "key"; return `<button type="button" class="rsa-kchip${i === S.sel ? " on" : ""}${k.locked ? " locked" : ""} tag-${esc(tag.replace(/[^a-z_]/g, ""))}" data-key="${i}" title="Key ${i + 1} · ${fmt(k.t, 3)} s · ${esc(tag)} · ease ${esc((k.ease || []).join(" "))}${k.stage ? " · " + esc(k.stage) : ""}${mk ? " · " + mk + " marker" + (mk > 1 ? "s" : "") : ""}${k.locked ? " · locked" : ""}"><i>${TAG_GLYPH[tag] || "◆"}</i><b>${fmt(k.t, 2)}</b><small>${esc(tag === "key" || tag === "beat" ? (k.ease || ["", ""])[0].replace("CubicV2", "cubic").toLowerCase() : tag)}</small>${mk ? `<em>⚑${mk > 1 ? mk : ""}</em>` : ""}</button>`; }).join("");
    try { const on = D.keystrip.querySelector(".rsa-kchip.on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
    const k = c.keys[S.sel];
    D.markerList.innerHTML = k && k.markers && k.markers.length ? k.markers.map((m) => `<span class="rsa-marker" title="KeyframeMarker ${esc(m.name)}${m.value ? " = " + esc(m.value) : ""} - GetMarkerReachedSignal(&quot;${esc(m.name)}&quot;) fires here in Studio">⚑ ${esc(m.name)}${m.value ? `<small>${esc(m.value)}</small>` : ""}<button type="button" data-marker-del="${esc(m.name)}" title="Remove marker">×</button></span>`).join("") : `<span class="rsa-muted">no markers on this key</span>`;
    if (D.biasVal) D.biasVal.textContent = `${D.bias.value}%`;
    if (D.easeAllRow) for (const b of D.easeAllRow.querySelectorAll("[data-ease-all]")) b.classList.toggle("on", c.easePreset === b.getAttribute("data-ease-all"));
    if (D.arcsBtn) D.arcsBtn.classList.toggle("on", !!S.arcs);
    const tm = E().timing ? E().timing(c) : null;
    D.timing.innerHTML = tm ? `<span class="rsa-tm"><b>${c.keys.length}</b> keys</span><span class="rsa-tm"><b>${tm.impacts}</b> impacts</span><span class="rsa-tm"><b>${tm.holds}</b> holds</span><span class="rsa-tm"><b>${tm.breakdowns}</b> breakdowns</span><span class="rsa-tm"><b>${tm.markers}</b> markers</span><span class="rsa-tm"><b>${c.overlapFrames || 0}f</b> overlap</span>${tm.notes.map((n) => `<span class="rsa-tm note ${n.level}" title="${esc(n.text)}">${esc(n.text)}</span>`).join("")}` : "";
  }
  function benchBreakdown() { if (!S.clip) return toast("Generate a clip first"); const bias = (parseFloat(D.bias.value) || 50) / 100; pushHistory(); const r = E().breakdown(S.clip, S.t, bias); S.sel = r.index; S.t = r.clip.keys[r.index] ? r.clip.keys[r.index].t : S.t; setClip(r.clip, { keepT: true, noPrev: true }); toast(r.reason ? "Breakdown: " + r.reason : `Breakdown key at ${fmt(S.t, 3)}s favouring the ${bias < 0.5 ? "previous" : bias > 0.5 ? "next" : "middle"} pose (${Math.round(bias * 100)}%)`); diag("bench.breakdown", { t: S.t, bias }); }
  function benchHold() { if (!S.clip || S.sel < 0) return toast("Select a key first"); const n = Math.max(1, Math.round(parseFloat(D.holdFrames.value) || 3)); pushHistory(); const r = E().holdKey(S.clip, S.sel, n); if (r.reason) { toast("Hold: " + r.reason); return; } S.sel = r.index; S.t = r.clip.keys[r.index].t; setClip(r.clip, { keepT: true, noPrev: true }); toast(`Moving hold: pose held for ${n} frame${n > 1 ? "s" : ""}`); diag("bench.hold", { frames: n }); }
  function benchNudge(frames) { if (!S.clip || S.sel < 0) return toast("Select a key first"); const before = S.clip.keys[S.sel].t; const next = E().nudgeKey(S.clip, S.sel, frames); const after = next.keys[S.sel] ? next.keys[S.sel].t : before; if (Math.abs(after - before) < 1e-6) return toast("Key cannot move further - its neighbour is on the next frame"); pushHistory(); S.t = after; setClip(next, { keepT: true, noPrev: true }); toast(`Key ${S.sel + 1} → ${fmt(after, 3)}s`); }
  function benchMarker() { if (!S.clip || S.sel < 0) return toast("Select a key first"); const raw = String(D.markerName.value || "").trim(); if (!raw) { D.markerName.focus(); return toast("Name the marker (footstep, hit, sfx…)"); } const [name, value] = raw.split(/\s*[=:]\s*/); pushHistory(); setClip(E().setMarker(S.clip, S.sel, name, value || ""), { keepT: true, noPrev: true }); D.markerName.value = ""; toast(`Marker "${name}" on key ${S.sel + 1} - GetMarkerReachedSignal("${name}") in Studio`); diag("bench.marker", { name }); }
  function benchMarkerDel(name) { if (!S.clip || S.sel < 0) return; pushHistory(); setClip(E().removeMarker(S.clip, S.sel, name), { keepT: true, noPrev: true }); toast(`Marker "${name}" removed`); }
  function benchEaseAll(preset) { if (!S.clip) return toast("Generate a clip first"); pushHistory(); setClip(E().easeAll(S.clip, preset), { keepT: true }); const p = E().EASE_PRESETS[preset]; toast(`Ease preset ${p ? p.label : preset}: ${p ? p.note : ""}`); diag("bench.easeAll", { preset }); }
  function benchOverlap() { if (!S.clip) return toast("Generate a clip first"); const n = Math.max(1, Math.round(parseFloat(D.lagFrames.value) || 2)); pushHistory(); setClip(E().overlap(S.clip, n), { keepT: true }); toast(`Overlap: elbows, wrists, head, knees and ankles now trail by ${n} frame${n > 1 ? "s" : ""} (follow-through)`); diag("bench.overlap", { frames: n }); }
  function benchRetime() { if (!S.clip) return toast("Generate a clip first"); const to = parseFloat(D.retimeTo.value); if (!(to > 0.05 && to <= 60)) { D.retimeTo.focus(); return toast("Enter the new length in seconds (0.1 - 60)"); } pushHistory(); const c = E().retime(S.clip, to); c.edited = true; c.report = E().validate(c); setClip(c, { keepT: false }); D.retimeTo.value = ""; toast(`Clip retimed to ${fmt(to, 2)}s (${to > S.clip.duration ? "slower" : "faster"}, timing ratios kept)`); }
  function benchArcs() { S.arcs = !S.arcs; renderPreview(); renderEditor(); toast(S.arcs ? "Motion arcs: hands, feet and head trails (yellow dots = keys). Clean arcs = good animation." : "Motion arcs off"); }
  function drawArcs(ctx, cam) {
    if (!S.clip || !E().arcs) return; const A = E().arcs(S.clip, null, Math.min(160, Math.round(S.clip.duration * S.clip.fps) + 1));
    const col = { r_hand: "rgba(255,159,110,.85)", l_hand: "rgba(126,178,255,.85)", r_foot: "rgba(255,120,160,.7)", l_foot: "rgba(120,220,180,.7)", head: "rgba(255,230,140,.7)", root: "rgba(255,255,255,.35)" };
    ctx.save(); ctx.lineWidth = 1.25;
    for (const w of Object.keys(A)) { const pts = A[w].map((sm) => cam.project(sm.p)); ctx.strokeStyle = col[w]; ctx.beginPath(); pts.forEach((pp, i) => { if (i) ctx.lineTo(pp[0], pp[1]); else ctx.moveTo(pp[0], pp[1]); }); ctx.stroke(); ctx.fillStyle = "#ffd166"; A[w].forEach((sm, i) => { if (sm.key) { ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2.2, 0, Math.PI * 2); ctx.fill(); } }); }
    ctx.restore();
  }
  // ───────────────────────── pose tools, clip tools, pose library, layering ─────────────────────────
  const POSES_KEY = "rsAnimPoses";
  function loadPoses() { try { const j = JSON.parse(localStorage.getItem(POSES_KEY) || "[]"); return Array.isArray(j) ? j : []; } catch { return []; } }
  function savePoses(list) { try { localStorage.setItem(POSES_KEY, JSON.stringify(list.slice(0, 60))); } catch {} }
  function applyEdited(c, msg) { c.edited = true; c.report = E().validate(c); c.fingerprint = E().fingerprint(c); setClip(c, { keepT: true, noPrev: true }); if (msg) toast(msg); }
  function insertKeyHere() { if (!S.clip) return toast("Generate a clip first"); pushHistory(); const r = E().insertKey(S.clip, S.t); S.sel = r.index; S.t = r.clip.keys[r.index].t; setClip(r.clip, { keepT: true, noPrev: true }); toast(r.inserted ? `Key inserted at ${fmt(r.clip.keys[r.index].t, 3)}s` : "A key already sits on this frame - it is selected"); }
  function copyPose() { if (!S.clip || S.sel < 0) return; S.clipboard = E().copyPose(S.clip, S.sel); toast("Pose copied (Ctrl+V paste · Ctrl+Shift+V paste flipped)"); renderTools(); }
  function pastePose(flipped) {
    if (!S.clip) return; if (!S.clipboard) return toast("Copy a pose first (Ctrl+C on a key)");
    pushHistory(); S.clip = JSON.parse(JSON.stringify(S.clip)); if (!ensureKeyAtPlayhead()) return;
    applyEdited(E().pastePose(S.clip, S.sel, S.clipboard, { flipped: !!flipped }), flipped ? "Pasted X-flipped (left ↔ right)" : "Pose pasted");
  }
  function toggleLock() { if (!S.clip || S.sel < 0) return; pushHistory(); const c = JSON.parse(JSON.stringify(S.clip)); c.keys[S.sel].locked = !c.keys[S.sel].locked; applyEdited(c, c.keys[S.sel].locked ? "Key locked: Smooth / Simplify will keep it" : "Key unlocked"); }
  function savePoseToLibrary() {
    if (!S.clip || S.sel < 0) return toast("Select a key to save its pose");
    const name = String(D.poseName.value || "").trim() || `${S.clip.name} @${fmt(S.clip.keys[S.sel].t, 2)}s`;
    const list = loadPoses().filter((p) => p.name !== name); list.unshift({ name, pose: E().copyPose(S.clip, S.sel), rigType: S.clip.rigType, at: Date.now() }); savePoses(list);
    D.poseName.value = ""; renderPoses(); toast(`Pose "${name}" saved`);
  }
  function applyLibraryPose(name, flipped) {
    const p = loadPoses().find((q) => q.name === name); if (!p || !S.clip) return;
    pushHistory(); S.clip = JSON.parse(JSON.stringify(S.clip)); if (!ensureKeyAtPlayhead()) return;
    applyEdited(E().pastePose(S.clip, S.sel, p.pose, { flipped: !!flipped }), `Applied pose "${name}"${flipped ? " (flipped)" : ""}`);
  }
  function deleteLibraryPose(name) { savePoses(loadPoses().filter((p) => p.name !== name)); renderPoses(); }
  function renderPoses() { if (!D) return; const list = loadPoses(); D.poses.innerHTML = list.length ? list.map((p) => `<div class="rsa-pose"><button type="button" class="rsa-pose-apply" data-pose="${esc(p.name)}" title="Apply to the selected key (Shift+click: X-flipped)">${esc(p.name)}<small>${esc(p.rigType || "")}</small></button><button type="button" class="rsa-ib mini" data-pose-del="${esc(p.name)}" title="Delete pose">${I.close}</button></div>`).join("") : `<div class="rsa-muted">No saved poses yet - select a key and press Save pose.</div>`; }
  function clipTool(kind) {
    if (!S.clip) return toast("Generate a clip first");
    const En = E(); let out, msg;
    if (kind === "smooth") { out = En.smooth(S.clip, { strength: 1 }); msg = out.fixes[out.fixes.length - 1]; }
    else if (kind === "plant") { out = En.groundFeet(S.clip, { force: true }); msg = out.fixes && out.fixes.length && /planted/.test(out.fixes[out.fixes.length - 1]) ? out.fixes[out.fixes.length - 1] : "Feet already planted - nothing to change"; if (!/planted/.test(msg)) return toast(msg); }
    else if (kind === "simplify") { out = En.simplify(S.clip, 2); msg = out.fixes[out.fixes.length - 1]; if (out.keys.length === S.clip.keys.length) return toast("No redundant keys - every key changes the motion by more than 2°"); }
    else if (kind === "interp") { const to = S.clip.interp === "spline" ? "eased" : "spline"; out = En.setInterp(S.clip, to); msg = to === "spline" ? `Spline curves: C1 motion through the keys (smoothness ${S.clip.report.smoothness} → ${out.report.smoothness}); Studio receives it baked per frame` : `Eased segments: Roblox easing per key (smoothness ${S.clip.report.smoothness} → ${out.report.smoothness})`; }
    else if (kind === "reverse") { out = En.reverse(S.clip); msg = "Reversed in time"; }
    else if (kind === "bake") { out = En.bake(S.clip); msg = out.fixes[out.fixes.length - 1] + " - every frame is now a key (Simplify undoes the density)"; }
    else if (kind === "offset") { const v = prompt("Cycle offset in seconds (positive = the loop starts later; negative allowed)", "0.25"); if (v == null) return; const sec = parseFloat(v); if (!Number.isFinite(sec)) return toast("Enter a number of seconds"); if (!S.clip.loop) return toast("Cycle offset only applies to looping clips (tick Loop first)"); out = En.cycleOffset(S.clip, sec); msg = `Loop start moved by ${fmt(sec, 2)}s`; }
    else return;
    pushHistory(); setClip(out, { keepT: true }); toast(msg); diag("tool", { kind, keys: out.keys.length, score: out.report.score });
  }
  function libraryClips() { // session clips (this studio + the AI's clips) for layering
    const map = {}; for (const [n, c] of Object.entries(S.library || {})) map[n] = c;
    try { const ext = S.hooks.clips ? S.hooks.clips() : null; if (ext) for (const [n, c] of Object.entries(ext)) if (c && Array.isArray(c.keys)) map[n] = c; } catch {}
    return map;
  }
  function remember(clip) { if (!clip || !clip.name) return; S.library = S.library || {}; S.library[clip.name] = clip; const names = Object.keys(S.library); if (names.length > 24) delete S.library[names[0]]; renderLayerPick(); renderClipList(); }
  function renderLayerPick() { if (!D) return; const cur = D.layerPick.value; const names = Object.keys(libraryClips()).filter((n) => !S.clip || n !== S.clip.name); D.layerPick.innerHTML = `<option value="">upper body from…</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("") + `<option value="__file">a saved project file…</option>`; if (names.includes(cur)) D.layerPick.value = cur; }
  function layerWith(upper) {
    if (!S.clip) return toast("Generate the base clip (legs + root) first");
    const fit = ["loop", "stretch", "hold"].includes(D.layerFit.value) ? D.layerFit.value : "auto", weight = clamp(parseFloat(D.layerWeight.value) || 1, 0, 1);
    const out = E().layer(S.clip, upper, { fit, weight });
    pushHistory(); remember(S.clip); setClip(out, { keepT: true }); toast(`Layered "${upper.name}" (upper body) over "${S.clip.layered.base}" - ${out.duration}s, ${out.layered.requested === "auto" ? "tempo kept" : out.layered.fit}, score ${out.report.score}`); diag("layer", { base: out.layered.base, upper: upper.name, fit, weight });
  }
  function layerFromPick() {
    if (!S.clip) return toast("Generate the base clip first");
    const v = D.layerPick.value; if (!v) return toast("Pick the clip whose upper body you want (generate it first, it is remembered)");
    if (v === "__file") { S.fileFor = "layer"; D.file.click(); return; }
    const up = libraryClips()[v]; if (!up) return toast("That clip is gone - generate it again"); layerWith(up);
  }
  function setRightTab(name) { S.rtab = /^(pose|clip|check|clips)$/.test(name) ? name : "pose"; renderPanels(); }
  function renderPanels() {
    if (!D) return;
    for (const b of D.host.querySelectorAll("[data-rtab]")) b.classList.toggle("on", b.getAttribute("data-rtab") === S.rtab);
    for (const p of D.host.querySelectorAll("[data-rpanel]")) p.hidden = p.getAttribute("data-rpanel") !== S.rtab;
    D.editor.hidden = !S.editorOpen; D.editorToggle.classList.toggle("on", !S.editorOpen); D.editorToggle.title = S.editorOpen ? "Hide the key workbench (more room for the viewport)" : "Show the key workbench";
  }
  function renderTools() { if (!D) return; D.onionBtn.classList.toggle("on", !!S.onion); D.autoKeyBtn.classList.toggle("on", !!S.autoKey); D.pasteBtn.disabled = !S.clipboard || !S.clip; D.pasteFlipBtn.disabled = !S.clipboard || !S.clip; for (const b of D.host.querySelectorAll("[data-tool]")) b.disabled = !S.clip; if (D.interpBtn) { const sp = !!(S.clip && S.clip.interp === "spline"); D.interpBtn.textContent = sp ? "Spline" : "Eased"; D.interpBtn.classList.toggle("on", sp); } D.lockBtn.classList.toggle("on", !!(S.clip && S.clip.keys[S.sel] && S.clip.keys[S.sel].locked)); if (D.smoothVal) { const r = S.clip && S.clip.report; D.smoothVal.textContent = r && Number.isFinite(r.smoothness) ? `${r.smoothness}` : "–"; D.smoothVal.title = r && r.roughestJoint ? `motion smoothness (100 = silky). Roughest joint: ${r.roughestJoint}` : "motion smoothness (100 = silky)"; } }
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
    const interp = S.clip.interp === "spline" ? `<div class="rsa-fixes">Curves: spline (C1) - ${S.clip.keys.length} authored keys, exported to Studio / .rbxmx as ${E().exportKeys(S.clip).length} baked frames.</div>` : "";
    D.report.innerHTML = (items ? `<ul class="rsa-issues">${items}</ul>` : `<div class="rsa-ok">No issues - joint limits, continuity, timing and loop seam all pass.</div>`) + interp + fixes + lim + fb;
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
            <section class="rsa-card">
              <div class="rsa-h"><b>1</b> Describe ANY motion <span class="rsa-h-tag" data-ref="vocabTag" title="Everything the generator understands composes: motions × moods × styles × speeds × sides × parts × directions × then-chains × while-layers × takes">unlimited</span></div>
              <textarea data-ref="prompt" rows="4" placeholder="Anything: 'drink a potion', 'tired old man walk', 'wave while walking', 'salute then bow', '8 hit anime sword combo', 'guzzle a beer', 'stir a cauldron', 'teeter on the edge'. Several at once: 'idle, walk, run and jump animations for my knight' → one clip each, same character"></textarea>
              <div class="rsa-understood" data-ref="understood" aria-live="polite"></div>
              <div class="rsa-vocab">
                <div class="rsa-vocab-n" data-ref="vocabLine"></div>
                <div class="rsa-vocab-acts"><button type="button" class="rsa-btn small" data-act="inspire" title="Compose a random prompt from the vocabulary (motion × mood × style × speed × chain)">Inspire me</button><button type="button" class="rsa-btn small tgl" data-act="browse" data-ref="browseBtn" title="Browse everything the generator knows - click to insert">Browse motions</button></div>
              </div>
              <div class="rsa-browse" data-ref="browse" hidden>${vocabBrowserHtml()}</div>
              <details class="rsa-examples"><summary>Examples</summary><div class="rsa-chips">${PRESETS.map((p) => `<button type="button" class="rsa-chip" data-preset="${esc(p[1])}">${esc(p[0])}</button>`).join("")}</div></details>
              <div class="rsa-grid">
                <label>Quality<select data-ref="quality"><option value="fast">Fast</option><option value="balanced" selected>Balanced</option><option value="high">High Quality</option><option value="cinematic">Cinematic</option></select></label>
                <label>Rig<select data-ref="rig"><option value="R15" selected>R15</option><option value="R6">R6</option></select></label>
                <label>Duration (s)<input data-ref="duration" type="number" min="0.1" max="60" step="0.1" placeholder="auto"></label>
                <label>FPS<input data-ref="fps" type="number" min="10" max="120" step="1" placeholder="auto"></label>
                <label class="rsa-check"><input data-ref="loop" type="checkbox"> Loop</label>
                <label class="rsa-check" title="Reuse the character seed of the clips already in this session (lead side, arm rest, tempo, easing) so idle / walk / jump / attack blend as one person. Untick for a different character."><input data-ref="sameChar" type="checkbox" checked> Same character as my other clips</label>
              </div>
              <button type="button" class="rsa-btn primary big" data-act="generate">Generate</button>
              <div class="rsa-row"><button type="button" class="rsa-btn" data-act="regen" data-ref="regenBtn" title="Regenerate from the same prompt (discards manual edits)">Regenerate</button><button type="button" class="rsa-btn" data-act="variation" data-ref="varBtn" title="New take: same prompt, a different persona and choreography (fingerprint guaranteed to differ)">New take</button><button type="button" class="rsa-btn" data-act="mirror" data-ref="mirrorBtn" title="Swap left and right (left-handed version)">Mirror</button></div>
              <div class="rsa-persona" data-ref="persona" title="Who this clip is: the seeded persona behind its asymmetry, fidget, easing and tempo"></div>
            </section>
            <section class="rsa-card">
              <div class="rsa-h"><b>2</b> Refine with feedback</div>
              <div class="rsa-row"><input data-ref="feedback" type="text" placeholder="make it slow · a bit faster · fluent · heavier landing · more anticipation · tired · drunk · then wave"><button type="button" class="rsa-btn" data-act="refine" data-ref="refineBtn">Refine</button></div>
              <div class="rsa-muted">Understands speed ("make it slow / fast", "a bit slower", "half speed", "2x", "too fast"), "fluent" / smoother, weight, anticipation, exaggerate / subtle, longer / shorter, loop, new take, mirror, root motion, moods (tired, proud, drunk, scared…), "then …" to append a motion, plant feet, simplify, reverse.</div>
            </section>
            <section class="rsa-card rsa-card-tips">
              <div class="rsa-h"><b>3</b> Edit &amp; deliver</div>
              <div class="rsa-muted">Drag the figure to orbit · drag a hand / foot to pose with IK · click a joint, then type angles on the right · <kbd>I</kbd> insert key · <kbd>Shift+D</kbd> duplicate · <kbd>X</kbd> delete · <kbd>B</kbd> breakdown · <kbd>H</kbd> hold · <kbd>,</kbd> <kbd>.</kbd> nudge a frame · <kbd>G</kbd> motion arcs · <kbd>Ctrl+Z</kbd> undo. Build in Studio writes the KeyframeSequence; Export saves an .rbxmx.</div>
            </section>
          </aside>
          <main class="rsa-main">
            <div class="rsa-stagewrap">
              <canvas class="rsa-canvas" data-ref="canvas"></canvas>
              <div class="rsa-empty" data-ref="empty"><b>Describe ANY animation, then Generate</b><span>Idles, cycles, jumps, combat combos, emotes - and anything else you can phrase: "drink a potion", "open a heavy door", "tired old man walk", "wave while walking", "salute then bow", "raise the left arm", "guzzle a beer", "stir a cauldron", "teeter on the edge". Unknown words become synonyms or body-region primitives, so nearly any sentence turns into motion.</span><span>Preview is a schematic skeleton - use Preview in Studio for the real rig.</span></div>
              <div class="rsa-tools rsa-vtools">
                <button type="button" class="rsa-ib tgl" data-act="onion" data-ref="onionBtn" title="Onion skin: previous key (blue) and next key (orange) as ghosts (O)">${I.onion}</button>
                <button type="button" class="rsa-ib tgl" data-act="autoKey" data-ref="autoKeyBtn" title="Auto-key: editing at a time with no key inserts one there (K)">${I.key}</button>
                <button type="button" class="rsa-ib tgl" data-act="ghost" data-ref="ghostBtn" title="Before / after: show the previous version as a ghost">${I.ghost}</button>
              </div>
              <div class="rsa-viewsel"><button type="button" class="rsa-chip on" data-view="3d" title="Orbit view (5)">3D</button><button type="button" class="rsa-chip" data-view="front" title="Front (1)">Front</button><button type="button" class="rsa-chip" data-view="side" title="Side (3)">Side</button><button type="button" class="rsa-chip" data-view="top" title="Top (7)">Top</button><button type="button" class="rsa-chip" data-view="both" title="Front + Side (2)">Front + Side</button><button type="button" class="rsa-ib" data-act="resetCam" title="Reset camera (double-click the viewport)">${I.cam}</button></div>
            </div>
            <div class="rsa-transport">
              <button type="button" class="rsa-ib" data-act="play" data-ref="playBtn" title="Play (Space)">${I.play}</button>
              <button type="button" class="rsa-ib" data-act="stop" data-ref="stopBtn" title="Stop">${I.stop}</button>
              <button type="button" class="rsa-ib tgl" data-act="loopPlay" data-ref="loopPlay" title="Loop playback in this preview">${I.loop}</button>
              <select data-ref="speed" title="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
              <input data-ref="scrub" type="range" min="0" max="1" step="0.01" value="0" title="Scrub">
              <span class="rsa-time" data-ref="time">0.00 / 0.00 s</span>
            </div>
            <canvas class="rsa-timeline" data-ref="timeline" title="Click to scrub · drag a key to retime it · click a key to edit it"></canvas>
            <div class="rsa-bench" data-ref="editor">
              <div class="rsa-bench-head">
                <span class="rsa-bench-t" title="Every key of the clip in order - click to select; the glyph is the key's role (! impact · = hold · ~ breakdown · ⚑ marker)">Keys</span>
                <div class="rsa-keystrip" data-ref="keystrip"></div>
                <button type="button" class="rsa-ib mini" data-act="toggleEditor" data-ref="editorToggle" title="Show / hide the key workbench">${I.collapse}</button>
              </div>
              <div class="rsa-bench-tools">
                <div class="rsa-bt" title="Tween machine: insert a key at the playhead whose pose favours the previous key (0%) or the next key (100%) instead of the plain in-between - passing positions, favours, overshoots">
                  <b>Breakdown</b><input type="range" data-ref="bias" min="0" max="100" value="50" step="5"><span class="rsa-bt-v" data-ref="biasVal">50%</span><button type="button" class="rsa-btn mini" data-act="breakdown">Insert at playhead</button>
                </div>
                <div class="rsa-bt" title="Moving hold: repeat the selected pose N frames later (later keys slide back if needed) - lets a pose read before the next move">
                  <b>Hold</b><input type="number" data-ref="holdFrames" value="3" min="1" max="30" step="1"><span class="rsa-bt-v">frames</span><button type="button" class="rsa-btn mini" data-act="hold">Add moving hold</button>
                </div>
                <div class="rsa-bt" title="Move the selected key by one frame (never past its neighbours)">
                  <b>Nudge</b><button type="button" class="rsa-btn mini" data-act="nudgeL">◀ 1 frame</button><button type="button" class="rsa-btn mini" data-act="nudgeR">1 frame ▶</button>
                </div>
                <div class="rsa-bt rsa-bt-wide" title="KeyframeMarker on the selected key: Studio fires AnimationTrack:GetMarkerReachedSignal(name) when playback passes it - footsteps, hit frames, sounds, VFX. 'name=value' sets a value">
                  <b>Marker</b><input type="text" data-ref="markerName" placeholder="footstep · hit=right · sfx=swing"><button type="button" class="rsa-btn mini" data-act="marker">Add to key</button><div class="rsa-markers" data-ref="markerList"></div>
                </div>
                <div class="rsa-bt rsa-bt-wide" data-ref="easeAllRow" title="Set the easing of every key at once; impacts / lands get the preset's arrival, holds stay flat">
                  <b>Ease all</b>${Object.entries((typeof ORAnimEngine !== "undefined" && ORAnimEngine.EASE_PRESETS) || { snappy: { label: "Snappy" }, organic: { label: "Organic" }, mechanical: { label: "Mechanical" }, bouncy: { label: "Bouncy" }, elastic: { label: "Elastic" }, anticipate: { label: "Anticipate" } }).map(([id, p]) => `<button type="button" class="rsa-chip" data-ease-all="${id}" title="${esc(p.note || "")}">${esc(p.label)}</button>`).join("")}
                </div>
                <div class="rsa-bt" title="Follow-through: elbows, wrists, head, knees and ankles trail their parents by N frames - the secondary motion that makes a pose feel alive">
                  <b>Overlap</b><input type="number" data-ref="lagFrames" value="2" min="1" max="8" step="1"><span class="rsa-bt-v">frames</span><button type="button" class="rsa-btn mini" data-act="overlap">Follow-through</button>
                </div>
                <div class="rsa-bt" title="Stretch or compress the whole clip to a new length, keeping every timing ratio">
                  <b>Retime</b><input type="number" data-ref="retimeTo" placeholder="s" min="0.1" max="60" step="0.1"><button type="button" class="rsa-btn mini" data-act="retime">Set length</button>
                </div>
                <div class="rsa-bt" title="Draw the paths of hands, feet and head through the whole clip in the viewport (yellow dots = keys). Smooth arcs read well; zig-zags need a breakdown">
                  <b>Arcs</b><button type="button" class="rsa-btn mini tgl" data-act="arcs" data-ref="arcsBtn">Motion trails</button>
                </div>
              </div>
              <div class="rsa-timing" data-ref="timing"></div>
            </div>
            <div class="rsa-foot">
              <span class="rsa-status" data-ref="status"></span>
              <input data-ref="intent" type="text" placeholder="Note for the AI (optional)">
              <button type="button" class="rsa-btn" data-act="send" data-ref="sendBtn" title="Hand the clip to the AI in the chat">Send to AI</button>
              <button type="button" class="rsa-btn" data-act="export" data-ref="exportBtn" title="Export a Roblox KeyframeSequence (.rbxmx) - drag it into Studio or import it">${I.export} Export .rbxmx</button>
              <button type="button" class="rsa-btn" data-act="previewStudio" data-ref="previewBtn" title="Build if needed, then play it on the rig in Studio">Preview in Studio</button>
              <button type="button" class="rsa-btn primary" data-act="build" data-ref="buildBtn" title="Write the KeyframeSequence into Studio now (animation_build)">Build in Studio</button>
            </div>
          </main>
          <aside class="rsa-right">
            <div class="rsa-rtabs">
              <button type="button" class="rsa-chip on" data-rtab="pose" title="Joints, selected key, pose tools, pose library">Pose</button>
              <button type="button" class="rsa-chip" data-rtab="clip" title="Curves, cleanup, layering, stages">Clip</button>
              <button type="button" class="rsa-chip" data-rtab="check" title="Validation report, smoothness, auto-fix, set compatibility">Check <span class="rsa-score" data-ref="score">–</span></button>
              <button type="button" class="rsa-chip" data-rtab="clips" title="Every clip of this session: switch, build all, export all, check they fit together">Clips <span class="rsa-count" data-ref="clipCount">0</span></button>
            </div>
            <div class="rsa-rpanel" data-rpanel="clips" hidden>
              <div class="rsa-h">Session clips <span class="rsa-muted rsa-hr">click = open · one character</span></div>
              <div class="rsa-cliplist" data-ref="clipList"></div>
              <div class="rsa-row"><button type="button" class="rsa-btn mini" data-act="buildAll" data-ref="buildAllBtn" title="Build every clip in Studio, one KeyframeSequence each (animation_build per clip)">Build all in Studio</button><button type="button" class="rsa-btn mini" data-act="exportAll" title="Download one .rbxmx per clip">Export all</button><button type="button" class="rsa-btn mini" data-act="checkSet" title="Compatibility: same character / rig / fps, stance distance + root pop between clips, fade times">Check set</button></div>
              <div class="rsa-muted">Type several animations at once ("idle, walk, run and jump for my knight") and each becomes its own clip here - never one merged clip. Clips made in separate requests share the character seed while "Same character" is ticked.</div>
            </div>
            <div class="rsa-rpanel" data-rpanel="pose">
              <div class="rsa-h">Joints <span class="rsa-muted rsa-hr">click one, or click a handle in the viewport</span></div>
              <div class="rsa-joints" data-ref="joints"></div>
              <div class="rsa-h">Selected key</div>
              <div class="rsa-inspector" data-ref="inspector"></div>
              <div class="rsa-h">Pose tools</div>
              <div class="rsa-posetools">
                <button type="button" class="rsa-btn mini" data-act="insertKey" title="Insert a key at the playhead holding the interpolated pose (I)">${I.key} Insert key</button>
                <button type="button" class="rsa-btn mini" data-act="copyPose" title="Copy the selected key's pose (Ctrl+C)">${I.copy} Copy</button>
                <button type="button" class="rsa-btn mini" data-act="pastePose" data-ref="pasteBtn" title="Paste the copied pose onto the selected key (Ctrl+V)">${I.paste} Paste</button>
                <button type="button" class="rsa-btn mini" data-act="pasteFlip" data-ref="pasteFlipBtn" title="Paste X-flipped: left ↔ right (Ctrl+Shift+V)">${I.flip} Paste flipped</button>
                <button type="button" class="rsa-btn mini tgl" data-act="lockKey" data-ref="lockBtn" title="Lock this key: Smooth and Simplify leave it untouched">${I.lock} Lock key</button>
              </div>
              <div class="rsa-h">Pose library <span class="rsa-muted rsa-hr">Shift-click = X-flipped</span></div>
              <div class="rsa-row"><input data-ref="poseName" type="text" placeholder="pose name"><button type="button" class="rsa-btn mini" data-act="savePose" title="Save the selected key's pose to the library (kept in this browser)">Save pose</button></div>
              <div class="rsa-poses" data-ref="poses"></div>
            </div>
            <div class="rsa-rpanel" data-rpanel="clip" hidden>
              <div class="rsa-h">Curves &amp; cleanup</div>
              <div class="rsa-tools">
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="smooth" title="Smooth: switch the clip to spline (C1) curves and relax every non-anchor key toward its neighbours (impacts, holds and locked keys stay)">Smooth</button><small>spline curves + relaxed keys; impacts stay sharp</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="interp" data-ref="interpBtn" title="Interpolation: Eased = Roblox easing per key (velocity resets at every key); Spline = C1 F-curves through the keys like Blender (exported to Studio baked per frame)">Eased</button><small>interpolation: eased per key ↔ C1 spline (click to switch)</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="plant" title="Plant feet: put the lowest foot on the ground at every key (root re-based) and flatten planted soles">Plant feet</button><small>no floating / sliding: lowest foot on the ground at every key</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="simplify" title="Clean keys: remove keys the interpolation already reproduces within 2°">Simplify</button><small>drop keys the curve already reproduces (2°)</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="reverse" title="Reverse the clip in time">Reverse</button><small>play it backwards</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="bake" title="Bake: one key per frame (what Studio plays)">Bake</button><small>one key per frame (Simplify undoes the density)</small></div>
                <div class="rsa-toolrow"><button type="button" class="rsa-btn mini" data-tool="offset" title="Cycle offset: move where a looping clip starts">Cycle offset</button><small>move where a looping clip starts</small></div>
              </div>
              <div class="rsa-h">Layer upper body (NLA)</div>
              <div class="rsa-row rsa-layer"><select data-ref="layerPick" title="The clip whose upper body goes on top of the current clip's legs and root"></select></div>
              <div class="rsa-row rsa-layer"><select data-ref="layerFit" title="keep tempo: nobody speeds up - a looping base repeats under a longer upper clip, a one-shot base holds its last pose · stretch: upper clip retimed to this clip's duration (changes its speed) · loop: upper clip repeats at its own period · hold: upper plays once, then holds"><option value="auto">keep tempo (auto)</option><option value="stretch">stretch to fit</option><option value="loop">loop at own period</option><option value="hold">play once, hold</option></select><input data-ref="layerWeight" type="number" min="0" max="1" step="0.1" value="1" title="Blend weight of the upper body (1 = fully replaced)"><button type="button" class="rsa-btn" data-act="layer" title="Combine: legs + root from this clip, upper body from the picked clip">Layer</button></div>
              <div class="rsa-muted">Legs + root stay from this clip; waist, head and arms come from the picked clip (walk + wave, run + aim). Or just type "wave while walking".</div>
              <div class="rsa-h">Stages <span class="rsa-muted rsa-hr">click to jump</span></div>
              <div class="rsa-stages" data-ref="stages"></div>
            </div>
            <div class="rsa-rpanel" data-rpanel="check" hidden>
              <div class="rsa-h">Validation <span class="rsa-smooth" title="motion smoothness (100 = silky)">smooth <b data-ref="smoothVal">–</b></span><button type="button" class="rsa-btn mini" data-act="fix" data-ref="fixBtn" title="Clamp limits, bridge jumps, close the loop">Auto-fix</button></div>
              <div class="rsa-report" data-ref="report"></div>
              <div class="rsa-h">Set compatibility <span class="rsa-score" data-ref="compatScore">–</span><button type="button" class="rsa-btn mini" data-act="checkSet" title="Re-check how the session's clips fit together">Re-check</button></div>
              <div class="rsa-report" data-ref="compat"></div>
            </div>
          </aside>
        </div>
        <input type="file" accept=".json,application/json" data-ref="file" hidden>
      </div>`;
    document.body.appendChild(host);
    D = { host, toast: host.querySelector(".rsa-toast") };
    host.querySelectorAll("[data-ref]").forEach((el) => { D[el.getAttribute("data-ref")] = el; });
    D.loopAuto = true;
    if (D.vocabLine) D.vocabLine.innerHTML = vocabLine();
    D.prompt.addEventListener("input", () => { clearTimeout(understoodTimer); understoodTimer = setTimeout(renderUnderstood, 160); });
    // actions
    host.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]"); if (act) { e.preventDefault(); return doAction(act.getAttribute("data-act")); }
      const preset = e.target.closest("[data-preset]"); if (preset) { D.prompt.value = preset.getAttribute("data-preset"); D.loopAuto = true; D.duration.value = ""; generate(); return; }
      const ins = e.target.closest("[data-ins]"); if (ins) { insertVocab(ins.getAttribute("data-ins"), ins.getAttribute("data-mode")); return; }
      const joint = e.target.closest("[data-joint]"); if (joint) { S.selJoint = joint.getAttribute("data-joint"); renderJoints(); renderInspector(); return; }
      const view = e.target.closest("[data-view]"); if (view) { setView(view.getAttribute("data-view")); return; }
      const tool = e.target.closest("[data-tool]"); if (tool) { clipTool(tool.getAttribute("data-tool")); return; }
      const kc = e.target.closest("[data-key]"); if (kc) { selectKey(parseInt(kc.getAttribute("data-key"), 10)); return; }
      const ea = e.target.closest("[data-ease-all]"); if (ea) { benchEaseAll(ea.getAttribute("data-ease-all")); return; }
      const md = e.target.closest("[data-marker-del]"); if (md) { benchMarkerDel(md.getAttribute("data-marker-del")); return; }
      const rt = e.target.closest("[data-rtab]"); if (rt) { setRightTab(rt.getAttribute("data-rtab")); return; }
      const dc = e.target.closest("[data-delclip]"); if (dc) { forgetClip(dc.getAttribute("data-delclip")); return; }
      const ci = e.target.closest("[data-clip]"); if (ci) { switchClip(ci.getAttribute("data-clip")); return; }
      const pd = e.target.closest("[data-pose-del]"); if (pd) { deleteLibraryPose(pd.getAttribute("data-pose-del")); return; }
      const pa = e.target.closest("[data-pose]"); if (pa) { applyLibraryPose(pa.getAttribute("data-pose"), e.shiftKey); return; }
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
      if (t === D.file && t.files && t.files[0]) { const f = t.files[0]; t.value = ""; if (S.fileFor === "layer") { S.fileFor = null; const rd = new FileReader(); rd.onload = () => { try { layerWith(E().parseProject(String(rd.result))); } catch (e) { toast("Could not read that project: " + (e && e.message || e)); } }; rd.readAsText(f); return; } openProject(f); return; }
      if (t === D.layerPick && t.value === "__file") { layerFromPick(); return; }
    });
    D.scrub.addEventListener("input", () => { if (S.playing) pause(); scrub(parseFloat(D.scrub.value) || 0); });
    // viewport: orbit / pan / zoom / pick / IK
    D.canvas.addEventListener("pointerdown", viewportDown); D.canvas.addEventListener("pointermove", viewportMove); D.canvas.addEventListener("pointerup", viewportUp); D.canvas.addEventListener("pointercancel", viewportUp);
    D.canvas.addEventListener("wheel", viewportWheel, { passive: false }); D.canvas.addEventListener("dblclick", resetCamera);
    // key workbench
    D.bias.addEventListener("input", () => { if (D.biasVal) D.biasVal.textContent = `${D.bias.value}%`; });
    D.markerName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); benchMarker(); } });
    D.retimeTo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); benchRetime(); } });
    D.poseName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); savePoseToLibrary(); } });
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
      if ((e.ctrlKey || e.metaKey) && !typing && (e.key === "c" || e.key === "C")) { e.preventDefault(); copyPose(); return; }
      if ((e.ctrlKey || e.metaKey) && !typing && (e.key === "v" || e.key === "V")) { e.preventDefault(); pastePose(e.shiftKey); return; }
      if (typing) return;
      if (e.key === " ") { e.preventDefault(); if (S.playing) pause(); else play(); }
      else if (e.key === "ArrowRight" && S.clip) { e.preventDefault(); if (e.shiftKey) selectKey(S.sel + 1); else scrub(S.t + 1 / S.clip.fps); }
      else if (e.key === "ArrowLeft" && S.clip) { e.preventDefault(); if (e.shiftKey) selectKey(S.sel - 1); else scrub(S.t - 1 / S.clip.fps); }
      else if ((e.key === "Delete" || e.key === "x" || e.key === "X") && S.clip) { e.preventDefault(); deleteKey(); }
      else if ((e.key === "i" || e.key === "I") && S.clip) { e.preventDefault(); insertKeyHere(); }
      else if ((e.key === "d" || e.key === "D") && e.shiftKey && S.clip) { e.preventDefault(); duplicateKey(); }
      else if (e.key === "ArrowUp" && S.clip) { e.preventDefault(); selectKey(S.sel + 1); }
      else if (e.key === "ArrowDown" && S.clip) { e.preventDefault(); selectKey(S.sel - 1); }
      else if (e.key === "1") { e.preventDefault(); setView("front"); } else if (e.key === "3") { e.preventDefault(); setView("side"); } else if (e.key === "7") { e.preventDefault(); setView("top"); } else if (e.key === "5") { e.preventDefault(); setView("3d"); } else if (e.key === "2") { e.preventDefault(); setView("both"); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); S.onion = !S.onion; renderPreview(); renderTools(); }
      else if (e.key === "k" || e.key === "K") { e.preventDefault(); S.autoKey = !S.autoKey; renderTools(); toast(S.autoKey ? "Auto-key ON: edits off a key insert one at the playhead" : "Auto-key OFF: edits land on the selected key"); }
      else if ((e.key === "g" || e.key === "G") && S.clip) { e.preventDefault(); benchArcs(); }
      else if ((e.key === "b" || e.key === "B") && S.clip && !e.ctrlKey && !e.metaKey) { e.preventDefault(); benchBreakdown(); }
      else if ((e.key === "h" || e.key === "H") && S.clip && !e.ctrlKey && !e.metaKey) { e.preventDefault(); benchHold(); }
      else if (e.key === "," && S.clip) { e.preventDefault(); benchNudge(-1); } else if (e.key === "." && S.clip) { e.preventDefault(); benchNudge(1); }
      else if (e.key === "Home") { e.preventDefault(); scrub(0); } else if (e.key === "End" && S.clip) { e.preventDefault(); scrub(S.clip.duration); }
    });
    window.addEventListener("resize", () => { if (S.open) { renderPreview(); renderTimeline(); renderEditor(); } });
    renderAll();
  }
  function doAction(name) {
    switch (name) {
      case "generate": return generate();
      case "regen": return regenerate();
      case "inspire": return inspire();
      case "browse": return toggleBrowse();
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
      case "onion": S.onion = !S.onion; renderPreview(); renderTools(); return;
      case "autoKey": S.autoKey = !S.autoKey; renderTools(); toast(S.autoKey ? "Auto-key ON: edits off a key insert one at the playhead" : "Auto-key OFF: edits land on the selected key"); return;
      case "resetCam": return resetCamera();
      case "toggleEditor": S.editorOpen = !S.editorOpen; renderPanels(); if (S.editorOpen) renderEditor(); return;
      case "breakdown": return benchBreakdown();
      case "hold": return benchHold();
      case "nudgeL": return benchNudge(-1);
      case "nudgeR": return benchNudge(1);
      case "marker": return benchMarker();
      case "overlap": return benchOverlap();
      case "retime": return benchRetime();
      case "arcs": return benchArcs();
      case "buildAll": return buildAll();
      case "exportAll": return exportAll();
      case "checkSet": return checkSet();
      case "insertKey": return insertKeyHere();
      case "copyPose": return copyPose();
      case "pastePose": return pastePose(false);
      case "pasteFlip": return pastePose(true);
      case "lockKey": return toggleLock();
      case "savePose": return savePoseToLibrary();
      case "layer": return layerFromPick();
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
    renderPoses(); renderLayerPick();
    renderAll();
    requestAnimationFrame(() => { renderPreview(); renderTimeline(); renderEditor(); D.host.focus(); });
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
    if (meta && meta.built) { S.built = { name: clip.name, at: Date.now() }; S.builtNames[clip.name] = Date.now(); }
    if (!Number.isFinite(S.personaSeed) && Number.isFinite(clip.personaSeed)) S.personaSeed = clip.personaSeed;
    remember(clip);
    if (meta && meta.rigInfo) S.rigInfo = meta.rigInfo;
    return true;
  }
  function setRigInfo(info) { S.rigInfo = info || null; }
  function loadSet(set, meta) {
    if (!set || !Array.isArray(set.clips) || !set.clips.length) return false;
    for (const c of set.clips) { remember(c); if (meta && Array.isArray(meta.built) && meta.built.includes(c.name)) S.builtNames[c.name] = Date.now(); }
    S.compat = set.report || null;
    if (!Number.isFinite(S.personaSeed) && Number.isFinite(set.personaSeed)) S.personaSeed = set.personaSeed;
    const ok = loadClip(set.clips[0], { built: !!(meta && meta.built && meta.built.includes(set.clips[0].name)), rigInfo: meta && meta.rigInfo });
    if (D) { renderClipList(); renderCompat(); setRightTab("clips"); }
    return ok;
  }
  window.ORAnimStudio = { open, close, isOpen, getClip, loadClip, loadSet, switchClip, checkSet, buildAll, exportAll, setRigInfo, clipTool, layerWith, insertKey: insertKeyHere, copyPose, pastePose, setView, resetCamera, _viewport: { down: viewportDown, move: viewportMove, up: viewportUp, wheel: viewportWheel }, _bench: { breakdown: benchBreakdown, hold: benchHold, nudge: benchNudge, marker: benchMarker, easeAll: benchEaseAll, overlap: benchOverlap, retime: benchRetime, arcs: benchArcs }, generate: (p, o) => { if (!D) build(); return generate(p, o); }, buildMessage, PRESETS, _state: S, _refine: refine, _variation: variation, _selectKey: selectKey, _setJointValue: setJointValue, _retime: retime, _play: play, _pause: pause, _stop: stop, _scrub: scrub, _undo: undo, _redo: redo, _exportRbxmx: exportRbxmx, _timelineHit: timelineHit };
})();
