// SPDX-License-Identifier: MIT
// src/core/work_modes.js — TotalWorkModes (2.21.0)
//
// What a WORK MODE actually DOES at run time. Before 1.99.9 the three built-in
// modes (creation = Totality, blender, animate = Animator) only shaped the
// prompt: a mode section, catalogue ordering, a checklist line, a skill-ranking
// bias and ONE end-of-run evidence nudge. Nothing happened at the start of a
// request, nothing was tracked while it ran and nothing was read back without
// a chat turn. This module adds the hard, observable behaviours; main.js only
// wires them (preflight at send time, tracker after every tool, auto-check
// after a successful build command, verdict at completion).
//
// Pure: no DOM, no chrome.*, no fetch. Every probe is a READ-ONLY Luau program
// that returns HttpService:JSONEncode(table) (or a real Blender bridge tool
// name from background.js: get_scene_info / get_object_info). The Luau is kept
// plain Lua 5.x (no `+=`, no `continue`) so tests/work-modes-sim.py can run it
// on the roblox_sim runtime unchanged.
//
//   PREFLIGHT   preflight(mode, ctx) → probe | null; renderBrief(mode, data, ctx)
//   TRACKER     gateStates(gates, runTools) → [{id,state}], gateStrip(mode, states)
//   VERDICT     verdict(mode, states) → one line for the completion card + diag
//   AUTO-CHECK  autoCheck(mode, toolName, args, feedback) → probe | null;
//               renderAutoCheck(probe, raw) → "[MODE AUTO-CHECK] …" or ""
//   PRECONDITION precondition(mode, ctx) → { ok } | { ok:false, title, message, brief }
const TotalWorkModes = (() => {
  "use strict";
  const VERSION = "2.21.0";
  const IDS = ["creation", "blender", "animate", "blockbench"]; // 2.21.0: + Blockbench (low-poly models; 2.21.0 through TotalScript's own Blockbench plugin)
  const BADGE = { creation: "TOTALITY", blender: "BLENDER", animate: "ANIMATOR", blockbench: "BLOCKBENCH" };
  const BRIEF_MAX = 1200;
  const AUTO_MAX = 600;
  const PROBE_TIMEOUT_MS = 8000;
  // Mode gate ids (pinned in main.js MODE_GATES; the labels are display only).
  const GATE_LABEL = {
    scripts: "SCRIPTS", look: "LOOK", motion: "MOTION", quality: "QUALITY", systems: "SYSTEMS",
    asset: "ASSET", import: "IMPORT", rig: "RIG", playback: "PLAYBACK",
    model: "MODEL", export: "EXPORT",
  };
  // What each mode does at run time — shown in the mode picker (separate line,
  // the WORK_MODES literal in popup/bar is pinned by tests and stays as is).
  const DOES = {
    creation: "Preflight reads the place (parts, scripts, GUIs, remotes, lighting, selection) before the first command; live gate strip SCRIPTS / LOOK / MOTION / QUALITY / SYSTEMS; every build command is read back automatically; up to 2 verification rounds; verdict card at the end.",
    blender: "Checks the Blender bridge BEFORE the model acts (not connected = hard stop note + banner); preflight reads the Blender scene; gate strip ASSET / IMPORT / SCRIPTS / LOOK; every blender_* build is read back with get_object_info; verdict card at the end.",
    animate: "Preflight lists the rigs (RigType, Animator, Motor6D count), existing clips and whether AnimPlayer is installed; gate strip RIG / PLAYBACK / SCRIPTS / LOOK; clips and rigs are read back after every authoring command; verdict card at the end.",
    blockbench: "Checks the Blockbench link (TotalScript plugin inside Blockbench → total-core) BEFORE the model acts (not connected = hard stop note + banner); preflight reads the open Blockbench project (format, element counts, groups); gate strip MODEL / EXPORT / SCRIPTS / LOOK; every bb_* build is read back with bb_status; the export path is reported for Studio's Import 3D (manual) - nothing is uploaded; verdict card at the end.",
  };

  function normalize(mode) {
    const m = String(mode || "").trim().toLowerCase();
    return IDS.includes(m) ? m : "creation";
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bare = (name) => { const s = String(name || ""); return (s.includes("/") ? s.split("/").pop() : s) || ""; };
  // Lua string literal (single-quoted) for a JS string.
  const lq = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n") + "'";

  // ── Luau helpers shared by the probes ──────────────────────────────────────
  // resolve(p): "game.Workspace.X" | "Workspace.X" | "ServerStorage" → Instance
  // (exact child, then case-insensitive child, then service at the root).
  const LUA_RESOLVE = [
    "local function resolve(p)",
    " p=tostring(p or '') if p=='' then return nil end",
    " if p:sub(1,5)=='game.' then p=p:sub(6) end",
    " if p:lower()=='workspace' then return workspace end",
    " local n=game",
    " for _,s in ipairs(string.split(p,'.')) do",
    "  if s~='' then",
    "   local nxt=n:FindFirstChild(s)",
    "   if not nxt then for _,ch in ipairs(n:GetChildren()) do if ch.Name:lower()==s:lower() then nxt=ch break end end end",
    "   if not nxt and n==game then local ok,svc=pcall(function() return game:GetService(s) end) if ok then nxt=svc end end",
    "   if not nxt then return nil end",
    "   n=nxt",
    "  end",
    " end",
    " return n",
    "end",
  ].join("\n");
  const LUA_RIGINFO = [
    "local function rigInfo(m)",
    " local hum=m:FindFirstChildOfClass('Humanoid') local ac=m:FindFirstChildOfClass('AnimationController')",
    " if not hum and not ac then return nil end",
    " local animator=(hum and hum:FindFirstChildOfClass('Animator')) or (ac and ac:FindFirstChildOfClass('Animator'))",
    " local motors=0 for _,d in ipairs(m:GetDescendants()) do if d:IsA('Motor6D') then motors=motors+1 end end",
    " local rt='custom' if hum then local ok,v=pcall(function() return hum.RigType.Name end) if ok and v then rt=v end end",
    " return {path=m:GetFullName(),rig=rt,animator=animator~=nil,motors=motors,hrp=m:FindFirstChild('HumanoidRootPart')~=nil,controller=(ac~=nil and hum==nil),animSaves=m:FindFirstChild('AnimSaves')~=nil}",
    "end",
  ].join("\n");
  const LUA_TAIL_COMMON = [
    "pcall(function() for i,s in ipairs(game:GetService('Selection'):Get()) do if i>3 then break end out.selection[#out.selection+1]=s:GetFullName() end end)",
    "pcall(function() out.playing=game:GetService('RunService'):IsRunning() end)",
    "return hs:JSONEncode(out)",
  ].join("\n");

  // ── 1. PREFLIGHT ───────────────────────────────────────────────────────────
  // Every probe starts with this marker line: harnesses and log readers can
  // tell a TotalScript read-only probe from a model command at a glance.
  const PROBE_MARK = "-- TotalScript mode probe (read-only)";
  const PREFLIGHT_LUA = {
    creation: [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      "local out={mode='creation',parts=0,unanchored=0,models=0,scripts=0,guis=0,remotes=0,selection={},lighting={},playing=false,index=false,bench=false,topModels={},guiNames={},remoteNames={},streaming=false}",
      "pcall(function() out.streaming=workspace.StreamingEnabled==true end)",
      "for _,ch in ipairs(workspace:GetChildren()) do if ch:IsA('Model') and #out.topModels<6 then out.topModels[#out.topModels+1]=ch.Name end end",
      "for _,d in ipairs(workspace:GetDescendants()) do",
      " if d:IsA('BasePart') then out.parts=out.parts+1 if not d.Anchored then out.unanchored=out.unanchored+1 end",
      " elseif d:IsA('Model') then out.models=out.models+1 end",
      "end",
      "for _,n in ipairs({'ServerScriptService','ServerStorage','ReplicatedStorage','StarterPlayer','StarterGui','Workspace'}) do",
      " local ok,svc=pcall(function() return game:GetService(n) end)",
      " if ok and svc then for _,d in ipairs(svc:GetDescendants()) do",
      "  if d:IsA('LuaSourceContainer') then out.scripts=out.scripts+1 elseif d:IsA('RemoteEvent') or d:IsA('RemoteFunction') then out.remotes=out.remotes+1 if #out.remoteNames<6 then out.remoteNames[#out.remoteNames+1]=d.Name end end",
      " end end",
      "end",
      "for _,g in ipairs(game:GetService('StarterGui'):GetChildren()) do if g:IsA('ScreenGui') then out.guis=out.guis+1 if #out.guiNames<6 then out.guiNames[#out.guiNames+1]=g.Name end end end",
      "pcall(function() local L=game:GetService('Lighting') local lg={technology='?',clock=L.ClockTime} pcall(function() lg.technology=tostring(L.Technology.Name) end) pcall(function() lg.atmosphere=L:FindFirstChildOfClass('Atmosphere')~=nil lg.bloom=L:FindFirstChildOfClass('BloomEffect')~=nil end) out.lighting=lg end)",
      "pcall(function() local ss=game:GetService('ServerStorage') out.index=ss:FindFirstChild('Total_ProjectIndex')~=nil out.bench=ss:FindFirstChild('_TotalBench')~=nil end)",
      LUA_TAIL_COMMON,
    ].join("\n"),
    animate: [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      "local out={mode='animate',rigs={},clips=0,clipNames={},clipDetails={},animations=0,animPlayer=false,selection={},playing=false}",
      LUA_RIGINFO,
      "local seen=0",
      "for _,n in ipairs({'Workspace','ReplicatedStorage','ServerStorage','StarterPlayer'}) do",
      " local ok,svc=pcall(function() return game:GetService(n) end)",
      " if ok and svc then for _,d in ipairs(svc:GetDescendants()) do",
      "  if d:IsA('Model') and seen<8 then local r=rigInfo(d) if r then seen=seen+1 out.rigs[#out.rigs+1]=r end end",
      "  if d:IsA('KeyframeSequence') then out.clips=out.clips+1 if #out.clipNames<8 then out.clipNames[#out.clipNames+1]=d.Name end if #out.clipDetails<5 then local kf=d:GetKeyframes() local tm=0 for _,k in ipairs(kf) do if k.Time>tm then tm=k.Time end end out.clipDetails[#out.clipDetails+1]={name=d.Name,kf=#kf,len=tm,loop=d.Loop} end end",
      "  if d:IsA('Animation') then out.animations=out.animations+1 end",
      " end end",
      "end",
      "pcall(function() local ta=game:GetService('ReplicatedStorage'):FindFirstChild('TotalAnimations') out.animPlayer=(ta~=nil and ta:FindFirstChild('AnimPlayer')~=nil) end)",
      LUA_TAIL_COMMON,
    ].join("\n"),
  };

  // ctx: { engine:"roblox"|"local", blenderConnected:boolean }
  function preflight(mode, ctx) {
    mode = normalize(mode);
    ctx = ctx || {};
    if (ctx.engine === "local") return null;
    if (mode === "blender") {
      if (!ctx.blenderConnected) return null; // precondition() already says it all
      return { kind: "blender", tool: "get_scene_info", args: {}, timeoutMs: PROBE_TIMEOUT_MS, mode };
    }
    if (mode === "blockbench") {
      if (!ctx.blockbenchConnected) return null;
      return { kind: "blockbench", tool: "bb_status", args: { max_depth: 3 }, timeoutMs: PROBE_TIMEOUT_MS, mode };
    }
    return { kind: "luau", code: PREFLIGHT_LUA[mode], timeoutMs: PROBE_TIMEOUT_MS, mode };
  }

  // Tolerant JSON: execute_luau results are the returned string, but some
  // bridges prefix "Output of 'execute_luau':" or wrap in text. Returns null
  // when nothing object-like is found.
  function parseResult(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    try { const v = JSON.parse(s); if (v && typeof v === "object") return v; } catch {}
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) { try { const v = JSON.parse(s.slice(a, b + 1)); if (v && typeof v === "object") return v; } catch {} }
    return null;
  }

  const header = (mode, word) => "━━━ " + BADGE[normalize(mode)] + " " + word + " (System note from TotalScript, not the user) ━━━";
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
  const list = (arr) => (Array.isArray(arr) ? arr : []).map((x) => String(x)).filter(Boolean);

  function perfNote(perf) {
    if (!perf || typeof perf !== "object") return "";
    const cur = perf.latest || {};
    const errs = Array.isArray(perf.errors) ? perf.errors : [];
    const alerts = Array.isArray(perf.alerts) ? perf.alerts : [];
    const fps = Number(cur.fps);
    const heap = Number(cur.lua_heap_mb);
    const errCount = (perf.stats && Number(perf.stats.total_errors)) || errs.length;
    const unhealthy = (perf.health && perf.health !== "ok") || errCount > 0 || alerts.length > 0 || (Number.isFinite(fps) && fps > 0 && fps < 48);
    if (!unhealthy) return "";
    const bits = [];
    if (Number.isFinite(fps) && fps > 0) bits.push(fps.toFixed(0) + " FPS");
    if (Number.isFinite(heap) && heap > 0) bits.push("LuaHeap " + heap.toFixed(1) + " MB");
    if (errCount > 0) bits.push(errCount + " runtime error" + (errCount === 1 ? "" : "s"));
    if (alerts.length > 0) bits.push("alerts: " + alerts.slice(0, 2).map((a) => String(a.title || a.msg || a)).join(", "));
    return bits.length ? "Live Studio Profiler (" + (perf.mode || "edit") + "): " + bits.join(" · ") + " - factor these into your plan." : "";
  }

  // renderBrief(mode, data, ctx): data = parsed probe result (or null when the
  // probe failed / timed out — then a short "no facts" note is produced so the
  // model knows the state was NOT read). Blender data = raw get_scene_info text.
  function renderBrief(mode, data, ctx) {
    mode = normalize(mode);
    ctx = ctx || {};
    const lines = [header(mode, "PREFLIGHT")];
    if (mode === "blender") {
      const txt = String(data == null ? "" : (typeof data === "string" ? data : JSON.stringify(data))).trim();
      if (!txt) lines.push("Blender scene could not be read (get_scene_info returned nothing). Run get_scene_info yourself before building.");
      else lines.push("Blender scene (get_scene_info, read before your first command): " + clip(txt.replace(/\s+/g, " "), 700));
      lines.push("Rules this mode enforces: build in Blender → blender_asset_validate + blender_asset_inspect (ASSET gate) → blender_send_to_studio → mesh_import_verify (IMPORT gate). Each blender_* build is read back automatically with get_object_info; the read-back is appended to that command's result.");
    } else if (mode === "blockbench") {
      const txt = String(data == null ? "" : (typeof data === "string" ? data : JSON.stringify(data))).trim();
      if (!txt) lines.push("Blockbench project could not be read (bb_status returned nothing - no project open, or the plugin answered an error). Run bb_status yourself; if there is no project, bb_project {name, format:\"free\"} first.");
      else lines.push("Blockbench project (bb_status, read before your first command): " + clip(txt.replace(/\s+/g, " "), 700));
      lines.push("Rules this mode enforces: build with bb_cubes / bb_group / bb_mesh / bb_mesh_primitive / bb_locator / bb_duplicate, refine with bb_cube_edit / bb_cube_uv / bb_mesh_edit / bb_texture / bb_visibility / bb_remove, and use bb_animate / bb_animation_keyframe / bb_marker for real timelines → bb_screenshot and LOOK at it (MODEL gate) → bb_export {format:\"obj\"|\"gltf\"|\"glb\"} and tell the user the file path + Studio → Home → Import 3D (EXPORT gate). Every bb_* build is read back automatically with bb_status. Never claim the model is in Studio: the import is the user's manual step.");
    } else if (!data || typeof data !== "object") {
      lines.push("The place could not be read before this request (the preflight probe failed or timed out). Do not assume it is empty: inspect with get_studio_state / inspect_service / ui_list_tree before creating anything.");
    } else if (mode === "animate") {
      const rigs = Array.isArray(data.rigs) ? data.rigs : [];
      if (!rigs.length) lines.push("Rigs: NONE found in Workspace / ReplicatedStorage / ServerStorage / StarterPlayer. Before animating, add one (dummy_spawn for a quick Humanoid dummy, or ask the user to insert an R15 / R6 rig with Studio's Rig Builder), then animation_select_rig + rig_joints_inspect.");
      else {
        lines.push("Rigs (" + rigs.length + (rigs.length >= 8 ? "+" : "") + "): " + rigs.slice(0, 8).map((r) => String(r.path || "?") + " [" + String(r.rig || "custom") + (r.controller ? " AnimationController" : "") + ", " + (r.motors || 0) + " Motor6D" + (r.animator ? ", Animator" : ", NO Animator") + (r.hrp ? "" : ", no HumanoidRootPart") + (r.animSaves ? ", AnimSaves" : "") + "]").join("; "));
        const bad = rigs.filter((r) => !r.animator || !(r.motors > 0));
        if (bad.length) lines.push("Fix first: " + bad.map((r) => String(r.path || "?") + (!(r.motors > 0) ? " has no Motor6D joints (poses cannot bind)" : "") + (!r.animator ? " has no Animator (add one under the Humanoid/AnimationController or playback fails)" : "")).join("; ") + ".");
      }
      lines.push("Clips: " + (data.clips || 0) + " KeyframeSequence" + (data.clips === 1 ? "" : "s") + (list(data.clipNames).length ? " (" + list(data.clipNames).join(", ") + ")" : "") + " · Animation objects: " + (data.animations || 0) + " · AnimPlayer (ReplicatedStorage.TotalAnimations.AnimPlayer): " + (data.animPlayer ? "installed" : "NOT installed - anim_player_install before any in-game playback script"));
      if (Array.isArray(data.clipDetails) && data.clipDetails.length) {
        lines.push("Clip timing: " + data.clipDetails.slice(0, 5).map((c) => String(c.name || "?") + " (" + (c.kf || 0) + "kf, " + (Number(c.len) || 0).toFixed(2) + "s" + (c.loop ? ", loop" : "") + ")").join("; "));
      }
      if (list(data.selection).length) lines.push("Selected in Studio: " + list(data.selection).join(", ") + (rigs.some((r) => list(data.selection).includes(r.path)) ? " (a rig - use it as the target unless the user named another)" : ""));
      if (data.playing) lines.push("Studio is PLAYING right now - edits land in the play session, not the saved place. Stop play (start_stop_play) before authoring.");
      const pn = perfNote(ctx.perf);
      if (pn) lines.push(pn);
    } else {
      const L = data.lighting && typeof data.lighting === "object" ? data.lighting : {};
      lines.push("Place: " + (data.parts || 0) + " parts (" + (data.unanchored || 0) + " unanchored) · " + (data.models || 0) + " models · " + (data.scripts || 0) + " scripts · " + (data.guis || 0) + " ScreenGuis · " + (data.remotes || 0) + " remotes · Lighting " + (L.technology || "?") + " @ " + (Number.isFinite(Number(L.clock)) ? Number(L.clock).toFixed(1) : "?") + "h" + (L.atmosphere ? ", Atmosphere" : ", no Atmosphere") + (L.bloom ? ", Bloom" : "") + (data.streaming ? ", Streaming" : ""));
      const inv = [];
      if (list(data.topModels).length) inv.push("Models: " + list(data.topModels).join(", "));
      if (list(data.guiNames).length) inv.push("GUIs: " + list(data.guiNames).join(", "));
      if (list(data.remoteNames).length) inv.push("Remotes: " + list(data.remoteNames).join(", "));
      if (inv.length) lines.push("Existing: " + inv.join(" · ") + " (reuse / extend rather than duplicating).");
      if ((data.parts || 0) === 0 && (data.scripts || 0) === 0) lines.push("The place is EMPTY apart from services - build the scene, the look and the systems; do not look for existing content to reuse.");
      else if ((data.unanchored || 0) > 0) lines.push((data.unanchored || 0) + " unanchored part" + (data.unanchored === 1 ? "" : "s") + " will fall at play time - anchor what you build and check existing props when you touch them.");
      if (list(data.selection).length) lines.push("Selected in Studio: " + list(data.selection).join(", ") + " - the user's selection is the default target.");
      if (data.index) lines.push("Total_ProjectIndex exists - project_index_search / project_index_summary before re-reading scripts.");
      if (data.bench) lines.push("A previous bench_run exists - the next bench_run reports the delta.");
      if (data.playing) lines.push("Studio is PLAYING right now - stop play (start_stop_play) before editing the saved place.");
      const pn = perfNote(ctx.perf);
      if (pn) lines.push(pn);
    }
    lines.push("These are facts read from " + (mode === "blender" ? "Blender" : mode === "blockbench" ? "Blockbench" : "Studio") + " just now; they are not an instruction to acknowledge. Act on them and keep the mode gates: the gate strip in the bar turns ✓ only when the proof command ran.");
    return clip(lines.join("\n"), BRIEF_MAX);
  }

  // Short UI card text for the preflight (toast/track card).
  function briefSummary(mode, data) {
    mode = normalize(mode);
    if (mode === "blender") return data ? "Blender scene read" : "Blender scene not readable";
    if (mode === "blockbench") return data ? "Blockbench project read" : "Blockbench project not readable";
    if (!data || typeof data !== "object") return "place not read (probe failed)";
    if (mode === "animate") return (Array.isArray(data.rigs) ? data.rigs.length : 0) + " rig(s) · " + (data.clips || 0) + " clip(s) · AnimPlayer " + (data.animPlayer ? "installed" : "missing");
    return (data.parts || 0) + " parts · " + (data.scripts || 0) + " scripts · " + (data.guis || 0) + " GUIs · " + (data.remotes || 0) + " remotes";
  }

  // ── 2. GATE TRACKER ────────────────────────────────────────────────────────
  // gates = MODE_GATES[mode] from main.js ([{id,did,proof,nudge}]); runTools =
  // Set/array of tool names run this request. State per gate:
  //   idle    – no command of that family ran yet
  //   pending ◌ a did-family command ran, the proof command has not
  //   proved  ✓ a did-family command ran AND its proof command ran
  // (a proof without a did stays idle: nothing of that family changed)
  function gateStates(gates, runTools) {
    const tools = [...(runTools || [])].map(bare).filter(Boolean);
    return (Array.isArray(gates) ? gates : []).map((g) => {
      const did = tools.some((t) => g.did && g.did.test(t));
      const proved = tools.some((t) => g.proof && g.proof.test(t));
      return { id: g.id, label: GATE_LABEL[g.id] || String(g.id || "").toUpperCase(), state: did ? (proved ? "proved" : "pending") : "idle" };
    });
  }
  const MARK = { idle: "–", pending: "◌", proved: "✓" };
  function gateStrip(mode, states) {
    return BADGE[normalize(mode)] + " " + (states || []).map((s) => s.label + " " + (MARK[s.state] || "–")).join(" · ");
  }
  function gateStripHtml(mode, states) {
    return "<b>" + esc(BADGE[normalize(mode)]) + "</b>" + (states || []).map((s) => "<i class=\"rs-gate rs-gate-" + esc(s.state) + "\" data-gate=\"" + esc(s.id) + "\" data-state=\"" + esc(s.state) + "\" title=\"" + esc(s.label.toLowerCase() + ": " + (s.state === "proved" ? "proof command ran" : s.state === "pending" ? "changed, not yet verified — click to draft proof command" : "nothing of this family ran")) + "\">" + esc(s.label) + " " + (MARK[s.state] || "–") + "</i>").join("");
  }

  // ── 3. VERDICT ─────────────────────────────────────────────────────────────
  // One honest line at completion: which gates were proved, which stayed open
  // (the model changed that family but the proof command never ran) and which
  // were untouched. `rounds` = how many gate reminders were sent this run.
  function verdict(mode, states, rounds) {
    mode = normalize(mode);
    const st = states || [];
    const open = st.filter((s) => s.state === "pending");
    const proved = st.filter((s) => s.state === "proved");
    const touched = st.filter((s) => s.state !== "idle");
    let tail;
    if (!touched.length) tail = "no gated family ran";
    else if (!open.length) tail = "all " + proved.length + " touched gate" + (proved.length === 1 ? "" : "s") + " proved";
    else tail = open.map((s) => s.label + " ✗ (" + GATE_PROOF_HINT[s.id] + " never ran)").join(", ") + (rounds ? " after " + rounds + " reminder" + (rounds === 1 ? "" : "s") : "");
    return BADGE[mode] + " gates: " + (touched.length ? st.filter((s) => s.state !== "idle").map((s) => s.label + " " + (s.state === "proved" ? "✓" : "✗")).join(" ") + " — " : "") + tail;
  }
  const GATE_PROOF_HINT = {
    scripts: "script_read / script_check / playtest", look: "total_screenshot", motion: "animation_preview", quality: "quality_audit", systems: "bench_run",
    asset: "blender_asset_validate / inspect", import: "mesh_import_verify", rig: "animation_preview / validate", playback: "script_check + playtest",
    model: "bb_screenshot / bb_status", export: "bb_export",
  };
  function verdictLevel(states) {
    const st = states || [];
    if (st.some((s) => s.state === "pending")) return "open";
    if (st.some((s) => s.state === "proved")) return "proved";
    return "none";
  }

  // ── 4. AUTO-CHECKS (no chat turn) ──────────────────────────────────────────
  // After a SUCCESSFUL command that creates or changes something addressable,
  // read it back immediately so the model's next decision rests on facts, not
  // on the command's own "ok". Trigger = create-ish name + an extractable path
  // (from the result JSON or the arguments). Read-only tools never trigger.
  const READ_ONLY_RE = /^(total_|list_|get_|debug_|web_|status$|screen_|help|skill_|mode_|memory_)|_(audit|inspect|preview|validate|verify|test|check|read|get|find|list|search|status|info|summary|graph|changes|report|capture|screenshot|lint|diff|simulate)$/;
  const CREATE_RE = {
    creation: /^(part_|model_|generate_procedural_model|ui_|gui_|script_(create|set_source|module|new)|module_scaffold|remote_scaffold|blueprint_install|design_kit_install|fx_|vfx_|lighting|atmosphere|terrain_|prop_|building_|furniture_|vehicle_|weapon_|npc_|spawn_|door_|platform_|mesh_import|blender_send_to_studio|create_instance|insert_model)/,
    blender: /^(blender_(?!asset_(validate|inspect)|render|turntable|status|connect|send_to_studio$)[a-z_]+|execute_blender_code$)/,
    blockbench: /^bb_(project|cubes|cube_edit|group|remove|mesh|mesh_primitive|mesh_edit|texture|animate|undo|redo)$/,
    animate: /^(animation_(build|generate|create|set_pose|add_keyframe|update_keyframe|motion_preset|stagger_parts|polish|refine|import|layer|loop_set|export)|dummy_spawn$|target_dummy_spawn$|motor6d_set$|anim_player_install$|sequence_create$|cutscene_create$)/,
  };
  function extractPath(args, feedback) {
    const fb = String(feedback || "");
    if (/^ERROR/i.test(fb.trim())) return "";
    let m = fb.match(/"(?:path|fullName|full_name|rigPath|rig_path)"\s*:\s*"((?:game\.)?[A-Za-z][A-Za-z0-9_]*(?:\.[^"\\]+)+)"/);
    if (m) return m[1];
    m = fb.match(/\bpath=((?:game\.)?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/);
    if (m) return m[1].trim();
    const a = args || {};
    for (const k of ["path", "rig", "target", "model", "script"]) {
      const v = a[k];
      if (typeof v === "string" && /^(game\.)?[A-Za-z][A-Za-z0-9_]*\.[^\s]+$/.test(v.trim())) return v.trim();
    }
    if (typeof a.parent === "string" && typeof a.name === "string" && /^(game\.)?[A-Za-z][A-Za-z0-9_]*/.test(a.parent.trim()) && a.name.trim()) return a.parent.trim() + "." + a.name.trim();
    return "";
  }
  function readbackLua(path) {
    return [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      LUA_RESOLVE,
      LUA_RIGINFO,
      "local target=resolve(" + lq(path) + ")",
      "if not target then return hs:JSONEncode({found=false,path=" + lq(path) + "}) end",
      "local out={found=true,path=target:GetFullName(),class=target.ClassName,parts=0,anchored=0,scripts=0,children=#target:GetChildren()}",
      "if target:IsA('BasePart') then out.parts=1 if target.Anchored then out.anchored=1 end pcall(function() out.size={target.Size.X,target.Size.Y,target.Size.Z} end) end",
      "for _,d in ipairs(target:GetDescendants()) do",
      " if d:IsA('BasePart') then out.parts=out.parts+1 if d.Anchored then out.anchored=out.anchored+1 end",
      " elseif d:IsA('LuaSourceContainer') then out.scripts=out.scripts+1 end",
      "end",
      "if target:IsA('Model') then pcall(function() local cf,sz=target:GetBoundingBox() out.size={sz.X,sz.Y,sz.Z} end) pcall(function() out.hasPrimary=target.PrimaryPart~=nil end) local r=rigInfo(target) if r then out.rigType=r.rig out.animator=r.animator out.motors=r.motors out.hrp=r.hrp end end",
      "if target:IsA('LuaSourceContainer') then pcall(function() local src=target.Source or '' out.sourceLen=#src out.enabled=(target:IsA('BaseScript') and target.Enabled) or nil local dep=0 if string.find(src,'[^%w_%.]wait%s*%(') or string.find(src,'^wait%s*%(') then dep=dep+1 end if string.find(src,'[^%w_%.]spawn%s*%(') or string.find(src,'^spawn%s*%(') then dep=dep+1 end if string.find(src,'[^%w_%.]delay%s*%(') or string.find(src,'^delay%s*%(') then dep=dep+1 end if string.find(src,':LoadAnimation%s*%(') and string.find(src,'Humanoid') then dep=dep+1 end if dep>0 then out.deprecated=dep end end) end",
      "if target:IsA('KeyframeSequence') then local kf=target:GetKeyframes() out.keyframes=#kf local tmax=0 local poses=0 for _,k in ipairs(kf) do if k.Time>tmax then tmax=k.Time end for _,d in ipairs(k:GetDescendants()) do if d:IsA('Pose') then poses=poses+1 end end end out.length=tmax out.poses=poses out.loop=target.Loop pcall(function() out.priority=target.Priority.Name end) end",
      "if target:IsA('ScreenGui') then local n=0 local zs=0 local oo=0 for _,d in ipairs(target:GetDescendants()) do if d:IsA('GuiObject') then n=n+1 pcall(function() if d.Visible and d.Size==UDim2.new(0,0,0,0) and d.AutomaticSize==Enum.AutomaticSize.None then zs=zs+1 elseif d.Visible and d.Size.X.Scale==0 and d.Size.Y.Scale==0 and (d.Size.X.Offset>0 or d.Size.Y.Offset>0) and d.AutomaticSize==Enum.AutomaticSize.None then oo=oo+1 end end) end end out.guiObjects=n if zs>0 then out.zeroSize=zs end if oo>0 then out.offsetOnly=oo end pcall(function() if not target.Enabled then out.guiEnabled=false end end) end",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  function extractBlenderObject(args, feedback) {
    const a = args || {};
    for (const k of ["name", "object_name", "asset", "asset_name", "target"]) {
      if (typeof a[k] === "string" && a[k].trim()) return a[k].trim();
    }
    const fb = String(feedback || "");
    if (!fb || /^ERROR/i.test(fb.trim())) return "";
    const m = fb.match(/"(?:asset|asset_name|object|object_name|created|name)"\s*:\s*"([A-Za-z0-9_.\- ]{1,64})"/);
    if (m && m[1].trim()) return m[1].trim();
    return "";
  }
  // Returns a probe { kind:"luau", code, label, path } | { kind:"blender", tool:"get_object_info", args:{name}, label } | null
  function autoCheck(mode, toolName, args, feedback) {
    mode = normalize(mode);
    const name = bare(toolName);
    if (!name || READ_ONLY_RE.test(name)) return null;
    if (/^ERROR/i.test(String(feedback || "").trim())) return null;
    if (mode === "blockbench") {
      if (!CREATE_RE.blockbench.test(name)) return null;
      if (name === "bb_texture" && !/^(create|import|apply)$/.test(String(args && args.action || ""))) return null;
      const label = (args && (args.name || args.group || args.shape)) ? String(args.name || args.group || args.shape) : name;
      return { kind: "blockbench", tool: "bb_status", args: { max_depth: 3 }, label, timeoutMs: PROBE_TIMEOUT_MS, mode };
    }
    if (mode === "blender" && CREATE_RE.blender.test(name)) {
      const obj = extractBlenderObject(args, feedback);
      if (!obj) return null;
      return { kind: "blender", tool: "get_object_info", args: { name: obj }, label: obj, timeoutMs: PROBE_TIMEOUT_MS, mode };
    }
    const re = mode === "blender" || mode === "blockbench" ? CREATE_RE.creation : CREATE_RE[mode];
    if (!re || !re.test(name)) return null;
    const path = extractPath(args, feedback);
    if (!path) return null;
    return { kind: "luau", code: readbackLua(path), label: path, path, timeoutMs: PROBE_TIMEOUT_MS, mode };
  }
  const fmtSize = (s) => (Array.isArray(s) && s.length === 3 ? s.map((v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : "?")).join("×") : "");
  // renderAutoCheck(probe, raw): the line appended to the command's feedback,
  // "" when the probe produced nothing usable (never invent facts).
  function renderAutoCheck(probe, raw) {
    if (!probe) return "";
    if (probe.kind === "blender") {
      const txt = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
      if (!txt) return "";
      return clip("[MODE AUTO-CHECK get_object_info " + probe.label + "] " + txt, AUTO_MAX);
    }
    if (probe.kind === "blockbench") {
      const txt = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
      if (!txt) return "";
      return clip("[MODE AUTO-CHECK bb_status after " + probe.label + "] " + txt, AUTO_MAX);
    }
    const d = parseResult(raw);
    if (!d) return "";
    if (d.found === false) return "[MODE AUTO-CHECK] " + String(probe.path || probe.label) + ": NOT FOUND after the command - the result claimed success but nothing is at that path. Re-check the parent / name before building on it.";
    const bits = [String(d.class || "?")];
    if (d.parts > 0) bits.push(d.parts + " part" + (d.parts === 1 ? "" : "s") + (fmtSize(d.size) ? " · " + fmtSize(d.size) : "") + " · anchored " + (d.anchored || 0) + "/" + d.parts);
    else if (fmtSize(d.size)) bits.push(fmtSize(d.size));
    if (d.scripts > 0) bits.push(d.scripts + " script" + (d.scripts === 1 ? "" : "s"));
    if (typeof d.sourceLen === "number") bits.push(d.sourceLen + " chars" + (d.enabled === false ? " · DISABLED" : ""));
    if (typeof d.guiObjects === "number") bits.push(d.guiObjects + " GuiObjects");
    if (d.rigType) bits.push("rig " + d.rigType + " · " + (d.motors || 0) + " Motor6D · " + (d.animator ? "Animator" : "NO Animator") + (d.hrp ? "" : " · no HumanoidRootPart"));
    if (typeof d.keyframes === "number") bits.push(d.keyframes + " keyframes · " + (d.poses || 0) + " poses · " + (Number(d.length) || 0).toFixed(2) + "s" + (d.loop ? " · loop" : "") + (d.priority ? " · " + d.priority : ""));
    const warn = [];
    if (d.parts > 0 && (d.anchored || 0) < d.parts && probe.mode !== "animate" && !d.rigType) warn.push((d.parts - (d.anchored || 0)) + " unanchored");
    if (d.rigType && !(d.motors > 0)) warn.push("no Motor6D - poses cannot bind");
    if (d.rigType && !d.animator) warn.push("no Animator");
    if (typeof d.keyframes === "number" && d.keyframes < 2) warn.push("fewer than 2 keyframes - nothing moves");
    else if (typeof d.keyframes === "number" && d.keyframes >= 2 && d.poses === 0) warn.push("0 poses - rig will not deform");
    if (typeof d.sourceLen === "number" && d.sourceLen === 0) warn.push("empty Source");
    if (typeof d.deprecated === "number" && d.deprecated > 0) warn.push(d.deprecated + " deprecated API(s) - use task.wait/task.spawn/Animator");
    if (d.hasPrimary === false && d.parts > 1 && !d.rigType) warn.push("no PrimaryPart");
    if (d.guiEnabled === false) warn.push("ScreenGui Enabled=false");
    if (typeof d.zeroSize === "number" && d.zeroSize > 0) warn.push(d.zeroSize + " visible GuiObject(s) at zero size");
    if (typeof d.offsetOnly === "number" && d.offsetOnly > 0) warn.push(d.offsetOnly + " offset-only GuiObject(s) - use Scale for responsive UI");
    return clip("[MODE AUTO-CHECK] " + String(d.path || probe.path) + ": " + bits.join(" · ") + (warn.length ? " — CHECK: " + warn.join("; ") : ""), AUTO_MAX);
  }

  // ── 4b. AgentScript (local workspace) preflight ───────────────────────────
  // Separate helper so preflight(mode, {engine:"local"}) stays null for
  // existing Roblox work-mode contracts while AS sessions still get zero-turn
  // workspace orientation (top-level files + detected language/build stack).
  function localPreflight() {
    return { kind: "local", tool: "list_dir", args: { path: "." }, timeoutMs: PROBE_TIMEOUT_MS, mode: "local" };
  }
  function renderLocalBrief(raw) {
    const txt = String(raw == null ? "" : raw).replace(/^Output of '[^']*':\s*/i, "").trim();
    if (!txt || /^ERROR\b/i.test(txt)) return "";
    const entries = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 32);
    if (!entries.length) return "";
    const joined = entries.join(" ");
    const stack = [];
    if (/\bpackage\.json\b/i.test(joined)) stack.push("Node/JS");
    if (/\btsconfig\.json\b/i.test(joined)) stack.push("TypeScript");
    if (/\bCargo\.toml\b/i.test(joined)) stack.push("Rust/Cargo");
    if (/\b(?:pyproject\.toml|requirements\.txt|setup\.py)\b/i.test(joined)) stack.push("Python");
    if (/\bdefault\.project\.json\b/i.test(joined)) stack.push("Rojo/Roblox");
    if (/\bgo\.mod\b/i.test(joined)) stack.push("Go");
    if (/(?:^|\s)\.git(?=[/\s]|$)/i.test(joined)) stack.push("Git");
    const lines = [
      "━━━ AGENTSCRIPT PREFLIGHT (System note from TotalScript, not the user) ━━━",
      "Workspace root (" + entries.length + (entries.length >= 32 ? "+" : "") + " entries" + (stack.length ? " · stack: " + stack.join(", ") : "") + "): " + clip(entries.join(", "), 420),
      "Read target files with read_range/read_file before editing, batch up to 4 independent commands per reply, and verify edits by reading back or running tests with run_command.",
    ];
    return clip(lines.join("\n"), BRIEF_MAX);
  }

  // ── 5. PRECONDITION ────────────────────────────────────────────────────────
  function precondition(mode, ctx) {
    mode = normalize(mode);
    ctx = ctx || {};
    if (mode === "blender" && !ctx.blenderConnected) {
      return {
        ok: false,
        title: "Blender mode — Blender is not connected",
        message: "Blender work mode needs the Blender MCP add-on running (Blender → N-panel → Start MCP Server, then Menu → Connect Blender). Until then every blender_* command fails.",
        brief: header("blender", "PREFLIGHT") + "\nBLENDER NOT CONNECTED. Every blender_* command will fail right now. Do NOT emulate Blender with execute_luau or claim a Blender result. Tell the user to start the Blender MCP server (N-panel → Start MCP Server) and connect it from the TotalScript menu; Studio-side work (scripts, UI, lighting) can proceed meanwhile.\nDo not acknowledge this note; act on it.",
      };
    }
    if (mode === "blockbench" && !ctx.blockbenchConnected) {
      return {
        ok: false,
        title: "Blockbench mode — Blockbench is not connected",
        message: "Blockbench work mode needs the TotalScript plugin inside Blockbench: start the TotalScript desktop app (total-core), then in Blockbench once File → Plugins → Load Plugin from File → TotalScript-Blockbench.js (Settings → Blockbench in the bar shows the file path and a Check again button). The plugin connects to total-core by itself. Until then every bb_* command fails.",
        brief: header("blockbench", "PREFLIGHT") + "\nBLOCKBENCH NOT CONNECTED. Every bb_* command will fail right now. Do NOT emulate Blockbench with execute_luau or claim a Blockbench result. Tell the user in one sentence: start the TotalScript desktop app and load TotalScript-Blockbench.js once in Blockbench (File → Plugins → Load Plugin from File); the plugin then connects by itself and Tools → TotalScript in Blockbench shows the state. Studio-side work (scripts, parts, the Import 3D of an existing file by the user) still works.",
      };
    }
    return { ok: true };
  }

  // ── 6. OP TARGET TRACKING, GATE ACTIONS, INTENT ROUTER & QUICK MISSIONS ───
  function extractTarget(mode, toolName, args, feedback) {
    mode = normalize(mode);
    const name = bare(toolName);
    if (!name || READ_ONLY_RE.test(name)) return "";
    if (/^ERROR/i.test(String(feedback || "").trim())) return "";
    if (mode === "blender" && /^blender_|^execute_blender_code$|^mesh_/.test(name)) {
      const obj = extractBlenderObject(args, feedback);
      if (obj) return obj;
    }
    if (mode === "blockbench" && /^bb_/.test(name)) {
      const a = args || {};
      if (typeof a.group === "string" && a.group.trim()) return a.group.trim();
      if (typeof a.name === "string" && a.name.trim()) return a.name.trim();
      if (Array.isArray(a.cubes) && a.cubes[0] && a.cubes[0].name) return String(a.cubes[0].name).trim();
    }
    return extractPath(args, feedback);
  }

  function targetNote(mode, failingIds, targets) {
    const clean = [...new Set(list(targets))].slice(0, 6);
    if (!clean.length) return "";
    mode = normalize(mode);
    const ids = list(failingIds);
    const hint = mode === "blender"
      ? "verify these exact Blender assets/imports in ONE batch"
      : mode === "blockbench"
        ? "screenshot and export these Blockbench assets in ONE batch"
        : mode === "animate"
          ? "preview/validate these exact rigs/clips in ONE batch"
          : "verify these exact paths in ONE batch";
    return "Touched targets (" + (ids.length ? ids.join(", ") : mode) + "): " + clean.join(", ") + " — " + hint + ".";
  }

  function gateVerifyPrompt(mode, gateId, targets) {
    mode = normalize(mode);
    const tList = [...new Set(list(targets))].slice(0, 4);
    const tSuffix = tList.length ? " (" + tList.join(", ") + ")" : "";
    const prompts = {
      scripts: "Verify the changed scripts" + tSuffix + ": run script_read + script_check, then start_stop_play + get_console_output and fix any errors or warnings until clean.",
      look: "Inspect the visual pass" + tSuffix + ": take total_screenshot {target:\"studio\"}, critique contrast, lighting, hierarchy and readability like an art director, and run one polish pass.",
      motion: "Verify the authored motion" + tSuffix + ": run animation_preview (or start_stop_play for tweens/cutscenes), judge timing, arcs and loop seams, and fix anything rough.",
      quality: "Run quality_audit" + (tList[0] ? " on " + tList[0] : "") + ", apply quality_fix for mechanical findings, fix remaining high/medium items, and re-audit until score >= 85.",
      systems: "Run bench_run across the systems" + tSuffix + ", fix every high security/robustness finding (remote validation, pcall/BindToClose saves, button wiring), and re-run until grade A (>= 85).",
      asset: "Validate and inspect the Blender asset" + tSuffix + ": run blender_asset_validate + blender_asset_inspect {views:[\"iso\",\"front\",\"closeup\"]}, fix every silhouette/material/normal flaw you see.",
      import: "Run mesh_import_verify on the imported Studio asset" + tSuffix + " (check placeholders, scale, pivot, materials, collisions) and fix any discrepancies in Blender before re-sending.",
      rig: "Play and validate the animation" + tSuffix + ": run animation_polish {aaa_pass:true} if rough, then animation_preview on the pinned rig + animation_validate, inspect arcs, timing, weight, Footstep/HitFrame markers and loop seams, and refine any pops.",
      playback: "Verify in-game animation playback" + tSuffix + ": run script_read + script_check on the playback script, then start_stop_play + get_console_output to prove the track plays cleanly.",
      model: "Inspect the Blockbench model" + tSuffix + ": run bb_screenshot {} + bb_status, check silhouette, gaps, z-fighting and pivots, and fix what you see.",
      export: "Export the finished Blockbench model" + tSuffix + " with bb_export {format:\"obj\"} (or glb/gltf) and give me the exact file path plus Studio Home → Import 3D steps.",
    };
    return prompts[String(gateId || "")] || ("Verify the open " + String(gateId || mode).toUpperCase() + " gate" + tSuffix + " using the mode's proof commands.");
  }

  const MODE_SIGNALS = {
    blender: [
      [/\bblender\b/i, 6],
      [/\b(sculpt|retopo|subsurf|subdivision surface|bevel modifier|boolean modifier|bake textures?|turntable render|cycles render|eevee|uv unwrap|surfaceappearance|pbr bake|high[- ]?poly|fbx|glb)\b/i, 4],
      [/\b(blender_asset|execute_blender_code|mesh_import_verify|studio_grey|three_point)\b/i, 5],
      [/\b(product render|hero weapon|modular dungeon kit|procedural tree|rock cluster)\b/i, 2],
    ],
    animate: [
      [/\b(keyframe|keyframeSequence|r15|r6|motor6d|animplayer|walk cycle|run cycle|idle loop|combat combo|3[- ]?hit combo|sword swing|hit reaction|parry animation|emote|cutscene|animation_preview|animation_generate)\b/i, 4],
      [/\b(animate|animation|animations|rigging|rig joints|locomotion set|blend space|pose|anticipation|follow[- ]?through)\b/i, 3],
      [/\b(humanoid:loadanimation|animator:loadanimation)\b/i, 4],
    ],
    blockbench: [
      [/\b(blockbench|bbmodel|bb_cubes|bb_mesh|bb_export)\b/i, 6],
      [/\b(voxel|blocky|minecraft[- ]?style|low[- ]?poly cube|16[- ]?unit|import 3d)\b/i, 3],
    ],
    creation: [
      [/\b(datastore|leaderstats|remoteevent|remotefunction|serverscriptservice|replicatedstorage|startergui|screengui|shop system|currency system|inventory system|quest system|game hud|ui_screen_generate|blueprint_install|project_index|bench_run)\b/i, 4],
      [/\b(luau|localscript|modulescript|script|terrain|lighting preset|vfx|magic circle|particle|game system|full game|lobby|ob[b]?y|tycoon|simulator)\b/i, 2],
    ],
  };
  const MODE_REASON = {
    creation: "Full Roblox Luau system / UI / VFX / world build fits Totality mode",
    blender: "3D modeling / PBR bake / render pipeline fits Blender mode",
    animate: "Rig keyframes / combat combo / locomotion / cutscene fits Animator mode",
    blockbench: "Blockbench low-poly / cube-mesh export workflow fits Blockbench mode",
  };
  const MODE_NAME = { creation: "Totality", blender: "Blender", animate: "Animator", blockbench: "Blockbench" };

  function recommendMode(prompt, ctx) {
    ctx = ctx || {};
    if (ctx.engine === "local") return null;
    const text = String(prompt || "").trim();
    if (text.length < 10) return null;
    const current = normalize(ctx.currentMode);
    const scores = { creation: 0, blender: 0, animate: 0, blockbench: 0 };
    for (const id of IDS) {
      let s = 0;
      for (const [re, w] of MODE_SIGNALS[id]) {
        const hits = text.match(new RegExp(re.source, "gi"));
        if (hits && hits.length) s += w * Math.min(2, hits.length);
      }
      scores[id] = s;
    }
    let best = current, bestScore = -1, secondScore = -1;
    for (const id of IDS) {
      if (scores[id] > bestScore) { secondScore = bestScore; bestScore = scores[id]; best = id; }
      else if (scores[id] > secondScore) secondScore = scores[id];
    }
    if (best === current) return null;
    const margin = bestScore - Math.max(0, scores[current]);
    if (bestScore < 5 || margin < 3) return null;
    return {
      mode: best,
      badge: BADGE[best],
      name: MODE_NAME[best],
      score: bestScore,
      margin,
      reason: MODE_REASON[best],
      needsConnect: (best === "blender" && ctx.blenderConnected === false) || (best === "blockbench" && ctx.blockbenchConnected === false),
    };
  }

  const QUICK_MISSIONS = Object.freeze({
    creation: Object.freeze([
      { id: "totality-system", tag: "SYSTEMS", label: "Full Economy + Shop", desc: "Server-authoritative currency, DataStore saves, responsive Shop UI & bench A+", prompt: "Install and wire a complete, server-authoritative Coins + Shop system: session-safe DataStore persistence (pcall + BindToClose + PlayerRemoving), leaderstats, validated RemoteEvents with rate limiting, and a responsive modern Shop ScreenGui using design tokens. Verify with script_check, bench_run (>= 85), ui_audit, total_screenshot and a live playtest." },
      { id: "totality-scene", tag: "WORLD", label: "AAA Map + Lighting", desc: "Hero landmark, terrain, Future lighting, atmosphere & quality_audit >= 85", prompt: "Build a cohesive hero landmark scene in Workspace (real scale, rich architectural silhouette, deliberate material palette — zero default grey, all parts anchored and grouped with PrimaryPart), then apply a cinematic Future lighting + Atmosphere + Bloom stack. Score with quality_audit (>= 85) and prove with total_screenshot from two angles + polish pass." },
      { id: "totality-ui", tag: "UI/UX", label: "Pro Responsive HUD", desc: "Design-token HUD, animated panels, mobile-safe Scale & ui_audit", prompt: "Create a cohesive responsive game HUD + Menu + Inventory UI system using design_tokens_set: crisp dark glass styling, strict Scale layout (zero offset-only breakage on mobile), hover/click feedback tweens, and clean LocalScript wiring. Run ui_audit + quality_audit + total_screenshot and polish any overlap or contrast issues." },
      { id: "totality-vfx", tag: "COMBAT", label: "Boss Ability + VFX", desc: "Layered spell particles, dynamic light, camera shake & clean server cooldown", prompt: "Build a signature boss/player ability with server-validated cooldown, hitbox, layered VFX (core emitter, sparks, magic circle, dynamic flickering light, sound), and subtle camera shake. Verify scripts with script_check, playtest with clean console, and capture mid-burst with total_screenshot." },
    ]),
    blender: Object.freeze([
      { id: "blender-weapon", tag: "HERO ASSET", label: "Hero PBR Weapon", desc: "Plan → bmesh build → validate → inspect → bake → Studio import verify", prompt: "In Blender, craft a game-ready stylized hero weapon (1.2 m): plan the spec with blender_asset_plan, build clean beveled silhouette geometry with layered materials, run blender_asset_validate + blender_asset_inspect (iso, front, closeup) and refine any flaws, bake PBR maps, send to Studio with blender_send_to_studio, and verify with mesh_import_verify." },
      { id: "blender-kit", tag: "MODULAR", label: "4m Modular Kit", desc: "Grid-snapped wall, doorway, pillar, arch & stairs — matched materials", prompt: "Build a 4 m × 3 m grid-snapped modular architectural kit in Blender (solid wall, doorway wall, window wall, corner pillar, archway, stairs) with shared stylized materials, clean origin/pivots at floor center, and strict triangle budget. Validate and inspect an assembled bay, send to Studio, run mesh_import_verify and assemble a 2-bay showcase Model." },
      { id: "blender-biome", tag: "BIOME", label: "Island Biome Pack", desc: "Terrain tile, rock clusters, crystals & stylized trees under 40k tris", prompt: "Create an island biome pack in Blender (terrain tile, 2 rock formations, crystal cluster, 3 stylized trees) sharing one cohesive color/material palette under 40k triangles total. Validate and inspect, send to Studio, verify with mesh_import_verify, set matching outdoor lighting and screenshot from two angles." },
      { id: "blender-turntable", tag: "RENDER", label: "Studio Turntable", desc: "3-point light rig, DoF product camera, Eevee preview → Cycles hero shot", prompt: "Stage the current Blender asset for a portfolio showcase: studio_grey backdrop, three-point lighting rig, product camera with subtle depth of field, Eevee framing check, then a crisp Cycles hero render and 360° turntable. Clean up the temporary light/camera rig afterward." },
    ]),
    animate: Object.freeze([
      { id: "anim-combo", tag: "COMBAT", label: "3-Hit Sword Combo", desc: "Anticipation/hit/follow-through, Hit markers, AnimPlayer & playtest", prompt: "Select the active rig (read its joints & R15/R6 type first) and author a 3-hit melee combo (light slash, reverse slash, heavy overhead finisher) with clear anticipation, snappy impact frames, follow-through, Hit markers, and shared stance. Preview each clip on the rig, run animation_validate + animation_compatibility, install AnimPlayer, write the combo LocalScript, and playtest every branch." },
      { id: "anim-loco", tag: "LOCOMOTION", label: "Idle / Walk / Run Set", desc: "Contact-down-passing-up loops, clean seams & speed-blended playback", prompt: "Build a complete locomotion set (Idle, Walk, Run) on the active rig with proper contact/down/passing/up poses, mirrored second halves, and seamless loop boundaries. Preview every clip on the rig, verify animation_compatibility, wire Animator playback with speed transitions, and playtest." },
      { id: "anim-dash", tag: "ABILITY", label: "Dash + Camera FX", desc: "Crouch-burst-slide clip, trail VFX, camera shake & server cooldown", prompt: "Author a snappy forward dash animation (anticipation crouch, explosive burst, slide recover) on the active rig, combine it into an ability sequence with trail VFX, camera shake, and sound. Preview and validate the sequence, wire server-authoritative cooldown + client Animator playback, and playtest." },
      { id: "anim-cutscene", tag: "CINEMATIC", label: "3-Shot Cutscene", desc: "Establishing dolly, hero close-up, reveal beat & join trigger", prompt: "Create a 10-second 3-shot intro cutscene (establishing dolly, character close-up, dramatic reveal) coordinated with rig animation beats. Run cutscene_preview + total_screenshot on key beats, wire a clean client trigger, and verify with a playtest." },
    ]),
    blockbench: Object.freeze([
      { id: "bb-weapon", tag: "LOW-POLY", label: "Low-Poly Hero Blade", desc: "Grouped blade/guard/grip pivots, crisp flat textures & OBJ export", prompt: "In Blockbench, model a stylized 40-unit low-poly hero sword with separate pivoted groups (Blade, Crossguard, Grip, Pommel), crisp 3-4 tone flat textures, bb_screenshot from front and iso to refine silhouette and fix gaps/z-fighting, then bb_export {format:\"obj\"} and provide exact Studio Home → Import 3D steps and scale." },
      { id: "bb-mob", tag: "CHARACTER", label: "Rigged Blocky Mob", desc: "Joint-pivoted limbs, idle + walk timelines & glTF export", prompt: "Model a 32-unit blocky character/mob in Blockbench with clean outliner groups and joint pivots (Body, Head, ArmL, ArmR, LegL, LegR), cohesive flat-color textures, and idle + walk timelines via bb_animate. Inspect with bb_screenshot (front/side), fix proportions, and bb_export {format:\"gltf\"} with Studio Import 3D instructions." },
      { id: "bb-kit", tag: "VOXEL KIT", label: "16u Dungeon Kit", desc: "Grid-aligned wall, door, pillar, floor & stairs — shared import scale", prompt: "Build a modular 16-unit grid low-poly dungeon kit in Blockbench (wall, doorway, window wall, pillar, floor, stairs) as clean origin-aligned groups with cohesive stone/wood palette. Screenshot an assembled bay with bb_screenshot, verify counts with bb_status, and bb_export each piece as OBJ with shared Studio Import 3D scale." },
      { id: "bb-mesh", tag: "HYBRID MESH", label: "Mesh Roof + Props", desc: "bb_mesh_primitive cones/cylinders + cubes, textured & GLB export", prompt: "Create a stylized low-poly cottage roof & prop set in Blockbench combining cubes with bb_mesh_primitive (pyramid roof, cylinder chimney, lantern) inside cleanly pivoted groups. Apply cohesive textures, inspect iso + front with bb_screenshot, and bb_export {format:\"glb\"} with Studio Import 3D steps." },
    ]),
  });

  return Object.freeze({
    VERSION, IDS, BADGE, DOES, BRIEF_MAX, AUTO_MAX, PROBE_TIMEOUT_MS, GATE_LABEL,
    normalize, preflight, parseResult, renderBrief, briefSummary,
    gateStates, gateStrip, gateStripHtml, verdict, verdictLevel,
    autoCheck, extractPath, readbackLua, renderAutoCheck, precondition,
    localPreflight, renderLocalBrief,
    extractTarget, targetNote, gateVerifyPrompt, recommendMode, QUICK_MISSIONS,
    PROBE_MARK, _lua: { PREFLIGHT_LUA, LUA_RESOLVE, LUA_RIGINFO },
  });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalWorkModes; } catch {}
try { if (typeof window !== "undefined") window.TotalWorkModes = TotalWorkModes; } catch {}
