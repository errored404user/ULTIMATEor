// The notification-area (tray) icon is compiled in on every supported
// platform (Windows, macOS). `has_tray` is kept as a cfg so the GUI code keeps
// a single switch for "can the window hide and come back".
fn main() {
    println!("cargo:rustc-check-cfg=cfg(has_tray)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "windows" || os == "macos" {
        println!("cargo:rustc-cfg=has_tray");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
