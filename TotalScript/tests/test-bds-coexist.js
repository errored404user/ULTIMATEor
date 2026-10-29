#!/usr/bin/env node
// 1.94.0 — DeepSeek adapter × Better DeepSeek (github.com/EdgeTypE/better-deepseek)
// coexistence. BDS v0.1.16 was audited from source; this test rebuilds the DOM
// footprint it leaves on chat.deepseek.com (every injected node carries a
// `bds-` class or sits under #bds-root — see its src/lib/composer-dom.js) and
// checks the adapter reads, drives and prompts correctly with it present:
//   - code-block banner buttons "Run Lua" / "Download" (dom/lua-injector.js) never
//     land inside the Luau the adapter reads;
//   - the sanitized overlay copy `.ds-markdown.bds-sanitized-text` inside
//     `.bds-host-wrapper` (ui/MessageOverlay.svelte) is not read twice;
//   - the DeepResearch chip (`.bds-deep-research-toggle.ds-toggle-button`, label
//     "DeepResearch") is not mistaken for DeepSeek's Search toggle;
//   - `.bds-loading-wrapper` (matches [class*='ds-loading']) is not "generating";
//   - the BDS drawer's textarea / primary buttons / "+" attach menu are ignored;
//   - promptExtra carries the BDS fence only when BDS is on the page.
// Without BDS nodes the adapter must behave exactly as before (control run).
"use strict";
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let JSDOM, installDomShims;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims } = require("./lib/e2e-page.js")); } catch (e) { console.log("test-bds-coexist: jsdom missing (npm i --no-save jsdom) - skipped"); process.exit(0); }

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : "")); } }

const LUAU = 'local p = Instance.new("Part")\np.Name = "Door"\np.Parent = workspace';
const CMD = "###LUA###\n" + LUAU + "\n###END_LUA###";

function page(withBds) {
  const bdsBanner = withBds ? '<button type="button" class="ds-atom-button ds-text-button bds-run-btn"><span><span class="code-info-button-text">Run Lua</span></span></button><button class="ds-atom-button bds-download-btn">Download</button>' : "";
  const assistant = `
    <div data-virtual-list-item-key="2"><div class="ds-message">
      <div class="ds-markdown"><p>Building the door.</p>
        <div class="md-code-block" ${withBds ? 'data-bds-lua-run-injected="1"' : ""}><div class="md-code-block-banner"><span>lua</span>${bdsBanner}<span>Copy</span></div><pre><code class="language-lua">${CMD.replace(/</g, "&lt;")}</code></pre></div>
        ${withBds ? '<div class="bds-loading-wrapper" data-rect="10,10,40,40"><img src="x"></div>' : ""}
      </div>
      ${withBds ? '<div class="bds-host-wrapper"><div class="bds-message-overlay"><div class="ds-markdown bds-sanitized-text"><p>Building the door.</p><pre><code>' + CMD.replace(/</g, "&lt;") + '</code></pre></div></div></div><div class="bds-message-price bds-price-assistant">$0.0004 · 120 tok</div>' : ""}
    </div></div>`;
  const composer = `
    <div id="composer" style="border-top-left-radius: 16px" data-rect="200,600,800,120">
      <textarea id="site-ta" data-rect="210,610,700,40"></textarea>
      <div role="radiogroup"><div role="radio" data-model-type="default" aria-checked="true">Instant</div><div role="radio" data-model-type="expert" aria-checked="false">Expert</div></div>
      <div class="ds-toggle-button" aria-pressed="false"><span>Search</span></div>
      ${withBds ? '<div class="bds-deep-research-mount"><div class="bds-deep-research-toggle f79352dc ds-toggle-button ds-toggle-button--m ds-toggle-button--selected" aria-pressed="true"><span class="_6dbc175 bds-chip-label">DeepResearch</span></div></div><button class="bds-attach-trigger" aria-label="+">+</button>' : ""}
      <div role="button" class="ds-button--primary" aria-label="Send" data-rect="900,660,36,36"><svg><path d="M8.31 2 L12 6"></path></svg></div>
    </div>`;
  const drawer = withBds ? '<div id="bds-root"><textarea id="bds-ta"></textarea><button class="ds-button--primary">Save</button><button class="ds-button">Continue</button><input type="file" webkitdirectory></div>' : "";
  return `<div class="chat"><div data-virtual-list-item-key="1"><div class="ds-message d29f3d7d"><div class="fbb737a4">make a door</div></div></div>${assistant}</div>${composer}${drawer}`;
}

