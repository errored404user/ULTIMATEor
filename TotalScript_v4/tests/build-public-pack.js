#!/usr/bin/env node
// Writes public_skills/totalscript-featured.orskills.json from src/core/public_packs.js
// (the same bytes TotalPublicPacks.packJson() returns in the extension), so the pack
// is also importable as a plain file by people who do not use the Public tab.
//
//   node tests/build-public-pack.js            # (re)write the file
//   node tests/build-public-pack.js --check    # exit 1 if the file is stale
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const PP = require(path.join(root, "src/core/public_packs.js"));
const out = path.join(root, "public_skills", "totalscript-featured.orskills.json");
const json = PP.packJson(PP.PACK_ID) + "\n";
if (process.argv.includes("--check")) {
  const have = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (have !== json) { console.error("STALE  " + path.relative(root, out) + " differs from TotalPublicPacks.packJson() - run: node tests/build-public-pack.js"); process.exit(1); }
  console.log("OK     " + path.relative(root, out) + " matches public_packs.js (" + json.length + " bytes)");
  process.exit(0);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, json);
console.log("wrote  " + path.relative(root, out) + " (" + json.length + " bytes, " + PP.get(PP.PACK_ID).items.length + " items, v" + PP.get(PP.PACK_ID).version + ")");
