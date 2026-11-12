/* TotalScript Template Creator — save what you ask for often, run it with one click.
 *
 * 1.73.0. The templates button opens this full-screen window instead of the
 * old tray. Left: your templates (search, Run, Edit, more). Right: the creator
 * - a name, what it does, the prompt with {{blanks}} (detected live and turned
 * into a fill-in form at run time), optional ordered steps, and an Advanced
 * drawer for the rest (environment, tags, execution level, per-step Studio
 * command, version history). "Draft with AI" turns one sentence into a draft
 * through the same visible round trip as the Prompt Enhancer; nothing is saved
 * until Save is pressed. Storage is the existing TotalTemplateRegistry
 * (user-owned, versioned, this browser only) - every template made here opens
 * in the classic tray too and vice versa.
 *
 * Public API (window.TotalTemplateCreator):
 *   open(hooks, opts)  hooks = {
 *     registry                       // TotalTemplateRegistry (or a compatible stub)
 *     commandRegistry() -> TotalCommandRegistry | null   // validation context
 *     examples() -> [{id,title,blurb,brief,body,commands}] // TotalTemplates.list()
 *     run(templateId, values) -> Promise                  // main.js runTemplateCard with preset blanks
 *     draft(sentence, opts, onStatus) -> Promise<{draft}>  // main.js draftTemplateViaAI
 *     openTray(tab)                  // classic tray (Tasks · Activity · Session · Public Skills)
 *     engine() -> "roblox"|"local", providerName(), toast(msg), diag(event, data), confirm(msg)
 *   }
 *   opts = { mount } (render inside the Templates window) · { templateId } (edit) · { example } · { draft } (prefill)
 *   close(), isOpen(), state(), detectBlanks(text), formToTemplate(form), templateToForm(template)
 */
