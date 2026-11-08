// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript image pack (2.15.0) - the catalogue half of the Image Studio.
//
// Registers the image_* commands (descriptions + params so the command contract
// validates calls and the model sees them in the catalogue). The commands run in
// the browser (src/core/imagegen.js via main.js), not as Luau: image_generate
// talks to the user's image API or asks the chat to draw, image_pickup reads a
// picture from the reply, image_thumbnail exports a PNG. Only image_to_gui ends
// in Studio - its Luau comes from TotalImageGen.studioLuau so the parser check
// can compile it; main.js intercepts the command before buildLuau either way.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.15.0";
  // imagegen.js loads later in the bundle (just before videostudio.js), so resolve it lazily.
  const ig = () => (typeof TotalImageGen !== "undefined" && TotalImageGen) || (typeof window !== "undefined" && window.TotalImageGen) || null;
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const KINDS = "thumbnail|icon|gui_background|gui_panel|gui_button|gui_icon|texture";
  const STYLES = "roblox|cartoon|flat|realistic|pixel|neon|painterly|clean";

  const C = [
    { name: "image_generate", description: "Create a picture for a game thumbnail, icon or GUI (background, panel, button, icon, tileable texture). Source auto = the user's image API key when configured (Images window), else THIS chat draws it: the result then tells you to generate the picture in your next reply and call image_pickup after it is visible. API results are finished PNGs (thumbnail 1920x1080, icon 512x512) attached to the message and registered as an image id for image_to_gui / image_thumbnail. Never claim an image exists that the result did not return.", params: { prompt: S("string", true, "what the picture shows"), kind: S("string", false, KINDS + " (default gui_panel)"), style: S("string", false, STYLES), title: S("string", false, "bold title text (thumbnails; <= 3 words)"), palette: S("string", false), transparent: S("boolean", false, "transparent background (gui_icon default)"), name: S("string", false, "image name / id alias"), source: S("string", false, "auto|api|chat") } },
    { name: "image_pickup", description: "Read the newest picture from the assistant's earlier replies (one this chat drew, or one the user attached) into the image registry and attach it back for judging. Call it in the reply AFTER the picture is visible, never in the same reply that draws it.", params: { name: S("string", false), kind: S("string", false, KINDS + " - fits the picture to that size; omit to keep it as is"), which: S("number", false, "1 = newest (default), 2 = the one before"), again: S("boolean", false, "allow re-reading an already picked picture") } },
    { name: "image_to_gui", description: "Put a registered image into a GUI in Studio. Pixels -> EditableImage -> ImageLabel.ImageContent (LIVE preview, session-only - it is not saved with the place) or, with publish:true (approval gate), AssetService:CreateAssetAsync -> a permanent Image asset set as .Image (rbxassetid). target = an ImageLabel/ImageButton (bound in place), any GuiObject/ScreenGui (child ImageLabel created), or empty (StarterGui.TotalImages.<name>). Returns path, mode live|published, asset_id, scale_type.", params: { image: S("string", false, "image id from image_generate / image_pickup (default latest)"), target: S("string", false, "StarterGui.HUD.Logo"), name: S("string", false, "ImageLabel name"), kind: S("string", false, "gui_background|gui_panel|gui_button|gui_icon|texture"), publish: S("boolean", false, "upload as an Image asset (permanent; asks the user unless publish automation is on)"), scale_type: S("string", false, "Stretch|Slice|Tile|Fit|Crop"), slice: S("object", false, "{x,y,w,h} SliceCenter for 9-slice panels"), studio_size: S("number", false, "max edge of the live EditableImage, 16..512 (default 256; 512 with the Studio plugin)") } },
    { name: "image_thumbnail", description: "Export a registered image as a finished store image: thumbnail 1920x1080 or icon 512x512 (cover-cropped, or fit:contain with a background colour). Downloads the PNG and attaches it to the message. Studio has NO API for an experience thumbnail or icon - the user uploads the file on the Creator Dashboard; the result says exactly where.", params: { image: S("string", false, "image id (default latest)"), kind: S("string", false, "thumbnail|icon (default thumbnail)"), fit: S("string", false, "cover|contain"), background: S("string", false, "#000 - letterbox colour for fit:contain"), name: S("string", false, "file name stem") } },
    { name: "image_list", description: "List the images registered in this session (id, name, kind, size, source, where they were sent).", params: {}, hidden: true },
  ];

  function build(op, args) {
    if (!C.some((c) => c.name === op)) return null;
    if (op === "image_to_gui") {
      const a = args || {};
      const IG = ig();
      if (!IG || typeof IG.studioLuau !== "function") return { err: "ERROR building image_to_gui: src/core/imagegen.js is not loaded" };
      // Pixels never travel through the model's call: main.js resolves the
      // registry entry and calls studioLuau with the real RGBA payload. A call
      // that reaches buildLuau directly gets a 2x2 placeholder (parser check).
      const b64 = typeof a._b64 === "string" ? a._b64 : "/wAA//8AAP//AAD//wAA/w==";
      const code = IG.studioLuau({ w: a._w || 2, h: a._h || 2, b64, name: a.name || "TotalImage", target: a.target, kind: a.kind, publish: a.publish === true, scale_type: a.scale_type, slice: a.slice });
      return { code, lib: "", body: code };
    }
    return { err: "ERROR building " + op + ": this command runs in the browser (TotalScript Image Studio), main.js dispatches it before any Luau is built" };
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = build(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.IMAGE_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.IMAGE_VERSION = VERSION;
})();
