// 1.84.0 - command contract + self-repair: every Studio skill call is checked
// against the pack's REAL parameter schema before Luau is built (aliases, enum
// spellings, vector / colour shapes, ranges), failures are classified with a
// next step, identical deterministic failures are blocked by the loop guard,
// and the Blender tool schemas agree with the Python handlers.
// Mocked - no AI site, Studio or Blender involved.
const fs = require("fs"), vm = require("vm"), path = require("path");
process.chdir(path.join(__dirname, ".."));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " :: " + String(detail).slice(0, 400) : "")); } }

global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const C = require(path.join(process.cwd(), "src/core/command_contract.js"));
const S = RobloxScriptSkills;

// ── wiring ──────────────────────────────────────────────────────────────────
ok("module version 1.93.0", C.VERSION === "1.93.0", C.VERSION);
const lists = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/command_registry.js"));
ok("command_contract.js follows command_registry.js in every manifest list (" + lists.length + ")", lists.length >= 12 && lists.every((c) => c.js.indexOf("src/core/command_contract.js") === c.js.indexOf("src/core/command_registry.js") + 1));
ok("codecraft.html loads the contract", /command_registry\.js"><\/script>\s*<script src="src\/core\/command_contract\.js">/.test(fs.readFileSync("codecraft.html", "utf8")));
const main = fs.readFileSync("src/core/main.js", "utf8");
ok("main.js: contract prepared BEFORE the checkpoint hook and buildLuau", (() => { const a = main.indexOf("const prepS = contractPrepare(name, args);"), b = main.indexOf("window.__rsBeforeTool(name, args)", a), c = main.indexOf("RobloxScriptSkills.buildLuau(name, args)", b); return a > 0 && b > a && c > b && c - a < 6000; })());
ok("main.js: a rejected call returns the schema message without running", main.includes("if (!prepS.ok) return prepS.message;") && main.includes("if (!prepA.ok) return prepA.message;"));
ok("main.js: skill results are annotated with the failure class", main.includes("res = contractAnnotate(name, res, prepS);"));
ok("main.js: loop guard blocks identical deterministic repeats before runTool", main.includes("const blocked = repeatBlocked(call);") && main.includes("feedback = blocked !== null ? blocked : await runTool(call);") && main.includes("CONTRACT.repeatDecision("));
ok("main.js: Blender calls get the schema pre-flight + structured error rendering", main.includes("const missingB = requiredParamsMissing(bt, args || {});") && main.includes("return contractAnnotate(bareName, blenderErrorText(name, r), null);") && main.includes("[blender] ${bits.join(\"; \")}"));
const cfg = fs.readFileSync("src/core/config.js", "utf8");
ok("config.js teaches the NOT run / [diagnosis] protocol and blender_introspect", cfg.includes("\"NOT run\" errors: nothing ran - fix ONLY the named parameter(s), resend; follow \"[diagnosis]\".") && cfg.includes("blender_introspect {name?}"));

// ── contracts from the packs ────────────────────────────────────────────────
const ms = C.contract("material_set");
ok("material_set contract: path required string, material enum, color optional colour", ms && ms.params.path.required && ms.params.path.type === "string" && ms.params.material.enumKey === "Material" && ms.params.material.enum.includes("SmoothPlastic") && !ms.params.color.required && ms.params.color.color === true, JSON.stringify(ms && ms.params));
ok("schemaLine renders the real signature", C.schemaLine("material_set") === "material_set {path: string, material: Enum.Material, color?: [r,g,b]}", C.schemaLine("material_set"));
ok("unknown command → null contract and prepare passes through untouched", C.contract("nope_cmd") === null && C.prepare("nope_cmd", { a: 1 }).ok === true && C.prepare("nope_cmd", { a: 1 }).args.a === 1);
let built = 0, broken = [];
for (const cmd of S.SKILL_COMMANDS) { try { const c = C.contract(cmd.name); if (c) built++; } catch (e) { broken.push(cmd.name + ": " + e.message); } }
ok("a contract builds for every one of the " + S.SKILL_COMMANDS.length + " pack commands", built === S.SKILL_COMMANDS.length && broken.length === 0, broken.slice(0, 3).join(" | "));
// every pack command with no required params must pass prepare({}) (no false rejections)
let falseRejects = [];
for (const cmd of S.SKILL_COMMANDS) { const req = Object.entries(cmd.params || {}).filter(([, v]) => v && v.req).map(([k]) => k); if (!req.length) { const p = C.prepare(cmd.name, {}); if (!p.ok) falseRejects.push(cmd.name); } }
ok("no command without required params is rejected on {}", falseRejects.length === 0, falseRejects.slice(0, 5).join(","));

// ── prepare: missing / alias / enum / vector / colour / range / type ───────
let p = C.prepare("material_set", {});
ok("missing params → MISSING_PARAMS, NOT run, lists the enum choices and the schema", !p.ok && /^ERROR MISSING_PARAMS calling 'material_set'/.test(p.message) && /NOT run/.test(p.message) && /- path: missing parameter/.test(p.message) && /Enum\.Material \(Plastic, Wood/.test(p.message) && /Schema: material_set \{path: string/.test(p.message) && /Fix only the listed parameter/.test(p.message), p.message);
p = C.prepare("material_set", { target_path: "Workspace.Part", material: "smooth plastic" });
ok("alias target_path→path and 'smooth plastic'→SmoothPlastic are corrected, not rejected", p.ok && p.args.path === "Workspace.Part" && !("target_path" in p.args) && p.args.material === "SmoothPlastic" && p.corrections.some((c) => c.kind === "alias") && p.corrections.some((c) => c.kind === "enum"), JSON.stringify(p));
p = C.prepare("material_set", { path: "Workspace.P", material: "Enum.Material.Neon" });
ok("'Enum.Material.Neon' prefix stripped", p.ok && p.args.material === "Neon");
p = C.prepare("material_set", { path: "Workspace.P", material: "Steel" });
ok("'Steel' → INVALID_ENUM with a real list (never silently Plastic)", !p.ok && /^ERROR INVALID_ENUM/.test(p.message) && /'Steel' is not a Roblox Material/.test(p.message) && p.problems[0].code === "invalid_enum", p.message);
p = C.prepare("material_set", { path: "Workspace.A", target_path: "Workspace.B", material: "Neon" });
ok("alias AND canonical with different values → conflict, not a silent pick", !p.ok && /conflicting parameters/.test(p.message), p.message);
p = C.prepare("material_set", { path: "Workspace.A", target_path: "Workspace.A", material: "Neon" });
ok("alias AND canonical with the same value → fine", p.ok && p.args.path === "Workspace.A" && !("target_path" in p.args));
p = C.prepare("tween_create", { path: "Workspace.P", to: "[1,2,3]", easing: "sine", direction: "inout" });
ok("reverse alias path→target_path + EasingStyle / EasingDirection fold", p.ok && p.args.target_path === "Workspace.P" && p.args.easing === "Sine" && p.args.direction === "InOut", JSON.stringify(p.args));
p = C.prepare("part_create", { Position: { x: 1, y: 2, z: 3 }, size: "4,2,4", colour: [0.5, 0.2, 0.1], material: "wood planks" });
ok("vector shapes ({x,y,z}, '4,2,4') and 0-1 colours normalized", p.ok && JSON.stringify(p.args.position) === "[1,2,3]" && JSON.stringify(p.args.size) === "[4,2,4]" && JSON.stringify(p.args.color) === "[128,51,26]" && p.args.material === "WoodPlanks", JSON.stringify(p.args));
p = C.prepare("part_create", { color: "red", position: [0, 0, 0], size: [1, 1, 1] });
ok("named colours pass through (packs map them)", p.ok && p.args.color === "red");
p = C.prepare("part_create", { color: "#ff8800", position: [0, 0, 0], size: [1, 1, 1] });
ok("hex colour → [r,g,b]", p.ok && JSON.stringify(p.args.color) === "[255,136,0]");
p = C.prepare("instance_move", { path: "Workspace.P", position: [1, "a", 3] });
ok("non-numeric vector → INVALID_PARAMS naming the param", !p.ok && /- position: invalid type/.test(p.message) && /\[x, y, z\]/.test(p.message), p.message);
p = C.prepare("transparency_set", { path: "Workspace.P", transparency: 5 });
ok("range 0..1 enforced, not clamped", !p.ok && /out of range - expected 0\.\.1/.test(p.message) && /not clamped/.test(p.message), p.message);
p = C.prepare("transparency_set", { path: "Workspace.P", transparency: "0.5" });
ok("numeric strings coerced", p.ok && p.args.transparency === 0.5);
p = C.prepare("decal_add", { path: "Workspace.P", texture: "rbxassetid://1", face: "top" });
ok("NormalId fold: 'top' → Top", p.ok && p.args.face === "Top", JSON.stringify(p.args));
p = C.prepare("gfx_pose", { path: "Workspace.Rig", face: "happy" });
ok("gfx_* face is an expression, NOT NormalId (exception list)", p.ok && p.args.face === "happy");
p = C.prepare("terrain_fill_region", { material: "rock", position: [0, 0, 0], size: [4, 4, 4] });
ok("terrain: lowercase 'rock' → Rock (Lua handler does Enum.Material[matName]) and position→cframe", p.ok && p.args.material === "Rock" && JSON.stringify(p.args.cframe) === "[0,0,0]", JSON.stringify(p.args));
p = C.prepare("ui_set_font", { path: "StarterGui.X", font: "gotham bold" });
ok("Enum.Font fold 'gotham bold' → GothamBold", p.ok && p.args.font === "GothamBold");
p = C.prepare("highlight_add", { path: "Workspace.P", bogus: 1 });
ok("unknown parameters are warned, never dropped and never fatal", p.ok && p.args.bogus === 1 && p.warnings.some((w) => /unknown parameter\(s\)/.test(w)), JSON.stringify(p.warnings));
p = C.prepare("material_set", { path: "Workspace.P", material: "Neon", _totalInternal: true, _totalTimeout: 5000 });
ok("_total* internal keys are ignored", p.ok && !p.warnings.length);

// ── classify / annotate / repeat ───────────────────────────────────────────
const k = (t) => C.classify("x", t).category;
ok("classify: missing/invalid schema answers are deterministic", k("ERROR MISSING_PARAMS calling 'a': …") === "missing_parameter" && C.classify("x", "ERROR INVALID_ENUM calling 'a'").deterministic === true && k("ERROR INVALID_PARAMS calling 'a'") === "invalid_parameter");
ok("classify: Luau member / property errors", k("ERROR in execute_luau: Workspace.X is not a valid member of Workspace") === "invalid_property" && k("ERROR in execute_luau: Steel is not a valid EnumItem") === "invalid_enum");
ok("classify: timeout is transient + uncertain", (() => { const c = C.classify("x", "ERROR STUDIO_TIMEOUT: tool 'execute_luau' timed out"); return c.category === "timeout" && c.transient && c.uncertain; })());
ok("classify: offline bridge is transient, not retry-blocked", (() => { const c = C.classify("x", "ERROR calling 'x': Blender is not connected"); return c.category === "backend_unavailable" && c.transient && !c.deterministic; })());
ok("classify: Blender enum message", k("Error executing code: TypeError: bpy_struct: item.attr = val: enum \"FOO\" not found in ('NONE', 'ANGLE')") === "invalid_enum");
ok("classify: not found → invalid_reference (retry after locating)", (() => { const c = C.classify("material_set", "ERROR in material_set: not found: Workspace.Nope"); return c.category === "invalid_reference" && c.retryable && !c.deterministic; })());
ok("classify: permission / user action", k("ERROR USER_ACTION_REQUIRED in publish: the user did not answer") === "permission_denied");
ok("classify: syntax", k("ERROR in execute_luau: Failed to parse command code: Expected ')'") === "syntax_error");
ok("classify: success → ok", C.classify("x", "Output of 'x':\n{\"ok\":true}").ok === true);
const ann = C.annotate("material_set", "ERROR in material_set: not found", C.prepare("material_set", { target_path: "a", material: "Neon", foo: 1 }));
ok("annotate appends [diagnosis] with class, next step, unknown params and normalizations", /\n\[diagnosis\] invalid_reference; next: locate the real target first/.test(ann) && /unknown parameter\(s\) for material_set: foo/.test(ann) && /normalized: path <- target_path/.test(ann), ann);
ok("annotate on success adds nothing when there is nothing to say", C.annotate("material_set", "Output of 'material_set':\nok", C.prepare("material_set", { path: "a", material: "Neon" })) === "Output of 'material_set':\nok");
const sigA = C.signature("material_set", { target_path: "Workspace.P", material: "smooth plastic" });
const sigB = C.signature("material_set", { material: "SmoothPlastic", path: "Workspace.P" });
ok("signature is normalization- and order-independent", sigA === sigB, sigA + " vs " + sigB);
const prevDet = { sig: sigA, text: "ERROR INVALID_ENUM calling 'material_set'", klass: C.classify("material_set", "ERROR INVALID_ENUM calling 'material_set'") };
ok("repeatDecision blocks an identical call after a deterministic failure", C.repeatDecision(prevDet, sigA, 1).block === true);
ok("repeatDecision lets a CHANGED call through", C.repeatDecision(prevDet, C.signature("material_set", { path: "Workspace.P", material: "Neon" }), 1).block === false);
const prevTimeout = { sig: sigA, text: "ERROR STUDIO_TIMEOUT: timed out", klass: C.classify("x", "ERROR STUDIO_TIMEOUT: timed out") };
ok("repeatDecision never blocks a transient failure (timeout / offline)", C.repeatDecision(prevTimeout, sigA, 2).block === false && C.repeatDecision(prevTimeout, sigA, 5).block === false);
// 1.87.0: post-timeout hold for MUTATING calls (opt-in via prev.mutating) + transient budget.
const prevTimeoutMut = Object.assign({}, prevTimeout, { mutating: true, at: Date.now() });
const held = C.repeatDecision(prevTimeoutMut, sigA, 1);
ok("repeatDecision HOLDS an identical MUTATING call once after a timeout (it may have run) and says to read the state back", held.block === true && held.hold === true && /MAY have run/.test(held.reason) && /inspect_instance|instance_find/.test(held.reason), JSON.stringify(held));
ok("after the hold was delivered (uncertainHeld) the identical call goes through", C.repeatDecision(Object.assign({}, prevTimeoutMut, { uncertainHeld: true }), sigA, 2).block === false);
ok("a READ call is never held after a timeout", C.repeatDecision(Object.assign({}, prevTimeout, { mutating: false, at: Date.now() }), sigA, 1).block === false);
ok("the hold expires with the repeat window (an old timeout does not block a later retry)", C.repeatDecision(Object.assign({}, prevTimeoutMut, { at: Date.now() - C.REPEAT_WINDOW_MS - 1 }), sigA, 1).block === false);
const offline = { sig: sigA, text: "ERROR MCP_CONNECTION_REFUSED: bridge not connected", klass: C.classify("x", "ERROR MCP_CONNECTION_REFUSED: bridge not connected"), at: Date.now() };
ok("transient failures (offline bridge) are retried up to the budget, then blocked with a 'tell the user' reason", C.repeatDecision(offline, sigA, C.TRANSIENT_BUDGET - 1).block === false && C.repeatDecision(offline, sigA, C.TRANSIENT_BUDGET).block === true && /tell the user/.test(C.repeatDecision(offline, sigA, C.TRANSIENT_BUDGET).reason));
ok("the transient budget block expires with the window too", C.repeatDecision(Object.assign({}, offline, { at: Date.now() - C.REPEAT_WINDOW_MS - 1 }), sigA, 9).block === false);
ok("main.js feeds mutating / at / uncertainHeld into the decision and latches the hold once", main.includes("mutating: REPEAT.mutating, uncertainHeld: REPEAT.uncertainHeld") && main.includes("if (d.hold) REPEAT.uncertainHeld = true;") && main.includes("REPEAT.uncertainHeld = false;"));
const prevRef = { sig: sigA, text: "ERROR in material_set: not found", klass: C.classify("x", "ERROR in material_set: not found") };
ok("repeatDecision blocks a non-transient failure only from the 3rd identical attempt", C.repeatDecision(prevRef, sigA, 1).block === false && C.repeatDecision(prevRef, sigA, 2).block === false && C.repeatDecision(prevRef, sigA, 3).block === true);

// ── Blender: btool schema vs blender_ops.py handler drift ─────────────────
const bg = fs.readFileSync("background.js", "utf8");
const start = bg.indexOf("function btool("), end = bg.indexOf("\n];", bg.indexOf("const BLENDER_TOOLS = [")) + 3;
const ctx = {}; vm.createContext(ctx); vm.runInContext(bg.slice(start, end) + ";this.T=BLENDER_TOOLS;", ctx);
const tools = ctx.T;
const cs = bg.indexOf("const BLENDER_CMD"), ce = bg.indexOf("\n};", cs);
const cmdMap = {}; for (const m of bg.slice(cs, ce + 3).matchAll(/([A-Za-z0-9_]+)\s*:\s*"([a-z0-9_]+)"/g)) cmdMap[m[1]] = m[2];
const py = fs.readFileSync("tools/blender_ops.py", "utf8");
const handlers = {}; const re = /^def cmd_([a-z0-9_]+)\(\):\n([\s\S]*?)(?=^def |^DISPATCH)/gm; let m;
while ((m = re.exec(py))) { const args = new Set(); for (const a of m[2].matchAll(/ARGS\.get\(\s*["']([a-z0-9_]+)["']/g)) args.add(a[1]); for (const a of m[2].matchAll(/ARGS\[["']([a-z0-9_]+)["']\]/g)) args.add(a[1]); handlers[m[1]] = [...args]; }
// Handler-level aliases: the handler reads `canonical or alias`; the canonical name IS in the schema.
const HANDLER_ALIASES = { asset: ["filepath"], name: ["parent", "collection"], location: ["offset"], degrees: ["rotation_deg"], size: ["dimensions"], rgb: ["color"], modifier: ["type"], type: ["operation"] };
const drift = [];
for (const t of tools) {
  const cmd = cmdMap[t.name] || t.name.replace(/^blender_/, ""); const h = handlers[cmd]; if (!h) continue;
  const props = Object.keys(t.inputSchema.properties || {});
  const missing = h.filter((a) => !props.includes(a) && !(HANDLER_ALIASES[a] && HANDLER_ALIASES[a].some((c) => props.includes(c))));
  if (missing.length) drift.push(t.name + " lacks " + missing.join(","));
}
ok("ZERO schema drift: every argument a blender_ops.py handler reads is in its btool schema (" + tools.length + " tools)", drift.length === 0, drift.join(" | "));
const addMod = tools.find((t) => t.name === "blender_add_modifier");
ok("blender_add_modifier schema exposes the per-kind settings + enum", addMod && ["width", "segments", "thickness", "count", "offset", "axis", "ratio", "operation"].every((k) => addMod.inputSchema.properties[k]) && Array.isArray(addMod.inputSchema.properties.type.enum) && addMod.inputSchema.properties.type.enum.includes("BEVEL"));
ok("enums declared for light / origin / boolean / mirror / decimate", ["blender_add_light", "blender_set_origin", "blender_boolean", "blender_mirror", "mesh_decimate"].every((n) => { const t = tools.find((x) => x.name === n); const pr = t && t.inputSchema.properties; return pr && Object.values(pr).some((v) => Array.isArray(v.enum) && v.enum.length >= 3); }));
ok("blender_introspect + blender_remove_modifier are real tools mapped to handlers", tools.some((t) => t.name === "blender_introspect") && cmdMap.blender_introspect === "introspect" && handlers.introspect && tools.some((t) => t.name === "blender_remove_modifier") && handlers.remove_modifier);
ok("blender_ops.py classifies exceptions (no bare traceback) and validates modifier kinds", py.includes("emit(classify_exception(exc, CMD))") && py.includes('"error_class": "invalid_enum"') && py.includes("unsupported modifier type: ") && !/except Exception:\n    emit\(\{"ok": False, "error": traceback\.format_exc\(\)/.test(py));
ok("blender_asset.py shares the classifier", /def classify_exception/.test(fs.readFileSync("tools/blender_asset.py", "utf8")) && fs.readFileSync("tools/blender_asset.py", "utf8").includes("return emit(classify_exception(e, CMD))"));
ok("background.js keeps the structured fields (blenderStructuredError)", bg.includes("function blenderStructuredError(result, fallback)") && bg.includes("return blenderStructuredError(result, \"Blender command failed\");") && /"error_class", "deterministic", "allowed", "hint"/.test(bg));

// ── Luau: material_set / part_create never swallow a bad Enum.Material ─────
const daily = fs.readFileSync("src/core/skills/studio_daily.js", "utf8");
ok("material_set Luau validates the enum via pcall, fails loudly, verifies by read-back", daily.includes("local okm,matv=pcall(function() return Enum.Material.${mat} end)") && daily.includes("is not a valid Enum.Material - nothing was changed") && daily.includes("verified by read-back"));
ok("part_create reports material_applied instead of silently keeping Plastic", daily.includes("material_applied=okm"));

console.log(`\n${fail ? "FAILED" : "OK   "} test-command-contract: ${pass} passed, ${fail} failed (mocked - no AI site, Studio or Blender involved)`);
process.exit(fail ? 1 : 0);
