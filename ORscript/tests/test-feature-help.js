"use strict";
const fs=require("fs"),assert=require("assert"),main=fs.readFileSync("src/core/main.js","utf8"),config=fs.readFileSync("src/core/config.js","utf8"),manifest=JSON.parse(fs.readFileSync("manifest.json"));
for(const topic of ["templates","roadmap","commands","studio","workmode","projects","themes","permissions","providers","troubleshooting"])assert(main.includes(`${topic}:`),topic);
assert(main.includes("const FEATURE_HELP_TOPICS={"),"FEATURE_HELP_TOPICS table must be defined (orscript_help threw 'FEATURE_HELP_TOPICS is not defined')");
{const start=main.indexOf("const FEATURE_HELP_TOPICS={"),end=main.indexOf("\n  };",start);const table=main.slice(start,end);for(const topic of ["templates","roadmap","commands","studio","workmode","projects","themes","permissions","providers","troubleshooting"])assert(new RegExp(`\\n\\s+${topic}:\\{title:`).test(table),`help topic ${topic} has an entry`);assert(main.indexOf("const FEATURE_HELP_TOPICS={")<main.indexOf('roadmapName==="orscript_help"'),"table defined before use");}
assert(main.includes('name:"orscript_help"'));
assert(main.includes('roadmapName==="orscript_help"'));
assert(main.includes("agentStarted:false,executedCommands:false"));
assert(main.includes("VoidScript is OrScript's partner visual identity"));
assert(config.includes("call orscript_help {question, topic?} before answering"));
assert(config.includes("do not start a new task, execute Studio commands, create a roadmap, or mutate anything"));
for(const cs of manifest.content_scripts.filter(x=>x.js&&x.js.includes("src/core/main.js")))assert(cs.js.includes("src/core/config.js"));
console.log("PASS  automatic feature help is factual, provider-wide, and non-mutating");
