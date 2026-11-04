// 2.9.0 — DEVICE PACK: device_audit / device_fix (src/core/skills/studio_device.js).
// Static half: registration, schemas, JS-side validation, builder shape (lib +
// body for the Luau library cache), contract compatibility, catalogue placement,
// wiring into manifest / codecraft.html / prompts / hints, prompt budgets,
// honest-output rules. The Luau itself runs in tests/device-sim.py.
// Run: node tests/test-device-pack.js
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
const NAMES = ["device_audit", "device_fix"];
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
const src = read("src/core/skills/studio_device.js");
const LIB = S.DEVICE_LIB;

// ── A. registration ───────────────────────────────────────────────────────────
ok("A1 pack exports DEVICE_COMMANDS (2 names) + VERSION 2.9.1 + LIB + FIX_OPS (6) + DEFAULT_OPS (4) + DEVICES (4) + validateDevice", JSON.stringify(S.DEVICE_COMMANDS) === JSON.stringify(NAMES) && S.DEVICE_VERSION === "2.9.1" && typeof LIB === "string" && JSON.stringify(S.DEVICE_FIX_OPS) === JSON.stringify(["text_constraints", "min_touch_size", "selectable", "safe_insets", "scale_sizes", "aspect_images"]) && JSON.stringify(S.DEVICE_DEFAULT_OPS) === JSON.stringify(["text_constraints", "min_touch_size", "selectable", "safe_insets"]) && JSON.stringify(S.DEVICE_DEVICES) === JSON.stringify(["phone", "tablet", "console", "pc"]) && typeof S.validateDevice === "function");
ok("A2 both are registered ONCE, visible, with description + params", NAMES.every((n) => byName.has(n) && !byName.get(n).hidden && byName.get(n).description.length > 200 && Object.keys(byName.get(n).params).length >= 2) && S.SKILL_COMMANDS.filter((c) => NAMES.includes(c.name)).length === 2);
ok("A3 SKILL_COMMANDS spliced, not reassigned; SKILL_OPS lists the names", /const arr = RobloxScriptSkills\.SKILL_COMMANDS;[\s\S]*?for \(const c of C\) arr\.push\(c\);/.test(src) && !/RobloxScriptSkills\.SKILL_COMMANDS\s*=/.test(src) && NAMES.every((n) => S.SKILL_OPS.includes(n)));
ok("A4 nothing is required: both run place-wide without path; device_fix params ops / min_touch / min_text / max_text / baseline", NAMES.every((n) => Object.values(byName.get(n).params).every((p) => p.req === false)) && ["path", "ops", "min_touch", "min_text", "max_text", "baseline"].every((k) => byName.get("device_fix").params[k]));
ok("A5 descriptions are honest: 'simulated layout', 'Lines, not a score', 'Scripts are never rewritten', device emulator named", /simulated layout/.test(byName.get("device_audit").description) && /Lines, not a score/.test(byName.get("device_audit").description) && /device emulator/.test(byName.get("device_audit").description) && /Scripts are never rewritten/.test(byName.get("device_fix").description));

