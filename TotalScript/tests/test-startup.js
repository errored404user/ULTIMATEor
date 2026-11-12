// Startup reliability regression contracts.
const fs=require("fs");
const main=fs.readFileSync("src/core/main.js","utf8");
const bg=fs.readFileSync("background.js","utf8");
let failures=0;const check=(n,v)=>{console.log(`${v?"PASS":"FAIL"}  ${n}`);if(!v)failures++;};
check("provider init failure is retained",main.includes("providerInitError = e instanceof Error"));
check("provider init failure is visible",main.includes("failed to initialize")&&main.includes("provider.initFailed"));
check("provider init can retry",/providerInitError && !initializeProvider\(\)/.test(main));
check("duplicate Start is ignored",main.includes("start.duplicateIgnored"));
check("Start requires installed message hooks",main.includes("if (!providerHooksReady)"));
check("message hook errors are visible",main.includes("provider.hooksFailed")&&main.includes("integration failed"));
check("composer readiness is bounded",main.includes('startupTimeout(P.ensureComposerReady("startup"), 15000'));
check("bootstrap always unlocks",main.includes("start.unlockFailed")&&main.includes("ui.inputCover(false)"));
check("background validates messages",bg.includes('kind:"invalid-message"'));
check("background async failures reply",bg.includes('kind:"background-error"')&&bg.includes('message handler failed'));
check("background unknown messages explain type",bg.includes("unknown message type: ${msg.type}"));
check("Start path has no out-of-scope state transition", !main.includes("setAgentState(") && !main.includes("AGENT_STATES"));
process.exitCode=failures?1:0;