function load(withBds) {
  const dom = new JSDOM(`<!doctype html><html><body>${page(withBds)}</body></html>`, { url: "https://chat.deepseek.com/a/chat/s/abc", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  installDomShims(w);
  w.__rsDiag = [];
  w.eval(read("src/core/parser.js") + ";window.RSParse = RSParse;");
  w.eval(read("src/providers/deepseek.js"));
  const P = w.RSProvider;
  P.init({ diag: (event, data) => w.__rsDiag.push({ event, data: data || null }) });
  return { w, d: w.document, P };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
// ── control run: no BDS ──────────────────────────────────────────────────────
{
  const { w, d, P } = load(false);
  const r = P.readAssistant();
  ok("control: reply read once, contains the envelope", r.present && r.reply.includes("###LUA###") && r.reply.split("###END_LUA###").length === 2, r.reply.slice(0, 120));
  ok("control: no coexist beacon, promptExtra has no BDS fence", !d.documentElement.hasAttribute("data-rs-ds-coexist") && !P.promptExtra.includes("Better DeepSeek") && P.promptExtra.includes("COMMAND FORMAT (hard rule)"));
  ok("control: editor is the site composer", P.getEditor() && P.getEditor().id === "site-ta");
  ok("control: Search toggle found and off", (() => { const s = P.enforceComposer(); return s.searchFound === true && s.searchOff === true; })());
  P.isGenerating(); await sleep(700); // let the stream-growth meter settle (first sample always counts as growth)
  ok("control: not generating", P.isGenerating() === false && P.isBusyNow() === false, P.genDebug());
  ok("control: no coexist diag event", !w.__rsDiag.some((e) => e.event === "coexist"));
}

// ── BDS on the page ──────────────────────────────────────────────────────────
{
  const { w, d, P } = load(true);
  ok("bds: detected at init (beacon + diag)", d.documentElement.getAttribute("data-rs-ds-coexist") === "bds" && w.__rsDiag.some((e) => e.event === "coexist" && e.data && e.data.ext === "better-deepseek"));
  const r = P.readAssistant();
  ok("bds: reply read ONCE (sanitized overlay copy ignored)", r.present && r.reply.split("###END_LUA###").length === 2 && r.reply.split("Building the door.").length === 2, r.reply);
  ok("bds: 'Run Lua' / 'Download' captions and the price badge never reach the reply text", !/Run Lua|Download|tok\b|\$0\.0004/.test(r.reply), r.reply);
  ok("bds: the Luau inside the envelope is byte-identical", r.reply.includes(LUAU));
  ok("bds: itemText / classifyText agree with readAssistant", P.itemText(P.lastAssistant()).trim() === r.reply && P.classifyText(P.lastAssistant()).trim() === r.reply);
  ok("bds: user turn still classified as user, assistant as assistant", P.userCount() === 1 && P.assistantCount() === 1);
  ok("bds: editor is the site composer, not the drawer textarea", P.getEditor() && P.getEditor().id === "site-ta");
  const st = P.enforceComposer();
  ok("bds: DeepResearch chip is NOT the Search toggle (real Search found, off)", st.searchFound === true && st.searchOff === true, st);
  ok("bds: enforceComposer never clicked the DeepResearch chip", d.querySelector(".bds-deep-research-toggle").getAttribute("aria-pressed") === "true");
  P.isGenerating(); await sleep(700);
  ok("bds: .bds-loading-wrapper is not a generation spinner", P.genDebug().spinner === false && P.isGenerating() === false && P.isBusyNow() === false, P.genDebug());
  ok("bds: drawer 'Continue' button is not DeepSeek's Continue", P.findContinueBtn() === null);
  ok("bds: snapshot / streamLen count only the native reply", P.snapshot().rp === P.itemText(P.lastAssistant()).length && P.streamLen() > 0 && P.streamLen() < 2 * P.snapshot().rp);
  ok("bds: promptExtra carries the BDS fence after the site rules", P.promptExtra.startsWith("- Templates:") && P.promptExtra.includes("Better DeepSeek is installed in this chat") && P.promptExtra.includes("never wrap Luau or a command in a <BDS:...> tag") && P.promptExtra.includes("<BDS:ask_question>"));
  ok("bds: fence is short (<= 900 chars) so the DeepSeek prompt budget is unaffected in practice", P.promptExtra.length - P.promptExtra.indexOf("- Better DeepSeek") <= 900);
  // Camouflage spot still resolves in the native container (the only one the adapter touches).
  const spot = P.findToolBlockSpot(P.lastAssistant(), null);
  ok("bds: tool-block spot found in the native markdown, not the overlay copy", spot && spot.parent && !spot.parent.closest(".bds-host-wrapper"));
}

// ── source pins ──────────────────────────────────────────────────────────────
{
  const src = read("src/providers/deepseek.js");
  ok("source: single foreign selector + helpers", src.includes("const FOREIGN_SEL = '#bds-root, [class*=\"bds-\"]';") && src.includes("function foreignActive()") && src.includes("function mdText(m)") && src.includes("const replyMds = (item) =>"));
  ok("source: no raw querySelectorAll(S.markdown).map(textContent) reader left", !/querySelectorAll\(S\.markdown\)\]\s*\.filter\(\(m\) => !m\.closest\(S\.thinking\)\)/.test(src));
  ok("source: file input picker skips BDS folder input + BDS attach menu", src.includes('!el.hasAttribute("webkitdirectory")') && src.includes("BDS's own \"+\" attach menu is not DeepSeek's"));
  ok("source: beacon string untouched (pinned by test-v112 / test-v115)", src.includes('"2026-09_flash41"'));
  const readme = read("README.md");
  ok("README documents the Better DeepSeek coexistence", /Better DeepSeek/.test(readme) && /test-bds-coexist\.js/.test(readme));
}

console.log(`\ntest-bds-coexist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("FAIL harness: " + (e && e.stack || e)); process.exit(1); });
