// 2.1.0 — Image Studio (src/core/imagegen.js + skills/studio_images.js + background image_* handlers).
//
// What is verified here, and how far it reaches:
//   A. pure module: specs, prompt builder, API request shaping per model family
//      (documented sizes / parameters), response parsing, registry.
//   B. background.js shapes the same request the module does (kept in sync by
//      regex pins) and never returns the key.
//   C. the chat pickup heuristics on a jsdom transcript (own UI, avatars, tiny
//      icons and already-picked pictures are skipped; newest first).
//   D. the window in jsdom: builds, opens, closes, source/kind controls, a
//      dropped file lands in the registry (jsdom has no canvas → that path is
//      exercised through a canvas stub; the stub is a MOCK, not a browser).
//   E. the command surface through run(): honest errors with no image / no API
//      / unknown id, image_list, image_generate source:chat hand-back.
//   F. registration: catalogue entries + params, manifest / codecraft.html
//      bundle order, main.js dispatch + hooks + bar button + shortcut,
//      overlay.css, system prompt + GUI brief lines, README.
// NOT verified (sandbox): a real image API, a real chat site drawing, Studio.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-imagegen.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const { JSDOM } = require("jsdom");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 500) : "")); } };
const I = require(path.join(R, "src/core/imagegen.js"));

