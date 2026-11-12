// Build script for total-core.
//
// 1. `has_tray` cfg: the notification-area (tray) icon is compiled in on every
//    supported platform (Windows, macOS). Kept as a cfg so the GUI code has a
//    single switch for "can the window hide and come back".
// 2. Windows file icon: `../assets/icon.res` (RT_ICON + RT_GROUP_ICON, built
//    by `build-icon.py` from assets/icon.png) is handed straight to the MSVC
//    linker, so Explorer, the taskbar and Alt-Tab show the TotalScript tile
//    instead of the generic exe icon. No rc.exe and no extra crates needed;
//    the GNU toolchain simply skips it.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(has_tray)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" || os == "macos" {
        println!("cargo:rustc-cfg=has_tray");
    }
    if os == "windows" && env == "msvc" {
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        let res = manifest.join("..").join("assets").join("icon.res");
        if res.exists() {
            println!("cargo:rustc-link-arg-bins={}", res.display());
            println!("cargo:rerun-if-changed={}", res.display());
        } else {
            println!("cargo:warning=assets/icon.res missing — run `python build-icon.py` in agent/ to restore the exe icon");
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
