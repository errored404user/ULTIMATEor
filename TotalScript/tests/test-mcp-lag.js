// MCP latency/replay regression checks.
const fs=require('fs');const bg=fs.readFileSync('background.js','utf8'),main=fs.readFileSync('src/core/main.js','utf8'),rust=fs.readFileSync('agent/src/main.rs','utf8');let failed=0;const ok=(n,v)=>{console.log(`${v?'PASS':'FAIL'}  ${n}`);if(!v)failed++;};
ok('extension does not reconnect/replay on timeout',bg.includes('r.kind === "disconnected"')&&!bg.includes('r.kind === "disconnected" || r.kind === "timeout"'));
ok('script_read extension wait is bounded to 30 seconds',main.includes('bareName === "script_read" ? 30000'));
ok('MCP timeout resets helper without second long replay',rust.includes('timed out — resetting helper without replay')&&rust.includes('return Err(error)'));
ok('mutating extension requests are not automatically replayed',bg.includes('bridgeRequestIsIdempotent')&&bg.includes('Never replay a mutating Studio request'));
ok('only one reconnect retry block exists',bg.includes('if (retryable)')&&!bg.includes('for (let i = 0; i < 3'));
process.exitCode=failed?1:0;
