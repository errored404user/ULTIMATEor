// 1.84.0 - Blender failure handling end to end (MOCK Blender: fixtures/fakebpy_asset).
// blender_ops.py must answer every failure with a structured class + allowed
// values + hint (never a traceback tail), background.js must keep those fields,
// and main.js must render them for the model. blender_introspect is read-only.
const fs = require("fs"), vm = require("vm"), path = require("path"), cp = require("child_process"), os = require("os");
process.chdir(path.join(__dirname, ".."));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " :: " + String(detail).slice(0, 500) : "")); } }

const work = fs.mkdtempSync(path.join(os.tmpdir(), "total-blender-errors-"));
const steps = [
  ["__fake__", { add_broken_mesh: "Crate" }],
  ["add_modifier", { name: "Crate", type: "SUBDIVISION SURFACE" }],
  ["add_modifier", { name: "Crate", type: "bevel", width: 0.03, segments: 3 }],
  ["modifier_configure", { name: "Crate", modifier: "Bevel", properties: { limit_method: "BOGUS" } }],
  ["modifier_configure", { name: "Crate", modifier: "Bevel", properties: { nonexistent_prop: 1 } }],
  ["modifier_configure", { name: "Crate", modifier: "Nope", properties: { width: 1 } }],
  ["introspect", { name: "Crate" }],
  ["introspect", { name: "Nope" }],
  ["introspect", {}],
  ["remove_modifier", { name: "Crate", type: "BEVEL" }],
  ["introspect", { name: "Crate" }],
  ["nonsense_cmd", {}],
  ["set_material", { name: "Nope", color: [1, 0, 0] }],
];
const stepsFile = path.join(work, "steps.json");
fs.writeFileSync(stepsFile, JSON.stringify(steps));
let data;
try {
  data = JSON.parse(cp.execFileSync("python3", ["tests/fixtures/run_blender_asset.py", stepsFile, work], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  console.log("SKIP  python3 / fake bpy unavailable: " + String(e.message).slice(0, 200));
  process.exit(0);
}
const R = data.results.map((r) => r.result);
ok("no step escaped as a raw Python exception", data.results.every((r) => !r.exception), JSON.stringify(data.results.filter((r) => r.exception).map((r) => r.cmd + ": " + r.exception.message)));

const badKind = R[1];
ok("unknown modifier kind → invalid_enum + allowed list + hint (deterministic)", badKind && badKind.ok === false && badKind.error_class === "invalid_enum" && badKind.deterministic === true && Array.isArray(badKind.allowed) && badKind.allowed.includes("SUBSURF") && /pick one of/.test(badKind.hint), JSON.stringify(badKind));
ok("valid kind (case-folded 'bevel') is applied", R[2] && R[2].ok === true && R[2].modifier === "BEVEL", JSON.stringify(R[2]));
const badEnum = R[3];
ok("bpy enum TypeError → invalid_enum with the parsed allowed values and the parameter", badEnum && badEnum.ok === false && badEnum.error_class === "invalid_enum" && JSON.stringify(badEnum.allowed) === JSON.stringify(["NONE", "ANGLE", "WEIGHT", "VGROUP"]) && badEnum.parameter === "limit_method" && badEnum.value === "BOGUS", JSON.stringify(badEnum));
const badProp = R[4];
ok("unknown modifier property → unknown_parameter naming it", badProp && badProp.error_class === "unknown_parameter" && badProp.parameter === "nonexistent_prop" && /blender_introspect/.test(badProp.hint), JSON.stringify(badProp));
const noMod = R[5];
ok("missing modifier → resource_missing + the real modifier names", noMod && noMod.error_class === "resource_missing" && Array.isArray(noMod.available) && noMod.available.includes("Bevel"), JSON.stringify(noMod));
const intro = R[6];
ok("introspect(Crate): object transform, modifiers, mesh counts, catalogue of enums", intro && intro.ok === true && intro.object && intro.object.name === "Crate" && intro.object.modifiers.length === 1 && intro.object.modifiers[0].type === "BEVEL" && intro.object.mesh && intro.object.mesh.vertices === 8 && intro.modifier_types.includes("BEVEL") && Array.isArray(intro.render_engines) && intro.note === "read-only", JSON.stringify(intro).slice(0, 400));
ok("introspect(Nope): resource_missing + list of real objects", R[7] && R[7].ok === false && R[7].error_class === "resource_missing" && R[7].objects.some((o) => o.name === "Crate"), JSON.stringify(R[7]).slice(0, 300));
ok("introspect() without a name is ok (scene-level)", R[8] && R[8].ok === true && Array.isArray(R[8].objects));
ok("remove_modifier by type then introspect shows none", R[9] && R[9].ok === true && R[10] && R[10].object.modifiers.length === 0);
ok("unknown command stays an explicit error", R[11] && R[11].ok === false && /unknown blender command/.test(R[11].error));
ok("introspect changed nothing (no operator / render / export logged at all for the read-only steps)", Array.isArray(data.log.ops) && data.log.renders.length === 0 && data.log.exports.length === 0, JSON.stringify(data.log).slice(0, 200));

// ── background.js keeps the fields ─────────────────────────────────────────
const bg = fs.readFileSync("background.js", "utf8");
const fnSrc = bg.slice(bg.indexOf("function blenderStructuredError("), bg.indexOf("async function blenderCall("));
const bse = new Function(fnSrc + "; return blenderStructuredError;")();
const kept = bse(badEnum, "Blender command failed");
ok("blenderStructuredError keeps error_class / allowed / hint / parameter / value and drops nothing needed", kept.ok === false && kept.error === badEnum.error && kept.error_class === "invalid_enum" && JSON.stringify(kept.allowed) === JSON.stringify(badEnum.allowed) && kept.hint === badEnum.hint && kept.parameter === "limit_method" && kept.value === "BOGUS", JSON.stringify(kept));
ok("blenderStructuredError falls back to the generic text when the script gave none", bse({ ok: false }, "Blender FBX failed").error === "Blender FBX failed");

// ── main.js renders them ───────────────────────────────────────────────────
const main = fs.readFileSync("src/core/main.js", "utf8");
const renderSrc = main.slice(main.indexOf("function blenderErrorText(name, r) {"), main.indexOf("function contractAnnotate(name, res, prep) {"));
const render = new Function(renderSrc + "; return blenderErrorText;")();
const txt = render("blender_modifier_configure", kept);
ok("rendered error starts with ERROR calling, carries [blender] class + allowed + Fix line", /^ERROR calling 'blender_modifier_configure': bpy_struct/.test(txt) && /\[blender\] class=invalid_enum \(deterministic - the same call will fail again\); parameter=limit_method; value=BOGUS; allowed=\[NONE, ANGLE, WEIGHT, VGROUP\]/.test(txt) && /\nFix: 'BOGUS' is not a valid choice here/.test(txt), txt);
ok("plain errors render unchanged", render("blender_x", { ok: false, error: "boom" }) === "ERROR calling 'blender_x': boom");

// ── the contract classifies the rendered text the same way ────────────────
const C = require(path.join(process.cwd(), "src/core/command_contract.js"));
const k = C.classify("blender_modifier_configure", txt);
ok("TotalCommandContract.classify agrees: invalid_enum, deterministic → loop guard will block an identical resend", k.category === "invalid_enum" && k.deterministic === true, JSON.stringify(k));

try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? "FAILED" : "OK   "} test-blender-errors: ${pass} passed, ${fail} failed (MOCK Blender - tests/fixtures/fakebpy_asset; no real Blender involved)`);
process.exit(fail ? 1 : 0);
