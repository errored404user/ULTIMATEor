#!/usr/bin/env python3
"""Regenerate src/core/gui_standard.js from the Multi-Script 6.49.9 Dev archive.

TotalScript 1.99.2 adopted Multi-Script's GUI method pack (the "Check-Clean-UI" standard
plus the roblox-production GUI method), rewritten so every tool reference names a real
TotalScript command. Both projects are GPL-3.0; the generated file carries the attribution.

    python3 tools/port_gui_standard.py [path/to/Multi-Script-6.49.9-Dev.zip]

The script is deterministic: running it twice yields a byte-identical module. Hand edits
belong HERE (SUBSTITUTIONS / TOTAL_SECTIONS), never in the generated file.
"""
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZIP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), "Multi-Script-6.49.9-Dev.zip")
OUT = os.path.join(ROOT, "src", "core", "gui_standard.js")
VERSION = "1.99.2"

z = zipfile.ZipFile(ZIP)
skills = json.loads(z.read("Multi-Script/runtime/skills.json"))
methods = json.loads(z.read("Multi-Script/runtime/skill-resources/roblox-production/methods.json"))
ccui = skills["check-clean-ui"]

# ── exact rewrites: Multi-Script tool names / unverified ids → TotalScript commands ──
SUBSTITUTIONS = [
    ("`search_asset` / the Creator Store returned it and you confirmed it loads",
     "`search_creator_store` / `ui_image_find` returned it and you confirmed it loads (glows, rings, gradients, frames and noise come from `ui_texture_create` instead)"),
    ("If they name nothing, use the Cartoon style.",
     "If they name nothing, match the UI already in the project (`ui_inspect`); with no existing UI, use the Cartoon style."),
    ("Damier (checkerboard): `rbxassetid://385956923`, tiled,",
     "Damier (checkerboard): a tiled checkerboard image (a verified project or store asset - never an invented id),"),
    ("`Checkerboard`: ImageLabel `rbxassetid://385956923`, tiled 19x19, black,",
     "`Checkerboard`: ImageLabel with a verified checkerboard image, tiled 19x19, black,"),
    ("Step 2, search the Creator Store properly with the asset scout tool (or the Studio asset search): search `kind = image` for pictures (most uploaded decals and textures are stored as Image), `kind = model` for 3D things. Use the plain noun plus a style word, and give 2 to 3 `alt_queries` (a synonym, a different style word: 'clover icon', 'lucky clover cartoon', 'shamrock emoji'). Use `+` to combine words and quotes for an exact phrase, `facets` and `tags` to narrow, verified creators first, free assets only (never pick a paid asset without asking the user). Read results across all phrasings, not just the first.",
     "Step 2, search the Creator Store properly: `ui_image_find {query}` for pictures (free decals - most uploaded icons and textures are stored as Image) and `search_creator_store {query}` for 3D things and models. Use the plain noun plus a style word, and run 2 to 3 phrasings (a synonym, a different style word: 'clover icon', 'lucky clover cartoon', 'shamrock'). Verified creators first, free assets only (never pick a paid asset without asking the user). Read results across all phrasings, not just the first."),
    ("Step 3, look at the actual pictures before choosing. The scout attaches the real thumbnails of the first results; each search result also carries a `thumbnailUrl` (fetch it to get JSON with `data[0].imageUrl` pointing to the image). Open and look at the candidates.",
     "Step 3, look at the actual pictures before choosing: place the candidates in an ImageLabel strip (`ui_decor_add` or a throw-away Frame), `ui_preview` + `total_screenshot {target:\"studio\"}`, and judge the real render; delete the strip afterwards."),
    ("Write a small helper in Luau, run it over every pair in the screen, and fix failures.",
     "`ui_audit` runs exactly this over every text / background pair (low_contrast under 3:1, weak_contrast under 4.5:1); for gradients, images and icon pairs judge the worst spot yourself, then fix failures."),
    ("Final review: Readability: run the contrast helper on every text and icon pair",
     "Final review: Readability: run `ui_audit` (and your own check for icon pairs) on every text and icon pair"),
    ("(b) the Creator Store (Toolbox) if the Studio asset tools are connected: search for the object,",
     "(b) the Creator Store via `search_creator_store` + `insert_from_creator_store`: search for the object,"),
    ("read properties back from Studio, then capture the screen at a phone size and a desktop size (the Device emulator).",
     "read properties back from Studio (`ui_layout_report`), then capture the screen at a phone size and a desktop size (`ui_preview {device:\"phone\"}` / `{device:\"desktop\"}`, each followed by `total_screenshot {target:\"studio\"}`; `ui_preview {restore:true}` afterwards)."),
]

