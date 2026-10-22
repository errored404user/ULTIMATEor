/* ORscript GUI Studio — prompt-to-GUI generation engine (1.65.0).
 *
 * The GUI counterpart of animengine.js: "describe it → Generate" without a
 * model turn. A plain-words prompt is parsed into an INTENT (kind of screen,
 * theme, title, item / tab / button counts and names, placement, size, device,
 * extras such as search / timer / currency / close, text scale, spacing,
 * corner style), the closest of the 100+ library templates is chosen and
 * transformed to match, and the result is scored with notes the studio shows.
 * Like the animation engine it is deterministic for a (prompt, take) pair, so
 * REFINE replays the prompt with the accumulated feedback and VARIATION bumps
 * the take (next-best template / next theme in the same family).
 *
 * Public API (window.ORGuiGen):
 *   parseIntent(text)                               → intent
 *   generate(text|intent, opts, env)                → design { name, prompt, intent, templateId, templateLabel, preset, screen,
 *                                                       nodes, report:{score,notes[]}, feedback[], take, applied[] }
 *   refine(design, feedbackText, env)               → design (regenerated with the feedback applied to the intent)
 *   variation(design, env)                          → design (take + 1)
 *   describe(design)                                → one-line summary for the studio ("Shop · neon · 6 items · search")
 *   rank(text|intent, env)                          → [{id,label,score}] best templates first
 *   serialize(design) / parse(json)
 * env = { templates: window.ORGuiTemplates, comp(kind,args) → node, presets: {id: tokens} } - supplied by GUI Studio.
 */
