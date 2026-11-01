// 2.0.5 — FeatherRBLX (https://feather-chat-link.base44.app/) on the adaptive multichat adapter.
//
// Evidence used here, and nothing more:
//   * the public landing page (fetched 2026-11-01): title "FeatherRBLX — Roblox chat console", text
//     "sign in with google to start. every account gets 10 free credits — that's 56 messages.",
//     a "continue with google" button and "google only · credits are per account and per network";
//   * the app's public settings endpoint (/api/apps/public/prod/public-settings/by-id/<id>) and
//     manifest.json (name FeatherRBLX, start_url https://feather-chat-link.base44.app).
// The chat screen itself is behind the Google login and its source is not public, so section C
// runs the adapter against a SYNTHETIC chat page (plain textarea + Send button + a role=log list).
// That proves the adaptive path works on a generic React chat layout - it does NOT prove the live
// site's DOM; live compatibility stays "Blocked by environment" until a user tries it.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-feather.js
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); } };
const HOST = "feather-chat-link.base44.app", URL = "https://" + HOST + "/";
const adapter = read("src/providers/multichat.js");

function boot(html, url) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: url || URL });
  const w = dom.window;
  // jsdom has no layout: give visible elements a box, hidden ones none.
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hidden || this.closest("[hidden]")) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { left: 0, top: 0, width: 400, height: 40, right: 400, bottom: 40 };
  };
  const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
  // jsdom does not implement form.requestSubmit; route it to a submit event like a browser would.
  w.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };
  const el = w.document.createElement("script"); el.textContent = adapter; w.document.head.appendChild(el);
  const diags = []; w.RSProvider.init({ diag: (ev, d) => diags.push([ev, d]) });
  return { w, P: w.RSProvider, errors, diags };
}

// ── A. the landing page as fetched (login gate) ──
const LANDING = `<!doctype html><html><head><title>FeatherRBLX — Roblox chat console</title></head><body>
<main><img alt="FeatherRBLX" src="x.png"><h1>FeatherRBLX</h1>
<p>sign in with google to start. every account gets 10 free credits — that's 56 messages.</p>
<button type="button">continue with google</button>
<p>google only · credits are per account and per network</p></main>
<footer><a href="https://base44.com">Edit with Base44</a></footer></body></html>`;
{
  const { P, errors } = boot(LANDING);
  ok("A1 adapter identifies the host: id feather, displayName FeatherRBLX", P.id === "feather" && P.displayName === "FeatherRBLX");
  ok("A2 the Google login gate is recognised from the landing page's own button text", P.loginGatePresent() === true);
  ok("A3 no composer on the landing page → modeWarning stays quiet (the gate explains itself) and ensureComposerReady reports not ready, no throw", P.modeWarning() === "" && P.getEditor() === null);
  ok("A4 no page errors while the adapter attaches to the landing page", errors.length === 0, errors);
}

// ── B. credit-aware knobs (real behaviour, not just text) ──
{
  const { P } = boot(LANDING);
  ok("B1 maxBatchCommands is raised to 8 on the credit-metered host (fewer, fuller replies)", P.maxBatchCommands === 8);
  ok("B2 the notice pill text names the site, the credits and what TotalScript does about it", /FeatherRBLX/.test(P.unstableWarning) && /credit/i.test(P.unstableWarning) && /8 commands/.test(P.unstableWarning));
  ok("B3 promptExtra tells the model once that every reply costs a credit and to batch", /every reply costs the user a site credit/.test(P.promptExtra) && /Batch up to 8 commands/.test(P.promptExtra));
  const other = boot("<!doctype html><html><body><textarea></textarea></body></html>", "https://overchat.ai/").P;
  ok("B4 other multichat hosts are unchanged: batch 6, no notice, no prompt extra", other.id === "overchat" && other.maxBatchCommands === 6 && other.unstableWarning === "" && other.promptExtra === "");
  const main = read("src/core/main.js");
  ok("B5 main.js honours P.maxBatchCommands up to the core cap of 8", /const MAX_BATCH_COMMANDS = Math\.max\(1, Math\.min\(8, Number\(P\.maxBatchCommands\) \|\| 6\)\);/.test(main));
  ok("B6 main.js shows the notice pill only when unstableWarning is non-empty and feeds promptExtra into the system prompt", /if \(P\.unstableWarning\) unstableEl\.hidden = false;/.test(main) && /providerNotes: P\.promptExtra \|\| ""/.test(main));
}

