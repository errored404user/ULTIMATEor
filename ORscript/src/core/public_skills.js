// OrScript — Public Skills
//
// User-made commands. Anyone can describe a Skill (a parameterised Luau program
// that runs in Studio), an Ability (a reusable procedure the agent follows) or a
// Work Mode (a mandate + focus list layered on the built-in Creation mode)
// in plain words; the AI designs it and submits it with public_skill_create, and
// OrScript validates, installs and exposes it like any built-in command.
//
// "Public" = shareable: every item exports to a .orskill.json file or a short
// share code that another OrScript install imports with one click (or with the
// public_skill_import command). Storage is chrome.storage.local (key
// rsPublicSkills); nothing is uploaded anywhere.
//
// This file is DOM-free at top level (it is loaded in node by the tests).
(function (root) {
  "use strict";
  const KEY = "rsPublicSkills";
  const MODE_KEY = "rsPublicMode";
  const FORMAT = "orscript-public-skill";
  const PACK_FORMAT = "orscript-public-skill-pack";
  const FORMAT_VERSION = 1;
  const KINDS = ["skill", "ability", "mode"];
  // 1.39.0: ONE built-in base, Creation (Ultimate + Visualizer + Animator
  // merged). Packs written for the old bases still import: LEGACY_BASES maps
  // them onto Creation (validate() runs on load, so stored items migrate too).
  const BASES = ["creation"];
  const LEGACY_BASES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };
  const normalizeBase = (b) => { const k = String(b || "").toLowerCase(); return BASES.includes(k) ? k : (LEGACY_BASES[k] || "creation"); };
  const PARAM_TYPES = ["string", "number", "boolean", "array", "object"];
  const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
  const PARAM_RE = /^[a-z][a-z0-9_]{0,40}$/;
  const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const LIMITS = { luau: 24000, mandate: 9000, instructions: 7000, params: 12, steps: 20, commands: 40, focus: 60 };

  let items = [];
  let activeModeId = null;
  let loaded = false;
  let loadPromise = null;
  const listeners = new Set();

  const storage = () => { try { return root.chrome && root.chrome.storage && root.chrome.storage.local || null; } catch { return null; } };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const str = (v, max) => { const s = v == null ? "" : String(v); return max ? s.slice(0, max) : s; };
  const snake = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "").slice(0, 40);
  const uid = () => "ps_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  function luauLiteral(v) {
    if (v == null) return "nil";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "{" + v.map(luauLiteral).join(",") + "}";
    if (typeof v === "object") {
      const parts = [];
      for (const [k, val] of Object.entries(v)) parts.push(`[${JSON.stringify(String(k))}]=${luauLiteral(val)}`);
      return "{" + parts.join(",") + "}";
    }
    return JSON.stringify(String(v));
  }

  function emit(reason, item) {
    for (const fn of [...listeners]) { try { fn({ reason, item, items: list() }); } catch {} }
    try {
      if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
        root.dispatchEvent(new root.CustomEvent("or-public-skills-change", { detail: { reason, item: item ? clone(item) : null } }));
      }
    } catch {}
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      const st = storage();
      if (!st) { loaded = true; return resolve(list()); }
      try {
        st.get([KEY, MODE_KEY], (r) => {
          try {
            const raw = r && Array.isArray(r[KEY]) ? r[KEY] : [];
            items = raw.map((it) => { const v = validate(it, { allowDuplicateId: true }); return v.ok ? v.item : null; }).filter(Boolean);
            activeModeId = r && typeof r[MODE_KEY] === "string" && items.some((i) => i.id === r[MODE_KEY] && i.kind === "mode") ? r[MODE_KEY] : null;
          } catch { items = []; activeModeId = null; }
          loaded = true;
          emit("loaded", null);
          resolve(list());
        });
      } catch { loaded = true; resolve(list()); }
    });
    return loadPromise;
  }
  function persist() {
    const st = storage();
    if (!st) return;
    try { st.set({ [KEY]: clone(items), [MODE_KEY]: activeModeId }); } catch {}
  }

  // ── Validation ──────────────────────────────────────────────────────────
  function inferKind(def) {
    if (def && KINDS.includes(def.kind)) return def.kind;
    if (def && typeof def.luau === "string") return "skill";
    if (def && typeof def.mandate === "string") return "mode";
    if (def && (typeof def.instructions === "string" || Array.isArray(def.steps))) return "ability";
    return "";
  }
  function normalizeParams(raw, errors, warnings) {
    const out = [];
    const arr = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([name, p]) => Object.assign({ name }, typeof p === "object" && p ? p : { type: String(p) })) : [];
    for (const p of arr.slice(0, LIMITS.params)) {
      if (!p || typeof p !== "object") continue;
      const name = snake(p.name);
      if (!PARAM_RE.test(name)) { errors.push(`param name '${p.name}' must be snake_case (letters, digits, underscores)`); continue; }
      if (out.some((x) => x.name === name)) { errors.push(`duplicate param '${name}'`); continue; }
      let type = String(p.type || "string").toLowerCase().replace(/\[\]$/, "array");
      if (/^(int|integer|float|num)/.test(type)) type = "number";
      if (/^(bool)/.test(type)) type = "boolean";
      if (/^(list|arr)/.test(type)) type = "array";
      if (/^(dict|map|json|table)/.test(type)) type = "object";
      if (!PARAM_TYPES.includes(type)) { warnings.push(`param '${name}': unknown type '${p.type}', using string`); type = "string"; }
      const item = { name, type, description: str(p.description || p.desc, 240), required: p.required === true || (p.required == null && p.default === undefined && p.optional !== true) };
      if (p.default !== undefined) item.default = p.default;
      if (Array.isArray(p.enum) && p.enum.length) item.enum = p.enum.slice(0, 20).map((e) => String(e));
      out.push(item);
    }
    if (arr.length > LIMITS.params) warnings.push(`only the first ${LIMITS.params} params were kept`);
    return out;
  }
  function stringList(v, max, lower) {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n|,/) : [];
    const out = [];
    for (const x of arr) { const s = str(x).trim(); if (s && !out.includes(lower ? s.toLowerCase() : s)) out.push(lower ? s.toLowerCase() : s); if (out.length >= max) break; }
    return out;
  }

  // validate(def, {reserved:Set|Array of built-in command names, allowDuplicateId})
  // -> {ok, errors[], warnings[], item}
  function validate(def, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, errors: ["definition must be an object"], warnings, item: null };
    if (def.definition && typeof def.definition === "object" && !def.kind && !def.luau && !def.mandate) def = def.definition;
    const kind = inferKind(def);
    if (!kind) errors.push("kind must be one of skill | ability | mode (or provide luau / instructions / mandate)");
    let name = snake(def.name || def.command || def.title || def.displayName);
    const title = str(def.title || def.displayName || titleCase(name), 80).trim();
    if (kind === "mode") { if (!name) name = snake(title) || "custom_mode"; }
    else if (!NAME_RE.test(name)) errors.push(`name '${def.name || title}' must be snake_case, 3-41 chars, starting with a letter (e.g. spawn_lantern_row)`);
    const reserved = opts.reserved instanceof Set ? opts.reserved : new Set(Array.isArray(opts.reserved) ? opts.reserved : []);
    if (kind !== "mode" && name && reserved.has(name)) errors.push(`name '${name}' collides with a built-in command - pick another name`);
    if (name && /^public_skill_/.test(name)) errors.push("names starting with public_skill_ are reserved");
    const description = str(def.description || def.desc, 600).trim();
    if (description.length < 10) errors.push("description must be at least 10 characters (what it does, when to use it)");
    const item = {
      id: typeof def.id === "string" && /^ps_[a-z0-9_]+$/.test(def.id) ? def.id : uid(),
      kind, name, title: title || titleCase(name), description,
      version: Math.max(1, parseInt(def.version, 10) || 1),
      author: str(def.author, 60).trim() || "you",
      tags: stringList(def.tags, 10, true),
      enabled: def.enabled !== false,
      source: ["ai", "import", "manual"].includes(def.source) ? def.source : "manual",
      createdAt: Number(def.createdAt) || Date.now(),
      updatedAt: Date.now(),
      params: [],
    };
    if (def.usage) item.usage = str(def.usage, 300);
    if (kind === "skill" || kind === "ability") item.params = normalizeParams(def.params || def.parameters || def.arguments, errors, warnings);
    if (kind === "skill") {
      const luau = str(def.luau || def.code || def.source_code);
      if (luau.trim().length < 20) errors.push("luau must contain the Luau program (at least 20 characters)");
      if (luau.length > LIMITS.luau) errors.push(`luau is too long (${luau.length} > ${LIMITS.luau} chars) - split the work or simplify`);
      const declared = new Set(item.params.map((p) => p.name));
      const used = new Set();
      let m; PLACEHOLDER_RE.lastIndex = 0;
      while ((m = PLACEHOLDER_RE.exec(luau))) used.add(m[1]);
      for (const u of used) if (!declared.has(u)) errors.push(`placeholder {{${u}}} is used in luau but not declared in params`);
      for (const d of declared) if (!used.has(d) && !new RegExp("args\\s*[.\\[]\\s*[\"']?" + d).test(luau)) warnings.push(`param '${d}' is never read by the luau (use {{${d}}} or args.${d})`);
      if (/\bplugin\s*[:.]/.test(luau)) warnings.push("the `plugin` global is not available to execute_luau - this skill may fail in Studio");
      if (/\bwait\s*\(\s*(\d+)/.test(luau) && Number(RegExp.$1) > 5) warnings.push("long waits stall the command; keep yields under 5 seconds");
      if (/\brequire\s*\(\s*\d{5,}/.test(luau)) warnings.push("require(assetId) pulls remote code - reviewers should check that asset");
      if (/HttpService\s*:\s*(GetAsync|PostAsync|RequestAsync)/.test(luau)) warnings.push("the skill makes HTTP requests from Studio");
      const opens = (luau.match(/\b(function|if|for|while|do)\b/g) || []).length - (luau.match(/\b(then|else|elseif)\b/g) || []).length;
      const ends = (luau.match(/\bend\b/g) || []).length;
      if (Math.abs(opens - ends) > 6) warnings.push("block keywords and `end`s look unbalanced - public_skill_test {name} checks the syntax in Studio");
      item.luau = luau;
      item.executionMode = /^(READ|WRITE)$/.test(String(def.executionMode)) ? def.executionMode : "WRITE";
    } else if (kind === "ability") {
      item.instructions = str(def.instructions || def.prompt || def.procedure, LIMITS.instructions).trim();
      item.steps = stringList(def.steps || def.workflow, LIMITS.steps);
      item.commands = stringList(def.commands || def.uses, LIMITS.commands, true).map(snake).filter(Boolean);
      if (item.instructions.length < 20 && !item.steps.length) errors.push("ability needs instructions (>= 20 chars) or at least one step");
      if (reserved.size) { const unknown = item.commands.filter((c) => !reserved.has(c)); if (unknown.length) warnings.push(`commands not found in this build: ${unknown.join(", ")}`); }
      item.executionMode = "READ";
    } else if (kind === "mode") {
      item.base = normalizeBase(def.base || def.baseMode);
      item.badge = str(def.badge || title, 12).toUpperCase().replace(/[^A-Z0-9 +\-]/g, "").trim() || "CUSTOM";
      item.sub = str(def.sub || def.subtitle || def.tagline, 120).trim() || description.slice(0, 120);
      item.note = str(def.note, 320).trim() || description.slice(0, 320);
      item.mandate = str(def.mandate || def.prompt || def.systemPrompt, LIMITS.mandate).trim();
      item.focus = stringList(def.focus || def.focusCommands, LIMITS.focus, true).map(snake).filter(Boolean);
      item.toast = str(def.toast, 140).trim() || `${item.title} - custom work mode on ${titleCase(item.base)}`;
      if (item.mandate.length < 80) errors.push("mode mandate must be at least 80 characters (how the agent must think, build and verify in this mode)");
      if (reserved.size) { const unknown = item.focus.filter((c) => !reserved.has(c)); if (unknown.length) warnings.push(`focus commands not found in this build: ${unknown.join(", ")}`); }
      if (!item.focus.length) warnings.push("no focus commands - the mode will inherit only the base mode's focus list");
    }
    // Uniqueness against installed items.
    if (!errors.length) {
      const other = items.find((i) => i.id !== item.id && i.kind === item.kind && i.name === item.name);
      if (other && !opts.allowDuplicateId) errors.push(`a ${kind} named '${name}' already exists (id ${other.id}) - use public_skill_update, or choose another name`);
      if (kind !== "mode") { const cross = items.find((i) => i.id !== item.id && i.kind !== "mode" && i.name === item.name); if (cross && !opts.allowDuplicateId) errors.push(`'${name}' is already used by a ${cross.kind}`); }
    }
    return { ok: !errors.length, errors, warnings, item: errors.length ? null : item };
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  function list(filter) {
    let out = items.map(clone);
    if (filter && filter.kind) out = out.filter((i) => i.kind === filter.kind);
    if (filter && filter.enabled != null) out = out.filter((i) => i.enabled === !!filter.enabled);
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }
  function find(ref) {
    if (!ref) return null;
    if (typeof ref === "object") ref = ref.id || ref.name;
    ref = String(ref).trim();
    const bare = ref.includes("/") ? ref.split("/").pop() : ref;
    return items.find((i) => i.id === ref) || items.find((i) => i.kind !== "mode" && i.name === snake(bare)) || items.find((i) => i.name === snake(bare)) || items.find((i) => i.kind === "mode" && ("pm:" + i.id) === ref) || null;
  }
  const get = (ref) => { const i = find(ref); return i ? clone(i) : null; };
  const has = (name) => !!find(name);
  const isCommand = (name) => { const i = find(name); return !!(i && i.enabled && i.kind !== "mode"); };

  function upsert(def, opts) {
    opts = opts || {};
    const existing = def && def.id ? items.find((i) => i.id === def.id) : null;
    const merged = existing ? Object.assign({}, existing, def, { id: existing.id, createdAt: existing.createdAt, version: def.version || existing.version + (opts.bump === false ? 0 : 1) }) : def;
    if (opts.source && merged && typeof merged === "object") merged.source = opts.source;
    const v = validate(merged, opts);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, item: null };
    const idx = items.findIndex((i) => i.id === v.item.id);
    if (idx >= 0) items[idx] = v.item; else items.push(v.item);
    persist();
    emit(idx >= 0 ? "updated" : "created", v.item);
    return { ok: true, errors: [], warnings: v.warnings, item: clone(v.item), created: idx < 0 };
  }
  function update(ref, patch, opts) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`unknown public skill '${typeof ref === "object" ? JSON.stringify(ref) : ref}'`], warnings: [], item: null };
    const next = Object.assign({}, cur, patch || {}, { id: cur.id, kind: cur.kind });
    if (!(patch && Number(patch.version) > cur.version)) next.version = cur.version + 1;
    return upsert(next, opts);
  }
  function remove(ref) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: ["not found"], item: null };
    items = items.filter((i) => i.id !== cur.id);
    if (activeModeId === cur.id) activeModeId = null;
    persist();
    emit("removed", cur);
    return { ok: true, errors: [], item: clone(cur) };
  }
  function setEnabled(ref, on) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: ["not found"], item: null };
    cur.enabled = !!on; cur.updatedAt = Date.now();
    if (!cur.enabled && activeModeId === cur.id) activeModeId = null;
    persist();
    emit("toggled", cur);
    return { ok: true, errors: [], item: clone(cur) };
  }

  // ── Modes ───────────────────────────────────────────────────────────────
  const modes = () => list({ kind: "mode" });
  const activeMode = () => { const m = items.find((i) => i.id === activeModeId && i.kind === "mode" && i.enabled); return m ? clone(m) : null; };
  function setActiveMode(ref) {
    const m = ref ? find(ref) : null;
    activeModeId = m && m.kind === "mode" && m.enabled ? m.id : null;
    persist();
    emit("mode", m && activeModeId ? m : null);
    return activeMode();
  }
  function modePrompt(m) {
    m = m && m.kind === "mode" ? m : activeMode();
    if (!m) return "";
    const focus = m.focus.length ? `\nFOCUS COMMANDS for this mode (use them heavily, on top of the ${m.base.toUpperCase()} focus list): ${m.focus.join(", ")}` : "";
    return `━━━ CUSTOM WORK MODE: ${m.title.toUpperCase()} (public mode by ${m.author}, layered on ${m.base.toUpperCase()}) ━━━\n${m.sub ? m.sub + "\n" : ""}${m.mandate}${focus}\nThe ${m.base.toUpperCase()} workflow above stays the process; this block sets the priorities and the standard of quality. The user picked this mode on purpose - follow it.`;
  }

  // ── Execution ───────────────────────────────────────────────────────────
  function resolveArgs(item, args) {
    const out = {}, missing = [];
    const src = args && typeof args === "object" ? args : {};
    for (const p of item.params || []) {
      let v = src[p.name];
      if (v === undefined || v === null || v === "") {
        if (p.default !== undefined) v = clone(p.default);
        else if (p.required) { missing.push(p.name); continue; }
        else v = null;
      }
      if (v != null) {
        if (p.type === "number") { const n = Number(v); if (!Number.isFinite(n)) return { err: `param '${p.name}' must be a number` }; v = n; }
        else if (p.type === "boolean") v = v === true || v === "true" || v === 1 || v === "1";
        else if (p.type === "array") { if (typeof v === "string") { try { const j = JSON.parse(v); v = Array.isArray(j) ? j : v.split(",").map((s) => s.trim()).filter(Boolean); } catch { v = v.split(",").map((s) => s.trim()).filter(Boolean); } } else if (!Array.isArray(v)) v = [v]; }
        else if (p.type === "object") { if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { err: `param '${p.name}' must be a JSON object` }; } } if (!v || typeof v !== "object" || Array.isArray(v)) return { err: `param '${p.name}' must be an object` }; }
        else v = String(v);
        if (p.enum && p.enum.length && !p.enum.includes(String(v))) return { err: `param '${p.name}' must be one of ${p.enum.join(" | ")}` };
      }
      out[p.name] = v;
    }
    if (missing.length) return { err: `ERROR MISSING_PARAMS calling '${item.name}': ${missing.join(", ")} - call it as ${signature(item)}` };
    return { args: out };
  }
  function buildLuau(ref, args) {
    const item = find(ref);
    if (!item || item.kind !== "skill") return { err: `ERROR in public skill: '${ref}' is not an installed skill` };
    if (!item.enabled) return { err: `ERROR in ${item.name}: this public skill is disabled - enable it in the Public tab or with public_skill_enable {name}` };
    const r = resolveArgs(item, args);
    if (r.err) return { err: r.err.startsWith("ERROR") ? r.err : `ERROR INVALID_PARAMETER in ${item.name}: ${r.err}` };
    const body = item.luau.replace(PLACEHOLDER_RE, (_, k) => luauLiteral(r.args[k] === undefined ? null : r.args[k]));
    const code = [
      `-- OrScript public skill '${item.name}' v${item.version} by ${item.author.replace(/[^\w .-]/g, "")}`,
      `local HttpService = game:GetService("HttpService")`,
      `local args = ${luauLiteral(r.args)}`,
      `local __ok, __res = pcall(function()`,
      body,
      `end)`,
      `if not __ok then return HttpService:JSONEncode({ok = false, error = tostring(__res), skill = ${JSON.stringify(item.name)}}) end`,
      `if __res == nil then return HttpService:JSONEncode({ok = true, skill = ${JSON.stringify(item.name)}}) end`,
      `if type(__res) == "table" then if __res.ok == nil then __res.ok = true end return HttpService:JSONEncode(__res) end`,
      `return tostring(__res)`,
    ].join("\n");
    return { code, args: r.args, item: clone(item) };
  }
  function syntaxCheckLuau(ref, args) {
    const built = buildLuau(ref, args);
    if (built.err) return built;
    const code = [
      `local HttpService = game:GetService("HttpService")`,
      `local src = ${luauLiteral(built.code)}`,
      `if type(loadstring) ~= "function" then return HttpService:JSONEncode({ok = true, checked = false, note = "loadstring unavailable in this context; run the skill with public_skill_test {dry_run=false}"}) end`,
      `local fn, err = loadstring(src)`,
      `if fn then return HttpService:JSONEncode({ok = true, checked = true, syntax = "OK", chars = #src}) end`,
      `return HttpService:JSONEncode({ok = false, checked = true, error = "SYNTAX: " .. tostring(err)})`,
    ].join("\n");
    return { code, item: built.item };
  }
  function abilityText(ref, args) {
    const item = find(ref);
    if (!item || item.kind !== "ability") return { err: `ERROR in public ability: '${ref}' is not an installed ability` };
    if (!item.enabled) return { err: `ERROR in ${item.name}: this public ability is disabled - enable it in the Public tab or with public_skill_enable {name}` };
    const r = resolveArgs(item, args);
    if (r.err) return { err: r.err.startsWith("ERROR") ? r.err : `ERROR INVALID_PARAMETER in ${item.name}: ${r.err}` };
    const lines = [`ABILITY '${item.name}' v${item.version} (public ability by ${item.author}) - ${item.description}`];
    if (Object.keys(r.args).length) lines.push(`ARGUMENTS: ${JSON.stringify(r.args)}`);
    if (item.instructions) lines.push("", "INSTRUCTIONS:", fill(item.instructions, r.args));
    if (item.steps.length) lines.push("", "STEPS:", ...item.steps.map((s, i) => `${i + 1}. ${fill(s, r.args)}`));
    if (item.commands.length) lines.push("", `COMMANDS TO USE: ${item.commands.join(", ")}`);
    lines.push("", "Carry these steps out now with real command calls (one per message as usual), verify the result, then report what you did. This ability returned instructions only - nothing has been executed yet.");
    return { text: lines.join("\n"), item: clone(item), args: r.args };
  }
  const fill = (s, args) => String(s).replace(PLACEHOLDER_RE, (_, k) => args[k] == null ? "" : typeof args[k] === "object" ? JSON.stringify(args[k]) : String(args[k]));

  // ── Catalogue / tool entries ────────────────────────────────────────────
  function signature(item) {
    const ps = (item.params || []).map((p) => p.name + (p.required ? "" : "?")).join(", ");
    return `${item.name} {${ps}}`;
  }
  function schema(item) {
    const properties = {}, required = [];
    for (const p of item.params || []) {
      const prop = { type: p.type === "array" ? "array" : p.type, description: p.description || p.name };
      if (p.type === "array") prop.items = { type: "string" };
      if (p.enum) prop.enum = p.enum.slice();
      if (p.default !== undefined) prop.default = p.default;
      properties[p.name] = prop;
      if (p.required) required.push(p.name);
    }
    const s = { type: "object", properties };
    if (required.length) s.required = required;
    return s;
  }
  function toolEntries() {
    return items.filter((i) => i.enabled && i.kind !== "mode").map((i) => ({
      name: i.name,
      description: `[Public ${i.kind} by ${i.author}] ${i.description}${i.usage ? " Usage: " + i.usage : ""}`,
      inputSchema: schema(i),
      server: i.kind === "skill" ? "roblox" : "orscript",
      environment: i.kind === "skill" ? "ROBLOX_STUDIO" : "GENERAL",
      executionMode: i.executionMode || (i.kind === "skill" ? "WRITE" : "READ"),
      category: "Public Skills",
      publicSkill: true,
      virtual: true,
    }));
  }
  function catalogueBlock(opts) {
    const cmds = items.filter((i) => i.enabled && i.kind !== "mode");
    if (!cmds.length) return "";
    const compact = !!(opts && opts.compact);
    const rows = cmds.map((i) => compact ? `${signature(i)} - ${i.description.slice(0, 90)}` : `${signature(i)} - [${i.kind}] ${i.description.slice(0, 200)}`);
    return `PUBLIC SKILLS - ${cmds.length} user-made command${cmds.length === 1 ? "" : "s"} installed on this device (call them like any command; skills run Luau in Studio, abilities return a procedure to follow):\n${rows.join("\n")}\nManage them with public_skill_list / public_skill_get / public_skill_update / public_skill_delete / public_skill_export; create new ones with public_skill_create.\n\n`;
  }

  const DEFINITION_DOC = [
    "DEFINITION OBJECT (JSON) - common fields: kind ('skill'|'ability'|'mode'), name (snake_case, unique, 3-41 chars; modes may use a title instead), title, description (10-600 chars: what it does, when to use it), version (int), author, tags[], usage (one example call).",
    "SKILL fields: params[{name, type: string|number|boolean|array|object, description, required, default?, enum?}], luau (the program; max 24000 chars). Every param is available in Luau BOTH as the Lua literal {{param}} and as args.param. The program runs in Studio through execute_luau in the Edit DataModel (plugin-level API, no `plugin` global, no yields over 5 s). Resolve instance paths first (walk game by name, fail with a clear error), wrap risky work in pcall, keep work idempotent, name created instances, record ChangeHistoryService waypoints for big edits, and RETURN A TABLE such as {ok=true, created=3, path='Workspace.X'} (it is JSON-encoded for the agent). Use `return {ok=false, error='...'}` for failures.",
    "ABILITY fields: params[] (optional), instructions (imperative procedure; may use {{param}}), steps[] (3-15 concrete steps), commands[] (real command names from list_commands). Calling an ability returns these instructions to the agent, which then performs them with real commands.",
    "MODE fields: title, badge (<=12 chars, uppercase), base ('creation' - the only built-in mode; legacy 'ultimate'|'visualizer'|'animator' map to it), sub (one line), note (menu blurb), mandate (80-9000 chars: priorities, quality bar, pipeline, verification rules - written like a senior specialist's standing orders), focus[] (10-40 real command names the mode leans on), toast.",
  ].join("\n");

  function generationPrompt(request, kindHint, ctx) {
    ctx = ctx || {};
    const kind = KINDS.includes(kindHint) ? kindHint : "auto";
    const existing = items.length ? `Already installed on this device (do not reuse these names): ${items.map((i) => `${i.name} (${i.kind})`).join(", ")}.` : "No public skills are installed yet.";
    const names = Array.isArray(ctx.commandNames) && ctx.commandNames.length ? `Built-in command names you may reference in commands[]/focus[] (sample): ${ctx.commandNames.slice(0, 80).join(", ")}${ctx.commandNames.length > 80 ? " ..." : ""}. Use list_commands {\"query\":\"keyword\"} to find more.` : "";
    const kindLine = kind === "auto"
      ? "KIND: decide yourself - 'skill' when the whole job can be one parameterised Luau program; 'ability' when it is a reusable multi-command procedure the agent should follow; 'mode' when it should change how the whole agent behaves for a session."
      : `KIND: ${kind} (the user chose this explicitly).`;
    return [
      "PUBLIC SKILL REQUEST - OrScript 'Public Skills' lets the user create their own commands, abilities and work modes by describing them. You do the whole job now.",
      `USER REQUEST: "${String(request || "").trim()}"`,
      kindLine,
      "PROCESS: (1) design it completely - make sensible decisions instead of asking questions and mention them in the description; (2) submit it with ONE call to public_skill_create {\"definition\": {...}}; (3) if it returns VALIDATION_FAILED, fix the listed problems and call public_skill_create again; (4) for skills call public_skill_test {\"name\": ...} once to syntax-check it in Studio and fix any error with public_skill_update; (5) finally tell the user in one short paragraph what was installed, one example call, and how to share it (Public tab -> Export / Share code). Do not run the new skill on the user's place unless they asked for a test.",
      DEFINITION_DOC,
      existing,
      names,
    ].filter(Boolean).join("\n\n");
  }

  const MANAGEMENT_TOOLS = [
    { name: "public_skill_create", description: "Install a user-made Public Skill (kind=skill: parameterised Luau run in Studio), Ability (kind=ability: reusable procedure) or Work Mode (kind=mode: mandate + focus list). Validates and installs immediately; returns INSTALLED or VALIDATION_FAILED with fixes.", inputSchema: { type: "object", required: ["definition"], properties: { definition: { type: "object", description: "Full definition: {kind, name, title, description, params[], luau | instructions+steps+commands | mandate+focus+base+badge}" } } } },
    { name: "public_skill_list", description: "List installed Public Skills / Abilities / Modes with their signatures.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["skill", "ability", "mode"] } } } },
    { name: "public_skill_get", description: "Read one Public Skill definition in full (Luau, params, mandate).", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "name or id" } } } },
    { name: "public_skill_update", description: "Patch an installed Public Skill (fields are merged; version increments).", inputSchema: { type: "object", required: ["name", "patch"], properties: { name: { type: "string" }, patch: { type: "object" } } } },
    { name: "public_skill_delete", description: "Uninstall a Public Skill by name or id.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    { name: "public_skill_enable", description: "Enable or disable a Public Skill without deleting it; for kind=mode, enabled=true with activate=true switches the agent into that mode.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, enabled: { type: "boolean", default: true }, activate: { type: "boolean" } } } },
    { name: "public_skill_test", description: "Syntax-check a public skill's Luau in Studio (dry_run=true, default) or actually run it with args (dry_run=false).", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, args: { type: "object" }, dry_run: { type: "boolean", default: true } } } },
    { name: "public_skill_export", description: "Export a Public Skill (or name='all' for a pack of everything installed) as shareable JSON plus an ORSKILL1: share code the user can give to others.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "name, id, or 'all'" } } } },
    { name: "public_skill_import", description: "Import Public Skills from exported JSON (single .orskill.json, a pack .orskills.json), a plain-text .txt skill (# Title / kind: / --- luau --- sections) or an ORSKILL1: share code.", inputSchema: { type: "object", required: ["data"], properties: { data: { type: "string", description: "JSON text, .txt skill text or ORSKILL1: share code" }, replace: { type: "boolean", description: "Replace items with the same name" } } } },
    { name: "public_skill_from_prompt", description: "Turn a full prompt the user wrote into an installed Public Skill WITHOUT redesigning it: the prompt is kept verbatim as an ability's instructions (default), a mode's mandate (kind=mode) or, when it contains Luau, a skill. Instant; refine later with public_skill_update.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", description: "The full prompt text" }, kind: { type: "string", enum: ["skill", "ability", "mode"] }, title: { type: "string" }, name: { type: "string", description: "snake_case command name" }, description: { type: "string" } } } },
  ].map((t) => Object.assign(t, { server: "orscript", executionMode: /create|update|delete|import|enable|test|from_prompt/.test(t.name) ? "WRITE" : "READ", environment: "GENERAL", category: "Public Skills" }));

  // ── Sharing ─────────────────────────────────────────────────────────────
  function exportObject(ref) {
    const item = find(ref);
    if (!item) return null;
    const out = clone(item);
    delete out.enabled; delete out.source; delete out.createdAt; delete out.updatedAt;
    return { format: FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), app: "OrScript", item: out };
  }
  const exportJson = (ref) => { const o = exportObject(ref); return o ? JSON.stringify(o, null, 2) : null; };
  // Pack = several items in one file (Export all / a curated bundle).
  function exportPackObject(refs) {
    const picked = refs && refs.length ? refs.map((r) => find(r)).filter(Boolean) : items.slice();
    if (!picked.length) return null;
    return { format: PACK_FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), app: "OrScript", count: picked.length, items: picked.map((i) => exportObject(i.id).item) };
  }
  const exportPackJson = (refs) => { const o = exportPackObject(refs); return o ? JSON.stringify(o, null, 2) : null; };
  const packFileName = () => `orscript-public-skills-${new Date().toISOString().slice(0, 10)}.orskills.json`;
  const packShareCode = (refs) => { const o = exportPackObject(refs); return o ? "ORSKILL1:" + b64encode(JSON.stringify(o)) : null; };
  const fileName = (ref) => { const i = find(ref); return i ? `${i.name || "mode"}.${i.kind}.orskill.json` : "public-skill.orskill.json"; };
  function b64encode(s) { try { return typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"); } catch { return ""; } }
  function b64decode(s) { try { return typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8"); } catch { return ""; } }
  function shareCode(ref) { const o = exportObject(ref); return o ? "ORSKILL1:" + b64encode(JSON.stringify(o)) : null; }
  function parseShared(text) {
    let s = String(text || "").trim();
    if (!s) return { ok: false, errors: ["nothing to import"] };
    if (/^ORSKILL1:/i.test(s)) { s = b64decode(s.slice(9).replace(/\s+/g, "")); if (!s) return { ok: false, errors: ["share code is corrupted"] }; }
    let j; try { j = JSON.parse(s); } catch {
      // Not JSON: a plain-text skill file (.txt) or a bare prompt.
      const t = parseText(s);
      if (t.ok) return { ok: true, def: t.def, text: true };
      return { ok: false, prompt: !!t.prompt, text: s, errors: t.prompt ? ["this is a prompt, not a skill file - use 'Make it a skill' (AI) or 'Save as-is' to convert it"] : ["not valid JSON, share code or .txt skill"] };
    }
    if (j && j.format === PACK_FORMAT && Array.isArray(j.items)) return { ok: true, pack: true, defs: j.items.filter((d) => d && typeof d === "object") };
    if (j && Array.isArray(j.items) && j.items.every((d) => d && (d.kind || d.luau || d.mandate))) return { ok: true, pack: true, defs: j.items };
    if (Array.isArray(j) && j.every((d) => d && (d.kind || d.luau || d.mandate))) return { ok: true, pack: true, defs: j };
    const def = j && j.format === FORMAT && j.item ? j.item : j && (j.kind || j.luau || j.mandate || j.instructions) ? j : null;
    if (!def) return { ok: false, errors: ["unrecognised file - expected an OrScript public skill export (.orskill.json / .orskills.json) or an ORSKILL1: share code"] };
    return { ok: true, def };
  }
  function importShared(text, opts) {
    const p = parseShared(text);
    if (!p.ok) return { ok: false, errors: p.errors, warnings: [], item: null, prompt: !!p.prompt, text: p.prompt ? p.text : undefined };
    if (p.pack) return importPack(p.defs, opts);
    return importOne(p.def, opts);
  }
  // Pack import: installs every item it can; duplicates are skipped unless
  // opts.replace. Returns {ok, installed[], skipped[], errors[]}.
  function importPack(defs, opts) {
    const installed = [], skipped = [], errors = [], warnings = [];
    for (const d of defs || []) {
      const r = importOne(d, opts);
      if (r.ok) { installed.push(r.item); warnings.push(...r.warnings.map((w) => `${r.item.name}: ${w}`)); }
      else if (r.duplicate) skipped.push(r.duplicate.name);
      else errors.push(`${(d && (d.name || d.title)) || "item"}: ${r.errors.join("; ")}`);
    }
    return { ok: installed.length > 0 || (!errors.length && !!skipped.length), pack: true, installed, skipped, errors, warnings, item: installed[0] || null, count: installed.length };
  }
  function importOne(src, opts) {
    const def = Object.assign({}, src);
    delete def.id; delete def.createdAt; delete def.updatedAt;
    const dup = items.find((i) => i.kind === def.kind && i.name === snake(def.name || def.title));
    if (dup && !(opts && opts.replace)) return { ok: false, errors: [`a ${dup.kind} named '${dup.name}' is already installed - delete it first or import with replace`], warnings: [], item: null, duplicate: clone(dup) };
    if (dup) def.id = dup.id;
    return upsert(def, Object.assign({ source: "import" }, opts || {}));
  }

  // ── Plain-text format (.txt) ─────────────────────────────────────────────
  // A skill written by hand in any text editor. Header lines `key: value`,
  // then sections opened by `--- name ---` (luau | instructions | steps |
  // mandate | description). Everything a JSON definition can say, in a form
  // people actually type:
  //
  //   # Lantern Row
  //   kind: skill
  //   description: Places N lanterns with warm PointLights along the selected path.
  //   params: count:number=4 "how many", color:string="warm" "light colour"
  //   tags: lighting, props
  //   --- luau ---
  //   local n = {{count}}
  //   ...
  const SECTION_RE = /^\s*(?:-{3,}|={3,}|#{2,3})\s*([a-zA-Z][a-zA-Z _-]{1,30}?)\s*(?:-{3,}|={3,})?\s*$/;
  const HEADER_KEYS = { kind: "kind", type: "kind", name: "name", command: "name", title: "title", description: "description", desc: "description", summary: "description", tags: "tags", tag: "tags", params: "params", param: "params", parameters: "params", args: "params", base: "base", badge: "badge", focus: "focus", commands: "commands", uses: "commands", author: "author", by: "author", usage: "usage", example: "usage", sub: "sub", subtitle: "sub", note: "note", toast: "toast", version: "version", executionmode: "executionMode", mode: "executionMode" };
  const SECTION_KEYS = { luau: "luau", lua: "luau", code: "luau", script: "luau", program: "luau", instructions: "instructions", instruction: "instructions", procedure: "instructions", prompt: "instructions", steps: "steps", step: "steps", workflow: "steps", mandate: "mandate", "system prompt": "mandate", systemprompt: "mandate", rules: "mandate", description: "description", about: "description", notes: "note" };
  // `count:number=4 "how many"` | `name (string, required): what it is` | `color string`
  function parseParamSpec(spec) {
    const out = [];
    const parts = String(spec || "").split(/\r?\n|;|,(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean);
    for (const raw of parts) {
      let s = raw.replace(/^[-*\d.)\s]+/, "");
      let description = "";
      const q = s.match(/"([^"]*)"\s*$/); if (q) { description = q[1]; s = s.slice(0, q.index).trim(); }
      const colonDesc = s.match(/^([^:]+:[^:=\s]+(?:\s*=\s*[^:]+)?)\s*:\s*(.+)$/); if (!description && colonDesc && !/^[a-z_][a-z0-9_]*\s*:\s*[a-z]+$/i.test(s)) { s = colonDesc[1].trim(); description = colonDesc[2].trim(); }
      let def;
      const eq = s.match(/^(.*?)\s*=\s*(.+)$/); if (eq) { s = eq[1].trim(); def = eq[2].trim(); }
      let required;
      if (/\boptional\b/i.test(s)) { required = false; s = s.replace(/[,(]?\s*optional\s*\)?/i, "").trim(); }
      if (/\brequired\b/i.test(s)) { required = true; s = s.replace(/[,(]?\s*required\s*\)?/i, "").trim(); }
      const m = s.match(/^([a-zA-Z_][a-zA-Z0-9_ ]*?)\s*(?:[:(\s]\s*([a-zA-Z\[\]]+)\s*\)?)?$/);
      if (!m) continue;
      const p = { name: snake(m[1]), type: (m[2] || "string").toLowerCase(), description };
      if (def !== undefined) { try { p.default = JSON.parse(def); } catch { p.default = def.replace(/^['"]|['"]$/g, ""); } }
      if (required !== undefined) p.required = required;
      out.push(p);
    }
    return out;
  }
  // parseText(text) -> {ok:true, def} when the text has skill structure, or
  // {ok:false, prompt:true, text} when it is free prose (a prompt to convert).
  function parseText(text) {
    const src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!src.trim()) return { ok: false, errors: ["empty text"] };
    const lines = src.split("\n");
    const def = {}; const sections = {}; let cur = null; let title = null; let structure = 0;
    const headerBuf = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sec = line.match(SECTION_RE);
      if (sec && SECTION_KEYS[sec[1].trim().toLowerCase()]) { cur = SECTION_KEYS[sec[1].trim().toLowerCase()]; sections[cur] = sections[cur] || []; structure++; continue; }
      if (cur) { sections[cur].push(line); continue; }
      if (title === null && /^#\s+\S/.test(line)) { title = line.replace(/^#\s+/, "").trim(); structure++; continue; }
      const kv = line.match(/^\s*([A-Za-z][A-Za-z _]{1,20})\s*[:=]\s*(.*)$/);
      if (kv && HEADER_KEYS[kv[1].trim().toLowerCase().replace(/\s+/g, "")]) {
        const key = HEADER_KEYS[kv[1].trim().toLowerCase().replace(/\s+/g, "")];
        if (key === "kind" || key === "name" || key === "params" || key === "base" || key === "badge" || key === "focus") structure++;
        def[key] = def[key] ? def[key] + "\n" + kv[2] : kv[2];
        continue;
      }
      if (line.trim()) headerBuf.push(line);
    }
    // Code fence without a section marker: ```lua … ``` counts as the luau section.
    if (!sections.luau) { const fence = src.match(/```(?:lua|luau)\n([\s\S]*?)```/i); if (fence && fence[1].trim().length >= 20) { sections.luau = fence[1].split("\n"); structure++; } }
    if (!structure && !def.kind && !def.luau) return { ok: false, prompt: true, text: src, errors: ["no skill structure found (no kind:/--- luau ---/--- instructions ---/--- mandate --- markers) - this reads as a prompt"] };
    if (title && !def.title) def.title = title;
    for (const [k, v] of Object.entries(sections)) {
      const body = v.join("\n").replace(/^\n+|\n+$/g, "");
      if (k === "steps") def.steps = body.split("\n").map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
      else if (k === "luau") def.luau = body.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
      else if (k === "description") def.description = (def.description ? def.description + " " : "") + body.replace(/\s+/g, " ").trim();
      else def[k] = body;
    }
    if (!def.description && headerBuf.length) def.description = headerBuf.join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
    if (def.params) def.params = parseParamSpec(def.params);
    if (def.version) def.version = parseInt(def.version, 10) || 1;
    if (!def.kind) def.kind = inferKind(def) || (def.luau ? "skill" : def.mandate ? "mode" : "ability");
    def.kind = String(def.kind).trim().toLowerCase().replace(/^work ?mode$/, "mode").replace(/^command$/, "skill");
    if (!def.name && def.title) def.name = snake(def.title);
    if (def.kind === "ability" && !def.instructions && def.description && !def.steps) { def.instructions = def.description; }
    return { ok: true, def, text: true };
  }
  // exportText(ref) -> the same format, for people who prefer .txt to JSON.
  function exportText(ref) {
    const i = find(ref);
    if (!i) return null;
    const L = [];
    L.push(`# ${i.title}`);
    L.push(`kind: ${i.kind}`);
    L.push(`name: ${i.name}`);
    L.push(`description: ${i.description.replace(/\s+/g, " ")}`);
    if (i.tags && i.tags.length) L.push(`tags: ${i.tags.join(", ")}`);
    if (i.author) L.push(`author: ${i.author}`);
    L.push(`version: ${i.version}`);
    if (i.usage) L.push(`usage: ${i.usage}`);
    if (i.params && i.params.length) L.push(`params: ${i.params.map((p) => `${p.name}:${p.type}${p.default !== undefined ? "=" + JSON.stringify(p.default) : ""}${p.required === false && p.default === undefined ? " optional" : ""}${p.description ? ` "${p.description.replace(/"/g, "'")}"` : ""}`).join(", ")}`);
    if (i.kind === "skill") { L.push("", "--- luau ---", i.luau, ""); }
    if (i.kind === "ability") {
      if (i.commands && i.commands.length) L.push(`commands: ${i.commands.join(", ")}`);
      L.push("", "--- instructions ---", i.instructions || "", "");
      if (i.steps && i.steps.length) L.push("--- steps ---", ...i.steps.map((s, n) => `${n + 1}. ${s}`), "");
    }
    if (i.kind === "mode") {
      L.push(`base: ${i.base}`, `badge: ${i.badge}`);
      if (i.sub) L.push(`sub: ${i.sub}`);
      if (i.focus && i.focus.length) L.push(`focus: ${i.focus.join(", ")}`);
      L.push("", "--- mandate ---", i.mandate, "");
    }
    return L.join("\n");
  }
  const textFileName = (ref) => { const i = find(ref); return i ? `${i.name || "mode"}.${i.kind}.orskill.txt` : "public-skill.orskill.txt"; };

  // ── Prompt → skill ───────────────────────────────────────────────────────
  // A "full prompt" is a long piece of instructions the user already wrote
  // (for any AI). Two paths turn it into an installed item:
  //   fromPrompt(text, opts)       - instant, no AI: ability (or mode / skill
  //                                  when the text makes that possible), the
  //                                  prompt kept verbatim as its instructions.
  //   conversionPrompt(text, kind) - the AI does a faithful conversion with
  //                                  public_skill_create (params, Luau, steps).
  const looksLikeFullPrompt = (t) => { const s = String(t || "").trim(); return s.length >= 280 || s.split(/\n/).filter((l) => l.trim()).length >= 4; };
  const LUA_HINT_RE = /\b(local\s+\w+\s*=|game:GetService\(|Instance\.new\(|workspace[.:]|function\s*\(|\bend\b\s*$)/m;
  function firstHeading(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const h = lines.find((l) => /^#{1,3}\s+\S/.test(l)); if (h) return h.replace(/^#+\s+/, "").slice(0, 80);
    const t = lines.find((l) => /^(title|name|skill|mode|ability)\s*[:\-]\s*\S/i.test(l)); if (t) return t.replace(/^[^:\-]+[:\-]\s*/, "").slice(0, 80);
    const first = lines[0] || "";
    if (first.length <= 70 && !/[.!?:;,]$/.test(first) && first.split(/\s+/).length <= 10) return first;
    return "";
  }
  function fromPrompt(text, opts) {
    opts = opts || {};
    const src = String(text || "").replace(/\r\n?/g, "\n").trim();
    const warnings = [];
    if (src.length < 20) return { ok: false, errors: ["the prompt is too short to become a skill (at least 20 characters)"], warnings, def: null };
    let kind = KINDS.includes(opts.kind) ? opts.kind : "";
    const title = str(opts.title || firstHeading(src) || ("Prompt " + new Date().toISOString().slice(0, 10)), 80).trim();
    const name = snake(opts.name || title) || ("prompt_skill_" + Date.now().toString(36).slice(-4));
    const body = src.replace(/^#{1,3}\s+[^\n]*\n+/, "");
    const firstPara = body.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
    let description = str(opts.description || firstPara, 300).trim();
    if (description.length < 10) description = `Converted from a prompt: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
    const reserved = opts.reserved instanceof Set ? opts.reserved : new Set(Array.isArray(opts.reserved) ? opts.reserved : []);
    // Command names the prompt mentions (snake_case words); filtered to real ones when the catalogue is known.
    const snakeTokens = [...new Set(src.toLowerCase().match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])];
    const known = snakeTokens.filter((t) => reserved.has(t));
    const tokens = known.length ? known : snakeTokens.slice(0, 12);
    const lua = (() => { const f = src.match(/```(?:lua|luau)?\n([\s\S]*?)```/i); if (f && LUA_HINT_RE.test(f[1])) return f[1].trim(); return LUA_HINT_RE.test(src) && (src.match(/\bend\b/g) || []).length >= 1 ? src : ""; })();
    if (!kind) kind = lua && !/^(you are|always|never)/i.test(src) ? "skill" : (/\b(you are|act as|your role|always|never|priorit)/i.test(src) && src.length >= 400 ? "mode" : "ability");
    if (kind === "skill" && !lua) { warnings.push("no Luau found in the prompt - saved as an ability (procedure); ask the AI to turn it into a skill if it should run as one program"); kind = "ability"; }
    if (kind === "mode" && src.length < 80) { warnings.push("too short for a work-mode mandate - saved as an ability"); kind = "ability"; }
    const def = { kind, name, title, description, tags: ["from-prompt"], author: opts.author || "you", source: "manual" };
    if (kind === "skill") {
      const used = []; let m; PLACEHOLDER_RE.lastIndex = 0; while ((m = PLACEHOLDER_RE.exec(lua))) if (!used.includes(m[1])) used.push(m[1]);
      def.params = used.map((u) => ({ name: u, type: "string", description: `value for {{${u}}}` }));
      def.luau = lua.slice(0, LIMITS.luau);
      def.usage = `${name} ${JSON.stringify(Object.fromEntries(used.map((u) => [u, "..."])))}`;
    } else if (kind === "ability") {
      def.instructions = src.length > LIMITS.instructions ? src.slice(0, LIMITS.instructions - 60) + "\n[... prompt truncated to fit the ability limit]" : src;
      if (src.length > LIMITS.instructions) warnings.push(`prompt truncated to ${LIMITS.instructions} characters`);
      def.steps = (src.match(/^\s*(?:\d+[.)]|[-*•])\s+.+$/gm) || []).map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").trim()).filter((s) => s.length >= 4).slice(0, LIMITS.steps);
      def.commands = tokens.slice(0, LIMITS.commands);
      def.usage = `${name} {}`;
    } else {
      def.mandate = src.slice(0, LIMITS.mandate);
      if (src.length > LIMITS.mandate) warnings.push(`prompt truncated to ${LIMITS.mandate} characters`);
      def.base = "creation";
      def.badge = title.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase().slice(0, 12) || "PROMPT";
      def.focus = tokens.slice(0, LIMITS.focus);
      def.sub = description.slice(0, 120);
    }
    return { ok: true, errors: [], warnings, def };
  }
  // Install straight away (no AI). Returns the upsert result (+ warnings).
  function installFromPrompt(text, opts) {
    const r = fromPrompt(text, opts);
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, item: null };
    const u = upsert(r.def, { source: (opts && opts.source) || "manual", reserved: opts && opts.reserved });
    return Object.assign(u, { warnings: [...r.warnings, ...u.warnings], converted: r.def.kind });
  }
  function conversionPrompt(text, kindHint, ctx) {
    ctx = ctx || {};
    const kind = KINDS.includes(kindHint) ? kindHint : "auto";
    const prompt = String(text || "").trim();
    const existing = items.length ? `Already installed (do not reuse these names): ${items.map((i) => `${i.name} (${i.kind})`).join(", ")}.` : "";
    const names = Array.isArray(ctx.commandNames) && ctx.commandNames.length ? `Built-in command names you may reference in commands[]/focus[] (sample): ${ctx.commandNames.slice(0, 60).join(", ")}${ctx.commandNames.length > 60 ? " ..." : ""}.` : "";
    const kindLine = kind === "auto"
      ? "KIND: choose from the prompt itself - a behavioural/system prompt ('you are…', rules, priorities) becomes a MODE (mandate = the prompt, cleaned but complete); a step-by-step procedure becomes an ABILITY (instructions = the prompt, steps[] = its steps); a concrete, repeatable build with obvious variables becomes a SKILL (parameterised Luau that does exactly what the prompt describes)."
      : `KIND: ${kind} (the user chose this explicitly).`;
    return [
      "PROMPT → PUBLIC SKILL - the user wrote a full prompt and wants it installed as a reusable OrScript item. CONVERT it; do not redesign it.",
      "RULES: keep every instruction, rule and constraint from the prompt (rephrase only for clarity, never drop or soften); do not add behaviour the prompt does not ask for; pick a short title and a snake_case name from the prompt's subject; write a 1-2 sentence description of when to use it; for skills, turn the variable parts into params[] with sensible defaults and write complete Luau; for abilities keep the prompt as instructions and list 3-15 steps[] in its order; for modes keep the prompt as the mandate and pick base/badge/focus[].",
      kindLine,
      "PROCESS: (1) submit ONE public_skill_create {\"definition\": {...}}; (2) if VALIDATION_FAILED, fix and resubmit; (3) for skills run public_skill_test {\"name\"} once; (4) reply with one short paragraph: what was installed, how to call it, and what you changed from the prompt (ideally nothing).",
      "THE PROMPT (verbatim, between the markers):\n<<<PROMPT\n" + prompt + "\nPROMPT>>>",
      DEFINITION_DOC,
      existing,
      names,
    ].filter(Boolean).join("\n\n");
  }

  function onChange(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }
  function replaceAll(arr) { items = []; for (const d of arr || []) { const v = validate(d, { allowDuplicateId: true }); if (v.ok) items.push(v.item); } persist(); emit("reset", null); }

  const api = {
    KINDS, BASES, LEGACY_BASES, normalizeBase, PARAM_TYPES, NAME_RE, FORMAT, LIMITS, DEFINITION_DOC,
    load, isLoaded: () => loaded, onChange,
    validate, list, get, has, find, isCommand, upsert, update, remove, setEnabled, replaceAll,
    modes, activeMode, setActiveMode, modePrompt,
    buildLuau, syntaxCheckLuau, abilityText, resolveArgs, signature, schema, toolEntries, catalogueBlock,
    managementTools: () => clone(MANAGEMENT_TOOLS), generationPrompt,
    exportObject, exportJson, fileName, shareCode, parseShared, importShared, importPack, luauLiteral, snake,
    exportPackObject, exportPackJson, packFileName, packShareCode, PACK_FORMAT,
    parseText, exportText, textFileName, parseParamSpec,
    looksLikeFullPrompt, fromPrompt, installFromPrompt, conversionPrompt,
  };
  root.PublicSkills = api;
  try { root.__rsPublicMode = () => api.activeMode(); } catch {}
  try { load(); } catch {}
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
