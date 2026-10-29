// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript mesh importer (1.99.0) - Blender dump -> Roblox Studio build.
//
// Replaces the 1.46 single-colour / flat-hierarchy importer in main.js
// (studioMeshLuau delegates here when this module is loaded; the old function
// stays as the fallback). What changed, per Phase 116 audit defect:
//   * one MeshPart per material slot (dump_meshes splits objects per material)
//   * split normals (smooth / auto-smooth) via AddNormal + SetFaceNormals,
//     flat shading only when Blender says flat
//   * UVs via AddUV + SetFaceUVs when the dump carries them
//   * explicit PBR -> Roblox translation (Enum.Material + Color + Reflectance +
//     Transparency; emissive -> Neon) recorded as attributes - never a claim
//     that the Blender shader survived
//   * Model per asset (root empty) and per multi-material object, stable
//     names (Sword_Blade -> Sword.Blade), PrimaryPart = primary-role part,
//     WorldPivot at the Blender asset origin, attachments from ATT_* empties
//   * collision from the spec (box / hull / precise / none) - never silently
//     disabled, never silently Default-everything
//   * a verification payload (mesh_import_verify reads it back)
// Pure JS; exposes window.TotalMeshImport + module.exports.
(function (root) {
  "use strict";
  const VERSION = "1.99.0";
  const MATERIALS = ["Plastic", "SmoothPlastic", "Neon", "Wood", "WoodPlanks", "Marble", "Slate", "Concrete", "Granite", "Brick", "Pebble", "Cobblestone", "Rock", "Sandstone", "Basalt", "CrackedLava", "Limestone", "Pavement", "CorrodedMetal", "DiamondPlate", "Foil", "Metal", "Grass", "LeafyGrass", "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt", "Salt", "Ice", "Glacier", "Glass", "ForceField", "Cardboard", "Carpet", "CeramicTiles", "ClayRoofTiles", "RoofShingles", "Leather", "Plaster", "Rubber"];
  const FIDELITY = { box: "Box", hull: "Hull", precise: "PreciseConvexDecomposition", default: "Default", none: "Box" };
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // Blender Principled parameters -> what Roblox can actually show.
  function mapMaterial(pbr) {
    const m = pbr || {};
    const out = { material: "SmoothPlastic", reflectance: 0, transparency: 0, color: null, source: "default", lost: [] };
    const c = Array.isArray(m.color) && m.color.length >= 3 ? m.color.slice(0, 3).map(clamp01) : null;
    if (c) out.color = c;
    const metallic = clamp01(m.metallic), roughness = m.roughness == null ? 0.5 : clamp01(m.roughness), alpha = m.alpha == null ? 1 : clamp01(m.alpha);
    const emissive = Array.isArray(m.emission) && Number(m.emission_strength) > 0;
    if (m.roblox && MATERIALS.includes(String(m.roblox))) { out.material = String(m.roblox); out.source = "spec"; }
    else if (emissive) { out.material = "Neon"; out.source = "emission"; }
    else if (alpha < 0.98) { out.material = "Glass"; out.source = "alpha"; }
    else if (metallic >= 0.5) { out.material = roughness > 0.6 ? "CorrodedMetal" : "Metal"; out.source = "metallic"; }
    else if (roughness >= 0.8) { out.material = "Plastic"; out.source = "roughness"; }
    else { out.material = "SmoothPlastic"; out.source = "roughness"; }
    if (emissive && out.material === "Neon" && Array.isArray(m.emission)) out.color = m.emission.slice(0, 3).map(clamp01);
    if (alpha < 0.98) out.transparency = r3(1 - alpha);
    if (metallic >= 0.5 && roughness < 0.35 && out.material !== "Neon") out.reflectance = r3(Math.min(0.5, (0.35 - roughness) * 1.2));
    if (emissive && out.material !== "Neon") out.lost.push("emission (" + out.material + " is not emissive; use Neon or a SurfaceAppearance)");
    if (Array.isArray(m.textures) && m.textures.length) out.lost.push("image textures (" + m.textures.length + " - the mesh bridge carries no images; upload them as Image assets and add a SurfaceAppearance manually)");
    if (m.wear) out.lost.push("procedural wear nodes (flat base colour only)");
    if (metallic > 0 && metallic < 0.5) out.lost.push("partial metallic " + r3(metallic));
    return out;
  }

  const partName = (entryName, asset) => {
    let n = String(entryName || "Mesh");
    if (asset && n.indexOf(asset + "_") === 0) n = n.slice(asset.length + 1);
    n = n.replace(/\.\d{3}$/, "");
    return n || "Mesh";
  };

  // JS-side plan: grouping, naming, material / collision decisions. Pure, testable.
  function planImport(meshes, opts) {
    const o = opts || {};
    const assets = {};
    for (const a of Array.isArray(o.assets) ? o.assets : []) if (a && a.name) assets[a.name] = a;
    const groups = [];
    const byKey = {};
    const parts = [];
    const problems = [];
    let idx = 0;
    for (const e of Array.isArray(meshes) ? meshes : []) {
      if (!e || !Array.isArray(e.verts) || !e.verts.length || !Array.isArray(e.faces) || !e.faces.length) { problems.push((e && e.name) + ": empty mesh skipped"); continue; }
      const asset = e.parent && assets[e.parent] ? e.parent : (e.parent || null);
      const objectName = String(e.object || e.name || "Mesh");
      const multi = !!(e.object && e.name !== e.object);
      const props = e.props || {};
      const mat = mapMaterial(e.material || (e.color ? { color: e.color } : null));
      if (!mat.color && Array.isArray(e.color)) mat.color = e.color.slice(0, 3).map(clamp01);
      const collisionKey = String(props.collision || o.collision || "default").toLowerCase();
      const fidelity = FIDELITY[collisionKey] || "Default";
      const canCollide = props.can_collide === false || collisionKey === "none" ? false : true;
      const groupKey = asset ? "asset:" + asset : (multi ? "object:" + objectName : null);
      let group = null;
      if (groupKey) {
        if (!byKey[groupKey]) { byKey[groupKey] = { key: groupKey, name: asset ? asset : partName(objectName, null), kind: asset ? "asset" : "object", pivot: asset && assets[asset] && Array.isArray(assets[asset].pivot) ? assets[asset].pivot : (Array.isArray(e.pivot) ? e.pivot : null), parts: [], attachments: [] }; groups.push(byKey[groupKey]); }
        group = byKey[groupKey];
      }
      let name = asset ? partName(objectName, asset) : partName(e.name, null);
      if (asset && multi) name = partName(objectName, asset) + "_" + String(e.name).slice(objectName.length + 1).replace(new RegExp("^" + asset + "_"), "");
      else if (!asset && multi) name = String(e.name).slice(objectName.length + 1) || name;
      const p = { index: idx++, entry: e, name, group: group ? group.key : null, asset, object: objectName, material: mat, fidelity, canCollide, role: String(props.role || ""), tris: Number(e.tris) || Math.floor(e.faces.length / 3), hasUV: Array.isArray(e.uvs) && e.uvs.length > 0, hasNormals: Array.isArray(e.normals) && e.normals.length > 0, flat: e.flat === true, pivotGroup: props.pivot_group || null };
      parts.push(p);
      if (group) group.parts.push(p.index);
    }
    for (const a of Array.isArray(o.attachments) ? o.attachments : []) {
      if (!a || !a.name || !Array.isArray(a.pos)) continue;
      const g = a.parent && byKey["asset:" + a.parent];
      if (g) g.attachments.push({ name: String(a.name).replace(/[^A-Za-z0-9_]/g, ""), pos: a.pos.slice(0, 3).map(Number) });
      else problems.push("attachment " + a.name + " has no asset model to live in");
    }
    for (const g of groups) {
      const members = g.parts.map((i) => parts[i]);
      const primary = members.filter((p) => p.role === "primary").sort((a, b) => b.tris - a.tris)[0] || members.sort((a, b) => b.tris - a.tris)[0];
      g.primary = primary ? primary.index : null;
    }
    const lost = {};
    for (const p of parts) for (const l of p.material.lost) lost[l] = (lost[l] || 0) + 1;
    return { parts, groups, problems, material_notes: Object.keys(lost).map((k) => k + " x" + lost[k]) };
  }

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';

  function luau(meshes, dest, scale, opts) {
    const o = opts || {};
    const plan = planImport(meshes, o);
    const payload = {
      meshes: plan.parts.map((p) => ({ verts: p.entry.verts, faces: p.entry.faces, normals: p.hasNormals ? p.entry.normals : null, uvs: p.hasUV ? p.entry.uvs : null, flat: p.flat, name: p.name, source: String(p.entry.name || ""), object: p.object, group: p.group, material: p.material.material, color: p.material.color, reflectance: p.material.reflectance, transparency: p.material.transparency, blenderMaterial: p.entry.material && p.entry.material.name || null, fidelity: p.fidelity, canCollide: p.canCollide, role: p.role, tris: p.tris, pivot: Array.isArray(p.entry.pivot) ? p.entry.pivot : null })),
      groups: plan.groups.map((g) => ({ key: g.key, name: g.name, kind: g.kind, pivot: g.pivot, primary: g.primary, attachments: g.attachments })),
      dest: dest || "Workspace", scale: Number(scale) || 20, append: !!o.append, publish: !!o.publish, notes: plan.material_notes, problems: plan.problems,
    };
    const json = JSON.stringify(payload).replace(/\]==\]/g, "] == ]");
    const pieces = [];
    for (let i = 0; i < json.length; i += 3000) pieces.push("J[#J + 1] = [==[" + json.slice(i, i + 3000) + "]==]");
    return [
      "local HttpService = game:GetService(\"HttpService\")",
      "local AssetService = game:GetService(\"AssetService\")",
      "local J = {}",
      pieces.join("\n"),
      "local decode = HttpService.JSONDecode",
      "local data = decode(HttpService, table.concat(J))",
      "local meshes = data.meshes or {}",
      "local scale = tonumber(data.scale) or 20",
      "local destName = tostring(data.dest or \"Workspace\")",
      "local parent = workspace",
      "if destName ~= \"Workspace\" and destName ~= \"workspace\" and destName ~= \"\" then",
      "  local cur = game",
      "  for seg in string.gmatch(destName, \"[^%.]+\") do",
      "    if seg ~= \"game\" then",
      "      local nxt = cur:FindFirstChild(seg)",
      "      if not nxt then",
      "        if cur == game then nxt = workspace:FindFirstChild(seg) end",
      "        if not nxt then nxt = Instance.new(\"Folder\") nxt.Name = seg nxt.Parent = (cur == game) and workspace or cur end",
      "      end",
      "      cur = nxt",
      "    end",
      "  end",
      "  if cur ~= game then parent = cur end",
      "end",
      "local folder = parent:FindFirstChild(\"Total_Imported\")",
      "if folder and not data.append then folder:Destroy() folder = nil end",
      "if not folder then",
      "  folder = Instance.new(\"Model\")",
      "  folder.Name = \"Total_Imported\"",
      "  folder.Parent = parent",
      "end",
      "pcall(function() folder:SetAttribute(\"TotalImporter\", " + q(VERSION) + ") end)",
      "local models = {}",
      "for _, g in ipairs(data.groups or {}) do",
      "  local m = data.append and folder:FindFirstChild(g.name) or nil",
      "  if not m or not m:IsA(\"Model\") then m = Instance.new(\"Model\") m.Name = g.name m.Parent = folder end",
      "  pcall(function() m:SetAttribute(\"BlenderAsset\", g.name) m:SetAttribute(\"ImportKind\", g.kind) end)",
      "  models[g.key] = m",
      "end",
      "local report, verify = {}, { parts = {}, models = {}, attachments = 0, uv_parts = 0, smooth_parts = 0, materials = {}, lost = data.notes or {}, problems = data.problems or {} }",
      "local built, viaEm, viaBox, published = 0, 0, 0, 0",
      "local builtParts = {}",
      "for _, entry in ipairs(meshes) do",
      "  local verts, faces = entry.verts or {}, entry.faces or {}",
      "  local name = tostring(entry.name or \"Mesh\")",
      "  local minx, miny, minz = math.huge, math.huge, math.huge",
      "  local maxx, maxy, maxz = -math.huge, -math.huge, -math.huge",
      "  for _, v in ipairs(verts) do",
      "    local x, y, z = (tonumber(v[1]) or 0) * scale, (tonumber(v[2]) or 0) * scale, (tonumber(v[3]) or 0) * scale",
      "    if x < minx then minx = x end if y < miny then miny = y end if z < minz then minz = z end",
      "    if x > maxx then maxx = x end if y > maxy then maxy = y end if z > maxz then maxz = z end",
      "  end",
      "  if #verts == 0 then minx, miny, minz, maxx, maxy, maxz = 0, 0, 0, 0, 0, 0 end",
      "  local cx, cy, cz = (minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2",
      "  local size = Vector3.new(math.max(0.05, maxx - minx), math.max(0.05, maxy - miny), math.max(0.05, maxz - minz))",
      "  local part, how, err, em = nil, nil, nil, nil",
      "  local shading, uvDone = \"none\", false",
      "  local okEm, emOrErr = pcall(function() return AssetService:CreateEditableMesh() end)",
      "  if okEm and emOrErr then",
      "    em = emOrErr",
      "    local tris = 0",
      "    local okAdd, addErr = pcall(function()",
      "      local ids = {}",
      "      for i, v in ipairs(verts) do",
      "        ids[i] = em:AddVertex(Vector3.new((tonumber(v[1]) or 0) * scale - cx, (tonumber(v[2]) or 0) * scale - cy, (tonumber(v[3]) or 0) * scale - cz))",
      "      end",
      "      local flat = entry.flat == true",
      "      local normals = type(entry.normals) == \"table\" and entry.normals or nil",
      "      local uvs = type(entry.uvs) == \"table\" and entry.uvs or nil",
      "      local canNormals, canUV = normals ~= nil, uvs ~= nil",
      "      local ti = 0",
      "      for i = 1, #faces - 2, 3 do",
      "        ti = ti + 1",
      "        local a, b, c = ids[(tonumber(faces[i]) or -1) + 1], ids[(tonumber(faces[i + 1]) or -1) + 1], ids[(tonumber(faces[i + 2]) or -1) + 1]",
      "        if a and b and c and a ~= b and b ~= c and a ~= c then",
      "          local fid = em:AddTriangle(a, b, c)",
      "          tris = tris + 1",
      "          if fid then",
      "            if canNormals and normals[ti] then",
      "              local okN = pcall(function()",
      "                local n = normals[ti]",
      "                local n1 = em:AddNormal(Vector3.new(tonumber(n[1][1]) or 0, tonumber(n[1][2]) or 1, tonumber(n[1][3]) or 0))",
      "                local n2 = em:AddNormal(Vector3.new(tonumber(n[2][1]) or 0, tonumber(n[2][2]) or 1, tonumber(n[2][3]) or 0))",
      "                local n3 = em:AddNormal(Vector3.new(tonumber(n[3][1]) or 0, tonumber(n[3][2]) or 1, tonumber(n[3][3]) or 0))",
      "                em:SetFaceNormals(fid, { n1, n2, n3 })",
      "              end)",
      "              if okN then shading = \"split\" else canNormals = false end",
      "            elseif flat then",
      "              local nid = em:AddNormal()",
      "              em:SetFaceNormals(fid, { nid, nid, nid })",
      "              shading = \"flat\"",
      "            end",
      "            if canUV and uvs[ti] then",
      "              local okU = pcall(function()",
      "                local u = uvs[ti]",
      "                local u1 = em:AddUV(Vector2.new(tonumber(u[1][1]) or 0, 1 - (tonumber(u[1][2]) or 0)))",
      "                local u2 = em:AddUV(Vector2.new(tonumber(u[2][1]) or 0, 1 - (tonumber(u[2][2]) or 0)))",
      "                local u3 = em:AddUV(Vector2.new(tonumber(u[3][1]) or 0, 1 - (tonumber(u[3][2]) or 0)))",
      "                em:SetFaceUVs(fid, { u1, u2, u3 })",
      "              end)",
      "              if okU then uvDone = true else canUV = false end",
      "            end",
      "          end",
      "        end",
      "      end",
      "      pcall(function() em:RemoveUnused() end)",
      "    end)",
      "    if okAdd and tris > 0 then",
      "      local fidelity = Enum.CollisionFidelity.Default",
      "      pcall(function() fidelity = Enum.CollisionFidelity[tostring(entry.fidelity or \"Default\")] or Enum.CollisionFidelity.Default end)",
      "      local okPart, mpOrErr = pcall(function()",
      "        return AssetService:CreateMeshPartAsync(Content.fromObject(em), { CollisionFidelity = fidelity })",
      "      end)",
      "      if okPart and mpOrErr then part = mpOrErr how = string.format(\"MeshPart (%d tris, %s shading%s, %s collision)\", tris, shading, uvDone and \", UVs\" or \"\", tostring(entry.fidelity or \"Default\")) viaEm = viaEm + 1 else err = tostring(mpOrErr) end",
      "    else",
      "      err = okAdd and \"no valid triangles\" or tostring(addErr)",
      "    end",
      "  else",
      "    err = \"EditableMesh unavailable: \" .. tostring(emOrErr)",
      "  end",
      "  if part and em and data.publish then",
      "    local okPub, res, idOrErr = pcall(function()",
      "      return AssetService:CreateAssetAsync(em, Enum.AssetType.Mesh, { Name = name, Description = \"Blender mesh sent by TotalScript\" })",
      "    end)",
      "    if okPub and res == Enum.CreateAssetResult.Success and idOrErr then",
      "      part:SetAttribute(\"PublishedMeshId\", tonumber(idOrErr) or tostring(idOrErr))",
      "      how = how .. string.format(\", published as rbxassetid://%s\", tostring(idOrErr))",
      "      published = published + 1",
      "    else",
      "      how = how .. \" (publish failed: \" .. (okPub and (tostring(res) .. \" \" .. tostring(idOrErr)) or tostring(res)) .. \")\"",
      "    end",
      "  end",
      "  local method = \"EditableMesh\"",
      "  if not part then",
      "    part = Instance.new(\"Part\")",
      "    part.Size = size",
      "    how = \"bounding-box Part\" .. (err and (\" - \" .. err) or \"\")",
      "    viaBox = viaBox + 1",
      "    method = \"BoundingBox\"",
      "  end",
      "  part.Name = name",
      "  part.Anchored = true",
      "  part.CFrame = CFrame.new(cx, cy, cz)",
      "  local matName = tostring(entry.material or \"SmoothPlastic\")",
      "  local okMat = pcall(function() part.Material = Enum.Material[matName] end)",
      "  if not okMat then pcall(function() part.Material = Enum.Material.SmoothPlastic end) matName = \"SmoothPlastic (fallback)\" end",
      "  if type(entry.color) == \"table\" and entry.color[1] then",
      "    pcall(function() part.Color = Color3.new(math.clamp(tonumber(entry.color[1]) or 0.6, 0, 1), math.clamp(tonumber(entry.color[2]) or 0.6, 0, 1), math.clamp(tonumber(entry.color[3]) or 0.6, 0, 1)) end)",
      "  end",
      "  if tonumber(entry.reflectance) and tonumber(entry.reflectance) > 0 then pcall(function() part.Reflectance = tonumber(entry.reflectance) end) end",
      "  if tonumber(entry.transparency) and tonumber(entry.transparency) > 0 then pcall(function() part.Transparency = tonumber(entry.transparency) end) end",
      "  pcall(function() part.CanCollide = entry.canCollide ~= false end)",
      "  part:SetAttribute(\"BlenderObject\", tostring(entry.source ~= \"\" and entry.source or name))",
      "  pcall(function()",
      "    part:SetAttribute(\"ImportMethod\", method)",
      "    part:SetAttribute(\"Triangles\", tonumber(entry.tris) or 0)",
      "    part:SetAttribute(\"Shading\", shading)",
      "    part:SetAttribute(\"HasUVs\", uvDone)",
      "    part:SetAttribute(\"RobloxMaterial\", matName)",
      "    part:SetAttribute(\"Collision\", tostring(entry.fidelity or \"Default\") .. (entry.canCollide == false and \" (CanCollide false)\" or \"\"))",
      "    if entry.blenderMaterial then part:SetAttribute(\"BlenderMaterial\", tostring(entry.blenderMaterial)) end",
      "    if entry.role and entry.role ~= \"\" then part:SetAttribute(\"Role\", tostring(entry.role)) end",
      "  end)",
      "  local holder = entry.group and models[entry.group] or folder",
      "  part.Parent = holder",
      "  builtParts[#builtParts + 1] = { part = part, entry = entry }",
      "  built = built + 1",
      "  if uvDone then verify.uv_parts = verify.uv_parts + 1 end",
      "  if shading == \"split\" then verify.smooth_parts = verify.smooth_parts + 1 end",
      "  verify.materials[matName] = (verify.materials[matName] or 0) + 1",
      "  table.insert(verify.parts, { name = name, path = part:GetFullName(), method = method, tris = tonumber(entry.tris) or 0, material = matName, shading = shading, uvs = uvDone, collision = tostring(entry.fidelity or \"Default\"), can_collide = entry.canCollide ~= false, size = { math.floor(size.X * 100 + 0.5) / 100, math.floor(size.Y * 100 + 0.5) / 100, math.floor(size.Z * 100 + 0.5) / 100 } })",
      "  table.insert(report, name .. \": \" .. how)",
      "end",
      "for _, g in ipairs(data.groups or {}) do",
      "  local m = models[g.key]",
      "  if m then",
      "    local primary = nil",
      "    for _, bp in ipairs(builtParts) do if bp.entry.group == g.key and g.primary ~= nil and bp.entry == meshes[g.primary + 1] then primary = bp.part end end",
      "    if not primary then primary = m:FindFirstChildWhichIsA(\"BasePart\") end",
      "    if primary then m.PrimaryPart = primary end",
      "    if type(g.pivot) == \"table\" and g.pivot[1] then",
      "      pcall(function() m.WorldPivot = CFrame.new((tonumber(g.pivot[1]) or 0) * scale, (tonumber(g.pivot[2]) or 0) * scale, (tonumber(g.pivot[3]) or 0) * scale) end)",
      "    end",
      "    local attParent = primary",
      "    for _, att in ipairs(g.attachments or {}) do",
      "      if attParent then",
      "        local a = Instance.new(\"Attachment\")",
      "        a.Name = tostring(att.name)",
      "        local wx, wy, wz = (tonumber(att.pos[1]) or 0) * scale, (tonumber(att.pos[2]) or 0) * scale, (tonumber(att.pos[3]) or 0) * scale",
      "        local pc = attParent.CFrame",
      "        pcall(function() a.Position = Vector3.new(wx - pc.X, wy - pc.Y, wz - pc.Z) end)",
      "        a.Parent = attParent",
      "        verify.attachments = verify.attachments + 1",
      "      end",
      "    end",
      "    table.insert(verify.models, { name = g.name, kind = g.kind, primary = primary and primary.Name or nil, pivot = g.pivot, attachments = #(g.attachments or {}) })",
      "  end",
      "end",
      "local primary = folder:FindFirstChildWhichIsA(\"BasePart\")",
      "if not primary then local firstModel = folder:FindFirstChildWhichIsA(\"Model\") if firstModel and firstModel.PrimaryPart then primary = firstModel.PrimaryPart end end",
      "if primary and not folder.PrimaryPart then folder.PrimaryPart = primary end",
      "verify.real = viaEm verify.fallback = viaBox verify.published = published verify.scale = scale",
      "local verifyText = \"\"",
      "pcall(function() verifyText = \"\\nverify: \" .. HttpService:JSONEncode(verify) end)",
      "return string.format(\"imported %d mesh(es) into %s.Total_Imported (%d real MeshParts, %d bounding boxes, %d published)\\n%s\", built, parent:GetFullName(), viaEm, viaBox, published, table.concat(report, \"\\n\")) .. (viaBox > 0 and \"\\nWARNING: bounding-box parts are placeholders, not the Blender geometry.\" or \"\") .. (#(data.notes or {}) > 0 and (\"\\nNot reproducible in Roblox: \" .. table.concat(data.notes, \"; \")) or \"\") .. verifyText",
    ].join("\n");
  }

  // Studio-side read-back: what is actually in the DataModel after an import.
  function verifyLuau(pathArg, expect) {
    const e = expect || {};
    return [
      "local HttpService = game:GetService(\"HttpService\")",
      "local function resolve(p)",
      "  p = tostring(p or \"\"):gsub(\"^game%.\", \"\")",
      "  if p == \"\" then return workspace:FindFirstChild(\"Total_Imported\") end",
      "  local cur = game",
      "  for seg in string.gmatch(p, \"[^%.]+\") do",
      "    local nxt = (cur == game and seg:lower() == \"workspace\") and workspace or cur:FindFirstChild(seg)",
      "    if not nxt and cur == game then local okS, s = pcall(function() return game:GetService(seg) end) if okS then nxt = s end end",
      "    if not nxt then return nil end",
      "    cur = nxt",
      "  end",
      "  return cur",
      "end",
      "local target = resolve(" + q(pathArg || "") + ")",
      "if not target then return HttpService:JSONEncode({ ok = false, error = \"nothing found at \" .. " + q(pathArg || "Workspace.Total_Imported") + " .. \" - the import did not land (or landed elsewhere)\" }) end",
      "local parts, models, atts, problems, mats = {}, {}, 0, {}, {}",
      "local minY, tris, real, fallback, unanchored = math.huge, 0, 0, 0, 0",
      "local minx, miny, minz, maxx, maxy, maxz = math.huge, math.huge, math.huge, -math.huge, -math.huge, -math.huge",
      "local function walk(inst)",
      "  for _, ch in ipairs(inst:GetChildren()) do",
      "    if ch:IsA(\"BasePart\") then",
      "      local m = ch:GetAttribute(\"ImportMethod\")",
      "      local t = tonumber(ch:GetAttribute(\"Triangles\")) or 0",
      "      tris = tris + t",
      "      if m == \"EditableMesh\" or ch:IsA(\"MeshPart\") then real = real + 1 else fallback = fallback + 1 end",
      "      if not ch.Anchored then unanchored = unanchored + 1 end",
      "      local mn = tostring(ch.Material):gsub(\"^Enum%.Material%.\", \"\")",
      "      mats[mn] = (mats[mn] or 0) + 1",
      "      local p = ch.Position local s = ch.Size",
      "      if p.X - s.X / 2 < minx then minx = p.X - s.X / 2 end if p.Y - s.Y / 2 < miny then miny = p.Y - s.Y / 2 end if p.Z - s.Z / 2 < minz then minz = p.Z - s.Z / 2 end",
      "      if p.X + s.X / 2 > maxx then maxx = p.X + s.X / 2 end if p.Y + s.Y / 2 > maxy then maxy = p.Y + s.Y / 2 end if p.Z + s.Z / 2 > maxz then maxz = p.Z + s.Z / 2 end",
      "      if string.match(ch.Name, \"%.%d%d%d$\") or string.match(ch.Name, \"^Cube$\") or string.match(ch.Name, \"^Cylinder$\") then table.insert(problems, ch.Name .. \": default / numbered name\") end",
      "      if m == \"BoundingBox\" then table.insert(problems, ch.Name .. \": placeholder bounding box, not real geometry\") end",
      "      if s.X < 0.06 and s.Y < 0.06 and s.Z < 0.06 then table.insert(problems, ch.Name .. \": near-zero size\") end",
      "      for _, a in ipairs(ch:GetChildren()) do if a:IsA(\"Attachment\") then atts = atts + 1 end end",
      "      table.insert(parts, { name = ch.Name, class = ch.ClassName, material = mn, method = m, tris = t, shading = ch:GetAttribute(\"Shading\"), uvs = ch:GetAttribute(\"HasUVs\"), collision = ch:GetAttribute(\"Collision\"), can_collide = ch.CanCollide, anchored = ch.Anchored, size = { math.floor(s.X * 100 + 0.5) / 100, math.floor(s.Y * 100 + 0.5) / 100, math.floor(s.Z * 100 + 0.5) / 100 } })",
      "    elseif ch:IsA(\"Model\") then",
      "      local pv = nil pcall(function() local c = ch:GetPivot() pv = { math.floor(c.X * 100 + 0.5) / 100, math.floor(c.Y * 100 + 0.5) / 100, math.floor(c.Z * 100 + 0.5) / 100 } end)",
      "      table.insert(models, { name = ch.Name, primary = ch.PrimaryPart and ch.PrimaryPart.Name or nil, pivot = pv, children = #ch:GetChildren() })",
      "      if not ch.PrimaryPart then table.insert(problems, ch.Name .. \": Model without PrimaryPart\") end",
      "    end",
      "    walk(ch)",
      "  end",
      "end",
      "walk(target)",
      "if #parts == 0 then table.insert(problems, \"no BaseParts under \" .. target:GetFullName()) end",
      "if unanchored > 0 then table.insert(problems, unanchored .. \" unanchored part(s)\") end",
      "if tris > 20000 * math.max(1, #parts) then table.insert(problems, \"triangle count suspicious: \" .. tris) end",
      "local extent = (#parts > 0) and { math.floor((maxx - minx) * 100 + 0.5) / 100, math.floor((maxy - miny) * 100 + 0.5) / 100, math.floor((maxz - minz) * 100 + 0.5) / 100 } or { 0, 0, 0 }",
      (e.parts ? "if #parts ~= " + Math.max(0, Number(e.parts) | 0) + " then table.insert(problems, \"expected " + (Number(e.parts) | 0) + " parts, found \" .. #parts) end" : ""),
      (e.min_real ? "if real < " + Math.max(0, Number(e.min_real) | 0) + " then table.insert(problems, \"expected at least " + (Number(e.min_real) | 0) + " real MeshParts, found \" .. real) end" : ""),
      (Array.isArray(e.extent) && e.extent.length >= 3 ? "do local want = {" + e.extent.slice(0, 3).map((x) => Number(x) || 0).join(", ") + "} for i = 1, 3 do if want[i] > 0 and math.abs(extent[i] - want[i]) / want[i] > 0.25 then table.insert(problems, string.format(\"extent axis %d is %.2f studs, expected %.2f\", i, extent[i], want[i])) end end end" : ""),
      "return HttpService:JSONEncode({ ok = #problems == 0, target = target:GetFullName(), parts = #parts, real_meshparts = real, placeholders = fallback, models = models, attachments = atts, triangles = tris, materials = mats, extent_studs = extent, min_y = (#parts > 0) and math.floor(miny * 100 + 0.5) / 100 or nil, part_list = parts, problems = problems, note = \"structural read-back from the DataModel: counts, classes, materials, sizes, pivots, attachments - not a visual judgement (take a screenshot for that)\" })",
    ].filter(Boolean).join("\n");
  }

  const api = { VERSION, MATERIALS, FIDELITY, mapMaterial, planImport, luau, verifyLuau, partName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TotalMeshImport = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