# ── TotalScript-authored sections (always-on tool map + two optional methods) ──
TOTAL_TOOLS = [
    "TotalScript tools: every command named in this standard exists in this build. Look first: `ui_inspect`, `ui_list_tree`, `ui_find`, `ui_layout_report` (pixel boxes, overlaps, off-screen). Tokens: `design_tokens_set` (a preset or a style name such as cartoon, studded, glass, tactical, pixel, horror, plus any colour / font / radius override) and `design_tokens_get`. Whole screens: `ui_screen_generate` (main_menu, hud, shop, inventory, settings, leaderboard, daily_rewards, quest_log, loading, dialog, notification_stack, ability_bar - with their runtime scripts and remotes) or `ui_from_spec` / `ui_build_spec` from a tree measured on a 1280x720 canvas; one widget with `ui_component_place` / `ui_component`; cinematic title, pause, chapter and results screens with `ui_art_build`.",
    "TotalScript tools: styling and pictures. `ui_apply_tokens` restyles any existing tree to the tokens; `ui_font_set` sets any Enum.Font family or an uploaded font with weight, letter spacing and uppercase; `ui_text_fx` layers glow / outline / shadow on titles; `ui_texture_create` draws glows, soft circles, rings, vignettes, noise, gradients, sparkles, dividers, flourishes, frame borders, rays and grain as real image assets, so no made-up ids are ever needed; `ui_decor_add` places ornaments. Pictures come from `search_creator_store` / `ui_image_find` and only after the thumbnail was looked at.",
    "TotalScript tools: behaviour and devices. `ui_states_wire` writes the ONE controller for a screen (hover, press, open / close / toggle, keybind, gamepad) - never a script per button; `ui_bind_button`, `ui_state_toggle` and `ui_tween` for single actions; `ui_make_responsive` or `ui_responsive_fix` converts offset-only roots to Scale with aspect / size constraints; `ui_gamepad_focus` links selection neighbours and adds a cursor; server-side validation stays in the generated server scripts (Total_ShopServer, Total_AbilityServer, ...) or the project's own services.",
    "TotalScript tools: checks. `ui_audit` measures contrast, tiny / unbounded text, touch targets at desktop and phone size, overlapping siblings, static scroll canvases, palette drift, fixed-width roots, huge trees and screens without a runtime; `fix:true` applies the safe repairs (text floor, UITextSizeConstraint, minimum button size, AutomaticCanvasSize, ZIndexBehavior Sibling) and `grade` summarises. `ui_responsive_check` for layout-only scoring; `ui_preview {device:\"phone\"}` then `total_screenshot {target:\"studio\"}` to look at the real screen, and `ui_preview {restore:true}` before hand-off; `get_console_output` for LocalScript errors.",
    "TotalScript tools: order of work. inspect → tokens → build → wire → responsive → `ui_audit {fix:true}` → preview + screenshot at phone and desktop → repair → short plain report. Reuse or replace the existing ScreenGui of the same name (`replace:true`) instead of stacking a second one, and keep one controller per screen.",
]

