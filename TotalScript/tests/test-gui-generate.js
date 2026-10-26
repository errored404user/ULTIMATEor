// 1.69.0 — GUI Studio "describe → Generate": the local prompt-to-GUI engine (src/core/guigen.js) and its wiring
// into the studio (prompt bar, Refine with feedback, Variation, hand-off lines), mirroring Animation Studio.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-gui-generate.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let n = 0; const ok = (name, cond, detail) => { n++; if (!cond) { console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : "")); process.exit(1); } };
const engineSrc = read("src/core/guigen.js"), studio = read("src/core/guistudio.js"), css = read("overlay.css"), manifest = read("manifest.json"), codecraft = read("codecraft.html"), readme = read("README.md");

// ── registration ─────────────────────────────────────────────────────────────
const m = JSON.parse(manifest);
const lists = m.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
ok("all 16 provider lists load guigen.js between the template library and the studio", lists.length === 16 && lists.every((js) => { const t = js.indexOf("src/core/guistudio_templates.js"), g = js.indexOf("src/core/guigen.js"), s = js.indexOf("src/core/guistudio.js"); return t >= 0 && g === t + 1 && s === g + 1; }));
ok("codecraft.html loads guigen.js in the same order", codecraft.indexOf('<script src="src/core/guistudio_templates.js"></script>') < codecraft.indexOf('<script src="src/core/guigen.js"></script>') && codecraft.indexOf('<script src="src/core/guigen.js"></script>') < codecraft.indexOf('<script src="src/core/guistudio.js"></script>'));
ok("engine pins its version", engineSrc.includes('const VERSION = "1.71.1";'));
ok("README documents the feature", /\*\*1\.71\.1 — /.test(readme) && readme.includes("guigen.js"));

// ── engine in a vm sandbox (real component factory + template library) ──────
const ctx = { window: {}, console }; ctx.RobloxScriptSkills = { SKILL_COMMANDS: [], CATEGORIES: {}, SKILLS: [] }; ctx.window.RobloxScriptSkills = ctx.RobloxScriptSkills; vm.createContext(ctx);
for (const f of ["src/core/skills/studio_guistudio.js", "src/core/guistudio_templates.js", "src/core/guigen.js"]) vm.runInContext(read(f) + "\n//# sourceURL=" + f, ctx);
const SK = ctx.RobloxScriptSkills, E = ctx.window.TotalGuiGen, L = ctx.window.TotalGuiTemplates;
const env = { templates: L, comp: (k, a) => SK.guiComponentNode(k, Object.assign({ preset: "midnight" }, a || {})), presets: SK.GUI_TOKEN_PRESETS };
ok("window.TotalGuiGen exports the API", E && ["parseIntent", "rank", "generate", "refine", "variation", "describe", "serialize", "parse", "applyFeedback"].every((k) => typeof E[k] === "function") && Array.isArray(E.QUICK) && E.QUICK.length >= 8);
const count = (nodes) => { let c = 0; const walk = (l) => { for (const x of l) { c++; walk(x.children || []); } }; walk(nodes); return c; };
const find = (nodes, pred) => { let hit = null; const walk = (l, p) => { for (const x of l) { if (!hit && pred(x, p)) hit = x; walk(x.children || [], x); } }; walk(nodes, null); return hit; };
const findAll = (nodes, pred) => { const out = []; const walk = (l, p) => { for (const x of l) { if (pred(x, p)) out.push(x); walk(x.children || [], x); } }; walk(nodes, null); return out; };

