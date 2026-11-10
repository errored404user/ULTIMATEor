// SPDX-License-Identifier: GPL-3.0-or-later
// updater.js - 2.17.0 auto-updater: the pure part shared by the service worker
// (background.js, importScripts) and the popup (popup.html <script>), and run
// as-is by tests/test-updater.js in node.
//
// How an update works (see README "Updates"):
//   * Releases live on GitHub Releases of errored404user/ULTIMATEor. A tag
//     vX.Y.Z makes .github/workflows/release.yml build total-core for Windows
//     and macOS, pack TotalScript.zip + TotalScript-extension.tar, and publish
//     them with latest.json (version, assets, sha256) and SHA256SUMS.txt.
//   * The desktop app (total-core) checks latest.json once a day (Settings →
//     Updates, opt-out) and the extension asks the app (POST /api/update/check)
//     - or, when the app is not running, reads the same latest.json itself.
//   * Nothing installs by itself: the popup shows "2.20.0 available" with
//     Update / Later / Skip. Update asks the APP to do the work (POST
//     /api/update/apply): it downloads the tar, verifies the sha256, stages it,
//     copies the files over the unpacked extension folder, then replaces its
//     own binary and relaunches; the extension reloads itself once the app
//     reports the extension files are in place. Chrome cannot rewrite the files
//     of a "Load unpacked" extension, so without the app the popup can only
//     offer the download + the three manual steps.
//
// Pure JS: no DOM, no chrome.*, no fetch. Everything that touches the network
// or storage lives in background.js / popup.js and passes plain data in here.
const TotalUpdater = (() => {
  "use strict";
  const VERSION = "2.20.0";
  const REPO = "errored404user/ULTIMATEor";
  const RELEASES_URL = `https://github.com/${REPO}/releases`;
  // "latest/download/<asset>" redirects to the newest release's asset - no API,
  // no rate limit, cacheable.
  const LATEST_JSON_URL = `${RELEASES_URL}/latest/download/latest.json`;
  const EXTENSION_ASSET = "TotalScript-extension.tar";
  const ZIP_ASSET = "TotalScript.zip";
  const STORAGE_KEY = "tsUpdate";          // chrome.storage.local: last check + skip + apply state
  const PREF_KEY = "rsUpdateCheck";        // chrome.storage.local: daily check on/off (default on)
  const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
  const ALARM = "total-update";
  const ALARM_MINUTES = 360;               // the alarm only *considers* a check; CHECK_EVERY_MS decides
  const APP_STATUS = "/api/update/status";
  const APP_CHECK = "/api/update/check";
  const APP_APPLY = "/api/update/apply";
  const APP_FOLDER = "/api/update/extension-folder";
  const COMPONENTS = Object.freeze(["extension", "app"]);
  const PHASES = Object.freeze(["idle", "downloading", "verifying", "staging", "applying", "restarting", "done", "failed"]);

  // "v2.20.0" / "2.20.0" / "2.20.0-beta.1" → [2, 18, 0] (pre-release suffix ignored, but see isPrerelease)
  function parseVersion(v) {
    const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? "" : v));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function isPrerelease(v) { return /^\s*v?\d+\.\d+\.\d+-/.test(String(v || "")); }
  // -1 / 0 / 1 like a comparator; null when either side is not a version.
  function compareVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
    // a release beats its own pre-release
    const ra = isPrerelease(a), rb = isPrerelease(b);
    if (ra !== rb) return ra ? -1 : 1;
    return 0;
  }
  function isNewer(latest, current) { return compareVersions(latest, current) === 1; }

  // latest.json as published by release.yml. Tolerant: unknown keys ignored,
  // missing assets → empty list; returns null when there is no usable version.
  function parseLatest(json) {
    let o = json;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
    if (!o || typeof o !== "object") return null;
    const version = String(o.version || "").replace(/^v/, "").trim();
    if (!parseVersion(version)) return null;
    const assets = Array.isArray(o.assets) ? o.assets.filter((a) => a && typeof a === "object" && typeof a.name === "string").map((a) => ({
      name: a.name,
      size: Number.isFinite(Number(a.size)) ? Number(a.size) : 0,
      sha256: typeof a.sha256 === "string" && /^[0-9a-f]{64}$/i.test(a.sha256) ? a.sha256.toLowerCase() : "",
      url: typeof a.url === "string" && /^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(a.url) ? a.url : "",
    })) : [];
    return {
      version,
      tag: typeof o.tag === "string" && o.tag ? o.tag : "v" + version,
      publishedAt: typeof o.published_at === "string" ? o.published_at : (typeof o.publishedAt === "string" ? o.publishedAt : ""),
      notesUrl: typeof o.notes_url === "string" && /^https:\/\/github\.com\//.test(o.notes_url) ? o.notes_url : `${RELEASES_URL}/tag/v${version}`,
      notes: typeof o.notes === "string" ? o.notes.slice(0, 2000) : "",
      assets,
    };
  }
  const assetNamed = (latest, name) => (latest && latest.assets || []).find((a) => a.name === name) || null;
  function downloadUrl(latest, name) {
    const a = assetNamed(latest, name);
    if (a && a.url) return a.url;
    return latest ? `${RELEASES_URL}/download/${latest.tag}/${name}` : `${RELEASES_URL}/latest`;
  }

  // Given what we know, what should the UI say / offer? One function so the
  // Home card, the Settings row and the bar agree.
  //   state: { current, latest|null, checkedAt, error, skipped, appOnline, job|null, applying }
  function decide(state) {
    const s = state || {};
    const current = String(s.current || "0.0.0");
    const latest = s.latest || null;
    const job = s.job && typeof s.job === "object" ? s.job : null;
    const out = { kind: "current", current, latest: latest ? latest.version : "", title: "", sub: "", actions: [], notesUrl: latest ? latest.notesUrl : RELEASES_URL };
    if (job && job.phase && job.phase !== "idle") {
      if (job.phase === "done") {
        const ext = (job.finished || []).includes("extension");
        out.kind = "done"; out.title = `Updated to ${job.version || out.latest || "the new version"}`;
        out.sub = ext ? "The extension files are in place - reload the extension to run them." : (job.message || "Finished.");
        out.actions = ext ? ["reload"] : ["dismiss"];
        return out;
      }
      if (job.phase === "failed") {
        out.kind = "failed"; out.title = "Update failed"; out.sub = String(job.error || job.message || "unknown error").slice(0, 300);
        out.actions = ["retry", "download", "dismiss"];
        return out;
      }
      out.kind = "running"; out.title = `Updating ${job.component || ""}…`.replace("  ", " ");
      const pct = job.total > 0 ? Math.min(100, Math.round(job.received * 100 / job.total)) : null;
      out.sub = (job.message || job.phase) + (job.phase === "downloading" && pct != null ? ` ${pct}%` : "");
      out.progress = pct;
      out.actions = [];
      return out;
    }
    if (!latest) {
      out.kind = s.error ? "error" : (s.checkedAt ? "current" : "unchecked");
      out.title = s.error ? "Could not check for updates" : (s.checkedAt ? `TotalScript ${current} is up to date` : `TotalScript ${current}`);
      out.sub = s.error ? String(s.error).slice(0, 200) : (s.checkedAt ? "" : "Not checked yet.");
      out.actions = ["check"];
      return out;
    }
    const cmp = compareVersions(latest.version, current);
    if (cmp !== 1) {
      out.kind = "current"; out.title = `TotalScript ${current} is up to date`;
      out.sub = cmp === -1 ? `Newer than the latest release (${latest.version}) - a development build.` : "";
      out.actions = ["check"];
      return out;
    }
    if (s.skipped && compareVersions(s.skipped, latest.version) === 0) {
      out.kind = "skipped"; out.title = `${latest.version} skipped`; out.sub = "You chose to skip this version. The next one will show again.";
      out.actions = ["unskip", "check"];
      return out;
    }
    out.kind = "available"; out.title = `TotalScript ${latest.version} is available`;
    if (s.appOnline === false) {
      out.sub = "The desktop app is not running, so nothing can be installed automatically. Start total-core and come back, or download the zip and replace the folder yourself.";
      out.actions = ["download", "notes", "later", "skip"];
    } else if (s.appOnline && s.extensionDir === null) {
      out.sub = "The desktop app does not know where the extension folder is - set it in the app (Settings → Updates), then press Update.";
      out.actions = ["download", "notes", "later", "skip"];
    } else {
      out.sub = "Update installs the new files into the extension folder, replaces the desktop app and relaunches it. Nothing is sent anywhere; the download comes from GitHub Releases.";
      out.actions = ["update", "notes", "later", "skip"];
    }
    return out;
  }

  // The three manual steps for the no-app path (also printed in the popup).
  const MANUAL_STEPS = Object.freeze([
    `Download ${ZIP_ASSET} from the release page and unzip it.`,
    "Replace the contents of your TotalScript folder (the one you loaded unpacked) with the new ones. Keep the folder path the same.",
    "chrome://extensions → TotalScript → Reload. Then start the new bin/total-core and restart Roblox Studio once for the plugin.",
  ]);

  function ago(ms, now) {
    const d = Math.max(0, (now == null ? Date.now() : now) - Number(ms || 0));
    if (!ms) return "never";
    if (d < 90e3) return "just now";
    if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
    if (d < 48 * 3600e3) return `${Math.round(d / 3600e3)} h ago`;
    return `${Math.round(d / 86400e3)} days ago`;
  }

  // Normalise what the app's GET /api/update/status returns (Rust side) into
  // the fields decide() reads. Unknown → null.
  function fromAppStatus(json) {
    if (!json || typeof json !== "object" || json.ok === false) return null;
    const check = json.check && typeof json.check === "object" ? json.check : {};
    const job = json.job && typeof json.job === "object" ? json.job : null;
    const latest = check.latest ? parseLatest(check.latest) : null;
    const ext = json.extension && typeof json.extension === "object" ? json.extension : {};
    return {
      appVersion: typeof json.app_version === "string" ? json.app_version : "",
      latest,
      checkedAt: check.at ? Number(check.at) * (Number(check.at) < 1e12 ? 1000 : 1) : 0,
      error: check.error ? String(check.error) : "",
      extensionDir: typeof ext.path === "string" && ext.path ? ext.path : null,
      extensionDetected: typeof ext.detected === "string" ? ext.detected : "",
      job: job && typeof job.phase === "string" ? {
        phase: PHASES.includes(job.phase) ? job.phase : "idle",
        component: String(job.component || ""),
        message: String(job.message || ""),
        error: job.error ? String(job.error) : "",
        received: Number(job.received) || 0,
        total: Number(job.total) || 0,
        version: String(job.version || ""),
        finished: Array.isArray(job.finished) ? job.finished.map(String) : [],
        pending: Array.isArray(job.pending) ? job.pending.map(String) : [],
      } : null,
    };
  }

  return Object.freeze({
    VERSION, REPO, RELEASES_URL, LATEST_JSON_URL, EXTENSION_ASSET, ZIP_ASSET, STORAGE_KEY, PREF_KEY, CHECK_EVERY_MS, ALARM, ALARM_MINUTES,
    APP_STATUS, APP_CHECK, APP_APPLY, APP_FOLDER, COMPONENTS, PHASES, MANUAL_STEPS,
    parseVersion, isPrerelease, compareVersions, isNewer, parseLatest, assetNamed, downloadUrl, decide, ago, fromAppStatus,
  });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalUpdater; } catch {}
try { if (typeof self !== "undefined") self.TotalUpdater = TotalUpdater; } catch {}
