// 1.39.2 — Logo: a black & white R. Every shipped icon must be a PNG of the
// right size, RGBA (transparent rounded corners) and strictly monochrome.
// Run from the ORscript root: node tests/test-v1392.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const root = path.join(__dirname, "..");
let failed = 0;
function ok(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || extra === undefined ? "" : "  → " + String(extra).slice(0, 160)}`); if (!cond) failed++; }

// Minimal PNG reader (8-bit RGBA / RGB, non-interlaced) — enough to inspect our own icons.
function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG: " + file);
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : 0;
  if (depth !== 8 || !bpp || interlace) return { w, h, ctype, pixels: null };
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(w * h * bpp); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ctype, bpp, pixels: out };
}

const ICONS = [["assets/logo-source.png", 1024], ["assets/icon.png", 512], ["assets/icon128.png", 128], ["assets/icon48.png", 48], ["assets/icon32.png", 32], ["assets/icon16.png", 16]];
for (const [rel, size] of ICONS) {
  const p = path.join(root, rel);
  ok(`${rel} exists`, fs.existsSync(p));
  if (!fs.existsSync(p)) continue;
  const png = readPng(p);
  ok(`${rel} is ${size}x${size}`, png.w === size && png.h === size, `${png.w}x${png.h}`);
  ok(`${rel} is 8-bit RGBA`, png.ctype === 6 && !!png.pixels, "ctype " + png.ctype);
  if (!png.pixels || png.ctype !== 6) continue;
  // Monochrome: every opaque pixel is (near) gray — no hue.
  let maxChroma = 0, opaque = 0, white = 0, black = 0, mid = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const r = png.pixels[i], g = png.pixels[i + 1], b = png.pixels[i + 2], a = png.pixels[i + 3];
    if (a < 128) continue; opaque++;
    maxChroma = Math.max(maxChroma, Math.max(r, g, b) - Math.min(r, g, b));
    const l = (r + g + b) / 3; if (l > 235) white++; else if (l < 20) black++; else mid++;
  }
  ok(`${rel} is monochrome (no hue)`, maxChroma <= 8, "max chroma " + maxChroma);
  ok(`${rel} is mostly pure black + white (anti-alias only in between)`, (white + black) / opaque > (size >= 128 ? 0.9 : 0.5), `white ${white} black ${black} mid ${mid}`);
  ok(`${rel} has a white R on black (both tones present)`, white / opaque > 0.08 && black / opaque > 0.4, `white ${(white / opaque).toFixed(2)} black ${(black / opaque).toFixed(2)}`);
  // Corners transparent (rounded square), centre opaque.
  const alphaAt = (x, y) => png.pixels[(y * png.w + x) * 4 + 3];
  ok(`${rel} has transparent rounded corners and an opaque centre`, alphaAt(0, 0) < 40 && alphaAt(png.w - 1, 0) < 40 && alphaAt(0, png.h - 1) < 40 && alphaAt(png.w - 1, png.h - 1) < 40 && alphaAt(png.w >> 1, png.h >> 1) === 255, [alphaAt(0, 0), alphaAt(png.w - 1, 0), alphaAt(0, png.h - 1), alphaAt(png.w - 1, png.h - 1)].join(","));
}

// Wiring: manifest icons, popup crest, bar mark, paint brand, desktop app bytes.
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
ok("manifest icons point at the derived sizes", ["16", "32", "48", "128"].every((k) => mf.icons[k] === `assets/icon${k}.png`), JSON.stringify(mf.icons));
const css = fs.readFileSync(path.join(root, "overlay.css"), "utf8");
const logoCss = css.slice(css.indexOf("/* ORscript mark (black & white R"), css.indexOf("#rs-cards-panel:has(.rs-template-library) .rs-cards-brand"));
ok("logo rings are neutral white, not gold", logoCss.length > 100 && !logoCss.includes("214,174,79") && logoCss.includes("#rs-logo.rs-logo") && logoCss.includes(".rs-menu-mark.rs-menu-mark-logo") && logoCss.includes(".rs-cards-logo.rs-logo"));
ok("paint brand ring is neutral white", /\.rsp-logo \{[^}]*rgba\(255,255,255,\.3\)/.test(css) && !/\.rsp-logo \{[^}]*214,174,79/.test(css));
ok("desktop app embeds assets/icon.png", fs.readFileSync(path.join(root, "agent/src/gui.rs"), "utf8").includes('include_bytes!("../../assets/icon.png")'));
ok("README changelog 1.39.2 + test listed", /\*\*1\.39\.2 — Logo: black & white R\.\*\*/.test(fs.readFileSync(path.join(root, "README.md"), "utf8")) && fs.readFileSync(path.join(root, "README.md"), "utf8").includes("test-v1392.js"));
ok("manifest 1.39.2", mf.version === "1.39.2", mf.version);

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.39.2 checks passed");
process.exit(failed ? 1 : 0);
