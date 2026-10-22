// Regression checks for collision-safe ORscript UI placement.
// Run with: node test-layout.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src/core/main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "overlay.css"), "utf8");
const collision = fs.readFileSync(path.join(root, "src/core/ui_collision_manager.js"), "utf8");
let failed = false;
function ok(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failed = true;
}

ok("anchored bars reserve composer padding", /function reserveAnchorStrip\([\s\S]*setProperty\("padding-top"[\s\S]*basePadding \+ occupied/.test(main));
ok("border-box composers grow instead of squeezing text", /anchorPad\.borderBox[\s\S]*setProperty\("min-height"[\s\S]*baseOuterHeight \+ occupied/.test(main));
ok("host inline styles are restored exactly", /getPropertyPriority\(prop\)[\s\S]*restoreInline[\s\S]*setProperty\(prop, old\.value, old\.priority/.test(main));
ok("anchored bar is seated in the reserved strip", /function dockBarInReservedStrip\([\s\S]*reserveAnchorStrip\(anchorEl, occupied\)[\s\S]*const top = r\.top \+ reservation\.borderTop/.test(main));
ok("bar is no longer floated above transcript text", !/r\.top\s*-\s*bh\s*-/.test(main));
ok("fallback uses a reserved composer frame", /Collision-safe fallback:[\s\S]*dockBarInReservedStrip\(f, "rs-bar-docked"\)/.test(main));
ok("unsafe viewport fallback is hidden without a composer", /Without a live composer there is no safe host-owned region[\s\S]*bar\.style\.display = "none"/.test(main));

ok("cards control lives inside the status row", /rightCluster\.insertBefore\(cardsBtn/.test(main) && !/cardsBtn\.className = "rs-cards-fab"/.test(main));
ok("settings tray opens below the reserved bar", /#rs-bar\.rs-menu-contained #rs-menu\.rs-menu-top[\s\S]*top: calc\(100% \+ 6px\) !important/.test(css));
ok("cards panel opens inside the reserved expansion lane", /#rs-bar\.rs-cards-open #rs-cards-panel[\s\S]*position: absolute !important/.test(css));
ok("open control height participates in reservation", /expandedSurfaceHeight\(\)[\s\S]*occupied = bh \+ BAR_GAP \+ \(expanded \? expanded \+ BAR_GAP : 0\)/.test(main));
ok("removed mode no longer occupies bar layout", !main.includes('id="rs-cowork"') && !main.includes('id="rs-steering"'));
ok("card send preview uses the reserved expansion lane", /bar\.classList\.add\("rs-card-embed-open"\)/.test(main) && /#rs-bar\.rs-card-embed-open #rs-card-embed/.test(css));
ok("first-run setup uses the reserved expansion lane", /bar\.appendChild\(setupCard\)/.test(main) && /#rs-bar\.rs-setup-open #rs-setup/.test(css));

ok("capture preview is an in-bar thumbnail", /className = "rs-shot-chip"/.test(main) && /right\.insertBefore\(wrap, cardsBtn/.test(main));
ok("capture preview no longer creates a fixed page card", !/className = "rs-shot"/.test(main) && !/position: fixed; left: 18px; top: 72px/.test(css));
ok("full capture opens only from thumbnail click", /open\.addEventListener\("click"[\s\S]*URL\.createObjectURL[\s\S]*window\.open/.test(main));

ok("working cover remains bounded", /const MAXH = P\.coverMaxH \|\| 200/.test(main) && /Math\.min\(Math\.max\(r\.height \+ PAD \* 2, 36\), MAXH\)/.test(main));
ok("native overlays trigger respectful hide/reposition", collision.includes("TEMPORARILY_HIDDEN") && collision.includes("REPOSITIONING") && collision.includes("getBoundingClientRect") && !css.includes(".cdk-overlay-container { z-index: 2147483646 !important; }"));

if (failed) {
  console.error("\nCollision-safe layout checks failed.");
  process.exit(1);
}
console.log("\nAll collision-safe layout checks passed.");
