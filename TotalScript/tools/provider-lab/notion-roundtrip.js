const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("fs"), path = require("path");
const EXT = path.resolve(process.env.EXT || path.join(__dirname, "..", "..")), HOST = "www.notion.so";
(async () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const cs = m.content_scripts.find(c => c.matches.includes("https://www.notion.so/*") && c.world !== "MAIN");
  const exe = await chromium.executablePath();
  const args = chromium.args.concat(["--no-sandbox", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:8443`, "--ignore-certificate-errors"]);
  const browser = await puppeteer.launch({ executablePath: exe, args, headless: true, defaultViewport: { width: 1280, height: 800 } });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("[pageerror]", String(e.message).slice(0, 300)));
  page.on("console", c => { const t = c.text(); if (/TypeError|ReferenceError|notion\.(providerLoaded|tas|send)|start\.|bootstrap|uncaught/i.test(t)) console.log("[console]", t.slice(0, 260)); });
  await page.goto(`https://${HOST}/ai`, { waitUntil: "load" });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "studio-shim.js"), "utf8") });
  for (const css of cs.css || []) await page.addStyleTag({ url: "/__ext/" + css });
  for (const js of cs.js) { try { await page.addScriptTag({ url: "/__ext/" + js }); } catch (e) { console.log("script fail", js, e.message); } }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await page.waitForSelector("#rs-bar", { timeout: 15000 }).catch(() => console.log("NO #rs-bar"));
  await wait(3000);
  const snap = async (label) => {
    const info = await page.evaluate(() => {
      const q = (s) => document.querySelector(s); const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width) }; };
      const bar = q("#rs-bar"), comp = q("#composer"), pill = q("#rs-status-pill"), act = q("#rs-action");
      return { bar: rect(bar), barDisplay: bar && getComputedStyle(bar).display, composer: rect(comp), composerPadTop: comp && getComputedStyle(comp).paddingTop, cls: bar && bar.className, pill: pill && pill.textContent.trim(), action: act && { text: act.textContent.trim(), kind: act.dataset.kind, disabled: act.disabled }, state: (q("#rs-state") || {}).textContent, sent: window.__sent.length, agent: document.documentElement.getAttribute("data-rs-agent") };
    });
    console.log(label, JSON.stringify(info));
    return info;
  };
  const before = await snap("before start:");
  await page.screenshot({ path: path.join(__dirname, "shot-notion-1.png") });
  // Click Start Agent
  await page.evaluate(() => document.querySelector("#rs-action").click());
  await wait(4000);
  const typed = await page.evaluate(() => window.__sent.map(t => t.slice(0, 100)));
  console.log("sent to Notion:", typed.length, JSON.stringify(typed));
  const protoOk = typed.length === 1;
  // Simulate Notion AI answering with the list_commands command block
  await page.evaluate(() => window.__answer('Sure.\n```json\n{"command":"list_commands"}\n```'));
  await wait(6000);
  const probe = await page.evaluate(() => { try { const P = RSProvider; const ra = P.readAssistant(); return { items: P.allItems().length, users: P.userCount(), assistants: P.assistantCount(), gen: P.isGenerating(), hard: P.isHardGenerating(), present: ra.present, reply: (ra.reply || "").slice(0, 80), stop: !!P.isBusyNow(), pending: P.responsePending && P.responsePending() }; } catch (e) { return { err: String(e) }; } });
  console.log("provider probe:", JSON.stringify(probe));
  const until = async (pred, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(pred)) { console.log(label, "after", Date.now() - t0, "ms"); return true; } await wait(500); } console.log(label, "TIMEOUT"); return false; };
  await until(() => window.__sent.length >= 2, 40000, "catalogue result sent");
  const afterReply = await page.evaluate(() => window.__sent.map(t => t.slice(0, 120)));
  console.log("after reply, sent:", afterReply.length, JSON.stringify(afterReply.slice(1)));
  await page.screenshot({ path: path.join(__dirname, "shot-notion-2.png") });
  await snap("after catalogue:");
  // Model acknowledges, session becomes Ready
  await page.evaluate(() => window.__answer("TotalScript is ready."));
  await until(() => document.documentElement.getAttribute("data-rs-agent") === "on", 40000, "session READY");
  await snap("ready:");
  // User asks for work in Notion's own composer; model answers with a command
  await page.evaluate(() => { const ed = document.getElementById("editor"); ed.focus(); ed.textContent = "make a red part"; ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await wait(1500);
  await page.evaluate(() => window.__answer('Creating it now.\n```json\n{"command":"run_code","command_text":"Instance.new(\'Part\', workspace)"}\n```'));
  await until(() => window.__calls.includes("run_code") , 40000, "run_code executed in Studio");
  await until(() => window.__sent.length >= 4, 40000, "tool result sent back");
  const barNow = await page.evaluate(() => { const b = document.querySelector("#rs-bar"); const r = b.getBoundingClientRect(); return { display: getComputedStyle(b).display, inline: b.style.display, top: r.top, h: r.height, cls: b.className, hiddenAttr: b.hidden, vis: getComputedStyle(b).visibility, op: getComputedStyle(b).opacity, diag: (window.__rsDiag || []).filter(e => /bar|collision|overlay|hide/i.test(e.event)).slice(-8).map(e => e.event + " " + JSON.stringify(e.data || {}).slice(0, 160)) }; });
  console.log("bar now:", JSON.stringify(barNow));
  const coverVsBar = await page.evaluate(() => { const c = document.getElementById("rs-input-cover"), b = document.querySelector("#rs-bar"); if (!c) return { cover: null }; const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect(); return { coverOn: c.dataset.on, coverTop: Math.round(cr.top), coverBottom: Math.round(cr.bottom), barTop: Math.round(br.top), barBottom: Math.round(br.bottom), overlap: cr.top < br.bottom && cr.bottom > br.top }; });
  console.log("cover vs bar:", JSON.stringify(coverVsBar));
  const tail = await page.evaluate(() => ({ calls: window.__calls, sent: window.__sent.map(t => t.slice(0, 90)), cards: document.querySelectorAll("[data-totalscript-notion-card]").length, styleRules: [...document.querySelectorAll("#rs-root style, html > style")].map(st => st.textContent.length) }));
  console.log("tail:", JSON.stringify(tail));
  await page.screenshot({ path: path.join(__dirname, "shot-notion-3.png") });
  const diag = await page.evaluate(() => (window.__rsDiag || []).slice(-60).map(e => e.iso + " " + e.event + " " + JSON.stringify(e.data || {}).slice(0, 150)));
  console.log(diag.join("\n"));
  await browser.close();
  console.log("PROTOCOL_OK", protoOk);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
