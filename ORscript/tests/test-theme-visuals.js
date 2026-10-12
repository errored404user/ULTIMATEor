// 1.19.7 — theme visual refresh: layered backgrounds for every theme, corner
// decorations on panels + the viewport rail, gradient-pill buttons with glow.
// Run from the ORscript root: node tests/test-theme-visuals.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const css = read("overlay.css");
const main = read("src/core/main.js");
const popup = read("popup.html");
const manifest = JSON.parse(read("manifest.json"));

const THEMES = [
  "night", "blood-moon", "sakura", "starglaze", "autumn", "pixelated", "void",
  "epicface", "headooh", "ragequit", "killfeed", "shitpost", "skillissue", "pogchamp", "glitchlord", "npcenergy",
];
const CLASSIC = THEMES.slice(0, 7);

// Only inspect the refresh section so older patches can't satisfy the checks.
const start = css.indexOf("OR 1.19.7 — theme visual refresh");
assert(start > 0, "overlay.css must contain the 1.19.7 theme visual refresh section");
const sec = css.slice(start);

// 1) Backgrounds — one token block per theme, each defining a photo/pattern layer.
for (const id of THEMES) {
  const re = new RegExp(`html\\[data-rs-theme="${id}"\\]\\s*\\{[^}]*--orx-img:`);
  assert(re.test(sec), `theme "${id}" must define an --orx-img background layer`);
  const tok = sec.match(new RegExp(`html\\[data-rs-theme="${id}"\\]\\s*\\{([^}]*)\\}`))[1];
  for (const v of ["--orx-a", "--orx-b", "--orx-on", "--orx-glow", "--orx-bg"]) {
    assert(tok.includes(v + ":"), `theme "${id}" must define ${v}`);
  }
}
for (const id of CLASSIC) {
  assert(sec.includes(`url(ui/swatch-${id}.jpg)`), `classic theme "${id}" must use its swatch photo as a background`);
  assert(fs.existsSync(path.join(root, "ui", `swatch-${id}.jpg`)), `ui/swatch-${id}.jpg must exist`);
}
assert(/html\[data-rs-theme\] #rs-menu,[\s\S]*?background:\s*var\(--orx-marks\), var\(--orx-fade\), var\(--orx-wash\), var\(--orx-img\), var\(--orx-bg\) !important/.test(sec),
  "#rs-menu must stack marks + fade + wash + image + base");
assert(sec.includes("html[data-rs-theme] .rs-menu-head {"), "settings head must take the theme photo");
assert(sec.includes('html[data-rs-theme][data-rs-glass="true"] #rs-bar'), "glass bar must get the themed background");

// 2) Corner decorations — bracket marks on panels, glyph rail for every theme.
assert((sec.match(/linear-gradient\(var\(--orx-mark\), var\(--orx-mark\)\)/g) || []).length === 8, "--orx-marks must draw 8 bracket layers (4 corners x 2 edges)");
for (const c of ["tl", "tr", "bl", "br"]) assert(sec.includes(`#rs-root .rs-corner-${c}::before`), `viewport rail corner ${c} must have a bracket frame`);
assert(sec.includes('.rs-theme-corners[data-kind="classic"]'), "classic rail styling must exist");
assert(sec.includes('.rs-theme-corners[data-kind="meme"]'), "meme rail styling must exist");
assert(main.includes("const CLASSIC_THEME_DECOR = {"), "main.js must define classic theme corner decorations");
for (const id of CLASSIC) {
  const m = main.match(new RegExp(`^\\s*"?${id}"?:\\s*\\[([^\\]]*)\\]`, "m"));
  assert(m, `CLASSIC_THEME_DECOR must include "${id}"`);
  const n = m[1].split(",").filter((x) => x.trim()).length;
  assert(n >= 23, `"${id}" needs >= 23 decoration tokens for the 6/6/5/6 corner split (got ${n})`);
}
assert(main.includes('rail.dataset.kind=memeIds.includes(orTheme)?"meme":"classic"'), "rail must be tagged classic/meme for CSS");
assert(main.includes('rail.hidden=memeEffects==="off"||dec.length===0'), "rail must show for any theme with decorations and honour effects=off");
assert(!main.includes("rail.hidden=!memeIds.includes(orTheme)"), "rail must no longer be meme-only");

