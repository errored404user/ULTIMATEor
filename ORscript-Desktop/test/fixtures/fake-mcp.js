// Fake Roblox Studio MCP helper (stdio JSON-RPC) used by the test-suite.
// FAKE_STUDIO_ATTACHED=0 simulates "Studio closed"; FAKE_MCP_CRASH_ON=<tool>
// makes the helper exit when that tool is called (dead-helper retry path).
"use strict";

const attached = process.env.FAKE_STUDIO_ATTACHED !== "0";
const crashOn = process.env.FAKE_MCP_CRASH_ON || "";
let buf = "";

const TOOLS = [
  { name: "get_studio_state", description: "Current Studio state", inputSchema: { type: "object", properties: {} } },
  { name: "execute_luau", description: "Run Luau in Studio", inputSchema: { type: "object", properties: { code: { type: "string" }, datamodel_type: { type: "string" } }, required: ["code"] } },
  { name: "screen_capture", description: "Viewport screenshot", inputSchema: { type: "object", properties: {} } },
  { name: "slow_tool", description: "Never answers", inputSchema: { type: "object", properties: {} } },
];

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-studio-mcp", version: "0.1" } });
    else if (msg.method === "tools/list") reply(msg.id, { tools: TOOLS });
    else if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (crashOn && name === crashOn) process.exit(3);
      if (name === "get_studio_state") reply(msg.id, { content: [{ type: "text", text: attached ? "Studio: place 'TestPlace' (Edit mode), selection: 0" : "Unable to find an active Studio instance" }] });
      else if (name === "execute_luau") {
        if (!attached) reply(msg.id, { isError: true, content: [{ type: "text", text: "No active Studio" }] });
        else reply(msg.id, { content: [{ type: "text", text: `ran: ${String(args.code || "").slice(0, 60)}` }] });
      } else if (name === "screen_capture") reply(msg.id, { content: [{ type: "text", text: "captured" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] });
      else if (name === "slow_tool") { /* never replies */ }
      else fail(msg.id, -32601, `unknown tool ${name}`);
    } else if (msg.id !== undefined) reply(msg.id, {});
  }
});
process.stdin.on("end", () => process.exit(0));
