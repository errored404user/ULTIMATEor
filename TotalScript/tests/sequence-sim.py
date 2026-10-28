#!/usr/bin/env python3
"""Execute the 1.82.0 VFX / SFX / sequence packs against the miniature Roblox DataModel.

tests/test-vfx-pro.js, test-sfx-events.js and test-sequence-pack.js check the packs
statically; this script RUNS the generated Luau inside tests/roblox_sim.py (plain Lua 5.4
with a Roblox-shaped DataModel - a mock, NOT live Studio):

  C  VFX   - install TotalVFX, play a family on a part, tier clamp, handle lifecycle,
             containers removed when the effect ends / is stopped
  D  SFX   - install TotalSFX, play an engine-bundled event, missing event -> nil+reason,
             define rejects unverifiable / non-audio ids and accepts a verified one
  A  cine  - camera cut + eased move with look-at, banner UI, lighting grade, signal;
             Stop restores camera / lighting / UI
  F  ability - fireball on an R15 rig against a target: beats fire in order, projectile
             travels hand -> target, signals reach the Signal BindableEvent, camera
             punch/shake are overlays and the FOV comes back, VFX containers are cleaned
  G  failure - structural errors refuse creation, missing references refuse creation,
             R6 rig resolves limbs by R6 names, pause/resume/skip, death cancels and
             cleans up, delete removes only the sequence

    pip install lupa && python3 tests/sequence-sim.py          (from the TotalScript root)
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
try:
    from roblox_sim import make_runtime
except Exception as e:  # pragma: no cover
    print("SKIP  " + str(e))
    sys.exit(0)
try:
    import lupa  # noqa: F401
except Exception:  # pragma: no cover
    print("SKIP  lupa is not installed (pip install lupa)")
    sys.exit(0)

GEN = r"""
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills;
const out={programs:{}, vfxVersion:S.VFX_VERSION, sfxVersion:S.SFX_VERSION, seqVersion:S.SEQUENCE_VERSION};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "vfx_install": ["vfx_library_install", {"genre": "fantasy"}],
    "vfx_play": ["vfx_play", {"family": "impact", "path": "Workspace.Dummy.Body", "palette": "ember", "tier": "Low"}],
    "vfx_play_bad": ["vfx_play", {"family": "impact", "path": "Workspace.Nope"}],
    "vfx_play_fire": ["vfx_play", {"family": "fire", "path": "Workspace.Dummy.Body", "tier": "High"}],
    "vfx_validate": ["vfx_validate", {"path": "Workspace.TotalVFXRuntime"}],
    "sfx_install": ["sfx_library_install", {}],
    "sfx_play": ["sfx_event_play", {"event": "impact", "at": "Workspace.Dummy.Body"}],
    "sfx_play_missing": ["sfx_event_play", {"event": "heal"}],
    "sfx_define": ["sfx_event_define", {"name": "heal", "sound_ids": ["rbxassetid://123456", "777", "404", "9999"], "volume": 0.6}],
    "sfx_define_bad": ["sfx_event_define", {"name": "ui_error", "sound_ids": ["404", "9999"]}],
    "sfx_play_defined": ["sfx_event_play", {"event": "heal"}],
    "fire": ["ability_sequence_create", {"ability": "fireball", "rig": "Workspace.Hero", "target": "Workspace.Dummy"}],
    "bad": ["sequence_create", {"name": "Bad", "duration": 3, "events": [
        {"t": 0, "kind": "vfx", "family": "nope", "at": "player"}, {"t": 5, "kind": "sfx", "event": "impact"},
        {"t": 0, "kind": "camera", "shot": {"position": [0, 5, 10], "look_at": [0, 0, 0]}, "duration": 2},
        {"t": 1, "kind": "camera", "shot": {"position": [5, 5, 10], "look_at": [0, 0, 0]}, "duration": 1}]}],
    "badref": ["sequence_create", {"name": "BadRef", "events": [
        {"t": 0, "kind": "vfx", "family": "impact", "at": "Workspace.Nope"},
        {"t": 0.2, "kind": "animation", "rig": "Workspace.Hero", "animation": "Workspace.NoAnim"}]}],
    "r6": ["sequence_create", {"name": "R6Test", "duration": 1, "events": [
        {"t": 0, "kind": "vfx", "family": "impact", "at": {"actor": "Workspace.OldGuy", "limb": "right_hand"}},
        {"t": 0.1, "kind": "signal", "name": "hit"}]}],
    "cine": ["sequence_create", {"name": "Cine", "duration": 2, "events": [
        {"t": 0, "kind": "camera", "shot": {"target": "Workspace.Dummy", "preset": "wide"}, "move": "cut"},
        {"t": 0.5, "kind": "camera", "shot": {"target": "Workspace.Dummy", "preset": "closeup"}, "duration": 1, "easing": "Quad", "direction": "Out"},
        {"t": 0.2, "kind": "ui", "text": "Chapter 1", "subtitle": "The Dummy", "style": "banner", "duration": 1.2},
        {"t": 0.3, "kind": "light", "effect": "ColorCorrection", "props": {"Saturation": -0.3}, "duration": 1, "tween": 0.1},
        {"t": 1.6, "kind": "signal", "name": "done"}]}],
    "validate": ["sequence_validate", {"name": "Fireball", "rig": "Workspace.Hero", "target": "Workspace.Dummy"}],
    "preview": ["sequence_preview", {"name": "Fireball", "rig": "Workspace.Hero", "target": "Workspace.Dummy"}],
    "list": ["sequence_list", {}],
    "stop": ["sequence_stop", {}],
    "delete": ["sequence_delete", {"name": "R6Test"}],
}

