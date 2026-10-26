(() => {
  const store = {}; const listeners = []; const log = (window.__shimLog = []);
  const get = (k, cb) => { let out = {}; if (k == null) out = { ...store }; else if (typeof k === "string") out[k] = store[k]; else if (Array.isArray(k)) k.forEach(x => out[x] = store[x]); else { out = { ...k }; Object.keys(k).forEach(x => { if (x in store) out[x] = store[x]; }); } Object.keys(out).forEach(x => out[x] === undefined && delete out[x]); if (cb) cb(out); return Promise.resolve(out); };
  const set = (o, cb) => { Object.assign(store, o); cb && cb(); return Promise.resolve(); };
  const remove = (k, cb) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); cb && cb(); return Promise.resolve(); };
  const STATUS = window.__fakeStatus = { type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true, robloxProc: true, studioProc: true, engine: "roblox", tools: 2, servers: [{id:"roblox",name:"Roblox Studio",alive:true,tools:2}], local_connected: false, local_full: false };
  const TOOLS = [
    { name: "run_code", description: "Run Luau in Studio", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "insert_model", description: "Insert a model", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "screen_capture", description: "Viewport screenshot", inputSchema: { type: "object", properties: {} } },
  ];
  window.__calls = [];
  const reply = (m) => { log.push(m && m.type); if (m && m.type === "status") return { ok: true, ...STATUS };
    if (m && m.type === "list_tools") return { ok: true, tools: TOOLS, studio: true, roblox_connected: true, servers: STATUS.servers };
    if (m && m.type === "call_tool") { window.__calls.push(m.name); return { ok: true, text: "OK: " + m.name + " executed" }; }
    if (m && m.type === "settings") return {}; return { ok: true }; };
  window.chrome = { runtime: { id: "fakeext", lastError: null, getURL: (p) => "/__ext/" + p, getManifest: () => ({ version: "1.19.8" }),
      sendMessage: (m, cb) => { const r = reply(m); cb && setTimeout(() => cb(r), 0); return Promise.resolve(r); },
      onMessage: { addListener(f) { window.__onMsg = f; }, removeListener() {} }, connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) },
    storage: { local: { get, set, remove }, sync: { get, set, remove }, onChanged: { addListener: (f) => listeners.push(f), removeListener() {} } } };
})();
