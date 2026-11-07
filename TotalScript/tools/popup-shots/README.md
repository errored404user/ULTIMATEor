# popup-shots — headless screenshots of the extension popup

Dev tool only (nothing here ships in the extension's runtime path).

```
cd TotalScript/tools/popup-shots
npm i --no-save @sparticuz/chromium puppeteer-core      # once
node shoot.js [outDir]                                 # default: ../../ui/snapshots
```

* `chrome-shim.js` — a fake `chrome.*` (runtime / storage / tabs) driven by
  `window.__SHOT = { status, tabs, storage, activity, tools, version }`; every
  message the popup sends is recorded in `window.__shotCalls`. The same shim
  backs `tests/test-extension-ui.js` in jsdom.
* `scenarios.js` — the rendered states (offline, connected, Activity, Error
  Viewer, Tools, Settings, search, Support, palette, light + violet, compact +
  large text, shortcuts).
* `shoot.js` — renders each scenario at 420 × 600 (full-page where noted),
  audits horizontal overflow / clipped text, and writes PNGs + `report.txt`.

On Debian-family sandboxes `@sparticuz/chromium` needs its bundled NSS libs on
`LD_LIBRARY_PATH` (extract `bin/al2023.tar.br`); on a normal desktop it just runs.
