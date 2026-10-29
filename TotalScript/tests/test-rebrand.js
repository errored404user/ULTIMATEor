// 1.71.0: ORscript -> TotalScript rename + Aqua default skin.
// Pins: no old brand token left in shipped files, renamed artefacts exist, legacy
// settings / file formats still load, Aqua is the default everywhere.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; } else { failed++; console.error("FAIL  " + name + (extra ? " :: " + extra : "")); } }
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

// ── 1. shipped text files carry no ORscript-era brand token ──────────────────
const SKIP = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".zip", ".exe", ".mp3", ".wav", ".woff", ".woff2", ".ttf"]);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "target" || e.name === "tests") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (!SKIP.has(path.extname(e.name).toLowerCase())) files.push(p);
  }
})(root);
ok("scan covers the shipped tree", files.length > 80, String(files.length));
// allowed: legacy-compat lookups that read the OLD names on purpose
const ALLOW = [
  /plugin:GetSetting\("ORscript" \.\. key\)/,                 // plugin settings carry-over
  /support\.join\("ORscript"\)/, /ORscript-era/, /old `?ORscript`?/, /from the ORscript-era/,  // comments / docs about the migration
  /"orscript-animation"/, /\^orscript-/,  // old export formats still import
  /FindFirstChild\(['"]OR_UI(?:Bindings|Behaviours|Events)['"]\)/, /'OR_UIBindings'\}/, /match\('\^OR_'\)/, /sub\(1,3\)=='OR_'/,  // old GUI binding store / behaviour script / events folder / OR_-prefixed effects still recognised
  /ORscript\*? (keys|settings|folder)/, /ORscript → TotalScript/, /ORscript is now/, /was ORscript/, /ORscript\*/,
];
const BRAND = /ORscript|OrScript|Orscript|ORSCRIPT|orscript|\bor-core\b|\bor_core\b|\bor-agent\b|\bor_agent\b|\bOR_[A-Za-z0-9_]+|\bOR(?:Paint|GuiStudio|Orchestrator|TaskList|Reasoning|AgentCrew|TemplateRegistry|AnimStudio|AnimEngine|ProjectAnalyzer|CommandRegistry|GuiTemplates|GuiGen|Screenshot|UICollisionManager|ProjectWorker|LuauLib|BlueprintLib|Brief)\b|--or-|--orx-|data-or-theme|\borTheme\b|\bor_screenshot\b|\bor_debug\b|\bor_status\b|\b_orInternal\b|\[OR-AGENT\]|System note from OR\b/;
const leaks = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    if (!BRAND.test(l)) return;
    if (/README\.md$/.test(f) && /^\*\*1\.(?:[0-6]\d|70)\./.test(l)) return;     // historical changelog entries may name the old brand
    if (ALLOW.some((re) => re.test(l))) return;
    leaks.push(path.relative(root, f) + ":" + (i + 1) + " " + l.trim().slice(0, 100));
  });
}
ok("no ORscript-era brand token left in shipped files (outside historical changelog + legacy-compat reads)", leaks.length === 0, leaks.slice(0, 12).join("\n      "));

