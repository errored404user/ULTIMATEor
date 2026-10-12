// Isolated bridge between the official OrScript Figma plugin UI and extension service worker.
(()=>{"use strict";if(globalThis.__orFigmaBridge)return;globalThis.__orFigmaBridge=true;
window.addEventListener("message",e=>{if(!e.data||e.data.source!=="orscript-figma-plugin")return;if(e.data.type==="OR_FIGMA_READY")chrome.runtime.sendMessage({type:"figma_plugin_ready"}).catch(()=>{});else if(e.data.type==="OR_FIGMA_RESULT")chrome.runtime.sendMessage({type:"figma_plugin_result",requestId:String(e.data.requestId||""),result:e.data.result}).catch(()=>{});});
chrome.runtime.onMessage.addListener((m,_s,reply)=>{if(!m||m.type!=="figma_plugin_execute")return false;window.postMessage({source:"orscript-extension",type:"OR_FIGMA_REQUEST",requestId:m.requestId,operation:m.operation,args:m.args||{}},"*");reply({ok:true});return false;});
})();
