# provider-lab — headless end-to-end run of the Notion AI adapter

Loads the real TotalScript content scripts (`overlay.css`, `src/providers/notion.js`,
`src/core/main.js`) in headless Chrome on a **Notion-shaped stand-in page** and
drives a complete agent round trip against a fake Studio bridge:

1. bar renders in the provider-reserved strip above the composer (`RS Connected`)
2. **Start Agent** types the plain-text preferences message and sends it with Notion's send control
3. the fake AI answers with a ```` ```json {"command":"list_commands"} ```` block → TotalScript runs it and
   attaches the catalogue as an `totalscript_tool_result_*.txt` file (too long to paste)
4. the AI says `TotalScript is ready.` → session becomes **Agent running**
5. a user message typed in Notion's own composer + a `run_code` reply → executed on the fake bridge,
   `Output of 'run_code': …` sent back

Nothing here ships in the extension. `fake-notion.html` mimics the DOM the adapter keys on
(`[data-agent-service-scroll-anchor]` rows with `justify-content` flex-end/flex-start,
a `contenteditable[role=textbox]` composer, `[data-testid=agent-send-message-button]`, file drop
→ attachment chip). `studio-shim.js` fakes `chrome.*` and a bridge with three tools.

```bash
cd TotalScript/tools/provider-lab
npm init -y >/dev/null && npm i --no-save @sparticuz/chromium puppeteer-core
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=www.notion.so"
node server.js &                 # https stand-in for www.notion.so (maps via --host-resolver-rules)
node notion-roundtrip.js         # ~90 s; prints each stage, ends with PROTOCOL_OK true
```

If Chrome fails with `libnspr4.so` missing, extract `@sparticuz/chromium`'s `al2023.tar.br`
and export `LD_LIBRARY_PATH=/tmp/al2023/lib`. Screenshots land next to the script (git-ignored).
Stage timings are governed by the adapter's conservative `timings` (GEN_IDLE 9 s, STABLE 15 s),
so the catalogue step takes ~25 s.