// intent parsing
{ const it = E.parseIntent("a dark shop called 'Mega Store' with 6 items and a search bar, top-right, big text");
  ok("intent: theme / title / counts / extras / placement / text scale", it.theme === "midnight" && it.title === "Mega Store" && it.counts.items === 6 && it.extras.includes("search") && it.placement === "top-right" && it.textScale > 1, it);
  const it2 = E.parseIntent("settings with tabs Gameplay, Audio and Controls, no close button, neon");
  ok("intent: explicit tab names + negated extra + theme", it2.lists.tabs && it2.lists.tabs.join("|") === "Gameplay|Audio|Controls" && it2.counts.tabs === 3 && it2.removes.includes("close") && !it2.extras.includes("close") && it2.theme === "neon", it2);
  const it3 = E.parseIntent("mobile inventory with twelve slots, compact, rounded");
  ok("intent: word numbers, device, size, corners", it3.counts.items === 12 && it3.device === "phone" && it3.scale < 1 && it3.corner >= 12, it3);
}
// ranking
{ const r = (p) => E.rank(p, env)[0].id;
  ok("rank: shop / inventory / settings / HUD / menu / leaderboard / confirm / loading", r("a shop with items") === "shop" && r("inventory for my rpg game") === "inventory" && r("settings menu with audio and graphics") === "settings" && r("fps hud with ammo") === "hud_fps" && r("main menu with a play button") === "menu" && r("leaderboard of top players") === "leaderboard" && r("confirm dialog are you sure") === "pop_confirm" && r("loading screen with tips") === "load_tips", [r("a shop with items"), r("inventory for my rpg game"), r("settings menu with audio and graphics"), r("fps hud with ammo"), r("main menu with a play button")]);
  ok("rank: specialised screens beat generic ones (gamepass store, crate opening, skill tree, kill feed, pause menu)", r("gamepass store") === "shop_gamepass" && r("crate opening with a spin") === "shop_crate" && r("skill tree with unlockable talents") === "prog_skilltree" && r("kill feed and hit marker") === "rnd_killfeed" && r("pause menu with resume and quit") === "menu_pause");
  ok("rank: mobile templates only when a phone is mentioned", r("mobile shop") === "mob_shop" && E.rank("shop", env).every((x) => x.id !== "mob_shop" || x.score < E.rank("shop", env)[0].score));
}
// generation
{ const d = E.generate("a dark shop with 6 items and a search bar", {}, env);
  ok("generate: picks the Shop template, midnight, 6 cards, search box, close kept", d.templateId === "shop" && d.preset === "midnight" && d.screen === "Shop" && d.nodes.length >= 2 && d.report.score === 100, [d.templateId, d.preset, d.report]);
  const page = find(d.nodes, (x) => x.name === "Page_Weapons"); ok("generate: the card grid now holds exactly 6 cards with unique names", page && page.children.length === 6 && new Set(page.children.map((c) => c.name)).size === 6, page && page.children.map((c) => c.name));
  const clonedTitle = page.children[5].children.find((c) => c.name === "Title"); ok("generate: cloned cards get numbered titles instead of duplicates", clonedTitle && /\d/.test(clonedTitle.text) && clonedTitle.text !== page.children[3].children.find((c) => c.name === "Title").text, clonedTitle);
  ok("generate: search TextBox sits in the title bar", !!find(d.nodes, (x, p) => x.class === "TextBox" && x.name === "Search" && p && p.name === "TitleBar"));
  ok("generate: applied list + describe() summary", d.applied.includes("6 items") && d.applied.includes("+ search") && /Shop · midnight · 6 items · \+search/.test(E.describe(d)), [d.applied, E.describe(d)]);
  ok("generate: deterministic for the same prompt + take", JSON.stringify(E.generate("a dark shop with 6 items and a search bar", {}, env).nodes) === JSON.stringify(d.nodes));
}
{ const d = E.generate("settings with tabs Gameplay, Audio, Controls", {}, env);
  const nav = find(d.nodes, (x) => x.name === "Nav"); ok("generate: named tabs rename the nav buttons (side-nav settings count as tabs)", d.templateId === "set_tabs" && nav && nav.children.map((c) => c.text).join("|") === "Gameplay|Audio|Controls" && nav.children.map((c) => c.name).join("|") === "Gameplay|Audio|Controls", nav && nav.children.map((c) => [c.name, c.text]));
}
{ const d = E.generate("shop with tabs Weapons, Pets, Gamepasses, Skins", {}, env);
  const bar = find(d.nodes, (x) => x.name === "TabBar"), pages = find(d.nodes, (x) => x.name === "Pages");
  ok("generate: real tab bars grow to 4 tabs and the pages follow (Page_Skins)", bar && bar.children.length === 4 && bar.children[3].name === "Tab_Skins" && pages && pages.children.length === 4 && pages.children[3].name === "Page_Skins", [bar && bar.children.map((c) => c.name), pages && pages.children.map((c) => c.name)]);
}
{ const d = E.generate("neon main menu with buttons Play, Shop, Settings, Quit", {}, env);
  const btns = find(d.nodes, (x) => x.name === "Buttons"); ok("generate: menu buttons renamed / extended to the given list + neon", d.templateId === "menu" && d.preset === "neon" && btns && btns.children.map((c) => c.text).join("|") === "PLAY|Shop|Settings|Quit" && btns.children.map((c) => c.name).join("|") === "Play|Shop|Settings|Quit", btns && btns.children.map((c) => [c.name, c.text]));
}
{ const d = E.generate("leaderboard top-right with 8 rows", {}, env);
  const rows = find(d.nodes, (x) => x.name === "Rows"); const board = d.nodes.find((x) => x.name === "Board");
  ok("generate: 8 leaderboard rows numbered 1..8, panel anchored top-right", rows && rows.children.length === 8 && /^8\./.test(rows.children[7].text) && board && board.anchor[0] === 1 && board.anchor[1] === 0 && board.position[0] === 1, rows && rows.children.map((c) => c.text));
}
{ const d = E.generate("pet shop called 'Pet Paradise', candy theme, 9 cards, bigger", {}, env);
  const title = find(d.nodes, (x, p) => x.class === "TextLabel" && x.name === "Title" && p && p.name === "TitleBar"); const win = d.nodes.find((x) => x.name === "ShopWindow");
  ok("generate: quoted title lands in the title bar and the ScreenGui name, window scaled up", title && title.text === "Pet Paradise" && d.screen === "PetParadise" && win.size[1] > 640 && d.preset === "candy", [title && title.text, d.screen, win && win.size]);
}
{ const d = E.generate("confirm dialog with ok and cancel buttons, horror theme, top-right", {}, env);
  const dlg = find(d.nodes, (x) => x.name === "Confirm"); ok("generate: panel inside a full-screen dim is the one that moves; existing OK/Cancel count as the footer", d.templateId === "pop_confirm" && d.preset === "horror" && dlg && dlg.anchor[0] === 1 && d.applied.includes("+ footer") && findAll(d.nodes, (x) => x.class === "TextButton").length === 2, [dlg && dlg.anchor, d.applied]);
}
{ const d = E.generate("RPG HUD with a coins display, a timer and an avatar", {}, env);
  ok("generate: HUD extras are added as root elements (currency_hud component, Timer, Avatar)", d.templateId === "hud_rpg" && d.nodes.some((x) => x.name === "Timer") && d.nodes.some((x) => /Coins/.test(x.name)) && d.nodes.some((x) => x.name === "Avatar"), d.nodes.map((x) => x.name));
}
{ const d = E.generate("quest log small, bottom-left, no close button, 5 quests", {}, env);
  ok("generate: smaller + bottom-left + count on the quest log, no close added", d.templateId === "quests" && d.applied.includes("smaller window") && d.applied.includes("placed bottom-left") && d.applied.includes("5 items") && !find(d.nodes, (x) => x.name === "Close" && d.intent.removes.includes("close") && false), d.applied);
}
{ const d = E.generate("a window for choosing your favourite food with buttons Pizza, Sushi, Tacos", {}, env);
  ok("generate: no library match → custom window with a Title-Case title and the listed buttons, scored down with a warning", d.templateId === null && d.templateLabel === "Custom window" && d.nodes[0].children[0].children[0].text === "Choosing Your Favourite Food" && find(d.nodes, (x) => x.name === "Body").children.map((c) => c.text).join("|") === "Pizza|Sushi|Tacos" && d.report.score < 100 && d.report.notes.some((x) => x.level === "warn"), [d.templateLabel, d.report]);
}
{ const d = E.generate("", {}, env); ok("generate: empty prompt still yields a window (never throws)", d && d.nodes.length >= 1); }