// ── 2. renamed artefacts ──────────────────────────────────────────────────────
ok("plugin file renamed", exists("plugin/TotalScript.lua") && !exists("plugin/ORscript.lua"));
ok("build scripts renamed", exists("Build-TotalScript-Desktop.cmd") && exists("build-totalscript-desktop.sh") && !exists("Build-ORscript-Desktop.cmd"));
ok("bundled executable renamed", exists("bin/total-core.exe") && !exists("bin/or-core.exe"));
const cargo = read("agent/Cargo.toml"), lock = read("agent/Cargo.lock");
ok("crate is total-agent, binary total-core", /^name = "total-agent"/m.test(cargo) && /\[\[bin\]\]\nname = "total-core"/.test(cargo));
ok("Cargo.lock renamed in place and still sorted (--locked must keep passing)", (() => {
  const names = [...lock.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1]);
  return names.includes("total-agent") && !names.includes("or-agent") && names.every((n, i) => i === 0 || names[i - 1] <= n || names[i - 1] === n);
})());
const manifest = JSON.parse(read("manifest.json"));
ok("manifest name / title", manifest.name === "TotalScript" && manifest.action.default_title === "TotalScript — RS/AS");
const main = read("src/core/main.js"), config = read("src/core/config.js"), lua = read("plugin/TotalScript.lua"), gui = read("agent/src/gui.rs");
ok("product name + APP_NAME", main.includes('totalTheme==="void"?"VoidScript":"TotalScript"') && config.includes('const APP_NAME = "TotalScript";') && gui.includes('pub const APP_NAME: &str = "TotalScript";'));
ok("plugin toolbar + kind id", lua.includes('plugin:CreateToolbar("TotalScript")') && lua.includes('{ id = "totalscript", name = "TotalScript", match = { "totalscript" }, kind = "agent" }'));
ok("module globals renamed", ["TotalPaint", "TotalOrchestrator", "TotalTaskList", "TotalReasoning", "TotalAgentCrew", "TotalAnimStudio"].every((g) => main.includes(g)));
ok("internal-arg prefix is _total (wire filter + validator agree)", main.includes("if (!/^_total/.test(k)) o[k] = args[k];") && read("src/core/orchestrator.js").includes("if (/^_total/.test(k)) continue;") && main.includes("_totalInternal"));
ok("workflow builds TotalScript/agent and uploads total-core artefacts", (() => { const w = fs.readFileSync(path.join(root, "..", ".github", "workflows", "desktop.yml"), "utf8"); return w.includes("working-directory: TotalScript/agent") && w.includes("total-core-windows-x64") && w.includes("./target/release/total-core.exe --help") && !/ORscript|or-core/.test(w); })());
ok("mesh marker parsing is length-based, not a hard-coded 13", read("background.js").includes('lines[i].slice("TOTAL_MESH_JSON:".length)') && main.includes('textOut.slice(mark + "TOTAL_MESH_JSON:".length)'));

// ── 3. nothing saved is lost ──────────────────────────────────────────────────
ok("plugin reads TotalScript* settings, falls back to ORscript*", lua.includes('local v = plugin:GetSetting("TotalScript" .. key)') && lua.includes('if v == nil then v = plugin:GetSetting("ORscript" .. key) end') && lua.includes('settingWithLegacy("OpenCloudKey")') && lua.includes('settingWithLegacy("Macros")'));
ok("macOS data dir keeps the old folder until a new one exists", gui.includes('let legacy = support.join("ORscript");') && gui.includes("if !new_dir.exists() && legacy.exists() { legacy } else { new_dir }"));
ok("old export formats still import", read("src/core/animengine.js").includes('j.format === "orscript-animation"') && read("src/core/public_skills.js").includes('f.replace(/^orscript-/, "totalscript-") === want'));
ok("GUI behaviours read Total_UIBindings or the old OR_UIBindings; legacy behaviour script / events folder are adopted, not duplicated", (() => { const g = read("src/core/skills/studio_guistudio.js"); return g.includes("gui:FindFirstChild(\"Total_UIBindings\") or gui:FindFirstChild(\"OR_UIBindings\")") && g.includes("sv.Name='Total_UIBindings'") && g.includes("or sg:FindFirstChild('OR_UIBehaviours') if not ls then ls=Instance.new('LocalScript') ls.Parent=sg end ls.Name='Total_UIBehaviours'") && g.includes('or ReplicatedStorage:FindFirstChild("OR_UIEvents")'); })());
ok("generated Luau uses the Total_ instance / attribute prefix (OR_Systems, OR_Version, OR_Controller … are gone)", (() => { const all = fs.readdirSync(path.join(root, "src/core/skills")).map((f) => read("src/core/skills/" + f)).join("\n"); return all.includes("Total_Systems") && all.includes("Total_Version") && !/\bOR_(?:Systems|Version|Controller|Blueprint|Design|Notify|Toggle|Window|Progress|Imported|ProjectIndex)\b/.test(all); })());
ok("token attributes / post-FX cleanup accept both prefixes (places built before the rename still export + reset)", read("src/core/skills/studio_guistudio.js").includes("local pre=(k:sub(1,6)=='Total_' and 6) or (k:sub(1,3)=='OR_' and 3) or nil") && read("src/core/skills/studio_modes.js").includes("if c.Name:sub(1,6)=='Total_' or c.Name:sub(1,3)=='OR_' then c:Destroy()") && read("src/core/skills/studio_200.js").includes("not (sg.Name:match('^Total_') or sg.Name:match('^OR_'))"));

