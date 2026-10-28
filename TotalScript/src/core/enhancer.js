/* TotalScript Prompt Enhancer — rough idea → precise prompt, reviewed by you.
 *
 * 1.72.0. The rough request is sent to the CURRENT AI site as a "rewrite this
 * into a precise prompt" pre-pass (main.js does the round trip: it types the
 * request, waits for the reply, extracts the prompt between the markers from
 * config.js). The result lands in an editable preview; nothing reaches the
 * agent until the user presses Send (or puts it in the chat box / copies it).
 *
 * Public API (window.TotalEnhancer):
 *   open(hooks)   hooks = {
 *     draft() -> string                                   // current composer text
 *     enhance(rough, opts, onStatus) -> Promise<{text, focus, source, raw, mode?, experts?, checks?}>
 *                                                         // opts = {focus:"auto"|"roblox"|"general", mode:"auto"|..., short, notes, cancelled()}
 *     analyze(rough, opts) -> {mode, experts[], explain, preserve} | null   // 1.88.0 optional, sync (TotalSkillIntel)
 *     send(text, onStatus) -> Promise<boolean>           // same path as Paint / GUI Studio hand-offs
 *     insert(text) -> Promise<boolean>                   // write into the site's composer, no send
 *     engine() -> "roblox" | "local", agentStarted() -> boolean, providerName() -> string
 *     toast(msg), diag(event, data)
 *   }
 *   close(), isOpen(), state() (read-only copy for tests / support)
 */
