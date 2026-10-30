// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript mesh kit (1.99.1) - Studio-side verification for Blender imports.
//
// Phase 116 audit: blender_send_to_studio reported "N real MeshParts" from the
// same Luau that built them and nothing could read the result back, so an
// import was "done" the moment the code returned. mesh_import_verify walks the
// DataModel afterwards (parts, real vs placeholder, materials, sizes, pivots,
// attachments, extent, naming) and lists problems. Structural only - it says so.
//
// Commands: mesh_import_verify. Luau comes from src/core/meshimport.js
// (TotalMeshImport.verifyLuau) so the importer and the verifier share one
// definition of "what a good import looks like".
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "1.99.6";
  const MI = (typeof TotalMeshImport !== "undefined" && TotalMeshImport) || (typeof window !== "undefined" && window.TotalMeshImport) || null;

  const C = [
    { name: "mesh_import_verify", description: "Read a Blender import back from the DataModel (default Workspace.Total_Imported): part count, real MeshParts vs bounding-box placeholders, Enum.Material per part, sizes, Model pivots + PrimaryParts, attachments, total extent in studs, default / numbered names. Optional expectations (parts, min_real, extent [x,y,z] studs) become problems when unmet. Run it after every blender_send_to_studio - the import is finished only when problems is empty (visual quality still needs a screenshot).", params: { path: { type: "string", desc: "instance path (default Workspace.Total_Imported)" }, parts: { type: "integer", desc: "expected BasePart count" }, min_real: { type: "integer", desc: "minimum real MeshParts" }, extent: { type: "array", desc: "expected [x,y,z] extent in studs (25 % tolerance)" } } },
  ];

  function build(op, args) {
    if (op !== "mesh_import_verify") return null;
    const a = args || {};
    if (!MI || typeof MI.verifyLuau !== "function") return { err: "ERROR building mesh_import_verify: src/core/meshimport.js is not loaded" };
    try {
      const code = MI.verifyLuau(String(a.path || ""), { parts: a.parts, min_real: a.min_real, extent: Array.isArray(a.extent) ? a.extent : null });
      return { code, lib: "", body: code };
    } catch (e) {
      return { err: "ERROR building mesh_import_verify: " + (e && e.message || e) };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = build(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.MESHKIT_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.MESHKIT_VERSION = VERSION;
})();
