"use strict";
const fs=require("fs"),assert=require("assert");
const css=fs.readFileSync("overlay.css","utf8"),main=fs.readFileSync("src/core/main.js","utf8");
assert(css.includes('grid-template-columns:minmax(180px,1fr) auto!important'),"header must reserve one stable action column");
assert(css.includes('grid-template-columns:repeat(2,minmax(105px,auto))!important'),"desktop actions must stay side by side");
assert(css.includes('@media(max-width:620px)'),"stacking must be reserved for genuinely narrow panels");
assert(css.includes('grid-template-columns:minmax(180px,1fr) 140px 108px!important'),"search, filter, and import need predictable widths");
assert(main.indexOf('>Create template</button>')<main.indexOf('>Create with AI</button>'),"primary create action must come first");
console.log("PASS  Template header remains compact with stable side-by-side actions");
