"use strict";
// 2.17.0 — AUTO-UPDATER: GitHub Releases → desktop app installs → extension reloads.
//
// Part 1 (real code): src/core/updater.js evaluated directly — version
//        comparison, latest.json parsing (hash / url hygiene), the single
//        decide() state machine every surface draws, the app-status mapping.
// Part 2 (static pins): background.js (daily alarm, update_* messages, the
//        reload only after the user's click), popup (card + Settings row,
//        script order), manifest (no new permissions), the Rust updater
//        (module, routes, hand-rolled sha256 + ustar, no new crates), the
//        release workflow (tag trigger, version gate, ustar, latest.json) and
//        the README.
// OFFLINE / SIMULATED: GitHub is never contacted. From the TotalScript root:
//   node tests/test-updater.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + String(extra).slice(0, 300) : "")); } }

const U = require(path.join(root, "src/core/updater.js"));
const manifest = JSON.parse(read("manifest.json"));

// ── Part 1: pure helpers ────────────────────────────────────────────────────
ok("A1 VERSION matches manifest.json (release.yml gates tag == manifest == Cargo == updater.js)", U.VERSION === manifest.version, `${U.VERSION} vs ${manifest.version}`);
ok("A2 parseVersion: v-prefix, prerelease, garbage", JSON.stringify(U.parseVersion("v2.17.0")) === JSON.stringify([2, 17, 0]) && JSON.stringify(U.parseVersion("2.17.0-beta.1")) === JSON.stringify([2, 17, 0]) && U.parseVersion("nope") === null && U.parseVersion("") === null);
ok("A3 compareVersions is numeric (2.100 > 2.99) and a prerelease ranks below its release", U.compareVersions("2.100.0", "2.99.9") === 1 && U.compareVersions("2.16.1", "2.16.1") === 0 && U.compareVersions("2.17.0-beta", "2.17.0") === -1 && U.compareVersions("2.16.0", "2.16.1") === -1);
ok("A4 isNewer: strictly newer only; unparsable never 'newer'", U.isNewer("2.17.0", "2.16.1") && !U.isNewer("2.16.1", "2.16.1") && !U.isNewer("garbage", "2.16.1") && !U.isNewer("2.17.0", "garbage"));

