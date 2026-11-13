"use strict";
// Google AI Studio website-provider wiring + offline DOM checks.
// These tests exercise a synthetic AI Studio-shaped page; they do not contact
// Google, load a model, verify a live prompt, or claim a Studio tool executed.
// Run from the TotalScript root: node tests/test-aistudio.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const HOST = "aistudio.google.com";
let pass = 0, fail = 0;
function ok(name, condition, extra) {
  if (condition) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FAIL " + name + (extra === undefined ? "" : " — " + String(extra && extra.message || extra).slice(0, 240))); }
}

const manifest = JSON.parse(read("manifest.json"));
const bg = read("background.js"), popup = read("popup.js"), main = read("src/core/main.js");
const css = read("overlay.css"), adapter = read("src/providers/aistudio.js"), readme = read("README.md");
const bundles = manifest.content_scripts.filter((entry) => entry.matches.includes(`https://${HOST}/*`) && entry.js.includes("src/core/main.js"));
ok("manifest injects exactly one isolated provider bundle on aistudio.google.com", bundles.length === 1, bundles.length);
const bundle = bundles[0];
ok("AI Studio adapter loads before the shared core", !!bundle && bundle.js.indexOf("src/providers/aistudio.js") >= 0 && bundle.js.indexOf("src/providers/aistudio.js") < bundle.js.indexOf("src/core/main.js"));
ok("background status broadcasts include the AI Studio origin", bg.includes(`"https://${HOST}/*"`));
ok("popup recognizes AI Studio tabs and labels them clearly", popup.includes(`"${HOST}"`) && popup.includes(`"${HOST}": "Google AI Studio"`));
ok("popup default-site picker opens a new AI Studio prompt", popup.includes(`"Google AI Studio", "https://aistudio.google.com/prompts/new_chat", "${HOST}"`));
ok("in-page Switch-AI list includes AI Studio", main.includes(`{ name: "Google AI Studio", url: "https://aistudio.google.com/prompts/new_chat" }`));
ok("provider skin covers inline, anchored and light-mode bars", ["#rs-bar.rs-prov-aistudio", "rs-bar-inline.rs-prov-aistudio", "rs-bar-anchored.rs-prov-aistudio", "html.rs-light #rs-bar.rs-bar-inline.rs-prov-aistudio", "html.rs-light #rs-bar.rs-bar-anchored.rs-prov-aistudio"].every((needle) => css.includes(needle)));
ok("AI Studio command camouflage covers stable turn and rendered-body roots", css.includes(".chat-turn-container.model.rs-cmd-mask ms-code-block") && css.includes(".model-prompt-container.rs-cmd-mask ms-code-block"));
ok("README documents visible-UI scope, unsupported images and unverified live status", readme.includes("Google AI Studio website adapter") && readme.includes("Image attachment is intentionally disabled") && readme.includes("has **not** been verified"));
ok("adapter does not fetch APIs or hook network transports", !/(?:\bfetch\s*\(|XMLHttpRequest|WebSocket)/.test(adapter));

let JSDOM = null, installDomShims = null;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims } = require("./lib/e2e-page.js")); } catch {}
if (!JSDOM) {
  console.log("(jsdom missing - DOM checks skipped; provider-contract and inventory tests still cover registration/types)");
} else {
  const html = `<!doctype html><html><body>
    <main>
      <div id="thread">
        <ms-chat-turn id="user-turn"><div class="chat-turn-container user"><div class="user-prompt-container"><ms-prompt-chunk>Kapı_Çerçevesi oluştur. Türkçe metin korunmalı.</ms-prompt-chunk></div></div></ms-chat-turn>
        <ms-chat-turn id="assistant-turn"><div class="chat-turn-container model">
          <div class="model-prompt-container">
            <ms-prompt-chunk><ms-cmark-node class="cmark-node">Başlıyorum.</ms-cmark-node>
              <ms-thought-accordion><ms-thought-chunk>###CMD part_create### hidden reasoning</ms-thought-chunk></ms-thought-accordion>
            </ms-prompt-chunk>
            <ms-code-block><pre><code>###CMD part_create###\nname: Kapı_Çerçevesi\n###END_CMD###</code></pre></ms-code-block>
            <pre><code>ordinary example code should remain distinct</code></pre>
          </div>
        </div></ms-chat-turn>
      </div>
      <form id="composer"><ms-prompt-input-wrapper>
        <ms-autosize-textarea><textarea id="ed" class="textarea" aria-label="Enter a prompt"></textarea></ms-autosize-textarea>
        <ms-run-button><button id="run" type="submit" aria-label="Run"></button></ms-run-button>
      </ms-prompt-input-wrapper></form>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: `https://${HOST}/prompts/new_chat`, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  installDomShims(w);
  w.__rsDiag = [];
  w.eval(adapter);
  const P = w.RSProvider;
  try { P.init({ diag: (event, data) => w.__rsDiag.push({ event, data: data || null }) }); }
  catch (error) { ok("provider init does not throw", false, error); }

  ok("adapter exports the Google AI Studio identity and disables unsupported vision", P && P.id === "aistudio" && P.displayName === "Google AI Studio" && P.supportsVision === false);
  ok("semantic turn selectors find one user and one assistant turn", P.userCount() === 1 && P.assistantCount() === 1 && P.allItems().length === 2);
  const user = P.allItems().find((item) => P.isUserItem(item));
  const assistant = P.lastAssistant();
  ok("turn classification preserves Turkish text", P.itemText(user).includes("Kapı_Çerçevesi") && P.classifyText(user).includes("Türkçe"));
  const reply = P.readAssistant();
  ok("assistant text is read while thought/reasoning text is excluded", reply.present && reply.reply.includes("Başlıyorum") && !reply.reply.includes("hidden reasoning") && reply.thinking.includes("hidden reasoning"));
  ok("new_chat route is transient and the visible prompt box is discoverable", P.conversationKey() === "" && P.getEditor() === d.getElementById("ed") && P.chatIsEmpty() === false);
  w.history.pushState({}, "", "/prompts/prompt-abc123");
  ok("existing /prompts/<id> route gets a stable conversation key", P.conversationKey() === "prompt-abc123");
  ok("prompt page has no Gemini API-key setup or unsupported image claim", P.modeWarning() == null && typeof P.attachImages === "function" && P.supportsVision === false);

  const spot = P.findToolBlockSpot(assistant);
  const commandBlock = d.querySelector("ms-code-block");
  const ordinaryPre = d.querySelector(".model-prompt-container > pre");
  ok("###CMD output is camouflaged at its AI Studio code-block wrapper", !!spot && commandBlock.classList.contains("rs-tool-hide") && assistant.classList.contains("rs-cmd-mask"));
  ok("ordinary prose code remains unmarked by command detection", !ordinaryPre.classList.contains("rs-tool-hide"));

  const editor = d.getElementById("ed"), form = d.getElementById("composer");
  let submitCount = 0, captured = "";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCount++;
    captured = editor.value;
    editor.value = "";
    const turn = d.createElement("ms-chat-turn");
    const row = d.createElement("div"); row.className = "chat-turn-container user";
    const chunk = d.createElement("ms-prompt-chunk"); chunk.textContent = captured;
    row.appendChild(chunk); turn.appendChild(row); d.getElementById("thread").appendChild(turn);
  });
  const prompt = "Part oluştur: Kapı_Çerçevesi\nBoyut: 4, 6, 1\nUse Turkish text: ışık, çerçeve.";
  (async () => {
    try {
      P.setInputLock(true);
      const sent = await P.typeAndSend(prompt);
      ok("textarea send commits exactly once and preserves multiline Turkish text", sent === true && submitCount === 1 && captured === prompt);
      ok("input lock is restored after the adapter sends", editor.readOnly === true);
      P.setInputLock(false);
      ok("input lock restores the original editable state", editor.readOnly === false);
      const before = submitCount;
      let imageRejected = false;
      try { await P.typeAndSend("text", [{ mimeType: "image/png", data: "AA==" }]); }
      catch (error) { imageRejected = /image attachment is not supported/.test(String(error && error.message)); }
      ok("unsupported images are rejected explicitly, not silently sent without the image", imageRejected && submitCount === before);
      ok("diagnostics contain no submitted prompt text", !JSON.stringify(w.__rsDiag).includes(prompt));

      const noComposerDom = new JSDOM("<!doctype html><html><body><main></main></body></html>", { url: `https://${HOST}/prompts/new_chat`, runScripts: "outside-only" });
      const noW = noComposerDom.window;
      installDomShims(noW); noW.eval(adapter);
      ok("missing prompt editor returns a setup warning instead of a connected claim", !noW.RSProvider.getEditor() && /open a prompt workspace/.test(noW.RSProvider.modeWarning()));
      noComposerDom.window.close();
    } catch (error) {
      ok("synthetic AI Studio composer flow completes", false, error);
    } finally {
      dom.window.close();
      console.log(`\ntest-aistudio: ${pass} passed, ${fail} failed (static + mocked DOM; no live Google or Studio)`);
      process.exit(fail ? 1 : 0);
    }
  })();
}
if (!JSDOM) {
  console.log(`\ntest-aistudio: ${pass} passed, ${fail} failed (static; jsdom unavailable)`);
  process.exit(fail ? 1 : 0);
}
