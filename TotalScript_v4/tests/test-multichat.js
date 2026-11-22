"use strict";
// Offline registration + adapter-contract test for the shared MultiChat family.
// The new host checks use synthetic composer elements; they do not claim live-site compatibility.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const code = fs.readFileSync("src/providers/multichat.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const main = fs.readFileSync("src/core/main.js", "utf8");
const background = fs.readFileSync("background.js", "utf8");
const popup = fs.readFileSync("popup.js", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const css = fs.readFileSync("overlay.css", "utf8");
const cases = [
  { host: "huggingface.co", path: "/chat/", id: "huggingchat", name: "HuggingChat", url: "https://huggingface.co/chat/", match: "https://huggingface.co/chat/*", composer: "textarea" },
  { host: "openrouter.ai", path: "/chat", id: "openrouter", name: "OpenRouter Chat", url: "https://openrouter.ai/chat", match: "https://openrouter.ai/*", composer: "textarea" },
  { host: "aifreeforever.com", path: "/chat/deepseek-v4-flash", id: "aifreeforever", name: "AI Free Forever", url: "https://aifreeforever.com/chat/deepseek-v4-flash", match: "https://aifreeforever.com/*", composer: "textarea" },
  { host: "app.langdock.com", path: "/chat", id: "langdock", name: "Langdock", url: "https://app.langdock.com/chat", match: "https://app.langdock.com/chat*", composer: "contenteditable" },
];
const adapterBundle = manifest.content_scripts.find((x) => x.js && x.js.includes("src/providers/multichat.js"));
const streamTap = manifest.content_scripts.find((x) => x.world === "MAIN" && x.js.includes("src/providers/stream-net.js"));
assert(adapterBundle, "MultiChat adapter bundle is registered");
assert(streamTap && streamTap.run_at === "document_start", "generic stream tap runs at document_start");
for (const required of ["src/core/config.js", "src/core/parser.js", "src/core/command_registry.js", "src/core/project_worker.js", "src/core/template_registry.js", "src/core/main.js", "src/providers/stream-reader.js"]) assert(adapterBundle.js.includes(required), required);
assert(adapterBundle.js.indexOf("src/providers/stream-reader.js") < adapterBundle.js.indexOf("src/providers/multichat.js"));
assert(adapterBundle.js.indexOf("src/providers/multichat.js") < adapterBundle.js.indexOf("src/core/main.js"));

function load(site) {
  const editable = {
    tagName: site.composer === "textarea" ? "TEXTAREA" : "DIV",
    value: "",
    isContentEditable: site.composer === "contenteditable",
    className: "",
    closest: () => null,
    getBoundingClientRect: () => ({ width: 480, height: 48, top: 0, left: 0, right: 480, bottom: 48 }),
    getAttribute: (name) => name === "contenteditable" && site.composer === "contenteditable" ? "true" : null,
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, dispatchEvent() {},
  };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (site.composer === "textarea" && selector === "textarea") return [editable];
      if (site.composer === "contenteditable" && selector.includes("contenteditable")) return [editable];
      return [];
    },
    documentElement: { setAttribute() {} },
    addEventListener() {},
    activeElement: null,
  };
  const win = {
    document, window: null,
    location: { hostname: site.host, origin: `https://${site.host}`, pathname: site.path, href: `https://${site.host}${site.path}` },
    navigator: { userAgent: "test" }, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    InputEvent: class {}, KeyboardEvent: class {}, Event: class {},
    HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(code + "\n;window.__P = RSProvider;", context);
  return { P: win.__P, editable };
}

(async () => {
  for (const site of cases) {
    const { P, editable } = load(site);
    assert(P, site.host);
    assert.equal(P.id, site.id, `${site.host} provider id`);
    assert.equal(P.displayName, site.name, `${site.host} display name`);
    assert(code.includes(`chat:"${site.url}"`), `${site.id} fallback chat URL matches its launch route`);
    assert.equal(P.supportsVision, site.id === "huggingchat" || site.id === "openrouter", `${site.id} image capability is conservative until verified`);
    for (const fn of ["getEditor", "typeAndSend", "allItems", "readAssistant", "ensureComposerReady", "scanError", "modeWarning", "installSendHooks"]) assert.equal(typeof P[fn], "function", `${site.id}.${fn}`);
    assert.strictEqual(P.getEditor(), editable, `${site.id} generic composer selector finds the synthetic ${site.composer} surface`);
    assert.equal(P.modeWarning(), "", `${site.id} does not warn when a visible chat composer exists`);
    assert.equal((await P.ensureComposerReady("test")).ready, true, `${site.id} reports the synthetic composer ready`);
    assert(adapterBundle.matches.includes(site.match), `${site.id} isolated content script matches requested host/path`);
    assert(streamTap.matches.includes(site.match), `${site.id} receives the MAIN-world stream tap`);
    const explicitPermission = site.id === "aifreeforever" || site.id === "langdock";
    assert(explicitPermission ? manifest.host_permissions.includes(`https://${site.host}/*`) : (manifest.host_permissions.includes("<all_urls>") || manifest.host_permissions.includes("https://*/*")), `${site.id} host permission`);
    assert(background.includes(site.match), `${site.id} receives status broadcasts`);
    assert(popup.includes(`"${site.host}"`), `${site.id} popup recognizes the host`);
    if (site.id === "aifreeforever" || site.id === "langdock") {
      assert(popup.includes(site.url), `${site.id} popup launches the requested chat route`);
      assert(readme.includes(site.url), `${site.id} route is documented`);
    }
    assert(main.includes(`{ name: "${site.name}", url: "${site.url}" }`), `${site.id} is in the AI switcher`);
    assert(css.includes(`rs-prov-${site.id}`), `${site.id} transparent bar styling`);
    assert(readme.includes(site.name), `${site.id} is listed in the README`);
  }
  assert.deepEqual(cases.slice(2).map((x) => [x.id, x.name]), [["aifreeforever", "AI Free Forever"], ["langdock", "Langdock"]]);
  console.log("PASS  HuggingChat, OpenRouter Chat, AI Free Forever, and Langdock registration + generic composer contracts (offline mocks)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
