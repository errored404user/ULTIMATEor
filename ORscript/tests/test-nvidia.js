// Focused contract/lifecycle checks for NVIDIA NIM Kimi K3.
const fs = require("fs");
const path = require("path");

const providerCode = fs.readFileSync(path.join(__dirname, "../src/providers/nvidia.js"), "utf8");
const netCode = fs.readFileSync(path.join(__dirname, "../src/providers/nvidia-net.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const popup = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
const mainCode = fs.readFileSync(path.join(__dirname, "../src/core/main.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../overlay.css"), "utf8");
let failures = 0;
const ok = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures++;
};

class FakeEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
global.Event = FakeEvent;
global.InputEvent = FakeEvent;
global.KeyboardEvent = FakeEvent;
global.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });

function element(tag, attrs = {}, text = "") {
  const values = { ...attrs };
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    type: values.type || "",
    value: values.value || "",
    textContent: text,
    innerText: text,
    className: values.class || "",
    childNodes: text ? [{ nodeType: 3, nodeValue: text, parentElement: null }] : [],
    children: [],
    parentElement: null,
    isConnected: true,
    disabled: false,
    style: { pointerEvents: "", caretColor: "" },
    dataset: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : null; },
    setAttribute(name, value) { values[name] = String(value); },
    removeAttribute(name) { delete values[name]; },
    getBoundingClientRect() { return { width: 600, height: 80, left: 100, right: 700, top: 500, bottom: 580 }; },
    focus() { global.document.activeElement = this; },
    dispatchEvent() { return true; },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
    matches(selector) {
      if (selector.includes("#rs-root")) return false;
      return false;
    },
    closest(selector) {
      for (let n = this; n; n = n.parentElement) {
        if (selector === "form" && n.tagName === "FORM") return n;
        if ((selector.includes('[role="main"]') || /(^|,)\s*main/.test(selector)) && n.tagName === "MAIN") return n;
        if (selector.includes("#rs-root")) return null;
        if (selector.includes("button") && n.tagName === "BUTTON") return n;
      }
      return null;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}
function append(parent, child) { child.parentElement = parent; parent.children.push(child); parent.childNodes.push(child); return child; }

function fixture() {
  const main = element("main");
  const user = append(main, element("article", { "data-message-role": "user" }, "hello"));
  const assistant = append(main, element("article", { "data-message-role": "assistant" }, '{"command":"list_commands","params":{}}'));
  const form = append(main, element("form"));
  const editor = append(form, element("textarea", { placeholder: "Type text here" }));
  const send = append(form, element("button", { type: "submit", "aria-label": "Send" }));
  send.getBoundingClientRect = () => ({ width: 32, height: 32, left: 665, right: 697, top: 545, bottom: 577 });
  form.querySelectorAll = (selector) => selector.includes("button") ? [send] : [];
  main.querySelectorAll = (selector) => {
    if (selector.includes("button")) return [send];
    if (selector.includes("data-message") || selector.includes("chat-message") || selector.includes("role=\"article\"")) return [user, assistant];
    return [];
  };
  const document = {
    activeElement: editor,
    documentElement: { setAttribute() {} },
    body: main,
    querySelectorAll(selector) {
      if (selector.includes("textarea") || selector.includes("contenteditable")) return [editor];
      if (selector === "button") return [send];
      return main.querySelectorAll(selector);
    },
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag) => element(tag),
    addEventListener() {},
  };
  return { document, main, form, editor, send, user, assistant };
}

