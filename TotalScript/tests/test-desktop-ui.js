// 2.10.0 desktop UI overhaul: static checks on the Rust sources, the shipped
// fonts, the headless snapshot test and the CI workflow. The window itself is
// rendered only by CI (agent/snapshots/*.png); this file pins what must stay.
const fs = require("fs");
const path = require("path");
process.chdir(path.join(__dirname, ".."));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok    " + name); } else { fail++; console.log("FAIL  " + name + (extra ? " — " + extra : "")); } }
const read = (p) => fs.readFileSync(p, "utf8");
const gui = read("agent/src/gui.rs");
// 2.11.0: the window is split into gui.rs + gui/*.rs sub-modules; `guiAll` is everything.
const guiAll = gui + "\n" + fs.readdirSync("agent/src/gui").filter((f) => f.endsWith(".rs")).sort().map((f) => read("agent/src/gui/" + f)).join("\n");
const snap = read("agent/src/gui/snapshot.rs");
const ws = read("agent/src/workspace.rs");
const wf = read(path.join("..", ".github", "workflows", "desktop.yml"));
const readme = read("README.md");

// A — fonts
ok("A1 Inter Regular / Medium / SemiBold + OFL licence ship with the crate",
  ["Inter-Regular.ttf", "Inter-Medium.ttf", "Inter-SemiBold.ttf", "Inter-LICENSE-OFL.txt"].every((f) => fs.existsSync(path.join("agent/assets/fonts", f))));
