// TotalScript — Public Skills
//
// User-made SKILLS. Since 2.20.0 a public skill is the same thing a built-in
// skill is - a package the agent can be handed:
//
//   * one or more COMMANDS   - parameterised Luau programs that run in Studio
//                               (the main command carries the skill's name;
//                               extra ones live in commands[]);
//   * TRIGGERS               - weighted words / phrases that say WHEN the skill
//                               applies (auto-selection: the catalogue ranks
//                               them for the request, the knowledge rides on
//                               the first tool result of a matching request);
//   * KNOWLEDGE              - the rules / pitfalls / procedure the agent must
//                               know while the skill is relevant (markdown);
//   * a VERIFY block         - Luau that checks the command's result in Studio.
//                               A skill stays callable but flagged UNVERIFIED
//                               until a real test pass (public_skill_test
//                               {dry_run:false} or the Public tab's Test
//                               button) ran the command AND the verify block.
//
// Abilities (prompt-only procedures) and custom work modes were retired in
// 2.20.0: only skills can be created. Stored abilities that contained Luau are
// converted to skills on load (their instructions become the knowledge);
// prompt-only abilities and modes are dropped once with a notice that offers
// their JSON for download (migrationNotice / migrationArchiveJson).
//
// The canonical, shareable format is SKILL.md: YAML front matter (name,
// description, triggers, params, references) + Markdown sections
// (## Knowledge, ## Command <name> with a ```luau fence, ## Verify). Export,
// share codes (ORSKILL2:) and import all speak it; legacy .orskill.json /
// .txt / ORSKILL1: imports still work.
//
// Storage is chrome.storage.local (key rsPublicSkills); nothing is uploaded.
// This file is DOM-free at top level (it is loaded in node by the tests).
(function (root) {
  "use strict";
  const KEY = "rsPublicSkills";
  const MODE_KEY = "rsPublicMode"; // retired in 2.20.0 - removed from storage on load
  const MIGRATION_KEY = "rsPublicSkillsMigration";
  const FORMAT = "totalscript-public-skill";
  const PACK_FORMAT = "totalscript-public-skill-pack";
  const FORMAT_VERSION = 2;
  const VERSION = "2.20.0";
  const KINDS = ["skill"];
  const LEGACY_KINDS = ["ability", "mode"];
  // Kept for packs written before 1.39.0 (they named a base mode); every base maps to Creation.
  const BASES = ["creation"];
  const LEGACY_BASES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };
  const normalizeBase = (b) => { const k = String(b || "").toLowerCase(); return BASES.includes(k) ? k : (LEGACY_BASES[k] || "creation"); };
  const PARAM_TYPES = ["string", "number", "boolean", "array", "object"];
  const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
  const PARAM_RE = /^[a-z][a-z0-9_]{0,40}$/;
  const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const LIMITS = { luau: 24000, verify: 8000, knowledge: 9000, params: 12, commands: 6, triggers: 16, references: 12, examples: 4, exampleBody: 3000, history: 10 };
  const PROMPT_MAX = 12;
  const PACK_SEPARATOR = "<!-- ======== next skill ======== -->";
  const libraryModule = () => { try { return root.PublicReferences && typeof root.PublicReferences.forItem === "function" ? root.PublicReferences : null; } catch { return null; } };

  let items = [];
  let migration = null;
  let loaded = false;
  let loadPromise = null;
  const listeners = new Set();

  const storage = () => { try { return root.chrome && root.chrome.storage && root.chrome.storage.local || null; } catch { return null; } };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const str = (v, max) => { const s = v == null ? "" : String(v); return max ? s.slice(0, max) : s; };
  const snake = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "").slice(0, 40);
  const uid = () => "ps_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const hashOf = (s) => { let h = 5381; const t = String(s || ""); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h.toString(36); };

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
        root.dispatchEvent(new root.CustomEvent("total-public-skills-change", { detail: { reason, item: item ? clone(item) : null } }));
      }
    } catch {}
  }

  // ── Load / persist (+ 2.20.0 migration) ─────────────────────────────────
  // migrateStored(rawItems) → { items, converted[], dropped[], archive[] }
  // Skills validate as before. Abilities whose instructions / steps / examples
  // contain Luau become skills (that Luau is the command, the prose becomes
  // knowledge). Prompt-only abilities and every mode are dropped; their
  // original JSON is kept in `archive` so the user can download it once.
  function migrateStored(raw) {
    const out = { items: [], converted: [], dropped: [], archive: [] };
    for (const it of Array.isArray(raw) ? raw : []) {
      if (!it || typeof it !== "object") continue;
      const kind = inferKind(it);
      if (kind === "skill") { const v = validate(it, { allowDuplicateId: true, installed: out.items }); if (v.ok) out.items.push(v.item); continue; }
      const conv = LEGACY_KINDS.includes(kind) ? convertLegacy(it) : null;
      if (conv) {
        const v = validate(conv, { allowDuplicateId: true, installed: out.items });
        if (v.ok) { out.items.push(v.item); out.converted.push({ name: v.item.name, title: v.item.title, from: kind }); continue; }
      }
      out.dropped.push({ name: it.name || snake(it.title) || "?", title: it.title || it.name || "?", kind: kind || "unknown", reason: kind === "mode" ? "work modes were retired - the mandate is behaviour, not a skill" : "no Luau to turn into a command" });
      out.archive.push(it);
    }
    return out;
  }
  function convertLegacy(it) {
    if (!it || it.kind !== "ability") return null;
    const text = [it.instructions, (it.steps || []).join("\n")].filter(Boolean).join("\n\n");
    const lua = extractLuau(text) || ((it.examples || []).map((e) => e && e.body).find((b) => b && LUA_HINT_RE.test(b)) || "");
    if (!lua || lua.trim().length < 20) return null;
    const prose = text.replace(/```[a-z]*\n[\s\S]*?```/gi, "").trim();
    const used = placeholdersIn(lua);
    const params = (Array.isArray(it.params) ? it.params : []).filter((p) => p && used.includes(p.name)).concat(used.filter((u) => !(it.params || []).some((p) => p && p.name === u)).map((u) => ({ name: u, type: "string", description: `value for {{${u}}}` })));
    return {
      id: it.id, kind: "skill", name: it.name, title: it.title, description: it.description, version: it.version, author: it.author, tags: it.tags, triggers: it.triggers,
      enabled: it.enabled, source: it.source, createdAt: it.createdAt, references: it.references, examples: it.examples, expert: it.expert, stats: it.stats,
      params, luau: lua.slice(0, LIMITS.luau), knowledge: prose.slice(0, LIMITS.knowledge),
      history: (it.history || []).concat([{ v: (parseInt(it.version, 10) || 1), at: Date.now(), note: "converted from an ability (2.20.0): its Luau is the command, the instructions are the knowledge" }]),
    };
  }
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      const st = storage();
      if (!st) { loaded = true; return resolve(list()); }
      try {
        st.get([KEY, MODE_KEY, MIGRATION_KEY], (r) => {
          try {
            const raw = r && Array.isArray(r[KEY]) ? r[KEY] : [];
            const m = migrateStored(raw);
            items = m.items;
            migration = r && r[MIGRATION_KEY] && typeof r[MIGRATION_KEY] === "object" ? r[MIGRATION_KEY] : null;
            if (m.converted.length || m.dropped.length) {
              migration = { at: Date.now(), version: "2.20.0", converted: m.converted, dropped: m.dropped, archive: m.archive };
              try { st.set({ [KEY]: clone(items), [MIGRATION_KEY]: migration }); } catch {}
            }
            if (r && r[MODE_KEY] !== undefined) { try { st.remove(MODE_KEY); } catch {} }
          } catch { items = []; }
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
    try { st.set({ [KEY]: clone(items) }); } catch {}
  }
  // migrationNotice() → the one-time 2.20.0 record (converted + dropped) until
  // dismissMigration(); migrationArchiveJson() → the dropped items' original JSON.
  const migrationNotice = () => (migration ? { at: migration.at, version: migration.version, converted: clone(migration.converted || []), dropped: clone(migration.dropped || []), archived: (migration.archive || []).length } : null);
  function dismissMigration() { migration = null; const st = storage(); try { if (st) st.remove(MIGRATION_KEY); } catch {} emit("migration", null); return true; }
  function migrationArchiveJson() { if (!migration || !(migration.archive || []).length) return null; return JSON.stringify({ format: "totalscript-public-skill-archive", formatVersion: 1, app: "TotalScript", note: "Abilities and work modes retired in 2.20.0 - kept here for your records; they cannot be imported again.", exportedAt: new Date().toISOString(), items: migration.archive }, null, 2); }

  // ── Validation ──────────────────────────────────────────────────────────
  function inferKind(def) {
    if (!def) return "";
    if (def.kind === "skill" || def.kind === "command") return "skill";
    if (LEGACY_KINDS.includes(def.kind) || /^work ?mode$/.test(String(def.kind || ""))) return def.kind === "ability" ? "ability" : "mode";
    if (typeof def.luau === "string" || (Array.isArray(def.commands) && def.commands.some((c) => c && typeof c.luau === "string"))) return "skill";
    if (typeof def.mandate === "string") return "mode";
    if (typeof def.instructions === "string" || Array.isArray(def.steps)) return "ability";
    return "";
  }
  const placeholdersIn = (luau) => { const used = []; let m; PLACEHOLDER_RE.lastIndex = 0; while ((m = PLACEHOLDER_RE.exec(String(luau || "")))) if (!used.includes(m[1])) used.push(m[1]); return used; };
  function normalizeParams(raw, errors, warnings, where) {
    const out = [];
    const pre = where ? `${where}: ` : "";
    // Shorthands: "count: number = 6 \"how many\"" (string), {count: "number = 6"} /
    // {count: {type}} (object entry) and the SKILL.md list form `- count: number = 6 "doc"`
    // (parseYamlLite yields {count: 'number = 6 "doc"'}).
    const spec = (name, v) => {
      if (v && typeof v === "object") return Object.assign({ name }, v);
      const m = String(v == null ? "" : v).trim().match(/^([A-Za-z_][\w\[\]]*)?\s*(\??)\s*(?:=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"\s][^"]*?))?\s*(?:"((?:[^"\\]|\\.)*)")?\s*$/);
      const out = { name, type: (m && m[1]) || "string" };
      if (m && m[2]) out.required = false;
      if (m && m[3] !== undefined) { let d = m[3].trim(); if (/^(["']).*\1$/.test(d)) d = d.slice(1, -1); else if (/^-?\d+(\.\d+)?$/.test(d)) d = Number(d); else if (d === "true" || d === "false") d = d === "true"; out.default = d; }
      if (m && m[4]) out.description = m[4];
      return out;
    };
    const arr = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([name, p]) => spec(name, p)) : []).map((p) => {
      if (typeof p === "string") { const mm = p.match(/^\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/); return mm ? spec(mm[1], mm[2]) : null; }
      if (p && typeof p === "object" && !p.name) { const keys = Object.keys(p); if (keys.length === 1) return spec(keys[0], p[keys[0]]); }
      return p;
    });
    for (const p of arr.slice(0, LIMITS.params)) {
      if (!p || typeof p !== "object") continue;
      const name = snake(p.name);
      if (!PARAM_RE.test(name)) { errors.push(`${pre}param name '${p.name}' must be snake_case (letters, digits, underscores)`); continue; }
      if (out.some((x) => x.name === name)) { errors.push(`${pre}duplicate param '${name}'`); continue; }
      let type = String(p.type || "string").toLowerCase().replace(/\[\]$/, "array");
      if (/^(int|integer|float|num)/.test(type)) type = "number";
      if (/^(bool)/.test(type)) type = "boolean";
      if (/^(list|arr)/.test(type)) type = "array";
      if (/^(dict|map|json|table)/.test(type)) type = "object";
      if (!PARAM_TYPES.includes(type)) { warnings.push(`${pre}param '${name}': unknown type '${p.type}', using string`); type = "string"; }
      const item = { name, type, description: str(p.description || p.desc, 240), required: p.required === true || (p.required == null && p.default === undefined && p.optional !== true) };
      if (p.default !== undefined) item.default = p.default;
      if (Array.isArray(p.enum) && p.enum.length) item.enum = p.enum.slice(0, 20).map((e) => String(e));
      out.push(item);
    }
    if (arr.length > LIMITS.params) warnings.push(`${pre}only the first ${LIMITS.params} params were kept`);
    return out;
  }
  function stringList(v, max, lower) {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n|,/) : [];
    const out = [];
    for (const x of arr) { const s = str(x).trim(); if (s && !out.includes(lower ? s.toLowerCase() : s)) out.push(lower ? s.toLowerCase() : s); if (out.length >= max) break; }
    return out;
  }
  // triggers: ["boss arena", "arena:4", {word:"throne", weight:2}, {"safe zone": 4}] or
  // "a, b:3" → { triggers: [lower-case words/phrases], weights: {phrase: n} (only when given) }
  function normalizeTriggers(raw) {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n|,/) : raw && typeof raw === "object" ? Object.entries(raw).map(([w, n]) => ({ word: w, weight: n })) : [];
    const triggers = [], weights = {};
    const add = (w, n) => {
      const word = String(w || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!word || word.length > 40 || triggers.includes(word) || triggers.length >= LIMITS.triggers) return;
      triggers.push(word);
      const num = Number(n);
      if (Number.isFinite(num) && num > 0 && num !== 1) weights[word] = Math.min(9, Math.max(1, Math.round(num)));
    };
    for (const t of list) {
      if (t == null) continue;
      if (typeof t === "object" && !Array.isArray(t)) {
        if (t.word || t.phrase || t.trigger) add(t.word || t.phrase || t.trigger, t.weight || t.score);
        else for (const [w, n] of Object.entries(t)) add(w, n);
        continue;
      }
      const s = String(t).trim();
      const m = s.match(/^(.*?)\s*[:=]\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) add(m[1], m[2]); else add(s, 1);
    }
    return { triggers, weights };
  }
  const triggerWeight = (item, word) => (item && item.weights && Number(item.weights[word])) || 1;

  // ── References (1.99.7) ──────────────────────────────────────────────────
  const DOCS_HOST = "https://create.roblox.com/docs/";
  const refsModule = () => { try { return root.TotalSkillRefs && typeof root.TotalSkillRefs.refs === "function" ? root.TotalSkillRefs : null; } catch { return null; } };
  const intelModule = () => { try { return root.TotalSkillIntel && typeof root.TotalSkillIntel.select === "function" ? root.TotalSkillIntel : null; } catch { return null; } };
  const URL_RE = /(https?:\/\/[^\s"'<>|]+|\/?docs\/[^\s"'<>|]+)/i;
  function normalizeUrl(u) {
    let v = String(u || "").trim().replace(/[),.;:]+$/, "").replace(/\/+$/, "");
    if (!v) return null;
    if (/^\/?docs\//i.test(v)) v = DOCS_HOST + v.replace(/^\/?docs\//i, "");
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(v)) return null;
    return v;
  }
  const titleFromUrl = (u) => { try { const seg = decodeURIComponent(String(u).replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || ""); return titleCase(seg.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ")).slice(0, 80) || "Reference"; } catch { return "Reference"; } };
  function normalizeReferences(raw, warnings) {
    const out = []; const seen = new Set();
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n|;/) : raw && typeof raw === "object" ? Object.entries(raw).map(([t, u]) => ({ title: t, url: u })) : [];
    for (const entry of list) {
      if (out.length >= LIMITS.references) { warnings.push(`only the first ${LIMITS.references} references are kept`); break; }
      let title = "", url = "", note = "";
      if (typeof entry === "string") {
        const t = entry.trim().replace(/^[-*•]\s*/, "");
        if (!t) continue;
        const m = t.match(URL_RE);
        if (!m) { warnings.push(`reference dropped (no http(s) URL): ${t.slice(0, 60)}`); continue; }
        url = m[1]; title = (t.slice(0, m.index) + " " + t.slice(m.index + m[1].length)).replace(/[|—–:]+/g, " ").replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim();
      } else if (entry && typeof entry === "object") {
        url = String(entry.url || entry.href || entry.link || entry.path || "").trim(); title = str(entry.title || entry.name || entry.label, 80).trim(); note = str(entry.note || entry.why, 160).trim();
      } else continue;
      const nu = normalizeUrl(url);
      if (!nu) { warnings.push(`reference dropped (not an http(s) URL): ${String(url || title).slice(0, 60)}`); continue; }
      if (seen.has(nu)) continue;
      seen.add(nu);
      const ref = { title: (title || titleFromUrl(nu)).slice(0, 80), url: nu };
      if (note) ref.note = note;
      out.push(ref);
    }
    return out;
  }
  function normalizeExamples(raw, warnings) {
    const out = [];
    for (const e of Array.isArray(raw) ? raw : []) {
      if (out.length >= LIMITS.examples) { warnings.push(`only the first ${LIMITS.examples} examples are kept`); break; }
      const obj = e && typeof e === "object" ? e : { body: e };
      const body = String(obj.body || obj.code || obj.luau || "").replace(/\r\n?/g, "\n").replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
      const title = str(obj.title || obj.name, 100).trim() || `Example ${out.length + 1}`;
      if (body.length < 20) { warnings.push(`example '${title}' dropped (under 20 characters)`); continue; }
      if (body.length > LIMITS.exampleBody) { warnings.push(`example '${title}' dropped (${body.length} > ${LIMITS.exampleBody} chars)`); continue; }
      if (/`/.test(body)) { warnings.push(`example '${title}' dropped (backticks break the chat rendering)`); continue; }
      const ex = { title, lang: /^(lua|luau|text|json)$/i.test(String(obj.lang || "")) ? String(obj.lang).toLowerCase() : "luau", body };
      const note = str(obj.note, 200).trim(); if (note) ex.note = note;
      out.push(ex);
    }
    return out;
  }
  const sanitizeStats = (s) => ({ runs: Math.max(0, parseInt(s && s.runs, 10) || 0), ok: Math.max(0, parseInt(s && s.ok, 10) || 0), fail: Math.max(0, parseInt(s && s.fail, 10) || 0), lastRunAt: Number(s && s.lastRunAt) || 0, lastOk: s && s.lastOk === true, lastError: str(s && s.lastError, 200) });
  const HISTORY_FIELDS = ["title", "description", "params", "luau", "commands", "knowledge", "verify", "references", "examples", "triggers", "tags", "usage", "expert"];

  // Luau lint shared by the main command, extra commands and the verify block.
  function lintLuau(luau, declared, errors, warnings, where, opts) {
    opts = opts || {};
    const pre = where ? `${where}: ` : "";
    if (luau.trim().length < (opts.min || 20)) errors.push(`${pre}luau must contain the Luau program (at least ${opts.min || 20} characters)`);
    if (luau.length > (opts.max || LIMITS.luau)) errors.push(`${pre}luau is too long (${luau.length} > ${opts.max || LIMITS.luau} chars) - split the work or simplify`);
    const used = new Set(placeholdersIn(luau));
    for (const u of used) if (!declared.has(u)) errors.push(`${pre}placeholder {{${u}}} is used in luau but not declared in params`);
    if (!opts.verify) for (const d of declared) if (!used.has(d) && !new RegExp("args\\s*[.\\[]\\s*[\"']?" + d).test(luau)) warnings.push(`${pre}param '${d}' is never read by the luau (use {{${d}}} or args.${d})`);
    if (/\bplugin\s*[:.]/.test(luau)) warnings.push(`${pre}the \`plugin\` global is not available to execute_luau - this may fail in Studio`);
    if (/\bwait\s*\(\s*(\d+)/.test(luau) && Number(RegExp.$1) > 5) warnings.push(`${pre}long waits stall the command; keep yields under 5 seconds`);
    if (/\brequire\s*\(\s*\d{5,}/.test(luau)) warnings.push(`${pre}require(assetId) pulls remote code - reviewers should check that asset`);
    if (/HttpService\s*:\s*(GetAsync|PostAsync|RequestAsync)/.test(luau)) warnings.push(`${pre}the code makes HTTP requests from Studio`);
    const stripped = luau.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, " ").replace(/--[^\n]*/g, " ").replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    const opens = (stripped.match(/\b(function|if|do|repeat)\b/g) || []).length;
    const ends = (stripped.match(/\b(end|until)\b/g) || []).length;
    if (Math.abs(opens - ends) > 2) warnings.push(`${pre}block keywords and \`end\`s look unbalanced (${opens} openers vs ${ends} closers) - public_skill_test {name} checks the syntax in Studio`);
    // A verify block that neither returns nor checks anything would pass every
    // time (nil counts as ok) - that is not a test, so it is an error.
    if (opts.verify && !/\breturn\b/.test(stripped) && !/\b(check|error|assert)\s*\(/.test(stripped)) errors.push("verify: the block never returns and never calls check()/error()/assert() - it could not fail, so it proves nothing; return {ok=true} / {ok=false, error='...'} or use check(cond, message)");
    else if (opts.verify && !/\breturn\b/.test(stripped)) warnings.push("verify: the block never returns - return {ok=true, detail=...} so the test result is explicit");
  }
  const sanitizeTested = (t) => (t && typeof t === "object" && /^(syntax|run|verified)$/.test(String(t.level)) && t.hash ? { level: t.level, at: Number(t.at) || 0, version: Math.max(1, parseInt(t.version, 10) || 1), hash: String(t.hash), detail: str(t.detail, 300) } : null);

  // validate(def, {reserved:Set|Array of built-in command names, allowDuplicateId, installed})
  // -> {ok, errors[], warnings[], item}
  function validate(def, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, errors: ["definition must be an object"], warnings, item: null };
    if (def.definition && typeof def.definition === "object" && !def.kind && !def.luau) def = def.definition;
    const kind = inferKind(def);
    if (kind !== "skill") {
      errors.push(LEGACY_KINDS.includes(kind)
        ? `kind '${kind}' was retired in 2.20.0 - only skills exist now. Put the procedure / rules into \`knowledge\` and write the work as Luau in \`luau\` (plus a \`verify\` block)`
        : "a skill needs `luau` (the main command's Luau program; params become {{placeholders}} / args.*)");
      return { ok: false, errors, warnings, item: null };
    }
    let name = snake(def.name || def.command || def.title || def.displayName);
    const title = str(def.title || def.displayName || titleCase(name), 80).trim();
    if (!NAME_RE.test(name)) errors.push(`name '${def.name || title}' must be snake_case, 3-41 chars, starting with a letter (e.g. spawn_lantern_row)`);
    const reserved = opts.reserved instanceof Set ? opts.reserved : new Set(Array.isArray(opts.reserved) ? opts.reserved : []);
    if (name && reserved.has(name)) errors.push(`name '${name}' collides with a built-in command - pick another name`);
    if (name && /^public_skill_/.test(name)) errors.push("names starting with public_skill_ are reserved");
    const description = str(def.description || def.desc, 600).trim();
    if (description.length < 10) errors.push("description must be at least 10 characters (what it does, when to use it)");
    const tr = normalizeTriggers(def.triggers || def.when || def.use_when);
    if (def.weights && typeof def.weights === "object") for (const [w, n] of Object.entries(def.weights)) { const k = String(w).toLowerCase(); const num = Number(n); if (tr.triggers.includes(k) && tr.weights[k] === undefined && Number.isFinite(num) && num > 1) tr.weights[k] = Math.min(9, Math.round(num)); }
    const item = {
      id: typeof def.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(def.id) ? def.id : uid(),
      kind: "skill", name, title: title || titleCase(name), description,
      version: Math.max(1, parseInt(def.version, 10) || 1),
      author: str(def.author, 60).trim() || "you",
      tags: stringList(def.tags, 10, true),
      triggers: tr.triggers,
      enabled: def.enabled !== false,
      source: ["ai", "import", "manual"].includes(def.source) ? def.source : "manual",
      createdAt: Number(def.createdAt) || Date.now(),
      updatedAt: Date.now(),
      params: [],
    };
    if (Object.keys(tr.weights).length) item.weights = tr.weights;
    if (def.usage) item.usage = str(def.usage, 300);
    item.references = normalizeReferences(def.references || def.refs || def.docs || def.links, warnings);
    item.examples = normalizeExamples(def.examples, warnings);
    const expert = snake(def.expert || def.related_expert || def.relatedExpert || "");
    if (expert) { const SI = intelModule(); if (SI && Array.isArray(SI.IDS) && !SI.IDS.includes(expert)) warnings.push(`expert '${expert}' is not a built-in expert - the nearest one is auto-detected instead`); else item.expert = expert; }
    if (def.stats && typeof def.stats === "object") item.stats = sanitizeStats(def.stats);
    if (Array.isArray(def.history) && def.history.length) item.history = def.history.filter((h) => h && typeof h === "object").slice(-LIMITS.history).map((h) => ({ v: Math.max(1, parseInt(h.v, 10) || 1), at: Number(h.at) || 0, note: str(h.note, 160) }));
    // main command
    item.params = normalizeParams(def.params || def.parameters || def.arguments, errors, warnings);
    const luau = str(def.luau || def.code || def.source_code).replace(/\r\n?/g, "\n");
    lintLuau(luau, new Set(item.params.map((p) => p.name)), errors, warnings, "");
    item.luau = luau;
    item.executionMode = /^(READ|WRITE)$/.test(String(def.executionMode)) ? def.executionMode : "WRITE";
    // extra commands
    item.commands = [];
    const rawCmds = Array.isArray(def.commands) ? def.commands : [];
    if (rawCmds.length > LIMITS.commands) warnings.push(`only the first ${LIMITS.commands} extra commands are kept`);
    for (const c of rawCmds.slice(0, LIMITS.commands)) {
      if (!c || typeof c !== "object") { if (typeof c === "string") warnings.push(`commands[] entry '${c}' ignored - since 2.20.0 commands[] holds {name, description, params, luau} objects (built-in command names belong in knowledge)`); continue; }
      const cname = snake(c.name || c.command || c.title);
      const where = `command '${cname || "?"}'`;
      if (!NAME_RE.test(cname)) { errors.push(`${where}: name must be snake_case, 3-41 chars`); continue; }
      if (cname === name || item.commands.some((x) => x.name === cname)) { errors.push(`${where}: duplicate command name inside the skill`); continue; }
      if (reserved.has(cname)) errors.push(`${where}: collides with a built-in command - pick another name`);
      if (/^public_skill_/.test(cname)) errors.push(`${where}: names starting with public_skill_ are reserved`);
      const cparams = normalizeParams(c.params || c.parameters || c.arguments, errors, warnings, where);
      const cl = str(c.luau || c.code).replace(/\r\n?/g, "\n");
      lintLuau(cl, new Set(cparams.map((p) => p.name)), errors, warnings, where);
      const cdesc = str(c.description || c.desc, 400).trim();
      if (cdesc.length < 10) errors.push(`${where}: description must be at least 10 characters`);
      item.commands.push({ name: cname, title: str(c.title, 80).trim() || titleCase(cname), description: cdesc, params: cparams, luau: cl, executionMode: /^(READ|WRITE)$/.test(String(c.executionMode)) ? c.executionMode : "WRITE" });
    }
    // knowledge (markdown the agent reads while the skill is relevant)
    const knowledge = str(def.knowledge || def.instructions || def.rules || def.notes_for_agent).replace(/\r\n?/g, "\n").trim();
    if (knowledge.length > LIMITS.knowledge) warnings.push(`knowledge truncated to ${LIMITS.knowledge} characters`);
    item.knowledge = knowledge.slice(0, LIMITS.knowledge);
    // verify block
    const vraw = def.verify == null ? null : typeof def.verify === "string" ? { luau: def.verify } : def.verify;
    if (vraw && typeof vraw === "object" && str(vraw.luau || vraw.code).trim()) {
      const vl = str(vraw.luau || vraw.code).replace(/\r\n?/g, "\n");
      lintLuau(vl, new Set(item.params.map((p) => p.name)), errors, warnings, "verify", { verify: true, min: 10, max: LIMITS.verify });
      item.verify = { luau: vl };
      const note = str(vraw.note || vraw.description, 300).trim(); if (note) item.verify.note = note;
    } else {
      item.verify = null;
      warnings.push("no verify block - the skill stays UNVERIFIED (callable, flagged) until one is added and passes; add verify {luau} that checks the result in Studio and returns {ok=true} or {ok=false, error}");
    }
    item.tested = sanitizeTested(def.tested);
    if (item.tested && item.tested.hash !== codeHash(item)) item.tested = Object.assign(item.tested, { stale: true });
    // Uniqueness against installed items (all command names share one namespace).
    if (!errors.length) {
      const pool = Array.isArray(opts.installed) ? opts.installed : items;
      const names = [item.name].concat(item.commands.map((c) => c.name));
      for (const other of pool) {
        if (other.id === item.id) continue;
        const theirs = [other.name].concat((other.commands || []).map((c) => c.name));
        const clash = names.find((n) => theirs.includes(n));
        if (clash && !opts.allowDuplicateId) { errors.push(clash === item.name && clash === other.name ? `a skill named '${clash}' already exists (id ${other.id}) - use public_skill_update, or choose another name` : `command name '${clash}' is already used by skill '${other.name}' - command names are unique across all public skills`); break; }
      }
    }
    return { ok: !errors.length, errors, warnings, item: errors.length ? null : item };
  }
  // codeHash(item) - what a test pass vouches for: every command's Luau +
  // params + the verify block. Any change to those makes the pass stale.
  const codeHash = (it) => hashOf(JSON.stringify([it.luau, it.params, (it.commands || []).map((c) => [c.name, c.params, c.luau]), it.verify && it.verify.luau]));

  // ── CRUD ─────────────────────────────────────────────────────────────
  function list(filter) {
    let out = items.map(clone);
    if (filter && filter.kind && filter.kind !== "skill") return [];
    if (filter && filter.enabled != null) out = out.filter((i) => i.enabled === !!filter.enabled);
    if (filter && filter.verified != null) out = out.filter((i) => (verification(i).state === "verified") === !!filter.verified);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  function find(ref) {
    if (!ref) return null;
    if (typeof ref === "object") ref = ref.id || ref.name;
    ref = String(ref).trim();
    const bare = snake(ref.includes("/") ? ref.split("/").pop() : ref);
    return items.find((i) => i.id === ref) || items.find((i) => i.name === bare) || items.find((i) => (i.commands || []).some((c) => c.name === bare)) || null;
  }
  // commandOf(ref) → { item, cmd:{name, description, params, luau, executionMode, main} } for a
  // skill name (main command) or one of its extra command names.
  function commandOf(ref) {
    const item = find(ref);
    if (!item) return null;
    const bare = typeof ref === "string" ? snake(ref.includes("/") ? ref.split("/").pop() : ref) : "";
    const sub = bare && bare !== item.name ? (item.commands || []).find((c) => c.name === bare) : null;
    const cmd = sub ? Object.assign({ main: false }, sub) : { name: item.name, title: item.title, description: item.description, params: item.params, luau: item.luau, executionMode: item.executionMode, main: true };
    return { item, cmd };
  }
  const get = (ref) => { const i = find(ref); return i ? clone(i) : null; };
  const has = (name) => !!find(name);
  const isCommand = (name) => { const r = commandOf(name); return !!(r && r.item.enabled); };

  function upsert(def, opts) {
    opts = opts || {};
    const existing = def && def.id ? items.find((i) => i.id === def.id) : null;
    const merged = existing ? Object.assign({}, existing, def, { id: existing.id, createdAt: existing.createdAt, version: def.version || existing.version + (opts.bump === false ? 0 : 1) }) : def;
    if (opts.source && merged && typeof merged === "object") merged.source = opts.source;
    const v = validate(merged, opts);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, item: null };
    const idx = items.findIndex((i) => i.id === v.item.id);
    if (idx >= 0) {
      const changed = HISTORY_FIELDS.filter((k) => JSON.stringify(items[idx][k] === undefined ? null : items[idx][k]) !== JSON.stringify(v.item[k] === undefined ? null : v.item[k]));
      if (changed.length) v.item.history = (items[idx].history || []).concat([{ v: v.item.version, at: Date.now(), note: "changed " + changed.join(", ") }]).slice(-LIMITS.history);
      else if (items[idx].history) v.item.history = items[idx].history;
      if (items[idx].stats && !v.item.stats) v.item.stats = items[idx].stats;
      // a test pass survives edits that do not touch the code; code edits leave it marked stale
      if (items[idx].tested && !def.tested) { v.item.tested = Object.assign({}, items[idx].tested); if (v.item.tested.hash !== codeHash(v.item)) v.item.tested.stale = true; }
    }
    if (idx >= 0) items[idx] = v.item; else items.push(v.item);
    persist();
    emit(idx >= 0 ? "updated" : "created", v.item);
    return { ok: true, errors: [], warnings: v.warnings, item: clone(v.item), created: idx < 0 };
  }
  function update(ref, patch, opts) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`unknown public skill '${typeof ref === "object" ? JSON.stringify(ref) : ref}'`], warnings: [], item: null };
    const next = Object.assign({}, cur, patch || {}, { id: cur.id, kind: "skill" });
    if (!(patch && Number(patch.version) > cur.version)) next.version = cur.version + 1;
    return upsert(next, opts);
  }
  function remove(ref) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: ["not found"], item: null };
    items = items.filter((i) => i.id !== cur.id);
    persist();
    try { const L = libraryModule(); if (L && typeof L.renameAttachment === "function") L.renameAttachment(cur.name, ""); } catch {}
    emit("removed", cur);
    return { ok: true, errors: [], item: clone(cur) };
  }
  function setEnabled(ref, on) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: ["not found"], item: null };
    cur.enabled = !!on; cur.updatedAt = Date.now();
    persist();
    emit("toggled", cur);
    return { ok: true, errors: [], item: clone(cur) };
  }
  function recordRun(ref, ok, error) {
    const cur = find(ref);
    if (!cur) return null;
    const st = sanitizeStats(cur.stats || {});
    st.runs++; if (ok) st.ok++; else st.fail++;
    st.lastRunAt = Date.now(); st.lastOk = !!ok; st.lastError = ok ? "" : str(error, 200);
    cur.stats = st; persist(); emit("ran", cur);
    return clone(st);
  }

  // ── Verification state ───────────────────────────────────────────────────
  // verification(item) → { state, label, flag, at, version, detail }
  //   unverified - never tested on this device
  //   syntax     - public_skill_test {dry_run:true} compiled it in Studio
  //   ran        - a real run succeeded but there is no verify block (or it did not run)
  //   verified   - the command ran AND the verify block returned ok=true
  //   stale      - a pass exists but the Luau / params / verify changed since
  function verification(item) {
    const it = item && typeof item === "object" && Array.isArray(item.params) ? item : find(item);
    if (!it) return { state: "unverified", label: "UNVERIFIED", flag: "UNVERIFIED", at: 0, version: 0, detail: "" };
    const t = it.tested;
    if (!t) return { state: "unverified", label: "UNVERIFIED", flag: "UNVERIFIED", at: 0, version: 0, detail: it.verify ? "not tested yet - public_skill_test {name, dry_run:false} runs the command and its verify block" : "no verify block yet" };
    if (t.hash !== codeHash(it) || t.stale) return { state: "stale", label: "STALE", flag: "UNVERIFIED (code changed since the last test)", at: t.at, version: t.version, detail: t.detail || "" };
    if (t.level === "verified") return { state: "verified", label: "VERIFIED", flag: "VERIFIED", at: t.at, version: t.version, detail: t.detail || "" };
    if (t.level === "run") return { state: "ran", label: "RAN", flag: "UNVERIFIED (ran OK, no verify block passed)", at: t.at, version: t.version, detail: t.detail || "" };
    return { state: "syntax", label: "SYNTAX OK", flag: "UNVERIFIED (syntax checked only)", at: t.at, version: t.version, detail: t.detail || "" };
  }
  // markTested(ref, level, detail) - called by the test runner after Studio
  // answered. Never downgrades a verified pass of the SAME code to syntax.
  function markTested(ref, level, detail) {
    const cur = find(ref);
    if (!cur) return null;
    if (!/^(syntax|run|verified)$/.test(String(level))) return verification(cur);
    const h = codeHash(cur);
    const rank = { syntax: 1, run: 2, verified: 3 };
    if (cur.tested && cur.tested.hash === h && !cur.tested.stale && rank[cur.tested.level] > rank[level]) return verification(cur);
    cur.tested = { level, at: Date.now(), version: cur.version, hash: h, detail: str(detail, 300) };
    cur.updatedAt = Date.now();
    persist();
    emit("tested", cur);
    return verification(cur);
  }
  const clearTested = (ref) => { const cur = find(ref); if (!cur) return false; cur.tested = null; persist(); emit("tested", cur); return true; };

  // ── References / library (1.99.7 / 2.2.2) ──────────────────────────────
  function relatedExpert(item) {
    const SI = intelModule();
    if (!SI || !item) return null;
    if (item.expert && Array.isArray(SI.IDS) && SI.IDS.includes(item.expert)) return { id: item.expert, why: ["set by the author"], explicit: true };
    try {
      const text = [item.title, item.description, (item.tags || []).join(" "), (item.triggers || []).join(" "), (item.commands || []).map((c) => c.name + " " + c.description).join(" "), String(item.knowledge || "").slice(0, 400)].filter(Boolean).join(" ");
      const sel = SI.select(SI.analyze(text, { engine: "roblox" }), { max: 1 });
      const p = sel && sel.picked && sel.picked[0];
      return p ? { id: p.id, why: [].concat(p.why || []).slice(0, 4), explicit: false } : null;
    } catch { return null; }
  }
  function referencesFor(ref, opts) {
    opts = opts || {};
    const item = find(ref);
    if (!item) return null;
    const R = refsModule();
    const known = new Map();
    if (R && typeof R.all === "function") { try { for (const e of R.all()) for (const r of e.refs || []) if (!r.unverified) known.set(r.url, e.id); } catch {} }
    const own = (item.references || []).map((r) => Object.assign({}, r, { verified: known.has(r.url), verifiedBy: known.get(r.url) || null }));
    const exp = relatedExpert(item);
    const inherited = { expert: exp ? exp.id : null, explicit: !!(exp && exp.explicit), why: exp ? exp.why : [], refs: [], examples: [] };
    if (exp && R) {
      const ownUrls = new Set(own.map((r) => r.url));
      const maxInherited = opts.maxInherited == null ? 6 : Math.max(0, opts.maxInherited);
      inherited.refs = (R.refs(exp.id) || []).filter((r) => !ownUrls.has(r.url)).slice(0, maxInherited).map((r) => ({ title: r.title, url: r.url, verified: !r.unverified }));
      const maxEx = opts.maxExamples == null ? 1 : Math.max(0, opts.maxExamples);
      const q = opts.query || [item.title, item.description, (item.tags || []).join(" "), (item.triggers || []).join(" ")].join(" ");
      if (maxEx && typeof R.exampleRank === "function") inherited.examples = R.exampleRank(exp.id, q).slice(0, maxEx).map((x) => ({ title: x.example.title, body: x.example.body, note: x.example.note || "" }));
    }
    return { name: item.name, kind: item.kind, own, examples: clone(item.examples || []), inherited, library: libraryFor(item.name) };
  }
  function libraryFor(name) { const L = libraryModule(); if (!L) return []; try { return L.forItem(name); } catch { return []; } }
  function libraryText(nameOrEntries, opts) {
    const L = libraryModule(); if (!L) return "";
    opts = opts || {};
    try {
      const entries = Array.isArray(nameOrEntries) ? nameOrEntries : nameOrEntries ? L.forItem(nameOrEntries, { design: !!opts.design }) : opts.design ? L.designEntries() : [];
      return L.textFor(entries, { budget: opts.budget, heading: opts.heading });
    } catch { return ""; }
  }
  // referencesText(ref, {budget, query, inherit}) - the REFERENCES / EXAMPLES /
  // USER REFERENCES block (used by knowledgeText and public_skill_get).
  function referencesText(ref, opts) {
    opts = opts || {};
    const info = referencesFor(ref, opts);
    if (!info) return "";
    const inherit = opts.inherit !== false;
    const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 4000;
    const L = [];
    const examples = info.examples.concat(inherit ? info.inherited.examples.map((x) => Object.assign({}, x, { from: info.inherited.expert })) : []);
    if (examples.length) {
      L.push("REFERENCE EXAMPLES (copy the shape, rename for this place; nothing here ran):");
      let used = 0;
      for (const e of examples) {
        const block = `--- ${e.title}${e.from ? ` [from built-in ${e.from}]` : ""} ---\n${e.note ? "-- " + e.note + "\n" : ""}${e.body}`;
        if (used + block.length > budget) { L.push(`(further example omitted for length: ${e.title})`); continue; }
        L.push(block); used += block.length;
      }
    }
    const refs = info.own.concat(inherit ? info.inherited.refs.map((r) => Object.assign({}, r, { from: info.inherited.expert })) : []);
    if (refs.length) {
      L.push(L.length ? "" : null, "REFERENCES (official documentation - read these before inventing an API; 'verified' = the page was checked offline against the Roblox docs listing):");
      for (const r of refs) L.push(`- ${r.title} — ${r.url}${r.verified ? " (verified)" : " (not verified offline)"}${r.from ? ` [from built-in ${r.from}]` : ""}`);
    }
    const lib = libraryText(info.library, { budget: Math.min(budget, Number(opts.libraryBudget) > 0 ? Number(opts.libraryBudget) : 3000) });
    if (lib) L.push(L.length ? "" : null, lib);
    if (inherit && info.inherited.expert) L.push(L.length ? "" : null, `RELATED BUILT-IN EXPERT: ${info.inherited.expert}${info.inherited.explicit ? "" : " (auto-detected)"} - skill {name: "${info.inherited.expert}"} prints its full procedure.`);
    return L.filter((x) => x !== null).join("\n");
  }
  function addReferences(ref, list, opts) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`unknown public skill '${ref}'`], warnings: [], item: null };
    const warnings = [];
    const add = normalizeReferences(list, warnings);
    if (!add.length) return { ok: false, errors: ["no valid reference to add (each needs an http(s) URL; '/docs/...' paths resolve to the Roblox Creator Docs)"], warnings, item: null };
    const have = new Set((cur.references || []).map((r) => r.url));
    const merged = (cur.references || []).concat(add.filter((r) => !have.has(r.url)));
    const r = update(cur.id, { references: merged }, opts);
    return Object.assign(r, { warnings: warnings.concat(r.warnings || []), added: add.filter((x) => !have.has(x.url)).length });
  }
  function removeReferences(ref, keys, opts) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`unknown public skill '${ref}'`], warnings: [], item: null };
    const ks = [].concat(keys == null ? [] : keys).map((k) => String(k).trim().toLowerCase());
    const kept = (cur.references || []).filter((r, i) => !ks.includes(String(i + 1)) && !ks.includes(r.url.toLowerCase()) && !ks.includes(r.title.toLowerCase()));
    if (kept.length === (cur.references || []).length) return { ok: false, errors: ["nothing matched - pass a url, a title or the 1-based index from public_skill_refs"], warnings: [], item: null };
    const r = update(cur.id, { references: kept }, opts);
    return Object.assign(r, { removed: (cur.references || []).length - kept.length });
  }
  function adoptSuggested(ref, max, opts) {
    const info = referencesFor(ref, { maxInherited: max == null ? 4 : max, maxExamples: 0 });
    if (!info) return { ok: false, errors: [`unknown public skill '${ref}'`], warnings: [], item: null };
    if (!info.inherited.refs.length) return { ok: false, errors: [info.inherited.expert ? `no further docs pages to inherit from ${info.inherited.expert}` : "no related built-in expert found - add references by hand (public_skill_refs {name, add:[...]})"], warnings: [], item: null };
    const r = addReferences(ref, info.inherited.refs.map((x) => ({ title: x.title, url: x.url })), opts);
    return Object.assign(r, { expert: info.inherited.expert });
  }
  function referenceCandidates(text, max) {
    const SI = intelModule(), R = refsModule();
    if (!SI || !R) return "";
    try {
      const sel = SI.select(SI.analyze(String(text || ""), { engine: "roblox" }), { max: 2 });
      const picked = (sel && sel.picked || []).map((p) => p.id);
      if (!picked.length) return "";
      const per = Math.max(2, Math.ceil((max || 8) / picked.length));
      const rows = [];
      for (const id of picked) for (const r of (R.refs(id) || []).filter((x) => !x.unverified).slice(0, per)) rows.push(`- ${r.title} — ${r.url}`);
      if (!rows.length) return "";
      return `REFERENCE CANDIDATES (official docs pages already verified for ${picked.join(" / ")}): put the 2-5 that apply in references[] as {title, url} and set expert to the closest of ${picked.join(" / ")}. Do NOT invent other URLs - unknown links are stored as "not verified offline".\n${rows.join("\n")}`;
    } catch { return ""; }
  }

  // ── Execution ───────────────────────────────────────────────────────────
  function resolveArgs(cmd, args) {
    const out = {}, missing = [];
    const src = args && typeof args === "object" ? args : {};
    for (const p of cmd.params || []) {
      let v = src[p.name];
      if (v === undefined || v === null || v === "") {
        if (p.default !== undefined) v = clone(p.default);
        else if (p.required) { missing.push(p.name); continue; }
        else v = null;
      }
      if (v != null) {
        if (p.type === "number") { const n = Number(v); if (!Number.isFinite(n)) return { err: `param '${p.name}' must be a number` }; v = n; }
        else if (p.type === "boolean") v = v === true || v === "true" || v === 1 || v === "1";
        else if (p.type === "array") { if (typeof v === "string") { try { const j = JSON.parse(v); v = Array.isArray(j) ? j : v.split(",").map((s) => s.trim()).filter(Boolean); } catch { v = v.split(",").map((s) => s.trim()).filter(Boolean); } } if (!Array.isArray(v)) return { err: `param '${p.name}' must be an array` }; }
        else if (p.type === "object") { if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { err: `param '${p.name}' must be a JSON object` }; } } if (!v || typeof v !== "object" || Array.isArray(v)) return { err: `param '${p.name}' must be a JSON object` }; }
        else v = String(v);
        if (p.enum && p.enum.length && !p.enum.includes(String(v))) return { err: `param '${p.name}' must be one of ${p.enum.join(" | ")}` };
      }
      out[p.name] = v;
    }
    if (missing.length) return { err: `ERROR MISSING_PARAMS calling '${cmd.name}': ${missing.join(", ")} - call it as ${signature(cmd)}` };
    return { args: out };
  }
  const wrapProgram = (label, args, body, name) => [
    label,
    `local HttpService = game:GetService("HttpService")`,
    `local args = ${luauLiteral(args)}`,
    `local __ok, __res = pcall(function()`,
    body,
    `end)`,
    `if not __ok then return HttpService:JSONEncode({ok = false, error = tostring(__res), skill = ${JSON.stringify(name)}}) end`,
    `if __res == nil then return HttpService:JSONEncode({ok = true, skill = ${JSON.stringify(name)}}) end`,
    `if type(__res) == "table" then if __res.ok == nil then __res.ok = true end return HttpService:JSONEncode(__res) end`,
    `return tostring(__res)`,
  ].join("\n");
  // buildLuau(ref, args) - ref = skill name (main command) or an extra command name.
  function buildLuau(ref, args) {
    const r = commandOf(ref);
    if (!r) return { err: `ERROR in public skill: '${ref}' is not an installed skill or skill command` };
    const { item, cmd } = r;
    if (!item.enabled) return { err: `ERROR in ${cmd.name}: this public skill is disabled - enable it in the Public tab or with public_skill_enable {name}` };
    const a = resolveArgs(cmd, args);
    if (a.err) return { err: a.err.startsWith("ERROR") ? a.err : `ERROR INVALID_PARAMETER in ${cmd.name}: ${a.err}` };
    const body = cmd.luau.replace(PLACEHOLDER_RE, (_, k) => luauLiteral(a.args[k] === undefined ? null : a.args[k]));
    const code = wrapProgram(`-- TotalScript public skill '${item.name}'${cmd.main ? "" : " command '" + cmd.name + "'"} v${item.version} by ${item.author.replace(/[^\w .-]/g, "")}`, a.args, body, cmd.name);
    return { code, args: a.args, item: clone(item), command: cmd.name, main: !!cmd.main };
  }
  // buildVerify(ref, args, result) - the verify block after a real run.
  // `args` = the resolved args the command ran with, `result` = the table the
  // command returned (decoded JSON) or nil. Helpers: find(path) walks the
  // DataModel by dotted path (nil when missing); attr(path, name) reads an
  // attribute (nil when missing); check(cond, message) raises. Plain Lua 5.x
  // syntax on purpose (no `continue`), so the mocked sim can compile it too.
  function buildVerify(ref, args, result) {
    // a not-yet-installed definition (object with luau) may be passed directly
    const item = ref && typeof ref === "object" && ref.luau ? ref : find(ref);
    if (!item) return { err: `ERROR in public skill: '${ref}' is not an installed skill` };
    if (!item.verify || !item.verify.luau) return { err: `ERROR NO_VERIFY in ${item.name}: this skill has no verify block - add verify {luau} with public_skill_update so a test can prove the result` };
    const a = resolveArgs({ name: item.name, params: item.params }, args);
    const argv = a.err ? (args && typeof args === "object" ? args : {}) : a.args;
    const body = item.verify.luau.replace(PLACEHOLDER_RE, (_, k) => luauLiteral(argv[k] === undefined ? null : argv[k]));
    const code = [
      `-- TotalScript public skill '${item.name}' v${item.version} - VERIFY`,
      `local HttpService = game:GetService("HttpService")`,
      `local args = ${luauLiteral(argv)}`,
      `local result = ${luauLiteral(result && typeof result === "object" ? result : null)}`,
      `local function find(path) local cur = game for seg in string.gmatch(tostring(path or ""), "[^%.]+") do if seg == "game" and cur == game then cur = game elseif seg == "Workspace" and cur == game then cur = workspace else cur = cur:FindFirstChild(seg) if not cur then return nil end end end return cur end`,
      `local function attr(path, name) local inst = type(path) == "string" and find(path) or path if not inst then return nil end return inst:GetAttribute(name) end`,
      `local function check(cond, message) if not cond then error(tostring(message or "check failed"), 0) end return true end`,
      `local __ok, __res = pcall(function()`,
      body,
      `end)`,
      `if not __ok then return HttpService:JSONEncode({ok = false, verify = true, error = tostring(__res), skill = ${JSON.stringify(item.name)}}) end`,
      `if __res == nil or __res == true then return HttpService:JSONEncode({ok = true, verify = true, skill = ${JSON.stringify(item.name)}}) end`,
      `if __res == false then return HttpService:JSONEncode({ok = false, verify = true, error = "verify returned false", skill = ${JSON.stringify(item.name)}}) end`,
      `if type(__res) == "table" then if __res.ok == nil then __res.ok = true end __res.verify = true return HttpService:JSONEncode(__res) end`,
      `return HttpService:JSONEncode({ok = true, verify = true, detail = tostring(__res), skill = ${JSON.stringify(item.name)}})`,
    ].join("\n");
    return { code, args: argv, item: clone(item) };
  }
  function syntaxCheckLuau(ref, args) {
    const built = buildLuau(ref, args);
    if (built.err) return built;
    const pieces = [built.code];
    if (built.item.verify && built.item.verify.luau) { const v = buildVerify(built.item.id, built.args, null); if (!v.err) pieces.push(v.code); }
    const code = [
      `local HttpService = game:GetService("HttpService")`,
      `local srcs = ${luauLiteral(pieces)}`,
      `if type(loadstring) ~= "function" then return HttpService:JSONEncode({ok = true, checked = false, note = "loadstring unavailable in this context; run the skill with public_skill_test {dry_run=false}"}) end`,
      `for i, src in ipairs(srcs) do local fn, err = loadstring(src) if not fn then return HttpService:JSONEncode({ok = false, checked = true, part = (i == 1) and "command" or "verify", error = "SYNTAX: " .. tostring(err)}) end end`,
      `return HttpService:JSONEncode({ok = true, checked = true, syntax = "OK", parts = #srcs})`,
    ].join("\n");
    return { code, item: built.item, command: built.command };
  }
  // parseResult(text) → the JSON table a run / verify returned, or null.
  function parseResult(text) {
    try {
      const body = String(text || "").replace(/^Output of '[^']*':\n?/, "").trim();
      if (!/^\{/.test(body) || body.length > 60000) return null;
      const j = JSON.parse(body);
      return j && typeof j === "object" ? j : null;
    } catch { return null; }
  }

  // ── Knowledge ───────────────────────────────────────────────────────────
  // knowledgeText(ref, {budget}) - the skill's knowledge + references block the
  // agent gets when the skill is relevant (and from public_skill_get).
  function knowledgeText(ref, opts) {
    opts = opts || {};
    const item = find(ref);
    if (!item) return "";
    const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 2400;
    const L = [];
    const v = verification(item);
    L.push(`PUBLIC SKILL ${item.name} v${item.version} by ${item.author} [${v.flag}] - ${item.description}`);
    L.push(`COMMANDS: ${signatures(item).join("; ")}`);
    if (item.knowledge) {
      const k = item.knowledge.length > budget ? item.knowledge.slice(0, budget - 40).replace(/\s+\S*$/, "") + "\n[... knowledge trimmed; public_skill_get shows all]" : item.knowledge;
      L.push("", "KNOWLEDGE:", k);
    }
    if (item.verify && item.verify.note) L.push("", `VERIFY: ${item.verify.note}`);
    if (opts.references !== false) { const rt = referencesText(item.id, { budget: Math.max(600, Math.floor(budget / 2)), inherit: opts.inherit !== false }); if (rt) L.push("", rt); }
    return L.join("\n");
  }
  // knowledgeRider(text, {tight, max}) - what rides on the first tool result of
  // a request that matches installed skills: the knowledge of the best 1-2
  // matches. Empty when nothing matches with a trigger / name hit.
  function knowledgeRider(text, opts) {
    opts = opts || {};
    const tight = !!opts.tight;
    const picks = relevant(text, opts.max || (tight ? 1 : 2)).filter((r) => r.score >= 6);
    if (!picks.length) return "";
    const budget = tight ? 700 : 1800;
    const per = Math.floor(budget / picks.length);
    const blocks = picks.map((p) => { const it = find(p.name); if (!it) return ""; const v = verification(it); const k = it.knowledge ? (it.knowledge.length > per ? it.knowledge.slice(0, per - 30).replace(/\s+\S*$/, "") + " [...]" : it.knowledge) : "(no knowledge text - follow the command descriptions)"; return `• ${it.title} (${signatures(it).join("; ")}) [${v.flag}] matched: ${p.why.join(", ")}\n${k}`; }).filter(Boolean);
    if (!blocks.length) return "";
    return `━━━ PUBLIC SKILL KNOWLEDGE (installed by the user; applies to this request) ━━━\n${blocks.join("\n\n")}\nUse the skill's commands for this work instead of rebuilding it from scratch; an UNVERIFIED skill is still callable - tell the user when its result could not be proved.`;
  }

  // ── Catalogue / tool entries ────────────────────────────────────────────
  function signature(cmd) {
    const ps = (cmd.params || []).map((p) => p.name + (p.required ? "" : "?")).join(", ");
    return `${cmd.name} {${ps}}`;
  }
  const signatures = (ref) => { const item = ref && typeof ref === "object" && ref.luau ? ref : find(ref); if (!item) return []; return [signature(item)].concat((item.commands || []).map(signature)); };
  function schema(cmd) {
    const properties = {}, required = [];
    for (const p of cmd.params || []) {
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
    const out = [];
    for (const i of items) {
      if (!i.enabled) continue;
      const v = verification(i);
      const flag = v.state === "verified" ? "VERIFIED" : v.flag;
      out.push({ name: i.name, description: `[Public skill by ${i.author} · ${flag}] ${i.description}${i.usage ? " Usage: " + i.usage : ""}`, inputSchema: schema(i), server: "roblox", environment: "ROBLOX_STUDIO", executionMode: i.executionMode || "WRITE", category: "Public Skills", publicSkill: true, virtual: true, verification: v.state });
      for (const c of i.commands || []) out.push({ name: c.name, description: `[Public skill '${i.name}' command · ${flag}] ${c.description}`, inputSchema: schema(c), server: "roblox", environment: "ROBLOX_STUDIO", executionMode: c.executionMode || "WRITE", category: "Public Skills", publicSkill: true, virtual: true, skill: i.name, verification: v.state });
    }
    return out;
  }
  // relevant(text, max) → installed skills ranked for a request: name / title /
  // tags / weighted triggers / description words against the text. Delegates
  // to TotalSkillIntel.rankPublic when loaded; deterministic either way.
  function relevant(text, max) {
    const cmds = items.filter((i) => i.enabled);
    const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9_\s]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    if (!cmds.length || t.trim().length < 3) return [];
    try {
      const SI = root.TotalSkillIntel;
      if (SI && typeof SI.rankPublic === "function") return SI.rankPublic({ text: String(text || "") }, cmds, max || 5).map((r) => ({ name: r.name, score: r.score, why: r.why }));
    } catch {}
    const toks = new Set(t.split(" ").filter((w) => w.length > 2));
    const out = [];
    for (const i of cmds) {
      let score = 0; const why = [];
      const words = [].concat(i.name.split("_"), i.tags || [], i.triggers || [], String(i.title || "").toLowerCase().split(/\W+/), (i.commands || []).map((c) => c.name.split("_")).flat());
      for (const w of words) { const k = String(w || "").toLowerCase(); if (k.length > 2 && toks.has(k) && !why.includes(k)) { score += 3 * triggerWeight(i, k); why.push(k); } }
      for (const tr of i.triggers || []) if (tr.includes(" ") && t.includes(" " + tr + " ")) { score += 4 * triggerWeight(i, tr); why.push(tr); }
      let dh = 0; for (const w of String(i.description || "").toLowerCase().split(/\W+/)) if (w.length > 4 && toks.has(w)) dh++;
      score += Math.min(4, dh);
      if (score >= 5) out.push({ name: i.name, score, why: why.slice(0, 4) });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, max || 5);
  }
  // catalogueBlock({compact, task, max}) - the PUBLIC SKILLS block of the
  // system prompt (every command of up to `max` skills; relevant ones first).
  function catalogueBlock(opts) {
    const cmds = items.filter((i) => i.enabled);
    if (!cmds.length) return "";
    const compact = !!(opts && opts.compact);
    const max = Math.max(3, (opts && opts.max) || PROMPT_MAX);
    let shown = cmds, hidden = 0;
    if (cmds.length > max) {
      let task = opts && opts.task; if (!task) { try { task = typeof root.__rsTaskText === "function" ? root.__rsTaskText() : ""; } catch { task = ""; } }
      const ranked = relevant(task, max).map((r) => r.name);
      const byName = new Map(cmds.map((i) => [i.name, i]));
      shown = ranked.map((n) => byName.get(n)).filter(Boolean);
      for (const i of cmds) { if (shown.length >= max) break; if (!shown.includes(i)) shown.push(i); }
      hidden = cmds.length - shown.length;
    }
    const rows = [];
    for (const i of shown) {
      const v = verification(i);
      const tag = v.state === "verified" ? "" : " [UNVERIFIED]";
      rows.push(compact ? `${signature(i)} - ${i.description.slice(0, 90)}${tag}` : `${signature(i)} - ${i.description.slice(0, 200)}${i.triggers && i.triggers.length ? ` (when: ${i.triggers.slice(0, 4).join(", ")})` : ""}${i.knowledge ? " (has knowledge)" : ""}${tag}`);
      for (const c of i.commands || []) rows.push(`  ${signature(c)} - ${c.description.slice(0, compact ? 70 : 140)} (part of ${i.name})`);
    }
    const more = hidden ? `\n…and ${hidden} more installed - public_skill_list {} shows all of them with signatures.` : "";
    let libLine = ""; try { const L = libraryModule(); if (L && !compact) libLine = L.promptLine(); } catch {}
    if (libLine) libLine = "\n" + libLine;
    const n = cmds.reduce((s, i) => s + 1 + (i.commands || []).length, 0);
    return `PUBLIC SKILLS - ${cmds.length} user-made skill${cmds.length === 1 ? "" : "s"} (${n} command${n === 1 ? "" : "s"}) installed on this device; call them like any command, they run Luau in Studio. [UNVERIFIED] = no test pass yet: still callable, say so when you report:\n${rows.join("\n")}${more}${libLine}\n\n`;
  }

  const DEFINITION_DOC = [
    "DEFINITION OBJECT (JSON) - a public SKILL (the only kind since 2.20.0): name (snake_case, unique, 3-41 chars - also the main command's name), title, description (10-600 chars: what it does, when to use it), version (int), author, tags[], triggers[] (words / short phrases that say WHEN the skill applies; weight with 'phrase:3' - used for auto-selection and for injecting the knowledge), usage (one example call).",
    "MAIN COMMAND: params[{name, type: string|number|boolean|array|object, description, required, default?, enum?}] and luau (the program; max 24000 chars). Every param is available in Luau BOTH as the Lua literal {{param}} and as args.param. The program runs in Studio through execute_luau in the Edit DataModel (plugin-level API, no `plugin` global, no yields over 5 s). Resolve instance paths first (walk game by name, fail with a clear error), wrap risky work in pcall, keep work idempotent, name created instances, record ChangeHistoryService waypoints for big edits, and RETURN A TABLE such as {ok=true, created=3, path='Workspace.X'} (it is JSON-encoded for the agent). Use `return {ok=false, error='...'}` for failures.",
    "EXTRA COMMANDS (optional): commands[{name, description, params[], luau, executionMode?}] - up to 6 more commands that belong to the same skill (e.g. zone_remove next to zone_system). Names share one namespace with every other command.",
    "KNOWLEDGE (optional, strongly recommended): knowledge - markdown the agent reads whenever the skill matches a request: rules, pitfalls, the order of operations, how to tweak the result, what to tell the user. This is where a procedure or prompt belongs (abilities and work modes no longer exist).",
    "VERIFY (required for a VERIFIED badge): verify {luau, note?} - Luau that runs in Studio right after the main command during public_skill_test {dry_run:false}; it gets `args` (the resolved params), `result` (the table the command returned), find(path), attr(pathOrInstance, name) and check(cond, message), and must return {ok=true, detail=...} or {ok=false, error=...}. Until that passes the skill is callable but flagged UNVERIFIED.",
    "REFERENCES (optional): references[{title, url}] - the official docs pages the skill relies on (prefer the REFERENCE CANDIDATES given below; '/docs/...' paths resolve to create.roblox.com; never invent URLs - unknown ones are kept but marked 'not verified offline'); examples[{title, body}] - up to 4 short plain-Luau patterns (20-3000 chars, no backticks); expert - the nearest built-in expert id (auto-detected when omitted).",
  ].join("\n");

  const PROCESS_DOC = "PROCESS: (1) design it completely - make sensible decisions instead of asking questions and mention them in the description; (2) submit it with ONE call to public_skill_create {\"definition\": {...}}; (3) if it returns VALIDATION_FAILED, fix the listed problems and resubmit; (4) run public_skill_test {\"name\"} once (syntax check in Studio); if the user is in Studio and asked for the thing itself, run public_skill_test {\"name\", \"dry_run\": false, \"args\": {...}} so the verify block proves it and the skill becomes VERIFIED; (5) reply with one short paragraph: what was installed, how to call it, whether it is verified.";

  function generationPrompt(request, _kindHint, ctx) {
    ctx = ctx || {};
    const existing = items.length ? `Already installed on this device (do not reuse these names): ${items.map((i) => signatures(i).map((s) => s.split(" ")[0]).join("/")).join(", ")}.` : "No public skills are installed yet.";
    const names = Array.isArray(ctx.commandNames) && ctx.commandNames.length ? `Built-in command names (sample; a public skill must not reuse them): ${ctx.commandNames.slice(0, 80).join(", ")}${ctx.commandNames.length > 80 ? " ..." : ""}` : "";
    return [
      "PUBLIC SKILL REQUEST - TotalScript 'Public Skills' lets the user create their own SKILLS by describing them: one or more parameterised Luau commands + triggers (when it applies) + knowledge (what the agent must know while using it) + a verify block (how a test proves the result in Studio). You do the whole job now.",
      `USER REQUEST: "${String(request || "").trim()}"`,
      PROCESS_DOC,
      DEFINITION_DOC,
      referenceCandidates(request, 8),
      libraryText(null, { design: true, budget: 3000, heading: "USER REFERENCE LIBRARY (the user marked these for every new design - follow them: copy the shape of snippets, cite the links in references[]; nothing here ran):" }),
      existing,
      names,
    ].filter(Boolean).join("\n\n");
  }

  const MANAGEMENT_TOOLS = [
    { name: "public_skill_create", description: "Install a user-made Public Skill: parameterised Luau command(s) run in Studio + triggers + knowledge + a verify block. Validates and installs; the new command(s) are callable immediately (flagged UNVERIFIED until public_skill_test {dry_run:false} passes).", inputSchema: { type: "object", required: ["definition"], properties: { definition: { type: "object", description: "See DEFINITION OBJECT: name, description, params, luau, triggers, knowledge, verify{luau}, commands[]" } } } },
    { name: "public_skill_list", description: "List installed Public Skills with their command signatures and verification state (verified | unverified | syntax | ran | stale).", inputSchema: { type: "object", properties: { verified: { type: "boolean", description: "only verified (true) or only unverified (false)" } } } },
    { name: "public_skill_get", description: "Read one Public Skill in full (Luau of every command, params, knowledge, verify block, references, verification state).", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "skill name, command name or id" } } } },
    { name: "public_skill_update", description: "Patch an installed Public Skill (fields are merged; version increments; a code change marks an earlier test pass stale).", inputSchema: { type: "object", required: ["name", "patch"], properties: { name: { type: "string" }, patch: { type: "object" } } } },
    { name: "public_skill_delete", description: "Uninstall a Public Skill by name or id.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    { name: "public_skill_enable", description: "Enable or disable a Public Skill (all of its commands) without deleting it.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, enabled: { type: "boolean", default: true } } } },
    { name: "public_skill_test", description: "Test a Public Skill in Studio. dry_run=true (default): compile the command + verify block (SYNTAX OK). dry_run=false: really run the command with args, then its verify block; when verify returns ok the skill is marked VERIFIED (a later code change makes that stale).", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "skill name or one of its command names" }, args: { type: "object" }, dry_run: { type: "boolean", default: true } } } },
    { name: "public_skill_export", description: "Export a Public Skill as SKILL.md (the canonical, shareable format: YAML front matter + ## Knowledge / ## Command / ## Verify sections) plus an ORSKILL2: share code; name='all' bundles every installed skill (SKILLS.md).", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "name, id, or 'all'" } } } },
    { name: "public_skill_import", description: "Import Public Skills from SKILL.md text (or a SKILLS.md bundle), an ORSKILL2:/ORSKILL1: share code, legacy exported JSON (.orskill.json / .orskills.json), a legacy .txt skill, or data:'featured' for the bundled Featured pack (11 skills with knowledge + verify blocks: damage_numbers_pro, npc_patrol_chase, keycard_door_system, dialogue_tree_system, collectible_spawner, zone_system, boss_health_bar, checkpoint_system, gui_polish_kit, game_feel_kit, place_audit_report).", inputSchema: { type: "object", required: ["data"], properties: { data: { type: "string", description: "SKILL.md text, share code, JSON, or 'featured'" }, names: { type: "array", items: { type: "string" }, description: "With data:'featured': install only these skill names" }, replace: { type: "boolean", description: "Replace skills with the same name" } } } },
    { name: "public_skill_refs", description: "References of a Public Skill: its own docs links / examples (verified = page checked offline against the Roblox docs listing) plus the ones inherited from the nearest built-in expert. add[] attaches links ('Title | url' or {title,url}), remove[] drops them by url / title / index, suggest=true adopts the inherited docs links.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, add: { type: "array", items: { type: "string" }, description: "'Title | https://...' entries (or '/docs/...' paths)" }, remove: { type: "array", items: { type: "string" } }, suggest: { type: "boolean", description: "adopt the related expert's verified docs links" } } } },
    { name: "public_skill_reference", description: "The user's reference LIBRARY (Public tab -> References): docs links, notes and Luau/GUI snippets. op=list|get|add|update|remove|attach|detach. Attached entries are appended to a skill's knowledge when it is relevant; design=true entries reach every new design.", inputSchema: { type: "object", required: ["op"], properties: { op: { type: "string", enum: ["list", "get", "add", "update", "remove", "attach", "detach"] }, id: { type: "string", description: "entry id or exact title (get/update/remove/attach/detach)" }, kind: { type: "string", enum: ["link", "note", "snippet"] }, title: { type: "string" }, url: { type: "string" }, body: { type: "string", description: "note / snippet text (max 16000 chars)" }, lang: { type: "string", enum: ["luau", "text", "json", "markdown"] }, tags: { type: "array", items: { type: "string" } }, names: { type: "array", items: { type: "string" }, description: "public skill names to attach to / detach from" }, design: { type: "boolean" }, query: { type: "string", description: "list filter (words)" }, attached_to: { type: "string", description: "list filter: public skill name" } } } },
    { name: "public_skill_from_prompt", description: "Design a Public Skill from a full prompt the user wrote: returns a DESIGN BRIEF in which the prompt becomes the skill's knowledge (kept complete) and you must write the Luau command(s) + a verify block, then install it with public_skill_create. Nothing is installed by this call.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", description: "The full prompt text" }, title: { type: "string" }, name: { type: "string", description: "snake_case skill name" } } } },
  ].map((t) => Object.assign(t, { server: "totalscript", executionMode: /create|update|delete|import|enable|test|refs|reference/.test(t.name) ? "WRITE" : "READ", environment: "GENERAL", category: "Public Skills" }));

  // ── SKILL.md (canonical format, 2.20.0) ─────────────────────────────────
  // YAML subset reader: mappings, block lists (scalars or mappings), flow
  // lists, quoted / bare scalars, `>` folded and `|` literal blocks.
  function parseYamlLite(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    const indentOf = (l) => (l.match(/^ */) || [""])[0].length;
    const blank = (l) => !l.trim() || /^\s*#/.test(l);
    const next = () => { let j = i; while (j < lines.length && blank(lines[j])) j++; return j; };
    function scalar(v) {
      const s = String(v).trim();
      if (s === "") return "";
      if (/^(true|yes|on)$/i.test(s)) return true;
      if (/^(false|no|off)$/i.test(s)) return false;
      if (/^(null|~)$/i.test(s)) return null;
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
      if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
      if (/^\[.*\]$/.test(s)) { try { return JSON.parse(s); } catch { return splitFlow(s.slice(1, -1)).map(scalar); } }
      if (/^\{.*\}$/.test(s)) { try { return JSON.parse(s); } catch { return s; } }
      return s;
    }
    function splitFlow(s) { const out = []; let cur = "", q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === ",") { out.push(cur.trim()); cur = ""; continue; } cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
    function blockScalar(indent, marker) {
      const body = [];
      let min = Infinity;
      while (i < lines.length) { const l = lines[i]; if (l.trim() && indentOf(l) <= indent) break; body.push(l); if (l.trim()) min = Math.min(min, indentOf(l)); i++; }
      const rows = body.map((l) => (l.trim() ? l.slice(min) : ""));
      while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
      let text;
      if (marker[0] === "|") text = rows.join("\n");
      else { text = ""; for (const r of rows) { if (!r.trim()) { text += "\n"; continue; } text += (text && !text.endsWith("\n") ? " " : "") + r.trim(); } }
      return marker.endsWith("-") ? text.replace(/\n+$/, "") : text + "\n";
    }
    function mapping(indent) {
      const obj = {};
      while (i < lines.length) {
        const j = next(); if (j >= lines.length) { i = j; break; }
        const l = lines[j]; const ind = indentOf(l);
        if (ind < indent) { i = j; break; }
        if (ind > indent) { i = j + 1; continue; }
        if (/^\s*- /.test(l)) { i = j; break; }
        const m = l.match(/^ *([^:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/);
        if (!m) { i = j + 1; continue; }
        i = j + 1;
        const key = m[1].trim(); const val = m[2] == null ? "" : m[2].trim();
        if (val === "") {
          const k = next();
          if (k < lines.length && indentOf(lines[k]) > indent) obj[key] = /^\s*- /.test(lines[k]) ? listAt(indentOf(lines[k])) : mapping(indentOf(lines[k]));
          else if (k < lines.length && indentOf(lines[k]) === indent && /^\s*- /.test(lines[k])) obj[key] = listAt(indent);
          else obj[key] = "";
        } else if (/^[>|][-+]?$/.test(val)) obj[key] = blockScalar(indent, val);
        else obj[key] = scalar(val);
      }
      return obj;
    }
    function listAt(indent) {
      const arr = [];
      while (i < lines.length) {
        const j = next(); if (j >= lines.length) { i = j; break; }
        const l = lines[j]; const ind = indentOf(l);
        if (ind !== indent || !/^\s*- /.test(l)) { if (ind > indent) { i = j + 1; continue; } i = j; break; }
        const rest = l.slice(ind + 2);
        if (/^[A-Za-z_][\w-]*\s*:(\s|$)/.test(rest)) {
          // `- key: value` → a mapping item (continues on deeper-indented lines)
          lines[j] = " ".repeat(ind + 2) + rest; i = j;
          arr.push(mapping(ind + 2));
        } else { arr.push(scalar(rest)); i = j + 1; }
      }
      return arr;
    }
    i = next();
    if (i < lines.length && /^\s*- /.test(lines[i])) return listAt(indentOf(lines[i]));
    return mapping(i < lines.length ? indentOf(lines[i]) : 0);
  }
  const yamlScalar = (v) => {
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v == null ? "" : v);
    if (s === "" || /^[\s]|[\s]$/.test(s) || /[:#\[\]{}"'\n\\]|^[-?&*!|>%@`]/.test(s) || /^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
    return s;
  };
  const yamlFlow = (arr) => "[" + arr.map(yamlScalar).join(", ") + "]";
  const yamlFolded = (key, text, indent) => { const pad = " ".repeat(indent || 0); const t = String(text || "").replace(/\s+/g, " ").trim(); if (!t) return ""; const words = t.split(" "); const rows = []; let cur = ""; for (const w of words) { if ((cur + " " + w).trim().length > 88 && cur) { rows.push(cur); cur = w; } else cur = (cur ? cur + " " : "") + w; } if (cur) rows.push(cur); return `${pad}${key}: >-\n${rows.map((r) => pad + "  " + r).join("\n")}`; };
  function paramsYaml(params, indent) {
    const pad = " ".repeat(indent || 0);
    const L = [];
    for (const p of params || []) {
      L.push(`${pad}- name: ${p.name}`);
      L.push(`${pad}  type: ${p.type}`);
      if (p.required) L.push(`${pad}  required: true`);
      if (p.default !== undefined) L.push(`${pad}  default: ${typeof p.default === "object" ? JSON.stringify(p.default) : yamlScalar(p.default)}`);
      if (p.enum && p.enum.length) L.push(`${pad}  enum: ${yamlFlow(p.enum)}`);
      if (p.description) L.push(`${pad}  description: ${yamlScalar(p.description)}`);
    }
    return L.join("\n");
  }
  const fence = (code) => { const body = String(code || "").replace(/\n+$/, ""); const ticks = /```/.test(body) ? "````" : "```"; return `${ticks}luau\n${body}\n${ticks}`; };
  // toSkillMd(ref | item) → the SKILL.md document.
  function toSkillMd(ref) {
    const i = (ref && typeof ref === "object" && ref.luau) ? ref : find(ref);
    if (!i) return null;
    const fm = [];
    fm.push(`name: ${i.name}`);
    fm.push(`title: ${yamlScalar(i.title)}`);
    fm.push(yamlFolded("description", i.description));
    fm.push(`version: ${i.version}`);
    fm.push(`author: ${yamlScalar(i.author)}`);
    if (i.tags && i.tags.length) fm.push(`tags: ${yamlFlow(i.tags)}`);
    if (i.triggers && i.triggers.length) { fm.push("triggers:"); for (const t of i.triggers) fm.push(`  - ${yamlScalar(i.weights && i.weights[t] ? `${t}: ${i.weights[t]}` : t)}`); }
    if (i.expert) fm.push(`expert: ${i.expert}`);
    if (i.usage) fm.push(`usage: ${yamlScalar(i.usage)}`);
    if (i.executionMode && i.executionMode !== "WRITE") fm.push(`executionMode: ${i.executionMode}`);
    if (i.params && i.params.length) { fm.push("params:"); fm.push(paramsYaml(i.params, 2)); }
    if (i.references && i.references.length) { fm.push("references:"); for (const r of i.references) { fm.push(`  - title: ${yamlScalar(r.title)}`); fm.push(`    url: ${yamlScalar(r.url)}`); if (r.note) fm.push(`    note: ${yamlScalar(r.note)}`); } }
    const B = [];
    B.push(`# ${i.title}`, "", i.description, "");
    if (i.knowledge) B.push("## Knowledge", "", i.knowledge.replace(/\n+$/, ""), "");
    B.push(`## Command ${i.name}`, "", `Main command: \`${signature(i)}\``, "", fence(i.luau), "");
    for (const c of i.commands || []) {
      B.push(`## Command ${c.name}`, "", c.description, "");
      if (c.params && c.params.length) B.push("params:", paramsYaml(c.params, 2), "");
      if (c.executionMode && c.executionMode !== "WRITE") B.push(`executionMode: ${c.executionMode}`, "");
      B.push(fence(c.luau), "");
    }
    if (i.verify && i.verify.luau) { B.push("## Verify", ""); if (i.verify.note) B.push(i.verify.note, ""); B.push(fence(i.verify.luau), ""); }
    for (const e of i.examples || []) B.push(`## Example ${e.title}`, "", ...(e.note ? [e.note, ""] : []), "```" + (e.lang || "luau") + "\n" + e.body + "\n```", "");
    return `---\n${fm.filter(Boolean).join("\n")}\n---\n\n${B.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
  }
  const FENCE_RE = /^(`{3,4})(?:luau|lua)?[^\n]*\n([\s\S]*?)\n\1\s*$/m;
  const isSkillMd = (text) => { const s = String(text || "").replace(/^\uFEFF/, "").trimStart(); return (/^---\n[\s\S]*?\n---(\n|$)/.test(s) && /^name\s*:/m.test(s.split(/\n---/)[0])) || /^## +Command\s+[a-z]/m.test(s) || (/^# +\S/m.test(s) && /^## +(Knowledge|Verify)\b/m.test(s) && /^`{3,4}(luau|lua)\b/m.test(s)); }; // a prompt with a heading + a Luau fence is NOT a SKILL.md (that is the Save as-is path)
  // parseSkillMd(text) → {ok, def, warnings} | {ok:false, errors}
  function parseSkillMd(text) {
    const src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const warnings = [];
    let fm = {}, body = src;
    const m = src.match(/^\s*---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (m) { try { fm = parseYamlLite(m[1]) || {}; } catch (e) { return { ok: false, errors: ["front matter is not readable YAML: " + String(e && e.message || e)] }; } body = src.slice(m[0].length); }
    const def = {};
    for (const [k, v] of Object.entries(fm)) {
      const key = String(k).trim();
      const map = { name: "name", command: "name", title: "title", description: "description", desc: "description", version: "version", author: "author", by: "author", tags: "tags", triggers: "triggers", when: "triggers", expert: "expert", usage: "usage", executionmode: "executionMode", execution_mode: "executionMode", params: "params", parameters: "params", references: "references", refs: "references", docs: "references", kind: "kind", type: "kind" };
      const dst = map[key.toLowerCase()];
      if (dst) def[dst] = v;
    }
    // sections: # Title, ## Knowledge, ## Command <name>, ## Verify, ## Example <title>
    const secs = []; let cur = { head: "", lines: [] };
    let inFence = null;
    for (const line of body.split("\n")) {
      const f = line.match(/^(`{3,4})/);
      if (f) { if (!inFence) inFence = f[1]; else if (line.startsWith(inFence)) inFence = null; }
      if (!inFence && /^##\s+\S/.test(line)) { secs.push(cur); cur = { head: line.replace(/^##\s+/, "").trim(), lines: [] }; continue; }
      cur.lines.push(line);
    }
    secs.push(cur);
    const pre = secs[0].lines.join("\n");
    const h1 = pre.match(/^#\s+(.+)$/m);
    if (h1 && !def.title) def.title = h1[1].trim();
    const intro = pre.replace(/^#\s+.+$/m, "").trim();
    if (!def.description && intro) def.description = intro.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim().slice(0, 600);
    const commands = [];
    for (const s of secs.slice(1)) {
      const textOf = () => s.lines.join("\n");
      const hm = s.head.match(/^(knowledge|command|verify|example|examples|description|about|notes?)\b\s*:?\s*(.*)$/i);
      const kindH = hm ? hm[1].toLowerCase() : "";
      if (kindH === "knowledge" || kindH === "note" || kindH === "notes") { def.knowledge = (def.knowledge ? def.knowledge + "\n\n" : "") + textOf().trim(); continue; }
      if (kindH === "description" || kindH === "about") { def.description = (def.description ? def.description + " " : "") + textOf().replace(/\s+/g, " ").trim(); continue; }
      if (kindH === "verify") {
        const fm2 = textOf().match(FENCE_RE);
        if (!fm2) { warnings.push("## Verify has no ```luau fence - ignored"); continue; }
        const note = textOf().slice(0, textOf().indexOf(fm2[0])).replace(/\s+/g, " ").trim();
        def.verify = { luau: fm2[2] }; if (note) def.verify.note = note.slice(0, 300);
        continue;
      }
      if (kindH === "example" || kindH === "examples") {
        const fm2 = textOf().match(/^(`{3,4})([a-z]*)[^\n]*\n([\s\S]*?)\n\1\s*$/m);
        if (fm2) { const note = textOf().slice(0, textOf().indexOf(fm2[0])).replace(/\s+/g, " ").trim(); (def.examples = def.examples || []).push(Object.assign({ title: (hm[2] || "").trim() || `Example ${def.examples.length + 1}`, body: fm2[3], lang: fm2[2] || "luau" }, note ? { note } : {})); }
        continue;
      }
      if (kindH === "command") {
        const cname = snake(hm[2].split(/\s/)[0] || "");
        const t = textOf();
        const fm2 = t.match(FENCE_RE);
        if (!fm2) { warnings.push(`## Command ${cname} has no \`\`\`luau fence - ignored`); continue; }
        const head = t.slice(0, t.indexOf(fm2[0]));
        const cmd = { name: cname, luau: fm2[2] };
        const pm = head.match(/^params:[ \t]*\n((?:[ \t]+[^\n]*\n?)+)/m);
        if (pm) { try { cmd.params = parseYamlLite(pm[1]); } catch { warnings.push(`command ${cname}: params block unreadable`); } }
        const em = head.match(/^executionMode:\s*(READ|WRITE)\s*$/m); if (em) cmd.executionMode = em[1];
        const descr = head.replace(/^params:\s*\n[\s\S]*$/m, "").replace(/^executionMode:.*$/m, "").replace(/^Main command:.*$/m, "").replace(/\s+/g, " ").trim();
        if (descr) cmd.description = descr.slice(0, 400);
        commands.push(cmd);
        continue;
      }
      // Unknown heading: a bare luau fence counts as the main command (hand-written files); prose joins the knowledge.
      const fm2 = textOf().match(FENCE_RE);
      if (fm2 && !commands.length) commands.push({ name: "", luau: fm2[2], description: "" });
      else if (textOf().trim()) def.knowledge = (def.knowledge ? def.knowledge + "\n\n" : "") + `## ${s.head}\n${textOf().trim()}`;
    }
    if (!commands.length) { const fm2 = pre.match(FENCE_RE); if (fm2) commands.push({ name: "", luau: fm2[2], description: "" }); }
    if (!commands.length) return { ok: false, errors: ["no ```luau fence found - a SKILL.md needs at least one '## Command <name>' section with the Luau program"], warnings };
    if (!def.name) def.name = snake(commands.find((c) => c.name) ? commands.find((c) => c.name).name : def.title || "");
    else { if (!def.title && /[A-Z ]/.test(String(def.name))) def.title = String(def.name).trim(); def.name = snake(def.name); }
    // params may use the shorthand list form - expand it here so the parsed
    // definition is already the canonical shape (validate() repeats this).
    if (def.params != null) def.params = normalizeParams(def.params, [], []);
    for (const c of commands) if (c.params != null) c.params = normalizeParams(c.params, [], []);
    const mainIdx = Math.max(0, commands.findIndex((c) => c.name === snake(def.name)));
    const main = commands[mainIdx];
    def.luau = main.luau;
    if (main.params && !def.params) def.params = main.params;
    if (main.executionMode) def.executionMode = main.executionMode;
    def.commands = commands.filter((_, k) => k !== mainIdx).map((c) => ({ name: c.name, description: c.description || `${titleCase(c.name)} (part of ${def.name})`, params: c.params || [], luau: c.luau, executionMode: c.executionMode }));
    if (def.version != null) def.version = parseInt(def.version, 10) || 1;
    def.kind = "skill";
    return { ok: true, def, warnings, skillMd: true };
  }
  function splitPackMd(text) { return String(text || "").split(new RegExp("^\\s*" + PACK_SEPARATOR.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\s*$", "m")).map((s) => s.trim()).filter(Boolean); }

  // ── Sharing ─────────────────────────────────────────────────────────────
  function exportObject(ref) {
    const item = find(ref);
    if (!item) return null;
    const out = clone(item);
    delete out.enabled; delete out.source; delete out.createdAt; delete out.updatedAt; delete out.stats; delete out.tested;
    return { format: FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), app: "TotalScript", item: out };
  }
  const exportJson = (ref) => { const o = exportObject(ref); return o ? JSON.stringify(o, null, 2) : null; };
  const exportText = (ref) => toSkillMd(ref);
  function exportPackObject(refs) {
    const picked = refs && refs.length ? refs.map((r) => find(r)).filter(Boolean) : items.slice();
    if (!picked.length) return null;
    return { format: PACK_FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), app: "TotalScript", count: picked.length, items: picked.map((i) => exportObject(i.id).item) };
  }
  const exportPackJson = (refs) => { const o = exportPackObject(refs); return o ? JSON.stringify(o, null, 2) : null; };
  function exportPackText(refs) {
    const picked = refs && refs.length ? refs.map((r) => find(r)).filter(Boolean) : items.slice();
    if (!picked.length) return null;
    return picked.map((i) => toSkillMd(i.id)).join(`\n${PACK_SEPARATOR}\n\n`);
  }
  const packFileName = () => `totalscript-public-skills-${new Date().toISOString().slice(0, 10)}.SKILLS.md`;
  const packJsonFileName = () => `totalscript-public-skills-${new Date().toISOString().slice(0, 10)}.orskills.json`;
  const packShareCode = (refs) => { const t = exportPackText(refs); return t ? "ORSKILL2:" + b64encode(t) : null; };
  const fileName = (ref) => { const i = find(ref); return i ? `${i.name}.SKILL.md` : "public-skill.SKILL.md"; };
  const jsonFileName = (ref) => { const i = find(ref); return i ? `${i.name}.skill.orskill.json` : "public-skill.orskill.json"; };
  const textFileName = fileName;
  function b64encode(s) { try { return typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"); } catch { return ""; } }
  function b64decode(s) { try { return typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8"); } catch { return ""; } }
  function shareCode(ref) { const t = toSkillMd(ref); return t ? "ORSKILL2:" + b64encode(t) : null; }
  // parseShared(text) → {ok, def} | {ok, pack:true, defs[]} | {ok:false, prompt?, errors}
  function parseShared(text) {
    let s = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!s) return { ok: false, errors: ["nothing to import"] };
    if (/^ORSKILL2:/i.test(s)) { s = b64decode(s.slice(9).replace(/\s+/g, "")); if (!s) return { ok: false, errors: ["share code is corrupted"] }; }
    else if (/^ORSKILL1:/i.test(s)) { s = b64decode(s.slice(9).replace(/\s+/g, "")); if (!s) return { ok: false, errors: ["share code is corrupted"] }; }
    let j = null;
    if (/^[\[{]/.test(s)) { try { j = JSON.parse(s); } catch { j = null; } }
    if (j === null) {
      if (isSkillMd(s)) {
        const docs = splitPackMd(s);
        if (docs.length > 1) {
          const defs = [], errors = [];
          for (const d of docs) { const p = parseSkillMd(d); if (p.ok) defs.push(p.def); else errors.push(p.errors.join("; ")); }
          return defs.length ? { ok: true, pack: true, defs, errors } : { ok: false, errors };
        }
        const p = parseSkillMd(s);
        return p.ok ? { ok: true, def: p.def, skillMd: true, warnings: p.warnings } : { ok: false, errors: p.errors };
      }
      const t = parseText(s);
      if (t.ok) return { ok: true, def: t.def, text: true };
      return { ok: false, prompt: !!t.prompt, text: s, errors: t.prompt ? ["this is a prompt, not a skill file - use 'Design a skill from it (AI)' to turn it into one"] : ["not valid SKILL.md, JSON, share code or .txt skill text"] };
    }
    const legacyFormat = (f, want) => typeof f === "string" && f.replace(/^orscript-/, "totalscript-") === want;
    const skillish = (d) => d && typeof d === "object" && (d.kind || d.luau || d.mandate || d.instructions || Array.isArray(d.commands));
    if (j && legacyFormat(j.format, PACK_FORMAT) && Array.isArray(j.items)) return { ok: true, pack: true, defs: j.items.filter((d) => d && typeof d === "object") };
    if (j && Array.isArray(j.items) && j.items.length && j.items.every(skillish)) return { ok: true, pack: true, defs: j.items };
    if (Array.isArray(j) && j.length && j.every(skillish)) return { ok: true, pack: true, defs: j };
    const def = j && legacyFormat(j.format, FORMAT) && j.item ? j.item : skillish(j) ? j : null;
    if (!def) return { ok: false, errors: ["unrecognised file - expected SKILL.md text, a TotalScript export (.orskill.json / .orskills.json) or an ORSKILL2:/ORSKILL1: share code"] };
    return { ok: true, def };
  }
  function importShared(text, opts) {
    const p = parseShared(text);
    if (!p.ok) return { ok: false, errors: p.errors, warnings: [], item: null, prompt: !!p.prompt, text: p.prompt ? p.text : undefined };
    if (p.pack) { const r = importPack(p.defs, opts); if (p.errors && p.errors.length) r.errors = (r.errors || []).concat(p.errors); return r; }
    const r = importOne(p.def, opts);
    if (p.warnings && p.warnings.length && r) r.warnings = (r.warnings || []).concat(p.warnings);
    return r;
  }
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
  // importOne: legacy abilities with Luau are converted on the way in; prompt-only
  // abilities and modes are refused with the reason.
  function importOne(src, opts) {
    let def = Object.assign({}, src);
    delete def.id; delete def.createdAt; delete def.updatedAt; delete def.tested;
    const kind = inferKind(def);
    if (LEGACY_KINDS.includes(kind)) {
      const conv = convertLegacy(Object.assign({}, def, { id: undefined }));
      if (!conv) return { ok: false, errors: [kind === "mode" ? `'${def.name || def.title}' is a work mode - modes were retired in 2.20.0 (only skills can be installed)` : `'${def.name || def.title}' is a prompt-only ability without Luau - abilities were retired in 2.20.0; design a skill from its text instead`], warnings: [], item: null };
      def = conv; delete def.id;
    }
    const dup = items.find((i) => i.name === snake(def.name || def.title));
    if (dup && !(opts && opts.replace)) return { ok: false, errors: [`a skill named '${dup.name}' is already installed - delete it first or import with replace`], warnings: [], item: null, duplicate: { id: dup.id, name: dup.name, kind: dup.kind } };
    if (dup) def.id = dup.id;
    return upsert(def, Object.assign({ source: "import" }, opts || {}));
  }

  // ── Legacy plain-text format (.txt) - import only ────────────────────────
  const SECTION_RE = /^\s*(?:-{3,}|={3,}|#{2,3})\s*([a-zA-Z][a-zA-Z0-9 _:'(),./+-]{1,60}?)\s*(?:-{3,}|={3,})?\s*$/;
  const EXAMPLE_SECTION_RE = /^\s*(?:-{3,}|={3,})\s*example\s*[:\-]?\s*(.*?)\s*(?:-{3,}|={3,})\s*$/i;
  const HEADER_KEYS = { kind: "kind", type: "kind", name: "name", command: "name", title: "title", description: "description", desc: "description", summary: "description", tags: "tags", tag: "tags", triggers: "triggers", trigger: "triggers", when: "triggers", params: "params", param: "params", parameters: "params", args: "params", author: "author", by: "author", usage: "usage", example: "usage", version: "version", executionmode: "executionMode", mode: "executionMode", references: "references", reference: "references", refs: "references", docs: "references", links: "references", expert: "expert" };
  const SECTION_KEYS = { luau: "luau", lua: "luau", code: "luau", script: "luau", program: "luau", verify: "verify", check: "verify", test: "verify", knowledge: "knowledge", instructions: "knowledge", instruction: "knowledge", procedure: "knowledge", prompt: "knowledge", rules: "knowledge", notes: "knowledge", steps: "steps", step: "steps", workflow: "steps", mandate: "mandate", description: "description", about: "description", references: "references", refs: "references", docs: "references", links: "references" };
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
  // parseText(text) -> {ok:true, def} for the legacy .txt layout (# Title / key: value /
  // --- luau --- sections) or {ok:false, prompt:true, text} for free prose.
  function parseText(text) {
    const src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!src.trim()) return { ok: false, errors: ["empty text"] };
    const lines = src.split("\n");
    const def = {}; const sections = {}; let cur = null; let title = null; let structure = 0;
    const headerBuf = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const exs = line.match(EXAMPLE_SECTION_RE);
      if (exs) { cur = "example:" + (exs[1] || "").trim().slice(0, 100); sections[cur] = sections[cur] || []; structure++; continue; }
      const sec = line.match(SECTION_RE);
      if (sec && SECTION_KEYS[sec[1].trim().toLowerCase()]) { cur = SECTION_KEYS[sec[1].trim().toLowerCase()]; sections[cur] = sections[cur] || []; structure++; continue; }
      if (cur) { sections[cur].push(line); continue; }
      if (title === null && /^#\s+\S/.test(line)) { title = line.replace(/^#\s+/, "").trim(); structure++; continue; }
      const kv = line.match(/^\s*([A-Za-z][A-Za-z _]{1,20})\s*[:=]\s*(.*)$/);
      if (kv && HEADER_KEYS[kv[1].trim().toLowerCase().replace(/\s+/g, "")]) {
        const key = HEADER_KEYS[kv[1].trim().toLowerCase().replace(/\s+/g, "")];
        if (key === "kind" || key === "name" || key === "params") structure++;
        def[key] = def[key] ? def[key] + "\n" + kv[2] : kv[2];
        continue;
      }
      if (line.trim()) headerBuf.push(line);
    }
    if (!sections.luau) { const fenced = extractLuau(src); if (fenced && fenced.trim().length >= 20) { sections.luau = fenced.split("\n"); structure++; } }
    if (!structure && !def.kind && !def.luau) return { ok: false, prompt: true, text: src, errors: ["no skill structure found (no kind:/--- luau --- markers, no ```luau fence) - this reads like a prompt"] };
    if (title && !def.title) def.title = title;
    for (const [k, v] of Object.entries(sections)) {
      const body = v.join("\n").replace(/^\n+|\n+$/g, "");
      if (k.startsWith("example:")) { (def.examples = def.examples || []).push({ title: k.slice(8) || `Example ${def.examples.length + 1}`, body }); }
      else if (k === "references") def.references = (def.references ? def.references + "\n" : "") + body;
      else if (k === "steps") def.knowledge = (def.knowledge ? def.knowledge + "\n\n" : "") + "Steps:\n" + body;
      else if (k === "luau") def.luau = body.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
      else if (k === "verify") def.verify = { luau: body.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "") };
      else if (k === "description") def.description = (def.description ? def.description + " " : "") + body.replace(/\s+/g, " ").trim();
      else if (k === "knowledge") def.knowledge = (def.knowledge ? def.knowledge + "\n\n" : "") + body;
      else def[k] = body;
    }
    if (!def.description && headerBuf.length) def.description = headerBuf.join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
    if (def.params) def.params = parseParamSpec(def.params);
    if (def.version) def.version = parseInt(def.version, 10) || 1;
    def.kind = String(def.kind || inferKind(def) || "skill").trim().toLowerCase().replace(/^work ?mode$/, "mode").replace(/^command$/, "skill");
    if (def.kind === "ability" && !def.instructions && def.knowledge) def.instructions = def.knowledge;
    if (!def.name && def.title) def.name = snake(def.title);
    return { ok: true, def, text: true };
  }

  // ── Prompt → skill ───────────────────────────────────────────────────────
  // A "full prompt" is a long piece of instructions the user already wrote.
  //   fromPrompt(text)          - no AI: only when the prompt already contains
  //                               Luau (the code becomes the command, the prose
  //                               the knowledge); otherwise {ok:false, needsAi}.
  //   conversionPrompt(text)    - the AI DESIGNS a skill from it: the prompt
  //                               becomes the knowledge (kept complete), the AI
  //                               writes the command(s) and a verify block.
  const looksLikeFullPrompt = (t) => { const s = String(t || "").trim(); return s.length >= 280 || s.split(/\n/).filter((l) => l.trim()).length >= 4; };
  const LUA_HINT_RE = /\b(local\s+\w+\s*=|game:GetService\(|Instance\.new\(|workspace[.:]|function\s*\(|\bend\b\s*$)/m;
  function extractLuau(text) {
    const src = String(text || "");
    const f = src.match(/```(?:lua|luau)?[^\n]*\n([\s\S]*?)```/i);
    if (f && LUA_HINT_RE.test(f[1])) return f[1].trim();
    if (LUA_HINT_RE.test(src) && (src.match(/\bend\b/g) || []).length >= 2 && (src.match(/\blocal\b/g) || []).length >= 2) return src.trim();
    return "";
  }
  function firstHeading(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const h = lines.find((l) => /^#{1,3}\s+\S/.test(l)); if (h) return h.replace(/^#+\s+/, "").slice(0, 80);
    const t = lines.find((l) => /^(title|name|skill)\s*[:\-]\s*\S/i.test(l)); if (t) return t.replace(/^[^:\-]+[:\-]\s*/, "").slice(0, 80);
    const first = lines[0] || "";
    if (first.length <= 70 && !/[.!?:;,]$/.test(first) && first.split(/\s+/).length <= 10) return first;
    return "";
  }
  function fromPrompt(text, opts) {
    opts = opts || {};
    const src = String(text || "").replace(/\r\n?/g, "\n").trim();
    const warnings = [];
    if (src.length < 20) return { ok: false, errors: ["the prompt is too short to become a skill (at least 20 characters)"], warnings, def: null };
    const title = str(opts.title || firstHeading(src) || ("Prompt " + new Date().toISOString().slice(0, 10)), 80).trim();
    const name = snake(opts.name || title) || ("prompt_skill_" + Date.now().toString(36).slice(-4));
    const body = src.replace(/^#{1,3}\s+[^\n]*\n+/, "");
    const firstPara = body.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
    let description = str(opts.description || firstPara, 300).trim();
    if (description.length < 10) description = `Made from a prompt: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
    const lua = extractLuau(src);
    if (!lua || /^(you are|always|never)/i.test(src)) return { ok: false, needsAi: true, errors: ["no Luau in the prompt - a skill needs a command program. Use 'Design a skill from it (AI)': the prompt becomes the knowledge and the AI writes the Luau + verify block"], warnings, def: null };
    const used = placeholdersIn(lua);
    const prose = src.replace(/```[\s\S]*?```/g, "").trim();
    const def = { kind: "skill", name, title, description, tags: ["from-prompt"], author: opts.author || "you", source: "manual", params: used.map((u) => ({ name: u, type: "string", description: `value for {{${u}}}` })), luau: lua.slice(0, LIMITS.luau), knowledge: prose !== lua.trim() ? prose.slice(0, LIMITS.knowledge) : "", usage: `${name} ${JSON.stringify(Object.fromEntries(used.map((u) => [u, "..."])))}` };
    if (lua.length > LIMITS.luau) warnings.push(`Luau truncated to ${LIMITS.luau} characters`);
    warnings.push("installed without a verify block - it stays UNVERIFIED until one is added (Improve with AI can write it) and passes a test");
    return { ok: true, errors: [], warnings, def };
  }
  function installFromPrompt(text, opts) {
    const r = fromPrompt(text, opts);
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, item: null, needsAi: !!r.needsAi };
    const u = upsert(r.def, { source: (opts && opts.source) || "manual", reserved: opts && opts.reserved });
    return Object.assign(u, { warnings: [...r.warnings, ...u.warnings], converted: "skill" });
  }
  function conversionPrompt(text, _kindHint, ctx) {
    ctx = ctx || {};
    const prompt = String(text || "").trim();
    const existing = items.length ? `Already installed (do not reuse these names): ${items.map((i) => signatures(i).map((s) => s.split(" ")[0]).join("/")).join(", ")}.` : "";
    const names = Array.isArray(ctx.commandNames) && ctx.commandNames.length ? `Built-in command names (sample; a public skill must not reuse them): ${ctx.commandNames.slice(0, 60).join(", ")}${ctx.commandNames.length > 60 ? " ..." : ""}` : "";
    const hints = [ctx.title ? `Suggested title: ${ctx.title}` : "", ctx.name ? `Suggested name: ${ctx.name}` : ""].filter(Boolean).join(" · ");
    return [
      "PROMPT → PUBLIC SKILL (DESIGN BRIEF) - the user wrote a full prompt and wants it installed as a real TotalScript SKILL. DESIGN the skill from it now.",
      "RULES: (a) KNOWLEDGE = the prompt itself - keep every instruction, rule and constraint (clean up formatting, never drop or soften anything; it is what you will be handed whenever the skill applies); (b) write the Luau COMMAND(S) that do the concrete work the prompt describes (params for everything that varies; several commands[] when the prompt describes several distinct actions); (c) write a VERIFY block that proves the result in Studio (find the instances the command must have created / changed, check their properties, return {ok=true, detail} or {ok=false, error}); (d) triggers = the words a user would say when this skill applies; (e) do not add behaviour the prompt does not ask for.",
      hints,
      PROCESS_DOC,
      "THE PROMPT (verbatim, between the markers):\n<<<PROMPT\n" + prompt + "\nPROMPT>>>",
      DEFINITION_DOC,
      referenceCandidates(prompt.slice(0, 1200), 8),
      libraryText(null, { design: true, budget: 2000, heading: "USER REFERENCE LIBRARY (the user marked these for every new design; use them only where the prompt leaves a gap - never override the prompt):" }),
      existing,
      names,
    ].filter(Boolean).join("\n\n");
  }

  function onChange(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }
  function replaceAll(arr) { items = []; for (const d of arr || []) { const v = validate(d, { allowDuplicateId: true, installed: items }); if (v.ok) items.push(v.item); } persist(); emit("reset", null); }

  const api = {
    VERSION, KINDS, LEGACY_KINDS, BASES, LEGACY_BASES, normalizeBase, PARAM_TYPES, NAME_RE, FORMAT, FORMAT_VERSION, LIMITS, DEFINITION_DOC, PACK_SEPARATOR,
    load, isLoaded: () => loaded, onChange,
    validate, list, get, has, find, commandOf, isCommand, upsert, update, remove, setEnabled, replaceAll,
    verification, markTested, clearTested, codeHash,
    buildLuau, buildVerify, syntaxCheckLuau, parseResult, resolveArgs, signature, signatures, schema, toolEntries, catalogueBlock, relevant,
    knowledgeText, knowledgeRider,
    recordRun, relatedExpert, referencesFor, referencesText, addReferences, removeReferences, adoptSuggested, referenceCandidates,
    managementTools: () => clone(MANAGEMENT_TOOLS), generationPrompt,
    toSkillMd, parseSkillMd, isSkillMd, parseYamlLite,
    exportObject, exportJson, fileName, jsonFileName, shareCode, parseShared, importShared, importPack, luauLiteral, snake,
    exportPackObject, exportPackJson, exportPackText, packFileName, packJsonFileName, packShareCode, PACK_FORMAT,
    parseText, exportText, textFileName, parseParamSpec,
    looksLikeFullPrompt, fromPrompt, installFromPrompt, conversionPrompt, extractLuau,
    migrateStored, convertLegacy, migrationNotice, dismissMigration, migrationArchiveJson,
    libraryText, libraryFor, PROMPT_MAX,
  };
  root.PublicSkills = api;
  try { load(); } catch {}
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
