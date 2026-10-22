# layout-check — real-browser check for the bar and its trays

Renders the actual ORscript content scripts + `overlay.css` in headless Chrome on a
DeepSeek-shaped page (anchored bar mode) and reports whether the settings tray and
the templates panel open **above** or **below** the bar. Nothing here ships in the
extension; it is a dev tool.

```bash
cd ORscript/tools/layout-check
npm init -y >/dev/null && npm i --no-save @sparticuz/chromium puppeteer-core
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=chat.deepseek.com"
node server.js &                         # https stand-in for chat.deepseek.com
node check.js            # 1280x800 window  → expects ABOVE for both surfaces
node check.js 800 centered  # empty chat, composer centred → expects ABOVE (clamped height)
node check.js 300        # tiny window → expects BELOW (rs-tray-below fallback)
```

The Sparticuz build is a headless shell (no extension loading), so `check.js` injects
the scripts itself with `chrome-shim.js` providing `chrome.storage` / `chrome.runtime`.
If Chrome fails with `libnspr4.so` missing, extract the bundled libs and export
`LD_LIBRARY_PATH=/tmp/al2023/lib` (see `@sparticuz/chromium`'s `al2023.tar.br`).
Screenshots land next to the script (`shot-*.png`, git-ignored).