PRODUCTION_METHOD = [
    "Production method: Inspect. Survey StarterGui and the runtime PlayerGui, existing ScreenGuis and controllers, StarterPlayer scripts, ReplicatedStorage state and remotes and the server handlers for inventory, purchases and rewards (`ui_inspect`, `ui_list_tree`, `search_game_tree`, `script_search`). For each requested screen record the owner, the state source, the local action, the authoritative request, the token module and what must be preserved. A failed or partial query is unknown, not an empty project - never create a second menu, a competing controller or a duplicate remote because inspection came back incomplete. Inventory the real item data before styling: stable ids, owned / equipped / locked flags, stock, price and currency, selected detail, pagination, the longest real label, the smallest safe viewport and the gamepad route.",
    "Production method: Design. Translate the user's exact style into one token sheet (`design_tokens_set`): semantic surface / text / status colours, type and numeric scale, spacing, panel silhouette, border and depth, icon family, texture frequency and motion timing. Plan normal, focused, pressed, disabled, pending, empty, error and success states. Keep the existing visual vocabulary unless replacement was requested, and one dominant style across adjacent menus. Specify the component set once - panel shell, header, tab, item card, rarity badge, currency display, action button, progress rail - and how columns and detail panes reflow on narrow screens instead of shrinking every label. Cartoon / studded: bold silhouettes and high-value labels over quiet card interiors, strong texture only on headers, frames and broad surfaces. Tactical / minimal: alignment, compact numeric groups, restrained callouts. Luminous / holographic: solid readable cores with local glow accents.",
    "Production method: Build. ScreenGui root, native layout objects for every managed list or grid, Scale for relationships and Offset for padding and legible detail, AnchorPoint set, aspect / size constraints where they matter. Each layout property has one owner: never overwrite UIListLayout / UIGridLayout positions from a loop. Readable TextSize with wrapping or content growth; bounded TextScaled, never both sizing rules at once. Pick ScreenInsets for the real interactive safe area rather than disabling insets. Shops and inventories are reusable data-bound cards (icon well, name, explicit rarity, quantity or stock, price, one primary action) with search / sort / category controls outside the scrolling area; when width is constrained drop columns and move the detail pane below the grid. Depth comes from layered frames, UIStroke, UICorner, UIGradient and verified images at an intentional tile / slice scale - there is no CSS blur or box-shadow. Keep pattern layers beneath labels, avoid nested clipping that cuts strokes, and give icons a consistent optical size.",
    "Production method: Integrate. Connect Activated through the existing controller (`ui_states_wire`) and trace input → validation → state → visual feedback for every visible action. A shop uses real item definitions, an authoritative price / balance / result and pending / refused / retry states - a decorative Buy button is unfinished. Inventory needs stable item keys, selection, filter / sort, an empty state and authorised equip / use actions. HUD values come from real state events. The client may predict feedback but never grants currency, purchases or damage. One modal / navigation state with focus capture and return, back / cancel and input-lock ownership. Cancel or retarget old tweens and guard completions with a generation counter so a stale close cannot hide a reopened screen. Initialise idempotently; tear down connections, render bindings, temporary instances and input locks on destroy and respawn. Closing or sorting a panel must not retarget an in-flight action to the newly displayed index. Shimmer, floating icons and confetti stop when the panel is hidden.",
    "Production method: Verify. Exercise the real screen through its normal entry point. Check desktop and a narrow viewport (`ui_preview` + `total_screenshot`, `ui_layout_report`), touch reach, gamepad selection, long names and numbers, safe insets, stacking, scroll extent and texture scale. Activate every control; test repeated open / close, rapid reopen during a tween, pending requests, server refusal, missing assets, empty inventory, zero / one / many items, owned / sold-out / locked states, search with no results and a selected item disappearing after an update. Count duplicate callbacks and retained cards after teardown; read `get_console_output`. Compare the capture with the token sheet at thumbnail size and in greyscale: title, icon, name and primary action must form one reading sequence. Report authored hierarchy, applied changes, live tests and visual evidence separately; whatever could not be captured or played stays unverified.",
    "Production method: Failures - find the failed layer before redesigning. Invisible GUI: owner (StarterGui vs runtime PlayerGui), Enabled / Visible, LocalScript start-up and errors. Dead or double buttons: the actual Activated target, duplicate initialisation, in-flight ownership. Phone clipping: anchors, content growth, constraints and safe insets - do not shrink every label. Jitter: layout versus tween competition and stale callbacks. A closed panel still blocking play: release its backdrop, focus and input lock. Missing icons: asset permission / id, then a usable fallback. Currency reverting: the authoritative result binding. Large inventories: bounded or virtualised rows and event-driven diffs, never a full rebuild per frame. A screen that reads as a plain rectangle with bright buttons is missing hierarchy, icon silhouette, border / depth consistency and spacing - fix those before adding effects; a noisy screen needs a quieter surface behind text and fewer competing accents. Never switch the project to a new style to hide weak execution.",
]

