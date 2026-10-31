// 1.99.1 — DeepSeek through the OFFICIAL API inside the extension.
// chat.deepseek.com suspends accounts for bot-like cadence even under gentle
// pacing (the risk score is cumulative); api.deepseek.com is a separate service
// with its own key and no such suspension. This pins the wiring:
//   codecraft.html?api=deepseek  → PROFILE "deepseek" in src/providers/codecraft.js
//   popup button · AI switcher entry · background allow-list · banner action
//   gentle defaults tightened (8–20 s, 30/h) + optional nudges gated.
// Run: cd TotalScript && node tests/test-deepseek-api.js
// Live behaviour (api.deepseek.com, real keys) is NOT covered here - see
// `API=deepseek node tests/codecraft-e2e.js` for the whole-bundle jsdom run.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("ok   " + n); } else { fail++; console.log("FAIL " + n + (x !== undefined ? " — " + String(x).slice(0, 300) : "")); } };

const cc = read("src/providers/codecraft.js");
const main = read("src/core/main.js");
const bg = read("background.js");
const popupJs = read("popup.js");
const popupHtml = read("popup.html");
const ds = read("src/providers/deepseek.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));

// ── profile table evaluated from source (no page needed) ───────────────────
const m = cc.match(/const PROFILES = \{[\s\S]*?\n  \};\n/);
ok("codecraft.js defines a PROFILES table", !!m);
let PROFILES = null;
try { PROFILES = vm.runInNewContext("(" + m[0].replace(/^const PROFILES = /, "").replace(/;\s*$/, "") + ")"); } catch (e) { ok("PROFILES parses standalone", false, e.message); }
if (PROFILES) {
  const c = PROFILES.codecraft, d = PROFILES.deepseek;
  ok("codecraft profile keeps the shipped constants (base, store key, default model, 15 fallbacks)", c.apiBase === "https://codecraftapi.com/v1" && c.storeKey === "rsCodeCraft" && c.defaultModel === "claude-opus-4.8" && c.fallbackModels.length === 15 && c.reasoningParam === true && c.modelLogos === true);
  ok("deepseek profile: official base + platform site", d.apiBase === "https://api.deepseek.com/v1" && d.site === "https://platform.deepseek.com" && d.hostLabel === "api.deepseek.com");
  ok("deepseek profile: separate storage namespace", d.storeKey === "rsDeepSeekApi" && d.storeKey !== c.storeKey);
  ok("deepseek profile: deepseek-chat default, deepseek-reasoner fallback", d.defaultModel === "deepseek-chat" && d.fallbackModels.join() === "deepseek-chat,deepseek-reasoner");
  ok("deepseek profile: sk- key shape, platform key/usage links", d.keyRe.test("sk-" + "a".repeat(32)) && !d.keyRe.test("cc_" + "a".repeat(32)) && d.keysUrl === "https://platform.deepseek.com/api_keys" && /platform\.deepseek\.com\/usage/.test(d.pricingUrl));
  ok("deepseek profile: no reasoning_effort, no model logos", d.reasoningParam === false && d.modelLogos === false);
  ok("deepseek profile: hero copy says why (suspensions) and what to do (key, Start)", /suspends/.test(d.heroText) && /platform\.deepseek\.com/.test(d.heroText) && /Start/.test(d.heroText));
  ok("codecraft key regex unchanged (cc_ + 16)", c.keyRe.test("cc_" + "a".repeat(16)) && !c.keyRe.test("sk-" + "a".repeat(32)));
}
ok("profile chosen from ?api=<id>, codecraft when absent/unknown", /new URLSearchParams\(location\.search\)\.get\("api"\); return PROFILES\[q\] \|\| PROFILES\.codecraft;/.test(cc));
ok("derived constants come from the profile (API_BASE/SITE/STORE_KEY/DEFAULT_MODEL/FALLBACK_MODELS)", /const API_BASE = PROFILE\.apiBase;\s*const SITE = PROFILE\.site;\s*const STORE_KEY = PROFILE\.storeKey;\s*const DEFAULT_MODEL = PROFILE\.defaultModel;\s*const FALLBACK_MODELS = PROFILE\.fallbackModels;/.test(cc));
ok("chat index / chat / usage keys derive from STORE_KEY (rsCodeCraftChats stays identical)", /const CHAT_INDEX_KEY = STORE_KEY \+ "Chats"/.test(cc) && /const CHAT_KEY_PREFIX = STORE_KEY \+ "Chat:"/.test(cc) && /const USAGE_KEY = STORE_KEY \+ "Usage"/.test(cc));
ok("contract id stays \"codecraft\" for every profile; displayName + profile exposed", /id: "codecraft",[^\n]*\n\s*profile: PROFILE\.id,\n\s*displayName: NAME,/.test(cc));
ok("reasoning_effort only sent when the profile supports it", /if \(settings\.reasoning && PROFILE\.reasoningParam\) body\.reasoning_effort = settings\.reasoning;/.test(cc));
ok("setReasoningMode is prompt-only on profiles without reasoning_effort (never switches the model)", /if \(!PROFILE\.reasoningParam\) return \{ ok: true, how: "prompt-only"/.test(cc));
ok("reasoning_content deltas (deepseek-reasoner) land in the thinking block", /const think = d\.reasoning_content \|\| d\.reasoning/.test(cc));
ok("model logo painter skipped when the profile has none", /if \(!m \|\| !PROFILE\.modelLogos\) \{ img\.hidden = true; return; \}/.test(cc));
ok("applyProfileUi rewrites title/brand/key placeholder/hero and tags <html data-rs-api-profile>", /function applyProfileUi\(\)/.test(cc) && /data-rs-api-profile/.test(cc) && /PROFILE\.keyPlaceholder/.test(cc) && /PROFILE\.heroTitle/.test(cc) && /applyProfileUi\(\);\s*await loadSettings\(\);/.test(cc));
ok("bootstrap detector no longer hard-codes the CodeCraft name", /const BOOTSTRAP_RE = \/API rules\|TotalScript\|list_commands\|command catalogue\/i;/.test(cc));
ok("promptExtra is per profile name (\"<name> rules: …\")", /promptExtra: NAME \+ " rules: /.test(cc));
ok("no leftover hard-coded CodeCraft wording in user-facing strings", !/"[^"\n]*(?:Paste your CodeCraft|CodeCraft rejected|Message CodeCraft|reaching codecraftapi\.com|CodeCraft API key missing|CodeCraft send refused)[^"\n]*"/.test(cc));
ok("test hooks export PROFILES + PROFILE", /CHAT_KEY_PREFIX, USAGE_KEY, PROFILES, PROFILE,/.test(cc));

// ── entry points ───────────────────────────────────────────────────────────
ok("AI switcher lists DeepSeek API on the same page with ?api=deepseek", /\{ name: "DeepSeek API", url: CODECRAFT_PAGE_URL \+ "\?api=deepseek", host: "api\.deepseek\.com · in TotalScript", extensionPage: "codecraft\.html\?api=deepseek" \}/.test(main));
ok("popup: DeepSeek API button + handler (reuses an open ?api=deepseek tab)", /id="deepseek-api"/.test(popupHtml) && /getElementById\("deepseek-api"\)\?\.addEventListener\("click"/.test(popupJs) && /CODECRAFT_PAGE_URL \+ "\?api=deepseek"/.test(popupJs) && /\/api=deepseek\/\.test\(String\(t\.url/.test(popupJs));
ok("popup: CodeCraft button no longer grabs the DeepSeek tab", /tabs = \(tabs \|\| \[\]\)\.filter\(\(t\) => !\/\[\?&\]api=\/\.test\(String\(t\.url \|\| ""\)\)\);/.test(popupJs));
ok("background allow-list admits codecraft.html with an optional ?api=<profile> only", /const pm = page\.match\(\/\^\(\[a-z\]\+\\\.html\)\(\?:\\\?api=\(\[a-z\]\+\)\)\?\$\/\);\s*if \(!pm \|\| pm\[1\] !== CODECRAFT_PAGE\)/.test(bg));
ok("background reuses the tab of the SAME profile", /filter\(\(t\) => \(pm\[2\] \? String\(t\.url \|\| ""\)\.includes\("api=" \+ pm\[2\]\) : !\/\[\?&\]api=\/\.test\(String\(t\.url \|\| ""\)\)\)\)/.test(bg));
{
  const re = /^([a-z]+\.html)(?:\?api=([a-z]+))?$/;
  ok("allow-list regex: accepts codecraft.html and codecraft.html?api=deepseek, rejects paths/other queries", re.test("codecraft.html") && re.test("codecraft.html?api=deepseek") && !re.test("../codecraft.html") && !re.test("codecraft.html?x=1") && !re.test("codecraft.html?api=deepseek&y=2") && re.exec("popup.html?api=deepseek")[1] !== "codecraft.html" /* other pages match the shape but fail the CODECRAFT_PAGE check */);
}
ok("api.deepseek.com is already covered by the shipped host permissions (<all_urls>) - no new permission", manifest.host_permissions.includes("<all_urls>") && !manifest.optional_host_permissions);

// ── gentle mode tightened + API route surfaced ─────────────────────────────
ok("deepseek.js pacing: 8–20 s gap, 30/hour (+ 1.99.5 breaks / day cap / checkpoint), apiPage + apiLabel", /pacing: \{ minGapMs: 8000, maxGapMs: 20000, perHour: 30, breakEvery: 6, breakMinMs: 45000, breakMaxMs: 120000, perDay: 160, checkpointEvery: 36, noResend: true, label: "DeepSeek gentle mode", apiPage: "codecraft\.html\?api=deepseek", apiLabel: "Open DeepSeek API chat"/.test(ds));
ok("banner() takes an optional action button (rs-banner-go)", /function banner\(kind, title, msg, action\)/.test(main) && /go\.className = "rs-banner-go"/.test(main) && /\.rs-banner-go \{/.test(css));
ok("apiPageAction opens P.pacing.apiPage through rs-open-extension-page", /function apiPageAction\(\)/.test(main) && /bg\(\{ type: "rs-open-extension-page", page \}\)/.test(main.slice(main.indexOf("function apiPageAction()"), main.indexOf("function apiPageAction()") + 600)));
ok("gentle notice + account_block banner carry the action", /Gentle pacing\.`, apiPageAction\(\)\);/.test(main) && /will not resend anything\. \$\{\(P\.pacing && P\.pacing\.apiHint\) \|\| ""\}`\.trim\(\), apiPageAction\(\)\);/.test(main));
ok("gentle notice says pacing lowers but cannot remove the risk", /lowers the risk but cannot remove it/.test(main));
ok("optional nudges gated by resendAllowed(): false-success, GUI brief, mode gate, reasoning gate", /if \(!falseSuccessNudged && resendAllowed\(\) && !A\.stop/.test(main) && /!A\.guiBrief\.nudged && resendAllowed\(\) && !A\.stop/.test(main) && /if \(modeGateRounds < MODE_GATE_ROUNDS && resendAllowed\(\) && !A\.stop && toolTurns >= 2\)/.test(main) && /if \(resendAllowed\(\) && !A\.stop && toolTurns >= 1 && typeof TotalReasoning !== "undefined"\)/.test(main));
ok("commandless retries capped at 1 on gentle providers", /const maxRefuse = resendAllowed\(\) \? Math\.max\(1, Math\.min\(3, Number\(P\.commandlessRetries\) \|\| 1\)\) : 1;/.test(main));

console.log(`test-deepseek-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