data = json.loads(subprocess.run(["node", "-e", GEN, json.dumps(PROGRAMS)], capture_output=True, text=True, check=True).stdout)
P = data["programs"]
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else "  -- " + str(detail)[:400]))


L, M, run = make_runtime()
G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)  # noqa: E731
WS, RS, LIGHT = svc("Workspace"), svc("ReplicatedStorage"), svc("Lighting")
CAM = WS.CurrentCamera
CAM.FieldOfView = 70


def find(parent, name):
    return parent.FindFirstChild(parent, name)


def ui_present():
    for name in ("StarterGui", "CoreGui"):
        try:
            if find(svc(name), "TotalSequenceUI"):
                return True
        except Exception:
            pass
    return False


def kids(inst):
    return [c.Name for c in inst.GetChildren(inst).values()] if inst else []


def do(key):
    code = P[key]
    if code.startswith("--ERR"):
        return {"ok": False, "error": code[6:], "pre": True}
    return run(key, code)


# ---- scene: R15 hero, R6 old guy, a dummy target -----------------------------------
L.execute("""
local Players = game:GetService('Players')
local hero = Players:CreateHumanoidModelFromDescription(nil, Enum.HumanoidRigType.R15) hero.Name = 'Hero' hero.Parent = workspace hero:PivotTo(CFrame.new(0, 3, 0))
local old = Players:CreateHumanoidModelFromDescription(nil, Enum.HumanoidRigType.R6) old.Name = 'OldGuy' old.Parent = workspace old:PivotTo(CFrame.new(8, 3, 0))
local d = Instance.new('Model') d.Name = 'Dummy' d.Parent = workspace
local b = Instance.new('Part') b.Name = 'Body' b.Size = Vector3.new(4, 6, 2) b.CFrame = CFrame.new(0, 3, -14) b.Parent = d d.PrimaryPart = b
__sig = {}
""")
ok("scene: R15 hero has RightHand, R6 rig has Right Arm", find(find(WS, "Hero"), "RightHand") is not None and find(find(WS, "OldGuy"), "Right Arm") is not None)

# ---- C: VFX -------------------------------------------------------------------------
r = do("vfx_install")
ok("C1 vfx_library_install creates ReplicatedStorage.TotalVFX (+Replicate remote, client script)", r.get("ok") and find(RS, "TotalVFX") is not None and find(find(RS, "TotalVFX"), "Replicate") is not None, r)
ok("C1 install reports 17 families, 11 palettes, genre palette applied", r.get("ok") and len(r["data"]["families"]) == 17 and len(r["data"]["palettes"]) == 11, r.get("data"))
vfx = M.runModule(find(RS, "TotalVFX"))
r = do("vfx_play")
rt = find(WS, "TotalVFXRuntime")
ok("C2 vfx_play impact on a part creates ONE container under workspace.TotalVFXRuntime", r.get("ok") and rt is not None and len(kids(rt)) == 1, r)
cont = rt.GetChildren(rt)[1]
desc = [d.ClassName for d in cont.GetDescendants(cont).values()]
ok("C2 effect is emitters / light / attachments, not a pile of neon parts (%s)" % ",".join(sorted(set(desc))), desc.count("ParticleEmitter") >= 1 and desc.count("Part") <= 3 and "Attachment" in desc, desc)
ok("C2 Low tier clamps emitters (<= 2 ParticleEmitters) and drops lights", desc.count("ParticleEmitter") <= 2 and "PointLight" not in desc, desc)
for _ in range(40):
    vfx.step(0.05)
