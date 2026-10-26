"use strict";
const fs=require("fs"),assert=require("assert");
const main=fs.readFileSync("src/core/main.js","utf8"),css=fs.readFileSync("overlay.css","utf8");
assert(main.includes('class="rs-template-controls"'),"header and search must share one fixed controls surface");
assert(css.includes('.rs-template-controls{position:sticky;top:0;z-index:20'),"template controls must stay visible while the list scrolls");
assert(css.includes('overflow-y:auto!important')&&css.includes('overscroll-behavior:contain'),"only the content body should scroll");
assert(main.includes("' + EXT_VERSION + '"),"visible build version must be evaluated, not raw template text");
assert(!main.includes('rs-cards-subheading\">Reusable workflows · v${EXT_VERSION}'),"raw version expression must never appear in the Template header");
console.log("PASS  Template controls remain fixed while the library scrolls independently");
