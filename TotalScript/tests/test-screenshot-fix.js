// 1.22.0 — "screen capture is not working: ERROR INVALID_ARGUMENT: Missing
// required arg". Two defects, both covered live by `SHOT=1 node tests/notion-e2e.js`:
//  1. src/core/screenshot.js (and templates.js / studio_bridge.js) were only
//     listed for DeepSeek + NVIDIA, so total_screenshot answered "screenshot
//     module missing" on every other provider and the model fell back to the
//     raw screen_capture tool;
//  2. Studio's screen_capture refuses the call without a studio_id (the one
//     Studio tool that does not infer it), and TotalScript only resolved one when the
//     cached schema advertised the parameter.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let n = 0;
function ok(name, cond) { n++; if (!cond) { console.log("FAIL  " + name); process.exitCode = 1; } else console.log("PASS  " + name); }

const manifest = JSON.parse(read("manifest.json"));
const main = read("src/core/main.js");
const rs = read("agent/src/main.rs");
const notion = read("src/providers/notion.js");

const mainEntries = manifest.content_scripts.filter((cs) => (cs.js || []).includes("src/core/main.js"));
ok("every provider bundle loads screenshot.js before main.js", mainEntries.length >= 10 && mainEntries.every((cs) => cs.js.indexOf("src/core/screenshot.js") >= 0 && cs.js.indexOf("src/core/screenshot.js") < cs.js.indexOf("src/core/main.js")));
ok("every provider bundle loads templates.js and studio_bridge.js", mainEntries.every((cs) => cs.js.includes("src/core/templates.js") && cs.js.includes("src/core/studio_bridge.js")));
ok("every listed content script exists", manifest.content_scripts.every((cs) => (cs.js || []).every((f) => fs.existsSync(path.join(ROOT, f)))));

ok("studio_id is resolved via list_roblox_studios with a short cache", main.includes("async function resolveStudioId(force)") && main.includes("const STUDIO_ID_TTL = 20000") && /name = \(listTool && listTool\.name\) \|\| "list_roblox_studios"/.test(main));
ok("screen_capture always carries a studio_id (not only when the cached schema lists it)", /if \(!clean\.studio_id\) \{\s*const given = source && \(source\.studio_id \|\| source\.studioId\);\s*clean\.studio_id = given \|\| await resolveStudioId\(false\)/.test(main) && !main.includes("if (props.studio_id && !clean.studio_id)"));
ok("Studio tool calls retry once with a fresh studio_id on 'Missing required arg'", main.includes("async function callStudioToolWithId(name, args, timeout, requestId)") && main.includes("function studioIdComplaint(r)") && /callStudioToolWithId\(name, (?:args|wireArgs), timeout, A\.activeRequestId\)/.test(main) && main.includes("callStudioToolWithId(screenTool.name, callArgs, 90000, A.activeRequestId)"));
ok("final error explains the studio_id requirement", main.includes("Studio requires a studio_id for '${bareName}'"));
ok("total-core injects studio_id and retries at the bridge too", rs.includes("fn tool_wants_studio_id(&self, name: &str) -> bool") && rs.includes("async fn resolve_studio_id(&mut self) -> Option<String>") && rs.includes("fn studio_id_from_listing(text: &str) -> Option<String>") && rs.includes("fn missing_studio_id(text: &str) -> bool") && rs.includes("retry_with_fresh_studio_id(name, args).await"));
ok("Notion attach never throws out of the loop when DataTransfer is missing", notion.includes('_lastAttachFailure = "unsupported"'));
ok("e2e harness has the SHOT scenario", read("tests/notion-e2e.js").includes("Missing required arg: studio_id") && read("tests/notion-e2e.js").includes("const SHOT = !!process.env.SHOT"));
console.log(`\n${n} checks`);
