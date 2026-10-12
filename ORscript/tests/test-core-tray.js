// Windows background-app regressions for or-core's native status window.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const gui = fs.readFileSync(path.join(root, "agent/src/gui.rs"), "utf8");
const main = fs.readFileSync(path.join(root, "agent/src/main.rs"), "utf8");
const workflowPath = path.join(root, ".github/workflows/build-agent.yml");
const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, "utf8") : null;
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
let failures = 0;
const ok = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures++;
};

ok("tray is created after the winit event loop starts",
  gui.indexOf('Box::new(move |_cc|') < gui.lastIndexOf("let tray = make_tray();"));
ok("left-click opens instead of opening the context menu",
  gui.includes(".with_menu_on_left_click(false)") && gui.includes("MouseButtonState::Down"));
ok("hidden tray events run on a dedicated worker instead of App update",
  gui.includes('.name("orscript-tray".to_string())')
    && gui.includes("TrayIconEvent::receiver().try_recv()")
    && gui.includes("MenuEvent::receiver().try_recv()")
    && !gui.includes("set_event_handler"));
ok("Open bypasses broken invisible viewport commands on Windows",
  gui.includes("crate::show_agent_window(hwnd)")
    && main.includes("win_msg::ShowWindow(hwnd, 9)")
    && main.includes("win_msg::SetForegroundWindow(hwnd)"));
ok("Quit wakes a hidden winit window and has a hard fallback",
  gui.includes("quit.store(true, Ordering::Release)")
    && gui.includes("crate::close_agent_window(hwnd)")
    && gui.includes("std::process::exit(0)")
    && main.includes("PostMessageW")
    && main.includes("0x0010"));
ok("normal Close only hides when a usable tray exists",
  gui.includes("self.tray.is_some() && self.native_hwnd.is_some()")
    && gui.includes("!can_background")
    && gui.includes("Close will quit instead of hiding an unreachable background app"));
ok("status window exposes an explicit Quit button", gui.includes('pill(ui, "Quit", false)'));
ok("launching or-core again reopens the existing hidden instance",
  /fn main\(\)[\s\S]*if let Some\(hwnd\) = agent_window\(\)[\s\S]*show_agent_window\(hwnd\);[\s\S]*return;/.test(main)
    && main.includes("FindWindowW"));
if (workflow !== null) ok("Windows build commits the rebuilt lockfile and executable",
  workflow.includes("git add agent/Cargo.lock bin/or-core.exe"));
else console.log("SKIP  Windows release workflow is not distributed in the extension package");
ok("background controls are documented",
  readme.includes("left-click the ORscript tray icon") && readme.includes("right-click → **Quit**"));

process.exitCode = failures ? 1 : 0;
