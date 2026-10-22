// ORscript — Reasoning effort (1.63.0)
//
// One setting, five levels: low · mid · high · max · ultimate. It does two things:
//
//  1. PROMPT: config.js reads window.__rsThinkingLevel() and appends the matching
//     THINKING LEVEL block to the system prompt (plan → build → review → verify
//     rigor grows with the level); main.js adds an evidence gate at high+.
//  1b. (1.63) PROMPT POWER-UPS: boosts (force any profile behaviour on at any
//     level), focus lenses (performance / security / mobile / multiplayer /
//     clean code / minimal changes / explain / ask-first) and one standing rule.
//     promptExtras() renders them after the level note; effectiveProfile() is
//     what Settings shows; gate() honours boosted read-back / proof / review.
//     ORscript NEVER switches the site's model or think mode for the user
//     (1.63): the provider table below is kept as a library for API providers
//     and tests, but main.js no longer calls apply() on its own.
//  2. NATIVE MODE PER PROVIDER (library only): every AI site has its own switch for "think more"
//     (ChatGPT Instant / Thinking / Pro, Gemini Fast / Thinking / Pro / Deep Think,
//     DeepSeek DeepThink, Qwen / Kimi / GLM thinking toggles, Claude extended
//     thinking, CodeCraft reasoning_effort ...). Each provider declares its modes
//     here with a default level → mode map; the user may remap any level per
//     provider in Settings (stored as rsReasoningModes = {provider:{level:mode}}).
//     apply() then flips the site's control best-effort through generic, label-
//     anchored DOM rules (toggle / picker) or a provider hook (P.setReasoningMode).
//     It never guesses: an unmatched control reports {ok:false, reason} and the
//     user gets a toast telling them which switch to flip by hand.
//
// No dependencies. Loaded before main.js in every bundle (manifest.json).
(function () {
  "use strict";
  // profile = what the AI actually does at that level (rendered as the live
  // "effort profile" in Settings, 1.61): plan before acting, flaw critique,
  // review loops, read-back of changed files, proof (playtest / console),
  // quality audit, final self-review, API research. Values are display text;
  // false = off.
  const LEVELS = [
    { id: "low", name: "Low", short: "fast", sub: "Act fast, one quick self-check. Cheapest and quickest replies.", profile: { plan: false, critique: "quick check", loops: "1", readback: false, proof: false, audit: false, review: false, research: false } },
    { id: "mid", name: "Medium", short: "balanced", sub: "Default. One review loop after writing code.", profile: { plan: false, critique: "1 pass", loops: "1", readback: false, proof: false, audit: false, review: false, research: false } },
    { id: "high", name: "High", short: "careful", sub: "Plan first, critique 2–3 flaws, read the result back before done.", profile: { plan: "steps first", critique: "2–3 flaws", loops: "1", readback: "changes", proof: false, audit: false, review: false, research: false } },
    { id: "max", name: "Max", short: "rigorous", sub: "Plan → build → review 3+ flaws → fix → verify, up to three loops; research APIs.", profile: { plan: "outline", critique: "3+ flaws", loops: "up to 3", readback: "every change", proof: false, audit: false, review: "final pass", research: "unknown APIs" } },
    { id: "ultimate", name: "Ultimate", short: "no shortcuts", sub: "Everything in Max plus a playtest / console check, a quality audit and a final self-review before any 'done'.", profile: { plan: "full plan", critique: "5+ flaws", loops: "up to 5", readback: "every change", proof: "play+console", audit: "quality", review: "flaw hunt", research: "never guess" } },
  ];
  const PROFILE_KEYS = [["plan", "Plan"], ["critique", "Critique"], ["loops", "Loops"], ["readback", "Read-back"], ["proof", "Proof"], ["audit", "Audit"], ["review", "Review"], ["research", "Research"]];
  const LEVEL_IDS = LEVELS.map((l) => l.id);
  const LEGACY = { default: "mid", medium: "mid", middle: "mid", maximum: "max", extreme: "ultimate", ultra: "ultimate" };
  const normalize = (v) => { const s = String(v || "").toLowerCase().trim(); if (LEVEL_IDS.includes(s)) return s; return LEGACY[s] || "mid"; };
  const levelOf = (id) => LEVELS.find((l) => l.id === normalize(id)) || LEVELS[1];
  const rank = (id) => Math.max(0, LEVEL_IDS.indexOf(normalize(id)));
  const atLeast = (id, floor) => rank(id) >= rank(floor);

  // Mode rule kinds:
  //  { kind:"none" }                      – prompt only (the site has no switch)
  //  { kind:"toggle", match, on }         – a pressed/unpressed button whose label matches
  //  { kind:"picker", trigger, item }     – open a menu (trigger label) and click an item (label)
  //  { kind:"hook", value }               – P.setReasoningMode(value) (API providers)
  // `match` / `trigger` / `item` are RegExps tested against the control's
  // trimmed accessible label (text + aria-label + title), case-insensitive.
  const OFF = "standard";
  const PROVIDERS = {
    chatgpt: {
      name: "ChatGPT",
      note: "Model picker Instant / Thinking / Pro, plus the per-message Think pill.",
      modes: [
        { id: "instant", label: "Instant", rule: { kind: "picker", trigger: /model|gpt|chatgpt|instant|thinking|pro\b/i, item: /^(instant|auto)\b/i } },
        { id: "thinking", label: "Thinking", rule: { kind: "picker", trigger: /model|gpt|chatgpt|instant|thinking|pro\b/i, item: /^thinking\b/i } },
        { id: "think_pill", label: "Think (per message)", rule: { kind: "toggle", match: /^(think|thinking|think longer|extended thinking)$/i, on: true } },
        { id: "pro", label: "Pro", rule: { kind: "picker", trigger: /model|gpt|chatgpt|instant|thinking|pro\b/i, item: /^pro\b/i } },
      ],
      map: { low: "instant", mid: "thinking", high: "thinking", max: "think_pill", ultimate: "pro" },
    },
    claude: {
      name: "Claude",
      note: "Extended thinking switch in the composer's tools / settings menu.",
      modes: [
        { id: OFF, label: "Normal", rule: { kind: "toggle", match: /^(extended thinking|thinking)$/i, on: false } },
        { id: "extended", label: "Extended thinking", rule: { kind: "toggle", match: /^(extended thinking|thinking)$/i, on: true } },
      ],
      map: { low: OFF, mid: OFF, high: "extended", max: "extended", ultimate: "extended" },
    },
    gemini: {
      name: "Gemini",
      note: "Model picker Fast / Thinking / Pro / Deep Think (plan dependent).",
      modes: [
        { id: "fast", label: "Fast", rule: { kind: "picker", trigger: /gemini|model|fast|thinking|pro\b|deep think/i, item: /^fast\b/i } },
        { id: "thinking", label: "Thinking", rule: { kind: "picker", trigger: /gemini|model|fast|thinking|pro\b|deep think/i, item: /^thinking\b/i } },
        { id: "pro", label: "Pro", rule: { kind: "picker", trigger: /gemini|model|fast|thinking|pro\b|deep think/i, item: /^pro\b/i } },
        { id: "deepthink", label: "Deep Think", rule: { kind: "picker", trigger: /gemini|model|fast|thinking|pro\b|deep think/i, item: /^deep ?think\b/i } },
      ],
      map: { low: "fast", mid: "thinking", high: "thinking", max: "pro", ultimate: "deepthink" },
    },
    deepseek: {
      name: "DeepSeek",
      note: "DeepThink toggle under the composer.",
      modes: [
        { id: OFF, label: "DeepThink off", rule: { kind: "toggle", match: /^deep ?think(\s*\(r1\))?$/i, on: false } },
        { id: "deepthink", label: "DeepThink", rule: { kind: "toggle", match: /^deep ?think(\s*\(r1\))?$/i, on: true } },
      ],
      map: { low: OFF, mid: OFF, high: "deepthink", max: "deepthink", ultimate: "deepthink" },
    },
    qwen: {
      name: "Qwen",
      note: "Thinking toggle under the composer.",
      modes: [
        { id: OFF, label: "Thinking off", rule: { kind: "toggle", match: /^(thinking|deep thinking|think)$/i, on: false } },
        { id: "thinking", label: "Thinking", rule: { kind: "toggle", match: /^(thinking|deep thinking|think)$/i, on: true } },
      ],
      map: { low: OFF, mid: OFF, high: "thinking", max: "thinking", ultimate: "thinking" },
    },
    kimi: {
      name: "Kimi",
      note: "Thinking (K2) toggle in the composer.",
      modes: [
        { id: OFF, label: "Instant", rule: { kind: "toggle", match: /^(thinking|k2 thinking|long thinking|think)$/i, on: false } },
        { id: "thinking", label: "Thinking", rule: { kind: "toggle", match: /^(thinking|k2 thinking|long thinking|think)$/i, on: true } },
      ],
      map: { low: OFF, mid: OFF, high: "thinking", max: "thinking", ultimate: "thinking" },
    },
    glm: {
      name: "GLM",
      note: "Deep thinking toggle in the composer.",
      modes: [
        { id: OFF, label: "Deep thinking off", rule: { kind: "toggle", match: /^(deep thinking|thinking|think)$/i, on: false } },
        { id: "deep", label: "Deep thinking", rule: { kind: "toggle", match: /^(deep thinking|thinking|think)$/i, on: true } },
      ],
      map: { low: OFF, mid: OFF, high: "deep", max: "deep", ultimate: "deep" },
    },
    codecraft: {
      name: "CodeCraft API",
      note: "Sent as reasoning_effort on every request (ignored by models without reasoning).",
      modes: [
        { id: "default", label: "Model default", rule: { kind: "hook", value: "" } },
        { id: "low", label: "low", rule: { kind: "hook", value: "low" } },
        { id: "medium", label: "medium", rule: { kind: "hook", value: "medium" } },
        { id: "high", label: "high", rule: { kind: "hook", value: "high" } },
      ],
      map: { low: "low", mid: "default", high: "medium", max: "high", ultimate: "high" },
    },
    arena: {
      name: "Arena",
      note: "No global switch - the reasoning depth is the model you pick in Arena's model picker (o-series / Thinking models think more). Effort applies through the prompt.",
      modes: [{ id: "model", label: "Current model (prompt only)", rule: { kind: "none" } }],
      map: { low: "model", mid: "model", high: "model", max: "model", ultimate: "model" },
    },
    nvidia: {
      name: "NVIDIA NIM",
      note: "Reasoning depends on the selected NIM model; effort applies through the prompt.",
      modes: [{ id: "model", label: "Current model (prompt only)", rule: { kind: "none" } }],
      map: { low: "model", mid: "model", high: "model", max: "model", ultimate: "model" },
    },
  };
  // Sites without any native switch share one prompt-only profile.
  const PROMPT_ONLY = { name: "", note: "This site has no reasoning switch - the effort level applies through the prompt.", modes: [{ id: "prompt", label: "Prompt only", rule: { kind: "none" } }], map: { low: "prompt", mid: "prompt", high: "prompt", max: "prompt", ultimate: "prompt" } };
  const providerOf = (id) => PROVIDERS[String(id || "").toLowerCase()] || PROMPT_ONLY;
  const hasNative = (id) => !!PROVIDERS[String(id || "").toLowerCase()] && providerOf(id).modes.some((m) => m.rule.kind !== "none");

  // Resolve which mode a (provider, level) pair asks for, honouring overrides.
  // overrides = { [providerId]: { [level]: modeId | "off" } }; "off" = never touch the site.
  function modeFor(providerId, level, overrides) {
    const prov = providerOf(providerId);
    const lvl = normalize(level);
    const ov = overrides && overrides[providerId] && overrides[providerId][lvl];
    if (ov === "off") return { id: "off", label: "Leave the site as it is", rule: { kind: "none" }, overridden: true };
    const id = ov && prov.modes.some((m) => m.id === ov) ? ov : prov.map[lvl];
    const mode = prov.modes.find((m) => m.id === id) || prov.modes[0];
    return Object.assign({}, mode, { overridden: !!ov && ov !== prov.map[lvl] });
  }
  // Full table for the Settings UI: every level → mode of one provider.
  function table(providerId, overrides) {
    const prov = providerOf(providerId);
    return LEVELS.map((l) => ({ level: l.id, name: l.name, mode: modeFor(providerId, l.id, overrides), options: prov.modes.map((m) => ({ id: m.id, label: m.label })) }));
  }

  // ── DOM helpers (generic, label-anchored) ─────────────────────────────────
  const labelOf = (el) => {
    if (!el) return "";
    const parts = [el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("title"), el.textContent];
    return parts.filter(Boolean).map((s) => String(s).replace(/\s+/g, " ").trim()).join(" | ");
  };
  // The label used for matching is the SHORT one: aria-label if present, else text.
  const shortLabel = (el) => {
    const a = el.getAttribute && el.getAttribute("aria-label");
    const t = (a && a.trim()) || (el.textContent || "").replace(/\s+/g, " ").trim() || (el.getAttribute && el.getAttribute("title")) || "";
    return t.trim();
  };
  const visible = (el) => {
    try {
      if (!el || !el.isConnected || el.closest("#rs-root, #rs-gui, #rs-anim, #rs-paint")) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    } catch { return false; }
  };
  const CONTROL_SEL = 'button, [role="button"], [role="switch"], [role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], [role="tab"], label, input[type="checkbox"]';
  const controls = (root) => [...(root || document).querySelectorAll(CONTROL_SEL)].filter(visible);
  const pressed = (el) => {
    const a = (n) => el.getAttribute && el.getAttribute(n);
    if (el.type === "checkbox") return !!el.checked;
    const inner = el.querySelector && el.querySelector('input[type="checkbox"]'); if (inner) return !!inner.checked;
    for (const n of ["aria-pressed", "aria-checked", "aria-selected"]) { const v = a(n); if (v === "true") return true; if (v === "false") return false; }
    const ds = a("data-state"); if (ds) return /^(on|checked|active|selected|open)$/i.test(ds);
    const da = a("data-active"); if (da) return da !== "false";
    return /(^|\s)(active|selected|on|checked|enabled|is-active)(\s|$)/.test(String(el.className || "")) ;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nearEditor = (P) => { try { const ed = P && P.getEditor && P.getEditor(); return ed ? (ed.closest("form") || ed.closest("main") || ed.parentElement) : null; } catch { return null; } };
  // Prefer controls inside the composer region; fall back to the whole page.
  function findControl(P, re, extraRoot) {
    const scopes = [nearEditor(P), extraRoot, document].filter(Boolean);
    for (const sc of scopes) {
      const hit = controls(sc).find((el) => re.test(shortLabel(el)) && shortLabel(el).length <= 48);
      if (hit) return hit;
    }
    return null;
  }
  const click = (el) => { try { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); } catch {} try { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch {} try { el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); } catch {} try { el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); } catch {} try { el.click(); } catch {} };

  // apply(P, mode) → { ok, how, reason?, label }
  // how: "prompt-only" | "already" | "clicked" | "picked" | "hook"
  async function apply(P, mode, opts) {
    const o = opts || {};
    const rule = (mode && mode.rule) || { kind: "none" };
    const label = (mode && mode.label) || "";
    try {
      if (P && typeof P.setReasoningMode === "function" && rule.kind !== "none") {
        const r = await P.setReasoningMode(mode.id, rule);
        if (r && typeof r === "object") return Object.assign({ label }, r);
        if (r !== undefined) return { ok: !!r, how: "hook", label };
      }
      if (rule.kind === "none") return { ok: true, how: "prompt-only", label };
      if (rule.kind === "hook") return { ok: false, how: "hook", reason: "provider has no setReasoningMode hook", label };
      if (rule.kind === "toggle") {
        const el = findControl(P, rule.match);
        if (!el) return { ok: false, how: "toggle", reason: "control-not-found", label };
        if (pressed(el) === !!rule.on) return { ok: true, how: "already", label };
        if (o.dryRun) return { ok: true, how: "would-click", label };
        click(el);
        await sleep(o.settleMs == null ? 300 : o.settleMs);
        const el2 = findControl(P, rule.match) || el;
        const now = pressed(el2);
        // Sites that do not expose state at all: trust the click once.
        const exposes = /^(true|false)$/.test(String(el2.getAttribute("aria-pressed") || el2.getAttribute("aria-checked") || "")) || !!el2.getAttribute("data-state") || el2.type === "checkbox";
        return { ok: !exposes || now === !!rule.on, how: "clicked", label, verified: exposes };
      }
      if (rule.kind === "picker") {
        // Already showing the wanted item on the trigger? (ChatGPT / Gemini print the current mode on the button.)
        const trig = findControl(P, rule.trigger, document.querySelector("header, nav"));
        if (!trig) return { ok: false, how: "picker", reason: "picker-not-found", label };
        if (rule.item.test(shortLabel(trig).replace(/^.*?(?=\b(instant|thinking|pro|fast|deep ?think|auto)\b)/i, ""))) return { ok: true, how: "already", label };
        if (o.dryRun) return { ok: true, how: "would-pick", label };
        click(trig);
        await sleep(o.settleMs == null ? 350 : o.settleMs);
        const items = controls(document).filter((el) => el !== trig && rule.item.test(shortLabel(el)) && shortLabel(el).length <= 60);
        const item = items.find((el) => /menuitem|option|radio/.test(el.getAttribute("role") || "")) || items[0];
        if (!item) {
          try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch {}
          try { trig.click(); } catch {}
          return { ok: false, how: "picker", reason: "item-not-found", label };
        }
        click(item);
        await sleep(o.settleMs == null ? 300 : o.settleMs);
        return { ok: true, how: "picked", label };
      }
      return { ok: false, how: rule.kind, reason: "unknown-rule", label };
    } catch (e) {
      return { ok: false, how: rule.kind, reason: String((e && e.message) || e), label };
    }
  }

  // ── 1.63 prompt-side power-ups (the site's model picker is NEVER touched) ──
  // BOOSTS: any profile behaviour can be forced on at any level ("Medium, but
  // always prove it"). The boosted value is Ultimate's value for that key.
  const BOOST_TEXT = {
    plan: "PLAN FIRST: before the first mutating command restate the goal, list assumptions / unknowns and the ordered steps; resolve unknowns by reading the place or the docs, never by guessing.",
    critique: "CRITIQUE: after writing code list at least five concrete flaws or edge cases (Play vs Edit, respawn, mobile, two players, nil access, races, performance) and fix each before answering.",
    loops: "REVIEW LOOPS: repeat review → fix up to five times until a pass finds nothing new.",
    readback: "READ-BACK: after every change read the result back (script_read / inspect_instance / lighting_inspect) and confirm it matches the request before moving on.",
    proof: "PROOF: nothing is 'done' until start_stop_play + get_console_output (or or_debug) ran clean on what you built.",
    audit: "AUDIT: run quality_audit / script_analysis on the result and fix what they report.",
    review: "FINAL REVIEW: before finishing, hunt for remaining flaws one last time and state what you checked.",
    research: "RESEARCH: never guess an API or property name - web_search / docs lookup first, then use it.",
  };
  // FOCUS LENSES: what the review passes must specifically look for.
  const FOCUS = [
    { id: "perf", label: "Performance", hint: "frame budget, loops, instance counts, RenderStepped", text: "PERFORMANCE: watch per-frame work (RenderStepped / Heartbeat), unbounded loops, instance counts, :GetChildren() in hot paths, Debris, streaming; prefer events over polling." },
    { id: "security", label: "Security", hint: "exploit-proof remotes, server authority", text: "SECURITY: the server is the authority - validate every RemoteEvent / RemoteFunction argument (type, range, ownership, rate), never trust client values for money / damage / position, no server secrets on the client." },
    { id: "mobile", label: "Mobile & UI", hint: "touch, scaling, safe areas", text: "MOBILE & UI: Scale (not Offset) sizing, UIAspectRatio / UIListLayout, touch targets >= 44 px, GuiInset / safe areas, test both phone and desktop viewports, no hover-only interactions." },
    { id: "multiplayer", label: "Multiplayer", hint: "replication, respawn, late joiners", text: "MULTIPLAYER: think two players + a late joiner - replication direction, CharacterAdded / respawn, PlayerRemoving cleanup, per-player state, race conditions, StreamingEnabled." },
    { id: "clean", label: "Clean code", hint: "readable, named, commented", text: "CLEAN CODE: descriptive names, small functions, a header comment per script, typed Luau where it helps, no magic numbers, no dead code." },
    { id: "minimal", label: "Minimal changes", hint: "touch only what the task needs", text: "MINIMAL CHANGES: edit only what the task needs - no rewrites, renames or reformatting of untouched code; prefer script_edit / multi_edit over replacing whole scripts." },
    { id: "explain", label: "Explain decisions", hint: "why, not just what", text: "EXPLAIN DECISIONS: in the final answer say in 2-3 lines WHY the approach was chosen and what you deliberately did not do." },
    { id: "ask", label: "Ask before destructive", hint: "confirm deletes / overwrites", text: "ASK FIRST: before deleting instances, overwriting whole scripts or changing DataStore schemas, stop and ask the user - one question, then wait." },
  ];
  const FOCUS_IDS = FOCUS.map((f) => f.id);
  const cleanExtras = (x) => {
    const e = x && typeof x === "object" ? x : {};
    const boost = {}; for (const [k] of PROFILE_KEYS) if (e.boost && e.boost[k]) boost[k] = true;
    const focus = Array.isArray(e.focus) ? e.focus.filter((f) => FOCUS_IDS.includes(f)) : [];
    const rule = String(e.rule || "").replace(/\s+/g, " ").trim().slice(0, 240);
    return { boost, focus, rule };
  };
  // What the AI actually does at this level once boosts are applied.
  function effectiveProfile(level, extras) {
    const lvl = levelOf(level); const e = cleanExtras(extras); const top = LEVELS[LEVELS.length - 1].profile;
    return PROFILE_KEYS.map(([k, label]) => { const base = lvl.profile[k]; const boosted = !!e.boost[k] && base !== top[k]; return { key: k, label, value: boosted ? top[k] : base, on: !!base || boosted, boosted, forced: !!e.boost[k] }; });
  }
  // Prompt additions appended after the level note (config.js) - and shown
  // verbatim in Settings so the preview is the truth.
  function promptExtras(level, extras) {
    const lvl = levelOf(level); const e = cleanExtras(extras); const parts = [];
    const top = LEVELS[LEVELS.length - 1].profile;
    const boosted = PROFILE_KEYS.filter(([k]) => e.boost[k] && lvl.profile[k] !== top[k]).map(([k]) => BOOST_TEXT[k]);
    if (boosted.length) parts.push("BOOSTED (the user forced these on at " + lvl.name + "):\n- " + boosted.join("\n- "));
    const lenses = e.focus.map((id) => FOCUS.find((f) => f.id === id)).filter(Boolean);
    if (lenses.length) parts.push("FOCUS LENSES (check these specifically in every review pass):\n- " + lenses.map((f) => f.text).join("\n- "));
    if (e.rule) parts.push("STANDING RULE (the user's own, always applies): " + e.rule);
    return parts.length ? "\n" + parts.join("\n") : "";
  }
  const extrasCount = (extras) => { const e = cleanExtras(extras); return Object.keys(e.boost).length + e.focus.length + (e.rule ? 1 : 0); };

  // Evidence gate for the agent loop (main.js): what a finishing run still owes
  // at this level. runTools = Set of bare tool names used in the run.
  const MUTATE_RE = /^(script_(create|set_source|replace|insert|append|module|new|delete_lines|rename_symbol|deprecations_fix|write|edit)|multi_edit|module_scaffold|blueprint_install|blueprint_configure|remote_scaffold|datastore_profile_scaffold|execute_luau|run_code|create_|insert_|set_property|set_properties|ui_(?!list_tree|audit|inspect|layout_report|export_spec)|gui_(?!hide|show)|fx_|vfx_|lighting_set|atmosphere|animation_(?!validate|compatibility|export)|tween_|write_file|edit_file|build_|place_|terrain_)/;
  const VERIFY_RE = /^(script_read|script_check|script_analysis|script_lint|get_console_output|start_stop_play|or_debug|audit_script_errors|script_diff|project_index_changes|studio_playtest|inspect_instance|inspect|get_properties|or_screenshot|screen_capture|gfx_capture|screenshot_frame|ui_layout_report|ui_audit|quality_audit|read_file|list_children|get_children|playtest_)/;
  const AUDIT_RE = /^(quality_audit|or_debug|start_stop_play|studio_playtest|get_console_output|audit_script_errors|script_analysis|playtest_)/;
  function gate(level, runTools, state, extras) {
    const lvl = normalize(level);
    const st = state || {};
    const bare = [...(runTools || [])];
    const e = cleanExtras(extras);
    const wantVerify = atLeast(lvl, "high") || !!e.boost.readback, wantAudit = lvl === "ultimate" || !!e.boost.proof || !!e.boost.audit, wantReview = atLeast(lvl, "max") || !!e.boost.review || !!e.boost.critique;
    if (!bare.length || !(wantVerify || wantAudit || wantReview)) return null;
    const mutated = bare.some((b) => MUTATE_RE.test(b));
    const verified = bare.some((b) => VERIFY_RE.test(b));
    const audited = bare.some((b) => AUDIT_RE.test(b));
    if (wantVerify && mutated && !verified && !st.verify) {
      return { id: "verify", text: `━━━ REASONING EFFORT ${lvl.toUpperCase()} - VERIFY (System note from OR, not the user) ━━━\nYou changed things in this run but never read the result back. Before the final answer: read back what you changed (script_read / inspect_instance / or_screenshot as fits), fix what is wrong, then report with that evidence. Do not acknowledge this note; do it.` };
    }
    if (wantAudit && mutated && !audited && !st.audit) {
      return { id: "audit", text: `━━━ REASONING EFFORT ULTIMATE - PROVE IT (System note from OR, not the user) ━━━\nUltimate effort means nothing ships unproven: run start_stop_play + get_console_output (or or_debug) and, if available, quality_audit / script_analysis on what you built; fix every error or warning they report, then re-check once. Only then the final report, citing the clean result.` };
    }
    if (wantReview && mutated && !st.review) {
      return { id: "review", text: `━━━ REASONING EFFORT ${lvl.toUpperCase()} - FINAL REVIEW (System note from OR, not the user) ━━━\nBefore you finish: list ${lvl === "ultimate" ? "five" : "three"} concrete ways this work could still fail (Play vs Edit, respawn, mobile, two players, missing instances, nil access, race conditions, performance). For each: fix it with a command now, or state in one line why it cannot happen here with evidence you already read. Then the final report.` };
    }
    return null;
  }

  const api = {
    PROFILE_KEYS, VERSION: "1.63.0", LEVELS, LEVEL_IDS, PROVIDERS, FOCUS, FOCUS_IDS, BOOST_TEXT, normalize, levelOf, rank, atLeast, providerOf, hasNative, modeFor, table, apply, gate, cleanExtras, effectiveProfile, promptExtras, extrasCount, _test: { pressed, shortLabel, findControl } };
  try { window.ORReasoning = api; } catch {}
  try { if (typeof module !== "undefined" && module.exports) module.exports = api; } catch {}
})();
