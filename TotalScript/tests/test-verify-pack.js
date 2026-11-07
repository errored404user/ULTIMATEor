// 2.3.0 — VERIFY PACK: place_checkpoint / ui_test (src/core/skills/studio_verify.js).
// Static half: registration, schemas, JS-side validation, builder shape (lib +
// body for the Luau library cache), contract compatibility, catalogue placement,
// wiring into manifest / prompts / hints / SLOW_SKILL_RE, honest-output rules.
// The Luau itself runs in tests/verify-sim.py (lupa + roblox_sim DataModel).
// Run: node tests/test-verify-pack.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 600) : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/command_contract.js") + ";globalThis.__CC=TotalCommandContract;", { filename: "command_contract.js" });
const S = RobloxScriptSkills, CC = globalThis.__CC;
const NAMES = ["place_checkpoint", "ui_test"];
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
const src = read("src/core/skills/studio_verify.js");
const LIB = S.VERIFY_LIB;

// ── A. registration ───────────────────────────────────────────────────────────
ok("A1 pack exports VERIFY_COMMANDS (2 names) + VERSION 2.10.0 + LIB + validateVerify", JSON.stringify(S.VERIFY_COMMANDS) === JSON.stringify(NAMES) && S.VERIFY_VERSION === "2.10.0" && typeof LIB === "string" && typeof S.validateVerify === "function");
ok("A2 both are registered ONCE, visible, with description + params", NAMES.every((n) => byName.has(n) && !byName.get(n).hidden && byName.get(n).description.length > 120 && Object.keys(byName.get(n).params).length >= 4) && S.SKILL_COMMANDS.filter((c) => NAMES.includes(c.name)).length === 2);
ok("A3 SKILL_COMMANDS spliced, not reassigned; SKILL_OPS lists the names", /const arr = RobloxScriptSkills\.SKILL_COMMANDS;[\s\S]*?for \(const c of C\) arr\.push\(c\);/.test(src) && !/RobloxScriptSkills\.SKILL_COMMANDS\s*=/.test(src) && NAMES.every((n) => S.SKILL_OPS.includes(n)));
ok("A4 required params: op for place_checkpoint, path for ui_test; op desc lists save|restore|list|diff|delete", byName.get("place_checkpoint").params.op.req === true && byName.get("place_checkpoint").params.path.req === false && byName.get("ui_test").params.path.req === true && /save\|restore\|list\|diff\|delete/.test(byName.get("place_checkpoint").params.op.desc));
ok("A5 the name place_checkpoint (not checkpoint_*) keeps it out of the GAMEPLAY family regex (checkpoint_system) - see main.js families", !/^checkpoint/.test("place_checkpoint"));

