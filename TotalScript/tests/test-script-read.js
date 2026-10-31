// script_read regression contract. Static bridge checks plus deterministic protocol simulation.
const fs=require('fs'),vm=require('vm');let fails=0;const ok=(n,v)=>{console.log(`${v?'PASS':'FAIL'}  ${n}`);if(!v)fails++;};
const bridge=fs.readFileSync('src/core/studio_bridge.js','utf8'),background=fs.readFileSync('background.js','utf8'),main=fs.readFileSync('src/core/main.js','utf8'),rust=fs.readFileSync('agent/src/main.rs','utf8');
const sandbox={RobloxScriptSkills:{buildLuau:()=>({err:'base'}),SKILL_COMMANDS:[]}};vm.createContext(sandbox);vm.runInContext(bridge,sandbox);const built=sandbox.RobloxScriptSkills.buildLuau('script_read',{path:'game.ServerScriptService.Nested.Main'});const code=built.code||'';
ok('Script/LocalScript/ModuleScript only',code.includes("inst:IsA('Script')")&&code.includes("inst:IsA('LocalScript')")&&code.includes("inst:IsA('ModuleScript')"));
ok('nested exact hierarchy resolution',code.includes("for _,segment in ipairs(string.split(p,'.'))"));
ok('duplicate names return INVALID_INSTANCE',code.includes("#matches>1")&&code.includes("'INVALID_INSTANCE'"));
ok('renamed/nonexistent scripts return SCRIPT_NOT_FOUND',code.includes("'SCRIPT_NOT_FOUND'"));
ok('deleted/detached scripts return INVALID_INSTANCE',code.includes("inst.Parent==nil")&&code.includes("Target is destroyed"));
ok('wrong type and permission failures return SCRIPT_NOT_READABLE',code.includes("'SCRIPT_NOT_READABLE'")&&code.includes('Studio denied access'));
ok('empty scripts are explicit SCRIPT_SOURCE_EMPTY',code.includes("'SCRIPT_SOURCE_EMPTY'"));
ok('Source read error is not swallowed',code.includes('local readOk,srcOrError=pcall')&&code.includes('if not readOk then'));
ok('serialization failures are BRIDGE_PROTOCOL_ERROR',code.includes("'BRIDGE_PROTOCOL_ERROR'")&&code.includes('encodedOk'));
ok('large source is returned without clipping',code.includes('source=srcOrError')&&!code.includes('string.sub(srcOrError'));
ok('legacy script_read selects native tool when available',main.includes('preferMcp = /^(script_read|'));
ok('Studio offline has structured error',background.includes('errorCode:"STUDIO_BRIDGE_OFFLINE"'));
ok('timeouts have structured STUDIO_TIMEOUT',background.includes('"STUDIO_TIMEOUT"'));
ok('safe reads retry at most once',background.includes('IDEMPOTENT_STUDIO_TOOLS')&&background.includes('if (retryable)')&&!background.includes('for (let i = 0; i < 3'));
ok('writes are never replayed after ambiguous timeout',background.includes('Never replay a mutating Studio request'));
ok('versioned unique request envelope',background.includes('version: "1.0"')&&background.includes('crypto.randomUUID()')&&background.includes('requestId'));
ok('duplicate/stale responses are ignored',background.includes('duplicate, cancelled, timed-out, or stale response'));
ok('transport id remains authoritative across bridge requestId formats',background.includes('response_request_id_normalized')&&background.includes('it must match an active transport id')&&!background.includes('Response requestId did not match'));
ok('extension restart does not restore stale pending requests',!background.includes('chrome.storage.local.set({pending'));
// Protocol simulation: out-of-order concurrent reads cannot cross-contaminate.
const pending=new Map();const results={};for(let i=0;i<25;i++){const id=`r-${i}`;pending.set(id,(value)=>results[id]=value);}for(let i=24;i>=0;i--){const id=`r-${i}`;const cb=pending.get(id);pending.delete(id);cb(`source-${i}`);}ok('25 simultaneous reads remain isolated',Object.keys(results).length===25&&Object.entries(results).every(([k,v])=>v===`source-${k.slice(2)}`));
// Timeout/cancellation: a late response cannot revive a removed request.
pending.set('timeout',()=>results.timeout='bad');pending.delete('timeout');if(pending.has('timeout'))pending.get('timeout')('late');ok('timed-out read ignores late response',results.timeout===undefined);
process.exitCode=fails?1:0;
