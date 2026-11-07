// src/core/public_refs.js — Public Skills → References (2.10.0)
//
// A reference LIBRARY the user curates on this device: official docs links,
// plain notes, pasted Luau / GUI snippets and text files. Entries are attached
// to specific Public Skills (by name) and/or flagged "design" (handed to the AI
// whenever it designs or converts a NEW item). The skills engine appends the
// attached entries to an ability call, a mode's mandate and public_skill_refs
// through PublicSkills.referencesText - this module never talks to the AI
// itself and never executes anything from an entry.
//
// Storage: chrome.storage.local rsPublicRefs (one array). Dependency-free,
// DOM-free; loads before public_skills.js and is consulted lazily (typeof
// PublicReferences !== "undefined"), so either module works without the other.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  const VERSION = "2.10.0";
  const KEY = "rsPublicRefs";
  const KINDS = Object.freeze(["link", "note", "snippet"]);
  const LANGS = Object.freeze(["luau", "text", "json", "markdown"]);
  const LIMITS = Object.freeze({ items: 80, title: 80, url: 500, body: 16000, tags: 8, attach: 30, total: 400000, textBudget: 3500, snippetMax: 2500 });
  const FORMAT = "totalscript-public-references";

  let items = [];
  let loaded = false;
  let loadPromise = null;

  const str = (v, max) => { const s = v == null ? "" : String(v); return max ? s.slice(0, max) : s; };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const now = () => Date.now();
  const uid = () => "pr_" + now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const snake = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  function storage() { try { return root.chrome && root.chrome.storage && root.chrome.storage.local ? root.chrome.storage.local : null; } catch { return null; } }
  function emit(reason, item) {
    try {
      if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") root.dispatchEvent(new root.CustomEvent("total-public-refs-change", { detail: { reason, item: item ? clone(item) : null } }));
    } catch {}
  }
  function persist() { const st = storage(); if (!st) return; try { st.set({ [KEY]: clone(items) }); } catch {} }
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      const st = storage();
      if (!st) { loaded = true; return resolve(list()); }
      try {
        st.get([KEY], (r) => {
          try {
            const raw = r && Array.isArray(r[KEY]) ? r[KEY] : [];
            items = raw.map((e) => { const v = validate(e, { keepId: true }); return v.ok ? v.entry : null; }).filter(Boolean);
          } catch { items = []; }
          loaded = true; emit("loaded", null); resolve(list());
        });
      } catch { loaded = true; resolve(list()); }
    });
    return loadPromise;
  }

  // ── validation ────────────────────────────────────────────────────────────
  function isHttpUrl(u) { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; } catch { return false; } }
  function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } }
  // '/docs/...' shorthands resolve to the Creator Docs like the per-item references do.
  function normalizeUrl(u) { u = str(u, LIMITS.url).trim(); if (/^\/docs\//.test(u)) u = "https://create.roblox.com" + u; return u; }
  function inferLang(body, hint) {
    const h = String(hint || "").toLowerCase();
    if (LANGS.includes(h)) return h;
    if (/^(lua|luau)$/.test(h)) return "luau";
    if (/^(md)$/.test(h)) return "markdown";
    const b = String(body || "");
    if (/^\s*[\[{]/.test(b) && /[\]}]\s*$/.test(b)) { try { JSON.parse(b); return "json"; } catch {} }
    if (/\blocal\s+\w+|\bfunction\b[\s\S]*\bend\b|game:GetService\(|\bInstance\.new\(/.test(b)) return "luau";
    return "text";
  }
  function tagList(v) {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
    const out = [];
    for (const t of arr) { const s = snake(t).slice(0, 24); if (s && !out.includes(s)) out.push(s); if (out.length >= LIMITS.tags) break; }
    return out;
  }
  function nameList(v) {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
    const out = [];
    for (const t of arr) { const s = snake(t); if (s && !out.includes(s)) out.push(s); if (out.length >= LIMITS.attach) break; }
    return out;
  }
  // validate(def, {keepId}) -> {ok, errors[], warnings[], entry}
  function validate(def, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    const d = def && typeof def === "object" ? def : {};
    let kind = String(d.kind || "").toLowerCase();
    const url = normalizeUrl(d.url || d.href || "");
    let body = str(d.body != null ? d.body : d.text != null ? d.text : d.code != null ? d.code : "", LIMITS.body + 1);
    if (!kind) kind = url && !body.trim() ? "link" : /\blocal\s+\w+|\bend\b|game:GetService|<\w+/.test(body) ? "snippet" : "note";
    if (!KINDS.includes(kind)) errors.push(`kind must be one of ${KINDS.join(" | ")}`);
    if (kind === "link") {
      if (!url) errors.push("a link needs url");
      else if (!isHttpUrl(url)) errors.push(`url must start with http(s):// (got '${url.slice(0, 60)}')`);
    } else {
      if (body.length > LIMITS.body) { warnings.push(`body trimmed to ${LIMITS.body} characters`); body = body.slice(0, LIMITS.body); }
      if (body.trim().length < 8) errors.push(`a ${kind} needs body text (at least 8 characters)`);
      if (url && !isHttpUrl(url)) errors.push("url must start with http(s):// or be empty");
    }
    let title = str(d.title || d.name, LIMITS.title).trim();
    if (!title) title = kind === "link" ? (hostOf(url) + (url.split("/").filter(Boolean).pop() ? " · " + decodeURIComponent(url.split("/").filter(Boolean).pop()).replace(/[-_]+/g, " ").slice(0, 40) : "")) : body.trim().split(/\r?\n/)[0].replace(/^[-#*\s]+/, "").slice(0, 60);
    if (!title) errors.push("title is required");
    const entry = {
      id: opts.keepId && typeof d.id === "string" && d.id ? d.id : uid(),
      kind, title,
      url: kind === "link" || url ? url : "",
      body: kind === "link" ? str(d.body || d.note || "", 600).trim() : body,
      lang: kind === "snippet" ? inferLang(body, d.lang) : kind === "note" ? (inferLang(body, d.lang) === "json" ? "json" : "text") : "",
      tags: tagList(d.tags),
      attach: nameList(d.attach || d.skills || d.items),
      design: d.design === true || d.design === "true" || d.useInDesign === true,
      source: ["user", "ai", "import"].includes(d.source) ? d.source : "user",
      createdAt: Number(d.createdAt) || now(),
      updatedAt: Number(d.updatedAt) || now(),
    };
    return { ok: errors.length === 0, errors, warnings, entry };
  }
  function sizeOf(e) { return (e.title || "").length + (e.url || "").length + (e.body || "").length; }
  function totalSize(extra) { return items.reduce((n, e) => n + sizeOf(e), 0) + (extra ? sizeOf(extra) : 0); }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  function list(filter) {
    filter = filter || {};
    let out = items.slice();
    if (filter.kind) out = out.filter((e) => e.kind === filter.kind);
    if (filter.attachedTo) { const n = snake(filter.attachedTo); out = out.filter((e) => e.attach.includes(n)); }
    if (filter.design === true) out = out.filter((e) => e.design);
    if (filter.query) {
      const q = String(filter.query).toLowerCase().split(/\s+/).filter(Boolean);
      out = out.filter((e) => { const hay = [e.title, e.url, e.body.slice(0, 2000), e.tags.join(" "), e.attach.join(" ")].join(" ").toLowerCase(); return q.every((w) => hay.includes(w)); });
    }
    // newest change first; same millisecond -> the later-added one first
    return clone(out.map((e, i) => [e, items.indexOf(e)]).sort((p, q) => q[0].updatedAt - p[0].updatedAt || q[1] - p[1]).map((p) => p[0]));
  }
  function find(ref) {
    if (!ref) return null;
    const s = String(ref).trim();
    return items.find((e) => e.id === s) || items.find((e) => e.title.toLowerCase() === s.toLowerCase()) || items.find((e) => e.url && e.url === normalizeUrl(s)) || (/^\d+$/.test(s) ? list()[Number(s) - 1] && items.find((e) => e.id === list()[Number(s) - 1].id) : null) || null;
  }
  const get = (ref) => { const e = find(ref); return e ? clone(e) : null; };
  function add(def, opts) {
    opts = opts || {};
    const keepId = !!(opts.keepId && def && typeof def.id === "string" && def.id && !items.some((e) => e.id === def.id));
    const v = validate(Object.assign({}, def, { id: keepId ? def.id : undefined, source: opts.source || (def && def.source) || "user" }), { keepId });
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, entry: null };
    if (items.length >= LIMITS.items) return { ok: false, errors: [`the library holds at most ${LIMITS.items} references - remove one first`], warnings: v.warnings, entry: null };
    if (totalSize(v.entry) > LIMITS.total) return { ok: false, errors: [`the library would exceed ${Math.round(LIMITS.total / 1000)} KB - remove or shorten an entry first`], warnings: v.warnings, entry: null };
    const dupUrl = v.entry.url && items.find((e) => e.url === v.entry.url);
    if (dupUrl && !opts.allowDuplicate) return { ok: false, errors: [`that url is already in the library as '${dupUrl.title}' (id ${dupUrl.id}) - update it instead`], warnings: v.warnings, entry: clone(dupUrl), duplicate: clone(dupUrl) };
    const dupBody = v.entry.body && v.entry.body.length > 40 && items.find((e) => e.kind !== "link" && e.body === v.entry.body);
    if (dupBody && !opts.allowDuplicate) return { ok: false, errors: [`that exact text is already in the library as '${dupBody.title}' (id ${dupBody.id})`], warnings: v.warnings, entry: clone(dupBody), duplicate: clone(dupBody) };
    items.push(v.entry); persist(); emit("added", v.entry);
    return { ok: true, errors: [], warnings: v.warnings, entry: clone(v.entry) };
  }
  function update(ref, patch) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`no reference '${ref}' - public_skill_reference {op:"list"} shows them`], warnings: [], entry: null };
    const merged = Object.assign({}, cur, patch && typeof patch === "object" ? patch : {}, { id: cur.id, createdAt: cur.createdAt, updatedAt: now() });
    const v = validate(merged, { keepId: true });
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, entry: null };
    if (totalSize(v.entry) - sizeOf(cur) > LIMITS.total) return { ok: false, errors: [`the library would exceed ${Math.round(LIMITS.total / 1000)} KB`], warnings: v.warnings, entry: null };
    const clash = v.entry.url && items.find((e) => e.id !== cur.id && e.url === v.entry.url);
    if (clash) return { ok: false, errors: [`that url is already in the library as '${clash.title}'`], warnings: v.warnings, entry: null };
    items[items.indexOf(cur)] = v.entry; persist(); emit("updated", v.entry);
    return { ok: true, errors: [], warnings: v.warnings, entry: clone(v.entry) };
  }
  function remove(ref) {
    const cur = find(ref);
    if (!cur) return { ok: false, errors: [`no reference '${ref}'`], removed: null };
    items.splice(items.indexOf(cur), 1); persist(); emit("removed", cur);
    return { ok: true, errors: [], removed: clone(cur) };
  }
  function attach(ref, names) {
    const cur = find(ref); if (!cur) return { ok: false, errors: [`no reference '${ref}'`], entry: null };
    const add = nameList(names); if (!add.length) return { ok: false, errors: ["names: give one or more Public Skill names (snake_case)"], entry: null };
    const merged = cur.attach.concat(add.filter((n) => !cur.attach.includes(n))).slice(0, LIMITS.attach);
    return update(cur.id, { attach: merged });
  }
  function detach(ref, names) {
    const cur = find(ref); if (!cur) return { ok: false, errors: [`no reference '${ref}'`], entry: null };
    const del = nameList(names);
    const kept = del.length ? cur.attach.filter((n) => !del.includes(n)) : [];
    return update(cur.id, { attach: kept });
  }
  function setDesign(ref, on) { const cur = find(ref); if (!cur) return { ok: false, errors: [`no reference '${ref}'`], entry: null }; return update(cur.id, { design: !!on }); }
  function replaceAll(arr) { items = (Array.isArray(arr) ? arr : []).map((e) => { const v = validate(e, { keepId: true }); return v.ok ? v.entry : null; }).filter(Boolean); persist(); emit("replaced", null); return list(); }
  // Called by the skills engine when an item is renamed / removed so attachments follow.
  function renameAttachment(oldName, newName) {
    const o = snake(oldName), n = snake(newName); let changed = 0;
    for (const e of items) { const i = e.attach.indexOf(o); if (i >= 0) { if (n && !e.attach.includes(n)) e.attach[i] = n; else e.attach.splice(i, 1); e.updatedAt = now(); changed++; } }
    if (changed) { persist(); emit("renamed", null); }
    return changed;
  }

  // ── what the AI sees ──────────────────────────────────────────────────────
  // forItem(name, {design}) - entries attached to the item (+ the design-flagged
  // ones when asked). designEntries() - the ones handed to every new design.
  const forItem = (name, opts) => { const n = snake(name); const withDesign = !!(opts && opts.design); return clone(items.filter((e) => e.attach.includes(n) || (withDesign && e.design)).sort((a, b) => b.updatedAt - a.updatedAt)); };
  const designEntries = () => clone(items.filter((e) => e.design).sort((a, b) => b.updatedAt - a.updatedAt));
  function summary(e) {
    const extra = e.kind === "link" ? hostOf(e.url) : `${e.lang || "text"} · ${e.body.length} chars`;
    return { id: e.id, kind: e.kind, title: e.title, url: e.url || undefined, lang: e.lang || undefined, chars: e.kind === "link" ? undefined : e.body.length, tags: e.tags, attach: e.attach, design: e.design, meta: extra };
  }
  // textFor(entries, {budget, heading}) - the block appended to prompts. Links
  // are listed, notes / snippets are quoted (each capped at snippetMax, all
  // within budget); anything cut says how to fetch it.
  function textFor(entries, opts) {
    opts = opts || {};
    const arr = (Array.isArray(entries) ? entries : []).filter(Boolean);
    if (!arr.length) return "";
    const budget = Number(opts.budget) > 0 ? Number(opts.budget) : LIMITS.textBudget;
    const L = [opts.heading || "USER REFERENCES (the user's own material for this - follow it over general habits; links are to read, snippets show the shape to copy; nothing here ran):"];
    let used = 0; // the heading is not charged to the budget
    const omitted = [];
    const links = arr.filter((e) => e.kind === "link"), texts = arr.filter((e) => e.kind !== "link");
    for (const e of links) {
      const line = `- [link] ${e.title} — ${e.url}${e.body ? ` (${e.body})` : ""}${e.tags.length ? ` #${e.tags.join(" #")}` : ""}`;
      if (used + line.length > budget) { omitted.push(e); continue; }
      L.push(line); used += line.length + 1;
    }
    for (const e of texts) {
      const head = `--- [${e.kind === "snippet" ? (e.lang || "text") + " snippet" : "note"}] ${e.title}${e.tags.length ? " #" + e.tags.join(" #") : ""} ---`;
      const room = Math.min(LIMITS.snippetMax, budget - used - head.length - 40);
      if (room < 120) { omitted.push(e); continue; }
      const body = e.body.length > room ? e.body.slice(0, room).replace(/\s+\S*$/, "") + `\n…(${e.body.length - room} more chars)` : e.body;
      L.push(head, body); used += head.length + body.length + 2;
    }
    if (omitted.length) L.push(`(${omitted.length} more not shown for length: ${omitted.map((e) => `'${e.title}' id ${e.id}`).join(", ")} - public_skill_reference {op:"get", id} prints one in full)`);
    return L.join("\n");
  }
  // One line for the system prompt (only when the library is non-empty).
  function promptLine() {
    if (!items.length) return "";
    const d = items.filter((e) => e.design).length, a = items.filter((e) => e.attach.length).length;
    return `REFERENCE LIBRARY: ${items.length} user reference${items.length === 1 ? "" : "s"} (links / notes / snippets)${a ? `, ${a} attached to public items (appended automatically when those run)` : ""}${d ? `, ${d} marked for every new design` : ""} - public_skill_reference {op:"list"} lists them, {op:"get", id} prints one, {op:"add", ...} saves one the user gives you.`;
  }

  // ── files / import / export ───────────────────────────────────────────────
  // fromFile(text, fileName) -> a definition (not yet added): .lua/.luau → luau
  // snippet, .json → json note, .md/.txt → note; a single URL on its own → link.
  function fromFile(text, fileName) {
    const t = String(text || "").replace(/^\uFEFF/, "");
    const name = String(fileName || "").split(/[\\/]/).pop() || "";
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    const title = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().slice(0, LIMITS.title) || "Pasted reference";
    const trimmed = t.trim();
    if (/^https?:\/\/\S+$/.test(trimmed)) return { kind: "link", url: trimmed, title: title === "Pasted reference" ? "" : title };
    if (ext === "lua" || ext === "luau") return { kind: "snippet", lang: "luau", title, body: t };
    if (ext === "json") return { kind: "note", lang: "json", title, body: t };
    return { kind: inferLang(t) === "luau" ? "snippet" : "note", title, body: t };
  }
  const exportObject = () => ({ format: FORMAT, formatVersion: 1, app: "TotalScript", exportedAt: new Date().toISOString(), count: items.length, items: clone(items) });
  const exportJson = () => JSON.stringify(exportObject(), null, 2);
  const fileName = () => `totalscript-references-${new Date().toISOString().slice(0, 10)}.json`;
  function importJson(text, opts) {
    opts = opts || {};
    let j; try { j = JSON.parse(String(text || "")); } catch { return { ok: false, errors: ["not valid JSON"], added: 0, skipped: 0 }; }
    const arr = j && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : null;
    if (!arr || (j && j.format && j.format !== FORMAT)) return { ok: false, errors: [j && j.format ? `this is a ${j.format} file, not a references library` : "no items[] found"], added: 0, skipped: 0 };
    if (opts.replace) items = [];
    let added = 0, skipped = 0; const errors = [];
    for (const d of arr) { const r = add(Object.assign({}, d, { source: "import" }), { source: "import", keepId: true }); if (r.ok) added++; else if (r.duplicate) skipped++; else errors.push(`${d && d.title ? d.title : "entry"}: ${r.errors[0]}`); }
    return { ok: errors.length === 0, errors, added, skipped };
  }
  const isLibraryJson = (text) => { try { const j = JSON.parse(String(text || "")); return !!(j && j.format === FORMAT && Array.isArray(j.items)); } catch { return false; } };

  const api = Object.freeze({
    VERSION, KEY, KINDS, LANGS, LIMITS, FORMAT,
    load, isLoaded: () => loaded,
    validate, list, get, find, add, update, remove, attach, detach, setDesign, replaceAll, renameAttachment,
    forItem, designEntries, summary, textFor, promptLine,
    fromFile, exportObject, exportJson, fileName, importJson, isLibraryJson,
    count: () => items.length, totalSize: () => totalSize(),
  });
  root.PublicReferences = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  try { load(); } catch {}
})();