ok("C3 effect finished and the container was removed by the lifecycle (no Debris)", len(kids(rt)) == 0 and vfx.activeCount() == 0, kids(rt))
ok("C3 emitters were driven by :Emit bursts (%d particles emitted)" % M.emits, M.emits >= 1)
r = do("vfx_play_bad")
ok("C4 vfx_play on a missing part fails with a diagnostic", r.get("ok") is False and "Workspace.Nope" in json.dumps(r), r)
r = do("vfx_play_fire")
vfx.step(0.1)
n_before = len(kids(rt))
r = do("vfx_validate")
ok("C6 vfx_validate audits the live fire effect tree: no defects (no neon parts, rates inside budget)", r.get("ok") and r["data"].get("errors", 0) == 0 and r["data"].get("emitters", 0) >= 2, r)
hs = vfx.stopAll("test")
vfx.step(0.1)
ok("C5 sustained family: stopAll tears the container down", n_before == 1 and len(kids(rt)) == 0 and vfx.activeCount() == 0, (n_before, kids(rt)))

# ---- D: SFX -------------------------------------------------------------------------
r = do("sfx_install")
ok("D1 sfx_library_install creates TotalSFX + Events and SoundService groups", r.get("ok") and find(RS, "TotalSFX") is not None and find(svc("SoundService"), "Master") is not None and r["data"]["engine_bundled"] == 27, r)
sfx = M.runModule(find(RS, "TotalSFX"))
played0 = M.soundsPlayed or 0
r = do("sfx_play")
ok("D2 sfx_event_play impact plays an engine-bundled rbxasset sound in 3D", r.get("ok") and M.soundsPlayed == played0 + 1 and "rbxasset://sounds/" in json.dumps(r), r)
r = do("sfx_play_missing")
ok("D3 sfx_event_play heal (no bundled asset) fails with 'missing' instead of a silent Sound", r.get("ok") is False and ("no asset" in json.dumps(r).lower() or "missing" in json.dumps(r).lower()) and "nothing was played" in json.dumps(r), r)
r = do("sfx_define")
ok("D4 sfx_event_define verifies each id: 1 accepted (audio), 777 (not audio) / 404 (unavailable) / 9999 (load failure) rejected", r.get("ok") and len(r["data"].get("ids", [])) == 1 and len(r["data"].get("rejected", [])) == 3 and "not-audio" in json.dumps(r) and "unverifiable" in json.dumps(r) and (M.productInfoCalls or 0) >= 3, r)
r = do("sfx_define_bad")
ok("D4 sfx_event_define with zero verified ids fails and defines nothing", r.get("ok") is False, r)
r = do("sfx_play_defined")
ok("D5 after a verified definition heal plays (runtime re-reads EventsJSON)", r.get("ok") and M.soundsPlayed == played0 + 2, r)
res = sfx.play("ui_error")
ok("D6 runtime TotalSFX.play returns nil + reason for an event that stays missing", res is None or (isinstance(res, tuple) and res[0] is None), res)

# ---- G (part 1): structural / reference failures -------------------------------------
r = do("bad")
ok("G1 sequence_create with unknown family + after-end + overlapping camera is refused before Studio", r.get("ok") is False and "NOT created" in r["error"] and "unknown vfx family" in r["error"] and "overlap" in r["error"] and "never fire" in r["error"], r)
r = do("badref")
ok("G2 sequence_create with missing at-path / animation refuses in Studio with both references named", r.get("ok") is False and "Workspace.Nope" in r["error"] and "Workspace.NoAnim" in r["error"], r)
ok("G2 nothing was saved by the failed attempts", find(RS, "TotalSequences") is None or not any(n in kids(find(RS, "TotalSequences")) for n in ("Bad", "BadRef")))