// ── B. builder shape ──────────────────────────────────────────────────────────
const b = S.buildLuau("device_audit", { path: "StarterGui.Hud" });
ok("B1 builder returns { code, lib, body } with code === lib + '\\n' + body (runSkillLuau cache contract)", b && !b.err && b.code === b.lib + "\n" + b.body && b.lib === LIB);
ok("B2 library > 12000 chars, body small (the lib uploads once per place)", b.lib.length > 12000 && b.body.length < 300, { lib: b.lib.length, body: b.body.length });
ok("B3 body = JSONDecode of the args in a [==[ ]==] long string + DV.run(op)", /HttpService:JSONDecode\(\[==\[\{"path":"StarterGui\.Hud"\}\]==\]\)/.test(b.body) && /return DV\.run\("device_audit", __a\)/.test(b.body));
ok("B4 args containing ']==]' are refused", (() => { const r = S.buildLuau("device_audit", { path: "a]==]print(1)--" }); return r && r.err && /]==]/.test(r.err); })());
ok("B5 library is pure ASCII and has no Luau-only syntax (+=, continue, //, backticks)", !/[^\x00-\x7f]/.test(LIB) && !/\+=|\bcontinue\b|[^/]\/\/[^/]|`/.test(LIB));
ok("B6 one namespace (local DV = {}) and every result goes through okj / failj JSON", /local DV = \{\}/.test(LIB) && /local function okj\(d, t\) return HttpService:JSONEncode\(\{ ok = true, data = d or \{\}, text = t or "" \}\) end/.test(LIB) && /local function failj\(m\)/.test(LIB) && /return failj\("unknown device op "/.test(LIB));

// ── C. audit semantics in the Luau ────────────────────────────────────────────
ok("C1 four device profiles: phone 844x390 touch, tablet 1180x820 touch, console 1920x1080 gamepad, pc 1280x720; topbar 58 px; touch minimum 36 px; touch-control zone 220 px", /id = "phone", w = 844, h = 390, touch = true/.test(LIB) && /id = "tablet", w = 1180, h = 820, touch = true/.test(LIB) && /id = "console", w = 1920, h = 1080, touch = false, gamepad = true/.test(LIB) && /id = "pc", w = 1280, h = 720/.test(LIB) && /local TOPBAR = 58/.test(LIB) && /local TOUCH_MIN = 36/.test(LIB) && /local TOUCH_ZONE = 220/.test(LIB));
ok("C2 real layout pass: UDim2 Scale+Offset, AnchorPoint, UIPadding, UIScale, UISizeConstraint clamp, UIAspectRatioConstraint (dominant axis), UIListLayout stacking, IgnoreGuiInset root", /local w = sz\.X\.Scale \* pr\.w \+ sz\.X\.Offset/.test(LIB) && /- ap\.X \* w/.test(LIB) && /childOfClass\(inst, "UIPadding"\)/.test(LIB) && /childOfClass\(inst, "UIScale"\)/.test(LIB) && /childOfClass\(inst, "UISizeConstraint"\)/.test(LIB) && /DominantAxis/.test(LIB) && /childOfClass\(parent, "UIListLayout"\)/.test(LIB) && /gui\.IgnoreGuiInset == true/.test(LIB));
const RULES = ["touch_target", "offset_only_size", "offscreen", "topbar_overlap", "touch_controls_overlap", "text_unbounded", "text_small", "text_tv", "text_clipped", "image_stretch", "scrollbar_thin", "safe_insets", "gamepad_unreachable", "gamepad_entry", "keyboard_only", "mouse_api"];
ok("C3 all 16 rules exist by name", RULES.every((r) => new RegExp('"' + r + '"').test(LIB)), RULES.filter((r) => !new RegExp('"' + r + '"').test(LIB)));
ok("C4 every finding carries rule / severity / path / class / device / detail / fix", /\{ rule = rule, severity = sev, path = full\(inst\), class = inst\.ClassName, device = dev, detail = detail, fix = fix \}/.test(LIB));
ok("C5 keyboard-only detection = Enum.KeyCode + InputBegan/InputEnded/IsKeyDown without ContextActionService / BindAction / Touch / Gamepad; scans GUI scripts + StarterPlayerScripts + StarterCharacterScripts; fix names BindAction(..., true, KeyCode, ButtonX)", /src:find\("Enum%\.KeyCode%\."\) and \(src:find\("InputBegan"\) or src:find\("InputEnded"\) or src:find\("IsKeyDown"\)\)/.test(LIB) && /src:find\("ContextActionService"\) or src:find\("BindAction"\) or src:find\("UserInputType%\.Touch"\)/.test(LIB) && /StarterPlayer:FindFirstChild\("StarterPlayerScripts"\)/.test(LIB) && /StarterPlayer:FindFirstChild\("StarterCharacterScripts"\)/.test(LIB) && /ContextActionService:BindAction\(name, handler, true, Enum\.KeyCode\./.test(LIB));
ok("C6 no numeric score anywhere - verdict is blockers / warnings / notes per device", !/score/i.test(LIB) && /blocker\(s\), " \.\. d\.warn \.\. " warning\(s\), " \.\. d\.info \.\. " note\(s\)/.test(LIB));
ok("C7 honesty: verified = static_layout_simulation and the text sends the user to the Studio device emulator", /verified = "static_layout_simulation"/.test(LIB) && /confirm on the Studio device emulator \(Test tab\) for the final word/.test(LIB));
ok("C8 audit never mutates: no property assignment in DV.audit / auditGui / auditScripts", (() => { const seg = LIB.slice(LIB.indexOf("local function auditGui"), LIB.indexOf("function DV.fix")); return !/\binst\.[A-Z]\w* = /.test(seg) && !/\bg\.[A-Z]\w* = /.test(seg); })());

// ── D. fix semantics ──────────────────────────────────────────────────────────
ok("D1 default ops are the four safe ones; scale_sizes / aspect_images opt-in", /a\.ops or \{ "text_constraints", "min_touch_size", "selectable", "safe_insets" \}/.test(LIB) && /if ops\.scale_sizes then/.test(LIB) && /if ops\.aspect_images and/.test(LIB));
ok("D2 text_constraints adds UITextSizeConstraint only where missing; min_touch_size raises (never lowers) an existing UISizeConstraint; selectable only flips false -> true; safe_insets only None -> DeviceSafeInsets", /inst\.TextScaled == true and not childOfClass\(inst, "UITextSizeConstraint"\)/.test(LIB) && /c\.MinSize = Vector2\.new\(math\.max\(mn\.X, minTouch\), math\.max\(mn\.Y, minTouch\)\)/.test(LIB) && /inst:IsA\("GuiButton"\) and inst\.Selectable == false then inst\.Selectable = true/.test(LIB) && /insets\.Name == "None" then g\.ScreenInsets = Enum\.ScreenInsets\.DeviceSafeInsets/.test(LIB));
ok("D3 scale_sizes: offset-only Size -> Scale relative to the parent's baseline rect (height under the topbar), pixel Position offsets folded into Scale (also the 'Scale 1, Offset -90' corner idiom), UIAspectRatioConstraint for 0.5..2 ratios", /sz\.X\.Scale == 0 and sz\.Y\.Scale == 0 and \(sz\.X\.Offset > 0 or sz\.Y\.Offset > 0\)/.test(LIB) && /local nx = r1\(\(pos\.X\.Scale \+ pos\.X\.Offset \/ parentW\) \* 1000\) \/ 1000/.test(LIB) && /ratio > 0\.5 and ratio < 2 and not childOfClass\(inst, "UIAspectRatioConstraint"\)/.test(LIB) && /parentH = bh - TOPBAR/.test(LIB));
ok("D4 one ChangeHistory waypoint per run, only when something changed; changes list capped at 60 with a truncated count", /if total > 0 then waypoint\("TotalScript device_fix"\) end/.test(LIB) && /if #changes < 60 then changes\[#changes \+ 1\]/.test(LIB) && /truncated_changes = math\.max\(0, total - #changes\)/.test(LIB));
ok("D5 scripts are never written by device_fix (no .Source assignment in the fix half)", !/\.Source\s*=/.test(LIB.slice(LIB.indexOf("function DV.fix"))));

// ── E. JS-side validation + contract ─────────────────────────────────────────
const err = (op, a) => { const r = S.buildLuau(op, a); return r && r.err ? r.err : null; };
ok("E1 device_audit: limit outside 1..500 refused; path must be a string", /1\.\.500/.test(err("device_audit", { limit: 0 }) || "") && /1\.\.500/.test(err("device_audit", { limit: 999 }) || "") && /dotted string/.test(err("device_audit", { path: 5 }) || "") && !err("device_audit", {}) && !err("device_audit", { path: "StarterGui.X", limit: 20 }));
ok("E2 device_fix: unknown / empty ops, min_touch outside 24..96, min_text / max_text ranges, min > max, bad baseline refused", /unknown op\(s\) zap/.test(err("device_fix", { ops: ["zap"] }) || "") && /non-empty array/.test(err("device_fix", { ops: [] }) || "") && /24\.\.96/.test(err("device_fix", { min_touch: 10 }) || "") && /8\.\.40/.test(err("device_fix", { min_text: 2 }) || "") && /12\.\.200/.test(err("device_fix", { max_text: 500 }) || "") && /must not exceed/.test(err("device_fix", { min_text: 30, max_text: 20 }) || "") && /\[width, height\]/.test(err("device_fix", { baseline: [10] }) || ""));
ok("E3 valid calls build for every op", S.DEVICE_FIX_OPS.every((op) => !err("device_fix", { ops: [op] })) && !err("device_fix", { path: "StarterGui.Hud", ops: ["scale_sizes"], baseline: [1920, 1080], min_touch: 44, min_text: 14, max_text: 40 }));
ok("E4 contract: device_audit is read-only (audit suffix), device_fix mutating; ops array passes through untouched", (() => { const a = CC.contract("device_audit"), f = CC.contract("device_fix"); const r = CC.prepare("device_fix", { ops: ["selectable", "safe_insets"], min_touch: 40 }); return a && a.mutating !== true && f && f.mutating === true && r.ok && JSON.stringify(r.args.ops) === JSON.stringify(["selectable", "safe_insets"]) && r.args.min_touch === 40; })());

// ── F. wiring ─────────────────────────────────────────────────────────────────
const main = read("src/core/main.js"), config = read("src/core/config.js");
ok("F1 manifest: studio_device.js loads right after studio_perf.js and before main.js in every Studio bundle (" + bundles.length + "); codecraft.html too", bundles.length >= 10 && bundles.every((c) => { const i = c.js.indexOf("src/core/skills/studio_perf.js"), j = c.js.indexOf("src/core/skills/studio_device.js"), k = c.js.indexOf("src/core/main.js"); return i > -1 && j === i + 1 && j < k; }) && (() => { const h = read("codecraft.html"); const i = h.indexOf("studio_perf.js"), j = h.indexOf("studio_device.js"); return i > -1 && j > i; })());
ok("F2 tests/test-command-dedup.js loads the pack", /"studio_device\.js"/.test(read("tests/test-command-dedup.js")));
ok("F3 catalogue family: device_* -> UI & HUD (the GUI pillar), device_audit in the audit tier", (() => { const cut = (a, c) => { const i = main.indexOf(a), j = main.indexOf(c, i); return main.slice(i, j); }; const block = cut("const COMMAND_FAMILIES = [", "];"); return /id: "ui"[^\n]*device_\|/.test(block); })());
ok("F4 NEXT_STEP hints for device_audit / device_fix point at real follow-ups (device_fix, script_set_source, the emulator)", /device_audit: "Next: device_fix \{ops: fix_ops from the audit\}/.test(main) && /script_set_source/.test(main.match(/device_audit: "[^"]+"/)[0]) && /device_fix: "Next: device_audit again to confirm; test on the Studio device emulator/.test(main));
ok("F5 config prompt: the VERIFY line teaches device_audit / device_fix", /\\`device_audit\\` \{path\?\} lays every GUI out on phone \/ tablet \/ console/.test(config) && /\\`device_fix\\` \{ops\} clears the mechanical ones/.test(config));
ok("F6 visible catalogue ceiling moved to 630 (2 device commands) and the count matches the pin", /never above 630/.test(read("tests/test-not-implemented.js")) && S.SKILL_COMMANDS.filter((c) => !c.hidden).length === 630, S.SKILL_COMMANDS.filter((c) => !c.hidden).length);
ok("F7 prompt budgets still hold (Gemini full < 48000, ChatGPT compact <= 14000)", (() => { const c = { window: {}, console, chrome: global.chrome }; c.window = c; c.window.__rsWorkMode = () => "creation"; vm.createContext(c); vm.runInContext(config + ";this.__RS=RS;", c); const full = c.__RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" }); const tight = c.__RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 }); return full.length < 48000 && tight.length <= 14000; })());
ok("F8 README documents 2.9.0 with both commands, the device-sim and the honesty caveat", /\*\*2\.9\.0 — Mobile \/ console readiness/.test(read("README.md")) && /device_audit/.test(read("README.md")) && /device_fix/.test(read("README.md")) && /device-sim\.py/.test(read("README.md")) && /node tests\/test-device-pack\.js/.test(read("README.md")));

console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-device-pack: ${pass} passed, ${fail} failed (static - the Luau runs in tests/device-sim.py; the Studio device emulator is still the final word)`);
process.exit(fail ? 1 : 0);