(() => {
  "use strict";
  if (window.TotalTemplateCreator) return;

  const SVG = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    play: SVG('<path d="M7 5l12 7-12 7z"/>'),
    edit: SVG('<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M13 7l3 3"/>'),
    copy: SVG('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    out: SVG('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 21h14"/>'),
    archive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>'),
    trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    spark: SVG('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
    save: SVG('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'),
    up: SVG('<path d="M6 15l6-6 6 6"/>'),
    down: SVG('<path d="M6 9l6 6 6-6"/>'),
    x: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    list: SVG('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
    file: SVG('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'),
  };
  const CATEGORIES = ["Building", "UI", "Scripting", "Systems", "Gameplay", "VFX", "Animation", "Planning", "Custom"];
  const ENVS = [["ROBLOX_STUDIO", "Roblox Studio"], ["GENERAL", "Any AI chat"], ["BLENDER", "Blender"], ["WEB", "Web"]];
  const LEVELS = [["READ", "Read - just asks / inspects"], ["WRITE", "Write - changes the place (asks before running)"], ["PUBLISH", "Publish - ships / saves (asks before running)"]];
  const EXAMPLE_CATEGORY = { hud: "UI", shop: "Systems", tool: "Gameplay", door: "Building", leaderboard: "Systems", npc: "Gameplay", obby: "Building", vfx: "VFX" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const BLANK_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

  // ── pure helpers (exported for tests) ─────────────────────────────────────
  function detectBlanks(text) { const out = []; for (const m of String(text || "").matchAll(BLANK_RE)) if (!out.includes(m[1])) out.push(m[1]); return out; }
  function blankForm(f) { return [f.prompt, ...(f.steps || []).map((s) => s.text + " " + (s.params || ""))].join("\n"); }
  function emptyForm() { return { id: null, name: "", description: "", category: "Custom", prompt: "", blanks: [], steps: [], environment: "ROBLOX_STUDIO", tags: "", executionLevel: "READ", versions: [], currentVersion: 0 }; }
  function syncBlanks(f, meta) {
    const names = detectBlanks(blankForm(f));
    const prev = new Map((f.blanks || []).map((b) => [b.name, b]));
    f.blanks = names.map((n) => prev.get(n) || (meta && meta.get(n)) || { name: n, question: n.replace(/_/g, " "), default: "", required: true });
    return f;
  }
  function parseParams(text) {
    const t = String(text || "").trim(); if (!t) return {};
    const j = JSON.parse(t); if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("parameters must be a JSON object");
    return j;
  }
  function formToTemplate(f) {
    const steps = (f.steps || []).map((s) => ({ text: String(s.text || "").trim(), command: String(s.command || "").trim(), params: String(s.params || "").trim() })).filter((s) => s.text || s.command);
    const hasCommand = steps.some((s) => s.command);
    const t = {
      name: String(f.name || "").trim(),
      description: String(f.description || "").trim(),
      category: String(f.category || "").trim() || "Custom",
      type: hasCommand ? "workflow" : steps.length ? "workflow" : "prompt",
      environment: f.environment || "ROBLOX_STUDIO",
      tags: String(f.tags || ""),
      instructions: String(f.prompt || "").trim(),
      variables: (f.blanks || []).map((b) => ({ name: b.name, type: "string", description: String(b.question || "").trim(), default: String(b.default == null ? "" : b.default), required: b.required !== false })),
      workflow: steps.map((s, i) => ({ id: `step-${i + 1}`, title: (s.text || s.command).slice(0, 160), instruction: s.text, command: s.command, parameters: s.command ? parseParams(s.params) : {}, errorBehavior: "STOP", dependsOn: i ? [`step-${i}`] : [] })),
      commands: [],
      executionLevel: f.executionLevel || "READ",
    };
    if (f.id) t.id = f.id;
    return t;
  }
  function templateToForm(t) {
    const f = emptyForm();
    if (!t) return f;
    f.id = t.id || null; f.name = t.name || ""; f.description = t.description || ""; f.category = t.category || "Custom";
    f.prompt = Array.isArray(t.instructions) ? t.instructions.join("\n") : String(t.instructions || "");
    f.environment = t.environment || "ROBLOX_STUDIO"; f.tags = Array.isArray(t.tags) ? t.tags.join(", ") : String(t.tags || ""); f.executionLevel = t.executionLevel || "READ";
    f.blanks = (t.variables || []).map((v) => ({ name: v.name, question: v.description || v.name.replace(/_/g, " "), default: v.default == null ? "" : String(v.default), required: v.required !== false }));
    const steps = Array.isArray(t.workflow) && t.workflow.length ? t.workflow : (t.commands || []).map((c) => ({ instruction: "", command: c.command, parameters: c.parameters }));
    f.steps = steps.map((w) => ({ text: w.instruction || (w.command ? "" : w.title) || "", command: w.command || "", params: w.parameters && Object.keys(w.parameters).length ? JSON.stringify(w.parameters) : "" }));
    f.versions = Array.isArray(t.versions) ? t.versions.map((v) => ({ version: v.version, name: v.name, savedAt: v.savedAt || v.updatedAt || "" })) : [];
    f.currentVersion = t.currentVersion || 0;
    return f;
  }
  function exampleToForm(ex) {
    const f = emptyForm();
    f.name = ex.title || ex.id; f.description = ex.blurb || ""; f.category = EXAMPLE_CATEGORY[ex.id] || "Custom";
    f.prompt = [ex.brief, ex.body].filter(Boolean).join("\n");
    f.environment = "ROBLOX_STUDIO"; f.tags = (ex.commands || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ");
    return f;
  }
  function draftToForm(d) {
    const f = emptyForm();
    f.name = d.name || ""; f.description = d.description || ""; f.category = d.category || "Custom"; f.prompt = d.prompt || "";
    f.blanks = (d.blanks || []).map((b) => ({ name: b.name, question: b.question || b.name, default: b.default || "", required: b.required !== false }));
    f.steps = (d.steps || []).map((s) => ({ text: s, command: "", params: "" }));
    return syncBlanks(f);
  }

  // ── state ─────────────────────────────────────────────────────────────────
  const S = { open: false, embedded: false, hooks: {}, form: emptyForm(), dirty: false, advanced: false, query: "", archived: false, busy: false, cancelled: false, blankMeta: new Map(), runFor: null, sentence: "" };
  let D = null;
  const diag = (e, d) => { try { S.hooks.diag && S.hooks.diag("tcreator." + e, d || {}); } catch {} };
  const toast = (m) => { try { S.hooks.toast ? S.hooks.toast(m) : console.log("[tcreator]", m); } catch {} };
  const reg = () => S.hooks.registry || window.TotalTemplateRegistry;
  const confirmIt = (m) => { try { return S.hooks.confirm ? S.hooks.confirm(m) : window.confirm(m); } catch { return false; } };
  const download = (filename, data) => { try { const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } catch {} };

  // ── build ─────────────────────────────────────────────────────────────────
  function build(mount) {
    const host = document.createElement("div"); host.id = "rs-tcreator"; host.setAttribute("role", mount ? "region" : "dialog"); host.setAttribute("aria-label", "TotalScript Template Creator"); host.tabIndex = -1;
    if (mount) host.classList.add("rst-embedded");
    const logo = (window.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("assets/icon128.png") : "";
    host.innerHTML = `
      <div class="rst-shell">
        <div class="rst-title">
          <span class="rst-brand"><img class="rst-logo" alt="" src="${esc(logo)}">Template Creator</span>
          <span class="rst-sub">Save what you ask for often. Run it with one click.</span>
          <div class="rst-title-actions">
            <button type="button" class="rst-tb" data-act="tray" title="Open the classic tray: Tasks · Activity · Session · Public Skills">${I.list}<span>Tasks · Activity · Session</span></button>
            <button type="button" class="rst-tb" data-act="import" title="Import a .totalscript-template.json file">${I.file}<span>Import</span></button>
            <button type="button" class="rst-tb" data-act="exportAll" title="Export all templates as one .json">${I.out}<span>Export all</span></button>
            <button type="button" class="rst-ib rst-close" data-act="close" title="Close (Esc)">${I.close}</button>
          </div>
        </div>
        <div class="rst-body">
          <aside class="rst-side">
            <div class="rst-side-head">
              <h4>My templates <span class="rst-count"></span></h4>
              <button type="button" class="rst-btn primary rst-new" data-act="new">${I.plus}<span>New template</span></button>
            </div>
            <div class="rst-side-tools">
              <input type="search" class="rst-search" placeholder="Search your templates" spellcheck="false">
              <label class="rst-check" title="Show archived templates"><input type="checkbox" class="rst-archived"> Archived</label>
            </div>
            <div class="rst-list" role="list"></div>
            <div class="rst-examples">
              <h5>Start from an example</h5>
              <div class="rst-example-chips"></div>
            </div>
          </aside>
          <section class="rst-main">
            <div class="rst-ai">
              <span class="rst-ai-label">${I.spark} Draft with AI</span>
              <input type="text" class="rst-sentence" placeholder="Describe it in one sentence, e.g. a shop template where I pick the item list and the currency">
              <button type="button" class="rst-btn primary rst-draft" data-act="draft">${I.spark}<span>Draft</span></button>
              <button type="button" class="rst-btn rst-draft-cancel" data-act="cancelDraft" hidden>${I.x}<span>Cancel</span></button>
            </div>
            <div class="rst-ai-status" aria-live="polite"></div>
            <form class="rst-form" autocomplete="off">
              <div class="rst-form-head"><h4 class="rst-form-title">New template</h4><span class="rst-form-meta"></span><button type="button" class="rst-link rst-adv" data-act="advanced" aria-pressed="false">Advanced</button></div>
              <div class="rst-grid2">
                <label class="rst-field"><span>Name</span><input type="text" name="name" maxlength="120" placeholder="e.g. Shop with currency" required></label>
                <label class="rst-field"><span>Category</span><input type="text" name="category" list="rst-cats" maxlength="80" placeholder="Custom"><datalist id="rst-cats">${CATEGORIES.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
              </div>
              <label class="rst-field"><span>What does it do? <small>one line, shown on the card</small></span><input type="text" name="description" maxlength="200" placeholder="e.g. Builds a complete shop UI + server purchase flow for the items I list"></label>
              <label class="rst-field rst-prompt-field"><span>The prompt <small>write <code>{{blank}}</code> for anything you want to fill in when you run it</small></span><textarea name="prompt" rows="9" placeholder="e.g. Build a {{item_count}}-item shop in StarterGui named {{shop_name}} with a {{currency}} currency… verified with a playtest and a screenshot."></textarea></label>
              <div class="rst-blanks">
                <h5>Blanks <small>asked when you press Run</small></h5>
                <div class="rst-blank-rows"></div>
                <div class="rst-blank-empty">No blanks yet - type <code>{{something}}</code> in the prompt and it appears here.</div>
              </div>
              <div class="rst-steps">
                <h5>Steps <small>optional - the agent follows them in order</small><button type="button" class="rst-link" data-act="addStep">${I.plus} Add step</button></h5>
                <div class="rst-step-rows"></div>
              </div>
              <div class="rst-advanced" hidden>
                <div class="rst-grid2">
                  <label class="rst-field"><span>Runs in</span><select name="environment">${ENVS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
                  <label class="rst-field"><span>Execution level</span><select name="executionLevel">${LEVELS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
                </div>
                <label class="rst-field"><span>Tags <small>comma separated</small></span><input type="text" name="tags" placeholder="shop, ui, currency"></label>
                <div class="rst-versions" hidden><h5>Versions</h5><div class="rst-version-rows"></div></div>
                <div class="rst-adv-note">Steps can also carry a Studio command (exact command name + JSON parameters) - then Run executes those steps directly and sends the rest to the AI.</div>
              </div>
              <div class="rst-form-actions">
                <button type="submit" class="rst-btn primary rst-save">${I.save}<span>Save</span></button>
                <button type="button" class="rst-btn rst-save-run" data-act="saveRun">${I.play}<span>Save & Run</span></button>
                <button type="button" class="rst-btn rst-discard" data-act="discard">Discard</button>
                <span class="rst-form-status" aria-live="polite"></span>
              </div>
            </form>
          </section>
        </div>
        <div class="rst-run" hidden>
          <div class="rst-run-card">
            <h4>Run <span class="rst-run-name"></span></h4>
            <p class="rst-run-desc"></p>
            <div class="rst-run-fields"></div>
            <div class="rst-run-preview"><h5>What will be sent</h5><pre></pre></div>
            <div class="rst-run-actions"><button type="button" class="rst-btn" data-act="runCancel">Back</button><button type="button" class="rst-btn primary" data-act="runGo">${I.play}<span>Run</span></button></div>
            <div class="rst-run-status"></div>
          </div>
        </div>
        <input type="file" class="rst-file" accept=".json,.totalscript-template.json" hidden>
      </div>`;
    (mount || document.documentElement).appendChild(host);
    const q = (s) => host.querySelector(s);
    D = { host, count: q(".rst-count"), search: q(".rst-search"), archived: q(".rst-archived"), list: q(".rst-list"), chips: q(".rst-example-chips"), sentence: q(".rst-sentence"), draft: q(".rst-draft"), draftCancel: q(".rst-draft-cancel"), aiStatus: q(".rst-ai-status"),
      form: q(".rst-form"), formTitle: q(".rst-form-title"), formMeta: q(".rst-form-meta"), adv: q(".rst-adv"), advanced: q(".rst-advanced"), blankRows: q(".rst-blank-rows"), blankEmpty: q(".rst-blank-empty"), stepRows: q(".rst-step-rows"), versions: q(".rst-versions"), versionRows: q(".rst-version-rows"), status: q(".rst-form-status"), save: q(".rst-save"), saveRun: q(".rst-save-run"),
      run: q(".rst-run"), runName: q(".rst-run-name"), runDesc: q(".rst-run-desc"), runFields: q(".rst-run-fields"), runPreview: q(".rst-run-preview pre"), runStatus: q(".rst-run-status"), file: q(".rst-file") };

    host.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (a) { e.preventDefault(); act(a.dataset.act, a); return; }
      if (e.target === D.run) { D.run.hidden = true; return; }
      if (e.target === host) close();
    });
    D.form.addEventListener("submit", (e) => { e.preventDefault(); save(false); });
    D.form.addEventListener("input", (e) => {
      const t = e.target; if (!t || !t.name && !t.dataset.blank && !t.dataset.step) return;
      readForm(); S.dirty = true;
      if (t.name === "prompt" || t.dataset.step) renderBlanks();
      setStatus("");
    });
    D.form.addEventListener("change", () => { readForm(); S.dirty = true; });
    D.search.addEventListener("input", () => { S.query = D.search.value; renderList(); });
    D.archived.addEventListener("change", () => { S.archived = D.archived.checked; renderList(); });
    D.sentence.addEventListener("input", () => { S.sentence = D.sentence.value; });
    D.sentence.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); act("draft"); } });
    D.file.addEventListener("change", async () => { const f = D.file.files && D.file.files[0]; D.file.value = ""; if (!f) return; try { const r = await reg().importTemplate(await f.text()); toast(r.success ? "Template imported" : `${r.error.code}: ${r.error.message}`); renderList(); } catch (err) { toast("Import failed: " + String(err && err.message || err)); } });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!D.run.hidden) D.run.hidden = true; else if (S.busy) act("cancelDraft"); else close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (!D.run.hidden) act("runGo"); else save(false); }
    });
    try { window.addEventListener("total-templates-synced", () => { if (S.open) renderList(); }); } catch {}
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function templates() { const R = reg(); if (!R) return []; try { return R.searchTemplates(S.query, S.archived ? { archived: true } : {}); } catch { return []; } }
  function renderList() {
    if (!D) return;
    const items = templates();
    D.count.textContent = String(items.length);
    if (!items.length) { D.list.innerHTML = `<div class="rst-empty"><b>${S.query ? "No templates match" : S.archived ? "Nothing archived" : "No templates yet"}</b><span>${S.query ? "Try another word." : "Fill the form on the right, start from an example below, or let the AI draft one from a sentence."}</span></div>`; return; }
    D.list.innerHTML = items.map((t) => {
      const blanks = (t.variables || []).length, steps = (t.workflow || []).length, on = S.form.id === t.id;
      return `<div class="rst-card${on ? " on" : ""}" role="listitem" data-id="${esc(t.id)}">
        <div class="rst-card-main" data-act="edit" data-id="${esc(t.id)}">
          <div class="rst-card-top"><b>${esc(t.name)}</b><span class="rst-badge">${esc(t.category)}</span></div>
          <p>${esc(t.description || (t.instructions || []).join(" ").slice(0, 120) || "No description")}</p>
          <div class="rst-card-meta">${blanks ? `<span>${blanks} blank${blanks === 1 ? "" : "s"}</span>` : ""}${steps ? `<span>${steps} step${steps === 1 ? "" : "s"}</span>` : ""}<span>v${t.currentVersion || 1}</span>${t.environment && t.environment !== "ROBLOX_STUDIO" ? `<span>${esc(t.environment === "GENERAL" ? "any chat" : t.environment.toLowerCase())}</span>` : ""}</div>
        </div>
        <div class="rst-card-actions">
          <button type="button" class="rst-btn small primary" data-act="run" data-id="${esc(t.id)}" title="Run - fill the blanks, send it">${I.play}<span>Run</span></button>
          <button type="button" class="rst-ib" data-act="edit" data-id="${esc(t.id)}" title="Edit">${I.edit}</button>
          <button type="button" class="rst-ib" data-act="duplicate" data-id="${esc(t.id)}" title="Duplicate">${I.copy}</button>
          <button type="button" class="rst-ib" data-act="export" data-id="${esc(t.id)}" title="Export .json">${I.out}</button>
          <button type="button" class="rst-ib" data-act="archive" data-id="${esc(t.id)}" title="${t.archived ? "Restore" : "Archive"}">${I.archive}</button>
          <button type="button" class="rst-ib danger" data-act="delete" data-id="${esc(t.id)}" title="Delete">${I.trash}</button>
        </div>
      </div>`;
    }).join("");
  }
  function renderExamples() {
    let ex = []; try { ex = (S.hooks.examples && S.hooks.examples()) || []; } catch {}
    D.chips.innerHTML = ex.length ? ex.map((x) => `<button type="button" class="rst-chip" data-act="example" data-id="${esc(x.id)}" title="${esc(x.blurb || "")}">${esc(x.title || x.id)}</button>`).join("") : `<span class="rst-muted">No examples available</span>`;
    D.chips.parentElement.hidden = !ex.length;
  }
  function renderForm() {
    const f = S.form, el = D.form.elements;
    el.name.value = f.name; el.category.value = f.category; el.description.value = f.description; el.prompt.value = f.prompt;
    el.environment.value = f.environment; el.executionLevel.value = f.executionLevel; el.tags.value = f.tags;
    D.formTitle.textContent = f.id ? `Edit: ${f.name || "template"}` : "New template";
    D.formMeta.textContent = f.id ? `v${f.currentVersion || 1} · saving makes v${(f.currentVersion || 1) + 1}` : "";
    D.save.querySelector("span").textContent = f.id ? "Save new version" : "Save";
    D.advanced.hidden = !S.advanced; D.adv.setAttribute("aria-pressed", String(S.advanced)); D.adv.textContent = S.advanced ? "Simple" : "Advanced";
    renderSteps(); renderBlanks(); renderVersions();
    renderList();
  }
  function renderBlanks() {
    syncBlanks(S.form, S.blankMeta);
    const rows = S.form.blanks;
    D.blankEmpty.hidden = !!rows.length;
    D.blankRows.innerHTML = rows.map((b, i) => `<div class="rst-blank-row" data-blank-row="${i}">
      <code class="rst-blank-name">{{${esc(b.name)}}}</code>
      <input type="text" data-blank="question" data-i="${i}" value="${esc(b.question)}" placeholder="Question to ask" aria-label="Question for ${esc(b.name)}">
      <input type="text" data-blank="default" data-i="${i}" value="${esc(b.default)}" placeholder="Default (optional)" aria-label="Default for ${esc(b.name)}">
      <label class="rst-check" title="Must be filled before running"><input type="checkbox" data-blank="required" data-i="${i}" ${b.required ? "checked" : ""}> required</label>
    </div>`).join("");
  }
  function renderSteps() {
    const steps = S.form.steps;
    D.stepRows.innerHTML = steps.map((s, i) => `<div class="rst-step-row" data-step-row="${i}">
      <span class="rst-step-n">${i + 1}</span>
      <div class="rst-step-fields">
        <input type="text" data-step="text" data-i="${i}" value="${esc(s.text)}" placeholder="What should happen in this step?" aria-label="Step ${i + 1}">
        <div class="rst-step-adv"${S.advanced ? "" : " hidden"}><input type="text" data-step="command" data-i="${i}" value="${esc(s.command)}" placeholder="Studio command (optional, exact name)" aria-label="Command for step ${i + 1}"><input type="text" data-step="params" data-i="${i}" value="${esc(s.params)}" placeholder='{"path":"{{shop_path}}"}' aria-label="Parameters for step ${i + 1}"></div>
      </div>
      <div class="rst-step-tools"><button type="button" class="rst-ib" data-act="stepUp" data-i="${i}" title="Move up" ${i ? "" : "disabled"}>${I.up}</button><button type="button" class="rst-ib" data-act="stepDown" data-i="${i}" title="Move down" ${i < steps.length - 1 ? "" : "disabled"}>${I.down}</button><button type="button" class="rst-ib danger" data-act="stepRemove" data-i="${i}" title="Remove step">${I.x}</button></div>
    </div>`).join("");
  }
  function renderVersions() {
    const v = S.form.versions || [];
    D.versions.hidden = !(S.form.id && v.length > 1);
    D.versionRows.innerHTML = v.slice().reverse().map((x) => `<div class="rst-version-row"><b>v${x.version}</b><span>${esc(x.name || "")}</span>${x.version === S.form.currentVersion ? '<em>current</em>' : `<button type="button" class="rst-link" data-act="restore" data-v="${x.version}">Restore as new version</button>`}</div>`).join("");
  }
  function readForm() {
    const f = S.form, el = D.form.elements;
    f.name = el.name.value; f.category = el.category.value; f.description = el.description.value; f.prompt = el.prompt.value;
    f.environment = el.environment.value; f.executionLevel = el.executionLevel.value; f.tags = el.tags.value;
    D.form.querySelectorAll("[data-blank]").forEach((inp) => { const b = f.blanks[+inp.dataset.i]; if (!b) return; const k = inp.dataset.blank; b[k] = k === "required" ? inp.checked : inp.value; S.blankMeta.set(b.name, Object.assign({}, b)); });
    D.form.querySelectorAll("[data-step]").forEach((inp) => { const s = f.steps[+inp.dataset.i]; if (s) s[inp.dataset.step] = inp.value; });
  }
  function setStatus(m, kind) { D.status.textContent = m || ""; D.status.dataset.kind = kind || ""; }
  function setAiStatus(m, kind) { D.aiStatus.textContent = m || ""; D.aiStatus.dataset.kind = kind || ""; }

  // ── actions ───────────────────────────────────────────────────────────────
  function loadForm(f, reason) { S.form = f; S.dirty = false; renderForm(); setStatus(""); diag("load", { reason, id: f.id || null }); }
  function discardOk() { return !S.dirty || confirmIt("Discard the unsaved changes in the form?"); }
  async function act(name, btn) {
    const id = btn && btn.dataset.id, R = reg();
    switch (name) {
      case "close": return close();
      case "tray": { close(); try { S.hooks.openTray && S.hooks.openTray("tasks"); } catch {} return; }
      case "import": return D.file.click();
      case "exportAll": { const r = R.exportAllTemplates(); if (!r.success) return toast("Export failed"); if (!r.data.templates.length) return toast("No templates to export"); download(r.filename, r.data); toast(`Exported ${r.data.templates.length} templates`); return; }
      case "new": if (!discardOk()) return; loadForm(emptyForm(), "new"); D.form.elements.name.focus(); return;
      case "example": { if (!discardOk()) return; let ex = []; try { ex = S.hooks.examples() || []; } catch {} const x = ex.find((e) => e.id === id); if (!x) return; loadForm(exampleToForm(x), "example:" + id); S.dirty = true; toast(`Example "${x.title}" loaded - make it yours, then Save`); return; }
      case "edit": { if (S.form.id !== id && !discardOk()) return; const t = R.getTemplate(id); if (!t) return toast("Template not found"); loadForm(templateToForm(t), "edit"); return; }
      case "duplicate": { const r = await R.duplicateTemplate(id); if (r && r.success) { toast("Template copied"); renderList(); } else toast("Copy failed"); return; }
      case "export": { const r = R.exportTemplate(id); if (!r.success) return toast(`${r.error.code}: ${r.error.message}`); download(r.filename, r.data); toast("Template exported"); return; }
      case "archive": { const t = R.getTemplate(id); if (!t) return; await R.archiveTemplate(id, !t.archived); toast(t.archived ? "Template restored" : "Template archived"); renderList(); return; }
      case "delete": { const t = R.getTemplate(id); if (!t) return; if (!confirmIt(`Delete "${t.name}" and all of its versions?`)) return; await R.deleteTemplate(id); if (S.form.id === id) loadForm(emptyForm(), "deleted"); toast("Template deleted"); renderList(); return; }
      case "run": { const t = R.getTemplate(id); if (!t) return toast("Template not found"); openRun(t); return; }
      case "advanced": S.advanced = !S.advanced; readForm(); renderForm(); return;
      case "addStep": readForm(); S.form.steps.push({ text: "", command: "", params: "" }); S.dirty = true; renderSteps(); { const last = D.stepRows.querySelector(`[data-step="text"][data-i="${S.form.steps.length - 1}"]`); if (last) last.focus(); } return;
      case "stepRemove": readForm(); S.form.steps.splice(+btn.dataset.i, 1); S.dirty = true; renderSteps(); renderBlanks(); return;
      case "stepUp": case "stepDown": { readForm(); const i = +btn.dataset.i, j = name === "stepUp" ? i - 1 : i + 1; const st = S.form.steps; if (j < 0 || j >= st.length) return; [st[i], st[j]] = [st[j], st[i]]; S.dirty = true; renderSteps(); return; }
      case "restore": { const v = +btn.dataset.v; if (!confirmIt(`Restore v${v} as a new version?`)) return; const r = await R.restoreVersion(S.form.id, v); if (r && r.success) { loadForm(templateToForm(R.getTemplate(r.template.id)), "restore"); toast(`Restored v${v} as v${r.template.currentVersion}`); } else toast("Restore failed"); return; }
      case "discard": if (!discardOk()) return; loadForm(S.form.id ? templateToForm(R.getTemplate(S.form.id)) : emptyForm(), "discard"); return;
      case "saveRun": return save(true);
      case "draft": return runDraft();
      case "cancelDraft": if (S.busy) { S.cancelled = true; setAiStatus("Cancelling…", "warn"); } return;
      case "runCancel": D.run.hidden = true; return;
      case "runGo": return runGo();
    }
  }

  async function save(andRun) {
    readForm();
    const R = reg();
    let t;
    try { t = formToTemplate(S.form); } catch (e) { setStatus("Step parameters: " + String(e && e.message || e), "err"); return null; }
    if (!t.name) { setStatus("Give it a name.", "err"); D.form.elements.name.focus(); return null; }
    if (!t.instructions && !t.workflow.length) { setStatus("Write the prompt (or at least one step).", "err"); D.form.elements.prompt.focus(); return null; }
    let ctx = null; try { ctx = { registry: S.hooks.commandRegistry ? S.hooks.commandRegistry() : window.TotalCommandRegistry }; } catch { ctx = {}; }
    const audit = R.validateTemplate(t, ctx);
    if (!audit.success) { setStatus(audit.errors.map((x) => x.message).join(" · "), "err"); return null; }
    D.save.disabled = true; setStatus("Saving…");
    try {
      const r = S.form.id ? await R.updateTemplate(S.form.id, t) : await R.createTemplate(t);
      if (!r || !r.success) { setStatus(`${(r && r.error && r.error.code) || "TEMPLATE_SAVE_FAILED"}: ${(r && r.error && r.error.message) || "could not save"}`, "err"); return null; }
      const saved = R.getTemplate(r.template.id);
      if (!saved) { setStatus("TEMPLATE_SAVE_FAILED: the saved template could not be read back.", "err"); return null; }
      loadForm(templateToForm(saved), "saved");
      const warn = (audit.warnings || []).filter((x) => x.code !== "MISSING_EXPECTED_RESULT").map((x) => x.message).join(" · "); // expected result is an optional advanced field, not a form error
      setStatus(`Saved ${saved.name} v${saved.currentVersion}${warn ? " · " + warn : ""}`, "ok");
      toast(`Template saved: ${saved.name}`);
      diag("saved", { id: saved.id, version: saved.currentVersion, blanks: saved.variables.length, steps: saved.workflow.length, andRun: !!andRun });
      if (andRun) openRun(saved);
      return saved;
    } catch (e) { setStatus("TEMPLATE_SAVE_FAILED: " + String(e && e.message || e), "err"); return null; }
    finally { D.save.disabled = false; }
  }

  // ── run (fill the blanks) ─────────────────────────────────────────────────
  function openRun(t) {
    S.runFor = t;
    D.runName.textContent = t.name; D.runDesc.textContent = t.description || "";
    const vars = t.variables || [];
    D.runFields.innerHTML = vars.length ? vars.map((v) => `<label class="rst-field"><span>${esc(v.description || v.name.replace(/_/g, " "))}${v.required ? "" : " <small>optional</small>"}</span><input type="text" data-run-var="${esc(v.name)}" value="${esc(v.default == null ? "" : v.default)}" placeholder="{{${esc(v.name)}}}"></label>`).join("") : `<div class="rst-muted">No blanks to fill - press Run.</div>`;
    D.runStatus.textContent = "";
    const refresh = () => { D.runPreview.textContent = previewText(t, runValues()); };
    D.runFields.querySelectorAll("[data-run-var]").forEach((inp) => inp.addEventListener("input", refresh));
    refresh();
    D.run.hidden = false;
    const first = D.runFields.querySelector("[data-run-var]"); if (first) first.focus();
    diag("runOpen", { id: t.id, blanks: vars.length });
  }
  function runValues() { const o = {}; D.runFields.querySelectorAll("[data-run-var]").forEach((inp) => { o[inp.dataset.runVar] = inp.value; }); return o; }
  function previewText(t, values) {
    const sub = (s) => String(s || "").replace(BLANK_RE, (_, k) => { const v = values[k]; const d = (t.variables || []).find((x) => x.name === k); return v !== undefined && v !== "" ? v : (d && d.default) || `{{${k}}}`; });
    const lines = [sub((t.instructions || []).join("\n"))];
    const steps = (t.workflow || []).filter((w) => w.instruction || w.command);
    if (steps.length) lines.push("", ...steps.map((w, i) => `${i + 1}. ${sub(w.instruction || w.title)}${w.command ? `  [${w.command}]` : ""}`));
    return lines.join("\n").trim();
  }
  async function runGo() {
    const t = S.runFor; if (!t) return;
    const values = runValues();
    const missing = (t.variables || []).filter((v) => v.required && !String(values[v.name] || "").trim() && !String(v.default || "").trim()).map((v) => v.name);
    if (missing.length) { D.runStatus.textContent = "Fill in: " + missing.map((m) => `{{${m}}}`).join(", "); D.runStatus.dataset.kind = "err"; return; }
    for (const v of t.variables || []) if (!String(values[v.name] || "").trim()) values[v.name] = v.default == null ? "" : String(v.default);
    D.runStatus.textContent = "Running…"; D.runStatus.dataset.kind = "";
    try {
      const r = await S.hooks.run(t.id, values);
      diag("run", { id: t.id, ok: r !== false });
      if (r === false) { D.runStatus.textContent = "Not run - see the bar for the reason."; D.runStatus.dataset.kind = "err"; return; }
      D.run.hidden = true; close();
    } catch (e) { D.runStatus.textContent = "Run failed: " + String(e && e.message || e); D.runStatus.dataset.kind = "err"; }
  }

  // ── Draft with AI ─────────────────────────────────────────────────────────
  async function runDraft() {
    const sentence = String(S.sentence || "").trim();
    if (!sentence) { setAiStatus("Describe the template in one sentence first.", "warn"); D.sentence.focus(); return; }
    if (S.busy || !S.hooks.draft) return;
    if (!discardOk()) return;
    S.busy = true; S.cancelled = false; D.draft.hidden = true; D.draftCancel.hidden = false; D.sentence.disabled = true;
    setAiStatus("Preparing the draft request…");
    const t0 = Date.now();
    try {
      const r = await S.hooks.draft(sentence, { cancelled: () => S.cancelled }, (m) => setAiStatus(m));
      if (S.cancelled) { setAiStatus("Cancelled.", "warn"); return; }
      if (!r || !r.draft) throw new Error("the AI returned nothing usable");
      loadForm(draftToForm(r.draft), "draft"); S.dirty = true;
      setAiStatus(`Draft ready in ${Math.round((Date.now() - t0) / 100) / 10}s - review every field, then Save.`, "ok");
      diag("draft", { ms: Date.now() - t0, blanks: S.form.blanks.length, steps: S.form.steps.length });
      D.form.elements.name.focus();
    } catch (e) {
      setAiStatus(S.cancelled ? "Cancelled." : "Draft failed: " + String(e && e.message || e), S.cancelled ? "warn" : "err");
      diag("draftFail", { err: String(e && e.message || e).slice(0, 200) });
    } finally { S.busy = false; S.cancelled = false; D.draft.hidden = false; D.draftCancel.hidden = true; D.sentence.disabled = false; }
  }

  // ── open / close ──────────────────────────────────────────────────────────
  // opts.mount: render INSIDE that element (the Templates window's Library tab)
  // instead of as a stand-alone full-screen dialog; the host element is kept
  // across re-mounts so the form (and an unsaved draft) survives.
  function open(hooks, opts) {
    S.hooks = hooks || S.hooks || {};
    const o = opts || {};
    // Already open in this very slot and nothing new to load (the host window
    // re-rendered its rail): leave the form and the focus alone.
    if (S.open && S.embedded && o.mount && D && D.host.parentElement === o.mount && !o.templateId && !o.draft && !o.example) return;
    if (!D) build(o.mount || null);
    else if (o.mount && D.host.parentElement !== o.mount) { D.host.classList.add("rst-embedded"); o.mount.appendChild(D.host); }
    else if (!o.mount && D.host.classList.contains("rst-embedded")) { D.host.classList.remove("rst-embedded"); document.documentElement.appendChild(D.host); }
    S.embedded = !!o.mount;
    const R = reg();
    const ready = R && typeof R.initialize === "function" ? Promise.resolve(R.initialize()).catch(() => null) : Promise.resolve();
    S.open = true; D.host.classList.add("open"); if (!S.embedded) document.documentElement.classList.add("rs-tcreator-open");
    const name = (S.hooks.providerName && S.hooks.providerName()) || "the AI";
    D.draft.querySelector("span").textContent = "Draft with " + name;
    D.draft.disabled = !S.hooks.draft; D.sentence.disabled = !S.hooks.draft; if (!S.hooks.draft) D.sentence.placeholder = "Draft with AI is unavailable here";
    renderExamples();
    if (o.templateId && R) { const t = R.getTemplate(o.templateId); if (t) loadForm(templateToForm(t), "open:edit"); }
    else if (o.draft) { loadForm(draftToForm(o.draft), "open:draft"); S.dirty = true; }
    else if (o.example) { let ex = []; try { ex = S.hooks.examples() || []; } catch {} const x = ex.find((e) => e.id === o.example); if (x) { loadForm(exampleToForm(x), "open:example"); S.dirty = true; } }
    else renderForm();
    ready.then(() => { if (S.open) { renderList(); if (o.templateId && R && !S.form.id) { const t = R.getTemplate(o.templateId); if (t) loadForm(templateToForm(t), "open:edit-late"); } } });
    try { (S.form.id || S.form.name ? D.form.elements.prompt : D.form.elements.name).focus(); } catch {}
    diag("open", { templateId: o.templateId || null, example: o.example || null });
  }
  function close() {
    if (!S.open) return;
    S.open = false; D.run.hidden = true;
    if (S.embedded) { try { S.hooks.onClose && S.hooks.onClose(); } catch {} }
    else { D.host.classList.remove("open"); document.documentElement.classList.remove("rs-tcreator-open"); }
    diag("close", { dirty: S.dirty, embedded: !!S.embedded });
  }
  function isOpen() { return S.open; }
  function state() { return { open: S.open, embedded: S.embedded, busy: S.busy, dirty: S.dirty, advanced: S.advanced, query: S.query, archived: S.archived, form: JSON.parse(JSON.stringify(S.form)) }; }

  window.TotalTemplateCreator = { open, close, isOpen, state, detectBlanks, formToTemplate, templateToForm, exampleToForm, draftToForm, CATEGORIES };
})();
