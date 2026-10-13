#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Headless entry point: runs the ORscript bridge without the desktop window
// (same ports, same protocol). Useful for servers, CI and scripted setups.
//
//   node bridge/cli.js [--workspace <dir>] [--full-access] [--mcp "<command>"]
//                      [--data-dir <dir>] [--log-level debug|info|warn|error]
"use strict";

const path = require("path");
const { Bridge } = require("./server");
const { Settings, dataDir } = require("./settings");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--workspace" || a === "-w") out.workspace = next();
    else if (a === "--full-access") out.fullAccess = true;
    else if (a === "--mcp") out.mcp = next();
    else if (a === "--data-dir") out.dataDir = next();
    else if (a === "--log-level") out.logLevel = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "ORscript bridge (headless)\n\n" +
      "  --workspace <dir>     AgentScript workspace root (default %USERPROFILE%\\ORWorkspace)\n" +
      "  --full-access         allow absolute paths + process_kill for AgentScript\n" +
      "  --mcp \"<command>\"     override the Roblox Studio MCP helper command\n" +
      "  --data-dir <dir>      settings + logs location\n" +
      "  --log-level <level>   debug | info | warn | error\n"
    );
    return;
  }
  const dir = args.dataDir ? path.resolve(args.dataDir) : dataDir();
  const settings = new Settings({ dir });
  const patch = {};
  if (args.workspace) patch.workspaceRoot = path.resolve(args.workspace);
  if (args.fullAccess) patch.fullAccess = true;
  if (args.mcp) patch.mcpCommand = args.mcp;
  if (args.logLevel) patch.logLevel = args.logLevel;
  if (Object.keys(patch).length) settings.update(patch);

  const bridge = new Bridge({ settings, dataDir: dir });
  await bridge.start();

  const shutdown = async (signal) => {
    bridge.log.info("core", `received ${signal}, shutting down`);
    try { await bridge.stop(); } finally { process.exit(0); }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => bridge.log.error("core", `uncaught: ${err.stack || err.message}`));
  process.on("unhandledRejection", (err) => bridge.log.error("core", `unhandled rejection: ${(err && err.stack) || err}`));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
