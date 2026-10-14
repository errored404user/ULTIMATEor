"use strict";
// or_screenshot regressions: the tab capture used to throw a swallowed
// ReferenceError (_sender) in background.js, so every browser-tab screenshot
// failed with "screenshot captured nothing. tab: _sender is not defined".
const fs = require("fs"), assert = require("assert");
const bg = fs.readFileSync("background.js", "utf8"), main = fs.readFileSync("src/core/main.js", "utf8"), s200 = fs.readFileSync("src/core/skills/studio_200.js", "utf8");

// background: the capture handler must read the real listener argument
assert(!/\b_sender\b/.test(bg), "background.js must not reference the undefined _sender");
assert(bg.includes("const tabId = sender && sender.tab && sender.tab.id;"), "tab capture reads sender.tab");
assert(/chrome\.runtime\.onMessage\.addListener\(\(msg, sender, sendResponse\)/.test(bg), "listener param is named sender");
assert(bg.includes("let fullSyncedOnce = false;"), "refreshProcStatus must not throw on an undeclared fullSyncedOnce (it skipped broadcastStatus)");

// or_screenshot: discover the Studio capture tool by family, and wait like a direct call
assert(main.includes('const screenTool = studioToolByBare("screen_capture") || studioCaptureTool();'), "capture tool discovery");
assert(main.includes("function studioCaptureTool()") && main.includes("A.imageTools.has(bareToolName(t.name))"), "capture tool fallback via learned image tools");
assert(main.includes('callStudioToolWithId(screenTool.name, callArgs, 90000, A.activeRequestId)'), "studio capture gets the same patience as a direct call (and the studio_id retry)");

// renderBar status pill / tooltips: no undefined identifiers inside the swallowed try
assert(!/\bstudioConnected\b/.test(main), "renderBar must not read the undefined studioConnected");
assert(main.includes('txt.textContent = currentEngine === "local" ? "AS Connected" : "RS Connected";'), "status pill uses currentEngine");
assert(!main.includes('actionBtn.title = currentMode === "local"'), "tooltips use currentEngine");
assert(!/^\s*try \{ createCheckpoint\(name, args\); \} catch \{\}/m.test(main) && main.includes("window.__rsBeforeTool(name, args)") && main.includes("window.__rsAfterTool(name, args, ok, res)") && main.includes("window.__rsAfterTool = (op, args, ok, res) =>"), "runTool must reach checkpoint/session/perf helpers through the ui hooks (direct calls were swallowed ReferenceErrors)");
assert(!/ZSParse/.test(fs.readFileSync("src/providers/notion.js", "utf8")), "notion.js must use RSParse (ZSParse was a stale rename)");
assert(!main.includes("scanProject(projectFile)") || main.includes("async function scanProject(file)"), "template editor must only call scanProject when it is defined (1.23.0 restored the Project panel)");
assert(main.includes('typeof dispatchPublicItemTool === "function"'), "public_item tools fail softly");
assert(main.includes("window.__rsBuildMenu = buildMenu"), "theme preview can rebuild the menu from outside build()");

// remote_handler print behaviour must be valid Lua, not JS reading pl.Name
assert(s200.includes("from ' .. pl.Name .. ': ' .. tostring(arg1)) end)"), "remote_handler print snippet is Lua");
console.log("PASS  or_screenshot tab capture + status pill + undefined-identifier regressions");