TACTICAL_RULES = [  # merged into "Realistic style" (its triggers already cover tactical / military / fps)
    "Realistic style, tactical: disciplined alignment, controlled accent and status colours, legible numeric data and predictable navigation. Base slate or olive (24,28,30) / (34,40,38), panels one step lighter, hairline strokes (1 px, 0.7 transparency), corners 2 to 4 px or square, chevron or bracket corner marks drawn from thin Frames. One accent (amber (255,176,46) or signal green (120,220,120)); red is reserved for danger. Fonts: `RobotoMono` or `Code` for numbers and readouts, `Michroma`, `Jura` or `GothamBold` for headers in uppercase with 1 to 2 px tracking (`ui_font_set`).",
    "Realistic style, tactical: state is never colour alone - every status colour carries a label or icon (AMMO 24 / 120, RELOADING, LOCKED). Numbers right-align in monospace columns; units are smaller and muted; bars are thin with tick marks. HUD: ammo and health bottom-right / bottom-left above the thumb zones, compass or objective strip top-centre under the top bar, kill feed and hit markers short-lived and pooled. Loadout and attachment screens: category list left, item grid centre, stats and compare pane right, with callout lines anchored to real item features and never crossing the silhouette; weight and constraints sit next to the confirm button.",
    "Realistic style, tactical: motion is short and linear-to-quad (0.08 to 0.15 s), scanline or grid textures from `ui_texture_create` stay under 0.9 transparency behind text, selected / available / unavailable states read in greyscale, and controller selection is tested across zoom and viewport changes - a still reference's callout positions are not fixed coordinates for every camera.",
]

TOTAL_TRIGGERS = {
    "Production method": ["fix", "repair", "broken", "not showing", "not visible", "invisible", "doesn't open", "does not open", "won't open", "not working", "nothing happens", "rebuild", "restyle", "redesign", "workflow", "plan", "integrate", "wire", "connect", "existing ui", "existing gui", "match the existing", "production", "polish", "professional", "shop", "inventory", "hud"],
}
TOTAL_BOOST = {"Production method": 60}

# style section → design_tokens_set style key (studio_design.js STYLES); kept here so the
# standard, the token generator and the enhancer agree on one vocabulary.
STYLE_KEYS = {
    "Cartoon style": "cartoon", "Sleek modern style": "sleek", "Glass style": "glass", "Horror style": "horror",
    "Sci-fi style": "scifi", "Fantasy style": "fantasy", "Minimal style": "minimal", "Retro style": "retro",
    "Realistic style": "realistic", "Studded style": "studded", "Skeuomorphic style": "skeuomorphic",
    "Steampunk style": "steampunk", "Comic style": "comic", "Clay and candy style": "candy", "Neumorphism style": "neumorphic",
    "Neubrutalism style": "neubrutalist", "Y2K and retro OS style": "y2k", "Pixel style": "pixel", "Paper and sticker style": "paper",
    "Blueprint and terminal style": "terminal", "Holographic and iridescent style": "holographic", "Aurora and gradient style": "aurora",
    "Low-poly and geometric style": "lowpoly", "Dark mode and bento layouts": "bento", "Anime and gacha style": "gacha",
    "Studded shop screen": "studded", "Candy and sweets style": "candy",
}


def head_of(step):
    h = step.split(":", 1)[0] if ":" in step[:60] else ""
    return h if len(h) <= 40 else ""  # the long "Mandatory standard ...:" opener is preface, not a section