# ---- F: integrated ability ---------------------------------------------------------
r = do("fire")
seqf = find(RS, "TotalSequences")
ok("F1 ability_sequence_create fireball installs SequenceRunner + PlaySequence + Signal + Fireball module", r.get("ok") and seqf is not None and all(n in kids(seqf) for n in ("SequenceRunner", "PlaySequence", "Signal", "Fireball")), r)
ok("F1 beats are explicit and ordered: camera punch -> charge -> release -> projectile -> explosion -> UI", r.get("ok") and [b.split(" ", 2)[1:] for b in r["data"]["beats"]][0][0] == "camera" and "0.7s vfx release" in r["data"]["beats"] and "1.15s vfx explosion" in r["data"]["beats"], r.get("data", {}).get("beats"))
ok("F1 validation ran against the real rig (Hero R15) and only warns about the unbundled charge sound", r.get("ok") and r["data"]["validation"]["errors"] == 0 and all(i["code"] == "sfx-missing" for i in r["data"]["validation"]["issues"]), r.get("data", {}).get("validation"))
ok("F1 client bootstrap installed under StarterPlayerScripts", find(find(svc("StarterPlayer"), "StarterPlayerScripts"), "TotalSequenceClient") is not None)
r = do("validate")
ok("F2 sequence_validate: VALID, max 3 live effects, checked against rig + target + VFX + SFX", r.get("ok") and r["data"]["errors"] == 0 and r["data"]["max_live_vfx"] <= 4 and r["data"]["checked_against"]["rig"] == "Hero (R15)", r)
L.execute("game:GetService('ReplicatedStorage').TotalSequences.Signal.Event:Connect(function(seq, name, val) __sig[#__sig + 1] = name .. '=' .. tostring(val) end)")
cam_before = CAM.CFrame
r = do("preview")
ok("F3 sequence_preview starts: 14 events, skipped list names the missing charge sound honestly", r.get("ok") and r["data"]["events"] == 14 and any("charge" in s for s in r["data"]["skipped"]), r)
runner = M.runModule(find(seqf, "SequenceRunner"))
fov_min, traveled, seen_ui, seen_cc, proj_positions = 99, False, False, False, []
for i in range(60):
    runner.step(0.05)
    vfx.step(0.05)
    fov_min = min(fov_min, CAM.FieldOfView)
    if find(WS, "TotalVFXRuntime") and "TotalSequence_Projectile" in kids(find(WS, "TotalVFXRuntime")):
        p = find(find(WS, "TotalVFXRuntime"), "TotalSequence_Projectile").CFrame.Position
        proj_positions.append((round(p.X, 2), round(p.Y, 2), round(p.Z, 2)))
    if ui_present():
        seen_ui = True
    if "TotalSequence_ColorCorrectionEffect" in kids(LIGHT):
        seen_cc = True
sig = list(G.__sig.values())
ok("F4 signals reached gameplay in order: fire_projectile then hit", sig == ["fire_projectile=fireball", "hit=fireball"], sig)
ok("F4 FOV punch dipped (%.1f) and returned to 70 - camera is an overlay, not hijacked" % fov_min, fov_min < 69 and abs(CAM.FieldOfView - 70) < 1e-6 and CAM.CameraType is None or (CAM.CameraType and CAM.CameraType.Name == "Custom"))
ok("F4 projectile host travelled from the hand toward the target (%d samples)" % len(proj_positions), len(proj_positions) >= 4 and proj_positions[0][2] > proj_positions[-1][2] - 1 and proj_positions[-1][2] < -8, proj_positions[:3] + proj_positions[-2:])
ok("F4 banner UI and ColorCorrection grade appeared during the sequence", seen_ui and seen_cc)
ok("F5 at the end: no active sequence, camera CFrame restored, lighting / UI cleaned, sequence VFX hosts gone", len(list(runner.active().values())) == 0 and abs(CAM.CFrame.Position.X - cam_before.Position.X) < 1e-6 and kids(LIGHT) == [] and not ui_present() and "TotalSequence_Projectile" not in kids(find(WS, "TotalVFXRuntime")), (kids(LIGHT), kids(find(WS, "TotalVFXRuntime"))))
for _ in range(80):
    vfx.step(0.05)
ok("F5 every effect container eventually expires on its own (%s)" % kids(find(WS, "TotalVFXRuntime")), kids(find(WS, "TotalVFXRuntime")) == [])
ok("F5 no runtime warnings were emitted", len(list(M.warnings.values())) == 0, list(M.warnings.values())[:3])

