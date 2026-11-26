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

## tray-wrap.js — on-page settings tray rows (2.12.1)

```
node tray-wrap.js [overlay.css] [older-overlay.css]
```

Renders the tray's real row markup (`.rs-tip-opt`, `.rs-tgl-row`,
`.rs-site-opt`, `.rs-mcp-item`, `.rs-sec-label`) with `overlay.css` at tray
width for the base / night / void themes and counts the line boxes of every
label. A label with more lines than words is being squeezed letter-by-letter
(the 2.12.0 regression: `overflow-wrap: anywhere` on a flex item collapses its
minimum width to one glyph). Exit code 1 on any squeezed label; PNGs land in
`/tmp/tray-*.png` (`ui/snapshots/tray-rows-*.png` are the 2.13.0 results).