// 3) Buttons — gradient pills with glow, every state covered.
assert(sec.includes("--orx-grad: linear-gradient(135deg, var(--orx-a)"), "accent gradient token must exist");
for (const sel of [
  'html[data-rs-theme] #rs-action[data-kind="start"]',
  'html[data-rs-theme] #rs-action[data-kind="start-degraded"]',
  'html[data-rs-theme] #rs-action[data-kind="restart"]',
  "html[data-rs-theme] #rs-stop",
  'html[data-rs-theme] #rs-stop[data-state="stopping"]',
  "html[data-rs-theme] #rs-discord",
  "html[data-rs-theme] #rs-support",
  "html[data-rs-theme] #rs-switch",
  "html[data-rs-theme] #rs-settings-btn",
  "html[data-rs-theme] #rs-approve-allow",
  "html[data-rs-theme] #rs-approve-deny",
  "html[data-rs-theme] .rs-theme-tools button[data-theme-random]",
  "html[data-rs-theme] .rs-tgl.on",
  "html[data-rs-theme] #rs-action:disabled",
]) assert(sec.includes(sel), `button rule missing: ${sel}`);
assert(/#rs-action\[data-kind="start"\]:hover[\s\S]*?translateY\(-1px\)/.test(sec), "primary pill must lift on hover");
assert(/#rs-action\[data-kind="start"\]:active[\s\S]*?scale\(\.98\)/.test(sec), "primary pill must have a pressed state");
assert(sec.includes("border-radius: var(--orx-r) !important"), "pills must use the per-theme radius token");
assert(sec.includes('html[data-rs-theme="pixelated"]  { --orx-a:#58e07f') && sec.includes("--orx-r:2px"), "pixelated keeps square edges");
assert(sec.includes(":focus-visible"), "keyboard focus ring must be themed");
assert(sec.includes("@media (prefers-reduced-motion: reduce)"), "motion must be reducible");

// 4) Meme themes have photo backgrounds too (pattern layer on top of a swatch).
const MEME = THEMES.slice(7);
for (const id of MEME) {
  assert(fs.existsSync(path.join(root, "ui", `swatch-${id}.jpg`)), `ui/swatch-${id}.jpg must exist`);
  const tok = sec.match(new RegExp(`html\\[data-rs-theme="${id}"\\]\\s*\\{([^}]*)\\}`))[1];
  assert(tok.includes(`url(ui/swatch-${id}.jpg)`), `meme theme "${id}" must use its swatch photo in --orx-img`);
  assert(sec.includes(`html[data-rs-theme] .rs-theme-card[data-theme="${id}"] .rs-theme-art   `.trimEnd()), `picker card for "${id}" must show the photo`);
  assert(popup.includes(`[data-theme="${id}"] .theme-art{background-image:url(ui/swatch-${id}.jpg)`), `popup card for "${id}" must show the photo`);
  assert(popup.includes(`html[data-theme="${id}"] .hero{background-image:url(ui/swatch-${id}.jpg)}`), `popup hero for "${id}" must show the photo`);
}
assert(main.includes('chrome.runtime.getURL("ui/swatch-" + id + ".jpg")'), "picker must use swatches for every theme");
assert(!main.includes('"ui/theme-" + id + ".svg"'), "picker must no longer branch to svg stickers");

// 5) Sound packs: seven distinct, short, hand-tuned effects per theme.
const packSrc = main.match(/const THEME_SOUNDS = (\{[\s\S]*?\n  \});/);
assert(packSrc, "main.js must define THEME_SOUNDS");
const PACKS = Function("return " + packSrc[1])();
const KINDS = ["start", "done", "stop", "error", "ok", "click", "special"];
assert.deepStrictEqual(Object.keys(PACKS).sort(), [...THEMES].sort(), "every theme needs a sound pack");
const seen = new Set();
for (const [id, pack] of Object.entries(PACKS)) {
  assert(typeof pack.label === "string" && pack.label.length > 8, `pack "${id}" needs a label`);
  for (const k of KINDS) {
    const steps = pack.fx[k];
    assert(Array.isArray(steps) && steps.length, `pack "${id}" is missing "${k}"`);
    const sig = JSON.stringify(steps);
    assert(!seen.has(sig), `pack "${id}.${k}" duplicates another effect`);
    seen.add(sig);
    for (const st of steps) {
      let end, gain;
      if (st[0] === "t") { end = st[2] + st[3]; gain = st[5]; assert(st[1] > 15 && st[1] < 8000, `${id}.${k}: bad freq`); }
      else if (st[0] === "n") { end = st[1] + st[2]; gain = st[3]; }
      else if (st[0] === "a") { end = st[2] + (st[1].length - 1) * st[3] + st[4]; gain = st[6]; }
      else assert.fail(`${id}.${k}: unknown step ${st[0]}`);
      assert(end <= 1.0, `${id}.${k}: effects must stay under 1s (never loop), got ${end}`);
      assert(gain <= 0.1, `${id}.${k}: gain ${gain} too hot`);
    }
  }
}
assert(main.includes("function playSfx(kind, themeId)"), "playSfx must accept a theme override for previews");
assert(main.includes('menuEl.querySelectorAll("[data-theme-sound-preview]").forEach'), "♪ preview buttons must be wired");
assert(main.includes('playSfx(b.dataset.effect,b.dataset.themeSoundPreview)'), "♪ preview buttons must play the named effect of that theme");
assert(main.includes('playSfx("special")') && main.includes('playSfx("click")'), "signature + click sounds must be used");
assert(!main.includes('i*27,accent:'), "old transposed meme effects must be gone");
for (const kw of ["createBuffer", "freqEnd", "highpass", "lowpass", "detune", "vibDepth"]) assert(main.includes(kw), `synth must support ${kw}`);
assert(main.includes("never loops"), "sound packs must document the no-loop rule");
assert(sec.includes("html[data-rs-theme] .rs-theme-sound-list button"), "sound strip must be styled");

// 6) VoidScript finally has real swatch art everywhere the other classics do.
assert(fs.existsSync(path.join(root, "ui", "swatch-void.jpg")), "ui/swatch-void.jpg must ship");
assert(popup.includes("#theme-void .theme-art{background-image:url(ui/swatch-void.jpg)}"), "popup theme card for void must use the swatch");
assert(popup.includes('html[data-theme="void"] .hero{background-image:url(ui/swatch-void.jpg)}'), "popup hero for void must use the swatch");
assert(manifest.web_accessible_resources.some((w) => (w.resources || []).includes("ui/*.jpg")), "swatches must stay web-accessible for the content script");
assert(manifest.version === "1.19.7", "visual refresh ships as 1.19.7");

console.log("theme visuals: ok (16 themes with photos, corners, gradient buttons, 112 sound effects)");
