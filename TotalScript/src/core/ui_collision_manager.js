// SPDX-License-Identifier: GPL-3.0-or-later
// Respectful host-UI collision handling. Runs in the isolated extension world.
//
// Goal: when the host site opens a REAL blocking surface (modal dialog, drawer,
// dimmed backdrop) on top of the TotalScript bar, step aside; when a popover merely
// overlaps the bar, nudge it. What this must NEVER do is hide the whole UI
// because of an invisible container. v1.21.2 fix: Notion keeps a permanent
// full-viewport, fully transparent `notion-overlay-container` in its shell.
// The old rule "class contains overlay + area > 55% of the viewport ⇒ hide"
// matched it one second after load (the 1 s poll), so the bar appeared briefly
// and then vanished for good. Hiding now requires evidence that something is
// actually drawn over OUR elements: a dialog/modal role, or an opaque /
// blurred backdrop, intersecting the rectangle we really occupy.
(() => {
  "use strict";
  if (globalThis.TotalUICollisionManager) return;
  const STATES = Object.freeze({ VISIBLE: "VISIBLE", REPOSITIONING: "REPOSITIONING", TEMPORARILY_HIDDEN: "TEMPORARILY_HIDDEN", RESTORING: "RESTORING" });
  const PROVIDER_SELECTORS = {
    chatgpt: ['[data-testid*="modal"]', '[data-testid*="popover"]', '[role="dialog"]'],
    deepseek: ['.ds-modal', '[class*="modal"]', '[role="dialog"]'],
    gemini: ['mat-dialog-container', '.cdk-overlay-pane', '[role="dialog"]'],
    claude: ['[data-radix-popper-content-wrapper]', '[role="dialog"]'],
    qwen: ['.ant-modal', '.ant-drawer', '.ant-dropdown', '[role="dialog"]'],
    kimi: ['.n-modal', '.n-drawer', '.v-binder-follower-content', '[role="dialog"]'],
    // Notion renders every popup inside .notion-overlay-container; the container
    // itself is a transparent full-viewport shell and must never count.
    notion: ['.notion-overlay-container [role="dialog"]', '.notion-overlay-container [aria-modal="true"]', '[role="dialog"]'],
  };
  const FALLBACK = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-state="open"],[class*="modal" i],[class*="popover" i],[class*="drawer" i],[class*="overlay" i]';
  const MODAL_ROLE = '[role="dialog"],[aria-modal="true"]';

  const rectOf = (el) => { try { return el.getBoundingClientRect(); } catch { return null; } };
  const styleOf = (el) => { try { return getComputedStyle(el); } catch { return null; } };
  const alphaOf = (color) => {
    const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(String(color || ""));
    if (!m) return /transparent|^$/i.test(String(color || "")) ? 0 : 1;
    return m[1] === undefined ? 1 : parseFloat(m[1]);
  };
  const visible = (el) => {
    if (!el || el === document.documentElement || el === document.body || el.closest("#rs-root")) return false;
    const r = rectOf(el);
    if (!r || r.width < 8 || r.height < 8) return false;
    const s = styleOf(el);
    return !!s && s.display !== "none" && s.visibility !== "hidden" && +s.opacity !== 0;
  };
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  // Transparent, click-through shells (Notion's overlay container, portal
  // roots, "overlay" layout wrappers) draw nothing and block nothing.
  const paintsSomething = (el, s) => {
    if (!s) return true;
    if (alphaOf(s.backgroundColor) > 0.02) return true;
    if (s.backgroundImage && s.backgroundImage !== "none") return true;
    if ((s.backdropFilter && s.backdropFilter !== "none") || (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none")) return true;
    if (s.boxShadow && s.boxShadow !== "none") return true;
    const bw = parseFloat(s.borderTopWidth) || 0;
    return bw > 0 && alphaOf(s.borderTopColor) > 0.02;
  };
  // Real modal backdrops dim or blur what is underneath (rgba(0,0,0,.4),
  // backdrop-filter). An OPAQUE full-screen panel is a page surface - a chat
  // view, a settings page - and only counts as blocking through a dialog role.
  const dimsOrBlurs = (s) => {
    if (!s) return false;
    const a = alphaOf(s.backgroundColor);
    if (a > 0.02 && a < 0.97) return true;
    return (s.backdropFilter && s.backdropFilter !== "none") || (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none");
  };
  const hasVisibleContent = (el) => {
    let n = 0;
    for (const child of el.children) {
      const r = rectOf(child);
      if (r && r.width >= 8 && r.height >= 8) { n++; if (n >= 1) return true; }
    }
    return false;
  };
  const providerEditor = () => {
    try { const P = globalThis.RSProvider; return P && typeof P.getEditor === "function" ? P.getEditor() : null; } catch { return null; }
  };

  class CollisionManager {
    constructor() { this.state = STATES.VISIBLE; this.root = null; this.provider = ""; this.observers = []; this.timer = 0; this.raf = 0; this.lastUrl = location.href; this.bound = () => this.schedule(); }
    initialize({ root, provider } = {}) {
      if (this.root === root && this.observers.length) return this;
      this.destroy();
      this.root = root || document.getElementById("rs-root");
      this.provider = String(provider || "").toLowerCase();
      if (!this.root) return this;
      const body = document.body || document.documentElement;
      const direct = new MutationObserver(this.bound);
      direct.observe(body, { childList: true });
      this.observers.push(direct);
      const composer = this.root.parentElement && this.root.parentElement !== document.documentElement ? this.root.parentElement : null;
      if (composer) {
        const scoped = new MutationObserver(this.bound);
        scoped.observe(composer, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "aria-expanded", "data-state"] });
        this.observers.push(scoped);
      }
      addEventListener("resize", this.bound, { passive: true });
      addEventListener("popstate", this.bound);
      document.addEventListener("visibilitychange", this.bound);
      this.timer = setInterval(() => { if (location.href !== this.lastUrl) { this.lastUrl = location.href; this.schedule(); } else this.evaluate(); }, 1000);
      this.evaluate();
      return this;
    }
    candidates() {
      const selectors = [...(PROVIDER_SELECTORS[this.provider] || []), FALLBACK];
      const out = [], seen = new Set();
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (!seen.has(el) && visible(el)) { seen.add(el); out.push(el); }
          }
        } catch {}
      }
      return out;
    }
    // The rectangle TotalScript really occupies: #rs-root is a zero-size fixed
    // wrapper, so measure its visible children (bar, menu, cards, banners).
    ownRect() {
      let out = null;
      for (const child of this.root.children) {
        const s = styleOf(child);
        if (!s || s.display === "none" || s.visibility === "hidden") continue;
        const r = rectOf(child);
        if (!r || r.width < 2 || r.height < 2) continue;
        out = out
          ? { left: Math.min(out.left, r.left), top: Math.min(out.top, r.top), right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom) }
          : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
      return out;
    }
    setState(next) {
      if (next === this.state) return;
      this.state = next;
      if (this.root) this.root.dataset.rsCollisionState = next;
      dispatchEvent(new CustomEvent("totalscript:collision-state", { detail: { state: next, provider: this.provider } }));
    }
    schedule() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.evaluate(); }); }
    evaluate() {
      if (!this.root || !this.root.isConnected) return;
      const ours = this.ownRect();
      const viewport = Math.max(1, innerWidth * innerHeight);
      const editor = providerEditor();
      let hide = false, move = false;
      if (ours) {
        for (const el of this.candidates()) {
          // The chat surface itself (or a shell wrapping it) is never a modal.
          if (el.contains(this.root) || (editor && el.contains(editor))) continue;
          const r = rectOf(el);
          if (!r) continue;
          const s = styleOf(el);
          const area = r.width * r.height;
          const isModalRole = el.matches(MODAL_ROLE);
          const clickThrough = !!s && s.pointerEvents === "none";
          // A large element only counts as a backdrop when it actually paints
          // (dim/blur/colour) - a transparent full-screen container is a shell.
          const isBackdrop = !isModalRole && area > viewport * 0.55 && !clickThrough && dimsOrBlurs(s) && (s.position === "fixed" || s.position === "absolute");
          if (!isModalRole && !isBackdrop && !paintsSomething(el, s) && !hasVisibleContent(el)) continue;
          if (!intersects(r, ours)) continue;
          if (isModalRole || isBackdrop) { hide = true; break; }
          if (!clickThrough) move = true;
        }
      }
      if (hide) {
        this.setState(STATES.TEMPORARILY_HIDDEN);
        this.root.style.setProperty("visibility", "hidden", "important");
        this.root.style.setProperty("pointer-events", "none", "important");
        return;
      }
      if (this.state === STATES.TEMPORARILY_HIDDEN) this.setState(STATES.RESTORING);
      this.root.style.removeProperty("visibility");
      this.root.style.removeProperty("pointer-events");
      if (move) {
        this.setState(STATES.REPOSITIONING);
        this.root.style.setProperty("--rs-collision-offset", "72px");
      } else {
        this.root.style.removeProperty("--rs-collision-offset");
        this.setState(STATES.VISIBLE);
      }
    }
    destroy() {
      for (const o of this.observers) o.disconnect();
      this.observers = [];
      clearInterval(this.timer); this.timer = 0;
      if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0;
      removeEventListener("resize", this.bound);
      removeEventListener("popstate", this.bound);
      document.removeEventListener("visibilitychange", this.bound);
      if (this.root) {
        this.root.style.removeProperty("visibility");
        this.root.style.removeProperty("pointer-events");
        this.root.style.removeProperty("--rs-collision-offset");
      }
      this.root = null;
      this.state = STATES.VISIBLE;
    }
  }
  globalThis.TotalUICollisionManager = { STATES, instance: new CollisionManager(), CollisionManager };
})();
