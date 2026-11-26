#!/usr/bin/env node
// 2.0.0 — Blender → Studio textures ride with the mesh (EditableImage).
//   tools/blender_ops.py    dump: base-colour image per material -> downsampled
//                           RGBA (base64), first user carries the blob, others the key
//   src/core/meshimport.js  planImport/luau: validate the blob, dedupe, Luau that
//                           decodes base64 -> buffer -> EditableImage ->
//                           SurfaceAppearance.ColorMapContent (fallback TextureContent)
//   main.js / background.js textures / texture_size parameters, publish gate text
// Run from the TotalScript root:  node tests/test-mesh-textures.js
// Mocked only: fake bpy (tests/fixtures/fakebpy_asset), lupa Studio stand-in
// (tests/fixtures/run_mesh_import_luau.py). Live Blender / Studio = not tested here.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
process.chdir(path.resolve(__dirname, ".."));
const MI = require("../src/core/meshimport.js");
const A = require("../src/core/assetplan.js");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 400) : "")); } };
const main = fs.readFileSync("src/core/main.js", "utf8");
const bg = fs.readFileSync("background.js", "utf8");
const opsPy = fs.readFileSync("tools/blender_ops.py", "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "total-tex-"));
const py = (file, args, env) => spawnSync("python3", [file].concat(args || []), { encoding: "utf8", timeout: 120000, env: Object.assign({}, process.env, env || {}) });
const hasLupa = spawnSync("python3", ["-c", "import lupa"]).status === 0;

// ── pixel packing (pure python, exec'd without bpy) ─────────────────────────
const pySrc = opsPy.slice(opsPy.indexOf("def _srgb_byte("), opsPy.indexOf("def material_base_image("));
const packProbe = py("python3", []) && spawnSync("python3", ["-c", pySrc + `
import base64, json
# 2x2, bottom row first: bottom-left red, bottom-right green, top-left blue, top-right white(alpha .5)
px = [1,0,0,1, 0,1,0,1, 0,0,1,1, 1,1,1,0.5]
b = base64.b64decode(rgba_rows_to_b64(px, 2, 2))
lin = base64.b64decode(rgba_rows_to_b64([0.2140,0.2140,0.2140,1]*4, 2, 2, True))
print(json.dumps({"bytes": list(b), "lin": list(lin[:4]), "clamp": _srgb_byte(2.0, False), "nan": _srgb_byte(float("nan"), False)}))
`], { encoding: "utf8" });
const pack = (() => { try { return JSON.parse(packProbe.stdout.trim()); } catch { return null; } })();
ok("P1 rgba_rows_to_b64 flips rows to top-first RGBA bytes (top-left blue, bottom-right green)", pack && pack.bytes.join() === [0, 0, 255, 255, 255, 255, 255, 128, 255, 0, 0, 255, 0, 255, 0, 255].join(), packProbe.stderr || JSON.stringify(pack));
ok("P2 float (linear) images get the sRGB transfer (0.214 linear -> ~128), bytes clamp, NaN -> 0", pack && Math.abs(pack.lin[0] - 128) <= 1 && pack.clamp === 255 && pack.nan === 0, JSON.stringify(pack));
ok("P3 dump caps: 16..512 px, default 256, 2.4 M base64 budget; textures off when uvs are off", /TEXTURE_SIZE_DEFAULT = 256/.test(opsPy) && /TEXTURE_SIZE_MAX = 512/.test(opsPy) && /TEXTURE_BUDGET = 2400000/.test(opsPy) && /want_textures = ARGS\.get\("textures"\) is not False and want_uvs/.test(opsPy));
ok("P4 material_base_image: TEX_IMAGE linked into Base Color (via node_tree.links), else the baked total_tex_base_color map; copies are removed", /link\.to_node == bsdf and link\.to_socket == sock/.test(opsPy) && /total_tex_base_color/.test(opsPy) && /bpy\.data\.images\.remove\(copy\)/.test(opsPy));
ok("P5 cmd_dump reports textures / texture_bytes / textures_skipped", /"textures": sorted\(set\(m\["texture"\]\["key"\]/.test(opsPy) && /"textures_skipped": list\(TEXTURE_SKIPPED\)/.test(opsPy));

// ── fake Blender dump with a textured material ──────────────────────────────
const blaster = A.plan("sci-fi plasma blaster with cyan glow");
function runBlender(steps) {
  const f = path.join(tmp, "steps-" + Math.random().toString(36).slice(2) + ".json");
  fs.writeFileSync(f, JSON.stringify(steps));
  const r = py("tests/fixtures/run_blender_asset.py", [f, path.join(tmp, "ws")]);
  try { return JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { return { error: String(r.stdout).slice(-800) + String(r.stderr).slice(-800) }; }
}
const res = (out, cmd, nth) => { const list = (out.results || []).filter((r) => r.cmd === cmd); const r = list[nth || 0]; return r && r.result ? r.result : null; };
const out = runBlender([
  ["asset_build", { spec: blaster.spec }],
  ["__fake__", { add_base_texture: "Blaster_body", image: "body_albedo.png", w: 64, h: 32 }],
  ["dump", { objects: ["Blaster"] }],
  ["dump", { objects: ["Blaster"], texture_size: 32 }],
  ["dump", { objects: ["Blaster"], textures: false }],
]);
const d1 = res(out, "dump", 0), d2 = res(out, "dump", 1), d3 = res(out, "dump", 2);
const withTex = d1 ? d1.meshes.filter((m) => m.texture) : [];
const blobs = withTex.filter((m) => m.texture.rgba_b64), refs = withTex.filter((m) => !m.texture.rgba_b64);
ok("B1 (mock) dump: every Blaster_body part carries the texture - ONE blob, the rest references to the same key", d1 && d1.ok && withTex.length >= 2 && blobs.length === 1 && refs.length === withTex.length - 1 && refs.every((m) => m.texture.key === blobs[0].texture.key), out.error || JSON.stringify(d1 && { n: d1.meshes.length, tex: d1.textures, skipped: d1.textures_skipped }).slice(0, 400));
ok("B2 (mock) blob: 64x32 RGBA kept (under the cap), bytes = w*h*4, base64 length matches, source node, key sanitised", blobs[0] && blobs[0].texture.w === 64 && blobs[0].texture.h === 32 && blobs[0].texture.bytes === 64 * 32 * 4 && blobs[0].texture.rgba_b64.length === Math.ceil(64 * 32 * 4 / 3) * 4 && blobs[0].texture.source === "node" && blobs[0].texture.key === "body_albedo.png", JSON.stringify(blobs[0] && { ...blobs[0].texture, rgba_b64: blobs[0].texture.rgba_b64.slice(0, 12) }));
ok("B3 (mock) dump summary lists the texture key + bytes, nothing skipped; parts of other materials carry no texture", d1 && d1.textures.join() === "body_albedo.png" && d1.texture_bytes === 64 * 32 * 4 && d1.textures_skipped.length === 0 && d1.meshes.some((m) => !m.texture), JSON.stringify(d1 && d1.textures));
ok("B4 (mock) texture_size:32 downsamples 64x32 -> 32x16 (aspect kept); textures:false carries nothing", d2 && d2.meshes.some((m) => m.texture && m.texture.w === 32 && m.texture.h === 16) && d3 && !d3.meshes.some((m) => m.texture), JSON.stringify(d2 && d2.meshes.filter((m) => m.texture && m.texture.w).map((m) => [m.texture.w, m.texture.h])));
const b64 = blobs[0] ? blobs[0].texture.rgba_b64 : "";
const bytes = Buffer.from(b64, "base64");
ok("B5 (mock) pixel rows are top-first: first pixel red (top row), last pixel blue (right column), alpha 255", bytes.length === 64 * 32 * 4 && bytes[0] === 255 && bytes[2] === 0 && bytes[3] === 255 && bytes[bytes.length - 4] === 0 && bytes[bytes.length - 2] === 255, Array.from(bytes.slice(0, 4)).join() + " … " + Array.from(bytes.slice(-4)).join());

// ── planImport / luau (pure JS) ─────────────────────────────────────────────
const tri = { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [0, 1, 2], tris: 1, uvs: [[[0, 0], [1, 0], [0, 1]]] };
const small = Buffer.alloc(16 * 16 * 4, 0); for (let i = 0; i < 16 * 16; i++) { small[i * 4] = i < 16 ? 255 : 0; small[i * 4 + 2] = i >= 16 * 15 ? 255 : 0; small[i * 4 + 3] = 255; }
const blob = { key: "albedo.png", w: 16, h: 16, rgba_b64: small.toString("base64"), source: "node" };
const meshes = [
  Object.assign({ name: "A", object: "A", material: { name: "M", color: [1, 1, 1], textures: [{ image: "albedo.png" }] }, texture: blob }, tri),
  Object.assign({ name: "B", object: "B", material: { name: "M", color: [1, 1, 1], textures: [{ image: "albedo.png" }] }, texture: { key: "albedo.png" } }, tri),
  Object.assign({ name: "C", object: "C", material: { name: "M2", color: [1, 0, 0], textures: [{ image: "x.png" }] } }, tri),
  Object.assign({ name: "D", object: "D", texture: { key: "bad", w: 16, h: 16, rgba_b64: "AAAA" } }, tri),
  Object.assign({ name: "E", object: "E", texture: { key: "huge", w: 4096, h: 4096, rgba_b64: "AAAA" } }, tri),
];
const plan = MI.planImport(meshes, {});
const P = Object.fromEntries(plan.parts.map((p) => [p.name, p]));
ok("J1 planImport: A carries the blob, B is a reference, C has no texture, D/E dropped with reasons", P.A.texture.rgba_b64 && P.A.texture.bytes === 1024 && P.B.texture.ref === true && !P.C.texture && /blob is 3 bytes, expected 1024/.test(P.D.texture.dropped) && /outside 16\.\.512/.test(P.E.texture.dropped), JSON.stringify(plan.parts.map((p) => [p.name, p.texture && (p.texture.dropped || (p.texture.ref ? "ref" : "blob"))])));
ok("J2 planImport: the 'image textures lost' note is cleared for carried textures and replaced by the live-content note; C keeps the lost note; dropped ones become problems", !P.A.material.lost.some((l) => /^image textures/.test(l)) && P.A.material.lost.some((l) => /live EditableImage content/.test(l)) && P.C.material.lost.some((l) => /^image textures/.test(l)) && plan.problems.some((p) => /D: texture bad dropped/.test(p)) && plan.problems.some((p) => /E: texture huge dropped/.test(p)) && plan.textures.carried === 1 && plan.textures.referenced === 1 && plan.textures.dropped === 2, JSON.stringify(plan.problems));
ok("J3 planImport: the same blob twice in one call -> second becomes a reference (dedupe per run)", (() => { const p2 = MI.planImport([meshes[0], Object.assign({}, meshes[0], { name: "A2", object: "A2" })], {}); return p2.parts[0].texture.rgba_b64 && p2.parts[1].texture.ref === true; })());
const code = MI.luau(meshes, "Workspace", 20, {});
ok("J4 luau payload: texture {key,w,h,b64} on A, {key} on B, null on C/D/E; the Luau has the base64 decoder, EditableImage, WritePixelsBuffer, SurfaceAppearance.ColorMapContent + TextureContent fallback, attributes, verify.textures", /"texture":\{"key":"albedo.png","w":16,"h":16,"b64":"/.test(code) && /"texture":\{"key":"albedo.png"\},"verts"/.test(code) && (code.match(/"texture":null/g) || []).length === 3 && /local function b64ToBuffer\(s, expect\)/.test(code) && /AssetService:CreateEditableImage\(\{ Size = Vector2\.new\(w, h\) \}\)/.test(code) && /WritePixelsBuffer\(Vector2\.zero, Vector2\.new\(w, h\), buf\)/.test(code) && /sa\.ColorMapContent = content/.test(code) && /part\.TextureContent = content/.test(code) && /TotalTextureKey/.test(code) && /verify\.textures = \{ applied = 0, reused = 0, unavailable = 0, failed = 0, live = true/.test(code));
ok("J5 luau: every texture step is pcall-guarded and only MeshParts get textures; publish uploads the image via CreateAssetAsync(Image) and records PublishedTextureId", /pcall\(function\(\) return AssetService:CreateEditableImage/.test(code) && /pcall\(function\(\) imgOrErr:WritePixelsBuffer/.test(code) && /if entry\.texture and method == "EditableMesh" then texNote = applyTexture/.test(code) && /texture skipped \(no MeshPart\)/.test(code) && /CreateAssetAsync\(imgOrErr, Enum\.AssetType\.Image/.test(code) && /PublishedTextureId/.test(code));
ok("J6 luau stays chunkable: no line longer than ~3100 chars (3000-char JSON pieces)", code.split("\n").every((l) => l.length < 3100));

// ── Studio stand-in (lupa) ──────────────────────────────────────────────────
function runStudio(importCode, mode, verifyCode) {
  const a = path.join(tmp, "imp-" + mode + ".luau");
  fs.writeFileSync(a, importCode);
  const args = [a];
  if (verifyCode) { const b = path.join(tmp, "ver-" + mode + ".luau"); fs.writeFileSync(b, verifyCode); args.push(b); }
  args.push(mode);
  const r = py("tests/fixtures/run_mesh_import_luau.py", args);
  try { return JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { return { error: String(r.stdout).slice(-800) + String(r.stderr).slice(-800) }; }
}
if (!hasLupa) { console.log("skip lupa Studio stand-in (pip install lupa)"); }
else {
  const s1 = runStudio(code, "editable");
  const sas = (s1.tree || []).filter((n) => n.class === "SurfaceAppearance");
  const v1 = (() => { try { return JSON.parse(String(s1.import).split("\nverify: ")[1]); } catch { return null; } })();
  ok("S1 (lupa) import: A gets a NEW EditableImage 16x16 written once (1024 bytes, top-left red, bottom-right blue), B REUSES it via the folder lookup", s1.images && s1.images.length === 1 && s1.images[0].w === 16 && s1.images[0].h === 16 && s1.images[0].bytes === 1024 && s1.images[0].first.join() === "255,0,0,255" && s1.images[0].last.join() === "0,0,255,255" && v1 && v1.textures.applied === 1 && v1.textures.reused === 1, s1.error || JSON.stringify({ images: s1.images, tex: v1 && v1.textures, imp: String(s1.import).slice(0, 300) }));
  ok("S2 (lupa) two SurfaceAppearances (A and B) with TotalTextureKey / TotalTextureLive attributes and the same content; parts carry TextureKey + TextureLive true", sas.length === 2 && sas.every((s) => s.attrs.TotalTextureKey === "albedo.png" && s.attrs.TotalTextureLive === true && s.has_content && s.image_size && s.image_size[0] === 16) && (s1.tree || []).filter((n) => n.class === "MeshPart" && n.attrs.TextureKey === "albedo.png" && n.attrs.TextureLive === true).length === 2, JSON.stringify(sas));
  ok("S3 (lupa) the report names the texture per part (new vs reused) and the dropped ones never reached Studio (C/D/E have no SurfaceAppearance)", /A: MeshPart[^\n]*texture albedo\.png \(EditableImage 16x16\) via SurfaceAppearance/.test(String(s1.import)) && /B: MeshPart[^\n]*texture albedo\.png \(reused\) via SurfaceAppearance/.test(String(s1.import)) && !(s1.tree || []).some((n) => n.class === "SurfaceAppearance" && !/\.(A|B)\./.test(n.path + ".")) && v1.textures.failed === 0 && v1.parts.filter((p) => p.texture === "albedo.png").length === 2, String(s1.import).slice(0, 500));
  const s2 = runStudio(code, "noimage");
  const v2 = (() => { try { return JSON.parse(String(s2.import).split("\nverify: ")[1]); } catch { return null; } })();
  ok("S4 (lupa) EditableImage unavailable: meshes still import as MeshParts, textures reported 'unavailable' (A) + 'missing' (B reference), no SurfaceAppearance, no crash", v2 && v2.real === 5 && v2.textures.unavailable === 1 && v2.textures.failed === 1 && v2.textures.applied === 0 && !(s2.tree || []).some((n) => n.class === "SurfaceAppearance") && /not applied: EditableImage unavailable/.test(String(s2.import)) && /missing \(reference without blob in this run\)/.test(String(s2.import)), s2.error || JSON.stringify(v2 && v2.textures) + String(s2.import).slice(0, 300));
  const codePub = MI.luau(meshes.slice(0, 2), "Workspace", 20, { publish: true });
  const s3 = runStudio(codePub, "editable");
  ok("S5 (lupa) publish:true uploads the image once as an Image asset (CreateAssetAsync Image) next to the meshes; the part records PublishedTextureId and TextureLive false", (s3.published || []).filter((p) => p.type === "Image").length === 1 && (s3.published || []).filter((p) => p.type === "Mesh").length === 2 && (s3.tree || []).some((n) => n.class === "MeshPart" && n.name === "A" && /^\d+$/.test(String(n.attrs.PublishedTextureId)) && n.attrs.TextureLive === false) && /published as rbxassetid:\/\/\d+/.test(String(s3.import)), s3.error || JSON.stringify({ pub: s3.published, imp: String(s3.import).slice(0, 300) }));
  const sv = runStudio(code, "editable", MI.verifyLuau("Workspace.Total_Imported", { textures: 2 }));
  const sv3 = runStudio(code, "editable", MI.verifyLuau("Workspace.Total_Imported", { textures: 3 }));
  ok("S7 (lupa) mesh_import_verify reads the textures back: 2 live, 0 published, key albedo.png x2, honest live-content note; expect textures:3 -> problem", sv.verify && sv.verify.textures && sv.verify.textures.live === 2 && sv.verify.textures.published === 0 && sv.verify.textures.keys["albedo.png"] === 2 && /not saved with the place/.test(sv.verify.textures.note) && sv3.verify && sv3.verify.ok === false && sv3.verify.problems.some((p) => /expected 3 textured part\(s\), found 2/.test(p)), (sv.error || "") + JSON.stringify(sv.verify && sv.verify.textures) + (sv.verify_error || "") + JSON.stringify(sv3.verify && sv3.verify.problems));
  const s4 = runStudio(code, "noeditable");
  ok("S6 (lupa) no EditableMesh at all -> bounding-box Parts, 'texture skipped (no MeshPart)', no EditableImage created", s4.images && s4.images.length === 0 && /texture skipped \(no MeshPart\)/.test(String(s4.import)) && !(s4.tree || []).some((n) => n.class === "SurfaceAppearance"), s4.error || String(s4.import).slice(0, 300));
}

// ── wiring ──────────────────────────────────────────────────────────────────
ok("W1 main.js: runAssetBridgeImport forwards textures / texture_size to blender_mesh_dump and the publish approval mentions the Image assets", /name: "blender_mesh_dump", arguments: \{ filepath: asset, asset, objects: a\.objects, textures: a\.textures !== false && a\.textures !== "false", texture_size: a\.texture_size \}/.test(main) && /each mesh as a Mesh asset[^"]*texture as an Image asset/.test(main));
ok("W2 main.js: skipped textures from the dump are reported to the model (never silently dropped)", /texturesSkipped/.test(main) && /Textures not carried:/.test(main));
ok("W3 background.js: blender_send_to_studio schema has textures (boolean) + texture_size (number) and the description says what a live EditableImage texture is", /textures: \{ type: "boolean", description: "[^"]*base-colour[^"]*"/.test(bg) && /texture_size: \{ type: "number", description: "[^"]*512[^"]*"/.test(bg) && /EditableImage/.test(bg.split('btool("blender_send_to_studio"')[1].split("\n")[0]) && /not saved with the place/.test(bg.split('btool("blender_send_to_studio"')[1].split("\n")[0]));
ok("W4 meshimport.js header documents the honest limits (live content, publish via plugin, base colour only)", /live content only \(an EditableImage is NOT saved with the\n\/\/\s+place; publish:true uploads it as an Image asset through the local\n\/\/\s+plugin\), one base-colour map per material, no normal \/ roughness maps/.test(fs.readFileSync("src/core/meshimport.js", "utf8")));

console.log(`\ntest-mesh-textures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