optional = dict(ccui["ruleSections"])
optional.update(TOTAL_TRIGGERS)
defaults = dict(ccui["ruleSectionDefaults"])
boost = dict(ccui["ruleSectionBoost"])
boost.update(TOTAL_BOOST)

steps = list(ccui["steps"])
for old, new in SUBSTITUTIONS:
    n = sum(s.count(old) for s in steps)
    assert n == 1, (old, n)
    steps = [s.replace(old, new) for s in steps]

preface, order, by_head = [], [], {}
for s in steps:
    h = head_of(s)
    if not h:
        preface.append(s)
        continue
    if h not in by_head:
        by_head[h] = []
        order.append(h)
    by_head[h].append(s)

# splice TotalScript sections: tool map right after Core, methods at the end
order.insert(order.index("Core") + 1, "TotalScript tools")
by_head["TotalScript tools"] = TOTAL_TOOLS
order.append("Production method")
by_head["Production method"] = PRODUCTION_METHOD
by_head["Realistic style"] = by_head["Realistic style"] + TACTICAL_RULES

joined = "\n".join(preface + [x for h in order for x in by_head[h]])
assert not re.search(r"rbxassetid://\d+", joined), "unverified asset id leaked into the standard"
assert "search_asset" not in joined and "ms_" not in joined and "Multi-Script" not in joined
for h in optional:
    assert h in by_head, "trigger section without rules: " + h
for h in defaults["Cartoon style"]:
    assert h in optional, h
style_sections = set(defaults["Cartoon style"]) | {"Cartoon style"}
for h in style_sections:
    assert h in STYLE_KEYS, h

sections = []
for h in order:
    kind = "style" if h in style_sections else ("optional" if h in optional else "always")
    sections.append({"id": re.sub(r"[^a-z0-9]+", "_", h.lower()).strip("_"), "title": h, "kind": kind, "rules": by_head[h]})

total_chars = sum(len(r) for s in sections for r in s["rules"]) + sum(len(p) for p in preface)


def js(v):
    return json.dumps(v, ensure_ascii=False, indent=2)


header = f"""/*
 * TotalScript GUI standard ({VERSION}) - the rulebook behind every ScreenGui the AI builds.
 *
 * Ported from Multi-Script 6.49.9 Dev by KrazyCheesitz (GPL-3.0-or-later; a ZeroScript-lineage
 * sibling of TotalScript): skill "check-clean-ui" (runtime/skills.json) and the roblox-production
 * GUI method (skill-resources/roblox-production/GUI.md + methods.json). Adapted for TotalScript:
 * every tool reference names a real TotalScript command, no asset ids are carried over, and the
 * "TotalScript tools" and "Production method" sections and the tactical rules are TotalScript additions.
 * TotalScript is GPL-3.0 as well; this notice is the attribution.
 *
 * GENERATED by tools/port_gui_standard.py - edit the generator, not this file.
 *
 * Shape: PREFACE + SECTIONS (kind always | style | optional). Always-on sections are sent whole;
 * optional ones only when the request mentions one of their trigger words (TRIGGERS), best match
 * first within a character budget, exactly like the source's selective loader. When no style
 * section matches, the Cartoon section stands in (DEFAULT_STYLE), as the source does.
 *
 * API (DOM-free, no storage, no network):
 *   select(text, {{budget, only}})  -> {{rows, chosen, skipped, style}}
 *   render(text, {{budget, only}})  -> string for `skill {{name:"ui_ux", section|query}}`
 *   brief(text, {{tight}})          -> <=700 (320 tight) chars for the expert rider
 *   styleFor(text)                 -> {{section, style}}  (style = design_tokens_set style key)
 *   sectionNames(), matchSections(ref), VERSION, SOURCE, STYLE_KEYS, TOTAL_CHARS
 */
"""