// ── A. pure ──
ok("A1 VERSION 2.19.0, 7 kinds, 8 styles, 5 commands, frozen API", I.VERSION === "2.19.0" && I.KIND_IDS.length === 7 && I.STYLE_IDS.length === 8 && I.COMMANDS.length === 5 && Object.isFrozen(I));
ok("A2 specs: thumbnail 1920x1080 16:9 not for Studio; icon 512; gui_icon transparent 256 studio edge; texture 512", I.spec("thumbnail").w === 1920 && I.spec("thumbnail").h === 1080 && I.spec("thumbnail").studio === null && I.spec("icon").w === 512 && I.spec("gui_icon").transparent === true && I.spec("gui_icon").studio === 256 && I.spec("texture").studio === 512);
ok("A3 unknown kind falls back to gui_panel", I.spec("nope").id === "gui_panel");
const pT = I.buildPrompt({ prompt: "a knight on a cliff", kind: "thumbnail" });
ok("A4 thumbnail prompt: Roblox art direction + subject + roblox style + no-text negatives folded in", /Roblox game thumbnail/.test(pT.prompt) && /a knight on a cliff/.test(pT.prompt) && pT.style === "roblox" && /No watermark/.test(pT.prompt) && pT.negative.includes("text"));
const pTt = I.buildPrompt({ prompt: "x", kind: "thumbnail", title: "ESCAPE" });
ok("A5 a title keeps text allowed and asks for it spelled exactly", /"ESCAPE"/.test(pTt.prompt) && !pTt.negative.includes("text"));
const pI = I.buildPrompt({ prompt: "sword", kind: "gui_icon" });
ok("A6 gui_icon: flat style default + transparent background, texture: seamless", pI.style === "flat" && pI.transparent === true && /transparent background/.test(pI.prompt) && /seamless tileable/.test(I.buildPrompt({ prompt: "stone", kind: "texture" }).prompt));
ok("A7 fold:false keeps the negatives out of the prompt text", !/No watermark/.test(I.buildPrompt({ prompt: "x", kind: "icon", fold: false }).prompt));
ok("A8 model families: gpt-image / dall-e-3 / dall-e-2 / generic", I.modelFamily("gpt-image-1") === "gpt-image" && I.modelFamily("dall-e-3") === "dall-e-3" && I.modelFamily("DALL-E-2") === "dall-e-2" && I.modelFamily("flux-schnell") === "generic");
ok("A9 sizes: landscape kinds → 1536x1024 (gpt-image) / 1792x1024 (dall-e-3) / 1024x1024 (generic); square kinds always 1024x1024", I.apiSizeFor("gpt-image-1", "thumbnail") === "1536x1024" && I.apiSizeFor("dall-e-3", "gui_background") === "1792x1024" && I.apiSizeFor("sdxl", "gui_button") === "1024x1024" && I.apiSizeFor("gpt-image-1", "icon") === "1024x1024");
const rq1 = I.apiRequest({ model: "gpt-image-1", prompt: "p", kind: "gui_icon", transparent: true });
const rq2 = I.apiRequest({ model: "dall-e-3", prompt: "p", kind: "thumbnail", base: "http://127.0.0.1:7860/v1///" });
ok("A10 gpt-image request: output_format png + background transparent, NO response_format", rq1.body.output_format === "png" && rq1.body.background === "transparent" && !("response_format" in rq1.body) && rq1.body.n === 1);
ok("A11 dall-e-3 request: response_format b64_json, no background; base trailing slashes trimmed; local base allowed", rq2.body.response_format === "b64_json" && !("background" in rq2.body) && rq2.url === "http://127.0.0.1:7860/v1/images/generations");
ok("A12 default base is api.openai.com/v1", I.apiRequest({ prompt: "p" }).url === "https://api.openai.com/v1/images/generations");
ok("A13 parseApiResponse: b64 / url / error / empty", I.parseApiResponse({ data: [{ b64_json: "QUJD", revised_prompt: "r" }] }).b64 === "QUJD" && I.parseApiResponse({ data: [{ url: "https://x/y.png" }] }).url === "https://x/y.png" && /bad key/.test(I.parseApiResponse({ error: { message: "bad key" } }).error) && /no data/.test(I.parseApiResponse({ data: [] }).error) && /empty/.test(I.parseApiResponse(null).error));
I.registry.clear();
const e1 = I.registry.add({ name: "Logo", kind: "gui_icon", source: "api", png: { width: 512, height: 512, mimeType: "image/png", data: "" } });
const e2 = I.registry.add({ name: "Splash", kind: "gui_background", source: "chat", png: { width: 1920, height: 1080, mimeType: "image/png", data: "" } });
ok("A14 registry: ids img1/img2, latest, by id, by name (case-insensitive), unknown → null", e1.id === "img1" && e2.id === "img2" && I.registry.get("latest").id === "img2" && I.registry.get("img1").name === "Logo" && I.registry.get("splash").id === "img2" && I.registry.get("zzz") === null);
for (let i = 0; i < 14; i++) I.registry.add({ name: "f" + i, kind: "gui_panel", source: "file", png: { width: 1, height: 1, mimeType: "image/png", data: "" } });
ok("A15 registry keeps at most 12 entries (oldest dropped)", I.registry.list().length === 12 && I.registry.get("img1") === null);
I.registry.clear();
const lua = I.studioLuau({ w: 2, h: 2, b64: "AAAA", name: "Logo <x>", kind: "gui_icon", publish: true, target: "StarterGui.HUD" });
ok("A16 studioLuau: EditableImage → WritePixelsBuffer → CreateAssetAsync(Image) gate → ImageContent fallback, plain Luau (no += / continue), name sanitised", /CreateEditableImage/.test(lua) && /WritePixelsBuffer/.test(lua) && /CreateAssetAsync\(img, Enum\.AssetType\.Image/.test(lua) && /gui\.ImageContent = content/.test(lua) && !/\+=|\bcontinue\b/.test(lua) && /name = 'Logo x'/.test(lua));
ok("A17 studioLuau clamps sizes to 1..1024 and strips non-base64 bytes", /w = 1024, h = 1/.test(I.studioLuau({ w: 99999, h: 0, b64: "AB CD$$" })) && /local DATA = 'ABCD'/.test(I.studioLuau({ w: 2, h: 2, b64: "AB CD$$" })));

// ── B. background.js in sync ──
const bgSrc = read("background.js");
ok("B1 background handles image_api_status / image_api / image_fetch", /case "image_api_status":/.test(bgSrc) && /case "image_api":/.test(bgSrc) && /case "image_fetch":/.test(bgSrc));
ok("B2 background reads the key from chrome.storage.local (rs_image_api) and only exposes a masked tail", /chrome\.storage\.local\.get\("rs_image_api"\)/.test(bgSrc) && /key_masked: key \? "…" \+ key\.slice\(-4\)/.test(bgSrc) && !/sendResponse\(\{[^}]*\bkey\b:/.test(bgSrc));
ok("B3 background shapes the same request as the module (gpt-image: output_format/background, else response_format b64_json; landscape sizes)", /fam === "gpt-image"\) \{ body\.output_format = "png"; if \(msg\.transparent\) body\.background = "transparent"; \}/.test(bgSrc) && /else body\.response_format = "b64_json";/.test(bgSrc) && /fam === "gpt-image" \? "1536x1024" : fam === "dall-e-3" \? "1792x1024" : "1024x1024"/.test(bgSrc));
ok("B4 image_api posts Bearer <key> to <base>/images/generations with a 180 s abort; image_fetch keeps the private-network guard and a 20 MB cap", /base \+ "\/images\/generations"/.test(bgSrc) && /"Authorization": "Bearer " \+ key/.test(bgSrc) && /ctrl\.abort\(\), 180000/.test(bgSrc) && /image_fetch refused: " \+ why/.test(bgSrc) && /20 \* 1024 \* 1024/.test(bgSrc));

// ── C. pickup heuristics (jsdom) ──
function dom(html) { const d = new JSDOM(html, { pretendToBeVisual: true, url: "https://chatgpt.com/" }); return d.window; }
{
  const w = dom(`<body>
    <article data-role="assistant" id="a1"><img alt="avatar" src="https://cdn/x/avatar.png" width="32" height="32"><p>Here you go</p><img alt="Generated image" src="https://cdn/x/old.png" width="1024" height="1024" data-rs-img-picked="1"></article>
    <article data-role="assistant" id="a2"><img alt="" src="data:image/svg+xml;base64,AAA" width="400" height="400"><img class="emoji" src="https://cdn/x/e.png" width="300" height="300"><img alt="Generated image" src="https://cdn/x/new.png" width="1536" height="1024"><div data-rs-owned="1"><img src="https://cdn/x/ours.png" width="800" height="600"></div><img src="https://cdn/x/tiny.png" width="64" height="64"></article>
  </body>`);
  const items = [w.document.getElementById("a2"), w.document.getElementById("a1")]; // newest first (as the hooks hand them over)
  const c = I.pickupCandidates(items);
  ok("C1 one candidate: the real generated picture; avatar / svg / emoji / own UI / tiny / already-picked are skipped", c.length === 1 && /new\.png$/.test(c[0].src) && c[0].w === 1536, c.map((x) => x.src));
  ok("C2 includePicked brings the older picked picture back as the second candidate", I.pickupCandidates(items, { includePicked: true }).length === 2 && /old\.png$/.test(I.pickupCandidates(items, { includePicked: true })[1].src));
  ok("C3 tolerates junk items", I.pickupCandidates([null, {}, w.document.getElementById("a2")]).length === 1);
}

// ── D. the window (jsdom, canvas stubbed = MOCK) ──
{
  const w = dom(`<body></body>`);
  // canvas / bitmap stubs: jsdom has no 2D context. Enough to walk the file path.
  const px = (wd, ht) => ({ width: wd, height: ht, getContext: () => ({ imageSmoothingEnabled: true, fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(wd * ht * 4) }) }), toDataURL: () => "data:image/png;base64,QUJD" });
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => (String(tag).toLowerCase() === "canvas" ? px(2, 2) : origCreate(tag));
  w.createImageBitmap = async () => ({ width: 300, height: 200, close() {} });
  w.chrome = { storage: { local: { get: (k, cb) => cb({ rs_image_api: { base: "https://api.openai.com/v1", model: "gpt-image-1", key: "" } }), set: (o, cb) => { w.__saved = o; cb && cb(); } } } };
  const ctx = w; ctx.window = w; ctx.globalThis = w; ctx.module = undefined;
  vm.runInContext(read("src/core/imagegen.js"), vm.createContext(ctx), { filename: "imagegen.js" });
  const IG = w.TotalImageGen;
  const sends = [];
  const hooks = { bg: async (m) => (m.type === "image_api_status" ? { ok: true, configured: false } : { ok: false, error: "offline" }), send: async (t) => { sends.push(t); return true; }, diag() {}, download: () => true, attach() {}, assistantItems: () => [] };
  ok("D1 closed before open; open builds #rs-images (data-rs-owned) once and focuses the prompt", !IG.isOpen() && (IG.open(hooks), IG.isOpen()) && w.document.querySelectorAll("#rs-images").length === 1 && w.document.getElementById("rs-images").getAttribute("data-rs-owned") === "1");
  const root = w.document.getElementById("rs-images");
  ok("D2 controls: prompt, 7 kinds, 8 styles, source select with auto/api/chat, Generate, file input, drop zone, target, publish checkbox, 4 actions, API fields", root.querySelector("[data-ig-prompt]") && root.querySelectorAll("[data-ig-kind] option").length === 7 && root.querySelectorAll("[data-ig-style] option").length === 8 && root.querySelectorAll("[data-ig-source] option").length === 3 && root.querySelector("[data-ig-generate]") && root.querySelector("[data-ig-file]") && root.querySelector("[data-ig-drop]") && root.querySelector("[data-ig-target]") && root.querySelector("[data-ig-publish]") && root.querySelector("[data-ig-send]") && root.querySelector("[data-ig-thumb]") && root.querySelector("[data-ig-icon]") && root.querySelector("[data-ig-ask]") && root.querySelector("[data-ig-api-key]").type === "password");
  root.querySelector("[data-ig-generate]").click();
  ok("D3 Generate with an empty prompt → status warning, nothing sent", /Describe the picture/.test(root.querySelector("[data-ig-status]").textContent) && sends.length === 0);
  root.querySelector("[data-ig-prompt]").value = "a shop banner";
  root.querySelector("[data-ig-kind]").value = "gui_background";
  root.querySelector("[data-ig-source]").value = "chat";
  root.querySelector("[data-ig-generate]").click();
  (async () => {
    await new Promise((r) => setTimeout(r, 30));
    ok("D4 source:chat → ONE hand-off message asking the chat to draw, then image_pickup + image_to_gui in a later reply (no pretending)", sends.length === 1 && /generate this picture with your image tool/.test(sends[0]) && /image_pickup \{name:"a shop banner", kind:"gui_background"\}/.test(sends[0]) && /image_to_gui/.test(sends[0]) && /say so instead of pretending/.test(sends[0]), sends[0]);
    root.querySelector("[data-ig-source]").value = "api";
    root.querySelector("[data-ig-generate]").click();
    await new Promise((r) => setTimeout(r, 30));
    ok("D5 source:api without a key → status says to configure the API (no fake image)", /no image API configured/.test(root.querySelector("[data-ig-status]").textContent) && IG.registry.list().length === 0, root.querySelector("[data-ig-status]").textContent);
    // dropped file → registry (MOCK canvas)
    const file = new w.File([new Uint8Array([137, 80, 78, 71])], "banner.png", { type: "image/png" });
    const ev = new w.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
    root.querySelector("[data-ig-drop]").dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 30));
    const lst = IG.registry.list();
    ok("D6 a dropped PNG registers as source:file with the chosen kind and shows in the list + preview", lst.length === 1 && lst[0].source === "file" && lst[0].kind === "gui_background" && lst[0].name === "banner" && root.querySelectorAll("[data-ig-item]").length === 1 && root.querySelector("[data-ig-preview] img"), lst);
    root.querySelector("[data-ig-api-base]").value = "http://127.0.0.1:7860/v1";
    root.querySelector("[data-ig-api-model]").value = "sdxl";
    root.querySelector("[data-ig-api-key]").value = "EXAMPLE_KEY_NOT_REAL_0000";
    root.querySelector("[data-ig-api-save]").click();
    await new Promise((r) => setTimeout(r, 30));
    ok("D7 API save writes rs_image_api {base, model, key} to chrome.storage.local and blanks the key field", w.__saved && w.__saved.rs_image_api && w.__saved.rs_image_api.base === "http://127.0.0.1:7860/v1" && w.__saved.rs_image_api.model === "sdxl" && w.__saved.rs_image_api.key === "EXAMPLE_KEY_NOT_REAL_0000" && root.querySelector("[data-ig-api-key]").value === "", w.__saved);
    root.querySelector("[data-ig-close]").click();
    ok("D8 close hides the dialog; Escape inside closes too; reopen reuses the node", !IG.isOpen() && (IG.open(hooks), root.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })), !IG.isOpen()) && w.document.querySelectorAll("#rs-images").length === 1);

    // ── E. command surface ──
    IG.registry.clear();
    const r1 = await IG.run("image_to_gui", {}, hooks);
    ok("E1 image_to_gui with no image → honest ERROR pointing at image_generate / image_pickup", /^ERROR in image_to_gui: no image yet/.test(r1));
    const r2 = await IG.run("image_generate", { kind: "thumbnail" }, hooks);
    ok("E2 image_generate without a prompt → ERROR listing kinds + styles", /^ERROR in image_generate: prompt is required/.test(r2) && /thumbnail/.test(r2));
    const r3 = await IG.run("image_generate", { prompt: "a dragon", kind: "thumbnail", title: "FLY" }, hooks);
    ok("E3 image_generate with no API (auto → chat) hands the drawing back to the chat: pending:true, the built prompt, 'never pretend'", /Output of 'image_generate'/.test(r3) && /"pending": true/.test(r3) && /"source": "chat"/.test(r3) && /Roblox game thumbnail/.test(r3) && /never pretend/.test(r3) && /image_pickup/.test(r3), r3.slice(0, 300));
    const r4 = await IG.run("image_generate", { prompt: "a dragon", source: "api" }, hooks);
    ok("E4 image_generate source:api with no key → ERROR naming the Images window", /^ERROR in image_generate: no image API configured/.test(r4));
    const r5 = await IG.run("image_pickup", {}, hooks);
    ok("E5 image_pickup with no picture in the transcript → ERROR explaining the picture must already be visible", /^ERROR in image_pickup: no new picture/.test(r5) && /assistant_items_scanned/.test(r5));
    const r6 = await IG.run("image_list", {}, hooks);
    ok("E6 image_list reports count 0 + kinds + styles", /"count": 0/.test(r6) && /gui_panel/.test(r6) && /painterly/.test(r6));
    const r7 = await IG.run("image_thumbnail", { image: "img99" }, hooks);
    ok("E7 image_thumbnail unknown id → ERROR", /^ERROR in image_thumbnail: no image yet/.test(r7));
    ok("E8 unknown command → ERROR", /^ERROR in image_nope: unknown/.test(await IG.run("image_nope", {}, hooks)));

    // ── F. registration ──
    const manifest = JSON.parse(read("manifest.json"));
    const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
    ok("F1 manifest: studio_images.js right after studio_meshkit.js and imagegen.js right before videostudio.js in all " + bundles.length + " bundles", bundles.length >= 11 && bundles.every((b) => b.js.indexOf("src/core/skills/studio_images.js") === b.js.indexOf("src/core/skills/studio_meshkit.js") + 1 && b.js.indexOf("src/core/imagegen.js") === b.js.indexOf("src/core/videostudio.js") - 1));
    const page = read("codecraft.html");
    ok("F2 codecraft.html loads both files in the same places", page.indexOf('src="src/core/skills/studio_images.js"') > page.indexOf('src="src/core/skills/studio_meshkit.js"') && page.indexOf('src="src/core/imagegen.js"') > 0 && page.indexOf('src="src/core/imagegen.js"') < page.indexOf('src="src/core/videostudio.js"'));
    // catalogue
    const g = { window: null, chrome: { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } }, navigator: { userAgent: "node" }, location: { hostname: "chatgpt.com", href: "https://chatgpt.com/" }, console };
    g.window = g; g.globalThis = g; g.TotalImageGen = I;
    const cctx = vm.createContext(g);
    for (const f of bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInContext(read(f), cctx, { filename: f });
    const S = vm.runInContext("typeof RobloxScriptSkills !== 'undefined' ? RobloxScriptSkills : window.RobloxScriptSkills", cctx);
    const cmds = Object.fromEntries(S.SKILL_COMMANDS.filter((c) => /^image_(generate|pickup|to_gui|thumbnail|list)$/.test(c.name)).map((c) => [c.name, c]));
    ok("F3 catalogue: 4 visible image commands + hidden image_list, each with params and a req prompt on image_generate", Object.keys(cmds).length === 5 && !cmds.image_generate.hidden && !cmds.image_pickup.hidden && !cmds.image_to_gui.hidden && !cmds.image_thumbnail.hidden && cmds.image_list.hidden === true && cmds.image_generate.params.prompt.req === true && cmds.image_to_gui.params.publish && cmds.image_thumbnail.params.kind, Object.keys(cmds));
    ok("F4 descriptions are honest: live preview session-only, Studio cannot set thumbnails, never claim an image exists", /session-only/.test(cmds.image_to_gui.description) && /NO API for an experience thumbnail/.test(cmds.image_thumbnail.description) && /Never claim an image exists/.test(cmds.image_generate.description));
    ok("F5 IMAGE_COMMANDS / IMAGE_VERSION exposed; SKILL_OPS includes them; the pack is after meshkit so no duplicate names", JSON.stringify(S.IMAGE_COMMANDS) === JSON.stringify(I.COMMANDS) && S.IMAGE_VERSION === "2.19.0" && S.SKILL_OPS.includes("image_to_gui") && S.SKILL_COMMANDS.filter((c) => c.name === "image_to_gui").length === 1);
    const bl = S.buildLuau("image_to_gui", { name: "X", kind: "gui_panel" });
    ok("F6 buildLuau(image_to_gui) compiles a real program from a 2x2 placeholder (parser check path); the browser-only commands return an err, never Luau", bl && bl.code && /CreateEditableImage/.test(bl.code) && S.buildLuau("image_generate", {}).err && /browser/.test(S.buildLuau("image_pickup", {}).err));
    const main = read("src/core/main.js");
    ok("F7 main.js dispatches image_* before gfx_capture through TotalImageGen.run with the hooks, inside the before/after tool hooks", /if \(\/\^image_\(generate\|pickup\|to_gui\|thumbnail\|list\)\$\/\.test\(bareName\) && typeof TotalImageGen !== "undefined"\)/.test(main) && main.indexOf("TotalImageGen.run(bareName, args, imageHooks())") < main.indexOf('if (name === "gfx_capture" || bareName === "gfx_capture")'));
    const hooksSrc = main.slice(main.indexOf("function imageHooks()"), main.indexOf("function openImageStudio()"));
    ok("F8 hooks lend exactly the core's own paths: bg, attach (A.pendingImages + ui.showImages), downloadDataImage, assistant items newest first, plugin_execute_luau else execute_luau, publish gate (publishAutomationEnabled || requestApproval), sendHandoff", /attach: \(imgs, tool\) => \{ A\.pendingImages = imgs;/.test(hooksSrc) && /download: downloadDataImage/.test(hooksSrc) && /P\.isAssistantItem\(it\)\); return items\.reverse\(\)/.test(hooksSrc) && /bridgeTool\("plugin_execute_luau", \{ code \}, 180000\)/.test(hooksSrc) && /_totalInternal: true/.test(hooksSrc) && /\(await publishAutomationEnabled\(\)\) \|\| \(await requestApproval\("image_to_gui"/.test(hooksSrc) && /send: sendHandoff/.test(hooksSrc));
    ok("F9 bar: Image Studio button between Video and Settings, Ctrl+Shift+I shortcut, opener exported", main.indexOf('id="rs-images-btn"') > main.indexOf('id="rs-video-btn"') && main.indexOf('id="rs-images-btn"') < main.indexOf('id="rs-settings-btn"') && /e\.key === "I" \|\| e\.key === "i"/.test(main) && /window\.__rsOpenImageStudio = openImageStudio/.test(main));
    ok("F10 command family: image_* files under the Thumbnail & Icon Studio family", /id: "gfx", label: "THUMBNAIL & ICON STUDIO", re: \/\^\(gfx_\|image_\)\//.test(main));
    const css = read("overlay.css");
    ok("F11 overlay.css: the bar button nests into the pinned chain (older pins intact) and the #rs-images dialog + light theme are styled", (css.match(/:is\(:is\(:is\(#rs-settings-btn, #rs-enhance-btn\), #rs-video-btn\), #rs-images-btn\)/g) || []).length >= 20 && /#rs-images \{ position: fixed/.test(css) && /html\.rs-light #rs-images \{/.test(css) && /#rs-images\[hidden\] \{ display: none; \}/.test(css));
    const cfg = read("src/core/config.js");
    ok("F12 system prompt line 7 GENERATED ART + GUI brief step 2 mention image_generate → image_to_gui and the no-placeholder rule, within the pinned budgets", /\n7\. GENERATED ART: image_generate → image_to_gui \/ image_thumbnail; no API = draw in chat, then image_pickup\. No fake ids\./.test(cfg) && /GENERATED ART: real pictures for logos \/ backgrounds \/ frames \/ icons - image_generate \{kind: gui_\*\} → image_to_gui; never placeholder ids\./.test(cfg));
    const readme = read("README.md");
    ok("F13 README documents 2.1.0 (sources, evidence boundary) and lists the tests", /\*\*2\.1\.0 — Image Studio/.test(readme) && /test-imagegen\.js/.test(readme) && /imagegen-sim\.py/.test(readme));
    console.log(`test-imagegen: ${n} checks, ${failed} failed (pure + jsdom; canvas MOCKED; no image API / chat site / Studio reached)`);
    process.exit(failed ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