// ── 4. Aqua is the default ────────────────────────────────────────────────────
const css = read("overlay.css"), popup = read("popup.html");
ok("extension skin pinned to aqua", main.includes('const totalTheme = "aqua";') && main.includes('|| THEME_SOUNDS.aqua') && main.includes('totalTheme || "aqua"'));
ok("aqua theme entry + sound pack", /aqua:\s*\{ name: "Aqua"/.test(main) && /aqua: \{ label: "Water drops/.test(main));
ok("aqua CSS: tokens, swatch, ornament, tile, menu head, cards, work cards, reduced motion", ['html[data-rs-theme="aqua"] {', "--totalx-img:url(ui/swatch-aqua.jpg)", 'html[data-rs-theme="aqua"] { --totalx-orn: url("data:image/svg+xml;utf8,<svg', 'html[data-rs-theme="aqua"] { --totalx-tile:', 'html[data-rs-theme="aqua"] .rs-menu-head {', 'html[data-rs-theme="aqua"] #rs-cards-panel::before', 'html[data-rs-theme="aqua"] .rs-work-card.on', "@keyframes rs-aqua-caustic", "@keyframes rs-aqua-breathe", 'html.rs-light[data-rs-theme="aqua"]'].every((t) => css.includes(t)));
ok("aqua block is appended last (wins the cascade) and has no dead #rs-bar::after rule", css.lastIndexOf('html[data-rs-theme="aqua"]') > css.lastIndexOf('html[data-rs-theme="night"]') && !css.slice(css.indexOf("AQUA — TotalScript")).includes("#rs-bar::after"));
ok("swatch photo shipped", exists("ui/swatch-aqua.jpg") && fs.statSync(path.join(root, "ui/swatch-aqua.jpg")).size > 20000);
ok("popup defaults to aqua", popup.includes('<html data-theme="aqua">') && popup.includes('html[data-theme="aqua"]{--bg:#03161c;') && read("popup.js").includes('setAttribute("data-theme", "aqua")'));
ok("desktop app: Aqua palette is the default, Gold kept", gui.includes('theme: "aqua".into(),') && gui.includes('("aqua", "TotalScript Aqua"), ("gold", "Gold")') && gui.includes('"gold" => Theme {') && gui.includes("Color32::from_rgb(34, 211, 238)"));
ok("theme preview harness defaults to aqua", read("tools/theme-preview/harness.js").includes("totalTheme = 'aqua'"));
ok("night skin still exists as a selectable style", css.includes('html[data-rs-theme="night"] {') && /night:\s*\{ name: "Night"/.test(main));

// ── 5. release pins ───────────────────────────────────────────────────────────
const readme = read("README.md");
ok("README 1.71.0 entry + title", /\*\*1\.71\.0 — TotalScript: the rename, and Aqua as the default skin\.\*\*/.test(readme) && readme.startsWith("# TotalScript — "));
ok("version pins 1.99.2", manifest.version === "1.99.2" && /^version = "1\.99\.2"/m.test(cargo) && lua.includes('local VERSION = "1.99.2"') && lock.includes('name = "total-agent"\nversion = "1.99.2"'));

console.log((failed ? "FAIL  " : "OK    ") + "test-rebrand: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
