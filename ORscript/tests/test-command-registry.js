// Command platform unit and integration contracts.
const fs=require("fs");
const R=require("../src/core/command_registry.js");
let fail=0;const check=(n,v)=>{console.log(`${v?"PASS":"FAIL"}  ${n}`);if(!v)fail++;};
const schema={type:"object",required:["radius"],properties:{radius:{type:"number"}}};
check("register Studio command",R.register({id:"test_part",description:"part",environment:"ROBLOX_STUDIO",parameters:schema,category:"studio.hierarchy",aliases:["make block"]}).ok);
check("duplicate id rejected",!R.register({id:"test_part",environment:"ROBLOX_STUDIO"}).ok);
check("invalid environment rejected",!R.register({id:"bad_env",environment:"MARS"}).ok);
check("missing parameters rejected",!R.validate("test_part",{},"ROBLOX_STUDIO").ok);
check("unsupported environment rejected",!R.validate("test_part",{radius:2},"BLENDER").ok);
check("valid parameters accepted",R.validate("test_part",{radius:2},"ROBLOX_STUDIO").ok);
check("alias resolves",R.get("make block").id==="test_part");
R.register({id:"blender_add_cylinder",description:"Add cylinder mesh",environment:"BLENDER",category:"blender.mesh",parameters:schema,examples:["make a cylinder"]});
check("natural language search",R.search("make a cylinder",{environment:"BLENDER"})[0].id==="blender_add_cylinder");
check("category listing",R.list("blender.mesh").some((c)=>c.id==="blender_add_cylinder"));
R.register({id:"broken",environment:"GENERAL",executor:()=>{throw new Error("boom")}});
R.execute("broken",{}, {environment:"GENERAL"}).then((r)=>{
  check("broken executor isolated",r.ok===false&&/boom/.test(r.error));
  check("registration failure recorded",R.failures().length>=2);
  check("docs generated from registry",R.docs().includes("blender_add_cylinder"));
  const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
  const isolated=manifest.content_scripts.filter((x)=>x.world!=="MAIN"&&x.js.includes("src/core/main.js")&&x.js.some((f)=>f.startsWith("src/providers/")));
  check("registry loaded on every provider",isolated.length>=12&&isolated.every((x)=>x.js.includes("src/core/command_registry.js")));
  const bg=fs.readFileSync("background.js","utf8"), ops=fs.readFileSync("tools/blender_ops.py","utf8"), main=fs.readFileSync("src/core/main.js","utf8");
  for(const id of ["blender_export_gltf","blender_import_gltf","blender_scene_cleanup","blender_set_world","blender_set_render","blender_render_image","blender_principled_material","blender_inset","blender_add_bone","blender_normalize_weights"])
    check(`${id} registered and mapped`,bg.includes(`btool(\"${id}\"`)&&bg.includes(`${id}:`));
  for(const op of ["cmd_export_gltf","cmd_import_gltf","cmd_scene_cleanup","cmd_set_world","cmd_set_render","cmd_render_image","cmd_principled_material","cmd_inset","cmd_add_bone","cmd_normalize_weights"])
    check(`${op} real executor`,ops.includes(`def ${op}(`));
  check("discovery commands execute in shared core",main.includes('roadmapName==="search_commands"')&&main.includes('roadmapName==="get_command"'));
  check("offline Blender catalogue discoverable",bg.includes('case "command_catalog"'));
  process.exitCode=fail?1:0;
});
