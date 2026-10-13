// Decides whether the notification-area (tray) icon is compiled in.
//   Windows, macOS      -> always (tray-icon works out of the box)
//   Linux               -> only with `--features linux-tray` (needs GTK 3 +
//                          libayatana-appindicator at build and run time)
fn main() {
    println!("cargo:rustc-check-cfg=cfg(has_tray)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let linux_tray = std::env::var_os("CARGO_FEATURE_LINUX_TRAY").is_some();
    if os == "windows" || os == "macos" || (os == "linux" && linux_tray) {
        println!("cargo:rustc-cfg=has_tray");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
