"use strict";
// GLM (chat.z.ai) provider wiring + 2.16 adapter regressions (run: node tests/test-glm.js).
// Behavioural checks run when jsdom is installed (cd TotalScript && npm i --no-save jsdom).
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const ok = (name, cond, extra) => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra !== undefined && !cond ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

const src = read("src/providers/glm.js");
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/providers/glm.js") && c.world !== "MAIN");
ok("manifest has a GLM bundle that loads the adapter before the core", !!bundle && bundle.js.indexOf("src/providers/glm.js") < bundle.js.indexOf("src/core/main.js"));
ok("adapter id / selectors documented live", src.includes('id: "glm"') && src.includes('editor: "#chat-input"') && src.includes('sendBtn: "#send-message-button"') && src.includes('assistantItem: ".chat-assistant"'));

// 2.16 regressions (static)
ok("camouflage shape covers the plain ###CMD opener (no chip-rebuild storm)", /###\\s\*cmd\\s/.test(src) && src.includes("###\\s*lua"));
ok("missing-composer verdict is debounced (4 s), not a one-poll turn killer", src.includes("_editorGoneAt") && src.includes("> 4000"));
ok("typeAndSend waits for a remounting textarea before giving up", src.includes("glm.editorWait") && src.includes("waitFor(() => !!getEditor(), 6000)"));
ok("send is verified once (textarea cleared / stop button) with a single bounded retry", src.includes("glm.send.retryOnce") && (src.match(/pressEnter\(\)/g) || []).length >= 2);
ok("stop button still excludes the svg scroll arrows", src.includes('!b.querySelector("svg")'));

let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
if (!JSDOM) { console.log("SKIP  behavioural checks (jsdom not installed)"); done(); }
else (async () => {
  const dom = new JSDOM(`<main><div class="w-full message-3f2a9c1e-11d2-4b77-9a0e-5d6c7b8a9f01"><div class="chat-assistant markdown-prose"><div class="flex flex-col w-full"><div class="markdown-prose"><p>Hello</p>
    <div class="relative rounded-xl border"><div><button class="copy-code-button">Copy</button></div><pre><code>###CMD part_create###\nname: X\n###END_CMD###</code></pre></div></div><div aria-hidden="true"></div></div></div></div>
    <div class="messageInputContainer"><div class="flex flex-col w-full rounded-xl"><textarea id="chat-input"></textarea><div><button class="bg-white rounded-full"><svg></svg></button><button id="send-message-button" disabled></button></div></div></div></main>`, { url: "https://chat.z.ai/c/abc", runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 }; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.parentElement; } });
  w.eval(src);
  const P = w.RSProvider;
  ok("turn id read from the message-<uuid> wrapper", P.lastAssistantId() === "3f2a9c1e-11d2-4b77-9a0e-5d6c7b8a9f01", P.lastAssistantId());
  ok("static page: the svg scroll arrow is not a stop button", !P.isHardGenerating());
  const item = P.lastAssistant();
  const spot = P.findToolBlockSpot(item);
  ok("plain ###CMD block wrapper is camouflaged and the turn masked", !!spot && spot.ref.classList.contains("rs-tool-hide") && /rounded-xl/.test(spot.ref.className) && item.classList.contains("rs-cmd-mask"));
  // scanError debounce: unmount the textarea, poll like the core does
  const ta = d.getElementById("chat-input"), holder = ta.parentElement;
  ta.remove();
  ok("first poll with the textarea gone is NOT an error", P.scanError() === null);
  await new Promise((r) => setTimeout(r, 1200));
  ok("still not an error after 1.2 s", P.scanError() === null);
  holder.insertBefore(ta, holder.firstChild);
  ok("composer back → clean slate", P.scanError() === null);
  // typeAndSend while the textarea is unmounted: waits for the remount, then sends
  ta.remove();
  setTimeout(() => { holder.insertBefore(ta, holder.firstChild); }, 800);
  const btn = d.getElementById("send-message-button");
  let clicks = 0; btn.addEventListener("click", () => { clicks++; ta.value = ""; });
  ta.addEventListener("input", () => { btn.disabled = !ta.value.trim(); });
  const t0 = Date.now();
  let threw = null; try { await P.typeAndSend("hello z.ai"); } catch (e) { threw = e; }
  ok("typeAndSend survived an 800 ms composer unmount and clicked send exactly once", !threw && clicks === 1 && Date.now() - t0 < 6000, threw ? String(threw) : clicks + " clicks");
  done();
})();

function done() {
  if (process.exitCode) { console.log("\nSome GLM checks failed."); process.exit(process.exitCode); }
  console.log("\nGLM provider checks passed.");
}