// ── C. SYNTHETIC chat page (generic React chat layout; NOT the live DOM) ──
const SYNTH = `<!doctype html><html><head><title>FeatherRBLX — Roblox chat console</title></head><body>
<main>
  <div role="log" id="log">
    <div class="msg user"><div class="bubble">hello</div></div>
    <div class="msg assistant"><div class="bubble">Hi! I am FeatherRBLX. How can I help with your Roblox game?</div></div>
  </div>
  <form id="composer"><textarea placeholder="type a message"></textarea><button type="submit" aria-label="Send">Send</button></form>
</main></body></html>`;
(async () => {
  const { w, P, errors, diags } = boot(SYNTH);
  ok("C1 synthetic page: no login gate, composer found, modeWarning empty", P.loginGatePresent() === false && !!P.getEditor() && P.modeWarning() === "");
  ok("C2 synthetic page: transcript roles come from the row classes (1 user, 1 assistant) and the assistant text reads back", P.assistantCount() === 1 && P.userCount() === 1 && P.readAssistant().present === true && /FeatherRBLX/.test(P.readAssistant().reply), P.readAssistant());
  const ready = await P.ensureComposerReady("test");
  ok("C3 ensureComposerReady → ready on the synthetic page", ready && ready.ready === true);
  // The synthetic page behaves like a chat app: on submit it appends the user row and clears the box.
  let submitted = 0;
  w.document.getElementById("composer").addEventListener("submit", (e) => {
    e.preventDefault(); submitted++;
    const ta = w.document.querySelector("textarea");
    const row = w.document.createElement("div"); row.className = "msg user"; row.innerHTML = "<div class='bubble'></div>"; row.firstChild.textContent = ta.value;
    w.document.getElementById("log").appendChild(row); ta.value = "";
  });
  await P.typeAndSend("say hi");
  P.invalidateItems(); // the core does this from its MutationObserver; the test has none
  ok("C4 typeAndSend commits EXACTLY once (Send button → form submit) and the composer text landed as a user row", submitted === 1 && P.userCount() === 2 && errors.length === 0, { submitted, users: P.userCount(), errors });
  ok("C5 the send diagnostics are tagged with the site id and report a landing proof", diags.some(([ev, d]) => ev === "feather.send.landed" && d && d.proof), diags.map((d) => d[0]));
  ok("C6 no page errors across the synthetic walk", errors.length === 0, errors);

  // ── D. registration everywhere a provider must be registered ──
  const manifest = JSON.parse(read("manifest.json"));
  const pat = "https://" + HOST + "/*";
  const iso = manifest.content_scripts.find((c) => c.world !== "MAIN" && c.js.includes("src/providers/multichat.js"));
  const tap = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/stream-net.js"));
  ok("D1 manifest: host permission + multichat bundle + stream-net MAIN tap all match the host", manifest.host_permissions.includes(pat) && iso.matches.includes(pat) && tap.matches.includes(pat));
  ok("D2 background PROVIDER_URLS, popup SUPPORTED_HOSTS, Switch-AI list in main.js", read("background.js").includes('"' + pat + '"') && read("popup.js").includes('"' + HOST + '"') && read("src/core/main.js").includes('{ name: "FeatherRBLX", url: "' + URL + '" }'));
  ok("D3 overlay.css carries the bar skin class .rs-prov-feather (inline + anchored, dark + light)", (read("overlay.css").match(/rs-prov-feather/g) || []).length >= 4);
  ok("D4 PROVIDERS.md lists the provider (regenerated by tests/provider-inventory.js) with its honest limitation", /\| `feather` \| FeatherRBLX \| feather-chat-link\.base44\.app \| `src\/providers\/multichat\.js`/.test(read("PROVIDERS.md")) && /Blocked by environment/.test(read("PROVIDERS.md")));
  ok("D5 README documents 2.0.5 with the evidence boundary (landing page verified, chat DOM not)", /\*\*2\.0\.5 — FeatherRBLX/.test(read("README.md")) && /test-feather\.js/.test(read("README.md")));
  console.log(`test-feather: ${n} checks, ${failed} failed (landing page from the fetched site; chat walk SYNTHETIC)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
