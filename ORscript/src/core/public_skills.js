// OrScript — Public Skills
//
// User-made commands. Anyone can describe a Skill (a parameterised Luau program
// that runs in Studio), an Ability (a reusable procedure the agent follows) or a
// Work Mode (a mandate + focus list layered on Ultimate / Visualizer / Animator)
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
  const FORMAT_VERSION = 1;
  const KINDS = ["skill", "ability", "mode"];
  const BASES = ["ultimate", "visualizer", "animator"];
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
      item.base = BASES.includes(String(def.base || def.baseMode || "").toLowerCase()) ? String(def.base || def.baseMode).toLowerCase() : "ultimate";
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
    "MODE fields: title, badge (<=12 chars, uppercase), base ('ultimate'|'visualizer'|'animator'), sub (one line), note (menu blurb), mandate (80-9000 chars: priorities, quality bar, pipeline, verification rules - written like a senior specialist's standing orders), focus[] (10-40 real command names the mode leans on), toast.",
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
    { name: "public_skill_export", description: "Export a Public Skill as shareable JSON plus a share code the user can paste to others.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    { name: "public_skill_import", description: "Import a Public Skill from exported JSON text or a share code.", inputSchema: { type: "object", required: ["data"], properties: { data: { type: "string", description: "JSON text or ORSKILL1: share code" } } } },
  ].map((t) => Object.assign(t, { server: "orscript", executionMode: /create|update|delete|import|enable|test/.test(t.name) ? "WRITE" : "READ", environment: "GENERAL", category: "Public Skills" }));

  // ── Sharing ─────────────────────────────────────────────────────────────
  function exportObject(ref) {
    const item = find(ref);
    if (!item) return null;
    const out = clone(item);
    delete out.enabled; delete out.source; delete out.createdAt; delete out.updatedAt;
    return { format: FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), app: "OrScript", item: out };
  }
  const exportJson = (ref) => { const o = exportObject(ref); return o ? JSON.stringify(o, null, 2) : null; };
  const fileName = (ref) => { const i = find(ref); return i ? `${i.name || "mode"}.${i.kind}.orskill.json` : "public-skill.orskill.json"; };
  function b64encode(s) { try { return typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"); } catch { return ""; } }
  function b64decode(s) { try { return typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8"); } catch { return ""; } }
  function shareCode(ref) { const o = exportObject(ref); return o ? "ORSKILL1:" + b64encode(JSON.stringify(o)) : null; }
  function parseShared(text) {
    let s = String(text || "").trim();
    if (!s) return { ok: false, errors: ["nothing to import"] };
    if (/^ORSKILL1:/i.test(s)) { s = b64decode(s.slice(9).replace(/\s+/g, "")); if (!s) return { ok: false, errors: ["share code is corrupted"] }; }
    let j; try { j = JSON.parse(s); } catch { return { ok: false, errors: ["not valid JSON or share code"] }; }
    const def = j && j.format === FORMAT && j.item ? j.item : j && (j.kind || j.luau || j.mandate || j.instructions) ? j : null;
    if (!def) return { ok: false, errors: ["unrecognised file - expected an OrScript public skill export"] };
    return { ok: true, def };
  }
  function importShared(text, opts) {
    const p = parseShared(text);
    if (!p.ok) return { ok: false, errors: p.errors, warnings: [], item: null };
    const def = Object.assign({}, p.def);
    delete def.id; delete def.createdAt; delete def.updatedAt;
    const dup = items.find((i) => i.kind === def.kind && i.name === snake(def.name || def.title));
    if (dup && !(opts && opts.replace)) return { ok: false, errors: [`a ${dup.kind} named '${dup.name}' is already installed - delete it first or import with replace`], warnings: [], item: null, duplicate: clone(dup) };
    if (dup) def.id = dup.id;
    return upsert(def, Object.assign({ source: "import" }, opts || {}));
  }

  function onChange(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }
  function replaceAll(arr) { items = []; for (const d of arr || []) { const v = validate(d, { allowDuplicateId: true }); if (v.ok) items.push(v.item); } persist(); emit("reset", null); }

  const api = {
    KINDS, BASES, PARAM_TYPES, NAME_RE, FORMAT, LIMITS, DEFINITION_DOC,
    load, isLoaded: () => loaded, onChange,
    validate, list, get, has, find, isCommand, upsert, update, remove, setEnabled, replaceAll,
    modes, activeMode, setActiveMode, modePrompt,
    buildLuau, syntaxCheckLuau, abilityText, resolveArgs, signature, schema, toolEntries, catalogueBlock,
    managementTools: () => clone(MANAGEMENT_TOOLS), generationPrompt,
    exportObject, exportJson, fileName, shareCode, parseShared, importShared, luauLiteral, snake,
  };
  root.PublicSkills = api;
  try { root.__rsPublicMode = () => api.activeMode(); } catch {}
  try { load(); } catch {}
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
