// 1.51.2 — LUAU LIBRARY CACHE: skill programs are "library + body"; main.js
// uploads the library once per place (non-archivable StringValue under
// ServerStorage._TotalLuauLib) and ships only the body per command, so a GUI
// command is ONE bridge round trip instead of 2-5 chunk trips. The simulator
// half lives in tests/luau-lib-sim.py; this file pins the JS contract.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let fails = 0, n = 0;
function ok(name, cond, detail) { n++; if (!cond) { fails++; console.log("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); } }

const main = read("src/core/main.js");
ok("skill branch runs programs through runSkillLuau (library cache aware)", main.includes("      let res = await runSkillLuau(built, slowBudget);") && main.includes("async function runSkillLuau(built, budget) {"));
ok("cache lives in ServerStorage._TotalLuauLib, bounded to 12 libraries, NON-archivable (never saved with the place)", main.includes('const LUAU_LIB_FOLDER = "_TotalLuauLib";') && main.includes("const LUAU_LIB_KEEP = 12;") && main.includes('f.Archivable=false f.Parent=ss end') && main.includes('m.Archivable=false m.Parent=f'));
ok("library id = FNV-1a hash + UTF-8 byte length; the probe checks the byte length so a half-uploaded library never runs", main.includes('return "lib_" + h.toString(16).padStart(8, "0") + "_" + luauByteLen(lib);') && main.includes('and #m.Value==" + bytes + ") then return \\"TOTAL_LIB_MISSING " + id + "\\" end"'));
ok("exec = loadstring(library .. body) in ONE trip, named chunk", main.includes('"local fn,err=loadstring(m.Value..\\"\\\\n\\".." + luauLongStr(body) + ",\\"=TotalScript\\")"'));
ok("missing library → chunked upload → re-run; any transport trouble falls back to the classic single program", main.includes("if (!/^Output of '[^']*':\\n?TOTAL_LIB_MISSING\\b/.test(String(res || \"\"))) return res;") && main.includes("return plain(); // transport trouble: fall back to the classic path for this call") && main.includes('diag("luauLib.stillMissing", { id }); return plain();'));
ok("small programs and huge bodies keep the old path (no behaviour change below LUAU_CHUNK_MAX)", main.includes("if (!lib || !body || !built.code || built.code.length <= LUAU_CHUNK_MAX || lib.length < 4000) return plain();") && main.includes("if (exec0.length > LUAU_CHUNK_MAX) return plain();"));
ok("upload pieces are cut at line ends only and re-join verbatim", main.includes("function splitLuauPieces(src, max) {") && main.includes('if (buf && next.length > max) { out.push(buf + "\\n"); buf = line; } else buf = next;'));
ok("internal pieces never re-chunk, never prompt, never hit the schema pre-flight", main.includes("arguments: { code: exec0, datamodel_type: \"Edit\", _totalInternal: true, _totalChunk: true, _totalTimeout: budget || undefined }"));

// every skill pack exposes lib/body next to code
global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
const S = RobloxScriptSkills;
const probes = {
  ui_build_spec: { spec: { screen: { name: "X" }, children: [{ class: "Frame", name: "A" }] } },
  ui_layout_report: { path: "game.StarterGui.X" }, ui_export_spec: { path: "game.StarterGui.X" }, ui_component: { kind: "button" },
  quality_audit: { path: "game.StarterGui.X" }, design_tokens_set: { preset: "ocean" }, ui_audit: { path: "game.StarterGui.X" }, ui_screen_create: { name: "X" },
  ui_tokens_apply: { path: "game.StarterGui.X" }, ui_align: { paths: ["game.StarterGui.X.A"], mode: "left" },
};
const sizes = {};
for (const [op, args] of Object.entries(probes)) {
  const b = S.buildLuau(op, args);
  ok(op + ": builder returns code + lib + body with code === lib + \"\\n\" + body", b && !b.err && typeof b.lib === "string" && typeof b.body === "string" && b.code === b.lib + "\n" + b.body, b && (b.err || Object.keys(b)));
  if (b && !b.err) sizes[op] = { code: b.code.length, lib: b.lib.length, body: b.body.length };
}
ok("GUI-brief commands are all > 18 KB programs whose BODY is small - the cache turns 2-5 trips into one", Object.values(sizes).every((s) => s.code > 18000 && s.body < 12000), sizes);
ok("one shared GUI Studio library across the GUI Studio commands", ["ui_build_spec", "ui_layout_report", "ui_export_spec", "ui_component", "ui_screen_create"].map((op) => S.buildLuau(op, probes[op]).lib).every((l, _, arr) => l === arr[0]));
// generic packs with the plain HEAD + body shape
let withLib = 0;
for (const op of S.SKILL_OPS.slice(0, 400)) { try { const b = S.buildLuau(op, {}); if (b && !b.err && typeof b.lib === "string" && typeof b.body === "string") withLib++; } catch {} }
ok("most skill packs expose the library split (sampled 400 ops)", withLib > 200, withLib);

if (fails) { console.log(`test-luau-lib: ${fails} FAILED, ${n - fails} passed`); process.exit(1); }
console.log(`test-luau-lib: ${n} checks passed`);
