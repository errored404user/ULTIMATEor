// SPDX-License-Identifier: GPL-3.0-or-later
// tests/test-provider-boost.js — Comprehensive verification for TotalScript 4.0
// Provider Boost: parser schema fixes, salvageCutOff reachability, TotalProviderBoost
// engine (profiles, lazy-reply rescue, craft riders, live scoring/rankings), all 12
// provider adapters, manifest/codecraft wiring, and UI/CSS placement.
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
}

const RSParse = new Function(read("src/core/parser.js") + "; return RSParse;")();
const PBoost = require(path.join(ROOT, "src/core/provider_boost.js"));
const mainSrc = read("src/core/main.js");
const cssSrc = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const codecraftHtml = read("codecraft.html");

// ── 1. Layer 1: Universal Tool-Call JSON Parsing & Salvage Fixes ────────────
{
  // Claude Anthropic {"tool":"...","input":{...}} no longer drops arguments!
  const claudeCall = RSParse.parseToolCalls('```json\n{"tool":"script_create","input":{"path":"ServerScriptService.Game","source":"print(1)"}}\n```');
  ok("1. Claude {tool, input} preserves full input arguments",
    claudeCall.length === 1 && claudeCall[0].tool === "script_create" &&
    claudeCall[0].arguments.path === "ServerScriptService.Game" && claudeCall[0].arguments.source === "print(1)",
    claudeCall);

  // Gemini/OpenAI {"command":"...","parameters":{...}} unwraps parameters cleanly!
  const gemCall = RSParse.parseToolCalls('{"command":"script_create","parameters":{"path":"ServerScriptService.Shop","source":"return 1"}}');
  ok("2. Gemini/OpenAI {command, parameters} unwraps parameters cleanly",
    gemCall.length === 1 && gemCall[0].tool === "script_create" &&
    gemCall[0].arguments.path === "ServerScriptService.Shop" && !gemCall[0].arguments.parameters,
    gemCall);

  // {"tool_name":"...","parameters":{...}} works natively + streaming + salvage
  const tnText = '{"tool_name":"inspect_instance","parameters":{"path":"game.Workspace"}}';
  const tnCall = RSParse.parseToolCalls(tnText);
  const tnCut = RSParse.salvageCutOff('{"tool_name":"inspect_instance","parameters":{"path":"game.Workspace"}');
  ok("3. {tool_name, parameters} parses, labels stream chip, detects open block & salvages cut-off",
    tnCall.length === 1 && tnCall[0].tool === "inspect_instance" && tnCall[0].arguments.path === "game.Workspace" &&
    RSParse.CMD_KEY_RE.test(tnText) &&
    RSParse.toolNameFromText('{"tool_name":"inspect_ins') === "inspect_ins" &&
    RSParse.hasOpenToolBlock('{"tool_name":"inspect_instance","parameters":{"path":"game.Workspace"}') === true &&
    tnCut && tnCut.tool === "inspect_instance" && tnCut.arguments.path === "game.Workspace",
    { tnCall, tnCut });

  // ReAct {action, action_input} parses in alternate tool calls
  const reactCall = RSParse.parseAlternateToolCalls('{"action":"script_read","action_input":{"path":"ServerScriptService.Main"}}');
  ok("4. ReAct {action, action_input} parses cleanly via parseAlternateToolCalls",
    reactCall.length === 1 && reactCall[0].tool === "script_read" && reactCall[0].arguments.path === "ServerScriptService.Main",
    reactCall);

  // Nested OpenAI {function:{name, arguments}} works in normalizeCall
  const nested = RSParse.normalizeCall({ type: "function", function: { name: "get_studio_state", arguments: '{"verbose":true}' } });
  ok("5. Nested OpenAI {function:{name,arguments}} normalizes cleanly",
    nested && nested.tool === "get_studio_state" && nested.arguments.verbose === true,
    nested);

  // False-positive guard: data object {"name":"Crate","size":[4,4,4]} is NEVER a command
  ok("6. Plain data object {name, size} is never misread as a tool call",
    RSParse.normalizeCall({ name: "Crate", size: [4, 4, 4] }) === null &&
    RSParse.parseToolCalls('{"name":"Crate","size":[4,4,4]}').length === 0 &&
    RSParse.parseAlternateToolCalls('{"name":"Crate","size":[4,4,4]}').length === 0);

  // main.js salvageCutOff reachability fix: hasOpenToolBlock precedes malformed branch!
  const openIdx = mainSrc.indexOf("if (RSParse.hasOpenToolBlock(r)) {");
  const malIdx = mainSrc.indexOf('return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };');
  ok("7. main.js runs salvageCutOff / hasOpenToolBlock BEFORE generic malformed return",
    openIdx > 0 && malIdx > openIdx && mainSrc.includes('.filter((call) => knownTool(call.tool))'));
}

