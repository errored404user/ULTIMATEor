"use strict";
const fs=require("fs"),assert=require("assert");
const files=["src/core/main.js","src/core/config.js","overlay.css","README.md","manifest.json"];
for(const f of files){const s=fs.readFileSync(f,"utf8");assert(!/cowork/i.test(s),`${f} still references removed mode`);}
const main=fs.readFileSync("src/core/main.js","utf8"),config=fs.readFileSync("src/core/config.js","utf8");
assert(!main.includes('id="rs-steering"')&&!main.includes('data-mode="steering"'));
assert(!config.includes("STEERING MODE (user enabled)"));
assert(!fs.existsSync("test-cowork.js"));
console.log("PASS  removed mode has no UI, prompt, help, storage registration, documentation, or legacy test");
