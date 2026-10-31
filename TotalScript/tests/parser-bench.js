// Provider-output parser benchmark (1.99.8). Runs tests/fixtures/provider_outputs.json
// through src/core/parser.js exactly the way the loop does and scores it:
//   mode "parse"     (default) RSParse.parseToolCalls(text)
//   mode "alternate" RSParse.parseAlternateToolCalls(text)  (native envelopes;
//                    main.js catalogue-gates these before anything runs)
//   mode "salvage"   RSParse.salvageCutOff(text) (generation ended, closers lost)
//   mode "injected"  the text is OUR feedback - isInjectedFeedback must be true
//                    (the loop never parses such a turn)
//   mode "contract"  parseToolCalls + TotalCommandContract.prepare (what
//                    runTool applies before dispatch - e.g. fence stripping)
// A case passes when the parsed tool names match `expect` in order and every
// `args` key given is deep-equal. Negatives (tag "negative") expect [].
// Floors are the release contract: overall >= 0.98, negatives == 1.0,
// every tagged provider family >= 0.9. Baseline before 1.99.8: 50/60 probe
// (comments, Python literals, params-first, flat params, raw quotes in code,
// heading markers, entity-escaped Lua all failed). Not shipped to the browser.
"use strict";
const fs = require("fs");
const path = require("path");
const RSParse = new Function(fs.readFileSync(path.join(__dirname, "../src/core/parser.js"), "utf8") + "; return RSParse;")();
// The contract reads the real skill packs (parameter schemas), loaded the same
// way test-command-contract.js does.
const vm = require("vm");
global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
const Contract = require(path.join(__dirname, "../src/core/command_contract.js"));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/provider_outputs.json"), "utf8"));

const FLOORS = { overall: 0.98, negative: 1.0, perTag: 0.9 };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function run(c) {
  let calls = [];
  const mode = c.mode || "parse";
  try {
    if (mode === "parse") calls = RSParse.parseToolCalls(c.text);
    else if (mode === "alternate") calls = RSParse.parseAlternateToolCalls(c.text);
    else if (mode === "salvage") { const s = RSParse.salvageCutOff(c.text); calls = s ? [s] : []; }
    else if (mode === "injected") {
      // Our own feedback is recognised BEFORE any parsing in the loop; the
      // quoted example inside it must therefore never be reachable.
      return RSParse.isInjectedFeedback(c.text) ? { ok: true } : { ok: false, why: "not recognised as injected feedback" };
    } else if (mode === "contract") {
      // parse, then TotalCommandContract.prepare - what runTool does before dispatch.
      calls = RSParse.parseToolCalls(c.text).map((x) => ({ tool: x.tool, arguments: Contract.prepare(x.tool, x.arguments).args }));
    } else return { ok: false, why: "unknown mode " + mode };
  } catch (e) { return { ok: false, why: "threw " + e.message }; }
  const got = calls.map((x) => x.tool);
  const want = c.expect.map((x) => x.tool);
  if (!deepEq(got, want)) return { ok: false, why: "tools " + JSON.stringify(got) + " != " + JSON.stringify(want) };
  for (let i = 0; i < c.expect.length; i++) {
    const args = c.expect[i].args || {};
    for (const k of Object.keys(args)) {
      if (!deepEq(calls[i].arguments[k], args[k])) return { ok: false, why: `call ${i + 1} ${k}=${JSON.stringify(calls[i].arguments[k])} != ${JSON.stringify(args[k])}` };
    }
  }
  return { ok: true };
}

const byTag = {};
let pass = 0;
const fails = [];
for (const c of corpus.cases) {
  const r = run(c);
  const t = byTag[c.tag] || (byTag[c.tag] = { pass: 0, total: 0 });
  t.total++;
  if (r.ok) { pass++; t.pass++; } else fails.push(`${c.id} [${c.tag}] — ${r.why}`);
}
const total = corpus.cases.length;
const ratio = pass / total;
console.log(`parser-bench: ${pass}/${total} (${(ratio * 100).toFixed(1)}%)`);
for (const tag of Object.keys(byTag).sort()) {
  const t = byTag[tag];
  console.log(`  ${tag.padEnd(12)} ${t.pass}/${t.total}`);
}
for (const f of fails) console.log("MISS  " + f);

let bad = 0;
const floor = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  floor: " + name); if (!cond) bad++; };
floor(`overall >= ${FLOORS.overall}`, ratio >= FLOORS.overall);
floor("negatives never execute (1.0)", byTag.negative && byTag.negative.pass === byTag.negative.total);
for (const tag of Object.keys(byTag).sort()) {
  if (tag === "negative") continue;
  const t = byTag[tag];
  floor(`${tag} >= ${FLOORS.perTag}`, t.pass / t.total >= FLOORS.perTag);
}
floor("corpus has at least 80 cases and 6 negatives", total >= 80 && byTag.negative && byTag.negative.total >= 6);
// The corpus must keep exercising every protocol surface.
const ids = new Set(corpus.cases.map((c) => c.id));
for (const must of ["lua-plain", "cmd-plain", "cmd-heredoc", "fence-json", "dsml-invoke", "salvage-one-closer", "neg-bare-lua-fence"]) floor("case present: " + must, ids.has(must));
if (bad) process.exitCode = 1;
console.log(bad ? `${bad} floor(s) FAILED` : "ALL FLOORS PASS (pure string parsing — no AI site or Studio involved)");