body = f"""(function (root) {{
  "use strict";
  const VERSION = {js(VERSION)};
  const SOURCE = {{ project: "Multi-Script", version: "6.49.9-Dev", author: "KrazyCheesitz", license: "GPL-3.0-or-later", skill: "check-clean-ui", method: "roblox-production/GUI.md", portedBy: "TotalScript tools/port_gui_standard.py" }};
  const TOTAL_CHARS = {total_chars};
  const DEFAULT_STYLE = "Cartoon style";
  const PREFACE = {js(preface)};
  const SECTIONS = {js(sections)};
  const TRIGGERS = {js(optional)};
  const DEFAULTS = {js(defaults)};
  const BOOST = {js(boost)};
  const STYLE_KEYS = {js(STYLE_KEYS)};

  const BY_TITLE = {{}};
  SECTIONS.forEach((s, i) => {{ s.index = i; BY_TITLE[s.title] = s; }});
  const STYLE_TITLES = SECTIONS.filter((s) => s.kind === "style").map((s) => s.title);
  const norm = (t) => String(t || "").toLowerCase().replace(/[\\u2018\\u2019]/g, "'");

  // Word-boundary hit test over the request text (mirrors the source's _has_word): the trigger
  // may be a phrase; letters / digits on either side disqualify ("hud" does not match "shudder").
  function hasWord(text, w) {{
    const i = text.indexOf(w);
    if (i < 0) return false;
    let from = 0;
    while (true) {{
      const k = text.indexOf(w, from);
      if (k < 0) return false;
      const before = k === 0 ? " " : text[k - 1];
      const after = k + w.length >= text.length ? " " : text[k + w.length];
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      from = k + 1;
    }}
  }}
  const hits = (text, title) => (TRIGGERS[title] || []).filter((w) => hasWord(text, w));
  function scoreOf(text, title) {{
    let s = hits(text, title).length;
    if (!s) return 0;
    if (STYLE_KEYS[title]) s += 95;
    return s + (BOOST[title] || 0);
  }}
  // matchSections("studded") -> ["Studded style", "Studded shop screen"]; exact title, id, style key or trigger word.
  function matchSections(ref) {{
    const r = norm(ref).trim();
    if (!r) return [];
    const out = [];
    for (const s of SECTIONS) {{
      const t = s.title.toLowerCase();
      if (t === r || s.id === r.replace(/[^a-z0-9]+/g, "_") || STYLE_KEYS[s.title] === r || t.indexOf(r) >= 0 || (TRIGGERS[s.title] || []).indexOf(r) >= 0) out.push(s.title);
    }}
    return out;
  }}
  // styleFor(text) -> the style section the request names (or the default), plus the token style key.
  function styleFor(text) {{
    const t = " " + norm(text) + " ";
    let best = "", bestScore = 0;
    for (const title of STYLE_TITLES) {{
      const sc = scoreOf(t, title);
      if (sc > bestScore) {{ best = title; bestScore = sc; }}
    }}
    const named = !!best;
    const section = best || DEFAULT_STYLE;
    return {{ section, style: STYLE_KEYS[section] || "cartoon", named }};
  }}
  // select(text, {{budget, only}}) - port of the source's _rules_for_request.
  function select(text, opts) {{
    opts = opts || {{}};
    const t = " " + norm(text) + " ";
    const only = opts.only ? [].concat(opts.only).map((x) => matchSections(x)).reduce((a, b) => a.concat(b), []) : null;
    const wanted = (title) => {{
      if (only) return only.indexOf(title) >= 0;
      if (hits(t, title).length) return true;
      if (DEFAULTS[title]) return !DEFAULTS[title].some((o) => TRIGGERS[o] && hits(t, o).length);
      return false;
    }};
    let rows = [], skipped = [];
    for (const s of SECTIONS) {{
      if (s.kind === "always") {{ if (!only) rows.push(s); continue; }}
      if (wanted(s.title)) rows.push(s); else skipped.push(s.title);
    }}
    const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 0;
    const st = styleFor(text);
    const prio = (title) => (title === st.section ? 1e6 : 0) + scoreOf(t, title); // the request's style section always goes first
    if (budget) {{
      const fixed = rows.filter((s) => s.kind === "always").reduce((n, s) => n + s.rules.join("\\n").length, 0) + (only ? 0 : PREFACE.join("\\n").length);
      let room = Math.max(0, budget - fixed);
      const opt = rows.filter((s) => s.kind !== "always").sort((a, b) => (prio(b.title) - prio(a.title)) || (a.index - b.index));
      const keep = new Set();
      for (const s of opt) {{
        const size = s.rules.join("\\n").length;
        if (size <= room) {{ keep.add(s.title); room -= size; }} else skipped.push(s.title);
      }}
      rows = rows.filter((s) => s.kind === "always" || keep.has(s.title));
    }}
    skipped = skipped.filter((x, i, a) => a.indexOf(x) === i);
    return {{ rows, chosen: rows.map((s) => s.title), skipped, style: st, only: !!only }};
  }}
  // render(text, opts) -> the text block for the `skill` command.
  function render(text, opts) {{
    opts = opts || {{}};
    const sel = select(text, opts);
    const L = [];
    L.push("GUI STANDARD (TotalScript " + VERSION + ") - " + (sel.only ? "requested section(s)" : "sections for this request") + ": " + (sel.chosen.join(", ") || "none") + ".");
    if (!sel.only) {{
      L.push("Style for this request: " + sel.style.section + (sel.style.named ? "" : " (nothing named - match the project's existing UI first)") + "; tokens: design_tokens_set {{style: \\"" + sel.style.style + "\\"}}.");
      L.push("");
      PREFACE.forEach((p) => L.push(p));
    }}
    for (const s of sel.rows) {{
      L.push("", "## " + s.title);
      s.rules.forEach((r) => L.push("- " + r));
    }}
    if (sel.skipped.length) L.push("", "Not shown (not needed for this request, or kept out for length) - load with skill {{name: \\"ui_ux\\", section: \\"<name>\\"}}: " + sel.skipped.join(", ") + ".");
    L.push("", "This standard is guidance only: nothing ran. Commands, permissions and validation stay authoritative; the user's explicit instructions win.");
    return L.join("\\n");
  }}
  // brief(text, {{tight}}) -> one compact paragraph for the expert rider (first tool result).
  const BRIEF_RULES = [
    "one style family per screen and one token sheet (design_tokens_set)",
    "Scale for layout, Offset only for padding / borders / icons; UIListLayout / UIGridLayout, never hand-placed rows",
    "Activated for clicks, every state reachable without hover, touch and gamepad",
    "no emoji or symbol characters in any UI text - icons are images, drawn shapes or ViewportFrames",
    "4.5:1 text contrast, buttons >= 40 px on phones, text >= 12 px, nothing clipped, every list / tab filled with real entries",
    "finish with ui_audit {{fix:true}}, ui_preview phone + desktop and total_screenshot, then a short plain report",
  ];
  function brief(text, opts) {{
    opts = opts || {{}};
    const st = styleFor(text);
    const cap = opts.tight ? 320 : 700;
    const head = "(GUI standard from TotalScript, not the user.) Style: " + st.section + (st.named ? "" : " unless the project already has a UI to match") + " (design_tokens_set {{style: \\"" + st.style + "\\"}}). Rules: ";
    const tail = " Full standard: skill {{name: \\"ui_ux\\"}}; a section: skill {{name: \\"ui_ux\\", section: \\"" + st.section + "\\"}}.";
    let body = "";
    for (const r of BRIEF_RULES) {{
      const next = body ? body + "; " + r : r;
      if (head.length + next.length + tail.length + 1 > cap) break;
      body = next;
    }}
    return head + body + "." + tail;
  }}
  const api = {{ VERSION, SOURCE, TOTAL_CHARS, DEFAULT_STYLE, PREFACE, SECTIONS, TRIGGERS, DEFAULTS, BOOST, STYLE_KEYS, select, render, brief, styleFor, matchSections, sectionNames: () => SECTIONS.map((s) => s.title), hasWord }};
  root.TotalGuiStandard = api;
}})(typeof window !== "undefined" ? window : globalThis);
"""

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(header + body)
print("wrote", OUT, len(header + body), "bytes;", len(sections), "sections;", total_chars, "rule chars")
