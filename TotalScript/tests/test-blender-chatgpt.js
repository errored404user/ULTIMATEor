#!/usr/bin/env node
// Blender connectivity through ChatGPT's shared tool path. Mocked only: no
// browser, ChatGPT account, total-core process, or Blender installation needed.
// Run from the TotalScript root:
//   node tests/test-blender-chatgpt.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const main = read("src/core/main.js");
const background = read("background.js");
const chatgpt = read("src/providers/chatgpt.js");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};
function sliceBetween(source, start, end, label) {
  const i = source.indexOf(start);
  const j = i < 0 ? -1 : source.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error("could not extract " + label + " (" + start + ")");
  return source.slice(i, j);
}
const bareToolName = (name) => String(name || "").split("/").pop().split(".").pop();

// Exercise the actual worker connection function, with only its OS / addon
// dependencies replaced. In particular, a successful TCP connect is not a
// successful Blender link until get_scene_info itself succeeds.
const connectSrc = sliceBetween(background, "async function connectBlender() {", "\n\n// ── Blockbench", "connectBlender");
const makeConnectBlender = new Function(
  "probeBlenderTcp", "setBlender", "blenderCall", "broadcastStatus",
  connectSrc + "\nreturn connectBlender;"
);
async function connectScenario({ probe, ping, throwPing = false }) {
  const events = [];
  const connect = makeConnectBlender(
    async () => { events.push(["probe"]); return probe; },
    (on, error) => { events.push(["set", on, error || ""]); },
    async (...args) => { events.push(["ping", ...args]); if (throwPing) throw new Error("mock dispatch failed"); return ping; },
    () => { events.push(["broadcast"]); },
  );
  return { result: await connect(), events };
}

// Extract the exact core gate used by ChatGPT's response classifier. Blender
// names are intentionally not virtual: they become known only when refreshed
// into A.toolNames from the worker's live tool catalogue.
const knownStart = main.indexOf("  const bareKey = (n) => String(n || \"\").split(\"/\").pop().split(\".\").pop();");
const knownEnd = main.indexOf("  const isBlockedTool", knownStart);
if (knownStart < 0 || knownEnd < 0) throw new Error("could not extract knownTool");
const knownSrc = main.slice(knownStart, knownEnd);
function makeKnownTool(A) {
  return new Function(
    "A", "RSAnim", "RobloxScriptSkills", "AgentScriptSkills", "bareToolName",
    knownSrc + "\nreturn knownTool;"
  )(A, { ANIM_OPS: [] }, { SKILL_OPS: [] }, { SKILL_OPS: [] }, bareToolName);
}

// Extract the production Blender preflight/readiness function. The fake
// ensureTools() mutates the same A.toolList/A.toolNames state as the real one.
const readySrc = sliceBetween(main, "  async function blenderReady() {", "\n  // A cached boolean is not enough", "blenderReady");
function makeBlenderReady({ A, window, bg, ensureTools, diagnostics }) {
  return new Function(
    "A", "window", "bg", "ensureTools", "diag", "bareToolName",
    readySrc + "\nreturn blenderReady;"
  )(A, window, bg, ensureTools, (event, data) => diagnostics.push({ event, data }), bareToolName);
}

