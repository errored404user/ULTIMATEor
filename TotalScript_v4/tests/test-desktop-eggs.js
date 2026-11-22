// 2.9.1 easter eggs: Settings → Appearance → "Search palettes…" opens a small
// window for three exact words. Static pins over agent/src/easter.rs + gui.rs;
// the behaviour itself is covered by the Rust unit tests in easter.rs (CI).
// Run: node tests/test-desktop-eggs.js
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + String(d).slice(0, 300) : "")); } };
const easter = read("agent/src/easter.rs"), gui = read("agent/src/gui.rs"), main = read("agent/src/main.rs"), cargo = read("agent/Cargo.toml"), readme = read("README.md");

ok("A1 module declared in main.rs and the GUI keeps an EggState next to the palette query", /^mod easter;$/m.test(main) && /egg: crate::easter::EggState,/.test(gui) && /egg: crate::easter::EggState::default\(\),/.test(gui));
ok("A2 the palette search box feeds the egg state every frame and the window is drawn from update()", /TextEdit::singleline\(&mut self\.palette_query\)[\s\S]{0,400}self\.egg\.observe\(&self\.palette_query\);/.test(gui) && /self\.egg\.show\(ctx, t\.text, t\.muted, t\.accent\);/.test(gui));
ok("A3 three triggers, exact + lower-cased: featherscript / plazcode / shang", /Egg::Feather => "featherscript"/.test(easter) && /Egg::Plaz => "plazcode"/.test(easter) && /Egg::Shang => "shang"/.test(easter) && /let q = query\.trim\(\)\.to_lowercase\(\);/.test(easter) && /\.find\(\|e\| e\.trigger\(\) == q\)/.test(easter));
ok("B1 FeatherScript: painter-drawn feather (mesh + barbs + outline) and the Discord invite, click to open + copy", /pub const FEATHER_DISCORD: &str = "https:\/\/discord\.gg\/Je8WS2N2q";/.test(easter) && /pub fn feather_shapes\(rect: Rect\) -> Vec<egui::Shape>/.test(easter) && /egui::Shape::mesh\(mesh\)/.test(easter) && /crate::gui::open_external\(FEATHER_DISCORD\)/.test(easter) && /o\.copied_text = FEATHER_DISCORD\.to_string\(\)/.test(easter));
ok("B2 PlazCode line verbatim", easter.includes(`pub const PLAZ_LINE: &str = "He took my ORscript and became popular and I'MMMM!!!! left in the shadows...";`));
ok("B3 Shang line verbatim + synthesised WAV + OS player (PowerShell SoundPlayer / afplay / paplay|aplay) + Play again", easter.includes(`pub const SHANG_LINE: &str = "Erm im a little nobody";`) && /pub fn shang_tune_wav\(\) -> Vec<u8>/.test(easter) && /Media\.SoundPlayer/.test(easter) && /"afplay"/.test(easter) && /\["paplay", "aplay"\]/.test(easter) && /small_button\("Play again"\)/.test(easter));
ok("B4 open-once logic: same word does not reopen a closed window; clearing re-arms", /if trimmed\.eq_ignore_ascii_case\(&self\.armed_query\) \{ return false; \}/.test(easter) && /if trimmed\.is_empty\(\) \{\s*self\.armed_query\.clear\(\);/.test(easter));
ok("C1 no new crate (Cargo.toml dependency list unchanged: no rodio / cpal / audio / webbrowser)", !/rodio|cpal|kira|webbrowser|open\s*=/.test(cargo));
ok("C2 Rust unit tests cover detection, re-arm, feather bounds/colours, WAV header + envelope", ["detect_is_exact_and_case_insensitive", "observe_opens_once_per_query_and_rearms_after_clear", "feather_fits_its_rect_and_is_black_and_white", "tune_is_a_valid_short_wav"].every((t) => easter.includes("fn " + t + "()")));
ok("C3 README 2.9.1 block + Testing line", /\*\*2\.9\.1 — Three easter eggs in the desktop app\.\*\*/.test(readme) && /FeatherScript/.test(readme) && /node tests\/test-desktop-eggs\.js/.test(readme));
ok("C4 the Help page does not spoil the words (they stay hidden)", !/FeatherScript|PlazCode|Shang/.test(gui));
console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-desktop-eggs: ${pass} passed, ${fail} failed (static - the window and the sound run only in the built app)`);
process.exit(fail ? 1 : 0);
