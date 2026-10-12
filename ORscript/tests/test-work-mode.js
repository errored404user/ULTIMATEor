"use strict";
// Ultimate Work Mode replaces the former Adaptive workflow as the default.
const fs=require("fs"),assert=require("assert");
const main=fs.readFileSync("src/core/main.js","utf8"),config=fs.readFileSync("src/core/config.js","utf8"),css=fs.readFileSync("overlay.css","utf8");
assert(main.includes('let workMode = "ultimate"'),"ultimate is the default");
assert(!main.includes('data-work="fast"')&&!main.includes('data-work="balanced"')&&!main.includes('data-work="thorough"')&&!main.includes('data-work="adaptive"'));
assert(main.includes('Luau systems · Modeling · Architecture — production-grade, verified'),"ultimate card subtitle");
assert(main.includes('rsWorkMode:"ultimate"'),"legacy presets and adaptive must migrate to ultimate");
assert(main.includes('name: "Ultimate", badge: "ULTIMATE", short: "Ultimate"'),"ultimate shows a bar badge");
for(const phase of ['1. ASSESS','2. READ BEFORE YOU WRITE','3. PLAN INTERNALLY, THEN EXECUTE CONTINUOUSLY','4. APPROVAL ONLY FOR RISK','5. VERIFY DEEPLY','6. RECOVER','7. FINISH WITH EVIDENCE'])assert(config.includes(phase),phase);
assert(config.includes('LUAU ENGINEERING MANDATE')&&config.includes('MODELING MANDATE'),"both mandates present");
assert(config.includes('do not ask "Approve this plan to begin."'),"continuous by default");
assert(config.includes('Existing permission and platform confirmation rules always win.'));
assert(css.includes('.rs-work-row.rs-work-ultimate'));
console.log('PASS  Ultimate Work Mode is the default: Luau engineering + modeling mandates, continuous, deeply verified');
