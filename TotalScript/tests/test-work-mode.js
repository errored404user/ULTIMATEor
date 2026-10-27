"use strict";
// Creation Work Mode (1.39.0: Ultimate + Visualizer + Animator merged) is the default.
const fs=require("fs"),assert=require("assert");
const main=fs.readFileSync("src/core/main.js","utf8"),config=fs.readFileSync("src/core/config.js","utf8"),css=fs.readFileSync("overlay.css","utf8");
assert(main.includes('let workMode = "creation"'),"creation is the default");
assert(!main.includes('data-work="fast"')&&!main.includes('data-work="balanced"')&&!main.includes('data-work="thorough"')&&!main.includes('data-work="adaptive"'));
assert(main.includes('Luau systems · Modeling · VFX & Lighting · UI · Animation & Camera — everything, verified'),"creation card subtitle");
assert(main.includes('rsWorkMode:"creation"'),"legacy modes (ultimate / visualizer / animator / adaptive / presets) must migrate to creation");
assert(main.includes('name: "Totality", badge: "TOTALITY", short: "Totality"'),"creation shows a bar badge");
for(const phase of ['1. ASSESS','2. READ BEFORE YOU WRITE','3. PLAN INTERNALLY, THEN EXECUTE CONTINUOUSLY','4. APPROVAL ONLY FOR RISK','5. VERIFY DEEPLY','6. RECOVER','7. FINISH WITH EVIDENCE'])assert(config.includes(phase),phase);
assert(config.includes('LUAU ENGINEERING MANDATE')&&config.includes('MODELING MANDATE')&&config.includes('VISUAL MANDATE')&&config.includes('MOTION MANDATE'),"all four mandates present");
assert(config.includes('do not ask "Approve this plan to begin."'),"continuous by default");
assert(config.includes('Existing permission and platform confirmation rules always win.'));
assert(css.includes('.rs-work-row.rs-work-creation'));
console.log('PASS  Creation Work Mode is the default: Luau engineering + modeling + visual + motion mandates, continuous, deeply verified');
