// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/videostudio.js — TotalScript Video Studio (1.79.0)
//
// "Show the AI a video, it builds something similar." The AI chat sites cannot
// take a video upload, so this window turns a LOCAL video file (mp4 / webm /
// mov / gif - decoded entirely in the browser, nothing is uploaded anywhere
// except to the chat you are already using) into what a model CAN read:
//   - a contact sheet (grid of keyframes with the timestamp burnt into each)
//   - up to 8 individual keyframes as separate images (where the site allows)
//   - a VIDEO BRIEF: duration, shots with time ranges, camera motion per shot
//     (static / pan / tilt / zoom / handheld / subject motion), motion level,
//     palette, HUD-like static overlay regions, a detected KIND (gui /
//     animation / cutscene / vfx / map / gameplay - a heuristic the user can
//     override) and a kind-specific recreation protocol using the real
//     TotalScript commands (cutscene_*, animation_*, ui_art_*, fx_* …).
// The analysis is pure functions over small grayscale samples, so it is
// testable in node without a video element (tests/test-video-studio.js).
//
// Public API (window.TotalVideoStudio):
//   open(hooks) / close() / isOpen()      hooks: { send(text, images, onStatus), engine(),
//                                           canAttachImages(), maxImages(), toast, diag }
//   analyze(samples, opts)                pure: samples → analysis
//   detectShots / blockMotion / cameraLabel / classifyKind / pickKeyframes / palette
//   buildMessage(analysis, opts)          the VIDEO BRIEF text
//   KINDS, VERSION
(() => {
  "use strict";
  if (window.TotalVideoStudio) return;
  const VERSION = "1.79.0";
  const BRIEF_MARK = "\u27E6TotalScript VIDEO BRIEF\u27E7";

  const KINDS = {
    gui: { label: "GUI / HUD / menu", hint: "a screen, menu or HUD - static layout, text, buttons" },
    animation: { label: "Character / object animation", hint: "a subject moves, the camera mostly does not" },
    cutscene: { label: "Camera / cutscene", hint: "the camera itself pans, tilts, zooms or cuts between shots" },
    vfx: { label: "VFX / particles / lighting", hint: "flashes, bursts, glows, beams - colour and brightness change fast" },
    map: { label: "Map / environment / build", hint: "a place or model shown slowly, little motion" },
    gameplay: { label: "Gameplay / mechanic", hint: "a player doing something with a HUD on top" },
  };
  const KIND_IDS = Object.keys(KINDS);

  // ───────────────────────── pure analysis ─────────────────────────
  // A sample is { t, w, h, gray: Uint8Array(w*h), hist: number[64] (4x4x4 RGB), lum, sat }.
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtT = (t) => (Math.round(t * 10) / 10).toFixed(1) + " s";
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const stddev = (arr) => { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(mean(arr.map((v) => (v - m) * (v - m)))); };

  function frameDiff(a, b) {
    if (!a || !b || a.gray.length !== b.gray.length) return 255;
    let s = 0; const n = a.gray.length;
    for (let i = 0; i < n; i++) s += Math.abs(a.gray[i] - b.gray[i]);
    return s / n;
  }
  function histDiff(a, b) {
    if (!a || !b || !a.hist || !b.hist) return 1;
    let s = 0, ta = 0, tb = 0;
    for (let i = 0; i < a.hist.length; i++) { ta += a.hist[i]; tb += b.hist[i]; }
    if (!ta || !tb) return 1;
    for (let i = 0; i < a.hist.length; i++) s += Math.abs(a.hist[i] / ta - b.hist[i] / tb);
    return s / 2; // 0 identical … 1 disjoint
  }

  // Coarse block matching: grid×grid blocks of `a` searched in `b` within ±radius px.
  // Returns per-block vectors, the dominant (median) global vector, how coherent the
  // field is (fraction of blocks agreeing with the global vector), and the fraction of
  // blocks that moved at all.
  function blockMotion(a, b, opts = {}) {
    const grid = opts.grid || 4, radius = opts.radius || 3;
    const w = a.w, h = a.h, bw = Math.floor(w / grid), bh = Math.floor(h / grid);
    const vectors = [];
    for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
      const x0 = gx * bw + radius, y0 = gy * bh + radius, x1 = (gx + 1) * bw - radius, y1 = (gy + 1) * bh - radius;
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      let best = { dx: 0, dy: 0, err: Infinity }, still = Infinity;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        let e = 0, n = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
          const xa = x + dx, ya = y + dy;
          if (xa < 0 || ya < 0 || xa >= w || ya >= h) continue;
          e += Math.abs(a.gray[y * w + x] - b.gray[ya * w + xa]); n++;
        }
        e = n ? e / n : 255;
        if (dx === 0 && dy === 0) still = e;
        if (e < best.err - 1e-6 || (Math.abs(e - best.err) < 1e-6 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, err: e };
      }
      // Only count a shift when it clearly beats staying put (textureless blocks match everywhere).
      const moved = still - best.err > Math.max(1.5, still * 0.15);
      vectors.push({ gx, gy, dx: moved ? best.dx : 0, dy: moved ? best.dy : 0, err: best.err, still, moved, textured: still > 2 || best.err > 2 });
    }
    const movedV = vectors.filter((v) => v.moved);
    const med = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const gdx = med(movedV.map((v) => v.dx)), gdy = med(movedV.map((v) => v.dy));
    const agree = movedV.filter((v) => Math.abs(v.dx - gdx) <= 1 && Math.abs(v.dy - gdy) <= 1).length;
    // Radial component (zoom): sign of vector · (block centre − image centre).
    let radial = 0;
    for (const v of movedV) {
      const cx = (v.gx + 0.5) * bw - w / 2, cy = (v.gy + 0.5) * bh - h / 2;
      const d = v.dx * cx + v.dy * cy;
      radial += d > 0 ? 1 : d < 0 ? -1 : 0;
    }
    return {
      vectors, global: { dx: gdx, dy: gdy },
      movingFraction: vectors.length ? movedV.length / vectors.length : 0,
      changedFraction: vectors.length ? vectors.filter((v) => v.still > 6).length / vectors.length : 0,
      coherence: movedV.length ? agree / movedV.length : 0,
      radial: movedV.length ? radial / movedV.length : 0,
    };
  }

  // Human label for one sample pair.
  function cameraLabel(m, diff) {
    if (!m) return "static";
    if (m.movingFraction < 0.15) return (m.movingFraction > 0 || m.changedFraction > 0 || diff > 2.5) ? "subject motion" : "static";
    const mag = Math.abs(m.global.dx) + Math.abs(m.global.dy);
    if (m.movingFraction >= 0.5 && Math.abs(m.radial) >= 0.6 && mag <= 1) return m.radial > 0 ? "zoom in" : "zoom out";
    if (m.movingFraction >= 0.5 && m.coherence >= 0.6 && mag >= 1) {
      if (Math.abs(m.global.dx) >= Math.abs(m.global.dy)) return m.global.dx > 0 ? "pan left" : "pan right"; // content slides left ⇒ camera pans right
      return m.global.dy > 0 ? "tilt up" : "tilt down";
    }
    if (m.movingFraction >= 0.5 && m.coherence < 0.4) return "handheld / shake";
    return "subject motion";
  }
  const CAMERA_LABELS = ["static", "pan left", "pan right", "tilt up", "tilt down", "zoom in", "zoom out", "handheld / shake", "subject motion"];

  // Shot boundaries from adaptive thresholds on pixel + histogram change.
  function detectShots(samples, opts = {}) {
    const n = samples.length;
    if (n === 0) return [];
    if (n === 1) return [{ start: 0, end: 0 }];
    const diffs = [], hd = [];
    for (let i = 1; i < n; i++) { diffs.push(frameDiff(samples[i - 1], samples[i])); hd.push(histDiff(samples[i - 1], samples[i])); }
    const m = mean(diffs), sd = stddev(diffs);
    const thr = Math.max(opts.minDiff || 22, m + (opts.k || 2.5) * sd);
    const minLen = Math.max(1, opts.minShotSamples || 2);
    const cuts = [];
    for (let i = 0; i < diffs.length; i++) {
      // A cut is a spike: well above the clip's typical change AND a clear local
      // peak over its neighbours, with the colour distribution jumping too.
      const nb = Math.max(i > 0 ? diffs[i - 1] : 0, i + 1 < diffs.length ? diffs[i + 1] : 0);
      const peak = diffs[i] >= (opts.minDiff || 22) && diffs[i] >= 1.4 * nb && hd[i] >= (opts.minHist || 0.2);
      const isCut = (diffs[i] >= thr && hd[i] >= (opts.minHist || 0.2)) || peak || (hd[i] >= 0.5 && diffs[i] >= 8);
      if (isCut && (!cuts.length || i + 1 - cuts[cuts.length - 1] >= minLen)) cuts.push(i + 1);
    }
    const shots = []; let s = 0;
    for (const c of cuts) { shots.push({ start: s, end: c - 1 }); s = c; }
    shots.push({ start: s, end: n - 1 });
    return shots.map((sh) => Object.assign(sh, { diffs: diffs.slice(sh.start, sh.end) }));
  }

  // Pixels whose content barely changes over the clip but sit on an edge (text, a
  // frame, a logo) - a HUD / menu / watermark. Measured per PIXEL so a small HUD
  // in the corner of a moving scene is not diluted by its cell; reported per
  // cells×cells region. Returns fraction of the frame + where it sits.
  function staticOverlay(samples, cells = 6) {
    if (samples.length < 3) return { fraction: 0, cells: [], regions: [] };
    const w = samples[0].w, h = samples[0].h, base = samples[0], n = samples.length;
    const flag = new Uint8Array(w * h);
    let total = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let d = 0;
      for (let k = 1; k < n; k++) d += Math.abs(samples[k].gray[i] - base.gray[i]);
      d /= (n - 1);
      if (d >= 5) continue;
      const edge = Math.abs(base.gray[i] - base.gray[i + 1]) + Math.abs(base.gray[i] - base.gray[i + w]) + Math.abs(base.gray[i] - base.gray[i - 1]) + Math.abs(base.gray[i] - base.gray[i - w]);
      if (edge > 24) { flag[i] = 1; total++; }
    }
    const cw = w / cells, ch = h / cells, out = [];
    for (let gy = 0; gy < cells; gy++) for (let gx = 0; gx < cells; gx++) {
      let c = 0, m = 0;
      for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y++) for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x++) { m++; if (flag[y * w + x]) c++; }
      out.push({ gx, gy, share: m ? c / m : 0, static: m ? c / m >= 0.12 : false });
    }
    const where = new Set();
    for (const c of out.filter((c) => c.static)) {
      const v = c.gy < cells / 3 ? "top" : c.gy >= (2 * cells) / 3 ? "bottom" : "middle";
      const hz = c.gx < cells / 3 ? "left" : c.gx >= (2 * cells) / 3 ? "right" : "centre";
      where.add(v === "middle" && hz === "centre" ? "centre" : `${v}-${hz}`);
    }
    // Fraction of the frame covered by static detail, counted by region cells so a
    // dense little HUD and a sparse big one compare sensibly.
    const covered = out.filter((c) => c.static).length / out.length;
    return { fraction: covered, pixelFraction: total / (w * h), cells: out, regions: [...where] };
  }

  // Top colours from the summed 4x4x4 histogram (bin centres).
  function palette(samples, n = 5) {
    if (!samples.length || !samples[0].hist) return [];
    const sum = new Array(64).fill(0);
    for (const s of samples) for (let i = 0; i < 64; i++) sum[i] += s.hist[i] || 0;
    const total = sum.reduce((a, b) => a + b, 0) || 1;
    const hex = (v) => ("0" + Math.round(v).toString(16)).slice(-2);
    return sum.map((c, i) => ({ i, c })).filter((b) => b.c > 0).sort((p, q) => q.c - p.c).slice(0, n).map((b) => {
      const r = ((b.i >> 4) & 3) * 64 + 32, g = ((b.i >> 2) & 3) * 64 + 32, bl = (b.i & 3) * 64 + 32;
      return { hex: "#" + hex(r) + hex(g) + hex(bl), share: Math.round((b.c / total) * 100) };
    });
  }

  function classifyKind(f) {
    const reasons = [];
    const score = { gui: 0, animation: 0, cutscene: 0, vfx: 0, map: 0, gameplay: 0 };
    const moving = f.subjectFraction >= 0.2 || f.cameraFraction >= 0.2;
    // Static detail over MOST of a frame whose camera never moves is a static
    // background, not an overlay; a minority of the frame staying put over a
    // moving scene is a HUD; a whole frame that never moves at all is a screen.
    const screenLike = f.hudFraction >= 0.35 && f.avgMotion < 5 && f.flatness >= 0.4; // a scene has texture everywhere, a screen has flat panels
    const overlay = f.hudFraction >= 0.6 ? (screenLike ? f.hudFraction : 0) : f.hudFraction; // ≥60% "static detail" is a background (frozen or behind a subject), never a HUD
    if (screenLike) { score.gui += 3.5; reasons.push(`${Math.round(f.hudFraction * 100)}% of the frame never changes but has detail (a layout)`); }
    else if (overlay >= 0.1) { score.gameplay += 1.5; score.gui += overlay >= 0.3 ? 1.5 : 0.5; reasons.push(`${Math.round(overlay * 100)}% static overlay (HUD-like, ${f.hudRegions && f.hudRegions.length ? f.hudRegions.join(", ") : "edges"})`); }
    if (f.avgMotion < 3 && !screenLike) {
      if (f.flatness >= 0.6) { score.gui += 3; reasons.push(`flat panels with crisp edges (${Math.round(f.flatness * 100)}% flat) and no motion - a screen`); }
      else { score.map += 1.5; score.gui += 0.5; reasons.push("very little motion"); }
    }
    if (f.cameraFraction >= 0.45) { score.cutscene += 3; reasons.push(`camera moves in ${Math.round(f.cameraFraction * 100)}% of the clip`); }
    else if (f.cameraFraction >= 0.2) { score.cutscene += 1.5; score.gameplay += 0.5; reasons.push(`camera moves in ${Math.round(f.cameraFraction * 100)}% of the clip`); }
    if (f.shotCount >= 3 && f.duration < 90) { score.cutscene += 1; reasons.push(`${f.shotCount} shots (cuts)`); }
    if (f.subjectFraction >= 0.4 && f.cameraFraction < 0.25) { score.animation += f.flashiness >= 0.25 ? 1 : 3; reasons.push(`a subject moves in ${Math.round(f.subjectFraction * 100)}% of the clip while the camera holds`); }
    else if (f.subjectFraction >= 0.2) { score.animation += 1; score.gameplay += 1; }
    if (f.flashiness >= 0.25) { score.vfx += 3.5; reasons.push(`brightness / colour jumps in ${Math.round(f.flashiness * 100)}% of the frames (bursts, flashes)`); }
    else if (f.flashiness >= 0.1) { score.vfx += 1.5; reasons.push("some flashes"); }
    if (f.saturation >= 0.45 && f.flashiness >= 0.1) score.vfx += 1;
    if (overlay < 0.1 && f.avgMotion < 10 && f.cameraFraction < 0.45 && f.subjectFraction < 0.3 && f.shotCount <= 2 && !screenLike && f.flatness < 0.6) { score.map += 1.5; reasons.push("a slow look at a scene without HUD"); }
    if (overlay >= 0.1 && moving) score.gameplay += 1.5;
    if (f.loops) { score.animation += 1; score.vfx += f.flashiness >= 0.1 ? 1 : 0.5; reasons.push("first and last frames match (it loops)"); }
    let best = "gameplay", bs = -1, second = -1;
    for (const k of KIND_IDS) { if (score[k] > bs) { second = bs; bs = score[k]; best = k; } else if (score[k] > second) second = score[k]; }
    const total = Object.values(score).reduce((a, b) => a + b, 0) || 1;
    const confidence = bs <= 0 ? 0.2 : clamp(0.35 + (bs - Math.max(0, second)) / total, 0.2, 0.95);
    return { kind: best, confidence: Math.round(confidence * 100) / 100, scores: score, reasons: reasons.slice(0, 4) };
  }

  // One keyframe per shot (its most "settled" middle frame), then the frames most
  // different from everything already chosen, in time order.
  function pickKeyframes(samples, shots, n) {
    const want = clamp(n | 0 || 6, 1, 12);
    const chosen = [];
    if (want >= 3 && samples.length >= 3) chosen.push(0); // the opening frame always matters
    for (const sh of shots) {
      const mid = sh.start + Math.floor((sh.end - sh.start) / 2);
      if (!chosen.includes(mid)) chosen.push(mid);
      if (chosen.length >= want) break;
    }
    while (chosen.length < want && chosen.length < samples.length) {
      let bestI = -1, bestD = -1;
      for (let i = 0; i < samples.length; i++) {
        if (chosen.includes(i)) continue;
        let d = Infinity;
        for (const c of chosen) d = Math.min(d, frameDiff(samples[i], samples[c]) + 40 * histDiff(samples[i], samples[c]));
        if (d > bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0) break;
      chosen.push(bestI);
    }
    return chosen.sort((a, b) => a - b);
  }

  function analyze(samples, opts = {}) {
    samples = (samples || []).filter((s) => s && s.gray && s.w && s.h);
    const n = samples.length;
    const duration = opts.duration != null ? Number(opts.duration) : (n ? samples[n - 1].t : 0);
    if (!n) return { ok: false, error: "no frames", version: VERSION };
    const shots = detectShots(samples, opts);
    const motions = [], labels = [], diffs = [];
    for (let i = 1; i < n; i++) {
      const d = frameDiff(samples[i - 1], samples[i]);
      diffs.push(d);
      const inCut = shots.some((sh) => sh.start === i);
      const m = inCut ? null : blockMotion(samples[i - 1], samples[i], opts);
      motions.push(m);
      labels.push(inCut ? "cut" : cameraLabel(m, d));
    }
    const overlay = staticOverlay(samples, opts.cells || 6);
    // Flat panels with crisp edges (a screen) vs texture everywhere (a scene).
    let flat = 0; { const f0 = samples[0], w = f0.w, h = f0.h; let cnt = 0; for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { const i = y * w + x; cnt++; if (Math.abs(f0.gray[i] - f0.gray[i + 1]) + Math.abs(f0.gray[i] - f0.gray[i + w]) < 4) flat++; } flat = cnt ? flat / cnt : 0; }
    const pal = palette(samples, 5);
    const lums = samples.map((s) => s.lum == null ? 128 : s.lum), sats = samples.map((s) => s.sat == null ? 0 : s.sat);
    let flashes = 0;
    for (let i = 1; i < n; i++) {
      const cut = shots.some((sh) => sh.start === i);
      if (!cut && (Math.abs(lums[i] - lums[i - 1]) > 16 || Math.abs(sats[i] - sats[i - 1]) > 0.12)) flashes++;
    }
    const pairs = Math.max(1, n - 1);
    const camLabels = labels.filter((l) => /pan|tilt|zoom|handheld/.test(l)).length;
    const subj = labels.filter((l) => l === "subject motion").length;
    const features = {
      duration, shotCount: shots.length, avgMotion: Math.round(mean(diffs) * 10) / 10,
      cameraFraction: camLabels / pairs, subjectFraction: subj / pairs, hudFraction: overlay.fraction,
      flashiness: flashes / pairs, saturation: mean(sats), brightness: mean(lums) / 255, hudRegions: overlay.regions, flatness: Math.round(flat * 100) / 100,
      loops: n > 4 && mean(diffs) > 1 && frameDiff(samples[0], samples[n - 1]) < 8 && histDiff(samples[0], samples[n - 1]) < 0.1, // a frozen clip does not "loop"
    };
    const kind = classifyKind(features);
    const shotRows = shots.map((sh, idx) => {
      // labels[j] describes the move from sample j to j+1; runs of the same label
      // inside the shot become "static (0.0-3.0 s) → pan right (3.0-6.0 s)".
      const runs = [];
      for (let j = sh.start; j < sh.end; j++) {
        const l = labels[j] === "cut" ? "static" : labels[j];
        if (runs.length && runs[runs.length - 1].label === l) runs[runs.length - 1].to = j + 1;
        else runs.push({ label: l, from: j, to: j + 1 });
      }
      // Merge short runs (noise) into their bigger neighbour.
      const minRun = Math.max(2, Math.round((sh.end - sh.start) * 0.15));
      let merged = true;
      while (merged && runs.length > 1) {
        merged = false;
        for (let r = 0; r < runs.length; r++) {
          if (runs[r].to - runs[r].from >= minRun) continue;
          const left = runs[r - 1], right = runs[r + 1];
          const into = left && right ? ((left.to - left.from) >= (right.to - right.from) ? left : right) : (left || right);
          if (!into) break;
          if (into === left) left.to = runs[r].to; else right.from = runs[r].from;
          runs.splice(r, 1); merged = true; break;
        }
      }
      for (let r = runs.length - 1; r > 0; r--) if (runs[r].label === runs[r - 1].label) { runs[r - 1].to = runs[r].to; runs.splice(r, 1); }
      const camera = runs.length <= 1 ? (runs[0] ? runs[0].label : "static")
        : runs.map((r) => `${r.label} (${fmtT(samples[r.from].t)}-${fmtT(samples[Math.min(r.to, n - 1)].t)})`).join(" \u2192 ");
      const mot = mean(sh.diffs || []);
      const level = mot < 4 ? "still" : mot < 10 ? "slow" : mot < 22 ? "medium" : "fast";
      const lum = mean(lums.slice(sh.start, sh.end + 1)) / 255, sat = mean(sats.slice(sh.start, sh.end + 1));
      const look = `${lum < 0.3 ? "dark" : lum > 0.7 ? "bright" : "mid"}, ${sat < 0.15 ? "muted" : sat > 0.45 ? "vivid" : "balanced"}`;
      return { index: idx + 1, start: Math.round(samples[sh.start].t * 100) / 100, end: Math.round(samples[sh.end].t * 100) / 100, startIdx: sh.start, endIdx: sh.end, camera, level, motion: Math.round(mot * 10) / 10, look, lum: Math.round(lum * 100) / 100, sat: Math.round(sat * 100) / 100 };
    });
    // The last shot runs to the clip's end, not to its last sample.
    if (shotRows.length) shotRows[shotRows.length - 1].end = Math.max(shotRows[shotRows.length - 1].end, duration);
    const keyIdx = pickKeyframes(samples, shots, opts.keyframes || 6);
    return {
      ok: true, version: VERSION, duration: Math.round(duration * 100) / 100, samples: n, sampleFps: n > 1 && duration ? Math.round(((n - 1) / duration) * 10) / 10 : 0,
      shots: shotRows, labels, features, kind, palette: pal, overlay: { fraction: Math.round(overlay.fraction * 100) / 100, regions: overlay.regions },
      keyframes: keyIdx.map((i) => ({ index: i, t: Math.round(samples[i].t * 100) / 100, shot: shotRows.findIndex((s) => i >= s.startIdx && i <= s.endIdx) + 1 })),
      motionCurve: diffs.map((d) => Math.round(d)),
    };
  }

  // ───────────────────────── brief ─────────────────────────
  const PROTOCOL = {
    cutscene: (a) => [
      `cutscene_create {name} once, then ONE cutscene_shot_add per shot below with the SAME duration (±10%) and the camera move named in the row (pan → move the camera position sideways while look_at stays; tilt → raise / lower the look target; zoom in/out → change fov or dolly; static → hold; handheld → small noise on position; cut → a new shot with no blend).`,
      `Frame each shot like its keyframe (what is in the centre, how high the horizon sits, how close the subject is). Use ${a.shots.length} shot(s); keep their order.`,
      `Then cutscene_preview, take screen_capture at the shot midpoints and compare against the keyframes; fix framing before reporting.`,
    ],
    animation: (a) => [
      `Pick / create the rig (animation_select_rig or the selection), then animation_create {name, length: ${a.duration}} and animation_add_keyframe at the shot boundaries and at every keyframe time listed below - the pose at each keyframe image is the pose to hit at that time (read limbs, lean, head direction from the frame).`,
      `Motion level per shot sets the easing: still/slow → Sine, medium → Quad, fast → Back/Bounce or Linear for hits. ${a.features.loops ? "The clip loops: make the last pose equal the first and set it looping." : "It does not loop - end on the final pose."}`,
      `animation_preview, then animation_test; compare the extremes against keyframes B+ and retime with animation_retime until the beats land at the listed seconds.`,
    ],
    gui: (a) => [
      `This is a screen. Follow the GUI protocol: ui_art_theme_set first (palette below - pick the look: hollow / dark_fantasy / arcane / scifi / cartoon / horror / royal / minimal_lux / pixel - and the typeface you can read in the frames), then ONE ui_art_build {spec} for a title / menu / pause screen or ONE ui_build_spec {spec, replace:true} for a HUD / panel, cloning the layout of keyframe B: positions as fractions of the frame, exact text as read, same button order.`,
      `Static overlay regions (${a.overlay.regions.join(", ") || "none detected"}) are the HUD elements - keep them where they are. Anything that animates between keyframes (slides, pulses, fades) becomes ui_tween / ui_text_fx / ui_decor_add particles with the same timing as the shot rows.`,
      `screen_capture after building and compare against the contact sheet; quality_audit {path} ≥ 85.`,
    ],
    vfx: (a) => [
      `Build the effect with fx_create_vfx / fx_create_emitter / fx_burst / fx_create_beam / fx_light_rig (+ light_pulse, fx_shockwave, fx_ring, fx_dissolve as they match the frames), colours from the palette, timing from the shot rows: each brightness jump is an emission burst or a light pulse at that second.`,
      `${a.features.loops ? "The clip loops - make the emitters continuous." : "It plays once - script a single sequence with task.wait() at the listed seconds."} Keep particle sizes relative to the frame as seen in the keyframes.`,
      `screen_capture at the brightest moment and compare against the matching keyframe.`,
    ],
    map: (a) => [
      `Rebuild the place seen in the keyframes: block out the big shapes first (model_build / model_wall / terrain_fill_region / terrain_paint), match the layout and proportions of keyframe B, then materials and colours from the palette, then lighting (lighting_set_preset / style_lighting_apply: the clip reads ${a.features.brightness < 0.35 ? "dark" : a.features.brightness > 0.7 ? "bright" : "mid"}, ${a.features.saturation > 0.45 ? "vivid" : a.features.saturation < 0.15 ? "muted" : "balanced"}).`,
      `Use camera_look_at + screen_capture from the same angle as each keyframe to compare and correct.`,
    ],
    gameplay: (a) => [
      `Recreate the MECHANIC, not pixels: describe in one line what the player does between the keyframes, then build it (scripts via execute_luau / the matching commands), plus the HUD you can see in the static overlay regions (${a.overlay.regions.join(", ") || "none"}) as a small ui_build_spec.`,
      `Timing from the shot rows (how long each phase lasts). After building, test it (animation_test / sound / screen_capture) and compare one moment against the matching keyframe.`,
    ],
  };
  function kindExplain(kind) {
    const k = KINDS[kind] || KINDS.gameplay;
    return `${kind.toUpperCase()} - ${k.label} (${k.hint})`;
  }
  function buildMessage(a, opts = {}) {
    if (!a || !a.ok) return "";
    const kind = KIND_IDS.includes(opts.kind) ? opts.kind : a.kind.kind;
    const over = kind !== a.kind.kind;
    const sheet = opts.contactSheet !== false;
    const frames = Array.isArray(opts.frames) ? opts.frames : a.keyframes;
    const letters = "ABCDEFGHIJKLMNOP";
    const imgLines = [];
    let li = 0;
    if (sheet) { imgLines.push(`${letters[li]} = contact sheet: ${frames.length} keyframes in a grid, timestamp burnt into each cell (read it left→right, top→bottom)`); li++; }
    if (opts.individual !== false) for (const f of frames) { if (li >= letters.length) break; imgLines.push(`${letters[li]} = keyframe at ${fmtT(f.t)} (shot ${f.shot || "?"})`); li++; }
    const imagesNote = opts.imagesAttached === false
      ? "No images could be attached on this site - work from the timeline and the user's description; ask ONE question if a detail is missing."
      : `${li} image(s) attached, in this order:\n` + imgLines.map((l) => "  " + l).join("\n");
    const shotRows = a.shots.map((s) => `  ${s.index}. ${fmtT(s.start)} - ${fmtT(s.end)} \u00b7 camera: ${s.camera} \u00b7 motion: ${s.level} \u00b7 look: ${s.look}`);
    const pal = a.palette.map((p) => `${p.hex} ${p.share}%`).join(", ");
    const out = [];
    out.push(`${BRIEF_MARK} - the user attached a video (analysed in the browser by TotalScript Video Studio ${VERSION}) and wants the ${opts.exact === false ? "same idea" : "same thing"} recreated in ${opts.engine === "local" ? "the local project" : "Roblox Studio"}.`);
    out.push(`CLIP: ${opts.name ? `"${opts.name}", ` : ""}${fmtT(a.duration)}${opts.width && opts.height ? `, ${opts.width}x${opts.height}` : ""}, ${a.shots.length} shot(s), ${a.samples} frames sampled at ~${a.sampleFps}/s.`);
    out.push(`KIND: ${kindExplain(kind)}${over ? ` - chosen by the user (the analysis guessed ${a.kind.kind}, ${Math.round(a.kind.confidence * 100)}%)` : ` - detected, ${Math.round(a.kind.confidence * 100)}% confidence${a.kind.reasons.length ? ": " + a.kind.reasons.join("; ") : ""}`}.`);
    if (opts.goal && String(opts.goal).trim()) out.push(`THE USER SAYS: ${String(opts.goal).trim()}`);
    out.push(`PALETTE (by area): ${pal || "n/a"}. Overall ${a.features.brightness < 0.35 ? "dark" : a.features.brightness > 0.7 ? "bright" : "mid-tone"}, ${a.features.saturation > 0.45 ? "vivid" : a.features.saturation < 0.15 ? "muted / monochrome" : "balanced"} colours.`);
    out.push(`STATIC OVERLAY: ${a.overlay.fraction > 0 ? `${Math.round(a.overlay.fraction * 100)}% of the frame never changes but carries detail (${a.overlay.regions.join(", ")}) - that is UI / a logo / a frame, not the scene` : "none - nothing stays fixed on screen"}.${a.features.loops ? " The clip LOOPS (first and last frames match)." : ""}`);
    out.push(`TIMELINE (shot \u00b7 time range \u00b7 camera \u00b7 motion \u00b7 look):\n${shotRows.join("\n")}`);
    out.push(`IMAGES: ${imagesNote}`);
    out.push(`RECREATION PROTOCOL (${kind}):\n` + PROTOCOL[kind](a).map((l, i) => `  ${i + 1}. ${l}`).join("\n"));
    out.push(`RULES: ${opts.exact === false ? "Keep the idea, timing and mood; you may simplify shapes." : "CLONE, do not approximate: same order, same timings (±10%), same colours and framing as the keyframes; read any text in the frames literally."} First reply = a 3-6 line plan mapping each shot / keyframe to the commands you will run, then start with the first command in the SAME reply. One command per reply afterwards. When done, say honestly what differs from the video.`);
    return out.join("\n");
  }

  // ───────────────────────── browser: decode + render ─────────────────────────
  const THUMB_W = 160;
  function sampleFromCanvasData(data, w, h, t) {
    const gray = new Uint8Array(w * h), hist = new Array(64).fill(0);
    let lum = 0, sat = 0;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const y = (r * 299 + g * 587 + b * 114) / 1000;
      gray[i] = y; lum += y;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx ? (mx - mn) / mx : 0;
      hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    }
    return { t, w, h, gray, hist, lum: lum / (w * h), sat: sat / (w * h) };
  }
  function seekTo(video, t) {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; video.removeEventListener("seeked", fin); res(); };
      video.addEventListener("seeked", fin, { once: true });
      try { video.currentTime = t; } catch { fin(); }
      setTimeout(fin, 1500);
    });
  }
  async function decodeFile(file, opts = {}) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = url;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("the browser could not read this video (unsupported codec?) - try an mp4 (H.264) or webm")), 20000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(t); res(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(t); rej(new Error("the browser could not decode this file - try an mp4 (H.264) or webm")); }, { once: true });
    });
    let duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      // WebM from MediaRecorder reports Infinity until seeked to the end.
      await seekTo(video, 1e6); duration = video.duration; await seekTo(video, 0);
      if (!isFinite(duration) || duration <= 0) duration = 10;
    }
    const maxSamples = opts.maxSamples || 180;
    const fps = clamp(opts.sampleFps || (duration <= 15 ? 4 : duration <= 60 ? 2 : 1), 0.25, 8);
    const count = clamp(Math.ceil(duration * fps) + 1, 2, maxSamples);
    const step = duration / Math.max(1, count - 1);
    const vw = video.videoWidth || 640, vh = video.videoHeight || 360;
    const tw = THUMB_W, th = Math.max(16, Math.round((tw * vh) / vw));
    const c = document.createElement("canvas"); c.width = tw; c.height = th;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const samples = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 0.001, i * step);
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, tw, th);
      let data;
      try { data = ctx.getImageData(0, 0, tw, th).data; } catch (e) { URL.revokeObjectURL(url); throw new Error("the video is tainted (cross-origin) - use a local file"); }
      samples.push(sampleFromCanvasData(data, tw, th, t));
      if (opts.onProgress) { try { opts.onProgress(i + 1, count); } catch {} }
    }
    const captureAt = async (t, maxW = 1024, quality = 0.86) => {
      await seekTo(video, Math.min(duration - 0.001, Math.max(0, t)));
      const scale = Math.min(1, maxW / vw);
      const cc = document.createElement("canvas"); cc.width = Math.round(vw * scale); cc.height = Math.round(vh * scale);
      cc.getContext("2d").drawImage(video, 0, 0, cc.width, cc.height);
      return cc;
    };
    const dispose = () => { try { video.pause(); video.removeAttribute("src"); video.load(); } catch {} URL.revokeObjectURL(url); };
    return { samples, duration, width: vw, height: vh, captureAt, dispose, video };
  }
  function canvasToImage(canvas, quality = 0.86) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    return { mimeType: "image/jpeg", data: dataUrl.split(",")[1], dataUrl };
  }
  function contactSheet(frames, opts = {}) {
    const cols = opts.cols || (frames.length <= 4 ? 2 : frames.length <= 9 ? 3 : 4);
    const rows = Math.ceil(frames.length / cols);
    const cw = opts.cellW || 480, ch = Math.round((cw * (frames[0] && frames[0].canvas ? frames[0].canvas.height / frames[0].canvas.width : 9 / 16)));
    const pad = 6, label = 22;
    const c = document.createElement("canvas"); c.width = cols * (cw + pad) + pad; c.height = rows * (ch + label + pad) + pad;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, c.width, c.height);
    frames.forEach((f, i) => {
      const x = pad + (i % cols) * (cw + pad), y = pad + Math.floor(i / cols) * (ch + label + pad);
      ctx.drawImage(f.canvas, x, y, cw, ch);
      ctx.fillStyle = "rgba(0,0,0,.72)"; ctx.fillRect(x, y + ch, cw, label);
      ctx.fillStyle = "#e8f6ff"; ctx.font = "bold 14px system-ui, sans-serif"; ctx.textBaseline = "middle";
      ctx.fillText(`${String.fromCharCode(66 + i)}  t = ${fmtT(f.t)}  shot ${f.shot || "?"}`, x + 8, y + ch + label / 2);
    });
    return c;
  }

  // ───────────────────────── UI ─────────────────────────
  const S = { open: false, hooks: null, file: null, decoded: null, analysis: null, kind: "", goal: "", exact: true, nKeys: 6, sheet: true, individual: true, selected: null, busy: false };
  let D = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (m) => { try { S.hooks && S.hooks.toast && S.hooks.toast(m); } catch {} };
  const diag = (ev, d) => { try { S.hooks && S.hooks.diag && S.hooks.diag("video." + ev, d); } catch {} };
  const logoUrl = () => { try { return chrome.runtime.getURL("assets/icon128.png"); } catch { return ""; } };

  function build() {
    const host = document.createElement("div"); host.id = "rs-video"; host.setAttribute("role", "dialog"); host.setAttribute("aria-label", "TotalScript Video Studio");
    const kindOpts = KIND_IDS.map((k) => `<option value="${k}">${esc(KINDS[k].label)}</option>`).join("");
    host.innerHTML = `
      <div class="rsv-shell">
        <div class="rsv-title">
          <span class="rsv-brand"><img class="rsv-logo" alt="" src="${esc(logoUrl())}"><b>Video Studio</b></span>
          <span class="rsv-sub">Show it a video \u2192 the AI builds something similar</span>
          <button type="button" class="rsv-ib rsv-close" data-act="close" title="Close (Esc)">\u2715</button>
        </div>
        <div class="rsv-body">
          <div class="rsv-left">
            <label class="rsv-drop" data-drop>
              <input type="file" accept="video/*,.gif,.mp4,.webm,.mov,.m4v,.mkv" hidden data-file>
              <div class="rsv-drop-inner">
                <div class="rsv-drop-ico">\u25B6</div>
                <div class="rsv-drop-t">Drop a video here or click to choose</div>
                <div class="rsv-drop-s">mp4 \u00b7 webm \u00b7 mov \u00b7 gif \u2014 decoded in your browser, never uploaded by TotalScript</div>
              </div>
            </label>
            <div class="rsv-preview" hidden>
              <video class="rsv-video" controls muted playsinline></video>
              <div class="rsv-meta" data-meta></div>
            </div>
            <div class="rsv-progress" hidden><div class="rsv-bar"><i></i></div><span data-ptext>Reading frames\u2026</span></div>
            <div class="rsv-keys" data-keys hidden></div>
          </div>
          <div class="rsv-right">
            <div class="rsv-sec"><div class="rsv-h">What is in the video</div>
              <div class="rsv-kind" data-kindbox>Analyse a video first.</div>
              <label class="rsv-row">Recreate as <select data-kind><option value="">Auto (detected)</option>${kindOpts}</select></label>
              <label class="rsv-row rsv-col">What exactly do you want? <span class="rsv-muted">(optional)</span>
                <textarea data-goal rows="3" placeholder="e.g. the pause menu at 0:04, the sword swing, the camera move around the castle\u2026"></textarea></label>
              <label class="rsv-chk"><input type="checkbox" data-exact checked> Clone it as exactly as possible (uncheck: same idea, simplified)</label>
            </div>
            <div class="rsv-sec"><div class="rsv-h">What the AI receives</div>
              <label class="rsv-row">Keyframes <input type="range" min="2" max="8" value="6" data-nkeys> <b data-nkeysv>6</b></label>
              <label class="rsv-chk"><input type="checkbox" data-sheet checked> Contact sheet (one grid image with timestamps)</label>
              <label class="rsv-chk"><input type="checkbox" data-individual checked> Individual keyframes as separate images</label>
              <div class="rsv-muted" data-sitenote></div>
            </div>
            <div class="rsv-sec"><div class="rsv-h">Timeline</div><div class="rsv-timeline" data-timeline>\u2014</div></div>
            <div class="rsv-actions">
              <button type="button" class="rsv-btn" data-act="analyse" disabled>Analyse</button>
              <button type="button" class="rsv-btn rsv-primary" data-act="send" disabled>Send to the AI</button>
              <span class="rsv-status" data-status></span>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);
    D = {
      host, drop: host.querySelector("[data-drop]"), file: host.querySelector("[data-file]"), preview: host.querySelector(".rsv-preview"), video: host.querySelector(".rsv-video"),
      meta: host.querySelector("[data-meta]"), progress: host.querySelector(".rsv-progress"), bar: host.querySelector(".rsv-bar i"), ptext: host.querySelector("[data-ptext]"),
      keys: host.querySelector("[data-keys]"), kindbox: host.querySelector("[data-kindbox]"), kind: host.querySelector("[data-kind]"), goal: host.querySelector("[data-goal]"),
      exact: host.querySelector("[data-exact]"), nkeys: host.querySelector("[data-nkeys]"), nkeysv: host.querySelector("[data-nkeysv]"), sheet: host.querySelector("[data-sheet]"),
      individual: host.querySelector("[data-individual]"), sitenote: host.querySelector("[data-sitenote]"), timeline: host.querySelector("[data-timeline]"),
      analyse: host.querySelector('[data-act="analyse"]'), send: host.querySelector('[data-act="send"]'), status: host.querySelector("[data-status]"),
    };
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.getAttribute("data-act");
      if (act === "close") close();
      else if (act === "analyse") runAnalysis();
      else if (act === "send") sendToAI();
    });
    host.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    D.file.addEventListener("change", () => { if (D.file.files && D.file.files[0]) loadFile(D.file.files[0]); });
    ["dragenter", "dragover"].forEach((ev) => D.drop.addEventListener(ev, (e) => { e.preventDefault(); D.drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => D.drop.addEventListener(ev, (e) => { e.preventDefault(); D.drop.classList.remove("over"); }));
    D.drop.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
    D.kind.addEventListener("change", () => { S.kind = D.kind.value; renderKind(); });
    D.goal.addEventListener("input", () => { S.goal = D.goal.value; });
    D.exact.addEventListener("change", () => { S.exact = D.exact.checked; });
    D.nkeys.addEventListener("input", () => { S.nKeys = Number(D.nkeys.value) || 6; D.nkeysv.textContent = String(S.nKeys); if (S.analysis) reKey(); });
    D.sheet.addEventListener("change", () => { S.sheet = D.sheet.checked; });
    D.individual.addEventListener("change", () => { S.individual = D.individual.checked; });
    D.keys.addEventListener("click", (e) => { const k = e.target.closest("[data-ki]"); if (!k) return; const i = Number(k.getAttribute("data-ki")); if (S.selected.has(i)) { if (S.selected.size > 1) S.selected.delete(i); } else S.selected.add(i); renderKeys(); });
  }
  const setStatus = (m) => { if (D) D.status.textContent = m || ""; };
  function siteNote() {
    if (!D || !S.hooks) return;
    const can = (() => { try { return S.hooks.canAttachImages ? !!S.hooks.canAttachImages() : true; } catch { return true; } })();
    const max = (() => { try { return S.hooks.maxImages ? Number(S.hooks.maxImages()) || 0 : 0; } catch { return 0; } })();
    D.sitenote.textContent = !can ? "This site does not accept images here - the AI gets the timeline + your description only." : max ? `This site accepts about ${max} image(s) per message - extras are dropped from the end.` : "Images are attached as JPEGs (contact sheet first).";
  }
  async function loadFile(file) {
    if (!file) return;
    if (S.decoded) { try { S.decoded.dispose(); } catch {} S.decoded = null; }
    S.file = file; S.analysis = null; S.selected = null;
    D.preview.hidden = false; D.keys.hidden = true; D.send.disabled = true; D.timeline.textContent = "\u2014"; D.kindbox.textContent = "Analysing\u2026";
    try { D.video.src = URL.createObjectURL(file); } catch {}
    D.meta.textContent = `${file.name} \u00b7 ${(file.size / 1048576).toFixed(1)} MB`;
    D.analyse.disabled = false;
    diag("file", { name: file.name, size: file.size, type: file.type });
    runAnalysis();
  }
  async function runAnalysis() {
    if (!S.file || S.busy) return;
    S.busy = true; D.analyse.disabled = true; D.progress.hidden = false; D.bar.style.width = "0%"; setStatus("");
    try {
      if (S.decoded) { try { S.decoded.dispose(); } catch {} }
      S.decoded = await decodeFile(S.file, { onProgress: (i, n) => { D.bar.style.width = Math.round((i / n) * 100) + "%"; D.ptext.textContent = `Reading frames\u2026 ${i}/${n}`; } });
      D.ptext.textContent = "Detecting shots, motion and layout\u2026";
      await new Promise((r) => setTimeout(r, 10));
      S.analysis = analyze(S.decoded.samples, { duration: S.decoded.duration, keyframes: S.nKeys });
      if (!S.analysis.ok) throw new Error(S.analysis.error || "analysis failed");
      D.meta.textContent = `${S.file.name} \u00b7 ${fmtT(S.decoded.duration)} \u00b7 ${S.decoded.width}x${S.decoded.height} \u00b7 ${S.analysis.shots.length} shot(s)`;
      S.selected = new Set(S.analysis.keyframes.map((k) => k.index));
      await renderKeysWithFrames();
      renderKind(); renderTimeline();
      D.send.disabled = false;
      diag("analysed", { duration: S.analysis.duration, shots: S.analysis.shots.length, kind: S.analysis.kind.kind, conf: S.analysis.kind.confidence });
    } catch (e) {
      D.kindbox.textContent = "Could not analyse: " + (e && e.message || e);
      diag("error", { err: String(e && e.message || e).slice(0, 200) });
    } finally {
      S.busy = false; D.progress.hidden = true; D.analyse.disabled = !S.file;
    }
  }
  function reKey() {
    if (!S.analysis || !S.decoded) return;
    const shots = S.analysis.shots.map((s) => ({ start: s.startIdx, end: s.endIdx }));
    const idx = pickKeyframes(S.decoded.samples, shots, S.nKeys);
    S.analysis.keyframes = idx.map((i) => ({ index: i, t: Math.round(S.decoded.samples[i].t * 100) / 100, shot: S.analysis.shots.findIndex((s) => i >= s.startIdx && i <= s.endIdx) + 1 }));
    S.selected = new Set(idx);
    renderKeysWithFrames();
  }
  async function renderKeysWithFrames() {
    S.thumbs = new Map();
    for (const k of S.analysis.keyframes) {
      try { const c = await S.decoded.captureAt(k.t, 320); S.thumbs.set(k.index, c.toDataURL("image/jpeg", 0.7)); } catch {}
    }
    renderKeys();
  }
  function renderKeys() {
    if (!D || !S.analysis) return;
    D.keys.hidden = false;
    D.keys.innerHTML = `<div class="rsv-h">Keyframes <span class="rsv-muted">(click to include / exclude)</span></div><div class="rsv-keygrid">` +
      S.analysis.keyframes.map((k) => `<button type="button" class="rsv-key${S.selected.has(k.index) ? " on" : ""}" data-ki="${k.index}" title="t = ${fmtT(k.t)}, shot ${k.shot}"><img alt="" src="${S.thumbs && S.thumbs.get(k.index) || ""}"><span>${fmtT(k.t)} \u00b7 shot ${k.shot}</span></button>`).join("") + `</div>`;
  }
  function renderKind() {
    if (!D || !S.analysis) return;
    const a = S.analysis, k = S.kind || a.kind.kind;
    D.kindbox.innerHTML = `<b>${esc(KINDS[k].label)}</b> ${S.kind ? '<span class="rsv-muted">(your choice)</span>' : `<span class="rsv-muted">detected \u00b7 ${Math.round(a.kind.confidence * 100)}%</span>`}<div class="rsv-muted">${esc(a.kind.reasons.join(" \u00b7 ") || KINDS[k].hint)}</div>` +
      `<div class="rsv-pal">${a.palette.map((p) => `<i style="background:${p.hex}" title="${p.hex} ${p.share}%"></i>`).join("")}</div>`;
  }
  function renderTimeline() {
    if (!D || !S.analysis) return;
    D.timeline.innerHTML = S.analysis.shots.map((s) => `<div class="rsv-shot"><b>${s.index}</b> ${fmtT(s.start)} \u2013 ${fmtT(s.end)} <span>${esc(s.camera)}</span> <span>${esc(s.level)}</span> <span>${esc(s.look)}</span></div>`).join("") +
      (S.analysis.overlay.fraction ? `<div class="rsv-muted">Static overlay ${Math.round(S.analysis.overlay.fraction * 100)}% (${esc(S.analysis.overlay.regions.join(", "))})</div>` : "") +
      (S.analysis.features.loops ? `<div class="rsv-muted">Loops</div>` : "");
  }
  async function prepareImages() {
    const sel = S.analysis.keyframes.filter((k) => S.selected.has(k.index));
    const frames = [];
    for (const k of sel) frames.push({ t: k.t, shot: k.shot, canvas: await S.decoded.captureAt(k.t, 1024) });
    const images = [];
    if (S.sheet && frames.length) images.push(canvasToImage(contactSheet(frames)));
    if (S.individual) for (const f of frames) images.push(canvasToImage(f.canvas));
    let max = 0; try { max = S.hooks.maxImages ? Number(S.hooks.maxImages()) || 0 : 0; } catch {}
    return { frames: sel, images: max ? images.slice(0, max) : images };
  }
  async function sendToAI() {
    if (!S.analysis || !S.decoded || S.busy) return;
    if (!S.hooks || !S.hooks.send) { toast("Sending is not wired on this page"); return; }
    S.busy = true; D.send.disabled = true; setStatus("Preparing frames\u2026");
    try {
      const { frames, images } = await prepareImages();
      let can = true; try { can = S.hooks.canAttachImages ? !!S.hooks.canAttachImages() : true; } catch {}
      const engine = (() => { try { return S.hooks.engine ? S.hooks.engine() : "roblox"; } catch { return "roblox"; } })();
      const text = buildMessage(S.analysis, { kind: S.kind, goal: S.goal, exact: S.exact, frames, contactSheet: S.sheet, individual: S.individual, imagesAttached: can && images.length > 0, name: S.file && S.file.name, width: S.decoded.width, height: S.decoded.height, engine });
      diag("send", { chars: text.length, images: images.length, kind: S.kind || S.analysis.kind.kind });
      const ok = await S.hooks.send(text, can ? images : null, setStatus);
      if (ok) { setStatus("Sent - the AI is reading the video brief. Closing\u2026"); setTimeout(() => close(), 900); }
      else setStatus("The chat did not accept the message. Try again.");
    } catch (e) { setStatus("Send failed: " + (e && e.message || e)); diag("send.err", { e: String(e).slice(0, 200) }); }
    finally { S.busy = false; D.send.disabled = false; }
  }
  function open(hooks) {
    S.hooks = hooks || S.hooks || {};
    if (!D) build();
    S.open = true; D.host.classList.add("open"); document.documentElement.classList.add("rs-video-open");
    siteNote();
    setTimeout(() => { try { (D.file.closest("label") || D.host).focus(); } catch {} }, 20);
    diag("open", {});
  }
  function close() {
    if (!D) return;
    S.open = false; D.host.classList.remove("open"); document.documentElement.classList.remove("rs-video-open");
    try { D.video.pause(); } catch {}
  }
  const isOpen = () => S.open;

  window.TotalVideoStudio = {
    VERSION, KINDS, KIND_IDS, CAMERA_LABELS, BRIEF_MARK,
    open, close, isOpen,
    analyze, detectShots, blockMotion, cameraLabel, staticOverlay, classifyKind, pickKeyframes, palette, frameDiff, histDiff,
    buildMessage, sampleFromCanvasData, contactSheet, decodeFile,
    _state: S,
  };
})();
