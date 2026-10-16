#!/usr/bin/env python3
"""Optional deep check: compile every generated Studio command with a real Lua parser.

tests/test-luau-syntax.js is a dependency-free static balance check. This script goes
further: it loads every skill generator through node, desugars the Luau-only syntax
(`+=`, `continue`, single-line if-expressions) and feeds each program to Lua's `load`
via the `lupa` package. Run it before shipping a skills change:

    pip install lupa && python3 tests/luau-parse-check.py          (from the ORscript root)

It is not part of the default test loop because it needs python + lupa.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
try:
    from lupa import LuaRuntime
except Exception:  # pragma: no cover
    print("SKIP  lupa is not installed (pip install lupa)")
    sys.exit(0)

DUMP = r"""
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
function sample(p){const t=String(p.type||"").toLowerCase();if(/\[\]|array|list/.test(t))return /number|num/.test(t)?[1,2,3]:["a","b"];if(/number|int|float/.test(t))return 1;if(/bool/.test(t))return true;if(/object|dict|map|json/.test(t))return {a:1};return (p.enum&&p.enum[0])||(p.desc&&/path/i.test(p.desc)?"Workspace.Part":"Test");}
const out=[];
for(const c of RobloxScriptSkills.SKILL_COMMANDS){const args={};for(const [k,v] of Object.entries(c.params||{}))args[k]=sample(v||{});for(const [label,a] of [["sample",args],["empty",{}]]){let r;try{r=RobloxScriptSkills.buildLuau(c.name,a);}catch(e){r={err:String(e)};}if(r&&r.code)out.push({name:c.name+" ("+label+")",code:r.code});}}
for(const [k,src] of Object.entries(RobloxScriptSkills.DESIGN_LUA||{}))out.push({name:"DESIGN_LUA."+k,code:src});
for(const n of (RobloxScriptSkills.GFX_COMMANDS||[])){const a={path:"Workspace.Rig",source:"Workspace.Sword",kind:"sparkles",pose:"hero",face:"happy",preset:"hero_low",style:"neon",title:"T",badge:"B",subtitle:"S",attach:"Workspace.Rig",target:"Workspace.Rig",logo_image:"rbxassetid://1",float:true,glow:true,reset:true,clear:false,name:"N"};const r=RobloxScriptSkills.buildLuau(n,a);if(r&&r.code)out.push({name:"gfx "+n,code:r.code});}
for(const kind of (RobloxScriptSkills.DESIGN_SCREENS||[])){const r=RobloxScriptSkills.buildLuau("ui_screen_generate",{kind,title:"T",items:["A",{item:"B",price:5}],buttons:["Play"],tabs:["X","Y"],rewards:[1,2,3],quests:[{title:"Q",progress:0.5}],choices:["a","b"],stats:["Coins"]});if(r&&r.code)out.push({name:"ui_screen_generate "+kind,code:r.code});}
process.stdout.write(JSON.stringify(out));
"""
progs = json.loads(subprocess.check_output(["node", "-e", DUMP], text=True))

L = LuaRuntime()
load = L.eval("function(s) local f,e=load(s,'=p') if f then return true,nil end return false,e end")
COMPOUND = re.compile(r"(\b[A-Za-z_][\w\.\[\]'\"#]*)\s*(\+|-|\*|/|\.\.)=(?!=)")
TOK = re.compile(r"\b(then|elseif|else|if|function|end)\b")

def desugar_ifx(src):
    """Rewrite single-line Luau if-expressions (`x = if c then a else b`) as and/or chains."""
    out = []
    for line in src.split("\n"):
        while True:
            m = re.search(r"(=|\(|,|\breturn|\.\.)(\s*)\bif\s", line)
            if not m:
                break
            start = m.end(); pos = start; repl = []; depth = 0; done = False
            while not done:
                t = TOK.search(line, pos)
                if not t:
                    break
                w = t.group(1)
                if w in ("if", "function"): depth += 1
                elif w == "end": depth -= 1
                elif depth == 0:
                    if w == "then": repl.append((t.start(), t.end(), " and "))
                    elif w == "elseif": repl.append((t.start(), t.end(), " or "))
                    elif w == "else": repl.append((t.start(), t.end(), " or ")); done = True
                pos = t.end()
            if not repl:
                break
            line = line[:m.start()] + m.group(1) + m.group(2) + line[start:]
            adj = len(m.group(1)) + len(m.group(2)) - (m.end() - m.start())
            new = ""; last = 0
            for a, b, r in repl:
                a += adj; b += adj
                new += line[last:a] + r; last = b
            line = new + line[last:]
        out.append(line)
    return "\n".join(out)

bad = []
for p in progs:
    src = COMPOUND.sub(lambda m: m.group(1) + "=" + m.group(1) + m.group(2), p["code"])
    src = re.sub(r"\bcontinue\b(?=\s*(end|$|\n|;))", "do end", src)
    src = desugar_ifx(src)
    ok, err = load(src)
    if not ok:
        err = str(err); ln = re.search(r":(\d+):", err)
        line = src.split("\n")[int(ln.group(1)) - 1] if ln else ""
        bad.append((p["name"], err[:160], line[:220]))

print(f"{'PASS' if not bad else 'FAIL'}  {len(progs)} generated programs parsed with Lua ({len(bad)} failure(s))")
for name, err, line in bad[:80]:
    print(f"  - {name}\n      {err}\n      {line}")
sys.exit(1 if bad else 0)