(() => {
  "use strict";
  if (window.TotalEnhancer) return;

  const SVG = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    spark: SVG('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/><path d="M5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z"/>'),
    send: SVG('<path d="M4 12l16-8-6 16-2-7z"/><path d="M12 13l8-9"/>'),
    box: SVG('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h6"/>'),
    copy: SVG('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: SVG('<path d="M9 14H4V9"/><path d="M4 14a8 8 0 1 1 3 6"/>'),
    stop: SVG('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  };
  // 1.88.0: modes change the rewrite STRATEGY (what the pre-pass is told to
  // do), not the UI. Auto picks one from the request (TotalSkillIntel.pickMode).
  const MODES = (window.TotalSkillIntel && Array.isArray(window.TotalSkillIntel.MODES) && window.TotalSkillIntel.MODES.length) ? window.TotalSkillIntel.MODES : [
    { id: "auto", label: "Auto", hint: "Picks Quick / Expert / Deep / Creative / Debug from the request itself" },
    { id: "quick", label: "Quick", hint: "Tidy and complete the request in a few lines" },
    { id: "expert", label: "Expert", hint: "Precise brief with implied requirements made explicit" },
    { id: "deep", label: "Deep Engineering", hint: "Components, data flow, failure modes, verification" },
    { id: "creative", label: "Creative Pro", hint: "Audience, tone, format, references" },
    { id: "debug", label: "Debug & Repair", hint: "Symptom, reproduction, must-not-change, proof" },
  ];
  const FOCUS = [
    { id: "auto", label: "Auto", hint: "Roblox brief when the request smells like Studio work (or the RS engine is on); general otherwise" },
    { id: "roblox", label: "Roblox Studio", hint: "GOAL · SCOPE · BEHAVIOUR & RULES · LOOK & FEEL · CONSTRAINTS · DONE WHEN - verified in Studio" },
    { id: "general", label: "General", hint: "GOAL · CONTEXT · REQUIREMENTS · CONSTRAINTS · OUTPUT FORMAT · DONE WHEN" },
  ];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const words = (t) => (String(t || "").trim().match(/\S+/g) || []).length;

  const S = {
    open: false, hooks: {}, busy: false, cancelled: false,
    rough: "", result: "", focus: "auto", mode: "auto", short: false, notes: "",
    last: null, // {text, focus, mode, source, at, rough, experts, checks}
    prev: null, // the result before the last Enhance (Previous version / Re-enhance never loses work)
    insight: null, // last hooks.analyze() verdict for the rough text (display only)
  };
  let D = null;
  const diag = (e, d) => { try { S.hooks.diag && S.hooks.diag("enhancer." + e, d || {}); } catch {} };
  const toast = (m) => { try { S.hooks.toast ? S.hooks.toast(m) : console.log("[enhancer]", m); } catch {} };

  function loadPrefs() {
    try {
      chrome.storage.local.get("rsEnhancer", (o) => {
        const p = o && o.rsEnhancer; if (!p || typeof p !== "object") return;
        if (FOCUS.some((f) => f.id === p.focus)) S.focus = p.focus;
        if (MODES.some((m) => m.id === p.mode)) S.mode = p.mode;
        S.short = !!p.short;
        if (D) syncOpts();
      });
    } catch {}
  }
  function savePrefs() { try { chrome.storage.local.set({ rsEnhancer: { focus: S.focus, short: S.short, mode: S.mode } }); } catch {} }

  function build() {
    const host = document.createElement("div"); host.id = "rs-enhance"; host.setAttribute("role", "dialog"); host.setAttribute("aria-label", "TotalScript Prompt Enhancer"); host.tabIndex = -1;
    const logo = (window.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("assets/icon128.png") : "";
    host.innerHTML = `
      <div class="rse-shell">
        <div class="rse-title">
          <span class="rse-brand"><img class="rse-logo" alt="" src="${esc(logo)}">Prompt Enhancer</span>
          <span class="rse-sub">Rough idea → precise prompt. You review it, you send it.</span>
          <div class="rse-title-actions"><button type="button" class="rse-ib rse-close" data-act="close" title="Close (Esc)">${I.close}</button></div>
        </div>
        <div class="rse-body">
          <section class="rse-col rse-in">
            <h4>Your rough prompt</h4>
            <textarea class="rse-rough" rows="9" placeholder="e.g. make a shop with coins and a daily reward"></textarea>
            <div class="rse-row rse-focus" role="radiogroup" aria-label="Focus">
              ${FOCUS.map((f) => `<button type="button" class="rse-chip" data-focus="${f.id}" role="radio" aria-checked="false" title="${esc(f.hint)}">${esc(f.label)}</button>`).join("")}
            </div>
            <div class="rse-focus-hint"></div>
            <div class="rse-row rse-mode" role="radiogroup" aria-label="Mode">
              ${MODES.map((m) => `<button type="button" class="rse-chip" data-mode="${m.id}" role="radio" aria-checked="false" title="${esc(m.hint)}">${esc(m.label)}</button>`).join("")}
            </div>
            <div class="rse-mode-hint"></div>
            <div class="rse-insight" aria-live="polite"></div>
            <input type="text" class="rse-notes" placeholder="Guidance for the rewrite (optional): e.g. keep it under 10 lines, ask for a plan first, mobile first">
            <label class="rse-check" title="Ask for a compact prompt under 120 words"><input type="checkbox" class="rse-short"> Keep it short</label>
            <div class="rse-actions">
              <button type="button" class="rse-btn primary rse-go" data-act="enhance">${I.spark}<span>Enhance</span></button>
              <button type="button" class="rse-btn rse-cancel" data-act="cancel" hidden>${I.stop}<span>Cancel</span></button>
            </div>
            <div class="rse-status" aria-live="polite"></div>
            <div class="rse-note">The rewrite request and the AI's answer appear in this chat like any other turn (that is the round trip). Nothing is sent to the agent until you press Send.</div>
          </section>
          <section class="rse-col rse-out">
            <h4>Enhanced prompt <span class="rse-meta"></span></h4>
            <textarea class="rse-result" rows="14" placeholder="The improved prompt lands here - edit it freely before sending."></textarea>
            <div class="rse-actions">
              <button type="button" class="rse-btn primary rse-send" data-act="send" disabled>${I.send}<span>Send to AI</span></button>
              <button type="button" class="rse-btn rse-insert" data-act="insert" disabled title="Put the text in the site's chat box without sending">${I.box}<span>Put in chat box</span></button>
              <button type="button" class="rse-btn rse-copy" data-act="copy" disabled>${I.copy}<span>Copy</span></button>
              <button type="button" class="rse-btn rse-back" data-act="original" disabled title="Replace the result with your original wording">${I.back}<span>Use original</span></button>
              <button type="button" class="rse-btn rse-prev" data-act="previous" disabled title="Swap back to the result before the last Enhance">${I.back}<span>Previous version</span></button>
            </div>
            <div class="rse-checks" aria-live="polite"></div>
            <div class="rse-agent-hint"></div>
          </section>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    const q = (s) => host.querySelector(s);
    D = { host, rough: q(".rse-rough"), notes: q(".rse-notes"), short: q(".rse-short"), focusHint: q(".rse-focus-hint"), modeHint: q(".rse-mode-hint"), insight: q(".rse-insight"), checks: q(".rse-checks"), prev: q(".rse-prev"), go: q(".rse-go"), cancel: q(".rse-cancel"), status: q(".rse-status"), result: q(".rse-result"), meta: q(".rse-meta"), send: q(".rse-send"), insert: q(".rse-insert"), copy: q(".rse-copy"), back: q(".rse-back"), agentHint: q(".rse-agent-hint") };

    host.addEventListener("click", (e) => {
      const chip = e.target.closest(".rse-chip[data-focus]"); if (chip) { S.focus = chip.dataset.focus; savePrefs(); syncOpts(); refreshInsight(); return; }
      const mchip = e.target.closest(".rse-chip[data-mode]"); if (mchip) { S.mode = mchip.dataset.mode; savePrefs(); syncOpts(); refreshInsight(); return; }
      const a = e.target.closest("[data-act]"); if (a) act(a.dataset.act);
      else if (e.target === host) close();
    });
    D.rough.addEventListener("input", () => { S.rough = D.rough.value; syncButtons(); scheduleInsight(); });
    D.result.addEventListener("input", () => { S.result = D.result.value; syncButtons(); });
    D.notes.addEventListener("input", () => { S.notes = D.notes.value; });
    D.short.addEventListener("change", () => { S.short = D.short.checked; savePrefs(); });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (S.busy) act("cancel"); else close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (e.target === D.result) act("send"); else act("enhance");
      }
    });
  }

  function syncOpts() {
    if (!D) return;
    D.host.querySelectorAll(".rse-chip[data-focus]").forEach((b) => { const on = b.dataset.focus === S.focus; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
    const f = FOCUS.find((x) => x.id === S.focus) || FOCUS[0]; D.focusHint.textContent = f.hint;
    D.host.querySelectorAll(".rse-chip[data-mode]").forEach((b) => { const on = b.dataset.mode === S.mode; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
    const m = MODES.find((x) => x.id === S.mode) || MODES[0]; D.modeHint.textContent = m.hint;
    D.short.checked = !!S.short;
  }
  // 1.88.0: what the deterministic layer will do for the current rough text
  // (mode picked by Auto, specialists, must-keep items). Display only.
  let insightTimer = null;
  function scheduleInsight() { clearTimeout(insightTimer); insightTimer = setTimeout(refreshInsight, 350); }
  function refreshInsight() {
    if (!D) return;
    let v = null;
    try { v = (S.hooks.analyze && S.rough.trim()) ? S.hooks.analyze(S.rough.trim(), { focus: S.focus, mode: S.mode }) : null; } catch {}
    S.insight = v;
    if (!v) { D.insight.textContent = ""; D.insight.hidden = true; return; }
    const modeLabel = (MODES.find((x) => x.id === v.mode) || {}).label || v.mode;
    const bits = [`Mode: ${modeLabel}${v.modeAuto ? " (auto)" : ""}`];
    bits.push(v.experts && v.experts.length ? `Expertise: ${v.experts.map((x) => x.title + (x.why && x.why.length ? " (" + x.why.slice(0, 2).join(", ") + ")" : "")).join(" · ")}` : "Expertise: none needed");
    if (v.preserve) bits.push(v.preserve.replace(/^MUST KEEP \([^)]*\): /, "Will keep: "));
    D.insight.textContent = bits.join("  —  ");
    D.insight.hidden = false;
  }
  function renderChecks(checks) {
    if (!D) return;
    D.checks.innerHTML = "";
    if (!checks || !Array.isArray(checks.issues) || !checks.issues.length) { D.checks.hidden = true; return; }
    const ul = document.createElement("ul"); ul.className = "rse-check-list";
    for (const i of checks.issues.slice(0, 6)) { const li = document.createElement("li"); li.dataset.severity = i.severity || "info"; li.textContent = i.text; ul.appendChild(li); }
    const head = document.createElement("div"); head.className = "rse-check-head"; head.textContent = checks.ok ? "Checks: minor notes" : "Checks: review before sending";
    D.checks.appendChild(head); D.checks.appendChild(ul);
    if (checks.repaired && checks.repaired !== S.result) {
      const b = document.createElement("button"); b.type = "button"; b.className = "rse-btn rse-repair"; b.dataset.act = "repair"; b.textContent = "Restore dropped code"; D.checks.appendChild(b);
    }
    D.checks.hidden = false;
  }
  function syncButtons() {
    if (!D) return;
    const hasRough = !!S.rough.trim(), hasResult = !!S.result.trim();
    D.go.disabled = S.busy || !hasRough;
    D.send.disabled = S.busy || !hasResult;
    D.insert.disabled = S.busy || !hasResult;
    D.copy.disabled = !hasResult;
    D.back.disabled = S.busy || !hasRough || S.result === S.rough;
    D.prev.disabled = S.busy || !S.prev || S.prev === S.result;
    D.rough.disabled = S.busy; D.result.disabled = S.busy;
    D.cancel.hidden = !S.busy; D.go.hidden = S.busy;
    const modeLabel = S.last && S.last.mode ? (MODES.find((x) => x.id === S.last.mode) || {}).label || S.last.mode : "";
    D.meta.textContent = hasResult ? `${words(S.result)} words` + (S.last && S.last.focus ? ` · ${S.last.focus === "general" ? "general" : "Roblox"} focus` : "") + (modeLabel ? ` · ${modeLabel}` : "") : "";
    const started = !!(S.hooks.agentStarted && S.hooks.agentStarted());
    D.agentHint.textContent = started
      ? "Send hands the prompt to the running TotalScript session: the agent acts on it."
      : "Agent is off: Send posts the prompt as a plain chat message. Press Start first if TotalScript should act on it.";
  }
  function setStatus(m, kind) { if (!D) return; D.status.textContent = m || ""; D.status.dataset.kind = kind || ""; }

  async function act(name) {
    if (name === "close") return close();
    if (name === "cancel") { if (S.busy) { S.cancelled = true; setStatus("Cancelling…", "warn"); } return; }
    if (name === "enhance") return runEnhance();
    if (name === "original") { if (S.result && S.result !== S.rough) S.prev = S.result; S.result = S.rough; D.result.value = S.rough; syncButtons(); return; }
    if (name === "previous") { if (!S.prev || S.busy) return; const cur = S.result; S.result = S.prev; S.prev = cur; D.result.value = S.result; syncButtons(); return; }
    if (name === "repair") { const r = S.last && S.last.checks && S.last.checks.repaired; if (!r) return; S.prev = S.result; S.result = r; D.result.value = r; if (S.last.checks) S.last.checks.repaired = ""; renderChecks(S.last.checks); syncButtons(); toast("Original code blocks re-attached"); return; }
    if (name === "copy") { try { await navigator.clipboard.writeText(S.result); toast("Prompt copied"); } catch { toast("Copy failed - select the text and copy it yourself"); } return; }
    if (name === "insert") {
      if (!S.result.trim() || !S.hooks.insert) return;
      let ok = false; try { ok = await S.hooks.insert(S.result); } catch (e) { diag("insertFail", { err: String(e && e.message || e).slice(0, 160) }); }
      if (ok) { toast("Prompt is in the chat box - edit or send it there"); diag("insert", { chars: S.result.length }); close(); }
      else setStatus("Couldn't write into this site's chat box - use Copy and paste it.", "warn");
      return;
    }
    if (name === "send") {
      if (!S.result.trim() || !S.hooks.send || S.busy) return;
      S.busy = true; syncButtons(); setStatus("Sending…");
      let ok = false;
      try { ok = await S.hooks.send(S.result, (m) => setStatus(m)); }
      catch (e) { setStatus("Not sent: " + String(e && e.message || e), "err"); diag("sendFail", { err: String(e && e.message || e).slice(0, 160) }); }
      S.busy = false; syncButtons();
      if (ok) { diag("sent", { chars: S.result.length, focus: S.last && S.last.focus }); toast("Enhanced prompt sent"); close(); }
      else if (!D.status.textContent.startsWith("Not sent")) setStatus("Not sent - the site refused the message. Try Put in chat box.", "warn");
    }
  }

  async function runEnhance() {
    const rough = S.rough.trim();
    if (!rough || S.busy || !S.hooks.enhance) return;
    S.busy = true; S.cancelled = false; syncButtons();
    setStatus("Preparing the rewrite request…");
    const opts = { focus: S.focus, mode: S.mode, short: S.short, notes: S.notes.trim(), cancelled: () => S.cancelled };
    const t0 = Date.now();
    try {
      const r = await S.hooks.enhance(rough, opts, (m) => setStatus(m));
      if (S.cancelled) { setStatus("Cancelled.", "warn"); diag("cancelled", { ms: Date.now() - t0 }); return; }
      if (!r || !String(r.text || "").trim()) throw new Error("the AI returned nothing usable");
      // Re-enhance never loses the previous result (Previous version swaps back).
      if (S.result.trim() && S.result !== S.rough) S.prev = S.result;
      S.result = String(r.text).trim(); D.result.value = S.result;
      S.last = { text: S.result, focus: r.focus, mode: r.mode || "", source: r.source, at: Date.now(), rough, experts: Array.isArray(r.experts) ? r.experts : [], checks: r.checks || null };
      renderChecks(S.last.checks);
      const warn = S.last.checks && !S.last.checks.ok;
      setStatus(`Ready in ${Math.round((Date.now() - t0) / 100) / 10}s - ${warn ? "see the checks, " : ""}review, edit, then Send.`, warn ? "warn" : "ok");
      diag("done", { ms: Date.now() - t0, focus: r.focus, mode: r.mode, experts: S.last.experts.map((x) => x.id), checksOk: S.last.checks ? S.last.checks.ok : null, source: r.source, inChars: rough.length, outChars: S.result.length });
      try { D.result.focus(); } catch {}
    } catch (e) {
      // Failure keeps whatever was in the preview; the original is untouched.
      const msg = String(e && e.message || e);
      setStatus(S.cancelled ? "Cancelled." : "Enhance failed: " + msg + (S.result.trim() ? " - your previous result is still here." : " - your original text is untouched."), S.cancelled ? "warn" : "err");
      diag("fail", { err: msg.slice(0, 200), ms: Date.now() - t0 });
    } finally {
      S.busy = false; S.cancelled = false; syncButtons();
    }
  }

  function open(hooks) {
    S.hooks = hooks || S.hooks || {};
    if (!D) { build(); loadPrefs(); }
    let draft = ""; try { draft = String((S.hooks.draft && S.hooks.draft()) || ""); } catch {}
    if (draft.trim()) S.rough = draft;
    D.rough.value = S.rough; D.result.value = S.result; D.notes.value = S.notes;
    S.open = true; D.host.classList.add("open"); document.documentElement.classList.add("rs-enhance-open");
    const name = (S.hooks.providerName && S.hooks.providerName()) || "the AI";
    D.go.querySelector("span").textContent = "Enhance with " + name;
    syncOpts(); syncButtons(); setStatus(""); renderChecks(S.last && S.last.checks); refreshInsight();
    try { (S.rough.trim() ? D.go : D.rough).focus(); } catch {}
    diag("open", { draftChars: draft.length, hasResult: !!S.result });
  }
  function close() {
    if (!S.open) return;
    S.open = false; D.host.classList.remove("open"); document.documentElement.classList.remove("rs-enhance-open");
    diag("close", {});
  }
  function isOpen() { return S.open; }
  function state() { return { open: S.open, busy: S.busy, rough: S.rough, result: S.result, prev: S.prev, focus: S.focus, mode: S.mode, short: S.short, notes: S.notes, insight: S.insight ? Object.assign({}, S.insight) : null, last: S.last ? Object.assign({}, S.last) : null }; }

  window.TotalEnhancer = { open, close, isOpen, state, FOCUS, MODES };
})();