// Extract the exact default-catalogue fallback and the primary-editor offline
// gate. The tests run the branch for both Roblox and AgentScript as the active
// editor; only the work mode and background responses are mocked.
const helperSrc = sliceBetween(
  main,
  "  async function blenderModeCatalogueFallback(args) {",
  "  // 2.21.0: same for the Blockbench family",
  "Blender catalogue fallback helpers"
);
const listStart = main.indexOf('    if (name === "list_commands" || name === "list_tools") {');
const gateStart = main.indexOf("      if (requested === curEng) {", listStart);
const gateEnd = main.indexOf("      const known = new Set(A.toolList.map", gateStart);
if (listStart < 0 || gateStart < 0 || gateEnd < 0) throw new Error("could not extract list_commands offline gate");
const gateSrc = main.slice(gateStart, gateEnd);
function makeFallbackHelpers(A, mode, blenderReady) {
  return new Function(
    "A", "currentWorkMode", "blenderReady",
    helperSrc + "\nreturn { blenderModeCatalogueFallback, blenderCatalogueUnavailableReply };"
  )(A, () => mode, blenderReady);
}
function makeOfflineGate(A, args, curEng, mode, ready) {
  const helpers = makeFallbackHelpers(A, mode, ready);
  const gate = new Function(
    "A", "args", "name", "curEng", "requested", "broadCatalogueRequest",
    "blenderModeCatalogueFallback", "blenderCatalogueUnavailableReply", "diag",
    "return (async () => {\n" + gateSrc + "\nreturn { requested };\n})();"
  );
  const diagnostics = [];
  return gate(A, args, "list_commands", curEng, (args.server || curEng).trim().toLowerCase(), true,
    helpers.blenderModeCatalogueFallback, helpers.blenderCatalogueUnavailableReply,
    (event, data) => diagnostics.push({ event, data })).then((result) => ({ result, diagnostics }));
}

