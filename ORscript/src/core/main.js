// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the RSProvider interface (src/providers/*.js):
// waits for the model's reply, parses OR commands (RSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  if(globalThis.__orscriptMainInitialized){
    try{globalThis.ORUICollisionManager&&ORUICollisionManager.instance.initialize({root:document.getElementById("rs-root"),provider:globalThis.RSProvider&&RSProvider.id});}catch{}
    return;
  }
  globalThis.__orscriptMainInitialized=true;
  addEventListener("pagehide",()=>{try{globalThis.ORUICollisionManager&&ORUICollisionManager.instance.destroy();}catch{}},{once:true});
  const OR_BOOT_AT=performance.now();
  const P = RSProvider;
  const T = P.timings;
  // Template storage is provider-independent and must hydrate on every page,
  // even when this conversation has never started an agent session.
  const templateRegistryReady=globalThis.ORTemplateRegistry?ORTemplateRegistry.initialize().then(r=>{try{dispatchEvent(new CustomEvent("or-templates-synced",{detail:{count:r.count}}));}catch{}return r;}):Promise.resolve({success:false,count:0});
  const log = (...a) => console.log("[or]", ...a);

  // ── Timing (v1.12.2: all-native, no Web Worker) ────────────────────────────
  // v1.12 tried to beat Chrome's hidden-tab timer throttling with a blob: Web
  // Worker ticker. That was a mistake twice over: on strict-CSP sites the
  // worker dies asynchronously and took the interval registry with it (the
  // "site crashes after starting the agent" report), and even hardened (v1.12.1)
  // it remained the one novel mechanism correlated with freezes. It is now
  // REMOVED. Everything runs on native timers, exactly like v1.11:
  //   * visible tabs: full precision, zero new failure modes;
  //   * hidden tabs: Chrome clamps timers to >=1s (and 1/min after 5min) - the
  //     loop keeps RUNNING, just slower, and waitForResponse slides its
  //     deadlines while hidden (see below) so throttling can never cause a
  //     false "went quiet" / "sent nothing".
  // rsInterval remains as a thin alias so call sites read clearly; it returns a
  // disposer function.
  function rsInterval(fn, ms) {
    const id = setInterval(() => { try { fn(); } catch {} }, ms);
    return () => clearInterval(id);
  }
  function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, ms));
  }
  // ── Background mode (v1.12) ────────────────────────────────────────────────
  // v1.11 and earlier PARKED the whole agent loop on visibilitychange: leaving
  // the AI site for any other tab froze the agent until the user came back.
  // Background mode (default ON) removes the parking entirely - the loop keeps
  // reading the DOM, running tools and injecting results in hidden tabs. With
  // the worker gone, a hidden tab runs at Chrome's throttled rate (slow but
  // alive) and deadline sliding below keeps it honest; the user's return
  // restores full speed instantly. Turning it OFF restores the old
  // park-until-foreground behavior.
  let bgMode = true;
  try {
    chrome.storage.local.get("rsBgMode", (r) => { if (r && typeof r.rsBgMode === "boolean") bgMode = r.rsBgMode; });
  } catch {}
  // Codex-style permission: sandbox (Studio + workspace only) | ask (confirm writes) | full (entire PC).
  let permMode = "sandbox";
  try {
    chrome.storage.local.get("rsPermMode", (r) => {
      if (r && ["sandbox", "ask", "full"].includes(r.rsPermMode)) permMode = r.rsPermMode;
      try { window.__rsPermMode = () => permMode; } catch {}
    });
  } catch {}
  try { window.__rsPermMode = () => permMode; } catch {}
  const TOOL_ALIASES = {
    "studio.findinstance":"instance_find","studio.finddescendants":"instance_descendants","studio.getdescendants":"get_descendants","studio.findchildren":"get_children","studio.getancestors":"instance_ancestors","studio.createinstance":"instance_new","studio.destroyinstance":"instance_destroy","studio.cloneinstance":"instance_clone","studio.renameinstance":"instance_rename","studio.moveinstance":"instance_move","studio.reparentinstance":"instance_reparent","studio.inspectinstance":"inspect_instance","studio.getproperty":"get_property","studio.setproperty":"set_property","studio.inspectattributes":"attribute_get","studio.setattribute":"attribute_set","studio.addtag":"tag_add","studio.removetag":"tag_remove","studio.createpart":"part_create","studio.createmodel":"model_group","studio.createfolder":"folder_create","studio.readscript":"script_read","studio.writescript":"script_set_source","studio.createscript":"script_create","studio.deletescript":"instance_destroy","studio.renamescript":"instance_rename","studio.clonescript":"instance_clone","studio.findscript":"script_search","studio.appendscript":"script_append","studio.validatescript":"script_analysis","studio.searchscript":"script_search","studio.createui":"ui_build","studio.inspectui":"ui_inspect",
    script_read_analysis: "script_analysis",
    script_readanalysis: "script_analysis",
    read_script_analysis: "script_analysis",
    analyze_script: "script_analysis",
    analyze_scripts: "script_analysis",
    analyse_script: "script_analysis",
    analyse_scripts: "script_analysis",
    script_analyze: "script_analysis",
    script_analyse: "script_analysis",
    script_lint: "script_analysis",
    lint_script: "script_analysis",
    lint_scripts: "script_analysis",
    screenshot: "or_screenshot",
    take_screenshot: "or_screenshot",
    screenshot_send: "or_screenshot",
    send_screenshot: "or_screenshot",
    capture_screenshot: "or_screenshot",
    or_screen_shot: "or_screenshot",
    or_capture: "or_screenshot",
    or_snap: "or_screenshot",
    capture: "or_screenshot",
    take_photo: "or_screenshot",
    snap: "or_screenshot",
    capture_screen: "or_screenshot",
    viewport_screenshot: "or_screenshot",
    capture_ids: "capture_id",
    get_id: "capture_id",
    get_ids: "capture_id",
    instance_id: "capture_id",
    object_id: "capture_id",
    subagent: "or_agent",
    spawn_subagent: "or_agent",
    grep_scripts: "script_grep",
    search_scripts: "script_search",
    read_script: "script_read",
    inspect: "inspect_instance",
    search_tree: "search_game_tree",
    play_start: "start_stop_play",
    play_stop: "start_stop_play",
    httpget: "http_get",
    docs_get: "http_get",
    roblox_docs: "http_get",
    template: "get_template",
    templates: "list_templates",
    get_templates: "list_templates",
    list_template: "list_templates",
    debug_run: "or_debug",
    debug_console: "or_debug",
    auto_debug: "or_debug",
    multi_agent: "or_agent",
    spawn_agent: "or_agent",
    create_game_pass: "gamepass_create",
    create_gamepass: "gamepass_create",
    game_pass_create: "gamepass_create",
    gamepass_new: "gamepass_create",
    list_game_passes: "gamepass_list",
    game_pass_list: "gamepass_list",
    gamepass_wire: "gamepass_handler_create",
    gamepass_handler: "gamepass_handler_create",
    create_developer_product: "developer_product_create",
    create_dev_product: "developer_product_create",
    devproduct_create: "developer_product_create",
    dev_product_create: "developer_product_create",
    developerproduct_create: "developer_product_create",
    list_developer_products: "developer_product_list",
    devproduct_list: "developer_product_list",
    // 1.24.0 plugin control / interop / Eclipse Animator
    studio_run: "studio_playtest", studio_play: "studio_playtest", studio_stop: "studio_playtest", playtest: "studio_playtest",
    studio_setting: "studio_settings", studio_set_setting: "studio_settings", studio_get_setting: "studio_settings",
    list_plugins: "plugins_list", plugin_list: "plugins_list", studio_plugins: "plugins_list", plugins: "plugins_list",
    plugin_call: "plugin_invoke", invoke_plugin: "plugin_invoke", plugin_show: "plugin_widget", plugin_hide: "plugin_widget", plugin_panel: "plugin_widget",
    plugin_read_source: "plugin_source_read", studio_macro_create: "studio_macro", studio_button_create: "studio_macro",
    studio_console: "studio_output", studio_log: "studio_output", studio_raycast: "studio_mouse",
    eclipse_animator: "eclipse_status", eclipse_animator_status: "eclipse_status", eclipse_animator_open: "eclipse_open", eclipse_export: "eclipse_handoff", eclipse_send: "eclipse_handoff", eclipse_to_orscript: "eclipse_import", eclipse_preview: "eclipse_play",
  };
  function remapToolName(n) {
    const raw = String(n || "");
    const key = raw.replace(/-/g, "_").toLowerCase();
    return TOOL_ALIASES[key] || TOOL_ALIASES[raw] || n;
  }
  const ASK_OPS = new Set([
    "execute_luau","multi_edit","write_file","edit_file","delete_path","move_path","create_folder","insert_from_creator_store","generate_mesh","generate_material","generate_procedural_model","start_stop_play","user_keyboard_input","user_mouse_input",
    "run_command","process_kill","download_file","open_path",
    "lighting_set_preset","lighting_setup_day_night","terrain_fill_region","terrain_clear",
    "ui_create_screen","ui_create_component","fx_create_emitter","fx_create_light","fx_create_vfx",
    "audio_setup_sound_hierarchy","audio_create_sound","camera_set_style","datastore_setup",
    "leaderboard_setup","remote_setup","teams_setup","npc_spawn_pathfinding","proximity_setup",
    "tween_create","marketplace_setup","diagnostics_fix_common","plugin_create",
    "ui_build","ui_set_image","ui_set_texture","ui_set_property","ui_paint","ui_add_element","ui_apply_theme","ui_bind_button",
    "decal_set","mesh_set_texture","surface_gui_create","ui_clone","ui_clear_children",
    "instance_rename","instance_reparent","script_append","selection_set",
    "script_set_source","script_disable","anchored_set","collision_set","transparency_set",
    "humanoid_set","lighting_set","folder_create","value_set","weld_constraint","instance_move","tag_remove",
    "append_file","copy_file","replace_in_files","patch_json","write_json","replace_once",
    "execute_blender_code","blender_export_fbx",
    "size_set","color_set","cframe_set","rotation_set","massless_set","can_touch_set","can_query_set","cast_shadow_set","collision_group_set","brickcolor_set",
    "meshpart_create","wedge_create","spawn_box","ladder_create","trampoline_create","conveyor_create","ice_part","jump_pad","speed_pad",
    "attachment_create","hinge_create","spring_create","rope_create","vector_force_create","linear_velocity_create",
    "fire_add","smoke_add","sparkles_add","point_light_add","spot_light_add",
    "atmosphere_set","bloom_set","blur_set","color_correction_set","sunrays_set","gravity_set",
    "walkspeed_set","jumppower_set","forcefield_add","explosion_at","teleport_to","leaderstats_int","remote_event_create","sound_volume","set_property","scale_model","ungroup_model",
    "developer_product_create","developer_product_list","gamepass_create","gamepass_list","gamepass_update",
    "script_replace","script_insert","script_delete_lines","script_rename_symbol","script_restore",
    "model_build","model_union","model_subtract","model_optimize","model_anchor_fix","model_paint","model_hollow_box","model_wall","model_pipe","model_array_radial",
    "memory_update_section","memory_remove_fact",
  ]);
  const PUBLISH_OPS=new Set(["developer_product_create","gamepass_create","gamepass_update","cloud_gamepass_create","cloud_gamepass_update","cloud_product_create","studio_publish_selection","studio.publishPlace","studio.publishAnimation","studio.createGamePass"]);
  async function publishAutomationEnabled(){try{const r=await chrome.storage.local.get("rsAllowPublishAutomation");return r.rsAllowPublishAutomation===true;}catch{return false;}}
  // Ask-mode / publish confirmation. The prompt is a full-screen modal, but a
  // modal nobody answers is a silent hang (seen on Notion: "stuck after
  // get_studio_state, trying to execute_luau" - execute_luau waited for Allow
  // while the user watched Studio). So: the modal lives at document level (a
  // hidden/collapsed bar cannot hide it), the bar shows a banner, Escape denies,
  // and after APPROVAL_TIMEOUT_MS the call is denied with a message that tells
  // the model to stop and ask the user instead of retrying.
  const APPROVAL_TIMEOUT_MS = 120000;
  let _approvalTimedOut = false;
  function approvalTimedOut() { const v = _approvalTimedOut; _approvalTimedOut = false; return v; }
  function requestApproval(op, args, required=false) {
    return new Promise((resolve) => {
      const root = document.getElementById("rs-approve");
      const body = document.getElementById("rs-approve-body");
      const allow = document.getElementById("rs-approve-allow");
      const deny = document.getElementById("rs-approve-deny");
      if (!root || !allow || !deny) { resolve(!required); return; }
      // Keep the modal outside #rs-root so a collapsed / hidden bar cannot hide it.
      try { if (root.parentElement !== document.documentElement) document.documentElement.appendChild(root); } catch {}
      const oldAllowText=allow.textContent;
      if(required)allow.textContent="Confirm Publish";
      const preview = (() => {
        try { return JSON.stringify(args || {}, null, 0).slice(0, 280); } catch { return ""; }
      })();
      if (body) body.innerHTML = `<b>${op}</b>${preview ? `<pre>${preview.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>` : ""}<div class="rs-approve-note">Waiting for you - Allow or Deny (Esc = Deny). Auto-denied after ${Math.round(APPROVAL_TIMEOUT_MS / 1000)} s. Switch Permissions to Sandbox in the OR menu to stop being asked.</div>`;
      root.hidden = false;
      try { diag("approval.wait", { op }); } catch {}
      try { if (typeof ui !== "undefined" && ui && ui.banner) ui.banner("warn", required ? "Confirm publishing" : "Approval needed (Ask mode)", `OR is waiting for you to Allow or Deny '${op}'. Nothing runs until you answer.`); } catch {}
      let timer = null;
      const done = (ok, why) => {
        clearTimeout(timer);
        root.hidden = true;
        allow.textContent=oldAllowText;
        allow.removeEventListener("click", onAllow);
        deny.removeEventListener("click", onDeny);
        document.removeEventListener("keydown", onKey, true);
        try { diag("approval.done", { op, ok: !!ok, why: why || (ok ? "allow" : "deny") }); } catch {}
        resolve(ok);
      };
      const onAllow = () => done(true);
      const onDeny = () => done(false);
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false, "escape"); } };
      allow.addEventListener("click", onAllow);
      deny.addEventListener("click", onDeny);
      document.addEventListener("keydown", onKey, true);
      timer = setTimeout(() => { _approvalTimedOut = true; done(false, "timeout"); }, APPROVAL_TIMEOUT_MS);
    });
  }
  function setPermMode(id) {
    if (!["sandbox", "ask", "full"].includes(id)) return;
    permMode = id;
    try { window.__rsPermMode = () => permMode; } catch {}
    try { chrome.storage.local.set({ rsPermMode: id }); } catch {}
    try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: id === "full" }).catch(() => {}); } catch {}
  }
  // Thrown by submitAndGetBase when the message VERIFIABLY never landed (the
  // composer never cleared and no new turn appeared after all retries). Callers
  // must abort the turn immediately instead of waiting a full warm-up cycle for
  // a reply that can never come - that dead wait is what froze the composer for
  // minutes on sites whose send silently no-ops (crax guest mode).
  class SendAbortedError extends Error {}


  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[rs-diag]") or window.__rsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  const RS_DIAG_MAX = 300;
  const _diag = [];
  let debugDiagnostics=false;
  try{chrome.storage.local.get("rsDebugDiagnostics",r=>{debugDiagnostics=!!(r&&r.rsDebugDiagnostics);});}catch{}
  function diag(event, data) {
    let snap = {};
    try { snap = { ...P.snapshot(), gen: P.isGenerating(), run: (typeof A !== 'undefined' ? A.running : false) }; } catch {}
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > RS_DIAG_MAX) _diag.shift();
    if(debugDiagnostics){try { console.log("[rs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try { let n=document.getElementById("rs-diag-log");if(!n){n=document.createElement("script");n.type="application/json";n.id="rs-diag-log";(document.body||document.documentElement).appendChild(n);}n.textContent=JSON.stringify(_diag); } catch {}}
    try { window.__rsDiag = _diag; } catch {}
  }

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  // ── Global error visibility ────────────────────────────────────────────────
  // Uncaught exceptions and rejected promises used to vanish (most of the loop
  // is wrapped in broad try/catch, but anything outside one was silently lost
  // and looked like "the agent just froze"). Land them in the diag log so a
  // freeze always leaves a fingerprint. Rate-limited: a throwing interval could
  // otherwise flood both the console and the ring buffer.
  {
    let _lastErrAt = 0, _errCount = 0;
    const _report = (kind, detail) => {
      const now = Date.now();
      if (now - _lastErrAt < 3000) { _errCount++; return; }
      diag(kind, { ...detail, suppressed: _errCount });
      _errCount = 0;
      _lastErrAt = now;
      try { console.warn("[rs] uncaught", kind, detail); } catch {}
    };
    window.addEventListener("error", (e) => {
      // Only OUR errors: content-script files carry the extension origin
      // (chrome-extension://<id>/...). The old regex tested the wrong shape and
      // silently dropped every real extension error (site scripts are http(s),
      // never chrome-extension://), so freezes left no fingerprint.
      const file = String((e && e.filename) || "");
      if (file && !file.includes("chrome-extension://")) return;
      _report("uncaught.error", { msg: e && e.message, line: e && e.lineno, file: e && e.filename });
    }, true);
    window.addEventListener("unhandledrejection", (e) => {
      const r = e && e.reason;
      const msg = r && (r.stack || r.message || String(r));
      // Chrome fires these for OUR chrome.runtime.sendMessage rejects too when a
      // tab closes mid-send - already handled as {ok:false,...}, so ignore them.
      if (msg && /Extension context invalidated|message port closed/i.test(msg)) return;
      _report("uncaught.rejection", { msg: String(msg).slice(0, 300) });
    });
  }

  // Central product name. The bar shows THIS constantly; which ENGINE is live
  // is communicated by the RS/AS/AN pill plus a top-right toast on switch.
  const BRAND_NAME = "OrScript";
  const productName=()=>orTheme==="void"?"VoidScript":BRAND_NAME;
  // Shown in the panel instead of a static "Free" label, so a user's screenshot
  // alone tells us which build they're on for debugging. Pulled from
  // manifest.json (single source of truth) rather than duplicated here.
  const EXT_VERSION = chrome.runtime.getManifest().version;
  // Which browser OR is running in. Chrome, Edge, Brave, Opera and Vivaldi all
  // report distinct user-agent tokens, so the system prompt and or_status can
  // name the real browser instead of assuming Chrome.
  function detectBrowser() {
    try {
      const ua = String(navigator.userAgent || "");
      if (/Edg\//.test(ua)) return "Microsoft Edge";
      if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
      if (/Vivaldi/.test(ua)) return "Vivaldi";
      if (/Brave/.test(ua)) return "Brave";
      if (/Chrome\//.test(ua)) return "Chrome";
      if (/Firefox\//.test(ua)) return "Firefox";
      return "a Chromium browser";
    } catch { return "a Chromium browser"; }
  }
  const USER_BROWSER = detectBrowser();
  try { window.__rsBrowserName = () => USER_BROWSER; } catch {}
  // Which bridge launcher to tell the user to run. ORscript Desktop (the Rust
  // app in agent/) builds to bin/or-core.exe on Windows and bin/or-core on
  // macOS / Linux (cargo build --release).
  const IS_WINDOWS_HOST = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
  const RUN_CMD = IS_WINDOWS_HOST ? "bin/or-core.exe" : "bin/or-core (ORscript Desktop)";
  // (The setup tutorial is now an in-app modal — see openTutorial() — so the
  // old YouTube link is gone and can never go stale.)
  // Work.ink locked link - free "watch an ad" support option. Set once the
  // locker is created at https://work.ink; the button is hidden until then.
  const WORKINK_URL = "https://work.ink/2JXi/robloxscript-free-roblox-ai-coding-tool";
  // Roblox "tip" Game Passes - the native currency for the audience.
  const ROBUX_PASSES = [
    { id: 1941228530 },
    { id: 1941336506 },
    { id: 1940736510 },
    { id: 1941672495 },
  ];
  const passUrl = (id) => `https://www.roblox.com/game-pass/${id}`;
  function parseRobuxPrice(text) {
    const m = String(text || "").match(/"PriceInRobux"\s*:\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
  }
  async function lookupRobuxPrice(id) {
    const urls = [
      "https://economy.roblox.com/v1/game-passes/" + id + "/game-pass-product-info",
      "https://economy.roblox.com/v2/assets/" + id + "/details",
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await bg({ type: "web_fetch", url: urls[i], max_chars: 2500 });
        const price = parseRobuxPrice(r && (r.text || r.body));
        if (price > 0) return price;
      } catch (e) {}
    }
    return 0;
  }
  async function fillRobuxPrices(root) {
    if (!root) return;
    const btns = root.querySelectorAll(".rs-tip-rbx[data-pass]");
    await Promise.all(Array.from(btns).map(async (btn) => {
      const id = btn.getAttribute("data-pass");
      const amt = btn.querySelector(".rs-rbx-amt");
      const price = await lookupRobuxPrice(id);
      if (amt) amt.textContent = price > 0 ? String(price) : "";
    }));
  }
  // AI chat sites OR works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const DISCORD_URL = "https://discord.gg/YqVZaZYuy";
  const OR_THEMES = {
    night:      { name: "Night",      sub: "Quiet console",    glyph: "☾", blurb: "Midnight console — hairline ticks, mono status, zero glow." },
    "blood-moon": { name: "Blood Moon", sub: "Brutal eclipse",  glyph: "☽", blurb: "Blood Moon — hard red edges, a pulsing disc, ember haze." },
    sakura:     { name: "Sakura",     sub: "Drifting petals",  glyph: "✿", blurb: "Sakura — soft pill shapes, petals falling through the light." },
    starglaze:  { name: "Starglaze",  sub: "Aurora glass",     glyph: "✦", blurb: "Starglaze — frosted glass, a drifting aurora, spinning star." },
    autumn:     { name: "Autumn",     sub: "Wood & embers",    glyph: "❧", blurb: "Autumn — wood grain, falling leaves, harvest ember glow." },
    pixelated:  { name: "Pixelated",  sub: "CRT pixel retro",  glyph: "▚", blurb: "Pixelated — square edges, scanlines, a blinking terminal cursor." },
    void:       { name: "VoidScript", sub: "Partner visual identity", glyph: "◉", blurb: "VoidScript — OrScript's partner identity, presented as a precision deep-space workspace." },
    epicface:   { name:"Epic Face", sub:"Legendary reaction", glyph:"★", blurb:"Chrome, sunglasses, victory glow, and unapologetic confidence.", sound:{base:220,accent:660,shape:"square",burst:true,noise:1200} },
    headooh:    { name:"Headshot OOOOH!", sub:"Critical hype", glyph:"◎", blurb:"Critical hit confirmed — the whole stadium erupts.", sound:{base:220,accent:990,shape:"sawtooth",burst:true,noise:1800} },
    ragequit:   { name:"Rage Quit", sub:"Controller damage", glyph:"⫽", blurb:"Hot red warning stripes, cracked panels, and maximum salt.", sound:{base:120,accent:240,shape:"sawtooth",burst:true,noise:400} },
    killfeed:   { name:"Kill Feed", sub:"GG / EZ", glyph:"⌖", blurb:"Competitive HUD markers, score ticks, and match-point tension.", sound:{base:260,accent:780,shape:"square",burst:false} },
    shitpost:   { name:"Shitpost", sub:"Cursed internet", glyph:"✺", blurb:"Chaotic stickers, impossible gradients, and proudly broken symmetry.", sound:{base:290,accent:1170,shape:"square",burst:true,noise:2400} },
    skillissue: { name:"Skill Issue", sub:"Try again", glyph:"↯", blurb:"Soft fail screens, wobbling cards, and a lovingly judgmental UI.", sound:{base:150,accent:450,shape:"triangle",burst:false} },
    pogchamp:   { name:"Pog Champ", sub:"Streamer hype", glyph:"▲", blurb:"Live-stream overlays, chat bubbles, neon highlights, and hype bursts.", sound:{base:392,accent:784,shape:"sine",burst:true,noise:1500} },
    glitchlord: { name:"Glitch Lord", sub:"Reality corrupted", glyph:"▞", blurb:"Chromatic offsets, scanline noise, corrupted labels, and unstable motion.", sound:{base:90,accent:1320,shape:"sawtooth",burst:true,noise:3000} },
    npcenergy:  { name:"NPC Energy", sub:"Default dialogue", glyph:"⋯", blurb:"Deadpan prompts, plastic panels, looping micro-motion, and uncanny calm.", sound:{base:196,accent:294,shape:"sine",burst:false} },
  };
  // Meme theme base gradients (bar fallback). Corner / inside decorations are
  // designed SVG ornaments in overlay.css (--orx-orn), never emoji or text.
  const MEME_THEME_DATA={
    epicface:["#18243a","#426b9c"],
    headooh:["#17142b","#b51f4b"],
    ragequit:["#210b0b","#681b16"],
    killfeed:["#080d0b","#1c3d1b"],
    shitpost:["#fff200","#ff46c8"],
    skillissue:["#292631","#403a4b"],
    pogchamp:["#10152c","#7431a5"],
    glitchlord:["#070711","#26103b"],
    npcenergy:["#c6c8c2","#e5e5dc"],
  };
  for(const [id,data] of Object.entries(MEME_THEME_DATA)){const th=OR_THEMES[id];if(th){th.background=data[0]+","+data[1];}}  // sound packs: see THEME_SOUNDS below
  let orTheme = "night";
  let soundOn = true;
  let themeVolume = 70, memeEffects = "full", memeIntensity = "medium", themePreviewId = null, themeBeforePreview = null;
  try {
    chrome.storage.local.get(["rsTheme", "rsSounds"], (r) => {
      if (r && OR_THEMES[r.rsTheme]) orTheme = r.rsTheme;
      if (r && typeof r.rsSounds === "boolean") soundOn = r.rsSounds;
      if (r && Number.isFinite(Number(r.rsThemeVolume))) themeVolume=Math.max(0,Math.min(100,Number(r.rsThemeVolume)));
      if (r && ["full","reduced","off"].includes(r.rsMemeEffects)) memeEffects=r.rsMemeEffects;
      if (r && ["low","medium","maximum"].includes(r.rsMemeIntensity)) memeIntensity=r.rsMemeIntensity;
      try { applyOrSkin(); } catch {}
    });
  } catch {}
  function applyOrSkin() {
    try {
      document.documentElement.setAttribute("data-rs-theme", orTheme);
      window.__rsTheme = () => orTheme;
      const th = OR_THEMES[orTheme];
      document.documentElement.style.setProperty("--rs-theme-bg",th?.background||"");document.documentElement.dataset.memeEffects=memeEffects;document.documentElement.dataset.memeIntensity=memeIntensity;
      const brand = document.getElementById("rs-brand");
      if (brand) {
        const product=orTheme==="void"?"VoidScript":"OrScript";brand.textContent=product;
        brand.title = product + (th ? " · " + th.name : "");
      }
      const tag = document.querySelector(".rs-menu-tag");
      if (tag){const product=orTheme==="void"?"VoidScript":"OrScript";tag.textContent=product+" · v"+EXT_VERSION+" · "+((th&&th.name)||"Night");}
      const orn = document.getElementById("rs-ornament");
      if (orn) orn.setAttribute("data-theme", orTheme || "night");
      // Every theme paints four corner rails; overlay.css draws a bracket frame and
      // the theme's SVG ornament (--orx-orn) in each. Created once, retagged on
      // theme changes, hidden when effects are off, never takes pointer events.
      const memeIds=["epicface","headooh","ragequit","killfeed","shitpost","skillissue","pogchamp","glitchlord","npcenergy"];
      const root=document.getElementById("rs-root");
      if(root){let rail=root.querySelector(".rs-theme-corners");if(!rail){rail=document.createElement("div");rail.className="rs-theme-corners";rail.innerHTML='<span class="rs-theme-corner rs-corner-tl"></span><span class="rs-theme-corner rs-corner-tr"></span><span class="rs-theme-corner rs-corner-bl"></span><span class="rs-theme-corner rs-corner-br"></span>';root.appendChild(rail);}rail.dataset.kind=memeIds.includes(orTheme)?"meme":"classic";rail.hidden=memeEffects==="off";}
      const glyph = document.querySelector(".rs-menu-glyph");
      if (glyph) glyph.textContent = (th && th.glyph) || "☾";
      document.querySelectorAll(".rs-theme-card").forEach((el) => {
        el.classList.toggle("on", el.getAttribute("data-theme") === orTheme);
      });
      const barEl = document.getElementById("rs-bar");
      if (barEl) barEl.setAttribute("data-or-theme", orTheme || "night");
    } catch {}
  }
  function setOrTheme(id) {
    if (!OR_THEMES[id]) return;
    orTheme = id;
    applyOrSkin();
    try { chrome.storage.local.set({ rsTheme: id }); } catch {}
  }
  function previewOrTheme(id){if(!OR_THEMES[id])return;if(!themePreviewId)themeBeforePreview=orTheme;themePreviewId=id;orTheme=id;applyOrSkin();try{playSfx("special");(window.__rsBuildMenu||buildMenu)();}catch{}}
  function exitThemePreview(){if(!themePreviewId)return;orTheme=themeBeforePreview||orTheme;themePreviewId=null;themeBeforePreview=null;applyOrSkin();(window.__rsBuildMenu||buildMenu)();}
  function applyThemeVolume(v){themeVolume=Math.max(0,Math.min(100,Number(v)||0));try{chrome.storage.local.set({rsThemeVolume:themeVolume});}catch{}}
  function setMemeEffects(v){memeEffects=["full","reduced","off"].includes(v)?v:"full";applyOrSkin();try{chrome.storage.local.set({rsMemeEffects:memeEffects});}catch{} }
  function setMemeIntensity(v){memeIntensity=["low","medium","maximum"].includes(v)?v:"medium";applyOrSkin();try{chrome.storage.local.set({rsMemeIntensity:memeIntensity});}catch{} }
  function setSounds(v) {
    soundOn = !!v;
    try { chrome.storage.local.set({ rsSounds: soundOn }); } catch {}
  }
  // ── Theme sound packs (1.19.7) ────────────────────────────────────────────
  // Every theme ships seven hand-tuned effects; the data lives here and the
  // core owns one synth (playSfx). Each effect is under one second, is built
  // from oscillators + filtered noise only, and plays once — never loops.
  //   ["t", freq, at, dur, shape, gain, opts]  tone. opts: freqEnd (glide), attack,
  //        lp (lowpass Hz), det (2nd osc detune, cents), vib (Hz) + vibDepth (Hz)
  //   ["n", at, dur, gain, hp, lp]             filtered noise puff
  //   ["a", [freqs], at, step, dur, shape, gain, opts]  arpeggio — one tone per freq
  const SFX_KINDS = ["start", "done", "stop", "error", "ok", "click", "special"];
  const THEME_SOUNDS = {
    night: { label: "Quiet console — soft sine intervals", fx: {
      start:  [["t",440,0,.09,"sine",.03],["t",660,.08,.14,"sine",.028]],
      done:   [["t",523,0,.1,"sine",.03],["t",659,.09,.1,"sine",.028],["t",784,.18,.22,"sine",.03]],
      stop:   [["t",660,0,.14,"sine",.03,{freqEnd:440}],["t",330,.1,.2,"sine",.02]],
      error:  [["t",220,0,.16,"sine",.035,{freqEnd:165}],["t",165,.14,.2,"sine",.025]],
      ok:     [["t",880,0,.06,"sine",.025],["t",1320,.05,.09,"sine",.02]],
      click:  [["t",1760,0,.03,"sine",.018,{attack:.003}]],
      special:[["t",880,0,.5,"sine",.03,{vib:5,vibDepth:6}],["t",1320,.05,.45,"sine",.018,{vib:5,vibDepth:6}]],
    }},
    "blood-moon": { label: "Dark brass and sub thumps", fx: {
      start:  [["t",55,0,.25,"sine",.07,{freqEnd:38}],["t",220,.02,.18,"sawtooth",.03,{lp:900}],["n",0,.14,.018,300]],
      done:   [["t",110,0,.2,"sawtooth",.03,{lp:700}],["t",165,.12,.2,"sawtooth",.028,{lp:900}],["t",220,.24,.3,"sawtooth",.03,{lp:1100}],["t",55,.24,.3,"sine",.06,{freqEnd:40}]],
      stop:   [["t",196,0,.22,"sawtooth",.03,{lp:800,freqEnd:98}],["t",49,.05,.3,"sine",.06,{freqEnd:36}]],
      error:  [["t",147,0,.16,"sawtooth",.035,{lp:600,freqEnd:110}],["t",139,0,.16,"sawtooth",.03,{lp:600}],["n",0,.2,.02,200,1200],["t",41,.02,.32,"sine",.07,{freqEnd:30}]],
      ok:     [["t",330,0,.07,"sawtooth",.022,{lp:1200}],["t",440,.06,.1,"sawtooth",.02,{lp:1200}]],
      click:  [["n",0,.03,.02,1200,4000],["t",110,0,.05,"sine",.03]],
      special:[["t",110,0,.6,"sawtooth",.028,{lp:500,vib:4,vibDepth:3}],["t",131,.1,.5,"sawtooth",.022,{lp:500}],["t",55,0,.7,"sine",.06,{freqEnd:41}],["n",.35,.3,.014,200,800]],
    }},
    sakura: { label: "Pentatonic chimes with petal shimmer", fx: {
      start:  [["a",[523,659,784],0,.07,.16,"triangle",.028],["n",0,.1,.005,5000]],
      done:   [["a",[523,587,784,880,1047],0,.06,.2,"triangle",.026],["t",1568,.32,.3,"sine",.014]],
      stop:   [["a",[880,784,659],0,.07,.16,"triangle",.024]],
      error:  [["t",392,0,.18,"triangle",.03,{freqEnd:330}],["t",294,.12,.22,"triangle",.024]],
      ok:     [["t",1047,0,.06,"sine",.022],["t",1319,.05,.1,"sine",.018]],
      click:  [["t",2093,0,.025,"triangle",.016,{attack:.002}],["n",0,.02,.004,6000]],
      special:[["a",[523,659,784,1047,1319],0,.09,.3,"triangle",.024],["a",[1319,1047,784],.5,.08,.26,"sine",.016],["n",0,.5,.004,6000]],
    }},
    starglaze: { label: "Glassy detuned bells, long tails", fx: {
      start:  [["t",1047,0,.22,"sine",.026,{det:7}],["t",1319,.1,.3,"sine",.022,{det:7}],["n",0,.25,.005,7000]],
      done:   [["a",[784,1047,1319,1568],0,.08,.35,"sine",.022,{det:6}],["t",2093,.34,.45,"sine",.012,{det:4}]],
      stop:   [["t",1319,0,.3,"sine",.024,{freqEnd:659,det:6}],["n",0,.2,.004,7000]],
      error:  [["t",494,0,.22,"sine",.03,{freqEnd:415,det:9}],["t",247,.1,.3,"triangle",.02]],
      ok:     [["t",1568,0,.09,"sine",.02,{det:5}],["t",2093,.07,.14,"sine",.016,{det:5}]],
      click:  [["t",2637,0,.03,"sine",.014,{attack:.002}],["n",0,.02,.004,8000]],
      special:[["a",[659,880,1109,1319,1760],0,.07,.35,"sine",.02,{det:7}],["a",[1760,1319,880],.45,.09,.3,"sine",.012,{det:7}],["n",.1,.5,.005,7000]],
    }},
    autumn: { label: "Warm low triangles and wood knocks", fx: {
      start:  [["t",196,0,.12,"triangle",.035,{lp:1200}],["t",262,.09,.16,"triangle",.03,{lp:1200}],["n",0,.03,.02,200,900]],
      done:   [["a",[262,330,392],0,.1,.22,"triangle",.03,{lp:1300}],["t",523,.32,.3,"triangle",.022,{lp:1500}]],
      stop:   [["t",330,0,.18,"triangle",.03,{lp:1000,freqEnd:196}],["n",0,.04,.018,200,700]],
      error:  [["t",147,0,.2,"triangle",.035,{lp:700,freqEnd:123}],["n",0,.06,.02,150,600]],
      ok:     [["t",392,0,.07,"triangle",.025,{lp:1500}],["t",494,.06,.1,"triangle",.02,{lp:1500}]],
      click:  [["n",0,.025,.028,200,1200],["t",330,0,.03,"triangle",.02,{lp:900}]],
      special:[["n",0,.03,.02,300,1500],["n",.09,.03,.016,300,1500],["n",.21,.03,.022,300,1500],["n",.3,.03,.014,300,1500],["n",.44,.03,.02,300,1500],["t",196,0,.55,"triangle",.022,{lp:800,vib:3,vibDepth:2}]],
    }},
    pixelated: { label: "8-bit square-wave chiptune", fx: {
      start:  [["a",[523,659,784,1047],0,.045,.07,"square",.022,{attack:.003}]],
      done:   [["a",[523,523,784,1047,1319],0,.05,.08,"square",.022,{attack:.003}],["t",1568,.28,.18,"square",.016,{attack:.003}]],
      stop:   [["a",[1047,784,523],0,.05,.07,"square",.02,{attack:.003}]],
      error:  [["t",262,0,.1,"square",.022,{attack:.003}],["t",220,.11,.22,"square",.022,{attack:.003,freqEnd:110}],["n",.11,.08,.012,1500]],
      ok:     [["t",1047,0,.045,"square",.016,{attack:.003}],["t",1319,.05,.08,"square",.014,{attack:.003}]],
      click:  [["t",1568,0,.025,"square",.012,{attack:.002}]],
      special:[["a",[392,523,659,784,1047,1319,1568,2093],0,.04,.06,"square",.018,{attack:.003}],["t",2093,.34,.22,"square",.014,{attack:.003,vib:9,vibDepth:20}]],
    }},
    void: { label: "Precision sci-fi sweeps and radar pings", fx: {
      start:  [["t",330,0,.14,"sine",.028,{freqEnd:660}],["t",660,.1,.16,"sawtooth",.014,{lp:900}],["n",0,.02,.012,3000]],
      done:   [["t",880,0,.09,"sine",.026],["t",1320,.08,.12,"sine",.022],["t",1760,.17,.28,"sine",.02,{freqEnd:1700}]],
      stop:   [["t",880,0,.2,"sine",.026,{freqEnd:220}],["n",.1,.03,.01,3000]],
      error:  [["t",165,0,.2,"sawtooth",.03,{lp:700,freqEnd:110}],["t",170,0,.2,"sawtooth",.018,{lp:700,freqEnd:112}],["n",0,.03,.018,2500]],
      ok:     [["t",1320,0,.05,"sine",.02],["t",1760,.045,.08,"sine",.016]],
      click:  [["n",0,.015,.02,3500],["t",2200,0,.02,"sine",.012,{attack:.002}]],
      special:[["t",1200,0,.3,"sine",.024,{freqEnd:1180}],["t",1200,.32,.25,"sine",.012,{freqEnd:1180}],["t",1200,.6,.2,"sine",.006,{freqEnd:1180}],["t",110,0,.5,"sawtooth",.01,{lp:400}]],
    }},
    epicface: { label: "Triumphant brass fanfare", fx: {
      start:  [["t",392,0,.1,"sawtooth",.028,{lp:1800,det:5}],["t",523,.09,.12,"sawtooth",.028,{lp:1800,det:5}],["t",784,.18,.22,"sawtooth",.03,{lp:2000,det:5}],["n",0,.1,.01,1500]],
      done:   [["a",[392,494,587],0,.08,.14,"sawtooth",.026,{lp:1800,det:5}],["t",784,.24,.4,"sawtooth",.03,{lp:2200,det:6,vib:5,vibDepth:4}],["n",.24,.3,.012,1500]],
      stop:   [["t",587,0,.18,"sawtooth",.026,{lp:1600,det:5,freqEnd:392}]],
      error:  [["t",185,0,.2,"sawtooth",.03,{lp:900,freqEnd:147,det:8}],["n",0,.15,.014,600]],
      ok:     [["t",659,0,.07,"sawtooth",.02,{lp:2000,det:4}],["t",988,.06,.12,"sawtooth",.02,{lp:2000,det:4}]],
      click:  [["t",1319,0,.03,"triangle",.018,{attack:.003}]],
      special:[["a",[392,392,392,523],0,.09,.11,"sawtooth",.026,{lp:1800,det:5}],["t",784,.38,.45,"sawtooth",.03,{lp:2400,det:7,vib:5,vibDepth:5}],["n",.38,.4,.016,1200]],
    }},
    headooh: { label: "Rising sweeps and a roaring crowd", fx: {
      start:  [["t",220,0,.22,"sawtooth",.022,{lp:1400,freqEnd:880,det:9}],["n",0,.3,.016,400,3000]],
      done:   [["t",440,0,.4,"sawtooth",.026,{lp:1600,freqEnd:880,det:12,vib:6,vibDepth:8}],["n",0,.55,.022,300,4000],["n",.2,.35,.014,2000]],
      stop:   [["t",660,0,.25,"sawtooth",.022,{lp:1200,freqEnd:220,det:9}],["n",0,.25,.012,400,2000]],
      error:  [["t",196,0,.22,"sawtooth",.028,{lp:800,freqEnd:131,det:14}],["n",0,.2,.016,300,1500]],
      ok:     [["t",880,0,.07,"triangle",.022],["t",1175,.06,.12,"triangle",.02],["n",0,.08,.008,2500]],
      click:  [["n",0,.03,.018,1500,5000],["t",1047,0,.03,"triangle",.014]],
      special:[["t",196,0,.45,"sawtooth",.022,{lp:1200,freqEnd:784,det:12,vib:6,vibDepth:10}],["t",233,.05,.4,"sawtooth",.016,{lp:1200,freqEnd:932,det:12}],["n",0,.7,.024,300,5000],["n",.45,.3,.018,1500]],
    }},
    ragequit: { label: "Crunchy hits, tritones and slams", fx: {
      start:  [["t",220,0,.14,"square",.024],["t",311,0,.14,"sawtooth",.02,{lp:1600}],["n",0,.1,.024,200,900],["t",60,0,.18,"sine",.06,{freqEnd:38}]],
      done:   [["t",330,0,.12,"square",.024],["t",466,.1,.2,"square",.022],["n",0,.12,.02,300,1200]],
      stop:   [["t",311,0,.2,"sawtooth",.026,{lp:1200,freqEnd:110}],["n",0,.18,.02,200,800],["t",55,.02,.25,"sine",.06,{freqEnd:35}]],
      error:  [["n",0,.12,.03,100,700],["n",.12,.12,.028,100,700],["t",196,0,.26,"sawtooth",.03,{lp:700,freqEnd:92}],["t",207,0,.26,"square",.018,{freqEnd:98}],["t",50,0,.35,"sine",.07,{freqEnd:30}]],
      ok:     [["t",440,0,.06,"square",.018],["t",554,.05,.09,"square",.016]],
      click:  [["n",0,.025,.028,500,2500],["t",165,0,.04,"square",.02]],
      special:[["n",0,.09,.03,150,900],["t",70,0,.2,"sine",.07,{freqEnd:38}],["n",.17,.09,.03,150,900],["t",70,.17,.2,"sine",.07,{freqEnd:38}],["n",.34,.14,.034,120,800],["t",60,.34,.3,"sine",.08,{freqEnd:30}],["t",311,.34,.4,"sawtooth",.026,{lp:900,freqEnd:78}]],
    }},
    killfeed: { label: "Hit-marker ticks and elimination stingers", fx: {
      start:  [["t",1200,0,.03,"square",.018,{attack:.002}],["t",900,.035,.03,"square",.018,{attack:.002}],["t",1200,.07,.06,"square",.016,{attack:.002}]],
      done:   [["a",[660,880,1320],0,.05,.07,"square",.02,{attack:.002}],["t",1760,.16,.14,"square",.016,{attack:.002}],["n",0,.05,.01,3000]],
      stop:   [["t",900,0,.03,"square",.018,{attack:.002}],["t",600,.04,.09,"square",.018,{attack:.002}]],
      error:  [["t",300,0,.08,"square",.022,{attack:.002}],["t",300,.1,.08,"square",.022,{attack:.002}],["n",0,.06,.014,800,3000]],
      ok:     [["t",1400,0,.03,"square",.014,{attack:.002}],["t",1050,.035,.05,"square",.014,{attack:.002}]],
      click:  [["t",1600,0,.02,"square",.012,{attack:.002}],["n",0,.015,.01,4000]],
      special:[["a",[880,988,1109,1319,1480],0,.055,.06,"square",.018,{attack:.002}],["t",1760,.3,.22,"square",.016,{attack:.002}],["n",.3,.1,.012,3000]],
    }},
    shitpost: { label: "Airhorns and the vine boom", fx: {
      start:  [["t",440,0,.3,"sawtooth",.022,{lp:2200,det:12,vib:7,vibDepth:6}],["t",442,0,.3,"sawtooth",.018,{lp:2200,det:-12}]],
      done:   [["t",440,0,.12,"sawtooth",.022,{lp:2200,det:12}],["t",440,.15,.12,"sawtooth",.022,{lp:2200,det:12}],["t",440,.3,.4,"sawtooth",.024,{lp:2400,det:12,vib:7,vibDepth:6}]],
      stop:   [["t",523,0,.35,"triangle",.028,{freqEnd:131}]],
      error:  [["t",90,0,.55,"sine",.09,{freqEnd:36}],["n",0,.25,.024,60,300]],
      ok:     [["t",659,0,.06,"triangle",.024,{freqEnd:988}]],
      click:  [["t",1976,0,.03,"sine",.016,{attack:.002}],["n",0,.02,.01,3000]],
      special:[["t",90,0,.55,"sine",.09,{freqEnd:36}],["n",0,.25,.024,60,300],["t",440,.35,.4,"sawtooth",.022,{lp:2400,det:12,vib:7,vibDepth:6}],["t",442,.35,.4,"sawtooth",.018,{lp:2400,det:-12}]],
    }},
    skillissue: { label: "Wobbly notes and a sad trombone", fx: {
      start:  [["t",330,0,.22,"triangle",.03,{vib:6,vibDepth:12}],["t",392,.18,.25,"triangle",.028,{vib:6,vibDepth:12}]],
      done:   [["t",392,0,.18,"triangle",.028,{vib:6,vibDepth:10}],["t",494,.15,.3,"triangle",.026,{vib:6,vibDepth:10}]],
      stop:   [["t",330,0,.3,"sawtooth",.022,{lp:600,freqEnd:220,vib:6,vibDepth:10}]],
      error:  [["t",233,0,.22,"sawtooth",.026,{lp:600,vib:5,vibDepth:8}],["t",220,.22,.22,"sawtooth",.026,{lp:600,vib:5,vibDepth:8}],["t",208,.44,.22,"sawtooth",.026,{lp:600,vib:5,vibDepth:8}],["t",196,.66,.3,"sawtooth",.028,{lp:600,freqEnd:170,vib:5,vibDepth:12}]],
      ok:     [["t",523,0,.08,"triangle",.022,{vib:7,vibDepth:8}]],
      click:  [["t",880,0,.035,"triangle",.016,{freqEnd:760}]],
      special:[["t",247,0,.22,"sawtooth",.028,{lp:650,vib:5,vibDepth:8}],["t",233,.22,.22,"sawtooth",.028,{lp:650,vib:5,vibDepth:8}],["t",220,.44,.22,"sawtooth",.028,{lp:650,vib:5,vibDepth:8}],["t",208,.66,.32,"sawtooth",.03,{lp:650,freqEnd:180,vib:5,vibDepth:14}]],
    }},
    pogchamp: { label: "Hype risers and confetti dings", fx: {
      start:  [["a",[523,659,784,1047],0,.05,.1,"triangle",.026],["n",0,.12,.01,2500]],
      done:   [["a",[523,659,784,1047,1319],0,.05,.12,"triangle",.026],["t",1568,.26,.3,"sine",.022],["n",.26,.25,.014,2000]],
      stop:   [["a",[1047,784,659,523],0,.05,.1,"triangle",.022]],
      error:  [["t",294,0,.16,"triangle",.03,{freqEnd:220}],["t",220,.14,.22,"triangle",.024],["n",0,.1,.01,1000]],
      ok:     [["t",1047,0,.06,"sine",.024],["t",1568,.05,.1,"sine",.02]],
      click:  [["t",1760,0,.03,"triangle",.016,{attack:.002}]],
      special:[["a",[523,659,784,1047,1319,1568],0,.045,.1,"triangle",.026],["t",2093,.28,.35,"sine",.022,{vib:6,vibDepth:8}],["n",.28,.3,.018,1800],["t",1047,.28,.35,"triangle",.014]],
    }},
    glitchlord: { label: "Stuttering detuned glitch bursts", fx: {
      start:  [["a",[880,440,1320,660],0,.035,.035,"square",.018,{attack:.002}],["n",0,.02,.014,2000],["n",.07,.02,.014,2000]],
      done:   [["a",[660,1320,990,1980,1320],0,.04,.04,"square",.018,{attack:.002,det:30}],["n",.2,.06,.012,1500]],
      stop:   [["a",[1320,660,330],0,.045,.05,"square",.018,{attack:.002,det:30}],["n",.05,.03,.012,1200]],
      error:  [["a",[220,233,220,233],0,.05,.06,"sawtooth",.024,{lp:1200,det:40}],["n",0,.03,.02,1500],["n",.1,.03,.02,1500],["n",.2,.05,.024,800]],
      ok:     [["t",1320,0,.03,"square",.014,{attack:.002,det:25}],["t",1760,.04,.05,"square",.012,{attack:.002,det:25}]],
      click:  [["n",0,.012,.018,3000],["t",2640,0,.015,"square",.01,{attack:.002}]],
      special:[["a",[1320,440,1760,220,990,2640,660,1480],0,.04,.04,"square",.018,{attack:.002,det:35}],["n",.02,.02,.016,2500],["n",.14,.02,.016,2500],["n",.26,.03,.016,1800],["t",55,.3,.25,"sawtooth",.02,{lp:300,freqEnd:35}]],
    }},
    npcenergy: { label: "Deadpan monotone dialogue blips", fx: {
      start:  [["t",330,0,.06,"sine",.022],["t",330,.09,.06,"sine",.022]],
      done:   [["t",330,0,.06,"sine",.022],["t",330,.09,.06,"sine",.022],["t",330,.18,.06,"sine",.022]],
      stop:   [["t",262,0,.12,"sine",.022]],
      error:  [["t",196,0,.22,"sine",.028]],
      ok:     [["t",330,0,.06,"sine",.02]],
      click:  [["t",392,0,.025,"sine",.014,{attack:.002}]],
      special:[["t",330,0,.05,"sine",.02],["t",330,.08,.05,"sine",.02],["t",330,.16,.05,"sine",.02],["t",330,.24,.05,"sine",.02],["t",330,.32,.05,"sine",.02],["t",262,.46,.12,"sine",.022]],
    }},
  };
  // Expose packs on the theme table so the picker, preview buttons and
  // "Surprise me" see one source of truth (th.sound.effects = seven names).
  for (const [id, pack] of Object.entries(THEME_SOUNDS)) {
    const th = OR_THEMES[id]; if (!th) continue;
    th.sound = Object.assign({}, th.sound || {}, { pack: id, label: pack.label, effects: SFX_KINDS.map((name) => ({ name })) });
  }
  const SFX_LABELS = { start: "▶ start", done: "✓ done", stop: "■ stop", error: "✕ error", ok: "· ok", click: "click", special: "★ signature" };

  // kind: one of SFX_KINDS. themeId: optional — preview another theme's pack
  // from the picker without switching to it.
  function playSfx(kind, themeId) {
    if (!soundOn) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = playSfx._ctx || (playSfx._ctx = new AC());
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const vol = themeVolume / 100;
      // Tone: optional glide, lowpass, detuned second oscillator (chorus) and
      // vibrato LFO. Everything is scheduled and stopped — nothing lingers.
      const tone = (freq, t, dur, type, gain, opts) => {
        opts = opts || {};
        const g = ctx.createGain();
        const peak = Math.max(0.0002, (gain || 0.05) * vol);
        const attack = opts.attack || 0.018;
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.exponentialRampToValueAtTime(peak, now + t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + dur);
        let sink = g;
        if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = opts.lp; f.Q.value = 0.8; f.connect(g); sink = f; }
        g.connect(ctx.destination);
        const voices = opts.det ? [0, opts.det] : [0];
        let lfo = null, lfoGain = null;
        if (opts.vib) { lfo = ctx.createOscillator(); lfoGain = ctx.createGain(); lfo.frequency.value = opts.vib; lfoGain.gain.value = opts.vibDepth || 6; lfo.connect(lfoGain); }
        for (const det of voices) {
          const o = ctx.createOscillator();
          o.type = type || "sine";
          o.detune.value = det;
          o.frequency.setValueAtTime(freq, now + t);
          if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(opts.freqEnd, now + t + dur);
          if (lfoGain) lfoGain.connect(o.frequency);
          o.connect(sink);
          o.start(now + t); o.stop(now + t + dur + 0.05);
        }
        if (lfo) { lfo.start(now + t); lfo.stop(now + t + dur + 0.05); }
      };
      // Short filtered noise puff — adds the "chime/click/crunch" texture beeps lack.
      const noise = (t, dur, gain, hp, lp) => {
        const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.setValueAtTime(Math.max(0.0002, (gain || 0.02) * vol), now + t);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + dur);
        const f = ctx.createBiquadFilter();
        f.type = "highpass"; f.frequency.value = hp || 900;
        src.connect(f);
        let tail = f;
        if (lp) { const f2 = ctx.createBiquadFilter(); f2.type = "lowpass"; f2.frequency.value = lp; f.connect(f2); tail = f2; }
        tail.connect(g); g.connect(ctx.destination);
        src.start(now + t); src.stop(now + t + dur + 0.05);
      };
      const pack = THEME_SOUNDS[themeId || orTheme] || THEME_SOUNDS.night;
      const steps = pack.fx[kind] || pack.fx.ok;
      for (const st of steps) {
        if (st[0] === "t") tone(st[1], st[2], st[3], st[4], st[5], st[6]);
        else if (st[0] === "n") noise(st[1], st[2], st[3], st[4], st[5]);
        else if (st[0] === "a") st[1].forEach((f, i) => tone(f, st[2] + i * st[3], st[4], st[5], st[6], st[7]));
      }
    } catch {}
  }

  const CODECRAFT_PAGE_URL = (() => { try { return chrome.runtime.getURL("codecraft.html"); } catch { return "codecraft.html"; } })();
  const AI_SITES = [
    { name: "DeepSeek", url: "https://chat.deepseek.com/" },
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Claude", url: "https://claude.ai/new" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.com/" },
    { name: "Kimi AI", url: "https://kimi.ai/" },
    { name: "Kimi K3 · NVIDIA NIM", url: "https://build.nvidia.com/moonshotai/kimi-k3/playground" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/text/direct" },
    { name: "Meta AI", url: "https://www.meta.ai/" },
    { name: "Crax GPT", url: "https://gpt.crax.lol/" },
    { name: "Ox Alpha", url: "https://oxalpha.com/" },
    { name: "Vani Chat", url: "https://c.vani.ai/chat" },
    // ClickUp Brain lives inside the ClickUp workspace app (sidebar AI / Ask AI).
    { name: "ClickUp Brain", url: "https://app.clickup.com/" },
    // CodeCraft is an OpenAI-compatible API with no web chat: ORscript hosts
    // the chat itself (codecraft.html, bring-your-own cc_ key). The page URL
    // is extension-local, so it opens through the background worker.
    { name: "CodeCraft API", url: CODECRAFT_PAGE_URL, host: "codecraftapi.com · in ORscript", extensionPage: "codecraft.html" },
    { name: "Notion AI", url: "https://www.notion.so/chat" },
    { name: "MiniMax Agent", url: "https://agent.minimax.io/" },
    { name: "Overchat", url: "https://overchat.ai/" },
    { name: "HuggingChat", url: "https://huggingface.co/chat/" },
    { name: "Mistral Le Chat", url: "https://chat.mistral.ai/" },
    { name: "OpenRouter Chat", url: "https://openrouter.ai/chat" },
    { name: "Groq Playground", url: "https://console.groq.com/playground" },
    { name: "Cohere Playground", url: "https://dashboard.cohere.com/" },
    { name: "Together AI", url: "https://api.together.ai/" },
    { name: "Fireworks AI", url: "https://fireworks.ai/" },
  ];

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    lifecycle: "IDLE",
    requestSeq: 0,
    activeRequestId: null,
    requestStartedAt: 0,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see sinceLastSys / sysResendDue).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN Roblox vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
    // Timestamp of the last successful tool-catalogue refresh (see ensureTools).
    toolsAt: 0,
    // Steering steering never touches the host editor. Instructions typed into
    // ORscript's own steering field wait here until agentLoop reaches a safe
    // boundary: before a pending command runs, or after an in-flight command
    // returns. Keeping this on session state also makes stale-queue cleanup
    // explicit when a loop/chat ends.
    steeringQueue: [],
    steeringStep: 0,
    steeringPhase: "idle",
    steeringDetail: "",
  };

  // Provider-agnostic roadmap store + replayable agent event stream. The reducer is the only code
  // allowed to mutate execution state; UI and persistence subscribe to it.
  /** @typedef {'pending'|'in_progress'|'completed'|'failed'|'blocked'|'skipped'} RoadmapStatus */
  /** @typedef {{id:string,type:string,timestamp:number,roadmapId:string,phaseId?:string,taskId?:string,data:Object}} RoadmapEvent */
  /** @typedef {{id:string,title:string,description:string,status:RoadmapStatus,phaseId:string,dependsOn:string[],startedAt:?number,completedAt:?number,error:string,result:string,agentActivity:RoadmapEvent[]}} RoadmapTask */
  /** @typedef {{id:string,title:string,description:string,status:RoadmapStatus,tasks:RoadmapTask[]}} RoadmapPhase */
  /** @typedef {{id:string,title:string,description:string,status:RoadmapStatus,createdAt:number,updatedAt:number,currentTaskId:?string,progress:number,phases:RoadmapPhase[]}} RoadmapState */
  // VoidScript is OrScript's partner visual identity.
  const ROADMAP_KEY = "rsRoadmapV2";
  const ROADMAP_LEGACY_KEY = "rsRoadmapV1";
  const ROADMAP_STATES = new Set(["pending", "in_progress", "completed", "failed", "blocked", "skipped"]);
  const ROADMAP_EVENT_TYPES = new Set([
    "roadmap.created","roadmap.updated","roadmap.completed","roadmap.failed",
    "phase.started","phase.completed",
    "task.created","task.started","task.updated","task.completed","task.failed","task.blocked","task.skipped",
    "agent.thinking","agent.activity","agent.tool_started","agent.tool_completed","agent.error","agent.warning",
    "validation.started","validation.completed","validation.failed",
  ]);
  const COMMAND_DISCOVERY_TOOLS = [
    {name:"search_commands",description:"Search every registered Studio, Blender, Web and General command by aliases and natural-language terms.",inputSchema:{type:"object",required:["query"],properties:{query:{type:"string"},environment:{type:"string",enum:["ROBLOX_STUDIO","BLENDER","WEB","GENERAL"]},limit:{type:"integer"}}},server:"orscript"},
    {name:"get_command",description:"Get structured metadata and parameter schema for one command id or alias.",inputSchema:{type:"object",required:["command_id"],properties:{command_id:{type:"string"}}},server:"orscript"},
    {name:"command_registry_stats",description:"Return command totals grouped by environment and category.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"generate_command_docs",description:"Generate command documentation from the live registry.",inputSchema:{type:"object",properties:{category:{type:"string"}}},server:"orscript"},
    {name:"orscript_help",description:"Explain OrScript features without starting work or executing commands.",inputSchema:{type:"object",required:["question"],properties:{question:{type:"string"},topic:{type:"string"}}},server:"orscript",executionMode:"READ"},
  ];
  const STUDIO_ALIAS_TOOLS=Object.entries(TOOL_ALIASES).filter(([id])=>id.startsWith("studio.")).map(([id,target])=>({name:id,description:`Namespaced Studio command routed to ${target}.`,inputSchema:{type:"object",properties:{}},server:"roblox",aliasTarget:target}));
  const RELIABILITY_TOOLS=[
    {name:"mcp.healthCheck",description:"Measure the live MCP transport and capability state.",inputSchema:{type:"object",properties:{debug:{type:"boolean"}}},server:"orscript"},
    {name:"mcp.reconnect",description:"Close an unhealthy MCP transport and perform one bounded reconnect.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"mcp.refreshTools",description:"Explicitly refresh MCP tool discovery and its cache.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"mcp.disconnect",description:"Close MCP and disable automatic reconnect until explicitly reconnected.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"chatgpt.status",description:"Return independent ChatGPT, agent, response-detector and MCP states.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"chatgpt.healthCheck",description:"Run non-mutating ChatGPT provider diagnostics.",inputSchema:{type:"object",properties:{debug:{type:"boolean"}}},server:"orscript"},
  ];
  const PROJECT_REFERENCE_TOOLS=[
    ["project.find",{query:{type:"string"}}],["project.findScripts",{query:{type:"string"}}],["project.findInstances",{query:{type:"string"}}],["project.getService",{name:{type:"string"}}],["project.getUI",{}],["project.getModules",{}],["project.getDependencies",{}]
  ].map(([name,properties])=>({name,description:"Query the active statically analyzed Roblox Template project reference. Never executes project scripts.",inputSchema:{type:"object",properties},server:"orscript",executionMode:"READ",environment:"GENERAL"}));
  const TEMPLATE_AI_TOOLS=[
    {name:"template_create_draft",description:"Submit a complete user-requested template draft for review. This never saves automatically.",inputSchema:{type:"object",required:["template"],properties:{template:{type:"object"},explanation:{type:"array",items:{type:"string"}}}},server:"orscript",executionMode:"READ",environment:"GENERAL"},
    {name:"template_propose_improvement",description:"Submit a structurally improved version of an existing user template for before/after review. Never overwrites the original.",inputSchema:{type:"object",required:["originalId","improved","summary"],properties:{originalId:{type:"string"},mode:{type:"string"},improved:{type:"object"},summary:{type:"array",items:{type:"string"}}}},server:"orscript",executionMode:"READ",environment:"GENERAL"},
    {name:"template_test_result",description:"Submit AI static-analysis findings for a template. Must label this STATIC_ANALYSIS and never claim real execution.",inputSchema:{type:"object",required:["templateId","findings"],properties:{templateId:{type:"string"},findings:{type:"array",items:{type:"object"}},summary:{type:"string"}}},server:"orscript",executionMode:"READ",environment:"GENERAL"},
  ];
  // Knowledge base behind orscript_help (read-only, never starts work).
  // Keep it factual for THIS build - runTool returns one entry verbatim, or the
  // {id,title,summary} list when no topic matches.
  const FEATURE_HELP_TOPICS={
    design:{title:"Design pack (GUI generation)",summary:"Generate real, responsive Roblox GUI - ScreenGui trees with LocalScripts, remotes and server stubs - from design tokens and screen templates instead of static mock-ups.",details:["design_tokens_set {preset, primary, secondary, surface, text, font, radius} writes ReplicatedStorage.OR_Design (Tokens, UIKit, Responsive ModuleScripts). Presets: midnight, clean_light, candy, neon, royal_gold, forest, horror, ocean, sakura, retro. Re-run it to restyle every generated screen at once; design_tokens_get reads the current set.","ui_screen_generate {kind} builds complete screens: main_menu, hud, shop, inventory, settings, leaderboard, daily_rewards, quest_log, loading, dialog, notification_stack - each with an OR_Controller LocalScript (actions, open keys, gamepad B, typewriter), data feeds (leaderstats pills, health, leaderboard rows, toasts) and, where needed, remotes plus server scripts (shop purchase validation, DataStore-backed daily rewards).","ui_from_spec {name, spec} turns a JSON tree (Window, Panel, Row, Column, Grid, ScrollList, Tabs, Button, Label, ItemCard, Slot, CurrencyPill, ProgressBar, Toggle, Input...) sized in pixels on a 1280x720 canvas into scale-based UI with aspect/size constraints and TextScaled text. ui_component_place adds one component to an existing GUI; ui_export_spec converts any GUI back into a spec.","Retrofit tools: ui_apply_tokens (restyle legacy UI), ui_make_responsive (offset roots -> scale + constraints + OR_Responsive script), ui_gamepad_focus (NextSelection links + selection cursor), ui_states_wire (hover/press states + OR_Controller).","ui_audit {path} scores 0-100 and lists issues (contrast, tiny text, small touch targets, offset-only roots, overlap, static canvases, global ZIndex, missing runtime). ui_preview {path, device} stages a window for or_screenshot; call it again with restore:true before shipping.","Everything lives in Studio as normal instances - no account, no web app, no image-only mock-ups. The Visualizer work mode focuses these commands; Ultimate uses them whenever a request involves a menu, HUD, shop or any other screen."]},
    gfx:{title:"Thumbnail & Icon Studio (gfx pack)",summary:"Stage, light, pose and photograph real game thumbnails (1920x1080) and icons (512x512) inside Roblox Studio - the finished PNG is cropped, downloaded and attached to the chat - instead of a static AI image you cannot edit.",details:["gfx_stage_create {style, kind} builds a cyclorama stage far above the map (floor, cove, backdrop, Key/Fill/Rim SpotLights) and applies the style lighting + post stack: cinematic, cartoony, horror, neon, clean or chroma (green screen). Lighting and the camera are snapshotted so gfx_teardown leaves no trace.","gfx_subject_add {source, pose, face, slot} puts a character on stage: 'dummy' (R15), 'r6', 'player:USERID' / 'user:Name' (the real avatar) or any model path. Poses: hero, point, jump, wave, scared, victory, run, think, sit, dab, fight, crossed_arms. Faces on dynamic heads: happy, shocked, angry, scared, smirk, determined, laughing, wink (face_id for classic decal heads). gfx_pose re-poses; gfx_prop_add floats a glowing sword / pet / chest beside the subject.","gfx_camera {preset} frames the shot: hero_low, three_quarter, front, closeup, top_down, dutch, wide, icon (+ fov / pitch / yaw / roll / distance_scale). gfx_overlay {title, subtitle, badge, logo_image} adds a huge outlined gradient title in the style font with 16:9 / 1:1 masks, safe-area and thirds guides. gfx_fx adds sparkles / embers / smoke / confetti / snow / magic / rays; gfx_lighting fine-tunes bloom, saturation, DOF, fog, time and the rig lights.","gfx_capture photographs the viewport through the Studio MCP, hides the guides, crops to the aspect box and returns the PNG (thumbnail 1920x1080, icon 512x512 or custom) - downloaded by the browser and attached to the chat so the model can judge and iterate. gfx_brief writes an art-director brief, an image-generation prompt and a CTR checklist for chats that can paint.","Workflow: gfx_brief -> gfx_stage_create -> gfx_subject_add (+ gfx_prop_add) -> gfx_overlay -> gfx_fx -> gfx_camera -> gfx_capture (judge, iterate) -> gfx_teardown. Maximise the 3D viewport first: the capture is only as sharp as the viewport."]},
    blueprints:{title:"System Blueprints (built-in skills)",summary:"Twelve production-grade game systems that install into the place as real code - shared Core (Signal bus, remotes, DataStore profiles with session locks, receipts, leaderstats, notifications) + a Config ModuleScript, a server Service and a client script per system - then verify themselves in edit mode. Lemonade-style 'complete systems', but built in, inspectable and yours.",details:["blueprint_list shows the catalogue: currency (wallet + data profiles), shop (items, game passes, dev-product packs), pets (eggs, rarity, luck, following pets), combat (weapons, hitboxes, damage pipeline, statuses), rounds (intermission / round / results loop with maps), checkpoints (obby stages + skip product), quests (Bus-driven daily objectives), tycoon (plots, buttons, droppers, collector), leaderboards (OrderedDataStore boards), admin (ranks + chat commands), anticheat (speed / fly / teleport rules), sprint (stamina).","blueprint_install {name:\"pets\"} installs dependencies first (pets -> currency), writes ReplicatedStorage.OR_Systems.<System>.{Config,Remotes}, ServerScriptService.OR_Systems.<System>.Service and StarterPlayerScripts.OR_Systems.<System>Client, generates weapon Tools / a demo course / plots / boards / an arena when the place has none, then runs blueprint_verify. name:\"all\" installs everything; config:{...} seeds the Config.","blueprint_configure {name, config} deep-merges into the Config module (readable Lua table, OR_ConfigJSON attribute) and re-verifies; blueprint_verify compiles Config + Service against Core in edit mode and runs each Service's SelfTest (shop validation, pet odds, cooldowns, round state machine, quest progress, tycoon gates, anticheat rules...); blueprint_status reports versions, remotes and missing dependencies; blueprint_remove uninstalls without touching player data.","Systems talk through Core.Bus topics (Combat.Kill -> Currency reward + Quests + Leaderboards; Checkpoints.Reached -> reward; Round.Won -> reward + quest) so any subset works together. Extend them with script_read / multi_edit on the Service, or build UI on their remotes with ui_screen_generate.","Workflow for a 'make me a pet simulator' request: blueprint_install {name:[\"currency\",\"pets\",\"shop\",\"quests\",\"leaderboards\"]} -> blueprint_configure the eggs / prices -> ui_screen_generate {kind:\"shop\"} wired to the Hatch / Purchase remotes -> start_stop_play + get_console_output -> blueprint_status."]},
    projectindex:{title:"Project Index (codebase awareness)",summary:"ORscript keeps a map of the whole place inside the place (ServerStorage.OR_ProjectIndex): every script hashed and outlined (functions + lines, requires resolved to modules, remotes fired / handled, services, DataStores, tags, TODOs, --!strict), the require graph with hubs / orphans / cycles, remote producers vs consumers with mismatch detection, the folder layout, the coding conventions in use and the installed blueprints. The compact PROJECT MAP is re-injected into the chat so the model works from a map instead of re-reading every script - Lemonade-style codebase awareness without a hosted account.",details:["project_index_build scans the place (or a scope), writes the index and returns added / modified / removed vs the previous index plus the PROJECT MAP text. Run it first on an unknown place and again after big changes; dry_run:true only computes.","project_index_summary is the cheap read: counts, layout per service, the style guide to match (indent, PascalCase / camelCase, strict ratio, task.wait vs wait, game:GetService), hubs, orphans, cycles, remotes with producer -> consumer, mismatches, DataStores, tags, TODO files, largest scripts, installed blueprints, and whether the index is stale.","project_index_search {query, kind} finds functions / exports / require targets / remote names / services / DataStore names / tags / paths / TODOs with script path + line, so you script_read a range instead of a whole file. project_index_script {path} gives one script's outline, requires + required_by, remote partners (who handles what it fires) and stale:true when the source changed since the index.","project_index_graph {kind:\"requires\"} returns the dependency graph (edges, hubs, orphans, cycles, unresolved requires; root + depth for a neighbourhood); {kind:\"remotes\"} the remote matrix with mismatches (fired but never handled, handled but never fired, referenced without an instance, unused instance) and handlers on the wrong side.","project_index_changes rehashes without writing: added / modified / removed scripts, and per modified script the line delta, new / removed functions and whether requires or remotes changed - use it to summarise your own edits or before trusting an old map.","Read before you write: on an existing place start with project_index_build (or project_index_summary when an index exists and is current), match the conventions it reports, wire new scripts into existing hubs and remotes instead of duplicating them, then rebuild the index at the end so the next session starts from an accurate map."]},
    templates:{title:"Templates",summary:"Reusable task recipes (name, instructions, steps, commands, variables) saved locally and run from the Templates library in the OR menu.",details:["Open the OR menu → Templates. New template opens the editor with Basics, Instructions, Steps, Project, Commands, Variables, Validation, AI Improvement and Versions tabs.","Templates can be imported/exported as JSON and versioned; AI Improvement asks the current provider for a structurally better draft that you approve before it is saved.","The agent can list and run them with the template_* commands (get_template, template_list, template_run_…) - nothing is mutated without your save."],howTo:["OR menu → Templates → New template","Fill Basics + Instructions, optionally attach a Roblox project in the Project tab","Save, then type the template name or pick it from the library"]},
    roadmap:{title:"Roadmap / plan",summary:"Optional multi-phase planning: the agent writes phases and tasks, tracks progress, and reports a checklist as work completes.",details:["Toggle Plan in the OR menu. With Plan ON the agent creates a roadmap first (roadmap_create / roadmap_update), then executes phase by phase.","Progress is shown in the chat as the agent ticks tasks; you can ask for the current roadmap or tell it to re-plan.","Plan OFF = direct execution with no roadmap overhead (better for small edits)."],howTo:["OR menu → Plan ON","Describe the whole feature; the agent proposes phases","Approve or edit the plan, then let it run"]},
    commands:{title:"Commands / tool registry",summary:"ORscript exposes 630+ advertised Studio commands (plus hidden legacy aliases, workspace, template, roadmap and help tools) through an embedded catalogue in the system prompt, list_commands, search_commands and get_command.",details:["Since 1.33 roomy providers receive a compact command catalogue inside the system prompt (universal block + the active work mode's family as signatures, the rest as names), so the agent no longer starts every session with list_commands; tight-composer providers (Notion, ClickUp, Vani, CodeCraft, NVIDIA) still get the catalogue as the first tool result.","list_commands returns the catalogue for the active work mode: a UNIVERSAL block (42 inspection/scripting/verification commands present in every mode, including inspect_service and query_instances) followed by the mode family.","search_commands {query} finds commands by name/description; get_command {name} returns the full schema; command_registry_stats summarises the registry.","Commands are executed through or-core (127.0.0.1:3000) - either the Studio MCP helper or the ORscript Studio plugin when it is connected."],howTo:["Ask: 'list commands' or 'what can you do with lights'","The agent calls list_commands / search_commands and picks the right command"]},
    studio:{title:"Roblox Studio connection",summary:"The browser extension talks to the or-core desktop agent on 127.0.0.1:3000, which bridges to Studio through the Studio MCP helper and the optional ORscript Studio plugin.",details:["Run or-core (agent/ crate, cargo build) once; it stays in the background and auto-installs plugin/ORscript.lua into the Studio Plugins folder.","In Studio: Plugins → ORscript panel → enable; click Allow on the HTTP prompt. The plugin runs execute_luau with plugin-level APIs and adds csg_*, open_script, script_live_update, studio_undo/redo, screenshot_frame, gamepass_handler_create…","or_status / studio_plugin_status report the connection; or_screenshot captures the Studio window through the MCP screen_capture tool."],howTo:["Start or-core","Open the place in Studio and enable the ORscript plugin","Check the status pill in the OR bar is green, then chat"]},
    workmode:{title:"Work modes",summary:"Ultimate (default: Luau engineering + modeling), Visualizer (VFX/UI/lighting) and Animator (rigs, keyframes, animation suite) change the catalogue order, mandates and skills the agent leans on.",details:["Switch in the OR menu → Work mode. Every mode keeps the same UNIVERSAL command block, then prioritises its own family.","Since 1.34 each mode is a distinct profile on a shared OPERATING LOOP (assess → read before you write → execute continuously with batches of up to 6 commands → approval only for risk → verify deeply → recover → finish with evidence): Ultimate = Luau engineering + modeling mandates, blueprints, project index; Visualizer = read the scene → mood → layered VFX → UI as a system → prove it with pixels; Animator = read the rig → block keys → polish curves → runtime motion → camera beats → preview.","Switching mid-session sends the AI a short MODE SWITCH note (the new profile + that mode's focus commands) instead of the whole system prompt; the periodic reminder carries a one-line mode checklist.","Each mode card has Quick starts: one-click prompts (index this place, shop + currency, cinematic mood, hero spell VFX, sword swing, cutscene camera …) pasted into the composer for you to edit and send."],howTo:["OR menu → Work mode → pick Ultimate / Visualizer / Animator","Click a Quick start pill under the mode cards, adjust the text, press Enter"]},
    projects:{title:"Roblox project references",summary:"Analyze a .rbxl/.rbxlx on your PC (nothing is uploaded) and attach a compact, searchable index to a template so the agent knows the real place structure.",details:["Templates → Roblox project (toolbar) or the Project tab inside the editor: drop the file, watch progress, cancel any time.","Binary .rbxl gives metadata only (ATTACHED_LIMITED); save as .rbxlx in Studio for a full index of services, scripts, UI and remotes.","The agent queries it in bounded chunks with project.find / project.findScripts / project.getService; Export Reference writes a .orscript-project-reference.json you can re-import."],howTo:["OR menu → Templates → Roblox project","Pick the .rbxlx, review the summary","Create Template from Project or Save"]},
    themes:{title:"Themes & appearance",summary:"16 themes with CSS backgrounds, swatch previews, per-theme corner decorations, gradient pill buttons and optional sound effects - applied to the ORscript UI only, never to the host site.",details:["OR menu → Theme. Each theme ships its own background, accent tokens (--orx-*), decorations and SFX set.","Sounds and decorations can be toggled independently in Settings.","VoidScript is OrScript's partner visual identity used by the Void theme family."],howTo:["OR menu → Theme → pick a swatch"]},
    permissions:{title:"Permissions",summary:"Sandbox (Studio + workspace only, no prompts), Ask (confirm writes, publishes and PC access with an approval card) or Full (entire PC via or-core).",details:["Sandbox is the default and never asks - ideal for Studio-only work.","Ask shows an approval card above the page for execute_luau, file writes, publishes and marketplace changes; it auto-denies after 120 s so a hidden card cannot stall the agent.","Full unlocks PC-wide file/terminal tools (OR_FULL_ACCESS in or-core). Publish/marketplace automation additionally requires the 'Allow publish automation' switch."],howTo:["OR menu → Permissions → Sandbox / Ask / Full"]},
    providers:{title:"Chat providers",summary:"ORscript runs inside ChatGPT, Claude, Gemini, DeepSeek, Qwen, Kimi, GLM, Meta, NVIDIA, Arena, Notion, Vani, ClickUp Brain, Crax, OxAlpha, MultiChat and CodeCraft API - same commands everywhere, the bar adapts to each composer.",details:["ClickUp Brain (app.clickup.com) is the AI inside the ClickUp workspace: open Brain (sidebar AI / Ask AI) so its message box is visible - ORscript attaches to that box only, never to task, comment or Doc editors - then press Start. Brain gets the compact catalogue and is told to answer in chat only (no ClickUp task/doc actions).","CodeCraft API (codecraftapi.com) has no web chat, so ORscript hosts one: popup → CodeCraft API chat, paste your own cc_ key, pick a model; replies stream straight from the API and every token is billed to that key.","Compact composers (Notion, Vani, ClickUp Brain, CodeCraft) receive a shorter catalogue with signatures instead of full schemas; the agent can still call get_command for details.","Notion and Vani guest mode are text-only, so screenshots are described in text instead of attached as images.","Switch sites freely: work mode, permissions, theme and templates are stored in the extension, not the site."],howTo:["Open any supported chat site - the OR bar appears above the composer"]},
    plugins:{title:"Other plugins & full Studio control",summary:"Since 1.24.0 the ORscript Studio plugin controls everything a plugin may touch (run/pause/stop, settings(), selection, camera, script editor tabs, history, any service method, toolbar macros, Save-to-Roblox, TestService, Output) and talks to other plugins - including Eclipse Animator.",details:["studio_service_call {service, method|property, args|value} reaches any Studio API with plugin security; studio_macro creates persistent toolbar buttons that run Luau; studio_playtest runs/pauses/stops the simulation.","plugins_list discovers installed plugins (widgets, save folders, PluginDebugService, shared/_G APIs) and commands other plugins registered on the ORscript bus (shared.ORscript.register / CoreGui.ORscriptBus). plugin_invoke calls them, plugin_widget shows/hides/reads their panels, plugin_source_read reads their code when Plugin Debugging is enabled.","Studio never lets one plugin press another plugin's buttons - ORscript reports the exact button and asks the user, or drives the plugin through its saves/exports.","Eclipse Animator: eclipse_status detects it, eclipse_handoff sends an ORscript clip to <rig>.AnimSaves and opens Eclipse, eclipse_import converts Eclipse saves / Module Exporter tables back into AnimLib KeyframeSequences, eclipse_play previews any clip in edit mode."],howTo:["Make sure or-core and the ORscript Studio plugin are connected (studio_plugin_status)","Ask e.g. 'open Eclipse on this rig', 'list my plugins', 'add a toolbar button that aligns the selection'"]},
    troubleshooting:{title:"Troubleshooting",summary:"Most stalls are a disconnected or-core/Studio, a pending approval card, or a provider that reformatted the command block.",details:["Red status pill: start or-core, then check Studio → Plugins → ORscript is enabled and the MCP helper is running (or_status shows both).","Agent waiting: look for the approval card (Ask mode) or switch Permissions to Sandbox; cards auto-deny after 120 s.","'Failed to parse command code': the site added code-block chrome; 1.23.1 strips it automatically - update if you still see it.","Use or_debug for the Studio Output log, restart_mcp from the OR menu to heal the MCP helper, and reload the tab after updating the extension."],howTo:["Check or_status","Reload the chat tab","Restart or-core / Studio if the plugin shows disconnected"]},
    tasklist:{title:"Task list",summary:"A persistent per-project checklist (Settings → Task list → Enable). You or the AI add tasks; the AI works them in order with task_next and ticks them with task_update only after verifying; the bar shows a progress pill.",details:["Enable/disable it in the OR menu (Settings) under Modes: 'Task list'. When disabled nothing is shown to the AI and the Tasks tab is hidden; tasks stay saved (chrome.storage key rsTaskList).","Tasks tab (cards panel): add one task per Enter or paste a whole list, drag order with ↑/↓, tick/skip, inline-edit the text, Run (one task) / Run next / Run all with AI, Plan with AI (the agent proposes 4-12 verifiable steps via task_add), Export/Import JSON or plain lines.","Agent commands while enabled: task_list, task_next (marks it doing), task_add {text}, task_update {id|'#n', status: todo|doing|done|skipped, notes}. The SYSTEM_STATE line carries TASKS done/total and the next task; the system prompt carries the full list and the rules."],howTo:["OR menu → Modes → Task list → on","Cards panel → Tasks → type tasks or Plan with AI","Press Run next / Run all, or just tell the AI 'do the next task'"]},
    publicskills:{title:"Public Skills",summary:"User-made skills, abilities and work modes. Three ways in: describe one in a sentence (AI designs it), paste a FULL PROMPT you already wrote or drop a .txt (it becomes a skill as-is - with AI or instantly without), or import a .txt / .json / share code. Installed items become real commands or selectable work modes.",details:["Open the cards panel → Public tab. Type what you want (for example 'a skill that places N lanterns along a path'), pick Auto/Skill/Ability/Mode and press Create with AI - the agent calls public_skill_create and the item is installed immediately.","Prompt → skill: paste a whole prompt (any length) or drop a .txt on the tab. The button turns into 'Turn prompt into a skill (AI)': the agent converts it faithfully (keeps every rule, picks skill/ability/mode, adds params where variables are obvious). 'Save as-is (no AI)' installs it instantly, word-for-word, as an ability (or the kind you picked); the agent can do the same with public_skill_from_prompt {prompt}.","Plain-text format (.txt): '# Title', then 'kind: skill|ability|mode', 'description: ...', optional 'params: count:number=4 \"how many\"', 'tags:', 'base:', 'badge:', 'focus:', 'commands:' lines, then sections '--- luau ---', '--- instructions ---', '--- steps ---' or '--- mandate ---'. Export .txt writes this format; Import reads it (and .md / .json / ORSKILL1: codes).","Skill = parameterised Luau program executed in Studio through execute_luau (params are injected as Lua literals via {{param}} and as args.param). Ability = reusable procedure the agent follows with real commands. Mode = mandate + focus list layered on Ultimate / Visualizer / Animator, selectable in the OR menu Work mode section.","Everything stays on this device (chrome.storage.local, key rsPublicSkills). Sharing is file/code based: Export downloads <name>.<kind>.orskill.json, Share code copies an ORSKILL1: string; Import accepts either. There is no central marketplace.","Agent commands: public_skill_create/from_prompt/list/get/update/delete/enable/test/export/import. public_skill_test syntax-checks a skill's Luau in Studio before you rely on it."],howTo:["Cards panel → Public → describe → Create with AI","Paste a full prompt or drop a .txt → Turn prompt into a skill (AI), or Save as-is (no AI)","Call the new command by name, or pick the new mode in OR menu → Work mode","Public tab → Export / Share code to give it to someone; they press Import"]},
  };
  try { window.__rsFeatureHelpTopics = FEATURE_HELP_TOPICS; } catch {}
  const CREATOR_TOOLS=[
    {name:"creator.createGamePass",description:"Create a REAL game pass (same as gamepass_create: roblox.com browser session or or-core Open Cloud, then the server handler). Prefer gamepass_create.",inputSchema:{type:"object",required:["name"],properties:{name:{type:"string"},description:{type:"string"},price:{type:"integer"},universeId:{type:"integer"}}},server:"orscript"},
    {name:"creator.getGamePass",description:"Retrieve verified Roblox asset metadata for a game pass id.",inputSchema:{type:"object",required:["assetId"],properties:{assetId:{type:"integer"}}},server:"orscript"},
    {name:"creator.updateGamePass",description:"Update a game pass (same as gamepass_update {gamepass_id, name?, description?, price?, for_sale?}).",inputSchema:{type:"object",required:["assetId"],properties:{assetId:{type:"integer"},name:{type:"string"},description:{type:"string"},price:{type:"integer"}}},server:"orscript"},
    {name:"creator.publishAnimation",description:"Prepare a Studio animation publishing workflow. Studio ownership and user confirmation are required.",inputSchema:{type:"object",properties:{path:{type:"string"},name:{type:"string"}}},server:"orscript"},
    {name:"creator.getPublishedAsset",description:"Retrieve verified Roblox metadata for a published asset id.",inputSchema:{type:"object",required:["assetId"],properties:{assetId:{type:"integer"}}},server:"orscript"},
    {name:"creator.publishPlace",description:"Prepare the supported Studio Publish to Roblox workflow. Never publishes silently.",inputSchema:{type:"object",properties:{placeId:{type:"integer"}}},server:"orscript"},
    {name:"creator.getPublishStatus",description:"Inspect current Studio place identity and publication prerequisites.",inputSchema:{type:"object",properties:{}},server:"orscript"},
    {name:"creator.validatePublish",description:"Validate Studio connection, place identity, and requested publishing operation without publishing.",inputSchema:{type:"object",properties:{operation:{type:"string"},assetId:{type:"integer"}}},server:"orscript"},
  ];
  let roadmap = null;
  let roadmapEvents = [];
  let roadmapSeenEvents = new Set();
  let roadmapSaveTimer = null;
  const roadmapSubscribers = new Set();
  function roadmapId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`; }
  function roadmapTask(raw, phaseId, parentId, depth=0) {
    raw=raw&&typeof raw==="object"?raw:{}; const id=String(raw.id||roadmapId("task")).slice(0,80);
    const status=ROADMAP_STATES.has(raw.status||raw.state)?(raw.status||raw.state):"pending";
    return {id,title:String(raw.title||"Untitled task").slice(0,180),description:String(raw.description||"").slice(0,600),status,phaseId,parentTaskId:parentId||"",dependsOn:(Array.isArray(raw.dependsOn)?raw.dependsOn:raw.dependencies||[]).map(String).slice(0,30),startedAt:Number(raw.startedAt)||null,completedAt:Number(raw.completedAt)||null,error:String(raw.error||"").slice(0,1000),result:String(raw.result||raw.verification||"").slice(0,1000),agentActivity:Array.isArray(raw.agentActivity)?raw.agentActivity.slice(-50):[],updatedAt:Number(raw.updatedAt)||0,_lastEventAt:Number(raw._lastEventAt)||0,subtasks:depth<20&&Array.isArray(raw.subtasks)?raw.subtasks.slice(0,50).map((x)=>roadmapTask(x,phaseId,id,depth+1)):[]};
  }
  function roadmapPhase(raw) { raw=raw&&typeof raw==="object"?raw:{}; const id=String(raw.id||roadmapId("phase")).slice(0,80); return {id,title:String(raw.title||"Untitled phase").slice(0,180),description:String(raw.description||"").slice(0,500),status:ROADMAP_STATES.has(raw.status)?raw.status:"pending",collapsed:!!raw.collapsed,updatedAt:Number(raw.updatedAt)||0,_lastEventAt:Number(raw._lastEventAt)||0,tasks:Array.isArray(raw.tasks)?raw.tasks.slice(0,100).map((x)=>roadmapTask(x,id,"")):[]}; }
  function roadmapAllTasks(state=roadmap) { const out=[]; const walk=(xs)=>xs.forEach((t)=>{out.push(t);walk(t.subtasks||[])}); if(state)state.phases.forEach((p)=>walk(p.tasks)); return out; }
  function roadmapFind(id) { return roadmapAllTasks().find((t)=>t.id===String(id||"")); }
  function calculateRoadmapProgress(state=roadmap) { const tasks=roadmapAllTasks(state); if(!tasks.length)return 0; const done=tasks.filter((t)=>t.status==="completed"||t.status==="skipped").length; return Math.round(done/tasks.length*100); }
  function normalizeRoadmap(raw) {
    if(!raw||typeof raw!=="object"||!Array.isArray(raw.phases))return null;
    const state={id:String(raw.id||roadmapId("roadmap")).slice(0,80),title:String(raw.title||"Implementation roadmap").slice(0,200),description:String(raw.description||"").slice(0,1000),status:ROADMAP_STATES.has(raw.status)?raw.status:"pending",createdAt:Number(raw.createdAt)||Date.now(),updatedAt:Number(raw.updatedAt)||Date.now(),currentTaskId:raw.currentTaskId?String(raw.currentTaskId):null,progress:0,lastAgentActivity:raw.lastAgentActivity||null,_lastEventAt:Number(raw._lastEventAt)||0,phases:raw.phases.slice(0,30).map(roadmapPhase)};
    const ids=new Set(),phaseIds=new Set();for(const phase of state.phases){if(!phase.id||phaseIds.has(phase.id))return null;phaseIds.add(phase.id);}for(const task of roadmapAllTasks(state)){if(!task.id||ids.has(task.id))return null;ids.add(task.id);}if(state.currentTaskId&&!ids.has(state.currentTaskId))state.currentTaskId=null;state.progress=calculateRoadmapProgress(state); return state;
  }
  function notifyRoadmap() { for(const fn of roadmapSubscribers)try{fn(roadmap)}catch{} try{window.dispatchEvent(new CustomEvent("or-roadmap-change",{detail:roadmap}));}catch{} }
  function subscribeRoadmap(fn) { roadmapSubscribers.add(fn); return ()=>roadmapSubscribers.delete(fn); }
  function saveRoadmap() { if(roadmapSaveTimer)clearTimeout(roadmapSaveTimer); roadmapSaveTimer=setTimeout(()=>{try{chrome.storage.local.set({[ROADMAP_KEY]:{roadmap,events:roadmapEvents.slice(-500)}})}catch{}},100); notifyRoadmap(); }
  function eventIsOld(target,event) { return !!(target&&target._lastEventAt&&event.timestamp<target._lastEventAt); }
  function setEventTime(target,event) { if(target){target._lastEventAt=Math.max(target._lastEventAt||0,event.timestamp);target.updatedAt=Math.max(target.updatedAt||0,event.timestamp);} }
  function recomputeRoadmap(event) { if(!roadmap)return; roadmap.progress=calculateRoadmapProgress(); roadmap.updatedAt=Math.max(roadmap.updatedAt||0,event.timestamp); const tasks=roadmapAllTasks(); const explicitRoadmap=/^roadmap\.(completed|failed)$/.test(event.type); if(!explicitRoadmap){if(roadmap.progress===100&&tasks.length){roadmap.status="completed";roadmap.currentTaskId=null;}else if(tasks.some((t)=>t.status==="failed"))roadmap.status="failed";else if(tasks.some((t)=>t.status==="in_progress"))roadmap.status="in_progress";else if(roadmap.status==="completed"||roadmap.status==="failed")roadmap.status="pending";} roadmap.phases.forEach((p)=>{if(event.type.startsWith("phase.")&&event.phaseId===p.id)return;const ts=tasks.filter((t)=>t.phaseId===p.id);p.status=ts.length&&ts.every((t)=>t.status==="completed"||t.status==="skipped")?"completed":ts.some((t)=>t.status==="in_progress")?"in_progress":ts.some((t)=>t.status==="failed")?"failed":ts.some((t)=>t.status==="blocked")?"blocked":"pending";}); }
  /** Deterministic, idempotent RoadmapEvent reducer. */
  function reduceRoadmapEvent(event,{replay=false}={}) {
    if(!event||typeof event!=="object"||!event.id||!ROADMAP_EVENT_TYPES.has(event.type)||!Number.isFinite(event.timestamp))return {ok:false,error:"invalid or unknown event"};
    if(roadmapSeenEvents.has(event.id))return {ok:true,duplicate:true};
    const data=event.data&&typeof event.data==="object"?event.data:{};
    if(event.type==="roadmap.created") { if(roadmap&&eventIsOld(roadmap,event))return {ok:true,stale:true}; roadmap=normalizeRoadmap({...data,id:event.roadmapId||data.id,createdAt:event.timestamp,updatedAt:event.timestamp}); if(!roadmap)return {ok:false,error:"roadmap.created requires phases"}; }
    else {
      if(!roadmap||event.roadmapId!==roadmap.id)return {ok:false,error:"unknown roadmap id"};
      if(event.type.startsWith("roadmap.")){if(eventIsOld(roadmap,event))return {ok:true,stale:true};if(event.type==="roadmap.updated"){if(data.title)roadmap.title=String(data.title).slice(0,200);if(data.description!==undefined)roadmap.description=String(data.description).slice(0,1000);}if(event.type==="roadmap.completed")roadmap.status="completed";if(event.type==="roadmap.failed")roadmap.status="failed";setEventTime(roadmap,event);}
      else if(event.type.startsWith("phase.")){const phase=roadmap.phases.find((p)=>p.id===event.phaseId);if(!phase)return {ok:false,error:"unknown phase id"};if(eventIsOld(phase,event))return {ok:true,stale:true};phase.status=event.type==="phase.started"?"in_progress":"completed";setEventTime(phase,event);}
      else if(event.type==="task.created"){const phase=roadmap.phases.find((p)=>p.id===event.phaseId);if(!phase)return {ok:false,error:"unknown phase id"};if(roadmapFind(event.taskId||data.id))return {ok:true,duplicate:true};const parent=data.parentTaskId&&roadmapFind(data.parentTaskId);if(data.parentTaskId&&!parent)return {ok:false,error:"unknown parent task id"};if(parent&&parent.phaseId!==phase.id)return {ok:false,error:"parent task belongs to another phase"};const task=roadmapTask({...data,id:event.taskId||data.id},phase.id,parent&&parent.id);(parent?parent.subtasks:phase.tasks).push(task);}
      else {const task=roadmapFind(event.taskId);if(!task)return {ok:false,error:"unknown task id"};if(eventIsOld(task,event))return {ok:true,stale:true};const activity={id:event.id,type:event.type,timestamp:event.timestamp,message:String(data.message||data.detail||data.tool||"").slice(0,500)};if(event.type==="task.started"){roadmapAllTasks().forEach((t)=>{if(t!==task&&t.status==="in_progress")t.status="pending"});task.status="in_progress";task.startedAt=task.startedAt||event.timestamp;roadmap.currentTaskId=task.id;}else if(event.type==="task.completed"){task.status="completed";task.completedAt=event.timestamp;task.result=String(data.result||data.verification||"").slice(0,1000);task.error="";if(roadmap.currentTaskId===task.id)roadmap.currentTaskId=null;}else if(event.type==="task.failed"){task.status="failed";task.error=String(data.error||data.message||"Task failed").slice(0,1000);if(roadmap.currentTaskId===task.id)roadmap.currentTaskId=null;}else if(event.type==="task.blocked"){task.status="blocked";task.error=String(data.reason||data.error||"Blocked").slice(0,1000);if(roadmap.currentTaskId===task.id)roadmap.currentTaskId=null;}else if(event.type==="task.skipped"){task.status="skipped";task.result=String(data.reason||data.result||"").slice(0,1000);task.completedAt=event.timestamp;if(roadmap.currentTaskId===task.id)roadmap.currentTaskId=null;}else if(event.type==="task.updated"){if(data.title)task.title=String(data.title).slice(0,180);if(data.description!==undefined)task.description=String(data.description).slice(0,600);if(ROADMAP_STATES.has(data.status))task.status=data.status;if(data.detail)activity.message=String(data.detail).slice(0,500);}task.agentActivity.push(activity);if(task.agentActivity.length>50)task.agentActivity.shift();roadmap.lastAgentActivity=activity;setEventTime(task,event);}
    }
    roadmapSeenEvents.add(event.id); if(!replay){roadmapEvents.push(event);if(roadmapEvents.length>500)roadmapEvents.shift();} recomputeRoadmap(event); if(!replay)saveRoadmap(); return {ok:true};
  }
  function emitRoadmapEvent(type,ids={},data={}) { const event={id:roadmapId("event"),type,timestamp:Date.now(),roadmapId:ids.roadmapId||(roadmap&&roadmap.id)||"",data};if(ids.phaseId)event.phaseId=ids.phaseId;if(ids.taskId)event.taskId=ids.taskId;return {event,result:reduceRoadmapEvent(event)}; }
  try { window.__orRoadmapEvents={getState:()=>roadmap?JSON.parse(JSON.stringify(roadmap)):null,dispatch:(event)=>reduceRoadmapEvent(event),subscribe:subscribeRoadmap,eventTypes:[...ROADMAP_EVENT_TYPES]}; } catch {}
  try { chrome.storage.local.get([ROADMAP_KEY,ROADMAP_LEGACY_KEY],(r)=>{const stored=r&&r[ROADMAP_KEY];if(stored){roadmapEvents=Array.isArray(stored.events)?stored.events.slice(-500):[];roadmap=normalizeRoadmap(stored.roadmap);if(!roadmap&&roadmapEvents.length){roadmapSeenEvents.clear();for(const event of roadmapEvents)reduceRoadmapEvent(event,{replay:true});}roadmapSeenEvents=new Set(roadmapEvents.map((e)=>e&&e.id).filter(Boolean));}else roadmap=normalizeRoadmap(r&&r[ROADMAP_LEGACY_KEY]);notifyRoadmap();}); } catch {}
  function roadmapResult(ok,text){return `${ok?"Output":"ERROR"} of roadmap: ${text}`;}
  function dispatchRoadmapTool(name,args={}) {
    try {
      if(name==="roadmap_create"){const id=String(args.id||roadmapId("roadmap"));const {result}=emitRoadmapEvent("roadmap.created",{roadmapId:id},{...args,id,status:"pending"});return roadmapResult(result.ok,result.ok?`Created "${roadmap.title}" with ${roadmapAllTasks().length} tasks.`:result.error);}
      if(!roadmap)return roadmapResult(false,"no roadmap exists. Call roadmap_create first.");
      if(name==="roadmap_update_project"){const {result}=emitRoadmapEvent("roadmap.updated",{},args);return roadmapResult(result.ok,result.ok?"Project updated.":result.error);}
      if(name==="roadmap_add_task"){const phase=roadmap.phases.find((p)=>p.id===String(args.phase_id));if(!phase)return roadmapResult(false,"unknown phase id");const id=String(args.id||roadmapId("task"));const {result}=emitRoadmapEvent("task.created",{phaseId:phase.id,taskId:id},{...args,id,parentTaskId:args.parent_task_id,dependsOn:args.dependencies});return roadmapResult(result.ok,result.ok?`Added task '${id}'.`:result.error);}
      if(name==="roadmap_update_task"){const task=roadmapFind(args.task_id);if(!task)return roadmapResult(false,"unknown task id");const state=String(args.state||"");if(!ROADMAP_STATES.has(state))return roadmapResult(false,"invalid state");const unmet=task.dependsOn.filter((id)=>{const d=roadmapFind(id);return !d||d.status!=="completed";});if((state==="in_progress"||state==="completed")&&unmet.length)return roadmapResult(false,`dependencies are not completed: ${unmet.join(", ")}`);if(state==="completed"&&!String(args.verification||args.result||"").trim())return roadmapResult(false,"completed requires a real verification result");const types={pending:"task.updated",in_progress:"task.started",completed:"task.completed",failed:"task.failed",blocked:"task.blocked",skipped:"task.skipped"};if(state==="completed")emitRoadmapEvent("validation.completed",{phaseId:task.phaseId,taskId:task.id},{message:args.verification});const {result}=emitRoadmapEvent(types[state],{phaseId:task.phaseId,taskId:task.id},{...args,status:state,result:args.result||args.verification,message:args.detail});return roadmapResult(result.ok,result.ok?`Task '${task.title}' is now ${state}.`:result.error);}
      return roadmapResult(false,"unknown roadmap operation");
    }catch(e){return roadmapResult(false,String(e&&e.message||e));}
  }
  function emitAgentRoadmapEvent(type,tool,detail) { if(!roadmap||String(tool).startsWith("roadmap_"))return;const task=roadmapFind(roadmap.currentTaskId);if(!task)return;emitRoadmapEvent(type,{phaseId:task.phaseId,taskId:task.id},{tool,message:String(detail||"").slice(0,500)}); }
  // Provider initialization is startup-critical. Keep the failure so Start can
  // retry once and show a provider-specific reason instead of silently doing
  // nothing after an adapter exception.
  let providerInitError = null;
  let providerHooksReady = false;
  let providerHooksError = null;
  let providerInitialized=false;
  function initializeProvider() {
    if(providerInitialized&&!providerInitError)return true;
    A.lifecycle="INITIALIZING";
    try {
      if (!P || typeof P.init !== "function") throw new Error("provider adapter has no init() function");
      P.init({ diag, isStopped: () => A.stop, isSessionActive: () => !!(A.started || A.running), requestStart: () => startSession() });
      providerInitError = null;providerInitialized=true;A.lifecycle="READY";
      diag("provider.initReady", { provider:P.id,agent_init:Math.round(performance.now()-OR_BOOT_AT) });
      return true;
    } catch (e) {
      providerInitError = e instanceof Error ? e : new Error(String(e));providerInitialized=false;A.lifecycle="ERROR";
      diag("provider.initFailed", { provider: P && P.id, error: providerInitError.message });
      try { console.error(`[or] ${P && P.id || "unknown"} provider initialization failed`, providerInitError); } catch {}
      return false;
    }
  }
  initializeProvider();

  function startupTimeout(promise, ms, operation) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      // Poll quickly while visible; hidden tabs remain browser-throttled anyway.
      await sleep(document.hidden ? 120 : 55);
    }
    return false;
  }

  // v1.10 behavior was to park until the AI tab is the FOREGROUND tab again.
  // Users hated it ("I switch to another website and the AI just stops") - so
  // since v1.12 the loop keeps working in hidden tabs (background mode) and
  // this only parks when the user explicitly turned background mode OFF.
  // Still event-driven with no time cap: a tab minimized/backgrounded for an
  // hour must resume cleanly, not silently time out into a "could not send /
  // not run" failure. Returns false ONLY if the user stopped while we were
  // parked, so callers can break.
  async function waitVisible() {
    if (!document.hidden || A.stop) return !A.stop;
    if (bgMode) return true; // background mode: keep working on other sites
    A.parked = true;
    try { ui.setStarting(); } catch {}
    try {
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = () => { if (!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        // Safety net only: covers a stop click while parked, and the (unlikely)
        // case of a missed visibilitychange event.
        const iv = setInterval(() => { if (A.stop || !document.hidden) done(); }, 1000);
      });
    } finally {
      A.parked = false;
      try { ui.setStarting(); } catch {}
    }
    return !A.stop;
  }

  // Park while the tab is hidden and report how long we were parked, so callers
  // can slide their timers forward by that amount. Without this, every deadline
  // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
  // ticking while nothing can be read - which is what turned "user switched to
  // Studio for 5 minutes" into "No response from <site>, the loop has stopped"
  // and left the pending command showing a grey "not run".
  // Background mode (v1.12) returns 0 immediately: the tab keeps reading its
  // own DOM while hidden, so no deadline sliding is needed.
  async function parkHidden() {
    if (!document.hidden || A.stop) return 0;
    if (bgMode) return 0;
    const t0 = Date.now();
    await waitVisible();
    const parked = Date.now() - t0;
    diag("park.resumed", { parkedMs: parked });
    // Give the site a beat to repaint: a tab that was hidden has no layout, so
    // the first reads after unhide can come back stale/blank.
    if (!A.stop) await sleep(120);
    return parked;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ?  P.lastAssistantId() : undefined;
  }

  async function submitAndGetBase(text, images) {
    // ── Duplicate-submit suppression ──
    // The retry loop below can legitimately resend when a send clearly didn't
    // land — but two callers racing (double-click Start, restart during
    // bootstrap, watchdog + user) must NEVER fire the same prompt twice.
    const _sig = images
      ? "img:" + Date.now()
      : String(text).length + ":" + String(text).slice(0, 120) + ":" + String(text).slice(-60);
    if (!images && A._lastSubmit && A._lastSubmit.sig === _sig && Date.now() - A._lastSubmit.at < 2500) {
      diag("send.duplicateSuppressed", {});
      return P.assistantCount();
    }
    A._lastSubmit = { sig: _sig, at: Date.now() };

    const requestId=`chat-${Date.now().toString(36)}-${++A.requestSeq}`;A.activeRequestId=requestId;A.requestStartedAt=performance.now();
    captureSendToken();
    diag("request.started", {requestId});
    diag("send", { requestId,text: String(text).slice(0, 60), busy: P.isBusyNow() });
    A.injecting = true;
    A._injectingSince = Date.now(); // stale-injecting failsafe anchor (meter loop)
    ui.inputCover(true);
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      const _settleItem = P.lastAssistant();
      if(P.isGenerating()){
        const _settleLen0 = _settleItem ? P.streamLen(_settleItem) : 0;await sleep(120);
        if (_settleItem && _settleItem === P.lastAssistant() && P.streamLen(_settleItem)>_settleLen0)await waitFor(() => !P.isGenerating(),4000);
      }
      const base = P.assistantCount();
      const preUser = P.userCount();
      // Arm the optimistic pre-hide for the result turn we're about to inject:
      // the very next NEW user turn is ours, so preHideWholeItems can mask it on
      // creation instead of waiting for its "Output of '…'" caption to render
      // (which lands a tick after the node - especially with an attached image -
      // and would otherwise flash the raw output for the 200/700ms until a sweep
      // nudge catches it). See preHideWholeItems.
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      // "Landed" = a new turn appeared in the DOM. In long chats, list
      // virtualisation can keep counts flat even when our message landed - the
      // textarea-cleared signal below is the primary fast gate.
      const landed = () => P.userCount() > preUser || P.assistantCount() > base;
      // v1.10 rule was "never type/send while the tab is HIDDEN" - background
      // tabs throttle rendering, which made the landed-check unreliable and
      // duplicated sends. v1.12 background mode keeps sending in hidden tabs
      // (the worker ticker keeps the pacing honest and the tail-fingerprint
      // below is count-independent); without background mode we still park.
      let tries = 0;
      let messageSent = false;
      // Fingerprint of what we typed: if the composer no longer contains this
      // tail, the send DID land even when counts/textarea signals are flaky
      // (virtualised lists, slow clearing). Prevents blind resends.
      const sentTail = String(text).slice(-80);
      // Max ONE resend: with the tail-fingerprint above, a second attempt only
      // happens when our text is verifiably still sitting in the composer.
      while (!messageSent && !landed() && tries < 2 && !A.stop) {
        if (document.hidden && !bgMode) {
          diag("send.waitVisible", { tries });
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
        }
        await jitterBeforeSend();
        diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
        await P.typeAndSend(text, images);
        // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
        // was just clicked, so our result turn is about to render). The initial
        // arm above can EXPIRE during an image upload - typeAndSend blocks ~3-6s
        // uploading the capture before the turn appears, past the 2.5s window - so
        // without this re-arm the raw "Output of…" + a still-loading (0-byte)
        // thumbnail flash for image feedbacks until a sweep chip lands. Safe: the
        // input is covered and the loop owns this send, so no user turn can slip
        // into the window, and the pre-hide is one-shot (consumes the first turn).
        A.injectHideUntil = Date.now() + 2500;
        // The site clears the textarea as soon as the send is accepted - faster
        // and more reliable than waiting for a DOM turn count change. Also accept
        // "our text is no longer in the composer" as proof of landing.
        await waitFor(() => {
          const edNow = P.editorText().trim();
          if (edNow === "") messageSent = true;
          else if (edNow.length < sentTail.length || !edNow.includes(sentTail.slice(-40))) messageSent = true;
          return messageSent || landed();
        }, 3500);
        tries++;
      }
      if (messageSent) diag("send.cleared", { tries });
      // All retries exhausted with NO evidence the message landed (textarea never
      // cleared, no new turn). Silently returning here left the loop waiting for
      // a reply that will never come (~60s "empty" timeout) with zero explanation
      // - the reported "the tool result just never gets injected" symptom. Tell
      // the user what actually happened so they can nudge the conversation
      // themselves instead of watching a stuck bar.
      if (!messageSent && !landed() && !A.stop) {
        diag("send.failed", { tries });
        ui.banner("warn", "Message didn't send",
          `${P.displayName} wouldn't take the message after ${tries} tries. ` +
          `Just send something short yourself — like "continue" — and it'll pick back up.`);
        // Abort the caller's turn NOW (v1.12.1). Returning `base` here made the
        // watcher sit through warm-up + late-rescue + dead-retry (~2min) for a
        // reply that can never come, with the composer locked the whole time.
        throw new SendAbortedError("send did not land");
      }
      return base;
    } finally {
      // During Starting Up / the agent loop, the bootstrap or loop owns the cover
      // for the whole phase, so don't lift it here between an injection and the
      // next waitForResponse - it stays up until the loop / bootstrap ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
    // long with NO streaming AND no text change. lastActiveAt is refreshed every
    // tick the model is generating or the reply text grows, so an arbitrarily
    // LONG but still-active response never trips it (the old total-elapsed cap
    // wrongly fired "No response" while the model was still writing past 300s).
    const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
    let lastActiveAt = Date.now();
    const STABLE_MS = T.STABLE_MS; // generating-flag stuck ON but text frozen → done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
    // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
    // genOffFirstAt: the FIRST moment gen went false after streaming began (does
    // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
    // flipped back true after having been false - a high count means post-stop DOM
    // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
    // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
    // gen was (re)true. These pinpoint which gate causes any tail latency.
    let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
    let waitedBlock = 0, waitedFlicker = 0;
    const finalizeDiag = (kind) => {
      const now = Date.now();
      diag("stopGoneToResp", {
        kind,
        stopGoneToRespMs: genOffFirstAt ?  now - genOffFirstAt : null,
        genStableForMs: genFalseSince ?  now - genFalseSince : null,
        lastChangeAgoMs: now - lastChangeAt,
        genFlickers, waitedBlock, waitedFlicker,
        totalMs: now - t0, requestId:A.activeRequestId,
      });
    };
    let preStartSilent = 0; // nothing produced AND not generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
    // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
    // subtree (React/Monaco churn) and a read can come back "" for a frame at
    // the exact moment the watcher finalizes - the turn then ended as
    // kind:"empty" even though a (possibly cut-off) command was sitting there a
    // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
    // autoResume dedupe (zResume) blocks any later retry (validated live on a
    // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
    // declaring empty. Reset whenever the turn NODE changes so a new turn can
    // never inherit the previous turn's text.
    let lastGoodReply = "";
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    let lateRescue = false; // v1.12: one bounded late-reply look before declaring empty
    let unsettledSince = 0; // command-shaped reply whose read is not yet stable
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Upper bound on holding off a parse verdict while a provider reports its
    // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
    // read still resolves after this and is parsed as-is.
    const UNSETTLED_GRACE_MS = 8000;
    const PRESTART_MS = T.PRESTART_MS || 60000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached. Slow hosts override via timings.GEN_STOP_GRACE_MS.
    const GEN_STOP_GRACE_MS = T.GEN_STOP_GRACE_MS || 2500;
    const errorResult = (detail) => {
      const text = String(detail || "");
      const context = (P.isTooLongMsg && P.isTooLongMsg(text))
        || /context.{0,20}(?:limit|length|exceeded)|maximum.{0,15}tokens|conversation.{0,20}too long/i.test(text);
      return { kind: context ? "context_limit" : "provider_error", detail: text };
    };

    // v1.12.2: deadline sliding while hidden+bgMode (replaces the old
    // park-then-slide). Hidden tabs get throttled timers (>=1s, 1/min after
    // 5min) AND unreliable DOM reads (no layout), so we slide every deadline
    // forward by the hidden gap - capped at 30s per iteration so a turn can
    // still EVENTUALLY time out on its own instead of hanging forever while
    // the tab never gets foregrounded again.
    let lastHiddenCheck = Date.now();

    while (Date.now() - lastActiveAt < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      // NEVER let a deadline expire while the tab is in the background. A hidden
      // tab has no layout (innerText reads come back "", getBoundingClientRect is
      // 0x0) and Chrome throttles its timers, so every read here is unreliable -
      // and the site may legitimately keep streaming for as long as the user is
      // away in Studio. Park until the tab is foreground again (parking mode),
      // or slide the deadlines forward (background mode) so nothing that was
      // mid-flight when the user switched away expires the moment they come
      // back. This is the fix for "I switched to Studio, came back and the
      // command says 'not run'": the loop used to burn its 5-minute inactivity
      // budget off-screen, end with "No response from <site>", and orphan the
      // pending command.
      if (document.hidden && !A.stop && !bgMode) {
        const parked = await parkHidden();
        if (A.stop) return { kind: "stopped" };
        if (parked) {
          lastActiveAt += parked; lastChangeAt += parked;
          if (doneSince) doneSince += parked;
          if (genFalseSince) genFalseSince += parked;
          if (preStartSilent) preStartSilent += parked;
          if (warmSince) warmSince += parked;
          if (reasonSince) reasonSince += parked;
          if (noTurnSince) noTurnSince += parked;
          if (unsettledSince) unsettledSince += parked;
          if (genOffFirstAt) genOffFirstAt += parked;
        }
        continue; // re-read everything now that the tab has layout again
      }
      if (document.hidden && !A.stop && bgMode) {
        const now = Date.now();
        const gap = now - lastHiddenCheck;
        if (gap > 1200) { // only slide when the gap shows real throttling
          const slide = Math.min(gap - 1000, 30000);
          lastActiveAt += slide; lastChangeAt += slide;
          if (doneSince) doneSince += slide;
          if (genFalseSince) genFalseSince += slide;
          if (preStartSilent) preStartSilent += slide;
          if (warmSince) warmSince += slide;
          if (reasonSince) reasonSince += slide;
          if (noTurnSince) noTurnSince += slide;
          if (unsettledSince) unsettledSince += slide;
          if (genOffFirstAt) genOffFirstAt += slide;
        }
        lastHiddenCheck = Date.now();
        await sleep(300); // a beat between throttled reads; loop continues below
      } else {
        lastHiddenCheck = Date.now();
      }
      const gen = P.isGenerating();
      if (gen) lastActiveAt = Date.now(); // actively generating ⇒ never time out
      let d = P.readAssistant();
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // a provider's list virtualisation can keep assistantCount() <= base for a
      // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ?  P.lastAssistantId() : undefined;
      // A NULL token means the provider could not read an identity for the
      // CURRENT last turn (not that the provider lacks ids - that's undefined).
      // Treating null as "no new reply" wedged the watcher on Qwen: a
      // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
      // carry, so curTok stayed null, `started` never latched, and the loop
      // sat in the pre-start branch for the full 60s before ending "empty" -
      // the regenerated command (complete in the net tap) was never run and
      // zResume then blocked any retry (validated live via empty.why, 2026-07).
      // Fall back to the count test instead, exactly as for a provider with no
      // lastAssistantId at all.
      const newReply = (curTok !== undefined && curTok !== null)
        ? (curTok !== A.sendToken)
        : P.assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)){if(!sawContent){diag("response.firstDetected",{requestId:A.activeRequestId,ms:A.requestStartedAt?Math.round(performance.now()-A.requestStartedAt):null});try{ui.steeringProgress("waiting","Response streaming",0);}catch{}}sawContent = true;}
      if (d.reply && d.reply.length) lastGoodReply = d.reply;

      if (!started) {
        // CRITICAL: a bare count increase is NOT enough - the empty turn
        // CONTAINER can appear seconds before the first token. Require actual
        // CONTENT (or the generating flag).
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        if (gen || (newReply && hasText)) { started = true; }
        else {
          // Network taps can report an HTTP/model error without ever creating a
          // response turn. Surface that immediately instead of holding the input
          // lock until PRESTART_MS expires on a reply that cannot arrive.
          if (Date.now() - lastLimitScan > 1000) {
            lastLimitScan = Date.now();
            const earlyError = P.scanError();
            if (earlyError) return errorResult(earlyError);
          }
          // The site can be slow to even CREATE the reply turn. Keep waiting -
          // only give up after a bounded fully-silent window.
          if (!preStartSilent) preStartSilent = Date.now();
          // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
          // on Qwen kept ending "empty" with a complete command in the net tap,
          // and without the branch name the cause was unfindable from the log.
          if (Date.now() - preStartSilent > PRESTART_MS) { diag("empty.why", { branch: "preStart", rep: (d.reply||"").length }); return { kind: "empty" }; }
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag). Compare the
      // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
      // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
      // copy-bar text churn - don't count as real "changes" and keep resetting
      // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
      // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
      // reduce false changes, so short replies / other providers are unaffected.
      const replyNorm = (d.reply || "").replace(/\s+/g, " ").trim();
      if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); lastActiveAt = Date.now(); }
      // How long the generating flag has been OFF. A mid-stream flicker resets
      // this the instant growth resumes and gen flips back on.
      if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
      // DIAG: first gen-off, and count flickers back to true after a gen-off.
      if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if (prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = P.scanError();
        if (ctx) return errorResult(ctx);
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) so we never parse/finalize half a command.
      const blockActive = RSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
      // ...but once generation has clearly stopped (stop indicator gone past the
      // grace window), stop honoring an "open block" - it is DOM churn, not live
      // streaming. Lets a finished big block finalise in seconds instead of
      // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
      // live on Gemini after a mid-write halt) but the text has been frozen for
      // a while → stop waiting and finalize. This must BYPASS the gen branch
      // below entirely: falling through while gen stays true used to reset
      // doneSince every iteration, so the watcher never finalized at all.
      // ...but NEVER treat a still-OPEN command block as "done" while the site is
      // genuinely still generating. A model writing a big command (a 3799-char
      // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
      // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
      // here parsed the half-written JSON and stamped a false "bad JSON" error
      // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
      const stuckDone = started && d.reply && Date.now() - lastChangeAt > STABLE_MS &&
        !(gen && RSParse.hasOpenToolBlock(d.reply));
      if ((gen || effectiveBlock) && !stuckDone) {
        // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
        // so any wait here is tail latency: either gen flickered back on, or an
        // (effective) open-block reading is holding us.
        if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
        doneSince = 0;
        await sleep(160);
        continue;
      }
      if (stuckDone && gen) log("generating flag stuck - falling back to text stability");

      // On providers whose turn counts are RELIABLE (semantic elements, no
      // list virtualisation - Gemini), never finalize before the reply turn
      // for THIS send exists. The generating flag can flicker off in the gap
      // between the send and the new <model-response> node spawning, and the
      // watcher used to finalize on the PREVIOUS turn's stable text - a
      // premature loop.end rescued only by autoResume 30-45s later (diag
      // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
      // Bounded so a genuinely dead send still ends the turn.
      if (P.reliableCounts && !newReply) {
        if (!noTurnSince) noTurnSince = Date.now();
        // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
        // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
        // that decide it so we can see whether curTok is null (id missing on the new
        // turn -> count fallback) or equal to sendToken (last turn not advancing).
        const _waited = Date.now() - noTurnSince;
        if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
          A._noTurnLoggedAt = Date.now();
          diag("noTurnGrace.wait", {
            waitedMs: _waited,
            curTok: (P.lastAssistantId ?  P.lastAssistantId() : undefined),
            sendToken: A.sendToken,
            assistantCount: P.assistantCount ?  P.assistantCount() : undefined,
            base, gen, started, replyLen: (d.reply || "").length });
        }
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(100); continue; }
      } else {
        noTurnSince = 0;
        A._noTurnLoggedAt = 0;
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 280) {  // short settle – DOM is stable
        await sleep(70);
        continue;
      }

      // A turn that has produced NOTHING yet is still warming up - never
      // finalize it as empty/truncated/text (a premature retry interrupts it).
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(100); continue; }
        // Late-reply rescue (v1.12): unstable sites under load often render the
        // reply a beat AFTER the warm-up deadline. One bounded 12s look before
        // declaring the turn dead - cheap, and it turns "the model did nothing"
        // into a normal continuation on exactly the flaky providers.
        if (!lateRescue) {
          lateRescue = true;
          diag("empty.lateRescue", { waitedMs: Date.now() - warmSince });
          const rescueT0 = Date.now();
          while (Date.now() - rescueT0 < 12000 && !A.stop) {
            await sleep(120);
            const rd = P.readAssistant();
            if ((rd.reply && rd.reply.length) || (rd.thinking && rd.thinking.length)) {
              sawContent = true;
              d = rd;
              warmSince = 0;
              break;
            }
          }
          if (sawContent) continue;
        }
        diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize - wait for the reply, bounded. A manually-stopped turn is
      // exempt so a real stop still ends.
      const thinkingCommand = !!(P.commandsMayAppearInThinking && d.thinking &&
        !(d.reply && d.reply.trim()) && RSParse.hasToolSignature(d.thinking));
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) &&
          !thinkingCommand && !P.turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(100); continue; }
      } else {
        reasonSince = 0;
      }

      // Blank-read guard: if THIS read came back empty but the same turn had
      // real text a tick ago, classify that text - see lastGoodReply above.
      let r = d.reply;
      if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      // Some provider lanes put their actual final call in reasoning_content and
      // leave visible content empty. Execute only one unambiguous, catalogue-known
      // call; never expose or execute arbitrary hidden deliberation.
      if (thinkingCommand) {
        const hidden = [
          ...RSParse.parseToolCalls(d.thinking),
          ...(RSParse.parseAlternateToolCalls ? RSParse.parseAlternateToolCalls(d.thinking) : []),
        ];
        const unique = [];
        const seen = new Set();
        for (const call of hidden) {
          const sig = `${call && call.tool}\n${JSON.stringify(call && call.arguments || {})}`;
          if (call && call.tool && !seen.has(sig)) { seen.add(sig); unique.push(call); }
        }
        if (unique.length === 1 && knownTool(unique[0].tool)) {
          diag("tool.promotedFromThinking", { name: unique[0].tool });
          finalizeDiag("tool");
          return { kind: "tool", calls: unique, item: d.item };
        }
        return { kind: "parse_error", reason: unique.length > 1 ? "hiddenMulti" : "hiddenMalformed", raw: d.thinking, item: d.item };
      }
      // Hold off on any "unparseable command" verdict while the provider reports
      // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
      // case: its network tap flips `done` the instant the SSE ends, but the
      // candidate-1 DOM we parse can still be mid-render, so a real command looks
      // half-written for a beat. Firing parse_error there sends an ERROR
      // mid-generation and nags a model that did nothing wrong. Only guard when
      // the reply already LOOKS like a command (so a plain-text answer is never
      // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
      // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
      const cmdShaped = P.replyUnsettled && (
        RSParse.hasToolSignature(r) ||
        (RSParse.LUA_END_RE.test(r) && !RSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if (cmdShaped && P.replyUnsettled(d.item)) {
        if (!unsettledSince) unsettledSince = Date.now();
        if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(100); continue; }
      } else {
        unsettledSince = 0;
      }
      // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
      // composer from the DOM (validated live: getEditor() is null), so we can't
      // send the tool result until a candidate is picked - and the read reply is a
      // partial candidate, so a command there looks "cut off". Per the product rule
      // we use the FIRST candidate: wait for BOTH candidates to finish generating
      // (you can't select mid-stream), then auto-select Response 1. That collapses
      // the carousel to a normal turn - composer returns - and the normal parse/run
      // path below handles it. Never a parse_error here (the model didn't truncate).
      // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
      // stuck carousel, so this cannot hang.
      if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
        if (P.isGenerating()) { await sleep(100); continue; }   // both still writing
        if (P.resolveComparison && P.resolveComparison()) {
          diag("carousel.resolved");
          await sleep(120); continue;                            // let it collapse, re-read
        }
        await sleep(100); continue;                              // button not ready yet
      }
      // OpenAI-compatible models sometimes expose a native function envelope in
      // visible text even though OR requested {command, params}. Accept it only
      // when EVERY parsed name exists in the live catalogue; this catalogue gate
      // prevents ordinary prose JSON with a "name" field from ever executing.
      const alternateCalls = RSParse.parseAlternateToolCalls ? RSParse.parseAlternateToolCalls(r) : [];
      if (alternateCalls.length && alternateCalls.every((call) => knownTool(call.tool))) {
        diag("tool.alternateEnvelope", { names: alternateCalls.map((call) => call.tool) });
        finalizeDiag("tool");
        return { kind: "tool", calls: alternateCalls, item: d.item };
      }
      if (RSParse.hasToolSignature(r)) {
        const calls = RSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present. Native XML/DSML
        // is also explicit: once alternate parsing failed, treating it as prose
        // silently drops a real hidden tool call.
        if (r.includes(RSParse.START_M) || RSParse.LUA_START_RE.test(r) ||
            (RSParse.CMD_KEY_RE && RSParse.CMD_KEY_RE.test(r)) ||
            (RSParse.NATIVE_TOOL_RE && RSParse.NATIVE_TOOL_RE.test(r))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        // ...unless ONLY the trailing closers were lost (the model hit its
        // output limit with the payload complete - seen live on Qwen: a big
        // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
        // and runs it instead of burning a whole retry turn; it refuses any
        // cut that amputated real content (mid-string / deep deficit), which
        // still falls through to the parse_error feedback. Safe to run here:
        // generation has ended (the open-block branch above kept waiting
        // while it streamed).
        if (RSParse.hasOpenToolBlock(r)) {
          const saved = RSParse.salvageCutOff(r);
          if (saved) {
            diag("tool.salvaged", { name: saved.tool });
            finalizeDiag("tool");
            return { kind: "tool", calls: [saved], item: d.item };
          }
          return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
        }
        // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
        // to parse - typically an unescaped " inside a code/string param broke the
        // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
        // mid-code). Unlike execute_luau there is NO ###LUA### fallback, so the
        // command silently dropped and the loop finalized the turn as a plain-text
        // answer with no result and no error - a dead turn. Fire a parse_error so
        // the model can fix its JSON. GATED on a known command name so prose that
        // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
        // placeholder like "command_name") is NOT misread as a broken command and
        // looped on - only a real tool name means a genuine failed call.
        const nm = RSParse.toolNameFromText(r);
        if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
      }
      // Malformed execute_luau: the model wrote the ###END_LUA### closer but
      // FORGOT the ###LUA### opener, so hasToolSignature missed it and the block
      // never ran (seen on Gemini). Don't silently treat it as a final answer -
      // nudge a rewrite instead of leaving the user stuck on a dead turn.
      if (RSParse.LUA_END_RE.test(r) && !RSParse.LUA_START_RE.test(r) && !r.includes(RSParse.START_M)) {
        return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
      }
      // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
      // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
      // the required {"command":...,"params":...} envelope - it treated the tool as a
      // real callable function (seen on Gemini). Those argument keys never appear in a
      // normal prose answer, so nudge a rewrite rather than ending the turn silently.
      if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r)) {
        return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
      }
      // Malformed command, function-calling flavour: the model named a REAL tool
      // but under the WRONG KEY - {"toolName": "get_studio_state", "studio_id": …}
      // instead of {"command": …, "params": {…}}. It reads as a deliberate call,
      // yet hasToolSignature never fires (no "command" key, no markers) and the
      // argument keys are the tool's own, so neither guard above catches it: the
      // turn finalized as a plain-text answer and the loop ENDED with the user
      // watching a dead agent (seen live on ChatGPT, long session, 2026-08).
      // GATED on the value being a tool we actually have - same reasoning as the
      // toolNameFromText gate above, so prose that merely mentions a tool name in
      // some JSON example is never looped on.
      const wrongKey = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/.exec(r);
      if (wrongKey && !/"command"\s*:/.test(r)) {
        const wk = wrongKey[1];
        const hit = knownTool(wk);
        // Log the miss too: the gate depends on how the bridge ADVERTISES names
        // (they can be prefixed per server on a collision), so a silent no-match
        // is exactly the case that is impossible to diagnose after the fact.
        diag("cmd.wrongKey", { name: wk, known: hit, catalogue: A.toolNames.size });
        if (hit) return { kind: "parse_error", reason: "toolKey", raw: r, item: d.item };
      }
      // NOTE: a site "server busy / something went wrong" notice is deliberately
      // NOT special-cased. It falls through to kind:"text" below and simply ENDS
      // the loop as a final answer - no auto-retry. Retrying risked an infinite
      // re-answer loop when the model's OWN prose said "try again", and treating
      // busy as a normal terminal turn is cleaner: the user just re-sends if the
      // site actually hiccuped. (P.isBusyMsg stays on the provider interface,
      // unused by the core, in case a future flow wants it.)
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") { diag("empty.why", { branch: "finalBlank" }); return { kind: "empty" }; }
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local OR bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = (m) =>
    /Extension context invalidated|Receiving end does not exist|message port closed/i.test(m || "");

  function bg(msg) {
    return new Promise((resolve) => {
      const fail = (m) => resolve({
        ok: false,
        kind: isContextInvalidated(m) ? "stale-extension" : "disconnected",
        error: m,
      });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (e) {
        fail(String(e && e.message || e));
      }
    });
  }

  // 'subagent' is always blocked (long-running, hangs the loop). 'screen_capture'
  // is only blocked on providers whose underlying model can't see images
  // (P.supportsVision === false) - see src/providers/*.js for the per-site flag.
  // Both are filtered out of the advertised command list AND refused in runTool.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  // ── Work modes ────────────────────────────────────────────────────────
  // ultimate   = the flagship default: senior Luau engineer + 3D modeler.
  //              Pushes the whole script_*/execute_luau/instance_*/part_*/
  //              model_*/physics_*/terrain_*/build families, deep verification.
  // visualizer = VFX / lighting / UI specialist: pushes the whole fx_*, vfx_*,
  //              lighting_*, ui_* families and screenshot-verifies every pass.
  // animator   = animation specialist: animation_* editor pipeline, tweens,
  //              springs, IK, camera work, preview-verified.
  // `focus` picks the commands each specialist mode surfaces first in
  // list_commands; config.js layers the matching prompt on top of the
  // Ultimate workflow (which is also the base for the two specialists).
  const WORK_MODES = {
    ultimate: {
      name: "Ultimate", badge: "ULTIMATE", short: "Ultimate",
      sub: "Luau systems · Modeling · Architecture — production-grade, verified",
      note: "Flagship mode: senior Luau engineer and 3D modeler in one. Full scripting, instance, physics, build and terrain arsenal, continuous autonomy, deep verification.",
      toast: "Ultimate Work Mode — senior Luau engineer + modeler, full arsenal, every build verified",
      starters: [
        { label: "Index this place", prompt: "Build the project index for this place and give me the PROJECT MAP: folder layout, conventions, hubs, remotes and every mismatch. Then tell me the three riskiest problems you see and fix the first one." },
        { label: "Shop + currency", prompt: "Install a complete coins currency and shop system in this place (blueprints: currency + shop), with session-locked DataStore saving, leaderstats, a shop UI from the design pack and server-validated purchases. Verify it in Play and show me the console." },
        { label: "Build a house", prompt: "Build a two-storey medieval tavern at real scale in Workspace: blockout, walls with door and window openings, staircase, roof, interior props, a deliberate material palette (no default grey), everything grouped in a named Model hierarchy. Screenshot it from two angles and polish." },
        { label: "Fix my errors", prompt: "Start a playtest, read the console, and fix every error and warning you find at the cause (not the symptom). Re-run until the console is clean and report what you changed with full script paths." },
      ],
      focus: /^(script_|model_|memory_|blueprint_|project_index_|execute_luau|multi_edit|module_scaffold|remote_scaffold|datastore_profile_scaffold|tag_scaffold|project_health_report|search_game_tree|search_files|inspect_instance|get_studio_state|get_console_output|audit_(script_errors|unanchored_parts)|instance_|part_(create|at|above)|meshpart_create|wedge_create|model_group|(scale|rotate|mirror|flatten|raise|ungroup)_model|set_primary_part|pivot_(set|to)|cframe_set|rotation_set|size_set|snap_(position|to_grid)|grid_clone|duplicate_n|weld_(assemble|constraint)|constraint_create|constraints_clear|rigid_constraint_create|hinge_create|rope_create|attachment_create|align_(position|orientation)_create|material_set|color_set|brickcolor_set|transparency_set|reflectance_set|texture_add|decal_(add|set)|mesh_set_texture|generate_(mesh|material|procedural_model)|terrain_|staircase_generate|archway_generate|roof_structure_build|fence_line_build|road_path_build|bridge_suspension_make|window_glass_install|tree_forest_scatter|dungeon_room_generate|ground_make|water_body|folder_create|attribute_(get|set)|tag_(add|remove)|remote_|bindable_|datastore_setup|ds_|leaderstats_|collision_(set|group_set)|physics_|anchored_set|get_(children|descendants|property|service|template)|set_property|property_copy|selection_(info|set)|script_analysis|or_debug|or_screenshot|start_stop_play|place_backup_save|workspace_(stats|list|export|import))/,
    },
    visualizer: {
      name: "Visualizer", badge: "VISUALIZER", short: "Visualizer",
      sub: "VFX · Lighting · UI — layered, cinematic, screenshot-verified",
      note: "VFX, lighting and UI specialist on top of Ultimate: mood, layered effects, design-system UI, screenshot-verified polish.",
      toast: "Visualizer Work Mode — full VFX, lighting and UI arsenal, screenshot-verified",
      starters: [
        { label: "Cinematic mood", prompt: "Take a screenshot, then set a complete cinematic mood for this scene: lighting preset, atmosphere, sky, bloom, color correction and a post-FX stack. Screenshot again, judge it as an art director and run one polish pass." },
        { label: "Hero spell VFX", prompt: "Create a layered fire-magic cast effect on the selected part: core emitter, glow, sparks, a magic circle, a point light with flicker and a sound layer, with proper Size/Transparency curves. Trigger it on touch and screenshot it mid-burst." },
        { label: "Game HUD", prompt: "Set design tokens (neon preset, my primary colour is #7C5CFF) and generate a responsive HUD with health bar, coins and a quest tracker, plus a main menu and a shop screen. Run ui_audit and the responsive check, then screenshot each screen." },
        { label: "Thumbnail", prompt: "Make a 1920x1080 cartoony thumbnail for my game: my avatar in a hero pose with a shocked face, a floating glowing sword prop, the title in three words, a NEW badge, then capture it." },
      ],
      focus: /^(fx_|design_|gfx_|vfx_|sfx_|ui_|gui_|lighting|light_|postfx_|atmosphere|sky_|bloom|blur|color_correction|fog_|film_|weather_|particle|beam|trail|highlight|fire_add|smoke_add|sparkles|point_light|spot_light|surface_light|explosion|shadows|cast_shadow|set_future_lighting|snowfall|volcanic|firefly|portal_vfx|screen_shake|toast_show|notification_toast|radial_menu|level_up_ui|loading_screen|performance_monitor_gui|surface_gui|billboard_gui|starter_gui|text_label|text_button|image_label|frame_create|texture_add|mesh_set_texture|directional_audio|or_screenshot)/,
    },
    animator: {
      name: "Animator", badge: "ANIMATOR", short: "Animator",
      sub: "Rigs · Keyframes · Tweens · Camera — motion-first, preview-verified",
      note: "Animation specialist on top of Ultimate: rigs, keyframes, easing, tweens, IK and camera beats, preview-verified.",
      toast: "Animator Work Mode — full animation editor, tween and camera arsenal, preview-verified",
      starters: [
        { label: "Sword swing", prompt: "Select the rig in my selection, read its joints, and create a 1.2 s sword swing with anticipation, a fast action beat, follow-through and a settle. Ease every key, add a hit marker, give it a camera FOV punch, preview it and screenshot the key poses." },
        { label: "Walk + idle loop", prompt: "Create a looping walk cycle (contact, down, passing, up) and a breathing idle with moving holds for the selected rig, with correct priorities. Preview both, fix foot sliding and loop seams, then export them to a folder ready for LoadAnimation." },
        { label: "Door + chest tweens", prompt: "Animate the selected door opening with a spring-like overshoot and the chest lid with anticipation, using tween sequences with deliberate easing, plus a small camera shake on impact. Preview them in Play." },
        { label: "Cutscene camera", prompt: "Build a 6 s intro cutscene camera track around the selected model: slow dolly in, a low hero angle, an eased orbit, FOV change on the reveal, then a reset to the player. Preview it and tell me the beats with timings." },
      ],
      focus: /^(animation_|anim_|tween|spring_|motor6d|rig_|ik_|character_emote|facial_animation|camera_|cutscene|walkspeed|or_screenshot)/,
    },
  };
  const WORK_MODE_IDS = Object.keys(WORK_MODES);
  const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "ultimate"); // fast/balanced/thorough/adaptive → ultimate
  // UNIVERSAL commands: the navigation / inspection / scripting / verification
  // core that EVERY work mode gets with full schemas, ahead of the mode's own
  // family. A Visualizer still has to find the part, an Animator still has to
  // read the rig, an Ultimate run still has to inspect before it writes - so
  // these are never pushed out of the catalogue by the focus family or by a
  // compact provider budget. (Exact catalogue names; unknown ones are skipped.)
  const UNIVERSAL_COMMANDS = [
    "list_commands", "get_studio_state", "selection_info", "search_game_tree", "instance_find", "instance_find_class",
    "find_first_child", "get_children", "get_descendants", "inspect_instance", "get_property", "set_property",
    "attribute_get", "attribute_set", "instance_new", "instance_rename", "instance_move", "instance_clone",
    "instance_destroy", "model_report", "instance_bounding_box", "part_create", "script_list", "script_read",
    "script_search", "script_grep", "script_create", "script_set_source", "script_replace", "script_insert",
    "multi_edit", "execute_luau", "get_console_output", "or_screenshot", "or_status", "or_debug", "get_template",
    "memory_read", "memory_add_fact", "workspace_stats", "inspect_service", "query_instances",
  ];
  const UNIVERSAL_SET = new Set(UNIVERSAL_COMMANDS);
  const isUniversalCommand = (name) => UNIVERSAL_SET.has(String(name || "").replace(/^[^.]*\./, ""));
  function workModeFocusNames(modeId, names) {
    const mode = WORK_MODES[modeId];
    if (!mode || !mode.focus) return [];
    // A custom (public) work mode adds its own focus names on top of its base.
    let customFocus = new Set();
    try { const pm = typeof window.__rsPublicMode === "function" ? window.__rsPublicMode() : null; if (pm && Array.isArray(pm.focus)) customFocus = new Set(pm.focus); } catch {}
    return [...new Set(names.filter((n) => n && (mode.focus.test(String(n).replace(/^[^.]*\./, "")) || customFocus.has(String(n).replace(/^[^.]*\./, "")) || isUniversalCommand(n))))].sort();
  }
  const ALWAYS_BLOCKED_TOOLS = new Set([]);
  const VISION_TOOLS = new Set(["screen_capture"]);
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  // The ONLY sanctioned way to read the active engine outside build()'s closure.
  // Returns exactly "roblox" | "local". Legacy "anim" storage maps onto Roblox
  // (animation tools + Motion tab live on RS now).
  const activeEngine = () => {
    try {
      const v = typeof window.__rsEngine === "function" ? window.__rsEngine() : null;
      return v === "local" ? "local" : "roblox";
    } catch { return "roblox"; }
  };
  // Ground-truth environment line appended to EVERY AgentScript tool result.
  // Long creative tasks wipe tool awareness out of a chat model's active
  // memory ("context decay") - this tag survives because it rides inside each
  // result, so the model can never claim the local engine is gone.
  function asStateTag() {
    try {
      const local = activeEngine() === "local";
      const eng = local ? "AGENTSCRIPT" : "ROBLOXSCRIPT";
      const n = A.toolList.length || 0;
      const bridge = A.bridge || {};
      const connected = bridge.connected === true;
      let extra = "OFF", plan = "OFF", lvl = "default", wm = "ultimate", perm = "sandbox", dbg = "ON", multi = "OFF";
      try { if (window.__rsExtraThinking && window.__rsExtraThinking()) extra = "ON"; } catch {}
      try { if (window.__rsPlanMode && window.__rsPlanMode()) plan = "ON"; } catch {}
      try { if (window.__rsAutoDebug && window.__rsAutoDebug() === false) dbg = "OFF"; } catch {}
      try { if (window.__rsMultiAgent && window.__rsMultiAgent()) multi = "ON"; } catch {}
      try { if (multi === "ON" && typeof ORAgentCrew !== "undefined" && ORAgentCrew) multi = ORAgentCrew.stateTag(); } catch {}
      try { lvl = (window.__rsThinkingLevel && window.__rsThinkingLevel()) || "default"; } catch {}
      try { wm = (window.__rsWorkMode && window.__rsWorkMode()) || "ultimate"; } catch {}
      try { perm = (window.__rsPermMode && window.__rsPermMode()) || "sandbox"; } catch {}
      const blender = !!bridge.blender;
      // Browser↔or-core connectivity is not Studio connectivity. or-core can be
      // healthy and keep cached schemas while Roblox Studio is closed. Never tell
      // the model STUDIO LINKED from the generic bridge bit again.
      const studioLinked = connected && (
        bridge.roblox_connected === true ||
        (typeof bridge.roblox_connected !== "boolean" && bridge.studio === true)
      );
      let env = "";
      if (local) {
        const root = typeof bridge.local_root === "string" ? bridge.local_root : "";
        const full = bridge.local_full === true;
        env = ` | WORKSPACE ${root || "active"} | ${full ? "FULL PC" : "SANDBOX"}`;
      } else {
        env = studioLinked ? " | STUDIO LINKED" : " | STUDIO UNLINKED";
      }
      try { if (typeof ORTaskList !== "undefined") env += ORTaskList.stateTag(); } catch {}
      return `[SYSTEM_STATE: ENGINE=${eng} | WORK=${wm} | EXTRA=${extra} | PLAN=${plan} | DEBUG=${dbg} | MULTI=${multi} | THINK=${lvl} | PERM=${perm}${env} | BRIDGE ${connected ? "UP" : "DOWN"} | BLENDER ${blender ? "ON" : "OFF"} | TOOLS ${n}]\nMODE LOCK: stay on ${eng}. Obey WORK/EXTRA/PLAN/THINK/DEBUG/MULTI this turn. ONE command per reply.\n${(RS.FEEDBACK && RS.FEEDBACK.creationFocus) || ""}`;
    } catch { return ""; }
  }
  function currentEngineIsLive() {
    const bridge = A.bridge || {};
    if (activeEngine() === "local") {
      const local = Array.isArray(bridge.servers)
        ? bridge.servers.find((server) => server && server.id === "local")
        : null;
      return bridge.connected === true && (
        bridge.local_connected === true || !!(local && local.alive === true)
      );
    }
    const roblox = Array.isArray(bridge.servers)
      ? bridge.servers.find((server) => server && (server.id === "roblox" || server.id === "studio"))
      : null;
    return bridge.connected === true && (
      bridge.roblox_connected === true ||
      (typeof bridge.roblox_connected !== "boolean" && bridge.studio === true) ||
      (typeof bridge.roblox_connected !== "boolean" && typeof bridge.studio !== "boolean" && !!(roblox && roblox.alive === true))
    );
  }
  async function refreshCurrentEngineState() {
    if (activeEngine() === "local") return currentEngineIsLive();
    const live = await bg({ type: "studio_status" });
    if (live && typeof live.studio === "boolean") {
      const previous = A.bridge || {};
      const servers = (previous.servers || []).map((server) =>
        (server.id === "roblox" || server.id === "studio")
          ? Object.assign({}, server, { alive: live.studio === true })
          : server);
      A.bridge = Object.assign({}, previous, {
        roblox_connected: live.studio === true,
        studio: live.studio === true,
        servers,
      });
    }
    return currentEngineIsLive();
  }

  // Is `name` a tool we actually have? The bridge ADVERTISES names that may carry
  // a per-server prefix when two MCP servers expose the same tool (see
  // list_tools in bridge.py), while the model always writes the bare name - so a
  // plain `A.toolNames.has(bare)` misses, and so does bareToolName(bare), which
  // cannot re-add a prefix it never had. Compare bare-to-bare in BOTH directions.
  const bareKey = (n) => String(n || "").split("/").pop().split(".").pop();
  // Commands implemented by OR itself are deliberately absent from the MCP's
  // `list_tools` response. That used to make the catalogue gate reject a model's
  // native {name,arguments} envelope for the single most important bootstrap
  // call: list_commands. JSON {command,...} worked, but GLM/DeepSeek/MiMo native
  // tool syntax was rendered as inert text and some providers could never get their
  // catalogue. Keep this set aligned with runTool's local branches.
  const CORE_VIRTUAL_TOOLS = new Set([
    "list_commands", "list_tools", "list_mcp_servers",
    "or_screenshot", "screenshot", "or_capture",
    "or_debug", "debug_run", "debug_console",
    "or_agent", "multi_agent", "or_status", "status",
    "web_fetch", "web_search", "http_get", "skill",
    "get_template", "template", "list_templates", "get_templates",
    "capture_id", "developer_product_create", "developer_product_list",
    "devproduct_create", "devproduct_list", "search_commands", "get_command", "command_registry_stats", "generate_command_docs",
  ]);
  function knownTool(name) {
    if (!name) return false;
    const b = bareKey(name);
    if (CORE_VIRTUAL_TOOLS.has(b)) return true;
    if (typeof RSAnim !== "undefined" && b.startsWith("animation_")
        && RSAnim.ANIM_OPS.includes(b.slice("animation_".length))) return true;
    if (typeof RobloxScriptSkills !== "undefined" && RobloxScriptSkills.SKILL_OPS.includes(b)) return true;
    if (typeof AgentScriptSkills !== "undefined" && AgentScriptSkills.SKILL_OPS.includes(b)) return true;
    if (!A.toolNames.size) return false;
    if (A.toolNames.has(name) || A.toolNames.has(bareToolName(name))) return true;
    for (const t of A.toolNames) if (bareKey(t) === b) return true;
    return false;
  }
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    return false;
  };

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known Roblox vision tool (screen_capture) is themed "screen" by name via
  // RS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ rsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("rsImageTools", (r) => {
      if (r && Array.isArray(r.rsImageTools)) for (const n of r.rsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // How long a fetched catalogue stays good enough to reuse without a round trip.
  const TOOLS_TTL_MS = 30000;

  // Refresh the tool catalogue - but never pay for it twice in a row.
  //
  // DEGRADED MODE (Roblox Studio closed, running on an addon server like Blender)
  // is where this used to hurt: a list_tools whose Roblox half is dead blocks the
  // bridge until it gives up, and the extension waited the FULL background timeout
  // for it. The boot sequence calls this three times in a row - startSession(),
  // then the model's list_commands, then list_mcp_servers - so the user watched
  // ~a minute of dead air with the model's reply already finished on screen
  // ("the first commands take forever even though the model clearly stopped
  // writing"). A short TTL collapses those three calls into one, and the caller
  // keeps the catalogue it already has instead of stalling for a fresh one.
  // Auto-chunk execute_luau at ~24KB so Studio's parser never hits the ~64KB wall.
  // Each piece is still one JSON-RPC/NDJSON line on the wire (no multi-line payloads).
  const LUAU_CHUNK_MAX = 18000;
  function splitLuauChunks(code, max) {
    if (!code || code.length <= max) return null;
    const lines = code.split("\n"), chunks=[]; let buf="", quote=null, escaped=false, longLevel=null;
    const scan = (line) => {
      for (let i=0;i<line.length;i++) {
        const c=line[i], n=line[i+1];
        if (longLevel !== null) { const close="]"+"=".repeat(longLevel)+"]"; if(line.startsWith(close,i)){i+=close.length-1;longLevel=null;} continue; }
        if (quote) { if(escaped){escaped=false;continue;} if(c==="\\"){escaped=true;continue;} if(c===quote)quote=null; continue; }
        if (c==="-"&&n==="-") { if(line[i+2]==="["){ const m=line.slice(i+2).match(/^\[(=*)\[/); if(m){longLevel=m[1].length;i+=m[0].length+1;continue;} } break; }
        if ((c==='"'||c==="'")) { quote=c; continue; }
        if (c==="["){ const m=line.slice(i).match(/^\[(=*)\[/); if(m){longLevel=m[1].length;i+=m[0].length-1;} }
      }
    };
    for (const line of lines) {
      const next=buf?buf+"\n"+line:line;
      if(buf && next.length>max && !quote && longLevel===null){chunks.push(buf);buf=line;} else buf=next;
      scan(line);
    }
    if(buf)chunks.push(buf);
    // Never slice an oversized line/string: slicing source text can split a
    // Luau string and produce the misleading "Malformed string" bridge error.
    return chunks.length>1 ? chunks : null;
  }
  // Embed `s` as a Luau long-string. StudioMCP parses execute_luau as REAL Luau,
  // so JSONDecode(JSON.stringify(s)) used to blow up on quotes/newlines/] =] and
  // show "Failed to parse command code". A long-string needs no escaping.
  function luauLongStr(s) {
    let n = 0;
    while (String(s).includes("]" + "=".repeat(n) + "]")) n++;
    const eq = "=".repeat(n);
    // A newline right after [[ is ignored by Lua, so the payload is byte-exact.
    return "[" + eq + "[\n" + s + "]" + eq + "]";
  }
  function wrapLuauChunk(piece, i, n) {
    const lit = luauLongStr(piece);
    const nl = "\n";
    if (i === 0 && n > 1) {
      return [
        "local ss=game:GetService(\"ServerStorage\")",
        "local f=ss:FindFirstChild(\"_ORLuau\") or Instance.new(\"Folder\")",
        "f.Name=\"_ORLuau\"; f.Parent=ss",
        "local m=f:FindFirstChild(\"Buf\") or Instance.new(\"StringValue\")",
        "m.Name=\"Buf\"; m.Parent=f",
        "m.Value=" + lit,
        "return \"OR chunk 1/" + n + " stored (" + piece.length + " chars)\"",
      ].join(nl);
    }
    if (i < n - 1) {
      return [
        "local f=game:GetService(\"ServerStorage\"):FindFirstChild(\"_ORLuau\")",
        "local m=f and f:FindFirstChild(\"Buf\")",
        "if not m then error(\"OR chunk buffer missing\") end",
        "m.Value=m.Value.." + lit,
        "return \"OR chunk " + (i + 1) + "/" + n + " stored\"",
      ].join(nl);
    }
    return [
      "local ss=game:GetService(\"ServerStorage\")",
      "local f=ss:FindFirstChild(\"_ORLuau\")",
      "local m=f and f:FindFirstChild(\"Buf\")",
      "if not m then error(\"OR chunk buffer missing\") end",
      "m.Value=m.Value.." + lit,
      "local src=m.Value",
      "if f then f:Destroy() end",
      "local fn,err=loadstring(src)",
      "if not fn then error(\"chunked luau parse: \"..tostring(err)) end",
      "return fn()",
    ].join(nl);
  }

  function syncCommandRegistry() {
    const reg=typeof ORCommandRegistry!=="undefined"?ORCommandRegistry:null;if(!reg)return;
    const envFor=(tool)=>tool&&tool.server==="blender"?"BLENDER":tool&&tool.server==="web"?"WEB":tool&&tool.server==="orscript"?"GENERAL":activeEngine()==="local"?"GENERAL":"ROBLOX_STUDIO";
    for(const tool of A.toolList||[])reg.registerTool(tool,envFor(tool),{replace:true,virtual:tool.server==="orscript",executionMode:tool.executionMode,permissions:tool.permissions});
    const add=(items,environment)=>{for(const c of items||[]){if(!c||!c.name)continue;reg.register({id:c.name,name:c.name,description:c.description||"OrScript virtual command",category:c.category,parameters:c.inputSchema||c.parameters||{type:"object",properties:{}},environment,aliases:c.aliases||[],examples:c.examples||[],virtual:true},{replace:true});}};
    try{if(typeof RobloxScriptSkills!=="undefined")add(RobloxScriptSkills.SKILL_COMMANDS,"ROBLOX_STUDIO");}catch(e){diag("registry.skillsFailed",{error:String(e)});}
    try{if(typeof RSAnim!=="undefined"&&Array.isArray(RSAnim.ANIM_COMMANDS))add(RSAnim.ANIM_COMMANDS,"ROBLOX_STUDIO");}catch(e){diag("registry.animFailed",{error:String(e)});}
    try{if(typeof AgentScriptSkills!=="undefined")add(AgentScriptSkills.SKILL_COMMANDS,"GENERAL");}catch(e){diag("registry.agentSkillsFailed",{error:String(e)});}
  }

  async function hydrateCommandRegistry() {
    syncCommandRegistry();
    if(typeof ORCommandRegistry==="undefined")return;
    try{const r=await bg({type:"command_catalog"});if(r&&r.ok&&Array.isArray(r.commands))for(const tool of r.commands)ORCommandRegistry.registerTool(tool,r.environment||"BLENDER",{replace:true});}
    catch(e){diag("registry.catalogFailed",{error:String(e&&e.message||e)});}
  }

  async function ensureTools(force) {
    if (!force && A.toolList.length && Date.now() - A.toolsAt < TOOLS_TTL_MS) {
      diag("tools.cached", { age: Date.now() - A.toolsAt, n: A.toolList.length });
      return A.toolList;
    }
    const t0 = Date.now();
    // Bounded retry: right after a page load or an engine switch the bridge
    // WebSocket may still be handshaking, so a single list_tools can come back
    // empty and falsely fail the bootstrap. Poll until tools arrive or ~8s.
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await bg({ type: "list_tools" });
      // list_tools may legitimately return cached schemas while its live Studio
      // probe says false. Consume that probe synchronously; waiting for the
      // background status broadcast left a race where bootstrap advertised a
      // catalogue and stamped STUDIO LINKED after the editor had disconnected.
      if (r && typeof r.roblox_connected === "boolean") {
        A.bridge = Object.assign({}, A.bridge || {}, {
          roblox_connected: r.roblox_connected,
          studio: r.studio === true,
          servers: Array.isArray(r.servers) ? r.servers : ((A.bridge && A.bridge.servers) || []),
        });
      }
      if (r && r.tools && r.tools.length) break;
      // Engine-offline answers are AUTHORITATIVE (Studio closed etc.) — don't
      // spin on them; only transient empties (handshake races) are retried.
      if (r && r.ok === false && r.error && /offline|not connected|closed/i.test(r.error)) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    diag("tools.fetched", { ms: Date.now() - t0, n: (r && r.tools && r.tools.length) || 0, mcpAvailable:!!(r&&r.ok) });
    {
      const tools = (r&&Array.isArray(r.tools)?r.tools:[]).filter((t) => !isBlockedTool(t.name));
      // Virtual packs describe params as {type, req, desc}; convert to a real
      // JSON schema so signatures, required-param checks and the registry see
      // the same contract the pack's own describeCommands() prints.
      const schemaFromParams=(pm)=>{const props={},req=[];for(const [k,v] of Object.entries(pm||{})){const t=v&&typeof v==="object"?v:{type:"string"};const prop={type:String(t.type||"string").replace(/\[\]$/,"")};if(/\[\]$|^array|^list/.test(String(t.type||"")))prop.type="array";if(t.desc)prop.description=t.desc;if(Array.isArray(t.enum))prop.enum=t.enum;props[k]=prop;if(t.req)req.push(k);}return {type:"object",properties:props,required:req};};
      const addOffline=(rows,server)=>{for(const t of rows||[])if(t&&t.name&&!tools.some(x=>x.name===t.name))tools.push({name:t.name,description:t.description||"OrScript command",inputSchema:t.inputSchema||t.parameters||(t.params?schemaFromParams(t.params):{type:"object",properties:{}}),server,virtual:true,hidden:!!t.hidden});};
      try{if(typeof RobloxScriptSkills!=="undefined")addOffline(RobloxScriptSkills.SKILL_COMMANDS,"roblox");}catch{}
      try{if(typeof RSAnim!=="undefined")addOffline(RSAnim.ANIM_COMMANDS,"roblox");}catch{}
      try{if(typeof AgentScriptSkills!=="undefined")addOffline(AgentScriptSkills.SKILL_COMMANDS,"local");}catch{}
      if (!tools.some((t) => t && t.name === "or_screenshot")) {
        tools.push({
          name: "or_screenshot",
          description: "Take a real viewport PHOTO and attach it to the next message. Use target=blender for Blender's current 3D viewport, target=studio/game for Roblox Studio, or target=tab for this browser chat. Native viewport requests never fall back to the browser.",
          inputSchema: { type: "object", properties: {
            target: { type: "string", enum: ["auto", "studio", "game", "viewport", "blender", "tab"] },
            studio_id: { type: "string", description: "Optional Studio id when multiple Studio windows are connected." },
          } },
          server: activeEngine(),
        });
      }
      for (const virtual of [...COMMAND_DISCOVERY_TOOLS, ...STUDIO_ALIAS_TOOLS, ...CREATOR_TOOLS, ...TEMPLATE_AI_TOOLS, ...RELIABILITY_TOOLS, ...PROJECT_REFERENCE_TOOLS]) if (!tools.some((t) => t && t.name === virtual.name)) tools.push(virtual);
      // Public Skills: user-made skills/abilities become real catalogue entries
      // (plus the public_skill_* management tools). Rebuilt on every change by
      // refreshPublicSkillTools below.
      try { if (typeof PublicSkills !== "undefined") for (const virtual of [...PublicSkills.managementTools(), ...PublicSkills.toolEntries()]) if (!tools.some((t) => t && t.name === virtual.name)) tools.push(virtual); } catch (e) { diag("publicSkills.injectFailed", { error: String(e) }); }
      // Task list (Settings → Task list): task_* commands exist only while enabled.
      try { if (typeof ORTaskList !== "undefined") for (const virtual of ORTaskList.toolEntries()) if (!tools.some((t) => t && t.name === virtual.name)) tools.push(virtual); } catch (e) { diag("taskList.injectFailed", { error: String(e) }); }
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
      A.toolsAt = Date.now();
    }
    syncCommandRegistry();
    return A.toolList;
  }

  // Keep the live tool list in sync with the Public Skills registry without a
  // full bridge refetch: drop stale public entries, add the current ones.
  function refreshPublicSkillTools() {
    if (typeof PublicSkills === "undefined" && typeof ORTaskList === "undefined") return;
    try {
      const list = (A.toolList || []).filter((t) => !(t && (t.publicSkill || t.taskList)));
      if (typeof PublicSkills !== "undefined") {
        for (const t of PublicSkills.toolEntries()) if (!list.some((x) => x && x.name === t.name)) list.push(t);
        for (const t of PublicSkills.managementTools()) if (!list.some((x) => x && x.name === t.name)) list.push(t);
      }
      if (typeof ORTaskList !== "undefined") for (const t of ORTaskList.toolEntries()) if (!list.some((x) => x && x.name === t.name)) list.push(t);
      A.toolList = list;
      A.toolNames = new Set(list.map((t) => t.name));
      syncCommandRegistry();
    } catch (e) { diag("publicSkills.refreshFailed", { error: String(e) }); }
  }
  try { window.addEventListener("or-public-skills-change", () => refreshPublicSkillTools()); } catch {}
  try { window.addEventListener("or-tasklist-change", (e) => { const why = e && e.detail && e.detail.reason; if (why === "enabled" || why === "loaded") refreshPublicSkillTools(); }); } catch {}
  try { window.__rsBuiltinToolNames = () => new Set((A.toolList || []).filter((t) => t && !t.publicSkill).map((t) => t.name)); } catch {}

  function luauLiteral(v) {
    if (v == null) return "nil";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "{" + v.map(luauLiteral).join(",") + "}";
    const parts = [];
    for (const [k, val] of Object.entries(v)) {
      const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : ("[" + JSON.stringify(k) + "]");
      parts.push(key + "=" + luauLiteral(val));
    }
    return "{" + parts.join(",") + "}";
  }

  function studioMeshLuau(meshes, dest, scale) {
    const payload = luauLiteral({ meshes: meshes || [], dest: dest || "Workspace", scale: Number(scale) || 20 });
    return [
      "local AssetService = game:GetService(\"AssetService\")",
      "local payload = " + payload,
      "local meshes = payload.meshes or {}",
      "local scale = tonumber(payload.scale) or 20",
      "local destName = tostring(payload.dest or \"Workspace\")",
      "local parent = workspace",
      "if destName ~= \"Workspace\" and destName ~= \"workspace\" then",
      "  local t = workspace:FindFirstChild(destName)",
      "  if t then parent = t end",
      "end",
      "local folder = parent:FindFirstChild(\"OR_Imported\")",
      "if folder then folder:Destroy() end",
      "folder = Instance.new(\"Model\")",
      "folder.Name = \"OR_Imported\"",
      "folder.Parent = parent",
      "local built = 0",
      "local usedEditable = false",
      "local function aabb(verts)",
      "  local minx,miny,minz = math.huge, math.huge, math.huge",
      "  local maxx,maxy,maxz = -math.huge, -math.huge, -math.huge",
      "  for _,v in ipairs(verts) do",
      "    local x,y,z = (v[1] or 0)*scale, (v[2] or 0)*scale, (v[3] or 0)*scale",
      "    if x<minx then minx=x end if y<miny then miny=y end if z<minz then minz=z end",
      "    if x>maxx then maxx=x end if y>maxy then maxy=y end if z>maxz then maxz=z end",
      "  end",
      "  return Vector3.new((minx+maxx)/2,(miny+maxy)/2,(minz+maxz)/2), Vector3.new(math.max(0.05,maxx-minx), math.max(0.05,maxy-miny), math.max(0.05,maxz-minz))",
      "end",
      "local function addTri(em, ids, a, b, c)",
      "  if not ids[a] or not ids[b] or not ids[c] then return end",
      "  pcall(function() em:AddTriangle(ids[a], ids[b], ids[c]) end)",
      "end",
      "for _,entry in ipairs(meshes) do",
      "  local verts, faces = entry.verts or {}, entry.faces or {}",
      "  local name = tostring(entry.name or \"Mesh\")",
      "  local part",
      "  local okEm, em = pcall(function() return AssetService:CreateEditableMesh() end)",
      "  if okEm and em then",
      "    local ids = {}",
      "    for i,v in ipairs(verts) do",
      "      local x,y,z = (v[1] or 0)*scale, (v[2] or 0)*scale, (v[3] or 0)*scale",
      "      local okv, id = pcall(function() return em:AddVertex(Vector3.new(x,y,z)) end)",
      "      if okv then ids[i] = id ids[i-1] = id end",
      "    end",
      "    for _,f in ipairs(faces) do",
      "      if #f >= 3 then",
      "        for i=2,#f-1 do addTri(em, ids, f[1], f[i], f[i+1]) end",
      "      end",
      "    end",
      "    local okPart, mp = pcall(function()",
      "      if Content and Content.fromObject then return AssetService:CreateMeshPartAsync(Content.fromObject(em)) end",
      "      return AssetService:CreateMeshPartAsync(em)",
      "    end)",
      "    if okPart and mp then part = mp usedEditable = true end",
      "  end",
      "  if not part then",
      "    local cf, size = aabb(verts)",
      "    part = Instance.new(\"Part\")",
      "    part.Size = size",
      "    part.CFrame = CFrame.new(cf)",
      "    part.Anchored = true",
      "    part.Material = Enum.Material.SmoothPlastic",
      "  end",
      "  part.Name = name",
      "  part.Anchored = true",
      "  part.Parent = folder",
      "  built += 1",
      "end",
      "pcall(function() if folder.GetPivot then folder:PivotTo(CFrame.new(0, 3, 0)) end end)",
      "local how = usedEditable and \"EditableMesh\" or \"bounding-box Parts (EditableMesh unavailable)\"",
      "return string.format(\"imported %d mesh(es) into Workspace.OR_Imported via %s\", built, how)",
    ].join("\n");
  }

  // ── Thumbnail & Icon Studio: gfx_capture composite ──
  // The Luau half (skills/studio_gfx.js) hides the guides, clears the selection and
  // returns the aspect box as viewport FRACTIONS; this half photographs the Studio
  // viewport through the MCP (screen_capture), crops to the box, resizes to the
  // requested output (1920x1080 / 512x512 / custom), downloads the PNG and attaches
  // it to the chat so the model can judge the shot like an art director.
  async function cropGfxImage(img, d) {
    const bytes = Uint8Array.from(atob(String(img.data || "")), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: img.mimeType || "image/png" }));
    const box = d.box && typeof d.box === "object" ? d.box : { x: 0, y: 0, w: 1, h: 1 };
    const clamp01 = (v, dflt) => (isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : dflt);
    const bx = clamp01(box.x, 0), by = clamp01(box.y, 0), bw = clamp01(box.w, 1), bh = clamp01(box.h, 1);
    const sx = Math.round(bx * bmp.width), sy = Math.round(by * bmp.height);
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(bw * bmp.width)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(bh * bmp.height)));
    const ow = Math.max(16, Math.min(4096, Math.round(Number(d.out && d.out.w) || 1920)));
    const oh = Math.max(16, Math.min(4096, Math.round(Number(d.out && d.out.h) || 1080)));
    const canvas = document.createElement("canvas");
    canvas.width = ow; canvas.height = oh;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = "high"; } catch {}
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh);
    try { bmp.close(); } catch {}
    const dataUrl = canvas.toDataURL("image/png");
    return { mimeType: "image/png", data: dataUrl.slice(dataUrl.indexOf(",") + 1), width: ow, height: oh, srcW: bmp.width, srcH: bmp.height, crop: { x: sx, y: sy, w: sw, h: sh } };
  }
  function downloadDataImage(img, file) {
    try {
      const a = document.createElement("a");
      a.href = `data:${img.mimeType || "image/png"};base64,${img.data}`;
      a.download = file;
      a.style.display = "none";
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch {} }, 1000);
      return true;
    } catch { return false; }
  }
  async function runGfxCapture(args) {
    args = args || {};
    if (typeof RobloxScriptSkills === "undefined" || !RobloxScriptSkills.GFX_COMMANDS) return "ERROR: gfx pack missing - reload the extension.";
    const built = RobloxScriptSkills.buildLuau("gfx_capture", args);
    if (!built || built.err) return (built && built.err) || "ERROR building gfx_capture";
    const prep = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
    const body = String(prep || "").replace(/^Output of '[^']*':\n?/, "").trim();
    if (/^ERROR/i.test(body)) return `ERROR in gfx_capture: ${body.slice(0, 600)}`;
    let j = null;
    try { j = JSON.parse(body); } catch {}
    if (!j || j.ok === false) return `ERROR in gfx_capture: ${(j && j.error) ? String(j.error).slice(0, 600) : body.slice(0, 400)}`;
    const d = j.data || {};
    const settle = Math.max(0, Math.min(5000, Number(d.settle_ms) || 0));
    if (settle) await new Promise((r) => setTimeout(r, settle));
    A.pendingImages = null;
    const shotText = await runTool({ tool: "or_screenshot", arguments: { target: "studio", _orInternal: true } });
    const imgs = Array.isArray(A.pendingImages) ? A.pendingImages.filter((i) => i && i.data) : [];
    if (!imgs.length) return `ERROR in gfx_capture: the Studio viewport could not be photographed (${String(shotText || "").replace(/\s+/g, " ").slice(0, 300)}). Studio must be connected through or-core with the MCP screen_capture tool; or_screenshot {target:"studio"} is the quickest check.`;
    let out = null;
    let cropErr = "";
    if (args.raw !== true) {
      try { out = await cropGfxImage(imgs[0], d); } catch (e) { cropErr = String((e && e.message) || e); }
    }
    const file = String(d.file || "OR_GFX.png");
    const img = out || Object.assign({}, imgs[0]);
    const downloaded = downloadDataImage(img, file);
    A.pendingImages = [img];
    try { ui.showImages([img], "gfx_capture"); } catch {}
    const info = {
      ok: true, file, downloaded,
      width: out ? out.width : null, height: out ? out.height : null,
      kind: d.kind || null, aspect: d.aspect || null,
      cropped_from: out ? { viewport: { w: out.srcW, h: out.srcH }, box_px: out.crop } : null,
      raw: !out, crop_error: cropErr || undefined,
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
      note: (out ? `The finished ${out.width}x${out.height} PNG is attached to THIS message and downloaded as ${file}.` : `The uncropped viewport capture is attached${cropErr ? " (crop failed: " + cropErr + ")" : ""}.`)
        + " Judge it like an art director: is the face readable, is the title legible at 10% size, does the subject separate from the backdrop? Iterate with gfx_camera / gfx_pose / gfx_overlay / gfx_lighting / gfx_fx, then gfx_capture again. gfx_teardown when done.",
    };
    return `Output of 'gfx_capture':\n${JSON.stringify(info, null, 2)}`;
  }

  async function runAssetBridgeImport(args) {
    const a = args || {};
    const asset = String(a.asset || a.filepath || a.path || "").trim();
    const dest = String(a.dest || a.parent || "Workspace");
    const scale = Number(a.scale) || 20;
    const assetLower = asset.toLowerCase();
    let assetId = "";
    const prefix = "rbxassetid://";
    if (assetLower.indexOf(prefix) === 0) assetId = asset.slice(prefix.length).replace(/\D/g, "");
    else if (/^\d+$/.test(asset)) assetId = asset;
    if (assetId && assetLower.indexOf(".fbx") < 0) {
      const id = assetId;
      const code = [
        "local id = " + id,
        "local ok, res = pcall(function() return game:GetService(\"InsertService\"):LoadAsset(id) end)",
        "if ok and res then res.Name = \"OR_Imported\"; res.Parent = workspace; return \"inserted rbxassetid://\"..id..\" as Workspace.OR_Imported\" end",
        "local p = Instance.new(\"MeshPart\")",
        "p.Name = \"OR_Imported\"",
        "p.Size = Vector3.new(4,4,4)",
        "p.Anchored = true",
        "pcall(function() p.MeshId = \"rbxassetid://\"..id end)",
        "p.Parent = workspace",
        "return \"created MeshPart with MeshId rbxassetid://\"..id..\" (LoadAsset: \"..tostring(res)..\")\"",
      ].join("\n");
      return await runTool({ tool: "execute_luau", arguments: { code, datamodel_type: "Edit", _orInternal: true } });
    }
    if (!(A.bridge && A.bridge.blender)) {
      return "ERROR in asset_bridge_import: Connect Blender first. The addon must still be running so OR can read the mesh.";
    }
    const dump = await bg({ type: "call_tool", name: "blender_mesh_dump", arguments: { filepath: asset, asset, objects: a.objects }, timeout: 120000 });
    if (!dump || !dump.ok) {
      return "ERROR in asset_bridge_import: " + ((dump && dump.error) || "could not dump meshes from Blender");
    }
    let data = null;
    const textOut = String(dump.text || "");
    const mark = textOut.indexOf("OR_MESH_JSON:");
    try { data = JSON.parse(mark >= 0 ? textOut.slice(mark + 13) : textOut); } catch {}
    try { if (!data) data = JSON.parse(textOut); } catch {}
    let meshes = data && (data.meshes || (data.result && data.result.meshes));
    const meshPath = (data && data.mesh_file) || dump.meshFile || "or_mesh.json";
    if (!meshes || !meshes.length) {
      const file = await bg({ type: "local_read", path: meshPath });
      if (file && file.ok && file.text) {
        try {
          const parsed = JSON.parse(String(file.text).replace(/^\uFEFF/, "").trim());
          meshes = parsed.meshes || (parsed.result && parsed.result.meshes);
        } catch {}
      }
    }
    if (!meshes || !meshes.length) {
      return "ERROR in asset_bridge_import: Blender returned no meshes. Add or select mesh objects, then blender_send_to_studio.\n" + textOut.slice(0, 400);
    }
    const code = studioMeshLuau(meshes, dest, scale);
    return await runTool({ tool: "execute_luau", arguments: { code, datamodel_type: "Edit", _orInternal: true } });
  }

  function wrapStudioTxn(code, label) {
    const lab = String(label || "OR").replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 48) || "OR";
    return "local __orChs=game:GetService(\"ChangeHistoryService\")\n" +
      "pcall(function() __orChs:SetEnabled(true) end)\n" +
      "pcall(function() __orChs:SetWaypoint(\"OR before " + lab + "\") end)\n" +
      "local __orOk,__orRes=pcall(function()\n" + String(code || "") + "\nend)\n" +
      "pcall(function() __orChs:SetWaypoint(\"OR " + lab + "\") end)\n" +
      "if not __orOk then error(tostring(__orRes)) end\n" +
      "return __orRes";
  }
  // Bounded anti-drift reminder for compact providers: exact command names
  // only (work-mode focus first), capped so it always fits a Notion message.
  // ── Command index helpers ───────────────────────────────────────────────
  // A "signature" is the one-line callable form of a command:
  //   name {a, b?, c?:x|y}   (? = optional, x|y = enum)
  // Signatures are ~45 characters, so the whole 750-command catalogue fits in
  // ~35k characters and every command can be CALLED DIRECTLY without a second
  // list_commands round trip for its schema. Detail lines (descriptions, param
  // docs, tested-usage notes) are reserved for the primitives and the current
  // work mode's focus family; everything else is a signature.
  const PRIORITY_COMMAND_RE = new RegExp("^(?:" + [...UNIVERSAL_COMMANDS, "model_build", "ui_build"].join("|") + ")$");
  const nameFromLine = (line) => (String(line).match(/^\s*([A-Za-z_][\w.-]*)\s*[:({]/) || [])[1];
  function toolSignature(t) {
    const schema = (t && t.inputSchema) || {};
    const props = schema.properties || {};
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    // studio_id is injected by the bridge for every Studio tool - never shown.
    const parts = Object.entries(props).filter(([k]) => k !== "studio_id").map(([k, v]) => {
      v = v || {};
      const en = Array.isArray(v.enum) && v.enum.length <= 5 ? v.enum.join("|") : null;
      const ty = en ? ":" + en : v.type === "array" ? ":[]" : v.type === "object" ? ":{}" : "";
      return k + (req.has(k) ? "" : "?") + ty;
    });
    return `${t.name} {${parts.join(", ")}}`;
  }
  // Signature from a virtual-tool description block ("name: desc\n    a?:type ...").
  function sigFromLine(line) {
    const str = String(line || "");
    const nm = nameFromLine(str);
    if (!nm) return null;
    const rest = str.split("\n").slice(1).join("\n");
    const parts = [];
    const re = /(?:^\s+|,\s*)([A-Za-z_]\w*)(\??)\s*:/gm;
    let m;
    while ((m = re.exec(rest))) { if (!parts.some((x) => x.replace(/\?$/, "") === m[1])) parts.push(m[1] + m[2]); }
    return `${nm} {${parts.join(", ")}}`;
  }
  // Pack signatures several per line (line count is what costs on composers
  // that type text in; characters are nearly free). Returns the text and how
  // many were omitted once the character or line budget ran out.
  function packSignatures(sigs, limitChars, limitLines) {
    const out = []; let cur = ""; let used = 0; let omitted = 0;
    const flush = () => { if (cur) { out.push(cur); cur = ""; } };
    for (const sg of sigs) {
      const add = (cur ? "  ·  " : "") + sg;
      if (used + add.length + 1 > limitChars || (out.length >= limitLines && !cur) || (out.length >= limitLines - 1 && cur.length + add.length > 170)) { omitted++; continue; }
      if (cur && cur.length + add.length > 170) { flush(); if (out.length >= limitLines) { omitted++; continue; } cur = sg; used += sg.length + 1; continue; }
      cur += add; used += add.length + 1;
    }
    flush();
    return { text: out.join("\n"), omitted, lines: out.length, chars: used };
  }
  // Full detail line for a bridge tool (description + param docs + usage note).
  function toolDetailLine(t) {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const req = new Set((t.inputSchema && t.inputSchema.required) || []);
    const compact = [];
    const detailed = [];
    for (const [k, v] of Object.entries(props)) {
      if (k === "studio_id") continue; // injected by the bridge (callStudioToolWithId)
      const items = v.items && typeof v.items === "object" ? v.items : null;
      const itemProps = items && items.properties;
      const mark = req.has(k) ? "" : "?";
      if (v.type === "array" && itemProps) {
        const itemReq = new Set(items.required || []);
        const fields = Object.entries(itemProps).map(([ik, iv]) => {
          const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ? `(${iv.enum.join("|")})` : (iv.type || "any");
          return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
        });
        detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ? " - " + v.description : ""}`);
      } else if (v.description && v.description.length > 45) {
        detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
      } else {
        const ty = Array.isArray(v.enum) && v.enum.length <= 8 ? `(${v.enum.join("|")})` : (v.type || "any");
        compact.push(`${k}${mark}:${ty}${v.description ? ` "${v.description}"` : ""}`);
      }
    }
    const paramLines = [compact.length ? `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
    const note = RS.TOOL_NOTES[bareToolName(t.name)];
    const noteStr = note ? `\n    ⚠ ${note}` : "";
    return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ? "\n" + paramLines : ""}${noteStr}`;
  }
  // Schema text for ONE command by name (native tool or virtual skill line),
  // used by error feedback so the model can fix a call without list_commands.
  function schemaTextFor(name) {
    const bare = bareToolName(name);
    try {
      const t = A.toolList.find((x) => x && (x.name === name || bareToolName(x.name) === bare));
      if (t && !t.virtual) return toolDetailLine(t);
      const pools = [];
      try { pools.push(...RSAnim.describeCommands()); } catch {}
      try { if (typeof RobloxScriptSkills !== "undefined") pools.push(...RobloxScriptSkills.describeCommands()); } catch {}
      try { if (typeof AgentScriptSkills !== "undefined") pools.push(...AgentScriptSkills.describeCommands()); } catch {}
      const line = pools.find((l) => nameFromLine(l) === bare);
      if (line) return line;
      if (t) return toolDetailLine(t);
    } catch {}
    return "";
  }
  function requiredParamsMissing(t, args) {
    const schema = (t && t.inputSchema) || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const a = args && typeof args === "object" ? args : {};
    // studio_id is injected by the bridge layer (callStudioToolWithId), never by the model.
    return req.filter((k) => k !== "studio_id" && (a[k] === undefined || a[k] === null || a[k] === ""));
  }
  // The command catalogue returned by a broad list_commands. One builder for
  // every provider: detail lines for primitives + focus family (skipped on
  // compact composers), signatures for everything else, names only when even
  // signatures do not fit. Nothing is ever listed twice.
  function buildCatalogue(o) {
    const { toolName, requested, nativeTools, virtualLines, webLines, focusBlock, focusNames, compact, limit, lineLimit, heading } = o;
    const entries = []; const seen = new Set();
    for (const line of virtualLines) {
      const nm = nameFromLine(line);
      if (!nm || seen.has(nm)) continue;
      seen.add(nm); entries.push({ name: nm, detail: String(line), sig: sigFromLine(line) || `${nm} {}`, virtual: true });
    }
    for (const t of nativeTools) {
      if (!t || !t.name || seen.has(t.name)) continue;
      seen.add(t.name); entries.push({ name: t.name, detail: toolDetailLine(t), sig: toolSignature(t), native: !t.virtual });
    }
    const focus = new Set(focusNames || []);
    const rank = (e) => (PRIORITY_COMMAND_RE.test(e.name) ? 0 : e.native ? 1 : focus.has(e.name) ? 2 : 3);
    entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const intro = `${heading || `Output of '${toolName}':`}\n${requested} commands - ${entries.length} total${compact ? " (compact index for this chat)" : ""}.\n`
      + `HOW TO READ: "name {a, b?, c?:x|y}" = call name with a (required), b (optional), c (one of x|y). `
      + `Every command shown with {…} can be called DIRECTLY - do not fetch its schema first. `
      + `list_commands {"query":"exact_name"} returns one command's full description and usage notes: use it only when a parameter is unclear or a call errored. `
      + `list_commands {"query":"keyword"} finds commands that are not shown here.\n\n`;
    const webBlock = webLines && webLines.length ? `HELPERS:\n${webLines.join("\n")}\n\n` : "";
    const countLines = (x) => (x ? x.split("\n").length : 0);
    let usedChars = intro.length + (focusBlock || "").length + webBlock.length;
    let usedLines = countLines(intro) + countLines(focusBlock) + countLines(webBlock) + 8;
    // UNIVERSAL block first, in every mode and on every budget: full schemas
    // on roomy composers, signatures on compact ones. These are the commands
    // the model needs before it can use ANY family (find, inspect, read, verify).
    const universal = entries.filter((e) => rank(e) === 0);
    let universalBlock = "";
    if (universal.length) {
      const body = compact ? packSignatures(universal.map((e) => e.sig), 4500, 80).text : universal.map((e) => e.detail).join("\n\n");
      universalBlock = `UNIVERSAL — ${universal.length} commands available in EVERY work mode (navigate, inspect, read, write, verify; call directly):\n${body}\n\n`;
      for (const e of universal) e.done = true;
      usedChars += universalBlock.length; usedLines += countLines(universalBlock);
    }
    // Public Skills ride along with the universal tier: the user installed
    // them on purpose, so they must never fall into the "names only" tail.
    try {
      if (typeof PublicSkills !== "undefined") {
        const pub = PublicSkills.catalogueBlock({ compact });
        if (pub) {
          for (const e of entries) if (!e.done && PublicSkills.isCommand(e.name)) e.done = true;
          universalBlock += pub; usedChars += pub.length; usedLines += countLines(pub);
        }
      }
      if (typeof ORTaskList !== "undefined" && ORTaskList.isEnabled()) {
        const p = ORTaskList.progress();
        const tl = `TASK LIST (user enabled it in Settings; ${p.done}/${p.total} done): task_next {} → next open task (marks it doing) · task_update {id|"#n", status: doing|done|skipped, notes?} · task_add {text} · task_list {}. Mark "done" only after verifying.\n\n`;
        for (const e of entries) if (!e.done && /^task_(list|next|add|update)$/.test(e.name)) e.done = true;
        universalBlock += tl; usedChars += tl.length; usedLines += countLines(tl);
      }
    } catch {}
    const detail = [];
    if (!compact) {
      // The universal block is part of the schema tier's share of the budget.
      const detailChars = Math.max(0, Math.floor(limit * 0.42) - universalBlock.length);
      const detailLines = Math.max(0, Math.floor(lineLimit * 0.5) - countLines(universalBlock));
      let dc = 0, dl = 0;
      for (const e of entries) {
        if (e.done) continue;
        const want = PRIORITY_COMMAND_RE.test(e.name) || e.native || focus.has(e.name);
        if (!want) continue;
        const ln = countLines(e.detail) + 1;
        if (dc + e.detail.length + 2 > detailChars || dl + ln > detailLines) continue;
        detail.push(e.detail); dc += e.detail.length + 2; dl += ln; e.done = true;
      }
      usedChars += dc; usedLines += dl;
    }
    const rest = entries.filter((e) => !e.done);
    // Compact: signatures take ~60% of what is left so a name index of the
    // remaining commands still fits; full: signatures may use everything.
    const sigBudget = Math.max(800, Math.floor((limit - usedChars - 600) * (compact ? 0.6 : 1)));
    const sigLines = Math.max(6, lineLimit - usedLines - 4);
    const packed = packSignatures(rest.map((e) => e.sig), sigBudget, sigLines);
    const shown = rest.length - packed.omitted;
    let namesBlock = "", omitted = 0;
    if (packed.omitted) {
      const leftover = rest.slice(shown).map((e) => e.name);
      const nameBudget = Math.max(300, limit - usedChars - packed.chars - 400);
      let list = "";
      for (const nm of leftover) { if (list.length + nm.length + 2 > nameBudget) { omitted++; continue; } list += (list ? ", " : "") + nm; }
      namesBlock = list ? `\n\nMORE COMMANDS (names only - fetch one with list_commands {"query":"name"} before use):\n${list}` : "";
    }
    const detailBlock = detail.length ? `${String((focusBlock || "").match(/━━━ (\w+) WORK MODE/) ? RegExp.$1 : "FOCUS")} FAMILY (full schemas):\n\n${detail.join("\n\n")}\n\n` : "";
    const sigBlock = packed.text ? `SIGNATURES (callable as shown):\n${packed.text}` : "";
    const tail = omitted ? `\n[${omitted} more commands omitted - list_commands {"query":"keyword"} finds them.]` : "";
    return intro + universalBlock + (focusBlock || "") + webBlock + detailBlock + sigBlock + namesBlock + tail;
  }
  // ── Project Index map cache (1.32) ──
  // project_index_build / project_index_summary return a compact PROJECT MAP
  // (<= 1500 chars). We keep the latest one per place in memory + storage and
  // append it to the periodic tools reminder, so a model deep into a long task
  // keeps the architecture, conventions and remote wiring in view without
  // spending calls on script_read. Rebuilt by the model when the index is stale.
  const PROJECT_MAP_MAX = 1500;
  function cacheProjectMap(resText) {
    const body = String(resText || "").replace(/^Output of '[^']*':\n?/, "").trim();
    if (!/^\{/.test(body) || body.length > 400000) return;
    let j = null;
    try { j = JSON.parse(body); } catch { return; }
    const d = j && j.ok !== false && j.data;
    const text = d && typeof d.map_text === "string" ? d.map_text.slice(0, PROJECT_MAP_MAX) : "";
    if (!text) return;
    const entry = { text, at: Date.now(), scripts: d.counts && d.counts.scripts || 0, place: d.place && d.place.name || "" };
    window.__rsProjectMap = entry;
    try { chrome.storage.local.set({ rsProjectMap: entry }); } catch {}
  }
  function projectMapReminder() {
    const m = window.__rsProjectMap;
    if (!m || !m.text) return "";
    const ageMin = Math.max(0, Math.round((Date.now() - (m.at || 0)) / 60000));
    return "\n\n(PROJECT MAP, cached " + (ageMin < 1 ? "just now" : ageMin + " min ago") + " from project_index_" + (m.scripts ? "build/summary - " + m.scripts + " scripts" : "build/summary") + ". Use project_index_search / project_index_script before reading whole scripts; run project_index_changes or project_index_build when it may be stale.)\n" + String(m.text).slice(0, PROJECT_MAP_MAX);
  }
  try { chrome.storage.local.get("rsProjectMap", (r) => { if (r && r.rsProjectMap && r.rsProjectMap.text && !window.__rsProjectMap) window.__rsProjectMap = r.rsProjectMap; }); } catch {}
  function compactToolsReminder(tools) {
    const limit = Math.max(2000, Number(P.commandListMaxChars) || 6000);
    let focus = [];
    try { focus = workModeFocusNames(normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()), (tools || []).map((t) => t.name)); } catch {}
    const byName = new Map((tools || []).filter((t) => t && t.name).map((t) => [t.name, t]));
    // Focus family + primitives as callable signatures (≈45 chars each) inside
    // the first half of the budget, every other command as a bare name.
    const sigNames = [...new Set([...focus, ...[...byName.keys()].filter((n) => PRIORITY_COMMAND_RE.test(n))])].sort();
    const packed = packSignatures(sigNames.map((n) => toolSignature(byName.get(n))).filter(Boolean), Math.floor(limit * 0.55), 60);
    const shownSig = new Set(sigNames.slice(0, sigNames.length - packed.omitted));
    const names = [...byName.keys()].filter((n) => !shownSig.has(n)).sort();
    let list = "", omitted = 0;
    const nameBudget = limit - packed.chars;
    for (const n of names) {
      if (list.length + n.length + 2 > nameBudget) { omitted++; continue; }
      list += (list ? ", " : "") + n;
    }
    return "\n\n────────────────────────────────\n" +
      "(System note from OR - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      (packed.text ? "Signatures (? = optional; call directly):\n" + packed.text + "\n" : "") +
      "Other exact command names: " + list + (omitted ? `\n[${omitted} more names omitted - search by keyword with list_commands.]` : "") +
      "\nFor a name without a signature, fetch its parameters with {\"command\":\"list_commands\",\"params\":{\"query\":\"exact_command_name\"}} before first use; never guess parameters.";
  }
  function compressToolFeedback(text, name) {
    const s = String(text || "");
    const MAX = 10000;
    if (s.length <= MAX) return s;
    return s.slice(0, 6500) + "\n[OR context compression: dropped " + (s.length - 9000) + " chars from " + String(name || "tool") + "]\n" + s.slice(-2500);
  }
  async function attachAutoDebug(toolName, feedback) {
    let on = true;
    try { if (window.__rsAutoDebug && window.__rsAutoDebug() === false) on = false; } catch {}
    if (!on) return feedback;
    try { if (activeEngine() === "local") return feedback; } catch {}
    if (!toolName || /^(or_|list_|get_|debug_|web_|status)/.test(String(toolName))) return feedback;
    if (String(feedback || "").startsWith("ERROR")) return feedback;
    const now = Date.now();
    if (A._debugBusy) return feedback;
    if (A._debugAt && now - A._debugAt < 6000) return feedback;
    A._debugBusy = true;
    A._debugAt = now;
    try {
      const code = [
        "local hs=game:GetService(\"HttpService\")",
        "local hist={}",
        "pcall(function() hist=game:GetService(\"LogService\"):GetLogHistory() end)",
        "local out={}",
        "for i=math.max(1,#hist-50),#hist do",
        " local e=hist[i]",
        " if e and (e.messageType==Enum.MessageType.MessageError or e.messageType==Enum.MessageType.MessageWarning) then",
        "  local m=tostring(e.message or \"\")",
        "  if not m:find(\"Assistant plugin version changed\",1,true) and not m:find(\"sabuiltin_Assistant\",1,true) then",
        "   out[#out+1]=m:sub(1,240)",
        "  end",
        " end",
        "end",
        "return hs:JSONEncode(out)",
      ].join("\n");
      const r = await Promise.race([
        bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 8000 }),
        new Promise((res) => setTimeout(() => res(null), 8000)),
      ]);
      const raw = r && r.ok ? String(r.text || "") : "";
      let lines = [];
      try { lines = JSON.parse(raw); } catch { lines = []; }
      if (!Array.isArray(lines) || !lines.length) return feedback;
      A._debugSigs = A._debugSigs || new Set();
      const fresh = [];
      for (const ln of lines) {
        if (isAssistantPluginNoise(ln)) continue;
        const sig = String(ln).replace(/\d+/g, "#").slice(0, 160);
        if (A._debugSigs.has(sig)) continue;
        A._debugSigs.add(sig);
        fresh.push(String(ln).slice(0, 200));
      }
      if (!fresh.length) return feedback;
      return String(feedback) + "\n[AUTO DEBUG] New Studio errors/warnings:\n- " + fresh.slice(0, 6).join("\n- ") + "\nFix these next with the smallest command.";
    } catch {
      return feedback;
    } finally {
      A._debugBusy = false;
    }
  }
  async function undoStudioTxn() {
    const code = "local chs=game:GetService(\"ChangeHistoryService\")\npcall(function() chs:SetEnabled(true) end)\nif chs:GetCanUndo() then chs:Undo() return \"UNDONE\" end\nreturn \"NOTHING\"";
    try {
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 20000 });
      const text = String((r && (r.text || r.error)) || "");
      if (/UNDONE/.test(text)) {
        try { ui.toast("Undo — last Studio change reverted"); } catch {}
        return true;
      }
      if (r && r.ok === false) {
        try { ui.toast("Undo failed — " + String(r.error || "Studio not connected").slice(0, 80)); } catch {}
        return false;
      }
      try { ui.toast("Nothing to undo in Studio"); } catch {}
      return false;
    } catch (e) {
      try { ui.toast("Undo failed — " + String(e && e.message || e).slice(0, 80)); } catch {}
      return false;
    }
  }
  try { window.__rsUndo = undoStudioTxn; } catch {}

  function parseStudioIds(text) {
    const raw = String(text || "");
    const m = raw.match(/\{[^{}]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        return { gameId: Number(j.gameId || j.GameId || 0) || 0, placeId: Number(j.placeId || j.PlaceId || 0) || 0, name: String(j.name || "") };
      } catch {}
    }
    return { gameId: 0, placeId: 0, name: "" };
  }
  async function studioUniverseIds() {
    const code = 'local hs=game:GetService("HttpService") return hs:JSONEncode({gameId=tonumber(game.GameId) or 0,placeId=tonumber(game.PlaceId) or 0,name=tostring(game.Name or "")})';
    try {
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 15000 });
      if (r && r.ok) return parseStudioIds(r.text);
    } catch {}
    return { gameId: 0, placeId: 0, name: "" };
  }
  async function createDeveloperProduct(args) {
    const productName = String(args.name || args.title || "").trim();
    const price = Number(args.price || args.price_in_robux || args.robux || 0);
    const desc = String(args.description || args.desc || productName).trim();
    const reward = String(args.reward || "").trim();
    if (!productName) return "ERROR: developer_product_create needs name (the product title players see).";
    if (!Number.isFinite(price) || price < 1) return "ERROR: price must be Robux >= 1 (got " + String(args.price || args.price_in_robux || args.robux || "none") + ").";
    const ids = await studioUniverseIds();
    let universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    const r = await bg({ type: "create_dev_product", universeId: universe, placeId: Number(args.place_id || args.placeId || ids.placeId || 0) || 0, gameId: universe, name: productName, description: desc, priceInRobux: Math.floor(price) });
    if (!r || !r.ok) {
      return "ERROR: could not create developer product — could not reach the game. " + String((r && r.error) || "Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry.");
    }
    universe = Number(r.universeId || universe) || universe;
    const prod = r.product || {};
    const pid = Number(prod.id || prod.productId || prod.developerProductId || r.productId || 0) || 0;
    let out = "Output of 'developer_product_create':\nCreated Developer Product \"" + productName + "\" — " + Math.floor(price) + " Robux.\nproduct_id=" + (pid || "(see payload)") + " universe_id=" + universe + "\n" + String(r.text || JSON.stringify(prod)).slice(0, 1200);
    if (pid && args.wire !== false) {
      try {
        const wired = await runTool({ tool: "marketplace_setup", arguments: { devproduct_id: pid, reward: reward || productName } });
        out += "\n\nWired ProcessReceipt:\n" + String(wired || "").slice(0, 800);
      } catch (e) {
        out += "\n(Product created. Wire it with marketplace_setup {devproduct_id: " + pid + "} if ProcessReceipt is missing.)";
      }
    } else if (pid) {
      out += "\nNext: marketplace_setup {devproduct_id: " + pid + ", reward: \"...\"} to grant the purchase.";
    }
    return out;
  }
  async function listDeveloperProducts(args) {
    const ids = await studioUniverseIds();
    let universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    const r = await bg({ type: "list_dev_products", universeId: universe, placeId: Number(args.place_id || args.placeId || ids.placeId || 0) || 0, gameId: universe });
    if (!r || !r.ok) return "ERROR: could not list developer products. " + String((r && r.error) || "Sign into roblox.com in this Chrome profile.");
    return "Output of 'developer_product_list':\n" + String(r.text || JSON.stringify(r.products || r, null, 2)).slice(0, 4000);
  }

  // ── Game passes ──
  // Two real routes, tried in order: (1) the user's roblox.com browser session
  // (background.js, like developer products), (2) Open Cloud through or-core when
  // the ORscript Studio plugin has an API key (cloud_gamepass_* tools appear in
  // the catalogue only then). Studio itself cannot create passes. Afterwards the
  // Studio plugin writes the server handler (gamepass_handler_create); without
  // the plugin the Luau skill marketplace_setup does the wiring.
  // Commands served by the ORscript Studio plugin through or-core
  // (agent/src/plugin.rs + plugin/ORscript.lua). They join A.toolList only while
  // the plugin is connected; calling one earlier gets a how-to instead of
  // "unknown command".
  const STUDIO_PLUGIN_COMMANDS = ["studio_plugin_status", "plugin_execute_luau", "csg_union", "csg_negate", "csg_separate", "open_script", "script_live_update", "studio_import_file", "studio_publish_selection", "studio_prompt_asset_id", "studio_insert_asset", "studio_place_info", "studio_select_tool", "studio_undo", "studio_redo", "studio_notify", "screenshot_frame", "gamepass_handler_create", "developer_product_handler_create", "cloud_gamepass_create", "cloud_gamepass_update", "cloud_gamepass_list", "cloud_product_create", "cloud_product_list",
    // 1.24.0 — full Studio control, other plugins, Eclipse Animator bridge
    "studio_playtest", "studio_settings", "studio_selection", "studio_camera", "studio_script_editor", "studio_history", "studio_service_call", "studio_macro", "studio_save", "studio_output", "studio_test_run", "studio_mouse",
    "plugins_list", "plugin_widget", "plugin_invoke", "plugin_module_call", "plugin_source_read",
    "eclipse_status", "eclipse_open", "eclipse_handoff", "eclipse_import", "eclipse_play"];
  const STUDIO_PLUGIN_SET = new Set(STUDIO_PLUGIN_COMMANDS);
  const PLUGIN_HOWTO = "the ORscript Studio plugin is not connected. or-core (ORscript Desktop, cargo build in ORscript/agent) installs plugin/ORscript.lua into Studio's local Plugins folder; restart Studio once, open Plugins → ORscript and click Allow on the HTTP prompt. Until then use execute_luau / the Luau skills (model_union, marketplace_setup, ...).";
  function pluginToolAvailable(name) {
    try { return A.toolNames.has(name) || Array.from(A.toolNames).some((n) => bareToolName(n) === name); } catch { return false; }
  }
  async function bridgeTool(name, args, timeout) {
    const r = await bg({ type: "call_tool", name: name, arguments: args || {}, timeout: timeout || 90000 });
    if (!r || !r.ok) throw new Error(String((r && (r.error || r.text)) || "bridge call failed"));
    return String(r.text || "");
  }
  async function wireGamePass(gamePassId, passName, args) {
    const benefit = String(args.benefit || args.reward_type || "").trim().toLowerCase();
    const reward = String(args.reward || "").trim();
    if (pluginToolAvailable("gamepass_handler_create")) {
      const text = await bridgeTool("gamepass_handler_create", { gamepass_id: gamePassId, name: passName, benefit: benefit || (reward ? "custom" : "custom"), amount: Number(args.amount || 0) || undefined, tool_name: args.tool_name || undefined });
      return "Wired by the Studio plugin (gamepass_handler_create):\n" + text.slice(0, 900);
    }
    const wired = await runTool({ tool: "marketplace_setup", arguments: { gamepass_id: gamePassId, reward: reward || passName } });
    return "Wired with marketplace_setup:\n" + String(wired || "").slice(0, 800);
  }
  async function createGamePass(args) {
    const passName = String(args.name || args.title || "").trim();
    const price = Math.floor(Number(args.price || args.price_in_robux || args.robux || 0)) || 0;
    const desc = String(args.description || args.desc || passName).trim();
    if (!passName) return "ERROR: gamepass_create needs name (the pass title players see). Optional: price (Robux), description, benefit (speed|coins|tool|custom), amount, tool_name.";
    if (price < 0) return "ERROR: price must be Robux >= 0 (0 = not for sale yet).";
    const ids = await studioUniverseIds();
    let universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    const placeId = Number(args.place_id || args.placeId || ids.placeId || 0) || 0;
    let r = null;
    try {
      r = await bg({ type: "create_game_pass", universeId: universe, placeId: placeId, gameId: universe, name: passName, description: desc, price: price, iconDataUrl: args.icon_data_url || args.iconDataUrl || "" });
    } catch (e) {
      r = { ok: false, error: String(e && e.message || e) };
    }
    let via = "your roblox.com browser session";
    let gamePassId = r && r.ok ? Number(r.gamePassId || 0) || 0 : 0;
    let priceNote = r && r.ok ? (r.priceWarning ? "\n" + r.priceWarning : "") : "";
    if (!(r && r.ok) && pluginToolAvailable("cloud_gamepass_create")) {
      try {
        const text = await bridgeTool("cloud_gamepass_create", { name: passName, description: desc, price: price, universe_id: universe || undefined, icon_path: args.icon_path || undefined }, 120000);
        let parsed = null; try { parsed = JSON.parse(text); } catch {}
        gamePassId = Number((parsed && parsed.gamepass_id) || 0) || 0;
        universe = Number((parsed && parsed.universe_id) || universe) || universe;
        if (parsed && parsed.price_warning) priceNote = "\n" + parsed.price_warning;
        via = "Open Cloud (or-core)";
        r = { ok: true, text: text };
      } catch (e) {
        return "ERROR: could not create the game pass. Browser session: " + String(r && r.error || "failed") + " | Open Cloud: " + String(e && e.message || e) + "\nManual fallback: https://create.roblox.com/dashboard/creations/experiences/" + (universe || "<universe>") + "/monetization/passes";
      }
    }
    if (!(r && r.ok)) {
      return "ERROR: could not create the game pass — " + String((r && r.error) || "Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry.") + (r && r.dashboard ? "\nManual fallback: " + r.dashboard : "") + "\nTip: paste an Open Cloud API key in Studio → Plugins → ORscript to let or-core create passes without the browser session.";
    }
    universe = Number((r && r.universeId) || universe) || universe;
    let out = "Output of 'gamepass_create':\nCreated Game Pass \"" + passName + "\"" + (price > 0 ? " — " + price + " Robux" : " — not for sale yet (price 0)") + " via " + via + ".\ngamepass_id=" + (gamePassId || "(see payload)") + " universe_id=" + universe + priceNote + "\n" + String(r.text || "").slice(0, 900);
    if (gamePassId && args.wire !== false) {
      try { out += "\n\n" + await wireGamePass(gamePassId, passName, args); }
      catch (e) { out += "\n(Pass created. Wire it with gamepass_handler_create {gamepass_id: " + gamePassId + "} or marketplace_setup {gamepass_id: " + gamePassId + "}; wiring failed: " + String(e && e.message || e).slice(0, 200) + ")"; }
    } else if (gamePassId) {
      out += "\nNext: gamepass_handler_create {gamepass_id: " + gamePassId + ", benefit: \"speed|coins|tool|custom\"} writes the server handler.";
    }
    out += "\nPlayers buy it with MarketplaceService:PromptGamePassPurchase(player, " + (gamePassId || "<id>") + ") from a LocalScript button.";
    return out;
  }
  async function updateGamePass(args) {
    const gamePassId = Number(args.gamepass_id || args.gamePassId || args.id || args.assetId || 0) || 0;
    if (!gamePassId) return "ERROR: gamepass_update needs gamepass_id (use gamepass_list).";
    const payload = { gamePassId: gamePassId };
    if (args.name != null) payload.name = String(args.name);
    if (args.description != null) payload.description = String(args.description);
    if (args.price != null) payload.price = Math.floor(Number(args.price)) || 0;
    if (args.for_sale != null || args.isForSale != null) payload.isForSale = !!(args.for_sale != null ? args.for_sale : args.isForSale);
    let r = null;
    try { r = await bg({ type: "update_game_pass", ...payload }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!(r && r.ok) && pluginToolAvailable("cloud_gamepass_update")) {
      try {
        const text = await bridgeTool("cloud_gamepass_update", { gamepass_id: gamePassId, name: payload.name, description: payload.description, price: payload.price, for_sale: payload.isForSale });
        return "Output of 'gamepass_update' (Open Cloud):\n" + text.slice(0, 1500);
      } catch (e) {
        return "ERROR: gamepass_update failed. Browser session: " + String(r && r.error || "failed") + " | Open Cloud: " + String(e && e.message || e);
      }
    }
    if (!(r && r.ok)) return "ERROR: gamepass_update failed — " + String((r && r.error) || "Sign into roblox.com in this Chrome profile.");
    return "Output of 'gamepass_update':\nUpdated game pass " + gamePassId + " " + JSON.stringify(payload) + "\n" + String(r.text || "").slice(0, 1200);
  }
  async function listGamePasses(args) {
    const ids = await studioUniverseIds();
    const universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    let r = null;
    try { r = await bg({ type: "list_game_passes", universeId: universe, placeId: Number(args.place_id || args.placeId || ids.placeId || 0) || 0, gameId: universe }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!(r && r.ok) && pluginToolAvailable("cloud_gamepass_list")) {
      try { return "Output of 'gamepass_list':\n" + (await bridgeTool("cloud_gamepass_list", { universe_id: universe || undefined })).slice(0, 4000); } catch {}
    }
    if (!(r && r.ok)) return "ERROR: could not list game passes. " + String((r && r.error) || "Sign into roblox.com in this Chrome profile, or publish the place first.");
    const passes = Array.isArray(r.passes) ? r.passes : [];
    return "Output of 'gamepass_list':\nuniverse_id=" + (r.universeId || universe) + " (" + passes.length + " passes)\n" + (passes.length ? passes.map((p) => "- " + p.id + "  \"" + p.name + "\"  " + (p.price == null ? "not for sale" : p.price + " Robux")).join("\n") : "(none yet — gamepass_create {name, price})");
  }

  function isAssistantPluginNoise(text) {
    return /sabuiltin_Assistant|Assistant plugin version changed from \w+ to \w+/i.test(String(text || ""));
  }
  function stripStudioNoise(text) {
    let s = String(text || "");
    s = s.replace(/\[[^\]]*\bsabuiltin_Assistant[^\]]*\][^\n]*/gi, "");
    s = s.replace(/Assistant plugin version changed from \w+ to \w+\.[^\n]*/gi, "");
    s = s.replace(/This may cause instability when using Assistant or the MCP server\.[^\n]*/gi, "");
    s = s.replace(/Please restart Roblox Studio to fix\.[^\n]*/gi, "");
    s = s.replace(/^[ \t]*-\s*Studio\s*$/gm, "");
    s = s.replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }
  function cleanToolResult(r) {
    if (!r || typeof r !== "object") return r;
    const blob = String(r.error || "") + "\n" + String(r.text || "");
    if (!isAssistantPluginNoise(blob)) {
      if (r.text) {
        const t = stripStudioNoise(r.text);
        if (t !== r.text) return Object.assign({}, r, { text: t });
      }
      return r;
    }
    const t = stripStudioNoise(r.text || "");
    const e = stripStudioNoise(r.error || "");
    if (!e) return Object.assign({}, r, { ok: true, text: t || "OK", error: undefined });
    return Object.assign({}, r, { text: t || r.text, error: e });
  }
  function studioToolByBare(name) {
    return (A.toolList || []).find((tool) => bareToolName(tool && tool.name) === name) || null;
  }
  // The Studio MCP's viewport capture has shipped under more than one name; also
  // honour any Roblox-server tool we have already SEEN return an image.
  function studioCaptureTool() {
    const list = (A.toolList || []).filter((t) => t && t.name && (t.server || "roblox") !== "local");
    const byName = list.find((t) => /^(screen_capture|screenshot|take_screenshot|capture_screen(shot)?|get_screenshot|viewport_(screenshot|capture)|capture_viewport)$/i.test(bareToolName(t.name)));
    if (byName) return byName;
    return list.find((t) => A.imageTools && A.imageTools.has(bareToolName(t.name)) && !/^or_/.test(bareToolName(t.name))) || null;
  }

  function studioIdFromList(value) {
    const text = String(value && (value.text || value.result) || value || "");
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (!Array.isArray(node)) {
        const id = node.studio_id || node.studioId || node.id;
        if (typeof id === "string" && id) found.push({ id, active: node.active === true || node.is_active === true });
      }
      for (const child of Object.values(node)) if (child && typeof child === "object") walk(child);
    };
    for (const start of [text.indexOf("["), text.indexOf("{")]) {
      if (start < 0) continue;
      try { walk(JSON.parse(text.slice(start))); } catch {}
    }
    const preferred = found.find((entry) => entry.active) || found[0];
    if (preferred) return preferred.id;
    const match = text.match(/(?:studio[_ ]?id|studioId)\s*[:=]\s*["']?([\w:.-]+)/i)
      || text.match(/"(?:studio_id|studioId)"\s*:\s*"([^"]+)"/i);
    return match ? match[1] : "";
  }

  // Studio's MCP takes a `studio_id` on every tool. Most tools infer it when a
  // single Studio is open, but screen_capture REFUSES the call without one
  // ("ERROR INVALID_ARGUMENT: Missing required arg"). Resolve it once via
  // list_roblox_studios and cache it briefly (ids change on every Studio
  // restart, so never cache for long). Prefers the entry flagged active.
  const STUDIO_ID_TTL = 20000;
  async function resolveStudioId(force) {
    const now = Date.now();
    if (!force && A.studioId && now - (A.studioIdAt || 0) < STUDIO_ID_TTL) return A.studioId;
    if (A._studioIdPending && !force) return A._studioIdPending;
    const listTool = studioToolByBare("list_roblox_studios");
    const name = (listTool && listTool.name) || "list_roblox_studios";
    A._studioIdPending = (async () => {
      try {
        const listed = await bg({ type: "call_tool", name, arguments: {}, timeout: 12000 });
        const id = listed && listed.ok ? studioIdFromList(listed) : "";
        if (id) { A.studioId = id; A.studioIdAt = Date.now(); }
        return id || "";
      } catch { return ""; }
      finally { A._studioIdPending = null; }
    })();
    return A._studioIdPending;
  }
  function studioIdComplaint(r) {
    if (!r) return false;
    const text = String((r.ok ? r.text : (r.error && (r.error.message || r.error.error || r.error))) || "");
    return /missing required arg/i.test(text) || (/studio[_ ]?id/i.test(text) && /required|missing|not connected|unknown/i.test(text));
  }
  // Call a Studio tool through the bridge; when Studio answers that the
  // studio_id is missing (or the cached one went stale), list the studios and
  // retry ONCE with a fresh id. Used by the main tool path and or_screenshot.
  async function callStudioToolWithId(name, args, timeout, requestId) {
    let r = await bg({ type: "call_tool", name, arguments: args, timeout, requestId });
    if (studioIdComplaint(r) && bareToolName(name) !== "list_roblox_studios") {
      const id = await resolveStudioId(true);
      if (id && id !== (args && args.studio_id)) {
        diag("tool.studioIdRetry", { name, id });
        r = await bg({ type: "call_tool", name, arguments: { ...(args || {}), studio_id: id }, timeout, requestId });
      }
    }
    return r;
  }

  async function screenCaptureArgs(source, tool) {
    const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
    const known = Object.keys(props).length > 0;
    const clean = {};
    // `target`/`source` belong to OR's virtual wrapper, not the strict Studio
    // schema. Forward only parameters the live screen_capture tool advertises
    // (everything when the cached schema is empty — or-core's compact index).
    for (const [key, value] of Object.entries(source || {})) {
      if (key === "target" || key === "source") continue;
      if (!known || Object.prototype.hasOwnProperty.call(props, key)) clean[key] = value;
    }
    // ALWAYS carry a studio_id for screen_capture — the schema refuses the call
    // without one even when a single Studio is open (the one Studio tool that
    // does not infer it). Previously this only ran when the cached schema
    // advertised the parameter, so a stale/compact tool list produced
    // "Missing required arg" on every screenshot.
    if (!clean.studio_id) {
      const given = source && (source.studio_id || source.studioId);
      clean.studio_id = given || await resolveStudioId(false) || "";
      if (!clean.studio_id) delete clean.studio_id;
    }
    return clean;
  }

  // ── Public Skills (user-made commands) ──────────────────────────────────
  // Legacy name kept for older catalogues/tests: public_item_* → public_skill_*.
  function dispatchPublicItemTool(name, args) {
    return runPublicSkillTool(String(name || "").replace(/^public_item_?/, "public_skill_"), args);
  }
  function publicSkillUsage(item) {
    if (!item) return "";
    if (item.kind === "mode") return `Activate it from the OrScript menu (Work mode → ${item.title}) or with public_skill_enable {"name":"${item.name}","activate":true}.`;
    const ex = {};
    for (const p of item.params || []) ex[p.name] = p.default !== undefined ? p.default : p.enum && p.enum[0] ? p.enum[0] : p.type === "number" ? 1 : p.type === "boolean" ? true : p.type === "array" ? ["a"] : p.type === "object" ? {} : p.name;
    return `${item.name} ${JSON.stringify(ex)}`;
  }
  async function runPublicSkill(name, args) {
    const PS = typeof PublicSkills !== "undefined" ? PublicSkills : null;
    const item = PS && PS.find(name);
    if (!item) return `ERROR in ${name}: unknown public skill`;
    if (item.kind === "ability") {
      const r = PS.abilityText(item.id, args);
      if (r.err) return r.err;
      try { if (typeof window.__rsAfterTool === "function") window.__rsAfterTool(item.name, args, true, r.text); } catch {}
      return `Output of '${item.name}':\n${r.text}`;
    }
    const built = PS.buildLuau(item.id, args);
    if (built.err) return built.err;
    try { if (typeof window.__rsBeforeTool === "function") window.__rsBeforeTool(item.name, args); } catch {}
    let res = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
    if (typeof res === "string" && res.startsWith("Output of 'execute_luau':")) res = `Output of '${item.name}':` + res.slice("Output of 'execute_luau':".length);
    try {
      const body = String(res || "").replace(/^Output of '[^']*':\n?/, "").trim();
      if (/^\{/.test(body) && body.length < 20000) {
        const j = JSON.parse(body);
        if (j && j.ok === false) res = `ERROR in ${item.name}: ${String(j.error && typeof j.error === "object" ? (j.error.message || j.error.code || JSON.stringify(j.error)) : (j.error || "skill failed")).slice(0, 600)}\nThis public skill ran but reported the failure above. Check the arguments (${PS.signature(item)}), the target paths, or inspect it with public_skill_get {"name":"${item.name}"}.`;
      }
    } catch {}
    const ok = !String(res || "").startsWith("ERROR") && !String(res || "").includes("ERROR in execute_luau");
    try { if (typeof window.__rsAfterTool === "function") window.__rsAfterTool(item.name, args, ok, res); } catch {}
    return res;
  }
  async function runPublicSkillTool(name, args) {
    const PS = typeof PublicSkills !== "undefined" ? PublicSkills : null;
    if (!PS) return `ERROR in ${name}: Public Skills module is not loaded; reload this page.`;
    args = args && typeof args === "object" ? args : {};
    const out = (obj) => `Output of '${name}':\n${JSON.stringify(obj, null, 2)}`;
    const fail = (code, errors, extra) => `ERROR in ${name}: ${code}\n${(errors || []).map((e) => "- " + e).join("\n")}${extra ? "\n" + extra : ""}`;
    const reserved = () => { try { return typeof window.__rsBuiltinToolNames === "function" ? window.__rsBuiltinToolNames() : new Set(); } catch { return new Set(); } };
    const announce = (kind, item, warnings) => { try { window.dispatchEvent(new CustomEvent("or-public-skill-result", { detail: { kind, item, warnings: warnings || [] } })); } catch {} };
    const op = name.replace(/^public_skill_/, "");
    if (op === "create") {
      const def = args.definition && typeof args.definition === "object" ? args.definition : args;
      const r = PS.upsert(Object.assign({}, def, { id: undefined }), { source: "ai", reserved: reserved() });
      if (!r.ok) return fail("VALIDATION_FAILED", r.errors, "Fix the definition and call public_skill_create again. Schema reminder:\n" + PS.DEFINITION_DOC);
      refreshPublicSkillTools(); announce("created", r.item, r.warnings);
      return out({ success: true, status: "INSTALLED", kind: r.item.kind, name: r.item.name, id: r.item.id, version: r.item.version, usage: publicSkillUsage(r.item), warnings: r.warnings, next: r.item.kind === "skill" ? `Run public_skill_test {"name":"${r.item.name}"} to syntax-check it in Studio.` : r.item.kind === "mode" ? "The mode now appears in the Work mode section of the OrScript menu." : "The ability is callable right away." });
    }
    if (op === "list") {
      const rows = PS.list(args.kind ? { kind: args.kind } : null).map((i) => ({ kind: i.kind, name: i.name, title: i.title, enabled: i.enabled, version: i.version, author: i.author, signature: i.kind === "mode" ? `pm:${i.id}` : PS.signature(i), description: i.description }));
      const active = PS.activeMode();
      return out({ success: true, count: rows.length, activeMode: active ? active.name : null, items: rows, hint: rows.length ? "Call a skill/ability by its signature; modes are switched with public_skill_enable {name, activate:true}." : "Nothing installed yet - use public_skill_create or the Public tab in the OrScript panel." });
    }
    if (op === "get") { const item = PS.get(args.name || args.id); return item ? out({ success: true, item, signature: item.kind === "mode" ? null : PS.signature(item) }) : fail("NOT_FOUND", [`no public skill named '${args.name || args.id}'`]); }
    if (op === "update") {
      const r = PS.update(args.name || args.id, args.patch || args.definition || {}, { reserved: reserved() });
      if (!r.ok) return fail("UPDATE_FAILED", r.errors);
      refreshPublicSkillTools(); announce("updated", r.item, r.warnings);
      return out({ success: true, status: "UPDATED", name: r.item.name, version: r.item.version, warnings: r.warnings });
    }
    if (op === "delete") { const r = PS.remove(args.name || args.id); if (!r.ok) return fail("NOT_FOUND", r.errors); refreshPublicSkillTools(); announce("removed", r.item); return out({ success: true, status: "DELETED", name: r.item.name }); }
    if (op === "enable") {
      const on = args.enabled !== false;
      const r = PS.setEnabled(args.name || args.id, on);
      if (!r.ok) return fail("NOT_FOUND", r.errors);
      refreshPublicSkillTools();
      let activated = false;
      if (r.item.kind === "mode" && on && args.activate) { try { if (typeof window.__rsSetWorkMode === "function") { window.__rsSetWorkMode("pm:" + r.item.id); activated = true; } } catch {} }
      announce("toggled", r.item);
      return out({ success: true, name: r.item.name, enabled: r.item.enabled, activated });
    }
    if (op === "test") {
      const item = PS.find(args.name || args.id);
      if (!item) return fail("NOT_FOUND", [`no public skill named '${args.name || args.id}'`]);
      if (item.kind !== "skill") return out({ success: true, status: "NOT_APPLICABLE", note: `${item.kind}s have no Luau to test; call ${item.kind === "ability" ? PS.signature(item) : "public_skill_enable"} instead.` });
      if (args.dry_run === false) return await runPublicSkill(item.name, args.args || {});
      const built = PS.syntaxCheckLuau(item.id, args.args || {});
      if (built.err) return built.err;
      let res = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
      if (typeof res === "string") res = res.replace(/^Output of 'execute_luau':/, `Output of '${name}':`);
      return res;
    }
    if (op === "export") {
      const ref = String(args.name || args.id || "");
      if (/^(all|\*|everything)$/i.test(ref)) { const o = PS.exportPackObject(); if (!o) return fail("NOTHING_TO_EXPORT", ["no public skills installed"]); return out({ success: true, pack: true, count: o.count, fileName: PS.packFileName(), shareCode: PS.packShareCode(), json: o, howToShare: "Give the file or the share code to another OrScript user; they use Public tab → Import / Paste share code (or public_skill_import)." }); }
      const o = PS.exportObject(ref); if (!o) return fail("NOT_FOUND", [`no public skill named '${ref}'`]);
      return out({ success: true, fileName: PS.fileName(ref), shareCode: PS.shareCode(ref), json: o, howToShare: "Give the file or the share code to another OrScript user; they use Public tab → Import / Paste share code (or public_skill_import)." });
    }
    if (op === "import") {
      const r = PS.importShared(typeof args.data === "string" ? args.data : JSON.stringify(args.data || args.definition || {}), { reserved: reserved(), replace: !!args.replace });
      if (!r.ok) return fail("IMPORT_FAILED", r.errors && r.errors.length ? r.errors : [r.duplicate ? `'${r.duplicate.name}' is already installed - pass replace:true to overwrite` : "nothing imported"]);
      refreshPublicSkillTools();
      if (r.pack) { for (const it of r.installed) announce("imported", it, []); return out({ success: true, status: "INSTALLED", pack: true, installed: r.installed.map((i) => ({ kind: i.kind, name: i.name, usage: publicSkillUsage(i) })), skipped: r.skipped, errors: r.errors, warnings: r.warnings }); }
      announce("imported", r.item, r.warnings);
      return out({ success: true, status: "INSTALLED", kind: r.item.kind, name: r.item.name, usage: publicSkillUsage(r.item), warnings: r.warnings });
    }
    if (op === "from_prompt") {
      const text = String(args.prompt || args.text || args.data || "");
      const r = PS.installFromPrompt(text, { kind: args.kind, title: args.title, name: args.name, description: args.description, reserved: reserved(), source: "ai" });
      if (!r.ok) return fail("CONVERSION_FAILED", r.errors, "Pass the full prompt text in {prompt}; optional kind (skill|ability|mode), title, name. Or design it yourself with public_skill_create.");
      refreshPublicSkillTools(); announce("created", r.item, r.warnings);
      return out({ success: true, status: "INSTALLED", kind: r.item.kind, name: r.item.name, id: r.item.id, usage: publicSkillUsage(r.item), warnings: r.warnings, note: "The prompt was stored verbatim (no redesign). Refine fields with public_skill_update {name, patch} if the user wants params, Luau or a tighter mandate." });
    }
    if (op === "run") { const item = PS.find(args.name || args.id); if (!item) return fail("NOT_FOUND", [`no public skill named '${args.name || args.id}'`]); return await runPublicSkill(item.name, args.args || {}); }
    return fail("UNKNOWN_OPERATION", [`'${name}' is not a public_skill command`], "Available: public_skill_create/from_prompt/list/get/update/delete/enable/test/export/import.");
  }

  async function runTool(call) {
    let name = call.tool;
    let args = call.arguments || {};
    if (!name) return RS.FEEDBACK.parseError("malformed");
    try { name = remapToolName(name); } catch {}
    const roadmapName = bareToolName(name);
    if (roadmapName.startsWith("public_item")) return typeof dispatchPublicItemTool === "function" ? dispatchPublicItemTool(roadmapName, args) : `ERROR: '${roadmapName}' is not available in this build. Use list_commands and continue with the listed commands.`;
    if (roadmapName.startsWith("public_skill_")) return await runPublicSkillTool(roadmapName, args);
    if (/^task_(list|next|add|update)$/.test(roadmapName) && typeof ORTaskList !== "undefined") {
      const r = ORTaskList.run(roadmapName, args);
      try { if (typeof window.__rsAfterTool === "function") window.__rsAfterTool(roadmapName, args, !String(r).startsWith("ERROR"), r); } catch {}
      return r;
    }
    if (typeof PublicSkills !== "undefined" && PublicSkills.isCommand(roadmapName)) return await runPublicSkill(roadmapName, args);
    if(roadmapName==="orscript_help"){
      const question=String(args.question||"").toLowerCase(),aliases={tasklist:/task list|tasklist|checklist|to-do|todo list|my tasks|next task/,templates:/template|reusable|library|save/,roadmap:/roadmap|plan|phase|task|progress/,commands:/command|tool|registry|what can/,studio:/studio|roblox|mcp|plugin|connect/,workmode:/work mode|ultimate mode|visualizer|animator mode|fast mode|balanced mode|thorough mode/,projectindex:/project index|project map|codebase|architecture|index the (place|project|game)|require graph|dependency graph|who requires|what requires|which script (fires|handles)|stale index|project_index|code map|conventions/,projects:/project|rbxl|upload|reference|analy/,themes:/theme|skin|void|appearance/,permissions:/permission|sandbox|full access|safety|confirm/,providers:/provider|model|chatgpt|claude|deepseek|minimax|arena/,troubleshooting:/error|broken|fail|stuck|repair|timeout|not start/,plugins:/other plugin|plugins|eclipse|moon animator|interop|full control|macro|settings\(\)/,publicskills:/public skill|own skill|own command|custom command|custom mode|own mode|make a skill|create a skill|new skill|ability|share code|orskill/,design:/design token|design pack|ui kit|uikit|screengui|gui gen|generate (a |the )?(gui|ui|menu|hud|shop|inventory)|main menu|hud|shop ui|inventory ui|settings screen|leaderboard ui|daily reward|quest log|loading screen|dialog box|responsive|ui audit|ui_from_spec|ui_screen_generate/,gfx:/thumbnail|game icon|gfx|render (a |the )?(thumbnail|icon)|cover art|key art|promo (image|art)|gfx_/,blueprints:/blueprint|complete system|game system|starter system|pet system|shop system|currency system|tycoon|anticheat|anti-cheat|admin command|round system|checkpoint system|quest system|leaderboard system|sprint system|data ?store profile/};let topic=String(args.topic||"").toLowerCase();if(!FEATURE_HELP_TOPICS[topic])topic=Object.keys(aliases).find(k=>aliases[k].test(question))||"";if(!topic)return `Output of 'orscript_help':\n${JSON.stringify({success:true,message:"Ask about any OrScript feature.",topics:Object.entries(FEATURE_HELP_TOPICS).map(([id,x])=>({id,title:x.title,summary:x.summary}))},null,2)}`;const help=FEATURE_HELP_TOPICS[topic];return `Output of 'orscript_help':\n${JSON.stringify({success:true,topic,...help,agentStarted:false,executedCommands:false},null,2)}`;
    }
    if (["search_commands","get_command","command_registry_stats","generate_command_docs","orscript_help"].includes(roadmapName)) {
      const reg=typeof ORCommandRegistry!=="undefined"?ORCommandRegistry:null;if(!reg)return `ERROR in ${roadmapName}: command registry unavailable; reload this page.`;await hydrateCommandRegistry();
      if(roadmapName==="search_commands"){const found=reg.search(args.query||"",{environment:args.environment,limit:args.limit||25});return `Output of 'search_commands':\n`+JSON.stringify({ok:true,count:found.length,commands:found.map((c)=>({id:c.id,name:c.name,description:c.description,category:c.category,environment:c.environment,aliases:c.aliases}))},null,2);}
      if(roadmapName==="get_command"){const c=reg.get(args.command_id||args.id||args.name);return c?`Output of 'get_command':\n`+JSON.stringify({ok:true,command:c},(k,v)=>typeof v==="function"?undefined:v,2):`ERROR in get_command: unknown command '${args.command_id||args.id||args.name||""}'.`;}
      if(roadmapName==="command_registry_stats")return `Output of 'command_registry_stats':\n`+JSON.stringify({ok:true,...reg.stats()},null,2);
      const category=String(args.category||"");const docs=category?reg.list(category).map((c)=>({id:c.id,description:c.description,category:c.category,environment:c.environment,parameters:c.parameters,examples:c.examples})):reg.docs();return `Output of 'generate_command_docs':\n`+(typeof docs==="string"?docs:JSON.stringify({ok:true,commands:docs},null,2));
    }
    if(roadmapName.startsWith("project.")){const op=roadmapName.split(".").pop(),arg=args.query??args.name;const r=globalThis.ORProjectAnalyzer?ORProjectAnalyzer.query(op,arg):{success:false,error:{code:"PROJECT_INDEX_FAILED",message:"Project index unavailable"}};return `${r.success?"Output":"ERROR"} of '${roadmapName}':\n${JSON.stringify(r,null,2)}`;}
    if(roadmapName.startsWith("mcp.")){const r=await bg({type:roadmapName,debug:!!args.debug});return `${r&&r.success?"Output":"ERROR"} of '${roadmapName}':\n${JSON.stringify(r,null,2)}`;}
    if(roadmapName==="chatgpt.status"||roadmapName==="chatgpt.healthCheck"){const mcp=await bg({type:"mcp.healthCheck",debug:!!args.debug});const r={success:true,provider:P.id,chatgptDetected:P.id==="chatgpt",orscriptInitialized:globalThis.__orscriptMainInitialized===true,agentState:A.lifecycle,agentReady:A.lifecycle==="READY"||A.lifecycle==="RUNNING",responseDetectorReady:providerHooksReady,mcpConnected:!!mcp.connected,mcpState:mcp.state,mcpTools:mcp.capabilities&&mcp.capabilities.tools||0,requestId:A.activeRequestId,timings:args.debug?_diag.filter(x=>/^(request|response|tool|start|provider)/.test(x.event)).slice(-30):undefined};return `Output of '${roadmapName}':\n${JSON.stringify(r,null,2)}`;}
    if(["template_create_draft","template_propose_improvement","template_test_result"].includes(roadmapName)){
      const detail={kind:roadmapName,...args};window.dispatchEvent(new CustomEvent("or-template-ai-result",{detail}));return `Output of '${roadmapName}':\n${JSON.stringify({success:true,status:"USER_REVIEW_REQUIRED",saved:false},null,2)}`;
    }
    if(roadmapName.startsWith("creator.")){
      if(roadmapName==="creator.getGamePass"||roadmapName==="creator.getPublishedAsset"){const id=Number(args.assetId||0);if(!Number.isInteger(id)||id<1)return `ERROR INVALID_PARAMETER: assetId must be a positive integer`;const r=await bg({type:"creator_asset_info",assetId:id});return `${r&&r.success?"Output":"ERROR"} of '${roadmapName}':\n${JSON.stringify(r,null,2)}`;}
      if(roadmapName==="creator.getPublishStatus"||roadmapName==="creator.validatePublish"){const state=await runTool({tool:"get_studio_state",arguments:{}});return `Output of '${roadmapName}':\n${JSON.stringify({success:!String(state).startsWith("ERROR"),operation:roadmapName,status:state},null,2)}`;}
      if(roadmapName==="creator.createGamePass")return await createGamePass({...args,universe_id:args.universeId||args.universe_id});
      if(roadmapName==="creator.updateGamePass")return await updateGamePass({...args,gamepass_id:args.assetId||args.gamepass_id});
      const confirmed=await requestApproval(roadmapName,{...args,warning:"This publishing workflow modifies Roblox cloud content and requires Roblox ownership, authentication, moderation, and final confirmation."},true);if(!confirmed)return `ERROR USER_ACTION_REQUIRED: publishing was not confirmed; no cloud operation ran.`;
      const action=roadmapName==="creator.publishPlace"?"In Roblox Studio, use File > Publish to Roblox and confirm the target place.":roadmapName==="creator.publishAnimation"?"Open the Animation Editor for the target rig, choose Publish to Roblox, review ownership, and confirm. Return the asset ID only after Studio displays it.":roadmapName==="creator.createGamePass"?`Open Creator Dashboard > Creations > Experiences > Passes, select universe ${args.universeId||"the current experience"}, and create '${String(args.name||"").slice(0,100)}'.`:"Open Creator Dashboard for this pass, review the requested changes, and confirm them.";
      return `ERROR USER_ACTION_REQUIRED: ${action}`;
    }
    // NEVER execute while the AI tab is backgrounded/minimized. This is the single
    // choke point for ALL execution (agentLoop's tool dispatch AND the bootstrap's
    // list_commands), so it closes the hole the loop-entry gate alone left open:
    // the tab is foreground when a cycle starts, the model then generates for
    // 30-120s, the user minimizes MID-generation, and waitForResponse returns a
    // tool call that fired into Studio off-screen (observed live: GLM minimized
    // still ran execute_luau). Parking here (no time cap) means the call runs the
    // moment the tab is foreground again, instead of being lost or run blind.
    if (document.hidden && !A.stop) {
      diag("tool.waitVisible", { name });
      // Only reachable via a user Stop while parked; agentLoop's post-runTool
      // A.stop check breaks the loop and discards this, so it just needs to be
      // a non-crashing, clearly-labelled string.
      if (!(await waitVisible()) || A.stop) return "ERROR: the command was not run - stopped by the user.";
    }
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (VISION_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    if (permMode !== "full" && /^(process_kill)$/.test(bareName)) {
      return `ERROR: '${bareName}' needs Full PC access. Switch Permissions to Full in the OR menu, or stay in Sandbox.`;
    }
    // Internal sub-calls (a skill's own execute_luau, chunk pieces, or_debug
    // probes) inherit the approval of the command the model actually asked for:
    // get_studio_state is read-only and must never pop an execute_luau prompt.
    const internalCall = !!(args && (args._orInternal || args._orChunk));
    if (!internalCall && PUBLISH_OPS.has(bareName) && !(await publishAutomationEnabled())) {
      const ok=await requestApproval(bareName,{...args,warning:"Publishing will modify a Roblox cloud resource and remains subject to Roblox ownership, moderation, permissions, and rate limits."},true);
      if(!ok)return approvalTimedOut() ? `ERROR USER_ACTION_REQUIRED in ${bareName}: the user did not answer the publish confirmation within ${Math.round(APPROVAL_TIMEOUT_MS / 1000)} s, so nothing was published. Stop and ask the user to confirm in the OR bar (or enable publish automation), then continue.` : `ERROR USER_ACTION_REQUIRED in ${bareName}: publishing was not confirmed. Nothing was published.`;
    } else if (!internalCall && permMode === "ask" && ASK_OPS.has(bareName)) {
      const ok = await requestApproval(bareName, args);
      if (!ok) return approvalTimedOut() ? `ERROR USER_ACTION_REQUIRED in ${bareName}: the user did not answer the Ask-mode approval prompt within ${Math.round(APPROVAL_TIMEOUT_MS / 1000)} s, so the command did NOT run. Stop here and tell the user to click Allow in the OR bar (or switch Permissions to Sandbox), then continue when they reply.` : `ERROR in ${bareName}: the user declined this action (Ask mode). Do not retry unless they ask.`;
    }
    // Multi-Agent role guard: planner / reviewer / tester are read-only. The
    // crew module refuses the mutation with a handoff recipe (and auto-promotes
    // after the second attempt so the loop can never dead-lock).
    try {
      if (typeof ORAgentCrew !== "undefined" && ORAgentCrew && ORAgentCrew.active()) {
        const guarded = ORAgentCrew.guard(bareName, args);
        if (guarded) { diag("tool.roleGuard", { name: bareName, role: ORAgentCrew.role() }); return guarded; }
      }
    } catch {}
    // Web tools — bridge-level, no Studio needed. Uses background fetch so it works
    // even when Studio is offline.
    if (bareName === "web_fetch" || bareName === "web_search") {
      let payload = { type: bareName, ...args };
      if (bareName === "web_fetch" && !payload.url && (payload.query || payload.q)) {
        payload = { type: "web_fetch", query: payload.query || payload.q, max_chars: payload.max_chars };
      }
      const r = await bg(payload);
      if (r && r.ok) return `Output of '${name}':\n${r.text}`;
      return `ERROR in ${name}: ${(r && r.error) || "fetch failed"}\nTry a different URL/query.`;
    }
    if (bareName === "api_request" || bareName === "web_api" || bareName === "api_json_get" || bareName === "api_json_post") {
      let url = args.url || args.endpoint;
      let method = (args.method || (bareName === "api_json_post" ? "POST" : "GET")).toUpperCase();
      let body = args.body || args.data;
      let headers = args.headers || {};
      let max_chars = args.max_chars || 16000;

      if (!url) return `ERROR in ${name}: url parameter is required (e.g. "https://api.example.com/data")`;

      try {
        const r = await bg({ type: "api_request", url, method, body, headers, max_chars });
        if (!r) return `ERROR in ${name}: Web API request timed out or returned empty response.`;
        if (r.ok === false && !r.status) return `ERROR in ${name}: Web API request failed — ${r.error || "Network error"}`;

        let summary = `Web API [${r.method}] ${r.url}\nStatus: ${r.status} ${r.statusText || ""}\n`;
        if (r.isJson && r.data) {
          summary += `Data:\n` + JSON.stringify(r.data, null, 2);
        } else {
          summary += `Response Body:\n` + r.text;
        }
        return `Output of '${name}':\n${summary.slice(0, 16000)}`;
      } catch (e) {
        return `ERROR in ${name}: Web API request failed — ${String(e && e.message || e)}`;
      }
    }
    if (bareName === "developer_product_create" || bareName === "devproduct_create") {
      return await createDeveloperProduct(args);
    }
    if (bareName === "developer_product_list" || bareName === "devproduct_list") {
      return await listDeveloperProducts(args);
    }
    if (STUDIO_PLUGIN_SET.has(bareName) && !pluginToolAvailable(bareName)) {
      if (/^cloud_/.test(bareName)) return "ERROR: '" + bareName + "' needs an Open Cloud API key in or-core (paste it in Studio → Plugins → ORscript → Open Cloud API key, or start or-core with OR_OPEN_CLOUD_KEY). Browser-session alternatives: gamepass_create / gamepass_list / developer_product_create.";
      return "ERROR: '" + bareName + "' - " + PLUGIN_HOWTO;
    }
    if (bareName === "gamepass_create") return await createGamePass(args);
    if (bareName === "gamepass_list") return await listGamePasses(args);
    if (bareName === "gamepass_update") return await updateGamePass(args);
    // Virtual command: list the MCP server(s) RobloxScript is currently connected
    // to, with each one's REAL per-server health (from the bridge, never the
    // merged tool count - a dead server must not borrow another's numbers).
    if (name === "list_mcp_servers") {
      await ensureTools();
      const curEng2 = activeEngine();
      const servers = (A.bridge && A.bridge.servers) || [];
        const engName = (e) => e === "local" ? "AgentScript workspace" : "Roblox Studio";
      const lines = servers.length
        ? servers.map((sv) => {
            const isPrimary = sv.id === curEng2;
            const label = isPrimary ?  `${engName(curEng2)} (primary)` : `${sv.id} (addon)`;
            return `- ${sv.id}: ${label} - ${sv.alive ?  `${sv.tools || 0} commands available` : "offline (no tools)"}`;
          })
        : [`- ${curEng2}: ${engName(curEng2)} (primary) - unknown (bridge did not report server health)`];
      return (
        `Output of 'list_mcp_servers':\n` +
        `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
        `Use list_commands with a "server" param (one of the ids above) to see that server's exact commands. Without "server", list_commands defaults to "${curEng2}".`
      );
    }
    // Virtual command: list available commands with full details. Defaults to
    // the primary server for the *current* engine — Roblox when RS/AN, AgentScript when AS.
    // A DIFFERENT server's tools only show up if the model asks via {"server": "<id>"}.
        if (name === "or_screenshot" || name === "screenshot" || name === "or_capture") {
      if (typeof ORScreenshot === "undefined") return "ERROR: screenshot module missing — reload the extension.";
      const bridge = A.bridge || {};
      const rbxServer = (bridge.servers || []).find((s) => s && (s.id === "roblox" || s.id === "studio"));
      const screenTool = studioToolByBare("screen_capture") || studioCaptureTool();
      // `connected` means the browser reached or-core, not that Studio itself is
      // online. Prefer editor-specific status, but a freshly fetched native tool
      // is also enough to attempt capture while a status push is still in flight.
      const studioOn = bridge.roblox_connected === true || bridge.studio === true
        || !!(rbxServer && rbxServer.alive === true) || !!screenTool;
      const captureStudio = async () => {
        if (!screenTool) return { ok: false, error: "Studio MCP does not expose screen_capture; update Studio and restart or-core" };
        const callArgs = await screenCaptureArgs(args, screenTool);
        return callStudioToolWithId(screenTool.name, callArgs, 90000, A.activeRequestId);
      };
      const result = await ORScreenshot.run(args, {
        studio: studioOn ? captureStudio : null,
        blender: bridge.blender ? async () => bg({ type: "call_tool", name: "get_viewport_screenshot", arguments: {max_size:Number(args.max_size)||1000}, timeout: 30000 }) : null,
      });
      if (result.images && result.images.length) {
        try { ui.showImages(result.images, "or_screenshot"); } catch {}
        A.pendingImages = result.images;
      }
      return result.text;
    }
        if (name === "http_get") {
      let url = String(args.url || args.href || "").trim();
      const q = String(args.query || args.q || args.path || args.page || "").trim();
      if (!url && q) url = /^https?:/i.test(q) ? q : ("https://create.roblox.com/docs/reference/engine/" + encodeURIComponent(q.replace(/\s+/g, "/")));
      if (!url) return "ERROR: http_get needs url or query (Roblox Engine API / docs).";
      if (!/^https?:/i.test(url)) url = "https://create.roblox.com/docs/" + url.replace(/^\/+/, "");
      try {
        const r = await bg({ type: "web_fetch", url: url, max_chars: Math.min(12000, Number(args.max_chars) || 8000) });
        const body = (r && (r.text || r.body || r.error)) || "";
        if (r && r.ok === false) return "ERROR: http_get " + String(r.error || body).slice(0, 400);
        return "Output of 'http_get':\n" + url + "\n" + String(body).slice(0, 8000);
      } catch (e) {
        return "ERROR: http_get " + String(e && e.message || e);
      }
    }
    if (name === "skill") {
      const key = String(args.name || args.id || args.topic || args.q || "debug").toLowerCase();
      const packs = {
        debug: "Studio debug: read Output via or_debug / get_console_output. Fix the FIRST error only. Prefer script_analysis, then the smallest script_set_source / set_property. WaitForChild needs a timeout. Never loadstring.",
        remotes: "Remotes: RemoteEvent/Function under ReplicatedStorage. Server OnServerEvent validates. Client FireServer. Never trust the client for currency or damage.",
        pathfinding: "PathfindingService waypoints. Humanoid MoveTo each. character_navigation wraps MoveTo.",
        datastore: "DataStoreService:GetDataStore(name). pcall GetAsync/SetAsync. UpdateAsync for races. API Services must be on in Studio.",
        ui: "ScreenGui in StarterGui. Scale not offset. Named instances. Default grey Frames are not finished art.",
        physics: "Anchored skips simulation. PhysicsService collision groups. Debris:AddItem for timed cleanup.",
        tween: "TweenService:Create(inst, TweenInfo.new(t), props):Play(). Set a ChangeHistoryService waypoint first.",
        general: "Build objects first, then scripts that WaitForChild them. inspect_instance / search_game_tree before guessing paths. One command per turn."
      };
      const hit = packs[key] || packs.debug;
      for (const k of Object.keys(packs)) { if (key.indexOf(k) >= 0) { return "Output of 'skill':\n" + k + "\n" + packs[k]; } }
      return "Output of 'skill':\n" + (key || "debug") + "\n" + hit;
    }
    if (name === "list_templates" || name === "get_templates") {
      const rows = (typeof ORTemplates !== "undefined") ? ORTemplates.list() : [];
      return "Output of 'list_templates':\n" + rows.map((t) => t.id + " — " + t.title + ": " + t.blurb).join("\n") + "\nget_template {name} searches the open place (then Creator Store) and CLONES a match into Workspace.";
    }
    if (name === "get_template" || name === "template") {
      const id = String(args.name || args.id || args.template || args.query || args.q || "").trim();
      if (!id) return "ERROR: get_template needs {name} — a Studio instance name, catalog keyword, or hud/shop/tool/door/obby.";
      if (typeof RobloxScriptSkills !== "undefined" && RobloxScriptSkills.buildLuau) {
        try {
          const built = RobloxScriptSkills.buildLuau("get_template", { query: id, name: id });
          if (built && built.code) {
            const res = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
            const s = String(res || "");
            if (s && !s.startsWith("ERROR") && !/no template|not found/i.test(s)) return s;
          }
        } catch (e) {}
      }
      try {
        const r = await runTool({ tool: "search_creator_store", arguments: { query: id, limit: 5 } });
        const m = String(r || "").match(/\b(\d{6,})\b/);
        if (m) {
          const ins = await runTool({ tool: "insert_from_creator_store", arguments: { assetId: Number(m[1]), name: id } });
          return "Output of 'get_template': searched Creator Store for '" + id + "' and copied asset " + m[1] + ".\n" + String(ins || "");
        }
      } catch (e) {}
      if (typeof ORTemplates !== "undefined") {
        const t = ORTemplates.get(id);
        if (t) return "Output of 'get_template': nothing to copy in the place/catalog. Build-brief '" + t.id + "':\n" + t.brief + "\nCommands: " + t.commands + "\n" + (t.body || "");
      }
      return "ERROR: get_template found nothing named '" + id + "'. Try search_game_tree or search_creator_store.";
    }
    if (name === "or_debug" || name === "debug_run" || name === "debug_console") {
      const code = [
        "local hs=game:GetService(\"HttpService\")",
        "local hist={}",
        "pcall(function() hist=game:GetService(\"LogService\"):GetLogHistory() end)",
        "local err,warn,info={},{},{}",
        "for i=math.max(1,#hist-80),#hist do",
        " local e=hist[i]",
        " if e then",
        "  local m=tostring(e.message or \"\")",
        "  if not m:find(\"Assistant plugin version changed\",1,true) and not m:find(\"sabuiltin_Assistant\",1,true) and not m:find(\"OR \",1,true) then",
        "   local t=tostring(e.messageType or e.Type or \"\")",
        "   local row={t=t,m=m:sub(1,220)}",
        "   if t:find(\"Error\") or t==\"3\" then err[#err+1]=row elseif t:find(\"Warning\") or t==\"2\" then warn[#warn+1]=row else if #info<8 then info[#info+1]=row end end",
        "  end",
        " end",
        "end",
        "return hs:JSONEncode({errors=err,warnings=warn,info=info,errorCount=#err,warningCount=#warn})",
      ].join("\n");
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 12000 });
      let raw = r && r.ok ? String(r.text || "") : ("ERROR: " + String((r && r.error) || "Studio log unavailable"));
      raw = stripStudioNoise(raw);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      if (!parsed) { try { const m = raw.match(/\{[\s\S]*\}$/); if (m) parsed = JSON.parse(m[0]); } catch {} }
      if (parsed && Array.isArray(parsed.errors)) {
        const errs = parsed.errors.map((e) => String(e.m || e)).slice(-12);
        const warns = (parsed.warnings || []).map((e) => String(e.m || e)).slice(-6);
        if (!errs.length) {
          return "Output of 'or_debug':\\nOutput is clean (no errors)." + (warns.length ? ("\\nWarnings:\\n- " + warns.join("\\n- ")) : "") + "\\nContinue building.";
        }
        return "Output of 'or_debug':\\n" + errs.length + " error(s):\\n- " + errs.join("\\n- ") + (warns.length ? ("\\nWarnings:\\n- " + warns.join("\\n- ")) : "") + "\\nNEXT: fix the FIRST error only with the smallest command (script_analysis / script_set_source / set_property). Then or_debug again.";
      }
      return "Output of 'or_debug':\\n" + raw.slice(0, 4000) + "\\nIf there are errors, fix the first one with the smallest command.";
    }

    if (name === "or_agent" || name === "multi_agent") {
      // Agent Crew (src/core/agent_crew.js): shared board, role guard,
      // completion gate. The inline briefs below are only the fallback when
      // the module failed to load.
      if (typeof ORAgentCrew !== "undefined" && ORAgentCrew && typeof ORAgentCrew.handoff === "function") {
        const out = ORAgentCrew.handoff(args);
        A.agentRole = ORAgentCrew.role() || "";
        try { if (typeof window.__rsSyncCrewBadge === "function") window.__rsSyncCrewBadge(); } catch {}
        return out;
      }
      const role = String(args.role || args.agent || "builder").toLowerCase();
      const task = String(args.task || args.prompt || args.goal || "").slice(0, 2000);
      A.agentRole = role;
      const briefs = {
        planner: "You are the PLANNER agent. Do NOT run mutating Studio commands this turn. Restate the user request as GOAL + implied systems, write a short numbered plan that ships a finished creation, then call or_agent {role:\"builder\", task:\"...\"}.",
        builder: "You are the BUILDER agent. Execute ONE Studio command that advances a finished, styled creation (not a stub). After it succeeds, call or_agent {role:\"reviewer\", task:\"verify\"} if Multi-Agent is on.",
        reviewer: "You are the REVIEWER agent. Use read-only commands (inspect, script_analysis, or_debug). List bugs. Then call or_agent {role:\"debugger\", task:\"...\"} if something is broken, else stop.",
        debugger: "You are the DEBUGGER agent. Read console via or_debug, then apply the smallest fix. Do not expand scope.",
      };
      const brief = briefs[role] || briefs.builder;
      return "Output of 'or_agent':\nROLE=" + role + "\n" + brief + "\nTASK: " + (task || "(continue the user's request)") + "\nReply as this agent only. ONE command.";
    }
    if (name === "or_status" || name === "status") {
      let extra = false, plan = false, lvl = "default", wm = "ultimate", perm = "sandbox", autoDbg = true, multi = false;
      try { extra = !!(window.__rsExtraThinking && window.__rsExtraThinking()); } catch {}
      try { plan = !!(window.__rsPlanMode && window.__rsPlanMode()); } catch {}
      try { autoDbg = !(window.__rsAutoDebug) || window.__rsAutoDebug() !== false; } catch {}
      try { multi = !!(window.__rsMultiAgent && window.__rsMultiAgent()); } catch {}
      try { lvl = (window.__rsThinkingLevel && window.__rsThinkingLevel()) || "default"; } catch {}
      try { wm = (window.__rsWorkMode && window.__rsWorkMode()) || "ultimate"; } catch {}
      try { perm = (window.__rsPermMode && window.__rsPermMode()) || "sandbox"; } catch {}
      const bridge = A.bridge || {};
      const info = {
        engine: activeEngine() === "local" ? "agentscript" : "robloxscript",
        browser: USER_BROWSER,
        work_mode: wm,
        extra_thinking: extra,
        plan_mode: plan,
        auto_debug: autoDbg,
        multi_agent: multi,
        agent_role: A.agentRole || "",
        crew: (typeof ORAgentCrew !== "undefined" && ORAgentCrew && multi) ? ORAgentCrew.summary() : undefined,
        thinking_level: lvl,
        permissions: perm,
        bridge_connected: bridge.connected === true,
        studio_connected: bridge.connected === true && bridge.roblox_connected === true,
        blender: !!bridge.blender,
        tools: A.toolList.length || 0,
        agent_started: !!A.started,
        agent_running: !!A.running,
      };
      return "Output of 'or_status':\n" + JSON.stringify(info, null, 2);
    }
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      if(args.category&&typeof ORCommandRegistry!=="undefined"){const rows=ORCommandRegistry.list(String(args.category),args.environment);return `Output of '${name}':\n`+JSON.stringify({ok:true,category:args.category,count:rows.length,commands:rows.map((c)=>({id:c.id,description:c.description,environment:c.environment,parameters:c.parameters}))},null,2);}
      const curEng = activeEngine();
      const requested = (args.server || curEng).trim().toLowerCase();
      const broadCatalogueRequest = !String(args.query || args.search || "").trim();
      // The first broad catalogue request is the bootstrap truth test. Probe the
      // editor now instead of trusting a periodic status tick or cached schemas.
      if (requested === curEng && curEng !== "local" && broadCatalogueRequest) {
        await refreshCurrentEngineState();
      }
      // The proxy keeps advertising a catalogue even with no engine attached.
      // When the DEFAULT engine's bridge is actually unusable, short-circuit into
      // a plain offline note so the model doesn't fire dead commands.
      if (requested === curEng) {
        const s = A.bridge || {};
        const srv = s.servers || [];
        if (curEng === "local") {
          const local = srv.find((x) => x.id === "local");
          const usable = !!s.connected && (
            s.local_connected === true ||
            (local && local.alive) ||
            A.toolList.length > 0
          );
          if (!usable) {
            return `Output of '${name}':\nAgentScript is currently OFFLINE (the native agent process is not running), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to start bin/or-core.exe.`;
          }
        } else if (curEng !== "local") {
          const rbx = srv.find((x) => x.id === "roblox" || x.id === "studio");
          // A cached/proxied catalogue proves only that OR knows command schemas;
          // it does NOT prove that the editor is connected. The old
          // `A.toolList.length > 0` fallback turned an explicitly disconnected
          // and left bootstrap sitting on Starting. Prefer editor-specific truth;
          // use mcpAlive only for legacy bridges that expose no editor fields.
          const explicitEditorState = typeof s.roblox_connected === "boolean"
            || typeof s.studio === "boolean" || !!rbx;
          const rbxUsable = !!s.connected && (
            s.roblox_connected === true ||
            s.studio === true ||
            !!(rbx && rbx.alive === true) ||
            (!explicitEditorState && s.mcpAlive === true)
          );
          if (!rbxUsable) {
            const others = srv.filter((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
            const otherStr = others.length
              ? `Other connected MCP server(s): ${others.map((x) => x.id).join(", ")}. Call list_mcp_servers, then list_commands with a "server" param to use them for anything that does not need Roblox.`
              : `No other MCP server is connected right now.`;
            return `Output of '${name}':\nRoblox Studio is currently OFFLINE (closed, no place open, or its MCP server disabled), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to open their place in Roblox Studio and enable its MCP server. ${otherStr}`;
          }
        }
      }
      const known = new Set(A.toolList.map((t) => t.server).filter(Boolean));
      // Tools from a bridge that doesn't tag "server" yet have no .server field;
      // treat them as the current engine's server rather than hard-coding roblox.
      const commandQuery = String(args.query || args.search || "").trim().toLowerCase();
      // Hidden entries (legacy aliases, duplicate setters) stay callable but are
      // only listed when asked for by exact name.
      const allScoped = A.toolList.filter((t) => (t.server || curEng) === requested && (!t.hidden || String(t.name || "").toLowerCase() === commandQuery));
      const queryTerms = commandQuery.split(/\s+/).filter(Boolean);
      const queryMatches = (value) => !queryTerms.length
        || queryTerms.every((term) => String(value || "").toLowerCase().includes(term));
      const exactScoped = commandQuery
        ? allScoped.filter((t) => String(t.name || "").toLowerCase() === commandQuery)
        : [];
      let scoped = commandQuery
        ? (exactScoped.length ? exactScoped : allScoped.filter((t) => queryMatches(`${t.name || ""} ${t.description || ""}`)))
        : allScoped;
      if (!A.toolList.length) return `Output of '${name}':\nNo commands available - the bridge or ${curEng==="local" ? "the AgentScript agent" : "Roblox Studio"} may be offline.`;
      if (!allScoped.length) {
        return `Output of '${name}':\nERROR: no server named "${requested}" is connected. Connected servers: ${[...known].join(", ") || curEng}. Call list_mcp_servers to check.`;
      }
      let lines = scoped.map(toolDetailLine);
      let animLines = requested === "roblox" ? RSAnim.describeCommands() : [];
      let skillLines = (requested === "roblox" && typeof RobloxScriptSkills !== "undefined") ? RobloxScriptSkills.describeCommands({ includeHidden: !!commandQuery }) : [];
      const hiddenSkillNames = (requested === "roblox" && typeof RobloxScriptSkills !== "undefined" && RobloxScriptSkills.hiddenCommandNames) ? RobloxScriptSkills.hiddenCommandNames() : new Set();
      let agentLines = (requested === "local" && typeof AgentScriptSkills !== "undefined") ? AgentScriptSkills.describeCommands() : [];
      let webLines = [`— Screenshot: or_screenshot {target?: auto|studio|game|viewport|blender|tab} — PHOTO of the real Studio/game viewport when MCP is on. Use target:studio or game for gameplay; target:tab is only for this browser chat. A failed Studio capture returns an error and NEVER substitutes the browser. NOT capture_id (IDs only).`, `— Debugger: or_debug {} — classified Output errors + NEXT fix. Automatic Debugger appends new errors after edits.`, `— Templates: get_template {name} searches the place then Creator Store and CLONES a match.`, `— OR Status: or_status {} — live engine, work mode, extra thinking, bridge, blender. Call this if you are unsure which mode you are in.`, `— Web Tools (bridge-level, no Studio needed): web_fetch {url?, query?, max_chars?} — fetch a URL, OR pass query to search the web then fetch the top result; web_search {query, limit?} — DuckDuckGo titles+URLs`, `— IDs (not a photo): capture_id {path?} — UniqueId + MeshId/Image/SoundId/AnimationId from the Studio selection. For a PHOTO use or_screenshot.`, `— Screenshot: or_screenshot {target?: auto|studio|game|viewport|tab|blender} — capture Studio/game through MCP and attach it to the next message. Use tab only for the browser. Aliases: screenshot, take_screenshot, send_screenshot.`, `— Debugger: or_debug {} — Studio LogService errors/warnings. Automatic Debugger (Settings) appends new errors after mutating commands.`, `— Multi-Agent: or_agent {role: planner|builder|scripter|reviewer|tester|debugger|done, task?, goal?, plan?:[...], step?, step_done?, findings?:[...], fixed?:[...], summary?} — hand off to a specialist on a shared board (plan, findings, verification). Read-only roles are guarded; done is refused until the tester verified. Enable Multi-Agent in Settings.`, `— Developer Products: developer_product_create {name, price, description?, reward?} — create a real Roblox Developer Product on this published universe (sign into roblox.com in Chrome). developer_product_list {} lists them. Aliases: create_developer_product, create_dev_product.`];
      if (commandQuery) {
        const exactLine = (line) => {
          const match = String(line).match(/^\s*([A-Za-z_][\w.-]*)\s*[:({]/);
          return !!match && match[1].toLowerCase() === commandQuery;
        };
        const exactAnim = animLines.filter(exactLine);
        const exactSkills = skillLines.filter(exactLine);
        const exactAgent = agentLines.filter(exactLine);
        const exactVirtual = exactAnim.length + exactSkills.length + exactAgent.length;
        if (exactScoped.length || exactVirtual) {
          // Exact requests must return one schema family alone. Many virtual-tool
          // descriptions mention primitives such as execute_luau, while native
          // descriptions can mention high-level virtual tools; including those
          // substring hits would defeat on-demand schema lookup.
          if (!exactScoped.length) { scoped = []; lines = []; }
          animLines = exactAnim;
          skillLines = exactSkills;
          agentLines = exactAgent;
          webLines = webLines.filter(queryMatches);
        } else {
          animLines = animLines.filter(queryMatches);
          skillLines = skillLines.filter((l) => queryMatches(l) && !hiddenSkillNames.has(nameFromLine(l)));
          agentLines = agentLines.filter(queryMatches);
          webLines = webLines.filter(queryMatches);
        }
      }
      const virtualCount = animLines.length + skillLines.length + agentLines.length + webLines.length;
      if (commandQuery && !scoped.length && !virtualCount) {
        return `Output of '${name}':\nNo ${requested} commands matched query "${commandQuery}". Call list_commands with another exact command name or keyword.`;
      }

      // Browser playground composers can wedge
      // on the full 500+ command reference. Compact providers receive a bounded
      // name index and fetch ONE exact schema on demand. Broad queries are also
      // folded back to names so a query like "ui" cannot recreate the same huge
      // payload on the next turn.
      // Specialist work modes surface their command family FIRST, by exact
      // name, on every broad catalogue request - so even compact providers
      // see the full VFX/UI or animation arsenal before anything else.
      let focusBlock = "";
      let focusMode = "ultimate";
      try { focusMode = normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()); } catch {}
      let focusNames = [];
      if (!commandQuery && WORK_MODES[focusMode] && WORK_MODES[focusMode].focus) {
        focusNames = workModeFocusNames(focusMode, [
          ...scoped.map((t) => t.name), ...[...animLines, ...skillLines, ...agentLines, ...webLines].map(nameFromLine),
        ]);
        // Compact composers get the header only - the family is listed first
        // (as signatures) in the index anyway, so the name list would be paid twice.
        if (focusNames.length) focusBlock = `━━━ ${WORK_MODES[focusMode].badge} WORK MODE FOCUS — ${focusNames.length} commands you are expected to use heavily (the UNIVERSAL set above plus this mode's family; all listed with their signatures below) ━━━\n${P.compactCommandList ? "" : focusNames.join(", ") + "\n"}\n`;
      }
      const compact = !!P.compactCommandList;
      const limit = compact
        ? Math.max(2500, Number(P.commandListMaxChars) || 9000)
        : Math.max(12000, Number(P.commandListMaxChars) || 32000);
      const lineLimit = Math.max(40, Number(P.commandListMaxLines) || (compact ? 400 : 700));
      if (commandQuery) {
        const matched = scoped.length + animLines.length + skillLines.length + agentLines.length;
        // Keyword searches with many hits come back as signatures (callable),
        // not bare names - one round trip instead of two.
        if (matched > (compact ? 12 : 40)) {
          const sigs = [...new Set([
            ...scoped.map(toolSignature),
            ...[...animLines, ...skillLines, ...agentLines].map(sigFromLine).filter(Boolean),
          ])].sort();
          const intro = `Output of '${name}':\nQuery "${commandQuery}" matched ${matched} commands (signatures; ? = optional):\n`;
          const guide = `\n\nCall one directly with the params shown, or list_commands {"query":"exact_name"} for its full description.`;
          const packed = packSignatures(sigs, Math.max(1800, limit - intro.length - guide.length - 200), lineLimit);
          const marker = packed.omitted > 0 ? `\n[${packed.omitted} additional matches omitted; narrow the keyword.]` : "";
          return intro + packed.text + marker + guide + (webLines.length ? "\n\n" + webLines.join("\n") : "");
        }
        return `Output of '${name}':\n${requested} commands (${scoped.length}${virtualCount ? ` + ${virtualCount} OR virtual tools` : ""}):\n\n${lines.join("\n\n")}${animLines.length ? "\n\n" + animLines.join("\n\n") : ""}${skillLines.length ? "\n\n" + skillLines.join("\n\n") : ""}${agentLines.length ? "\n\n" + agentLines.join("\n\n") : ""}${webLines.length ? "\n\n" + webLines.join("\n") : ""}`;
      }
      const helperNames = [
        "or_screenshot", "or_debug", "get_template", "or_status", "web_fetch",
        "web_search", "capture_id", "or_agent", "developer_product_create",
        "developer_product_list",
      ];
      const helperTools = helperNames
        .filter((hn) => !allScoped.some((t) => t.name === hn))
        .map((hn) => A.toolList.find((t) => t && t.name === hn))
        .filter(Boolean);
      // Header lines of the virtual packs ("— RobloxScript animation tools: …")
      // carry the flow notes; keep them at the top of the virtual section.
      const headers = [...animLines, ...skillLines, ...agentLines].filter((l) => !nameFromLine(l));
      const out = buildCatalogue({
        toolName: name, requested,
        nativeTools: [...allScoped, ...helperTools],
        virtualLines: [...animLines, ...skillLines, ...agentLines],
        webLines: [...headers, ...webLines],
        focusBlock, focusNames, compact, limit, lineLimit,
      });
      diag("list_commands.catalogue", { compact, limit, lineLimit, chars: out.length, lines: out.split("\n").length });
      return out;
    }
    // ── Virtual animation tools ──────────────────────────────────────────
    // Create/edit Roblox animation KEYFRAME DATA (KeyframeSequence/Keyframe/
    // Pose, per-bone transforms) via execute_luau + the RSAnim Luau library.
    // The catalogue above (list_commands) advertises them; the Roblox MCP
    // itself has no such tools, so they are resolved here instead of sent
    // through as real tool names.
    if (name.startsWith("animation_")) {
      const op = name.slice("animation_".length);
      if (!RSAnim.ANIM_OPS.includes(op)) {
        return `ERROR: unknown OR animation command '${name}'. Use list_commands to see the animation_* tools.`;
      }
      const built = RSAnim.buildLuau(op, args);
      if (built.err) return built.err;
      return await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
    }
    // ── Blender FBX → Studio (real import, not the watch-folder stub) ──
    if (name === "asset_bridge_import" || bareName === "asset_bridge_import") {
      return await runAssetBridgeImport(args);
    }
    // ── Thumbnail & Icon Studio: photograph + crop (needs the browser canvas, so it is not pure Luau) ──
    if (name === "gfx_capture" || bareName === "gfx_capture") {
      try { if (typeof window.__rsBeforeTool === "function") window.__rsBeforeTool(name, args); } catch {}
      const res = await runGfxCapture(args);
      try { if (typeof window.__rsAfterTool === "function") window.__rsAfterTool(name, args, !String(res || "").startsWith("ERROR"), res); } catch {}
      return res;
    }
    // ── Virtual Studio Skills (Lighting, UI, FX, Audio, Terrain, Camera, Diagnostics) ──
    if (typeof AgentScriptSkills !== "undefined" && AgentScriptSkills.SKILL_OPS.includes(name)) {
      return await AgentScriptSkills.run(name, args, runTool);
    }
    if (typeof RobloxScriptSkills !== "undefined" && RobloxScriptSkills.SKILL_OPS.includes(name)) {
      const preferMcp = /^(script_read|start_stop_play|get_console_output|wait_job_finished|list_roblox_studios|set_active_studio|user_keyboard_input|user_mouse_input|execute_luau|multi_edit)$/.test(name);
      const mcpHas = (A.toolList || []).some((t) => String(t.name || "").split("/").pop() === name);
      if (preferMcp && mcpHas) {
        /* fall through to Studio MCP */
      } else {
      // createCheckpoint lives in the ui closure - reach it through the hook (a direct call was a silent ReferenceError).
      try { if (typeof window.__rsBeforeTool === "function") window.__rsBeforeTool(name, args); } catch {}
      if (name === "ui_create_component") {
        try { if (window.__rsForge && window.__rsForge()) args = Object.assign({}, args, { forge: true }); } catch {}
      }
      const built = RobloxScriptSkills.buildLuau(name, args);
      if (built.err) return built.err;
      let res = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit", _orInternal: true } });
      // The model asked for `name`, not execute_luau - label the output with the
      // command it called so it never thinks its command was swapped.
      if (typeof res === "string" && res.startsWith("Output of 'execute_luau':")) res = `Output of '${name}':` + res.slice("Output of 'execute_luau':".length);
      // Skill programs report their own failures as {"ok":false,"error":...}
      // JSON - a SUCCESSFUL execute_luau as far as the MCP is concerned. Left
      // alone, the chip went green and the model read "not found" as data.
      // Re-shape it into a real ERROR so the loop guard, the recap and the
      // model's own retry logic all see it for what it is.
      try {
        const body = String(res || "").replace(/^Output of '[^']*':\n?/, "").trim();
        if (/^\{/.test(body) && body.length < 20000) {
          const j = JSON.parse(body);
          if (j && j.ok === false) {
            const why = String(j.error && typeof j.error === "object" ? (j.error.message || j.error.code || JSON.stringify(j.error)) : (j.error || "command failed")).slice(0, 600);
            res = `ERROR in ${name}: ${why}\nThe command ran but reported this failure. Paths are case-sensitive and must be full (e.g. game.Workspace.House.Door) - locate the target first with instance_find / search_game_tree / script_list, fix the parameter the message names, then retry.`;
          }
        }
      } catch {}
      const ok = !String(res||"").startsWith("ERROR") && !String(res||"").includes("ERROR in execute_luau");
      // Session persistence, perf budget pill and next-step suggestions live in
      // the ui closure (see window.__rsAfterTool) - calling them by name from
      // here threw a swallowed ReferenceError, so none of them ever ran.
      try { if (typeof window.__rsAfterTool === "function") window.__rsAfterTool(name, args, ok, res); } catch {}
      return res;
      }
    }
    const BLENDER_OPS = new Set(["get_scene_info","get_object_info","execute_blender_code","get_viewport_screenshot","blender_export_fbx","blender_execute_code","blender_screenshot"]);
    if (BLENDER_OPS.has(bareName) || /^blender_/.test(bareName)) {
      if (!(A.bridge && A.bridge.blender)) {
        let st = await bg({ type: "blender_status" });
        if (!(st && (st.blender || st.ok))) st = await bg({ type: "blender_connect" });
        if (st && (st.blender || st.ok)) {
          A.bridge = A.bridge || {};
          A.bridge.blender = true;
        }
      }
      if (!(A.bridge && A.bridge.blender)) {
        return "ERROR calling '" + name + "': Blender is not connected. Menu → Connect Blender (N-panel → Start MCP Server).";
      }
      if (bareName === "blender_send_to_studio") {
        return await runAssetBridgeImport(args);
      }
      const timeout = 120000;
      const hardCap = new Promise((res) =>
        setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from Blender" }), timeout + 30000));
      let stopTimer;
      const stopWatch = new Promise((res) => {
        stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
      });
      let sendArgs = args;
      if (bareName === "execute_luau" && args && args.code && args._orNoTxn !== true && !/ChangeHistoryService/.test(String(args.code))) {
        sendArgs = Object.assign({}, args, { code: wrapStudioTxn(String(args.code), String(bareName || "edit")) });
      }
      if (sendArgs && Object.prototype.hasOwnProperty.call(sendArgs, "_orNoTxn")) {
        sendArgs = Object.assign({}, sendArgs);
        delete sendArgs._orNoTxn;
      }
      let r = await Promise.race([bg({ type: "call_tool", name: bareName, arguments: sendArgs, timeout, requestId:A.activeRequestId }), hardCap, stopWatch]);
      clearInterval(stopTimer);
      r = cleanToolResult(r);
      if (r && r.kind === "stopped") return "(stopped by user)";
      if (!r) return RS.FEEDBACK.bridgeOffline;
      if (r.ok) {
        if (r.images && r.images.length) {
          ui.showImages(r.images, name);
          A.pendingImages = r.images;
          const caption = r.text && r.text.trim() ? r.text.trim() : `${r.images.length} image(s) captured.`;
          return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
        }
        const textOut = r.text && r.text.length ? r.text : "(tool returned an empty result)";
        const autoStudio = bareName === "blender_export_fbx" || bareName === "export_blender_fbx";
        if (autoStudio) {
          const imported = await runAssetBridgeImport({ source: "blender", asset: r.filepath || args.filepath || args.path || "scene", objects: args.objects, dest: args.dest, scale: args.scale });
          return `Output of '${name}':\n${textOut}\n\nStudio:\n${imported}`;
        }
        return `Output of '${name}':\n${textOut}`;
      }
      return `ERROR calling '${name}': ${r.error || "Blender call failed"}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name) && !A.toolNames.has(bareName)) {
      // Append the callable signatures of the suggested names so the model can
      // fix the call in its next reply instead of running list_commands first.
      let msg = RS.FEEDBACK.unknownTool(name, [...A.toolNames]);
      try {
        const m = msg.match(/Did you mean: ([^?]+)\?/);
        if (m) {
          const sigs = m[1].split(/,\s*/).map((nm) => A.toolList.find((t) => t && t.name === nm.trim())).filter(Boolean).map(toolSignature);
          if (sigs.length) msg += `\nSignatures (? = optional): ${sigs.join("  ·  ")}`;
        }
      } catch {}
      return msg;
    }
    // Normalize common model aliases before validation. The canonical schema is
    // parent_path, but older skill examples used parent/parentPath/host_path.
    if (args && typeof args === "object" && !args.parent_path) {
      const parentAlias = args.parent ?? args.parentPath ?? args.host_path;
      if (parentAlias !== undefined && parentAlias !== null && parentAlias !== "") args.parent_path = parentAlias;
    }
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    // The player-input tools only run against the Client datamodel (play mode) and
    // "Client" is the sole allowed value, so default it when the model omits it -
    // it can only be right. (It still needs the game RUNNING; that's documented.)
    if ((bareName === "user_keyboard_input" || bareName === "user_mouse_input") && !args.datamodel_type)
      args.datamodel_type = "Client";
    if (bareName === "screen_capture") {
      const screenTool = studioToolByBare("screen_capture");
      args = await screenCaptureArgs(args, screenTool);
      if (screenTool && screenTool.name) name = screenTool.name;
    }
    if (bareName === "execute_luau" && !args._orChunk && typeof args.code === "string") {
      const pieces = splitLuauChunks(args.code, LUAU_CHUNK_MAX);
      if (pieces && pieces.length > 1) {
        const dm = args.datamodel_type || "Edit";
        let last = "";
        for (let i = 0; i < pieces.length; i++) {
          const wrapped = wrapLuauChunk(pieces[i], i, pieces.length);
          last = await runTool({ tool: "execute_luau", arguments: { code: wrapped, datamodel_type: dm, _orChunk: true } });
          if (String(last || "").startsWith("ERROR")) return last;
        }
        return last;
      }
    }
    // Pre-flight against the cached schema: a call missing a required parameter
    // is answered instantly WITH the schema, instead of a bridge round trip that
    // comes back "x is required" and a second round trip for list_commands.
    // Native bridge tools only - virtual packs accept aliases their schema does
    // not list and validate themselves.
    if (!args._orChunk) {
      const schemaTool = A.toolList.find((t) => t && !t.virtual && (t.name === name || bareToolName(t.name) === bareName));
      const missing = schemaTool ? requiredParamsMissing(schemaTool, args) : [];
      if (missing.length) {
        return `ERROR MISSING_PARAMS calling '${name}': required parameter(s) not provided: ${missing.join(", ")}.\nSchema:\n${toolDetailLine(schemaTool)}\nFix the call and retry now - no list_commands needed.`;
      }
    }
    const timeout = name === "execute_luau" ? 20000 : bareName === "script_read" ? 30000 : 120000;
    // Hard watchdog: even if the background worker never answers, the loop
    // gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    // Stop watcher: a blocking tool (e.g. wait_job_finished) would otherwise keep
    // the loop awaiting the bridge for up to minutes, leaving the input locked and
    // the Stop button stuck. When the user halts (A.stop), abandon the wait within
    // ~150ms so the loop breaks and its finally unlocks everything. The in-flight
    // bridge call may still finish in the background; its result is just ignored.
    let stopTimer;
    const stopWatch = new Promise((res) => {
      stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
    });
    // Never leak OR-internal flags (_orInternal, _orChunk, _orNoTxn) into the
    // MCP call - strict schemas reject unknown arguments.
    const wireArgs = (() => { const o = {}; for (const k of Object.keys(args || {})) if (!/^_or/.test(k)) o[k] = args[k]; return o; })();
    const studioCall = activeEngine() === "local" || bareName === "list_roblox_studios"
      ? bg({ type: "call_tool", name, arguments: wireArgs, timeout, requestId:A.activeRequestId })
      : callStudioToolWithId(name, wireArgs, timeout, A.activeRequestId);
    let r = await Promise.race([studioCall, hardCap, stopWatch]);
    clearInterval(stopTimer);
    r = cleanToolResult(r);
    if (r && r.kind === "stopped") return "(stopped by user)";
    if (!r) return RS.FEEDBACK.bridgeOffline;
    // The MCP server answers SUCCESSFULLY (ok:true) when no Studio is attached
    // (Studio closed / no place / MCP option disabled) - with an explanatory
    // text instead of a result. Surface it as a proper environment ERROR so the
    // model stops and tells the user, instead of treating it as tool output.
    if (r.ok && /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(r.text || "")) {
      ui.banner("warn", "Roblox Studio is not connected",
        "Open your place in Roblox Studio and enable the MCP server (Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server), then try again.");
      return RS.FEEDBACK.studioOffline;
    }
    // The Roblox MCP reports missing/invalid required parameters as a SUCCESS
    // whose text is just the complaint (e.g. "datamodel_type is required").
    // Re-shape those into a real ERROR so the model corrects the call instead
    // of misreading it as tool output.
    if (r.ok && r.text && /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i.test(r.text.trim())) {
      const schemaText = schemaTextFor(name);
      return `ERROR calling '${name}': ${r.text.trim()}.\nA required or invalid parameter.${schemaText ? ` Schema:\n${schemaText}\n` : " Check the command's parameters with list_commands, "}Fix the call and retry.`;
    }
    // The Roblox MCP also reports Luau PARSE/RUNTIME errors as a SUCCESS whose
    // text is the executor's own stack trace ("…ExecuteLuauTool:139: …
    // CommandExecution:54: <real error>" - validated live). Genuine script
    // output never contains those internal paths. Re-shape into a real ERROR so
    // the model gets the fix-it hints below and the chip settles red, not ✓
    // green - and strip the internal frames so only the useful part remains.
    if (r.ok && bareName === "execute_luau" && r.text &&
        /\b(?:ExecuteLuauTool|CommandExecution):\d+:/.test(r.text)) {
      r = { ok: false, error: r.text.replace(/^(?:\S*(?:ExecuteLuauTool|CommandExecution):\d+:\s*)+/, "").trim() || r.text };
    }
    if (r.ok) {
      if (r.images && r.images.length) {
        // Show the capture in a left-hand OR popup (from the in-memory
        // base64 - simple and reliable on every site; no DOM-embedded preview).
        ui.showImages(r.images, name);
        // Do NOT attach the image here: submitAndGetBase/typeAndSend types the
        // feedback text into the editor LATER, and on providers whose editor is
        // rebuilt via select-all + insertText (e.g. Gemini's setEditorText),
        // that wipe severs the site's internal binding between "pending upload"
        // and "message being composed" - the file then sits in the composer
        // forever while only the text goes out (validated live: Gemini kept
        // the file attached+unsent across the whole turn). Stash the images and
        // let the provider attach them as the LAST step, right before the send
        // click, so nothing mutates the editor afterward.
        A.pendingImages = r.images;
        diag("images.stashed", { count: r.images.length });
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
      }
      const text = r.text && r.text.length ?  r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    // Orphaned content script - a page reload is the only cure, so say exactly
    // that instead of blaming the bridge (see bg / isContextInvalidated).
    if (r.kind === "stale-extension") {
      ui.banner("warn", "Reload this page",
        "OR was updated or reloaded while this tab was open, so this page is running an " +
        "old copy of it and commands can no longer run. Reload the page (F5) to reconnect - your " +
        "bridge and Roblox Studio are unaffected.");
      diag("bridge.staleExtension", { name, error: r.error });
      return RS.FEEDBACK.staleExtension;
    }
    const bridgeErrorText = (value, fallback="Studio bridge request failed") => {
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") return value.message || value.error || JSON.stringify(value);
      return fallback;
    };
    if (r.kind === "disconnected") return `ERROR ${r.errorCode||"STUDIO_BRIDGE_OFFLINE"}: ${bridgeErrorText(r.error,"Roblox Studio bridge is offline.")}`;
    if (r.kind === "timeout") {
      return `ERROR ${r.errorCode||"STUDIO_TIMEOUT"}: tool '${name}' timed out after ${name === "execute_luau" ? 20 : 120}s.\n${r.error}\nThe request was not silently reported as successful. Check Studio responsiveness before retrying.`;
    }
    if (r.errorCode) {
      const detail = bridgeErrorText(r.error);
      if (studioIdComplaint(r) && bareName !== "list_roblox_studios") {
        // Still missing after the automatic list_roblox_studios retry: there is
        // no Studio instance to target, or the listing shape changed.
        return `ERROR ${r.errorCode}: ${detail}\nStudio requires a studio_id for '${bareName}'. OR tried to resolve it with list_roblox_studios and found none - make sure a place is open in Roblox Studio with the MCP server enabled, then retry; or call list_roblox_studios and pass "studio_id" explicitly.`;
      }
      return `ERROR ${r.errorCode}: ${detail}`;
    }
    if (name === "execute_luau") {
      const err = r.error || "";
      // "Failed to parse command code" is StudioMCP's GENERIC parse rejection: an
      // empty/mis-marked block is only ONE of its causes. The others are ordinary
      // Luau syntax errors and - seen live on Meta AI 2026-08-13 - code that is
      // syntactically fine but too big for the parser: a `return 1+1+1+…` chain
      // ran at ~500 terms (1006 chars) and was rejected at ~1000 (2006 chars).
      // Telling the model its block was empty when we DID send it a full code
      // string sends it to fix something that isn't broken; it retries the same
      // payload and fails again (the reported spam of parse errors). Only give the
      // marker advice when the code we actually sent really was empty.
      const luaCode = args.code || "";
      const hint = err.includes("Failed to parse command code")
        ? !luaCode.trim()
          ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
          : `Roblox refused to PARSE the code (${luaCode.length} chars sent, so it was not empty). Either the Luau syntax is invalid, or the code is too large/complex for the parser - a single huge expression or a very long script can be rejected outright. Check the syntax first; if it looks correct, split the work into several smaller calls.`
        : err.includes("attempt to") || err.includes("nil value")
          ? "Lua runtime error. Check that the API you are calling exists (use game:GetService() to access services). Make sure you use 'return' to output values, not 'print()'."
          : "Check your Lua syntax, make sure you use 'return' to output values (not 'print()'), and that all APIs you call exist in the current Roblox Studio context.";
      return `ERROR in execute_luau: ${err}\n\n${hint}\n\nFix the code and retry.`;
    }
    return `ERROR calling '${name}': ${r.error}\nRead the error carefully, fix the call or try a different approach.`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "execute_luau") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could — not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Some tools answer with raw JSON on one line, and a 44-char slice of it makes
  // a chip that says nothing: list_roblox_studios read
  // `{"studios":[{"id":"8521cfad-f8d9-46f4-8cbe-2`. Summarise the SHAPE instead,
  // in the same spirit as the boot chip's "25 commands". Returns null when the
  // body isn't JSON, so plain-text outputs keep their first line unchanged.
  function jsonSummary(body) {
    if (!/^[[{]/.test(body) || body.length > 200000) return null;
    let v;
    try { v = JSON.parse(body); } catch { return null; }
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ?  "" : "s"}`;
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v);
    // The common MCP shape: one wrapper key holding the list. Its name is already
    // plural ("studios", "scripts"), so it reads correctly as-is - just drop the
    // trailing "s" when there is exactly one, so it says "1 studio".
    if (keys.length === 1 && Array.isArray(v[keys[0]])) {
      const n = v[keys[0]].length;
      const word = n === 1 ?  keys[0].replace(/s$/, "") : keys[0];
      return `${n} ${word}`;
    }
    // Otherwise show the scalar fields - that's what a human would read off.
    const scalars = keys
      .filter((k) => v[k] === null || typeof v[k] !== "object")
      .map((k) => `${k}: ${v[k]}`);
    if (scalars.length) return scalars.join(", ").slice(0, 44);
    return `${keys.length} field${keys.length === 1 ?  "" : "s"}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    // Errors are prose and read fine as-is; only reshape successful JSON.
    if (!isErr) { const j = jsonSummary(body); if (j) return j; }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
    if (isErr) return first;
    return lines > 1 ?  `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "execute_luau") return (a.code || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  function isCapabilityRefuse(text) {
    const t = String(text || "");
    if (!t) return false;
    if (/###\s*LUA\s*###|"command"\s*:\s*"/i.test(t)) return false;
    return /\b(i (can('t|not)|do not|don't) (actually )?(have (the ability|access)|run|execute|interact with|control|reach)|as an? (ai|language model|assistant) i (can('t|not)|don't)|i('m| am) not able to (run|execute|access|control|use)|cannot (run|execute) (code|commands|tools) (on|in|against) your|i don't have access to (your|the) (computer|studio|machine|roblox)|i (can't|cannot) (use|call) (external|local) (tools|commands)|i have no (direct )?way to (run|execute|access|control|reach)|i (can't|cannot|am unable to) (directly )?(access|control|modify|change|edit) (your|the) (studio|place|machine|computer|files|roblox|workspace))\b/i.test(t);
  }
  async function agentLoop(base) {
    if (A.running) return;
    A.running = true;A.lifecycle="RUNNING";
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0;
    const MAX_TRUNC = 6;
    // Dead-turn auto-retry budget (v1.12): ONE rescue for a dropped/quiet turn
    // per loop. Reset on every healthy turn (tool result or final text) so an
    // hour-long session can survive multiple one-off site hiccups, while a
    // genuinely broken provider still stops after a single failed retry.
    let deadRetries = 0;
    let refuseRetries = 0;
    let parseRetries = 0;
    let toolTurns = A.steeringStep || 0;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    // Compact-capable providers (usually the slower reasoning lanes) already
    // receive a name index and fetch exact schemas on demand. Re-sending a large
    // command reminder every 20 tool turns only increases context and makes the
    // next answer slower. Keep the full reminder for normal providers, but make
    // the compact path substantially lighter while preserving recovery guidance.
    const REMIND_TOOLS_EVERY = P.compactCommandList ? 50 : 25;
    // 1.34: how many commands one reply may carry (run in order, one combined
    // result). Providers can lower it (P.maxBatchCommands); 1 disables batching.
    const MAX_BATCH_COMMANDS = Math.max(1, Math.min(8, Number(P.maxBatchCommands) || 6));
    ui.showStop(true);
    ui.steeringProgress("waiting", "Waiting for the model's next action", 0);
    P.setInputLock(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        // Gate the WHOLE cycle on tab visibility. We only advance - read the
        // reply, PARSE it, EXECUTE a tool, inject the result - while the AI tab
        // is the FOREGROUND tab of its Edge window. document.visibilityState
        // (mirrored by document.hidden) is the right signal, NOT window focus:
        //  - Edge loses OS focus but the AI tab stays the active tab (user is
        //    working in Roblox Studio) -> still "visible" -> the agent keeps
        //    running, exactly as wanted.
        //  - The AI tab is backgrounded (another tab in front) or the window is
        //    minimized -> "hidden" -> pause here. Background tabs throttle
        //    rendering/timers, which made DOM reads unreliable (misparse,
        //    duplicate sends - see the send-side guard in submitAndGetBase).
        // Parking here means we never START a parse/exec cycle off-screen; the
        // send step re-checks too, so a switch-away mid-generation is covered.
        if (document.hidden && !A.stop) {
          diag("loop.waitVisible");
          ui.inputCover(true); // keep the "Agent is working" cover up while parked
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          diag("loop.visibleAgain");
        }
        if (!A.steeringQueue.length) ui.steeringProgress("waiting", "Waiting for the model's next action", toolTurns);
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;
        ui.steeringProgress("reviewing", `Checking ${res.kind === "tool" ? "the proposed command" : "the reply"}`, toolTurns);

        if (res.kind === "context_limit") {
          ui.steeringProgress("error", "The provider reached its context limit", toolTurns);
          ui.banner("limit", `${P.displayName} hit its limit`,
            (res.detail || "") + " — just open a fresh chat to keep going.");
          break;
        }
        if (res.kind === "provider_error") {
          ui.steeringProgress("error", "The provider request failed", toolTurns);
          ui.banner("warn", `${P.displayName} request failed`,
            res.detail || "The provider rejected or failed this request. Retry after resolving the provider error.");
          break;
        }
        if (res.kind === "too_long") {
          ui.steeringProgress("error", "This conversation is too long to continue reliably", toolTurns);
          ui.banner("limit", "Chat's getting long",
            `${P.displayName} says it's getting too long. Time for a fresh session.`);
          break;
        }
        if (res.kind === "timeout") {
          // One automatic retry (v1.12): flaky providers (GLM under load, Arena
          // busy pages, Qwen cold caches) sometimes just DROP a turn. A single
          // "continue" nudge rescues the run; a second failure still stops.
          if (deadRetries < 1 && !A.stop && A.started) {
            deadRetries++;
            diag("loop.deadRetry", { kind: "timeout", n: deadRetries });
            ui.toast(P.displayName + " went quiet — retrying once…");
            ui.steeringProgress("correcting", "Provider went quiet — retrying once", toolTurns);
            base = await submitAndGetBase(RS.FEEDBACK.deadTurn);
            continue;
          }
          ui.steeringProgress("error", `${P.displayName} did not answer`, toolTurns);
          ui.banner("warn", `${P.displayName} went quiet`,
            `${P.displayName} didn't answer in time. Loop stopped — try again.`);
          break;
        }
        // A genuinely empty turn is effectively never produced (the warm-up guard
        // waits out slow starts). It DOES happen when the site drops a reply, and
        // ending the loop silently is what made this the single most confusing
        // failure: the pending command just settles to a grey "not run" with no
        // explanation anywhere. Say what happened - and since v1.12, retry ONCE
        // first (same rationale as the timeout retry above).
        if (res.kind === "empty") {
          diag("empty.end");
          if (deadRetries < 1 && !A.stop && A.started) {
            deadRetries++;
            diag("loop.deadRetry", { kind: "empty", n: deadRetries });
            ui.toast(P.displayName + " sent nothing — retrying once…");
            ui.steeringProgress("correcting", "Empty reply — retrying once", toolTurns);
            base = await submitAndGetBase(RS.FEEDBACK.deadTurn);
            continue;
          }
          ui.steeringProgress("error", `${P.displayName} returned an empty reply`, toolTurns);
          ui.banner("warn", `${P.displayName} sent nothing`,
            `Got an empty reply so the loop stopped — nothing ran. Nudge ${P.displayName} to continue, or hit Start in a fresh chat.`);
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          const steerCutOff = ui.takeSteeringSteering();
          if (steerCutOff) {
            const pendingName = RSParse.toolNameFromText(res.text || "") || "command";
            if (res.item) decorate.toolBox(res.item, pendingName, "idle", "revised by you", true);
            ui.steeringProgress( "Cut-off command skipped — applying your update", toolTurns);
            let note = RS.FEEDBACK.steeringSteer(steerCutOff, true);
            const state = asStateTag();
            if (state) note += "\n" + state;
            base = await submitAndGetBase(note);
            continue;
          }
          ui.steeringProgress("correcting", "Reply was cut off — recovering it safely", toolTurns);
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("Reply was cut off — continuing from there");
            base = await submitAndGetBase(RS.FEEDBACK.truncated);
            continue;
          }
          if (res.text){ break; } // give up resuming; keep what we have as the answer
          ui.banner("warn", "Kept getting cut off",
            "Model keeps hitting its length cap. Try something shorter or start a fresh chat.");
          break;
        }
        truncCount = 0;
        deadRetries = 0; // healthy turn (text/tool/parse outcome) — refill the retry budget

        if (res.kind === "parse_error") {
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = RSParse.toolNameFromText(res.raw || "") || "command";
          const steerMalformed = ui.takeSteeringSteering();
          if (steerMalformed) {
            if (res.item) decorate.toolBox(res.item, failName, "idle", "revised by you", true);
            ui.steeringProgress( "Invalid pending command skipped — applying your update", toolTurns);
            let note = RS.FEEDBACK.steeringSteer(steerMalformed, true);
            const state = asStateTag();
            if (state) note += "\n" + state;
            base = await submitAndGetBase(note);
            continue;
          }
          if (res.item) {
            const detail = res.reason === "unclosed" ? "cut off"
              : res.reason === "luaOpener" ? "missing ###LUA###"
              : res.reason === "envelope" ? "bad format"
              : "bad JSON";
            decorate.toolBox(res.item, failName, "err", detail, true, "", RS.toolCategory(failName));
          }
          // Never loop forever on a lane that repeatedly emits malformed JSON.
          // Two rewrite attempts are enough to recover transient formatting; a
          // third failure stops with a clear explanation and unlocks the editor.
          if (parseRetries >= 2) {
            ui.steeringProgress("error", "Stopped after repeated invalid commands", toolTurns);
            ui.banner("warn", `${P.displayName} kept sending invalid commands`,
              "Nothing unsafe was executed. Retry the request or switch to another supported provider.");
            break;
          }
          parseRetries++;
          ui.steeringProgress("correcting", `Invalid command — correction ${parseRetries} of 2`, toolTurns);
          // Pass the detected command name so the feedback only offers the
          // ###LUA### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(RS.FEEDBACK.parseError(res.reason, failName));
          continue;
        }
        if (res.kind === "text") {
          const body = String(res.text || "");
          const steer = ui.takeSteeringSteering();
          if (steer) {
            ui.steeringProgress( "Applying your update before the next action", toolTurns);
            let note = RS.FEEDBACK.steeringSteer(steer, false);
            const state = asStateTag();
            if (state) note += "\n" + state;
            base = await submitAndGetBase(note);
            continue;
          }
          let providerCommandless = false;
          try {
            providerCommandless = toolTurns === 0 && typeof P.shouldRetryCommandlessText === "function"
              && P.shouldRetryCommandlessText(body);
          } catch {}
          if (refuseRetries < 1 && !A.stop && (isCapabilityRefuse(body) || providerCommandless)) {
            refuseRetries++;
            diag("loop.capabilityRefuse", { n: refuseRetries, providerCommandless });
            try { ui.toast("Model replied without acting — requesting one command…"); } catch {}
            let retryFeedback = providerCommandless && P.commandlessRetryFeedback
              ? P.commandlessRetryFeedback
              : RS.FEEDBACK.capabilityRefuse;
            if (providerCommandless) {
              // A refusal can be the first reply after Studio was closed. Probe
              // again so the rescue never insists on a command using yesterday's
              // LINKED state; the provider note explicitly follows this fresh tag.
              try { await refreshCurrentEngineState(); } catch {}
              const state = asStateTag();
              if (state) retryFeedback += "\n" + state;
            }
            ui.steeringProgress("correcting", "The model did not act — requesting a command", toolTurns);
            base = await submitAndGetBase(retryFeedback);
            continue;
          }
          ui.steeringProgress("complete", toolTurns ? `${toolTurns} step${toolTurns === 1 ? "" : "s"} completed` : "Reply finished", toolTurns);
          break;
        }

        if (res.kind === "tool") {
          parseRetries = 0;
          // 1.34: identical repeats in one reply (a model "showing" the command
          // and then "running" it) execute once - never twice.
          const calls = (() => { const seen = new Set(); return (res.calls || []).filter((c) => { const k = `${c && c.tool}\n${JSON.stringify((c && c.arguments) || {})}`; if (seen.has(k)) return false; seen.add(k); return true; }); })();
          if (calls.length !== (res.calls || []).length) diag("tool.dedupe", { from: res.calls.length, to: calls.length });
          // Steering that arrived while the model was generating wins BEFORE a
          // proposed command runs. This is the safe boundary Steering promises:
          // no concurrent provider send and no half-cancelled Studio mutation.
          const steerBefore = ui.takeSteeringSteering();
          if (steerBefore) {
            const pending = calls[0];
            if (pending && res.item) {
              decorate.toolBox(res.item, pending.tool, "idle", "revised by you", true,
                callBody(pending), RS.toolCategory(pending.tool));
            }
            ui.steeringProgress( "Pending command skipped — applying your update", toolTurns);
            let note = RS.FEEDBACK.steeringSteer(steerBefore, true);
            const state = asStateTag();
            if (state) note += "\n" + state;
            base = await submitAndGetBase(note);
            continue;
          }
          // 1.34: a reply may carry up to MAX_BATCH_COMMANDS independent commands.
          // They run here in order and the model gets ONE combined result, so a
          // "build 5 parts" step costs one model turn instead of five (each turn
          // is 10-60 s of generation + a composer round trip - the dominant cost
          // of a session). The batch stops at the first failed step: the rest is
          // reported as NOT RUN so the model fixes the error and resends only
          // what is missing. Beyond the cap we still ask for a smaller reply.
          if (calls.length > MAX_BATCH_COMMANDS) {
            ui.steeringProgress("correcting", `Model proposed ${calls.length} commands — asking for at most ${MAX_BATCH_COMMANDS}`, toolTurns);
            base = await submitAndGetBase(RS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?"), MAX_BATCH_COMMANDS));
            continue;
          }
          const batchN = calls.length;
          const batchParts = [];
          let batchImages = [];
          let batchSteer = null;
          let batchStopped = false;
          let batchAbort = false;
          let call = calls[0];
          let category = RS.toolCategory(call.tool);
          let feedback = "";
          for (let bi = 0; bi < batchN; bi++) {
          call = calls[bi];
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          category = learnedImg ?  "screen" : RS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category, batch: batchN > 1 ? `${bi + 1}/${batchN}` : undefined });

          // Park BEFORE painting the chip / stamping the clock / marking the turn
          // dispatched. runTool() gates on visibility too (it is the choke point
          // that also covers the bootstrap), but parking only there would leave
          // this block's side effects applied for the whole minimize:
          //   - the chip spins "running" while nothing actually runs, and
          //     elapsedOn(rsToolT0) counts the parked time, so a 20-min minimize
          //     renders a bogus "1200.0s" on the call;
          //   - rememberExecuted() would mark the turn dispatched before it ever
          //     ran, so a reload/close while parked loses the command for good -
          //     the auto-resume watchdog refuses to re-fire an "executed" turn.
          // Parking first keeps all of that truthful: we only commit once we are
          // foreground and about to really dispatch.
          if (document.hidden && !A.stop) {
            diag("tool.parkBeforeDispatch", { name: call.tool });
            if (!(await waitVisible()) || A.stop) { batchAbort = true; break; }
          }
          // A steer may have been queued while the tab was parked. Re-check at
          // the final dispatch boundary; after this point there is no await until
          // runTool owns the operation atomically.
          const steerAtDispatch = ui.takeSteeringSteering();
          if (steerAtDispatch) {
            if (bi > 0) {
              // Mid-batch steer: the steps already run keep their real results;
              // the remaining ones are skipped and the update rides on the batch.
              batchSteer = steerAtDispatch; batchStopped = true; break;
            }
            decorate.toolBox(res.item, call.tool, "idle", "revised by you", true,
              callBody(call), category);
            ui.steeringProgress( "Pending command skipped — applying your update", toolTurns);
            let note = RS.FEEDBACK.steeringSteer(steerAtDispatch, true);
            const state = asStateTag();
            if (state) note += "\n" + state;
            base = await submitAndGetBase(note);
            batchStopped = true; batchParts.length = 0; break;
          }
          toolTurns++;
          ui.steeringProgress("running", batchN > 1 ? `${call.tool} (step ${bi + 1}/${batchN})` : call.tool, toolTurns);
          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", (batchN > 1 ? `step ${bi + 1}/${batchN} · ` : "") + argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool,requestId:A.activeRequestId });
          try { ui.trackCard(call.tool, "run", "executing\u2026", category); } catch {}
          try { emitAgentRoadmapEvent("agent.tool_started", call.tool, argSummary(call)); } catch {}
          feedback = await runTool(call);
          // Loop guard: the same command with the same parameters failing over
          // and over is the classic agent death spiral. Tag the result so the
          // model is told to change approach instead of resending it.
          try { feedback = applyRepeatGuard(call, feedback); } catch {}
          try {
            const rawFb = String(feedback || "");
            const stripped = stripStudioNoise(rawFb);
            if (isAssistantPluginNoise(rawFb) && (!stripped || /^ERROR:\s*$/i.test(stripped))) {
              feedback = "Output of '" + (call.tool || "execute_luau") + "':\nOK";
            } else if (stripped !== rawFb) {
              feedback = stripped || rawFb;
            }
          } catch {}
          // Multi-Agent board bookkeeping + [CREW] handoff hints (appended, so
          // feedbackIsError()'s startsWith("ERROR") stays intact).
          try {
            if (typeof ORAgentCrew !== "undefined" && ORAgentCrew && ORAgentCrew.active()) {
              feedback = ORAgentCrew.afterTool(call.tool, call.arguments, feedback);
              A.agentRole = ORAgentCrew.role() || "";
              try { if (typeof window.__rsSyncCrewBadge === "function") window.__rsSyncCrewBadge(); } catch {}
            }
          } catch {}
          // Persistent environment header (see asStateTag) — appended, never
          // prefixed, so feedbackIsError()'s startsWith("ERROR") stays intact.
          // In a batch it is appended once, on the combined result.
          if (batchN === 1) { const _tag = asStateTag(); if (_tag && !feedback.includes("[SYSTEM_STATE:")) feedback += "\n" + _tag; }
          // Auto-debug is one more Studio round trip: once per batch (after the
          // last step), not once per step.
          if (bi === batchN - 1) { try { feedback = await attachAutoDebug(call.tool, feedback); } catch {} }
          try { feedback = compressToolFeedback(feedback, call.tool); } catch {}
          try {
            const failed = feedback.startsWith("ERROR");
            emitAgentRoadmapEvent("agent.tool_completed", call.tool, (failed ? "Failed: " : "Completed: ") + feedback.replace(/\s+/g," ").slice(0,180));
            if (failed) emitAgentRoadmapEvent("agent.error", call.tool, feedback.replace(/\s+/g," ").slice(0,300));
          } catch {}
          A.toolRunning = false;
          diag("tool.done", { name: call.tool,requestId:A.activeRequestId,durationMs:Date.now()-A.toolStart, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          try { recordSessionTool(call.tool, call.arguments, feedback); } catch {}
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            batchStopped = true; batchParts.length = 0;
            break;
          }
          // Images from every step travel together on the combined result.
          if (A.pendingImages && A.pendingImages.length) { batchImages = batchImages.concat(A.pendingImages); rememberImageTool(call.tool); }
          A.pendingImages = null;
          const stepErr = feedbackIsError(feedback);
          batchParts.push({ call, feedback, isErr: stepErr, category });
          if (batchN > 1) {
            decorate.toolBox(res.item, call.tool, stepErr ? "err" : "run", `step ${bi + 1}/${batchN} ${stepErr ? "failed" : "ok"}`, true, stripOutputPrefix(feedback), category);
            if (stepErr) break;
            const steerMid = ui.peekSteeringSteering ? ui.peekSteeringSteering() : null;
            if (steerMid) break; // taken at the top of the next iteration
          }
          } // end batch loop
          if (A.stop || batchAbort) break;              // halted / never became visible: end the loop (as before)
          if (batchStopped && !batchParts.length) continue; // first step skipped for a steer: note already sent
          if (batchN > 1) {
            const ran = batchParts.length;
            const failedAt = batchParts.findIndex((p) => p.isErr);
            const okCount = batchParts.filter((p) => !p.isErr).length;
            const notRun = calls.slice(ran).map((c) => c.tool || "?");
            const head = (failedAt >= 0 ? "ERROR: " : "") + `Output of 'batch':\n${ran} of ${batchN} commands ran (${okCount} ok${failedAt >= 0 ? `, step ${failedAt + 1} failed` : ""}).`
              + (notRun.length ? ` NOT RUN: ${notRun.join(", ")} - ${failedAt >= 0 ? `fix step ${failedAt + 1} and resend only the remaining commands` : "resend them after applying the update below"}.` : "");
            const body = batchParts.map((p, i) => `[${i + 1}/${batchN}] ${p.call.tool}${p.isErr ? " - FAILED" : ""}\n${String(p.feedback || "").replace(/^Output of '[^']*':\s*/, "")}`).join("\n\n");
            feedback = head + "\n\n" + body;
            { const _tag = asStateTag(); if (_tag && !feedback.includes("[SYSTEM_STATE:")) feedback += "\n" + _tag; }
            try { feedback = compressToolFeedback(feedback, "batch"); } catch {}
            category = batchImages.length ? "screen" : (batchParts.some((p) => p.category === "screen") ? "screen" : category);
            diag("tool.batch", { n: batchN, ran, okCount, failedAt, images: batchImages.length });
          }
          A.pendingImages = batchImages.length ? batchImages : null;
          const isErr = feedbackIsError(feedback);
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ?  "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (Roblox OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ?  "screen" : category;
          const chipName = batchN > 1 ? `${batchParts.length}/${batchN} commands` : call.tool;
          const chipDetail = batchN > 1
            ? `${batchParts.filter((p) => !p.isErr).length} ok${isErr ? `, ${batchParts.filter((p) => p.isErr).length} failed` : ""} · ${batchParts.map((p) => p.call.tool).join(", ")}`.slice(0, 160)
            : outSummary(feedback);
          decorate.toolBox(res.item, chipName, isErr ?  "err" : "done", chipDetail,
            true, outBody, resultCat);
          try { ui.trackCard(chipName, isErr ?  "err" : "ok", chipDetail, resultCat); } catch {}
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ?  "err" : "done", detail: chipDetail,
            body: outBody, category: resultCat, count: P.assistantCount(),
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ?  P.lastAssistantId() : undefined,
          };

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Scope the reminder to the primary Roblox server, exactly like
              // list_commands: re-injecting EVERY connected server's tools (Blender
              // etc.) merged flat would bloat the model's context - the opposite of
              // what the model gets when it lists commands itself. Anti-drift only
              // needs the primary Roblox set; addon commands were listed on demand
              // and the bridge routes by name regardless.
              const roblox = A.toolList.filter((t) => (t.server || "roblox") === "roblox");
              // Compact providers (Notion, NVIDIA playground) cannot take the
              // full one-line-per-command reminder either: with ~750 commands it
              // is ~75k characters, far above what their composer delivers. Give
              // them the same bounded name index list_commands gave them.
              let modeCheck = "";
              try { modeCheck = RS.workModeChecklist(normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode())); } catch {}
              toSend += (P.compactCommandList ? compactToolsReminder(roblox) : RS.toolsReminder(roblox)) + (modeCheck ? "\n" + modeCheck : "") + "\n" + RS.memoryNudge() + projectMapReminder();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY, projectMap: !!(window.__rsProjectMap && window.__rsProjectMap.text) });
            }
          }
          // If steering arrived while runTool was already in flight, that command
          // is allowed to finish atomically. Carry the update on its real result
          // so the model applies it before selecting another command.
          const steerAfter = batchSteer || ui.takeSteeringSteering();
          if (steerAfter) {
            toSend += "\n\n" + RS.FEEDBACK.steeringSteer(steerAfter, false);
            ui.steeringProgress( "Current step finished — applying your update next", toolTurns);
          } else {
            ui.steeringProgress("sending", `${chipName} finished — sending ${batchN > 1 ? "the combined result" : "its result"}`, toolTurns);
          }
          // This result becomes a turn, so it counts toward the re-statement
          // budget - context volume is what makes the site summarise, and the
          // volume is overwhelmingly tool results, not how often the user types.
          bumpSys("results");
          // Ride the system-prompt re-statement out on this result if one is due
          // and it fits (see withSysResend - the result itself is never trimmed).
          toSend = withSysResend(toSend);
          const images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ?  images.length : 0 });
          base = await submitAndGetBase(toSend, images);
        }
      }
    } catch (e) {
      if (e instanceof SendAbortedError) {
        // "Couldn't send that" is already on screen from submitAndGetBase -
        // just stop quietly instead of piling an "internal error" on top.
        diag("loop.sendAborted", {});
        ui.steeringProgress("error", "The provider would not accept the next message", toolTurns);
      } else {
        diag("loop.error", { msg: String((e && e.message) || e) });
        ui.steeringProgress("error", productName()+" hit an internal loop error", toolTurns);
        ui.banner("warn", "Internal loop error", String((e && e.message) || e));
        try { A._sfxErr = true; } catch {}
      }
    } finally {
      const steeringWasStopped = !!(A.stop || A.userStopped);
      try { playSfx(A.stop ? "stop" : (A._sfxErr ? "error" : "done")); A._sfxErr = false; } catch {}
      try { flushSessionRecap(); } catch {}
      A.running = false;
      A.stop = false;
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
      const droppedSteering = A.steeringQueue.length;
      ui.clearSteeringSteering(); // never leak instructions into a later task/chat
      if (droppedSteering) ui.toast("The task stopped before queued steering could be applied");
      if (steeringWasStopped) ui.steeringProgress("stopped", "Stopped safely at a command boundary", toolTurns);
      else ui.syncSteeringUi();
      diag("loop.end");
    }
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", RS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → " Stopping…", disabled
    ui.steeringProgress("stopped", "Stopping safely — no new command will start", A.steeringStep);
    P.stopGeneration();
    ui.toast("Stopping the agent…");
  }

  // The full system prompt for the CURRENT provider and user settings. One
  // definition, used both by the bootstrap and by the periodic re-injection, so
  // the two can never drift apart.
    // ── Embedded command catalogue (1.33) ──
    // Every session used to start with the model calling list_commands and OR
    // pasting a 40-70k character catalogue back into the chat - slow on every
    // provider page and the single biggest token cost of a session. Roomy
    // providers now get a COMPACT signature index (same builder as
    // list_commands, universal + work-mode families first, ~16k chars) inside
    // the system prompt itself, so turn zero is just "ready". Providers with a
    // tight composer (compactCommandList) keep the forced bootstrap catalogue.
    const EMBED_CATALOGUE_DEFAULT_CHARS = 20000;
    function embeddedCatalogue(engine) {
      try {
        if (P.compactCommandList || P.embedCatalogue === false) return "";
        const budget = Math.max(0, Number(P.embedCatalogueChars) || EMBED_CATALOGUE_DEFAULT_CHARS);
        if (!budget || !A.toolList || !A.toolList.length) return "";
        const requested = engine === "local" ? "local" : "roblox";
        const allScoped = A.toolList.filter((t) => t && (t.server || requested) === requested && !t.hidden);
        if (!allScoped.length) return "";
        const animLines = requested === "roblox" && typeof RSAnim !== "undefined" ? RSAnim.describeCommands() : [];
        const skillLines = requested === "roblox" && typeof RobloxScriptSkills !== "undefined" ? RobloxScriptSkills.describeCommands() : [];
        const agentLines = requested === "local" && typeof AgentScriptSkills !== "undefined" ? AgentScriptSkills.describeCommands() : [];
        const helperNames = ["or_screenshot", "or_debug", "get_template", "or_status", "web_fetch", "web_search", "capture_id", "or_agent"];
        const helperTools = helperNames.filter((hn) => !allScoped.some((t) => t.name === hn)).map((hn) => A.toolList.find((t) => t && t.name === hn)).filter(Boolean);
        let focusMode = "ultimate";
        try { focusMode = normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()); } catch {}
        let focusNames = [], focusBlock = "";
        if (WORK_MODES[focusMode] && WORK_MODES[focusMode].focus) {
          focusNames = workModeFocusNames(focusMode, [...allScoped.map((t) => t.name), ...[...animLines, ...skillLines, ...agentLines].map(nameFromLine)]);
          if (focusNames.length) focusBlock = `━━━ ${WORK_MODES[focusMode].badge} WORK MODE FOCUS — ${focusNames.length} commands you are expected to use heavily (the UNIVERSAL set above plus this mode's family; all listed with their signatures below) ━━━\n\n`;
        }
        const headers = [...animLines, ...skillLines, ...agentLines].filter((l) => !nameFromLine(l));
        const text = buildCatalogue({
          toolName: "list_commands", requested,
          heading: "━━━ COMMAND CATALOGUE (embedded; this IS the list_commands result - do NOT call list_commands {} to fetch it again) ━━━",
          nativeTools: [...allScoped, ...helperTools],
          virtualLines: [...animLines, ...skillLines, ...agentLines],
          webLines: headers,
          focusBlock, focusNames, compact: true, limit: budget, lineLimit: Math.max(120, Number(P.embedCatalogueLines) || 420),
        });
        diag("sys.embeddedCatalogue", { chars: text.length, lines: text.split("\n").length, budget, engine: requested });
        return text;
      } catch (e) { diag("sys.embeddedCatalogueFailed", { error: String(e && e.message || e) }); return ""; }
    }
    function systemPrompt(opts) {
      opts = opts || {};
      let engine = "roblox";
      try { if (typeof window.__rsEngine === "function") engine = window.__rsEngine(); } catch {}
      const catalogue = opts.embedCatalogue === false ? "" : embeddedCatalogue(engine);
      const text = RS.buildSystemPrompt({
        siteName: P.displayName,
        customPrompt: ui.getCustomPrompt(),
        memory: ui.getCustomMemory(),
        providerNotes: P.promptExtra || "",
        providerId: P.id,
        engine,
        fullAccess: !!(typeof window.__rsFullAccess === "function" && window.__rsFullAccess()),
        maxChars: P.sysMaxChars || 0,
        catalogue,
      });
      A.sysEmbeddedCatalogue = !!catalogue && text.includes("COMMAND CATALOGUE (embedded");
      // Context-meter cache: the bar shows an approximate token cost next to
      // Start so users understand why big prompts can degrade weaker chats.
      try { A.sysInfo = { len: text.length, tokens: Math.round(text.length / 4), engine, catalogue: catalogue.length }; } catch {}
      return text;
    }

  // ── Periodic system-prompt re-injection (opt-in, per provider) ────────────
  // Some sites aggressively summarise their own context mid-conversation. When
  // that happens the model keeps the gist of the task but loses the MECHANISM:
  // it forgets that an extension reads its replies and executes them, and starts
  // answering "I can't invoke those commands in this session" while the
  // extension sits there ready and waiting. Observed repeatedly on ChatGPT.
  //
  // The periodic tools reminder does NOT fix this: it re-anchors command NAMES,
  // but it never restates that the commands actually run. So providers that need
  // it set `resendSystemEvery`, and the whole prompt goes back in.
  //
  // Delivery rides on the next injected tool result rather than costing its own
  // message - free and invisible. But that channel dries up in exactly the case
  // this exists for (a model that has forgotten it can call tools stops calling
  // them, so no results flow), so a fallback sends it as its own masked turn
  // once the window has elapsed with nothing to piggyback on.
  const RESEND_SYS_EVERY = P.resendSystemEvery || 0;
  // Injected tool results get their own, larger budget (see sysResendDue).
  const RESEND_SYS_EVERY_RESULTS = 12;

  // How much conversation has accumulated since the operating instructions were
  // last stated. PERSISTED per conversation, because both simpler designs failed
  // in opposite directions - each caught live on 2026-08-14:
  //
  //  - An in-memory counter RESETS on every page reload, while the session
  //    itself survives one (A.started is persisted). After an F5, or a silent
  //    Chrome extension auto-update, the tally restarted and the re-statement
  //    could be postponed indefinitely.
  //  - Walking the DOM back to the last SYS_MARKER turn is reload-proof but
  //    UNDER-counts badly: these sites virtualize. Measured on a real ChatGPT
  //    session that had long passed the threshold - only 12 turns were rendered,
  //    the marker was not among them (so the walk silently counted from the top
  //    of the window) and it saw 5 injected results instead of the true total.
  //
  // Counting at INJECTION time and persisting sidesteps both: it is exact, and
  // virtualization cannot erase it. The DOM walk is kept as a floor, since a
  // conversation that visibly shows the threshold is due no matter what storage
  // says (e.g. a session adopted from another device, or storage cleared).
  const sysKey = () => `rsSys:${P.conversationKey() || "new"}`;
  let sysCount = { users: 0, results: 0 };
  let sysCountKey = "";

  // Hydrate from storage. Only meaningful at startup / on a conversation switch;
  // it never overwrites counts already accumulated in this tick's memory (a
  // bump that landed while the async read was in flight must not be lost).
  async function loadSysCount() {
    const k = sysKey();
    if (k === sysCountKey) return sysCount;
    sysCountKey = k;
    const local = sysCount;
    sysCount = { users: 0, results: 0 };
    try {
      const r = await new Promise((res) => chrome.storage.local.get(k, res));
      const saved = r && r[k];
      if (saved) sysCount = {
        users: Math.max(saved.users || 0, local.users || 0),
        results: Math.max(saved.results || 0, local.results || 0),
      };
    } catch {}
    return sysCount;
  }
  function saveSysCount() {
    try { chrome.storage.local.set({ [sysCountKey]: sysCount }); } catch {}
  }
  // Increment SYNCHRONOUSLY, persist asynchronously. sysResendDue() reads
  // sysCount in the same tick as the bump that should trip it, so deferring the
  // increment into the storage promise made the tally lag a full turn behind and
  // the threshold was never seen at the moment it mattered (caught live: 12 tool
  // results, counter still reading 11, no rider). Storage is a durability
  // mechanism here, not the source of truth for the current tick.
  function bumpSys(field) {
    if (!RESEND_SYS_EVERY) return;
    if (sysCountKey !== sysKey()) { sysCountKey = sysKey(); }
    sysCount[field]++;
    saveSysCount();
  }
  function resetSysCount() {
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }

  // Lower bound read straight from what is on screen (see above).
  function sinceLastSysInDom() {
    const items = P.allItems();
    let users = 0, results = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = P.classifyText(it, ".rs-chip");
      // The bootstrap turn and every rider both carry the marker - either one
      // means the rules were fully stated here, so stop counting.
      if (txt.includes(RS.SYS_MARKER)) break;
      if (!P.isUserItem(it)) continue;
      if (RSParse.isInjectedFeedback(txt)) results++;
      else users++;
    }
    return { users, results };
  }

  function sinceLastSys() {
    const dom = sinceLastSysInDom();
    return {
      users: Math.max(sysCount.users, dom.users),
      results: Math.max(sysCount.results, dom.results),
    };
  }

  // A re-statement is owed once EITHER budget is spent. Two triggers because
  // they measure different things: user turns track a long back-and-forth, while
  // injected results track context VOLUME - and volume is what actually makes
  // the site summarise. Measured live on 2026-08-14: in a real session 5 of the
  // 6 "user" turns were injected tool results and only ONE was typed by Seb, so
  // a user-turn-only trigger sat at 1/6 while five full tool payloads had
  // already landed. The results budget is the one that fires in practice.
  function sysResendDue() {
    if (A.forceSysResend) return true;   // mode toggled (Forge/Extra) — restate NOW
    if (!RESEND_SYS_EVERY) return false;
    const { users, results } = sinceLastSys();
    const due = users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS;
    // Logged sparsely on purpose: this is consulted on EVERY tool result, and an
    // entry each time would flush the 300-slot diag ring of everything else -
    // exactly the history you need when something goes wrong. The verdict turn
    // and every 4th result is enough to reconstruct the tally.
    if (due || results % 4 === 0) {
      diag("sys.tally", {
        users, results, due,
        mem: `${sysCount.users}/${sysCount.results}`,
        need: `${RESEND_SYS_EVERY}u ${RESEND_SYS_EVERY_RESULTS}r`,
      });
    }
    return due;
  }
  // Attach the prompt to an outgoing tool result IF it fits. The result is never
  // truncated to make room: the passenger is dropped and the flag stays raised,
  // so it rides the next result instead. A tool result the model is waiting on
  // is always worth more than a reminder.
  // 1.34: the focus family of the active work mode as packed signatures - the
  // part of the embedded catalogue that changes when the user switches modes.
  function workModeFocusSignatures(limitChars) {
    try {
      let mode = "ultimate";
      try { mode = normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()); } catch {}
      const tools = (A.toolList || []).filter((t) => t && (t.server || "roblox") === "roblox" && !t.hidden);
      const animLines = typeof RSAnim !== "undefined" ? RSAnim.describeCommands() : [];
      const skillLines = typeof RobloxScriptSkills !== "undefined" ? RobloxScriptSkills.describeCommands() : [];
      const names = workModeFocusNames(mode, [...tools.map((t) => t.name), ...[...animLines, ...skillLines].map(nameFromLine)]);
      if (!names.length) return "";
      const want = new Set(names);
      const sigs = [];
      const seen = new Set();
      for (const line of [...animLines, ...skillLines]) { const nm = nameFromLine(line); if (nm && want.has(nm) && !seen.has(nm)) { seen.add(nm); sigs.push(sigFromLine(line) || `${nm} {}`); } }
      for (const t of tools) if (want.has(t.name) && !seen.has(t.name)) { seen.add(t.name); sigs.push(toolSignature(t)); }
      const packed = packSignatures(sigs, Math.max(1200, limitChars || 6000), 160);
      return `${WORK_MODES[mode].badge} FOCUS FAMILY (${sigs.length} commands; callable as shown${packed.omitted ? `, ${packed.omitted} more via list_commands {"query":"keyword"}` : ""}):\n${packed.text}`;
    } catch { return ""; }
  }
  function withSysResend(text) {
    if (!sysResendDue()) return text;
    const periodicDue = (() => { try { const { users, results } = sinceLastSys(); return !!RESEND_SYS_EVERY && (users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS); } catch { return false; } })();
    if (A.workModeSwitchPending && !periodicDue) {
      // Work-mode switch only: a ~6-10k rider (new profile + its focus
      // signatures) instead of the full 30k+ prompt; the periodic restate
      // keeps its own schedule.
      let mode = "ultimate";
      try { mode = normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()); } catch {}
      const tight = !!(P.sysMaxChars && P.sysMaxChars < 16000) || !!P.compactCommandList;
      const rider = "\n\n────────────────────────────────\n" + RS.RESEND_MARKER + "\n"
        + RS.workModeSwitchNote(mode, { tight })
        + "\n\n" + workModeFocusSignatures(tight ? 2500 : 6000);
      const cap = P.sendCharBudget || Infinity;
      if (text.length + rider.length > cap) { diag("sys.modeSwitchDeferred", { result: text.length, rider: rider.length, cap }); return text; }
      A.workModeSwitchPending = false;
      A.forceSysResend = false;
      A.sysResendAt = Date.now();
      diag("sys.modeSwitch", { mode, chars: rider.length, tight });
      return text + rider;
    }
    const prompt = systemPrompt({ embedCatalogue: false });
    const rider =
      "\n\n────────────────────────────────\n" +
      RS.RESEND_MARKER + "\n" +
      "(System note from RobloxScript - an automatic re-statement of your operating " +
      "instructions, NOT a new request and NOT something to reply to. This conversation " +
      "may have been summarised, which drops the part explaining how you actually run " +
      "commands. To be explicit: the RobloxScript extension IS running in this page right " +
      "now, it DOES read your replies, and the commands below DO execute for real - the " +
      "results you have been receiving are proof of it. Keep using them exactly as " +
      "described. Just carry on with the task; do not acknowledge this note.)\n" +
      prompt;
    const cap = P.sendCharBudget || Infinity;
    if (text.length + rider.length > cap) {
      // Stays due - the next (smaller) result carries it.
      diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap });
      return text;
    }
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    A.forceSysResend = false;   // mode-change restate delivered
    A.workModeSwitchPending = false; // the full prompt carries the new mode too
    diag("sys.resend", { via: "toolResult", chars: rider.length, ...spent });
    return text + rider;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  // Stable bridge between the session controller and the settings-owned memory.
  // Keep this at the controller scope: settings UI is mounted in a nested scope,
  // so calling its local helper from startup can otherwise produce a ReferenceError.
  function clearTaskMemory() {
    try {
      if (typeof window.__rsClearTaskMemory === "function") { window.__rsClearTaskMemory(); return; }
      chrome.storage.local.get("rsCustomMemory", (r) => {
        const m = r && r.rsCustomMemory;
        if (m && typeof m === "object" && m.task) chrome.storage.local.set({ rsCustomMemory: { ...m, task: "" } });
      });
    } catch {}
  }

  // ═════════════════════════════════════════════════════════════════
  //  AUTO SESSION RECAP (memory that writes itself)
  //  The user-maintained coding memory only knows what the user typed into it.
  //  Everything the agent actually DID in a session - which scripts it edited,
  //  which commands it leaned on, what failed - evaporated with the chat. This
  //  recorder keeps a compact, factual trail of the last few sessions in
  //  chrome.storage (rsAutoMemory) and the system prompt surfaces it as a
  //  read-only "Recent sessions" block, so a fresh chat starts with continuity
  //  ("last time you edited ServerScriptService.Main and the lint pass was
  //  clean") instead of from zero. Opt-out: rsAutoRecap=false (menu toggle).
  const RECAP_MAX_SESSIONS = 4;
  const RECAP_MAX_CHARS = 2200;
  const SESSION = { startedAt: 0, count: 0, tools: Object.create(null), touched: new Set(), errors: [], last: "", place: "" };
  let autoRecap = [];
  let autoRecapEnabled = true;
  try {
    chrome.storage.local.get(["rsAutoMemory", "rsAutoRecap"], (r) => {
      if (r && Array.isArray(r.rsAutoMemory)) autoRecap = r.rsAutoMemory.slice(0, RECAP_MAX_SESSIONS);
      if (r && r.rsAutoRecap === false) autoRecapEnabled = false;
    });
  } catch {}
  const REPEAT = { sig: "", count: 0 };
  function applyRepeatGuard(call, feedback) {
    const text = String(feedback || "");
    const failed = /^\s*ERROR\b/.test(text);
    let sig = "";
    try { sig = String(call.tool || "") + "|" + JSON.stringify(call.arguments || {}); } catch { sig = String(call.tool || ""); }
    if (failed && sig === REPEAT.sig) REPEAT.count++;
    else { REPEAT.sig = failed ? sig : ""; REPEAT.count = failed ? 1 : 0; }
    if (!failed || REPEAT.count < 2) return feedback;
    const n = REPEAT.count;
    diag("tool.repeatFail", { name: call.tool, n });
    return text + `\n\n[LOOP GUARD] This exact call (same command, same parameters) has now failed ${n} times in a row. Do NOT send it again unchanged.${n >= 3 ? " Stop retrying it." : ""} Change the approach: read the current state first (script_read / inspect_instance / get_studio_state), fix the parameter the error names, split the step into smaller commands, or use a different command. If it genuinely cannot be done, tell the user what blocks it instead of retrying.`;
  }
  function sessionTouchedPath(tool, args) {
    if (!args || typeof args !== "object") return "";
    const bare = bareToolName(tool);
    if (/^(script_|multi_edit|memory_|model_)/.test(bare) || /_(set|create|add|apply|paint|fix)$/.test(bare)) {
      const v = args.path || args.script || args.root || args.parent_path || args.name || "";
      return typeof v === "string" ? v.slice(0, 80) : "";
    }
    return "";
  }
  function recordSessionTool(tool, args, feedback) {
    if (!autoRecapEnabled || !tool) return;
    if (!SESSION.startedAt) SESSION.startedAt = Date.now();
    const bare = bareToolName(tool) || tool;
    SESSION.count++;
    SESSION.tools[bare] = (SESSION.tools[bare] || 0) + 1;
    const touched = sessionTouchedPath(tool, args);
    if (touched && SESSION.touched.size < 12) SESSION.touched.add(touched);
    const text = String(feedback || "");
    if (/^\s*ERROR\b/.test(text)) {
      const first = text.split("\n")[0].replace(/\s+/g, " ").slice(0, 140);
      if (!SESSION.errors.includes(first)) { SESSION.errors.push(first); if (SESSION.errors.length > 3) SESSION.errors.shift(); }
    } else if (bare !== "list_commands") {
      SESSION.last = bare;
      if (!SESSION.place && /^(get_studio_state|place_info|game_stats|inspect_workspace)$/.test(bare)) {
        const m = text.match(/"(?:placeName|PlaceName|place_name|name)"\s*:\s*"([^"]{1,60})"/) || text.match(/\bPlace(?:Name| name)?\s*[:=]\s*"?([^"\n,}]{1,60})/i);
        if (m && m[1] && !/^\d+$/.test(m[1].trim())) SESSION.place = m[1].trim();
      }
    }
  }
  function flushSessionRecap() {
    if (!autoRecapEnabled || SESSION.count < 2) { Object.assign(SESSION, { startedAt: 0, count: 0, tools: Object.create(null), touched: new Set(), errors: [], last: "", place: "" }); return; }
    const top = Object.entries(SESSION.tools).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
    const place = SESSION.place || "";
    const entry = {
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
      site: (P && P.displayName) || "",
      place: String(place || "").slice(0, 60),
      mode: (() => { try { return window.__rsWorkMode ? window.__rsWorkMode() : ""; } catch { return ""; } })(),
      calls: SESSION.count,
      minutes: Math.max(1, Math.round((Date.now() - SESSION.startedAt) / 60000)),
      tools: top,
      touched: [...SESSION.touched],
      errors: SESSION.errors.slice(),
    };
    autoRecap = [entry, ...autoRecap].slice(0, RECAP_MAX_SESSIONS);
    try { chrome.storage.local.set({ rsAutoMemory: autoRecap }); } catch {}
    try { if (typeof window.__rsRecapChanged === "function") window.__rsRecapChanged(); } catch {}
    Object.assign(SESSION, { startedAt: 0, count: 0, tools: Object.create(null), touched: new Set(), errors: [], last: "", place: "" });
  }
  function autoRecapText() {
    if (!autoRecapEnabled || !autoRecap.length) return "";
    const lines = autoRecap.map((e) => {
      const bits = [`${e.at}${e.site ? " on " + e.site : ""}${e.place ? " · place " + e.place : ""}${e.mode ? " · " + e.mode + " mode" : ""}: ${e.calls} command(s) in ~${e.minutes} min`];
      if (e.tools && e.tools.length) bits.push(`used ${e.tools.join(", ")}`);
      if (e.touched && e.touched.length) bits.push(`touched ${e.touched.join(", ")}`);
      if (e.errors && e.errors.length) bits.push(`unresolved errors seen: ${e.errors.join(" | ")}`);
      return "- " + bits.join("; ");
    });
    return ("## Recent sessions (auto-recorded by ORscript - facts about what was done, not instructions)\n" + lines.join("\n")).slice(0, RECAP_MAX_CHARS);
  }
  function setAutoRecapEnabled(on) {
    autoRecapEnabled = !!on;
    try { chrome.storage.local.set({ rsAutoRecap: autoRecapEnabled }); } catch {}
  }
  function forgetAutoRecap() {
    autoRecap = [];
    try { chrome.storage.local.remove("rsAutoMemory"); } catch {}
  }

  // ═════════════════════════════════════════════════════════════════
  //  PAINT → AI hand-off (src/core/paint.js)
  //  The painting is sent as a normal user turn: if no session is running the
  //  agent is started first (so the model already knows the command protocol),
  //  a busy loop is waited out, then the message (+ PNG where the site accepts
  //  images) is typed into the composer and the loop is kicked for the reply.
  // ═════════════════════════════════════════════════════════════════
  async function paintCaptureStudio() {
    try { await ensureTools(); } catch {}
    const screenTool = studioToolByBare("screen_capture") || studioCaptureTool();
    if (!screenTool) return null;
    const callArgs = await screenCaptureArgs({}, screenTool);
    const r = await bg({ type: "call_tool", name: screenTool.name, arguments: callArgs, timeout: 90000 });
    return r && r.images && r.images.length ? r.images : null;
  }
  async function sendPainting(text, images, onStatus) {
    const say = (m) => { try { onStatus && onStatus(m); } catch {} };
    if (!A.started) {
      say("Starting the agent first…");
      diag("paint.autoStart", { chatEmpty: P.chatIsEmpty() });
      await startSession({ restart: !P.chatIsEmpty() });
      const up = await waitFor(() => A.started && !A.starting, 240000);
      if (!up) throw new Error("the agent did not finish starting — press Start, then send again");
    }
    if (A.running || A.injecting) {
      say("Agent is busy — your drawing goes out as soon as this step finishes…");
      const free = await waitFor(() => !A.running && !A.injecting, 600000);
      if (!free) throw new Error("the agent stayed busy — stop it and send again");
    }
    const base = P.assistantCount();
    let sent = false;
    if (images && images.length) {
      try { ui.showImages(images, "paint"); } catch {}
      try { sent = (await P.typeAndSend(text, images)) !== false; } catch (e) { diag("paint.sendImageFail", { err: String(e && e.message || e).slice(0, 160) }); }
      if (!sent) say("Image upload refused — sending the vector description instead…");
    }
    if (!sent) { try { sent = (await P.typeAndSend(text)) !== false; } catch (e) { diag("paint.sendFail", { err: String(e && e.message || e).slice(0, 160) }); } }
    if (!sent) return false;
    A.userStopped = false; bumpSys("users");
    try { ui.steeringProgress("waiting", "Drawing sent — waiting for the AI's reading", 0); } catch {}
    setTimeout(() => { if (A.started && !A.running && !A.userStopped) agentLoop(base); }, 350);
    diag("paint.sent", { chars: text.length, images: images ? images.length : 0 });
    return true;
  }
  function openPaint() {
    if (typeof ORPaint === "undefined") { ui.toast("Paint module missing — reload the extension"); return; }
    ORPaint.open({
      send: sendPainting,
      captureStudio: paintCaptureStudio,
      engine: () => activeEngine(),
      canAttachImages: () => typeof P.attachImages === "function" || /\bimages\b/.test(String(P.typeAndSend)),
      workMode: () => { try { return window.__rsWorkMode ? window.__rsWorkMode() : "ultimate"; } catch { return "ultimate"; } },
      toast: (m) => ui.toast(m),
      diag,
    });
  }
  window.__rsOpenPaint = openPaint;

  async function startSession(opts = {}) {
    const isRestart = !!(opts && opts.restart);
    if (A.running || A.starting) { diag("start.duplicateIgnored", { running:A.running, starting:A.starting }); return; }
    // A new session = a new crew board (plan, findings, verification).
    try { if (typeof ORAgentCrew !== "undefined" && ORAgentCrew) { ORAgentCrew.reset(); A.agentRole = ""; } } catch {}
    if (providerInitError && !initializeProvider()) {
      ui.banner("warn", `${P.displayName || "AI provider"} failed to initialize`, `${providerInitError.message}. Reload the provider page; Start can be retried after the adapter loads.`);
      return;
    }
    if (!providerHooksReady) {
      const detail = providerHooksError ? providerHooksError.message : "message hooks were not installed";
      ui.banner("warn", `${P.displayName || "AI provider"} is not ready`, `${detail}. Reload this provider page before retrying Start.`);
      diag("start.hooksUnavailable", { provider:P.id, error:detail });
      return;
    }
    // "Start session" is normally allowed ONLY on a blank conversation.
    // A "Restart" (existing chat, user explicitly clicked ↻ Restart) bypasses
    // this and injects the system prompt mid-chat so the AI will work.
    if (!isRestart && !P.chatIsEmpty() && !A.started) {
      ui.toast("Open a new chat first, then Start");
      return;
    }
    // Task notes are scratch memory. Keep coding/project preferences for the same
    // project, but never leak the previous task into the next one.
    clearTaskMemory();
    A.userStopped = false;
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ?  P.lastAssistantId() : null;
    A.starting = true;
    A.steeringStep = 0;
    ui.steeringProgress("starting", "Refreshing tools and checking Studio", 0);
    A._startingSince = Date.now(); // stale-bootstrap failsafe anchor (meter loop)
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    try {
      // The lock/cover live INSIDE the try: if any UI/provider call between
      // here and the first await throws, the finally still releases them. They
      // used to sit before the try - an exception there stuck A.starting true
      // with the composer locked and every failsafe gated off (frozen chat).
      ui.setStarting(true);
      ui.updateStartGate(); // refresh the bar into its "starting" state
      P.setInputLock(true); // block user input during bootstrap
      ui.inputCover(true);  // cover the composer ("Working…") for the WHOLE Starting Up
      await ensureTools(true); // boot: always take a fresh catalogue (the TTL then
                               // covers the list_commands / list_mcp_servers calls
                               // the model makes seconds later)
      if (!alive()) return;
      if (!A.toolList.length) {
        const eng = activeEngine();
        const tip = eng === "local"
          ? `Couldn't reach AgentScript. Run ${RUN_CMD} and give it another shot.`
          : `Couldn't grab the tools. Run ${RUN_CMD} and make sure Studio's actually open, then give it another shot.`;
        ui.banner("warn", "Bridge isn't talking", tip);
        return;
      }
      // Providers that are prone to inventing connectivity must not receive a
      // bootstrap prompt until the selected engine is genuinely usable. Besides
      // preventing contradictory "linked/offline" prompts, this leaves a failed
      // Start on a clean conversation so the user can connect Studio and retry
      // immediately instead of being forced to open another chat.
      if (P.requireLiveEngineAtBootstrap) {
        await refreshCurrentEngineState();
        if (!currentEngineIsLive()) {
          const local = activeEngine() === "local";
          diag("start.enginePreflightOffline", { engine: activeEngine() });
          ui.banner("warn", local ? "AgentScript is not connected" : "Roblox Studio is not connected",
            local
              ? `Start ${RUN_CMD}, select a workspace, then press Start again.`
              : "Open your place in Roblox Studio and enable its MCP server, then press Start again.");
          return;
        }
      }
      const modeState = await startupTimeout(P.ensureComposerReady("startup"), 15000, `${P.displayName} composer initialization`);
      if (!alive()) return;
      if (!modeState || !modeState.ready) {
        ui.banner("warn", `${P.displayName} isn't ready`,
          (modeState && modeState.detail) ||
          `Couldn't find ${P.displayName}'s chat box. Open a new chat or reload the page.`);
        return;
      }
      const prompt = systemPrompt();
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }
      if (["context_limit", "provider_error", "too_long"].includes(startRes.kind)) {
        ui.banner("warn", `${P.displayName} could not start`,
          (startRes.detail || "The provider rejected the startup request.") + " Try again after resolving the provider error.");
        return;
      }
      if (startRes.kind === "empty" || startRes.kind === "timeout") {
        ui.banner("warn", `${P.displayName} did not answer`,
          "The startup message was sent but no usable response arrived. Retry Start; if it repeats, reload the provider page.");
        return;
      }

      // If the model calls list_commands as instructed, run it and wait for the
      // "ready" reply. Some constrained model lanes intermittently return
      // their bootstrap call in renderer-only/native syntax; if extraction misses
      // it, a session used to be marked ready WITHOUT ever giving the model the
      // command catalogue. Providers can force this deterministic fallback: OR
      // runs list_commands itself and injects the exact same result, so Starting
      // cannot strand the user merely because the model formatted turn zero badly.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      const requestedCatalogue = startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
        (firstName === "list_commands" || firstName === "list_tools");
      const forcedCatalogue = !!P.forceBootstrapCatalogue && !requestedCatalogue;
      if (requestedCatalogue || forcedCatalogue) {
        if (requestedCatalogue) decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        else diag("start.catalogueFallback", { firstKind: startRes.kind, firstName: firstName || "" });
        const catalogueCall = requestedCatalogue ? startRes.calls[0] : { tool: "list_commands", arguments: {} };
        let toolFeedback = await runTool(catalogueCall);
        // Engine down short-circuits list_commands into a plain "offline" note
        // instead of the real catalogue - detect that and show it as such, rather
        // than the STALE cached tool count below.
        const offlineCatalogue = /Roblox Studio is currently OFFLINE|AgentScript is currently OFFLINE|Unreal Editor is currently OFFLINE/.test(toolFeedback);
        // Bootstrap bypasses agentLoop's normal result path, so attach the same
        // authoritative state line explicitly. Without it a provider could infer
        // Studio connectivity from the mere existence of cached command names.
        { const _tag = asStateTag(); if (_tag && !toolFeedback.includes("[SYSTEM_STATE:")) toolFeedback += "\n" + _tag; }
        if (requestedCatalogue && offlineCatalogue) {
          decorate.toolBox(startRes.item, "Loading commands", "err", `${activeEngine() === "local" ? "AgentScript" : "Roblox"} offline`, true);
        } else if (requestedCatalogue) {
          // Count what the model ACTUALLY received for the current engine.
          const _cur = activeEngine();
          const cnt = A.toolList.filter((t) => (t.server || _cur) === _cur).length;
          decorate.toolBox(startRes.item, "Loading commands", "done", `${cnt} commands`, true);
        }
        // The engine can disappear between preflight and the catalogue call.
        // Do not wait for another model turn after authoritative OFFLINE output;
        // that turned a clean connectivity failure into a multi-minute spinner.
        if (offlineCatalogue && P.requireLiveEngineAtBootstrap) {
          diag("start.engineOffline", { engine: activeEngine() });
          ui.banner("warn", activeEngine() === "local" ? "AgentScript is not connected" : "Roblox Studio is not connected",
            activeEngine() === "local"
              ? `Start ${RUN_CMD}, select a workspace, then press Restart.`
              : "Open your place in Roblox Studio and enable its MCP server, then press Restart.");
          return;
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2); // wait for "I'm ready" reply
        if (!alive()) return;
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
        if (["context_limit", "provider_error", "too_long", "empty", "timeout"].includes(readyRes.kind)) {
          ui.banner("warn", `${P.displayName} could not finish startup`,
            readyRes.detail || "The command catalogue was delivered, but the provider did not return a usable ready response. Press Restart to retry.");
          return;
        }
      }
      A.started = true;
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
      const _eng = activeEngine() === "local" ? "AgentScript" : "Roblox";
      ui.steeringProgress("idle", `Ready to co-build in ${_eng}`, 0);
      ui.toast(`Ready — tell ${P.displayName} what to build in ${_eng}.`);
    } catch (e) {
      if (e instanceof SendAbortedError) {
        // The bootstrap send never landed (e.g. Crax guest mode silently no-ops
        // sends). "Couldn't send that" is already on screen - stop quietly and
        // leave Start available instead of a raw "Startup failed" banner.
        diag("start.sendAborted", {});
      } else if (alive()) {
        ui.banner("warn", "Startup failed", String((e && e.message) || e));
      }
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        try { P.setInputLock(false); } catch (e) { diag("start.unlockFailed", { provider:P.id, error:String(e&&e.message||e) }); } // always unlock after bootstrap
        if (!A.started) {
          ui.clearSteeringSteering();
          ui.steeringProgress(A.stop || A.userStopped ? "stopped" : "error",
            A.stop || A.userStopped ? "Startup stopped" : "Startup did not complete", 0);
        }
        decorate.sweep();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    screen:  SVG('<rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    roblox:  SVG('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    read:    SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    edit:    SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    generate: SVG('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>'),
    tool:    SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result:  SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    check:   SVG('<polyline points="20 6 9 17 4 12"/>'),
    // Bell - the mid-session system-prompt re-statement. Deliberately NOT the
    // gear: the gear means "the agent is starting up", and a reminder is the
    // opposite (a session already long enough to need re-anchoring).
    remind:  SVG('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    error:   SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    gear:    SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 11h.1a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z"/>'),
  };
  const SPIN = '<span class="rs-spin"></span>';

  function iconFor(category, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return ICONS.error;
    if (phase === "done") return ICONS.check;
    if (phase === "result") return ICONS.result;
    if (phase === "sys") return ICONS.gear;
    if (phase === "remind") return ICONS.remind;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    if (P.immutableTranscript && P.clearImmutableChip) { try { P.clearImmutableChip(item, { force: true }); } catch {} }
    const chip = item.querySelector(".rs-chip");
    if (chip) chip.remove();
    item.classList.remove("rs-hidden");
    item.querySelectorAll(".rs-tool-hide").forEach((e) => e.classList.remove("rs-tool-hide"));
    item.querySelectorAll(".rs-cmd-mask").forEach((e) => e.classList.remove("rs-cmd-mask"));
    delete item.dataset.rs;
    delete item.dataset.rsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__rsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      // Immutable transcripts (Notion): the response editor is DOM-locked, so
      // the provider draws the card through its own stylesheet and nothing is
      // inserted into, or classed on, the host's nodes.
      if (P.immutableTranscript && P.renderImmutableChip && (!whole || !P.canRenderImmutableChip || P.canRenderImmutableChip(item, opts))) {
        try { P.renderImmutableChip(item, opts); } catch {}
        item.dataset.rs = cls || "1";
        item.__rsChip = { ...opts };
        return null;
      }
      let chip = item.querySelector(".rs-chip");
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="rs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ?  1 : 0}|${label}|${detail}|${hasBody ?  body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `rs-chip cat-${category} ${cls || ""}`;
        chip.innerHTML =
          `<div class="rs-chip-head">` +
            `<span class="rs-chip-ic">${iconFor(category, phase)}</span>` +
            `<span class="rs-chip-tx"></span>` +
            `<span class="rs-chip-dt"></span>` +
            (hasBody ?  `<span class="rs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>` : "") +
          `</div>` +
          (hasBody ?  `<div class="rs-chip-body"><pre></pre></div>` : "");
        chip.querySelector(".rs-chip-tx").textContent = label;
        if (detail) chip.querySelector(".rs-chip-dt").textContent = detail;
        if (hasBody) {
          chip.querySelector(".rs-chip-body pre").textContent = body;
          const head = chip.querySelector(".rs-chip-head");
          head.style.cursor = "pointer";
          head.onclick = () => chip.classList.toggle("open");
        }
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("rs-hidden");
      } else {
        item.classList.remove("rs-hidden");
        // findToolBlockSpot ALSO applies the .rs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ?  P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ?  chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.rs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__rsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .rs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      if (P.immutableTranscript && P.renderImmutableChip) {
        // The provider retains the settled state across Notion DOM remounts; an
        // old node's cached running options must not restart its spinner.
        const retained = P.immutableChipPresent && P.immutableChipPresent(item);
        try { P.renderImmutableChip(item, retained ? {} : (item.__rsChip || {})); } catch {}
        return;
      }
      const opts = item.__rsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".rs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###LUA### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".rs-tool-hide") && !e.closest(".rs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .rs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".rs-tool-hide") &&
                 RSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ?  P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ?  "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || RS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop || (P.immutableTranscript && P.immutableChipOwned && P.immutableChipOwned(item))) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".rs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .rs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = P.immutableTranscript && P.immutableChipPresent ? !P.immutableChipPresent(item) : !item.querySelector(".rs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(RS.RESEND_MARKER)) {
        if (item.dataset.rs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ?  `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.rs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(RS.SYS_MARKER)) {
        const phase = A.starting ?  "run" : "sys";
        if (item.dataset.rs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && RSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        const steeringUpdate = /\[STEERING_STEERING:\s*(PENDING_COMMAND_SKIPPED|APPLY_NEXT)\]/.exec(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (steeringUpdate ? `${m ? m[1] + "-" : ""}steering-${steeringUpdate[1]}` : m ?  m[1] : "note") + "|" + (isErr ?  "err" : hasImg ?  "img" : "result");
        if (item.dataset.rsig !== sig || !item.classList.contains("rs-hidden") || chipGone) {
          this.chip(item, {
            label: steeringUpdate ? (m ? `${m[1]} · result + steering` : "Steering update") : m ?  `${m[1]} · result` : "result",
            detail: steeringUpdate && steeringUpdate[1] === "PENDING_COMMAND_SKIPPED" ? "pending command revised" : "",
            category: hasImg ?  "screen" : m ?  RS.toolCategory(m[1]) : steeringUpdate ? "remind" : "tool",
            body: txt, phase: isErr ?  "err" : "result",
            cls: isErr ?  "err" : "result", whole: true,
          });
          item.dataset.rsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.rsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !RSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".rs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ?  "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real RobloxScript session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasRsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && RSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = RSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: RSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __rsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            RSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          RSParse.isInjectedFeedback(P.classifyText(next, ".rs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ?  "err" : (orphanPending ?  "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ?  "stopped" : (orphanPending ?  "not run" : "");
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".rs-chip");
          // A Steering steer can supersede a pending call before dispatch. Preserve
          // that neutral "revised" outcome across reloads instead of treating the
          // following hidden steering note as evidence that the command ran.
          if (/\[STEERING_STEERING:\s*PENDING_COMMAND_SKIPPED\]/.test(nt)) {
            phase = "idle"; detail = "revised by you";
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          } else if (RSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: RSParse.toolNameFromText(txt) });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("rs-tool-hide") && !e.closest(".rs-tool-hide") &&
                 !e.closest(".rs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".rs-tool-hide") &&
                 RSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with Roblox screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = RSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".rs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ?  P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ?  { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".rs-chip")) {
        const tx = item.querySelector(".rs-chip-tx");
        const name = RSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.rs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.rs || item.dataset.zphase || item.querySelector(".rs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.rs || "chip-only" });
        resetDecoration(item);
      }
    },

    sweep() {
      if (P.immutableTranscript && P.syncImmutableChips) { try { P.syncImmutableChips(); } catch {} }
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".rs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".rs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, bar, dot, brandEl, stateEl, actionBtn, stopBtn, extraBtn, menuEl, unstableEl, cardsBtn, cardsPanel, supportBtn;
    let steeringStrip, steeringProgressEl, steeringStepEl, steeringDetailEl, steeringQueuedEl, steeringInput, steeringSendBtn;
    let cover, coverRaf, barRaf;
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    let bridgeOk = false, studioDown = false, placeDown = false, appDown = false, addonOk = false, studioProcUp = false;
    let robloxProcUp = false, unrealProcUp = false;
    let wasConnected = false, bridgeBannerEl = null;
    let currentEngine = "roblox"; // hoisted to ui scope so renderBar can read it
    // setEngine lives inside build(); expose it here so setStatus can drive it.
    let engineApi = null;
    let lastManualEngineAt = 0; // user toggled recently — auto-switch must not fight them

    function build() {
      root = document.createElement("div");
      root.id = "rs-root";
      // One consolidated status bar, anchored just above the site's composer
      // (positioned every frame by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites, custom prompt, support, Discord). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      root.innerHTML = `
        <div id="rs-bar">
          <div class="rs-cluster rs-cluster-left">
          <span id="rs-dot" class="off" title=""></span>
          <span id="rs-ornament" aria-hidden="true"></span>
          <img id="rs-logo" class="rs-logo" alt="" aria-hidden="true" draggable="false" src="${chrome.runtime.getURL("assets/icon128.png")}">
          <span id="rs-brand" data-rs-brand>OrScript</span>
          <span id="rs-work-badge" hidden></span>
          <span id="rs-crew-badge" hidden></span>
          <button type="button" id="rs-task-pill" hidden title="Task list"></button>
          <div id="rs-engine" data-engine="roblox">
            <span id="rs-engine-thumb"></span>
            <button data-mode="roblox" class="rs-mode-btn on" title="RobloxScript">RS</button>
            <button data-mode="local" class="rs-mode-btn" title="AgentScript">AS</button>
          </div>
          </div>
          <span id="rs-status-pill" hidden><span class="rs-status-dot"></span><span class="rs-status-text"></span></span>
          <span id="rs-state"></span>
          <span id="rs-unstable-inline" hidden title="This site can drop turns">⚠ unstable</span>
          <span id="rs-perf" hidden title="Performance budget"></span>
          <span id="rs-ctx" hidden title=""></span>
          <div class="rs-cluster rs-cluster-right">
          <button id="rs-action"></button>
          <button id="rs-stop" hidden>■ Stop</button>
          <button id="rs-extra" title="Think — the AI questions every assumption for the best solution">Think</button>
          <button id="rs-voice" type="button" aria-pressed="false" title="Enable voice coding">🎙 Voice</button>
          <button id="rs-undo" hidden title="Undo last Studio change the agent made">Undo</button>
          <button id="rs-discord" aria-label="Discord" title="OR Discord"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></button>
          <button id="rs-paint-btn" aria-label="Paint" title="Paint — draw it, the AI builds it (Ctrl+Shift+P)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4c-3 1-8 6-10 9l2 2c3-2 8-7 9-10z"/><path d="M8 15c-2 0-4 1-4 4 0 1-1 1-1 1s4 1 6-1c1-1 1-2 1-2z"/></svg></button>
          <button id="rs-settings-btn" aria-label="Settings" title="Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          </div>

        <div id="rs-cards-panel" hidden></div>
        <div id="rs-menu" hidden></div>
        <div id="rs-approve" hidden>
          <div class="rs-approve-card">
            <div class="rs-approve-kicker">Ask mode</div>
            <div class="rs-approve-title">Allow this action?</div>
            <div id="rs-approve-body"></div>
            <div class="rs-approve-actions">
              <button type="button" id="rs-approve-deny">Deny</button>
              <button type="button" id="rs-approve-allow">Allow</button>
            </div>
          </div>
        </div>
      `;
      document.documentElement.appendChild(root);
      try { if(globalThis.ORUICollisionManager) ORUICollisionManager.instance.initialize({root,provider:P.id}); } catch(e) { diag("collision.init.error",{error:String(e)}); }
      bar = root.querySelector("#rs-bar");
      dot = root.querySelector("#rs-dot");
      brandEl = root.querySelector("#rs-brand");
      stateEl = root.querySelector("#rs-state");
      actionBtn = root.querySelector("#rs-action");
      // Install the primary action handler immediately after creating the bar.
      // Template panels and provider-specific setup must never be able to prevent
      // Start Agent from receiving its click handler.
      if (actionBtn) actionBtn.onclick = onActionClick;
      stopBtn = root.querySelector("#rs-stop");
      extraBtn = root.querySelector("#rs-extra");
      steeringStrip = root.querySelector("#rs-steering-strip");
      steeringProgressEl = root.querySelector("#rs-steering-progress");
      steeringStepEl = root.querySelector("#rs-steering-step");
      steeringDetailEl = root.querySelector("#rs-steering-detail");
      steeringQueuedEl = root.querySelector("#rs-steering-queued");
      steeringInput = root.querySelector("#rs-steering-input");
      steeringSendBtn = root.querySelector("#rs-steering-send");
      const submitSteering = () => enqueueSteeringSteering(steeringInput && steeringInput.value);
      if (steeringSendBtn) steeringSendBtn.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault(); submitSteering();
      });
      if (steeringInput) {
        // Never let provider/global Enter handlers mistake this OR-owned field for
        // the host composer. Steering is queued; agentLoop submits it only at a
        // safe boundary, so it cannot collide with an in-flight provider send.
        steeringInput.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitSteering(); }
        });
        steeringInput.addEventListener("keyup", (e) => e.stopPropagation());
      }
      const undoBtn = root.querySelector("#rs-undo");
      supportBtn = root.querySelector("#rs-settings-btn");
      const voiceBtn = root.querySelector("#rs-voice");
      let voiceRecognition = null;
      let voiceRunning = false;
      const voiceEditor = () => { try { return P.getEditor && P.getEditor(); } catch { return null; } };
      const writeVoiceText = (text) => {
        const ed = voiceEditor(); if (!ed || !text) return false;
        ed.focus();
        if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") {
          const start = typeof ed.selectionStart === "number" ? ed.selectionStart : ed.value.length;
          ed.value = ed.value.slice(0,start) + text + ed.value.slice(start);
          ed.selectionStart = ed.selectionEnd = start + text.length;
          ed.dispatchEvent(new Event("input", {bubbles:true}));
        } else {
          const ok = document.execCommand("insertText", false, text);
          if (!ok) { ed.textContent = (ed.textContent || "") + text; ed.dispatchEvent(new InputEvent("input", {bubbles:true, inputType:"insertText", data:text})); }
        }
        return true;
      };
      const stopVoice = () => { voiceRunning=false; try { voiceRecognition && voiceRecognition.stop(); } catch {} voiceRecognition=null; if (voiceBtn) { voiceBtn.classList.remove("rs-voice-on"); voiceBtn.setAttribute("aria-pressed","false"); voiceBtn.textContent="🎙 Voice"; voiceBtn.title="Enable voice coding"; } };
      if (voiceBtn) voiceBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (voiceRunning) { stopVoice(); return; }
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) { voiceBtn.title="Voice input is not supported by this browser"; voiceBtn.textContent="Voice unavailable"; return; }
        const ed=voiceEditor(); if (!ed) { voiceBtn.title="Open a supported chat composer first"; return; }
        try {
          const recognition = new SpeechRecognition(); voiceRecognition=recognition; recognition.lang=document.documentElement.lang || navigator.language || "en-US"; recognition.continuous=true; recognition.interimResults=true;
          recognition.onstart=()=>{voiceRunning=true;voiceBtn.classList.add("rs-voice-on");voiceBtn.setAttribute("aria-pressed","true");voiceBtn.textContent="● Listening";voiceBtn.title="Listening — click to stop voice coding";};
          recognition.onresult=(event)=>{let finalText="";for(let i=event.resultIndex;i<event.results.length;i++){if(event.results[i].isFinal)finalText+=event.results[i][0].transcript;}if(finalText)writeVoiceText((ed.value||ed.textContent?" ":"")+finalText);};
          recognition.onerror=()=>stopVoice(); recognition.onend=()=>{if(voiceRunning)stopVoice();}; recognition.start();
        } catch { stopVoice(); }
      });
      const discordBtn = root.querySelector("#rs-discord");
      if (discordBtn) discordBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        try { window.open(DISCORD_URL, "_blank", "noopener"); } catch {}
      });
      // Keep the session/cards control INSIDE the reserved status strip. The old
      // 52px fixed FAB was clamped to x=8 on narrow pages, where it sat directly
      // over message text and sidebar controls. An in-bar control is always in
      // ORscript-owned layout space and remains just as accessible.
      cardsBtn = document.createElement("button");
      cardsBtn.id = "rs-cards-btn";
      cardsBtn.setAttribute("aria-label", "Templates");
      cardsBtn.title = "Templates and activity";
      cardsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3.2 3L7 15"/><path d="M12.5 15H17"/></svg>';
      const rightCluster = bar.querySelector(".rs-cluster-right");
      if (rightCluster) rightCluster.insertBefore(cardsBtn, supportBtn || rightCluster.firstChild);
      else bar.appendChild(cardsBtn);
      cardsPanel = root.querySelector("#rs-cards-panel");
      if (cardsBtn && cardsPanel) {
        const setCardsOpen = (open) => {
          open = !!open;
          cardsPanel.hidden = !open;
          bar.classList.toggle("rs-cards-open", open);
          if (open) {
            // Menu and cards use the same reserved expansion lane; keep only one
            // open so neither surface can overlap the other or host content.
            setMenuOpen(false);
            hideCardEmbed();
            hideSetup();
            if (cardsPanel.parentElement !== bar) bar.appendChild(cardsPanel);
            renderCards(cardsPanel);
          }
        };
        openCardsPanel = setCardsOpen; // reachable from the Public Skills modal (hoisted var)
        const taskPill = root.querySelector("#rs-task-pill");
        if (taskPill) taskPill.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); const wasTasks = !cardsPanel.hidden && cardsTab === "tasks"; cardsTab = "tasks"; setCardsOpen(!wasTasks); });
        try { syncTaskPill(); } catch {}
        cardsBtn.addEventListener("click", (e)=>{
          e.stopPropagation();
          setCardsOpen(cardsPanel.hidden);
        });
        // Don't close when scrolling inside the panel itself, or when the click
        // target was detached by a re-render during this same event (tab switches).
        window.addEventListener("scroll", (e) => {
          if (cardsPanel.hidden) return;
          try { if (cardsPanel._orUiGuard && Date.now() < cardsPanel._orUiGuard) return; } catch {}
          try { if (e.target && (e.target === cardsPanel || cardsPanel.contains(e.target))) return; } catch {}
          setCardsOpen(false);
        }, true);
        document.addEventListener("click", (e) => {
          if (cardsPanel.hidden) return;
          try { if (cardsPanel._orUiGuard && Date.now() < cardsPanel._orUiGuard) return; } catch {}
          try { if (e.target && !e.target.isConnected) return; } catch {}
          if (!cardsPanel.contains(e.target) && !cardsBtn.contains(e.target)) setCardsOpen(false);
        });
        // Capture tab activation before host-page handlers can cancel or retarget it.
        // renderCards replaces the tab DOM, so do this on pointerdown and consume
        // the later click rather than relying on bubbling through the host page.
        cardsPanel.addEventListener("pointerdown", (e)=>{
          const tab=e.target.closest&&e.target.closest(".rs-cards-tab");
          if(!tab||!cardsPanel.contains(tab)) return;
          e.preventDefault(); e.stopPropagation();
          cardsTab=tab.dataset.tab==="public"?"public":tab.dataset.tab==="tasks"?"tasks":tab.dataset.tab==="activity"?"activity":"library";
          cardsPanel._orUiGuard=Date.now()+350;
          renderCards(cardsPanel);
        }, true);
        // Delegated: tab switching, Clear-all, library card clicks.
        cardsPanel.addEventListener("click", async (e)=>{
          const tab = e.target.closest && e.target.closest(".rs-cards-tab");
          if (tab) {
            // stopPropagation: renderCards detaches the clicked tab from the DOM,
            // and the document-level outside-click closer below would otherwise
            // see a detached target, fail contains(), and slam the panel shut.
            e.stopPropagation();
            const t = tab.dataset.tab;
            cardsTab = t === "activity" || t === "public" || t === "tasks" ? t : "library";
            renderCards(cardsPanel);
            return;
          }
          const clear = e.target.closest && e.target.closest("#rs-cards-clear");
          if (clear) {
            e.stopPropagation();
            recentCards.length = 0;
            renderCards(cardsPanel);
            return;
          }
          // Danger zone: single-click FULL ACCESS toggle (agent confirms state).
          const fullBtn = e.target.closest && e.target.closest("#rs-full-toggle");
          if (fullBtn) {
            e.stopPropagation();
            const want = !(typeof window.__rsFullAccess === "function" && window.__rsFullAccess());
            try { window.__rsFullAccess = () => want; } catch {}
            try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: want }); } catch {}
            renderCards(cardsPanel); // re-renders with new ON/OFF + note
            toast(want
              ? "\u26A0 FULL ACCESS ON \u2014 the AI can now touch your whole PC"
              : "FULL ACCESS OFF \u2014 back to the workspace sandbox");
            return;
          }
          const ideaGenerate=e.target.closest&&e.target.closest("[data-idea-generate]");if(ideaGenerate){e.stopPropagation();const g=cardsPanel.querySelector("[data-idea-genre]")?.value||"Platformer",t=cardsPanel.querySelector("[data-idea-theme]")?.value||"Futuristic";ideaGeneratorResult=makeIdea(g,t);renderCards(cardsPanel);return;}const ideaAnother=e.target.closest&&e.target.closest("[data-idea-generate-another]");if(ideaAnother){e.stopPropagation();const g=cardsPanel.querySelector("[data-idea-genre]")?.value||"Platformer",t=cardsPanel.querySelector("[data-idea-theme]")?.value||"Futuristic";ideaGeneratorResult=makeIdea(g,t);renderCards(cardsPanel);return;}const ideaCopy=e.target.closest&&e.target.closest("[data-idea-copy]");if(ideaCopy&&ideaGeneratorResult){navigator.clipboard?.writeText(ideaGeneratorResult.prompt);toast("Prompt copied");return;}const ideaChat=e.target.closest&&e.target.closest("[data-idea-chat]");if(ideaChat&&ideaGeneratorResult){const el=document.activeElement?.matches?.("textarea,[contenteditable=true]")?document.activeElement:document.querySelector("textarea,[contenteditable=true]");if(el){if(el.isContentEditable)el.textContent=ideaGeneratorResult.prompt;else{el.value=ideaGeneratorResult.prompt;el.dispatchEvent(new Event("input",{bubbles:true}));}toast("Prompt placed in chat box");}else toast("Chat box not found");return;}const ideaRun=e.target.closest&&e.target.closest("[data-idea-run]");if(ideaRun&&ideaGeneratorResult){runLibraryCard({engine:"rs",icon:"✦",cat:"Idea",title:ideaGeneratorResult.title,desc:"Generated game idea",prompt:ideaGeneratorResult.prompt},true);return;}
          // ── Tasks tab ──
          if (typeof ORTaskList !== "undefined" && cardsTab === "tasks") {
            const TL = ORTaskList;
            const runAll=e.target.closest&&e.target.closest("[data-task-run-all]");
            if(runAll){e.stopPropagation();const open=TL.list().filter((t)=>t.status==="todo"||t.status==="doing");if(!open.length)return toast("No open tasks");runLibraryCard({engine:"rs",icon:"✓",cat:"Task list",title:"Run the task list",desc:`${open.length} open task${open.length===1?"":"s"}`,prompt:`Work through my OrScript task list now, in order, one task at a time: call task_next, do that task with real commands, verify it, mark it done with task_update (or skipped with a reason), then call task_next again until it returns no task. Report briefly after each task. Open tasks:\n${open.map((t,i)=>`${i+1}. ${t.text}`).join("\n")}`},true);return;}
            const runNext=e.target.closest&&e.target.closest("[data-task-run-next]");
            if(runNext){e.stopPropagation();const n=TL.next();if(!n)return toast("No open tasks");const idx=TL.list().findIndex((t)=>t.id===n.id)+1;runLibraryCard({engine:"rs",icon:"✓",cat:"Task list",title:`Task #${idx}`,desc:n.text.slice(0,90),prompt:taskRunPrompt(n,idx)},true);return;}
            const aiPlan=e.target.closest&&e.target.closest("[data-task-ai-plan]");
            if(aiPlan){e.stopPropagation();const goal=prompt("What should the task list achieve? (the AI will propose the steps)","");if(goal==null||!goal.trim())return;runLibraryCard({engine:"rs",icon:"✓",cat:"Task list",title:"Plan tasks",desc:goal.slice(0,90),prompt:`Break this goal into a concrete, ordered task list for my OrScript project and add every task with task_add (one call, one task per line, 4-12 tasks, each a verifiable step). Goal: ${goal.trim()}. Inspect the place/workspace first if that changes the plan. After adding them, call task_list and summarise in two sentences. Do not start executing the tasks.`},true);return;}
            const clearDone=e.target.closest&&e.target.closest("[data-task-clear-done]");
            if(clearDone){e.stopPropagation();const n=TL.clearDone();toast(n?`Removed ${n} finished task${n===1?"":"s"}`:"Nothing to clear");renderCards(cardsPanel);return;}
            const exp=e.target.closest&&e.target.closest("[data-task-export]");
            if(exp){e.stopPropagation();const blob=new Blob([TL.exportJson()],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="orscript-tasks.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast("Task list exported");return;}
            const imp=e.target.closest&&e.target.closest("[data-task-import]");
            if(imp){e.stopPropagation();const input=document.createElement("input");input.type="file";input.accept=".json,.txt,.md";input.onchange=async()=>{const file=input.files&&input.files[0];if(!file)return;const r=TL.importText(await file.text());toast(r.ok?`Imported ${r.added} task${r.added===1?"":"s"}`:`IMPORT_FAILED: ${r.error}`);renderCards(cardsPanel);};input.click();return;}
            const dis=e.target.closest&&e.target.closest("[data-task-disable]");
            if(dis){e.stopPropagation();setTaskList(false);return;}
            const row=e.target.closest&&e.target.closest("[data-task-id]");
            const act=row&&e.target.closest&&e.target.closest("[data-task-action]");
            if(row&&act){e.stopPropagation();const id=row.dataset.taskId;const t=TL.find(id);if(!t)return renderCards(cardsPanel);const a=act.dataset.taskAction;const idx=TL.list().findIndex((x)=>x.id===id)+1;
              if(a==="toggle")TL.update(id,{status:t.status==="done"?"todo":"done"});
              else if(a==="doing")TL.update(id,{status:t.status==="doing"?"todo":"doing"});
              else if(a==="skip")TL.update(id,{status:t.status==="skipped"?"todo":"skipped"});
              else if(a==="up")TL.move(id,-1);
              else if(a==="down")TL.move(id,1);
              else if(a==="delete")TL.remove(id);
              else if(a==="run"){runLibraryCard({engine:"rs",icon:"✓",cat:"Task list",title:`Task #${idx}`,desc:t.text.slice(0,90),prompt:taskRunPrompt(t,idx)},true);return;}
              renderCards(cardsPanel);return;}
            if(e.target.closest&&(e.target.closest("#rs-task-input")||e.target.closest("[data-task-edit]"))){e.stopPropagation();return;}
          }
          // ── Public Skills tab ──
          if (typeof PublicSkills !== "undefined") {
            const pubCreate=e.target.closest&&e.target.closest("[data-public-create]");
            if(pubCreate){e.stopPropagation();const ta=cardsPanel.querySelector("#rs-public-prompt");const text=String(ta&&ta.value||"").trim();publicKind=(cardsPanel.querySelector("#rs-public-kind")||{}).value||"auto";if(text.length<8){toast("Describe the skill, ability or mode in a sentence — or paste a whole prompt");try{ta&&ta.focus();}catch{}return;}const convert=publicIsConvert(text);publicDraft="";publicHow="auto";runLibraryCard({engine:"rs",icon:"P",cat:"Public Skills",title:convert?"Turn my prompt into a public skill":publicKind==="auto"?"Create a public skill":`Create public ${publicKind}`,desc:(convert?"Convert: ":"")+text.slice(0,90),prompt:publicGenerationPrompt(text,publicKind)},true);return;}
            const pubHow=e.target.closest&&e.target.closest("[data-public-how]");
            if(pubHow){e.stopPropagation();publicHow=pubHow.dataset.publicHow||"auto";const ta=cardsPanel.querySelector("#rs-public-prompt");if(ta)publicDraft=ta.value;renderCards(cardsPanel);return;}
            const pubExample=e.target.closest&&e.target.closest("[data-public-example]");
            if(pubExample){e.stopPropagation();publicDraft=pubExample.dataset.publicExample||"";publicHow="auto";renderCards(cardsPanel);try{const ta=cardsPanel.querySelector("#rs-public-prompt");if(ta)ta.focus();}catch{}return;}
            const pubSaveText=e.target.closest&&e.target.closest("[data-public-save-text]");
            if(pubSaveText){e.stopPropagation();const ta=cardsPanel.querySelector("#rs-public-prompt");const text=String(ta&&ta.value||"").trim();publicKind=(cardsPanel.querySelector("#rs-public-kind")||{}).value||"auto";if(text.length<20){toast("Paste or type the full prompt first (at least 20 characters)");try{ta&&ta.focus();}catch{}return;}if(publicSaveAsIs(text))renderCards(cardsPanel);return;}
            const pubLoadText=e.target.closest&&e.target.closest("[data-public-load-text]");
            if(pubLoadText){e.stopPropagation();publicPickFile();return;}
            const pubManual=e.target.closest&&e.target.closest("[data-public-manual]");
            if(pubManual){e.stopPropagation();const k=(cardsPanel.querySelector("#rs-public-kind")||{}).value;openPublicEditor(null,k==="ability"||k==="mode"?k:"skill");return;}
            const pubExportAll=e.target.closest&&e.target.closest("[data-public-export-all]");
            if(pubExportAll){e.stopPropagation();const json=PublicSkills.exportPackJson();if(!json)return toast("Nothing to export");const blob=new Blob([json],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=PublicSkills.packFileName();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast(`Exported ${PublicSkills.list().length} item(s) to ${PublicSkills.packFileName()}`);return;}
            const pubShareAll=e.target.closest&&e.target.closest("[data-public-share-all]");
            if(pubShareAll){e.stopPropagation();const code=PublicSkills.packShareCode();if(!code)return toast("Nothing to share");(async()=>{try{await navigator.clipboard.writeText(code);toast(`Share code for ${PublicSkills.list().length} item(s) copied (${code.length} chars)`);}catch{prompt("Copy this share code:",code);}})();return;}
            const pubImport=e.target.closest&&e.target.closest("[data-public-import]");
            if(pubImport){e.stopPropagation();publicPickFile();return;}
            const pubPaste=e.target.closest&&e.target.closest("[data-public-paste]");
            if(pubPaste){e.stopPropagation();const code=prompt("Paste an ORSKILL1: share code, exported JSON, or a .txt skill:","");if(code)publicLoadText(code);return;}
            const pubRow=e.target.closest&&e.target.closest("[data-public-id]");
            const pubAction=pubRow&&e.target.closest&&e.target.closest("[data-public-action]");
            if(pubRow&&pubAction){e.stopPropagation();const item=PublicSkills.get(pubRow.dataset.publicId);if(!item)return renderCards(cardsPanel);const act=pubAction.dataset.publicAction;
              if(act==="run")publicRun(item);
              else if(act==="activate"){const active=PublicSkills.activeMode();setWorkMode(active&&active.id===item.id?workMode:"pm:"+item.id);}
              else if(act==="improve")publicImprove(item);
              else if(act==="edit")openPublicEditor(item);
              else if(act==="toggle"){const r=PublicSkills.setEnabled(item.id,!item.enabled);toast(r.ok?`${r.item.enabled?"Enabled":"Disabled"} '${item.name}'`:"Not found");}
              else if(act==="export")publicDownload(item.id);
              else if(act==="export-text")publicDownloadText(item.id);
              else if(act==="share")publicCopyShare(item.id);
              else if(act==="delete"){if(confirm(`Delete public ${item.kind} “${item.title}”? Export it first if you want to keep a copy.`)){PublicSkills.remove(item.id);}}
              renderCards(cardsPanel);return;}
            const pubTa=e.target.closest&&e.target.closest("#rs-public-prompt");if(pubTa){e.stopPropagation();return;}
          }
          const add=e.target.closest&&e.target.closest("[data-template-add]");if(add){e.stopPropagation();openTemplateEditor();return;}
          const aiCreate=e.target.closest&&e.target.closest("[data-template-ai-create]");if(aiCreate){e.stopPropagation();const request=prompt("Describe the reusable template you want OrScript AI to create");if(!request)return;runLibraryCard({engine:"rs",icon:"T",cat:"Templates",title:"Create Template with AI",desc:"Draft for review",prompt:`Create a complete user-owned OrScript template draft from this request: ${request}\nAnalyze required variables, workflow ordering, existing command IDs, validation, expected result, execution level, environment and safety. Submit the complete draft through template_create_draft. Do not save or execute it.`},true);return;}
          const projectImport=e.target.closest&&e.target.closest("[data-project-import]");if(projectImport){e.stopPropagation();const input=document.createElement("input");input.type="file";input.accept=".rbxl,.rbxlx,.orscript-project-reference.json";input.onchange=async()=>{const file=input.files&&input.files[0];if(!file)return;if(/\.json$/i.test(file.name)){try{const ref=JSON.parse(await file.text());if(!ref||!ref.analysis||!ref.analysis.project)return toast("INVALID_PROJECT_REFERENCE: not an exported ORscript project reference");openTemplateEditor(null,{draft:true,projectReference:ref});}catch(err){toast(`INVALID_PROJECT_REFERENCE: ${String(err.message||err)}`);}return;}openTemplateEditor(null,{draft:true,projectFile:file});};input.click();return;}const exportAll=e.target.closest&&e.target.closest("[data-template-export-all]");if(exportAll){e.stopPropagation();const r=ORTemplateRegistry.exportAllTemplates();if(!r.success)return toast(`${r.error.code}: ${r.error.message}`);if(!r.data.templates.length)return toast("No templates to export");const blob=new Blob([JSON.stringify(r.data,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=r.filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast(`Exported ${r.data.templates.length} templates`);return;}const importBtn=e.target.closest&&e.target.closest("[data-template-import]");if(importBtn){e.stopPropagation();const input=document.createElement("input");input.type="file";input.accept=".json,.orscript-template.json";input.onchange=async()=>{const file=input.files&&input.files[0];if(!file)return;const r=await ORTemplateRegistry.importTemplate(await file.text());toast(r.success?"Template imported":`${r.error.code}: ${r.error.message}`);renderCards(cardsPanel);};input.click();return;}
          const lib=e.target.closest&&e.target.closest(".rs-template-row");if(lib){const c=visibleLibCache[+lib.dataset.promptIndex];if(!c)return;const action=e.target.closest&&e.target.closest("[data-template-action]");if(!action)return;const kind=action.dataset.templateAction;e.stopPropagation();if(kind==="open")openTemplateEditor(ORTemplateRegistry.getTemplate(c.templateId));else if(kind==="run")await runTemplateCard(c);else if(kind==="improve")requestTemplateAI("improve",c.templateId,"Full AI Review");else if(kind==="duplicate"){await ORTemplateRegistry.duplicateTemplate(c.templateId);renderCards(cardsPanel);toast("Template copied");}else if(kind==="export"){const r=ORTemplateRegistry.exportTemplate(c.templateId);if(r.success){const blob=new Blob([JSON.stringify(r.data,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=r.filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast("Template exported");}}else if(kind==="archive"){await ORTemplateRegistry.archiveTemplate(c.templateId,cardsCategory!=="Archived");renderCards(cardsPanel);toast(cardsCategory==="Archived"?"Template restored":"Template archived");}else if(kind==="delete"){const t=ORTemplateRegistry.getTemplate(c.templateId);if(confirm(`Delete “${t?.name||"this template"}” and all of its versions?`)){await ORTemplateRegistry.deleteTemplate(c.templateId);renderCards(cardsPanel);toast("Template deleted");}}}

        });
      }
      menuEl = root.querySelector("#rs-menu");
      bar.classList.add(`rs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`rs-site-${P.id}`);
      // Experiment flags — easy revert: set FLAGS.* to false in src/core/config.js
      try {
        if (RS.FLAGS && RS.FLAGS.uiGlass) document.documentElement.setAttribute("data-rs-glass", "true");
        if (RS.FLAGS && RS.FLAGS.dualMemory) document.documentElement.setAttribute("data-rs-dual", "true");
      } catch {}

      // Start handler is installed at button creation time above.
      stopBtn.addEventListener("click", stopLoop);
      if (extraBtn) extraBtn.addEventListener("click", (e)=>{ e.stopPropagation(); setExtraThinking(!extraThinking); });
      const steeringBtn = root.querySelector("#rs-steering");
      if (steeringBtn) {
      }
      syncSteeringUi();
      if (undoBtn) undoBtn.addEventListener("click", (e)=>{ e.stopPropagation(); e.preventDefault(); try { if (typeof window.__rsUndo === "function") window.__rsUndo(); } catch {} });
      if (!document.getElementById("rs-plus-css")) {
        const st = document.createElement("style");
        st.id = "rs-plus-css";
        st.textContent = "#rs-undo{flex:none;padding:7px 10px;background:#3a3a48;color:#f3efe6;border:0;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}#rs-undo:hover{background:#4a4a5c}#rs-undo[hidden]{display:none}";
        (document.head || document.documentElement).appendChild(st);
      }
      unstableEl = root.querySelector("#rs-unstable-inline") || root.querySelector("#rs-unstable");
      if (unstableEl) {
        unstableEl.title = P.unstableWarning || "This site can drop turns";
        unstableEl.addEventListener("click", (e) => { e.stopPropagation(); toast(unstableEl.title); });
        // Inline pill is controlled via hidden attribute, not floating positioning
        if (P.unstableWarning) unstableEl.hidden = false;
      }
      buildMenu();
      // Both bar controls open the same panel; the heart lands on the Support
      // section (last), the model button opens at the top with Switch AI.
      const toggleMenu = (toSupport) => {
        setMenuOpen(!!menuEl.hidden, toSupport);
      };
      supportBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(true); });
      const paintBtn = root.querySelector("#rs-paint-btn");
      if (paintBtn) paintBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenuOpen(false); try { cardsPanel.hidden = true; } catch {} if (window.__rsOpenPaint) window.__rsOpenPaint(); });
      document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p") && !e.altKey) { if (typeof ORPaint !== "undefined" && ORPaint.isOpen()) return; e.preventDefault(); if (window.__rsOpenPaint) window.__rsOpenPaint(); } }, true);
      // Engine toggle (Roblox ↔ AgentScript ↔ Animation)
      const engineEl = root.querySelector("#rs-engine");
      currentEngine = "roblox";
      try { chrome.storage.local.get("rs-engine", (o) => { const v = o && o["rs-engine"]; if (v === "local") setEngine("local"); else if (v === "anim" || v === "unreal") { try { chrome.storage.local.set({"rs-engine": "roblox"}); } catch {} setEngine("roblox"); } }); } catch {}
      chrome.storage?.onChanged.addListener((ch, area) => {
        if (area !== "local" || !ch["rs-engine"]) return;
        const v = ch["rs-engine"].newValue === "local" ? "local" : "roblox";
        if (v === currentMode) return;
        if (Date.now() - lastManualEngineAt < 5000) return;
        setEngine(v);
        try { markModesChanged(); } catch {}
      });
      chrome.runtime.onMessage.addListener((m)=>{
        if (!(m && m.type === "rs-engine" && m.engine)) return;
        const v = m.engine === "local" ? "local" : "roblox";
        if (v === currentMode) return;
        if (Date.now() - lastManualEngineAt < 5000) return;
        setEngine(v);
        try { markModesChanged(); } catch {}
      });
      // setStatus lives outside build() — give it a scoped handle so the
      // proc-aware auto-switch can drive the engine without ReferenceErrors.
      engineApi = { set: setEngine, get: () => currentEngine };
      // Expose currentMode for external consumers and keep currentEngine as alias
      let currentMode = currentEngine;
      try { window.__rsMode = () => currentMode; window.__rsEngine = () => currentMode; } catch {}
      function setEngine(v){
        currentEngine = v==="local" ? "local" : "roblox";
        currentMode = currentEngine;
        try { window.__rsMode = () => currentMode; window.__rsEngine = () => currentMode; } catch {}
        if (engineEl) {
          const isLocal = currentMode==="local";
          try {
            const btns = engineEl.querySelectorAll(".rs-mode-btn");
            btns.forEach(b => {
              const isOn = b.dataset.mode === currentMode;
              b.classList.toggle("on", isOn);
              b.setAttribute("aria-selected", isOn ?  "true" : "false");
            });
          } catch {}
          engineEl.title = isLocal ? "AgentScript — click RS for Roblox"
            : "RobloxScript — click AS for AgentScript";
          try { engineEl.setAttribute("data-engine", currentMode); } catch {}
          try { document.documentElement.setAttribute("data-rs-engine", currentMode); } catch {}
          // Update CSS accent via data attribute on #rs-root for per-mode theming
          try { root.setAttribute("data-mode", currentMode); } catch {}
          // Belt-and-suspenders: directly animate the thumb via inline style
          // (works even if the CSS attribute selector is cached/blocked).
          // Two equal segments: RS 0%, AS 100%.
          try {
            const thumb = engineEl.querySelector("#rs-engine-thumb");
            if (thumb) {
              thumb.style.transform = isLocal ? "translateX(100%)" : "translateX(0)";
              thumb.style.background = "transparent";
              thumb.style.borderColor = "#ffffff";
            }
          } catch {}
          const brand = root.querySelector("#rs-brand");
          // Brand stays the central product name in every engine; the pill +
          // switch toast communicate which engine is live.
          if (brand) brand.textContent = productName();
          try { if (cardsBtn) cardsBtn.title = isLocal ? "Session summary \u2014 what the AI did" : "Templates \u2014 reusable workflows"; } catch {}
          // Status dot and brand are tinted via CSS using data-rs-engine — no inline bar styles needed
        }
        // Update bindings that depend on currentMode (colors, restart target, etc.)
        try { updatePerfPill(); } catch {}
        try { renderBar(); } catch {}
        // The library is engine-aware — re-filter an open panel immediately
        // so Roblox cards never linger after a toggle.
        try {
          if (cardsPanel && !cardsPanel.hidden && cardsTab === "library") renderCards(cardsPanel);
        } catch {}
      }
      if (engineEl) {
        const engineToast = (next) => {
          const name = next === "local" ? "AgentScript" : "RobloxScript";
          const extra = (A.started || A.running) ? " — restart the agent so it uses this engine" : "";
          toast("Engine: " + name + extra);
          try { markModesChanged(); } catch {}
        };
        // Segmented control: clicks on inner buttons switch mode
        engineEl.addEventListener("click", (e)=>{
          const btn = e.target.closest(".rs-mode-btn");
          if (!btn) return;
          e.stopPropagation();
          const mode = btn.dataset.mode;
          const next = mode === "local" ? "local" : "roblox";
          if (next === currentMode) return;
          lastManualEngineAt = Date.now();
          try { chrome.storage.local.set({"rs-engine": next}); } catch {}
          try { chrome.runtime.sendMessage({type:"rs-set-engine", engine: next}).catch(()=>{}); } catch {}
          setEngine(next);
          engineToast(next);
        });
        // Fallback: clicking the container cycles RS -> AS -> AN
        engineEl.addEventListener("dblclick", (e)=>{
          e.stopPropagation();
          const next = currentMode==="local" ? "roblox" : "local";
          lastManualEngineAt = Date.now();
          try { chrome.storage.local.set({"rs-engine": next}); } catch {}
          try { chrome.runtime.sendMessage({type:"rs-set-engine", engine: next}).catch(()=>{}); } catch {}
          setEngine(next);
          engineToast(next);
        });
      }
      // expose for config.js prompt branching (read synchronously where possible)
      try { window.__rsEngine = () => currentEngine; } catch {}
      openMenuFn = (toSupport) => { setMenuOpen(true, toSupport); };
      document.addEventListener("click", (e) => {
        if (menuEl.hidden) return;
        if (!menuEl.contains(e.target) && !(supportBtn && supportBtn.contains(e.target)))
          setMenuOpen(false);
      }, true);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menuEl && !menuEl.hidden) setMenuOpen(false);
      }, true);
      document.addEventListener("keydown", (e) => {
        if (isEditableTarget(e.target) || e.repeat) return;
        const combo = comboFromEvent(e); const key = Object.keys(keybinds).find(k => keybinds[k] && keybinds[k].toLowerCase() === combo.toLowerCase());
        if (key) { e.preventDefault(); e.stopPropagation(); runKeybind(key); }
      }, true);

      applyTheme();
      applyOrSkin();
      setInterval(applyTheme, 2000); // follow the host page toggling its theme
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind). Restart re-uses the same
    // bootstrap but forces it into an existing chat (see startSession restart).
    function onActionClick() {
      const kind = actionBtn && actionBtn.dataset.kind;
      diag("start.buttonClick", { kind: kind || "none", bridgeOk, addonOk, provider: P && P.id });
      if (kind === "start" || kind === "start-degraded" || kind === "restart") {
        if (!(A.bridge && A.bridge.connected === true)) { ui.toast("Open ORscript Desktop (or-core.exe) first — the Start button unlocks as soon as the bridge connects."); return; }
        try { playSfx("start"); } catch {}
        ui.toast(kind === "restart" ? "Restarting agent…" : "Starting agent…");
        Promise.resolve(startSession({ restart: kind === "restart" })).catch((error) => {
          ui.banner("warn", "Agent could not start", String(error && error.message || error));
          try { ui.setStarting(false); ui.inputCover(false); P.setInputLock(false); } catch {}
        });
      } else {
        ui.toast("Start is not ready on this chat. Open a new chat or reload the page.");
      }
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("rsCustomPrompt", (r) => {
        if (r && typeof r.rsCustomPrompt === "string") {
          customPrompt = r.rsCustomPrompt;
          syncMenuPrompt();
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }

    // User-maintained, structured memory is separate from the one-line custom prompt.
    // It is injected only at session/bootstrap prompt construction and capped locally.
    let customMemory = { projectKey: "", coding: "", project: "", preferences: "", task: "" };
    try { chrome.storage.local.get("rsCustomMemory", (r) => { if (r && r.rsCustomMemory && typeof r.rsCustomMemory === "object") { customMemory = { projectKey: String(r.rsCustomMemory.projectKey || ""), coding: String(r.rsCustomMemory.coding || ""), project: String(r.rsCustomMemory.project || ""), preferences: String(r.rsCustomMemory.preferences || ""), task: String(r.rsCustomMemory.task || "") }; syncMenuMemory(); } }); } catch {}
    function memoryText() { return [ ["Coding standards", customMemory.coding], ["Project context", customMemory.project], ["Preferences", customMemory.preferences], ["Current task notes", customMemory.task] ].filter(([,v]) => v.trim()).map(([k,v]) => `## ${k}\n${v.trim()}`).join("\n\n").slice(0, 12000); }
    function getCustomMemory() {
      const own = memoryText();
      let recap = "";
      try { recap = typeof autoRecapText === "function" ? autoRecapText() : ""; } catch {}
      return [own, recap].filter(Boolean).join("\n\n").slice(0, 12000);
    }
    function syncMenuMemory() { if (!menuEl) return; for (const [id,key] of [["rs-mem-key","projectKey"],["rs-mem-coding","coding"],["rs-mem-project","project"],["rs-mem-preferences","preferences"],["rs-mem-task","task"]]) { const el=menuEl.querySelector(`#${id}`); if (el && document.activeElement !== el) el.value=customMemory[key] || ""; } }
    function clearTaskMemory() { if (!customMemory.task.trim()) return; customMemory.task=""; try { chrome.storage.local.set({ rsCustomMemory: customMemory }); } catch {} }
    try { window.__rsClearTaskMemory = clearTaskMemory; } catch {}
    function switchMemoryProject(nextKey) { const key=String(nextKey || "").trim(); if (key && customMemory.projectKey && key !== customMemory.projectKey) { customMemory.project=""; customMemory.task=""; } customMemory.projectKey=key; }
    const DEFAULT_KEYBINDS = { menu: "Ctrl+Shift+O", start: "Ctrl+Enter", voice: "Ctrl+Shift+V", templates: "Ctrl+Shift+T" };
    let keybinds = { ...DEFAULT_KEYBINDS };
    try { chrome.storage.local.get("rsKeybinds", r => { if (r && r.rsKeybinds) { keybinds = { ...DEFAULT_KEYBINDS, ...r.rsKeybinds }; syncKeybindInputs(); } }); } catch {}
    function comboFromEvent(e) { const parts=[]; if(e.ctrlKey)parts.push("Ctrl"); if(e.altKey)parts.push("Alt"); if(e.shiftKey)parts.push("Shift"); if(e.metaKey)parts.push("Meta"); const k=e.key.length===1?e.key.toUpperCase():e.key.replace(" ","Space"); if(!["Control","Alt","Shift","Meta"].includes(e.key))parts.push(k); return parts.join("+"); }
    function isEditableTarget(el) { return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))); }
    function syncKeybindInputs() { if (!menuEl) return; menuEl.querySelectorAll("[data-keybind]").forEach(el => { const key=el.dataset.keybind; if(document.activeElement!==el)el.value=keybinds[key]||""; }); }
    function keybindLabel(k) { return String(k||"").replace(/\bCtrl\b/,"Ctrl"); }
    function runKeybind(key) { if(key==="menu") { if(openMenuFn) openMenuFn(false); } else if(key==="start") { if(!A.running&&!A.starting) startSession({restart:A.started}); } else if(key==="voice") { root?.querySelector("#rs-voice")?.click(); } else if(key==="templates") { root?.querySelector("#rs-cards-btn")?.click(); } }

    // ── Agent modes (Extra Thinking, Forge GUI, Auto-fix) ─────────────────
    // All four persist. The loads below restore the user's choices after a
    // reload - they used to silently reset to these defaults on every page
    // refresh because only the setters ever touched chrome.storage.
    let autoFixEnabled = true, extraThinking = false, planMode = false, steeringMode = false, forgeMode = false, autoFixStopPlay = true, autoDebugEnabled = true, multiAgent = false;
    let workMode = "ultimate";
    try { window.__rsWorkMode = () => workMode; } catch {}
    try { window.__rsWorkModes = () => WORK_MODES; } catch {}
    try { window.__rsPlanMode = () => planMode; } catch {}
    try { window.__rsSteeringMode = () => steeringMode; } catch {}
    try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
    try { window.__rsMultiAgent = () => multiAgent; } catch {}
    try {
      chrome.storage.local.get(["rsAutoFix", "rsExtraThinking", "rsPlanMode", "rsForgeMode", "rsAutoFixStopPlay", "rsWorkMode", "rsAutoDebug", "rsMultiAgent"], (r) => {
        if (!r) return;
        if (typeof r.rsAutoFix === "boolean") autoFixEnabled = r.rsAutoFix;
        if (typeof r.rsExtraThinking === "boolean") {
          extraThinking = r.rsExtraThinking;
          try { window.__rsExtraThinking = () => extraThinking; } catch {}
        }
        if (typeof r.rsPlanMode === "boolean") {
          planMode = r.rsPlanMode;
          try { window.__rsPlanMode = () => planMode; } catch {}
        }
        if (false) {
          steeringMode = false;
          try { window.__rsSteeringMode = () => steeringMode; } catch {}
          try { syncSteeringUi(); renderBar(); } catch {}
        }
        if (typeof r.rsAutoDebug === "boolean") {
          autoDebugEnabled = r.rsAutoDebug;
          try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
        }
        if (typeof r.rsMultiAgent === "boolean") {
          multiAgent = r.rsMultiAgent;
          try { window.__rsMultiAgent = () => multiAgent; } catch {}
          try { syncCrewBadge(); } catch {}
        }
        if (typeof r.rsForgeMode === "boolean") {
          forgeMode = r.rsForgeMode;
          try {
            document.documentElement.setAttribute("data-rs-forge", forgeMode ? "1" : "0");
            window.__rsForge = () => forgeMode;
          } catch {}
        }
        if (typeof r.rsAutoFixStopPlay === "boolean") autoFixStopPlay = r.rsAutoFixStopPlay;
        // v1.17 migrated the former speed presets to the adaptive workflow;
        // 1.19.8 added the Visualizer and Animator specialists; 1.21 replaces
        // Adaptive with Ultimate (legacy adaptive values migrate here).
        workMode = normalizeWorkMode(r.rsWorkMode);
        try { window.__rsWorkMode = () => workMode; if (r.rsWorkMode !== workMode) chrome.storage.local.set({rsWorkMode:"ultimate"}); } catch {}
        try { syncWorkModeUi(); } catch {}
        if (!menuEl.hidden) buildMenu();
      });
    } catch {}
    // ── Thinking Level ──
    let thinkingLevel = "default";
    try {
      chrome.storage.local.get("rsThinkingLevel", (r) => {
        if (r && ["default","low","mid","high","max"].includes(r.rsThinkingLevel)) {
          thinkingLevel = r.rsThinkingLevel;
          try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
          if (!menuEl.hidden) buildMenu();
        }
      });
    } catch {}
    try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes) return;
        let dirty = false;
        if (changes.rsExtraThinking && typeof changes.rsExtraThinking.newValue === "boolean") {
          extraThinking = changes.rsExtraThinking.newValue;
          try { window.__rsExtraThinking = () => extraThinking; } catch {}
          dirty = true;
        }
        if (changes.rsPlanMode && typeof changes.rsPlanMode.newValue === "boolean") {
          planMode = changes.rsPlanMode.newValue;
          try { window.__rsPlanMode = () => planMode; } catch {}
          dirty = true;
        }
        if (changes.rsAutoDebug && typeof changes.rsAutoDebug.newValue === "boolean") {
          autoDebugEnabled = changes.rsAutoDebug.newValue;
          try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
          dirty = true;
        }
        if (changes.rsMultiAgent && typeof changes.rsMultiAgent.newValue === "boolean") {
          multiAgent = changes.rsMultiAgent.newValue;
          try { window.__rsMultiAgent = () => multiAgent; } catch {}
          try { syncCrewBadge(); } catch {}
          dirty = true;
        }
        if (changes.rsForgeMode && typeof changes.rsForgeMode.newValue === "boolean") {
          forgeMode = changes.rsForgeMode.newValue;
          try {
            document.documentElement.setAttribute("data-rs-forge", forgeMode ? "1" : "0");
            window.__rsForge = () => forgeMode;
          } catch {}
          dirty = true;
        }
        if (changes.rsAutoFix && typeof changes.rsAutoFix.newValue === "boolean") {
          autoFixEnabled = changes.rsAutoFix.newValue; dirty = true;
        }
        if (changes.rsAutoFixStopPlay && typeof changes.rsAutoFixStopPlay.newValue === "boolean") {
          autoFixStopPlay = changes.rsAutoFixStopPlay.newValue; dirty = true;
        }
        if (changes.rsBgMode && typeof changes.rsBgMode.newValue === "boolean") {
          bgMode = changes.rsBgMode.newValue; dirty = true;
        }
        if (changes.rsThinkingLevel && ["default","low","mid","high","max"].includes(changes.rsThinkingLevel.newValue)) {
          thinkingLevel = changes.rsThinkingLevel.newValue;
          try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
          dirty = true;
        }
        if (changes.rsWorkMode && WORK_MODE_IDS.includes(changes.rsWorkMode.newValue)) {
          workMode = changes.rsWorkMode.newValue;
          try { window.__rsWorkMode = () => workMode; } catch {}
          try { syncWorkModeUi(); } catch {}
          dirty = true;
        }
        if (changes.rsPermMode && ["sandbox","ask","full"].includes(changes.rsPermMode.newValue)) {
          permMode = changes.rsPermMode.newValue;
          try { window.__rsPermMode = () => permMode; } catch {}
          dirty = true;
        }
        if (changes.rsTheme && OR_THEMES[changes.rsTheme.newValue]) {
          orTheme = changes.rsTheme.newValue;
          try { applyOrSkin(); } catch {}
          dirty = true;
        }
        if (changes.rsSounds && typeof changes.rsSounds.newValue === "boolean") {
          soundOn = changes.rsSounds.newValue;
          dirty = true;
        }
        if (dirty) {
          try { markModesChanged(); } catch {}
          try { updateExtraButton(); } catch {}
          try { if (typeof buildMenu === "function") buildMenu(); } catch {}
          try { renderBar(); } catch {}
        }
      });
    } catch {}
    // ── Smart Checkpoint & Undo (auto-snapshot before mutating tools) ──
    let rsCheckpoints = [];
    try{ chrome.storage.local.get("rsCheckpoints", r=>{ if(Array.isArray(r.rsCheckpoints)) rsCheckpoints=r.rsCheckpoints; }); }catch{}
    function createCheckpoint(op, args){
      try{
        if(/^(get_|list_|web_|or_|debug_)/.test(op) || /_(info|inspect|list)$/.test(op) || op==="get_property") return;
        const cp={op, args: JSON.parse(JSON.stringify(args||{})), at: Date.now()};
        rsCheckpoints.unshift(cp); if(rsCheckpoints.length>12) rsCheckpoints.pop();
        try{ chrome.storage.local.set({rsCheckpoints}); }catch{}
      }catch{}
    }
    function undoLastCheckpoint(){
      try { if (typeof window.__rsUndo === "function") { window.__rsUndo(); return; } } catch {}
      toast("Nothing to undo yet");
    }
    // ── Smart Performance Budget (live part/script estimate) ──

  let perfParts = 0, perfScripts = 0;
    function updatePerfPill(){
      const el = document.getElementById("rs-perf");
      if(!el) return;
      if(perfParts===0 && perfScripts===0){ el.hidden=true; return; }
      el.hidden=false;
      const lvl = perfParts>8000||perfScripts>120 ?  "high" : perfParts>3000||perfScripts>60 ?  "mid" : "low";
      el.dataset.lvl=lvl;
      el.textContent = `${perfParts||0} parts • ${perfScripts||0} scripts`;
      el.title = lvl==="high" ? "High budget — consider optimizing" : lvl==="mid" ? "Moderate budget" : "Budget OK";
    }
    function bumpPerf(op){
      if(op.startsWith("terrain_")) perfParts+=120;
      else if(op.startsWith("fx_")) perfParts+=8;
      else if(op.startsWith("ui_")) perfScripts+=1;
      else if(op.startsWith("audio_")) perfScripts+=1;
      else if(op==="datastore_setup"||op==="leaderboard_setup") perfScripts+=2;
      updatePerfPill();
      try{ chrome.storage.local.set({rsPerf:{parts:perfParts, scripts:perfScripts}}); }catch{}
    }
    try{ chrome.storage.local.get("rsPerf", r=>{ if(r.rsPerf){ perfParts=r.rsPerf.parts||0; perfScripts=r.rsPerf.scripts||0; updatePerfPill(); }}); }catch{}
    // Hooks for runTool (module scope cannot see these closure functions).
    try {
      window.__rsBeforeTool = (op, args) => { try { createCheckpoint(op, args); } catch {} };
      window.__rsAfterTool = (op, args, ok, res) => {
        try { persistSession(op, args, ok); } catch {}
        if (!ok) return;
        try { bumpPerf(op); } catch {}
        try { showSuggestion(op); } catch {}
        // Project Index (1.32): cache the PROJECT MAP the build / summary returned so
        // the periodic tools reminder re-anchors the model on the architecture
        // instead of letting it re-read every script.
        if ((op === "project_index_build" || op === "project_index_summary") && typeof res === "string") {
          try { cacheProjectMap(res); } catch {}
        }
        // update perf from audit if available
        if (op === "diagnostics_audit" && typeof res === "string") {
          const m = res.match(/(\d+)\s+parts?/i);
          if (m) { perfParts = parseInt(m[1], 10) || perfParts; updatePerfPill(); try { chrome.storage.local.set({ rsPerf: { parts: perfParts, scripts: perfScripts } }); } catch {} }
        }
      };
    } catch {}
    // ── Smart Next-Step Suggestions ──
    const NEXT_STEP = {
      lighting_set_preset: "Next: add terrain (terrain_fill_region) or a HUD (ui_create_component)",
      terrain_fill_region: "Next: set lighting (lighting_set_preset) or scatter foliage",
      ui_create_screen: "Next: add a component (ui_create_component) to this ScreenGui",
      ui_create_component: "Next: preview in Studio or add another component",
      fx_create_emitter: "Next: add a light (fx_create_light) or sound",
      datastore_setup: "Next: add a leaderboard (leaderboard_setup) or remotes",
      _default: "Next: run diagnostics_audit to check health"
    };
    function showSuggestion(op){
      const hint = NEXT_STEP[op] || NEXT_STEP._default;
      try{
        const s = document.getElementById("rs-state");
        if(s && !A.running) { /* subtle hint in state line for 4s */ const prev=s.textContent; s.textContent=hint; s.style.opacity="0.95"; setTimeout(()=>{ if(s) { s.textContent=prev; s.style.opacity=""; } }, 4000); }
        else toast(hint);
      }catch{}
    }
    // ── Smart Session Continuity & Auto-Resume ──
    let sessionOps = [];
    try{ chrome.storage.local.get("rsSessionOps", r=>{ if(Array.isArray(r.rsSessionOps)) sessionOps=r.rsSessionOps; }); }catch{}
    function persistSession(op, args, ok){
      try{
        sessionOps.unshift({op, args: JSON.parse(JSON.stringify(args||{})), ok: !!ok, at: Date.now()});
        if(sessionOps.length>20) sessionOps.pop();
        chrome.storage.local.set({rsSessionOps: sessionOps});
      }catch{}
    }
    function tryResumeSession(){
      if(!sessionOps.length) return;
      const last = sessionOps[0];
      if(Date.now()-last.at > 1000*60*30) return; // older than 30m, ignore
      ui.banner("warn","Resume?",`Last session ended on ${last.op} (${last.ok?"OK":"err"}). Re-open the same chat and hit Start to continue.`);
    }
    setTimeout(tryResumeSession, 1800);
    function setAutoFix(v){ autoFixEnabled=!!v; try{chrome.storage.local.set({rsAutoFix: autoFixEnabled});}catch{}; buildMenu(); }
    function setAutoFixStopPlay(v){ autoFixStopPlay=!!v; try{chrome.storage.local.set({rsAutoFixStopPlay: autoFixStopPlay});}catch{}; buildMenu(); }
    // ── Background mode (v1.12): keep working on other sites ──
    function setBgMode(v){
      bgMode = !!v;
      try{ chrome.storage.local.set({rsBgMode: bgMode}); }catch{}
      buildMenu();
      toast(bgMode
        ? "\u{1F310} Background mode ON \u2014 the agent keeps working while you're on other sites"
        : "Background mode OFF \u2014 the agent pauses when this tab is hidden");
    }
    // Custom (public) work modes are addressed as "pm:<id>"; they run on top of
    // one of the built-in modes (their `base`), which stays the real workMode.
    function publicMode(){ try { return typeof PublicSkills !== "undefined" ? PublicSkills.activeMode() : null; } catch { return null; } }
    function setWorkMode(id, silent){
      let custom = null;
      if (typeof id === "string" && id.startsWith("pm:")) {
        try { custom = typeof PublicSkills !== "undefined" ? PublicSkills.get(id.slice(3)) : null; } catch {}
        if (!custom || custom.kind !== "mode") { toast("That custom work mode is not installed any more"); id = workMode; }
      }
      workMode = normalizeWorkMode(custom ? custom.base : id);
      try { if (typeof PublicSkills !== "undefined") PublicSkills.setActiveMode(custom ? custom.id : null); } catch {}
      try { chrome.storage.local.set({rsWorkMode: workMode}); } catch {}
      try { window.__rsWorkMode = () => workMode; } catch {}
      syncWorkModeUi();
      buildMenu(); renderBar();
      // 1.34: a work-mode switch rides on the next tool result as a short
      // MODE SWITCH note (profile + this mode's focus signatures) instead of
      // re-sending the whole system prompt (see withSysResend).
      try { if (A.started || A.running) { A.workModeSwitchPending = true; A.forceSysResend = true; } } catch {}
      try { updateExtraButton(); } catch {}
      if (!silent) { try { playSfx("special"); } catch {} toast(custom ? custom.toast : WORK_MODES[workMode].toast); }
    }
    try { window.__rsSetWorkMode = (id) => setWorkMode(id); } catch {}
    // Multi-Agent crew badge: which specialist is active + plan progress.
    function syncCrewBadge(){
      const el = root && root.querySelector("#rs-crew-badge");
      if (!el) return;
      let b = { text: "", title: "", role: "" };
      try { if (typeof ORAgentCrew !== "undefined" && ORAgentCrew) b = ORAgentCrew.badge(); } catch {}
      const show = !!(multiAgent && b && b.text);
      el.hidden = !show;
      if (show) { el.textContent = b.text; el.title = b.title; el.dataset.role = b.role || ""; }
    }
    try { window.__rsSyncCrewBadge = syncCrewBadge; } catch {}
    try { window.addEventListener("or-crew-change", () => { try { syncCrewBadge(); } catch {} }); } catch {}
    // Bar badge + <html data-rs-work> for CSS; every mode has a badge.
    function syncWorkModeUi(){
      const mode = WORK_MODES[workMode] || WORK_MODES.ultimate;
      const pm = publicMode();
      try { document.documentElement.setAttribute("data-rs-work", workMode); } catch {}
      try { document.documentElement.toggleAttribute("data-rs-public-mode", !!pm); } catch {}
      const badge = root && root.querySelector("#rs-work-badge");
      if (badge) {
        badge.textContent = pm ? pm.badge : mode.badge; badge.dataset.work = workMode; badge.hidden = !(pm ? pm.badge : mode.badge);
        badge.title = pm ? `${pm.title} — custom work mode on ${mode.name} — ${pm.sub}` : mode.name + " work mode — " + mode.sub;
      }
    }
    function setExtraThinking(v){ extraThinking=!!v; try{chrome.storage.local.set({rsExtraThinking: extraThinking});}catch{}; try{ window.__rsExtraThinking = () => extraThinking; }catch{}; buildMenu(); updateExtraButton(); renderBar(); toast(v ? "Think ON — it will grill every solution" : "Think off"); markModesChanged(); }
    const STEERING_QUEUE_MAX = 5;
    const STEERING_QUEUE_CHARS = 2200;
    function steeringPhaseLabel(phase) {
      return ({
        idle: "Ready", starting: "Starting", waiting: "Waiting for AI",
        reviewing: "Reviewing", running: "Running", sending: "Sending result",
        steering: "Applying steering", correcting: "Correcting reply",
        complete: "Task complete", stopped: "Stopped", error: "Needs attention",
      })[phase] || "Steering";
    }
    function syncSteeringUi() {
      if (!bar || !steeringStrip) return;
      const on = !!steeringMode;
      const visible = on && !!(A.started || A.starting || A.running || A.steeringQueue.length);
      steeringStrip.hidden = !visible;
      bar.classList.toggle("rs-steering-expanded", visible);
      const steeringBtn = root && root.querySelector("#rs-steering");
      if (steeringBtn) {
        steeringBtn.classList.toggle("on", on);
        steeringBtn.textContent = on ? "Steering ON" : "Steering";
        steeringBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      const phase = A.steeringPhase || (A.starting ? "starting" : "idle");
      if (steeringProgressEl) steeringProgressEl.dataset.phase = phase;
      if (steeringStepEl) {
        const step = A.steeringStep > 0 ? `Step ${A.steeringStep} · ` : "";
        steeringStepEl.textContent = step + steeringPhaseLabel(phase);
      }
      if (steeringDetailEl) steeringDetailEl.textContent = A.steeringDetail ||
        (A.running ? "Working on the active request" : "Send a task in chat to begin");
      const queued = A.steeringQueue.length;
      if (steeringQueuedEl) {
        steeringQueuedEl.hidden = queued === 0;
        steeringQueuedEl.textContent = queued ? `${queued} queued` : "";
      }
      const canSteer = on && A.running;
      if (steeringInput) {
        steeringInput.disabled = !canSteer;
        steeringInput.placeholder = canSteer ? "Steer the next step…" : "Steering opens while the agent is working";
      }
      if (steeringSendBtn) steeringSendBtn.disabled = !canSteer;
    }
    function steeringProgress(phase, detail, step) {
      A.steeringPhase = phase || "idle";
      A.steeringDetail = String(detail || "").slice(0, 180);
      if (Number.isFinite(step)) A.steeringStep = Math.max(0, step);
      syncSteeringUi();
    }
    function enqueueSteeringSteering(raw) {
      if (!steeringMode) return;
      const text = String(raw || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 800);
      if (!text) return;
      if (!A.running) {
        toast("Start a task first — steering is applied while Steering is working");
        return;
      }
      const queuedChars = A.steeringQueue.reduce((n, item) => n + item.text.length, 0);
      if (A.steeringQueue.length >= STEERING_QUEUE_MAX || queuedChars + text.length > STEERING_QUEUE_CHARS) {
        toast("Steering queue is full — wait for the next step");
        return;
      }
      A.steeringQueue.push({ text, at: Date.now() });
      if (steeringInput) steeringInput.value = "";
      steeringProgress( "Queued for the next safe command boundary", A.steeringStep);
      diag("steering.queued", { count: A.steeringQueue.length, len: text.length });
      toast("Steering queued — it will apply before the next command");
    }
    function takeSteeringSteering() {
      if (!steeringMode || !A.steeringQueue.length) return "";
      const queued = A.steeringQueue.splice(0, A.steeringQueue.length);
      syncSteeringUi();
      const text = queued.map((item, i) => queued.length > 1 ? `${i + 1}. ${item.text}` : item.text).join("\n");
      diag("steering.applied", { count: queued.length, len: text.length });
      return text;
    }
    // Non-consuming look: a batch stops before its next step when a steer is
    // waiting, and the top of the loop then takes it with the usual bookkeeping.
    function peekSteeringSteering() {
      return steeringMode && A.steeringQueue.length ? A.steeringQueue[0].text : "";
    }
    function clearSteeringSteering() {
      if (A.steeringQueue.length) diag("steering.cleared", { count: A.steeringQueue.length });
      A.steeringQueue.length = 0;
      syncSteeringUi();
    }
    function setPlanMode(v){ planMode=!!v; try{chrome.storage.local.set({rsPlanMode: planMode});}catch{}; try{ window.__rsPlanMode = () => planMode; }catch{}; buildMenu(); renderBar(); toast(v ? "Plan mode on — the AI writes a plan, then production code" : "Plan mode off"); markModesChanged(); }
    function setAutoDebug(v){ autoDebugEnabled=!!v; try{chrome.storage.local.set({rsAutoDebug: autoDebugEnabled});}catch{}; try{ window.__rsAutoDebug = () => autoDebugEnabled; }catch{}; buildMenu(); toast(v ? "Automatic Debugger on — new Studio errors are sent to the AI" : "Automatic Debugger off"); markModesChanged(); }
    // Task list (Settings → Task list). State lives in ORTaskList; this only
    // flips it, refreshes the surfaces and tells the AI on the next turn.
    function taskListOn(){ try { return typeof ORTaskList !== "undefined" && ORTaskList.isEnabled(); } catch { return false; } }
    function taskListSummary(){ try { const p = ORTaskList.progress(); return p.total ? `${p.done}/${p.total} done${p.open ? ", " + p.open + " open" : ""}` : "no tasks yet"; } catch { return ""; } }
    function setTaskList(v){
      if (typeof ORTaskList === "undefined") return toast("Task list module missing - reload the page");
      ORTaskList.setEnabled(!!v);
      if (!v && cardsTab === "tasks") cardsTab = "library";
      buildMenu(); syncTaskPill(); markModesChanged();
      toast(v ? "Task list enabled - Tasks tab is in the cards panel; the AI now has task_list / task_next / task_add / task_update" : "Task list disabled - tasks are kept, the AI no longer sees them");
      if (v) { try { cardsTab = "tasks"; if (openCardsPanel) openCardsPanel(true); } catch {} }
    }
    function syncTaskPill(){
      const el = root && root.querySelector("#rs-task-pill");
      if (!el) return;
      let p = null; try { p = taskListOn() ? ORTaskList.progress() : null; } catch {}
      const show = !!(p && p.total);
      el.hidden = !show;
      if (show) { el.textContent = `Tasks ${p.done}/${p.total}`; el.dataset.done = p.done === p.total ? "all" : p.doing ? "doing" : "open"; el.title = `${p.done} of ${p.total} tasks done${p.open ? ` - ${p.open} open` : ""} - click to open the Tasks tab`; }
    }
    window.addEventListener("or-tasklist-change", () => { try { syncTaskPill(); } catch {} try { if (menuEl && !menuEl.hidden) buildMenu(); } catch {} try { if (cardsPanel && !cardsPanel.hidden && (cardsTab === "tasks" || !taskListOn())) renderCards(cardsPanel); } catch {} });
    function setMultiAgent(v){ multiAgent=!!v; try{chrome.storage.local.set({rsMultiAgent: multiAgent});}catch{}; try{ window.__rsMultiAgent = () => multiAgent; }catch{}; buildMenu(); try { if (typeof ORAgentCrew !== "undefined" && ORAgentCrew) ORAgentCrew.reset(); } catch {} try { syncCrewBadge(); } catch {} toast(v ? "Multi-Agent on — planner, builder, scripter, reviewer, tester, debugger" : "Multi-Agent off"); markModesChanged(); }
    // Toggling a mode mid-session must reach the AI on the NEXT turn, not ~12
    // results later: force the full system prompt (which now carries the
    // EXTRA THINKING / FORGE sections) to ride the next outgoing result.
    function markModesChanged(){ try { if (A.started || A.running) A.forceSysResend = true; } catch {} try { updateExtraButton(); } catch {} }
    function updateExtraButton(){
      const eb = document.getElementById("rs-extra");
      if (eb) {
        eb.hidden = false;
        eb.classList.toggle("on", !!extraThinking);
        eb.title = extraThinking ? "Think ON — questioning every assumption" : "Think — question every assumption for the best solution";
        eb.textContent = extraThinking ? "Think ✓" : "Think";
      }
      const ub = document.getElementById("rs-undo");
      if (ub) {
        let local = false;
        try { local = activeEngine() === "local"; } catch {}
        ub.hidden = !A.started || local;
      }
    }
    // Auto-fix playtest watcher — polls console whenever autoFix is on and Studio is in Play.
    // User request: "whenever a user plays a playtest in Roblox Studio, and there is an error
    // in the output, it suddenly stops playing and the system automatically copies the error
    // in the output and then pastes it into AI to check and fix it."
    // v1.11 rewrite — the old version re-fired the SAME error forever because:
    //  (a) _autofixBusy was never set, so overlapping 4s ticks double-injected;
    //  (b) the dedupe hash was tail+length, so ANY new console line (prints, the
    //      fix's own output) re-triggered the previous error;
    //  (c) play state was guessed from a fuzzy regex over get_studio_state text,
    //      letting EDIT-mode stale errors trigger a loop that itself stopped Play.
    // Contract now: only fires on errors that appeared AFTER this play session
    // started, at most once per distinct error signature, never while the agent
    // loop itself is mid-turn, with a hard cooldown between injections.
    let _autofixBusy = false;          // re-entrancy guard (actually set now)
    let _autofixLastAt = 0;            // cooldown anchor
    const AUTOFIX_COOLDOWN_MS = 90000; // min gap between two injections
    let _wasPlaying = false;           // play-session edge detector
    let _playBaseline = "";            // console snapshot taken when Play started
    let _reportedSigs = new Set();     // error signatures already fed to the AI
    // Normalize one error line into a stable signature: timestamps, durations,
    // leading line numbers and whitespace stripped, lowercased. Two occurrences
    // of the same runtime error a minute apart must hash identically.
    function _autofixSig(line) {
      return String(line)
        .replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, "TS")   // 12:34:56.789 timestamps
        .replace(/\d+(?:\.\d+)?\s*(?:ms|s\b)/gi, "DUR")     // durations
        .replace(/^\s*\d+\s*[.|:|)]\s*/, "")                // "12." / "12:" / "12)" prefixes
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
    // Extract the LAST complete error block (header + its stack) from text.
    function _autofixExtractBlock(txt) {
      const lines = txt.split(/\r?\n/);
      // Walk backwards for a header line: Roblox errors carry "…:NN: message"
      // or an explicit "Error" / "Stack Begin" context.
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l) continue;
        if (/(?:^|\s)(?:error|exception|traceback|failed to load)\b/i.test(l) ||
            /:\d+: .*attempt|:\d+: .*expected|:\d+: .*invalid|:\d+: .*unable/i.test(l)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return "";
      const out = [];
      // Header first (plus one line of context above when it looks like a
      // "The error occurred in" locator), then the stack block that follows.
      if (idx > 0 && /error occurred/i.test(lines[idx - 1] || "")) out.push(lines[idx - 1]);
      for (let i = idx; i < lines.length && out.length < 22; i++) {
        out.push(lines[i]);
        if (/stack end/i.test(lines[i])) break;
      }
      return out.join("\n").slice(0, 900);
    }
    async function checkPlaytestErrors(){
      try {
        const eng = activeEngine();
        if (eng !== "roblox" && eng !== "anim") return;      // Studio-only feature
      } catch { return; }
      if (!autoFixEnabled || _autofixBusy || (document.hidden && !bgMode)) return;
      if (!A.started) return;                                 // no live session → nothing to feed
      if (A.running || A.starting || A.stopping || A.injecting) return; // never interleave with the loop
      if (Date.now() - _autofixLastAt < AUTOFIX_COOLDOWN_MS) return;
      if (!(A.bridge && (A.bridge.connected || A.bridge.roblox_connected))) return; // Studio path down
      _autofixBusy = true;
      try {
        // 1. Authoritative play probe: execute_luau against the SERVER datamodel
        //    only exists while the game is running. Edit mode answers with a
        //    "...not available..." error — which itself means "not playing".
        let isPlaying = false;
        try {
          const probe = await bg({
            type: "call_tool", name: "execute_luau",
            arguments: {
              code: 'local rs = game:GetService("RunService")\nreturn tostring(rs:IsRunning())',
              datamodel_type: "Server",
            },
            timeout: 15000,
          });
          if (probe && probe.ok && typeof probe.text === "string") {
            isPlaying = /true/i.test(probe.text);
          } else {
            // Server datamodel missing (Edit mode) or Studio offline → not playing.
            isPlaying = false;
          }
        } catch { isPlaying = false; }
        // 2. Play-session edge: snapshot the console at the moment Play starts so
        //    ONLY errors emitted after it count. Old output from previous runs
        //    can never re-trigger the watcher.
        const out = await bg({ type: "call_tool", name: "get_console_output", arguments: {} });
        if (!out || !out.ok || typeof out.text !== "string") return;
        const txt = out.text;
        if (isPlaying && !_wasPlaying) {
          _playBaseline = txt;
          _reportedSigs = new Set();      // fresh session, fresh error memory
          _wasPlaying = true;
          diag("autofix.playstart", { len: txt.length });
        } else if (!isPlaying && _wasPlaying) {
          _wasPlaying = false;
          return;                          // play ended cleanly — nothing to do
        }
        if (!isPlaying) return;
        // 3. Only the output appended since the baseline is eligible.
        let fresh = "";
        if (_playBaseline && txt.startsWith(_playBaseline)) {
          fresh = txt.slice(_playBaseline.length);
        } else if (_playBaseline && txt.length > _playBaseline.length) {
          fresh = txt.slice(-Math.max(200, txt.length - _playBaseline.length)); // rotated/cleared console
        } else if (!_playBaseline) {
          fresh = txt.slice(-1500);        // baseline missed (loaded mid-play): tail only
        }
        if (!/(error|stack begin|exception|traceback|failed to load)/i.test(fresh)) return;
        const errBlock = _autofixExtractBlock(fresh);
        if (!errBlock) return;
        const sig = _autofixSig(errBlock.split(/\r?\n/).find((l) => l && l.trim()) || errBlock);
        if (!sig || _reportedSigs.has(sig)) return;
        _reportedSigs.add(sig);
        _autofixLastAt = Date.now();
        diag("autofix.trigger", { len: txt.length, sig: sig.slice(0, 90) });
        // 4. Stop the playtest (optional) so the error doesn't spam while fixing.
        if (autoFixStopPlay) {
          try { await bg({ type: "call_tool", name: "start_stop_play", arguments: { is_start: false } }); } catch {}
          _wasPlaying = false;
        }
        toast("Playtest error — sending it to the AI to fix");
        // 5. Feed the error to the AI as if the user reported it.
        const prompt =
          "\u26a0\ufe0f PLAYTEST ERROR (auto-captured from Output while the game was running):\n" +
          "```\n" + errBlock + "\n```\n" +
          (autoFixStopPlay
            ? "The playtest was stopped automatically. "
            : "The playtest is still running; it will keep spamming this error until fixed. ") +
          "Fix the script that caused this error. Keep it simple: explain the fix in one sentence, " +
          "then rewrite the script. Do NOT re-run the game yourself — I will playtest again after your fix.";
        const base = await submitAndGetBase(prompt);
        // The normal loop picks the turn up from here.
        diag("autofix.injected", { base });
      } catch (e) { diag("autofix.err", { msg: String(e && e.message || e).slice(0, 120) }); }
      finally { _autofixBusy = false; }
    }
    // Poll every 4s when enabled. Cheap when idle: the guards above return
    // before any tool call unless a session is live AND Studio is playing.
    setInterval(checkPlaytestErrors, 4000);
    // Reflect the saved value back into the menu textarea (unless being edited).


    function syncMenuPrompt() {
      const ta = root && root.querySelector("#rs-set-text");
      if (ta && document.activeElement !== ta) ta.value = customPrompt;
    }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // User-added MCP servers shown at the very bottom of the menu. These are
    // ADDONS: the Roblox server stays primary and is never in this list. Each
    // entry is { id, name, command } - `command` is the raw string the user
    // typed (split into command+args when sent to the bridge). The bridge writes
    // them to config.json and restarts to load them; this local list only drives
    // the menu UI and is kept in sync with the bridge's server health.
    let customMcpServers = [];
    try {
      chrome.storage.local.get("rsCustomMcpServers", (r) => {
        if (r && Array.isArray(r.rsCustomMcpServers)) {
          customMcpServers = r.rsCustomMcpServers;
          if (!menuEl.hidden) buildMenu();
        }
      });
    } catch {}
    function getCustomMcpServers() { return customMcpServers; }
    function saveCustomMcpServers() {
      try { chrome.storage.local.set({ rsCustomMcpServers: customMcpServers }); } catch {}
    }
    function blenderConnected() {
      if (A.bridge && A.bridge.blender === true) return true;
      const live = ((A.bridge && A.bridge.servers) || []);
      const hit = (s) => /blender/i.test(String((s && (s.id || s.name || s.command)) || ""));
      return live.some((s) => hit(s) && s.alive);
    }
    function syncBlenderFlag() {
      try { window.__rsBlender = () => blenderConnected(); } catch {}
    }
    function blenderToolCount() {
      try { return (A.toolList || []).filter((t) => t && (t.server === "blender" || /^blender_|^get_scene_info$|^get_object_info$|^execute_blender_code$|^get_viewport_screenshot$/.test(String(t.name || "")))).length; } catch { return 0; }
    }
    // Blender MCP card (Settings → MCP servers). Two states: offline shows the
    // three-step checklist; connected shows what the link unlocks. The status
    // pill sits next to the name (never on the clipped right edge) and the
    // primary button never wraps.
    function blenderCardHtml() {
      const on = blenderConnected();
      const n = on ? blenderToolCount() : 0;
      const pill = `<span class="rs-blender-pill" role="status"><i aria-hidden="true"></i>${on ? "Connected" : "Offline"}</span>`;
      const body = on
        ? `<div class="rs-blender-caps" aria-label="Available through Blender">
             <span class="rs-blender-cap"><b>Viewport</b> screenshots</span>
             <span class="rs-blender-cap"><b>Modeling</b> with bpy</span>
             <span class="rs-blender-cap"><b>Send to Studio</b> (FBX / mesh)</span>
             ${n ? `<span class="rs-blender-cap rs-blender-cap-n">${n} tools</span>` : ""}
           </div>`
        : `<ol class="rs-blender-steps" aria-label="How to connect Blender">
             <li><b>1</b><span>In Blender press <kbd>N</kbd> and open the <em>MCP for Blender</em> tab.</span></li>
             <li><b>2</b><span>Click <em>Start MCP Server</em> — it listens on port 9876.</span></li>
             <li><b>3</b><span>Come back and press <em>Connect Blender</em>.</span></li>
           </ol>`;
      return `<div class="rs-blender-card ${on ? "on" : ""}" id="rs-blender-card" data-state="${on ? "on" : "off"}">
              <div class="rs-blender-head">
                <span class="rs-blender-mark" aria-hidden="true"></span>
                <div class="rs-blender-copy">
                  <div class="rs-blender-title"><span class="rs-blender-name">Blender MCP</span>${pill}</div>
                  <span class="rs-blender-sub">${on ? "Addon live on 127.0.0.1:9876 — the AI can model in Blender and export to Studio." : "Talks to the blender-mcp addon on 127.0.0.1:9876. No uv/uvx needed."}</span>
                </div>
              </div>
              ${body}
              <div class="rs-blender-note" id="rs-blender-note" hidden></div>
              <div class="rs-blender-actions">
                <button type="button" id="rs-mcp-blender" class="rs-blender-primary">${on ? "Reconnect" : "Connect Blender"}</button>
                ${on ? '<button type="button" class="rs-blender-off" id="rs-mcp-blender-off">Disconnect</button>' : ""}
                <button type="button" class="rs-blender-link" id="rs-blender-site" title="Open blender.org in a new tab">blender.org</button>
              </div>
            </div>`;
    }
    try { window.__rsBlender = () => blenderConnected(); } catch {}
    // The bridge (config.json + live health) is the SOURCE OF TRUTH for which
    // addon servers actually exist - chrome.storage.local is just a display-name
    // cache, and the two CAN drift (e.g. storage cleared, or config.json edited
    // by hand). Rendering from the bridge's live list means an addon never
    // "disappears" from the menu while still running - and self-heals the local
    // cache the moment we see a server it didn't know about.
    function mergedMcpServers() {
      const live = ((A.bridge && A.bridge.servers) || []).filter((sv) => sv.id !== "roblox");
      const byId = new Map(customMcpServers.map((s) => [s.id, s]));
      const merged = live.map((sv) => {
        const cached = byId.get(sv.id);
        return {
          id: sv.id, name: (cached && cached.name) || sv.id, command: cached && cached.command,
          alive: sv.alive, tools: sv.tools,
        };
      });
      // Self-heal: cache didn't know about a server the bridge actually has.
      let healed = false;
      for (const sv of live) {
        if (!byId.has(sv.id)) { customMcpServers.push({ id: sv.id, name: sv.id }); healed = true; }
      }
      if (healed) saveCustomMcpServers();
      // A server we just added/removed but the bridge hasn't reported back on
      // yet (mid-restart) - still show it, health unknown, so it doesn't blink
      // out of the list during the few seconds the bridge is restarting.
      for (const s of customMcpServers) {
        if (!merged.some((m) => m.id === s.id)) merged.push({ ...s, alive: undefined, tools: undefined });
      }
      return merged;
    }
    // Derive a config-safe server id from a display name (roblox is reserved).
    function mcpSlug(name) {
      let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!s || s === "roblox") s = `addon-${s || "server"}`;
      let id = s, n = 2;
      while (customMcpServers.some((x) => x.id === id)) id = `${s}-${n++}`;
      return id;
    }
    // Split a raw "command with args" string into command + args (shell-lite:
    // whitespace-separated, honouring "double" and 'single' quotes).
    function splitCommand(raw) {
      const parts = String(raw || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const clean = parts.map((p) => p.replace(/^["']|["']$/g, ""));
      return { command: clean[0] || "", args: clean.slice(1) };
    }
    // Wait for the bridge to come back after its restart (config reload). Resolves
    // true once reconnected (optionally once `id` shows up in server health).
    async function waitForBridgeBack(id, timeoutMs = 15000) {
      const t0 = Date.now();
      // Give the bridge a moment to actually drop before we start polling, so we
      // don't instantly match the pre-restart "connected" state.
      await new Promise((r) => setTimeout(r, 1200));
      while (Date.now() - t0 < timeoutMs) {
        const s = await bg({ type: "status" });
        if (s && s.connected) {
          if (!id || (Array.isArray(s.servers) && s.servers.some((x) => x.id === id))) return true;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      return false;
    }

    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control: other AI sites, the custom
    // prompt, and support (Robux). Opens above the bar.
    function buildMenu() {
      try { window.__rsBuildMenu = buildMenu; } catch {}
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      let sites = "";
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const label = `<span class="rs-site-name"><span>${s.name}</span><span class="rs-site-host">${s.host || hostOf(s.url)}</span></span>`;
        sites += current
          ? `<div class="rs-site-opt rs-site-here">${label}<span class="rs-site-badge">active</span></div>`
          : `<button class="rs-site-opt" data-u="${s.url}">${label}<span class="rs-site-go">&rarr;</span></button>`;
      }
      let passes = "";
      for (const p of ROBUX_PASSES) {
        passes += `<button class="rs-tip-opt rs-tip-rbx" data-u="${passUrl(p.id)}" data-pass="${p.id}"><span class="rs-rbx-cur">R$</span><span class="rs-rbx-amt"></span></button>`;
      }
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const mergedServers = mergedMcpServers();
      // Roblox always heads the list as the primary target. Its health is shown
      // by the main status dot and it cannot be removed from this menu.
      let mcpList =
        `<div class="rs-mcp-item rs-mcp-item-primary"><div class="rs-mcp-info"><span class="rs-mcp-name">Roblox Studio</span><span class="rs-mcp-url">primary - probe status above</span></div></div>`;
      mergedServers.forEach((s, i) => {
        // alive === undefined -> the bridge hasn't reported this server's health
        // yet (just added/removed, still restarting) - shown neutral, not red.
        const healthClass = s.alive === true ?  "on" : s.alive === false ?  "off" : "unknown";
        const healthTitle = s.alive === true ?  `${s.tools || 0} tools available` : s.alive === false ?  "offline" : "status unknown";
        mcpList += `<div class="rs-mcp-item"><span class="rs-mcp-health rs-mcp-health-${healthClass}" title="${healthTitle}"></span><div class="rs-mcp-info"><span class="rs-mcp-name">${esc(s.name)}</span><span class="rs-mcp-url">${esc(s.command || s.id)}</span></div><button class="rs-mcp-remove" data-id="${esc(s.id)}" title="Remove">✕</button></div>`;
      });
      menuEl.innerHTML =
        `<div class="rs-menu-head"><span class="rs-menu-mark rs-menu-mark-logo" aria-hidden="true" style="background-image:url(${chrome.runtime.getURL("assets/icon128.png")})"></span><div class="rs-menu-head-txt"><span class="rs-menu-logo">Settings</span><span class="rs-menu-tag"><span data-rs-brand>${orTheme==="void"?"VoidScript":"OrScript"}</span> · v${EXT_VERSION}</span></div><button type="button" class="rs-menu-close" id="rs-menu-close" aria-label="Close settings" title="Close">×</button></div>
         <section class="rs-menu-sec">
           <div class="rs-sec-label"><span>Switch AI</span></div>
           ${sites}
         </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Help</span></div>
            <button class="rs-tip-opt rs-tip-star" id="rs-menu-tutorial"><span>Read the Tutorial</span><span class="rs-tip-sub">text walkthrough \u2014 always up to date</span></button>
            ${WORKINK_URL ?  `<button class="rs-tip-opt rs-tip-ad" data-u="${WORKINK_URL}"><span>Watch an ad to support</span><span class="rs-tip-sub">free, takes a minute</span></button>` : ""}
          </section>
         <section class="rs-menu-sec">
           <div class="rs-sec-label"><span>Support with Robux</span></div>
             <div class="rs-rbx-grid">${passes}</div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Work mode</span><span class="rs-sec-state">${(() => { const pm = publicMode(); return pm ? escRs(pm.title) + " · " + WORK_MODES[workMode].short : WORK_MODES[workMode].short; })()}</span></div>
              <div class="rs-menu-note">${(() => { const pm = publicMode(); return pm ? escRs(pm.note || pm.sub) : WORK_MODES[workMode].note; })()}</div>
              <div class="rs-work-row rs-work-ultimate rs-work-modes" role="radiogroup" aria-label="Work mode">
                ${WORK_MODE_IDS.map((id) => `<button type="button" class="rs-work-card ${workMode===id&&!publicMode()?"on":""}" data-work="${id}" role="radio" aria-checked="${workMode===id&&!publicMode()?"true":"false"}"><span class="rs-work-name">${WORK_MODES[id].name}</span><span class="rs-work-sub">${WORK_MODES[id].sub}</span></button>`).join("")}
                ${(() => { let customs = []; try { customs = typeof PublicSkills !== "undefined" ? PublicSkills.modes().filter((m) => m.enabled) : []; } catch {} const pm = publicMode(); return customs.map((m) => `<button type="button" class="rs-work-card rs-work-custom ${pm&&pm.id===m.id?"on":""}" data-work="pm:${m.id}" role="radio" aria-checked="${pm&&pm.id===m.id?"true":"false"}" title="Custom mode on ${escRs(WORK_MODES[m.base]?WORK_MODES[m.base].name:"Ultimate")}"><span class="rs-work-name">${escRs(m.title)} <small>public</small></span><span class="rs-work-sub">${escRs(m.sub || m.description)}</span></button>`).join(""); })()}
              </div>
              ${(() => { const st = (WORK_MODES[workMode] && WORK_MODES[workMode].starters) || []; return st.length ? `<div class="rs-work-starters" aria-label="${WORK_MODES[workMode].name} quick starts"><span class="rs-work-starters-label">Quick starts</span>${st.map((q, i) => `<button type="button" class="rs-work-starter" data-work-starter="${i}" title="${escRs(q.prompt)}">${escRs(q.label)}</button>`).join("")}</div>` : ""; })()}
              <div class="rs-menu-note rs-work-public-note">Make your own mode, skill or ability: open the cards panel → <b>Public</b> tab and describe it — the AI builds and installs it.</div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Access</span></div>
              <div class="rs-menu-note">Sandbox = Studio and the project folder. Ask = confirm each write. Full = the whole PC (AgentScript).</div>
              <div class="rs-work-row">
                <button type="button" class="rs-work-card ${permMode==="sandbox"?"on":""}" data-perm="sandbox"><span class="rs-work-name">Sandbox</span><span class="rs-work-sub">Roblox / workspace only</span></button>
                <button type="button" class="rs-work-card ${permMode==="ask"?"on":""}" data-perm="ask"><span class="rs-work-name">Ask</span><span class="rs-work-sub">Confirm each write / run</span></button>
                <button type="button" class="rs-work-card ${permMode==="full"?"on":""}" data-perm="full"><span class="rs-work-name">Full</span><span class="rs-work-sub">All PC files + processes</span></button>
              </div>
            </section>
            <section class="rs-menu-sec rs-theme-sec">
              <div class="rs-sec-label"><span>Themes</span><span class="rs-sec-state">${Object.keys(OR_THEMES).length} looks · ${Object.keys(OR_THEMES).filter(id=>OR_THEMES[id].sound?.effects).length} sound packs</span></div>
              <div class="rs-menu-note">${(OR_THEMES[orTheme] && OR_THEMES[orTheme].blurb) || "Pick a chrome skin. Colors, glows, and labels all follow it."}</div>
              <div class="rs-work-row rs-theme-row">
                ${Object.keys(OR_THEMES).map((id) => {
                  const th = OR_THEMES[id];
                  let art = "";
                  try { art = chrome.runtime.getURL("ui/swatch-" + id + ".jpg"); } catch (e) {}
                  return `<article class="rs-work-card rs-theme-card ${orTheme===id?"on":""}" data-theme-card="${id}" role="button" tabindex="0" aria-label="Select ${th.name}"><span class="rs-theme-art"${art ? ` style="background-image:url('${art}')"` : ""}></span><span class="rs-work-glyph">${th.glyph||""}</span><span class="rs-work-name">${th.name}</span><span class="rs-work-sub">${th.sub}</span></article>`;
                }).join("")}
              </div>
              <div class="rs-theme-tools">${themePreviewId?`<button type="button" data-theme-exit-preview>Exit preview</button>`:""}<button type="button" data-theme-random>🎲 Surprise Me</button><div class="rs-theme-sound-list" aria-label="Sound pack preview">${OR_THEMES[orTheme]?.sound?.label?`<span class="rs-theme-sound-name">♪ ${OR_THEMES[orTheme].sound.label}</span>`:""}${(OR_THEMES[orTheme]?.sound?.effects||[]).map(e=>`<button type="button" data-theme-sound-preview="${orTheme}" data-effect="${e.name}" title="Play the ${e.name} sound">${SFX_LABELS[e.name]||e.name}</button>`).join("")}</div><label>Theme Sounds <input type="checkbox" data-theme-sounds ${soundOn?"checked":""}></label><label>Volume <input type="range" min="0" max="100" value="${themeVolume}" data-theme-volume></label><label>Effects <select data-meme-effects><option ${memeEffects==="full"?"selected":""}>full</option><option ${memeEffects==="reduced"?"selected":""}>reduced</option><option ${memeEffects==="off"?"selected":""}>off</option></select></label><label>Intensity <select data-meme-intensity><option ${memeIntensity==="low"?"selected":""}>low</option><option ${memeIntensity==="medium"?"selected":""}>medium</option><option ${memeIntensity==="maximum"?"selected":""}>maximum</option></select></label></div>
            </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Agent modes</span></div>
            <div class="rs-tgl-row" data-mode="bgmode" role="switch" aria-checked="${bgMode}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Work in background tabs</span>
              <span class="rs-tgl-sub">Keep building while you browse other sites — this tab can stay in the background.</span></span>
              <span class="rs-tgl ${bgMode ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="autofix" role="switch" aria-checked="${autoFixEnabled}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Auto-fix playtest errors</span>
              <span class="rs-tgl-sub">Watches Output during Play and sends new errors to the AI.</span></span>
              <span class="rs-tgl ${autoFixEnabled ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row rs-tgl-sub-row" data-mode="autofixstop" role="switch" aria-checked="${autoFixStopPlay}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Stop playtest on error</span>
              <span class="rs-tgl-sub">Stop Play when an error is caught (off = keep playing while the AI fixes it).</span></span>
              <span class="rs-tgl ${autoFixStopPlay ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="autodebug" role="switch" aria-checked="${autoDebugEnabled}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Automatic Debugger</span><span class="rs-tgl-sub">After Studio edits, new Output errors are sent to the AI to fix.</span></span>
              <span class="rs-tgl ${autoDebugEnabled ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="multiagent" role="switch" aria-checked="${multiAgent}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Multi-Agent</span><span class="rs-tgl-sub">Crew with a shared board: planner → builder / scripter → reviewer → tester → debugger. Read-only roles cannot edit; "done" needs a verified playtest.</span></span>
              <span class="rs-tgl ${multiAgent ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="tasklist" role="switch" aria-checked="${taskListOn()}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Task list</span><span class="rs-tgl-sub">${taskListOn() ? `Enabled — ${taskListSummary()}. The AI sees the list, gets task_list / task_next / task_add / task_update, and a progress pill shows on the bar.` : "Disabled — a checklist you (or the AI) keep for this project. Enable to show the Tasks tab in the cards panel and give the AI the task_* commands."}</span></span>
              <span class="rs-tgl ${taskListOn() ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="sounds" role="switch" aria-checked="${soundOn}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Sound effects</span><span class="rs-tgl-sub">Chime when the agent starts, finishes, or errors.</span></span>
              <span class="rs-tgl ${soundOn ? "on" : ""}"></span>
            </div>
          </section>
          <section class="rs-menu-sec rs-keybind-sec">
            <div class="rs-sec-label"><span>Keyboard shortcuts</span><span class="rs-sec-state">click a field, press keys</span></div>
            <div class="rs-keybind-grid">
              <label>Settings <input data-keybind="menu" value="${keybinds.menu}" readonly></label>
              <label>Start / restart <input data-keybind="start" value="${keybinds.start}" readonly></label>
              <label>Voice coding <input data-keybind="voice" value="${keybinds.voice}" readonly></label>
              <label>Templates <input data-keybind="templates" value="${keybinds.templates}" readonly></label>
            </div>
            <div class="rs-menu-note">Shortcuts work anywhere outside a text field. Voice coding remains opt-in and only starts after its shortcut is pressed.</div>
          </section>
          <section class="rs-menu-sec rs-memory-sec">
            <div class="rs-sec-label"><span>Coding memory</span><span class="rs-sec-state">private · local</span></div>
            <div class="rs-menu-note">Project memory stays across tasks for the same project. Task notes are cleared automatically when you start the next task. Keep this factual — never store secrets.</div>
            <label class="rs-memory-label">Project key<textarea id="rs-mem-key" rows="1" placeholder="e.g. MyGame / place name / team project key"></textarea></label>
            <label class="rs-memory-label">Coding standards<textarea id="rs-mem-coding" rows="3" placeholder="Luau style, naming, architecture, testing rules…"></textarea></label>
            <label class="rs-memory-label">Project context<textarea id="rs-mem-project" rows="3" placeholder="Important systems, paths, services, constraints…"></textarea></label>
            <label class="rs-memory-label">Preferences<textarea id="rs-mem-preferences" rows="2" placeholder="How you want plans, code, and explanations delivered…"></textarea></label>
            <label class="rs-memory-label">Current task notes<textarea id="rs-mem-task" rows="2" placeholder="Temporary context for this task only…"></textarea></label>
            <div class="rs-set-row"><button id="rs-mem-save">Save memory</button><span id="rs-mem-status"></span></div>
            <div class="rs-sec-label"><span>Session recap</span><span class="rs-sec-state">auto · local</span></div>
            <div class="rs-menu-note">ORscript records what each session actually did (commands used, scripts touched, errors seen) and shows the last few to the AI as read-only context. In Studio the AI also keeps the shared handbook at ServerStorage.RobloxScript.Memory via the memory_* commands.</div>
            <pre id="rs-mem-recap" class="rs-mem-recap"></pre>
            <div class="rs-set-row"><label class="rs-chk"><input type="checkbox" id="rs-mem-recap-on"> Auto-record session recap</label><button id="rs-mem-recap-forget">Forget sessions</button></div>
          </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Custom prompt</span></div>
            <div class="rs-menu-note">Added below the system prompt on every new session. The built-in prompt cannot be edited.</div>
            <textarea id="rs-set-text" rows="4" placeholder="e.g. Always comment your Luau code. Prefer small modular scripts."></textarea>
            <div class="rs-set-row"><button id="rs-set-save">Save</button><span id="rs-set-status"></span></div>
          </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>MCP servers</span></div>
            <div class="rs-menu-note">Roblox Studio is primary. Blender connects to the addon running in Blender on port 9876.</div>
            ${blenderCardHtml()}
           ${mcpList}
           <div class="rs-mcp-sep"></div>
            <input id="rs-mcp-name" class="rs-mcp-field" placeholder="Name, e.g. Sketchfab" />
            <input id="rs-mcp-url" class="rs-mcp-field" placeholder="Start command, e.g. npx -y @some/mcp-server" />
            <div class="rs-set-row">
              <button id="rs-mcp-add">Add server</button>
              <button id="rs-mcp-repair" title="Restart the Studio MCP helper inside bin/or-core.exe \u2014 fixes 'connected but every command fails' after a Studio update or sleep/resume">Repair Studio link</button>
              <span id="rs-mcp-status"></span>
            </div>
          </section>
          <div class="rs-menu-foot">OR v${EXT_VERSION} • ${currentEngine==="local"?"AS":currentEngine==="anim"?"AN":"RS"} • ${esc(P.displayName)}</div>`;
      const open = (url) => {
        try {
          if (url && /^(?:chrome|moz)-extension:\/\//.test(url)) {
            // Extension pages (CodeCraft chat) are not web-accessible: the
            // background worker opens them in a new tab.
            const page = url.replace(/^(?:chrome|moz)-extension:\/\/[^/]+\//, "");
            bg({ type: "rs-open-extension-page", page }).catch(() => {});
          } else if (url) window.open(url, "_blank", "noopener");
        } catch {} menuEl.hidden = true;
      };
      const closeBtn = menuEl.querySelector("#rs-menu-close");
      if (closeBtn) closeBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenuOpen(false); });
      menuEl.querySelectorAll("button.rs-site-opt, .rs-tip-opt:not([data-mode])").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      try { fillRobuxPrices(menuEl); } catch (e) {}
      // In-app tutorial (no external link): opens the centered modal.
      const tutBtn = menuEl.querySelector("#rs-menu-tutorial");
      if (tutBtn) tutBtn.addEventListener("click", () => { setMenuOpen(false); openTutorial(); });
      const ta = menuEl.querySelector("#rs-set-text");
      const saveBtn = menuEl.querySelector("#rs-set-save");
      const status = menuEl.querySelector("#rs-set-status");
      if (ta) ta.value = customPrompt;
      if (ta && saveBtn) saveBtn.addEventListener("click", () => {
        customPrompt = ta.value;
        try { chrome.storage.local.set({ rsCustomPrompt: customPrompt }); } catch {}
        if (status) status.textContent = "Saved ✓";
        setTimeout(() => { if (status) status.textContent = ""; }, 1600);
      });
      syncMenuMemory();
      const paintRecap = () => {
        const pre = menuEl.querySelector("#rs-mem-recap");
        const chk = menuEl.querySelector("#rs-mem-recap-on");
        if (chk) chk.checked = autoRecapEnabled;
        if (!pre) return;
        let txt = "";
        try { txt = autoRecapEnabled ? (autoRecap.length ? autoRecapText().split("\n").slice(1).join("\n") : "No sessions recorded yet - run the agent once.") : "Auto recap is off."; } catch { txt = ""; }
        pre.textContent = txt;
      };
      paintRecap();
      try { window.__rsRecapChanged = paintRecap; } catch {}
      const recapChk = menuEl.querySelector("#rs-mem-recap-on");
      if (recapChk) recapChk.addEventListener("change", () => { setAutoRecapEnabled(recapChk.checked); paintRecap(); });
      const recapForget = menuEl.querySelector("#rs-mem-recap-forget");
      if (recapForget) recapForget.addEventListener("click", () => { forgetAutoRecap(); paintRecap(); toast("Session recap cleared"); });
      const memSave = menuEl.querySelector("#rs-mem-save");
      const memStatus = menuEl.querySelector("#rs-mem-status");
      if (memSave) memSave.addEventListener("click", () => {
        const nextKey = menuEl.querySelector("#rs-mem-key")?.value || "";
        switchMemoryProject(nextKey);
        customMemory.coding = menuEl.querySelector("#rs-mem-coding")?.value || "";
        customMemory.project = menuEl.querySelector("#rs-mem-project")?.value || "";
        customMemory.preferences = menuEl.querySelector("#rs-mem-preferences")?.value || "";
        customMemory.task = menuEl.querySelector("#rs-mem-task")?.value || "";
        try { chrome.storage.local.set({ rsCustomMemory: customMemory }); } catch {}
        if (memStatus) memStatus.textContent = "Saved locally ✓";
        setTimeout(() => { if (memStatus) memStatus.textContent = ""; }, 1800);
      });
      syncKeybindInputs();
      menuEl.querySelectorAll("[data-keybind]").forEach(input => {
        input.addEventListener("keydown", e => { e.preventDefault(); e.stopPropagation(); if(["Control","Alt","Shift","Meta"].includes(e.key)) return; const combo=comboFromEvent(e); const name=input.dataset.keybind; keybinds[name]=combo; try { chrome.storage.local.set({rsKeybinds:keybinds}); } catch {} input.value=combo; input.blur(); });
        input.addEventListener("focus", () => { input.value="Press keys…"; });
        input.addEventListener("blur", () => { input.value=keybinds[input.dataset.keybind]||""; });
      });
      menuEl.querySelectorAll("[data-mode]").forEach(btn=>{
        const flip = () => {
          const m=btn.dataset.mode;
          if(m==="autofix") setAutoFix(!autoFixEnabled);
          else if(m==="autofixstop") setAutoFixStopPlay(!autoFixStopPlay);
          else if(m==="bgmode") setBgMode(!bgMode);
          else if(m==="extra") setExtraThinking(!extraThinking);
          else if(m==="plan") setPlanMode(!planMode);
          else if(m==="autodebug") setAutoDebug(!autoDebugEnabled);
          else if(m==="multiagent") setMultiAgent(!multiAgent);
          else if(m==="tasklist") setTaskList(!taskListOn());
          else if(m==="sounds") { setSounds(!soundOn); try { buildMenu(); toast(soundOn ? "Sound effects on" : "Sound effects off"); if (soundOn) playSfx("ok"); } catch {} }
        };
        btn.addEventListener("click", flip);
        btn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
        });
      });
      const mcpNameEl = menuEl.querySelector("#rs-mcp-name");
      const mcpUrlEl = menuEl.querySelector("#rs-mcp-url");
      const mcpStatus = menuEl.querySelector("#rs-mcp-status");
      const mcpAddBtn = menuEl.querySelector("#rs-mcp-add");
      const mcpRepairBtn = menuEl.querySelector("#rs-mcp-repair");
      // Disable every add/remove control and show the restart spinner. Adding or
      // removing a server rewrites config.json and restarts the whole bridge, so
      // no other server edit may run until it is back.
      let mcpBusy = false;
      function setMcpBusy(on, label) {
        mcpBusy = on;
        mcpAddBtn.disabled = on;
        if (mcpRepairBtn) mcpRepairBtn.disabled = on;
        menuEl.querySelectorAll(".rs-mcp-remove").forEach((b) => (b.disabled = on));
        mcpStatus.innerHTML = on
          ? `<span class="rs-mcp-spin-row"><span class="rs-mcp-spin"></span>${label || "Restarting bridge…"}</span>`
          : "";
      }

      // ── Repair Studio link (v1.12): restart the StudioMCP helper ──
      // The agent exe only recycles a DEAD helper when a tool call proves it
      // dead; after a Studio update or sleep/resume the helper can sit dead
      // between calls ("connected" pill, every command failing). This forces a
      // restart on demand and waits for the bridge to come back.
      if (mcpRepairBtn) mcpRepairBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        setMcpBusy(true, "Restarting Studio MCP…");
        try { await bg({ type: "reconnect" }); } catch {}
        const r = await bg({ type: "restart_mcp" });
        if (!r || r.ok === false) {
          setMcpBusy(false);
          mcpStatus.textContent = (r && r.error) || "Restart failed — is bin/or-core.exe running?";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 3200);
          return;
        }
        await waitForBridgeBack(null);
        buildMenu();
        toast("Studio MCP restarted — try that command again");
      });

      menuEl.querySelectorAll(".rs-mcp-remove").forEach((b) =>
        b.addEventListener("click", async () => {
          if (mcpBusy) return;
          const id = b.dataset.id;
          if (!id) return;
          setMcpBusy(true, "Restarting bridge…");
          const r = await bg({ type: "remove_server", server_id: id });
          if (!r || !r.ok) {
            setMcpBusy(false);
            mcpStatus.textContent = (r && r.error) || "Couldn't remove server";
            setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
            return;
          }
          customMcpServers = customMcpServers.filter((s) => s.id !== id);
          saveCustomMcpServers();
          await waitForBridgeBack(null);
          buildMenu(); // rebuilds with the spinner cleared
        }));

      mcpAddBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        const name = mcpNameEl.value.trim();
        const command = mcpUrlEl.value.trim();
        if (!name || !command) {
          mcpStatus.textContent = "Name and command required";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 1800);
          return;
        }
        const id = mcpSlug(name);
        const { command: cmd, args } = splitCommand(command);
        setMcpBusy(true, "Restarting bridge…");
        const r = await bg({ type: "add_server", server_id: id, command: cmd, args });
        if (!r || !r.ok) {
          setMcpBusy(false);
          mcpStatus.textContent = (r && r.error) || "Couldn't add server";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
          return;
        }
        customMcpServers.push({ id, name, command });
        saveCustomMcpServers();
        await waitForBridgeBack(id);
        syncBlenderFlag();
        buildMenu(); // rebuilds with the new server listed + spinner cleared
      });

      const blenderBtn = menuEl.querySelector("#rs-mcp-blender");
      const blenderCard = menuEl.querySelector("#rs-blender-card");
      const blenderNote = menuEl.querySelector("#rs-blender-note");
      function setBlenderBusy(on, label) {
        if (blenderCard) blenderCard.classList.toggle("busy", !!on);
        if (!blenderBtn) return;
        blenderBtn.disabled = !!on;
        if (on) { blenderBtn.dataset.label = blenderBtn.textContent; blenderBtn.innerHTML = `<span class="rs-mcp-spin"></span>${label || "Connecting…"}`; }
        else if (blenderBtn.dataset.label) blenderBtn.textContent = blenderBtn.dataset.label;
      }
      function showBlenderNote(text, kind) {
        if (!blenderNote) return;
        blenderNote.textContent = text || "";
        blenderNote.dataset.kind = kind || "error";
        blenderNote.hidden = !text;
      }
      if (blenderBtn) blenderBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        showBlenderNote("");
        setBlenderBusy(true, "Connecting…");
        setMcpBusy(true, "Checking Blender on port 9876…");
        const r = await bg({ type: "blender_connect" });
        setMcpBusy(false);
        if (!r || !r.ok) {
          setBlenderBusy(false);
          const raw = String((r && r.error) || "").trim();
          const err = /refused|unreachable|timed? ?out|not (listening|running|reach)|ECONN|closed/i.test(raw) || !raw
            ? "Nothing is listening on port 9876. In Blender press N → MCP for Blender → Start MCP Server, then try again."
            : raw.slice(0, 180);
          showBlenderNote(err, "error");
          try { toast("Couldn't reach Blender"); playSfx("error"); } catch {}
          syncBlenderFlag();
          return;
        }
        customMcpServers = customMcpServers.filter((s) => s.id !== "blender");
        saveCustomMcpServers();
        try { A.toolsAt = 0; } catch {}
        try { await ensureTools(true); } catch {}
        syncBlenderFlag();
        try { toast("Blender connected — restart the agent so it sees Blender tools"); playSfx("ok"); } catch {}
        buildMenu();
      });
      const blenderOff = menuEl.querySelector("#rs-mcp-blender-off");
      if (blenderOff) blenderOff.addEventListener("click", async () => {
        if (mcpBusy) return;
        blenderOff.disabled = true;
        if (blenderCard) blenderCard.classList.add("busy");
        setMcpBusy(true, "Disconnecting Blender…");
        await bg({ type: "blender_disconnect" });
        setMcpBusy(false);
        try { A.toolsAt = 0; } catch {}
        try { await ensureTools(true); } catch {}
        syncBlenderFlag();
        try { toast("Blender disconnected"); playSfx("ok"); } catch {}
        buildMenu();
      });
      const blenderSite = menuEl.querySelector("#rs-blender-site");
      if (blenderSite) blenderSite.addEventListener("click", () => {
        try { window.open("https://www.blender.org/", "_blank", "noopener"); } catch {}
      });

      // ── Work mode cards ──
      menuEl.querySelectorAll("[data-work-starter]").forEach(btn=>{
        btn.addEventListener("click", () => {
          const st = (WORK_MODES[workMode] && WORK_MODES[workMode].starters) || [];
          const q = st[+btn.dataset.workStarter];
          if (!q) return;
          const ok = pasteLibraryCard({ title: q.label, prompt: q.prompt }, { silent: true });
          toast(ok ? `${q.label} — edit the prompt if you like, then press Enter` : "Open a chat first — the message box isn't on this page");
          if (ok) { try { setMenuOpen(false); } catch {} }
        });
      });
      menuEl.querySelectorAll("[data-work]").forEach(btn=>{
        btn.addEventListener("click", () => setWorkMode(btn.dataset.work));
      });
      menuEl.querySelectorAll("[data-theme-card]").forEach(card=>{const select=()=>{setOrTheme(card.dataset.themeCard);themePreviewId=null;themeBeforePreview=null;try{buildMenu();toast("Theme: "+OR_THEMES[orTheme].name);playSfx("click");}catch{}};card.addEventListener("click",select);card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select();}});});
      menuEl.querySelector("[data-theme-random]")?.addEventListener("click",()=>{const ids=Object.keys(OR_THEMES).filter(id=>OR_THEMES[id].sound?.effects);previewOrTheme(ids[Math.floor(Math.random()*ids.length)]);});
      menuEl.querySelector("[data-theme-sounds]")?.addEventListener("change",e=>setSounds(e.target.checked));
      menuEl.querySelectorAll("[data-theme-sound-preview]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();playSfx(b.dataset.effect,b.dataset.themeSoundPreview);}));
      menuEl.querySelector("[data-theme-volume]")?.addEventListener("input",e=>applyThemeVolume(e.target.value));
      menuEl.querySelector("[data-meme-effects]")?.addEventListener("change",e=>setMemeEffects(e.target.value));
      menuEl.querySelector("[data-meme-intensity]")?.addEventListener("change",e=>setMemeIntensity(e.target.value));
      menuEl.querySelectorAll("[data-perm]").forEach(btn=>{
        btn.addEventListener("click", () => {
          setPermMode(btn.dataset.perm);
          try { buildMenu(); } catch {}
          const label = permMode === "full" ? "Full PC access" : permMode === "ask" ? "Ask before acting" : "Sandbox (Studio + workspace)";
          try { toast("Permissions: " + label); } catch {}
        });
      });
      // ── Checkpoints undo ──
      menuEl.querySelectorAll(".rs-checkpoint-undo").forEach(btn=>{
        btn.addEventListener("click", ()=>{ undoLastCheckpoint(); });
      });
    }

    // ── Cards (lemonade.gg-style mechanic library + activity feed) ──────────
    // Lemonade's model: a card INVENTORY of pre-made game mechanics you drop
    // into your project; the embedded multi-step prompt drives the agent.
    // Panel = two tabs: Library (engine-aware mechanic cards, click-to-run +
    // native drag into any input) and Activity (live tool-result feed).
    let recentCards = [];
    let cardsTab = "library";
    let visibleLibCache = [];
    let cardsQuery = "";
    let cardsCategory = "All";
    let cardsSearchTimer = 0;
    function escRs(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function trackCard(tool, status, detail, category) {
      const top = recentCards[0];
      if (top && top.tool === tool && top.status === "run" && status !== "run") {
        top.status = status;
        top.detail = String(detail || "").slice(0, 120);
        top.at = Date.now();
      } else {
        recentCards.unshift({ tool, status, detail: String(detail || "").slice(0, 120), category: category || "tool", at: Date.now() });
        if (recentCards.length > 24) recentCards.pop();
      }
      if (cardsTab === "activity" || (activeEngine() === "local" && cardsPanel && !cardsPanel.hidden)) renderCards(cardsPanel);
    }
    try { window.__rsTrackCard = trackCard; } catch {} // tests / other IIFEs can feed the Activity tab

    let templateEditorEl=null,templateEditorId=null,templateProjectRef=null,templateProjectFile=null,templateChromeHidden=false;
    const templateTypes=["prompt","command","workflow","roblox","blender","ui","project","ai-agent"],templateEnvs=["ROBLOX_STUDIO","BLENDER","WEB","GENERAL"];
    function parseJsonField(form,name,fallback){const value=form.elements[name]?.value.trim();if(!value)return fallback;try{return JSON.parse(value);}catch{throw Error(`${name} must contain valid JSON`);}}
    function workflowRowHtml(w={},i=0){return `<div class="rs-builder-row" data-workflow-row><div><input data-wf="id" value="${escRs(w.id||`step-${i+1}`)}" placeholder="Step ID"><input data-wf="title" value="${escRs(w.title||`Step ${i+1}`)}" placeholder="Step title"><input data-wf="command" value="${escRs(w.command||"")}" placeholder="Existing command ID"></div><textarea data-wf="instruction" rows="2" placeholder="Instruction">${escRs(w.instruction||"")}</textarea><div><input data-wf="dependsOn" value="${escRs((w.dependsOn||[]).join(", "))}" placeholder="Dependencies"><select data-wf="errorBehavior">${["STOP","CONTINUE","ROLLBACK"].map(x=>`<option ${w.errorBehavior===x?"selected":""}>${x}</option>`).join("")}</select><button type="button" data-remove-row>Remove</button></div><textarea data-wf="parameters" rows="2" placeholder='Parameters JSON'>${escRs(JSON.stringify(w.parameters||{}))}</textarea><textarea data-wf="validation" rows="2" placeholder='Validation JSON'>${escRs(JSON.stringify(w.validation||{}))}</textarea></div>`;}
    function variableRowHtml(v={}){return `<div class="rs-builder-row rs-variable-row" data-variable-row><input data-var="name" value="${escRs(v.name||"")}" placeholder="variableName"><select data-var="type">${["string","number","boolean","assetId","instancePath","color","enum"].map(x=>`<option ${v.type===x?"selected":""}>${x}</option>`).join("")}</select><input data-var="description" value="${escRs(v.description||"")}" placeholder="Description"><label><input type="checkbox" data-var="required" ${v.required!==false?"checked":""}> Required</label><input data-var="default" value="${escRs(v.default??"")}" placeholder="Default"><input data-var="validation" value="${escRs(JSON.stringify(v.validation||{}))}" placeholder="Validation JSON"><button type="button" data-remove-row>Remove</button></div>`;}
    function syncTemplateBuilders(form){const workflow=[...form.querySelectorAll("[data-workflow-row]")].map(row=>({id:row.querySelector('[data-wf="id"]').value.trim(),title:row.querySelector('[data-wf="title"]').value.trim(),command:row.querySelector('[data-wf="command"]').value.trim(),instruction:row.querySelector('[data-wf="instruction"]').value.trim(),dependsOn:row.querySelector('[data-wf="dependsOn"]').value.split(",").map(x=>x.trim()).filter(Boolean),errorBehavior:row.querySelector('[data-wf="errorBehavior"]').value,parameters:JSON.parse(row.querySelector('[data-wf="parameters"]').value||"{}"),validation:JSON.parse(row.querySelector('[data-wf="validation"]').value||"{}")}));const variables=[...form.querySelectorAll("[data-variable-row]")].map(row=>({name:row.querySelector('[data-var="name"]').value.trim(),type:row.querySelector('[data-var="type"]').value,description:row.querySelector('[data-var="description"]').value.trim(),required:row.querySelector('[data-var="required"]').checked,default:row.querySelector('[data-var="default"]').value,validation:JSON.parse(row.querySelector('[data-var="validation"]').value||"{}")}));form.elements.workflow.value=JSON.stringify(workflow);form.elements.variables.value=JSON.stringify(variables);}
    function templateFromForm(form){syncTemplateBuilders(form);return {name:form.elements.name.value.trim(),description:form.elements.description.value.trim(),type:form.elements.type.value,category:form.elements.category.value.trim()||"Custom",environment:form.elements.environment.value,tags:form.elements.tags.value.split(",").map(x=>x.trim()).filter(Boolean),executionLevel:form.elements.executionLevel.value,instructions:form.elements.instructions.value.split(/\n+/).map(x=>x.trim()).filter(Boolean),workflow:parseJsonField(form,"workflow",[]),commands:form.elements.commands.value.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(command=>({command,parameters:{}})),variables:parseJsonField(form,"variables",[]),validation:parseJsonField(form,"validation",{}),expectedResult:form.elements.expectedResult.value.trim(),notes:form.elements.notes.value.trim(),projectReference:templateProjectRef};}
    function closeTemplateEditor(){try{ORProjectAnalyzer.cancel();}catch{}if(templateEditorEl)templateEditorEl.remove();templateEditorEl=null;templateEditorId=null;templateProjectRef=null;templateProjectFile=null;if(templateChromeHidden){try{if(bar){bar.style.visibility="";bar.style.pointerEvents="";}if(cardsPanel)cardsPanel.hidden=true;}catch{}templateChromeHidden=false;}}
    async function importRobloxProject(file) {
      const valid=ORProjectAnalyzer.validateFile(file); if(!valid.success){toast(`${valid.error.code}: ${valid.error.message}`);return;}
      toast(`Importing ${file.name}…`);
      const result=await ORProjectAnalyzer.analyze(file,{onProgress:p=>{if(p.stage)toast(`${p.stage}${p.processed?` (${p.processed})`:""}`);}});
      if(!result.success){toast(`${result.error.code}: ${result.error.message}`);return;}
      const analysis=result.analysis, base=file.name.replace(/\.rbxlx?$/i,"")||"Roblox project";
      const reference={fileName:file.name,fileSize:file.size,scannedAt:new Date().toISOString(),status:analysis.parser==="ROBLOX_BINARY_METADATA_V1"?"ATTACHED_LIMITED":"COMPLETE",mode:"Full Analysis",analysis};
      const template={name:base,description:`Reusable reference for the Roblox project ${base}.`,type:"project",category:"Roblox",environment:"ROBLOX_STUDIO",tags:["roblox","project","imported"],executionLevel:"READ",instructions:["Use the attached project analysis as verified context before making changes.","Inspect the live Roblox place before applying edits."],workflow:[],commands:[],variables:[],validation:{},expectedResult:"A verified Roblox project reference ready for analysis.",notes:analysis.parser==="ROBLOX_BINARY_METADATA_V1"?"Binary .rbxl metadata attached. Save As XML .rbxlx in Studio for full hierarchy and script analysis.":"XML project analyzed locally; scripts were never executed.",projectReference:reference};
      const saved=await ORTemplateRegistry.createTemplate(template);
      if(!saved.success){toast(`${saved.error.code}: ${saved.error.message}`);return;}
      cardsQuery="";cardsCategory="All";visibleLibCache=libFiltered();renderCards(cardsPanel);toast(`Roblox project imported: ${base}`);
    }

    // ── Project reference panel (Template editor → Project) ──
    // Local-only analysis of a .rbxl/.rbxlx through ORProjectAnalyzer's worker.
    // The saved template carries the compact analysis; the agent reads it in
    // bounded chunks (project.* commands + ORProjectAnalyzer.context), never as
    // one oversized prompt.
    function projectSummaryHtml(ref){
      if(!ref||!ref.analysis)return "No project attached yet.";
      const a=ref.analysis,sm=a.summary||{},p=a.project||{};
      const systems=(sm.detectedSystems||[]).slice(0,8).join(", ")||"none detected";
      const services=(p.services||[]).map(x=>x.name||x).slice(0,10).join(", ");
      const limited=a.parser==="ROBLOX_BINARY_METADATA_V1";
      return `<b>${escRs(ref.fileName||"project")}</b> · ${Math.round((ref.fileSize||0)/1024)} KB · ${escRs(ref.status||"COMPLETE")}${limited?" <small>(binary .rbxl: metadata only - save as .rbxlx in Studio for a full index)</small>":""}<span>${sm.instances||0} instances · ${sm.scripts||0} scripts · ${sm.moduleScripts||0} modules · ${sm.uiObjects||0} UI · ${sm.remoteObjects||0} remotes</span><span>Systems: ${escRs(systems)}</span>${services?`<span>Services: ${escRs(services)}</span>`:""}<span>Scanned ${escRs(ref.scannedAt||"")}</span>`;
    }
    function renderProjectSummary(modal){
      const sum=modal.querySelector("[data-project-summary]"),acts=modal.querySelector("[data-project-actions]");
      if(sum)sum.innerHTML=projectSummaryHtml(templateProjectRef);
      if(acts)acts.hidden=!templateProjectRef;
    }
    async function scanProject(file){
      const modal=templateEditorEl;if(!modal)return;
      const status=modal.querySelector("[data-editor-status]"),prog=modal.querySelector("[data-project-progress]"),stage=modal.querySelector("[data-project-stage]"),sum=modal.querySelector("[data-project-summary]");
      const tab=modal.querySelector('[data-editor-tab="project"]');if(tab)tab.click();
      const valid=ORProjectAnalyzer.validateFile(file);
      if(!valid.success){if(sum)sum.innerHTML=`<b>${escRs(valid.error.code)}</b><span>${escRs(valid.error.message)}</span>`;return;}
      templateProjectFile=file;templateProjectRef=null;try{ORProjectAnalyzer.setActive(null);}catch{}
      if(prog)prog.hidden=false;if(stage)stage.textContent=`Reading ${file.name}…`;if(status)status.textContent=`Analyzing ${file.name} locally…`;
      renderProjectSummary(modal);
      const result=await ORProjectAnalyzer.analyze(file,{onProgress:p=>{if(stage&&p&&p.stage)stage.textContent=`${p.stage}${p.processed?` (${p.processed})`:""}`;}});
      if(!templateEditorEl||templateProjectFile!==file)return; // editor closed or another scan started
      if(prog)prog.hidden=true;
      if(!result.success){if(sum)sum.innerHTML=`<b>${escRs(result.error.code)}</b><span>${escRs(result.error.message)}</span>`;if(status)status.textContent=result.error.code==="PROJECT_SCAN_CANCELLED"?"Analysis cancelled.":`${result.error.code}: ${result.error.message}`;return;}
      const analysis=result.analysis;
      templateProjectRef={fileName:file.name,fileSize:file.size,scannedAt:new Date().toISOString(),status:analysis.parser==="ROBLOX_BINARY_METADATA_V1"?"ATTACHED_LIMITED":"COMPLETE",mode:"Full Analysis",analysis};
      try{ORProjectAnalyzer.setActive(analysis);}catch{}
      renderProjectSummary(modal);
      if(status)status.textContent=`Project analyzed: ${analysis.summary?.instances||0} instances, ${analysis.summary?.scripts||0} scripts. Review, then Save.`;
      const form=modal.querySelector("form");
      if(form&&form.elements.name&&!form.elements.name.value.trim())form.elements.name.value=file.name.replace(/\.rbxlx?$/i,"");
    }
    function templateFromProjectRef(ref,form){
      const a=ref.analysis,sm=a.summary||{},base=(ref.fileName||"Roblox project").replace(/\.rbxlx?$/i,"");
      const systems=(sm.detectedSystems||[]);
      const scripts=(a.project?.scripts||[]).slice(0,12).map(x=>`${x.type||"Script"} ${x.path||x.name}`);
      if(form.elements.name&&!form.elements.name.value.trim())form.elements.name.value=base;
      if(form.elements.description&&!form.elements.description.value.trim())form.elements.description.value=`Reusable reference for the Roblox project ${base}: ${sm.instances||0} instances, ${sm.scripts||0} scripts${systems.length?`, systems: ${systems.join(", ")}`:""}.`;
      if(form.elements.type)form.elements.type.value="project";
      if(form.elements.category&&!form.elements.category.value.trim())form.elements.category.value="Roblox";
      if(form.elements.executionLevel)form.elements.executionLevel.value="READ";
      if(form.elements.tags&&!form.elements.tags.value.trim())form.elements.tags.value=["roblox","project","imported",...systems.map(x=>String(x).toLowerCase())].join(", ");
      if(form.elements.instructions&&!form.elements.instructions.value.trim())form.elements.instructions.value=[`Use project.find / project.findScripts / project.getService to look up ${base} before changing anything - the reference is the source of truth for names and paths.`,`Keep the existing architecture: ${(a.project?.services||[]).map(x=>x.name||x).slice(0,8).join(", ")||"services as found"}.`,...(scripts.length?[`Key scripts: ${scripts.join("; ")}`]:[]),"Do not re-create systems the project already has; extend them."].join("\n");
      if(form.elements.expectedResult&&!form.elements.expectedResult.value.trim())form.elements.expectedResult.value=`Changes fit the existing ${base} structure and reuse its scripts, remotes and UI.`;
    }
    function compareWithProject(ref,form){
      const idx=ORProjectAnalyzer.createIndex(ref.analysis);
      const text=[form.elements.description?.value,form.elements.instructions?.value,form.elements.commands?.value,form.elements.expectedResult?.value].filter(Boolean).join("\n");
      const words=[...new Set((text.match(/[A-Za-z][A-Za-z0-9_]{3,}/g)||[]).map(w=>w.toLowerCase()))].filter(w=>!/^(the|this|that|with|from|into|when|then|should|would|could|template|project|create|make|build|using|your|have|will|them|they|each|only|also)$/.test(w)).slice(0,120);
      const hits=[],misses=[];
      for(const w of words){let found=[];try{found=idx.find(w)||[];}catch{}if(found.length)hits.push(`${w} → ${found.slice(0,3).map(x=>x.path||x.name).join(", ")}${found.length>3?` (+${found.length-3})`:""}`);else misses.push(w);}
      return {hits,misses:misses.slice(0,40)};
    }
    function wireProjectPanel(modal,status){
      const drop=modal.querySelector("[data-project-drop]");if(!drop)return;
      const form=modal.querySelector("form");
      const pick=()=>{const input=document.createElement("input");input.type="file";input.accept=".rbxl,.rbxlx";input.onchange=()=>{const f=input.files&&input.files[0];if(f)scanProject(f);};input.click();};
      modal.querySelector("[data-project-browse]").onclick=e=>{e.stopPropagation();pick();};
      drop.onclick=e=>{if(!(e.target.closest&&e.target.closest("button")))pick();};
      drop.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();pick();}};
      drop.ondragover=e=>{e.preventDefault();drop.classList.add("over");};
      drop.ondragleave=()=>drop.classList.remove("over");
      drop.ondrop=e=>{e.preventDefault();drop.classList.remove("over");const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)scanProject(f);};
      modal.querySelector("[data-project-cancel]").onclick=()=>{try{ORProjectAnalyzer.cancel();}catch{}};
      modal.querySelector("[data-project-detach]").onclick=()=>{templateProjectRef=null;templateProjectFile=null;try{ORProjectAnalyzer.setActive(null);}catch{}renderProjectSummary(modal);if(status)status.textContent="Project reference detached.";};
      modal.querySelector("[data-project-template]").onclick=()=>{if(!templateProjectRef)return;templateFromProjectRef(templateProjectRef,form);if(status)status.textContent="Template fields filled from the project - review them, then Save.";modal.querySelector('[data-editor-tab="overview"]')?.click();};
      modal.querySelector("[data-project-compare]").onclick=()=>{if(!templateProjectRef)return;const r=compareWithProject(templateProjectRef,form);const sum=modal.querySelector("[data-project-summary]");if(sum)sum.innerHTML=projectSummaryHtml(templateProjectRef)+`<b>Compare with project</b><span>${r.hits.length} term(s) found in the project${r.hits.length?": "+escRs(r.hits.slice(0,12).join(" · ")):""}</span><span>${r.misses.length} term(s) not in the project${r.misses.length?": "+escRs(r.misses.join(", ")):""}</span>`;};
      modal.querySelector("[data-project-export]").onclick=()=>{if(!templateProjectRef)return;const blob=new Blob([JSON.stringify({kind:"orscript-project-reference",version:1,...templateProjectRef},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${String(templateProjectRef.fileName||"project").replace(/\.rbxlx?$/i,"")}.orscript-project-reference.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);if(status)status.textContent="Reference exported.";};
    }
    function openTemplateEditor(source=null,{draft=false,projectFile=null,projectReference=null}={}){closeTemplateEditor();try{if(bar){bar.style.visibility="hidden";bar.style.pointerEvents="none";}if(cardsPanel)cardsPanel.hidden=true;templateChromeHidden=true;}catch{}const t=source||{name:"",description:"",type:"workflow",category:"Custom",environment:"ROBLOX_STUDIO",tags:[],executionLevel:"WRITE",instructions:[],workflow:[],commands:[],variables:[],validation:{},expectedResult:"",notes:"",versions:[]};templateEditorId=draft?null:t.id||null;templateProjectRef=projectReference||t.projectReference||null;templateProjectFile=null;try{ORProjectAnalyzer.setActive(templateProjectRef&&templateProjectRef.analysis);}catch{}const modal=document.createElement("div");modal.className="rs-template-modal";modal.innerHTML=`<div class="rs-template-editor" role="dialog" aria-modal="true" aria-label="Template Editor"><header><div><b>${templateEditorId?"Edit Template":"Create a Template"}</b><span>${templateEditorId?`v${t.currentVersion||1}`:"Saved only when you choose Save — the agent will not start"}</span></div><div class="rs-template-head-actions"><button type="button" data-editor-advanced aria-pressed="false">Advanced</button><button type="button" data-editor-close>Close</button></div></header><form id="rs-template-form"><div class="rs-template-guide"><b>Three simple steps</b><span>1. Name it</span><span>2. Describe what it should do</span><span>3. Add instructions or steps, then save</span><small>Creating or editing a template never starts the agent. Use Run later when you are ready.</small></div><nav>${["Overview","Instructions","Workflow","Project","Commands","Variables","Validation","AI Improvement","Versions"].map((x,i)=>`<button type="button" class="${i?"":"on"} ${i>3?"rs-template-advanced":""}" data-editor-tab="${x.toLowerCase().replace(" ","-")}">${x==="Overview"?"1 · Basics":x==="Instructions"?"2 · Instructions":x==="Workflow"?"3 · Steps":x==="Project"?"4 · Project":x}</button>`).join("")}</nav><main>
<section data-editor-section="overview"><p class="rs-template-help"><b>Start here.</b> Give this reusable action a clear name and explain when you would use it.</p><label>Template name<input name="name" required value="${escRs(t.name)}" placeholder="Example: Build a shop UI"></label><label>What should this template do?<textarea name="description" rows="3" placeholder="Explain the result in plain language">${escRs(t.description)}</textarea></label><div class="rs-template-fields"><label>Type<select name="type">${templateTypes.map(x=>`<option ${t.type===x?"selected":""}>${x}</option>`).join("")}</select></label><label>Category<input name="category" value="${escRs(t.category)}" list="rs-template-categories"></label><label>Environment<select name="environment">${templateEnvs.map(x=>`<option ${t.environment===x?"selected":""}>${x}</option>`).join("")}</select></label><label>Execution Level<select name="executionLevel">${["READ","WRITE","PUBLISH"].map(x=>`<option ${t.executionLevel===x?"selected":""}>${x}</option>`).join("")}</select></label></div><label>Tags<input name="tags" value="${escRs((t.tags||[]).join(", "))}" placeholder="ui, inventory, reusable"></label><div class="rs-template-help rs-project-import-note"><b>Working from a real place?</b> The <em>Project</em> tab analyzes a .rbxl / .rbxlx locally (nothing is uploaded) and attaches a searchable reference the agent can query with project.find / project.findScripts.</div><label>Expected Result<textarea name="expectedResult" rows="3">${escRs(t.expectedResult||"")}</textarea></label><label>Notes<textarea name="notes" rows="2">${escRs(t.notes||"")}</textarea></label></section>
<section data-editor-section="project" hidden><p class="rs-template-help"><b>Project reference.</b> Analyze a Roblox place file on this PC. The template keeps a compact index (services, scripts, UI, remotes, detected systems) - never the whole file - and the agent retrieves it in bounded chunks through project.find / project.findScripts / project.getService.</p><div class="rs-project-reference"><b>Roblox project</b><div class="rs-project-drop" data-project-drop tabindex="0" role="button" aria-label="Drop a Roblox place file here or browse"><span>Drop a .rbxl / .rbxlx here</span><small>or</small><button type="button" data-project-browse>Browse File</button></div><div class="rs-project-controls" data-project-progress hidden><span data-project-stage>Analyzing…</span><button type="button" data-project-cancel>Cancel Analysis</button></div><div class="rs-project-result" data-project-summary>${templateProjectRef?"":"No project attached yet."}</div><div class="rs-project-controls" data-project-actions ${templateProjectRef?"":"hidden"}><button type="button" data-project-template>Create Template from Project</button><button type="button" data-project-compare>Compare with Project</button><button type="button" data-project-export>Export Reference</button><button type="button" data-project-detach>Detach</button></div></div></section>
<section data-editor-section="instructions" hidden><p class="rs-template-help">Write one clear instruction per line. These are saved, not run.</p><label>Instructions<textarea name="instructions" rows="12" placeholder="Create the interface hierarchy&#10;Add accessible labels&#10;Verify the result">${escRs((t.instructions||[]).join("\n"))}</textarea></label></section>
<section data-editor-section="workflow" hidden><p class="rs-template-help"><b>Optional structured steps.</b> Add these only when the template should use specific commands. Dragging is not required; steps run from top to bottom.</p><div data-workflow-rows>${(t.workflow||[]).map(workflowRowHtml).join("")}</div><input type="hidden" name="workflow"><button type="button" data-add-workflow>+ Add Step</button></section>
<section data-editor-section="commands" hidden><label>Commands<textarea name="commands" rows="12" placeholder="One existing command ID per line">${escRs((t.commands||[]).map(x=>x.command||x).join("\n"))}</textarea></label><p>Commands reference the shared OrScript registry. Implementations are never copied into templates.</p></section>
<section data-editor-section="variables" hidden><p>Reusable values are referenced as {{variableName}}.</p><div data-variable-rows>${(t.variables||[]).map(variableRowHtml).join("")}</div><input type="hidden" name="variables"><button type="button" data-add-variable>+ Add Variable</button></section>
<section data-editor-section="validation" hidden><label>Validation Rules<textarea name="validation" rows="12">${escRs(JSON.stringify(t.validation||{},null,2))}</textarea></label><button type="button" data-template-validate>Validate Template</button><pre data-validation-output></pre></section>
<section data-editor-section="ai-improvement" hidden><label>Improvement Mode<select name="improvementMode">${["Full AI Review","Improve Quality","Improve Reliability","Improve Efficiency","Improve Reusability","Improve Roblox Compatibility","Improve Blender Compatibility","Improve UI Quality","Improve Instructions"].map(x=>`<option>${x}</option>`).join("")}</select></label><div class="rs-template-inline"><button type="button" data-template-improve ${templateEditorId?"":"disabled"}>Improve with AI</button><button type="button" data-template-test ${templateEditorId?"":"disabled"}>Test Template</button></div><p>AI proposals are reviewed before a new version is created. Testing is labeled STATIC ANALYSIS unless commands really execute.</p></section>
<section data-editor-section="versions" hidden><div class="rs-template-versions">${(t.versions||[]).slice().reverse().map(v=>`<div><span>v${v.version} · ${escRs(v.createdAt||"")}</span><button type="button" data-restore-version="${v.version}">Restore</button></div>`).join("")||"No saved versions yet."}</div></section>
</main><footer><span data-editor-status></span><button type="button" data-editor-close>Cancel</button><button type="submit">${templateEditorId?"Save New Version":"Save Template"}</button></footer></form></div>`;root.appendChild(modal);templateEditorEl=modal;const form=modal.querySelector("form"),status=modal.querySelector("[data-editor-status]");const advancedBtn=modal.querySelector("[data-editor-advanced]");let advancedVisible=false;const paintAdvanced=()=>{modal.classList.toggle("show-advanced",advancedVisible);advancedBtn.setAttribute("aria-pressed",String(advancedVisible));advancedBtn.textContent=advancedVisible?"Simple view":"Advanced";};advancedBtn.onclick=()=>{advancedVisible=!advancedVisible;paintAdvanced();};paintAdvanced();modal.querySelectorAll("[data-editor-close]").forEach(x=>x.onclick=closeTemplateEditor);modal.querySelectorAll("[data-editor-tab]").forEach(btn=>btn.onclick=()=>{modal.querySelectorAll("[data-editor-tab]").forEach(x=>x.classList.toggle("on",x===btn));modal.querySelectorAll("[data-editor-section]").forEach(x=>x.hidden=x.dataset.editorSection!==btn.dataset.editorTab);});modal.querySelector("[data-add-workflow]").onclick=()=>modal.querySelector("[data-workflow-rows]").insertAdjacentHTML("beforeend",workflowRowHtml({},modal.querySelectorAll("[data-workflow-row]").length));modal.querySelector("[data-add-variable]").onclick=()=>modal.querySelector("[data-variable-rows]").insertAdjacentHTML("beforeend",variableRowHtml({}));wireProjectPanel(modal,status);if(projectFile)scanProject(projectFile);else if(templateProjectRef)renderProjectSummary(modal);modal.addEventListener("click",e=>{const remove=e.target.closest&&e.target.closest("[data-remove-row]");if(remove)remove.closest("[data-workflow-row],[data-variable-row]").remove();});form.onsubmit=async e=>{e.preventDefault();const saveBtn=form.querySelector('button[type="submit"]');if(saveBtn.disabled)return;saveBtn.disabled=true;saveBtn.textContent="Saving…";status.textContent="Saving to this browser…";try{await ORTemplateRegistry.initialize();const value=templateFromForm(form),audit=ORTemplateRegistry.validateTemplate(value,{registry:globalThis.ORCommandRegistry});if(!audit.success){status.textContent=audit.errors.map(x=>x.message).join(" · ");return;}const editingId=templateEditorId,r=editingId?await ORTemplateRegistry.updateTemplate(editingId,value):await ORTemplateRegistry.createTemplate(value);if(!r.success){status.textContent=`${r.error.code||"TEMPLATE_SAVE_FAILED"}: ${r.error.message}`;return;}const saved=ORTemplateRegistry.getTemplate(r.template.id);if(!saved){status.textContent="TEMPLATE_SAVE_FAILED: The saved template could not be verified.";return;}cardsQuery="";cardsCategory="All";closeTemplateEditor();renderCards(cardsPanel);toast(editingId?`Saved ${saved.name} v${saved.currentVersion}`:`Template saved: ${saved.name}`);}catch(err){status.textContent=`TEMPLATE_SAVE_FAILED: ${String(err.message||err)}`;}finally{if(saveBtn&&saveBtn.isConnected){saveBtn.disabled=false;saveBtn.textContent=templateEditorId?"Save New Version":"Save Template";}}};modal.querySelector("[data-template-validate]").onclick=()=>{try{const a=ORTemplateRegistry.validateTemplate(templateFromForm(form),{registry:globalThis.ORCommandRegistry});modal.querySelector("[data-validation-output]").textContent=JSON.stringify({valid:a.success,errors:a.errors,warnings:a.warnings},null,2);}catch(e){status.textContent=String(e.message||e);}};const improve=modal.querySelector("[data-template-improve]");if(improve)improve.onclick=()=>requestTemplateAI("improve",templateEditorId,form.elements.improvementMode.value);const test=modal.querySelector("[data-template-test]");if(test)test.onclick=()=>requestTemplateAI("test",templateEditorId);modal.querySelectorAll("[data-restore-version]").forEach(btn=>btn.onclick=async()=>{if(!confirm(`Restore v${btn.dataset.restoreVersion} as a new version?`))return;const r=await ORTemplateRegistry.restoreVersion(templateEditorId,+btn.dataset.restoreVersion);if(r.success){openTemplateEditor(r.template);renderCards(cardsPanel);}});if(projectFile){try{importRobloxProject(projectFile);}catch{}}}

    function requestTemplateAI(kind,id,mode="Full AI Review"){const t=ORTemplateRegistry.getTemplate(id);if(!t)return;const audit=ORTemplateRegistry.analyzeTemplate(t,{registry:globalThis.ORCommandRegistry});const aiTemplate=JSON.parse(JSON.stringify(t));let projectContext=null;if(aiTemplate.projectReference?.analysis&&globalThis.ORProjectAnalyzer){const c=ORProjectAnalyzer.context(aiTemplate.projectReference.analysis,aiTemplate.projectReference.mode||"Template Extraction",`${t.name} ${t.description}`);projectContext=c.success?c.context:{error:c.error};aiTemplate.projectReference={fileName:aiTemplate.projectReference.fileName,status:aiTemplate.projectReference.status,summary:aiTemplate.projectReference.analysis.summary,context:projectContext};}const tool=kind==="improve"?"template_propose_improvement":"template_test_result";const prompt=kind==="improve"?`Perform ${mode} on this user-owned OrScript template. Analyze structure, commands, variables, workflow ordering, validation, dependencies, ambiguity, safety, reliability, efficiency and reusability. Preserve intent. Return a complete improved object via ${tool}; originalId must be ${t.id}. Include only truthful summary items. Do not save or execute it.\n\nTemplate:\n${JSON.stringify(aiTemplate,null,2)}\n\nStatic audit:\n${JSON.stringify(audit,null,2)}`:`Perform STATIC ANALYSIS only on this template. Check dependencies, order, commands, ambiguity, validation and likely failures. Do not claim execution. Submit findings via ${tool}.\n\n${JSON.stringify(aiTemplate,null,2)}`;runLibraryCard({engine:"rs",icon:"T",cat:"Templates",title:kind==="improve"?"AI Template Review":"Template Static Test",desc:t.name,prompt},true);}
    function showTemplateProposal(original,improved,summary){
      const modal=document.createElement("div");modal.className="rs-template-modal";
      const initial=JSON.stringify(improved,null,2);
      modal.innerHTML=`<div class="rs-template-editor rs-template-diff" role="dialog" aria-modal="true" aria-label="Review AI template improvements"><header><div><b>AI Improvements</b><span>${escRs(original.name)} · proposed v${(original.currentVersion||1)+1}</span></div><button type="button" data-reject>Reject</button></header><div class="rs-ai-summary">${(summary||[]).map(x=>`<div>+ ${escRs(x)}</div>`).join("")||"No claimed improvements supplied."}</div><div class="rs-template-compare"><section><b>Original</b><pre>${escRs(JSON.stringify(original,null,2))}</pre></section><section><b>Improved</b><pre contenteditable="true" role="textbox" aria-label="Improved template JSON" spellcheck="false" data-improved-json>${escRs(initial)}</pre></section></div><footer><span data-proposal-status role="status"></span><button type="button" data-reject>Reject</button><button type="button" data-edit>Edit in Form</button><button type="button" data-apply>Accept & Apply v${(original.currentVersion||1)+1}</button></footer></div>`;
      root.appendChild(modal);
      const jsonEl=modal.querySelector("[data-improved-json]"),status=modal.querySelector("[data-proposal-status]"),apply=modal.querySelector("[data-apply]");
      const readProposal=()=>{try{const value=JSON.parse(jsonEl.textContent);const audit=ORTemplateRegistry.validateTemplate(value,{registry:globalThis.ORCommandRegistry});return {value,audit};}catch(e){return {value:null,audit:{success:false,errors:[{code:"INVALID_JSON",message:String(e.message||e)}],warnings:[]}};}};
      const validate=()=>{const {audit}=readProposal(),errors=audit.errors||[],warnings=audit.warnings||[];apply.disabled=!audit.success;status.classList.toggle("rs-template-error",!audit.success);status.textContent=audit.success?`Ready to apply · ${warnings.length} warning${warnings.length===1?"":"s"}`:errors.map(x=>`${x.code}: ${x.message}`).join(" · ");return audit.success;};
      jsonEl.addEventListener("input",validate);validate();
      modal.querySelectorAll("[data-reject]").forEach(x=>x.onclick=()=>modal.remove());
      modal.querySelector("[data-edit]").onclick=()=>{const {value}=readProposal();modal.remove();openTemplateEditor(value||improved,{draft:false});templateEditorId=original.id;};
      apply.onclick=async()=>{if(apply.disabled)return;const {value,audit}=readProposal();if(!audit.success){validate();return;}apply.disabled=true;status.textContent="Applying and verifying…";try{await ORTemplateRegistry.initialize();const r=await ORTemplateRegistry.updateTemplate(original.id,audit.template||value);if(!r.success)throw Error(`${r.error?.code||"TEMPLATE_UPDATE_FAILED"}: ${r.error?.message||"Template could not be updated"}`);const saved=ORTemplateRegistry.getTemplate(original.id);if(!saved||saved.currentVersion!==r.template.currentVersion)throw Error("TEMPLATE_SAVE_UNVERIFIED: Applied version could not be read back");modal.remove();closeTemplateEditor();cardsQuery="";cardsCategory="All";renderCards(cardsPanel);toast(`Accepted and applied v${saved.currentVersion}`);}catch(e){apply.disabled=false;status.classList.add("rs-template-error");status.textContent=String(e&&e.message||e);}};
    }

    window.addEventListener("or-templates-synced",()=>{try{if(cardsPanel&&!cardsPanel.hidden)renderCards(cardsPanel);}catch{}});
    window.addEventListener("or-template-ai-result",e=>{const d=e.detail||{};if(d.kind==="template_create_draft")openTemplateEditor(d.template,{draft:true});else if(d.kind==="template_propose_improvement"){const original=ORTemplateRegistry.getTemplate(d.originalId);if(original)showTemplateProposal(original,d.improved,d.summary);}else if(d.kind==="template_test_result"){const t=ORTemplateRegistry.getTemplate(d.templateId);if(t)alert(`STATIC ANALYSIS — ${t.name}\n\n${d.summary||""}\n\n${JSON.stringify(d.findings||[],null,2)}`);}});
    async function runTemplateCard(card){const t=ORTemplateRegistry.getTemplate(card.templateId);if(!t)return toast("TEMPLATE_NOT_FOUND");const vars={};for(const spec of t.variables||[]){const value=prompt(`${spec.name}${spec.required?" (required)":""}`,spec.default??"");if(value===null)return;vars[spec.name]=spec.type==="number"?Number(value):spec.type==="boolean"?/^(true|1|yes)$/i.test(value):value;}const resolved=ORTemplateRegistry.resolve(t.id,vars,t.environment,{registry:globalThis.ORCommandRegistry});if(!resolved.success)return toast(`${resolved.error.code}: ${resolved.error.message}`);if(resolved.requiresConfirmation&&!await requestApproval(`Run template: ${t.name}`,{executionLevel:t.executionLevel,steps:resolved.plan.length},true))return;if(!resolved.plan.some(x=>x.command)){runLibraryCard({...card,prompt:`Execute this reviewed prompt template. Do not claim any operation without tool verification.\n\n${resolved.instructions.join("\n")}`},true);return;}const results=[];for(const step of resolved.plan){if(!step.command)continue;const output=await runTool({tool:step.command,arguments:step.parameters||{}});const text=String(output),rules=step.validation||{};let failed=text.startsWith("ERROR");if(rules.outputIncludes&&!text.includes(String(rules.outputIncludes)))failed=true;if(rules.outputExcludes&&text.includes(String(rules.outputExcludes)))failed=true;results.push({step:step.id,command:step.command,success:!failed,output:text.slice(0,2000),validation:Object.keys(rules).length?rules:undefined});if(failed&&(step.errorBehavior||"STOP")==="STOP")break;}const success=results.every(x=>x.success);recentCards.unshift({tool:`Template: ${t.name}`,detail:`${success?"Completed":"Failed"} · ${results.filter(x=>x.success).length}/${results.length} commands verified`,status:success?"ok":"err",category:"tool",at:Date.now()});renderCards(cardsPanel);toast(success?"Template completed":"Template stopped on a failed command");}
    function templateCards(){if(!globalThis.ORTemplateRegistry)return [];const opts=cardsCategory==="Archived"?{archived:true}:cardsCategory!=="All"?{category:cardsCategory}:{};return ORTemplateRegistry.searchTemplates(cardsQuery,opts).map(t=>({templateId:t.id,engine:"rs",icon:"T",cat:t.category,title:t.name,desc:t.description,environment:t.environment,version:t.currentVersion,commands:t.commands.map(x=>x.command),updatedAt:t.updatedAt,type:t.type,executionLevel:t.executionLevel,projectReference:t.projectReference,prompt:(t.instructions||[]).join("\n")}));}
    function libFiltered(){return templateCards();}
    function templateEnvironmentLabel(value){return ({ROBLOX_STUDIO:"Roblox Studio",BLENDER:"Blender",WEB:"Web",GENERAL:"General"})[value]||String(value||"General").replace(/_/g," ").replace(/\b\w/g,x=>x.toUpperCase());}
    let ideaGeneratorResult="";
    const IDEA_GENRES=['Tycoon','Platformer','Simulator','Adventure','Obby','Roleplay','RPG','Horror','Survival','Tower Defense','Tower Climb','Racing','Fighting','Arena','Shooter','Puzzle','Strategy','City Builder','Business','Farming','Fishing','Mining','Cooking','Trading','Card Battler','Dungeon Crawler','Metroidvania','Stealth','Rhythm','Parkour','Battle Royale','Party Game','Social Hangout','Pet Collector','Creature Tamer','Factory','Sailing','Flight','Train','Sports','Golf','Kart Racing','Open World','Questing','Life Sim','School Sim','Detective','Heist','Western','Pirate','Multiplayer Co-op','Incremental','Clicker','Defense','Extraction','Roguelike','Action Adventure','Trivia','Word Game','Board Game','Sandbox','Survival Crafting','Trend Remix'], IDEA_THEMES=['Futuristic','Old school','Fantasy','Space','Horror','Trending','Cyberpunk','Steampunk','Underwater','Jungle','Desert','Arctic','Volcanic','Medieval','Ancient Egypt','Mythology','Neon City','Cozy Cottage','Candy','Food','Toy Box','Miniature','Giant World','Sky Islands','Time Travel','Post Apocalyptic','Solarpunk','Dark Academia','Haunted Carnival','Noir Detective','Pirate Bay','Wild West','Samurai','Ninja','Superhero','Villain Lair','Robot Factory','Alien Planet','Dinosaur Age','Fairy Tale','Dream World','Nightmare','Gothic','Mystical Forest','Crystal Caves','Lunar Colony','Mars Base','Ocean Trench','Floating City','Clockwork','Digital Glitch','Arcade','Vaporwave','Low Poly','Paper Craft','Pixel Art','Black and White','Anime','Comic Book','Cartoon','Ethereal','Bioluminescent','Storm Chaser','Festival','Royal Palace','Secret Laboratory','Trend Remix'];
    function ideaOptions(values,selected){return values.map(x=>`<option ${x===selected?"selected":""}>${escRs(x)}</option>`).join("");}
    function ideaGeneratorHtml(){return `<section class="rs-idea-generator" aria-label="Idea Generator"><div class="rs-idea-controls"><label>Genre<select data-idea-genre>${ideaOptions(IDEA_GENRES,"Platformer")}</select></label><label>Theme<select data-idea-theme>${ideaOptions(IDEA_THEMES,"Futuristic")}</select></label><button type="button" data-idea-generate>Generate idea</button></div>${ideaGeneratorResult?`<div class="rs-idea-result"><h3>${escRs(ideaGeneratorResult.title)}</h3><pre>${escRs(ideaGeneratorResult.prompt)}</pre><div><button type="button" data-idea-generate-another>Generate another</button><button type="button" data-idea-run>Run</button><button type="button" data-idea-copy>Copy prompt</button><button type="button" data-idea-chat>Put in chat box</button></div></div>`:'<div class="rs-idea-empty">Choose from 60+ genres and 60+ themes, then generate an idea.</div>'}</section>`;}
    function makeIdea(genre,theme){const hooks=["a living world that reacts to every player choice","a risk-and-reward upgrade system","a mysterious secret revealed through exploration","friendly competition with surprising alliances","a satisfying collection and discovery loop","a world that changes every in-game day"];const loops=["explore, collect, upgrade, and unlock a new region","complete challenges, earn resources, customize your base, and take on a boss","discover shortcuts, master movement, rescue characters, and open the final area","build momentum through short runs, permanent upgrades, and escalating goals"];const title=`${theme} ${genre}`,hook=hooks[Math.floor(Math.random()*hooks.length)],loop=loops[Math.floor(Math.random()*loops.length)];return {title,prompt:`Build "${title}" — a ${genre} game in Roblox Studio with a ${theme} presentation.

PITCH: Create ${hook}.
CORE LOOP: ${loop}.
PROGRESSION: Add meaningful upgrades, three distinct areas, clear rewards, and a memorable final challenge.
PLAYER EXPERIENCE: Make the first five minutes easy to understand, responsive, replayable, and fun with friends.
STYLE: Use cohesive ${theme} visuals, readable feedback, polished UI, sound cues, and satisfying effects.
SCOPE: Deliver a complete playable vertical slice before expanding.
SAFETY: Inspect the existing place first, use verified tools, and do not claim work until each change is confirmed.`};}
    function gridHtml(){if(!visibleLibCache.length)return '<div class="rs-template-empty"><div class="rs-template-empty-mark">T</div><b>No templates yet. Create your first template</b><span>Save a repeatable workflow, or start with an AI draft and review it before saving.</span><div><button type="button" class="rs-btn-primary rs-btn-create" data-template-add>Create template</button><button type="button" class="rs-btn-secondary rs-btn-ai" data-template-ai-create>Create with AI</button></div></div>';return '<div class="rs-template-list">'+visibleLibCache.slice(0,200).map((c,i)=>`<article class="rs-template-row" data-prompt-index="${i}"><div class="rs-template-copy"><b>${escRs(c.title||"Untitled template")}</b><p>${escRs(c.desc||"No description provided")}</p><span>${escRs(c.cat||"Uncategorized")} · ${escRs(templateEnvironmentLabel(c.environment))} · Version ${c.version} · Updated ${escRs(new Date(c.updatedAt).toLocaleDateString())}${c.projectReference?" · Project attached · AI analysis: "+escRs(c.projectReference.status):""}</span></div><div class="rs-template-actions"><button type="button" data-template-action="open">Edit</button><button type="button" class="rs-template-run" data-template-action="run">Run template</button><button type="button" class="rs-template-improve" data-template-action="improve">Improve with AI</button><details class="rs-template-more"><summary>Actions</summary><div><button type="button" data-template-action="duplicate">Copy</button><button type="button" data-template-action="export">Export</button><button type="button" data-template-action="archive">${cardsCategory==="Archived"?"Restore":"Archive"}</button><button type="button" class="rs-template-delete" data-template-action="delete">Delete</button></div></details></div></article>`).join("")+'</div>';}

    function libraryHtml(){
      visibleLibCache=libFiltered();const count=visibleLibCache.length;
      return `<section class="rs-template-library" aria-label="Template library">${ideaGeneratorHtml()}<div class="rs-template-controls"><header class="rs-template-head"><div class="rs-template-head-copy"><div><b>Your templates</b><span class="rs-template-count" data-template-count>${count}</span></div><p>Create, review, and run reusable workflows.</p></div><div class="rs-template-head-actions"><button type="button" class="rs-btn-primary rs-btn-create" data-template-add>Create template</button><button type="button" class="rs-btn-secondary rs-btn-ai" data-template-ai-create>Create with AI</button></div></header><div class="rs-template-toolbar"><label class="rs-template-search"><span class="rs-sr-only">Search templates</span><input id="rs-cards-search" type="search" placeholder="Search your templates" value="${escRs(cardsQuery)}" spellcheck="false"></label><label class="rs-template-filter"><span class="rs-sr-only">Filter templates by category</span><select id="rs-template-category"><option value="All">All categories</option>${ORTemplateRegistry.categories().map(x=>`<option ${cardsCategory===x?"selected":""}>${escRs(x)}</option>`).join("")}<option ${cardsCategory==='Archived'?"selected":""}>Archived</option></select></label><button type="button" class="rs-template-project-import" title="Analyze a .rbxl / .rbxlx locally (or load an exported reference) and review it as a Template draft" data-project-import>Roblox project</button><button type="button" class="rs-template-export-all" data-template-export-all>Export all</button><span class="rs-sr-only">Template file</span><button type="button" class="rs-template-import" data-template-import>Import template</button></div></div><div id="rs-cards-grid-wrap">${gridHtml()}</div></section>`;
    }

    // ── Public Skills tab (user-made skills / abilities / work modes) ──
    function publicCount(){ try { return typeof PublicSkills !== "undefined" ? PublicSkills.list().length : 0; } catch { return 0; } }
    function publicExampleArgs(item){ const ex = {}; for (const p of item.params || []) ex[p.name] = p.default !== undefined ? p.default : p.enum && p.enum[0] ? p.enum[0] : p.type === "number" ? 1 : p.type === "boolean" ? true : p.type === "array" ? ["a"] : p.type === "object" ? {} : p.name; return ex; }
    function publicReserved(){ try { return typeof window.__rsBuiltinToolNames === "function" ? window.__rsBuiltinToolNames() : new Set(); } catch { return new Set(); } }
    function publicCommandSample(){ try { return [...publicReserved()].filter((n) => /^[a-z][a-z0-9_]+$/.test(n)).slice(0, 80); } catch { return []; } }
    const PUBLIC_SKELETONS = {
      skill: { kind: "skill", name: "my_skill", title: "My Skill", description: "What it does and when to use it (10-600 chars).", params: [{ name: "path", type: "string", description: "Full instance path, e.g. Workspace.Model", required: true }, { name: "count", type: "number", description: "How many", default: 3 }], luau: "-- {{path}} and {{count}} are replaced with Lua literals; also available as args.path / args.count\nlocal target = game\nfor seg in string.gmatch({{path}}, '[^.]+') do\n  target = target:FindFirstChild(seg)\n  if not target then return {ok = false, error = 'path not found: ' .. {{path}}} end\nend\nlocal made = 0\nfor i = 1, {{count}} do\n  local part = Instance.new('Part')\n  part.Name = 'MySkillPart_' .. i\n  part.Anchored = true\n  part.Position = target:IsA('BasePart') and target.Position + Vector3.new(i * 5, 0, 0) or Vector3.new(i * 5, 5, 0)\n  part.Parent = target\n  made += 1\nend\nreturn {ok = true, created = made, parent = target:GetFullName()}" },
      ability: { kind: "ability", name: "my_ability", title: "My Ability", description: "A reusable procedure the agent follows with real commands.", params: [{ name: "target", type: "string", description: "What to work on", required: true }], instructions: "Audit {{target}} and fix what you find. Work step by step and verify each change.", steps: ["Locate {{target}} with instance_find", "Inspect it with inspect_instance / script_read", "Apply the fix with the right write command", "Verify the result and report"], commands: ["instance_find", "inspect_instance", "script_read", "script_set_source"] },
      mode: { kind: "mode", name: "my_mode", title: "My Mode", badge: "MYMODE", base: "ultimate", sub: "One-line tagline shown on the mode card", note: "Short blurb shown in the menu", description: "When to use this mode and what it optimises for.", mandate: "You are now a specialist in ... Priorities: 1) ... 2) ... 3) ... Pipeline: plan, build, verify with screenshots/console. Quality bar: ... Never: ...", focus: ["instance_find", "part_create", "script_create"] },
    };
    function publicHtml(){
      const PS = typeof PublicSkills !== "undefined" ? PublicSkills : null;
      const items = PS ? PS.list() : [];
      const active = PS ? PS.activeMode() : null;
      const kindLabel = { skill: "skill", ability: "ability", mode: "work mode" };
      const rows = items.map((i) => {
        const isMode = i.kind === "mode";
        const sig = isMode ? `base: ${escRs(i.base)} · badge ${escRs(i.badge)}` : escRs(PS.signature(i));
        const isActive = !!(active && active.id === i.id);
        return `<article class="rs-template-row rs-public-row${i.enabled ? "" : " rs-public-off"}" data-public-id="${escRs(i.id)}"><div class="rs-template-copy"><b>${escRs(i.title)} <span class="rs-public-kind rs-public-kind-${i.kind}">${kindLabel[i.kind]}</span>${isActive ? '<span class="rs-public-active">ACTIVE</span>' : ""}${i.enabled ? "" : '<span class="rs-public-disabled">disabled</span>'}</b><p>${escRs(i.description)}</p><span><code>${sig}</code> · v${i.version} · by ${escRs(i.author)} · ${i.source === "ai" ? "built by AI" : i.source === "import" ? "imported" : "hand-made"}</span></div><div class="rs-template-actions">${isMode ? `<button type="button" class="rs-template-run" data-public-action="activate">${isActive ? "Deactivate" : "Activate"}</button>` : `<button type="button" class="rs-template-run" data-public-action="run">Run…</button>`}<button type="button" class="rs-template-improve" data-public-action="improve">Improve with AI</button><details class="rs-template-more"><summary>Actions</summary><div><button type="button" data-public-action="edit">Edit JSON</button><button type="button" data-public-action="toggle">${i.enabled ? "Disable" : "Enable"}</button><button type="button" data-public-action="export">Export .json</button><button type="button" data-public-action="export-text">Export .txt</button><button type="button" data-public-action="share">Copy share code</button><button type="button" class="rs-template-delete" data-public-action="delete">Delete</button></div></details></div></article>`;
      }).join("");
      const empty = `<div class="rs-template-empty"><div class="rs-template-empty-mark">P</div><b>No public skills yet</b><span>Describe one above, paste a full prompt, or drop a .txt / .json file here — OrScript turns it into a real command.</span></div>`;
      const isPrompt = !!(PS && PS.looksLikeFullPrompt(publicDraft));
      const how = (publicHow || "auto") === "auto" ? (isPrompt ? "convert" : "design") : publicHow;
      const createLabel = how === "convert" ? "Turn prompt into a skill (AI)" : "Create with AI";
      const hint = !publicDraft.trim() ? "" : how === "convert"
        ? `<div class="rs-public-hint rs-public-hint-convert">Looks like a full prompt → the AI will convert it faithfully (nothing dropped, nothing invented).${publicHow === "auto" ? ' <button type="button" data-public-how="design">Design a new one from it instead</button>' : ' <button type="button" data-public-how="auto">Auto</button>'}</div>`
        : `<div class="rs-public-hint">Short description → the AI designs the ${publicKind === "auto" ? "skill / ability / mode" : publicKind} for you.${publicHow === "auto" ? ' <button type="button" data-public-how="convert">Treat it as a full prompt instead</button>' : ' <button type="button" data-public-how="auto">Auto</button>'}</div>`;
      const examples = [["skill", "A skill that places N street lamps with warm PointLights along the selected path"], ["ability", "An ability that audits every script for deprecated APIs and fixes them"], ["mode", "A 'Horror builder' work mode focused on fog, flickering lights and sound"]];
      return `<section class="rs-template-library rs-public" aria-label="Public skills"><div class="rs-template-controls"><header class="rs-template-head"><div class="rs-template-head-copy"><div><b>Public Skills</b><span class="rs-template-count">${items.length}</span></div><p>Your own commands, procedures and work modes — no coding needed.</p></div><div class="rs-template-head-actions"><button type="button" class="rs-btn-secondary" data-public-manual>New by hand</button></div></header><ol class="rs-public-ways"><li><b>Describe it</b><span>one sentence → the AI designs and installs it</span></li><li><b>Paste a full prompt</b><span>or drop a .txt → it becomes a skill as-is</span></li><li><b>Import</b><span>a .txt / .json file or share code from a friend</span></li></ol><div class="rs-public-sharebox"><b>Share</b><span>Give friends a .txt / .json file or a code; they press Import. Nothing is uploaded — files and codes are the only channel.</span><div class="rs-public-share-actions"><button type="button" data-public-import>Import file / code…</button><button type="button" data-public-paste>Paste share code</button><button type="button" data-public-export-all ${items.length ? "" : "disabled"}>Export all (${items.length})</button><button type="button" data-public-share-all ${items.length ? "" : "disabled"}>Copy share code for all</button></div></div><div class="rs-public-compose" data-public-drop><div class="rs-public-examples">Try: ${examples.map(([k, t]) => `<button type="button" data-public-example="${escRs(t)}" class="rs-public-kind rs-public-kind-${k}">${k}</button>`).join("")}</div><textarea id="rs-public-prompt" rows="${isPrompt ? 7 : 3}" spellcheck="false" placeholder="Describe what you want in a sentence — or paste a whole prompt you already wrote (any length). You can also drop a .txt file here.">${escRs(publicDraft)}</textarea>${hint}<div class="rs-public-compose-row"><select id="rs-public-kind" aria-label="Kind"><option value="auto"${publicKind === "auto" ? " selected" : ""}>Auto — AI decides</option><option value="skill"${publicKind === "skill" ? " selected" : ""}>Skill — Luau command with params</option><option value="ability"${publicKind === "ability" ? " selected" : ""}>Ability — reusable procedure</option><option value="mode"${publicKind === "mode" ? " selected" : ""}>Work mode — mandate + focus</option></select><button type="button" class="rs-btn-primary rs-btn-ai" data-public-create>${createLabel}</button></div><div class="rs-public-compose-row rs-public-compose-alt"><button type="button" data-public-load-text>Load .txt / .json…</button><button type="button" data-public-save-text ${publicDraft.trim().length >= 20 ? "" : "disabled"} title="Install the text above right now, without AI: kept word-for-word as an ability (or a work mode / skill if you picked that kind)">Save as-is (no AI)</button><span class="rs-public-drop-note">or drop a file on this box</span></div><small>Installed on this device only (chrome.storage). Share with Export / Share code; others press Import. Skills run only when called — nothing touches your place until then.</small></div></div><div class="rs-template-list rs-public-list">${rows || empty}</div></section>`;
    }
    var publicDraft = "", publicKind = "auto";
    var publicHow = "auto"; // "auto" | "design" | "convert" - how the Create button treats the text
    // One entry point for the Create button: a short description is DESIGNED
    // by the AI; a full prompt (long / multi-line, or the user said so) is
    // CONVERTED faithfully into a skill, ability or mode.
    function publicGenerationPrompt(text, kind){
      const how = publicHow === "auto" ? (PublicSkills.looksLikeFullPrompt(text) ? "convert" : "design") : publicHow;
      if (how === "convert") return PublicSkills.conversionPrompt(text, kind, { commandNames: publicCommandSample() });
      return PublicSkills.generationPrompt(text, kind, { commandNames: publicCommandSample() });
    }
    function publicIsConvert(text){ return publicHow === "convert" || (publicHow === "auto" && PublicSkills.looksLikeFullPrompt(text)); }
    // No-AI path: keep the pasted prompt word-for-word as an ability (or the chosen kind).
    function publicSaveAsIs(text){
      const r = PublicSkills.installFromPrompt(text, { kind: publicKind === "auto" ? undefined : publicKind, reserved: publicReserved(), source: "manual" });
      if (!r.ok) { toast(`Could not save: ${r.errors.join("; ")}`); return false; }
      publicDraft = ""; publicHow = "auto";
      try { window.dispatchEvent(new CustomEvent("or-public-skill-result", { detail: { kind: "created", item: r.item, warnings: r.warnings || [] } })); } catch {}
      toast(`Saved ${r.item.kind} '${r.item.name}' from your prompt${r.warnings && r.warnings.length ? " (" + r.warnings.length + " note" + (r.warnings.length === 1 ? "" : "s") + ")" : ""} — use Improve with AI any time`);
      return true;
    }
    // A file (picked or dropped) or pasted text: structured → install; prose → load into the composer.
    function publicLoadText(text, fileName){
      text = String(text || "").replace(/^\uFEFF/, "");
      if (!text.trim()) return toast("That file is empty");
      const probe = PublicSkills.parseShared(text);
      if (probe.ok) return publicImportText(text, fileName);
      publicDraft = text.trim(); publicHow = "convert";
      if (!publicDraft.length) return;
      renderCards(cardsPanel);
      try { const ta = cardsPanel.querySelector("#rs-public-prompt"); if (ta) { ta.focus(); ta.scrollTop = 0; } } catch {}
      toast(`Loaded the prompt${fileName ? " from " + fileName : ""} — press “Turn prompt into a skill (AI)” or “Save as-is (no AI)”`);
    }
    function publicReadFile(file){ return new Promise((resolve, reject) => { try { if (file && typeof file.text === "function") return resolve(file.text()); const fr = new FileReader(); fr.onload = () => resolve(String(fr.result || "")); fr.onerror = () => reject(fr.error || new Error("read failed")); fr.readAsText(file); } catch (e) { reject(e); } }); }
    function publicPickFile(){ const input = document.createElement("input"); input.type = "file"; input.accept = ".json,.orskill.json,.orskills.json,.txt,.md,text/plain,application/json"; input.onchange = async () => { const file = input.files && input.files[0]; if (!file) return; publicLoadText(await publicReadFile(file), file.name); }; input.click(); }
    function publicDownloadText(id){ const PS = PublicSkills; const txt = PS.exportText(id); if (!txt) return toast("Nothing to export"); const blob = new Blob([txt], { type: "text/plain" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = PS.textFileName(id); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast(`Exported ${PS.textFileName(id)} — a plain .txt anyone can read or edit`); }
    function publicDownload(id){ const PS = PublicSkills; const json = PS.exportJson(id); if (!json) return toast("Nothing to export"); const blob = new Blob([json], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = PS.fileName(id); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast(`Exported ${PS.fileName(id)}`); }
    async function publicCopyShare(id){ const code = PublicSkills.shareCode(id); if (!code) return toast("Nothing to share"); try { await navigator.clipboard.writeText(code); toast(`Share code copied (${code.length} chars) — paste it into another OrScript's Public tab`); } catch { prompt("Copy this share code:", code); } }
    function publicImportText(text, fileName){ if (!text) return; const r = PublicSkills.importShared(text, { reserved: publicReserved() });
      if (!r.ok && r.prompt) { publicDraft = String(r.text || text).trim(); publicHow = "convert"; renderCards(cardsPanel); try { const ta = cardsPanel.querySelector("#rs-public-prompt"); if (ta) ta.focus(); } catch {} toast(`${fileName ? fileName + " is" : "That is"} a prompt, not a skill file — loaded it into the box: press “Turn prompt into a skill (AI)” or “Save as-is (no AI)”`); return; }
      if (r.pack) { let msg = r.installed.length ? `Installed ${r.installed.length} item${r.installed.length === 1 ? "" : "s"}: ${r.installed.map((i) => i.name).join(", ")}` : "Nothing new installed"; if (r.skipped.length) msg += ` · already had: ${r.skipped.join(", ")}`; if (r.errors.length) msg += ` · failed: ${r.errors.length}`; toast(msg); if (r.skipped.length && confirm(`${r.skipped.length} item(s) already exist (${r.skipped.join(", ")}). Replace them with the imported versions?`)) { const r2 = PublicSkills.importShared(text, { reserved: publicReserved(), replace: true }); toast(r2.ok ? `Replaced/installed ${r2.installed.length} item(s)` : "Replace failed"); } return; }
      if (!r.ok && r.duplicate) { if (confirm(`'${r.duplicate.name}' is already installed. Replace it with the imported version?`)) { const r2 = PublicSkills.importShared(text, { reserved: publicReserved(), replace: true }); toast(r2.ok ? `Replaced ${r2.item.kind} '${r2.item.name}'` : `IMPORT_FAILED: ${r2.errors.join("; ")}`); } return; } toast(r.ok ? `Installed ${r.item.kind} '${r.item.name}'${r.warnings.length ? " (" + r.warnings.length + " warning" + (r.warnings.length === 1 ? "" : "s") + ")" : ""}` : `IMPORT_FAILED: ${r.errors.join("; ")}`); }
    function publicRun(item){ if (item.kind === "mode") return setWorkMode("pm:" + item.id); let args = {}; if ((item.params || []).length) { const raw = prompt(`Arguments for ${PublicSkills.signature(item)} (JSON):`, JSON.stringify(publicExampleArgs(item))); if (raw == null) return; try { args = JSON.parse(raw || "{}"); } catch { return toast("Arguments must be valid JSON"); } } runLibraryCard({ engine: "rs", icon: "P", cat: "Public Skills", title: `Run ${item.name}`, desc: item.description.slice(0, 90), prompt: `Run my public ${item.kind} now: call ${item.name} ${JSON.stringify(args)} and report the result. If it reports an error, fix the arguments or improve the ${item.kind} with public_skill_update (read it first with public_skill_get {"name":"${item.name}"}).` }, true); }
    function publicImprove(item){ const req = prompt(`What should change in '${item.title}'?`, ""); if (req == null) return; runLibraryCard({ engine: "rs", icon: "P", cat: "Public Skills", title: `Improve ${item.name}`, desc: req.slice(0, 90) || "AI review", prompt: `Improve my public ${item.kind} '${item.name}'. Request: ${req.trim() || "review it for correctness, robustness and clarity and improve it"}. First call public_skill_get {"name":"${item.name}"} to read the current definition, then submit the improved version with public_skill_update {"name":"${item.name}","patch":{...}} (keep the same name and kind; include every field you change in full)${item.kind === "skill" ? ", then run public_skill_test {\"name\":\"" + item.name + "\"} and fix any syntax error" : ""}. Finish with a one-paragraph summary of what changed.` }, true); }
    function openPublicEditor(item, kind){
      const PS = PublicSkills; closePublicEditor();
      const def = item ? (() => { const d = JSON.parse(JSON.stringify(item)); delete d.createdAt; delete d.updatedAt; delete d.source; return d; })() : JSON.parse(JSON.stringify(PUBLIC_SKELETONS[kind] || PUBLIC_SKELETONS.skill));
      const modal = document.createElement("div"); modal.className = "rs-template-modal rs-public-modal";
      modal.innerHTML = `<div class="rs-template-editor rs-public-editor" role="dialog" aria-modal="true" aria-label="Public skill editor"><header><div><b>${item ? "Edit " + escRs(item.title) : "New public " + escRs(kind || "skill") + " (by hand)"}</b><span>${item ? escRs(item.kind) + " · v" + item.version + " · id " + escRs(item.id) : "Fill the JSON and press Install. Params become {{placeholders}} in Luau."}</span></div><div class="rs-template-head-actions"><button type="button" data-public-editor-doc>Field guide</button><button type="button" data-public-editor-close>Close</button></div></header><textarea class="rs-public-json" spellcheck="false">${escRs(JSON.stringify(def, null, 2))}</textarea><pre class="rs-public-doc" hidden>${escRs(PS.DEFINITION_DOC)}</pre><footer><span data-public-editor-status></span><button type="button" data-public-editor-validate>Validate</button><button type="button" data-apply data-public-editor-save>${item ? "Save" : "Install"}</button></footer></div>`;
      document.body.appendChild(modal); publicEditorEl = modal;
      const ta = modal.querySelector(".rs-public-json"), status = modal.querySelector("[data-public-editor-status]"), doc = modal.querySelector(".rs-public-doc");
      const parse = () => { try { return { def: JSON.parse(ta.value) }; } catch (e) { return { err: "JSON: " + String(e.message || e) }; } };
      modal.querySelector("[data-public-editor-close]").onclick = closePublicEditor;
      modal.addEventListener("click", (e) => { if (e.target === modal) closePublicEditor(); });
      modal.querySelector("[data-public-editor-doc]").onclick = () => { doc.hidden = !doc.hidden; };
      modal.querySelector("[data-public-editor-validate]").onclick = () => { const p = parse(); if (p.err) { status.textContent = p.err; return; } const v = PS.validate(Object.assign({}, p.def, item ? { id: item.id } : {}), { reserved: publicReserved() }); status.textContent = v.ok ? `OK${v.warnings.length ? " — warnings: " + v.warnings.join("; ") : ""}` : v.errors.join("; "); status.style.color = v.ok ? "#9ed8b6" : ""; };
      modal.querySelector("[data-public-editor-save]").onclick = () => { const p = parse(); if (p.err) { status.textContent = p.err; return; } const r = PS.upsert(Object.assign({}, p.def, item ? { id: item.id, kind: item.kind } : {}), { reserved: publicReserved(), source: item ? item.source : "manual" }); if (!r.ok) { status.textContent = r.errors.join("; "); status.style.color = ""; return; } toast(`${item ? "Saved" : "Installed"} ${r.item.kind} '${r.item.name}'${r.warnings.length ? " — " + r.warnings.length + " warning(s)" : ""}`); closePublicEditor(); };
      setTimeout(() => { try { ta.focus(); } catch {} }, 0);
    }
    var publicEditorEl = null, openCardsPanel = null;
    function closePublicEditor(){ try { if (publicEditorEl) publicEditorEl.remove(); } catch {} publicEditorEl = null; }
    function showPublicInstalled(detail){
      const item = detail && detail.item; if (!item) return;
      closePublicEditor();
      const warnings = Array.isArray(detail.warnings) ? detail.warnings : [];
      const verb = detail.kind === "updated" ? "updated" : detail.kind === "imported" ? "imported" : "installed";
      const modal = document.createElement("div"); modal.className = "rs-template-modal rs-public-modal";
      const usage = item.kind === "mode" ? `Pick it in the OR menu → Work mode, or press Activate below.` : `Call it as <code>${escRs(PublicSkills.signature(item))}</code> — or press Try it.`;
      modal.innerHTML = `<div class="rs-template-editor rs-public-editor rs-public-installed" role="dialog" aria-modal="true" aria-label="Public skill installed"><header><div><b>Public ${escRs(item.kind)} ${verb}: ${escRs(item.title)}</b><span>v${item.version} · by ${escRs(item.author)} · stored on this device</span></div><div class="rs-template-head-actions"><button type="button" data-public-editor-close>Close</button></div></header><div class="rs-public-installed-body"><p>${escRs(item.description)}</p><p class="rs-public-usage">${usage}</p>${(item.params || []).length ? `<p><b>Params:</b> ${item.params.map((p) => `<code>${escRs(p.name)}${p.required ? "" : "?"}</code> <small>${escRs(p.type)}${p.description ? " — " + escRs(p.description) : ""}</small>`).join("<br>")}</p>` : ""}${warnings.length ? `<p class="rs-public-warn"><b>Warnings:</b><br>${warnings.map(escRs).join("<br>")}</p>` : ""}<p class="rs-public-share">Share it: Public tab → Export file / Copy share code.</p></div><footer><span></span>${item.kind === "mode" ? `<button type="button" data-apply data-public-installed-activate>Activate mode</button>` : `<button type="button" data-apply data-public-installed-try>Try it</button>`}<button type="button" data-public-installed-open>Open Public tab</button></footer></div>`;
      document.body.appendChild(modal); publicEditorEl = modal;
      modal.querySelector("[data-public-editor-close]").onclick = closePublicEditor;
      modal.addEventListener("click", (e) => { if (e.target === modal) closePublicEditor(); });
      const tryBtn = modal.querySelector("[data-public-installed-try]"); if (tryBtn) tryBtn.onclick = () => { closePublicEditor(); publicRun(item); };
      const actBtn = modal.querySelector("[data-public-installed-activate]"); if (actBtn) actBtn.onclick = () => { closePublicEditor(); setWorkMode("pm:" + item.id); };
      modal.querySelector("[data-public-installed-open]").onclick = () => { closePublicEditor(); cardsTab = "public"; try { if (openCardsPanel) openCardsPanel(true); else { cardsPanel.hidden = false; renderCards(cardsPanel); } } catch {} };
    }
    window.addEventListener("or-public-skill-result", (e) => { try { const d = e.detail || {}; if (d.kind === "removed") { toast(`Public ${d.item && d.item.kind || "skill"} '${d.item && d.item.name}' deleted`); return; } if (d.kind === "toggled") return; showPublicInstalled(d); } catch (err) { try { diag("publicSkills.resultUi", { error: String(err) }); } catch {} } });
    window.addEventListener("or-public-skills-change", () => { try { syncWorkModeUi(); } catch {} try { if (menuEl && !menuEl.hidden) buildMenu(); } catch {} try { if (cardsPanel && !cardsPanel.hidden && cardsTab === "public") renderCards(cardsPanel); } catch {} });
    // ── Tasks tab (Settings → Task list) ──
    const TASK_MARK = { todo: "", doing: "▶", done: "✓", skipped: "–" };
    function tasksHtml(){
      const TL = ORTaskList; const tasks = TL.list(); const p = TL.progress();
      const rows = tasks.map((t, i) => `<li class="rs-task-row rs-task-${t.status}" data-task-id="${escRs(t.id)}"><button type="button" class="rs-task-check" data-task-action="toggle" title="${t.status === "done" ? "Mark open" : "Mark done"}" aria-label="${t.status === "done" ? "Mark open" : "Mark done"}">${TASK_MARK[t.status]}</button><div class="rs-task-copy"><span class="rs-task-n">#${i + 1}</span><span class="rs-task-text" contenteditable="true" spellcheck="false" data-task-edit>${escRs(t.text)}</span>${t.notes ? `<small class="rs-task-notes">${escRs(t.notes)}</small>` : ""}${t.by === "ai" ? '<small class="rs-task-by">added by AI</small>' : ""}</div><div class="rs-task-actions"><button type="button" data-task-action="run" title="Ask the AI to do this task">Run</button><button type="button" data-task-action="doing" title="Mark in progress">▶</button><button type="button" data-task-action="skip" title="Skip">Skip</button><button type="button" data-task-action="up" title="Move up">↑</button><button type="button" data-task-action="down" title="Move down">↓</button><button type="button" class="rs-template-delete" data-task-action="delete" title="Delete">×</button></div></li>`).join("");
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<section class="rs-template-library rs-tasks" aria-label="Task list"><div class="rs-template-controls"><header class="rs-template-head"><div class="rs-template-head-copy"><div><b>Task list</b><span class="rs-template-count">${p.done}/${p.total}</span></div><p>Your checklist for this project. The AI sees it, works it with <code>task_next</code> and ticks items with <code>task_update</code> after verifying.</p></div><div class="rs-template-head-actions"><button type="button" class="rs-btn-primary" data-task-run-all ${p.open ? "" : "disabled"}>Run all with AI</button><button type="button" class="rs-btn-secondary" data-task-run-next ${p.open ? "" : "disabled"}>Run next</button></div></header><div class="rs-task-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div><form class="rs-task-add" data-task-add-form><input id="rs-task-input" type="text" autocomplete="off" spellcheck="false" placeholder="Add a task and press Enter (paste several lines to add many)"><button type="button" class="rs-btn-secondary" data-task-ai-plan title="Let the AI break the project into tasks">Plan with AI</button></form><div class="rs-task-tools"><button type="button" data-task-clear-done ${p.done + p.skipped ? "" : "disabled"}>Clear done</button><button type="button" data-task-export ${p.total ? "" : "disabled"}>Export</button><button type="button" data-task-import>Import</button><button type="button" data-task-disable title="Same as Settings → Task list">Disable task list</button></div></div>${tasks.length ? `<ol class="rs-task-list">${rows}</ol>` : `<div class="rs-template-empty"><div class="rs-template-empty-mark">✓</div><b>No tasks yet</b><span>Type a task above, paste a list, or press Plan with AI to let the agent propose the steps for your project.</span></div>`}</section>`;
    }
    function taskRunPrompt(t, idx){ return `Work on task #${idx} from my OrScript task list now: "${t.text}"${t.notes ? ` (notes: ${t.notes})` : ""}. First call task_update {"id":"${t.id}","status":"doing"}, then do the work with real commands and verify it, then call task_update {"id":"${t.id}","status":"done","notes":"<one line of what you did>"}. If it cannot be done, mark it "skipped" with the reason. Do not start other tasks.`; }
    function activityHtml() {
      // 1.34.1 — the Activity tab shares the Library shell (.rs-template-library
      // header + .rs-template-row rows) so every cards-panel tab has one look.
      const shown = recentCards.slice(0, 12);
      const doneN = shown.filter((c) => c.status === "ok").length;
      const errN = shown.filter((c) => c.status === "err").length;
      const head =
        '<div class="rs-template-controls"><header class="rs-template-head"><div class="rs-template-head-copy"><div><b>Activity</b><span class="rs-template-count">' + recentCards.length + '</span>'
        + (doneN ? '<span class="rs-cards-count">' + doneN + '<i>ok</i></span>' : "")
        + (errN ? '<span class="rs-cards-count err">' + errN + '<i>err</i></span>' : "")
        + '</div><p>Every command the AI ran this session, newest first, with its result.</p></div>'
        + '<div class="rs-template-head-actions"><button id="rs-cards-clear" type="button" class="rs-btn-secondary"' + (recentCards.length ? "" : " disabled") + '>Clear</button></div></header></div>';
      if (!recentCards.length) {
        return '<section class="rs-template-library rs-activity" aria-label="Activity">' + head
          + '<div class="rs-template-empty rs-cards-empty"><div class="rs-template-empty-mark">\u2726</div><b>No results yet</b><span>Every tool result lands here as a card — what ran, what it did and whether it worked.</span></div></section>';
      }
      const rows = shown.map((c, i) => {
        const icon = { edit: "\u270E", read: "\u2139", screen: "\u25A3", generate: "\u2726", roblox: "\u25A6", tool: "\u2699" }[c.category] || "\u2699";
        const cls = c.status === "ok" ? "done" : c.status === "err" ? "err" : "run";
        const ago = Math.max(0, Math.round((Date.now() - c.at) / 1000));
        const agoStr = ago < 60 ? ago + "s" : ago < 3600 ? Math.round(ago / 60) + "m" : Math.round(ago / 3600) + "h";
        return '<article class="rs-template-row rs-activity-row rs-card rs-card-' + cls + '" data-idx="' + i + '" style="animation-delay:' + Math.min(i * 45, 400) + 'ms">'
          + '<div class="rs-card-icon">' + icon + '</div>'
          + '<div class="rs-template-copy rs-card-body"><b class="rs-card-title">' + escRs(c.tool) + '</b>'
          + '<p class="rs-card-detail">' + escRs(c.detail || "") + '</p>'
          + '<span class="rs-card-meta"><span class="rs-card-status"><span class="rs-card-dot"></span>'
          + (c.status === "ok" ? "Done" : c.status === "err" ? "Failed" : "Running")
          + '</span><span class="rs-card-time">' + agoStr + ' ago</span></span></div>'
          + '</article>';
      }).join("");
      return '<section class="rs-template-library rs-activity" aria-label="Activity">' + head + '<div class="rs-template-list rs-activity-list">' + rows + '</div></section>';
    }

    function roadmapProgress() {
      const tasks=roadmapAllTasks(); const completed=tasks.filter((t)=>t.status==="completed"||t.status==="skipped").length;
      return { tasks, completed, percent:roadmap ? roadmap.progress : 0, active:roadmap&&roadmap.currentTaskId?roadmapFind(roadmap.currentTaskId):null };
    }
    function roadmapHtml() {
      if (!roadmap) return '<div class="rs-roadmap-empty"><div class="rs-roadmap-empty-title">No active roadmap</div><p>For a complex request, the agent will create phases and update them as verified work is completed.</p></div>';
      const info=roadmapProgress();
      const stateLabel={pending:"Pending",in_progress:"In progress",completed:"Completed",failed:"Failed",blocked:"Blocked",skipped:"Skipped"};
      const taskHtml=(task,depth)=>'<div class="rs-roadmap-task rs-roadmap-'+task.status+'" data-depth="'+depth+'">'
        +'<span class="rs-roadmap-state" aria-label="'+stateLabel[task.status]+'"></span><div class="rs-roadmap-task-copy"><div class="rs-roadmap-task-title">'+escRs(task.title)+'</div>'
        +((task.error||(task.agentActivity.length&&task.agentActivity[task.agentActivity.length-1].message))?'<div class="rs-roadmap-task-detail">'+escRs(task.error||(task.agentActivity[task.agentActivity.length-1].message))+'</div>':'')
        +(task.dependsOn&&task.dependsOn.length?'<div class="rs-roadmap-deps">Depends on '+task.dependsOn.map(escRs).join(', ')+'</div>':'')
        +(task.result?'<div class="rs-roadmap-verify">Verified: '+escRs(task.result)+'</div>':'')+'</div><span class="rs-roadmap-label">'+stateLabel[task.status]+'</span></div>'
        +(task.subtasks||[]).map((x)=>taskHtml(x,depth+1)).join('');
      const phases=roadmap.phases.map((phase,i)=>{const flat=[];const walk=(xs)=>xs.forEach((t)=>{flat.push(t);walk(t.subtasks||[])});walk(phase.tasks);const done=flat.filter((t)=>t.status==="completed").length;return '<section class="rs-roadmap-phase'+(phase.collapsed?' collapsed':'')+'"><button type="button" class="rs-roadmap-phase-head" data-phase-id="'+escRs(phase.id)+'" aria-expanded="'+(!phase.collapsed)+'"><span class="rs-roadmap-chevron"></span><span class="rs-roadmap-phase-copy"><b>'+escRs(phase.title)+'</b>'+(phase.description?'<small>'+escRs(phase.description)+'</small>':'')+'</span><span class="rs-roadmap-phase-count">'+done+'/'+flat.length+'</span></button><div class="rs-roadmap-phase-body">'+phase.tasks.map((t)=>taskHtml(t,0)).join('')+'</div></section>'}).join('');
      return '<div class="rs-roadmap"><header class="rs-roadmap-head"><div><span class="rs-roadmap-kicker">PROJECT ROADMAP</span><h3>'+escRs(roadmap.title)+'</h3>'+(roadmap.description?'<p>'+escRs(roadmap.description)+'</p>':'')+'</div><strong>'+info.percent+'%</strong></header><div class="rs-roadmap-progress"><i style="width:'+info.percent+'%"></i></div><div class="rs-roadmap-summary"><span>'+info.completed+' of '+info.tasks.length+' tasks completed</span><span>'+(info.active?'Active: '+escRs(info.active.title):info.percent===100?'All work verified':'Waiting for next task')+'</span></div><div class="rs-roadmap-phases">'+phases+'</div></div>';
    }

    // ── AgentScript Session Summary ──
    // In AS mode there are no mechanic cards: the panel becomes a live summary
    // of WHAT THE AI DID this session - edit/run/inspect counters plus a feed
    // of every action with its outcome. Data source is the same recentCards
    // stream trackCard() already records from the agent loop.
    function summaryActions() {
      return recentCards.filter((c) => c.tool !== "list_commands" && c.tool !== "list_tools" && c.tool !== "list_mcp_servers");
    }
    function summaryHtml() {
      const acts = summaryActions();
      const full = !!(typeof window.__rsFullAccess === "function" && window.__rsFullAccess());
      const head = '<div class="rs-cards-head"><span class="rs-cards-title">Session</span>'
        + '<span class="rs-sum-live">' + (full ? "\u25CF FULL" : "\u25CB sandboxed") + '</span>'
        + '<button id="rs-cards-clear" type="button">Clear</button></div>';
      // ── Danger zone FIRST — it must be visible immediately, every time,
      // empty session or not. Single FULL ACCESS toggle; agent state is truth.
      const danger =
        '<div class="rs-danger-zone">'
        + '<div class="rs-dz-head">\u26A0 Danger zone</div>'
        + '<div class="rs-dz-row">'
        +   '<div class="rs-dz-text"><b>FULL ACCESS</b><span>Let the AI read and write anywhere on this PC and control processes \u2014 not just the workspace.</span></div>'
        +   '<button id="rs-full-toggle" class="' + (full ? "on" : "") + '" title="' + (full ? "Click to return to the workspace sandbox" : "Lift the workspace sandbox") + '">' + (full ? "ON" : "OFF") + '</button>'
        + '</div>'
        + '</div>';
      if (!acts.length) {
        return '<section class="rs-template-library rs-session" aria-label="Session">' + head + danger
          + '<div class="rs-cards-empty"><div class="rs-cards-empty-glyph">\u25A6</div>No actions yet<br><span>File edits, terminal runs and searches land here as they happen.</span></div></section>';
      }
      const is = (c, re) => re.test(c.tool);
      const edits = acts.filter((c) => is(c, /^(write_file|edit_file|create_folder|delete_path|move_path)$/)).length;
      const runs = acts.filter((c) => is(c, /^run_command$/)).length;
      const reads = acts.filter((c) => is(c, /^(read_file|grep_files|search_files|tree|list_directory|file_info|env_info|process_list|process_kill|open_path|download_file|workspace_info)$/)).length;
      const errs = acts.filter((c) => c.status === "err").length;
      const chip = (n, label, cls) => `<span class="rs-sum-chip${cls ? " " + cls : ""}${n ? "" : " zero"}">${n} <i>${label}</i></span>`;
      const stats =
        '<div class="rs-sum-stats">'
        + chip(edits, "edits", "ed")
        + chip(runs, "runs", "run")
        + chip(reads, "inspects", "rd")
        + (errs ? chip(errs, "failed", "er") : "")
        + '</div>';
      const rows = acts.slice(0, 30).map((c, i) => {
        const icon = { edit: "\u270E", read: "\u2139", screen: "\u25A3", generate: "\u2726", roblox: "\u25A6", tool: "\u2699" }[c.category] || "\u2699";
        const cls = c.status === "ok" ? "done" : c.status === "err" ? "err" : "run";
        const ago = Math.max(0, Math.round((Date.now() - c.at) / 1000));
        const agoStr = ago < 60 ? ago + "s" : ago < 3600 ? Math.round(ago / 60) + "m" : Math.round(ago / 3600) + "h";
        return '<div class="rs-card rs-card-' + cls + '" style="animation-delay:' + Math.min(i * 35, 320) + 'ms">'
          + '<div class="rs-card-icon">' + icon + '</div>'
          + '<div class="rs-card-body"><div class="rs-card-title">' + escRs(c.tool) + '</div>'
          + '<div class="rs-card-detail">' + escRs(c.detail || "") + '</div></div>'
          + '<div class="rs-card-meta"><span class="rs-card-status"><span class="rs-card-dot"></span>'
          + (c.status === "ok" ? "Done" : c.status === "err" ? "Failed" : "Running")
          + '</span><span class="rs-card-time">' + agoStr + ' ago</span></div>'
          + '</div>';
      }).join("");
      return '<section class="rs-template-library rs-session" aria-label="Session">' + head + danger + stats + '<div class="rs-cards-grid rs-sum-feed">' + rows + '</div></section>';
    }

    function renderCards(panel) {
      if (!panel) return;
      const actN = recentCards.length ? ' <b>' + recentCards.length + '</b>' : '';
      const local = activeEngine() === "local";
      const mainLabel = local ? "Session" : "Library";
      if (cardsTab === "tasks" && !taskListOn()) cardsTab = "library";
      const body = cardsTab === "activity" ? activityHtml() : cardsTab === "public" ? publicHtml() : cardsTab === "tasks" ? tasksHtml() : (local ? summaryHtml() : libraryHtml());
      // 1.34.1 — the panel heading names the open tab instead of always saying
      // "Templates"; data-cards-tab lets overlay.css style per tab.
      const tabHead = cardsTab === "activity" ? ["Activity", "What the AI ran this session"]
        : cardsTab === "public" ? ["Public Skills", "Your own commands, procedures and modes"]
        : cardsTab === "tasks" ? ["Tasks", "Your checklist for this project"]
        : local ? ["Session", "What the agent did this session"] : ["Templates", "Reusable workflows"];
      panel.dataset.cardsTab = cardsTab;
      panel.innerHTML =
        '<div class="rs-cards-top">'
        + '<div class="rs-cards-brand"><img class="rs-logo rs-cards-logo" alt="" aria-hidden="true" src="' + chrome.runtime.getURL("assets/icon128.png") + '"><span class="rs-cards-kicker" data-rs-brand-short>' + (orTheme==="void"?"VoidScript":"OrScript") /* selected-skin branding */ + '</span><span class="rs-cards-heading">' + tabHead[0] + '</span><span class="rs-cards-subheading">' + tabHead[1] + ' · v' + EXT_VERSION + '</span></div>'
        + '<div class="rs-cards-tabs">'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "library" ? " on" : "") + '" data-tab="library">' + mainLabel + '</button>'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "activity" ? " on" : "") + '" data-tab="activity">Activity' + actN + '</button>'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "public" ? " on" : "") + '" data-tab="public">Public' + (publicCount() ? ' <b>' + publicCount() + '</b>' : '') + '</button>'
        + (taskListOn() ? '<button type="button" class="rs-cards-tab' + (cardsTab === "tasks" ? " on" : "") + '" data-tab="tasks">Tasks' + (() => { try { const p = ORTaskList.progress(); return p.total ? ' <b>' + p.done + '/' + p.total + '</b>' : ''; } catch { return ''; } })() + '</button>' : '')
        + '</div></div>'
        + '<div class="rs-cards-body">' + body + '</div>';
      // Bind tabs on every render. The panel is re-created frequently, so a
      // listener attached only during the first open becomes detached.
      panel.querySelectorAll(".rs-cards-tab").forEach((tab) => {
        const openTab = (event) => {
          event.preventDefault(); event.stopImmediatePropagation();
          cardsTab = tab.dataset.tab === "public" ? "public" : tab.dataset.tab === "tasks" ? "tasks" : tab.dataset.tab === "activity" ? "activity" : "library";
          renderCards(panel);
        };
        // Use one activation path only. A pointerup handler plus onclick caused a
        // second activation after renderCards replaced the button, making the
        // tab appear to ignore clicks in embedded pages.
        tab.onclick = openTab;
        tab.style.pointerEvents = "auto";
        tab.style.touchAction = "manipulation";
      });
      panel.querySelectorAll(".rs-roadmap-phase-head").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!roadmap) return;
        const phase=roadmap.phases.find((p)=>p.id===button.dataset.phaseId);
        if (phase) { phase.collapsed=!phase.collapsed; saveRoadmap(); renderCards(panel); }
      }));
      const search = panel.querySelector("#rs-cards-search");
      if (search) {
        search.addEventListener("input", () => {
          cardsQuery = search.value;clearTimeout(cardsSearchTimer);cardsSearchTimer=setTimeout(()=>{visibleLibCache = libFiltered();const wrap = panel.querySelector("#rs-cards-grid-wrap");if (wrap) wrap.innerHTML = gridHtml();const count=panel.querySelector("[data-template-count]");if(count)count.textContent=String(visibleLibCache.length);},120);
        });
        setTimeout(() => { try { search.focus(); } catch {} }, 0);
      }
      const pubPrompt = panel.querySelector("#rs-public-prompt");
      if (pubPrompt) {
        pubPrompt.addEventListener("input", () => {
          publicDraft = pubPrompt.value;
          // Live label: the Create button says what will happen (design vs convert).
          try {
            const PS = PublicSkills; const text = pubPrompt.value.trim();
            const convert = publicIsConvert(text);
            const b = panel.querySelector("[data-public-create]"); if (b) b.textContent = convert ? "Turn prompt into a skill (AI)" : "Create with AI";
            const save = panel.querySelector("[data-public-save-text]"); if (save) save.disabled = text.length < 20;
            const hint = panel.querySelector(".rs-public-hint"); const hadHint = !!hint;
            if (text && !hadHint) { renderCards(panel); const ta = panel.querySelector("#rs-public-prompt"); if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} } }
            else if (hint) { hint.classList.toggle("rs-public-hint-convert", convert); const strong = convert ? "Looks like a full prompt → the AI will convert it faithfully (nothing dropped, nothing invented)." : `Short description → the AI designs the ${publicKind === "auto" ? "skill / ability / mode" : publicKind} for you.`; if (hint.firstChild && hint.firstChild.nodeType === 3) hint.firstChild.nodeValue = strong + " "; }
            void PS;
          } catch {}
        });
        pubPrompt.addEventListener("paste", () => { setTimeout(() => { try { pubPrompt.dispatchEvent(new Event("input", { bubbles: true })); } catch {} }, 0); });
        pubPrompt.addEventListener("keydown", (e) => { e.stopPropagation(); if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); const b = panel.querySelector("[data-public-create]"); if (b) b.click(); } });
      }
      const pubKind = panel.querySelector("#rs-public-kind");
      if (pubKind) pubKind.addEventListener("change", () => { publicKind = pubKind.value; });
      // Drop a .txt / .md / .json anywhere on the Public tab: skill files install, prompts load into the box.
      const pubSection = panel.querySelector(".rs-public");
      if (pubSection) {
        const over = (e) => { if (!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"))) return; e.preventDefault(); e.stopPropagation(); pubSection.classList.add("rs-public-dragover"); };
        pubSection.addEventListener("dragenter", over); pubSection.addEventListener("dragover", over);
        pubSection.addEventListener("dragleave", (e) => { if (!pubSection.contains(e.relatedTarget)) pubSection.classList.remove("rs-public-dragover"); });
        pubSection.addEventListener("drop", async (e) => {
          const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
          if (!files.length) return;
          e.preventDefault(); e.stopPropagation(); pubSection.classList.remove("rs-public-dragover");
          for (const f of files.slice(0, 10)) { if (f.size > 2 * 1024 * 1024) { toast(`${f.name}: too large (2 MB max)`); continue; } try { publicLoadText(await publicReadFile(f), f.name); } catch (err) { toast(`${f.name}: ${String(err).slice(0, 80)}`); } }
        });
      }
      const taskInput = panel.querySelector("#rs-task-input");
      if (taskInput) {
        taskInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); const v = taskInput.value.trim(); if (!v) return; const added = ORTaskList.add(v, { by: "user" }); taskInput.value = ""; if (added.length) { renderCards(panel); const again = panel.querySelector("#rs-task-input"); if (again) setTimeout(() => { try { again.focus(); } catch {} }, 0); } } });
        taskInput.addEventListener("paste", (e) => { const text = e.clipboardData && e.clipboardData.getData("text"); if (text && /\n/.test(text.trim())) { e.preventDefault(); const added = ORTaskList.add(text, { by: "user" }); toast(`Added ${added.length} task${added.length === 1 ? "" : "s"}`); renderCards(panel); } });
        const form = panel.querySelector("[data-task-add-form]"); if (form) form.addEventListener("submit", (e) => e.preventDefault());
        setTimeout(() => { try { if (!ORTaskList.list().length) taskInput.focus(); } catch {} }, 0);
      }
      panel.querySelectorAll("[data-task-edit]").forEach((el) => {
        el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); el.blur(); } if (e.key === "Escape") { e.preventDefault(); renderCards(panel); } });
        el.addEventListener("blur", () => { const row = el.closest("[data-task-id]"); const t = row && ORTaskList.find(row.dataset.taskId); const v = el.textContent.trim(); if (t && v && v !== t.text) ORTaskList.update(t.id, { text: v }); else if (t && !v) renderCards(panel); });
      });
      const categorySelect=panel.querySelector("#rs-template-category");if(categorySelect)categorySelect.addEventListener("change",()=>{cardsCategory=categorySelect.value;visibleLibCache=libFiltered();const wrap=panel.querySelector("#rs-cards-grid-wrap");if(wrap)wrap.innerHTML=gridHtml();const count=panel.querySelector("[data-template-count]");if(count)count.textContent=String(visibleLibCache.length);});
    }

    window.addEventListener("or-roadmap-change", () => {
      try { if (cardsPanel && !cardsPanel.hidden && cardsTab === "roadmap") renderCards(cardsPanel); } catch {}
    });

    // ── Card send-embed ──
    // Pressing a library card shows a floating embed of exactly what you
    // picked (icon/title/category/desc) with a live status footer, AND wraps
    // the outgoing text in a matching unicode frame so your message in the
    // chat reads back as the same card you clicked.
    let cardEmbedEl = null, cardEmbedTimer = 0;
    function engineLabel(engine) { return engine === "an" ? "Animation" : "Roblox"; }
    function cardEmbedText(card) {
      // Plain text (NOT HTML) — this is what actually gets typed into the chat.
      const body = "\u256D\u2500 " + card.icon + " " + card.title + "  \u00B7 " + card.cat + " (" + engineLabel(card.engine) + ")\n"
        + "\u2502 " + card.desc + "\n"
        + "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"
        + card.prompt;
      // Public Skills cards (create / convert / improve) are not "build a
      // feature in Studio" briefs - wrapping them in the production brief made
      // models start building instead of calling public_skill_create.
      if (card.cat === "Public Skills" || card.noBrief) return body;
      try { if (RS.wrapTaskPrompt) return RS.wrapTaskPrompt(body); } catch {}
      return body;
    }
    function hideCardEmbed() {
      if (cardEmbedTimer) { clearTimeout(cardEmbedTimer); cardEmbedTimer = 0; }
      if (cardEmbedEl) cardEmbedEl.hidden = true;
      if (bar) bar.classList.remove("rs-card-embed-open");
    }
    function showCardEmbed(card, mode) {
      if (!card || !root) return;
      try {
        if (!cardEmbedEl || !cardEmbedEl.isConnected) {
          cardEmbedEl = document.createElement("div");
          cardEmbedEl.id = "rs-card-embed";
          bar.appendChild(cardEmbedEl);
        } else if (cardEmbedEl.parentElement !== bar) {
          bar.appendChild(cardEmbedEl);
        }
        const stMap = {
          run:   '<span class="rs-ce-dot"></span>Sending to AI\u2026',
          ok:    '<span class="rs-ce-dot ok"></span>Sent to AI \u2713',
          paste: '<span class="rs-ce-dot paste"></span>In composer \u2014 press Enter',
          err:   '<span class="rs-ce-dot err"></span>Composer not found'
        };
        cardEmbedEl.innerHTML =
          '<div class="rs-ce-glyph">' + card.icon + '</div>'
          + '<div class="rs-ce-body">'
          +   '<div class="rs-ce-title">' + escRs(card.title)
          +     '<span class="rs-ce-chip">' + escRs(card.cat) + '</span>'
          +     '<span class="rs-ce-chip dim">' + engineLabel(card.engine) + '</span>'
          +   '</div>'
          +   '<div class="rs-ce-desc">' + escRs(card.desc) + '</div>'
          +   '<div class="rs-ce-status">' + (stMap[mode] || stMap.run) + '</div>'
          + '</div>';
        try { cardEmbedEl.dataset.mode = mode || "run"; } catch {}
        // The send preview uses the same reserved expansion lane as Settings and
        // Cards. It no longer floats above the control and cover messages.
        setMenuOpen(false);
        if (cardsPanel) cardsPanel.hidden = true;
        hideSetup();
        bar.classList.remove("rs-menu-contained", "rs-cards-open");
        bar.classList.add("rs-card-embed-open");
        cardEmbedEl.hidden = false;
        // Restart the pop animation even when a second card replaces this one.
        cardEmbedEl.style.animation = "none";
        void cardEmbedEl.offsetWidth;
        cardEmbedEl.style.animation = "";
        if (cardEmbedTimer) clearTimeout(cardEmbedTimer);
        cardEmbedTimer = setTimeout(hideCardEmbed, mode === "paste" ? 4200 : 2600);
      } catch {}
    }

    // Click-to-run: drops the card's prompt straight into the site's composer
    // via the browser's native editing command (updates React/Angular/Vue
    // state the same way the agent loop injects its result messages).
    // Click-to-send: the card goes straight to the AI via the same
    // provider-native path the agent loop uses (types the framed embed into
    // the composer, then sends). Shift+click = paste only, for stacking
    // several cards first.
    async function runLibraryCard(card, send = true) {
      if (!send) { pasteLibraryCard(card); return; }
      try { cardsPanel.hidden = true; } catch {}
      hideCardEmbed();
      showCardEmbed(card, "run");
      let sent = false;
      try {
        if (typeof P !== "undefined" && P.typeAndSend) {
          await P.typeAndSend(cardEmbedText(card));
          sent = true;
        }
      } catch (e) { try { diag("cards.sendFail", { err: String(e).slice(0, 120) }); } catch {} }
      if (!sent) {
        const pasted = pasteLibraryCard(card, { silent: true });
        try {
          const btn = document.querySelector('[aria-label*="Send" i], [data-testid*="send" i], button[type="submit"]');
          if (btn && pasted) { btn.click(); sent = true; }
        } catch {}
        if (!sent) showCardEmbed(card, pasted ? "paste" : "err");
      }
      if (sent) showCardEmbed(card, "ok");
    }

    // Paste-only variant: inserts at the END of the composer WITHOUT sending.
    // Uses the browser's native editing command so React/Angular/Vue composer
    // state stays in sync. opts.silent suppresses the toast (the send-embed
    // reports the outcome instead); opts.embed pastes the framed card text.
    function pasteLibraryCard(card, opts) {
      const silent = !!(opts && opts.silent);
      const body = (opts && opts.embed) ? cardEmbedText(card) : card.prompt;
      const ed = (typeof P !== "undefined" && P.getEditor && P.getEditor()) || null;
      if (!ed) { toast("Open a chat first — the message box isn't on this page"); showCardEmbed(card, "err"); return false; }
      const isInput = ed.tagName === "TEXTAREA" || ed.tagName === "INPUT";
      let existing = "";
      try { existing = isInput ? (ed.value || "") : (ed.textContent || ""); } catch {}
      const payload = existing.trim() ? "\n\n" + body : body;
      try { ed.focus(); } catch {}
      try {
        if (isInput) {
          const L = (ed.value || "").length;
          ed.setSelectionRange(L, L);
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(ed);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
      let ok = false;
      try { ok = document.execCommand("insertText", false, payload); } catch {}
      if (!ok && isInput && typeof ed.setRangeText === "function") {
        try {
          const L = (ed.value || "").length;
          ed.setRangeText(payload, L, L, "end");
          ed.dispatchEvent(new Event("input", { bubbles: true }));
          ok = true;
        } catch {}
      }
      if (!ok) {
        try { ed.textContent = (existing || "") + payload; ed.dispatchEvent(new Event("input", { bubbles: true })); ok = true; } catch {}
      }
      if (!silent) toast(ok ? ("\u2795 " + card.title + " added \u2014 press Enter to run") : "Could not type into the composer.");
      return !!ok;
    }
    // Card event wiring moved into build() so cardsBtn/cardsPanel exist
    // ── First-time onboarding card (bridge missing) ─────────────────────────
    let setupCard = null, setupSeen = false, setupRaf = null;
    try {
      chrome.storage.local.get("rsSetupSeen", (r) => {
        if (r && r.rsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "rs-setup";
      setupCard.hidden = true;
      setupCard.innerHTML =
        `<div id="rs-setup-head"><span id="rs-setup-logo">OR</span><span id="rs-setup-tag">Setup</span></div>` +
        `<div id="rs-setup-sub">Three steps. Then talk to the AI like a teammate.</div>` +
        `<ol id="rs-setup-steps">` +
          `<li>Double-click <code>${RUN_CMD}</code> and leave it running</li>` +
          `<li>Pick <b>RS</b> for Studio or <b>AS</b> for a folder on this PC</li>` +
          `<li>Click <b>Start agent</b> on the bar</li>` +
        `</ol>` +
        `<div class="rs-setup-actions">` +
          `<button type="button" id="rs-setup-tutorial">Tutorial</button>` +
          `<button type="button" id="rs-setup-close" title="Dismiss setup">\u2715</button>` +
        `</div>`;
      // Keep onboarding in the same reserved composer lane as every persistent
      // ORscript control instead of pinning it over the page's top-right text.
      bar.appendChild(setupCard);

      setupCard.querySelector("#rs-setup-tutorial").addEventListener("click", () => {
        openTutorial();
      });

      setupCard.querySelector("#rs-setup-close").addEventListener("click", () => {
        setupSeen = true;
        try { chrome.storage.local.set({ rsSetupSeen: true }); } catch {}
        hideSetup();
      });
    }

    // ── In-extension text tutorial (centered, scrollable modal) ─────────────
    // Replaces the outdated YouTube link: the walkthrough ships with the
    // extension and can never go stale relative to the UI.
    let tutorialEl = null;
    const TUTORIAL_HTML = `
      <h3>Welcome to OR</h3>
      <p>This extension turns your AI chat into a real agent. You talk, it <b>does</b> — switch engines on the bar:</p>
      <ul>
        <li><b>RS — Roblox</b>: builds inside Roblox Studio (instances, scripts, terrain, UI, lighting).</li>
        <li><b>AS — AgentScript</b>: works directly on a folder on your PC — files, code, terminal commands.</li>
      </ul>

      <h3>1 · Run the agent</h3>
      <p>Double-click <code>bin/or-core.exe</code> in your folder. A status window opens showing engines and a live console. Keep it running while you work.</p>

      <h3>2 · Connect an engine</h3>
      <p><b>RS:</b> open Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → enable Studio as MCP Server.<br>
      <b>AS:</b> nothing to connect — it's already your machine.</p>

      <h3>3 · Start the agent</h3>
      <p>Open any supported AI chat (DeepSeek, ChatGPT, Gemini, Kimi, Qwen, Arena, Meta AI, or Crax). Click <b>Start agent</b> on the bar. The AI runs <code>list_commands</code>, then waits for your first request.</p>

      <h3>Power-ups</h3>
      <p>In the ⋯ menu toggle <b>Work in background tabs</b> (on by default) so the agent keeps building while you browse other sites.</p>

      <h3>AgentScript basics (AS)</h3>
      <p>The terminal button next to your chatbox opens your <b>Session summary</b>: every file edit, command run and search, with pass/fail states and counters.</p>
      <p>Ask naturally: "make a python script that sorts my downloads folder" or "fix the failing test in src/". The AI explores with <code>tree</code>/<code>grep_files</code>, edits with exact patches (<code>edit_file</code>) and verifies by running your tests itself — reading stdout/stderr without bothering you.</p>

      <h3>Danger zone — FULL ACCESS</h3>
      <p>By default AgentScript is confined to its workspace folder. At the bottom of the Session panel sits a red <b>Danger zone</b> with one toggle: <b>FULL ACCESS</b>. ON = the AI may use absolute paths anywhere on this PC and control processes. It stays off unless you flip it, and the agent window shows a red badge while it's on.</p>

      <h3>4 · Screenshot</h3>
      <p>Works in <b>Chrome, Edge, Brave, and Opera</b>. <code>or_screenshot {target:"studio"}</code> captures the real Roblox Studio/game viewport through Studio MCP and attaches it to the next message. Use <code>target:"tab"</code> only to capture this browser chat.</p>

      <h3>Troubleshooting</h3>
      <ul>
        <li><b>"Bridge offline"</b> → run bin/or-core.exe.</li>
        <li><b>RS says Studio offline</b> → enable the MCP server inside Studio (step 2), or hit <b>Repair Studio link</b> in the ⋯ menu.</li>
        <li><b>Wrong tools appearing</b> → check the RS/AS switch; switching wipes caches automatically.</li>
        <li><b>Commands do nothing</b> → reload the extension after updating the folder.</li>
      </ul>`;

    function buildTutorial() {
      tutorialEl = document.createElement("div");
      tutorialEl.id = "rs-tutorial";
      tutorialEl.innerHTML =
        '<div id="rs-tut-card">'
        +  '<div id="rs-tut-head">'
        +    '<span id="rs-tut-logo">OR</span><span id="rs-tut-tag">Tutorial</span>'
        +    '<button id="rs-tut-close" title="Close">\u2715</button>'
        +  '</div>'
        +  '<div id="rs-tut-body">' + TUTORIAL_HTML + '</div>'
        +  '<div id="rs-tut-foot"><button id="rs-tut-gotit">Got it \u2014 let\u2019s build</button></div>'
        + '</div>';
      document.documentElement.appendChild(tutorialEl);
      const close = () => { if (tutorialEl) tutorialEl.hidden = true; };
      tutorialEl.querySelector("#rs-tut-close").addEventListener("click", close);
      tutorialEl.querySelector("#rs-tut-gotit").addEventListener("click", close);
      tutorialEl.addEventListener("click", (e) => { if (e.target === tutorialEl) close(); });
      try { chrome.storage.local.set({ rsTutorialSeen: true }); } catch {}
    }

    function openTutorial() {
      if (!tutorialEl) buildTutorial();
      tutorialEl.hidden = false;
      const body = tutorialEl.querySelector("#rs-tut-body");
      if (body) body.scrollTop = 0;
    }

    // Onboarding expands the reserved composer strip rather than covering the
    // page. It is first-run only and remains dismissible from inside that lane.
    function showSetup() {
      if (!setupCard) buildSetup();
      if ((menuEl && !menuEl.hidden) || (cardsPanel && !cardsPanel.hidden) || (cardEmbedEl && !cardEmbedEl.hidden)) return;
      if (setupCard.hidden) {
        setupCard.hidden = false;
        if (bar) bar.classList.add("rs-setup-open");
        cancelAnimationFrame(setupRaf);
      }
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
      if (bar) bar.classList.remove("rs-setup-open");
      cancelAnimationFrame(setupRaf);
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      // Bridge is down, but if the user is just READING an existing
      // conversation with no OR session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
    }

    // The single source of truth for the bar's content. Decides the dot tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting the Roblox agent…"
    //  • session active   → live dot, "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/Studio warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      // Agent state for MAIN-world taps (crax-net.js reads it to decide whether a
      // chat request belongs to an OR session). The DOM is shared across worlds.
      try { document.documentElement.setAttribute("data-rs-agent", A.started ? "on" : (A.starting ? "starting" : "off")); } catch {}
      if (!bar) return;
      // Recover from any stale composer mask left by an interrupted template,
      // provider, or bootstrap operation. A cover must never block Start Agent.
      if (!A.running && !A.starting) { try { inputCover(false); } catch {} }
      try { syncSteeringUi(); } catch {}
      // Persona badge: only visible when a specialist persona is active.
      
      try {
        const engEl = root && root.querySelector("#rs-engine");
        if (engEl) {
          // Dim = hint only. Never set .disabled here: a disabled button swallows
          // clicks before the delegated handler can fire, which made the toggle
          // feel completely dead. Switching stays allowed; START is what's gated.
          const gating = !!(A.bridge && A.bridge.connected);
          const rb = engEl.querySelector('[data-mode="roblox"]');
          if (rb) { const ok = !gating || robloxProcUp; rb.style.opacity = ok ? "" : "0.35"; rb.title = ok ? "Switch to Roblox" : "Roblox Studio not running"; }
        }
      } catch {}
      // indicator = an optional leading dot/spinner; msg = the wrappable text.
      let toneClass = "standby", indicator = "", msg = "", label = "", kind = "", disabled = false, warn = false;
      // Orphaned page: check FIRST and return. Nothing below can be true any
      // more - the status poll is stopped, so every value it would render (the
      // green dot, "Agent active", the tool count) is a frozen snapshot of a
      // build this page no longer talks to. Leaving those up contradicted the
      // "reload this page" banner sitting right next to them, which is exactly
      // the confusing state Seb caught on 2026-08-14.
      // No action button here: the banner already carries the Reload one.
      if (A.staleExtension) {
        if (dot) dot.className = "off";
        toneClass = "warn"; warn = true;
        msg = `<b>Disconnected</b> — reload this page (F5)`;
      }
      // Show "Starting…" for the whole bootstrap. If the user actually leaves for
      // a new (empty) chat, syncSessionState clears A.starting, so this naturally
      // falls back to that chat's own state - no fragile per-key check here (fresh
      // chats share a key, and the conversation id only appears mid-bootstrap).
      else if (A.starting) {
        toneClass = "starting";
        indicator = `<span class="rs-spin"></span>`;
        const _engineStarting = currentEngine === "local" ? "AgentScript" : "Roblox";
        msg = `Starting ${_engineStarting} agent…`;
        label = "Starting…"; kind = "starting"; disabled = true;
      } else if (A.started) {
        // Prefer the ADVERTISED list length (A.toolList - the AGGREGATE catalogue
        // across every connected MCP server, already filtered by the vision/blocked
        // gate so it matches what the model actually has: e.g. screen_capture is
        // absent on non-vision providers like Kimi). After a page reload A.toolList
        // is empty until the next list_tools, so fall back to the sum of every
        // server's per-server health count (Roblox + addons like Blender) - NOT the
        // Roblox-only count, which made the total drop to just 27 after a reload.
        const healthTotal = A.bridge &&
          (A.bridge.servers || []).reduce((n, x) => n + (x.tools || 0), 0);
        const tools = A.toolList.length || healthTotal || (A.bridge && A.bridge.tools) || 0;
        // "N tools" only means StudioMCP itself is up - it advertises its full
        // catalogue even with no Studio/place attached (see probe_studio() in
        // bridge.py), so showing it while Studio/place isn't actually usable
        // reads as "everything's fine" when tool calls will just fail. Surface
        // the real blocker instead in that case.
        const _isUnrealStarted = false;
        const _isLocalStarted = currentEngine === "local";
        if (A.bridge && A.bridge.connected === false) {
          // placeDown/appDown/studioDown are all false in this case (they're
          // only computed when the bridge IS connected - see setStatus), so
          // without this check the bridge dropping fell through to the
          // stale "N tools" text below, reading as if nothing was wrong.
          toneClass = "warn"; warn = true;
          msg = `<b>Agent running</b> — bridge is down, run ${RUN_CMD}`;
        } else if (_isLocalStarted) {
          if (placeDown || appDown || studioDown) {
            toneClass = "warn"; warn = true;
            msg = `<b>Agent running</b> — AgentScript is offline, start bin/or-core.exe`;
          } else {
            toneClass = "active";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
          }
        } else if (_isUnrealStarted) {
          if ((placeDown || appDown || studioDown) && addonOk) {
            toneClass = "warn";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""} — engine offline`;
          } else if (placeDown || appDown || studioDown) {
            toneClass = "warn"; warn = true;
            msg = `<b>Agent running</b> — open Roblox Studio and enable its MCP server`;
          } else {
            toneClass = "active";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
          }
        } else if ((placeDown || appDown || studioDown) && addonOk) {
          // DEGRADED session by CHOICE: the user started the agent with Roblox
          // down but other MCP server(s) alive (the "Start agent (Roblox
          // offline)" path) - they may only want the addon tools (e.g. Blender).
          // Keep the YELLOW dot as the honest health signal, but do NOT keep the
          // red imperative "open Roblox Studio" nag on screen for the whole
          // session (warn=false → no rs-state-warn red text). The full nag
          // still shows when NO server is usable (the branches below).
          toneClass = "warn";
          msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""} — Roblox offline`;
        } else if (placeDown) {
          toneClass = "warn"; warn = true;
          msg = `<b>Agent running</b> — open a place in Studio`;
        } else if (appDown || studioDown) {
          toneClass = "warn"; warn = true;
          msg = studioProcUp
            ? `<b>Agent running</b> — Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b>`
            : `<b>Agent running</b> — open Studio and enable its MCP server`;
        } else {
          toneClass = "active";
          // No inline dot here: the leading status dot already shows green, two
          // dots side by side looked cluttered. The green "Agent active" text
          // carries it.
          msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
        }
        // Started chat — also offer Restart in the exact Start slot so user can
        // re-bootstrap mid-chat in either engine.
        {
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = false; // Keep Start clickable so it can surface the live bridge error instead of looking dead.
        }
      } else if (P.isFreshChat() || P.chatIsEmpty()) {
        // Treat ANY empty chat (no turns yet) as the standby/start case - not just
        // the strict fresh-chat match. isFreshChat() also requires an exact root
        // path AND the editor already mounted; on a cold load (e.g. arriving from a
        // search-engine link) the SPA can show pathname/editor before they settle,
        // which used to drop into the discouraging "No agent here" branch on a page
        // that is actually empty and startable. "No agent here" is only correct for
        // an EXISTING conversation (one that has turns) we did not start.
        if (bridgeOk) {
          toneClass = "standby";
          msg = `Ready — Start to drive Studio, or just chat.`;
          label = "▶︎ Start Agent"; kind = "start";
        } else if (addonOk) {
          // Primary engine is down but another MCP server is live: allow a DEGRADED start
          // (yellow). The agent runs on the other server(s); primary tools stay
          // unavailable until it's back. Button enabled, but visibly warned.
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `<b>Unreal offline</b> - start with your other MCP server(s).`;
          } else {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : studioProcUp
                ? `<b>Studio open but not connected</b> - open <b>Assistant Settings &gt; MCP Servers</b> in Studio, or start without it.`
                : `<b>Roblox Studio offline</b> - start with your other MCP server(s).`;
          }
          label = "▶︎ Start agent (engine offline)"; kind = "start-degraded";
        } else {
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          } else {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : placeDown
                ? `Open a <b>place</b> in Roblox Studio.`
                : (appDown || studioDown) && studioProcUp
                  ? `Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b> in Studio.`
                  : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          }
          label = "▶︎ Start Agent"; kind = "start";
        }
        disabled = false; // Keep Start clickable so it can surface the live bridge error instead of looking dead.
        } else {
        // Existing chat with no session: offer Restart in place of Start
        // so the AI will work mid-conversation (user request). Engine-aware
        // always occupies the same slot as Start for muscle-memory.
        const canRestart = bridgeOk || addonOk;
        if (canRestart) {
          toneClass = "standby";
          msg = `No agent on this chat. Restart to start <b>Roblox</b>.`;
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = false;
        } else {
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          } else {
            if (!A.bridge.connected) {
              msg = `Run <b>${RUN_CMD}</b>.`;
            } else if (placeDown) {
              msg = `Open a <b>place</b> in Roblox Studio.`;
            } else if ((appDown || studioDown) && studioProcUp) {
              msg = `Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b> in Studio.`;
            } else {
              msg = `Open <b>Roblox Studio</b> and enable its MCP server.`;
            }
          }
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = true;
        }
      }
      // Engine readiness gate: only meaningful when the bridge is up — with the
      // agent offline the proc flags are stale, and the bridge-down branches
      // above already show the right "run bin/or-core.exe" message.
      if (A.bridge && A.bridge.connected && currentEngine !== "local") {
        const curUp = robloxProcUp;
        if (!curUp && (kind === "start" || kind === "start-degraded" || kind === "restart")) {
          toneClass = "warn"; warn = true;
          msg = currentEngine === "unreal"
            ? `Open <b>Roblox Studio</b> to use OR.`
            : `Open <b>Roblox Studio</b> to use OR.`;
          disabled = true;
        }
      }
      // Parked on visibility: the loop is alive but deliberately frozen because
      // this tab is not the foreground tab of its window. Say so explicitly -
      // otherwise the bar keeps claiming "Agent active" while nothing advances,
      // which reads as a hang (and is what users reported as "it died in the
      // background"). No red warn tone: this is a normal, recoverable pause.
      if (A.parked && (A.running || A.starting)) {
        toneClass = "warn"; warn = false;
        msg = `<b>Paused</b> — this tab is in the background. Bring it forward to continue.`;
      }
      // Provider mode guard: some sites (e.g. Arena) only work in one chat mode.
      // When the provider reports the current mode is unsupported, override the
      // bar into a visible warning and disable Start until the user switches back.
      // Skipped once a session is started/starting (the mode is fixed for the
      // conversation by then). Reactive: renderBar runs on every sweep, so the
      // warning appears/clears the instant the user changes the mode dropdown.
      if (!A.started && !A.starting && P.modeWarning) {
        const modeWarn = P.modeWarning();
        if (modeWarn) {
          toneClass = "warn"; warn = true; msg = modeWarn;
          if (kind === "start" || kind === "start-degraded" || kind === "restart") disabled = true;
        }
      }
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Before a session is started, the bar stays minimal: only the Start action
      // + Discord (help). The AI selector and the tips/support menu appear once the
      // agent is actually running - so the pre-start bar isn't cluttered with
      // options that only matter mid-session. (A.started is ambiguous with `warn`
      // tone - which occurs both started-with-bridge-down and standby-with-bridge-
      // down - so it's tracked explicitly in the signature.)
      const showExtras = !!A.started;
      // HARD GATE: Start / Restart are only clickable once or-core.exe is up
      // (bridge WebSocket connected). Without the bridge nothing can start, so
      // a live button would only produce a "start or-core first" toast.
      const coreReady = !!(A.bridge && A.bridge.connected === true);
      const startKind = kind === "start" || kind === "start-degraded" || kind === "restart";
      if (!A.starting && startKind && !coreReady) disabled = true;
      const sig = [toneClass, indicator, msg, label, kind, disabled, warn, busy, showExtras, coreReady].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. rs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      stateEl.innerHTML = indicator + `<span class="rs-state-txt">${msg}</span>`;
      stateEl.classList.toggle("rs-state-warn", warn);
      // Inline dynamic status pill — RS/US Connected, Simulated, Offline
      try {
        const pill = root.querySelector("#rs-status-pill");
        const dot = pill && pill.querySelector(".rs-status-dot");
        const txt = pill && pill.querySelector(".rs-status-text");
        if (pill && txt) {
          const isUnreal = false;
          const isSim = false;
          const procUp = robloxProcUp;
          const isConnected = A.bridge && A.bridge.roblox_connected;
          const legacyConnected = !!(A.bridge && (A.bridge.studio === true || A.bridge.connected === true));
          const wsConnected = isConnected !== undefined ?  isConnected : legacyConnected;
          const connected = wsConnected && procUp;
          pill.hidden = false;
          pill.classList.remove("rs-status-connected", "rs-status-simulated", "rs-status-offline");
          if (isSim) {
            pill.classList.add("rs-status-simulated");
            txt.textContent = "Simulated";
            if (dot) dot.className = "rs-status-dot";
          } else if (connected) {
            pill.classList.add("rs-status-connected");
            txt.textContent = currentEngine === "local" ? "AS Connected" : "RS Connected";
            if (dot) dot.className = "rs-status-dot";
          } else {
            pill.classList.add("rs-status-offline");
            txt.textContent = "Offline - run bin/or-core.exe";
            if (dot) dot.className = "rs-status-dot";
          }
        }
      } catch {}
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.title = !coreReady && startKind
        ? "Start or-core.exe (ORscript Desktop) first"
        : (kind === "restart" ? "Restart the agent" : actionBtn.title);
      actionBtn.disabled = disabled;
      actionBtn.classList.toggle("rs-needs-core", startKind && !coreReady);
      actionBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
      // Tooltip shows the target engine without stretching the button text
      try {
      if (kind === "restart") actionBtn.title = currentEngine === "local" ? "Restart AgentScript agent" : "Restart Roblox agent";
      else if (kind === "start" || kind === "start-degraded") actionBtn.title = currentEngine === "local" ? "▶︎ Start AgentScript agent" : "▶︎ Start OR agent";
        else actionBtn.title = "";
      } catch {}
      // Context meter: approximate system-prompt cost beside Start/Restart so
      // users see what this engine+site combination actually spends.
      try {
        const cEl = root.querySelector("#rs-ctx");
        if (cEl) {
          const si = A.sysInfo;
          const relevant = kind === "start" || kind === "start-degraded" || kind === "restart";
          cEl.hidden = !(si && si.tokens && relevant);
          if (!cEl.hidden) {
            const k = si.tokens / 1000;
            cEl.textContent = (k >= 1 ? k.toFixed(1).replace(/\.0$/, "") + "k" : String(si.tokens)) + " tok";
            const budget = P.sysMaxChars || 18000; // chars before compact/limits kick in
            const ratio = si.len / budget;
            cEl.classList.toggle("warn", ratio >= 0.7 && ratio < 1);
            cEl.classList.toggle("high", ratio >= 1);
            cEl.title = `System prompt \u2248 ${si.tokens.toLocaleString()} tokens (${si.len.toLocaleString()} chars)\nEngine: ${si.engine.toUpperCase()}${P.sysMaxChars ? " · site budget " + P.sysMaxChars + " chars" : ""}\nLower = faster, cheaper replies. Custom prompt & thinking level add to this.`;
          }
        }
      } catch {}
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector + tips/support: only once a session is live. Discord stays
      // visible in every state (it's the help link).
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { try{updateExtraButton();}catch{}; renderBar(); }
    function setStarting() { try{updateExtraButton();}catch{}; renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      try { window.__rsBlender = () => !!(s && s.blender); } catch {}
      // AgentScript ground truth from the agent process itself. Re-render the
      // open session panel so the Danger-zone toggle mirrors the agent.
      try {
        if (typeof s.local_full === "boolean") {
          const prev = typeof window.__rsFullAccess === "function" ? window.__rsFullAccess() : null;
          window.__rsFullAccess = () => s.local_full;
          if (prev !== s.local_full && activeEngine() === "local" && cardsPanel && !cardsPanel.hidden) {
            renderCards(cardsPanel);
          }
        }
      } catch {}
      if (!dot) return;
      const servers = s.servers || [];
      // Engine-aware primary across all three engines. Background's `engine` is
      // authoritative; fall back to the UI's currentEngine while status is in flight.
      const eff = (s.engine === "local" || currentEngine === "local") && s.engine !== "roblox"
        ? "local" : "roblox";
      const isUnreal = false;
      const isLocal = eff === "local";
      const primaryId = eff;
      const primary = servers.find((x) => x.id === primaryId);
      const primaryTools = primary ?  (primary.tools || 0) : (s.tools || 0);
      // The local bridge/helper can be alive without an editor. Only the
      // editor-backed probe is allowed to make the primary server usable.
      const editorConnected = isUnreal ? s.unreal_connected === true
        : isLocal ? (s.local_connected === true || (!!primary && primary.alive === true))
        : s.roblox_connected === true;
      const mcpOk = !!s.connected;
      const totalTools = servers.reduce((n, x) => n + (x.tools || 0), 0) || s.tools || primaryTools;
      // studio === false means the engine's MCP/RemoteExecution answered but the
      // editor is not USABLE (no place/level). Same tri-state for both engines.
      const studioOff = mcpOk && !editorConnected;
      const noApp = studioOff && s.studioApp === false;
      const noPlace = studioOff && s.studioApp === true;
      const ok = mcpOk && editorConnected;
      dot.className = s.connected ?  (ok ?  "on" : "warn") : "off";
      const procUp = s.studioProc === true;
      let txt;
      if (!s.connected) txt = `Bridge offline, run ${RUN_CMD}`;
      else if (!mcpOk) txt = isUnreal ?  "Bridge OK, open Unreal Editor 5.8" : isLocal ? "Bridge OK — AgentScript workspace ready" : "Bridge OK, open Roblox Studio";
      else if (isLocal) txt = ok ? `Connected · ${totalTools} tools ready` : "AgentScript not ready - start bin/or-core.exe";
      else if (noPlace) txt = isUnreal ?  "Unreal Editor is open but no level is loaded - open a level" : "Roblox Studio is open but no place is loaded - open a place";
      else if (noApp) txt = procUp
        ? (isUnreal ?  "Editor is open but not connected - enable Python Remote Execution (Edit > Plugins > Python)" : "Studio is open but not connected - in Studio, open Assistant Settings > MCP Servers (or toggle its MCP server off/on)")
        : (isUnreal ?  "Unreal Editor not connected - open it and enable Remote Execution" : "Roblox Studio not connected - open it and enable its MCP server");
      else if (studioOff) txt = isUnreal ?  "Editor not connected, enable Remote Execution" : "Studio not connected, enable the MCP server in Roblox Studio";
      else txt = `Connected · ${totalTools} tools ready`;
      dot.title = txt;
      bridgeOk = ok;
      studioDown = studioOff;
      placeDown = noPlace;
      appDown = noApp;
      studioProcUp = procUp;
      if (typeof s.robloxProc === "boolean") robloxProcUp = s.robloxProc;
      else if (!isUnreal && typeof s.studioProc === "boolean") robloxProcUp = s.studioProc;
      if (typeof s.unrealProc === "boolean") unrealProcUp = s.unrealProc;
      else if (isUnreal && typeof s.studioProc === "boolean") unrealProcUp = s.studioProc;
      // Auto-follow the open editor, but NEVER fight a recent manual toggle:
      // only switch when the bridge is up, the current engine's app is closed,
      // the other one is open, and the user hasn't clicked the toggle in a while.
      try {
        // NEVER auto-switch out of AgentScript: there is no "other app" heuristic
        // for a folder, and flipping to roblox/unreal stole AS sessions silently.
        if (false && s.connected && engineApi && currentEngine !== "local" && Date.now() - lastManualEngineAt > 20000) {
          /* auto-switch between editors removed — Unreal engine is gone */
        }
      } catch {}
      // A non-primary MCP (e.g. Blender when Roblox is primary, or vice-versa) that is
      // actually alive. Lets a DEGRADED session start on the other engine.
      addonOk = !!s.connected && servers.some((x) => x.id !== primaryId && x.alive && (x.tools || 0) > 0);
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      // Once the bridge has connected at least once, onboarding is done: never
      // resurface the "download the bridge" setup card again (otherwise, if the
      // bridge later drops, it would reappear on top of the bridge-lost banner).
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ rsSetupSeen: true }); } catch {}
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // The page outlived its extension build (reload / Chrome auto-update /
    // disable+enable). Distinct from bridgeAlert on purpose: opposite cause,
    // opposite fix, and this one NEVER self-heals, so the banner has no Close
    // button and offers the reload directly rather than telling the user to go
    // restart a bridge that was never down.
    function staleExtensionAlert() {
      // Latch it BEFORE painting, so the bar drops its frozen "Agent active ·
      // N tools" in the same pass and never contradicts the banner.
      A.staleExtension = true;
      renderBar();
      if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
      if (root.querySelector(".rs-banner.rs-stale")) return;
      const b = document.createElement("div");
      b.className = "rs-banner limit rs-stale";
      b.innerHTML = `<div class="rs-banner-t">⚠ Need a refresh</div>
        <div class="rs-banner-m">This tab's running an old version after the extension updated — commands won't go through anymore. Studio and the bridge are fine, just reload this page.</div>
        <div class="rs-banner-acts"><button class="rs-banner-reload">Reload page</button></div>`;
      b.querySelector(".rs-banner-reload").addEventListener("click", () => location.reload());
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) {
      if (!on) {
        if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
        return;
      }
      if (bridgeBannerEl) return; // already shown
      const b = document.createElement("div");
      b.className = "rs-banner limit";
      // The setup tutorial lives INSIDE this banner (not as a separate card) so it
      // can never overlap the alert - the previous standalone onboarding card did.
      b.innerHTML = `<div class="rs-banner-t">⚠ Bridge went down</div>
        <div class="rs-banner-m">Bridge stopped. Just run ${RUN_CMD} again (keep Studio open) — it'll hop back on automatically when it's back.</div>
        <div class="rs-banner-acts"><button class="rs-banner-video" id="rs-banner-tut">◇ Tutorial</button><button class="rs-banner-x">Close</button></div>`;
      b.querySelector("#rs-banner-tut").addEventListener("click", () => openTutorial());
      b.querySelector(".rs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled " Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = " Stopping…";
      renderBar();
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable Roblox control.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        toast("Hit Start if you want the AI to drive Studio.");
      }
      if (!actionBtn) return;
      actionBtn.classList.add("rs-flash");
      setTimeout(() => actionBtn.classList.remove("rs-flash"), 1200);
    }

    // ── Theme auto-detection (light / dark) ─────────────────────────────────
    // The panel and the in-conversation chips are dark-themed by default. On a
    // LIGHT host page the chips' light text on a near-transparent tint becomes
    // invisible, so we detect the page's effective background luminance and add
    // `.rs-light` to <html>; overlay.css then flips to readable light colours.
    // Most chat sites declare their theme EXPLICITLY (a `dark`/`light` class on
    // <html>/<body>, a data-theme attribute, or CSS color-scheme) - far more
    // reliable than luminance, since many (e.g. z.ai) leave <html>/<body> with a
    // transparent background and paint the theme on a deeper container. Returns
    // "light" | "dark" | null (no explicit signal).
    function pageThemeHint() {
      const de = document.documentElement, b = document.body;
      const cls = (de.className + " " + (b ?  b.className : "")).toLowerCase();
      if (/\bdark\b/.test(cls)) return "dark";
      if (/\blight\b/.test(cls)) return "light";
      const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                    de.getAttribute("data-color-scheme") || "").toLowerCase();
      if (/dark/.test(attr)) return "dark";
      if (/light/.test(attr)) return "light";
      const cs = (getComputedStyle(de).colorScheme || "").toLowerCase();
      if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
      if (/light/.test(cs) && !/dark/.test(cs)) return "light";
      return null;
    }
    // Fallback only: luminance of the first opaque background up the tree.
    function effectiveBg() {
      let n = document.body;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor || "rgb(255,255,255)";
    }
    function applyTheme() {
      let light;
      const hint = pageThemeHint();
      if (hint) {
        light = hint === "light";
      } else {
        const m = (effectiveBg().match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (m.length < 3) return;
        light = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
      }
      document.documentElement.classList.toggle("rs-light", light);
    }

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      try {
        const m = P.barMount();
        return (m && m.parent && m.parent.isConnected) ? m : null;
      } catch (e) { try { log("barMount threw", e); } catch {} return null; }
    }

    // Persistent UI must live in space owned by ORscript, never in the message
    // viewport. Anchored providers cannot accept foreign DOM inside their
    // React/Vue/Angular composer, so the bar stays in #rs-root while this code
    // reserves an equally tall strip at the TOP of the composer. The fixed bar
    // is then painted only inside that strip. This is layout reservation, not a
    // transparent overlay: the host's editor, controls, and final response all
    // reflow away from the ORscript surface.
    const BAR_GAP = 6;
    const TRAY_MIN_ABOVE = 140; // px of room above the bar below which a tray falls back below it
    let trayRoomPx = null;

    // Save inline declarations byte-for-byte (including !important). Clearing a
    // property with `style.foo = ""` destroyed host-authored inline layout on SPA
    // composers, so every property we borrow is restored to its exact prior form.
    function rememberInline(el, props) {
      const values = {};
      for (const prop of props) values[prop] = {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      };
      return { el, values };
    }
    function restoreInline(saved) {
      if (!saved || !saved.el) return;
      try {
        for (const [prop, old] of Object.entries(saved.values)) {
          if (old.value) saved.el.style.setProperty(prop, old.value, old.priority || "");
          else saved.el.style.removeProperty(prop);
        }
      } catch {}
    }

    let anchorPad = null, inlineWiden = null;
    function clearAnchorReserve() {
      if (anchorPad) restoreInline(anchorPad.saved);
      anchorPad = null;
      if (P.reserveBarSpace) { try { P.reserveBarSpace(null, 0); } catch {} }
    }
    function clearInlineWiden() {
      if (inlineWiden) restoreInline(inlineWiden.saved);
      inlineWiden = null;
    }
    function clearAnchorPad() {
      clearAnchorReserve();
      clearInlineWiden();
    }

    function reserveAnchorStrip(anchorEl, occupiedHeight) {
      if (!anchorEl || !anchorEl.isConnected) return null;
      if (!anchorPad || anchorPad.el !== anchorEl) {
        clearAnchorReserve();
        let cs;
        try { cs = getComputedStyle(anchorEl); } catch { return null; }
        const r = anchorEl.getBoundingClientRect();
        const px = (v) => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0;
        anchorPad = {
          el: anchorEl,
          saved: rememberInline(anchorEl, ["padding-top", "min-height"]),
          basePadding: px(cs.paddingTop),
          baseOuterHeight: r.height,
          borderBox: cs.boxSizing === "border-box",
          borderTop: px(cs.borderTopWidth),
          borderLeft: px(cs.borderLeftWidth),
          borderRight: px(cs.borderRightWidth),
          occupied: -1,
        };
      }

      const occupied = Math.max(0, Math.ceil(occupiedHeight));
      if (anchorPad.occupied !== occupied) {
        // Use !important because several providers ship utility padding classes
        // with !important. We restore the original declaration and priority when
        // the anchor changes or the ORscript surface is hidden.
        anchorEl.style.setProperty("padding-top", `${anchorPad.basePadding + occupied}px`, "important");
        // With border-box composers, adding padding can otherwise SHRINK the
        // editable area under an explicit height. Raising min-height preserves
        // the original content room while adding our reserved strip.
        if (anchorPad.borderBox && anchorPad.baseOuterHeight > 0) {
          anchorEl.style.setProperty("min-height", `${Math.ceil(anchorPad.baseOuterHeight + occupied)}px`, "important");
        }
        anchorPad.occupied = occupied;
      }
      return anchorPad;
    }

    function widenInlineCard(card) {
      if (!card || !card.isConnected) return;
      if (!inlineWiden || inlineWiden.el !== card) {
        clearInlineWiden();
        inlineWiden = {
          el: card,
          saved: rememberInline(card, ["max-width", "width", "margin-left", "margin-right"]),
        };
      }
      const w = card.getBoundingClientRect().width;
      if (w && w < 800) {
        card.style.maxWidth = "900px";
        card.style.width = "100%";
        card.style.marginLeft = "auto";
        card.style.marginRight = "auto";
      }
    }

    // Inline unstable pill lives inside the bar — no floating positioning needed.
    // Keep it visible when the bar is visible and the provider is marked unstable.
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      // If it's the inline pill, just ensure it reflects P.unstableWarning and bar visibility
      if (u.id === "rs-unstable-inline") {
        const shouldShow = !!P.unstableWarning && bar && bar.style.display !== "none" && bar.getBoundingClientRect().width > 0;
        u.hidden = !shouldShow;
        return;
      }
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      u.style.left = Math.round(br.left) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    // Session/cards control lives in the status row; this lightweight upkeep
    // replaces the old fixed-position FAB geometry loop.
    let fabActivityTick = 0;
    function refreshCardsControl() {
      if (!cardsBtn || !bar) return;
      // The control now participates in the bar's reserved layout. Keep it glued
      // to the right cluster if a host re-render or an old session detached it;
      // never assign fixed viewport coordinates.
      const right = bar.querySelector(".rs-cluster-right");
      if (right && cardsBtn.parentElement !== right) {
        try { right.insertBefore(cardsBtn, supportBtn || right.firstChild); } catch {}
      }
      cardsBtn.style.display = bar.style.display === "none" ? "none" : "";
      cardsBtn.style.removeProperty("left");
      cardsBtn.style.removeProperty("top");
      // Keep Activity timestamps/results fresh while the panel sits open
      // (AgentScript session view refreshes too — its "ago" stamps go stale).
      if (cardsPanel && !cardsPanel.hidden && (cardsTab === "activity" || activeEngine() === "local") && recentCards.length) {
        fabActivityTick++;
        if (fabActivityTick % 300 === 0) renderCards(cardsPanel);
      }
    }

    function setMenuOpen(open, toSupport) {
      if (!menuEl) return;
      open = !!open;
      const wasOpen = !menuEl.hidden;
      menuEl.hidden = !open;
      if (open && !wasOpen) { try { playSfx("click"); } catch {} }
      menuEl.classList.add("rs-menu-top");
      if (bar) {
        bar.classList.toggle("rs-menu-open", open);
        bar.classList.toggle("rs-menu-contained", open);
        if (open) {
          // The settings tray and cards panel share one in-layout expansion lane.
          // Closing the other surface avoids stacked controls and keeps the
          // reserved composer strip bounded.
          if (cardsPanel) cardsPanel.hidden = true;
          bar.classList.remove("rs-cards-open");
          hideCardEmbed();
          hideSetup();
        }
        if (open && menuEl.parentElement !== bar) {
          try { bar.appendChild(menuEl); } catch {}
        }
      }
      if (supportBtn) {
        supportBtn.setAttribute("aria-expanded", open ? "true" : "false");
        supportBtn.classList.toggle("on", open);
      }
      if (open) {
        buildMenu();
        syncMenuPrompt();
        requestAnimationFrame(() => {
          if (!menuEl.hidden) menuEl.scrollTop = toSupport ? menuEl.scrollHeight : 0;
        });
      }
    }
    // Height of an open ORscript control surface below the status row. These
    // panels are positioned inside the composer's reserved padding, so their
    // exact rendered height must participate in collision geometry.
    function expandedSurfaceHeight() {
      const menuOpen = !!(menuEl && !menuEl.hidden);
      const cardsOpen = !!(cardsPanel && !cardsPanel.hidden);
      const embedOpen = !!(cardEmbedEl && !cardEmbedEl.hidden);
      const setupOpen = !!(setupCard && !setupCard.hidden);
      if (bar) {
        bar.classList.toggle("rs-menu-contained", menuOpen);
        bar.classList.toggle("rs-cards-open", cardsOpen);
        bar.classList.toggle("rs-card-embed-open", embedOpen);
        bar.classList.toggle("rs-setup-open", setupOpen);
      }
      const surface = menuOpen ? menuEl : (cardsOpen ? cardsPanel : (embedOpen ? cardEmbedEl : (setupOpen ? setupCard : null)));
      const h = surface ? (surface.offsetHeight || 0) : 0;
      // Trays open ABOVE the bar, overlaying the transcript, so they take no
      // composer space. The room between the viewport top and the bar is
      // published as --rs-room-above and the CSS clamps the tray to it, so a
      // vertically centred composer (empty DeepSeek chat) still gets the tray
      // above - just shorter, scrolling inside. Only when that room is smaller
      // than TRAY_MIN_ABOVE (a tiny window) does the tray fall back below the
      // bar (rs-tray-below), and only then does its height join the reserved
      // strip.
      let room = Infinity;
      if (bar) { try { room = Math.max(0, bar.getBoundingClientRect().top - (BAR_GAP + 8)); } catch {} }
      const below = h > 0 && room < TRAY_MIN_ABOVE;
      if (bar) {
        bar.classList.toggle("rs-tray-below", below);
        const px = Number.isFinite(room) ? Math.round(room) + "px" : "";
        if (px !== trayRoomPx) { trayRoomPx = px; try { bar.style.setProperty("--rs-room-above", px); } catch {} }
      }
      return below ? h : 0;
    }

    // Keep-visible fallback: a slim floating bar docked to the BOTTOM of the
    // viewport (never over the composer, never floated above transcript text).
    // Used while a provider's real composer is not resolvable - Notion mounts
    // its full-page AI editor seconds after the shell, and on non-AI Notion
    // pages the bar has to stay on screen to tell the user where to go.
    function dockBarAtViewportBottom() {
      bar.classList.remove("rs-bar-inline", "rs-bar-inside", "rs-bar-anchored", "rs-bar-docked");
      bar.classList.add("rs-bar-float");
      if (root && bar.parentElement !== root) root.appendChild(bar);
      clearAnchorReserve();
      bar.style.display = "flex";
      const bh = bar.offsetHeight || 44;
      const bw = bar.offsetWidth || Math.min(window.innerWidth - 24, 720);
      bar.style.width = "";
      bar.style.left = Math.max(4, Math.round((window.innerWidth - bw) / 2)) + "px";
      bar.style.top = Math.max(4, Math.round(window.innerHeight - bh - 14)) + "px";
      bar.style.borderRadius = "";
      return true;
    }

    function dockBarInReservedStrip(anchorEl, modeClass) {
      if (!anchorEl || !anchorEl.isConnected) return false;
      bar.classList.remove("rs-bar-inline", "rs-bar-inside", "rs-bar-float", "rs-bar-anchored", "rs-bar-docked");
      bar.classList.add(modeClass);
      if (root && bar.parentElement !== root) root.appendChild(bar);

      let r = anchorEl.getBoundingClientRect();
      if (!r.width) return false;
      bar.style.display = "flex";
      const bh = bar.offsetHeight || 44;
      const expanded = expandedSurfaceHeight();
      const occupied = bh + BAR_GAP + (expanded ? expanded + BAR_GAP : 0);
      // Immutable providers (Notion) reserve the strip through their own
      // stylesheet so the framework-owned composer attributes stay untouched.
      // When the provider declines (e.g. its own placeholder anchor on a page
      // without a composer) the bar falls back to the inline reservation and
      // is still seated INSIDE the reserved strip - never floated over text.
      let reservation = null;
      let providerReserved = false;
      if (P.reserveBarSpace) { try { providerReserved = P.reserveBarSpace(anchorEl, occupied) === true; } catch {} }
      // The provider owns reservation but declined this anchor: it is its own
      // stand-in placeholder (no composer on screen yet). Padding a placeholder
      // reserves nothing real, so keep the bar visible at the viewport bottom.
      if (!providerReserved && P.barOutside && P.reserveBarSpace) {
        if (anchorPad) { restoreInline(anchorPad.saved); anchorPad = null; }
        return dockBarAtViewportBottom();
      }
      if (providerReserved) {
        if (anchorPad) { restoreInline(anchorPad.saved); anchorPad = null; }
        let cs = null;
        try { cs = getComputedStyle(anchorEl); } catch {}
        const px = (v) => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0;
        reservation = {
          borderTop: cs ? px(cs.borderTopWidth) : 0,
          borderLeft: cs ? px(cs.borderLeftWidth) : 0,
          borderRight: cs ? px(cs.borderRightWidth) : 0,
        };
      } else {
        reservation = reserveAnchorStrip(anchorEl, occupied);
      }
      if (!reservation) return false;

      // Re-measure after reservation: flex/sticky composer layouts can move the
      // card when its height grows. The bar follows the final geometry, not the
      // pre-reservation snapshot.
      r = anchorEl.getBoundingClientRect();
      // Off-screen / degenerate strip: report failure so the caller decides
      // (hide on ordinary providers, viewport-bottom dock on keep-visible ones).
      if (!r.width || r.bottom <= 0 || r.top >= window.innerHeight) {
        bar.style.display = "none";
        return false;
      }
      const viewportPad = 4;
      const left = Math.max(viewportPad, r.left + reservation.borderLeft);
      const right = Math.min(window.innerWidth - viewportPad, r.right - reservation.borderRight);
      if (right - left < 80) {
        bar.style.display = "none";
        return false;
      }
      // Never clamp the row into unrelated page content. If the reserved strip
      // itself is off-screen, hide until the composer returns instead.
      const top = r.top + reservation.borderTop;
      if (top < 0 || top + bh > window.innerHeight) {
        bar.style.display = "none";
        return false;
      }
      bar.style.display = "flex";
      bar.style.left = Math.round(left) + "px";
      bar.style.top = Math.round(top) + "px";
      bar.style.width = Math.round(right - left) + "px";
      bar.style.borderRadius = "";
      return true;
    }

    function placeBar() {
      barRaf = requestAnimationFrame(placeBar);
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #rs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // rAF loop is resilient (its next frame is scheduled before any body code),
      // so the panel reappears on the very next frame.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every frame - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();
      refreshCardsControl();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next frame once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        (P.overlayBlocking && P.overlayBlocking())
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (menuEl) menuEl.hidden = true;
        if (cardsPanel) cardsPanel.hidden = true;
        hideCardEmbed();
        bar.classList.remove("rs-menu-contained", "rs-cards-open", "rs-card-embed-open");
        return;
      }

      // Preferred: in-flow mount inside the composer card — integrated look,
      // full width of the chatbox, never floating detached.
      const mount = computeBarMount();
      if (mount) {
        bar.classList.remove("rs-bar-float");
        clearAnchorReserve();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("rs-bar-inline")) {
          bar.classList.add("rs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        bar.classList.toggle("rs-bar-inside", !!mount.inside);
        // Widen the chatbox sides so the bar's pill row fits without overlapping.
        // Exact host inline styles are restored when this mode ends.
        try { widenInlineCard(mount.parent); } catch {}
        bar.style.display = "flex";
        expandedSurfaceHeight();
        return;
      }

      // Anchored mode: keep our DOM outside framework-managed composer trees, but
      // reserve a real strip inside the composer before painting the fixed bar.
      // Nothing is positioned in the transcript above the composer anymore.
      clearInlineWiden();
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        if (!dockBarInReservedStrip(anchorEl, "rs-bar-anchored")) {
          // keep-visible providers (Notion) never lose the bar to a zero-width
          // or off-screen anchor frame - they get the viewport-bottom dock,
          // exactly like the "no composer yet" case below.
          if (P.keepBarVisible) { dockBarAtViewportBottom(); return; }
          bar.style.display = "none";
          clearAnchorReserve();
          if (menuEl) menuEl.hidden = true;
        }
        return;
      }
      bar.classList.remove("rs-bar-anchored");
      clearAnchorReserve();

      // Collision-safe fallback: reserve space in the provider's composer frame
      // (or, as a last resort, its editor) exactly like anchored mode. The old
      // floating fallback painted above the editor and hid the last response.
      let f = null;
      try { f = (P.composerFrame && P.composerFrame()) || null; } catch {}
      if (!f || !f.isConnected) { try { f = (P.getEditor && P.getEditor()) || null; } catch {} }
      if (f && f.isConnected && f.getBoundingClientRect().width) {
        if (!dockBarInReservedStrip(f, "rs-bar-docked")) {
          if (P.keepBarVisible) { dockBarAtViewportBottom(); return; }
          bar.style.display = "none";
        }
        return;
      }

      // Without a live composer there is no safe host-owned region to reserve.
      // Providers whose chat lives on a sub-route of a larger app (Notion) opt
      // in to a bottom-of-viewport bar so the user is never left wondering
      // whether the extension loaded - the bar's warning line says where to go.
      if (P.keepBarVisible) { dockBarAtViewportBottom(); return; }
      // Otherwise hiding briefly during page/login loading is preferable to
      // covering page text with a viewport-fixed fallback; the bar returns on
      // the first frame that the provider exposes its composer.
      bar.classList.remove("rs-bar-float", "rs-bar-docked");
      bar.style.display = "none";
      clearAnchorReserve();
      if (menuEl) menuEl.hidden = true;
      if (cardsPanel) cardsPanel.hidden = true;
      hideCardEmbed();
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // Returns a FULLY OPAQUE colour that matches what is VISUALLY behind the cover.
    // The cover must hide the typed text, so it can't be translucent - but simply
    // returning the first solid ancestor is wrong when the composer surface itself
    // is translucent: Meta's card is rgba(56,56,56,0.8) over a dark page, so its
    // real on-screen colour is a BLEND (~rgb(50,50,50)), lighter than the bare page
    // (rgb(24,24,25)). Filling the cover with the page colour made it visibly
    // darker than the composer. So collect the background layers from `el` up to
    // the first opaque ancestor and FLATTEN them (alpha compositing) into one solid
    // colour that reproduces the composer's actual appearance.
    function opaqueBg(el) {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.999) break; // opaque base reached - nothing behind matters
        }
        n = n.parentElement;
      }
      // Guarantee an opaque base at the bottom of the stack.
      if (!layers.length || layers[layers.length - 1].a < 0.999) {
        const base = parseColor(getComputedStyle(document.body).backgroundColor) ||
                     { r: 255, g: 255, b: 255, a: 1 };
        layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
      }
      // We collected top-most (el) first, so composite from the opaque base (last)
      // upward toward el (first).
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
      return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
    }
    // Parse an rgb()/rgba() computed colour into {r,g,b,a}. Returns null for
    // "transparent"/unparseable. getComputedStyle always yields rgb/rgba form.
    function parseColor(c) {
      if (!c || c === "transparent") return null;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ?  p[3] : 1 };
    }
    // Source-over compositing of a (possibly translucent) fg onto an opaque bg.
    function blendOver(fg, bg) {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    }

    function inputCover(on) {
      const ed = P.getEditor();
      if (!on) {
        if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
        if (ed) ed.classList.remove("rs-typing");
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      ed.classList.add("rs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "rs-input-cover";
        cover.innerHTML = `<span>Agent is working…</span>`;
        document.documentElement.appendChild(cover);
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        const e = P.getEditor();
        if (!e) { coverRaf = requestAnimationFrame(place); return; }
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add every frame keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("rs-typing")) e.classList.add("rs-typing");
        // The cover is SIZED to coverTarget() when a provider supplies one, else
        // to the editor node itself. Some composers (Meta AI) make the editable a
        // tiny line inside a much larger rounded card - covering only the editor
        // left the rest of the card exposed and CLICKABLE (a careful click focused
        // the editor and let the user type behind the cover). Meta returns its
        // whole composer card so the cover blankets the entire input band and its
        // pointer-events:auto blocks every click. The typing mask above still lives
        // on the real editor node `e`.
        const covNode = (P.coverTarget && P.coverTarget()) || e;
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          (P.overlayBlocking && P.overlayBlocking()) ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          coverRaf = requestAnimationFrame(place);
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .rs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        // The SAME clipping applies horizontally, and for the same reason: a
        // composer whose editor is a flex item grows to its content width when a
        // long unbroken line is injected, while an ancestor with overflow-x:hidden
        // keeps the PAGE looking right. Seen on ChatGPT at Start, where the editor
        // is filled with the (large) system prompt: the inner
        // .prosemirror-parent widened past its `-my-2.5 flex overflow-x-hidden`
        // wrapper, so the cover - position:fixed and sized to the raw rect - stuck
        // out to the RIGHT of the composer card. Clip on each axis independently:
        // the ancestor that clips X is not always the one that clips Y.
        let clipY = false, clipX = false;
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
          const st = getComputedStyle(a);
          const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
          const ar = a.getBoundingClientRect();
          if (!clipY && clips(st.overflowY)) {
            clipY = true;
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
          }
          if (!clipX && clips(st.overflowX)) {
            clipX = true;
            const left = Math.max(r.left, ar.left);
            const right = Math.min(r.right, ar.right);
            if (right > left) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never paint outside the composer card. The cover is position:fixed and
        // re-placed every rAF from a freshly measured rect, which is correct while
        // the page is still - but a site that ANIMATES its composer updates layout
        // AFTER our callback, so for the whole animation the cover trails one frame
        // behind. Seen on ChatGPT at Start: injecting the system prompt grows the
        // composer 58px -> 156px, the page gains a scrollbar, the content column
        // narrows and the composer slides 29px left - while the cover kept the
        // previous coordinates and hung 28px past the card's right edge. It only
        // showed on the FIRST send, because afterwards the composer is already
        // docked at the bottom and stops moving. Clamping to the composer frame
        // makes a stale rect impossible to see: worst case the cover is briefly a
        // few px small, which reads as nothing.
        const frame = P.composerFrame && P.composerFrame();
        if (frame) {
          const fr = frame.getBoundingClientRect();
          // Only clamp to a frame that really wraps the cover target, so a provider
          // whose frame is narrower than its editor can never shrink the cover.
          const cx = r.left + r.width / 2;
          if (fr.width > 0 && fr.left <= cx && fr.right >= cx) {
            const left = Math.max(r.left, fr.left);
            const right = Math.min(r.right, fr.right);
            if (right - left > 40) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never blanket the ORscript bar itself. A provider whose coverTarget is
        // the whole composer card (Notion) has the bar seated in the reserved
        // strip at the TOP of that card, so an unclipped cover would hide the
        // Stop button for the whole loop. Trim the cover to start below the bar.
        if (bar && bar.classList.contains("rs-bar-anchored") && bar.style.display !== "none") {
          const br = bar.getBoundingClientRect();
          if (br.height > 0 && br.bottom > r.top && br.top < r.bottom && br.right > r.left && br.left < r.right) {
            const top = Math.min(r.bottom, br.bottom + 2);
            if (r.bottom - top > 20) r = new DOMRect(r.left, top, r.width, r.bottom - top);
          }
        }
        // Optionally overshoot the editor box by PAD px on every side. Some
        // composers (Gemini's Quill) keep typed text near rounded corners, so a
        // cover sized EXACTLY to the editor leaves slivers of text peeking; those
        // providers set coverPad to bleed past the edges. A native <textarea>
        // (DeepSeek) needs none - overshooting there just makes the cover overflow
        // the composer, so it defaults to 0.
        const PAD = P.coverPad || 0;
        // Optional vertical nudge: some composers (Gemini's Quill) report an
        // editor rect that sits a few px below the visual input box centre, so
        // the centred "Agent is working…" text looks low. A provider can shift it.
        const OFFY = P.coverOffsetY || 0;
        // Height is at least MIN_H so the label is readable even over a
        // single-line composer. CENTER the cover on the editor's vertical middle
        // rather than anchoring its TOP to the editor top: a short (e.g. 20px)
        // textarea bumped to 36px would otherwise grow only DOWNWARD, leaving the
        // "Agent is working…" label sitting high in the composer's input band
        // (seen on Cloudflare's 1-line textarea). For a composer already taller
        // than MIN_H the maths reduces to the old `r.top - PAD`, so DeepSeek/Gemini
        // are unchanged.
        // Hard ceiling: even though .rs-typing caps the editor's visual height
        // (see overlay.css), belt-and-suspenders clamp the cover so a composer
        // whose growing element escapes that CSS cap on some provider can never
        // turn the "Agent is working…" cover into a full-page white slab.
        const MAXH = P.coverMaxH || 200;
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = (r.left - PAD) + "px";
        cover.style.top = (centerY - h / 2) + "px";
        cover.style.width = (r.width + PAD * 2) + "px";
        cover.style.height = h + "px";
        // Composite the surface BEHIND the cover target so the fill matches what
        // the user sees (a translucent composer card blends over the page).
        cover.style.background = opaqueBg(covNode);
        // When the cover blankets a whole composer card (coverTarget), match its
        // corner radius so the cover's square corners don't poke past the card's
        // rounded ones. Editor-sized covers keep the CSS default.
        if (P.coverTarget) cover.style.borderRadius = getComputedStyle(covNode).borderRadius;
        coverRaf = requestAnimationFrame(place);
      };
      place();
    }

    function toast(msg) {
      const t = document.createElement("div");
      t.className = "rs-toast";
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => t.classList.add("show"), 10);
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function banner(kind, title, msg) {
      const b = document.createElement("div");
      b.className = `rs-banner ${kind}`;
      b.innerHTML = `<div class="rs-banner-t"></div><div class="rs-banner-m"></div>
        <div class="rs-banner-acts">
          <button class="rs-banner-x">Close</button>
        </div>`;
      b.querySelector(".rs-banner-t").textContent = title;
      b.querySelector(".rs-banner-m").textContent = msg;
      b.querySelector(".rs-banner-x").addEventListener("click", () => b.remove());
      root.appendChild(b);
    }

    // Keep capture previews inside the reserved bar instead of opening a 300px
    // fixed card over the host's left-hand text. The latest shot appears as a
    // real thumbnail control; clicking it opens the full image in a separate tab
    // (a user gesture), so inspecting a capture never blankets chat content.
    function showImages(images, toolName) {
      if (!images || !images.length || !bar) return;
      bar.querySelectorAll(".rs-shot-chip").forEach((e) => e.remove());
      const shot = images[0];
      const mime = shot.mimeType || "image/jpeg";
      const dataUrl = `data:${mime};base64,${shot.data}`;
      const wrap = document.createElement("div");
      wrap.className = "rs-shot-chip";
      wrap.title = `Open ${toolName} capture${images.length > 1 ? ` (${images.length} images)` : ""}`;

      const open = document.createElement("button");
      open.type = "button";
      open.className = "rs-shot-open";
      open.setAttribute("aria-label", `Open ${toolName} screenshot preview`);
      const thumb = document.createElement("img");
      thumb.className = "rs-shot-thumb";
      thumb.alt = "Screenshot preview";
      thumb.src = dataUrl;
      open.appendChild(thumb);
      if (images.length > 1) {
        const count = document.createElement("span");
        count.className = "rs-shot-count";
        count.textContent = String(images.length);
        open.appendChild(count);
      }
      open.addEventListener("click", () => {
        try {
          let blob;
          if (images.length === 1) {
            const raw = atob(shot.data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            blob = new Blob([bytes], { type: mime });
          } else {
            // One user gesture opens one gallery tab, preserving the old preview's
            // ability to inspect every returned image without triggering popup
            // blocking or putting a gallery over the chat.
            const gallery = images.map((img, i) =>
              `<figure><img alt="Capture ${i + 1}" src="data:${img.mimeType || "image/jpeg"};base64,${img.data}"><figcaption>${i + 1} / ${images.length}</figcaption></figure>`
            ).join("");
            blob = new Blob([`<!doctype html><meta charset="utf-8"><title>ORscript captures</title><style>html{color-scheme:dark}body{margin:0;padding:24px;background:#111;color:#ddd;font:13px system-ui}figure{margin:0 0 24px}img{display:block;max-width:100%;height:auto;margin:auto;border-radius:10px}figcaption{text-align:center;margin-top:8px}</style>${gallery}`], { type: "text/html" });
          }
          const url = URL.createObjectURL(blob);
          window.open(url, "_blank", "noopener");
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch {
          try { window.open(dataUrl, "_blank", "noopener"); } catch {}
        }
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "rs-shot-chip-x";
      close.setAttribute("aria-label", "Dismiss screenshot preview");
      close.textContent = "×";
      close.addEventListener("click", () => wrap.remove());
      wrap.appendChild(open);
      wrap.appendChild(close);

      const right = bar.querySelector(".rs-cluster-right");
      if (right) right.insertBefore(wrap, cardsBtn || right.firstChild);
      else bar.appendChild(wrap);
    }

    build();
    return { setStatus, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup, getCustomPrompt, getCustomMemory, getCustomMcpServers, trackCard, hideCardEmbed, steeringProgress, takeSteeringSteering, peekSteeringSteering, clearSteeringSteering, syncSteeringUi, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ?  Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    if (P.immutableTranscript && P.updateImmutableChipDetail) { try { P.updateImmutableChipDetail(item, text); } catch {} return; }
    const dt = item && item.querySelector(".rs-chip .rs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    if (P.immutableTranscript && P.updateImmutableChipLabel) { try { P.updateImmutableChipLabel(item, text); } catch {} return; }
    const tx = item && item.querySelector(".rs-chip .rs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // RobloxScript's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#rs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

let _prevHardGen = null, _prevSoftGen = null;
// Composer-unlock failsafe (v1.12.1, extended in v1.12.2): whatever code path
// leaked the "Agent is working…" cover, the readonly lock, a stuck A.starting
// bootstrap or a stuck A.injecting flag, the user must NEVER be left with a
// frozen composer. Throttled - the checks are cheap but the unlock touches
// provider DOM.
let _lastUnlockSweep = 0;
rsInterval(() => {
    // Failsafe FIRST so a stuck cover can never outlive its owner, even if
    // something below throws.
    if (Date.now() - _lastUnlockSweep > 2000) {
      _lastUnlockSweep = Date.now();
      // Idle: no loop/bootstrap/injection owns the input.
      if (!A.running && !A.starting && !A.injecting) {
        try { ui.inputCover(false); } catch {}
        try { P.setInputLock(false); } catch {}
      }
      // Stuck bootstrap: starting for >120s with no live stream is a wedged
      // startSession (exception outside its try, provider deadlock, a site
      // that ate the prompt). Force-abort it so Start becomes clickable again.
      // A healthy bootstrap NEVER takes this long without generating.
      if (A.starting && A._startingSince && Date.now() - A._startingSince > 120000) {
        try {
          A.startGen++;            // invalidates the in-flight bootstrap
          A.starting = false;
          A.startingKey = null;
          A._startingSince = 0;
          ui.setStarting(false);
          ui.inputCover(false);
          P.setInputLock(false);
          ui.banner("warn", "Start got stuck",
            "The startup didn't finish in 2 minutes and was reset. Try Start again — if it repeats, reload the page.");
          try { diag("start.staleAborted", {}); } catch {}
        } catch {}
      }
      // Stuck injecting: the 400ms post-send clear in submitAndGetBase's
      // finally should have run; >60s means an exception ate it.
      if (A.injecting && A._injectingSince && Date.now() - A._injectingSince > 60000) {
        A.injecting = false;
        try { diag("inject.staleCleared", {}); } catch {}
      }
    }
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #rs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".rs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live OR session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a RS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ?  P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    ui.showStop(A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating()));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "rsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ?  A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ?  P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && RSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = RSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "rsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "rs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, studioApp: msg.studioApp, studioProc: msg.studioProc, robloxProc: msg.robloxProc, roblox_connected: msg.roblox_connected, engine: msg.engine, tools: msg.tools, servers: msg.servers, local_connected: msg.local_connected, local_full: msg.local_full, local_root: msg.local_root, blender: msg.blender, blender_shim: msg.blender_shim, blender_error: msg.blender_error });
    }
    if (msg && msg.type === "rs-open-menu") {
      ui.openMenu(false); // from the popup's Settings button — opens at the top (Switch AI / custom prompt)
    }
  });

  // Status poll. An orphaned content script (see bg / isContextInvalidated) gets
  // a failure object back whose `connected` is undefined, which setStatus would
  // read as "the bridge just dropped" and answer with the red "run bin/or-core.exe"
  // banner - sending the user to fix a bridge that is perfectly healthy, with
  // the one thing that WOULD fix it (reload the page) never mentioned. Catch it
  // before setStatus, say the right thing, and stop polling: the context can
  // never come back, so every later tick would just repeat the same failure.
  let statusTimer = null;
  function onStatus(s) {
    if (!s) return;
    if (s.kind === "stale-extension") {
      if (statusTimer) statusTimer();
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: s.error });
      return;
    }
    ui.setStatus(s);
  }
  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  loadSysCount();
bg({ type: "status" }).then(onStatus);
statusTimer = rsInterval(() => bg({ type: "status" }).then(onStatus), 5000);

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ rsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("rsStartedSessions", (r) => {
      if (r && Array.isArray(r.rsStartedSessions)) {
        for (const p of r.rsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS an OR session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or an OR command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasRsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (txt.includes(RS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###LUA### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / rsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
        ui.clearSteeringSteering();
        ui.steeringProgress("stopped", "Startup left behind with the previous chat", 0);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not OR's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "▶︎ Start OR agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasRsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch and never carry a queued
      // Steering instruction into the chat the user just opened.
      if (lastSyncPath !== null && path !== lastSyncPath) {
        ui.clearSteeringSteering();
        A.steeringStep = 0;
        ui.steeringProgress("idle", "Ready for this conversation", 0);
      }
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("rs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("rs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("rs-hidden")) continue;
      const txt = P.classifyText(item, ".rs-chip");
      if (txt.includes(RS.SYS_MARKER) ||
          (P.isUserItem(item) && RSParse.isInjectedFeedback(txt))) {
        item.classList.add("rs-hidden");
      }
    }
  }
  let scopedMutationObserver = null;
  let observedChatRoot = null;
  // 1.21.4: providers with a cached transcript model (Notion keeps allItems()
  // for 15 s) MUST be told about mutations, exactly as PlazCode's observer did
  // (P.ignoreMutationRecords / P.invalidateItems / P.preprocessMutations).
  // Without these hooks a new Notion reply stayed invisible to the response
  // watcher for up to 15 s: the loop finalized on the PREVIOUS turn, ran its
  // command a second time, and the chat looked dead afterwards.
  function feedProviderMutations(records) {
    try {
      if (records && records.length && P.ignoreMutationRecords && P.ignoreMutationRecords(records)) return false;
      if (P.invalidateItems) P.invalidateItems(records);
      if (records && records.length && P.preprocessMutations) {
        P.preprocessMutations(records, { active: !!(A.started || A.starting || A.running) });
      }
    } catch (e) { diag("observer.providerHookFailed", { error: String((e && e.message) || e) }); }
    return true;
  }
  const pageShellObserver = new MutationObserver((records) => {
    feedProviderMutations(records);
    bindScopedObserver();
    scheduleSweep();
  });
  function chatObservationRoot() {
    try {
      const items=P.allItems();
      const frame=(P.composerFrame&&P.composerFrame())||null;
      const first=items.length&&items[0].parentElement||null;
      // 1.21.4: observe the subtree that holds BOTH the transcript and the
      // composer. Observing only the composer's parent on an empty chat (or
      // only the transcript parent) left the first Notion reply unobserved:
      // the provider's cached item list never saw it, and the bootstrap sat
      // for the full 15 s cache TTL before "Starting" could progress.
      if(first&&frame){let n=first;while(n&&n!==document.documentElement&&!n.contains(frame))n=n.parentElement;if(n&&n!==document.documentElement)return n;}
      if(first)return first;
      if(frame){const main=frame.closest("main,[role='main'],[role='region']");return main||frame.parentElement||null;}
      return null;
    } catch { return null; }
  }
  function bindScopedObserver() {
    const next=chatObservationRoot();
    if(!next||next===observedChatRoot)return;
    if(scopedMutationObserver)scopedMutationObserver.disconnect();
    observedChatRoot=next;
    scopedMutationObserver=new MutationObserver((records)=>{if(!feedProviderMutations(records))return;preHideWholeItems();scheduleSweep();});
    scopedMutationObserver.observe(next,{childList:true,subtree:true,characterData:true});
    // Rows that appeared while the old root did not cover them were never
    // reported: drop the provider's cached transcript model once per rebind.
    try { if (P.invalidateItems) P.invalidateItems(); } catch {}
    diag("observer.rebound",{provider:P.id,tag:next.tagName});
  }
  // Watch only direct page-shell replacements; message mutations are observed
  // on the nearest chat/composer subtree. This avoids a permanent whole-document
  // subtree observer and rebinds safely after SPA navigation.
  pageShellObserver.observe(document.body||document.documentElement,{childList:true});
  bindScopedObserver();
  rsInterval(()=>{bindScopedObserver();scheduleSweep();},1500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  try {
    if (typeof P.installSendHooks !== "function") throw new Error("provider adapter has no installSendHooks() function");
    P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => {
      let steering = false;
      try { steering = A.running && window.__rsSteeringMode && window.__rsSteeringMode(); } catch {}
      if (steering) ui.toast("Agent is working — use the Steering steering field to update the next step");
      else ui.nudgeStart();
    },
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      bumpSys("users");
      A.steeringStep = 0;
      ui.steeringProgress("waiting", "Request sent — waiting for the first action", 0);
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      if (!A.running) {
        ui.clearSteeringSteering();
        ui.steeringProgress("stopped", "Generation stopped by you", A.steeringStep);
      }
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
    });
    providerHooksReady = true;
    providerHooksError = null;
    diag("provider.hooksReady", {provider:P.id,ui_init:Math.round(performance.now()-OR_BOOT_AT),responseDetectorReady:true});
  } catch (e) {
    providerHooksReady = false;
    providerHooksError = e instanceof Error ? e : new Error(String(e));
    diag("provider.hooksFailed", { provider:P.id, error:providerHooksError.message });
    try { console.error(`[or] ${P.id} message hook installation failed`, providerHooksError); } catch {}
    try { ui.banner("warn", `${P.displayName} integration failed`, `${providerHooksError.message}. Reload this page before pressing Start.`); } catch {}
  }

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
const RESUME_FRESH_MS = 180000;
rsInterval(() => {
if (!A.started || A.running || A.starting || A.injecting) return;
if (document.hidden && !bgMode) return;              // parking mode: don't parse/exec off-screen (agentLoop gate
if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ?  Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        RSParse.isInjectedFeedback(P.classifyText(after, ".rs-chip"))) return;
    const txt = P.itemText(item);
    if (!RSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try. some providers' models
    // models may leak their native XML/DSML envelope after the main loop has
    // detached, so include the same catalogue-gated alternate path used by the
    // live response watcher.
    const directResumeCalls = RSParse.parseToolCalls(txt);
    const alternateResumeCalls = RSParse.parseAlternateToolCalls ? RSParse.parseAlternateToolCalls(txt) : [];
    if (!directResumeCalls.length &&
        !(alternateResumeCalls.length && alternateResumeCalls.every((call) => knownTool(call.tool)))) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (withSysResend) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
const SYS_FALLBACK_IDLE_MS = 20000;
rsInterval(async () => {
if (!sysResendDue()) return;
if (!A.started || A.running || A.starting || A.injecting) return;
if ((document.hidden && !bgMode) || A.userStopped) return;
    if (P.isGenerating()) return;
    // The user is composing - their draft owns the editor, leave it alone.
    try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
    // Give the cheap path a fair chance first: only step in once the turn has
    // been settled and quiet for a while with no tool result to ride on.
    if (Date.now() - A.lastGenAt < SYS_FALLBACK_IDLE_MS) return;
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    A.forceSysResend = false;
    diag("sys.resend", { via: "ownTurn", ...spent });
    try {
      const base = await submitAndGetBase(systemPrompt({ embedCatalogue: false }));
      await waitForResponse(base);
    } catch (e) {
      diag("sys.resendFailed", { err: String(e && e.message || e) });
    }
  }, 5000);

  log(`OR content script ready (provider: ${P.id})`);
})();
