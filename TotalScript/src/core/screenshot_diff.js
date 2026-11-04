// TotalScript — screenshot_compare (2.8.0)
//
// Visual verification used to be "take total_screenshot and judge it". A model
// looking at one picture cannot tell whether its change did anything: the
// camera may be pointing elsewhere, the GUI may be disabled, the tween may
// have finished before the capture. This module keeps the last few captures
// and measures the pixel delta between two of them:
//
//   total_screenshot {compare:true}         -> appends CHANGE / NO VISIBLE CHANGE
//   screenshot_compare {before, after}      -> explicit pair by label / id
//
// The diff core is pure arithmetic on RGBA arrays (testable in Node); image
// decoding (createImageBitmap + OffscreenCanvas) is injectable so tests and
// non-browser hosts can supply their own decoder.
//
// Honest scope: this is a pixel delta, not scene understanding. It answers
// "did the picture change, how much and where" - the model still has to look
// at the image to judge WHAT changed.
(function () {
  "use strict";
  const MAX_KEPT = 8;        // captures kept in memory (base64 strings - a few MB at most)
  const MAX_WIDTH = 256;     // diff resolution; 256 px wide keeps a compare < 5 ms
  const SAME_PCT = 0.5;      // below this fraction of changed pixels = "nothing changed"
  const DEFAULT_THRESHOLD = 24; // per-channel delta (0-255) that counts as a changed pixel
  const CELLS = 6;           // CELLS x CELLS heat grid

  const ring = [];
  let seq = 0;
  let decoder = null;

  // ── capture memory ──────────────────────────────────────────────────────
  function remember(image, label) {
    if (!image || !image.data) return null;
    const entry = {
      id: ++seq,
      at: Date.now(),
      label: String(label || "").trim().slice(0, 60),
      mimeType: String(image.mimeType || "image/png"),
      data: String(image.data),
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      _decoded: null,
    };
    ring.push(entry);
    while (ring.length > MAX_KEPT) ring.shift();
    return publicEntry(entry);
  }
  function publicEntry(e) { return e ? { id: e.id, at: e.at, label: e.label, mimeType: e.mimeType, bytes: e.data.length } : null; }
  function list() { return ring.map(publicEntry); }
  function latest(offset) { const i = ring.length - 1 - (Number(offset) || 0); return i >= 0 ? publicEntry(ring[i]) : null; }
  function clear() { ring.length = 0; }

  // "last" | "now" | "prev" | "previous" | "#3" | 3 | "<label>"
  function resolve(ref, fallbackOffset) {
    if (!ring.length) return null;
    if (ref === undefined || ref === null || ref === "") return ring[Math.max(0, ring.length - 1 - (fallbackOffset || 0))] || null;
    if (typeof ref === "object" && ref && ref.id) ref = ref.id;
    const s = String(ref).trim();
    // an exact label wins over the keywords ("before" / "after" are the
    // natural labels to give total_screenshot)
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].label && ring[i].label.toLowerCase() === s.toLowerCase()) return ring[i];
    if (/^(last|now|latest|after|current)$/i.test(s)) return ring[ring.length - 1];
    if (/^(prev|previous|before)$/i.test(s)) return ring.length >= 2 ? ring[ring.length - 2] : null;
    const m = s.match(/^#?(\d+)$/);
    if (m) return ring.find((e) => e.id === Number(m[1])) || null;
    const low = s.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].label.toLowerCase() === low) return ring[i];
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].label.toLowerCase().includes(low)) return ring[i];
    return null;
  }

  // ── decoding ────────────────────────────────────────────────────────────
  function setDecoder(fn) { decoder = typeof fn === "function" ? fn : null; }
  function base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/^data:[^,]*,/, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function browserDecode(mimeType, b64) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") throw new Error("no image decoder in this host (createImageBitmap / OffscreenCanvas missing)");
    const blob = new Blob([base64ToBytes(b64)], { type: mimeType || "image/png" });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_WIDTH / Math.max(1, bmp.width));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext("2d");
    g.drawImage(bmp, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    try { bmp.close && bmp.close(); } catch {}
    return { width: w, height: h, data: img.data, sourceWidth: bmp.width, sourceHeight: bmp.height };
  }
  async function decode(entry) {
    if (entry._decoded) return entry._decoded;
    const fn = decoder || browserDecode;
    const img = await fn(entry.mimeType, entry.data);
    if (!img || !img.data || !img.width || !img.height) throw new Error("decoder returned no pixels");
    entry._decoded = downsample(img, MAX_WIDTH);
    return entry._decoded;
  }

  // ── pure pixel maths ────────────────────────────────────────────────────
  function downsample(img, maxW) {
    if (img.width <= maxW) return img;
    const scale = maxW / img.width;
    const w = maxW, h = Math.max(1, Math.round(img.height * scale));
    return resample(img, w, h);
  }
  function resample(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, Math.floor(y * img.height / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor(x * img.width / w));
        const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
      }
    }
    return { width: w, height: h, data: out, sourceWidth: img.sourceWidth || img.width, sourceHeight: img.sourceHeight || img.height };
  }
  const ROW_NAMES = ["top", "top", "middle", "middle", "bottom", "bottom"];
  const COL_NAMES = ["left", "left", "center", "center", "right", "right"];
  function regionName(row, col) {
    const r = ROW_NAMES[Math.min(5, Math.floor(row * 6 / CELLS))], c = COL_NAMES[Math.min(5, Math.floor(col * 6 / CELLS))];
    if (r === "middle" && c === "center") return "center";
    if (r === "middle") return c;
    if (c === "center") return r;
    return r + "-" + c;
  }
  // diff(a, b) -> metrics. a / b = {width, height, data(RGBA)}.
  function diff(a, b, opts) {
    opts = opts || {};
    const threshold = Math.max(1, Math.min(255, Number(opts.threshold) || DEFAULT_THRESHOLD));
    if (!a || !b || !a.data || !b.data) throw new Error("diff needs two decoded images");
    let sizeMismatch = false;
    if (a.width !== b.width || a.height !== b.height) { sizeMismatch = true; b = resample(b, a.width, a.height); }
    const w = a.width, h = a.height, n = w * h;
    const cells = new Array(CELLS * CELLS).fill(0), cellTotals = new Array(CELLS * CELLS).fill(0);
    let changed = 0, sumDelta = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const cy = Math.min(CELLS - 1, Math.floor(y * CELLS / h));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        sumDelta += d;
        const cell = cy * CELLS + Math.min(CELLS - 1, Math.floor(x * CELLS / w));
        cellTotals[cell]++;
        if (d > threshold) {
          changed++; cells[cell]++;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const pct = (v, t) => Math.round(v / Math.max(1, t) * 1000) / 10;
    const changedPct = pct(changed, n);
    const grid = [];
    for (let r = 0; r < CELLS; r++) { const row = []; for (let c = 0; c < CELLS; c++) row.push(pct(cells[r * CELLS + c], cellTotals[r * CELLS + c])); grid.push(row); }
    const hot = [];
    for (let r = 0; r < CELLS; r++) for (let c = 0; c < CELLS; c++) { const v = grid[r][c]; if (v >= 5 && v >= changedPct * 1.5) hot.push({ region: regionName(r, c), row: r, col: c, pct: v }); }
    hot.sort((x, y) => y.pct - x.pct);
    const regions = [...new Set(hot.map((x) => x.region))].slice(0, 4);
    return {
      width: w, height: h, threshold, size_mismatch: sizeMismatch,
      changed_pct: changedPct, mean_delta: Math.round(sumDelta / Math.max(1, n) * 10) / 10,
      same: changedPct < SAME_PCT,
      bbox: maxX < 0 ? null : { x: pct(minX, w), y: pct(minY, h), w: pct(maxX - minX + 1, w), h: pct(maxY - minY + 1, h) },
      grid, hot_regions: regions,
    };
  }
  function describe(d, beforeEntry, afterEntry) {
    const tag = (e) => e ? `#${e.id}${e.label ? " " + JSON.stringify(e.label) : ""}` : "?";
    const pair = `${tag(beforeEntry)} -> ${tag(afterEntry)}`;
    if (d.same) {
      return `NO VISIBLE CHANGE between captures ${pair}: ${d.changed_pct}% of pixels differ (threshold ${d.threshold}/255, mean delta ${d.mean_delta}). ` +
        "Your change is NOT visible from this camera / in this capture. Before polishing anything: check the instance path you edited, whether the GUI / effect is Enabled, whether the camera is looking at it (camera_focus / ui_preview), and whether the effect finished before the capture. Do not claim the look changed.";
    }
    const box = d.bbox ? `, changed area x ${d.bbox.x}% y ${d.bbox.y}% (${d.bbox.w}% x ${d.bbox.h}% of the frame)` : "";
    const where = d.hot_regions.length ? `, concentrated at: ${d.hot_regions.join(", ")}` : ", spread across the frame";
    const scale = d.changed_pct >= 60 ? "ALMOST EVERYTHING changed (camera moved, lighting / time of day changed, or a full-screen GUI opened - if you only edited one object, the camera probably moved)" : d.changed_pct >= 15 ? "large change" : d.changed_pct >= 3 ? "moderate change" : "small, local change";
    return `CHANGE vs previous capture ${pair}: ${d.changed_pct}% of pixels differ (${scale})${box}${where}${d.size_mismatch ? "; captures had different sizes (resampled)" : ""}. Now judge the attached image: is the change the one you intended?`;
  }

  // ── public compare ──────────────────────────────────────────────────────
  // compare({before, after, threshold}) - refs as in resolve(); defaults:
  // before = previous capture, after = latest capture.
  async function compare(args) {
    args = args || {};
    if (ring.length < 2 && !(args.after && args.before)) {
      return { ok: false, text: ring.length ? "screenshot_compare: only one capture in memory - take total_screenshot again after your change (or pass compare:true to total_screenshot) and the delta is reported automatically." : "screenshot_compare: no captures yet - call total_screenshot {label:\"before\"} first, make the change, then total_screenshot {compare:true}." };
    }
    const after = resolve(args.after, 0), before = resolve(args.before, 1);
    if (!after || !before) return { ok: false, text: `screenshot_compare: capture not found (${!before ? "before=" + JSON.stringify(args.before ?? "previous") : "after=" + JSON.stringify(args.after ?? "last")}). Known captures: ${list().map((e) => "#" + e.id + (e.label ? " " + e.label : "")).join(", ") || "none"}.` };
    if (after.id === before.id) return { ok: false, text: "screenshot_compare: before and after are the same capture (#" + after.id + ")." };
    let a, b;
    try { a = await decode(before); b = await decode(after); }
    catch (e) { return { ok: false, text: "screenshot_compare: could not decode the captures (" + String(e && e.message || e) + ") - judge the images by eye." }; }
    const d = diff(a, b, { threshold: args.threshold });
    return { ok: true, before: publicEntry(before), after: publicEntry(after), diff: d, text: describe(d, before, after) };
  }

  const api = { remember, list, latest, clear, resolve: (r, o) => publicEntry(resolve(r, o)), setDecoder, decode, diff, describe, compare, downsample, resample, MAX_KEPT, MAX_WIDTH, SAME_PCT, DEFAULT_THRESHOLD, CELLS, VERSION: "2.8.0" };
  if (typeof window !== "undefined") window.TotalScreenshotDiff = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
