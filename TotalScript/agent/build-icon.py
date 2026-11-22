#!/usr/bin/env python3
"""Build the Windows file icon for total-core.exe — no rc.exe, no extra crates.

Input : ../assets/icon.png (the TotalScript tile, 512x512 RGBA)
Output: ../assets/icon.ico  (classic multi-size icon: shortcuts, installers)
        ../assets/icon.res  (compiled resource with RT_ICON + RT_GROUP_ICON;
                             build.rs hands it to the MSVC linker, which is
                             what makes Explorer / the taskbar show the tile)

Sizes 16..64 are stored as 32-bit BGRA DIBs (what every Windows shell reads),
256 as PNG (allowed since Vista and keeps the file small).

Run once after changing the artwork:  python build-icon.py   (needs Pillow)
"""
import io
import struct
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "assets" / "icon.png"
ICO = HERE.parent / "assets" / "icon.ico"
RES = HERE.parent / "assets" / "icon.res"
SIZES = [16, 24, 32, 48, 64, 256]


def dib(img: Image.Image) -> bytes:
    """BITMAPINFOHEADER + bottom-up BGRA pixels + 1-bpp AND mask (all opaque=0)."""
    w, h = img.size
    px = img.convert("RGBA").tobytes()
    rows = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    mask_stride = ((w + 31) // 32) * 4
    mask = bytes(mask_stride * h)
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(b"".join(rows)) + len(mask), 0, 0, 0, 0)
    return header + b"".join(rows) + mask


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    base = Image.open(SRC).convert("RGBA")
    images = []
    for s in SIZES:
        im = base.resize((s, s), Image.LANCZOS)
        images.append((s, png(im) if s >= 256 else dib(im)))

    # ── .ico ────────────────────────────────────────────────────────────
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    body = bytearray()
    for s, data in images:
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset + len(body))
        body += data
    ICO.write_bytes(bytes(out + body))

    # ── .res ────────────────────────────────────────────────────────────
    def entry(rtype: int, rid: int, data: bytes) -> bytes:
        # RESOURCEHEADER with ordinal type/name: DataSize, HeaderSize, TYPE, NAME,
        # DataVersion, MemoryFlags, LanguageId, Version, Characteristics.
        head = struct.pack("<II", len(data), 32) + struct.pack("<HHHH", 0xFFFF, rtype, 0xFFFF, rid)
        flags, lang = (0, 0) if rtype == 0 else (0x1030, 0x0409)  # the null entry is all zeros, like rc.exe writes it
        head += struct.pack("<IHHII", 0, flags, lang, 0, 0)
        pad = (-len(data)) % 4
        return head + data + bytes(pad)

    res = bytearray(entry(0, 0, b""))  # the mandatory empty first entry
    for n, (s, data) in enumerate(images, start=1):
        res += entry(3, n, data)  # RT_ICON
    grp = struct.pack("<HHH", 0, 1, len(images))
    for n, (s, data) in enumerate(images, start=1):
        grp += struct.pack("<BBBBHHIH", s % 256, s % 256, 0, 0, 1, 32, len(data), n)
    res += entry(14, 1, grp)  # RT_GROUP_ICON, id 1 = the icon Explorer shows
    RES.write_bytes(bytes(res))
    print(f"wrote {ICO.name} ({ICO.stat().st_size} bytes) and {RES.name} ({RES.stat().st_size} bytes) with sizes {SIZES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
