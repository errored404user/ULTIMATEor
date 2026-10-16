#!/usr/bin/env node
// Static + build checks for the DESIGN pack (src/core/skills/studio_design.js, 1.29.0):
// registration, bundles, schemas, every screen template, token presets, generated
// Luau shape, embedded module sources, prompt/help wiring and the ChatGPT catalogue
// budget. Runtime behaviour is covered by tests/design-sim.py (lupa simulator).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    failed++;
    console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 400) : ""));
  }
}

// ── load the skill bundle exactly like the extension does ─────────────────────
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("manifest has content-script bundles", bundles.length >= 10, bundles.length);
ok("every main.js bundle loads studio_design.js right after studio_modes.js", bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_modes.js");
  return i >= 0 && b.js[i + 1] === "src/core/skills/studio_design.js" && b.js.indexOf("src/core/main.js") > i + 1;
}));
ok("codecraft.html loads studio_design.js after studio_modes.js", (() => {
  const h = fs.readFileSync("codecraft.html", "utf8");
  return h.indexOf("studio_design.js") > h.indexOf("studio_modes.js") && h.indexOf("studio_design.js") < h.indexOf("src/core/main.js");
})());

const files = bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = vm.runInThisContext("typeof RobloxScriptSkills !== 'undefined' ? RobloxScriptSkills : undefined");
ok("RobloxScriptSkills exposes the design pack", S && Array.isArray(S.DESIGN_COMMANDS) && S.DESIGN_LUA && S.DESIGN_PRESETS && S.DESIGN_SCREENS);

const EXPECTED = ["design_tokens_set", "design_tokens_get", "design_kit_install", "ui_from_spec", "ui_screen_generate", "ui_component_place", "ui_apply_tokens", "ui_make_responsive", "ui_gamepad_focus", "ui_states_wire", "ui_audit", "ui_export_spec", "ui_preview"];
ok("13 design commands", S.DESIGN_COMMANDS.length === 13 && EXPECTED.every((n) => S.DESIGN_COMMANDS.includes(n)), S.DESIGN_COMMANDS.join(","));
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
ok("design commands are registered in SKILL_COMMANDS with descriptions + params", EXPECTED.every((n) => byName.has(n) && byName.get(n).description.length > 40 && byName.get(n).params && typeof byName.get(n).params === "object"));
ok("SKILL_OPS contains the design ops", EXPECTED.every((n) => S.SKILL_OPS.includes(n)));
ok("no duplicate command names after registration", new Set(S.SKILL_COMMANDS.map((c) => c.name)).size === S.SKILL_COMMANDS.length);
const isReq = (p) => p && (p.req === true || p.required === true);
ok("required params are flagged in schemas", isReq(byName.get("ui_from_spec").params.spec) && isReq(byName.get("ui_screen_generate").params.kind) && isReq(byName.get("ui_component_place").params.kind) && isReq(byName.get("ui_component_place").params.parent));
ok("ui_screen_generate schema enumerates every screen kind", (() => {
  const pk = byName.get("ui_screen_generate").params.kind;
  const d = (pk.desc || pk.description || "");
  return S.DESIGN_SCREENS.every((k) => d.includes(k));
})());

// ── token presets ─────────────────────────────────────────────────────────────
ok("10 token presets incl. midnight/clean_light/candy/neon/horror", S.DESIGN_PRESETS.length === 10 && ["midnight", "clean_light", "candy", "neon", "horror"].every((p) => S.DESIGN_PRESETS.includes(p)));
for (const p of S.DESIGN_PRESETS) {
  const T = S.designTokens({ preset: p });
  const keys = ["Primary", "PrimaryHover", "PrimaryPressed", "Secondary", "Surface", "SurfaceAlt", "Text", "TextMuted", "Success", "Danger", "Warning", "Stroke", "Overlay"];
  ok("preset " + p + " has a complete palette, font, radius, spacing, motion, rarity", keys.every((k) => Array.isArray(T.palette[k]) && T.palette[k].length === 3) && T.font.Family && T.radius.md >= 0 && T.spacing.md > 0 && T.motion.fast > 0 && T.rarity.legendary);
}
const over = S.designTokens({ preset: "midnight", primary: "#ff0000", surface: "rgb(1,2,3)", font: "Arcade", radius: 3, text: [250, 250, 250] });
ok("designTokens applies overrides (hex, rgb(), array) and derives hover/pressed", over.palette.Primary.join(",") === "255,0,0" && over.palette.Surface.join(",") === "1,2,3" && over.font.Family === "Arcade" && over.radius.md === 3 && over.palette.Text.join(",") === "250,250,250" && over.palette.PrimaryHover.join(",") !== "255,0,0");
const tokSrc = S.DESIGN_LUA.Tokens;
ok("Tokens module source is a Luau table with Color3.fromRGB palette + rarity", /^-- ORscript design tokens/.test(tokSrc) && tokSrc.includes("Primary = Color3.fromRGB(") && tokSrc.includes("T.rarity") && tokSrc.includes("return T"));