(async () => {
  const f = fixture();
  global.document = f.document;
  global.location = { pathname: "/moonshotai/kimi-k3/playground", search: "" };
  global.window = {
    document: f.document,
    location: global.location,
    innerHeight: 900,
    HTMLTextAreaElement: undefined,
    HTMLInputElement: undefined,
  };
  const P = new Function(providerCode + "; return RSProvider;")();

  ok("provider id", P.id === "nvidia");
  ok("provider display name identifies Kimi K3", /NVIDIA NIM.*Kimi K3/.test(P.displayName));
  ok("provider supports vision", P.supportsVision === true);
  ok("provider uses compact deterministic bootstrap", P.compactCommandList === true && P.commandListMaxChars === 6000 && P.sysMaxChars === 12000 && P.forceBootstrapCatalogue === true && P.requireLiveEngineAtBootstrap === true);
  ok("Kimi commandless refusals and fake completions get one executable retry", P.shouldRetryCommandlessText("I can't directly access Roblox Studio, but I can explain the code") === true && P.shouldRetryCommandlessText("Done, I have built the map.") === true);
  ok("finds NVIDIA prompt textarea", P.getEditor() === f.editor);
  ok("reads assistant command", P.lastAssistant() === f.assistant && P.readAssistant().reply.includes("list_commands"));
  ok("counts user and assistant turns", P.userCount() === 1 && P.assistantCount() === 1);
  const thinkingNode = { textContent: JSON.stringify({ rid: "reason-1", text: "", thinking: "planning", done: false }) };
  f.document.getElementById = (id) => id === "rs-nvidia-net" ? thinkingNode : null;
  const thinkingRead = P.readAssistant();
  ok("exposes Kimi thinking before answer text", thinkingRead.present === true && thinkingRead.reply === "" && thinkingRead.thinking === "planning");
  thinkingNode.textContent = JSON.stringify({ rid: "native-1", text: "", thinking: "", done: true, nativeCalls: [{ index: 0, name: "list_commands", arguments: "{}" }] });
  const nativeRead = P.readAssistant();
  ok("converts Kimi native calls into catalogue-gated visible envelopes", /<tool_call>.*list_commands/.test(nativeRead.reply));
  f.document.getElementById = () => null;
  ok("composer is ready", (await P.ensureComposerReady("test")).ready === true);

  P.setInputLock(true);
  ok("locks textarea read-only", f.editor.getAttribute("readonly") !== null);
  P.setInputLock(false);
  ok("unlocks textarea", f.editor.getAttribute("readonly") === null);

  let clicks = 0;
  f.send.click = () => { clicks++; f.editor.value = ""; };
  await P.typeAndSend("bootstrap");
  ok("submits through Send exactly once", clicks === 1);

  const entries = manifest.content_scripts.filter((entry) => entry.matches.includes("https://build.nvidia.com/moonshotai/kimi-k3/*"));
  ok("manifest registers MAIN-world response tap", entries.some((entry) => entry.world === "MAIN" && entry.js.includes("src/providers/nvidia-net.js")));
  ok("manifest registers NVIDIA provider bundle", entries.some((entry) => entry.js.includes("src/providers/nvidia.js") && entry.js.includes("src/core/main.js")));
  ok("background tracks NVIDIA tabs", background.includes("https://build.nvidia.com/moonshotai/kimi-k3/*"));
  ok("popup recognizes NVIDIA playground", popup.includes("build.nvidia.com/moonshotai/kimi-k3"));
  ok("AI switcher lists Kimi K3 NVIDIA NIM", mainCode.includes("Kimi K3 · NVIDIA NIM"));
  ok("overlay has NVIDIA provider skin", css.includes("rs-prov-nvidia"));
  ok("network tap reads OpenAI SSE, native calls, XHR, and errors", netCode.includes("chat\\/completions") && netCode.includes("reasoning_content") && netCode.includes("nativeCalls") && netCode.includes("XMLHttpRequest") && netCode.includes("response.clone()"));

  // Exercise the MAIN-world tap against an OpenAI-compatible NIM SSE stream.
  let published = null;
  const tapDocument = {
    body: { appendChild(node) { published = node; } },
    documentElement: { appendChild(node) { published = node; } },
    getElementById(id) { return published && published.id === id ? published : null; },
    createElement() { return { id: "", type: "", textContent: "" }; },
  };
  const encoded = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"reasoning_content":"think ","content":"hello "}}]}\n'
    + 'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n'
    + 'data: [DONE]\n'
  );
  const clone = {
    headers: { get: () => "text/event-stream" },
    body: { getReader() { let read = false; return { async read() { if (read) return { done: true }; read = true; return { done: false, value: encoded }; } }; } },
  };
  let nextResponse = { clone: () => clone };
  const tapWindow = { fetch: async () => nextResponse };
  new Function("window", "document", "TextDecoder", netCode)(tapWindow, tapDocument, TextDecoder);
  await tapWindow.fetch("https://integrate.api.nvidia.com/v1/chat/completions");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const captured = published && JSON.parse(published.textContent || "null");
  ok("network tap reconstructs Kimi K3 content and reasoning", captured && captured.text === "hello world" && captured.thinking === "think " && captured.done === true);

  const nativeEncoded = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_","arguments":"{\\"query\\":"}}]}}]}\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"commands","arguments":"\\"ui\\"}"}}]},"finish_reason":"tool_calls"}]}\n'
    + 'data: [DONE]\n'
  );
  nextResponse = { clone: () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: { getReader() { let read = false; return { async read() { if (read) return { done: true }; read = true; return { done: false, value: nativeEncoded }; } }; } },
  }) };
  await tapWindow.fetch("https://integrate.api.nvidia.com/v1/chat/completions");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const nativeCaptured = published && JSON.parse(published.textContent || "null");
  ok("network tap preserves streamed native tool calls", nativeCaptured && nativeCaptured.done === true && nativeCaptured.nativeCalls[0].name === "list_commands" && nativeCaptured.nativeCalls[0].arguments === '{"query":"ui"}');

  nextResponse = { clone: () => ({ ok: false, status: 429, async text() { return "trial rate limit exceeded"; } }) };
  await tapWindow.fetch("https://integrate.api.nvidia.com/v1/chat/completions");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failedCapture = published && JSON.parse(published.textContent || "null");
  ok("network tap publishes NVIDIA HTTP failures", failedCapture && failedCapture.done === true && /429.*rate limit/i.test(failedCapture.error));

  process.exitCode = failures ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
