// TotalScript — Task list
//
// A persistent checklist the user (or the agent) maintains. When the feature is
// ENABLED (Settings → Task list) the agent sees the open tasks in its prompt and
// state line, gets the task_* commands, and the bar shows a progress pill; the
// cards panel gains a "Tasks" tab (add / reorder / tick / run with AI). When
// DISABLED nothing is injected anywhere and the tab is hidden - the tasks stay
// saved. Storage: chrome.storage.local key rsTaskList.
//
// DOM-free at top level (the tests load it in node).
(function (root) {
  "use strict";
  const KEY = "rsTaskList";
  const STATUSES = ["todo", "doing", "done", "skipped"];
  const MAX_TASKS = 200;
  const MAX_TEXT = 500;
  let state = { enabled: false, tasks: [] };
  let loaded = false, loadPromise = null;
  const listeners = new Set();

  const storage = () => { try { return root.chrome && root.chrome.storage && root.chrome.storage.local || null; } catch { return null; } };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const uid = () => "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  const str = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || MAX_TEXT);

  function emit(reason, task) {
    for (const fn of [...listeners]) { try { fn({ reason, task, state: snapshot() }); } catch {} }
    try { if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") root.dispatchEvent(new root.CustomEvent("total-tasklist-change", { detail: { reason, task: task ? clone(task) : null } })); } catch {}
  }
  function persist() { const st = storage(); if (!st) return; try { st.set({ [KEY]: clone(state) }); } catch {} }
  function normalizeTask(t, i) {
    if (!t || typeof t !== "object") return null;
    const text = str(t.text || t.title || t.task);
    if (!text) return null;
    return {
      id: typeof t.id === "string" && /^t_[a-z0-9_]+$/.test(t.id) ? t.id : uid(),
      text,
      status: STATUSES.includes(t.status) ? t.status : t.done === true ? "done" : "todo",
      notes: str(t.notes, 400),
      by: t.by === "ai" ? "ai" : "user",
      createdAt: Number(t.createdAt) || Date.now() + i,
      doneAt: Number(t.doneAt) || null,
    };
  }
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      const st = storage();
      if (!st) { loaded = true; return resolve(snapshot()); }
      try {
        st.get([KEY], (r) => {
          try {
            const raw = r && r[KEY] && typeof r[KEY] === "object" ? r[KEY] : {};
            state = { enabled: raw.enabled === true, tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS) };
          } catch { state = { enabled: false, tasks: [] }; }
          loaded = true; emit("loaded", null); resolve(snapshot());
        });
      } catch { loaded = true; resolve(snapshot()); }
    });
    return loadPromise;
  }

  const snapshot = () => clone(state);
  const isEnabled = () => state.enabled === true;
  function setEnabled(v) { state.enabled = !!v; persist(); emit("enabled", null); return state.enabled; }
  const list = (filter) => state.tasks.filter((t) => !filter || !filter.status || t.status === filter.status).map(clone);
  function find(ref) {
    if (ref == null || ref === "") return null;
    if (typeof ref === "object") ref = ref.id != null ? ref.id : ref.index;
    const s = String(ref).trim();
    let t = state.tasks.find((x) => x.id === s);
    if (!t && /^#?\d+$/.test(s)) t = state.tasks[parseInt(s.replace("#", ""), 10) - 1];
    if (!t) { const lower = s.toLowerCase(); t = state.tasks.find((x) => x.text.toLowerCase() === lower) || state.tasks.find((x) => x.text.toLowerCase().includes(lower) && lower.length >= 4); }
    return t || null;
  }
  const indexOf = (task) => state.tasks.findIndex((t) => t.id === task.id);
  function add(text, opts) {
    const lines = Array.isArray(text) ? text : String(text == null ? "" : text).split(/\r?\n/);
    const added = [];
    for (const line of lines) {
      const clean = str(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, ""));
      if (!clean) continue;
      if (state.tasks.length >= MAX_TASKS) break;
      const t = normalizeTask({ text: clean, by: opts && opts.by, status: opts && opts.status }, added.length);
      if (!t) continue;
      if (opts && opts.first) state.tasks.unshift(t); else state.tasks.push(t);
      added.push(clone(t));
    }
    if (added.length) { persist(); emit("added", added[added.length - 1]); }
    return added;
  }
  function update(ref, patch) {
    const t = find(ref);
    if (!t) return null;
    patch = patch || {};
    if (patch.text != null && str(patch.text)) t.text = str(patch.text);
    if (patch.notes != null) t.notes = str(patch.notes, 400);
    if (patch.status != null) {
      const s = String(patch.status).toLowerCase();
      const map = { complete: "done", completed: "done", finished: "done", ok: "done", pending: "todo", open: "todo", reopen: "todo", progress: "doing", in_progress: "doing", "in-progress": "doing", active: "doing", started: "doing", skip: "skipped", blocked: "skipped", cancel: "skipped", cancelled: "skipped" };
      const next = STATUSES.includes(s) ? s : map[s];
      if (!next) return { error: `status must be one of ${STATUSES.join(" | ")}` };
      if (next === "doing") for (const o of state.tasks) if (o.status === "doing" && o.id !== t.id) o.status = "todo";
      t.status = next;
      t.doneAt = next === "done" ? Date.now() : null;
    }
    persist(); emit("updated", t);
    return clone(t);
  }
  function remove(ref) { const t = find(ref); if (!t) return null; state.tasks = state.tasks.filter((x) => x.id !== t.id); persist(); emit("removed", t); return clone(t); }
  function move(ref, delta) {
    const t = find(ref); if (!t) return false;
    const i = indexOf(t), j = Math.max(0, Math.min(state.tasks.length - 1, i + (Number(delta) || 0)));
    if (i === j) return false;
    state.tasks.splice(i, 1); state.tasks.splice(j, 0, t); persist(); emit("moved", t); return true;
  }
  function clearDone() { const n = state.tasks.length; state.tasks = state.tasks.filter((t) => t.status !== "done" && t.status !== "skipped"); persist(); emit("cleared", null); return n - state.tasks.length; }
  function replaceAll(tasks) { state.tasks = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS); persist(); emit("reset", null); return list(); }
  const next = () => { const t = state.tasks.find((x) => x.status === "doing") || state.tasks.find((x) => x.status === "todo"); return t ? clone(t) : null; };
  function progress() {
    const total = state.tasks.length, done = state.tasks.filter((t) => t.status === "done").length, skipped = state.tasks.filter((t) => t.status === "skipped").length;
    return { total, done, skipped, open: total - done - skipped, doing: state.tasks.filter((t) => t.status === "doing").length };
  }
  const numbered = (t) => `${indexOf(t) + 1}`;
  const mark = { todo: "[ ]", doing: "[>]", done: "[x]", skipped: "[-]" };

  // Short tag for the SYSTEM_STATE line (only when enabled).
  function stateTag() {
    if (!isEnabled() || !state.tasks.length) return "";
    const p = progress(), n = next();
    return ` | TASKS ${p.done}/${p.total}${n ? ` next #${numbered(n)} "${n.text.slice(0, 60)}${n.text.length > 60 ? "…" : ""}"` : " all done"}`;
  }
  // Prompt block (system prompt + task_list output).
  function promptBlock(opts) {
    if (!isEnabled()) return "";
    const p = progress();
    const rows = state.tasks.map((t) => `${mark[t.status]} #${numbered(t)} ${t.text}${t.notes ? ` — ${t.notes}` : ""}`);
    const head = `━━━ TASK LIST (user-enabled; ${p.done}/${p.total} done${p.doing ? ", 1 in progress" : ""}) ━━━`;
    const rules = (opts && opts.compact)
      ? `Work the open tasks in order unless the user says otherwise. Mark progress with task_update {id|"#n", status: "doing"|"done"|"skipped", notes?} — "done" only after you verified the result. task_add adds follow-ups; task_next returns the next open task.`
      : `This is the user's own checklist for this project. Rules: (1) when the user says "next task", "continue the list" or "do the tasks", call task_next and work on exactly that task; (2) set it to "doing" first (task_update {"id":"#n","status":"doing"}) and to "done" only after the result was verified in Studio/the workspace - never mark done on intent; (3) if a task is impossible or out of scope, mark it "skipped" with notes explaining why; (4) add follow-up work you discover with task_add instead of silently doing it; (5) never delete or rewrite the user's tasks except through task_update when they ask; (6) do not start the list on your own when the user asked for something unrelated.`;
    return `${head}\n${rows.length ? rows.join("\n") : "(empty - the user has not added tasks yet; task_add {text} adds one when they ask)"}\n${rules}`;
  }

  const TOOLS = [
    { name: "task_list", description: "Show the user's task list (Settings → Task list) with ids, status and progress.", inputSchema: { type: "object", properties: { status: { type: "string", enum: STATUSES } } }, executionMode: "READ" },
    { name: "task_next", description: "Return the next open task (the one in progress, else the first todo) and mark it 'doing'.", inputSchema: { type: "object", properties: { start: { type: "boolean", description: "Mark it doing (default true)" } } }, executionMode: "WRITE" },
    { name: "task_add", description: "Add one or more tasks to the user's task list (one per line).", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" }, first: { type: "boolean", description: "Insert at the top" } } }, executionMode: "WRITE" },
    { name: "task_update", description: "Update a task: status todo|doing|done|skipped, notes, or text. Use 'done' only after verifying the result.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "task id, '#n' index, or exact text" }, status: { type: "string", enum: STATUSES }, notes: { type: "string" }, text: { type: "string" } } }, executionMode: "WRITE" },
  ].map((t) => Object.assign(t, { server: "totalscript", environment: "GENERAL", category: "Task list", taskList: true, virtual: true }));
  const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
  const isCommand = (name) => isEnabled() && TOOL_NAMES.has(String(name || "").split("/").pop());
  const toolEntries = () => (isEnabled() ? clone(TOOLS) : []);

  // Executes a task_* command; returns the string the agent receives.
  function run(name, args) {
    const op = String(name || "").split("/").pop();
    args = args && typeof args === "object" ? args : {};
    const out = (obj) => `Output of '${op}':\n${JSON.stringify(obj, null, 2)}`;
    if (!isEnabled()) return `ERROR in ${op}: the Task list is disabled (Settings → Task list → Enable). Nothing was changed.`;
    const row = (t) => ({ id: t.id, n: indexOf(t) + 1, status: t.status, text: t.text, notes: t.notes || undefined, by: t.by });
    if (op === "task_list") { const items = list(args.status ? { status: args.status } : null).map((t) => row(state.tasks.find((x) => x.id === t.id))); return out({ success: true, progress: progress(), tasks: items, next: next() ? "#" + numbered(state.tasks.find((x) => x.id === next().id)) : null }); }
    if (op === "task_next") { const n = next(); if (!n) return out({ success: true, task: null, message: "All tasks are done - tell the user and stop." }); const t = state.tasks.find((x) => x.id === n.id); if (args.start !== false && t.status !== "doing") update(t.id, { status: "doing" }); return out({ success: true, task: row(t), remaining: progress().open, instruction: `Work on task #${numbered(t)} now. When it is verified call task_update {"id":"${t.id}","status":"done","notes":"what you did"}.` }); }
    if (op === "task_add") { const added = add(args.text, { by: "ai", first: !!args.first }); if (!added.length) return `ERROR in task_add: text is empty`; return out({ success: true, added: added.map((t) => row(state.tasks.find((x) => x.id === t.id))), progress: progress() }); }
    if (op === "task_update") { const t = find(args.id || args.task || args.n); if (!t) return `ERROR in task_update: no task matches '${args.id || args.task || args.n}' - call task_list for ids (#n works too).`; const r = update(t.id, { status: args.status, notes: args.notes, text: args.text }); if (r && r.error) return `ERROR in task_update: ${r.error}`; const n = next(); return out({ success: true, task: row(t), progress: progress(), next: n ? `#${numbered(state.tasks.find((x) => x.id === n.id))} ${n.text}` : null }); }
    return `ERROR in ${op}: unknown task command`;
  }

  function exportJson() { return JSON.stringify({ format: "totalscript-task-list", version: 1, exportedAt: new Date().toISOString(), tasks: state.tasks.map((t) => ({ text: t.text, status: t.status, notes: t.notes })) }, null, 2); }
  function importText(text, opts) {
    const s = String(text || "").trim();
    if (!s) return { ok: false, error: "nothing to import", added: 0 };
    let tasks = null;
    try { const j = JSON.parse(s); tasks = Array.isArray(j) ? j : j && Array.isArray(j.tasks) ? j.tasks : null; } catch {}
    if (!tasks) tasks = s.split(/\r?\n/).map((l) => ({ text: l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""), status: /^\s*(?:[-*•]\s*)?\[[xX]\]/.test(l) ? "done" : "todo" }));
    const norm = tasks.map((t) => typeof t === "string" ? { text: t } : t).map(normalizeTask).filter(Boolean);
    if (!norm.length) return { ok: false, error: "no tasks found", added: 0 };
    if (opts && opts.replace) state.tasks = norm.slice(0, MAX_TASKS); else state.tasks = state.tasks.concat(norm).slice(0, MAX_TASKS);
    persist(); emit("imported", null);
    return { ok: true, added: norm.length };
  }

  function onChange(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }

  const api = { KEY, STATUSES, load, isLoaded: () => loaded, onChange, snapshot, isEnabled, setEnabled, list, find, add, update, remove, move, clearDone, replaceAll, next, progress, stateTag, promptBlock, toolEntries, isCommand, run, exportJson, importText };
  root.TotalTaskList = api;
  try { root.__rsTaskList = () => (isEnabled() ? progress() : null); } catch {}
  try { load(); } catch {}
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
