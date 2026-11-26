#!/usr/bin/env python3
"""1.98.0 - AnimPlayer (ReplicatedStorage.TotalAnimations.AnimPlayer) executed inside the
miniature Roblox DataModel (tests/roblox_sim.py): install command, name / id / instance
resolution with actionable errors, one cached AnimationTrack per animation per character,
exclusive play stopping the previous Action track, stop / stopAll / isPlaying, cleanup on
Humanoid.Died, respawn-safe bindPlayer, and the combat blueprint's weapon client using it.

    pip install lupa && python3 tests/anim-player-sim.py          (from the TotalScript root)

Mocked: no Studio, no real Animator - the simulator's LoadAnimation returns a stateful
stub track, so timing / blending are NOT verified here.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from roblox_sim import make_runtime
    import lupa  # noqa: F401
except Exception as e:  # pragma: no cover
    print("SKIP  " + str(e))
    sys.exit(0)

GEN = r"""
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills; const LIB=window.TotalBlueprintLib||null;
const out={programs:{}, version:S.SEQUENCE_VERSION, toolClient:null};
try { const b=S.BLUEPRINT_CATALOG&&S.BLUEPRINT_CATALOG.combat; } catch {}
// the weapon client source is inside the blueprint library
const src=fs.readFileSync("src/core/skills/blueprints_lib_a.js","utf8"); const m=src.match(/toolClient: `([\s\S]*?)`,\n  \};/); out.toolClient=m?m[1]:null;
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""
PROGRAMS = {"install": ["anim_player_install", {}], "install_again": ["anim_player_install", {}], "install_force": ["anim_player_install", {"force": True}]}
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
WS, RS = svc("Workspace"), svc("ReplicatedStorage")
new = L.eval("function(cls, name, parent) local i = Instance.new(cls) i.Name = name i.Parent = parent return i end")

# ── install ──
r = run("install", P["install"])
tot = RS.FindFirstChild(RS, "TotalAnimations")
mod = tot and tot.FindFirstChild(tot, "AnimPlayer")
ok("anim_player_install creates ReplicatedStorage.TotalAnimations.AnimPlayer (how=created, version pinned)", r.get("ok") and mod is not None and r["data"]["how"] == "created" and r["data"]["version"] == data["version"] and mod.GetAttribute(mod, "TotalVersion") == data["version"], r)
r2 = run("install_again", P["install_again"])
ok("second install keeps the module (how=kept)", r2.get("ok") and r2["data"]["how"] == "kept", r2)
mod.Source = "return {}"
r3 = run("install_force", P["install_force"])
ok("force=true rewrites an edited module (how=updated)", r3.get("ok") and r3["data"]["how"] == "updated" and "AnimPlayer.forCharacter" in mod.Source, r3)
ok("result text teaches the call shape and the error contract", "AnimPlayer.forCharacter(character)" in r3["text"] and "err explains" in r3["text"], r3["text"][:200])

M.invalidate()
AP = M.runModule(mod)

# ── resolve ──
anims = new("Folder", "Animations", RS)
punch = new("Animation", "Punch1", anims)
punch.AnimationId = "rbxassetid://111"
empty = new("Animation", "Empty", anims)
empty.AnimationId = ""
def two(t):
    return t[1], t[2]


same = L.eval("function(a, b) return a == b end")  # lupa wrappers are never `is`-identical; compare in Lua


_res = L.eval("function(AP, src) local a, err = AP.resolve(src) return {a, err} end")
res = lambda AP, src: two(_res(AP, src))  # noqa: E731
a, err = res(AP, "Punch1")
ok("resolve('Punch1') finds ReplicatedStorage.Animations.Punch1", a is not None and a.Name == "Punch1", err)
a, err = res(AP, "Missing")
ok("resolve('Missing') -> nil + actionable reason (publish / asset id)", a is None and "no animation named" in str(err) and "animation_publish" in str(err), err)
a, err = res(AP, "rbxassetid://777")
ok("resolve('rbxassetid://777') builds an Animation instance", a is not None and a.AnimationId == "rbxassetid://777", err)
a, err = res(AP, 888)
ok("resolve(888) builds rbxassetid://888", a is not None and a.AnimationId == "rbxassetid://888", err)