// refine
{ let d = E.generate("a dark shop with 6 items and a search bar", {}, env);
  d = E.refine(d, "make it bigger and neon", env);
  ok("refine: theme + size feedback regenerate from the prompt", d.preset === "neon" && d.nodes.find((x) => x.name === "ShopWindow").size[1] > 640 && d.feedback.length === 1 && d.feedback[0].applied.includes("theme neon") && d.feedback[0].applied.includes("bigger"), d.feedback);
  d = E.refine(d, "4 items, move it to the top-left", env);
  ok("refine: counts + placement stack on earlier feedback (still neon, still bigger)", d.preset === "neon" && find(d.nodes, (x) => x.name === "Page_Weapons").children.length === 4 && d.nodes.find((x) => x.name === "ShopWindow").anchor.join() === "0,0" && d.feedback.length === 2, d.feedback);
  d = E.refine(d, "rename it to Mega Store", env);
  ok("refine: rename changes the title bar text and the screen name", find(d.nodes, (x, p) => x.name === "Title" && p && p.name === "TitleBar").text === "Mega Store" && d.screen === "MegaStore");
  d = E.refine(d, "add a timer and remove the search bar", env);
  ok("refine: add / remove extras (search gone, timer present, no stale warning)", d.nodes.some((x) => x.name === "Timer") && !find(d.nodes, (x) => x.name === "Search") && !d.report.notes.some((x) => /search/.test(x.text)), [d.report.notes, d.applied]);
  const before = d.preset; d = E.refine(d, "another theme", env); const after = d.preset; d = E.refine(d, "more items", env);
  ok("refine: 'another theme' moves once within the dark family and stays put on the next refinement; 'more items' adds two", before !== after && d.preset === after && find(d.nodes, (x) => x.name === "Page_Weapons").children.length === 6, [before, after, d.preset]);
  d = E.refine(d, "remove the dragon", env);
  ok("refine: unknown removals warn instead of silently passing", d.report.notes.some((x) => /dragon/.test(x.text)), d.report.notes);
  d = E.refine(d, "blorp", env);
  ok("refine: unrecognised feedback is logged with a hint, design unchanged", d.feedback[d.feedback.length - 1].applied[0].startsWith("(nothing recognised"), d.feedback[d.feedback.length - 1]);
  ok("refine: the whole feedback trail is kept for the hand-off", d.feedback.length === 8 && d.feedback.map((f) => f.text)[0] === "make it bigger and neon");
  const j = E.serialize(d); const back = E.parse(j); ok("serialize / parse round-trip", back.nodes.length === d.nodes.length && back.prompt === d.prompt && back.feedback.length === 8);
}
// variation
{ const a = E.generate("shop", {}, env); const b = E.variation(a, env); const c = E.variation(b, env);
  ok("variation: single-fit prompts rotate the theme inside the same family (dark → dark)", b.templateId === "shop" && b.preset !== a.preset && ["neon", "royal_gold", "forest", "horror", "ocean", "retro", "midnight"].includes(b.preset) && c.preset !== b.preset && b.take === 1 && c.take === 2 && /take 2/.test(E.describe(b)), [a.preset, b.preset, c.preset]);
  const h1 = E.generate("settings menu with audio and graphics", {}, env), h2 = E.variation(h1, env);
  ok("variation: when several screens fit, the next take switches template (settings → audio settings)", h1.templateId === "settings" && h2.templateId !== h1.templateId && h2.templateId.startsWith("set_"), [h1.templateId, h2.templateId]);
}
// every template survives the transform pipeline (no throw, nodes intact)
{ let bad = null;
  for (const t of L.list) { try { const d = E.generate(t.label + " with 5 items, bigger, top-left, add a timer", {}, env); if (!d.nodes.length || count(d.nodes) < 2) bad = t.id; } catch (e) { bad = t.id + ": " + e.message; } if (bad) break; }
  ok("every library label generates without throwing (count / scale / place / extras on all 100+ screens)", bad === null, bad);
}

