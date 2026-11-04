// 2.7.0 desktop pins: exe icon resource, local reference library tools,
// deterministic Luau API check, session report. Source-level + binary-format
// checks (the crate itself is compiled by the desktop CI job).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const gui = read("agent/src/gui.rs");
const main = read("agent/src/main.rs");
const ws = read("agent/src/workspace.rs");
const chat = read("agent/src/chat.rs");
const build = read("agent/build.rs");
const cargo = read("agent/Cargo.toml");
const readme = read("README.md");
let failures = 0;
const ok = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures++;
};

// ── A. exe icon ─────────────────────────────────────────────────────────
const resPath = path.join(root, "assets/icon.res");
const icoPath = path.join(root, "assets/icon.ico");
ok("A1 assets/icon.ico and assets/icon.res are shipped", fs.existsSync(resPath) && fs.existsSync(icoPath));
if (fs.existsSync(resPath)) {
  const res = fs.readFileSync(resPath);
  const entries = [];
  let off = 0;
  while (off + 32 <= res.length) {
    const dataSize = res.readUInt32LE(off);
    const headerSize = res.readUInt32LE(off + 4);
    const type = res.readUInt16LE(off + 10);
    const id = res.readUInt16LE(off + 14);
    entries.push({ type, id, dataSize, headerSize });
    off += headerSize + dataSize + ((4 - (dataSize % 4)) % 4);
  }
  ok("A2 .res starts with the empty 32-byte entry and ends exactly on a boundary",
    entries.length > 2 && entries[0].type === 0 && entries[0].dataSize === 0 && entries[0].headerSize === 32 && off === res.length);
  const icons = entries.filter((e) => e.type === 3);
  const groups = entries.filter((e) => e.type === 14);
  ok("A3 .res carries RT_ICON entries 1..n plus one RT_GROUP_ICON id 1",
    icons.length >= 5 && icons.every((e, i) => e.id === i + 1) && groups.length === 1 && groups[0].id === 1);
  ok("A4 RT_GROUP_ICON lists every RT_ICON (6 + 14*n bytes)", groups.length === 1 && groups[0].dataSize === 6 + 14 * icons.length);
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  ok("A5 .ico is a type-1 icon with the same image count", ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && count === icons.length);
}
ok("A6 build.rs links the resource only for windows-msvc binaries, with rerun-if-changed",
  build.includes('if os == "windows" && env == "msvc"')
    && build.includes("cargo:rustc-link-arg-bins=")
    && build.includes('join("assets").join("icon.res")')
    && build.includes("cargo:rerun-if-changed=")
    && !build.includes("winres"));
ok("A7 no new crate for the icon (Cargo.toml has no build-dependencies / winresource / embed-resource)",
  !cargo.includes("[build-dependencies]") && !/winres|embed-resource|embed_resource/.test(cargo));
ok("A8 window icon still comes from assets/icon.png", gui.includes('include_bytes!("../../assets/icon.png")') && gui.includes("with_icon("));
ok("A9 build-icon.py regenerates both files from icon.png", fs.existsSync(path.join(root, "agent/build-icon.py")) && read("agent/build-icon.py").includes("RT_GROUP_ICON"));

// ── B. reference library ───────────────────────────────────────────────
ok("B1 Workspace keeps an optional reference_dir with set/get", ws.includes("reference_dir: std::sync::RwLock<Option<PathBuf>>") && ws.includes("pub fn set_reference_dir(") && ws.includes("pub fn reference_dir(&self)"));
ok("B2 reference_search / reference_read / luau_check are in catalog, dispatch and the unknown-tool list",
  ["reference_search", "reference_read", "luau_check"].every((n) =>
    ws.includes(`"name": "${n}"`) && ws.includes(`"${n}" => tool_${n}(ws, a).await`)) && ws.includes("reference_search, reference_read, luau_check. Call list_commands"));
