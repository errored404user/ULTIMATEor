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
assert(code.includes('function deepRoots(scope = document)'), "shadow-root traversal is shared across selector queries");
assert(code.includes("Date.now() - _shadowRootsCache.at < 160"), "document shadow-root traversal is briefly cached");
assert(adapterBundle, "MultiChat adapter bundle is registered");
assert(streamTap && streamTap.run_at === "document_start", "generic stream tap runs at document_start");
for (const required of ["src/core/config.js", "src/core/parser.js", "src/core/command_registry.js", "src/core/project_worker.js", "src/core/template_registry.js", "src/core/main.js", "src/providers/stream-reader.js"]) assert(adapterBundle.js.includes(required), required);
assert(adapterBundle.js.indexOf("src/providers/stream-reader.js") < adapterBundle.js.indexOf("src/providers/multichat.js"));
assert(adapterBundle.js.indexOf("src/providers/multichat.js") < adapterBundle.js.indexOf("src/core/main.js"));
const wwwAIFreePattern = "https://www.aifreeforever.com/*";
assert(adapterBundle.matches.includes(wwwAIFreePattern), "www AI Free Forever redirect receives the provider adapter");
assert(streamTap.matches.includes(wwwAIFreePattern), "www AI Free Forever redirect receives the MAIN-world stream tap");
assert(manifest.host_permissions.includes("https://www.aifreeforever.com/*"), "www AI Free Forever redirect is covered by host permissions");
assert(background.includes(wwwAIFreePattern), "www AI Free Forever redirect receives status broadcasts");
assert(popup.includes("www.aifreeforever.com"), "popup recognizes the www AI Free Forever redirect");

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
    const routeDefinition = site.id === "aifreeforever"
      ? `const AI_FREE_URL = "${site.url}";`
      : site.id === "langdock"
        ? `const LANGDOCK_URL = "${site.url}";`
        : site.id === "huggingchat"
          ? `"huggingface.co": { id: "huggingchat", name: "HuggingChat", chat: "${site.url}" }`
          : `"openrouter.ai": { id: "openrouter", name: "OpenRouter Chat", chat: "${site.url}" }`;
    assert(code.includes(routeDefinition), `${site.id} fallback chat URL matches its launch route`);
    assert.equal(P.supportsVision, site.id === "huggingchat" || site.id === "openrouter", `${site.id} image capability is conservative until verified`);
    assert.equal(P.typeAndSendFalseMeansNoSubmit, true, `${site.id} false return guarantees no submit action was issued`);
    assert.equal(P.typeAndSendSingleCommit, true, `${site.id} never lets the core re-submit an ambiguous commit`);
    assert.equal(P.commandlessRetries, 2, `${site.id} preserves the shared adapter's bounded commandless retry policy`);
    assert.equal(P.resendSystemEvery, 10, `${site.id} preserves periodic system-prompt reinforcement`);
    assert.match(P.promptExtra, /###LUA###.*###END_LUA###/s, `${site.id} preserves the provider command-format guidance`);
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
  const auth = load({ host: "aifreeforever.com", path: "/login", composer: "none" }).P;
  assert.equal(auth.loginGatePresent(), true, "an auth route is reported instead of guessed around");
  assert.equal((await auth.ensureComposerReady("test")).ready, false, "a login gate never reports the provider ready");
  assert.match(auth.modeWarning(), /sign in/i, "login warning tells the user to authenticate on the site");
  assert.deepEqual(cases.slice(2).map((x) => [x.id, x.name]), [["aifreeforever", "AI Free Forever"], ["langdock", "Langdock"]]);
  console.log("PASS  MultiChat registrations, redirects, auth gates, composer selection, and single-commit/no-submit contracts (offline mocks)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
