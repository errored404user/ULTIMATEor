"use strict";
// 1.82.0 - studio_sfx.js: sound-event definitions with verified assets only (test D of the Phase 115 plan).
// Static checks; tests/sequence-sim.py plays the events inside tests/roblox_sim.py.
const fs = require("fs"), vm = require("vm");
global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? " - " + detail : "")); } }

const src = fs.readFileSync("src/core/skills/studio_sfx.js", "utf8");
ok("pack registered in every isolated-world list + codecraft.html", manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js")).every((c) => c.js.includes("src/core/skills/studio_sfx.js")) && /studio_sfx\.js/.test(fs.readFileSync("codecraft.html", "utf8")));
ok("version pinned", S.SFX_VERSION === "1.99.2" && /TotalSFX/.test(S.SFX_RUNTIME_SRC));
ok("commands: install / define / play / validate visible, list hidden", ["sfx_library_install", "sfx_event_define", "sfx_event_play", "sfx_validate"].every((n) => S.SKILL_COMMANDS.some((c) => c.name === n && !c.hidden)) && S.SKILL_COMMANDS.some((c) => c.name === "sfx_events_list" && c.hidden));

// Catalogue: engine-bundled files or explicitly missing - never invented ids.
const cat = S.SFX_CATALOGUE, names = Object.keys(cat);
ok("catalogue covers combat, movement, ability, UI and ambience events (" + names.length + ")", names.length >= 30 && ["impact", "hit", "swing", "swing_heavy", "whoosh", "explosion", "footstep", "jump", "land", "death", "ui_click", "ui_confirm", "ui_toggle", "ui_error", "charge", "release", "heal", "shield", "teleport", "music", "ambience"].every((n) => cat[n]));
const bundled = names.filter((n) => cat[n].ids.length), missing = names.filter((n) => !cat[n].ids.length);
ok("every bundled id is an engine rbxasset://sounds/ file (no rbxassetid numbers)", bundled.every((n) => cat[n].ids.every((id) => /^rbxasset:\/\/sounds\/[\w .-]+\.(ogg|wav|mp3)$/.test(id))), JSON.stringify(bundled.map((n) => cat[n].ids).flat().filter((id) => !/^rbxasset:\/\/sounds\//.test(id))));
ok("events without a bundled file are marked missing with a diagnostic, not faked (" + missing.join(", ") + ")", missing.length >= 4 && missing.every((n) => typeof cat[n].missing === "string" && cat[n].missing.length > 10));
ok("every event defines mix fields: volume, pitch range, spatial flag (+ roll-off when 3D), group, cooldown", names.every((n) => { const e = cat[n]; return typeof e.volume === "number" && Array.isArray(e.pitch) && e.pitch.length === 2 && typeof e.spatial === "boolean" && (!e.spatial || (typeof e.min === "number" && typeof e.max === "number" && e.min < e.max)) && typeof e.group === "string" && typeof e.cooldown === "number"; }));
ok("UI events are 2D, world events are spatial", names.filter((n) => /^ui_/.test(n)).every((n) => cat[n].spatial === false) && ["impact", "explosion", "footstep"].every((n) => cat[n].spatial === true));
ok("groups are Master-routed buses SFX / UI / Music / Ambience", names.every((n) => ["SFX", "UI", "Music", "Ambience"].includes(cat[n].group)) && /Master/.test(S.SFX_RUNTIME_SRC) && S.SFX_EVENT_NAMES.length === names.length);
ok("no hard-coded rbxassetid numbers anywhere in the pack source", (src.match(/rbxassetid:\/\/\d{5,}/g) || []).length === 0, (src.match(/rbxassetid:\/\/\d{5,}/g) || []).join(","));

// Runtime API.
const rt = S.SFX_RUNTIME_SRC;
ok("runtime: play/get/stop/stopAll/events/preload/groups/setGroupVolume", ["play", "get", "stop", "stopAll", "events", "preload", "groups", "setGroupVolume"].every((k) => rt.includes("function M." + k)));
ok("runtime: play returns nil + reason for missing events instead of a silent Sound", /return nil, *['"]missing/.test(rt) || /nil, 'missing'/.test(rt) || /missing/.test(rt) && /return nil/.test(rt));
ok("runtime: one-shots are cleaned up (Debris / Ended) and loops are returned for the caller to stop", /Debris/.test(rt) && /Looped/.test(rt));
ok("runtime: cooldown + pitch variation + RollOff distances applied", /cooldown/.test(rt) && /PlaybackSpeed/.test(rt) && /RollOffMinDistance/.test(rt) && /RollOffMaxDistance/.test(rt));
ok("runtime: event table is read from the EventsJSON attribute so redefinitions apply without re-require", /EventsJSON/.test(rt) && /JSONDecode/.test(rt));
ok("no Luau-only syntax", !/\+=|-=|\.\.=|\bcontinue\b/.test(rt));

// Define: verification before acceptance.
const def = S.buildLuau("sfx_event_define", { name: "Heal", sound_ids: ["rbxassetid://123456", "777", "404"], volume: 0.6, spatial: true });
ok("sfx_event_define builds and verifies through MarketplaceService:GetProductInfo (AssetTypeId 3) + ContentProvider:PreloadAsync", def.code && /GetProductInfo/.test(def.code) && /AssetTypeId/.test(def.code) && /PreloadAsync/.test(def.code));
ok("sfx_event_define rejects a definition with zero verified ids (fail, not a half-saved event)", /fail\(/.test(def.code) && /verified/.test(def.code));
const none = S.buildLuau("sfx_event_define", { name: "Heal" });
ok("sfx_event_define without ids fails before Studio", !!none.err || /fail\(/.test(none.code));
const play = S.buildLuau("sfx_event_play", { event: "impact", at: "Workspace.Part" });
ok("sfx_event_play builds and reports the reason when an event has no asset", play.code && /missing|no verified asset|reason/.test(play.code));
const val = S.buildLuau("sfx_validate", {});
ok("sfx_validate builds and checks each id with the content provider", val.code && /PreloadAsync/.test(val.code));
ok("legacy sound_library / jingle presets in studio_200 no longer point at invented 18378750* ids", !/18378750\d/.test(fs.readFileSync("src/core/skills/studio_200.js", "utf8").replace(/\/\/.*$/gm, "").replace(/migrat[^\n]*/g, "")));

console.log(fail ? "FAIL  test-sfx-events: " + pass + " passed, " + fail + " failed" : "OK    test-sfx-events: " + pass + " passed");
process.exit(fail ? 1 : 0);
