// SPDX-License-Identifier: GPL-3.0-or-later
// Port hygiene: before binding 3000/17613/17615 we evict stale bridge
// processes (or-agent / or-core / python helpers) exactly like or-core does,
// but never touch unrelated applications - those are reported as conflicts.
"use strict";

const net = require("net");
const { execFile } = require("child_process");

const RECLAIMABLE = ["or-agent", "or-core", "python", "pythonw", "roblox-bridge", "orscript-bridge"];

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

async function ownerOfPort(port) {
  if (process.platform === "win32") {
    const out = await run("netstat", ["-ano", "-p", "tcp"]);
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && Number(m[1]) === port) {
        const pid = Number(m[2]);
        const list = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
        const mm = list.match(/^"([^"]*)"/m);
        return { pid, name: mm ? mm[1] : "unknown" };
      }
    }
    return null;
  }
  const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  const pid = (out.match(/^p(\d+)/m) || [])[1];
  if (!pid) return null;
  const name = (out.match(/^c(.+)$/m) || [])[1] || "unknown";
  return { pid: Number(pid), name };
}

function kill(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => resolve(!err));
    else { try { process.kill(pid, "SIGKILL"); resolve(true); } catch { resolve(false); } }
  });
}

function isFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Returns [{ port, action: "free" | "reclaimed" | "conflict", owner }]
async function reclaimPorts(ports, log) {
  const report = [];
  for (const port of ports) {
    if (await isFree(port)) { report.push({ port, action: "free" }); continue; }
    const owner = await ownerOfPort(port);
    const name = owner ? owner.name.toLowerCase() : "";
    const mine = owner && owner.pid === process.pid;
    const reclaimable = owner && !mine && RECLAIMABLE.some((n) => name.includes(n));
    if (reclaimable) {
      const ok = await kill(owner.pid);
      if (log) log.warn("ports", `port ${port} held by ${owner.name} (pid ${owner.pid}) - ${ok ? "terminated stale bridge" : "could not terminate"}`);
      await new Promise((r) => setTimeout(r, 400));
      report.push({ port, action: ok && (await isFree(port)) ? "reclaimed" : "conflict", owner });
    } else {
      if (log) log.error("ports", `port ${port} is busy (${owner ? `${owner.name} pid ${owner.pid}` : "unknown owner"}) - close that program or stop PlazCode/other bridges`);
      report.push({ port, action: "conflict", owner });
    }
  }
  return report;
}

module.exports = { reclaimPorts, isFree, ownerOfPort, RECLAIMABLE };
