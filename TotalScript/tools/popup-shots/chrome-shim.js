// Stand-in for the extension APIs so popup.html can be rendered in a plain
// headless Chromium (dev tool only — nothing here ships). Window-global
// `__SHOT` drives the scenario: bridge status, tabs, storage seed, activity.
(() => {
  const S = window.__SHOT || {};
  const store = Object.assign({}, S.storage || {});
  const session = {};
  const listeners = [];
  const norm = (k) => { let out = {}; if (k == null) out = { ...store }; else if (typeof k === "string") out[k] = store[k]; else if (Array.isArray(k)) k.forEach((x) => (out[x] = store[x])); else { out = { ...k }; Object.keys(k).forEach((x) => { if (x in store) out[x] = store[x]; }); } Object.keys(out).forEach((x) => out[x] === undefined && delete out[x]); return out; };
  const area = (bag) => ({
    get: (k, cb) => { const out = norm(k); if (cb) cb(out); return Promise.resolve(out); },
    set: (o, cb) => { const ch = {}; for (const k of Object.keys(o)) { ch[k] = { oldValue: bag[k], newValue: o[k] }; bag[k] = o[k]; } cb && cb(); listeners.forEach((f) => { try { f(ch, "local"); } catch {} }); return Promise.resolve(); },
    remove: (k, cb) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete bag[x]); cb && cb(); return Promise.resolve(); },
  });
  const status = Object.assign({ type: "rs-status", connected: false, mcpAlive: false, studio: null, studioApp: null, studioProc: null, lifecycle: "IDLE", reconnecting: false, manual: false, robloxProc: null, roblox_connected: false, local_connected: false, local_full: false, local_root: "", tools: 0, servers: [], engine: "roblox", blender: false }, S.status || {});
  const activity = S.activity || [];
  const tools = S.tools || [];
  const reply = (msg) => {
    switch (msg && msg.type) {
      case "status": return status;
      case "activity_log": return { ok: true, items: activity };
      case "activity_clear": return { ok: true };
      case "list_tools": return { ok: tools.length > 0, tools, servers: status.servers, studio: status.roblox_connected };
      case "mcp.healthCheck": return { success: true, connected: status.connected, state: status.lifecycle, latency: status.connected ? 12 : null, lastError: status.connected ? null : "MCP_SERVER_UNAVAILABLE", capabilities: { tools: status.tools } };
      case "blender_status": return { ok: status.blender, blender: status.blender };
      case "rs-get-engine": return { engine: status.engine };
      case "rs-get-full": return { enabled: status.local_full };
      case "rs-set-engine": status.engine = msg.engine; return { engine: msg.engine };
      case "rs-set-full": return { ok: true, enabled: !!msg.enabled };
      case "reconnect": return { ok: true };
      case "restart_mcp": return { ok: true };
      default: return { ok: true };
    }
  };
  window.__shotCalls = [];
  window.chrome = {
    runtime: {
      id: "shot", lastError: null,
      getURL: (p) => location.href.replace(/[^/]*$/, "") + p,
      getManifest: () => ({ version: S.version || "2.12.0" }),
      sendMessage: (m, cb) => { window.__shotCalls.push(m); const r = reply(m); if (cb) setTimeout(() => cb(r), 0); return Promise.resolve(r); },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: { local: area(store), session: area(session), onChanged: { addListener: (f) => listeners.push(f), removeListener() {} } },
    tabs: {
      query: (q, cb) => { let t = S.tabs || []; if (q && q.active) t = t.filter((x) => x.active); if (q && q.url) { const p = String(q.url).replace(/\*$/, ""); t = t.filter((x) => String(x.url || "").startsWith(p)); } if (cb) cb(t); return Promise.resolve(t); },
      create: (o) => { window.__shotCalls.push({ type: "tabs.create", url: o.url }); return Promise.resolve({ id: 99 }); },
      update: (id, o) => { window.__shotCalls.push({ type: "tabs.update", id, o }); return Promise.resolve({ id }); },
      sendMessage: () => Promise.resolve(),
    },
    windows: { update: () => Promise.resolve() },
  };
})();