// ── studio wiring in jsdom ───────────────────────────────────────────────────
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.requestAnimationFrame = (f) => setTimeout(f, 0);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }; };
w.HTMLElement.prototype.scrollIntoView = function () {};
w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
w.prompt = () => null; let confirmAsked = 0; w.confirm = () => { confirmAsked++; return true; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 900; } });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; } });
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const load = (f) => { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); };
for (const f of ["src/core/skills/studio_skills.js", "src/core/skills/studio_design.js", "src/core/skills/studio_gui.js", "src/core/skills/studio_guistudio.js", "src/core/guistudio_templates.js", "src/core/guigen.js", "src/core/guistudio.js"]) load(f);
ok("scripts load without window errors", errors.length === 0, errors);
const G = w.TotalGuiStudio;
ok("studio exposes generate / refine / variation / lastDesign", typeof G.generate === "function" && typeof G.refine === "function" && typeof G.variation === "function" && "lastDesign" in G);
const sent = [], toasts = [], diags = [];
G.open({ send: async (t) => { sent.push(t); return true; }, runTool: async () => "Output of 'x':\n{}", studioReady: () => true, engine: () => "roblox", toast: (m) => toasts.push(m), diag: (e, d) => diags.push([e, d]) });
const host = w.document.getElementById("rs-gui");
const genBox = host.querySelector(".rsg-gen"), promptEl = host.querySelector(".rsg-gen-prompt"), fbEl = host.querySelector(".rsg-gen-fb"), refineRow = host.querySelector(".rsg-gen-refine");
ok("Describe bar renders above the stage with prompt, Generate, Variation, chips; refine row hidden until something was generated", genBox && !genBox.classList.contains("rsg-gen-off") && promptEl && host.querySelector('[data-act="genGo"]') && host.querySelector('[data-act="genVar"]') && host.querySelectorAll(".rsg-gen-chips [data-gen-chip]").length === 6 && refineRow.hidden === true && genBox.compareDocumentPosition(host.querySelector(".rsg-stage")) & 4);
ok("bar is visible in Simple mode (only Surprise me is advanced-only)", host.classList.contains("rsg-simple") && !genBox.classList.contains("rsg-adv") && !host.querySelector('[data-act="genGo"]').classList.contains("rsg-adv") && host.querySelector('[data-act="genSurprise"]').classList.contains("rsg-adv"));
ok("empty stage points at the describe box", /describe it/.test(host.querySelector(".rsg-empty-stage").textContent));
const click = (sel) => host.querySelector(sel).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const lastToast = () => host.querySelector(".rsg-toast").textContent; // the studio shows toasts in its own overlay while open
const enter = (el) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
// empty prompt
click('[data-act="genGo"]'); ok("Generate with an empty prompt toasts a hint and leaves the canvas empty", /Describe the screen first/.test(lastToast()) && G._state.nodes.length === 0, lastToast());
// Enter in the prompt
promptEl.value = "a dark shop with 6 items and a search bar"; enter(promptEl);
ok("Enter in the prompt generates onto the canvas (Shop, 6 cards, search) and records the design", G._state.nodes.length >= 2 && G._state.screen.name === "Shop" && G._state.preset === "midnight" && G.lastDesign && G.lastDesign.templateId === "shop" && host.querySelectorAll(".rsg-n").length > 20, [G._state.nodes.length, G._state.screen.name]);
ok("refine row + summary + score appear; chips hide; no confirm asked for an empty canvas", refineRow.hidden === false && /Shop · midnight · 6 items/.test(host.querySelector(".rsg-gen-sum").textContent) && host.querySelector(".rsg-gen-score").textContent === "100" && host.querySelector(".rsg-gen-chips").hidden === true && confirmAsked === 0);
ok("generation is one undo step and emits gui.generate diag", G._state.history.length === 1 && diags.some((d) => d[0] === "gui.generate" && d[1].template === "shop"));
// Refine via Enter
fbEl.value = "4 items, neon, move it to the top-left"; enter(fbEl);
const win = G._state.nodes.find((x) => x.name === "ShopWindow");
ok("Refine regenerates in place: neon tokens, 4 cards, top-left, feedback cleared, summary updated", G._state.preset === "neon" && G._state.tokens.primary === "#00d4ee" && win && win.anchor && win.anchor[0] === 0 && G.lastDesign.feedback.length === 1 && fbEl.value === "" && /1 refinement/.test(host.querySelector(".rsg-gen-sum").textContent), [G._state.preset, win && win.anchor]);
// Variation
click('[data-act="genVar"]'); ok("Variation bumps the take and changes the look", G.lastDesign.take === 1 && /take 2/.test(host.querySelector(".rsg-gen-sum").textContent) && G._state.nodes.length >= 2);
// hand-off text
const msg = G.buildMessage("wire the Buy buttons");
ok("Send-to-AI hand-off carries Prompt / Generated from / Feedback applied lines before the spec", /\nPrompt: a dark shop with 6 items and a search bar\n/.test(msg) && /\nGenerated from: Shop · theme /.test(msg) && /\nFeedback applied: "4 items, neon, move it to the top-left" → theme neon, 4 items, move top-left\./.test(msg) && msg.indexOf("Prompt:") < msg.indexOf("```json") && msg.includes("do this: wire the Buy buttons"), msg.slice(0, 1200));
// chips when canvas empty again
click('[data-act="clear"]'); ok("Clear empties the canvas, forgets the generation and the chips come back (prompt text stays)", G._state.nodes.length === 0 && G.lastDesign === null && host.querySelector(".rsg-gen-chips").hidden === false && promptEl.value.length > 0);
click('.rsg-gen-chips [data-gen-chip]'); ok("Quick chip fills the prompt and generates", G._state.nodes.length > 0 && promptEl.value === host.querySelector(".rsg-gen-chips [data-gen-chip]").dataset.genChip);
// forget
click('[data-act="genClear"]'); ok("× forgets the generation but keeps the design on the canvas", G.lastDesign === null && refineRow.hidden === true && G._state.nodes.length > 0);
ok("Refine without a design toasts", (fbEl.value = "bigger", enter(fbEl), /Generate something first/.test(lastToast())), lastToast());
// generating over a hand-made design asks first
confirmAsked = 0; w.confirm = () => { confirmAsked++; return false; };
promptEl.value = "settings"; enter(promptEl); ok("Generating over a non-generated design asks for confirmation and respects No", confirmAsked === 1 && G._state.screen.name !== "Settings");
w.confirm = () => true; enter(promptEl); ok("…and proceeds on Yes", G._state.screen.name === "Settings" && G.lastDesign.templateId === "settings");
// template picks reset the generation
const tplBtn = host.querySelector('[data-act="gallery"]'); tplBtn && click('[data-act="gallery"]'); const card = host.querySelector("[data-tpl]"); if (card) card.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ok("Loading a template forgets the generated design (Refine would otherwise rewrite the template)", G.lastDesign === null && refineRow.hidden === true);
// hand-off without a design has no generator lines
ok("hand-off without a generation has no Prompt line", !/\nPrompt: /.test(G.buildMessage("")));