// ── B. builder shape ──────────────────────────────────────────────────────────
const b = S.buildLuau("place_checkpoint", { op: "save", path: "Workspace.Shop", name: "v1" });
ok("B1 builder returns { code, lib, body } with code === lib + '\\n' + body (runSkillLuau cache contract)", b && !b.err && b.code === b.lib + "\n" + b.body && b.lib === LIB);
ok("B2 library > 4000 chars, program > 18000, body small (the lib uploads once per place)", b.lib.length > 4000 && b.code.length > 18000 && b.body.length < 400, { lib: b.lib.length, code: b.code.length, body: b.body.length });
ok("B3 body = JSONDecode of the args in a [==[ ]==] long string + VF.run(op)", /HttpService:JSONDecode\(\[==\[\{"op":"save","path":"Workspace\.Shop","name":"v1"\}\]==\]\)/.test(b.body) && /return VF\.run\("place_checkpoint", __a\)/.test(b.body));
ok("B4 args containing ']==]' are refused", (() => { const r = S.buildLuau("place_checkpoint", { op: "save", path: "Workspace.X", label: "a]==]print(1)--" }); return r && r.err && /]==]/.test(r.err); })());
ok("B5 library is pure ASCII and has no Luau-only syntax (+=, continue, //, backticks)", !/[^\x00-\x7f]/.test(LIB) && !/\+=|\bcontinue\b|[^/]\/\/[^/]|`/.test(LIB));
ok("B6 one namespace (local VF = {}) and every result goes through okj / failj JSON", /local VF = \{\}/.test(LIB) && /local function okj\(d, t\) return HttpService:JSONEncode\(\{ ok = true, data = d or \{\}, text = t or "" \}\) end/.test(LIB) && /local function failj\(m\)/.test(LIB));
ok("B7 checkpoint store is ServerStorage._TotalCheckpoints with Total_Label / Source / Class / Kind / Count / Time attributes and a Map StringValue", /local STORE = "_TotalCheckpoints"/.test(LIB) && ["Total_Label", "Total_Source", "Total_Class", "Total_Kind", "Total_Count", "Total_Time"].every((k) => LIB.includes('e:SetAttribute("' + k + '"')) && /mv\.Name = "Map"/.test(LIB));
ok("B8 save caps the subtree (MAX_SAVE 20000 descendants), refuses the whole game, services save Props + Children, instances Clone()", /local MAX_SAVE = 20000/.test(LIB) && /cannot checkpoint the whole game/.test(LIB) && /pv\.Name = "Props"/.test(LIB) && /ch\.Name = "Children"/.test(LIB) && /pcall\(function\(\) return inst:Clone\(\) end\)/.test(LIB));
ok("B9 restore destroys the current copy(ies) and clones back under the ORIGINAL parent, wrapped in ChangeHistoryService waypoints; Terrain / Camera / player characters are skipped", /while cur do cur:Destroy\(\) removed = removed \+ 1 cur = parent:FindFirstChild\(leaf\) end/.test(LIB) && /waypoint\("TotalScript checkpoint restore "/.test(LIB) && /c:IsA\("Terrain"\) or c:IsA\("Camera"\)/.test(LIB) && /GetPlayerFromCharacter/.test(LIB));
ok("B10 diff compares class + Size / CFrame (pos + rot) / Color / Material / Transparency / Anchored for parts, Size / Position / Visible / Text for GUI, a Source hash for scripts", /s\.material = inst\.Material\.Name/.test(LIB) && /s\.rot = \{/.test(LIB) && /s\.visible = inst\.Visible/.test(LIB) && /s\.source = strhash\(src\)/.test(LIB) && /s\.text = txt/.test(LIB));

// ── C. ui_test semantics in the Luau ──────────────────────────────────────────
ok("C1 wiring detection: Total_Action attribute (+ Total_Controller present), ui_state_toggle header, click words on own / external scripts, StarterPlayerScripts scanned", /btn:GetAttribute\("Total_Action"\)/.test(LIB) && /root:FindFirstChild\("Total_Controller", true\)/.test(LIB) && /TotalScript ui_state_toggle: \(%a\+\)/.test(LIB) && /"Activated", "MouseButton1Click", "MouseButton1Down", "MouseButton1Up", "InputBegan"/.test(LIB) && /StarterPlayerScripts/.test(LIB));
ok("C2 simulation follows the real Total_Controller semantics: close -> window or gui.Enabled, toggle:X, open:X, remote:X (server not simulated), print", /if act == "close" then/.test(LIB) && /act:sub\(1, 7\) == "toggle:"/.test(LIB) && /act:sub\(1, 5\) == "open:"/.test(LIB) && /server behaviour not simulated/.test(LIB) && /placeholder action/.test(LIB));
ok("C3 the simulation runs on a virtual state table - the real GUI is never mutated (no '.Visible =' assignment in the ui_test half)", !/\.Visible = (true|false|not)/.test(LIB.slice(LIB.indexOf("function VF.uiTest"))));
ok("C4 touch targets measured at 1280x720 and 844x390; < 36 px on phone is flagged", /absSize\(b, 1280, 720\)/.test(LIB) && /absSize\(b, 844, 390\)/.test(LIB) && /math\.min\(wP, hP\) < 36/.test(LIB));
ok("C5 live_plan uses the native tools exactly: start_stop_play {is_start:true}, user_mouse_input {datamodel_type:'Client', actions:[{action:'mouseButtonClick', mouse_button:'left', instance_path: game.Players.LocalPlayer.PlayerGui...}]}, ui_test {expect_only:true}, get_console_output", /tool = "start_stop_play", arguments = \{ is_start = true \}/.test(LIB) && /action = "mouseButtonClick", mouse_button = "left", instance_path = pgPrefix/.test(LIB) && /"game\.Players\.LocalPlayer\.PlayerGui\." \.\. gui\.Name/.test(LIB) && /expect_only = true/.test(LIB) && /tool = "get_console_output"/.test(LIB));
ok("C6 honesty: the result says 'Static + simulated only' unless expect_only, and `verified` is static_and_simulated | edit_state | live_state", /Static \+ simulated only - to PROVE it, run the live_plan/.test(LIB) && /verified = a\.expect_only and \(live and "live_state" or "edit_state"\) or "static_and_simulated"/.test(LIB));
ok("C7 expect_only in Play mode reads the LIVE PlayerGui copy of a StarterGui path", /RunService:IsRunning\(\)/.test(LIB) && /"Players\." \.\. p\.Name \.\. "\.PlayerGui\."/.test(LIB));

// ── D. JS-side validation + contract ─────────────────────────────────────────
const err = (op, a) => { const r = S.buildLuau(op, a); return r && r.err ? r.err : null; };
ok("D1 place_checkpoint: bad op, save without path, restore without name/path, bad name are refused before Luau", /save\|restore\|list\|diff\|delete/.test(err("place_checkpoint", { op: "zap" }) || "") && /save needs path/.test(err("place_checkpoint", { op: "save" }) || "") && /restore needs name or path/.test(err("place_checkpoint", { op: "restore" }) || "") && /name:/.test(err("place_checkpoint", { op: "save", path: "Workspace.X", name: "a/b" }) || ""));
ok("D2 ui_test: path required, actions must be objects with click, expect must be objects with path", /path is required/.test(err("ui_test", {}) || "") && /click:'ButtonName'/.test(err("ui_test", { path: "StarterGui.X", actions: ["Shop"] }) || "") && /each expectation needs path/.test(err("ui_test", { path: "StarterGui.X", expect: [{ Visible: true }] }) || ""));
ok("D3 valid calls build for every op", ["save", "restore", "list", "diff", "delete"].every((op) => !err("place_checkpoint", { op, path: "Workspace.X", name: "v1" })) && !err("ui_test", { path: "StarterGui.Shop", actions: [{ click: "Buy" }], expect: [{ path: "Win", Visible: true }] }) && !err("ui_test", { path: "StarterGui.Shop", expect_only: true, expect: [{ name: "Win", Visible: false }] }));
const prep = (n, a) => CC.prepare(n, a);
ok("D4 contract: actions / expect arrays pass through untouched (objects, not vectors); op / path strings kept", (() => { const r = prep("ui_test", { path: "StarterGui.Shop", actions: [{ click: "Buy" }], expect: [{ path: "Win", Visible: true }] }); return r.ok && JSON.stringify(r.args.actions) === '[{"click":"Buy"}]' && JSON.stringify(r.args.expect) === '[{"path":"Win","Visible":true}]'; })() && prep("place_checkpoint", { op: "save", path: "Workspace.Shop" }).ok);
ok("D5 contract: place_checkpoint is mutating (restore / delete destroy instances); ui_test is read-only (not mutating)", (() => { const c = CC.contract("place_checkpoint"), u = CC.contract("ui_test"); return c && c.mutating === true && u && u.mutating !== true; })(), { c: CC.contract("place_checkpoint"), u: CC.contract("ui_test") });

// ── E. wiring ─────────────────────────────────────────────────────────────────
const main = read("src/core/main.js"), config = read("src/core/config.js");
ok("E1 manifest: studio_verify.js loads right after studio_modelkit.js and before main.js in every Studio bundle (" + bundles.length + "); codecraft.html too", bundles.length >= 10 && bundles.every((c) => { const i = c.js.indexOf("src/core/skills/studio_modelkit.js"), j = c.js.indexOf("src/core/skills/studio_verify.js"), k = c.js.indexOf("src/core/main.js"); return i >= 0 && j === i + 1 && j < k; }) && /studio_modelkit\.js"><\/script>\n\s*<script src="src\/core\/skills\/studio_verify\.js">/.test(read("codecraft.html")));
ok("E2 tests/test-command-dedup.js loads the pack", /"studio_verify\.js"/.test(read("tests/test-command-dedup.js")));
ok("E3 SLOW_SKILL_RE grants the long budget to place_checkpoint (cloning big trees)", /SLOW_SKILL_RE = \/.*\|place_checkpoint(\|[a-z_|]+)?\)\$\//.test(main));
ok("E4 catalogue families: ui_test -> UI & HUD (audit tier -1), place_checkpoint -> STUDIO CONTROL via place_ (generator-free tier 0)", (() => { const cut = (a, c) => { const i = main.indexOf(a), j = main.indexOf(c, i); return main.slice(i, j); }; const block = cut("  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET") + cut("  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──"); const c = { window: null, console, RS: { TOOL_NOTES: {} }, RobloxScriptSkills: S, RSAnim: global.RSAnim }; c.window = c; vm.createContext(c); vm.runInContext(block + "\nthis.commandFamily=commandFamily;this.signaturePriority=signaturePriority;", c); return c.commandFamily("ui_test") === "ui" && c.signaturePriority("ui_test") === -1 && c.commandFamily("place_checkpoint") === "studio"; })());
ok("E5 NEXT_STEP hints for place_checkpoint / ui_test / screenshot_compare point at real follow-ups", /place_checkpoint: "Next: make the risky change; afterwards place_checkpoint \{op:'diff'\}/.test(main) && /ui_test: "Next: wire every DEAD button \(ui_states_wire \/ ui_state_toggle \/ ui_bind_button\)/.test(main) && /screenshot_compare: "Next: if NO VISIBLE CHANGE/.test(main));
ok("E6 config prompt: a VERIFY line teaches place_checkpoint / ui_test / screenshot_compare", /- VERIFY: \\`place_checkpoint\\`/.test(config) && /\\`ui_test\\`/.test(config) && /\\`screenshot_compare\\`/.test(config));
ok("E7 visible catalogue ceiling moved to 622 in 2.3.0 (628 since the 2.4.0 library + perf packs, 630 since the 2.9.0 device pack) and the count matches the pin", /never above 630/.test(read("tests/test-not-implemented.js")) && S.SKILL_COMMANDS.filter((c) => !c.hidden).length === 630, S.SKILL_COMMANDS.filter((c) => !c.hidden).length);
ok("E8 prompt budgets still hold (ChatGPT compact <= 14000)", (() => { const c = { window: {}, console, chrome: global.chrome }; c.window = c; c.window.__rsWorkMode = () => "creation"; vm.createContext(c); vm.runInContext(config + ";this.__RS=RS;", c); const tight = c.__RS.buildCompactPrompt ? c.__RS.buildCompactPrompt({ siteName: "ChatGPT", providerId: "chatgpt" }) : ""; return !c.__RS.buildCompactPrompt || tight.length <= 14000; })());
ok("E9 README documents the 2.10.0 verification release", /2\.10\.0/.test(read("README.md")) && /place_checkpoint/.test(read("README.md")) && /ui_test/.test(read("README.md")) && /screenshot_compare/.test(read("README.md")));

console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-verify-pack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
