#!/usr/bin/env node
// Online check (needs `gh` authenticated or a GITHUB_TOKEN): every Roblox docs
// path in src/core/skill_refs.js must exist in the Roblox/creator-docs
// repository (content/en-us/<path>.md, <path>/index.md, or <path>.yaml for the
// engine reference). Entries marked `unverified` (Blender manual) are listed
// but not fetched. Run from the TotalScript root:
//   node tools/verify_doc_refs.js
// Exit code 1 when any path is missing. Not part of the offline test loop.
"use strict";
const cp = require("child_process");
const R = require("../src/core/skill_refs.js");
const paths = new Map();
for (const id of R.ids()) for (const r of R.REFS[id]) if (!r.unverified) paths.set(r.p, (paths.get(r.p) || []).concat(id));
const exists = (p) => {
  try { cp.execFileSync("gh", ["api", "repos/Roblox/creator-docs/contents/content/en-us/" + p, "--jq", ".name // .[0].name"], { stdio: ["ignore", "pipe", "ignore"] }); return true; }
  catch { return false; }
};
let missing = 0, checked = 0;
for (const [p, ids] of paths) {
  checked++;
  const ok = /^reference\/engine\//.test(p) ? exists(p + ".yaml") : (exists(p + ".md") || exists(p + "/index.md") || exists(p));
  if (!ok) { missing++; console.log("MISSING " + p + "  (" + ids.join(", ") + ")"); }
}
const unverified = R.all().flatMap((x) => x.refs.filter((r) => r.unverified).map((r) => x.id + ": " + r.url));
console.log(`verify_doc_refs: ${checked} docs paths checked, ${missing} missing; ${unverified.length} outside-docs links not fetched${unverified.length ? ":\n  " + unverified.join("\n  ") : ""}`);
process.exit(missing ? 1 : 0);