ok("A2 gui.rs installs them (install_fonts, include_bytes, Medium/SemiBold families, Inter first in Proportional)",
  /fn install_fonts\(/.test(gui) && /include_bytes!\("\.\.\/assets\/fonts\/Inter-Regular\.ttf"\)/.test(gui) && /FONT_MEDIUM/.test(gui) && /FONT_SEMIBOLD/.test(gui));
ok("A3 no glyph egui's Ubuntu-Light lacked is left unreplaced (no ⋯ in gui.rs; arrows are allowed because Inter has them)", !gui.includes("⋯"));
ok("A4 the font-coverage unit test exists", /fn fonts_cover_turkish_and_arrows\(/.test(snap) && /ç ğ ı İ ö ş ü/.test(snap));

// B — one button family
const kinds = ["Primary", "Secondary", "Ghost", "Danger"];
ok("B1 Btn enum with exactly the four kinds and one button_widget / button / pill / ghost / danger",
  /enum Btn \{ Primary, Secondary, Ghost, Danger \}/.test(gui) && kinds.every((k) => gui.includes("Btn::" + k)) &&
  /fn button_widget\(t: Theme, text: &str, kind: Btn\)/.test(gui) && /fn ghost\(/.test(gui) && /fn danger\(/.test(gui));
ok("B2 no raw egui default buttons left in gui.rs (ui.button / ui.small_button)", !/ui\.button\(/.test(gui) && !/ui\.small_button\(/.test(gui));
ok("B3 buttons never wrap their label and share the r_btn radius token; 32 px / 28 px (ghost) heights",
  /wrap_mode\(egui::TextWrapMode::Extend\)/.test(gui) && /Rounding::same\(t\.r_btn\)/.test(gui) && /if kind == Btn::Ghost \{ 28\.0 \} else \{ 32\.0 \}/.test(gui));
ok("B4 keyboard focus ring painted on buttons", /resp\.has_focus\(\)/.test(gui));
ok("B5 radius tokens exist on Theme and follow Settings → Corners", /r_btn: f32,\s*r_card: f32,\s*r_chip: f32,/.test(gui) && /t\.r_btn = corner\(settings\.corners, 8\.0\)/.test(gui) && /t\.r_card = corner\(settings\.corners, 12\.0\)/.test(gui));
ok("B6 no 999-radius pills remain", !gui.includes("Rounding::same(999.0)"));
ok("B7 destructive actions use the danger kind (delete file, kill Studio, quit, forget keys)",
  /danger\(ui, t, if armed \{ "Confirm delete" \} else \{ "Delete" \}\)/.test(gui) && /Btn::Danger\)\)\.on_hover_text\("Ends every RobloxStudio process/.test(gui) &&
  /danger\(ui, t, "Quit TotalScript \(stop bridge\)"\)/.test(guiAll) && /Forget all API keys \(\{n\}\)"\), Btn::Danger\)/.test(gui) && /Forget all API keys \(\{keys\}\)"\), Btn::Danger\)/.test(guiAll));

// C — layout rules that the snapshots caught
ok("C1 Home is one scroll area (hero, cards, checklist, columns)", (() => { const a = gui.indexOf('id_salt("home-scroll")'); return a > 0 && a < gui.indexOf("Bridge failed to start") && a < gui.indexOf("// Hero") && a < gui.indexOf("// Status cards") && a < gui.indexOf("// Setup checklist"); })());
ok("C2 checklist hints wrap under the title instead of running off the card", /if !done \{ ui\.add\(egui::Label::new\(RichText::new\(hint\)\.small\(\)\.color\(t\.muted\)\)\.wrap\(\)\); \}/.test(gui));
ok("C3 page header carries no status chips (title bar + sidebar do); subtitle truncates", /Status chips live in the title bar and the sidebar card/.test(gui) && /RichText::new\(self\.page\.subtitle\(\)\)\.color\(t\.muted\)\)\.truncate\(\)/.test(gui));
ok("C4 title bar shows BRIDGE OFFLINE when the bridge is down", /status_chip\(ui, t, "BRIDGE OFFLINE", t\.bad, false\)/.test(gui));
ok("C5 terminal toolbars are two short rows (filter from the right, level switch + actions)", /Two short rows that fit the narrowest pane/.test(gui) && /\(RunnerMode::Command, "Command"\), \(RunnerMode::Luau, "Luau in Studio"\)/.test(gui));
ok("C6 explorer second row is laid out from the right (path box takes the rest)", /Second row, laid out from the right/.test(gui) && /hint_text\("folder path…"\)\.desired_width\(w\)/.test(gui));
ok("C7 list rows truncate by galley width, not a character estimate", /fn paint_text_fit\(/.test(gui) && /TextWrapping::truncate_at_width/.test(gui) && !/\/ 7\.4\)\.floor\(\)/.test(gui) && !/\/ 7\.6\)\.floor\(\)/.test(gui));
ok("C8 chat header: title row + wrapping action row; assistant cards use the inner width", /Row 1: title \+ provider\/model/.test(gui) && /with_main_wrap\(true\)/.test(gui) && !gui.includes("ui.set_width(avail - 4.0);"));
ok("C9 empty-workspace states say what to do (explorer note, terminal cwd, servers root)",
  /No workspace folder yet — pick one in Settings → Workspace/.test(gui) && /cwd — no workspace folder \(Settings → Workspace\)/.test(gui) && /not set — Change workspace…/.test(gui));
ok("C10 Settings → Corners blurbs match the tokens", /\(0u8, "Sharp", "3–4 px radii"\), \(1u8, "Soft", "8 px buttons, 12 px cards"\), \(2u8, "Round", "12–18 px radii"\)/.test(gui));

// D — headless snapshots
ok("D1 snapshot module is test-only and renders every page at 1280×820 / 1000×660 / 960×620 (+ chat panel)",
  /#\[cfg\(test\)\]\s*mod snapshot;/.test(gui) && /fn snapshot_every_page_at_three_sizes\(/.test(snap) && /\(1280\.0_f32, 820\.0_f32\), \(1000\.0, 660\.0\), \(960\.0, 620\.0\)/.test(snap) && /home-chatpanel-960x620\.png/.test(snap));
ok("D2 inspector uses galley rects (right-aligned text), ignores scroll-viewport cuts, fails hard on missing glyphs",
  /ts\.galley\.rect\.translate\(ts\.pos\.to_vec2\(\)\)/.test(snap) && /scroll_viewport = clip\.height\(\) > 160\.0/.test(snap) && /assert!\(total\.boxes\.is_empty\(\)/.test(snap) && /TOTAL_SNAPSHOTS_STRICT/.test(snap));
ok("D3 workflow renders snapshots before the unit tests, commits PNGs + report.txt back to the branch",
  /UI snapshots \(headless render of every page\)/.test(wf) && /snapshots\/report\.txt/.test(wf) && /Commit snapshots to the branch/.test(wf) && wf.indexOf("UI snapshots (headless") < wf.indexOf("- name: Unit tests"));
ok("D4 snapshots folder documented", fs.existsSync("agent/snapshots/README.md"));

// E — shell encoding (Turkish paths in run_command output)
ok("E1 windows shell line forces UTF-8 and keeps quotes", /fn windows_shell_line\(/.test(ws) && /chcp 65001 >nul/.test(ws) && /fn windows_shell_line_keeps_quotes_and_forces_utf8\(/.test(ws) && /raw_arg\(windows_shell_line\(command\)\)/.test(ws));

// F — release pins
const manifest = JSON.parse(read("manifest.json"));
ok("F1 version pins 2.18.0 (manifest / crate / lock / plugin)", manifest.version === "2.18.0" && /^version = "2\.18\.0"/m.test(read("agent/Cargo.toml")) && /name = "total-agent"\nversion = "2\.18\.0"/.test(read("agent/Cargo.lock")) && read("plugin/TotalScript.lua").includes('local VERSION = "2.18.0"'));
ok("F2 README 2.10.0 block + Testing line", /\*\*2\.10\.0 — Desktop UI overhaul/.test(readme) && /node tests\/test-desktop-ui\.js/.test(readme));
ok("F3 no new crate (Cargo.lock unchanged apart from the version)", !/name = "(fontdue|rusttype|resvg|tiny-skia|cosmic-text)"/.test(read("agent/Cargo.lock")));

console.log(`\n${fail ? "FAIL " : "OK   "} test-desktop-ui: ${pass} passed, ${fail} failed (static — the window is rendered by CI into agent/snapshots/)`);
process.exit(fail ? 1 : 0);