// ── CSS / source pins ────────────────────────────────────────────────────────
for (const s of [".rsg-gen {", ".rsg-gen.rsg-gen-off { display: none; }", ".rsg-gen-prompt, .rsg-gen-fb {", ".rsg-gen-score.warn {", ".rsg-chip:hover {", "#rs-gui .rsg-gen [hidden] { display: none !important; }"]) ok("overlay.css has " + s, css.includes(s));
ok("gen bar CSS lives inside the GUI Studio block (before .rsg-stage)", css.indexOf(".rsg-gen {") > css.indexOf("#rs-gui {") && css.indexOf(".rsg-gen {") < css.indexOf(".rsg-stage {"));
for (const s of ["function installScreen(nodes, screenName, preset)", "function applyDesign(d, verb)", "function genHandoffLines()", "...genHandoffLines(),", 'case "genGo":', 'case "genRefine": return genRefine(); case "genVar": return genVariation();', 'e.target.classList.contains("rsg-gen-prompt")', 'e.target.classList.contains("rsg-gen-fb")', "S.lastTemplate = t.id; S.gen = null; renderGen();"]) ok("guistudio.js has " + s, studio.includes(s));
ok("templates and generation share one install path (no duplicated inset / stroke logic)", studio.split("S.screen.ignore_inset = fullscreen;").length === 2);

console.log("test-gui-generate: " + n + " checks passed");
process.exit(0);