// ── 2. Layer 2: TotalProviderBoost Core Engine ──────────────────────────────
{
  const ALL_12 = ["chatgpt", "claude", "gemini", "deepseek", "qwen", "glm", "kimi", "arena", "aistudio", "vani", "huggingchat", "codecraft"];
  ok("8. TotalProviderBoost defines tailored profiles for all 12 providers",
    PBoost.VERSION === "4.0.0" && ALL_12.every((id) => PBoost.PROFILES[id] && PBoost.PROFILES[id].rules && PBoost.PROFILES[id].tightRules && PBoost.PROFILES[id].ultraRules));

  const forbidden = /must be JSON|JSON only|only JSON/i;
  let boostClean = true;
  for (const id of ALL_12) {
    for (const level of PBoost.LEVELS) {
      const b = PBoost.promptBoost(id, { level, tight: false, plain: id === "vani" });
      if (!b || forbidden.test(b)) boostClean = false;
      if (id === "vani" && /\{"command"/.test(b)) boostClean = false;
    }
  }
  const tightBoost = PBoost.promptBoost("chatgpt", { level: "pro", tight: true });
  const fullBoost = PBoost.promptBoost("chatgpt", { level: "ultra", tight: false });
  ok("9. promptBoost respects all levels, tight budget, plain-text mode, and parity rules (no 'JSON only')",
    boostClean && tightBoost.length < fullBoost.length && tightBoost.length <= 360 && fullBoost.includes("ULTRA"));

  // Lazy-reply detector catches all 4 bad patterns
  const mutTask = { mutates: true, explainOnly: false, primary: "gameplay", intent: "implement" };
  const sim = PBoost.detectLazyReply("Output of 'execute_luau':\nCreated sword successfully!", { task: mutTask, toolTurns: 0, planMode: false });
  const tut = PBoost.detectLazyReply("Here's how to build a shop GUI in Roblox Studio:\nStep 1: Open Roblox Studio and insert a ScreenGui.", { task: mutTask, toolTurns: 0, planMode: false });
  const prom = PBoost.detectLazyReply("Sure! I'll start by inspecting your Workspace and creating the shop system right now.", { task: mutTask, toolTurns: 0, planMode: false });
  const perm = PBoost.detectLazyReply("I've mapped out the shop modules and remotes. Would you like me to proceed?", { task: mutTask, toolTurns: 0, planMode: false });
  const planWall = PBoost.detectLazyReply("## Implementation Plan\n\n1. Create ServerScriptService.ShopServer with DataStore persistence and RemoteEvents.\n2. Build StarterGui.ShopGui with UIGradient styling and TweenService hover animations.\n3. Wire inventory syncing and sound effects across client and server.", { task: mutTask, toolTurns: 0, planMode: false });
  ok("10. detectLazyReply catches simulated output, DIY tutorials, promises, permission stalls & unrequested plan walls",
    sim && sim.kind === "simulated_output" &&
    tut && tut.kind === "tutorial" &&
    prom && prom.kind === "promise" &&
    perm && perm.kind === "promise" &&
    planWall && planWall.kind === "unrequested_plan",
    { sim, tut, prom, perm, planWall });

  // Lazy-reply detector false-positive safety
  const realQ = PBoost.detectLazyReply("What art style should the lobby use — futuristic sci-fi or medieval fantasy?", { task: mutTask, toolTurns: 0, planMode: false });
  const inPlan = PBoost.detectLazyReply("## Implementation Plan\n1. Build server\n2. Build client\n3. Verify everything in playtest mode cleanly.", { task: mutTask, toolTurns: 0, planMode: true });
  const explain = PBoost.detectLazyReply("Here's how to use RemoteEvents in Roblox Studio: Step 1: Insert a RemoteEvent.", { task: { mutates: false, explainOnly: true }, toolTurns: 0, planMode: false });
  const afterTools = PBoost.detectLazyReply("Sure! I'll start by checking that next.", { task: mutTask, toolTurns: 2, planMode: false });
  const hasCmd = PBoost.detectLazyReply("I'll start by checking Studio:\n```json\n{\"command\":\"get_studio_state\",\"params\":{}}\n```", { task: mutTask, toolTurns: 0, planMode: false });
  ok("11. detectLazyReply NEVER false-positives on genuine questions, Plan Mode, explainOnly, post-tool replies, or command replies",
    realQ === null && inPlan === null && explain === null && afterTools === null && hasCmd === null,
    { realQ, inPlan, explain, afterTools, hasCmd });

  // 2-stage rescue prompt (plain vs JSON, Blender vs Roblox)
  const r1 = PBoost.rescuePrompt("gemini", "tutorial", { round: 1, plain: false, engine: "roblox" });
  const r2 = PBoost.rescuePrompt("gemini", "tutorial", { round: 2, plain: false, engine: "roblox" });
  const rPlain = PBoost.rescuePrompt("vani", "promise", { round: 2, plain: true, mode: "blender" });
  ok("12. rescuePrompt escalates stage 1 -> stage 2 and adapts to plain-text & Blender mode",
    r1 !== r2 && r2.includes("get_studio_state") && rPlain.includes("###CMD get_scene_info###") && !rPlain.includes("```"));

  // Domain craft riders
  const cStd = PBoost.craftRider("gemini", mutTask, "creation", "standard");
  const cExp = PBoost.craftRider("gemini", { explainOnly: true }, "creation", "ultra");
  const cGui = PBoost.craftRider("claude", { primary: "gui" }, "creation", "pro");
  const cBlend = PBoost.craftRider("glm", mutTask, "blender", "ultra");
  const cTight = PBoost.craftRider("chatgpt", mutTask, "creation", "pro", { tight: true });
  ok("13. craftRider returns empty for standard/explainOnly and tailored AAA craft bars for pro/ultra domains",
    cStd === "" && cExp === "" &&
    /UICorner|TweenService/.test(cGui) &&
    /Principled BSDF|manifold/.test(cBlend) &&
    cTight.length > 0 && cTight.length < 240);

  // Scoring & Rankings
  const sEmpty = PBoost.scoreProvider({});
  const sHigh = PBoost.scoreProvider({ turns: 10, toolCalls: 12, toolOk: 12, parseErrors: 0, rescues: 0, providerErrors: 0, avgMs: 4500 });
  const sLow = PBoost.scoreProvider({ turns: 6, toolCalls: 4, toolOk: 1, parseErrors: 3, rescues: 4, providerErrors: 2, avgMs: 42000 });
  const ranked = PBoost.rankProviders({ claude: { turns: 10, toolCalls: 12, toolOk: 12, parseErrors: 0, rescues: 0, providerErrors: 0, avgMs: 4500 }, glm: { turns: 6, toolCalls: 4, toolOk: 1, parseErrors: 3, rescues: 4, providerErrors: 2, avgMs: 42000 } });
  ok("14. scoreProvider & rankProviders compute accurate 0-100 scores, S/A/B/C/D grades & best-first order",
    sEmpty.score === null && sEmpty.grade === "—" &&
    sHigh.score >= 95 && sHigh.grade === "S" &&
    sLow.score < 55 && sLow.grade === "D" &&
    ranked.length >= 12 && ranked[0].id === "claude" && ranked[1].id === "glm",
    { sHigh, sLow, top2: ranked.slice(0, 2) });
}

// ── 3. Layer 3: All 12 Provider Adapters Upgraded ───────────────────────────
{
  const ADAPTERS = ["aistudio", "arena", "chatgpt", "claude", "codecraft", "deepseek", "gemini", "glm", "kimi", "multichat", "qwen", "vani"];
  const LONG_SESSION_WEB = ["aistudio", "arena", "chatgpt", "claude", "gemini", "glm", "kimi", "multichat", "qwen"];
  const bad = [];
  for (const id of ADAPTERS) {
    const src = read(`src/providers/${id}.js`);
    if (!/promptExtra/.test(src)) bad.push(id + ":no-promptExtra");
    if (!/commandlessRetries:\s*2/.test(src)) bad.push(id + ":no-retries2");
    if (/must be JSON|JSON only|only JSON/i.test(src.slice(src.lastIndexOf("promptExtra")))) bad.push(id + ":json-only");
    if (LONG_SESSION_WEB.includes(id) && !/resendSystemEvery/.test(src)) bad.push(id + ":no-resendSystemEvery");
  }
  ok("15. All 12 provider adapters carry promptExtra + commandlessRetries:2 (+ resendSystemEvery on all 9 web chats)",
    bad.length === 0, bad);
}

// ── 4. Layer 4: Manifest, codecraft.html, main.js & overlay.css Wiring ──────
{
  const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
  ok("16. manifest.json & codecraft.html load src/core/provider_boost.js in every bundle before main.js",
    bundles.length === 11 &&
    bundles.every((b) => b.js.includes("src/core/provider_boost.js") && b.js.indexOf("src/core/provider_boost.js") < b.js.indexOf("src/core/main.js")) &&
    codecraftHtml.includes('<script src="src/core/provider_boost.js"></script>'));

  ok("17. main.js wires PBOOST, lazyRescue, craftRider, live telemetry, Providers tab & Boost pill",
    mainSrc.includes("const PBOOST =") &&
    mainSrc.includes("loop.lazyRescue") &&
    mainSrc.includes("providerBoost.craftRiderSent") &&
    mainSrc.includes("recordProviderStat(") &&
    mainSrc.includes('["providers", "🏆 Providers"]') &&
    mainSrc.includes('data-v4-act="boost-cycle"') &&
    mainSrc.includes('id: "v4-providers"'));

  const boostCssIdx = cssSrc.indexOf(".rs-boost-pill {");
  const block212Idx = cssSrc.indexOf("/* ═══ 2.12.0");
  ok("18. overlay.css places Provider Boost styles strictly BEFORE /* ═══ 2.12.0",
    boostCssIdx > 0 && block212Idx > boostCssIdx && cssSrc.includes(".rs-prov-hero {") && cssSrc.includes(".rs-boost-seg {"));
}

console.log(`\ntest-provider-boost: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
