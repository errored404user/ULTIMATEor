"use strict";
const fs=require("fs"),vm=require("vm"),assert=require("assert");
const context={console,TextDecoder,Uint8Array,ArrayBuffer,setTimeout,clearTimeout,module:{exports:{}},chrome:{runtime:{getURL:p=>`chrome-extension://test/${p}`}},Worker:class{constructor(){throw new DOMException("cannot be accessed from provider origin","SecurityError")}}};
context.globalThis=context;context.window=context;vm.createContext(context);
// Content-script loading must expose the parser without replacing window.onmessage.
context.onmessage="provider-handler";
vm.runInContext(fs.readFileSync("src/core/project_worker.js","utf8"),context);
assert.equal(context.onmessage,"provider-handler");
assert(context.TotalProjectWorker&&typeof context.TotalProjectWorker.analyzeBuffer==="function");
context.module={exports:{}};vm.runInContext(fs.readFileSync("src/core/project_analyzer.js","utf8"),context);
(async()=>{const xml='<roblox version="4"><Item class="DataModel" referent="DM"><Properties><string name="Name">Fallback</string></Properties></Item></roblox>';const bytes=new TextEncoder().encode(xml);const file={name:"Fallback.rbxl",size:bytes.byteLength,async arrayBuffer(){return bytes.buffer.slice(0)}};const stages=[];const result=await context.TotalProjectAnalyzer.analyze(file,{onProgress:p=>stages.push(p.stage)});assert(result.success,result.error&&result.error.message);assert.equal(result.analysis.parser,"ROBLOX_XML_STATIC_V1");assert.equal(result.analysis.summary.instances,1);assert(stages.includes("Complete"));console.log("PASS  provider-origin Worker failure uses safe local project parser");})().catch(e=>{console.error(e);process.exitCode=1});
