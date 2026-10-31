// 1.96.0 — TotalScript Desktop: in-app Help page (Page::Help, F1 / Ctrl+7).
// SOURCE PINS ONLY: cargo is not available here; CI (.github/workflows/desktop.yml)
// compiles the crate. This test proves the page is wired into every registry
// the app keeps for pages (enum, ALL, title, subtitle, shortcut, sidebar group,
// central match, nav icon, Esc handling, Home quick access), that the help
// topics are complete and plain text, and that every fact they state about the
// app is cross-checked against the code that implements it.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };

const gui = read("agent/src/gui.rs"), mainRs = read("agent/src/main.rs"), mainJs = read("src/core/main.js"), readme = read("README.md");

// ── A. page registry ──────────────────────────────────────────────────────
const variants = (gui.match(/enum Page \{ ([^}]+) \}/) || [, ""])[1].split(",").map((s) => s.trim()).filter(Boolean);
ok("A1 Page::Help exists, before Settings (SYSTEM group) and after Terminal", variants.join() === "Home,Chat,Explorer,Tools,Servers,Terminal,Help,Settings");
ok("A2 Page::ALL lists all 8 in the same order", gui.includes("const ALL: [Page; 8] = [Page::Home, Page::Chat, Page::Explorer, Page::Tools, Page::Servers, Page::Terminal, Page::Help, Page::Settings];"));
ok("A3 title / subtitle / shortcut arms (Help = Ctrl+7, Settings moved to Ctrl+8)", gui.includes('Page::Help => "Help",') && /Page::Help => "What every page, button and shortcut does[^"]*\(F1\)",/.test(gui) && gui.includes("Page::Help => egui::Key::Num7,") && gui.includes("Page::Settings => egui::Key::Num8,"));
ok("A4 sidebar: SYSTEM group label now starts at Help; central panel dispatches page_help; nav icon arm present", gui.includes('if page == Page::Help { ui.add_space(8.0); ui.label(RichText::new("SYSTEM")') && gui.includes("Page::Help => self.page_help(ui),") && /Page::Help => \{\s*\/\/ circle with a question mark/.test(gui) && gui.indexOf("Page::Help => self.page_help(ui),") < gui.indexOf("Page::Settings => self.page_settings(ui),"));
ok("A5 F1 opens Help from anywhere; Esc clears the help search", gui.includes("if i.key_pressed(egui::Key::F1) { nav = Some(Page::Help); }") && gui.includes("Page::Help => { self.help_query.clear(); }"));
ok("A6 help_query state declared + initialised", gui.includes("    help_query: String,\n") && gui.includes("            help_query: String::new(),\n"));
ok("A7 Home quick access gained a Help card (array widened to 6, Help first)", gui.includes("let items: [(&str, &str, Page); 6] = [") && /\("Help", "Learn every page, button and shortcut[^"]*", Page::Help\),/.test(gui));
ok("A8 Settings → About keyboard line updated (1…8 pages, F1, Ctrl+J)", gui.includes('"Keyboard: Ctrl+1…8 pages · F1 help · Ctrl+J chat panel · Ctrl+R restart MCP helper · F5 probe Studio + refresh · Ctrl+Shift+S capture Studio viewport · Ctrl+S save file · Ctrl+Enter run Luau"'));
// every exhaustive match over Page has a Help arm (no `_ =>` hides a missing page)
{
  const matchArms = (fnName) => { const i = gui.indexOf(fnName); const j = gui.indexOf("\n    }\n", i); return gui.slice(i, j); };
  ok("A9 every exhaustive Page match names Help (title, subtitle, shortcut_key, nav_icon)", ["fn title(self)", "fn subtitle(self)", "fn shortcut_key(self)"].every((f) => matchArms(f).includes("Page::Help =>")) && gui.slice(gui.indexOf("fn nav_icon(")).includes("Page::Help => {"));
}

// ── B. page_help ──────────────────────────────────────────────────────────
const pageHelp = gui.slice(gui.indexOf("    fn page_help(&mut self, ui: &mut egui::Ui) {"), gui.indexOf("    fn page_settings(&mut self, ui: &mut egui::Ui) {"));
ok("B1 page_help: search box filters title + summary + steps, case-insensitive, with an empty-state line", pageHelp.includes("egui::TextEdit::singleline(&mut self.help_query)") && pageHelp.includes("h.title.to_lowercase().contains(&q) || h.summary.to_lowercase().contains(&q) || h.steps.iter().any(|st| st.to_lowercase().contains(&q))") && pageHelp.includes("if shown.is_empty() {") && pageHelp.includes("Nothing matches"));
ok("B2 page_help: topics render through the existing settings_section card, bullets use the theme accent, 'Open <page>' navigates after the frame (no borrow of self inside the closure)", pageHelp.includes("settings_section(ui, t, h.title, |ui| {") && pageHelp.includes('RichText::new("•").color(t.accent)') && pageHelp.includes('pill(ui, t, &format!("Open {}", p.title()), false)') && pageHelp.includes("goto = Some(p);") && pageHelp.includes("if let Some(p) = goto { self.page = p; }") && !pageHelp.slice(pageHelp.indexOf("settings_section(ui, t, h.title"), pageHelp.indexOf("if let Some(p) = goto")).includes("self."));
ok("B3 page_help: Ctrl+n hover hint derives from Page::ALL (stays right if pages move)", pageHelp.includes("Page::ALL.iter().position(|x| *x == p).map(|i| i + 1)") && pageHelp.includes('on_hover_text(format!("Ctrl+{n}"))'));

// ── C. topics ─────────────────────────────────────────────────────────────
const topicsSrc = gui.slice(gui.indexOf("const HELP_TOPICS: &[HelpTopic] = &["), gui.indexOf("];", gui.indexOf("const HELP_TOPICS: &[HelpTopic] = &[")) + 2);
const topics = [...topicsSrc.matchAll(/HelpTopic \{\s*title: "([^"]+)",\s*page: (None|Some\(Page::(\w+)\)),\s*summary: "((?:[^"\\]|\\.)*)",\s*steps: &\[([\s\S]*?)\n\s*\],\s*\}/g)].map((m) => ({ title: m[1], page: m[3] || null, summary: m[4], steps: [...m[5].matchAll(/"((?:[^"\\]|\\.)*)",/g)].map((x) => x[1]) }));
ok(`C1 struct HelpTopic + ${topics.length} topics parsed (≥ 12), every topic has a summary and ≥ 3 steps`, gui.includes("struct HelpTopic { title: &'static str, page: Option<Page>, summary: &'static str, steps: &'static [&'static str] }") && topics.length >= 12 && topics.every((t) => t.summary.length > 30 && t.steps.length >= 3), topics.map((t) => [t.title, t.steps.length]));
ok("C2 one topic per page (Home, AI Chat, Explorer, Tools, MCP Servers, Terminal, Settings) + start-here, troubleshooting, access, Blender / plugin / extension, shortcuts, rebuild", ["Start here: what this app is", "Home", "AI Chat", "Explorer", "Tools", "MCP Servers", "Terminal", "Settings", "Studio will not link — fix it in order", "Access, safety and what stays on this PC", "Blender, Studio plugin and the browser extension", "Keyboard shortcuts", "Updating and rebuilding"].every((n) => topics.some((t) => t.title === n)));
ok("C3 every page: Some(Page::X) names a real variant, and every page except Help is reachable from at least one topic", topics.every((t) => !t.page || variants.includes(t.page)) && variants.filter((v) => v !== "Help").every((v) => topics.some((t) => t.page === v)));
ok("C4 plain text only (no markdown, no emoji, no HTML) and no secrets / external hosts", topics.every((t) => [t.title, t.summary, ...t.steps].every((s) => !/\*\*|^#+ |<[a-z]+>|https?:\/\/(?!127\.0\.0\.1)/.test(s) && !/[\u{1F300}-\u{1FAFF}]/u.test(s))));
// facts cross-checked with the implementation
const text = topics.flatMap((t) => [t.title, t.summary, ...t.steps]).join("\n");
ok("C5 ports match main.rs / gui.rs (127.0.0.1:3000, ws 17613 roblox, 17615 local)", text.includes("127.0.0.1:3000") && text.includes("17613") && text.includes("17615") && mainRs.includes("([127, 0, 0, 1], 3000)") && gui.includes('"WS 17613 roblox"') && gui.includes('"WS 17615 local"'));
ok("C6 shortcuts topic matches handle_shortcuts + page hints (Ctrl+1…8, F1, Ctrl+J, Ctrl+R, F5, Ctrl+Shift+S, Ctrl+S, Ctrl+Enter, Esc)", (() => { const sc = topics.find((t) => t.title === "Keyboard shortcuts"); const all = [sc.summary, ...sc.steps].join(" "); return ["Ctrl+1 … Ctrl+8", "F1", "Ctrl+J", "Ctrl+R", "F5", "Ctrl+Shift+S", "Ctrl+S", "Ctrl+Enter", "Esc"].every((k) => all.includes(k)) && gui.includes("if i.key_pressed(egui::Key::R) { restart = true; }") && gui.includes("if i.key_pressed(egui::Key::J) { chat = true; }") && gui.includes("if i.modifiers.shift && i.key_pressed(egui::Key::S) { capture = true; }") && gui.includes("if i.key_pressed(egui::Key::F5) { refresh = true; }") && gui.includes('on_hover_text("Ctrl+S")') && /Ctrl\+Enter/.test(gui.slice(0, gui.indexOf("const HELP_TOPICS"))); })());
ok("C7 themes, Explorer 2 MB limit, delete arming, providers and workspace env names match Settings / Explorer / chat code", text.includes("TotalScript Aqua, Gold, Emerald or Graphite") && /\("aqua", "TotalScript Aqua"\), \("gold", "Gold"\), \("emerald", "Emerald"\), \("graphite", "Graphite"\)/.test(gui) && text.includes("Text files up to 2 MB open inline") && gui.includes("Text files up to 2 MB open inline; Ctrl+S saves.") && text.includes("Delete is armed on the first click") && gui.includes("delete_armed") && text.includes("CodeCraft, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, xAI, Mistral, Together, a local Ollama / LM Studio or any OpenAI-compatible endpoint") && gui.includes("Bring your own API key: CodeCraft, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, xAI, Mistral, Together, a local Ollama / LM Studio or any OpenAI-compatible endpoint") && text.includes("TOTAL_WORKSPACE_ROOT") && gui.includes("TOTAL_WORKSPACE_ROOT") && text.includes("TOTAL_MCP_COMMAND") && gui.includes("TOTAL_MCP_COMMAND"));
ok("C8 Studio setup wording matches the app and the extension (Assistant → ⋯ → Manage MCP Servers → Studio as MCP server; plugin Allow prompt; Start MCP Server / Connect Blender)", text.includes("Assistant → ⋯ → Manage MCP Servers") && gui.includes("Roblox Studio → Assistant → ⋯ → Manage MCP Servers → Enable Studio as MCP server") && text.includes("open Plugins → TotalScript and click Allow on the HTTP prompt") && mainJs.includes("open Plugins → TotalScript and click Allow on the HTTP prompt") && text.includes("Start MCP Server in Blender (N panel → MCP for Blender)") && text.includes("Connect Blender") && mainJs.includes("Connect Blender"));
ok("C9 FULL PC ACCESS, Kill Studio two-click confirm and single-instance claims match the code", text.includes("FULL PC ACCESS") && gui.includes('"FULL PC ACCESS (absolute paths, process_kill, cd anywhere) — applies immediately and on next start"') && text.includes("two-click confirm") && gui.includes('"Confirm: kill Studio"') && text.includes("Only one bridge can run at a time") && /a live bridge on 3000 that answers \/api\/window is ours/.test(mainRs));
ok("C10 honest about Blender: it connects through the extension, this app has no Blender code", text.includes("Blender connects through the extension, not this app") && !/blender/i.test(gui.slice(0, gui.indexOf("const HELP_TOPICS"))) && !/blender/i.test(mainRs));

// ── D. docs ────────────────────────────────────────────────────────────────
ok("D1 README documents 1.96.0 and lists this test", /\*\*1\.96\.0 — Desktop Help page/.test(readme) && readme.includes("test-desktop-help.js"));

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
