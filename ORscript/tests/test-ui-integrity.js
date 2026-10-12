"use strict";
const fs=require("fs"),assert=require("assert");
const main=fs.readFileSync("src/core/main.js","utf8");
for(const id of ["rs-set-text","rs-set-save","rs-set-status","rs-mcp-blender","rs-blender-site","rs-figma-card","rs-figma-connect","rs-figma-check","rs-figma-refresh","rs-figma-disconnect","rs-mcp-add","rs-mcp-repair"]){
  assert(main.includes(`id=\"${id}\"`),`settings markup missing #${id}`);
}
for(const mode of ["autodebug","multiagent","sounds"]){assert(main.includes(`data-mode=\"${mode}\"`),`settings lost ${mode}`);}
assert(main.includes("if (ta) ta.value = customPrompt"),"optional settings nodes must not crash menu construction");
assert(main.includes("if (ta && saveBtn) saveBtn.addEventListener"),"custom prompt binding must be guarded");
assert(!main.includes('id="rs-cowork"')&&!main.includes('data-mode="cowork"'),"removed mode must stay removed");
console.log("PASS  settings UI has complete markup and null-safe event binding");
