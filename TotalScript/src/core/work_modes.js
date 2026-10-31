// SPDX-License-Identifier: MIT
// src/core/work_modes.js — TotalWorkModes (1.99.9)
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
  const VERSION = "1.99.9";
  const IDS = ["creation", "blender", "animate"];
  const BADGE = { creation: "TOTALITY", blender: "BLENDER", animate: "ANIMATOR" };
  const BRIEF_MAX = 1200;
  const AUTO_MAX = 600;
  const PROBE_TIMEOUT_MS = 8000;
  // Mode gate ids (pinned in main.js MODE_GATES; the labels are display only).
  const GATE_LABEL = {
    scripts: "SCRIPTS", look: "LOOK", motion: "MOTION", quality: "QUALITY", systems: "SYSTEMS",
    asset: "ASSET", import: "IMPORT", rig: "RIG", playback: "PLAYBACK",
  };
  // What each mode does at run time — shown in the mode picker (separate line,
  // the WORK_MODES literal in popup/bar is pinned by tests and stays as is).
  const DOES = {
    creation: "Preflight reads the place (parts, scripts, GUIs, remotes, lighting, selection) before the first command; live gate strip SCRIPTS / LOOK / MOTION / QUALITY / SYSTEMS; every build command is read back automatically; up to 2 verification rounds; verdict card at the end.",
    blender: "Checks the Blender bridge BEFORE the model acts (not connected = hard stop note + banner); preflight reads the Blender scene; gate strip ASSET / IMPORT / SCRIPTS / LOOK; every blender_* build is read back with get_object_info; verdict card at the end.",
    animate: "Preflight lists the rigs (RigType, Animator, Motor6D count), existing clips and whether AnimPlayer is installed; gate strip RIG / PLAYBACK / SCRIPTS / LOOK; clips and rigs are read back after every authoring command; verdict card at the end.",
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
    " return {path=m:GetFullName(),rig=rt,animator=animator~=nil,motors=motors,hrp=m:FindFirstChild('HumanoidRootPart')~=nil,controller=(ac~=nil and hum==nil)}",
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
      "local out={mode='creation',parts=0,unanchored=0,models=0,scripts=0,guis=0,remotes=0,selection={},lighting={},playing=false,index=false,bench=false}",
      "for _,d in ipairs(workspace:GetDescendants()) do",
      " if d:IsA('BasePart') then out.parts=out.parts+1 if not d.Anchored then out.unanchored=out.unanchored+1 end",
      " elseif d:IsA('Model') then out.models=out.models+1 end",
      "end",
      "for _,n in ipairs({'ServerScriptService','ServerStorage','ReplicatedStorage','StarterPlayer','StarterGui','Workspace'}) do",
      " local ok,svc=pcall(function() return game:GetService(n) end)",
      " if ok and svc then for _,d in ipairs(svc:GetDescendants()) do",
      "  if d:IsA('LuaSourceContainer') then out.scripts=out.scripts+1 elseif d:IsA('RemoteEvent') or d:IsA('RemoteFunction') then out.remotes=out.remotes+1 end",
      " end end",
      "end",
      "for _,g in ipairs(game:GetService('StarterGui'):GetChildren()) do if g:IsA('ScreenGui') then out.guis=out.guis+1 end end",
      "pcall(function() local L=game:GetService('Lighting') local lg={technology='?',clock=L.ClockTime} pcall(function() lg.technology=tostring(L.Technology.Name) end) pcall(function() lg.atmosphere=L:FindFirstChildOfClass('Atmosphere')~=nil lg.bloom=L:FindFirstChildOfClass('BloomEffect')~=nil end) out.lighting=lg end)",
      "pcall(function() local ss=game:GetService('ServerStorage') out.index=ss:FindFirstChild('Total_ProjectIndex')~=nil out.bench=ss:FindFirstChild('_TotalBench')~=nil end)",
      LUA_TAIL_COMMON,
    ].join("\n"),
    animate: [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      "local out={mode='animate',rigs={},clips=0,clipNames={},animations=0,animPlayer=false,selection={},playing=false}",
      LUA_RIGINFO,
      "local seen=0",
      "for _,n in ipairs({'Workspace','ReplicatedStorage','ServerStorage','StarterPlayer'}) do",
      " local ok,svc=pcall(function() return game:GetService(n) end)",
      " if ok and svc then for _,d in ipairs(svc:GetDescendants()) do",
      "  if d:IsA('Model') and seen<8 then local r=rigInfo(d) if r then seen=seen+1 out.rigs[#out.rigs+1]=r end end",
      "  if d:IsA('KeyframeSequence') then out.clips=out.clips+1 if #out.clipNames<8 then out.clipNames[#out.clipNames+1]=d.Name end end",
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
    } else if (!data || typeof data !== "object") {
      lines.push("The place could not be read before this request (the preflight probe failed or timed out). Do not assume it is empty: inspect with get_studio_state / inspect_service / ui_list_tree before creating anything.");
    } else if (mode === "animate") {
      const rigs = Array.isArray(data.rigs) ? data.rigs : [];
      if (!rigs.length) lines.push("Rigs: NONE found in Workspace / ReplicatedStorage / ServerStorage / StarterPlayer. Before animating, add one (dummy_spawn for a quick Humanoid dummy, or ask the user to insert an R15 / R6 rig with Studio's Rig Builder), then animation_select_rig + rig_joints_inspect.");
      else {
        lines.push("Rigs (" + rigs.length + (rigs.length >= 8 ? "+" : "") + "): " + rigs.slice(0, 8).map((r) => String(r.path || "?") + " [" + String(r.rig || "custom") + (r.controller ? " AnimationController" : "") + ", " + (r.motors || 0) + " Motor6D" + (r.animator ? ", Animator" : ", NO Animator") + (r.hrp ? "" : ", no HumanoidRootPart") + "]").join("; "));
        const bad = rigs.filter((r) => !r.animator || !(r.motors > 0));
        if (bad.length) lines.push("Fix first: " + bad.map((r) => String(r.path || "?") + (!(r.motors > 0) ? " has no Motor6D joints (poses cannot bind)" : "") + (!r.animator ? " has no Animator (add one under the Humanoid/AnimationController or playback fails)" : "")).join("; ") + ".");
      }
      lines.push("Clips: " + (data.clips || 0) + " KeyframeSequence" + (data.clips === 1 ? "" : "s") + (list(data.clipNames).length ? " (" + list(data.clipNames).join(", ") + ")" : "") + " · Animation objects: " + (data.animations || 0) + " · AnimPlayer (ReplicatedStorage.TotalAnimations.AnimPlayer): " + (data.animPlayer ? "installed" : "NOT installed - anim_player_install before any in-game playback script"));
      if (list(data.selection).length) lines.push("Selected in Studio: " + list(data.selection).join(", ") + (rigs.some((r) => list(data.selection).includes(r.path)) ? " (a rig - use it as the target unless the user named another)" : ""));
      if (data.playing) lines.push("Studio is PLAYING right now - edits land in the play session, not the saved place. Stop play (start_stop_play) before authoring.");
    } else {
      const L = data.lighting && typeof data.lighting === "object" ? data.lighting : {};
      lines.push("Place: " + (data.parts || 0) + " parts (" + (data.unanchored || 0) + " unanchored) · " + (data.models || 0) + " models · " + (data.scripts || 0) + " scripts · " + (data.guis || 0) + " ScreenGuis · " + (data.remotes || 0) + " remotes · Lighting " + (L.technology || "?") + " @ " + (Number.isFinite(Number(L.clock)) ? Number(L.clock).toFixed(1) : "?") + "h" + (L.atmosphere ? ", Atmosphere" : ", no Atmosphere") + (L.bloom ? ", Bloom" : ""));
      if ((data.parts || 0) === 0 && (data.scripts || 0) === 0) lines.push("The place is EMPTY apart from services - build the scene, the look and the systems; do not look for existing content to reuse.");
      else if ((data.unanchored || 0) > 0) lines.push((data.unanchored || 0) + " unanchored part" + (data.unanchored === 1 ? "" : "s") + " will fall at play time - anchor what you build and check existing props when you touch them.");
      if (list(data.selection).length) lines.push("Selected in Studio: " + list(data.selection).join(", ") + " - the user's selection is the default target.");
      if (data.index) lines.push("Total_ProjectIndex exists - project_index_search / project_index_summary before re-reading scripts.");
      if (data.bench) lines.push("A previous bench_run exists - the next bench_run reports the delta.");
      if (data.playing) lines.push("Studio is PLAYING right now - stop play (start_stop_play) before editing the saved place.");
    }
    lines.push("These are facts read from " + (mode === "blender" ? "Blender" : "Studio") + " just now; they are not an instruction to acknowledge. Act on them and keep the mode gates: the gate strip in the bar turns ✓ only when the proof command ran.");
    return clip(lines.join("\n"), BRIEF_MAX);
  }

  // Short UI card text for the preflight (toast/track card).
  function briefSummary(mode, data) {
    mode = normalize(mode);
    if (mode === "blender") return data ? "Blender scene read" : "Blender scene not readable";
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
    return "<b>" + esc(BADGE[normalize(mode)]) + "</b>" + (states || []).map((s) => "<i class=\"rs-gate rs-gate-" + esc(s.state) + "\" title=\"" + esc(s.label.toLowerCase() + ": " + (s.state === "proved" ? "proof command ran" : s.state === "pending" ? "changed, not yet verified" : "nothing of this family ran")) + "\">" + esc(s.label) + " " + (MARK[s.state] || "–") + "</i>").join("");
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
      "if target:IsA('Model') then pcall(function() local cf,sz=target:GetBoundingBox() out.size={sz.X,sz.Y,sz.Z} end) local r=rigInfo(target) if r then out.rigType=r.rig out.animator=r.animator out.motors=r.motors out.hrp=r.hrp end end",
      "if target:IsA('LuaSourceContainer') then pcall(function() out.sourceLen=#target.Source out.enabled=(target:IsA('BaseScript') and target.Enabled) or nil end) end",
      "if target:IsA('KeyframeSequence') then local kf=target:GetKeyframes() out.keyframes=#kf local tmax=0 local poses=0 for _,k in ipairs(kf) do if k.Time>tmax then tmax=k.Time end for _,d in ipairs(k:GetDescendants()) do if d:IsA('Pose') then poses=poses+1 end end end out.length=tmax out.poses=poses out.loop=target.Loop pcall(function() out.priority=target.Priority.Name end) end",
      "if target:IsA('ScreenGui') then local n=0 for _,d in ipairs(target:GetDescendants()) do if d:IsA('GuiObject') then n=n+1 end end out.guiObjects=n end",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  // Returns a probe { kind:"luau", code, label, path } | { kind:"blender", tool:"get_object_info", args:{name}, label } | null
  function autoCheck(mode, toolName, args, feedback) {
    mode = normalize(mode);
    const name = bare(toolName);
    if (!name || READ_ONLY_RE.test(name)) return null;
    if (/^ERROR/i.test(String(feedback || "").trim())) return null;
    if (mode === "blender" && CREATE_RE.blender.test(name)) {
      const a = args || {};
      const obj = typeof a.name === "string" ? a.name.trim() : (typeof a.object_name === "string" ? a.object_name.trim() : "");
      if (!obj) return null;
      return { kind: "blender", tool: "get_object_info", args: { name: obj }, label: obj, timeoutMs: PROBE_TIMEOUT_MS, mode };
    }
    const re = mode === "blender" ? CREATE_RE.creation : CREATE_RE[mode];
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
    if (typeof d.sourceLen === "number" && d.sourceLen === 0) warn.push("empty Source");
    return clip("[MODE AUTO-CHECK] " + String(d.path || probe.path) + ": " + bits.join(" · ") + (warn.length ? " — CHECK: " + warn.join("; ") : ""), AUTO_MAX);
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
    return { ok: true };
  }

  return Object.freeze({
    VERSION, IDS, BADGE, DOES, BRIEF_MAX, AUTO_MAX, PROBE_TIMEOUT_MS, GATE_LABEL,
    normalize, preflight, parseResult, renderBrief, briefSummary,
    gateStates, gateStrip, gateStripHtml, verdict, verdictLevel,
    autoCheck, extractPath, readbackLua, renderAutoCheck, precondition,
    PROBE_MARK, _lua: { PREFLIGHT_LUA, LUA_RESOLVE, LUA_RIGINFO },
  });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalWorkModes; } catch {}
try { if (typeof window !== "undefined") window.TotalWorkModes = TotalWorkModes; } catch {}
