// SPDX-License-Identifier: GPL-3.0-or-later
// Provider-independent command metadata, validation, discovery and dispatch.
const ORCommandRegistry = (() => {
  "use strict";
  const ENVIRONMENTS = new Set(["ROBLOX_STUDIO", "BLENDER", "FIGMA", "WEB", "GENERAL"]);
  const commands = new Map();
  const aliases = new Map();
  const failures = [];
  const searchCache = new Map();

  const text = (v, n = 500) => String(v == null ? "" : v).trim().slice(0, n);
  const words = (v) => text(v, 1000).toLowerCase().split(/[^a-z0-9]+/).filter((x)=>x&&!new Set(["make","create","add","build","a","an","the","please","tool","command"]).has(x));
  function categoryFor(name, environment) {
    const n = String(name || "").toLowerCase();
    if (environment === "BLENDER") {
      if (/camera|view/.test(n)) return "blender.camera";
      if (/material|shader|texture|uv/.test(n)) return "blender.material";
      if (/armature|bone|weight|keyframe|animation|frame/.test(n)) return "blender.animation";
      if (/import|export|send_to_studio/.test(n)) return "blender.io";
      if (/render|light|world/.test(n)) return "blender.render";
      if (/mesh|bevel|extrude|boolean|modifier|subdiv|decimate|normal|triangulate/.test(n)) return "blender.mesh";
      return "blender.scene";
    }
    if (/script|module|debug|console|output/.test(n)) return "studio.scripting";
    if (/ui_|gui|screen/.test(n)) return "studio.ui";
    if (/terrain/.test(n)) return "studio.terrain";
    if (/animation/.test(n)) return "studio.animation";
    if (/sound|audio/.test(n)) return "studio.audio";
    if (/light|atmosphere|bloom|sunray/.test(n)) return "studio.lighting";
    if (/part|model|instance|folder|selection|workspace/.test(n)) return "studio.hierarchy";
    return environment === "WEB" ? "web" : environment === "GENERAL" ? "general" : "studio.tools";
  }
  function normalize(raw) {
    if (!raw || typeof raw !== "object") throw new Error("command definition must be an object");
    const id = text(raw.id || raw.name, 120);
    if (!/^[a-zA-Z][\w./:-]*$/.test(id)) throw new Error("command id must be a stable identifier");
    const environment = text(raw.environment || "GENERAL", 40).toUpperCase();
    if (!ENVIRONMENTS.has(environment)) throw new Error(`unsupported environment: ${environment}`);
    const schema = raw.parameters || raw.inputSchema || { type: "object", properties: {} };
    return Object.freeze({
      id, name:text(raw.name || id, 160), description:text(raw.description, 1000),
      category:text(raw.category || categoryFor(id, environment), 100), environment,
      parameters:schema, parameterTypes:Object.fromEntries(Object.entries(schema.properties || {}).map(([k,v]) => [k, v.type || "any"])),
      examples:Array.isArray(raw.examples) ? raw.examples.map((x) => text(x, 500)).slice(0, 8) : [],
      permissions:Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
      returns:raw.returns&&typeof raw.returns==="object"?raw.returns:{type:"object"},
      executionMode:["READ","DESIGN","WRITE","EXPORT","ROBLOX_EXECUTION","PUBLISH"].includes(String(raw.executionMode||"").toUpperCase())?String(raw.executionMode).toUpperCase():(/^(get|find|list|inspect|search|validate|read)/i.test(id.split(/[.:/]/).pop())?"READ":"WRITE"),
      handler:text(raw.handler||id,160),version:text(raw.version||"1.0.0",30),
      tags:Array.isArray(raw.tags)?raw.tags.map((x)=>text(x,80).toLowerCase()).filter(Boolean):[],
      aliases:Array.isArray(raw.aliases) ? raw.aliases.map((x) => text(x, 120).toLowerCase()).filter(Boolean) : [],
      executor:typeof raw.executor === "function" ? raw.executor : null,
      validation:typeof raw.validation === "function" ? raw.validation : null,
      errorHandling:raw.errorHandling || "return_structured_error",
      virtual:raw.virtual === true,
    });
  }
  function register(raw, options = {}) {
    try {
      const command = normalize(raw);
      if (commands.has(command.id) && !options.replace) { const error=`duplicate command id: ${command.id}`;failures.push({at:Date.now(),id:command.id,error});return {ok:false,error}; }
      commands.set(command.id, command);searchCache.clear();
      for (const alias of command.aliases) {
        if (!aliases.has(alias) || options.replace) aliases.set(alias, command.id);
      }
      return { ok:true, command };
    } catch (e) {
      const error=String(e&&e.message||e); failures.push({at:Date.now(),id:raw&&raw.id,error});
      return {ok:false,error};
    }
  }
  function registerTool(tool, environment, extra = {}) {
    if (!tool || !tool.name) return {ok:false,error:"tool has no name"};
    return register({id:tool.name,name:extra.displayName||tool.name,description:tool.description,inputSchema:tool.inputSchema,environment,category:extra.category,aliases:extra.aliases,permissions:extra.permissions,examples:extra.examples,returns:extra.returns,executionMode:extra.executionMode,handler:extra.handler||tool.name,tags:extra.tags,virtual:extra.virtual,executor:extra.executor}, extra);
  }
  function get(id) { const key=text(id,120); return commands.get(key) || commands.get(aliases.get(key.toLowerCase())) || null; }
  function validate(id, args, environment) {
    const command=get(id); if(!command)return {ok:false,code:"COMMAND_NOT_FOUND",error:`unknown command: ${id}`};
    const env=text(environment||command.environment,40).toUpperCase();
    if (command.environment !== "GENERAL" && env !== command.environment) return {ok:false,code:"UNSUPPORTED_ENVIRONMENT",error:`${command.id} requires ${command.environment}; active environment is ${env||"UNKNOWN"}`};
    const value=args&&typeof args==="object"&&!Array.isArray(args)?args:{};
    const required=(command.parameters&&command.parameters.required)||[];
    const missing=required.filter((k)=>value[k]===undefined||value[k]===null||value[k]==="");
    if(missing.length)return {ok:false,code:"INVALID_PARAMETER",error:`missing required parameter(s): ${missing.join(", ")}`};
    if(command.validation){try{const r=command.validation(value);if(r===false)return {ok:false,error:"custom validation failed"};if(r&&r.ok===false)return r;}catch(e){return {ok:false,error:`validation failed: ${String(e&&e.message||e)}`};}}
    return {ok:true,command,args:value};
  }
  async function execute(id,args,context={}) {
    const checked=validate(id,args,context.environment); if(!checked.ok)return checked;
    if(!checked.command.executor)return {ok:false,error:`${checked.command.id} has no local executor; route it through the OrScript tool bridge`};
    try { const result=await checked.command.executor(checked.args,context); return result&&typeof result==="object"&&"ok" in result?result:{ok:true,result}; }
    catch(e){return {ok:false,error:`${checked.command.id} failed: ${String(e&&e.message||e)}`};}
  }
  function search(query, options={}) {
    const terms=words(query); const environment=options.environment&&String(options.environment).toUpperCase();const cacheKey=JSON.stringify([terms,environment,Number(options.limit)||25]);if(searchCache.has(cacheKey))return searchCache.get(cacheKey).slice();
    const result=[...commands.values()].filter((c)=>!environment||c.environment===environment||c.environment==="GENERAL").map((c)=>{
      const hay=[c.id,c.name,c.description,c.category,...c.aliases,...c.examples].join(" ").toLowerCase();
      let score=terms.reduce((n,t)=>n+(c.id.toLowerCase()===t?12:c.id.toLowerCase().includes(t)?7:c.category.includes(t)?5:hay.includes(t)?2:0),0);
      if(!terms.length)score=0; return {command:c,score};
    }).filter((x)=>!terms.length||x.score>0).sort((a,b)=>b.score-a.score||a.command.id.localeCompare(b.command.id)).slice(0,Math.min(100,Number(options.limit)||25)).map((x)=>x.command);searchCache.set(cacheKey,result);return result.slice();
  }
  function list(category, environment) { const env=environment&&String(environment).toUpperCase();return [...commands.values()].filter((c)=>(!env||c.environment===env||c.environment==="GENERAL")&&(!category||c.category===category||c.category.startsWith(category+"."))).sort((a,b)=>a.category.localeCompare(b.category)||a.id.localeCompare(b.id)); }
  function listByCategory(category){return list(category);}
  function listByEnvironment(environment){return list(null,environment);}
  function searchCommands(query,options){return search(query,options);}
  function getCommand(id){return get(id);}
  function listCommands(options={}){return list(options.category,options.environment);}
  function stats() { const values=[...commands.values()]; const byEnvironment={}; const byCategory={}; for(const c of values){byEnvironment[c.environment]=(byEnvironment[c.environment]||0)+1;byCategory[c.category]=(byCategory[c.category]||0)+1;} return {total:values.length,byEnvironment,byCategory,registrationFailures:failures.length}; }
  function docs() { const s=stats(); return `# OrScript Command Registry\n\nTotal commands: ${s.total}\n\n${Object.entries(s.byEnvironment).map(([k,v])=>`- ${k}: ${v}`).join("\n")}\n\n`+[...commands.values()].sort((a,b)=>a.category.localeCompare(b.category)||a.id.localeCompare(b.id)).map((c)=>`## ${c.id}\n\n${c.description}\n\n- Category: ${c.category}\n- Environment: ${c.environment}\n- Parameters: ${JSON.stringify(c.parameters)}\n- Examples: ${c.examples.join("; ")||"None"}`).join("\n\n"); }
  return Object.freeze({ENVIRONMENTS:[...ENVIRONMENTS],register,registerTool,get,getCommand,validate,execute,search,searchCommands,list,listCommands,listByCategory,listCommandsByCategory:listByCategory,listByEnvironment,listCommandsByEnvironment:listByEnvironment,stats,docs,failures:()=>failures.slice()});
})();
if (typeof window!=="undefined") window.ORCommandRegistry=ORCommandRegistry;
if (typeof module!=="undefined"&&module.exports) module.exports=ORCommandRegistry;
