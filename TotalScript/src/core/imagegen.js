// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/imagegen.js — TotalScript Image Studio (2.22.0)
//
// AI-generated images for game thumbnails, icons and GUI art, carried into
// Roblox Studio. Three honest sources:
//   * api  — independent key profiles for OpenAI, Google Imagen, Stability AI,
//            Replicate, or any OpenAI-compatible endpoint. The keys stay in
//            chrome.storage.local and are read only by background.js - never
//            by the AI, never in a prompt, never in a diagnostic.
//   * chat — the AI site draws the picture itself (ChatGPT, Gemini, Qwen, Meta
//            AI … whichever chat can); image_pickup grabs the newest picture
//            from the assistant's reply and reads its pixels.
//   * file — the user drops a PNG / JPG / WebP into the Images window.
// Delivery:
//   * thumbnails / icons → a finished PNG (1920x1080 / 512x512, cover-cropped),
//     downloaded and attached to the chat. Studio has NO API for a place
//     thumbnail - the user uploads it on the Creator Dashboard, the result says so.
//   * GUI art → Studio: RGBA pixels → EditableImage → ImageLabel.ImageContent
//     (live preview, session-only) and, when approved, AssetService:CreateAssetAsync
//     → a permanent rbxassetid (the same gated path the Blender texture carry uses).
// The pure parts (specs, prompt builder, API request / response shaping, the
// Studio Luau) are testable in node + lupa; the pixel work needs a browser.
//
// Public API (window.TotalImageGen): VERSION, KINDS, STYLES, COMMANDS,
//   spec(kind), buildPrompt(opts), apiRequest(opts), parseApiResponse(json),
//   apiSizeFor(model, kind), pickupCandidates(items, opts), studioLuau(p),
//   registry list()/get()/add(), run(name, args, hooks), open(hooks), close(), isOpen()
(() => {
  "use strict";
  const G = typeof window !== "undefined" ? window : globalThis;
  if (G.TotalImageGen) return;
  const VERSION = "2.22.0";

  // ───────────────────────── specs ─────────────────────────
  // w/h = delivered PNG size; studio = max EditableImage edge for the live carry
  // (null = not meant for Studio); fit = how a source is mapped onto the box.
  const KINDS = {
    thumbnail:      { label: "Game thumbnail",         w: 1920, h: 1080, aspect: "16:9", studio: null, fit: "cover",   where: "Creator Dashboard → your experience → Thumbnails (Studio has no API for it)" },
    icon:           { label: "Game icon",              w: 512,  h: 512,  aspect: "1:1",  studio: null, fit: "cover",   where: "Creator Dashboard → your experience → Icon" },
    gui_background: { label: "GUI background / splash", w: 1920, h: 1080, aspect: "16:9", studio: 512, fit: "cover" },
    gui_panel:      { label: "GUI panel / frame",      w: 1024, h: 1024, aspect: "1:1",  studio: 512, fit: "contain" },
    gui_button:     { label: "GUI button",             w: 1024, h: 512,  aspect: "2:1",  studio: 512, fit: "contain" },
    gui_icon:       { label: "GUI icon (transparent)", w: 512,  h: 512,  aspect: "1:1",  studio: 256, fit: "contain", transparent: true },
    texture:        { label: "Tileable texture",       w: 1024, h: 1024, aspect: "1:1",  studio: 512, fit: "cover" },
  };
  const KIND_IDS = Object.keys(KINDS);
  const STYLES = {
    roblox:    "stylized 3D render in the look of a modern Roblox game, bright saturated colours, soft studio lighting, crisp edges",
    cartoon:   "bold cartoon illustration, thick clean outlines, flat cel shading, playful proportions",
    flat:      "flat vector UI art, simple geometric shapes, two-tone shading, no gradients noise, pixel-perfect edges",
    realistic: "realistic concept art, physically based lighting, detailed materials",
    pixel:     "pixel art, 1-pixel outlines, limited palette, crisp pixels, no anti-aliasing",
    neon:      "neon cyberpunk, glowing magenta and cyan edges on dark backgrounds, bloom",
    painterly: "painterly digital illustration, visible brush strokes, warm light",
    clean:     "clean minimal design, generous negative space, soft shadows, premium feel",
  };
  const STYLE_IDS = Object.keys(STYLES);
  const COMMANDS = ["image_generate", "image_pickup", "image_to_gui", "image_thumbnail", "image_list"];
  const SOURCES = ["auto", "api", "chat", "file"];
  // API profiles are independent: selecting a provider chooses its own endpoint,
  // model and key. Provider endpoints are pinned for native integrations so a
  // credential cannot be sent to a user-edited host; `compatible` is the
  // explicit escape hatch for OpenRouter, Together, local servers, etc.
  const API_PROVIDERS = Object.freeze({
    openai: Object.freeze({ label: "OpenAI", protocol: "openai-compatible", base: "https://api.openai.com/v1", model: "gpt-image-1", keyLabel: "OpenAI API key", baseEditable: false, note: "OpenAI Images API. Uses your OpenAI billing and key." }),
    google: Object.freeze({ label: "Google Imagen", protocol: "google-imagen", base: "https://generativelanguage.googleapis.com/v1beta", model: "imagen-4.0-generate-001", keyLabel: "Google AI Studio API key", baseEditable: false, note: "Google Imagen 4 via the Gemini API. Enable the API and use an AI Studio key with access." }),
    stability: Object.freeze({ label: "Stability AI", protocol: "stability", base: "https://api.stability.ai", model: "core", keyLabel: "Stability AI API key", baseEditable: false, note: "Stable Image API; model can be core or ultra. Returns PNG image bytes." }),
    replicate: Object.freeze({ label: "Replicate", protocol: "replicate", base: "https://api.replicate.com", model: "black-forest-labs/flux-schnell", keyLabel: "Replicate API token", baseEditable: false, note: "Runs a Replicate model path (owner/name); returns a PNG URL after the prediction finishes." }),
    compatible: Object.freeze({ label: "OpenAI-compatible / custom", protocol: "openai-compatible", base: "", model: "", keyLabel: "Provider API key", baseEditable: true, note: "For OpenRouter, Together AI, a local server or another service implementing POST /images/generations. Enter its base URL and model." }),
  });
  const API_PROVIDER_IDS = Object.keys(API_PROVIDERS);
  const OPENAI_DEFAULT_BASE = API_PROVIDERS.openai.base;

  const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const kindOf = (k) => (KINDS[String(k || "").toLowerCase()] ? String(k).toLowerCase() : null);
  const styleOf = (s) => (STYLES[String(s || "").toLowerCase()] ? String(s).toLowerCase() : null);
  function spec(kind) {
    const id = kindOf(kind) || "gui_panel";
    return Object.assign({ id }, KINDS[id]);
  }

  // ───────────────────────── prompt builder (pure) ─────────────────────────
  // Roblox-aware art direction on top of the user's words. The negative list is
  // returned separately: most image APIs have no negative field, so it is folded
  // into the prompt as "no …" when the caller asks (fold:true).
  function buildPrompt(o) {
    o = o || {};
    const kind = kindOf(o.kind) || "gui_panel", K = KINDS[kind];
    const style = styleOf(o.style) || (kind === "gui_icon" || kind === "gui_button" || kind === "gui_panel" ? "flat" : "roblox");
    const subject = String(o.prompt || o.subject || "").trim();
    const title = String(o.title || "").trim();
    const palette = String(o.palette || "").trim();
    const transparent = o.transparent === true || (o.transparent !== false && !!K.transparent);
    const parts = [];
    const neg = ["watermark", "signature", "blurry", "low resolution", "deformed hands", "extra limbs"];
    if (kind === "thumbnail") {
      parts.push(`Roblox game thumbnail, ${K.aspect} landscape, one clear focal subject in the centre-left third facing the camera, strong silhouette, high contrast against the background, readable at 10% size`);
      if (!title) neg.push("text", "letters", "logo");
    } else if (kind === "icon") {
      parts.push("Roblox game icon, square, one bold centred subject filling 70% of the frame, simple background, readable at 64 pixels");
      if (!title) neg.push("text", "letters");
    } else if (kind === "gui_background") {
      parts.push(`game menu background art, ${K.aspect}, calm composition with the centre and lower third kept uncluttered so UI text stays readable, soft depth of field`);
      neg.push("text", "letters", "UI buttons", "logo");
    } else if (kind === "gui_panel") {
      parts.push("game UI panel frame, square, ornate border with an empty flat centre area, symmetrical, front view, isolated on a plain background");
      neg.push("text", "letters", "perspective", "photo");
    } else if (kind === "gui_button") {
      parts.push("game UI button, wide rounded rectangle, front view, empty centre for a label, consistent bevel and shadow, isolated on a plain background");
      neg.push("text", "letters", "perspective");
    } else if (kind === "gui_icon") {
      parts.push("game UI icon, single object centred, consistent 2px outline, simple readable shape, isolated");
      neg.push("text", "letters", "background scene", "shadow on ground");
    } else if (kind === "texture") {
      parts.push("seamless tileable texture, top-down orthographic, even lighting, no vignette, repeats without visible seams");
      neg.push("text", "objects", "perspective", "vignette");
    }
    if (subject) parts.push(subject);
    parts.push(STYLES[style]);
    if (palette) parts.push(`palette: ${palette}`);
    if (title) parts.push(`bold title text "${title}" in a chunky display font, spelled exactly`);
    if (transparent) parts.push("transparent background, no backdrop");
    let prompt = parts.join(". ") + ".";
    if (o.fold !== false) prompt += " No " + neg.join(", no ") + ".";
    return { prompt, negative: neg, kind, style, transparent };
  }

  // ───────────────────────── API profiles + request shaping ─────────────────────────
  // Older installs stored {base, model, key} at the top level. Migrate that
  // shape while preserving custom endpoints as the explicit `compatible` profile.
  function normalizeApiConfig(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const profilesIn = raw.profiles && typeof raw.profiles === "object" ? raw.profiles : null;
    const profiles = {};
    if (profilesIn) {
      for (const id of API_PROVIDER_IDS) {
        const saved = profilesIn[id] && typeof profilesIn[id] === "object" ? profilesIn[id] : {};
        const defaults = API_PROVIDERS[id];
        const savedModel = String(saved.model == null ? defaults.model : saved.model).trim();
        profiles[id] = {
          // Native provider keys are pinned to their official host. Only the
          // explicitly custom profile accepts a user-entered base URL.
          base: id === "compatible" ? String(saved.base == null ? defaults.base : saved.base).trim() : defaults.base,
          model: id !== "compatible" && !savedModel ? defaults.model : savedModel,
          key: String(saved.key || ""),
        };
      }
    }
    let legacyProvider = null;
    if (!profilesIn && ("base" in raw || "model" in raw || "key" in raw)) {
      const legacyBase = String(raw.base || "").trim().replace(/\/+$/, "");
      legacyProvider = API_PROVIDER_IDS.includes(raw.provider) ? raw.provider :
        (legacyBase && legacyBase !== OPENAI_DEFAULT_BASE ? "compatible" : "openai");
      const defaults = API_PROVIDERS[legacyProvider];
      const legacyModel = String(raw.model == null ? defaults.model : raw.model).trim();
      profiles[legacyProvider] = {
        base: legacyProvider === "compatible" ? String(raw.base == null ? defaults.base : raw.base).trim() : defaults.base,
        model: legacyProvider !== "compatible" && !legacyModel ? defaults.model : legacyModel,
        key: String(raw.key || ""),
      };
    }
    for (const id of API_PROVIDER_IDS) {
      if (!profiles[id]) profiles[id] = { base: API_PROVIDERS[id].base, model: API_PROVIDERS[id].model, key: "" };
    }
    const provider = API_PROVIDER_IDS.includes(raw.provider) ? raw.provider : (legacyProvider || "openai");
    return { version: 2, provider, profiles };
  }
  function publicApiConfig(raw) {
    const config = normalizeApiConfig(raw), profiles = {};
    for (const id of API_PROVIDER_IDS) {
      const p = config.profiles[id];
      profiles[id] = { base: p.base, model: p.model, configured: !!p.key, key_masked: p.key ? "…" + p.key.slice(-4) : "" };
    }
    const active = config.profiles[config.provider];
    // Never return a raw key to the page/content-script side.
    return { ok: true, provider: config.provider, configured: !!active.key, base: active.base, model: active.model, key_masked: active.key ? "…" + active.key.slice(-4) : "", profiles };
  }

  // OpenAI's documented model-family rules stay unchanged; the remaining
  // profiles use their native request and response contracts below.
  function modelFamily(model) {
    const m = String(model || "").toLowerCase();
    if (/gpt-image/.test(m)) return "gpt-image";
    if (/dall-e-3/.test(m)) return "dall-e-3";
    if (/dall-e-2/.test(m)) return "dall-e-2";
    return "generic";
  }
  function apiSizeFor(model, kind) {
    const K = KINDS[kindOf(kind) || "gui_panel"];
    const landscape = K.w > K.h;
    const fam = modelFamily(model);
    if (!landscape) return "1024x1024";
    if (fam === "gpt-image") return "1536x1024";
    if (fam === "dall-e-3") return "1792x1024";
    return "1024x1024";
  }
  function imageAspectFor(kind) {
    const K = KINDS[kindOf(kind) || "gui_panel"];
    return K.w > K.h ? "16:9" : "1:1";
  }
  function apiRequest(o) {
    o = o || {};
    const provider = API_PROVIDER_IDS.includes(String(o.provider || "")) ? String(o.provider) : "openai";
    const meta = API_PROVIDERS[provider];
    const configuredModel = String(o.model == null ? meta.model : o.model).trim();
    const model = provider !== "compatible" && !configuredModel ? meta.model : configuredModel;
    const prompt = String(o.prompt || "");
    const rawBase = provider === "compatible" ? (o.base == null ? meta.base : o.base) : meta.base;
    const base = String(rawBase || "").trim().replace(/\/+$/, "");
    if (provider === "google") {
      return { provider, protocol: meta.protocol, method: "POST", url: base + "/models/" + encodeURIComponent(model) + ":predict",
        body: { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: imageAspectFor(o.kind), outputMimeType: "image/png" } }, family: meta.protocol };
    }
    if (provider === "stability") {
      return { provider, protocol: meta.protocol, method: "POST", url: base + "/v2beta/stable-image/generate/" + encodeURIComponent(model),
        form: { prompt, output_format: "png", aspect_ratio: imageAspectFor(o.kind) }, family: meta.protocol };
    }
    if (provider === "replicate") {
      const parts = model.split("/");
      return { provider, protocol: meta.protocol, method: "POST", url: base + "/v1/models/" + parts.map(encodeURIComponent).join("/") + "/predictions",
        body: { input: { prompt, aspect_ratio: imageAspectFor(o.kind), output_format: "png" } }, family: meta.protocol };
    }
    const fam = modelFamily(model);
    const body = { model, prompt, n: 1, size: apiSizeFor(model, o.kind) };
    if (fam === "gpt-image") {
      body.output_format = "png";
      if (o.transparent) body.background = "transparent";
    } else {
      body.response_format = "b64_json";
    }
    return { provider, protocol: meta.protocol, method: "POST", url: base + "/images/generations", body, family: fam };
  }
  function parseApiResponse(j, provider) {
    if (!j || typeof j !== "object") return { error: "empty response" };
    if (j.error || j.errors) {
      const problem = j.error || j.errors;
      let message = problem && (problem.message || problem.code);
      if (!message) { try { message = JSON.stringify(problem); } catch { message = String(problem); } }
      return { error: String(message || "provider error").slice(0, 400) };
    }
    if (provider === "google") {
      const p = Array.isArray(j.predictions) ? j.predictions[0] : null;
      if (!p) return { error: "Google Imagen returned no predictions[0]" };
      const b64 = p.bytesBase64Encoded || p.bytes_base64_encoded || p.b64_json;
      return b64 ? { b64: String(b64), mime: String(p.mimeType || "image/png") } : { error: "Google Imagen prediction has no image bytes" };
    }
    if (provider === "replicate") {
      if (j.status === "failed" || j.status === "canceled") return { error: String(j.error || "Replicate prediction " + j.status).slice(0, 400) };
      const output = Array.isArray(j.output) ? j.output[0] : j.output;
      return typeof output === "string" && output ? { url: output } : { error: "Replicate prediction has no output image yet" };
    }
    if (provider === "stability") return { error: "Stability returns image bytes; the background worker handles its binary response." };
    const d = Array.isArray(j.data) ? j.data[0] : null;
    if (!d) return { error: "no data[0] in the response" };
    if (d.b64_json) return { b64: String(d.b64_json), mime: "image/png", revised: d.revised_prompt || "" };
    if (d.url) return { url: String(d.url), revised: d.revised_prompt || "" };
    return { error: "data[0] carries neither b64_json nor url" };
  }

  // ───────────────────────── chat pickup (DOM) ─────────────────────────
  // Newest-first list of real pictures inside assistant items: not our own UI,
  // not avatars / emoji / icons, not already picked. Pure DOM, jsdom-testable.
  const SKIP_ALT = /\b(avatar|logo|emoji|icon|profile|badge|spinner|loading)\b/i;
  function pickupCandidates(items, opts) {
    opts = opts || {};
    const out = [];
    const min = Number.isFinite(Number(opts.minSize)) ? Number(opts.minSize) : 120;
    for (const item of items || []) {
      if (!item || typeof item.querySelectorAll !== "function") continue;
      const imgs = Array.from(item.querySelectorAll("img"));
      for (let i = imgs.length - 1; i >= 0; i--) {
        const el = imgs[i];
        const src = String(el.currentSrc || el.src || el.getAttribute("src") || "");
        if (!src || /^data:image\/svg/i.test(src)) continue;
        if (el.closest && el.closest("[data-rs-owned], #rs-bar, .rs-shot-chip, [data-rs-ui]")) continue;
        if (!opts.includePicked && el.getAttribute("data-rs-img-picked") === "1") continue;
        const alt = String(el.getAttribute("alt") || "") + " " + String(el.className || "");
        if (SKIP_ALT.test(alt)) continue;
        let w = Number(el.naturalWidth) || 0, h = Number(el.naturalHeight) || 0;
        if (!w || !h) { try { const r = el.getBoundingClientRect(); w = w || r.width; h = h || r.height; } catch {} }
        if (!w || !h) { w = Number(el.getAttribute("width")) || 0; h = Number(el.getAttribute("height")) || 0; }
        if ((w && w < min) || (h && h < min)) continue;
        out.push({ el, src, w, h, item });
      }
    }
    return out;
  }

  // ───────────────────────── Studio Luau (pure) ─────────────────────────
  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  function studioLuau(p) {
    p = p || {};
    const w = clampInt(p.w, 1, 1024, 2), h = clampInt(p.h, 1, 1024, 2);
    const b64 = String(p.b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
    const name = String(p.name || "TotalImage").replace(/[^\w.\- ]/g, "").slice(0, 60) || "TotalImage";
    const target = String(p.target || "").trim();
    const kind = kindOf(p.kind) || "gui_panel";
    const publish = p.publish === true;
    const scale = /^(Stretch|Slice|Tile|Fit|Crop)$/.test(String(p.scale_type || "")) ? String(p.scale_type) : (kind === "texture" ? "Tile" : kind === "gui_background" ? "Crop" : "Fit");
    const slice = p.slice && typeof p.slice === "object" ? [clampInt(p.slice.x, 0, 1024, 0), clampInt(p.slice.y, 0, 1024, 0), clampInt(p.slice.w, 0, 1024, 0), clampInt(p.slice.h, 0, 1024, 0)] : null;
    const aspect = w / h;
    const frac = kind === "gui_background" ? 1 : kind === "gui_icon" ? 0.08 : kind === "gui_button" ? 0.22 : 0.3;
    return [
      "-- TotalScript Image Studio " + VERSION + ": generated image -> EditableImage -> ImageLabel (live) / Image asset (published)",
      "local AssetService = game:GetService('AssetService')",
      "local HttpService = game:GetService('HttpService')",
      "local StarterGui = game:GetService('StarterGui')",
      "local P = { w = " + w + ", h = " + h + ", name = " + q(name) + ", target = " + q(target) + ", kind = " + q(kind) + ", publish = " + (publish ? "true" : "false") + ", scale = " + q(scale) + ", frac = " + frac + ", aspect = " + aspect.toFixed(4) + " }",
      "local DATA = " + q(b64),
      "local function fail(msg, extra) local r = { ok = false, error = tostring(msg) } if type(extra) == 'table' then for k, v in pairs(extra) do r[k] = v end end return HttpService:JSONEncode(r) end",
      "local B64 = {} do local chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' for i = 1, 64 do B64[string.byte(chars, i)] = i - 1 end end",
      "local function b64ToBuffer(s, expect)",
      "  local n = #s",
      "  local buf = buffer.create(expect)",
      "  local o = 0",
      "  for i = 1, n, 4 do",
      "    local a, b, c, d = string.byte(s, i, i + 3)",
      "    local va, vb, vc, vd = B64[a], B64[b], B64[c] or 0, B64[d] or 0",
      "    if not va or not vb then return nil, 'bad base64 at ' .. i end",
      "    local v = va * 262144 + vb * 4096 + vc * 64 + vd",
      "    if o < expect then buffer.writeu8(buf, o, v // 65536) o = o + 1 end",
      "    if c ~= 61 and o < expect then buffer.writeu8(buf, o, (v // 256) % 256) o = o + 1 end",
      "    if d ~= 61 and o < expect then buffer.writeu8(buf, o, v % 256) o = o + 1 end",
      "  end",
      "  if o ~= expect then return nil, string.format('decoded %d bytes, expected %d', o, expect) end",
      "  return buf",
      "end",
      "local function resolve(path)",
      "  if path == nil or path == '' then return nil end",
      "  local cur = game",
      "  for piece in string.gmatch(path, '[^%.]+') do",
      "    if piece ~= 'game' then",
      "      local nxt = nil",
      "      if cur == game then local okS, s = pcall(function() return game:GetService(piece) end) if okS and s then nxt = s end end",
      "      if not nxt then nxt = cur:FindFirstChild(piece) end",
      "      if not nxt then return nil end",
      "      cur = nxt",
      "    end",
      "  end",
      "  return cur",
      "end",
      "local expect = P.w * P.h * 4",
      "local buf, berr = b64ToBuffer(DATA, expect)",
      "if not buf then return fail('pixel payload: ' .. tostring(berr)) end",
      "local okImg, img = pcall(function() return AssetService:CreateEditableImage({ Size = Vector2.new(P.w, P.h) }) end)",
      "if not okImg or not img then return fail('EditableImage unavailable: ' .. tostring(img) .. ' (update Studio; the image can still be uploaded by hand through Asset Manager)') end",
      "local okW, werr = pcall(function() img:WritePixelsBuffer(Vector2.new(0, 0), Vector2.new(P.w, P.h), buf) end)",
      "if not okW then return fail('WritePixelsBuffer: ' .. tostring(werr)) end",
      "local assetId, publishErr = nil, nil",
      "if P.publish then",
      "  local okP, res, idOrErr = pcall(function() return AssetService:CreateAssetAsync(img, Enum.AssetType.Image, { Name = P.name, Description = 'Generated with TotalScript Image Studio' }) end)",
      "  if okP and res == Enum.CreateAssetResult.Success and idOrErr then assetId = tostring(idOrErr) else publishErr = okP and tostring(res) or tostring(res) end",
      "end",
      "local target = resolve(P.target)",
      "if P.target ~= '' and not target then return fail('target not found: ' .. P.target, { hint = 'use a full path such as StarterGui.HUD.Logo, or omit target to create StarterGui.TotalImages.' .. P.name }) end",
      "local gui, created = nil, false",
      "if target then",
      "  if target:IsA('ImageLabel') or target:IsA('ImageButton') then gui = target",
      "  elseif target:IsA('GuiObject') or target:IsA('LayerCollector') then",
      "    gui = target:FindFirstChild(P.name)",
      "    if not (gui and (gui:IsA('ImageLabel') or gui:IsA('ImageButton'))) then gui = Instance.new('ImageLabel') gui.Name = P.name gui.BackgroundTransparency = 1 gui.Size = UDim2.fromScale(1, 1) gui.Parent = target created = true end",
      "  else return fail('target ' .. P.target .. ' is a ' .. target.ClassName .. ', not a GuiObject') end",
      "else",
      "  local sg = StarterGui:FindFirstChild('TotalImages')",
      "  if not sg then sg = Instance.new('ScreenGui') sg.Name = 'TotalImages' sg.ResetOnSpawn = false sg.IgnoreGuiInset = true sg.Parent = StarterGui end",
      "  gui = sg:FindFirstChild(P.name)",
      "  if not (gui and gui:IsA('ImageLabel')) then",
      "    gui = Instance.new('ImageLabel') gui.Name = P.name gui.BackgroundTransparency = 1",
      "    gui.AnchorPoint = Vector2.new(0.5, 0.5) gui.Position = UDim2.fromScale(0.5, 0.5)",
      "    gui.Size = UDim2.fromScale(P.frac, P.frac)",
      "    if P.frac < 1 then local ar = Instance.new('UIAspectRatioConstraint') ar.AspectRatio = P.aspect ar.Parent = gui end",
      "    gui.Parent = sg created = true",
      "  end",
      "end",
      "pcall(function() gui.ScaleType = Enum.ScaleType[P.scale] end)",
      slice ? "pcall(function() gui.ScaleType = Enum.ScaleType.Slice gui.SliceCenter = Rect.new(" + slice.join(", ") + ") end)" : "-- no 9-slice",
      "local mode = nil",
      "if assetId then",
      "  gui.Image = 'rbxassetid://' .. assetId",
      "  mode = 'published'",
      "else",
      "  local okC, content = pcall(function() return Content.fromObject(img) end)",
      "  if okC and content then local okSet = pcall(function() gui.ImageContent = content end) if okSet then mode = 'live' end end",
      "  if not mode then return fail('the image decoded but could not be bound: ' .. (publishErr and ('publish failed: ' .. publishErr .. '; ') or '') .. 'ImageContent unavailable', { path = gui:GetFullName(), created = created }) end",
      "  _G.TotalImagesLive = _G.TotalImagesLive or {}",
      "  _G.TotalImagesLive[gui:GetFullName()] = img",
      "end",
      "pcall(function() gui:SetAttribute('TotalImage', P.name) gui:SetAttribute('TotalImageMode', mode) gui:SetAttribute('TotalImageSize', P.w .. 'x' .. P.h) if assetId then gui:SetAttribute('TotalImageAssetId', assetId) end end)",
      "pcall(function() game:GetService('Selection'):Set({ gui }) end)",
      "return HttpService:JSONEncode({ ok = true, data = { path = gui:GetFullName(), class = gui.ClassName, mode = mode, asset_id = assetId, publish_error = publishErr, created = created, size = { P.w, P.h }, scale_type = P.scale,",
      "  note = mode == 'published' and ('Image asset ' .. tostring(assetId) .. ' is on your account; moderation may take a moment before it renders.') or 'LIVE preview only: the EditableImage is not saved with the place and disappears when Studio closes. Run image_to_gui again with publish:true (or upload the downloaded PNG through Asset Manager) to make it permanent.' } })",
    ].join("\n");
  }

  // ───────────────────────── registry (session) ─────────────────────────
  const REG = { list: [], seq: 0, lastPickupSrc: new Set() };
  const MAX_KEEP = 12;
  function regAdd(entry) {
    REG.seq += 1;
    const e = Object.assign({ id: "img" + REG.seq, createdAt: Date.now() }, entry);
    REG.list.push(e);
    while (REG.list.length > MAX_KEEP) REG.list.shift();
    return e;
  }
  function regGet(ref) {
    if (!REG.list.length) return null;
    if (ref == null || ref === "" || ref === "latest" || ref === "last") return REG.list[REG.list.length - 1];
    const s = String(ref).toLowerCase();
    return REG.list.find((e) => e.id === s) || REG.list.find((e) => String(e.name || "").toLowerCase() === s) || null;
  }
  const regSummary = (e) => ({ id: e.id, name: e.name, kind: e.kind, source: e.source, width: e.png && e.png.width, height: e.png && e.png.height, prompt: e.prompt ? String(e.prompt).slice(0, 140) : undefined, sent_to: e.sentTo || undefined });

  // ───────────────────────── pixels (browser only) ─────────────────────────
  const hasDOM = typeof document !== "undefined" && typeof document.createElement === "function";
  function b64ToBytes(b64) { const bin = atob(String(b64 || "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function bytesToB64(bytes) { let s = ""; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); }
  async function decodeToBitmap(src) {
    // src: { b64, mime } | Blob | HTMLImageElement
    if (src && src.b64) return await createImageBitmap(new Blob([b64ToBytes(src.b64)], { type: src.mime || "image/png" }));
    if (typeof Blob !== "undefined" && src instanceof Blob) return await createImageBitmap(src);
    if (src && src.tagName === "IMG") return await createImageBitmap(src);
    throw new Error("nothing to decode");
  }
  function renderTo(bmp, w, h, fit, bg) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = "high"; } catch {}
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    const sw = bmp.width, sh = bmp.height;
    if (fit === "stretch") { ctx.drawImage(bmp, 0, 0, w, h); return c; }
    const s = fit === "contain" ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    const dw = sw * s, dh = sh * s;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
  }
  const pngOf = (c) => { const u = c.toDataURL("image/png"); return { mimeType: "image/png", data: u.slice(u.indexOf(",") + 1), width: c.width, height: c.height }; };
  function rgbaOf(c, maxEdge) {
    const s = Math.min(1, maxEdge / Math.max(c.width, c.height));
    const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
    const d = s < 1 ? renderTo(c, w, h, "stretch") : c;
    const px = d.getContext("2d").getImageData(0, 0, w, h).data;
    return { w, h, b64: bytesToB64(new Uint8Array(px.buffer, px.byteOffset, px.byteLength)) };
  }
  async function materialize(bmp, kind, o) {
    // bitmap → { png (delivered size), canvas, w, h }
    const K = spec(kind); o = o || {};
    const fit = o.fit || K.fit || "cover";
    const keepNative = o.native === true;
    const w = keepNative ? bmp.width : K.w, h = keepNative ? bmp.height : K.h;
    const c = renderTo(bmp, w, h, keepNative ? "stretch" : fit, null);
    const png = pngOf(c);
    try { bmp.close && bmp.close(); } catch {}
    return { png, canvas: c, w, h };
  }
  async function grabPixels(cand, H) {
    // 1. the already-loaded element (works when the host sends CORS headers or same-origin)
    try { const bmp = await createImageBitmap(cand.el); const c = renderTo(bmp, bmp.width, bmp.height, "stretch"); c.getContext("2d").getImageData(0, 0, 1, 1); return { bitmap: bmp, how: "element" }; } catch {}
    // 2. page-context fetch with the site's cookies
    try { const r = await fetch(cand.src, { credentials: "include" }); if (r.ok) { const b = await r.blob(); if (/^image\//.test(b.type) || b.size > 0) return { bitmap: await createImageBitmap(b), how: "fetch" }; } } catch {}
    // 3. the extension's background worker (host permissions, no page CORS)
    if (H && typeof H.bg === "function") {
      const r = await H.bg({ type: "image_fetch", url: cand.src });
      if (r && r.ok && r.b64) return { bitmap: await decodeToBitmap({ b64: r.b64, mime: r.mime }), how: "background" };
      throw new Error("could not read the picture's pixels: " + String((r && r.error) || "background fetch failed"));
    }
    throw new Error("could not read the picture's pixels (cross-origin, no background fetch)");
  }

  // ───────────────────────── commands ─────────────────────────
  const out = (name, o) => `Output of '${name}':\n` + JSON.stringify(o, null, 2);
  const err = (name, msg, extra) => `ERROR in ${name}: ${msg}` + (extra ? "\n" + JSON.stringify(extra, null, 2) : "");
  async function apiStatus(H) { try { const r = await H.bg({ type: "image_api_status" }); return r && r.ok ? r : { configured: false }; } catch { return { configured: false }; } }

  async function cmdGenerate(args, H) {
    const name = "image_generate";
    if (!hasDOM) return err(name, "needs a browser page");
    const a = args || {};
    const kind = kindOf(a.kind) || "gui_panel";
    const subject = String(a.prompt || a.subject || a.description || "").trim();
    if (!subject) return err(name, "prompt is required (what the picture shows)", { kinds: KIND_IDS, styles: STYLE_IDS });
    const built = buildPrompt({ prompt: subject, kind, style: a.style, title: a.title, palette: a.palette, transparent: a.transparent });
    let source = SOURCES.includes(String(a.source || "").toLowerCase()) ? String(a.source).toLowerCase() : "auto";
    if (source === "file") return err(name, "source:file is the Images window (drop a PNG there, or use image_pickup after the user attached one)");
    const st = await apiStatus(H);
    if (source === "auto") source = st.configured ? "api" : "chat";
    if (source === "api" && !st.configured) return err(name, "no image API configured: open the Images window (bar button or Ctrl+Shift+I) → API, choose a provider and save its key; or use source:\"chat\" on a site that can draw.");
    if (source === "chat") {
      return out(name, {
        ok: true, pending: true, source: "chat", kind, style: built.style,
        action: "DRAW IT IN THIS CHAT: in your NEXT reply, generate the picture with this site's own image tool using the prompt below (no commands in that reply). Once it is visible, call image_pickup {name, kind} in the reply AFTER it; then image_to_gui / image_thumbnail. If this chat cannot create pictures, say so plainly and ask the user to add an image API key in the Images window or drop a file there - never pretend an image exists.",
        prompt: built.prompt, negative: built.negative, size: `${KINDS[kind].w}x${KINDS[kind].h} target (${KINDS[kind].aspect})`,
        suggested_name: String(a.name || subject.slice(0, 24).replace(/[^\w ]+/g, "").trim() || kind),
      });
    }
    H.diag && H.diag("image.api.request", { provider: st.provider || "openai", kind, model: st.model || "", chars: built.prompt.length });
    const r = await H.bg({ type: "image_api", prompt: built.prompt, kind, transparent: built.transparent });
    if (!r || !r.ok) return err(name, "image API: " + String((r && r.error) || "no response"), { provider: st.provider || "openai", model: st.model, base: st.base, hint: "check the selected provider's key and model in the Images window → API; the raw API message is above." });
    let bmp;
    try {
      if (r.b64) bmp = await decodeToBitmap({ b64: r.b64, mime: r.mime || "image/png" });
      else if (r.url) { const f = await H.bg({ type: "image_fetch", url: r.url }); if (!f || !f.ok) throw new Error(String((f && f.error) || "could not download the image url")); bmp = await decodeToBitmap({ b64: f.b64, mime: f.mime }); }
      else throw new Error("the API returned neither bytes nor a url");
    } catch (e) { return err(name, "decode: " + String(e && e.message || e)); }
    const m = await materialize(bmp, kind, {});
    const e = regAdd({ name: String(a.name || subject.slice(0, 24).replace(/[^\w ]+/g, "").trim() || kind), kind, source: "api", prompt: built.prompt, png: m.png, canvas: m.canvas, model: r.model || st.model || "" });
    let downloaded = false;
    if (kind === "thumbnail" || kind === "icon") downloaded = !!(H.download && H.download(e.png, `TOTAL_${kind}_${e.name.replace(/\s+/g, "_")}.png`));
    try { H.attach && H.attach([e.png], name); } catch {}
    return out(name, { ok: true, image: regSummary(e), model: e.model || undefined, revised_prompt: r.revised || undefined, downloaded,
      attached: "the finished PNG is attached to THIS message - judge it like an art director before using it",
      next: kind === "thumbnail" || kind === "icon" ? `image_thumbnail {image:"${e.id}"} re-exports it; upload the PNG on the ${KINDS[kind].where}.` : `image_to_gui {image:"${e.id}", target:"StarterGui.<Screen>.<ImageLabel or Frame>", publish:false|true}` });
  }

  async function cmdPickup(args, H) {
    const name = "image_pickup";
    if (!hasDOM) return err(name, "needs a browser page");
    const a = args || {};
    const items = (H.assistantItems && H.assistantItems()) || [];
    const cands = pickupCandidates(items, { includePicked: a.again === true });
    if (!cands.length) return err(name, "no new picture found in the assistant's replies. The image must already be VISIBLE in a previous reply (not the one that calls image_pickup); if this chat cannot draw, ask the user for an image API key or a dropped file in the Images window.", { assistant_items_scanned: items.length });
    const which = clampInt(a.which, 1, cands.length, 1);
    const cand = cands[which - 1];
    let got;
    try { got = await grabPixels(cand, H); } catch (e) { return err(name, String(e && e.message || e), { src: String(cand.src).slice(0, 160) }); }
    try { cand.el.setAttribute("data-rs-img-picked", "1"); } catch {}
    const kind = kindOf(a.kind);
    const m = await materialize(got.bitmap, kind || "gui_panel", { native: !kind });
    const e = regAdd({ name: String(a.name || "picked" + (REG.seq + 1)), kind: kind || "picked", source: "chat", png: m.png, canvas: m.canvas, how: got.how });
    try { H.attach && H.attach([e.png], name); } catch {}
    return out(name, { ok: true, image: regSummary(e), read_via: got.how, candidates: cands.length, next: `image_to_gui {image:"${e.id}", target?, publish?} for GUI art · image_thumbnail {image:"${e.id}", kind:"thumbnail"|"icon"} for a store image` });
  }

  async function cmdToGui(args, H) {
    const name = "image_to_gui";
    const a = args || {};
    const e = regGet(a.image || a.id || a.name_ref);
    if (!e) return err(name, REG.list.length ? `unknown image "${a.image}"` : "no image yet - image_generate or image_pickup first", { images: REG.list.map(regSummary) });
    if (!e.canvas) return err(name, "that image has no pixels in this session (reload lost them) - generate or pick it up again");
    const kind = kindOf(a.kind) || (KINDS[e.kind] ? e.kind : "gui_panel");
    const K = KINDS[kind];
    if (!K.studio && !a.force) return err(name, `${kind} is a store image (Studio has no API for it) - use image_thumbnail; pass kind:"gui_background" to show it inside a ScreenGui anyway`);
    let publish = a.publish === true || a.publish === "true";
    let publishNote = "";
    if (publish && H.publishAllowed) { const okP = await H.publishAllowed({ image: e.id, name: e.name, kind }); if (!okP) { publish = false; publishNote = "publish was not approved - bound as a live preview instead"; } }
    const viaPlugin = !!(H.viaPlugin && H.viaPlugin());
    const maxEdge = clampInt(a.studio_size, 16, 512, Math.min(K.studio || 512, viaPlugin ? 512 : 256));
    const px = rgbaOf(e.canvas, maxEdge);
    const code = studioLuau({ w: px.w, h: px.h, b64: px.b64, name: a.name || e.name, target: a.target, kind, publish, scale_type: a.scale_type, slice: a.slice });
    let r;
    try { r = await H.runLuau(code); } catch (ex) { return err(name, "Studio: " + String(ex && ex.message || ex)); }
    const body = String(r || "").replace(/^Output of '[^']*':\n?/, "").trim();
    if (/^ERROR/i.test(body)) return err(name, body.slice(0, 600));
    let j = null; try { j = JSON.parse(body); } catch {}
    if (!j) return err(name, "Studio returned no JSON: " + body.slice(0, 300));
    if (j.ok === false) return err(name, String(j.error || "failed"), j);
    e.sentTo = j.data && j.data.path;
    H.diag && H.diag("image.to_gui", { kind, mode: j.data && j.data.mode, w: px.w, h: px.h, via: viaPlugin ? "plugin" : "mcp" });
    return out(name, Object.assign({ ok: true, image: e.id, pixels_sent: `${px.w}x${px.h} RGBA` + (px.w < e.png.width ? ` (downsampled from ${e.png.width}x${e.png.height} for the live carry; the full PNG is the download)` : ""), via: viaPlugin ? "plugin_execute_luau" : "execute_luau" }, j.data || {}, publishNote ? { publish_note: publishNote } : {}));
  }

  async function cmdThumbnail(args, H) {
    const name = "image_thumbnail";
    if (!hasDOM) return err(name, "needs a browser page");
    const a = args || {};
    const e = regGet(a.image || a.id);
    if (!e) return err(name, REG.list.length ? `unknown image "${a.image}"` : "no image yet - image_generate {kind:\"thumbnail\"} or image_pickup first", { images: REG.list.map(regSummary) });
    if (!e.canvas) return err(name, "that image has no pixels in this session - generate or pick it up again");
    const kind = String(a.kind || "").toLowerCase() === "icon" ? "icon" : "thumbnail";
    const K = KINDS[kind];
    const bmp = await createImageBitmap(e.canvas);
    const c = renderTo(bmp, K.w, K.h, a.fit === "contain" ? "contain" : "cover", a.fit === "contain" ? String(a.background || "#000") : null);
    try { bmp.close && bmp.close(); } catch {}
    const png = pngOf(c);
    const file = `TOTAL_${kind}_${String(a.name || e.name).replace(/[^\w]+/g, "_")}.png`;
    const downloaded = !!(H.download && H.download(png, file));
    try { H.attach && H.attach([png], name); } catch {}
    return out(name, { ok: true, image: e.id, kind, file, size: `${K.w}x${K.h}`, downloaded, attached: "attached to THIS message", upload: K.where, honest: "Roblox Studio cannot set an experience thumbnail or icon; the user uploads the file on the Creator Dashboard." });
  }

  function cmdList() { return out("image_list", { ok: true, count: REG.list.length, images: REG.list.map(regSummary), kinds: KIND_IDS, styles: STYLE_IDS }); }

  async function run(name, args, H) {
    H = H || {};
    switch (name) {
      case "image_generate": return cmdGenerate(args, H);
      case "image_pickup": return cmdPickup(args, H);
      case "image_to_gui": return cmdToGui(args, H);
      case "image_thumbnail": return cmdThumbnail(args, H);
      case "image_list": return cmdList();
      default: return err(name, "unknown image command");
    }
  }

  // ───────────────────────── window ─────────────────────────
  let W = null, HOOKS = null, API_STATE = null;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function isOpen() { return !!(W && W.isConnected && !W.hidden); }
  function close() { if (W) { W.hidden = true; } }
  function open(hooks) {
    if (!hasDOM) return;
    HOOKS = hooks || HOOKS || {};
    if (!W || !W.isConnected) build();
    W.hidden = false;
    refreshList();
    refreshApi();
    try { W.querySelector("[data-ig-prompt]").focus(); } catch {}
  }
  function setStatus(msg, kind) { const s = W && W.querySelector("[data-ig-status]"); if (s) { s.textContent = msg || ""; s.dataset.kind = kind || ""; } }
  function build() {
    W = document.createElement("div");
    W.id = "rs-images";
    W.setAttribute("data-rs-owned", "1");
    W.setAttribute("role", "dialog");
    W.setAttribute("aria-label", "Image Studio");
    const kinds = KIND_IDS.map((k) => `<option value="${k}">${esc(KINDS[k].label)} · ${KINDS[k].w}×${KINDS[k].h}</option>`).join("");
    const styles = STYLE_IDS.map((s) => `<option value="${s}">${s}</option>`).join("");
    const apiProviders = API_PROVIDER_IDS.map((id) => `<option value="${id}">${esc(API_PROVIDERS[id].label)}</option>`).join("");
    W.innerHTML = `
      <div class="rs-ig-head"><span class="rs-ig-title">Image Studio</span><span class="rs-ig-sub">thumbnails · icons · GUI art → Studio</span><button type="button" class="rs-ig-close" data-ig-close aria-label="Close">×</button></div>
      <div class="rs-ig-body">
        <div class="rs-ig-col">
          <label class="rs-ig-field"><span>What should it show?</span><textarea data-ig-prompt rows="3" placeholder="e.g. a heroic knight with a glowing sword on a cliff at sunset"></textarea></label>
          <div class="rs-ig-row">
            <label class="rs-ig-field"><span>Kind</span><select data-ig-kind>${kinds}</select></label>
            <label class="rs-ig-field"><span>Style</span><select data-ig-style>${styles}</select></label>
          </div>
          <div class="rs-ig-row">
            <label class="rs-ig-field"><span>Title text (optional)</span><input data-ig-title placeholder="≤ 3 words, thumbnails only"></label>
            <label class="rs-ig-field"><span>Source</span><select data-ig-source><option value="auto">auto (API if configured, else this chat)</option><option value="api">image API (your key)</option><option value="chat">ask this chat to draw it</option></select></label>
          </div>
          <div class="rs-ig-actions">
            <button type="button" class="rs-ig-btn rs-ig-primary" data-ig-generate>Generate</button>
            <label class="rs-ig-btn rs-ig-file">Drop / pick a file<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-ig-file hidden></label>
          </div>
          <div class="rs-ig-drop" data-ig-drop>drop a PNG / JPG / WebP here</div>
          <details class="rs-ig-api"><summary>API providers &amp; keys</summary>
            <div class="rs-ig-note">Each provider has its own saved key, model and settings. Keys stay in extension storage and are read only by the background worker; they are never sent to the AI or included in diagnostics. Providers charge separately.</div>
            <label class="rs-ig-field"><span>Provider</span><select data-ig-api-provider>${apiProviders}</select></label>
            <div class="rs-ig-note" data-ig-api-provider-note></div>
            <label class="rs-ig-field"><span data-ig-api-base-label>Base URL</span><input data-ig-api-base placeholder="https://api.openai.com/v1"></label>
            <label class="rs-ig-field"><span>Model / endpoint</span><input data-ig-api-model placeholder="gpt-image-1"></label>
            <label class="rs-ig-field"><span data-ig-api-key-label>API key</span><input data-ig-api-key type="password" autocomplete="off" placeholder="Paste a key or token"></label>
            <div class="rs-ig-note">Leave the key box blank to keep the existing key. Use <b>Clear key</b> to remove only this provider’s credential.</div>
            <div class="rs-ig-actions"><button type="button" class="rs-ig-btn" data-ig-api-save>Save this provider</button><button type="button" class="rs-ig-btn" data-ig-api-clear>Clear key</button><span class="rs-ig-api-state" data-ig-api-state></span></div>
          </details>
        </div>
        <div class="rs-ig-col rs-ig-preview-col">
          <div class="rs-ig-preview" data-ig-preview><span class="rs-ig-empty">no image yet</span></div>
          <div class="rs-ig-meta" data-ig-meta></div>
          <div class="rs-ig-row">
            <label class="rs-ig-field"><span>Studio target (optional)</span><input data-ig-target placeholder="StarterGui.HUD.Logo — empty = StarterGui.TotalImages"></label>
            <label class="rs-ig-check"><input type="checkbox" data-ig-publish> publish as Image asset (permanent, asks first)</label>
          </div>
          <div class="rs-ig-actions">
            <button type="button" class="rs-ig-btn rs-ig-primary" data-ig-send>Send to Studio GUI</button>
            <button type="button" class="rs-ig-btn" data-ig-thumb>Export 1920×1080</button>
            <button type="button" class="rs-ig-btn" data-ig-icon>Export 512×512</button>
            <button type="button" class="rs-ig-btn" data-ig-ask>Ask the AI to use it</button>
          </div>
          <div class="rs-ig-list" data-ig-list></div>
        </div>
      </div>
      <div class="rs-ig-status" data-ig-status></div>`;
    (document.body || document.documentElement).appendChild(W);
    const $ = (sel) => W.querySelector(sel);
    $("[data-ig-close]").addEventListener("click", close);
    W.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    let styleTouched = false;
    $("[data-ig-style]").addEventListener("change", () => { styleTouched = true; });
    $("[data-ig-kind]").addEventListener("change", () => { const k = $("[data-ig-kind]").value; if (KINDS[k] && !styleTouched) $("[data-ig-style]").value = /^gui_(icon|button|panel)$/.test(k) ? "flat" : "roblox"; });
    $("[data-ig-generate]").addEventListener("click", async () => {
      const kind = $("[data-ig-kind]").value, prompt = $("[data-ig-prompt]").value.trim();
      if (!prompt) { setStatus("Describe the picture first.", "warn"); return; }
      const source = $("[data-ig-source]").value;
      setStatus(source === "chat" ? "Asking the chat to draw it…" : "Generating…", "busy");
      if (source === "chat" || (source === "auto" && !(await apiStatus(HOOKS)).configured)) {
        const built = buildPrompt({ prompt, kind, style: $("[data-ig-style]").value, title: $("[data-ig-title]").value });
        const text = `Please generate this picture with your image tool (no TotalScript commands in that reply): ${built.prompt}\n\nAfter it is visible, in the following reply run image_pickup {name:"${prompt.slice(0, 24).replace(/["\\]/g, "")}", kind:"${kind}"} and then ${kind === "thumbnail" || kind === "icon" ? `image_thumbnail {kind:"${kind}"}` : "image_to_gui {target: the right ImageLabel or Frame}"}. If you cannot create pictures here, say so instead of pretending.`;
        const ok = HOOKS.send ? await HOOKS.send(text, null, (m) => setStatus(m, "busy")) : false;
        setStatus(ok ? "Sent to the chat. When the picture appears the AI picks it up (or press Generate → source: image API)." : "Could not send - is the chat ready?", ok ? "" : "warn");
        return;
      }
      const r = await run("image_generate", { prompt, kind, style: $("[data-ig-style]").value, title: $("[data-ig-title]").value, source: "api" }, HOOKS);
      if (/^ERROR/.test(r)) { setStatus(r.replace(/^ERROR in image_generate: /, "").split("\n")[0].slice(0, 220), "warn"); return; }
      setStatus("Generated.", ""); refreshList(); showEntry(regGet("latest"));
    });
    const takeFile = async (file) => {
      if (!file || !/^image\//.test(file.type)) { setStatus("That is not an image file.", "warn"); return; }
      try {
        const bmp = await createImageBitmap(file);
        const kind = $("[data-ig-kind]").value;
        const m = await materialize(bmp, kind, { native: !/^(thumbnail|icon|gui_background)$/.test(kind) });
        const e = regAdd({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "file", kind, source: "file", png: m.png, canvas: m.canvas });
        setStatus(`Loaded ${file.name} (${m.w}×${m.h}).`, ""); refreshList(); showEntry(e);
      } catch (e) { setStatus("Could not decode: " + String(e && e.message || e), "warn"); }
    };
    $("[data-ig-file]").addEventListener("change", (e) => takeFile(e.target.files && e.target.files[0]));
    const drop = $("[data-ig-drop]");
    for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
    for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
    drop.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) takeFile(f); });
    $("[data-ig-send]").addEventListener("click", async () => {
      const e = current(); if (!e) { setStatus("Generate or load an image first.", "warn"); return; }
      setStatus("Sending to Studio…", "busy");
      const r = await run("image_to_gui", { image: e.id, target: $("[data-ig-target]").value.trim() || undefined, publish: $("[data-ig-publish]").checked, kind: KINDS[e.kind] && KINDS[e.kind].studio ? e.kind : "gui_panel" }, HOOKS);
      if (/^ERROR/.test(r)) { setStatus(r.replace(/^ERROR in image_to_gui: /, "").split("\n")[0].slice(0, 220), "warn"); return; }
      let j = null; try { j = JSON.parse(r.replace(/^Output of '[^']*':\n?/, "")); } catch {}
      setStatus(j ? `${j.mode === "published" ? "Published" : "Live preview"} → ${j.path}${j.mode === "live" ? " (session-only; tick publish for a permanent asset)" : ""}` : "Sent.", ""); refreshList();
    });
    const exportAs = async (kind) => { const e = current(); if (!e) { setStatus("Generate or load an image first.", "warn"); return; } const r = await run("image_thumbnail", { image: e.id, kind }, HOOKS); setStatus(/^ERROR/.test(r) ? r.split("\n")[0].slice(0, 200) : `Exported ${kind} PNG (downloaded + attached to the chat). ${KINDS[kind].where}.`, /^ERROR/.test(r) ? "warn" : ""); };
    $("[data-ig-thumb]").addEventListener("click", () => exportAs("thumbnail"));
    $("[data-ig-icon]").addEventListener("click", () => exportAs("icon"));
    $("[data-ig-ask]").addEventListener("click", async () => {
      const e = current(); if (!e) { setStatus("Generate or load an image first.", "warn"); return; }
      const text = `TotalScript Image Studio: image "${e.id}" (${e.name}, ${e.kind}, ${e.png.width}×${e.png.height}, from ${e.source}) is attached and already registered. Use it: image_to_gui {image:"${e.id}", target:"<ImageLabel or Frame path>", publish:false} for GUI art, or image_thumbnail {image:"${e.id}", kind:"thumbnail"|"icon"} for a store image. Then wire the GUI around it.`;
      setStatus("Sending…", "busy");
      const ok = HOOKS.send ? await HOOKS.send(text, [e.png], (m) => setStatus(m, "busy")) : false;
      setStatus(ok ? "Sent - the AI now has the image id." : "Could not send.", ok ? "" : "warn");
    });
    const apiEls = { provider: $("[data-ig-api-provider]"), base: $("[data-ig-api-base]"), model: $("[data-ig-api-model]"), key: $("[data-ig-api-key]") };
    apiEls.provider.addEventListener("change", async () => {
      const provider = apiEls.provider.value;
      showApiStatus(API_STATE, provider);
      try {
        const r = await HOOKS.bg({ type: "image_api_config", action: "select", provider });
        if (!r || !r.ok) { setStatus("Could not select provider: " + String((r && r.error) || "no response"), "warn"); return; }
        showApiStatus(r, provider);
      } catch (e) { setStatus("Could not select provider: " + String(e && e.message || e), "warn"); }
    });
    $("[data-ig-api-save]").addEventListener("click", async () => {
      const provider = apiEls.provider.value;
      const payload = { type: "image_api_config", action: "save", provider, base: apiEls.base.value.trim(), model: apiEls.model.value.trim(), key: apiEls.key.value.trim() };
      try {
        const r = await HOOKS.bg(payload);
        if (!r || !r.ok) { setStatus("Could not save API settings: " + String((r && r.error) || "no response"), "warn"); return; }
        apiEls.key.value = "";
        showApiStatus(r, provider);
        const profile = r.profiles && r.profiles[provider];
        setStatus(profile && profile.configured ? "Provider settings saved; the key remains masked." : "Provider settings saved; add its key before generating.", profile && profile.configured ? "" : "warn");
      } catch (e) { setStatus("Could not save API settings: " + String(e && e.message || e), "warn"); }
    });
    $("[data-ig-api-clear]").addEventListener("click", async () => {
      const provider = apiEls.provider.value;
      try {
        const r = await HOOKS.bg({ type: "image_api_config", action: "clear", provider, base: apiEls.base.value.trim(), model: apiEls.model.value.trim() });
        if (!r || !r.ok) { setStatus("Could not clear key: " + String((r && r.error) || "no response"), "warn"); return; }
        apiEls.key.value = "";
        showApiStatus(r, provider);
        setStatus("This provider’s key was removed; its model and endpoint settings remain.", "");
      } catch (e) { setStatus("Could not clear key: " + String(e && e.message || e), "warn"); }
    });
  }
  let currentId = null;
  const current = () => regGet(currentId) || regGet("latest");
  function showEntry(e) {
    if (!W || !e) return; currentId = e.id;
    const pv = W.querySelector("[data-ig-preview]");
    pv.innerHTML = ""; const img = document.createElement("img"); img.alt = e.name; img.src = `data:${e.png.mimeType};base64,${e.png.data}`; pv.appendChild(img);
    W.querySelector("[data-ig-meta]").textContent = `${e.id} · ${e.name} · ${KINDS[e.kind] ? KINDS[e.kind].label : e.kind} · ${e.png.width}×${e.png.height} · ${e.source}${e.model ? " · " + e.model : ""}${e.sentTo ? " · in Studio: " + e.sentTo : ""}`;
    W.querySelectorAll("[data-ig-item]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-ig-item") === e.id));
  }
  function refreshList() {
    if (!W) return;
    const box = W.querySelector("[data-ig-list]");
    box.innerHTML = REG.list.slice().reverse().map((e) => `<button type="button" class="rs-ig-item ${e.id === currentId ? "on" : ""}" data-ig-item="${e.id}"><img alt="" src="data:${e.png.mimeType};base64,${e.png.data}"><span>${esc(e.id)} ${esc(e.name)}</span></button>`).join("");
    box.querySelectorAll("[data-ig-item]").forEach((b) => b.addEventListener("click", () => showEntry(regGet(b.getAttribute("data-ig-item")))));
    if (!currentId && REG.list.length) showEntry(regGet("latest"));
  }
  function showApiStatus(st, selectedProvider) {
    if (!W) return;
    if (st && st.ok) API_STATE = st;
    const state = st && st.ok ? st : API_STATE || {};
    const provider = API_PROVIDER_IDS.includes(selectedProvider) ? selectedProvider : (API_PROVIDER_IDS.includes(state.provider) ? state.provider : "openai");
    const meta = API_PROVIDERS[provider];
    const profile = state.profiles && state.profiles[provider] || (state.provider === provider ? state : {});
    const providerEl = W.querySelector("[data-ig-api-provider]");
    if (providerEl) providerEl.value = provider;
    const baseEl = W.querySelector("[data-ig-api-base]"), modelEl = W.querySelector("[data-ig-api-model]");
    const baseLabel = W.querySelector("[data-ig-api-base-label]"), keyLabel = W.querySelector("[data-ig-api-key-label]");
    if (baseEl) { baseEl.value = profile.base == null ? meta.base : profile.base; baseEl.disabled = !meta.baseEditable; baseEl.placeholder = meta.base || "https://provider.example/v1"; }
    if (modelEl) { modelEl.value = profile.model == null ? meta.model : profile.model; modelEl.placeholder = meta.model || "provider model id"; }
    if (baseLabel) baseLabel.textContent = meta.baseEditable ? "Base URL" : "Provider endpoint (fixed)";
    if (keyLabel) keyLabel.textContent = meta.keyLabel;
    const note = W.querySelector("[data-ig-api-provider-note]");
    if (note) note.textContent = meta.note;
    const el = W.querySelector("[data-ig-api-state]");
    if (el) el.textContent = profile.configured ? `configured · ${meta.label} · ${profile.model || "?"} · key ${profile.key_masked || "set"}` : `not configured · ${meta.label} (chat drawing + dropped files still work)`;
  }
  async function refreshApi() {
    if (!W) return;
    const st = await apiStatus(HOOKS);
    showApiStatus(st);
  }

  const API = Object.freeze({
    VERSION, KINDS, KIND_IDS, STYLES, STYLE_IDS, COMMANDS, SOURCES, API_PROVIDERS, API_PROVIDER_IDS,
    spec, buildPrompt, modelFamily, apiSizeFor, imageAspectFor, apiRequest, parseApiResponse, publicApiConfig,
    pickupCandidates, studioLuau,
    registry: { list: () => REG.list.map(regSummary), get: regGet, add: regAdd, clear: () => { REG.list.length = 0; } },
    run, open, close, isOpen,
  });
  G.TotalImageGen = API;
  try { if (typeof module !== "undefined" && module.exports) module.exports = API; } catch {}
})();