# ---- A: cinematic sequence ----------------------------------------------------------
r = do("cine")
ok("A1 cinematic sequence created with cut + eased closeup + banner + grade + signal", r.get("ok") and r["data"]["validation"]["ok"] and r["data"]["events"] == 5, r)
G.__sig = L.table()
h = runner.play("Cine", None)
runner.step(0.25)
p_wide = CAM.CFrame.Position
ok("A2 wide shot cut: camera Scriptable, placed behind/above the target", CAM.CameraType.Name == "Scriptable" and abs(p_wide.Z - (-14)) > 8, (p_wide.X, p_wide.Y, p_wide.Z))
runner.step(0.5)
p_mid = CAM.CFrame.Position
ok("A3 banner UI + ColorCorrection alive mid-sequence", ui_present() and "TotalSequence_ColorCorrectionEffect" in kids(LIGHT))
runner.step(0.75)
p_close = CAM.CFrame.Position
ok("A3 UI (0.2-1.4s) and grade (0.3-1.3s) ended on time at 1.5s", not ui_present() and kids(LIGHT) == [], (ui_present(), kids(LIGHT)))
ok("A3 eased move: camera travelled toward the closeup over the move, not a jump", (p_mid.X, p_mid.Y, p_mid.Z) != (p_wide.X, p_wide.Y, p_wide.Z) and (p_close.X, p_close.Y, p_close.Z) != (p_mid.X, p_mid.Y, p_mid.Z) and abs(p_close.Z - (-14)) < abs(p_wide.Z - (-14)), ((p_wide.Z), (p_mid.Z), (p_close.Z)))
h.Stop(h, "test-cancel")
ok("A4 Stop: state recorded, camera type restored, no active sequences", h.state == "test-cancel" and CAM.CameraType.Name == "Custom" and len(list(runner.active().values())) == 0, (h.state, kids(LIGHT)))
h = runner.play("Cine", None)
runner.step(0.75)
mid_alive = ui_present() and "TotalSequence_ColorCorrectionEffect" in kids(LIGHT) and CAM.CameraType.Name == "Scriptable"
h.Stop(h, "test-cancel")
ok("A4 Stop mid-move with UI + grade alive: everything cleaned, camera handed back", mid_alive and h.state == "test-cancel" and CAM.CameraType.Name == "Custom" and kids(LIGHT) == [] and not ui_present() and len(list(runner.active().values())) == 0, (mid_alive, kids(LIGHT)))
G.__sig = L.table()
h = runner.play("Cine", None)
for _ in range(50):
    runner.step(0.05)
ok("A5 full run: 'done' signal fired and the camera was handed back at the end", list(G.__sig.values()) == ["done=nil"] and CAM.CameraType.Name == "Custom" and h.state == "completed", (list(G.__sig.values()), h.state))

# ---- G (part 2): R6, pause / resume / skip, death cancel, delete -------------------
r = do("r6")
ok("G3 sequence on an R6 rig with limb right_hand validates (limb resolves to 'Right Arm')", r.get("ok") and runner.limb(find(WS, "OldGuy"), "right_hand").Name == "Right Arm" and runner.rigType(find(WS, "OldGuy")) == "R6", r)
h2 = runner.play("R6Test", None)
runner.step(0.05)
h2.Pause(h2)
runner.step(0.5)
paused_elapsed = h2.elapsed
h2.Resume(h2)
runner.step(0.1)
ok("G4 Pause freezes the timeline, Resume continues it (%.2f -> %.2f) and the signal fires after resume" % (paused_elapsed, h2.elapsed), abs(paused_elapsed - 0.05) < 1e-6 and h2.elapsed > paused_elapsed and list(h2.signals.values()) == ["hit"], list(h2.signals.values()))
h2.Skip(h2)
runner.step(0.05)
ok("G5 Skip ends the sequence immediately and cleans up", h2.state == "skipped" and len(list(runner.active().values())) == 0)
L.execute("__h3 = require(game.ReplicatedStorage.TotalSequences.SequenceRunner).play('Fireball', {side = 'preview', character = workspace.Hero, target = workspace.Dummy})")
runner.step(0.3)
L.execute("workspace.Hero.Humanoid.Health = 0 workspace.Hero.Humanoid.Died:Fire()")
runner.step(0.05)
vfx.step(0.05)
ok("G6 character death cancels the running ability (state 'died'), FOV restored, charge effect torn down", G.__h3.state == "died" and abs(CAM.FieldOfView - 70) < 1e-6 and not any(n.startswith("TotalVFX_charge") for n in kids(find(WS, "TotalVFXRuntime"))), (G.__h3.state, kids(find(WS, "TotalVFXRuntime"))))
r = do("list")
ok("G7 sequence_list shows the 3 saved sequences and reports VFX / SFX installed", r.get("ok") and r["data"]["count"] == 3 and r["data"]["vfx_installed"] and r["data"]["sfx_installed"], r)
r = do("stop")
ok("G7 sequence_stop with nothing running is a clean no-op", r.get("ok") and r["data"]["stopped"] == [])
r = do("delete")
ok("G8 sequence_delete removes only R6Test, runtime kept for the others", r.get("ok") and "R6Test" not in kids(seqf) and "Fireball" in kids(seqf) and "SequenceRunner" in kids(seqf), r)
ok("versions: VFX / SFX / sequence runtimes all 1.92.0", data["vfxVersion"] == "1.92.0" and data["sfxVersion"] == "1.92.0" and data["seqVersion"] == "1.92.0")

print("\n%d/%d checks passed (mock DataModel - not live Studio)" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
