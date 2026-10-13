"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Settings, sanitizeServer } = require("../bridge/settings");
const { compareVersions } = require("../bridge/server");
const { splitCommand } = require("../bridge/studio");

test("settings persist and sanitize", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orset-"));
  const s = new Settings({ dir });
  assert.equal(s.get("closeToTray"), true);
  s.update({ theme: "emerald", fullAccess: "yes", bogus: 1 });
  const again = new Settings({ dir });
  assert.equal(again.get("theme"), "emerald");
  assert.equal(again.get("fullAccess"), true);
  assert.equal("bogus" in again.all(), false);
  again.upsertServer({ id: "My Server!", command: "npx", args: ["-y", "x"], env: { TOKEN: "t", "bad key": "x" } });
  const srv = again.get("mcpServers")[0];
  assert.equal(srv.id, "my-server-");
  assert.deepEqual(srv.env, { TOKEN: "t" });
  assert.equal(again.removeServer("my-server-"), true);
  assert.equal(sanitizeServer({ id: "x" }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("helpers", () => {
  assert.ok(compareVersions("1.21.0", "1.20.9") > 0);
  assert.equal(compareVersions("1.21", "1.21.0"), 0);
  assert.deepEqual(splitCommand('"C:\\Program Files\\x\\mcp.bat" --flag'), { command: "C:\\Program Files\\x\\mcp.bat", args: ["--flag"] });
  assert.deepEqual(splitCommand("node server.js"), { command: "node", args: ["server.js"] });
});