(() => {
  "use strict";
  if (window.ORGuiGen) return;
  const VERSION = "1.65.0";
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const lc = (s) => String(s == null ? "" : s).toLowerCase();
  const words = (s) => lc(s).replace(/[^a-z0-9+&' ]+/g, " ").split(/\s+/).filter(Boolean);
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, a: 1, an: 1, single: 1, couple: 2, few: 3, several: 5 };
  const num = (s) => { const t = lc(s); if (/^\d+$/.test(t)) return +t; return NUM[t] != null ? NUM[t] : null; };

  // ── vocabulary ─────────────────────────────────────────────────────────────
  // Extra phrases per template id (the label, tags, screen and category words
  // are indexed automatically). Phrases match as substrings of the prompt.
  const SYN = {
    hud: ["hud", "overlay", "in-game ui", "ingame ui", "game ui"], hud_minimal: ["minimal hud", "clean hud", "simple hud"], hud_rpg: ["rpg", "mana", "adventure"], hud_fps: ["fps", "shooter", "ammo", "crosshair", "gun game"], hud_racing: ["racing", "race", "kart", "speedometer", "car game"], hud_simulator: ["simulator", "sim ", "pets hud", "rebirth"], hud_tycoon: ["tycoon", "cash", "income"], hud_obby: ["obby", "parkour", "checkpoint", "stage"], hud_survival: ["survival", "hunger", "thirst"], hud_horror: ["horror hud", "sanity", "flashlight"], hud_sports: ["sports", "football", "soccer", "basketball", "match hud"], hud_br: ["battle royale", "br ", "zone", "storm"],
    menu: ["main menu", "title screen", "start screen", "start menu", "home screen", "play button"], menu_cinematic: ["cinematic", "hero image", "news"], menu_side: ["side menu", "sidebar menu", "side list"], menu_pause: ["pause", "paused", "resume"], menu_modes: ["mode select", "game modes", "gamemode", "choose a mode", "modes"], menu_team: ["team select", "pick a team", "teams"], menu_class: ["class select", "character select", "hero select", "choose a class", "classes"], menu_difficulty: ["difficulty"], menu_mapvote: ["map vote", "vote for a map", "maps"], menu_credits: ["credits"],
    shop: ["shop", "store", "buy", "purchase", "sell items", "market"], shop_featured: ["featured", "banner shop", "sale banner"], shop_gamepass: ["gamepass", "game pass", "gamepasses", "passes", "vip", "premium perks"], shop_coins: ["coin pack", "coins pack", "gem pack", "currency pack", "buy coins", "buy gems", "robux shop", "bundles"], shop_daily: ["daily deal", "deals", "discount", "offers", "sale"], shop_battlepass: ["battle pass", "battlepass", "season pass", "tiers"], shop_crate: ["crate", "loot box", "lootbox", "chest opening", "spin", "gacha", "unbox", "egg"], shop_trade: ["trade", "trading"], shop_market: ["marketplace", "auction", "listings", "player market"], shop_exchange: ["exchange", "convert", "swap currency"],
    inventory: ["inventory", "bag", "items"], inv_backpack: ["backpack", "hotbar"], inv_equipment: ["equipment", "armor", "armour", "gear", "paper doll", "equip slots"], inv_pets: ["pets", "pet inventory", "pet list"], inv_crafting: ["craft", "crafting", "recipe", "forge", "blacksmith", "workbench"], inv_loadout: ["loadout", "weapons", "guns", "primary weapon"], inv_locker: ["skins", "locker", "cosmetics", "wardrobe", "outfits"], inv_itemdetail: ["item detail", "item info", "item popup"],
    quests: ["quest", "mission", "tasks", "objectives", "quest log"], leaderboard: ["leaderboard", "ranking", "top players", "high score", "scores"], rewards: ["daily reward", "login reward", "streak", "claim reward"], prog_levelup: ["level up", "levelup", "level-up"], prog_achievements: ["achievement", "badges", "trophies"], prog_seasontrack: ["season progress", "milestones", "season track"], prog_skilltree: ["skill tree", "talent", "perk tree", "upgrade tree", "tech tree"], prog_stats: ["stats sheet", "player stats", "statistics", "profile stats"],
    soc_friends: ["friends", "friend list"], soc_chat: ["chat", "messages", "chat box"], soc_party: ["party", "squad", "lobby group", "team up"], soc_guild: ["guild", "clan", "crew"], soc_invite: ["invite"], soc_profile: ["profile card", "player card", "profile"], soc_emotes: ["emote", "emotes", "emote wheel"], soc_report: ["report player", "report"],
    dialogue: ["dialogue", "dialog box", "npc", "conversation", "talk", "speech"], pop_confirm: ["confirm", "are you sure", "yes no", "confirmation"], pop_warning: ["warning"], pop_error: ["error"], pop_reward: ["reward popup", "you won", "congratulations", "success popup", "prize"], pop_input: ["input prompt", "enter your name", "name input", "text input", "form"], pop_purchase: ["purchase confirm", "confirm purchase", "buy confirm"], pop_rate: ["rate us", "rating", "stars"], pop_tip: ["tutorial tip", "hint popup", "tip"], pop_tooltip: ["tooltip"], pop_toasts: ["notification", "toast", "alerts"], pop_countdown: ["countdown", "3 2 1", "go!"], pop_announce: ["announcement", "event banner", "broadcast"],
    loading: ["loading screen", "loading"], load_splash: ["splash", "logo intro", "studio logo"], load_tips: ["loading tips"], load_cutscene: ["cutscene", "letterbox", "cinematic bars"], load_tutorial: ["tutorial", "onboarding", "steps"], load_controls: ["controls help", "controls", "how to play"], load_welcome: ["welcome back", "welcome"], load_changelog: ["update notes", "changelog", "patch notes", "update log"],
    settings: ["settings", "options", "preferences"], set_tabs: ["settings tabs", "settings with tabs"], set_graphics: ["graphics", "quality settings"], set_audio: ["audio", "volume", "sound settings", "music settings"], set_keybinds: ["keybinds", "key binds", "rebind", "controls settings"], set_access: ["accessibility", "colourblind", "colorblind"], set_language: ["language"],
    rnd_status: ["round status", "round bar", "round timer"], rnd_vote: ["voting", "vote screen", "vote for"], rnd_results: ["results", "podium", "victory screen", "end screen", "game over"], rnd_killfeed: ["kill feed", "killfeed", "hit marker"], rnd_scoreboard: ["scoreboard", "tab menu", "player list"], rnd_spectate: ["spectate", "spectator"], rnd_intermission: ["intermission", "waiting for players", "next round"], rnd_winner: ["winner", "mvp", "winner banner"],
    mob_hud: ["mobile hud", "touch controls", "touch buttons"], mob_shop: ["mobile shop", "bottom sheet", "sheet"], mob_drawer: ["drawer", "hamburger", "side drawer"], mob_bottomnav: ["bottom nav", "bottom bar", "tab bar"], mob_popup: ["mobile popup"], mob_quests: ["mobile quest"],
    dev_admin: ["admin", "admin panel", "moderator panel"], dev_debug: ["debug", "fps counter", "ping", "performance overlay"], dev_cmdbar: ["command bar", "console", "commands"], dev_servers: ["server browser", "servers", "server list"], dev_modpopup: ["moderation", "ban", "banned", "kicked"], dev_banner: ["dev banner", "beta banner", "version banner"],
  };
  const GENERIC = new Set(["screen", "window", "panel", "with", "the", "and", "for", "ui", "gui"]);
  const CAT_WORDS = { hud: ["hud", "overlay"], menu: ["menu"], shop: ["shop", "store"], inventory: ["inventory"], progress: ["progress", "progression"], social: ["social"], popup: ["popup", "pop-up", "dialog", "modal"], onboard: ["loading", "intro"], settings: ["settings", "options"], round: ["round", "match"], mobile: ["mobile", "phone", "touch"], dev: ["admin", "dev", "debug"] };
  const THEMES = [
    ["neon", /\b(neon|cyber|cyberpunk|futuristic|sci-?fi|synthwave|glow|glowing|tron|hologram)\b/], ["clean_light", /\b(light|clean|white|minimal|minimalist|bright|flat|modern)\b/], ["candy", /\b(candy|cute|kawaii|pastel|bubbly|playful|cartoon|cartoony|simulator)\b/],
    ["royal_gold", /\b(gold|golden|royal|luxury|luxurious|premium|fantasy|medieval|king|epic|rich)\b/], ["forest", /\b(forest|nature|green|jungle|wood|wooden|survival|camp)\b/], ["horror", /\b(horror|scary|creepy|spooky|blood|bloody|halloween|evil)\b/],
    ["ocean", /\b(ocean|blue|water|sea|aqua|underwater|ice|frozen|pirate)\b/], ["sakura", /\b(sakura|japan|japanese|cherry|anime|blossom|soft pink)\b/], ["retro", /\b(retro|pixel|arcade|80s|90s|vintage|orange|synth)\b/], ["midnight", /\b(dark|night|midnight|navy|sleek|space)\b/],
  ];
  const DARK = ["midnight", "neon", "royal_gold", "forest", "horror", "ocean", "retro"], LIGHT = ["clean_light", "candy", "sakura"];
  const PLACES = [["top-left", /\b(top[- ]?left|upper[- ]?left)\b/], ["top-right", /\b(top[- ]?right|upper[- ]?right)\b/], ["bottom-left", /\b(bottom[- ]?left|lower[- ]?left)\b/], ["bottom-right", /\b(bottom[- ]?right|lower[- ]?right)\b/], ["top", /\b(at the top|top center|top centre|top of the screen|on top)\b/], ["bottom", /\b(at the bottom|bottom center|bottom centre|bottom of the screen)\b/], ["left", /\b(left side|on the left|to the left)\b/], ["right", /\b(right side|on the right|to the right)\b/], ["center", /\b(center|centre|middle|centered|centred)\b/]];
  const ITEM_NOUN = /\b(items?|cards?|products?|slots?|pets?|skins?|packs?|deals?|entries|rows?|players?|quests?|rewards?|options?|friends?|messages?|servers?|classes|modes|maps|teams|tiers?|levels?|badges?|achievements?|listings?|recipes?|weapons?|skills?|emotes?|offers?|days?|stages?|lines?)\b/;
  const EXTRAS = [["close", /\bclose (button|icon|x)\b|\bx button\b/], ["search", /\bsearch( bar| box| field)?\b/], ["timer", /\b(timer|countdown|clock)\b/], ["currency", /\b(coins?|gems?|currency|money|cash|gold) (display|counter|hud|bar|label|amount|balance)\b|\bshow(ing)? (the )?(coins|gems|currency|balance)\b/], ["avatar", /\b(avatar|profile picture|player icon|portrait)\b/], ["back", /\bback button\b/], ["progress", /\b(progress bar|xp bar|level bar)\b/], ["footer", /\b(ok|okay|cancel|confirm) (and|\/|or) (cancel|ok|okay|no) buttons?\b|\bfooter buttons\b/]];

  // ── intent ─────────────────────────────────────────────────────────────────
  function parseIntent(text) {
    const raw = String(text || "").trim(); const t = " " + lc(raw).replace(/\s+/g, " ") + " ";
    const it = { prompt: raw, text: t.trim(), theme: null, title: null, counts: {}, lists: {}, placement: null, scale: 1, textScale: 1, device: null, extras: [], removes: [], gap: 0, corner: null, mood: [], buttonScale: 1, widen: 1, heighten: 1 };
    for (const [id, re] of THEMES) if (re.test(t)) { it.theme = id; break; }
    const q = raw.match(/["“”']([^"“”']{2,40})["“”']/); if (q) it.title = q[1].trim();
    const nm = raw.match(/\b(?:called|named|titled|title[d]?\s*[:=]?)\s+([A-Z][\w' !&-]{1,30}?)(?=[,.;]|\s+(?:with|and|that|which|in|for|on)\b|$)/); if (!it.title && nm) it.title = nm[1].trim();
    // counts: "6 items", "four tabs", "3 buttons"
    const cre = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|a few|several|couple of)\s+(?:big |large |small |nice )?(tabs?|buttons?|(?:[a-z-]+ )?(?:items?|cards?|products?|slots?|pets?|skins?|packs?|deals?|entries|rows?|players?|quests?|rewards?|options?|friends?|messages?|servers?|classes|modes|maps|teams|tiers?|levels?|badges?|achievements?|listings?|recipes?|weapons?|skills?|emotes?|offers?|days?|stages?|lines?))\b/g;
    let m; while ((m = cre.exec(t))) { const n = num(m[1].replace(/^a |^couple of$/, (s) => s.trim() === "a" ? "a" : "couple")) ; const noun = m[2]; const k = /^tabs?$/.test(noun) ? "tabs" : /^buttons?$/.test(noun) ? "buttons" : "items"; if (n != null && n >= 1 && n <= 24) it.counts[k] = n; }
    // explicit lists: "tabs: Weapons, Pets, Gamepasses", "buttons Play, Shop and Quit", "items like Sword, Shield"
    const lre = /\b(tabs?|buttons?|items?|options?|categories|pages|modes|classes|teams|rows|entries|slots)\s*(?:named|called|labell?ed|like|such as|of|are|=|:|-)?\s*((?:[A-Z][\w'+&$ ]{0,18})(?:\s*(?:,|\/|\band\b|&)\s*[A-Z][\w'+&$ ]{0,18}){1,11})/g;
    while ((m = lre.exec(raw))) { const k = /^tabs?$/i.test(m[1]) ? "tabs" : /^buttons?$/i.test(m[1]) ? "buttons" : "items"; const list = m[2].split(/\s*(?:,|\/|\band\b|&)\s*/).map((s) => s.trim()).filter((s) => s && /^[A-Z]/.test(s) && s.length <= 20); if (list.length >= 2) { it.lists[k] = list.slice(0, 12); if (!it.counts[k]) it.counts[k] = it.lists[k].length; } }
    for (const [id, re] of PLACES) if (re.test(t)) { it.placement = id; break; }
    if (/\b(small|compact|mini|tiny|little)\b/.test(t)) it.scale = 0.85; if (/\b(big|bigger|large|larger|huge|giant|enlarge|scale up)\b(?! (text|font|buttons?|letters))/.test(t) || /\btoo small\b(?! (text|font))/.test(t)) it.scale = 1.15; if (/\b(smaller|shrink|scale down|too big|too large)\b(?! (text|font))/.test(t)) it.scale = 0.87; if (/\b(full ?screen|whole screen)\b/.test(t)) it.scale = 1;
    if (/\b(big|large|huge|readable) (text|font|letters)\b|\btext (bigger|larger)\b/.test(t)) it.textScale = 1.15; if (/\b(small|tiny) (text|font)\b/.test(t)) it.textScale = 0.9;
    if (/\b(big|large|huge) buttons?\b/.test(t)) it.buttonScale = 1.2;
    if (/\b(phone|mobile|touch|ios|android)\b/.test(t)) it.device = "phone"; else if (/\btablet|ipad\b/.test(t)) it.device = "tablet"; else if (/\b(desktop|pc|console)\b/.test(t)) it.device = "desktop";
    for (const [id, re] of EXTRAS) { if (!re.test(t)) continue; const neg = new RegExp("\\b(no|without|remove|hide|don'?t (want|need|add))\\s+(a |the |any )?(" + re.source.replace(/\\b/g, "") + ")", "i"); if (neg.test(t)) it.removes.push(id); else it.extras.push(id); }
    if (/\b(spacious|airy|breathing room|more space|roomy)\b/.test(t)) it.gap = 6; if (/\b(dense|tight|compact|packed)\b/.test(t)) it.gap = -3;
    if (/\b(rounded|rounder|round corners|pill|soft corners|bubbly)\b/.test(t)) it.corner = 18; if (/\b(sharp|square|squared|boxy|hard corners|no rounding)\b/.test(t)) it.corner = 2;
    for (const w of ["minimal", "fancy", "premium", "playful", "serious", "professional", "cozy", "cute", "epic"]) if (new RegExp("\\b" + w + "\\b").test(t)) it.mood.push(w);
    return it;
  }

  // ── template ranking ───────────────────────────────────────────────────────
  function rank(input, env) {
    const it = typeof input === "string" ? parseIntent(input) : input;
    const lib = env && env.templates; const list = (lib && lib.list) || [];
    const t = " " + it.text + " "; const ws = new Set(words(it.text));
    const out = [];
    for (const tp of list) {
      let s = 0; const why = [];
      let best = 0; for (const ph of (SYN[tp.id] || [])) if (t.includes(ph)) { const v = ph.includes(" ") ? 5 : 3; if (v > best) best = v; why.push(ph); } s += best; // longest matching phrase only - no double credit for "loading screen" + "loading"
      for (const w of words(tp.label)) if (w.length > 2 && ws.has(w) && !GENERIC.has(w)) { s += 2; why.push(w); }
      let tagHits = 0; for (const tag of tp.tags || []) for (const w of words(tag)) if (w.length > 2 && ws.has(w)) { s += 1; tagHits++; why.push(tag); }
      if (tagHits >= 2) s += 3; // covers several of the asks (a "settings" screen for "audio and graphics" beats the audio-only one)
      for (const w of words(tp.screen || "")) if (w.length > 3 && ws.has(w)) s += 1;
      for (const w of (CAT_WORDS[tp.cat] || [])) if (ws.has(w)) s += 1;
      const mobileWord = !!it.device && it.device === "phone"; if (tp.cat === "mobile") s += mobileWord ? 3 : -3; else if (mobileWord && /hud|shop|popup|quest|drawer|menu/.test(tp.id)) s += 0;
      if (tp.featured) s += 0.25;
      if (s > 0) out.push({ id: tp.id, label: tp.label, cat: tp.cat, preset: tp.preset, screen: tp.screen, score: s, why: [...new Set(why)].slice(0, 4) });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return out;
  }

  // ── node helpers ───────────────────────────────────────────────────────────
  const kids = (n) => (n && Array.isArray(n.children) ? n.children : []);
  const walk = (list, fn, parent) => { for (const n of list || []) { if (fn(n, parent) === false) continue; walk(kids(n), fn, n); } };
  const isText = (n) => /^(TextLabel|TextButton|TextBox)$/.test(n.class || "");
  const fullScreen = (n) => Array.isArray(n.size) && n.size[0] >= 0.98 && n.size[2] >= 0.98;
  const panelLike = (n) => !fullScreen(n) && /^(Frame|ScrollingFrame|CanvasGroup)$/.test(n.class) && Array.isArray(n.size) && n.size[1] > 120 && n.size[3] > 80 && n.visible !== false;
  // The "window" of a screen: the first sizeable panel at the root, or the panel inside a full-screen dim / backdrop.
  const mainRoot = (nodes) => nodes.find(panelLike) || nodes.filter(fullScreen).flatMap(kids).find(panelLike) || nodes.find((n) => n.class === "Frame" && kids(n).length) || nodes[0] || null;
  const uniqueIn = (list, base) => { let name = base, i = 2; while (list.some((n) => n.name === name)) name = base + i++; return name; };
  // Repeat groups: a container whose children (≥2) share class and size - cards, slots, tabs, rows, buttons.
  function groups(nodes) {
    const out = [];
    walk(nodes, (n) => {
      const ch = kids(n).filter((c) => c.visible !== false); if (ch.length < 2) return;
      const listy = !!(n.layout && /^(list|grid)$/.test(n.layout.kind || "")); // laid-out children group by class alone (a taller PLAY above Shop / Settings is still one button group)
      const key = (c) => c.class + "|" + (listy ? "" : JSON.stringify(c.size || null));
      const by = new Map(); for (const c of ch) { const k = key(c); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
      for (const [, arr] of by) {
        if (arr.length < 2) continue;
        const first = arr[0]; const tab = arr.every((c) => (c.actions || []).some((a) => a.do === "tab")) || arr.every((c) => /^Tab_/.test(c.name || ""));
        const kind = tab ? "tabs" : (first.class === "TextButton" && !kids(first).length) ? "buttons" : "items";
        out.push({ parent: n, items: arr, kind, layout: n.layout && n.layout.kind, depth: 0 });
      }
    });
    return out;
  }
  function pickGroup(nodes, kind) {
    const gs = groups(nodes).filter((g) => g.kind === kind);
    if (!gs.length && kind === "items") return groups(nodes).filter((g) => g.kind !== "tabs").sort((a, b) => b.items.length - a.items.length)[0] || null;
    if (!gs.length && kind === "tabs") return groups(nodes).filter((g) => g.kind === "buttons" && /nav|tab|categor|side|menu/i.test(g.parent.name || "")).sort((a, b) => b.items.length - a.items.length)[0] || null;
    // the biggest group of that kind (most items; then largest area)
    return gs.sort((a, b) => b.items.length - a.items.length || area(b.items[0]) - area(a.items[0]))[0] || null;
  }
  const area = (n) => Array.isArray(n.size) ? Math.max(1, n.size[1]) * Math.max(1, n.size[3]) : 0;
  const stripNum = (s) => String(s || "").replace(/\s*\d+$/, "");
  // "3. Noob123 — 9,870" → "5. Player 5 — 0"; "Item 3" → "Item 5"; "Sword" → "Sword 5"
  const nextLabel = (text, i) => { const t = String(text || ""); if (/^\d+\.\s/.test(t)) return `${i + 1}. ${t.replace(/^\d+\.\s*/, "").replace(/^[^—–-]+/, "Player " + (i + 1) + " ").replace(/\s+/g, " ").trim()}`; if (/\s\d+$/.test(t)) return `${stripNum(t)} ${i + 1}`; return `${t || "Item"} ${i + 1}`; };
  function retitle(node, label, idx) {
    // rename the item + its first title-ish label; keep behaviour targets intact
    const t = kids(node).find((c) => c.class === "TextLabel" && /^(Title|Label|Name|Text|T|L)$/i.test(c.name || "")) || kids(node).find((c) => c.class === "TextLabel");
    const caps = (orig) => (/^[A-Z0-9 !.'&-]+$/.test(orig || "") && /[A-Z]{2}/.test(orig || "") ? label.toUpperCase() : label);
    if (t) t.text = caps(t.text); else if (isText(node) && node.text) node.text = /^\d+\.\s/.test(node.text) ? `${idx + 1}. ${label}` : caps(node.text);
    const safe = label.replace(/[^A-Za-z0-9]+/g, "");
    if (safe) node.name = (/^Tab_/.test(node.name || "") ? "Tab_" : /^Page_/.test(node.name || "") ? "Page_" : "") + safe;
  }
  function setCount(nodes, kind, n, labels, notes) {
    const g = pickGroup(nodes, kind); if (!g) { notes.push({ level: "warn", text: `No ${kind} group to resize - the chosen screen has no repeated ${kind}.` }); return false; }
    const list = g.parent.children; const items = g.items;
    if (items.length > n) { const drop = items.slice(n); g.parent.children = list.filter((c) => !drop.includes(c)); }
    else if (items.length < n) {
      const last = items[items.length - 1]; const at = list.indexOf(last);
      const added = [];
      for (let i = items.length; i < n; i++) { const c = clone(last); const pm = String(last.name || "").match(/^([A-Za-z]+_)\d+/); c.name = uniqueIn(list.concat(added), pm ? pm[1] + (i + 1) : (stripNum(last.name) || "Item") + (i + 1)); walk([c], (x) => { if (x !== c && isText(x) && /\b(\d+)\s*$/.test(x.text || "") && /^(Key|Num|Index|N)$/i.test(x.name || "")) x.text = String(i + 1); }); const tl = kids(c).find((x) => x.class === "TextLabel" && /^(Title|Label|Name|T)$/i.test(x.name || "")); if (tl && !labels) tl.text = nextLabel(tl.text, i); else if (!kids(c).length && isText(c) && !labels) c.text = nextLabel(c.text, i); added.push(c); }
      list.splice(at + 1, 0, ...added);
    }
    if (labels && labels.length) { const now = pickGroup(nodes, kind); if (now) now.items.forEach((c, i) => { if (labels[i]) retitle(c, labels[i], i); }); }
    // tabs: keep pages in step with the tab bar (name Page_X)
    if (kind === "tabs") {
      const pagesHost = findByName(nodes, "Pages"); const tabsNow = pickGroup(nodes, "tabs");
      if (pagesHost && tabsNow) { const pages = kids(pagesHost); const tpl = pages[pages.length - 1] || null; const want = tabsNow.items.map((tb) => (tb.name || "").replace(/^Tab_/, "")); pagesHost.children = want.map((nm, i) => { const ex = pages[i]; if (ex) { ex.name = "Page_" + nm; const h = kids(ex).find((c) => /^Hint$/.test(c.name || "")); if (h) h.text = nm + " page"; return ex; } const p = tpl ? clone(tpl) : { class: "Frame", name: "Page_" + nm, size: [1, 0, 1, 0], bg_t: 1, children: [] }; p.name = "Page_" + nm; p.visible = false; const h = kids(p).find((c) => /^Hint$/.test(c.name || "")); if (h) h.text = nm + " page"; return p; }); tabsNow.items.forEach((tb) => { for (const a of tb.actions || []) if (a.do === "tab" && a.page) a.page = String(a.page).replace(/Page_[A-Za-z0-9]+/, "Page_" + (tb.name || "").replace(/^Tab_/, "")); }); }
    }
    // a grid / list parent with a fixed offset height can overflow: grow it a little for big counts
    if (n > items.length && g.parent && Array.isArray(g.parent.size) && g.layout === "list" && g.parent.size[2] === 0) { const per = (items[0].size && items[0].size[3]) || 40; const gap = (g.parent.layout && g.parent.layout.gap) || 8; g.parent.size[3] = Math.max(g.parent.size[3], n * (per + gap)); }
    return true;
  }
  const findByName = (nodes, name) => { let hit = null; walk(nodes, (n) => { if (!hit && n.name === name) hit = n; }); return hit; };
  function setTitle(nodes, title, notes) {
    const root = mainRoot(nodes) || nodes[0]; if (!root) return;
    let t = null; walk([root], (n, p) => { if (!t && n.class === "TextLabel" && (/^(Title|T|Heading|Header)$/i.test(n.name || "") || (p && /TitleBar|Header/.test(p.name || "")))) t = n; });
    if (!t) walk(nodes, (n) => { if (!t && n.class === "TextLabel" && (n.text_size || 14) >= 20) t = n; });
    if (t) { t.text = /^[A-Z0-9 !.'&-]+$/.test(t.text || "") && (t.text || "").length > 3 ? title.toUpperCase() : title; }
    else notes.push({ level: "info", text: "No title label in this screen - the title went to the ScreenGui name only." });
  }
  const ANCHORS = { "top-left": [[0, 16, 0, 16], [0, 0]], "top-right": [[1, -16, 0, 16], [1, 0]], "bottom-left": [[0, 16, 1, -16], [0, 1]], "bottom-right": [[1, -16, 1, -16], [1, 1]], top: [[0.5, 0, 0, 16], [0.5, 0]], bottom: [[0.5, 0, 1, -16], [0.5, 1]], left: [[0, 16, 0.5, 0], [0, 0.5]], right: [[1, -16, 0.5, 0], [1, 0.5]], center: [[0.5, 0, 0.5, 0], [0.5, 0.5]] };
  function place(nodes, where, notes) {
    const root = mainRoot(nodes); const a = ANCHORS[where]; if (!root || !a) return false;
    if (fullScreen(root)) { notes.push({ level: "info", text: "Full-screen layout - placement ignored." }); return false; }
    root.position = a[0].slice(); root.anchor = a[1].slice(); return true;
  }
  function scaleRoot(nodes, f, wf, hf) {
    const root = mainRoot(nodes); if (!root || fullScreen(root) || !Array.isArray(root.size)) return false;
    root.size = [root.size[0], Math.round(root.size[1] * f * (wf || 1)), root.size[2], Math.round(root.size[3] * f * (hf || 1))];
    // offset-sized direct children of a scaled window would overflow / underfill: nudge the body grid cells with the same factor
    walk([root], (n) => { if (n.layout && n.layout.kind === "grid" && Array.isArray(n.layout.cell) && f !== 1) n.layout.cell = [n.layout.cell[0], Math.round(n.layout.cell[1] * f), n.layout.cell[2], Math.round(n.layout.cell[3] * f)]; });
    return true;
  }
  function scaleText(nodes, f) { walk(nodes, (n) => { if (isText(n)) n.text_size = Math.max(8, Math.round((n.text_size || 14) * f)); }); }
  function scaleButtons(nodes, f) { walk(nodes, (n) => { if (n.class === "TextButton" && Array.isArray(n.size) && n.size[3] > 0 && n.size[3] < 120) { n.size = [n.size[0], n.size[0] ? n.size[1] : Math.round(n.size[1] * f), n.size[2], Math.round(n.size[3] * f)]; n.text_size = Math.round((n.text_size || 14) * Math.min(f, 1.15)); } }); }
  function spacing(nodes, d) { walk(nodes, (n) => { if (n.layout && n.layout.gap != null) n.layout.gap = Math.max(0, n.layout.gap + d); else if (n.layout) n.layout.gap = Math.max(0, 8 + d); if (typeof n.padding === "number") n.padding = Math.max(0, n.padding + d); }); }
  function corners(nodes, r) { walk(nodes, (n) => { if (typeof n.corner === "number" && n.corner > 0 && n.corner < 40) n.corner = r; }); }
  function removeMatching(nodes, word) {
    const w = lc(word).replace(/\s+/g, ""); let hits = 0;
    const prune = (list) => list.filter((n) => { const hit = lc(n.name).replace(/\s+/g, "").includes(w) || (isText(n) && lc(n.text).replace(/\s+/g, "").includes(w)); if (hit) hits++; else if (n.children) n.children = prune(n.children); return !hit; });
    return { nodes: prune(nodes), hits };
  }
  function hasClose(root) { let f = false; walk([root], (n) => { if ((n.actions || []).some((a) => a.do === "close") || /^Close$/i.test(n.name || "")) f = true; }); return f; }
  function addClose(nodes, env) {
    const root = mainRoot(nodes); if (!root || hasClose(root)) return false;
    const bar = kids(root).find((c) => /TitleBar|Header/.test(c.name || "")) || root;
    (bar.children = bar.children || []).push({ class: "TextButton", name: "Close", text: "×", size: [0, 30, 0, 30], position: [1, -8, 0, 8], anchor: [1, 0], bg: "danger", text_color: "auto", font: "title_font", text_size: 18, corner: 8, actions: [{ on: "click", do: "close", target: bar === root ? "parent" : "parent.parent" }, { on: "hover", do: "hover_grow" }] });
    return true;
  }
  function addSearch(nodes) {
    const root = mainRoot(nodes); if (!root) return false;
    const bar = kids(root).find((c) => /TitleBar|Header/.test(c.name || ""));
    const host = bar || root; const w = Math.min(200, Math.round(((root.size && root.size[1]) || 400) * 0.35));
    (host.children = host.children || []).push({ class: "TextBox", name: "Search", text: "", placeholder: "Search…", size: [0, w, 0, 30], position: [1, -48, 0.5, 0], anchor: [1, 0.5], bg: "bg", text_color: "text", text_size: 13, corner: 8, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, padding: { left: 10, right: 10 }, align_x: "Left" });
    if (!bar) { const t = kids(root).find((c) => c.class === "TextLabel"); if (t) t.size = [1, -w - 60, t.size ? t.size[2] : 0, t.size ? t.size[3] : 28]; }
    return true;
  }
  function addTimer(nodes) { nodes.push({ class: "Frame", name: "Timer", size: [0, 140, 0, 40], position: [0.5, 0, 0, 16], anchor: [0.5, 0], bg: "surface", bg_t: 0.08, corner: 20, stroke: { color: "stroke", thickness: 1, transparency: "stroke_t" }, children: [{ class: "TextLabel", name: "Time", text: "05:00", size: [1, 0, 1, 0], bg_t: 1, text_color: "text", font: "title_font", text_size: 16, attrs: { OR_Timer: true } }] }); return true; }
  function addCurrency(nodes, env) { const c = env && env.comp ? env.comp("currency_hud", { name: "Coins", label: "1,250", stat: "Coins" }) : null; if (!c) return false; if (!c.position) c.position = [1, -16, 0, 16]; nodes.push(c); return true; }
  function addAvatar(nodes, env) { const a = env && env.comp ? env.comp("avatar", { name: "Avatar" }) : null; if (!a) return false; a.position = [0, 16, 0, 16]; nodes.push(a); return true; }
  function addProgress(nodes, env) { const root = mainRoot(nodes); const b = env && env.comp ? env.comp("progress_bar", { name: "Progress", value: 0.6 }) : null; if (!b) return false; if (root && !fullScreen(root)) { b.size = [1, -32, 0, 14]; b.position = [0, 16, 1, -14]; b.anchor = [0, 1]; (root.children = root.children || []).push(b); } else { b.size = [0, 320, 0, 14]; b.position = [0.5, 0, 1, -24]; b.anchor = [0.5, 1]; nodes.push(b); } return true; }
  function addBack(nodes) { const root = mainRoot(nodes) || nodes[0]; if (!root) return false; (root.children = root.children || []).push({ class: "TextButton", name: "Back", text: "◀ Back", size: [0, 96, 0, 34], position: [0, 12, 1, -12], anchor: [0, 1], bg: "surface2", text_color: "text", font: "title_font", text_size: 13, corner: 8, actions: [{ on: "click", do: "close", target: "parent" }, { on: "hover", do: "hover_grow" }] }); return true; }
  function addFooter(nodes) { const root = mainRoot(nodes); if (!root || fullScreen(root)) return false; if (kids(root).filter((c) => c.class === "TextButton" && !/^Close$/i.test(c.name || "")).length >= 2 || kids(root).some((c) => /^Footer$/i.test(c.name || ""))) return true; (root.children = root.children || []).push({ class: "Frame", name: "Footer", size: [1, -32, 0, 44], position: [0.5, 0, 1, -12], anchor: [0.5, 1], bg_t: 1, layout: { kind: "list", direction: "Horizontal", gap: 10, h_align: "Right", v_align: "Center" }, children: [{ class: "TextButton", name: "Cancel", text: "Cancel", size: [0, 120, 0, 40], bg: "surface2", text_color: "text", font: "title_font", text_size: 14, corner: "radius", actions: [{ on: "click", do: "close", target: "parent.parent" }] }, { class: "TextButton", name: "Confirm", text: "OK", size: [0, 120, 0, 40], bg: "primary", text_color: "auto", font: "title_font", text_size: 14, corner: "radius", actions: [{ on: "click", do: "remote", remote: "Confirm" }] }] }); return true; }

  const titleCase = (s) => String(s || "").replace(/\b([a-z])/g, (m) => m.toUpperCase());
  function titleFromPrompt(prompt) {
    let t = String(prompt || "").split(/[,.;]| with | that | which | containing /i)[0] || "";
    t = t.replace(/^\s*(please\s+)?(make|create|build|design|generate|give me|i want|i need|show)\s+(me\s+)?/i, "").replace(/^(a|an|the)\s+/i, "").replace(/^(simple|nice|basic|cool|new)\s+/i, "").replace(/^(window|screen|ui|gui|panel|menu|frame|popup|dialog)\s+(for|to|of|about)\s+/i, "").replace(/\s+(window|screen|ui|gui|panel|frame)$/i, "").trim();
    if (t.length > 28) { t = t.slice(0, 28); t = t.replace(/\s+\S*$/, ""); }
    return titleCase(t) || "Window";
  }
  // Generic window when nothing in the library fits.
  function customWindow(it, env) {
    const title = it.title || titleFromPrompt(it.prompt);
    const C = env && env.comp; const w = C ? C("window", { name: title.replace(/[^A-Za-z0-9]+/g, "") || "Window", label: title }) : { class: "Frame", name: "Window", size: [0, 480, 0, 340], bg: "surface", corner: 14, position: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], children: [{ class: "TextLabel", name: "Title", text: title, size: [1, -60, 0, 44], position: [0, 16, 0, 0], text_color: "text", font: "title_font", text_size: 18, bg_t: 1, align_x: "Left" }, { class: "Frame", name: "Body", size: [1, -24, 1, -68], position: [0, 12, 0, 56], bg_t: 1, layout: { kind: "list", gap: 8 } }] };
    w.size = [0, 480, 0, 340];
    const body = kids(w).find((c) => c.name === "Body") || w; body.layout = { kind: "list", gap: 8 }; body.children = [];
    const items = it.lists.items || it.lists.buttons || null; const n = it.counts.items || it.counts.buttons || (items ? items.length : 3);
    for (let i = 0; i < Math.min(12, n); i++) body.children.push({ class: "TextButton", name: ((items && items[i]) || ("Option " + (i + 1))).replace(/[^A-Za-z0-9]+/g, ""), text: (items && items[i]) || ("Option " + (i + 1)), size: [1, 0, 0, 40], bg: i === 0 ? "primary" : "surface2", text_color: i === 0 ? "auto" : "text", font: "title_font", text_size: 14, corner: "radius", actions: [{ on: "hover", do: "hover_grow" }] });
    return { nodes: [w], screen: (title.replace(/[^A-Za-z0-9]+/g, "") || "Window"), preset: "midnight", label: "Custom window" };
  }

  // ── generation ─────────────────────────────────────────────────────────────
  function themeFamilyNext(preset, take) { const fam = LIGHT.includes(preset) ? LIGHT : DARK; const i = fam.indexOf(preset); return fam[(Math.max(0, i) + take) % fam.length]; }
  function generate(input, opts, env) {
    const o = opts || {}; env = env || {};
    const it = typeof input === "string" ? parseIntent(input) : clone(input);
    const take = Math.max(0, o.take | 0); const notes = []; const applied = [];
    const ranked = rank(it, env);
    let pick = null; let viaCustom = false;
    if (ranked.length && ranked[0].score >= 3) {
      const best = ranked[0].score; const close = ranked.filter((r) => r.score >= best - 3);
      pick = (take && close.length > 1) ? close[take % close.length] : ranked[0];
      if (take && close.length <= 1) notes.push({ level: "info", text: `Only one screen fits "${it.prompt.slice(0, 40)}" - variation ${take} changes the theme instead.` });
      if (best < 5) notes.push({ level: "info", text: `Closest library screen: "${pick.label}" (matched: ${pick.why.join(", ") || "category"}). Name the kind of screen (shop, inventory, settings, HUD, popup…) if this is not it.` });
    } else if (ranked.length) notes.push({ level: "warn", text: `No library screen really fits - built a plain window (closest was "${ranked[0].label}"). Say what kind of screen it is (shop, inventory, settings, HUD, popup…) to start from a finished design.` });
    let nodes, screen, preset, label, templateId = null;
    if (pick && env.templates && typeof env.templates.build === "function") {
      try { nodes = env.templates.build(pick.id, env.comp || (() => ({ class: "Frame", name: "Missing" }))); } catch (e) { nodes = null; notes.push({ level: "warn", text: "Template failed to build: " + (e && e.message || e) }); }
      if (nodes && nodes.length) { nodes = clone(nodes); screen = pick.screen; preset = pick.preset; label = pick.label; templateId = pick.id; applied.push(`screen: ${pick.label}`); }
    }
    if (!nodes || !nodes.length) { const cw = customWindow(it, env); nodes = cw.nodes; screen = cw.screen; preset = cw.preset; label = cw.label; viaCustom = true; applied.push("screen: custom window (no library match)"); if (!ranked.length) notes.push({ level: "info", text: "Nothing in the library matched - built a plain window from your words. Add the kind of screen (shop, HUD, settings…) to start from a finished design." }); }
    // theme
    if (it.theme && (!env.presets || env.presets[it.theme])) { preset = it.theme; applied.push("theme: " + it.theme.replace(/_/g, " ")); }
    if (take && (!ranked.length || ranked.filter((r) => r.score >= ranked[0].score - 3).length <= 1)) { preset = themeFamilyNext(preset, take); applied.push("variation theme: " + preset.replace(/_/g, " ")); }
    // lists / counts
    for (const k of ["items", "tabs", "buttons"]) { if (it.counts[k] || (it.lists[k] && it.lists[k].length)) { const n = it.counts[k] || it.lists[k].length; if (setCount(nodes, k, n, it.lists[k] || null, notes)) applied.push(`${n} ${k}${it.lists[k] ? " (" + it.lists[k].slice(0, 4).join(", ") + (it.lists[k].length > 4 ? "…" : "") + ")" : ""}`); } }
    if (it.title) { setTitle(nodes, it.title, notes); screen = it.title.replace(/[^A-Za-z0-9]+/g, "") || screen; applied.push(`title: ${it.title}`); }
    if (it.scale !== 1 && scaleRoot(nodes, it.scale, it.widen, it.heighten)) applied.push(it.scale > 1 ? "bigger window" : "smaller window"); else if ((it.widen !== 1 || it.heighten !== 1) && scaleRoot(nodes, 1, it.widen, it.heighten)) applied.push((it.widen !== 1 ? (it.widen > 1 ? "wider" : "narrower") : "") + (it.heighten !== 1 ? (it.heighten > 1 ? " taller" : " shorter") : ""));
    if (it.placement && place(nodes, it.placement, notes)) applied.push("placed " + it.placement);
    if (it.textScale !== 1) { scaleText(nodes, it.textScale); applied.push(it.textScale > 1 ? "bigger text" : "smaller text"); }
    if (it.buttonScale !== 1) { scaleButtons(nodes, it.buttonScale); applied.push("bigger buttons"); }
    if (it.gap) { spacing(nodes, it.gap); applied.push(it.gap > 0 ? "more spacing" : "tighter spacing"); }
    if (it.corner != null) { corners(nodes, it.corner); applied.push(it.corner >= 12 ? "rounder corners" : "sharper corners"); }
    for (const x of it.extras) { let ok = false; if (x === "close") ok = addClose(nodes, env) || hasClose(mainRoot(nodes) || {}); else if (x === "search") ok = addSearch(nodes); else if (x === "timer") ok = addTimer(nodes); else if (x === "currency") ok = addCurrency(nodes, env); else if (x === "avatar") ok = addAvatar(nodes, env); else if (x === "progress") ok = addProgress(nodes, env); else if (x === "back") ok = addBack(nodes); else if (x === "footer") ok = addFooter(nodes); if (ok) applied.push("+ " + x); else notes.push({ level: "info", text: `Could not add ${x} here.` }); }
    for (const r of it.removes) { const res = removeMatching(nodes, r === "close" ? "Close" : r); nodes = res.nodes; if (res.hits) applied.push("− " + r); }
    for (const rm of it.removeWords || []) { const res = removeMatching(nodes, rm); nodes = res.nodes; if (res.hits) applied.push("− " + rm); }
    // default: windows get a close button if they lack one (the user can say "no close button")
    if (!viaCustom && !it.removes.includes("close") && mainRoot(nodes) && !fullScreen(mainRoot(nodes)) && !hasClose(mainRoot(nodes)) && kids(mainRoot(nodes)).some((c) => /TitleBar|Header/.test(c.name || ""))) { if (addClose(nodes, env)) applied.push("+ close (windows always get one)"); }
    // device hint
    if (it.device) applied.push("device: " + it.device);
    // names: unique roots
    { const seen = new Set(); for (const c of nodes) { if (seen.has(c.name)) c.name = uniqueIn(nodes.filter((x) => x !== c), c.name); seen.add(c.name); } }
    let count = 0; walk(nodes, () => { count++; });
    const errors = notes.filter((n) => n.level === "error").length, warns = notes.filter((n) => n.level === "warn").length, infos = notes.length - errors - warns;
    const score = Math.max(0, Math.min(100, 100 - 25 * errors - 8 * warns - 2 * infos - (viaCustom ? 10 : 0)));
    const name = (o.name || screen || "GUI") + (take ? "_v" + (take + 1) : "");
    return { v: 1, engine: VERSION, name, prompt: it.prompt, intent: it, templateId, templateLabel: label, preset, screen, device: it.device || null, nodes, count, report: { score, notes, matched: ranked.slice(0, 5).map((r) => ({ id: r.id, label: r.label, score: r.score })) }, feedback: o.feedback ? clone(o.feedback) : [], take, applied };
  }

  // ── feedback ───────────────────────────────────────────────────────────────
  // Returns { intent, applied[] } - the feedback folded into a copy of the intent.
  function applyFeedback(intent, text) {
    const it = clone(intent); const t = " " + lc(text).replace(/\s+/g, " ") + " "; const applied = [];
    const fb = parseIntent(text);
    if (fb.theme) { it.theme = fb.theme; applied.push("theme " + fb.theme); }
    else if (/\b(darker|dark mode|too bright)\b/.test(t)) { it.theme = LIGHT.includes(it.theme) || !it.theme ? "midnight" : "horror"; applied.push("darker theme"); }
    else if (/\b(lighter|brighter|light mode|too dark)\b/.test(t)) { it.theme = "clean_light"; applied.push("lighter theme"); }
    else if (/\b(another|different|other|change the|new) (theme|colou?rs?|look|style|palette)\b/.test(t)) { it._nextTheme = true; applied.push("next theme"); }
    if (fb.title) { it.title = fb.title; applied.push("title " + fb.title); }
    const ren = text.match(/\b(?:rename|call|title)\s+(?:it|the title|the window|the screen)?\s*(?:to|as)?\s*["“']?([A-Z][\w' !&-]{1,28}?)["”']?\s*$/); if (ren && !fb.title) { it.title = ren[1].trim(); applied.push("title " + it.title); }
    for (const k of ["items", "tabs", "buttons"]) if (fb.counts[k]) { it.counts[k] = fb.counts[k]; applied.push(fb.counts[k] + " " + k); }
    for (const k of ["items", "tabs", "buttons"]) if (fb.lists[k]) { it.lists[k] = fb.lists[k]; it.counts[k] = fb.lists[k].length; applied.push(k + ": " + fb.lists[k].join(", ")); }
    const more = t.match(/\b(more|extra|additional|add (?:some|a few|two|three|\d+)?) (items|cards|slots|rows|tabs|buttons|options|entries|products)\b/); if (more && !fb.counts.items && !fb.counts.tabs && !fb.counts.buttons) { const k = /tab/.test(more[2]) ? "tabs" : /button/.test(more[2]) ? "buttons" : "items"; const by = num((more[1].match(/\d+|two|three/) || ["2"])[0]) || 2; it.counts[k] = (it.counts[k] || it._lastCounts && it._lastCounts[k] || 4) + by; applied.push("+" + by + " " + k); }
    const fewer = t.match(/\b(fewer|less|remove (?:some|a few|two|three|\d+)?) (items|cards|slots|rows|tabs|buttons|options|entries|products)\b/); if (fewer) { const k = /tab/.test(fewer[2]) ? "tabs" : /button/.test(fewer[2]) ? "buttons" : "items"; const by = num((fewer[1].match(/\d+|two|three/) || ["2"])[0]) || 2; it.counts[k] = Math.max(1, (it.counts[k] || it._lastCounts && it._lastCounts[k] || 4) - by); applied.push("-" + by + " " + k); }
    if (fb.scale !== 1 && !/\b(text|font|buttons?) (bigger|larger|smaller)\b/.test(t)) { it.scale = +((it.scale || 1) * (fb.scale > 1 ? 1.15 : 1 / 1.15)).toFixed(3); applied.push(fb.scale > 1 ? "bigger" : "smaller"); }
    if (/\bwider\b/.test(t)) { it.widen = +((it.widen || 1) * 1.2).toFixed(3); applied.push("wider"); } if (/\bnarrower\b/.test(t)) { it.widen = +((it.widen || 1) / 1.2).toFixed(3); applied.push("narrower"); }
    if (/\btaller\b/.test(t)) { it.heighten = +((it.heighten || 1) * 1.2).toFixed(3); applied.push("taller"); } if (/\bshorter\b/.test(t)) { it.heighten = +((it.heighten || 1) / 1.2).toFixed(3); applied.push("shorter"); }
    if (fb.textScale !== 1) { it.textScale = +((it.textScale || 1) * fb.textScale).toFixed(3); applied.push(fb.textScale > 1 ? "bigger text" : "smaller text"); }
    else if (/\b(text|font|letters) (too small|bigger|larger)\b|\b(bigger|larger) (text|font)\b/.test(t)) { it.textScale = +((it.textScale || 1) * 1.15).toFixed(3); applied.push("bigger text"); }
    if (fb.buttonScale !== 1 || /\bbuttons? (too small|bigger|larger)\b/.test(t)) { it.buttonScale = +((it.buttonScale || 1) * 1.2).toFixed(3); applied.push("bigger buttons"); }
    if (fb.placement) { it.placement = fb.placement; applied.push("move " + fb.placement); }
    else { const mv = t.match(/\b(move|put|place|shift) (it|the (window|panel|frame|menu|hud|bar))? ?(to the |to |on the |in the )?(top[- ]?left|top[- ]?right|bottom[- ]?left|bottom[- ]?right|top|bottom|left|right|center|centre|middle)\b/); if (mv) { it.placement = mv[5].replace(/\s/g, "-").replace(/centre|middle/, "center"); applied.push("move " + it.placement); } }
    if (fb.gap || /\bmore (spacing|space|padding|gap)\b|\bspread (them )?out\b/.test(t)) { it.gap = (it.gap || 0) + (fb.gap || 6); applied.push("more spacing"); }
    if (/\bless (spacing|space|padding|gap)\b|\btighter\b|\bcloser together\b/.test(t)) { it.gap = (it.gap || 0) - 4; applied.push("tighter"); }
    if (fb.corner != null) { it.corner = fb.corner; applied.push(fb.corner >= 12 ? "rounder" : "sharper"); }
    for (const x of fb.extras) if (!it.extras.includes(x)) { it.extras.push(x); it.removes = it.removes.filter((r) => r !== x); applied.push("add " + x); }
    for (const x of fb.removes) { const wasExtra = it.extras.includes(x); it.extras = it.extras.filter((e) => e !== x); if (!wasExtra && !it.removes.includes(x)) it.removes.push(x); applied.push("remove " + x); }
    const rm = text.match(/\b(?:remove|delete|drop|get rid of|hide)\s+(?:the\s+)?([A-Za-z][\w ]{1,24}?)(?=\s*(?:,|\.|$|\band\b))/i);
    if (rm && !fb.removes.length && !/\b(items|cards|slots|rows|tabs|buttons|options|entries|products)\b/i.test(rm[1])) { it.removeWords = (it.removeWords || []).concat(rm[1].trim()); applied.push("remove " + rm[1].trim()); }
    if (fb.device) { it.device = fb.device; applied.push("device " + fb.device); }
    return { intent: it, applied };
  }
  function refine(design, text, env) {
    const fbText = String(text || "").trim(); if (!design || !fbText) return design;
    const { intent, applied } = applyFeedback(design.intent, fbText);
    const feedback = (design.feedback || []).concat([{ text: fbText, applied: applied.length ? applied : ["(nothing recognised - try: bigger, darker, 6 items, add a search bar, move it to the top-left, rename it to Shop)"] }]);
    intent._lastCounts = Object.assign({}, design.intent._lastCounts || {}, design.intent.counts || {});
    if (intent._nextTheme) { intent.theme = themeFamilyNext(design.preset, 1); delete intent._nextTheme; }
    const out = generate(intent, { take: design.take || 0, feedback, name: (design.name || "").replace(/_v\d+$/, "") }, env);
    out.applied = out.applied.concat(applied.map((a) => "feedback: " + a));
    const newWords = (intent.removeWords || []).slice((design.intent.removeWords || []).length);
    for (const w of newWords) if (!out.applied.includes("− " + w)) out.report.notes.push({ level: "warn", text: `Nothing named or labelled "${w}" to remove.` });
    return out;
  }
  function variation(design, env) { if (!design) return null; return generate(design.intent, { take: (design.take || 0) + 1, feedback: design.feedback || [], name: (design.name || "").replace(/_v\d+$/, "") }, env); }
  function describe(d) {
    if (!d) return ""; const it = d.intent || {}; const bits = [d.templateLabel || "custom"];
    if (d.preset) bits.push(d.preset.replace(/_/g, " "));
    for (const k of ["items", "tabs", "buttons"]) if (it.counts && it.counts[k]) bits.push(it.counts[k] + " " + k);
    if (it.title) bits.push("“" + it.title + "”"); if (it.placement) bits.push(it.placement); if (it.device) bits.push(it.device);
    for (const x of it.extras || []) bits.push("+" + x);
    if (d.take) bits.push("take " + (d.take + 1));
    return bits.join(" · ");
  }
  const serialize = (d) => JSON.stringify({ format: "orscript-gui-design", version: 1, design: d }, null, 2);
  const parse = (json) => { const o = typeof json === "string" ? JSON.parse(json) : json; const d = o && o.format === "orscript-gui-design" ? o.design : o; if (!d || !Array.isArray(d.nodes)) throw new Error("Not an ORscript GUI design"); return d; };
  const QUICK = ["a dark shop with 6 items and a search bar", "inventory with 12 slots, forest theme", "settings with tabs Gameplay, Audio, Controls", "neon main menu with buttons Play, Shop, Settings, Quit", "RPG HUD with coins display and a timer", "daily rewards popup, candy theme", "leaderboard top-right with 8 rows", "mobile shop with big buttons", "pause menu, rounded, gold theme", "quest log small, bottom-left"];
  window.ORGuiGen = { VERSION, parseIntent, rank, generate, refine, variation, applyFeedback, describe, serialize, parse, QUICK, _test: { groups, pickGroup, setCount, mainRoot, customWindow } };
})();