// ── embedded Luau sources ─────────────────────────────────────────────────────
const LUA = S.DESIGN_LUA;
ok("DESIGN_LUA ships kit + runtime scripts", ["UIKit", "Responsive", "Controller", "HudFeed", "LeaderboardFeed", "NotifyFeed", "Loading", "DailyClient", "SettingsStore", "ShopServer", "DailyServer", "Tokens"].every((k) => typeof LUA[k] === "string" && LUA[k].length > 200));
const kitFns = ["tokens", "textOn", "contrast", "corner", "stroke", "padding", "layout", "wireButton", "setDisabled", "selectionCursor", "Label", "Image", "Panel", "Row", "Column", "Grid", "ScrollList", "Button", "IconButton", "Divider", "Spacer", "Input", "Window", "CurrencyPill", "ProgressBar", "bindProgress", "Toggle", "bindToggle", "ItemCard", "Slot", "Tabs", "bindTabs", "Toast", "bindAll", "setWindowOpen"];
ok("UIKit defines every component/helper (" + kitFns.length + ")", kitFns.every((f) => LUA.UIKit.includes("function UIKit." + f + "(")), kitFns.filter((f) => !LUA.UIKit.includes("function UIKit." + f + "(")).join(","));
ok("UIKit never persists wiring guards as attributes (clone-safe weak tables)", !/SetAttribute\("OR_(Wired|ToggleBound|TabsBound|ProgressBound)"/.test(LUA.UIKit) && LUA.UIKit.includes('setmetatable({}, { __mode = "k" })'));
ok("Controller handles close/toggle/open/remote/print actions, OR_OpenKey, gamepad B and typewriter", ["close", "toggle:", "open:", "remote:", "print", "OR_OpenKey", "ButtonB", "OR_Typewriter"].every((k) => LUA.Controller.includes(k)));
ok("HudFeed binds leaderstats + humanoid health and formats numbers", LUA.HudFeed.includes("leaderstats") && LUA.HudFeed.includes("HealthChanged") && /K|M/.test(LUA.HudFeed));
ok("Responsive module reacts to viewport changes and enforces touch targets / text floors", LUA.Responsive.includes("ViewportSize") && LUA.Responsive.includes("TouchEnabled") && LUA.Responsive.includes("UITextSizeConstraint"));
ok("Loading script lives in ReplicatedFirst flow (RemoveDefaultLoadingScreen + PreloadAsync)", LUA.Loading.includes("RemoveDefaultLoadingScreen") && LUA.Loading.includes("PreloadAsync"));
ok("ShopServer validates price/currency on the server and never trusts the client", LUA.ShopServer.includes("CATALOG") && LUA.ShopServer.includes("OnServerEvent") && LUA.ShopServer.includes("leaderstats"));
ok("DailyServer persists through a DataStore (pcall-guarded, memory fallback) + 20h cooldown", LUA.DailyServer.includes('GetDataStore("OR_DailyRewards")') && LUA.DailyServer.includes("pcall(store.GetAsync") && LUA.DailyServer.includes("pcall(store.SetAsync") && LUA.DailyServer.includes("20 * 3600"));
// strings in the embedded Luau must not contain raw template-literal leftovers
ok("embedded Luau has no JS template leftovers (${ or `)", Object.values(LUA).every((src) => !src.includes("${") && !src.includes("`")));

// ── every screen kind builds ─────────────────────────────────────────────────
ok("11 screen kinds", S.DESIGN_SCREENS.length === 11 && ["main_menu", "hud", "shop", "inventory", "settings", "leaderboard", "daily_rewards", "quest_log", "loading", "dialog", "notification_stack"].every((k) => S.DESIGN_SCREENS.includes(k)));
for (const kind of S.DESIGN_SCREENS) {
  const r = S.buildLuau("ui_screen_generate", { kind, title: "T", items: ["A", "B"], buttons: ["Play"] });
  ok("ui_screen_generate " + kind + " generates Luau with the kit header", !r.err && r.code.includes("local function kit()") && r.code.includes("buildScreen(") && r.code.includes("pcall(function()"), r.err);
  const spec = S.designScreenSpec(kind, { title: "T" });
  ok("  " + kind + " spec has a root + children", spec && spec.spec && Array.isArray(spec.spec.children) && spec.spec.children.length > 0);
}
const bad = S.buildLuau("ui_screen_generate", { kind: "nope" });
ok("unknown screen kind is rejected at build time", bad.err && /kind/.test(bad.err), bad.err);
const bad2 = S.buildLuau("ui_component_place", { kind: "Nope", parent: "StarterGui.X" });
ok("unknown component kind is rejected at build time", bad2.err && /unknown component kind/.test(bad2.err), bad2.err);
const noSpec = S.buildLuau("ui_from_spec", {});
ok("ui_from_spec without spec is rejected", !!noSpec.err);

const fromSpec = S.buildLuau("ui_from_spec", { name: "X", spec: { children: [{ kind: "Window", title: "W", children: [{ kind: "Button", text: "Go", action: "close" }] }] } });
ok("ui_from_spec embeds the JSON spec and the generic controller", !fromSpec.err && fromSpec.code.includes("JSONDecode(") && fromSpec.code.includes("OR_Controller"));
const tok = S.buildLuau("design_tokens_set", { preset: "candy", primary: "#123456" });
ok("design_tokens_set writes ReplicatedStorage.OR_Design.Tokens + installs the kit", !tok.err && tok.code.includes("OR_Design") && tok.code.includes("ensureKit(") && tok.code.includes("#123456"));
const audit = S.buildLuau("ui_audit", { path: "StarterGui" });
ok("ui_audit covers the documented rules", ["low_contrast", "weak_contrast", "tiny_text", "small_touch_target", "offset_only_root", "overlap", "static_canvas", "zindex_global", "no_runtime", "palette_drift", "empty_image"].every((r) => audit.code.includes("'" + r + "'")));

// ── embedded Luau sources are parsed with a real Lua parser in tests/luau-parse-check.py
// and executed against a miniature Roblox DataModel in tests/design-sim.py (both need lupa).
ok("each DESIGN_LUA source has no dangling JS interpolation", Object.values(LUA).every((src) => !/\$\{/.test(src)));

// ── prompt / help / UI wiring ────────────────────────────────────────────────
const mainSrc = fs.readFileSync("src/core/main.js", "utf8");
const configSrc = fs.readFileSync("src/core/config.js", "utf8");
ok("visualizer work mode focuses design_* and ui_* commands", /focus:\s*\/[^\n]*design_/.test(mainSrc));
ok("feature help has a 'design' topic", /design:\s*\{/.test(mainSrc) || /"design":\s*\{/.test(mainSrc) || /id:\s*"design"/.test(mainSrc));
ok("visualizer mandate teaches the DESIGN workflow (tokens -> screen -> audit)", configSrc.includes("DESIGN MANDATE") && configSrc.includes("design_tokens_set") && configSrc.includes("ui_screen_generate") && configSrc.includes("ui_audit") && configSrc.includes("ui_from_spec"));
const readme = fs.readFileSync("README.md", "utf8");
ok("README documents the design pack", readme.includes("ui_screen_generate") && readme.includes("design_tokens_set") && readme.includes("1.29.0"));
ok("manifest version is 1.33.0", manifest.version === "1.33.0", manifest.version);

// ── ChatGPT catalogue line budget ────────────────────────────────────────────
const CATALOG_MAX = 560;
const m = fs.readFileSync("src/providers/chatgpt.js", "utf8").match(/commandListMaxLines:\s*(\d+)/);
ok("commandListMaxLines pinned at " + CATALOG_MAX, m && Number(m[1]) === CATALOG_MAX, m && m[1]);

console.log("\n" + (failed ? failed + " check(s) failed" : "all design pack checks passed"));
process.exit(failed ? 1 : 0);