ok("B3 search skips hidden / underscore folders and ALL-CAPS hub files, and is bounded", ws.includes("name.starts_with('.') || name.starts_with('_')") && ws.includes("c.is_ascii_uppercase() || c.is_ascii_digit()") && ws.includes("REFERENCE_MAX_FILES") && ws.includes("REFERENCE_BODY_BYTES"));
ok("B4 TL;DR follows LihFolk markers, then ## TL;DR, then first paragraph", ws.includes('body.find("tldr:start")') && ws.includes('"## tl;dr"') && ws.includes("strip_prefix(\"---\")"));
ok("B5 SYMPTOMS.md rows ride along (best 6 by term hits)", ws.includes('root.join("SYMPTOMS.md")') && ws.includes("take(6)"));
ok("B6 LihFolk is credited as CC BY 4.0, never bundled", ws.includes('LihFolk Vault V2, CC BY 4.0') && gui.includes("download it yourself; nothing is bundled") && !fs.existsSync(path.join(root, "LihFolk Vault V2")));
ok("B7 unconfigured library answers in words instead of failing", ws.includes('return Ok("Reference library not configured.'));
ok("B8 Settings field + card + UiCommand + start-up application", gui.includes("pub reference_dir: String") && gui.includes('"Reference library (optional)"') && gui.includes("UiCommand::SetReferenceDir { path: self.draft_reference") && main.includes("gui::UiCommand::SetReferenceDir { path, reply }") && main.includes("workspace.set_reference_dir(&settings.reference_dir)"));
ok("B9 Reset-to-defaults keeps the reference folder like the workspace", gui.includes("reference_dir: keep_ref, ..Settings::default()"));
ok("B10 chat system prompt mentions reference_search only when a library is set", chat.includes("if state.workspace.reference_dir().is_some()") && chat.includes("reference_search {query} looks limits"));
ok("B11 unit test covers ranking, section read, skip dirs, symptoms, off state", ws.includes("async fn reference_search_ranks_titles_and_reads_sections()") && ws.includes('assert!(!out.contains("ignored")'));

// ── C. luau_check ──────────────────────────────────────────────────────
const rules = ws.slice(ws.indexOf("const LUAU_RULES"), ws.indexOf("pub fn luau_check"));
const needles = [...rules.matchAll(/\n\s*\("([^"\\]+(?:\\.[^"\\]*)*)",/g)].map((m) => m[1]);
ok("C1 rule table covers the classic deprecations", ["wait(", "spawn(", "delay(", ":connect(", "FindPartOnRay", "BodyVelocity", "BodyGyro", "BodyPosition", "SetPrimaryPartCFrame", "GetPrimaryPartCFrame", ":LoadAnimation(", "GetTextSize", "unpack(", "math.pow(", "table.getn(", "PointsService", "SetPartCollisionGroup", "CreateCollisionGroup"].every((n) => needles.includes(n)));
ok("C2 no rule flags a current API (CollisionGroupSetCollidable, GetMouse, http:// are not in the table)", !needles.some((n) => /CollisionGroupSetCollidable|GetMouse|http:\/\//.test(n)));
ok("C3 short globals are word-bounded so task.wait / :Wait / myspawn pass", ws.includes('matches!(*needle, "wait(" | "spawn(" | "delay(" | "unpack(" | "ypcall(")') && ws.includes("c == '.' || c == ':'"));
ok("C4 comments are skipped", ws.includes('raw.find("--")'));
ok("C5 advisory rows are labelled (advice) and the Animator exception exists", ws.includes('"(advice) Instance.new(class, parent)') && ws.includes('if line.contains("Animator") { continue }'));
ok("C6 chat loop appends findings to execute_luau results without blocking", chat.includes('if real == "execute_luau"') && chat.includes("workspace::luau_check") && chat.includes("ran anyway, fix next time") && chat.indexOf("let luau_findings") < chat.indexOf("execute(&state, engine, &real, args).await"));
ok("C7 unit test pins bad vs modern snippets", ws.includes("fn luau_check_flags_deprecated_and_keeps_modern()") && ws.includes("assert!(luau_check(good).is_empty()"));

// ── D. session report ──────────────────────────────────────────────────
ok("D1 SessionStats is fed from track() and capped", gui.includes("pub session: Mutex<SessionStats>") && gui.includes("self.record_session(kind, &text, &at);") && gui.includes("SESSION_ERRORS_CAP"));
ok("D2 parser matches the real activity formats", gui.includes('text.split(" · ")') && gui.includes('strip_suffix(" ms")') && gui.includes('text.split_once(" failed: ")')
  && main.includes("({engine}) · {elapsed_ms} ms · toolkit") && chat.includes("({engine}) · {elapsed_ms} ms · chat") && main.includes("({eng}) failed: {}"));
ok("D3 Home has Copy session report and diagnostics embed it", gui.includes('"Copy session report"') && gui.includes("self.shared.session_report_text()") && gui.includes('out.push_str("\\n--- session ---\\n");'));
ok("D4 report is names and numbers only", gui.includes("no tool arguments, no results, no chat text, no keys") && !gui.includes("st.args") && gui.includes("tool                                      calls   ok  fail   avg ms   max ms"));

// ── E. docs ────────────────────────────────────────────────────────────
ok("E1 README documents 2.8.0 with the four items and this test",
  readme.includes("**2.7.0") && /reference_search/.test(readme) && /luau_check/.test(readme) && /session report/i.test(readme) && readme.includes("icon.res") && readme.includes("test-desktop-reference.js"));

console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exit(failures ? 1 : 0);
