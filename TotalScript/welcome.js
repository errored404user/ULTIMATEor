// TotalScript — one-time hello page (opened by background.js right after the
// extension is installed; the rsHelloShown flag makes sure it never reopens).
const DISCORD_URL = "https://discord.gg/YqVZaZYuy";
const DEFAULT_AI_URL = "https://chat.deepseek.com/";
const IS_WINDOWS_HOST = /Windows/i.test(navigator.userAgent || "");
const runCmd = document.getElementById("run-cmd");
if (runCmd) runCmd.textContent = IS_WINDOWS_HOST ? "bin/total-core.exe" : "bin/total-core";
const openTab = (url) => { try { chrome.tabs.create({ url }); } catch { window.open(url, "_blank"); } };
document.getElementById("open-ai")?.addEventListener("click", () => openTab(DEFAULT_AI_URL));
document.getElementById("open-discord")?.addEventListener("click", () => openTab(DISCORD_URL));
document.getElementById("close")?.addEventListener("click", () => { try { window.close(); } catch {} });
// 2.12.0: follow the popup's Appearance choice (tsPopup) when one exists.
try {
  chrome.storage.local.get("tsPopup", (r) => {
    const p = r && r.tsPopup && typeof r.tsPopup === "object" ? r.tsPopup : {};
    const html = document.documentElement;
    if (["dark", "light", "system"].includes(p.theme)) html.setAttribute("data-ts-theme", p.theme);
    if (["aqua", "violet", "emerald", "amber", "rose", "slate"].includes(p.accent)) html.setAttribute("data-accent", p.accent);
    if (p.motion === false) html.setAttribute("data-motion", "off");
  });
} catch {}
