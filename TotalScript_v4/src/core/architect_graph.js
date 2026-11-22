// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/architect_graph.js — TotalArchitectGraph (4.0.0)
//
// Visual Node / Game-Flow Architect & 3D Live Telemetry Heatmap Engine.
// Pure module (no DOM, no chrome.*, no fetch). Generates plain Lua 5.x probes
// to extract Scripts <-> Remotes <-> DataStores <-> UI <-> Models topology,
// applies/clears 3D Studio Performance Heatmap Highlights, and renders an
// interactive SVG node graph.
const TotalArchitectGraph = (() => {
  "use strict";
  const VERSION = "4.0.0";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Plain Lua 5.x (no +=, no continue)
  function scanGraphLuau() {
    return [
      "-- TotalScript 4.0 Visual Architect & Telemetry Graph Scanner (read-only)",
      "local HttpService = game:GetService('HttpService')",
      "local nodes = {}",
      "local edges = {}",
      "local byName = {}",
      "local idx = 0",
      "local function addNode(label, kind, path, risk, heat, issue, metrics)",
      "  idx = idx + 1",
      "  local id = kind .. '_' .. idx",
      "  nodes[#nodes+1] = { id = id, label = label, kind = kind, path = path, risk = risk, heat = heat, issue = issue or '', metrics = metrics or '' }",
      "  byName[label] = id",
      "  return id",
      "end",
      "local scripts = {}",
      "for _, svcName in ipairs({'ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui'}) do",
      "  local ok, svc = pcall(function() return game:GetService(svcName) end)",
      "  if ok and svc then",
      "    for _, d in ipairs(svc:GetDescendants()) do",
      "      if d:IsA('RemoteEvent') or d:IsA('RemoteFunction') then",
      "        if #nodes < 28 then addNode(d.Name, 'remote', d:GetFullName(), 'amber', 20, 'Verify server validation', d.ClassName) end",
      "      elseif d:IsA('ScreenGui') then",
      "        local dead = 0",
      "        local btns = 0",
      "        for _, g in ipairs(d:GetDescendants()) do if g:IsA('GuiButton') then btns = btns + 1 if g:GetAttribute('Total_Action') == nil and g:FindFirstChildOfClass('LocalScript') == nil then dead = dead + 1 end end end",
      "        local risk = (dead > 0 or not d.Enabled) and 'amber' or 'green'",
      "        local iss = dead > 0 and (dead .. ' possibly unwired button(s)') or ''",
      "        if #nodes < 28 then addNode(d.Name, 'ui', d:GetFullName(), risk, 15 + btns * 2, iss, btns .. ' buttons') end",
      "      elseif d:IsA('LuaSourceContainer') then",
      "        scripts[#scripts+1] = d",
      "      end",
      "    end",
      "  end",
      "end",
      "-- Inspect top Workspace models for 3D Heatmap",
      "local modCount = 0",
      "for _, ch in ipairs(workspace:GetChildren()) do",
      "  if ch:IsA('Model') and modCount < 6 then",
      "    modCount = modCount + 1",
      "    local parts = 0",
      "    local unanch = 0",
      "    local lights = 0",
      "    for _, d in ipairs(ch:GetDescendants()) do",
      "      if d:IsA('BasePart') then parts = parts + 1 if not d.Anchored then unanch = unanch + 1 end",
      "      elseif d:IsA('Light') or d:IsA('ParticleEmitter') then lights = lights + 1 end",
      "    end",
      "    local heat = math.min(100, math.floor(parts / 4) + unanch * 4 + lights * 6)",
      "    local risk = heat >= 75 and 'red' or (heat >= 45 and 'amber' or 'green')",
      "    local iss = unanch > 5 and (unanch .. ' unanchored parts') or (parts > 200 and (parts .. ' parts (consider mesh/LOD)') or '')",
      "    addNode(ch.Name, 'model', ch:GetFullName(), risk, heat, iss, parts .. ' parts · ' .. unanch .. ' unanch')",
      "  end",
      "end",
      "-- Analyze scripts & wire edges",
      "local dsNodes = {}",
      "local scCount = 0",
      "for _, s in ipairs(scripts) do",
      "  if scCount < 14 then",
      "    scCount = scCount + 1",
      "    local src = ''",
      "    pcall(function() src = s.Source or '' end)",
      "    local kind = s:IsA('LocalScript') and 'localscript' or (s:IsA('ModuleScript') and 'module' or 'script')",
      "    local hasLoop = string.find(src, 'Heartbeat', 1, true) ~= nil or string.find(src, 'RenderStepped', 1, true) ~= nil",
      "    local hasDep = string.find(src, '[^%w_%.]wait%s*%(') ~= nil or string.find(src, '^wait%s*%(') ~= nil",
      "    local hasDs = string.find(src, 'GetDataStore', 1, true) ~= nil",
      "    local hasPcall = string.find(src, 'pcall', 1, true) ~= nil",
      "    local risk = (hasDs and not hasPcall) and 'red' or ((hasDep or hasLoop) and 'amber' or 'green')",
      "    local heat = 15 + (hasLoop and 40 or 0) + (hasDep and 15 or 0) + math.min(25, math.floor(#src / 400))",
      "    local iss = (hasDs and not hasPcall) and 'DataStore call without pcall' or (hasDep and 'Deprecated wait() call' or (hasLoop and 'Per-frame loop — verify perf' or ''))",
      "    local sid = addNode(s.Name, kind, s:GetFullName(), risk, heat, iss, #src .. ' chars')",
      "    if hasDs then",
      "      if not dsNodes['DataStore'] then dsNodes['DataStore'] = addNode('DataStore', 'datastore', 'DataStoreService', hasPcall and 'green' or 'red', 25, hasPcall and '' or 'Missing pcall/BindToClose', 'Persistence') end",
      "      edges[#edges+1] = { from = sid, to = dsNodes['DataStore'], kind = 'datastore' }",
      "    end",
      "    for name, nid in pairs(byName) do",
      "      if #edges < 48 and nid ~= sid and #name >= 4 and string.find(src, name, 1, true) ~= nil then",
      "        edges[#edges+1] = { from = sid, to = nid, kind = 'remote' }",
      "      end",
      "    end",
      "  end",
      "end",
      "local red = 0",
      "local amber = 0",
      "for _, n in ipairs(nodes) do if n.risk == 'red' then red = red + 1 elseif n.risk == 'amber' then amber = amber + 1 end end",
      "return HttpService:JSONEncode({ scanned_at = '', nodes = nodes, edges = edges, red_count = red, amber_count = amber, hotspots = {} })",
    ].join("\n");
  }

  // Applies temporary 3D Studio Performance Heatmap Highlight overlays to Workspace Models.
  function heatmapLuau() {
    return [
      "-- TotalScript 4.0 3D Performance Heatmap Overlay",
      "local HttpService = game:GetService('HttpService')",
      "local tagged = 0",
      "local red = 0",
      "local amber = 0",
      "for _, ch in ipairs(workspace:GetChildren()) do",
      "  if ch:IsA('Model') then",
      "    local old = ch:FindFirstChild('_TotalHeatmapHighlight')",
      "    if old then old:Destroy() end",
      "    local parts = 0",
      "    local unanch = 0",
      "    local fx = 0",
      "    for _, d in ipairs(ch:GetDescendants()) do",
      "      if d:IsA('BasePart') then parts = parts + 1 if not d.Anchored then unanch = unanch + 1 end",
      "      elseif d:IsA('ParticleEmitter') or d:IsA('PointLight') or d:IsA('SpotLight') then fx = fx + 1 end",
      "    end",
      "    local heat = math.min(100, math.floor(parts / 4) + unanch * 4 + fx * 6)",
      "    local h = Instance.new('Highlight')",
      "    h.Name = '_TotalHeatmapHighlight'",
      "    h.FillTransparency = 0.72",
      "    h.OutlineTransparency = 0.15",
      "    if heat >= 75 then h.FillColor = Color3.fromRGB(239, 68, 68) h.OutlineColor = Color3.fromRGB(254, 202, 202) red = red + 1",
      "    elseif heat >= 45 then h.FillColor = Color3.fromRGB(245, 158, 11) h.OutlineColor = Color3.fromRGB(254, 243, 199) amber = amber + 1",
      "    else h.FillColor = Color3.fromRGB(16, 185, 129) h.OutlineColor = Color3.fromRGB(167, 243, 208) end",
      "    h.Parent = ch",
      "    tagged = tagged + 1",
      "  end",
      "end",
      "return HttpService:JSONEncode({ ok = true, tagged = tagged, red = red, amber = amber })",
    ].join("\n");
  }

  function clearHeatmapLuau() {
    return [
      "-- TotalScript 4.0 Clear 3D Performance Heatmap",
      "local HttpService = game:GetService('HttpService')",
      "local removed = 0",
      "for _, d in ipairs(workspace:GetDescendants()) do",
      "  if d.Name == '_TotalHeatmapHighlight' and d:IsA('Highlight') then d:Destroy() removed = removed + 1 end",
      "end",
      "return HttpService:JSONEncode({ ok = true, removed = removed })",
    ].join("\n");
  }

  function renderSvg(graph, opts) {
    opts = opts || {};
    const nodes = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).slice(0, 18);
    const edges = (graph && Array.isArray(graph.edges) ? graph.edges : []).slice(0, 36);
    const W = Number(opts.width) || 720;
    let H = Number(opts.height) || 230;
    if (!nodes.length) {
      return `<svg viewBox="0 0 ${W} ${H}" class="rs-arch-svg" role="img" aria-label="Architecture Graph"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#64748b" font-size="12" font-family="Inter,system-ui,sans-serif">Click "Scan Place Graph" to map Scripts, Remotes, DataStores, UI &amp; Models</text></svg>`;
    }
    const cols = [0, 0, 0, 0];
    const colOf = (n) => (n.kind === "ui" ? 0 : n.kind === "remote" ? 1 : (n.kind === "script" || n.kind === "localscript" || n.kind === "module") ? 2 : 3);
    for (const n of nodes) cols[colOf(n)]++;
    const maxCol = Math.max(1, ...cols);
    H = Math.max(H, 24 + maxCol * 46);
    const colIdx = [0, 0, 0, 0];
    const pos = {};
    for (const n of nodes) {
      const c = colOf(n);
      const idx = colIdx[c]++;
      const x = 18 + c * Math.floor((W - 156) / 3);
      const y = 16 + idx * 46;
      pos[n.id] = { x, y, cx: x + 64, cy: y + 18 };
    }
    const edgeSvg = edges.map((e) => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return "";
      const mx = (a.cx + b.cx) / 2;
      return `<path d="M ${a.cx} ${a.cy} C ${mx} ${a.cy}, ${mx} ${b.cy}, ${b.cx} ${b.cy}" fill="none" stroke="rgba(34,211,238,0.38)" stroke-width="1.4"/>`;
    }).join("");
    const riskCol = { red: "#f87171", amber: "#fbbf24", green: "#34d399" };
    const nodeSvg = nodes.map((n) => {
      const p = pos[n.id];
      const stroke = riskCol[n.risk] || "#34d399";
      const lbl = String(n.label || "?").slice(0, 15);
      const meta = `${String(n.kind || "").slice(0, 10)} · heat ${Number(n.heat) || 0}`;
      return `<g class="rs-arch-node" data-arch-node="${esc(n.path || n.label)}" data-arch-issue="${esc(n.issue || "")}" style="cursor:pointer">` +
        `<rect x="${p.x}" y="${p.y}" width="128" height="36" rx="8" fill="#0d1524" stroke="${stroke}" stroke-width="1.4"/>` +
        `<circle cx="${p.x + 10}" cy="${p.y + 13}" r="3" fill="${stroke}"/>` +
        `<text x="${p.x + 18}" y="${p.y + 16}" fill="#f8fafc" font-size="11" font-weight="650" font-family="Inter,system-ui,sans-serif">${esc(lbl)}</text>` +
        `<text x="${p.x + 10}" y="${p.y + 29}" fill="#94a3b8" font-size="9" font-family="JetBrains Mono,monospace">${esc(meta)}</text>` +
      `</g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="rs-arch-svg" role="img" aria-label="Studio Architecture Graph">${edgeSvg}${nodeSvg}</svg>`;
  }

  function optimizePrompt(graph, focusPath) {
    if (focusPath) {
      return `[TotalScript 4.0 Architect Node Fix] Inspect and optimize ${focusPath}: check remote argument validation, pcall/BindToClose safety, unanchored physics parts, or per-frame Heartbeat/RenderStepped cost. Apply the minimal fix, run script_check + perf_audit, and verify clean console output.`;
    }
    const nodes = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).filter((n) => n.risk === "red" || n.risk === "amber" || Number(n.heat) >= 45);
    if (!nodes.length) {
      return "[TotalScript 4.0 Architect Audit] Scan the place architecture for any unvalidated remotes, unprotected DataStores, dead UI buttons, or high-heat Workspace models and optimize them.";
    }
    const list = nodes.slice(0, 8).map((n) => `- ${n.path} [${n.kind}, ${n.risk}, heat ${n.heat}]: ${n.issue || n.metrics || "needs optimization"}`).join("\n");
    return `[TotalScript 4.0 Architect & 3D Heatmap Optimization]\nFix these flagged nodes and performance hotspots:\n${list}\nVerify every fix with script_check, bench_run & perf_audit.`;
  }

  return Object.freeze({
    VERSION,
    scanGraphLuau,
    heatmapLuau,
    clearHeatmapLuau,
    renderSvg,
    optimizePrompt,
  });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalArchitectGraph; } catch {}
try { if (typeof window !== "undefined") window.TotalArchitectGraph = TotalArchitectGraph; } catch {}