const sampleLatest = {
  version: "v2.17.0", tag: "v2.17.0", published_at: "2026-11-09T12:00:00Z",
  notes_url: "https://github.com/errored404user/ULTIMATEor/releases/tag/v2.17.0",
  assets: [
    { name: "TotalScript-extension.tar", size: 30000000, sha256: "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789", url: "https://github.com/errored404user/ULTIMATEor/releases/download/v2.17.0/TotalScript-extension.tar" },
    { name: "TotalScript.zip", size: 20000000, sha256: "short", url: "https://evil.example.com/TotalScript.zip" },
    { name: "total-core-windows-x64.exe", size: 9000000, sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", url: "https://objects.githubusercontent.com/x/y" },
    "not an object", { nope: true },
  ],
};
const L = U.parseLatest(JSON.stringify(sampleLatest));
ok("B1 parseLatest accepts a JSON string or object and strips the v", L && L.version === "2.17.0" && U.parseLatest(sampleLatest).version === "2.17.0");
ok("B2 parseLatest keeps only well-formed assets, lower-cases the hash, drops a bad hash", L.assets.length === 3 && U.assetNamed(L, "TotalScript-extension.tar").sha256 === "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" && U.assetNamed(L, "TotalScript.zip").sha256 === "");
ok("B3 parseLatest refuses non-GitHub download URLs (falls back to the release URL)", U.assetNamed(L, "TotalScript.zip").url === "" && U.downloadUrl(L, "TotalScript.zip") === "https://github.com/errored404user/ULTIMATEor/releases/download/v2.17.0/TotalScript.zip" && U.assetNamed(L, "total-core-windows-x64.exe").url.startsWith("https://objects.githubusercontent.com/"));
ok("B4 parseLatest → null on garbage / missing version", U.parseLatest("not json") === null && U.parseLatest({}) === null && U.parseLatest({ version: "x" }) === null && U.parseLatest(null) === null);
ok("B5 notes_url must be github.com or it is replaced by the tag page", U.parseLatest({ version: "2.17.0", notes_url: "https://phish.example/x" }).notesUrl === "https://github.com/errored404user/ULTIMATEor/releases/tag/v2.17.0");
ok("B6 LATEST_JSON_URL is the stable 'latest' download link (no API token, no rate-limited endpoint)", U.LATEST_JSON_URL === "https://github.com/errored404user/ULTIMATEor/releases/latest/download/latest.json" && U.REPO === "errored404user/ULTIMATEor");

// decide(): every state the UI can be in
const cur = "2.16.1";
const d = (s) => U.decide(Object.assign({ current: cur }, s));
ok("C1 unchecked → 'Not checked yet' + check", d({}).kind === "unchecked" && d({}).actions.join() === "check");
ok("C2 checked, no newer → current (no install button)", d({ latest: U.parseLatest({ version: cur }), checkedAt: 1 }).kind === "current" && !d({ latest: U.parseLatest({ version: cur }), checkedAt: 1 }).actions.includes("update"));
ok("C3 dev build newer than the release → current, explained", d({ latest: U.parseLatest({ version: "2.0.0" }), checkedAt: 1 }).sub.includes("development build"));
ok("C4 error with no latest → error + check", d({ error: "GitHub unreachable", checkedAt: 1 }).kind === "error" && d({ error: "GitHub unreachable", checkedAt: 1 }).actions.join() === "check");
const avail = d({ latest: L, checkedAt: 1, appOnline: true, extensionDir: "C:/TotalScript" });
ok("C5 available + app online + folder known → Update / notes / later / skip (install needs the click)", avail.kind === "available" && avail.actions.join() === "update,notes,later,skip" && avail.notesUrl === L.notesUrl);
const offline = d({ latest: L, checkedAt: 1, appOnline: false });
ok("C6 available + app offline → manual fallback (download / notes / later / skip), never 'update'", offline.kind === "available" && offline.actions.join() === "download,notes,later,skip" && /not running/.test(offline.sub));
const nofolder = d({ latest: L, checkedAt: 1, appOnline: true, extensionDir: null });
ok("C7 available + app online but folder unknown → download path and a pointer to Settings → Updates", nofolder.actions.join() === "download,notes,later,skip" && /Settings/.test(nofolder.sub));
ok("C8 skipped version stays quiet (unskip / check) and a NEWER one shows again", d({ latest: L, checkedAt: 1, skipped: "2.17.0", appOnline: true, extensionDir: "x" }).kind === "skipped" && d({ latest: U.parseLatest({ version: "2.20.0" }), checkedAt: 1, skipped: "2.17.0", appOnline: true, extensionDir: "x" }).kind === "available");
const running = d({ latest: L, job: { phase: "downloading", component: "extension", message: "Downloading TotalScript-extension.tar", received: 15000000, total: 30000000, version: "2.17.0", finished: [], pending: ["app"] } });
ok("C9 running job → progress %, no actions", running.kind === "running" && running.progress === 50 && /50%/.test(running.sub) && running.actions.length === 0);
const doneExt = d({ latest: L, job: { phase: "done", version: "2.17.0", finished: ["extension"], pending: [] } });
ok("C10 done with the extension written → the only action is Reload (the user presses it)", doneExt.kind === "done" && doneExt.actions.join() === "reload");
const failed = d({ latest: L, job: { phase: "failed", error: "sha256 mismatch (expected ab…, got cd…)", version: "2.17.0", finished: [], pending: [] } });
ok("C11 failed job → retry / download / dismiss with the error text", failed.kind === "failed" && failed.actions.join() === "retry,download,dismiss" && /sha256 mismatch/.test(failed.sub));
ok("C12 MANUAL_STEPS: zip, replace folder, reload — the no-app path is spelled out", U.MANUAL_STEPS.length >= 3 && /TotalScript\.zip/.test(U.MANUAL_STEPS[0]) && /reload/i.test(U.MANUAL_STEPS.join(" ")));
ok("C13 ago(): never / just now / minutes / hours", U.ago(0) === "never" && U.ago(Date.now() - 1000) === "just now" && /min/.test(U.ago(Date.now() - 10 * 60e3)) && /h/.test(U.ago(Date.now() - 5 * 3600e3)));

// fromAppStatus(): what GET /api/update/status returns (mirrors update.rs snapshot())
const appJson = { ok: true, app_version: "2.16.1", daily: true, check: { at: 1762689600, latest: { version: "2.17.0", assets: [] }, error: null }, extension: { path: "C:/TotalScript", detected: "exe-tree", manifest_version: "2.16.1" }, job: { phase: "verifying", component: "app", version: "2.17.0", message: "Verifying", error: null, received: 10, total: 10, started: 1, finished: ["extension"], pending: [] } };
const A = U.fromAppStatus(appJson);
ok("D1 fromAppStatus maps app_version / latest / seconds→ms / folder / job", A && A.appVersion === "2.16.1" && A.latest.version === "2.17.0" && A.checkedAt === 1762689600000 && A.extensionDir === "C:/TotalScript" && A.extensionDetected === "exe-tree" && A.job.phase === "verifying" && A.job.finished.join() === "extension");
ok("D2 fromAppStatus: unknown phase → idle, ok:false → null, no job → null job", U.fromAppStatus(Object.assign({}, appJson, { job: { phase: "weird" } })).job.phase === "idle" && U.fromAppStatus({ ok: false }) === null && U.fromAppStatus({ ok: true, check: {} }).job === null);
ok("D3 PHASES / COMPONENTS are the Rust enum values (serde lowercase) and the two components", U.PHASES.join() === "idle,downloading,verifying,staging,applying,restarting,done,failed" && U.COMPONENTS.join() === "extension,app");

// ── Part 2: static pins ─────────────────────────────────────────────────────
const bg = read("background.js"), popupJs = read("popup.js"), popupHtml = read("popup.html"), popupCss = read("ui/popup.css");
ok("E1 background imports src/core/updater.js and pulls CURRENT_VERSION from the manifest", /importScripts\("src\/core\/updater\.js"\)/.test(bg) && /CURRENT_VERSION = \(\(\) => \{ try \{ return chrome\.runtime\.getManifest\(\)\.version/.test(bg));
ok("E2 daily check: chrome.alarms 'total-update' + a 24 h TTL (no polling loop)", /chrome\.alarms\.create\(UPD\.ALARM/.test(bg) && /a\.name === UPD\.ALARM/.test(bg) && U.CHECK_EVERY_MS === 24 * 3600e3 && U.ALARM_MINUTES >= 60);
ok("E3 opt-out: rsUpdateCheck false stops the scheduled check (manual Check now still works)", U.PREF_KEY === "rsUpdateCheck" && /o\[UPD\.PREF_KEY\] !== false/.test(bg) && /if \(!\(await updEnabled\(\)\)\) return;/.test(bg) && /case "update_check"/.test(bg));
for (const m of ["update_status", "update_check", "update_set_enabled", "update_skip", "update_apply", "update_set_folder", "update_reload"]) ok(`E4 background handles ${m}`, new RegExp(`case "${m}":`).test(bg));
ok("E5 the app is asked first (POST /api/update/check); GitHub latest.json only when the app is offline", bg.indexOf("appFetch(UPD.APP_CHECK") < bg.indexOf("fetch(UPD.LATEST_JSON_URL") && /if \(!latest && !\(viaApp\.ok && viaApp\.json\)\)/.test(bg));
ok("E6 chrome.runtime.reload() happens ONLY in update_reload (after the user's click), never from the alarm/check path", (bg.match(/chrome\.runtime\.reload\(\)/g) || []).length === 1 && /case "update_reload":[\s\S]{0,600}chrome\.runtime\.reload\(\)/.test(bg));
ok("E7 update_apply only forwards to the app (POST /api/update/apply) — the worker writes no files", /case "update_apply":[\s\S]{0,900}appFetch\(UPD\.APP_APPLY, \{ method: "POST"/.test(bg) && !/chrome\.downloads/.test(bg));
ok("E8 a new version is announced once per version (Activity 'update' + NEW badge), cleared on install", /state\.announced !== state\.latest\.version/.test(bg) && /updBadge\(newer && !skipped\)/.test(bg) && /setBadgeText/.test(bg) && /details\.reason !== "update"/.test(bg) && /TotalScript updated to \$\{CURRENT_VERSION\}/.test(bg));
ok("E9 app fetches stay on the local bridge (127.0.0.1:3000) with a timeout; the GitHub fetch has an AbortController", /RUST_ROBLOX_HTTP\}\$\{path\}/.test(bg) && /AbortController/.test(bg));
ok("F1 popup.html loads src/core/updater.js before popup.js and has the hidden #update-card", popupHtml.indexOf('src="src/core/updater.js"') < popupHtml.indexOf('src="popup.js"') && /id="update-card" hidden/.test(popupHtml) && /id="update-actions"/.test(popupHtml) && /id="update-bar"/.test(popupHtml));
ok("F2 popup renders every decide() action through one label map (no orphan action id)", ["update", "retry", "reload", "check", "later", "dismiss", "skip", "unskip", "notes", "download"].every((a) => new RegExp(`${a}: \\["`).test(popupJs)) && ["update", "retry", "reload", "check", "later", "dismiss", "skip", "unskip", "notes", "download"].every((a) => new RegExp(`case "${a}":`).test(popupJs)));
ok("F3 popup: Update asks for confirmation first; Reload goes through update_reload; polling only while a job runs", /confirmDialog\(`Update to \$\{latestV\}\?`/.test(popupJs) && /bg\(\{ type: "update_reload" \}\)/.test(popupJs) && /if \(d\.kind === "running"\) updStartPolling\(\); else updStopPolling\(\)/.test(popupJs) && /clearInterval\(updPoll\)/.test(popupJs));
ok("F4 popup Settings → Support & about has the Updates row (Check now, folder) and the daily toggle on rsUpdateCheck", /id: "updates", type: "updates"/.test(popupJs) && /key: "rsUpdateCheck", type: "toggle", default: true/.test(popupJs) && /case "updates":/.test(popupJs) && /update_set_folder/.test(popupJs) && /RS_KEYS_ALL = \["rsUpdateCheck"/.test(popupJs));
ok("F5 popup card is hidden unless available / running / done / failed (no nag when current)", /\["available", "running", "done", "failed"\]\.includes\(d\.kind\)/.test(popupJs));
ok("F6 progress bar respects reduced motion", /prefers-reduced-motion: reduce\) \{ \.upd-bar\[data-indeterminate\] > i \{ animation: none/.test(popupCss) && /html\[data-motion="off"\] \.upd-bar/.test(popupCss));
ok("G1 manifest: no new permissions for the updater (alarms + storage already there, no 'downloads', no 'management')", manifest.permissions.includes("alarms") && manifest.permissions.includes("storage") && !manifest.permissions.includes("downloads") && !manifest.permissions.includes("management"));

// Rust side
const rs = read("agent/src/update.rs"), mainRs = read("agent/src/main.rs"), guiRs = read("agent/src/gui.rs"), prefsRs = read("agent/src/gui/prefs.rs"), cargo = read("agent/Cargo.toml");
ok("H1 update.rs: module wired (mod update) and the four routes", /^mod update;/m.test(mainRs) && ["/api/update/status", "/api/update/check", "/api/update/apply", "/api/update/extension-folder"].every((r) => mainRs.includes(`"${r}"`)));
ok("H2 update.rs: hand-rolled SHA-256 (FIPS vectors in tests) and ustar reader — no new crates", /pub struct Sha256/.test(rs) && /e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/.test(rs) && /pub fn read_tar/.test(rs) && !/^sha2|^tar |^zip |^self_update/m.test(cargo));
ok("H3 update.rs: sha256 from latest.json is mandatory before anything is installed", /latest\.json carries no sha256 - refusing/.test(rs) && /sha256 mismatch/.test(rs));
ok("H4 update.rs: archive version must equal the release version; zip-slip paths refused", /archive is \{archive_version:\?\} but the release says/.test(rs) && /pub fn safe_relative/.test(rs) && /Component::Normal/.test(rs));
ok("H5 update.rs: never writes agent/target, .git, or the running binary; backs up overwritten files", /SKIP_PREFIXES: &\[&str\] = &\["agent\/target\/", "\.git\/"/.test(rs) && /running_exe/.test(rs) && /std::fs::copy\(&dest, &b\)/.test(rs) && /\.totalscript-updated\.json/.test(rs));
ok("H6 update.rs: self-update = .new → rename exe→.old → relaunch helper (cmd ping / sh sleep) → exit; .old removed at boot", /swap_binary/.test(rs) && /ping -n 3 127\.0\.0\.1/.test(rs) && /sleep 2; exec/.test(rs) && /pub fn cleanup_after_restart/.test(rs) && /update::cleanup_after_restart\(\)/.test(mainRs) && /--updated-from/.test(rs) && /updated_from: Option<String>/.test(mainRs));
ok("H7 main.rs: daily check task (every 30 min, acts once per 24 h, only when Settings allow) and nothing installs without /api/update/apply or the window's button", /hub\.daily\(\) && hub\.needs_daily_check\(\)/.test(mainRs) && /30 \* 60/.test(mainRs) && /fn start_update\(/.test(mainRs) && (mainRs.match(/start_update\(&state/g) || []).length === 2);
ok("H8 apply handler returns 409 when a job is already running; folder handler validates manifest.json and persists", /StatusCode::CONFLICT/.test(mainRs) && /that folder has no TotalScript manifest\.json/.test(mainRs) && /settings\.update_extension_dir = path\.clone\(\)/.test(mainRs));
ok("H9 update.rs unit tests cover sha256 vectors, tar roundtrip + escapes, folder detection, apply skips, swap/restore", ["sha256_matches_the_fips_vectors", "tar_reader_handles_ustar_prefix_dirs_and_longnames", "tar_reader_refuses_escapes_and_truncation", "extension_dir_is_found_from_the_exe_tree_or_the_configured_folder", "apply_entries_writes_backs_up_and_skips_the_build_tree", "apply_entries_never_touches_the_running_binary", "swap_binary_renames_and_restores_on_failure", "hub_snapshot_and_job_defaults"].every((t) => rs.includes(`fn ${t}()`)));
ok("I1 gui.rs: Settings gain update_check_daily (default true) + update_extension_dir; UiCommand UpdateCheck/UpdateApply; About no longer says 'no built-in updater'", /pub update_check_daily: bool/.test(guiRs) && /update_check_daily: true,/.test(guiRs) && /pub update_extension_dir: String/.test(guiRs) && /UpdateCheck \{ force: bool \}/.test(guiRs) && /UpdateApply \{ components: Vec<String> \}/.test(guiRs) && !/this app has no built-in updater/.test(guiRs) && !/No automatic update check/.test(guiRs));
ok("I2 prefs.rs: Updates section (Check now, Update to X, daily toggle, folder) under Settings → About", /pub\(super\) fn updates_section/.test(prefsRs) && /UiCommand::UpdateCheck \{ force: true \}/.test(prefsRs) && /vec!\["extension"\.into\(\), "app"\.into\(\)\]/.test(prefsRs) && /self\.settings\.update_check_daily/.test(prefsRs) && /settings_visible\(SettingsCat::About, "Updates"/.test(guiRs));
ok("I3 snapshot() JSON keys match fromAppStatus (app_version, check.at/latest/error, extension.path/detected, job)", /"app_version": env!\("CARGO_PKG_VERSION"\)/.test(rs) && /"check": \{ "at": c\.at, "latest": c\.latest, "error": c\.error/.test(rs) && /"extension": \{ "path":/.test(rs) && /"job": self\.job\(\)/.test(rs));

// Release workflow + README
const wf = fs.readFileSync(path.join(root, "..", ".github/workflows/release.yml"), "utf8");
ok("J1 release.yml: runs on v* tags (+ manual re-run), builds Windows + macOS arm64, then publishes", /tags: \["v\*"\]/.test(wf) && /workflow_dispatch/.test(wf) && /runs-on: windows-latest/.test(wf) && /runs-on: macos-latest/.test(wf) && /gh release upload "\$TAG"/.test(wf));
ok("J2 release.yml: version gate tag == manifest.json == Cargo.toml == updater.js", /version mismatch: tag \$VER, manifest\.json \$MANIFEST, Cargo\.toml \$CARGO, updater\.js \$UPDJS/.test(wf));
ok("J3 release.yml: plain ustar with the TotalScript/ prefix, fresh binaries in bin/, build tree excluded, verified before upload", /tar --format=ustar/.test(wf) && /stage\/TotalScript\/bin\/total-core\.exe/.test(wf) && /exclude 'agent\/target'/.test(wf) && /grep -qx 'TotalScript\/manifest\.json'/.test(wf));
ok("J4 release.yml: latest.json with version/tag/published_at/notes_url/assets[name,size,sha256,url] + SHA256SUMS.txt; the asset names are the ones the clients look for", /"sha256": hashlib\.sha256\(data\)\.hexdigest\(\)/.test(wf) && /SHA256SUMS\.txt/.test(wf) && wf.includes(U.EXTENSION_ASSET) && wf.includes(U.ZIP_ASSET) && /total-core-windows-x64\.exe/.test(wf) && /total-core-macos-arm64/.test(wf) && /total-core-windows-x64\.exe/.test(rs) && /total-core-macos-arm64/.test(rs));
ok("J5 release.yml: the Windows job runs cargo test (the updater's unit tests gate the release)", /cargo test --release --locked/.test(wf));
const readme = read("README.md");
ok("K1 README documents 2.17.0 Updates (daily check, click to install, skip, opt-out, tag to release)", /\*\*2\.17\.0 — /.test(readme) && /latest\.json/.test(readme) && /Skip this version/.test(readme) && /v2\.17\.0/.test(readme) && /test-updater\.js/.test(readme));

console.log(`\ntest-updater: ${pass} passed, ${fail} failed (static + pure helpers; GitHub never contacted)`);
process.exit(fail ? 1 : 0);