(async () => {
  ok("ChatGPT is the provider adapter; Blender call acceptance stays in shared main.js", /id:\s*["']chatgpt["']/.test(chatgpt) && /function knownTool\(name\)/.test(main) && /async function runTool\(call\)/.test(main));

  const tcpFailure = await connectScenario({ probe: { ok: false, error: "no listener" }, ping: { ok: true } });
  ok("TCP probe failure stays disconnected and does not send a Blender command", tcpFailure.result.ok === false && tcpFailure.result.blender === false && !tcpFailure.events.some((e) => e[0] === "ping") && tcpFailure.events.some((e) => e[0] === "set" && e[1] === false));

  const commandFailure = await connectScenario({ probe: { ok: true }, ping: { ok: false, error: "unsupported get_scene_info" } });
  ok("open port + failed get_scene_info is not reported as connected", commandFailure.result.ok === false && commandFailure.result.blender === false && /get_scene_info failed/.test(commandFailure.result.error) && commandFailure.events.some((e) => e[0] === "set" && e[1] === false) && !commandFailure.events.some((e) => e[0] === "set" && e[1] === true));
  ok("connect handshake uses the internal unverified-call bypass only for get_scene_info", (() => { const ping = commandFailure.events.find((e) => e[0] === "ping"); return !!ping && ping[1] === "get_scene_info" && ping[2] && ping[3] === 20000 && ping[4] === true && /async function blenderCall\(name, args, timeout, allowUnverified = false\)/.test(background) && /if \(!blenderAddon && !allowUnverified\)/.test(background); })());

  const thrownPing = await connectScenario({ probe: { ok: true }, ping: null, throwPing: true });
  ok("thrown scene-info dispatch is returned as a failed connection with a status broadcast", thrownPing.result.ok === false && /get_scene_info failed/.test(thrownPing.result.error) && thrownPing.events.some((e) => e[0] === "broadcast"));

  const successfulConnect = await connectScenario({ probe: { ok: true }, ping: { ok: true, text: "Scene: 1 object" } });
  ok("connected state is published only after the scene-info round trip succeeds", successfulConnect.result.ok === true && successfulConnect.result.blender === true && successfulConnect.events.some((e) => e[0] === "set" && e[1] === true) && successfulConnect.events.at(-1)[0] === "broadcast");
  const blenderErrorBranch = sliceBetween(background, 'if (data && data.status === "error") {', "\n    let result =", "Blender error classifier");
  ok("only refused sockets get the safe-to-retry BLENDER_OFFLINE code; ambiguous socket closure clears status without replay", blenderErrorBranch.includes("const definitelyNotDispatched = /not listening|actively refused|10061|Connection refused/i.test(msg);") && /if \(socketDropped\) setBlender\(false/.test(blenderErrorBranch) && /if \(definitelyNotDispatched\) return \{ ok: false, kind: "disconnected", errorCode: "BLENDER_OFFLINE"/.test(blenderErrorBranch) && !/closed\/.*errorCode: "BLENDER_OFFLINE"/.test(blenderErrorBranch));
  const blenderCallSrc = sliceBetween(background, "async function blenderCall(name, args, timeout, allowUnverified = false) {", "\n\nasync function dispatchBlenderTool", "blenderCall");
  ok("one-shot requests clear the previous output so a stale success cannot pass the connection handshake", blenderCallSrc.indexOf('await localWrite("total_blender_out.json", "");') > blenderCallSrc.indexOf('await localWrite("total_blender_in.json"') && blenderCallSrc.indexOf('await localWrite("total_blender_out.json", "");') < blenderCallSrc.indexOf("await localRun(cmd, secs)"));

  const dispatchSrc = sliceBetween(background, "async function dispatchBlenderTool(name, args, timeout) {", "\n\nasync function robloxCsrf()", "dispatchBlenderTool");
  const makeDispatch = (isBlenderToolName, blenderAddon, blenderError, blenderCall) => new Function(
    "isBlenderToolName", "blenderAddon", "blenderError", "blenderCall",
    dispatchSrc + "\nreturn dispatchBlenderTool;"
  )(isBlenderToolName, blenderAddon, blenderError, blenderCall);
  let disconnectedDispatchCalls = 0;
  const disconnectedDispatch = makeDispatch((name) => name === "get_scene_info", false, "Blender is offline", async () => { disconnectedDispatchCalls++; });
  const offlineDispatchResult = await disconnectedDispatch("get_scene_info", {}, 120000);
  ok("offline Blender tool dispatch returns BLENDER_OFFLINE without calling another engine", offlineDispatchResult && offlineDispatchResult.errorCode === "BLENDER_OFFLINE" && offlineDispatchResult.kind === "disconnected" && disconnectedDispatchCalls === 0);
  let connectedDispatchArgs = null;
  const connectedDispatch = makeDispatch((name) => name === "get_scene_info", true, "", async (...args) => { connectedDispatchArgs = args; return { ok: true, text: "scene" }; });
  const connectedDispatchResult = await connectedDispatch("get_scene_info", { detail: true }, 45000);
  ok("connected Blender calls preserve their name, arguments and timeout", connectedDispatchResult && connectedDispatchResult.ok && connectedDispatchArgs && connectedDispatchArgs[0] === "get_scene_info" && connectedDispatchArgs[1].detail === true && connectedDispatchArgs[2] === 45000);
  const callToolAt = background.indexOf('case "call_tool":');
  const blenderDispatchAt = background.indexOf("if (isBlenderToolName(msg.name))", callToolAt);
  const engineDispatchAt = background.indexOf('if (msg.engine && normalizeEngine(msg.engine) !== engine)', blenderDispatchAt);
  ok("Blender call routing precedes the generic engine route", callToolAt >= 0 && blenderDispatchAt > callToolAt && engineDispatchAt > blenderDispatchAt);

  const recoverySrc = sliceBetween(main, "  async function callBlenderToolWithRecovery(name, args, timeout) {", "\n  // A cached boolean is not enough", "callBlenderToolWithRecovery");
  const makeRecovery = ({ A, bg, ensureTools, diagnostics }) => new Function(
    "A", "bg", "ensureTools", "cleanToolResult", "diag", "bareToolName",
    recoverySrc + "\nreturn callBlenderToolWithRecovery;"
  )(A, bg, ensureTools, (r) => r, (event, data) => diagnostics.push({ event, data }), bareToolName);
  const recoveryA = { bridge: { blender: true }, activeRequestId: "req-1", stop: false };
  const recoveryCalls = [], recoveryDiagnostics = [];
  let refreshedAfterRecovery = false;
  const recoverCall = makeRecovery({
    A: recoveryA,
    bg: async (msg) => {
      recoveryCalls.push(msg.type + (msg.type === "call_tool" ? ":" + msg.name : ""));
      if (msg.type === "call_tool" && recoveryCalls.filter((x) => x.startsWith("call_tool:")).length === 1) return { ok: false, kind: "disconnected", errorCode: "BLENDER_OFFLINE", error: "worker link expired" };
      if (msg.type === "blender_connect") return { ok: true, blender: true };
      return { ok: true, text: "retried scene" };
    },
    ensureTools: async (force) => { refreshedAfterRecovery = force === true; },
    diagnostics: recoveryDiagnostics,
  });
  const recovered = await recoverCall("get_scene_info", {}, 1000);
  ok("a confirmed BLENDER_OFFLINE result reconnects, refreshes schemas, and retries once", recovered && recovered.ok && recoveryCalls.join() === "call_tool:get_scene_info,blender_connect,call_tool:get_scene_info" && refreshedAfterRecovery && recoveryA.bridge.blender === true && recoveryDiagnostics.some((d) => d.event === "blender.linkRetry" && d.data.ok));

  const noRetryA = { bridge: { blender: true }, activeRequestId: "req-2", stop: false };
  const noRetryCalls = [];
  const noRetry = makeRecovery({
    A: noRetryA,
    bg: async (msg) => { noRetryCalls.push(msg.type); return { ok: false, errorCode: "INVALID_ARGUMENT", error: "invalid schema" }; },
    ensureTools: async () => { throw new Error("must not refresh on argument errors"); },
    diagnostics: [],
  });
  const invalidResult = await noRetry("blender_asset_build", {}, 1000);
  ok("validation and command errors are not replayed", invalidResult.errorCode === "INVALID_ARGUMENT" && noRetryCalls.join() === "call_tool");

  const failedRecoveryA = { bridge: { blender: true }, activeRequestId: "req-3", stop: false };
  const failedRecoveryCalls = [];
  const failedRecovery = makeRecovery({
    A: failedRecoveryA,
    bg: async (msg) => { failedRecoveryCalls.push(msg.type); return msg.type === "call_tool"
      ? { ok: false, kind: "disconnected", errorCode: "BLENDER_OFFLINE", error: "worker link expired" }
      : { ok: false, blender: false, error: "Start MCP Server" }; },
    ensureTools: async () => {}, diagnostics: [],
  });
  const failedRecoveryResult = await failedRecovery("get_scene_info", {}, 1000);
  ok("failed reconnection reports offline and does not replay the Blender command", failedRecoveryResult.errorCode === "BLENDER_OFFLINE" && /Start MCP Server/.test(failedRecoveryResult.error) && failedRecoveryCalls.join() === "call_tool,blender_connect" && failedRecoveryA.bridge.blender === false);

  const initialTools = [{ name: "execute_luau", server: "roblox" }];
  const A = { bridge: { blender: false }, toolList: initialTools, toolNames: new Set(initialTools.map((t) => t.name)), toolsAt: Date.now() };
  const knownBeforeRefresh = makeKnownTool(A);
  const diagnostics = [], backgroundCalls = [];
  const ready = makeBlenderReady({
    A,
    window: { __rsBlender: () => false },
    bg: async (msg) => {
      backgroundCalls.push(msg.type);
      if (msg.type === "blender_status") return { ok: false, blender: false };
      if (msg.type === "blender_connect") return { ok: true, blender: true };
      return { ok: false };
    },
    ensureTools: async (force) => {
      if (force !== true) throw new Error("expected a forced live tool refresh");
      const tools = [{ name: "get_scene_info", server: "blender" }, { name: "blender_asset_build", server: "blender" }];
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
      A.toolsAt = Date.now();
      return tools;
    },
    diagnostics,
  });
  ok("stale preflight catalogue initially rejects get_scene_info", knownBeforeRefresh("get_scene_info") === false);
  const readyAfterConnect = await ready();
  const knownAfterRefresh = makeKnownTool(A);
  ok("successful auto-connect forces a live catalogue refresh before Blender mode is ready", readyAfterConnect && backgroundCalls.join() === "blender_status,blender_connect" && A.bridge.blender === true && A.toolNames.has("get_scene_info") && knownAfterRefresh("get_scene_info") === true && knownAfterRefresh("blender_asset_build") === true);

  const staleA = { bridge: { blender: true }, toolList: initialTools.slice(), toolNames: new Set(["execute_luau"]) };
  let staleRefresh = false;
  const staleReady = makeBlenderReady({
    A: staleA, window: { __rsBlender: () => true },
    bg: async (msg) => msg.type === "blender_status" ? { ok: true, blender: true } : { ok: true, blender: true },
    ensureTools: async () => { staleRefresh = true; staleA.toolList = [{ name: "blender/get_scene_info", server: "blender" }]; staleA.toolNames = new Set(["blender/get_scene_info"]); },
    diagnostics: [],
  });
  ok("cached connected flag without schemas probes and refreshes rather than fast-pathing", await staleReady() && staleRefresh && staleA.toolNames.has("blender/get_scene_info"));

  const noToolA = { bridge: { blender: true }, toolList: initialTools.slice(), toolNames: new Set(["execute_luau"]) };
  const noToolDiagnostics = [];
  const noToolReady = makeBlenderReady({
    A: noToolA, window: { __rsBlender: () => true },
    bg: async (msg) => msg.type === "blender_status" ? { ok: true, blender: true } : { ok: true, blender: true },
    ensureTools: async () => {}, diagnostics: noToolDiagnostics,
  });
  ok("a connected worker with no refreshed Blender schemas is not treated as ready", await noToolReady() === false && noToolDiagnostics.some((d) => d.event === "blender.toolsUnavailable"));

  const rbA = { bridge: { connected: true, roblox_connected: false, studio: false, blender: true, servers: [{ id: "roblox", alive: false }] }, toolList: [{ name: "get_scene_info", server: "blender" }] };
  let readinessChecks = 0;
  const rbRoute = await makeOfflineGate(rbA, {}, "roblox", "blender", async () => { readinessChecks++; return true; });
  ok("Blender mode's broad catalogue falls back to Blender when Roblox Studio is offline", rbRoute.result && rbRoute.result.requested === "blender" && readinessChecks === 1 && rbRoute.diagnostics.some((d) => d.event === "tools.blenderCatalogueFallback"));

  const localA = { bridge: { connected: false, local_connected: false, servers: [], blender: true }, toolList: [{ name: "get_scene_info", server: "blender" }] };
  const localRoute = await makeOfflineGate(localA, {}, "local", "blender", async () => true);
  ok("Blender mode's broad catalogue also bypasses the offline AgentScript gate", localRoute.result && localRoute.result.requested === "blender");

  const scopedStart = main.indexOf("      const allScoped = A.toolList.filter", gateEnd);
  const scopedEnd = main.indexOf("\n      const queryTerms", scopedStart);
  if (scopedStart < 0 || scopedEnd < 0) throw new Error("could not extract catalogue scoping");
  const scopedSrc = main.slice(scopedStart, scopedEnd);
  const scopedTools = new Function(
    "A", "requested", "curEng", "commandQuery", "blenderModeTools", "blockbenchModeTools",
    scopedSrc + "\nreturn allScoped;"
  )(rbA, "blender", "roblox", "", () => [], () => []);
  ok("fallback scope contains the live Blender commands, not the offline Roblox catalogue", scopedTools.map((t) => t.name).join() === "get_scene_info");

  const explicitA = { bridge: { connected: true, roblox_connected: false, studio: false, servers: [{ id: "roblox", alive: false }] }, toolList: [{ name: "get_scene_info", server: "blender" }] };
  const explicitRoute = await makeOfflineGate(explicitA, { server: "roblox" }, "roblox", "blender", async () => { throw new Error("explicit server must not auto-fallback"); });
  ok("an explicit server argument is never silently redirected to Blender", typeof explicitRoute.result === "string" && /Roblox Studio is currently OFFLINE/.test(explicitRoute.result));

  const offlineA = { bridge: { connected: true, roblox_connected: false, studio: false, blender: false, servers: [{ id: "roblox", alive: false }] }, toolList: [] };
  const offlineRoute = await makeOfflineGate(offlineA, {}, "roblox", "blender", async () => false);
  ok("when both default editor and Blender are offline, list_commands names Blender's real connection steps", typeof offlineRoute.result === "string" && /Blender is currently OFFLINE/.test(offlineRoute.result) && /Start MCP Server/.test(offlineRoute.result));

  console.log(`\ntest-blender-chatgpt: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
