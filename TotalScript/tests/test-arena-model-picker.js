// Regression for the Arena model picker being closed by the Direct-mode
// restore: Arena uses role=combobox for BOTH its chat-mode control and model
// picker. This executes the real adapter against a tiny DOM double (no jsdom or
// live Arena), with the model picker already open as a user would have it.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../src/providers/arena.js"), "utf8");

function boot({ modeLabel = "Direct", modelOpen = false } = {}) {
  let now = 1_000_000;
  class FastDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { const t = now; now += 500; return t; }
  }
  const combo = (textContent, expanded) => ({
    textContent,
    expanded,
    clicks: 0,
    offsetParent: {},
    getAttribute(name) { return name === "aria-expanded" ? (this.expanded ? "true" : "false") : null; },
    click() { this.clicks++; this.expanded = !this.expanded; },
  });
  const model = combo("GPT-4.1", modelOpen);
  const mode = combo(modeLabel, false);
  const modelOption = { offsetParent: {}, textContent: "GPT-4.1", click() {} };
  const directOption = {
    offsetParent: {},
    textContent: "DirectChat with 1 model at a time",
    clicks: 0,
    click() { this.clicks++; mode.textContent = "Direct"; mode.expanded = false; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'button[role="combobox"]') return [model, mode];
      if (selector === "[role=\"option\"]") {
        if (mode.expanded) return [directOption];
        return model.expanded ? [modelOption] : [];
      }
      if (selector.startsWith("button[aria-label=")) return [];
      return [];
    },
  };
  const window = {};
  const context = {
    window,
    document,
    location: { pathname: "/text/direct" },
    Date: FastDate,
    Promise,
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    console,
  };
  vm.runInNewContext(src, context, { filename: "arena.js" });
  assert(window.RSProvider, "Arena provider loaded");
  return { provider: window.RSProvider, model, mode, directOption };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

(async () => {
  // The common user report: the independent model menu is open while chat mode
  // is already Direct. init() must not toggle any combobox or dismiss that menu.
  {
    const { provider, model, mode } = boot({ modeLabel: "Direct", modelOpen: true });
    provider.init();
    await flush();
    assert.strictEqual(model.clicks, 0, "init must not click the model picker");
    assert.strictEqual(model.expanded, true, "the user's open model picker must remain open");
    assert.strictEqual(mode.clicks, 0, "Direct mode needs no restore click");
    assert.strictEqual(provider.modeWarning(), "", "Direct mode remains recognized");
  }

  // Keep the existing one-shot recovery for unsupported chat modes, while
  // proving it targets the mode combobox rather than the preceding model picker.
  {
    const { provider, model, mode, directOption } = boot({ modeLabel: "Battle", modelOpen: false });
    provider.init();
    await flush();
    assert.strictEqual(model.clicks, 0, "restore must never click the model picker");
    assert.strictEqual(mode.clicks, 1, "Battle mode should open its own selector once");
    assert.strictEqual(directOption.clicks, 1, "Direct option should be selected once");
    assert.strictEqual(mode.textContent, "Direct", "mode should be restored to Direct");
    assert.strictEqual(provider.modeWarning(), "", "restored Direct mode is accepted");
  }

  console.log("test-arena-model-picker: 11 checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
