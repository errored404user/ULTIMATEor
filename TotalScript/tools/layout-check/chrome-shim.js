(() => {
  const store = {}; const listeners = [];
  const get = (k, cb) => { let out = {}; if (k == null) out = { ...store }; else if (typeof k === "string") out[k] = store[k]; else if (Array.isArray(k)) k.forEach(x => out[x] = store[x]); else { out = { ...k }; Object.keys(k).forEach(x => { if (x in store) out[x] = store[x]; }); } Object.keys(out).forEach(x => out[x] === undefined && delete out[x]); if (cb) cb(out); return Promise.resolve(out); };
  const set = (o, cb) => { Object.assign(store, o); cb && cb(); return Promise.resolve(); };
  const remove = (k, cb) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); cb && cb(); return Promise.resolve(); };
  window.chrome = { runtime: { id: "fakeext", lastError: null, getURL: (p) => "/__ext/" + p, getManifest: () => ({ version: "1.19.7" }), sendMessage: (m, cb) => { cb && setTimeout(() => cb(undefined), 0); return Promise.resolve(undefined); }, onMessage: { addListener() {}, removeListener() {} }, connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) },
    storage: { local: { get, set, remove }, sync: { get, set, remove }, onChanged: { addListener: (f) => listeners.push(f), removeListener() {} } } };
})();
