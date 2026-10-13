// SPDX-License-Identifier: GPL-3.0-or-later
// ORscript Desktop UI. Talks to the bridge over /app/api (same origin) and, when
// running inside the Electron shell, to window.orscript for window/tray calls.
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const desktop = window.orscript || null;
  const API = (location.protocol === "file:" ? "http://127.0.0.1:3000" : "") + "/app/api";

  const state = {
    snap: null,
    tools: [],
    toolFilter: "all",
    toolQuery: "",
    logs: [],
    logLevel: "info",
    exPath: ".",
    exFile: null,
    updates: null,
    unread: 0,
    page: "home",
    skills: null,
    templates: null,
  };
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  // ── helpers ──────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json();
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toTimeString().slice(0, 8); };
  const fmtSize = (n) => { n = Number(n) || 0; if (n < 1024) return `${n} B`; const u = ["KB", "MB", "GB"]; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 2); return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`; };
  function toast(text, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, 3600);
  }
  function setDot(el, status) {
    if (!el) return;
    el.classList.remove("ok", "warn", "bad", "pulse");
    if (status) el.classList.add(...status.split(" "));
  }

  // ── navigation ───────────────────────────────────────────────────────────
  function go(page) {
    state.page = page;
    $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.page === page));
    $$(".page").forEach((p) => p.classList.toggle("is-active", p.dataset.page === page));
    $("#content").scrollTop = 0;
    if (page === "explorer") loadExplorer(state.exPath);
    if (page === "tools") renderTools();
    if (page === "toolkit") { fillRunToolSelect(); loadDiagnostics(); }
    if (page === "skills") loadSkills();
    if (page === "templates") loadTemplates();
    if (page === "terminal") { loadLogs(); setTimeout(() => $("#cmd-input").focus(), 50); }
    if (page === "updates" && !state.updates) checkUpdates();
    if (page === "home") { state.unread = 0; $("#tb-bell-dot").hidden = true; }
    try { localStorage.setItem("or.page", page); } catch { /* ignore */ }
  }
  $("#nav").addEventListener("click", (e) => { const b = e.target.closest(".nav-item"); if (b) go(b.dataset.page); });
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]"); if (g) return go(g.dataset.goto);
    const o = e.target.closest("[data-open]"); if (o) return openExternal(o.dataset.open);
    const a = e.target.closest("[data-action]"); if (a) return runAction(a.dataset.action, a);
  });
  $("#tb-bell").addEventListener("click", () => go("home"));

  async function openExternal(url) {
    if (desktop && desktop.openExternal) return desktop.openExternal(url);
    const r = await api("/open", { body: { target: url } });
    if (!r.ok) window.open(url, "_blank");
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async function runAction(action, btn) {
    const busy = (on) => { if (btn && btn.classList.contains("btn")) btn.disabled = on; };
    busy(true);
    try {
      switch (action) {
        case "open-workspace": { const r = await api("/open", { body: { target: "workspace" } }); toast(r.ok ? "Opened workspace folder" : r.error, r.ok ? "ok" : "bad"); break; }
        case "open-logs": { const r = await api("/open", { body: { target: "logs" } }); toast(r.ok ? "Opened log folder" : r.error, r.ok ? "ok" : "bad"); break; }
        case "probe": { toast("Probing Studio…"); const r = await api("/studio/probe", { body: {} }); toast(r.ok ? (r.studio ? "Roblox Studio is connected" : `Studio not attached${r.last_error ? ` - ${r.last_error}` : ""}`) : r.error, r.ok && r.studio ? "ok" : "bad"); break; }
        case "restart-mcp": { toast("Restarting Studio MCP…"); const r = await api("/studio/restart", { body: {} }); toast(r.ok ? `Studio MCP restarted (${r.tools} tools)` : r.error, r.ok ? "ok" : "bad"); break; }
        case "kill-studio": {
          if (!confirm("Force-close every Roblox Studio process? Unsaved work in Studio will be lost.")) break;
          const r = await api("/studio/kill", { body: {} }); toast(r.message || r.error, r.ok ? "ok" : "bad"); break;
        }
        case "clear-activity": await api("/activity/clear", { body: {} }); renderActivity([]); break;
        case "copy-diagnostics": {
          const r = await api("/diagnostics");
          try { await navigator.clipboard.writeText(r.text); toast("Diagnostics copied", "ok"); }
          catch { $("#diag-out").textContent = r.text; go("toolkit"); toast("Clipboard blocked - diagnostics shown in Toolkit"); }
          break;
        }
        default: break;
      }
    } catch (err) { toast(err.message, "bad"); }
    finally { busy(false); }
  }
  $("#kill-studio").addEventListener("click", (e) => runAction("kill-studio", e.currentTarget));

  // ── snapshot rendering ───────────────────────────────────────────────────
  function applySnapshot(snap) {
    state.snap = snap;
    const s = snap.studio, b = snap.bridge, t = snap.tools;
    $("#tb-version").textContent = `v${snap.version}`;
    $("#sb-version").textContent = `v${snap.version}`;
    $("#tb-effort").textContent = { fast: "Fast", deep: "Deep" }[snap.settings.effort] || "Default";

    // sidebar status box
    const httpOk = snap.bound.http && snap.bound.roblox && snap.bound.local;
    const linked = b.linked;
    setDot($("#sb-bridge-dot"), !httpOk ? "bad" : linked ? "ok" : "warn pulse");
    $("#sb-bridge-text").textContent = !httpOk ? `Port conflict on ${snap.host}` : linked ? `Bridge linked ${snap.host}:${snap.ports.http}` : `Bridge waiting ${snap.host}:${snap.ports.http}`;
    setDot($("#sb-studio-dot"), s.studio ? "ok" : s.studio_proc ? "warn" : "");
    $("#sb-studio-text").textContent = s.studio ? "Studio connected" : s.studio_proc ? (s.mcp_alive ? "Studio open - no place attached" : "Studio open - MCP down") : "Studio closed";

    // home strip + cards
    $("#home-bridge-chip").textContent = `${snap.host}:${snap.ports.http}${httpOk ? "" : " (busy)"}`;
    $("#home-bg-chip").textContent = desktop ? (snap.settings.closeToTray ? "tray mode ready" : "tray mode off") : "headless bridge";
    $("#home-ai-hint").textContent = linked ? `${b.roblox_clients + b.local_clients} extension link${b.roblox_clients + b.local_clients === 1 ? "" : "s"}` : "open any AI tab";

    $("#stat-bridge-value").textContent = !httpOk ? "Port busy" : linked ? "Linked" : "Waiting";
    $("#stat-bridge-sub").textContent = linked ? `Roblox ${b.roblox_clients} · AgentScript ${b.local_clients} · ws ${b.ws_clients}` : httpOk ? "Browser extension link" : (snap.port_report.filter((r) => r.action === "conflict").map((r) => `${r.port}: ${r.owner ? r.owner.name : "unknown"}`).join(", ") || "another process holds a port");
    setDot($('[data-dot="bridge"]'), !httpOk ? "bad" : linked ? "ok" : "warn pulse");

    $("#stat-studio-value").textContent = s.studio ? "Connected" : s.studio_proc ? "Open" : "Offline";
    $("#stat-studio-sub").textContent = s.studio ? `Primary Studio MCP · ${s.tools} tools` : s.mcp_alive ? "MCP alive - waiting for Studio" : s.command_available ? "Primary Studio MCP" : "mcp.bat not found - enable MCP in Studio";
    setDot($('[data-dot="studio"]'), s.studio ? "ok" : s.studio_proc || s.mcp_alive ? "warn" : "");

    $("#stat-tools-value").textContent = String(t.total);
    $("#stat-tools-sub").textContent = `RS ${t.rs} · AS ${t.as} · MCP ${t.mcp}`;
    setDot($('[data-dot="tools"]'), t.total ? "ok" : "warn");
    $("#nav-tools-count").textContent = t.total || "";

    $("#stat-ws-value").textContent = snap.workspace.exists ? (snap.workspace.full_access ? "Full access" : "Ready") : "Missing";
    $("#stat-ws-sub").textContent = snap.workspace.root;
    $("#stat-ws-sub").title = snap.workspace.root;
    setDot($('[data-dot="workspace"]'), snap.workspace.exists ? "ok" : "bad");
    $("#tk-ws").textContent = snap.workspace.root;

    renderActivity(snap.activity);
    renderServers(snap.servers);
    fillSettings(snap);
    $("#set-port-http").textContent = `${snap.host}:${snap.ports.http}`;
    $("#set-port-roblox").textContent = String(snap.ports.roblox);
    $("#set-port-local").textContent = String(snap.ports.local);
    $("#set-data-dir").textContent = snap.data_dir;
    $("#set-mcp-state").textContent = `Helper: ${s.command} - ${s.command_available ? "found" : "not found"} · ${s.mcp_alive ? "running" : "stopped"}${s.last_error ? ` · last error: ${s.last_error}` : ""}`;
    document.documentElement.dataset.theme = snap.settings.theme || "gold";
    document.documentElement.dataset.reduceMotion = snap.settings.reduceMotion ? "1" : "0";
    if (desktop && desktop.setTheme) desktop.setTheme(snap.settings.theme || "gold");
    $("#upd-current").textContent = `v${snap.version}`;
  }

  function renderActivity(rows) {
    const ul = $("#activity");
    if (!rows || !rows.length) { ul.innerHTML = '<li class="empty-row">No activity yet - connect the browser extension or run a tool.</li>'; return; }
    ul.innerHTML = rows.slice().reverse().slice(0, 80).map((r) => `<li><time>${fmtTime(r.ts)}</time><span class="k-${esc(r.kind)}">${esc(r.text)}</span></li>`).join("");
  }
  function appendActivity(entry) {
    if (!state.snap) return;
    state.snap.activity.push(entry);
    renderActivity(state.snap.activity);
    if (state.page !== "home") { state.unread++; $("#tb-bell-dot").hidden = false; }
  }

  // ── tools ────────────────────────────────────────────────────────────────
  async function loadTools() {
    const r = await api("/tools");
    state.tools = r.tools || [];
    renderTools();
    fillRunToolSelect();
  }
  function renderTools() {
    const q = state.toolQuery.trim().toLowerCase();
    const all = state.tools;
    $("#f-all").textContent = all.length;
    $("#f-rs").textContent = all.filter((t) => t.source === "RS").length;
    $("#f-as").textContent = all.filter((t) => t.source === "AS").length;
    $("#f-mcp").textContent = all.filter((t) => t.source === "MCP").length;
    const rows = all.filter((t) => (state.toolFilter === "all" || t.source === state.toolFilter) && (!q || `${t.name} ${t.description} ${t.server}`.toLowerCase().includes(q)));
    const srcName = { RS: "Roblox Studio", AS: "AgentScript", MCP: "MCP" };
    $("#tool-grid").innerHTML = rows.map((t) => {
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const req = new Set((t.inputSchema && t.inputSchema.required) || []);
      const params = Object.keys(props).map((k) => (req.has(k) ? `<b>${esc(k)}</b>` : esc(k))).join(", ");
      return `<article class="tool" title="${esc(t.name)}">
        <div class="tool-top"><span class="badge badge-${t.source.toLowerCase()}">${t.source}</span><span class="tool-name">${esc(t.name)}</span></div>
        <div class="tool-src">${esc(t.source === "MCP" ? t.server : srcName[t.source])}</div>
        <div class="tool-desc">${esc(t.description || "No description.")}</div>
        ${params ? `<div class="tool-params">${params}</div>` : ""}
        <span class="dot ok"></span>
      </article>`;
    }).join("");
    $("#tools-empty").hidden = rows.length > 0;
  }
  $("#tools-search").addEventListener("input", (e) => { state.toolQuery = e.target.value; renderTools(); });
  $("#tools-filters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip-btn"); if (!b) return;
    state.toolFilter = b.dataset.filter;
    $$(".chip-btn", $("#tools-filters")).forEach((x) => x.classList.toggle("is-active", x === b));
    renderTools();
  });

  // ── toolkit ──────────────────────────────────────────────────────────────
  function fillRunToolSelect() {
    const sel = $("#run-tool-name");
    const cur = sel.value;
    sel.innerHTML = state.tools.map((t) => `<option value="${esc(t.name)}">${esc(t.source)} · ${esc(t.name)}</option>`).join("");
    if (cur) sel.value = cur;
  }
  $("#run-tool-name").addEventListener("change", () => {
    const t = state.tools.find((x) => x.name === $("#run-tool-name").value);
    if (!t) return;
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const sample = {};
    for (const [k, v] of Object.entries(props)) sample[k] = v.type === "integer" || v.type === "number" ? 0 : v.type === "boolean" ? false : v.type === "array" ? [] : "";
    $("#run-tool-args").value = JSON.stringify(sample, null, 2);
  });
  $("#run-tool-btn").addEventListener("click", async () => {
    const name = $("#run-tool-name").value;
    let args;
    try { args = JSON.parse($("#run-tool-args").value || "{}"); } catch (err) { return toast(`Arguments must be JSON: ${err.message}`, "bad"); }
    const out = $("#run-tool-out"); out.hidden = false; out.className = "output"; out.textContent = `Running ${name}…`;
    $("#run-tool-images").innerHTML = "";
    const r = await api("/tools/call", { body: { name, arguments: args } });
    out.textContent = r.ok ? (r.text || "(empty result)") : `${r.errorCode || "ERROR"}: ${r.error}`;
    out.classList.toggle("err", !r.ok);
    if (r.ok && r.images && r.images.length) $("#run-tool-images").innerHTML = r.images.map((im) => `<img src="data:${esc(im.mimeType)};base64,${im.data}" alt="tool image">`).join("");
  });
  async function loadDiagnostics() { const r = await api("/diagnostics"); $("#diag-out").textContent = r.text || "—"; }

  // ── servers ──────────────────────────────────────────────────────────────
  function renderServers(list) {
    const el = $("#server-list");
    el.innerHTML = (list || []).map((s) => `<article class="card server" data-id="${esc(s.id)}">
      <div class="server-top"><span class="badge ${s.kind === "studio" ? "badge-rs" : s.kind === "workspace" ? "badge-as" : "badge-mcp"}">${s.kind === "studio" ? "RS" : s.kind === "workspace" ? "AS" : "MCP"}</span><b>${esc(s.name)}</b><span class="muted small">${esc(s.id)}</span><span class="dot ${s.alive ? "ok" : s.builtin ? "warn" : "bad"}"></span></div>
      <div class="muted small">${s.alive ? `${s.tools} tool${s.tools === 1 ? "" : "s"} live` : s.enabled === false ? "disabled" : "not running"}${s.kind === "studio" ? (s.studio ? " · Studio attached" : " · Studio not attached") : ""}</div>
      <div class="meta">${esc(s.kind === "workspace" ? s.root : [s.command, ...(s.args || [])].join(" "))}</div>
      ${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}
      <div class="server-actions">
        ${s.kind !== "workspace" ? `<button class="btn btn-ghost btn-sm" data-srv="restart">Restart</button>` : `<button class="btn btn-ghost btn-sm" data-goto="explorer">Browse</button>`}
        ${s.builtin ? "" : `<button class="btn btn-ghost btn-sm" data-srv="remove"><svg><use href="#i-trash"/></svg>Remove</button>`}
      </div>
    </article>`).join("");
  }
  $("#server-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-srv]"); if (!b) return;
    const id = b.closest(".server").dataset.id;
    b.disabled = true;
    if (b.dataset.srv === "restart") { const r = await api(`/servers/${id}/restart`, { body: {} }); toast(r.ok ? `${id} restarted` : r.error, r.ok ? "ok" : "bad"); }
    if (b.dataset.srv === "remove" && confirm(`Remove MCP server "${id}"?`)) { const r = await api(`/servers/${id}`, { method: "DELETE", body: {} }); toast(r.ok ? `${id} removed` : "not removed"); }
    b.disabled = false;
    loadTools();
  });
  $("#srv-add").addEventListener("click", async () => {
    const body = { id: $("#srv-id").value, name: $("#srv-name").value, command: $("#srv-cmd").value, args: $("#srv-args").value, env: $("#srv-env").value };
    const r = await api("/servers", { body });
    $("#srv-msg").textContent = r.ok ? `Saved "${r.server.name}" - starting…` : r.error;
    if (r.ok) { toast("MCP server saved", "ok"); ["#srv-id", "#srv-name", "#srv-cmd", "#srv-args", "#srv-env"].forEach((s) => ($(s).value = "")); setTimeout(loadTools, 2500); }
  });

  // ── explorer ─────────────────────────────────────────────────────────────
  async function loadExplorer(rel) {
    const r = await api(`/fs/list?path=${encodeURIComponent(rel || ".")}`);
    if (!r.ok) { toast(r.error, "bad"); return; }
    state.exPath = r.path;
    const parts = r.path === "." ? [] : r.path.split("/");
    let acc = "";
    $("#ex-crumbs").innerHTML = [`<button data-path=".">${esc(r.root)}</button>`].concat(parts.map((p) => { acc = acc ? `${acc}/${p}` : p; return `<span>/</span><button data-path="${esc(acc)}">${esc(p)}</button>`; })).join("");
    const rows = r.entries;
    $("#ex-files").innerHTML = (r.path !== "." ? `<li class="dir" data-path="${esc(parts.slice(0, -1).join("/") || ".")}" data-dir="1"><svg><use href="#i-folder"/></svg>..</li>` : "") +
      rows.map((e) => `<li class="${e.dir ? "dir" : "file"}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}"><svg><use href="#${e.dir ? "i-folder" : "i-file"}"/></svg><span>${esc(e.name)}</span><span class="size">${e.dir ? "" : fmtSize(e.size)}</span></li>`).join("") +
      (!rows.length ? '<li class="muted">Empty folder</li>' : "");
  }
  $("#ex-crumbs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) loadExplorer(b.dataset.path); });
  $("#ex-files").addEventListener("click", async (e) => {
    const li = e.target.closest("li[data-path]"); if (!li) return;
    if (li.dataset.dir === "1") return loadExplorer(li.dataset.path);
    $$("#ex-files li").forEach((x) => x.classList.toggle("is-active", x === li));
    const r = await api(`/fs/read?path=${encodeURIComponent(li.dataset.path)}`);
    if (!r.ok) return toast(r.error, "bad");
    state.exFile = li.dataset.path;
    $("#ex-view-title").textContent = li.dataset.path;
    $("#ex-editor").value = r.binary ? "" : r.text;
    $("#ex-editor").placeholder = r.binary ? `Binary file (${fmtSize(r.size)}) - not shown.` : "";
    $("#ex-editor").readOnly = !!r.binary;
    $("#ex-save").hidden = !!r.binary;
    $("#ex-delete").hidden = false;
    $("#ex-view-meta").textContent = `${fmtSize(r.size)} · modified ${r.mtime ? new Date(r.mtime).toLocaleString() : "?"}`;
  });
  $("#ex-save").addEventListener("click", async () => {
    if (!state.exFile) return;
    const r = await api("/fs/write", { body: { path: state.exFile, content: $("#ex-editor").value } });
    toast(r.ok ? r.text : r.error, r.ok ? "ok" : "bad");
  });
  $("#ex-delete").addEventListener("click", async () => {
    if (!state.exFile || !confirm(`Delete ${state.exFile}?`)) return;
    const r = await api("/fs/delete", { body: { path: state.exFile } });
    toast(r.ok ? r.text : r.error, r.ok ? "ok" : "bad");
    if (r.ok) { state.exFile = null; $("#ex-editor").value = ""; $("#ex-view-title").textContent = "Select a file"; $("#ex-save").hidden = $("#ex-delete").hidden = true; loadExplorer(state.exPath); }
  });
  $("#ex-new-folder").addEventListener("click", async () => {
    const name = prompt("New folder name (relative to the current folder):");
    if (!name) return;
    const r = await api("/fs/mkdir", { body: { path: state.exPath === "." ? name : `${state.exPath}/${name}` } });
    toast(r.ok ? r.text : r.error, r.ok ? "ok" : "bad");
    loadExplorer(state.exPath);
  });
  $("#ex-refresh").addEventListener("click", () => loadExplorer(state.exPath));

  // ── skills / templates / AIs ─────────────────────────────────────────────
  async function loadSkills() {
    if (!state.skills) state.skills = (await api("/skills")).families || [];
    renderSkills();
  }
  function renderSkills() {
    const q = $("#skills-search").value.trim().toLowerCase();
    let total = 0;
    const html = state.skills.map((f) => {
      const rows = f.skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
      if (!rows.length) return "";
      total += rows.length;
      return `<details class="card family" ${q ? "open" : ""}><summary>${esc(f.title)}<span class="muted small">${rows.length} commands · ${esc(f.engine)}</span></summary>
        <p class="muted small" style="padding:0 14px">${esc(f.description || "")}</p>
        <div class="skill-list">${rows.map((s) => `<div class="skill"><b>${esc(s.name)}</b><span>${esc(s.description)}</span></div>`).join("")}</div></details>`;
    }).join("");
    $("#skills-body").innerHTML = html || '<div class="empty">No skills match.</div>';
    $("#skills-count").textContent = `${total} commands in ${state.skills.length} families`;
  }
  $("#skills-search").addEventListener("input", renderSkills);

  async function loadTemplates() {
    if (!state.templates) state.templates = (await api("/templates")).templates || [];
    $("#templates-body").innerHTML = state.templates.map((t) => `<article class="card template" data-id="${esc(t.id)}">
      <div class="row gap"><b>${esc(t.name)}</b><span class="muted small mono">${esc(t.file)}</span></div>
      <p class="muted small">${esc(t.description)}</p>
      <div class="tags">${(t.tags || []).map((x) => `<span class="badge">${esc(x)}</span>`).join("")}</div>
      <pre>${esc(t.content.slice(0, 900))}${t.content.length > 900 ? "\n…" : ""}</pre>
      <div class="row gap end"><button class="btn btn-ghost btn-sm" data-tpl="copy"><svg><use href="#i-copy"/></svg>Copy</button><button class="btn btn-primary btn-sm" data-tpl="export"><svg><use href="#i-folder"/></svg>Export to workspace</button></div>
    </article>`).join("") || '<div class="empty">No templates bundled.</div>';
  }
  $("#templates-body").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tpl]"); if (!b) return;
    const id = b.closest(".template").dataset.id;
    const tpl = state.templates.find((t) => t.id === id);
    if (b.dataset.tpl === "copy") { try { await navigator.clipboard.writeText(tpl.content); toast("Template copied", "ok"); } catch { toast("Clipboard blocked", "bad"); } }
    else { const r = await api("/templates/export", { body: { id } }); toast(r.ok ? `Exported to ${r.path}` : r.error, r.ok ? "ok" : "bad"); }
  });

  async function loadAis() {
    const r = await api("/ais");
    const ais = r.ais || [];
    $("#ais-count").textContent = ais.length ? `(${ais.length} browser AIs)` : "";
    $("#ais-body").innerHTML = `<div class="ais">${ais.map((a) => `<span class="ai-pill" title="${esc(a.host)}"><i></i>${esc(a.name)}</span>`).join("")}</div><p class="muted small" style="margin-top:10px">The ORscript browser extension injects its command bar into each of these sites; every one of them reaches Studio through this bridge.</p>`;
  }

  // ── terminal ─────────────────────────────────────────────────────────────
  function logLine(entry) {
    if (LEVELS[entry.level] < LEVELS[state.logLevel]) return null;
    const div = document.createElement("div");
    div.className = `l-${entry.level}`;
    div.innerHTML = `<time>${fmtTime(entry.ts)}</time><span class="src">${esc(entry.source)}</span>${esc(entry.message)}`;
    return div;
  }
  async function loadLogs() {
    const r = await api("/logs?limit=600");
    state.logs = r.lines || [];
    const c = $("#console");
    c.innerHTML = "";
    for (const e of state.logs) { const el = logLine(e); if (el) c.appendChild(el); }
    c.scrollTop = c.scrollHeight;
  }
  function appendLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > 2000) state.logs.shift();
    const c = $("#console");
    const stick = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
    const el = logLine(entry);
    if (el) { c.appendChild(el); if (c.childElementCount > 1500) c.firstElementChild.remove(); if (stick) c.scrollTop = c.scrollHeight; }
  }
  $("#log-level").addEventListener("change", (e) => { state.logLevel = e.target.value; loadLogs(); });
  $("#log-clear").addEventListener("click", () => { $("#console").innerHTML = ""; });
  $("#cmd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#cmd-input");
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    const c = $("#console");
    const head = document.createElement("div"); head.className = "l-cmd"; head.textContent = `$ ${command}`; c.appendChild(head);
    c.scrollTop = c.scrollHeight;
    const r = await api("/terminal/run", { body: { command } });
    const out = document.createElement("div"); out.className = r.ok ? "l-out" : "l-error"; out.textContent = r.ok ? r.text : r.error; c.appendChild(out);
    c.scrollTop = c.scrollHeight;
  });

  // ── updates ──────────────────────────────────────────────────────────────
  async function checkUpdates() {
    $("#upd-status").textContent = "checking…";
    $("#tb-update").textContent = "(checking…)";
    const r = await api("/updates");
    state.updates = r;
    if (!r.ok) { $("#upd-status").textContent = `check failed - ${r.error}`; $("#upd-latest").textContent = "—"; $("#tb-update").textContent = ""; return; }
    if (r.latest) {
      $("#upd-latest").textContent = `v${r.latest}`;
      $("#upd-status").textContent = r.up_to_date ? "Up to date" : "Update available";
      $("#tb-update").textContent = r.up_to_date ? "(Up to date)" : "(Update available)";
      if (r.notes) { $("#upd-notes").hidden = false; $("#upd-notes").textContent = r.notes; }
    } else if (r.latest_commit) {
      $("#upd-latest").textContent = `${r.latest_commit.sha} · ${r.latest_commit.message}`;
      $("#upd-status").textContent = "No tagged release yet - tracking main";
      $("#tb-update").textContent = "(Up to date)";
    }
  }
  $("#upd-check").addEventListener("click", checkUpdates);

  // ── settings ─────────────────────────────────────────────────────────────
  let settingsBound = false;
  function fillSettings(snap) {
    const s = snap.settings;
    $$("[data-setting]").forEach((el) => {
      if (document.activeElement === el) return;
      const key = el.dataset.setting;
      if (el.type === "checkbox") el.checked = !!s[key];
      else el.value = s[key] == null ? "" : s[key];
    });
    if (settingsBound) return;
    settingsBound = true;
    $$("[data-setting]").forEach((el) => {
      const ev = el.tagName === "INPUT" && el.type === "text" || el.tagName === "INPUT" && !el.type ? "change" : "change";
      el.addEventListener(ev, async () => {
        const key = el.dataset.setting;
        const value = el.type === "checkbox" ? el.checked : el.value;
        const r = await api("/settings", { body: { [key]: value } });
        if (r.ok) {
          toast("Saved", "ok");
          if (desktop && desktop.settingsChanged) desktop.settingsChanged(r.settings);
        } else toast(r.error || "Could not save", "bad");
      });
    });
  }
  if (desktop && desktop.pickFolder) {
    const pick = $("#pick-folder");
    pick.hidden = false;
    pick.addEventListener("click", async () => {
      const dir = await desktop.pickFolder();
      if (!dir) return;
      const r = await api("/settings", { body: { workspaceRoot: dir } });
      if (r.ok) { toast("Workspace updated", "ok"); loadExplorer("."); }
    });
  }

  // ── window controls (desktop shell only) ─────────────────────────────────
  if (desktop) {
    $("#win-controls").hidden = false;
    $("#win-min").addEventListener("click", () => desktop.minimize());
    $("#win-max").addEventListener("click", () => desktop.toggleMaximize());
    $("#win-close").addEventListener("click", () => desktop.close());
    document.documentElement.classList.add("is-desktop");
  } else {
    $("#titlebar").style.webkitAppRegion = "no-drag";
  }

  // ── live events ──────────────────────────────────────────────────────────
  let es = null, retry = 1000;
  function connectEvents() {
    if (es) es.close();
    es = new EventSource(API + "/events");
    es.addEventListener("snapshot", (e) => { retry = 1000; applySnapshot(JSON.parse(e.data)); });
    es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
    es.addEventListener("activity", (e) => appendActivity(JSON.parse(e.data)));
    es.addEventListener("activity-cleared", () => { if (state.snap) { state.snap.activity = []; renderActivity([]); } });
    es.onerror = () => {
      es.close(); es = null;
      $("#sb-bridge-text").textContent = "Bridge unreachable - retrying…";
      setDot($("#sb-bridge-dot"), "bad pulse");
      setTimeout(connectEvents, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  // snapshot changes that affect the tool list -> refresh catalog lazily
  let lastToolSig = "";
  setInterval(() => {
    if (!state.snap) return;
    const sig = `${state.snap.tools.total}:${state.snap.tools.rs}:${state.snap.tools.mcp}`;
    if (sig !== lastToolSig) { lastToolSig = sig; loadTools(); }
  }, 1500);

  // ── boot ─────────────────────────────────────────────────────────────────
  (async () => {
    try {
      applySnapshot(await api("/snapshot"));
    } catch { $("#sb-bridge-text").textContent = "Bridge starting…"; }
    connectEvents();
    loadTools();
    loadAis();
    let page = "home";
    try { page = localStorage.getItem("or.page") || "home"; } catch { /* ignore */ }
    if (location.hash) page = location.hash.slice(1) || page;
    if (!$(`.page[data-page="${page}"]`)) page = "home";
    go(page);
    if (state.snap && state.snap.settings.checkUpdates) checkUpdates(); else $("#tb-update").textContent = "";
  })();
})();