# ── per-character player ──
hero = M.buildRig(None, "Hero")
hero.Parent = WS
_pl = L.eval("function(AP, c) local p, err = AP.forCharacter(c) return {p, err} end")
pl = lambda AP, c: two(_pl(AP, c))  # noqa: E731
p, err = pl(AP, hero)
ok("forCharacter(hero) returns a player (Animator created under the Humanoid)", p is not None and hero.FindFirstChildOfClass(hero, "Humanoid").FindFirstChildOfClass(hero.FindFirstChildOfClass(hero, "Humanoid"), "Animator") is not None, err)
p2, _ = pl(AP, hero)
ok("forCharacter is cached per character", same(p2, p))
_play = L.eval("function(p, src, opts) local t, err = p:play(src, opts) return {t, err} end")
play = lambda p, src, opts: two(_play(p, src, opts))  # noqa: E731
t1, err = play(p, "Punch1", L.table(priority="Action", fade=0.1))
ok("play('Punch1') loads + plays once with Action priority", t1 is not None and t1.IsPlaying is True and t1.plays == 1 and t1.Priority.Name == "Action", err)
t1b, _ = play(p, "Punch1", L.table())
ok("second play reuses the SAME cached track (no AnimationTrack leak)", same(t1b, t1) and t1.plays == 2 and len(list(M.tracks.values())) == 1, len(list(M.tracks.values())))
kick = new("Animation", "Kick", anims)
kick.AnimationId = "rbxassetid://222"
t2, err = play(p, "Kick", L.table(priority="Action"))
ok("exclusive (default): playing Kick stops the running Punch1 of the same priority", t2 is not None and t2.IsPlaying is True and t1.IsPlaying is False and t1.stops == 1, err)
idle = new("Animation", "Idle", anims)
idle.AnimationId = "rbxassetid://333"
t3, err = play(p, "Idle", L.table(priority="Idle", looped=True))
ok("a different priority (Idle, looped) does not stop the Action track", t3 is not None and t3.Looped is True and t2.IsPlaying is True, err)
t4, err = play(p, "Kick", L.table(priority="Action", exclusive=False))
ok("exclusive=false leaves other tracks alone", same(t4, t2) and t3.IsPlaying is True, err)
ok("isPlaying('Kick') true / isPlaying('Punch1') false", p.isPlaying(p, "Kick") is True and p.isPlaying(p, "Punch1") is False)
ok("stop('Kick', 0.2) stops it", p.stop(p, "Kick", 0.2) is True and t2.IsPlaying is False)
play(p, "Kick", L.table())
p.stopAll(p, 0.1, "Action")
ok("stopAll(fade, 'Action') stops Action tracks but keeps the Idle loop", t2.IsPlaying is False and t3.IsPlaying is True)
p.stopAll(p, 0.1)
ok("stopAll() stops everything", t3.IsPlaying is False)

# ── errors ──
t, err = play(p, "Empty", L.table())
ok("Animation with empty AnimationId -> nil + 'publish the clip first'", t is None and "has no AnimationId" in str(err) and "animation_publish" in str(err), err)
t, err = play(p, "Nope", L.table())
ok("unknown name -> nil + reason", t is None and "no animation named" in str(err), err)
bad = new("Animation", "Broken", anims)
bad.AnimationId = "rbxassetid://0"
t, err = play(p, "Broken", L.table())
ok("LoadAnimation failure is caught and explained", t is None and "LoadAnimation failed" in str(err), err)

# ── death cleanup ──
play(p, "Punch1", L.table())
hum = hero.FindFirstChildOfClass(hero, "Humanoid")
hum.Died.Fire(hum.Died)
ok("Humanoid.Died stops + destroys the cached tracks and marks the player dead", p.dead is True and t1.IsPlaying is False and t1.destroyed is True)
t, err = play(p, "Punch1", L.table())
ok("a dead player refuses to play ('character is gone')", t is None and "character is gone" in str(err), err)
p3, _ = pl(AP, hero)
ok("forCharacter after death hands out a fresh player", p3 is not None and not same(p3, p) and p3.dead is False)

# ── respawn binding ──
calls = []
bind = L.eval("function(AP, player, cb) return AP.bindPlayer(player, function(p, c) cb(c.Name) end) end")
M.fakePlayer.Character = hero
conn = bind(AP, M.fakePlayer, lambda n: calls.append(n))
hero2 = M.buildRig(None, "Hero2")
hero2.Parent = WS
M.fakePlayer.CharacterAdded.Fire(M.fakePlayer.CharacterAdded, hero2)
ok("bindPlayer runs for the current character and again on CharacterAdded", calls == ["Hero", "Hero2"], calls)

# ── combat blueprint weapon client uses AnimPlayer ──
tc = data["toolClient"] or ""
ok("combat toolClient no longer calls the deprecated Humanoid:LoadAnimation per swing", "hum:LoadAnimation" not in tc and "AnimPlayer.forCharacter" in tc and "exclusive = true" in tc and 'has no AnimationId' in tc)
ok("combat toolClient falls back to a cached Animator track and stops it on Unequipped", "animator:LoadAnimation(anim)" in tc and "cachedTrack" in tc and "tool.Unequipped" in tc)

failed = results.count(False)
print("\n%d passed, %d failed (mocked Roblox - stub tracks, no engine timing)" % (len(results) - failed, failed))
sys.exit(1 if failed else 0)
