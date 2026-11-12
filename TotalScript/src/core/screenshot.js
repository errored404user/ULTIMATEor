// Tab / Studio screenshot for Chrome, Edge, Brave, and Opera (all Chromium).
const TotalScreenshot = (() => {
  "use strict";

  function api() {
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome;
    if (typeof browser !== "undefined" && browser.runtime) return browser;
    return null;
  }

  function send(msg) {
    const C = api();
    return new Promise((resolve) => {
      if (!C || !C.runtime || !C.runtime.sendMessage) {
        resolve({ ok: false, error: "no extension runtime — reload in chrome://extensions, edge://extensions, brave://extensions, or opera://extensions" });
        return;
      }
      let settled = false;
      const done = (r, err) => {
        if (settled) return;
        settled = true;
        if (err) resolve({ ok: false, error: String(err) });
        else resolve(r || { ok: false, error: "empty screenshot response" });
      };
      try {
        const ret = C.runtime.sendMessage(msg, (r) => {
          const le = C.runtime.lastError && C.runtime.lastError.message;
          if (le) done(null, le);
          else done(r);
        });
        if (ret && typeof ret.then === "function") {
          ret.then((r) => done(r)).catch((e) => done(null, e && e.message || e));
        }
      } catch (e) {
        done(null, e && e.message || e);
      }
      setTimeout(() => done(null, "screenshot timed out"), 12000);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function grabTab() {
    // The chat tab is captured through the background worker, which focuses the
    // tab's window first — no need to keep a specific window on screen. Give it
    // several attempts: the first capture after a focus change can come back
    // empty on some Chromium builds, so retry with growing pauses.
    try { if (typeof window !== "undefined" && window.focus) window.focus(); } catch {}
    let last = { ok: false, error: "no attempt" };
    for (let i = 0; i < 5; i++) {
      last = await send({ type: "screenshot_capture" });
      if (last && last.ok && last.images && last.images.length) return last;
      await sleep(400 + i * 350);
    }
    return last;
  }

  function push(images, list, label, notes) {
    if (!list || !list.length) return 0;
    let n = 0;
    for (const im of list) {
      if (!im || !im.data) continue;
      images.push({ mimeType: im.mimeType || "image/jpeg", data: im.data });
      n++;
    }
    if (n) notes.push(label + " ×" + n);
    return n;
  }

  async function run(args, hooks) {
    args = args || {};
    hooks = hooks || {};
    const target = String(args.target || args.source || "auto").toLowerCase();
    const images = [];
    const notes = [];
    const explicitTab = target === "tab" || target === "chat" || target === "page" || target === "self";
    const wantStudio = target === "auto" || target === "studio" || target === "roblox" || target === "viewport" || target === "game";
    const wantBlend = target === "blender" || target === "auto";
    let studioAttempted = false;
    let blenderAttempted = false;

    // Studio first on auto. Never disguise a failed Studio request as success by
    // silently attaching the browser tab—the caller asked to see the game.
    if (wantStudio && typeof hooks.studio === "function") {
      studioAttempted = true;
      try {
        const r = await hooks.studio();
        if (r && r.ok && r.images && r.images.length) push(images, r.images, "studio", notes);
        else notes.push("studio: " + String((r && (r.error || r.text)) || "screen_capture returned no image").slice(0, 220));
      } catch (e) {
        notes.push("studio: " + String(e && e.message || e).slice(0, 220));
      }
    }

    if (!images.length && wantBlend && (!studioAttempted || target === "blender") && typeof hooks.blender === "function") {
      blenderAttempted = true;
      try {
        const r = await hooks.blender();
        if (r && r.ok && r.images && r.images.length) push(images, r.images, "blender", notes);
        else notes.push("blender: " + String((r && (r.error || r.text)) || "capture returned no image").slice(0, 220));
      } catch (e) {
        notes.push("blender: " + String(e && e.message || e).slice(0, 220));
      }
    }

    if (wantStudio && typeof hooks.studio !== "function" && target !== "auto") {
      notes.push("studio: Roblox Studio MCP is not connected");
    }
    if (target === "blender" && typeof hooks.blender !== "function") {
      notes.push("blender: Blender MCP is not connected");
    }

    // `auto` uses the browser only when no native viewport was available to try.
    // Explicit studio/game/viewport requests never fall back to the chat tab.
    const allowTab = explicitTab || (target === "auto" && !studioAttempted && !blenderAttempted);
    if (!images.length && allowTab) {
      const tab = await grabTab();
      if (tab && tab.ok) push(images, tab.images, "tab", notes);
      else notes.push("tab: " + String((tab && tab.error) || "failed").slice(0, 140));
    }

    if (!images.length) {
      const advice = studioAttempted
        ? " Keep Studio in Play mode, update/restart total-core, and confirm Studio MCP is enabled."
        : (explicitTab ? " Reload the extension if the tabs permission is missing." : " Enable the requested MCP connection and try again.");
      return {
        ok: false,
        images: [],
        text: "ERROR: screenshot captured nothing. " + notes.join(" | ") + "." + advice,
      };
    }
    return {
      ok: true,
      images: images,
      text: "Output of 'total_screenshot':\n" + notes.join("; ") + "\nThe photo is attached to THIS message. Look at it and continue.",
    };
  }

  return { run: run, grabTab: grabTab };
})();
