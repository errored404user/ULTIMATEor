"use strict";
const fs=require("fs"),assert=require("assert");
const main=fs.readFileSync("src/core/main.js","utf8"),css=fs.readFileSync("overlay.css","utf8");
for(const label of ["Create template","Create with AI","Import template","Improve with AI"])assert(main.includes(`>${label}</button>`),label);
for(const cls of ["rs-btn-create","rs-btn-ai","rs-template-import","rs-template-improve"])assert(main.includes(cls),cls);
assert(css.includes('flex-direction:row!important'),"header actions must not stack at desktop widths");
assert(css.includes('.rs-btn-create')&&css.includes('.rs-btn-ai')&&css.includes('.rs-template-improve'),"each action tier needs explicit styling");
assert(css.includes('@media(max-width:700px)')&&css.includes('flex:1!important'),"actions must remain usable on narrow panels");
console.log("PASS  Template actions are aligned, readable, and visually prioritized");
