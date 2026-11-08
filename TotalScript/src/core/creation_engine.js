// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/creation_engine.js — TotalCreation (2.16.0): the shared creation
// intelligence layer that every provider's agent loop runs through.
//
// What it adds on top of TotalOrchestrator.classifyTask (intent / category)
// and TotalSkillIntel (specialist riders):
//
//   1. spec(text, ctx)       REQUEST → STRUCTURED SPECIFICATION. The request
//                            is split into clauses; every clause that names a
//                            deliverable (a GUI, a gameplay system, a model, an
//                            animation, VFX, SFX, terrain, saved data, Blender
//                            geometry, local files) becomes a tracked item
//                            with the command families that BUILD it and the
//                            command families that PROVE it. Negated clauses
//                            ("no GUI", "without sounds") are excluded.
//                            Stages are ordered by dependency (data → logic →
//                            world → interface → motion → fx → audio → polish)
//                            and the integration checks between the present
//                            domains are listed up front.
//   2. PROFILES              Standard / High / Professional / Masterpiece.
//                            They change BEHAVIOUR, not adjectives: how many
//                            creation-check rounds a run may get, whether a
//                            built item must also be verified, whether
//                            integration evidence and a quality audit are
//                            required, how much of the static review reaches
//                            the model. Every number is capped by the
//                            provider's real limits (tight briefs on compact
//                            providers, small send budgets).
//   3. tracker(spec, opts)   RUN TRACKER. observe() records every executed
//                            command (name, arg shape, ok, ms — never the
//                            prompt), runs the static Luau review on the source
//                            the model actually sent, and answers:
//                              coverage()    built / verified / missing per deliverable
//                              integration() remote / pcall / trigger / playback evidence
//                              nudge()       ONE bounded correction message listing
//                                            exactly what is missing and the command
//                                            that proves it — with hard stop rules
//                                            (rounds, no progress since last round,
//                                            provider forbids re-sends)
//                              report()      the honest end-of-run report, derived
//                                            from the command log only (counts of
//                                            checks, never an invented score)
//   4. reviewLuau(src, ctx)  STATIC LUAU REVIEW in JS (no Studio round trip):
//                            server code reading LocalPlayer, DataStore without
//                            pcall, server handlers that trust client arguments,
//                            legacy wait()/spawn(), Touched without a debounce,
//                            busy loops, loadstring / require(id), client code
//                            writing Health, DataStore on the client, print
//                            leftovers, modules without --!strict. Each finding
//                            has a line, a severity and the fix.
//
// Everything is deterministic, side-effect free and runs in node (tests,
// benchmark) and in the content script (window.TotalCreation). main.js owns
// WHEN things are sent; this module only decides WHAT is true about the run.
const TotalCreation = (() => {
  "use strict";
  const VERSION = "2.16.0";

  // ───────────────────────── domains ─────────────────────────
  // did   = command families that BUILD the deliverable
  // proof = command families that VERIFY it (read-back / audit / preview)
  // audit = the quality audit that Professional+ profiles require on top
  // Names mirror the real catalogue (src/core/skills/*, animengine, main.js) and
  // the mode gates in main.js; a regex that matches nothing is a bug, so the
  // tests check every family against the live command list.
  const DOMAINS = {
    data: {
      label: "Saved data", order: 1,
      ask: /\b(data ?stores?|save(s|d|ing)? (the )?(player('s)? )?(progress|data|coins|stats|inventory)|persist(ent|ence)?|profile ?service|profilestore|datastore2|leaderstats? (that|which) saves?|saved? (between|across) (sessions|joins)|keep (their|the) (progress|coins))\b/i,
      did: /^(datastore_|ds_(set|increment|update|remove|profile)|leaderstats_(add|int|set)|profile_setup|datastore_profile_scaffold)/,
      proof: /^(ds_get|ds_get_many|script_read|bench_run|start_stop_play|get_console_output|studio_playtest)$/,
      audit: /^(bench_run)$/,
      build: "datastore_profile_scaffold (or ds_set / leaderstats_add)", verify: "ds_get or script_read + start_stop_play + get_console_output",
    },
    gameplay: {
      label: "Gameplay system", order: 2,
      ask: /\b(system|mechanic|combat|damage|health (system|regen|points|pack)|weapon|sword|gun|blaster|tool that|ability|abilities|round(s| based)?|wave(s| based)?|spawner|spawning|checkpoints?|obby|tycoon|simulator|quest(s| system)?|shop (system|that sells|logic)|inventory system|pet system|leaderstats|currency|coins?|xp|level(ling| up)|enem(y|ies)|boss|npc|door that|teleport(er|s)?|teams?|kill ?brick|lava|power ?ups?|cooldown|respawn|score|points|matchmaking|lobby|minigame|kit|class system|skill tree|crafting|farming|trading|daily reward|pathfind)\b/i,
      did: /^(script_(create|set_source|new|append|insert|replace|module)|multi_edit|module_scaffold|blueprint_(install|configure)|remote_(scaffold|setup|handler|event_create|function_create)|tool_create|weapon_(build|hitbox_create|recoil_set)|door_interactive_wire|npc_spawn_pathfinding|team_create|teams_setup|checkpoint_(system|track_build)|ability_sequence_create|quest_tracker_wire|health_pack|spawn_location(_create)?|leaderstats_(add|int|set)|anim_player_install|dialogue_tree_(create|system))$/,
      proof: /^(script_read|script_check|script_lint|script_analysis|get_console_output|start_stop_play|total_debug|studio_playtest|blueprint_verify|bench_run)$/,
      audit: /^(bench_run|start_stop_play|studio_playtest)$/,
      build: "script_create (server logic) + remote_scaffold for client ↔ server", verify: "script_check, then start_stop_play + get_console_output (bench_run for the whole system)",
    },
    script: {
      label: "Script", order: 2,
      ask: /\b(scripts?|luau|lua|module ?scripts?|local ?scripts?|server ?scripts?|remote ?(events?|functions?)|functions?|code|(for|while) loop|logic|bindable|coroutine)\b/i,
      did: /^(script_(create|set_source|new|append|insert|replace|module)|multi_edit|module_scaffold|blueprint_(install|configure)|remote_(scaffold|setup|handler|event_create|function_create))$/,
      proof: /^(script_read|script_check|script_lint|script_analysis|get_console_output|start_stop_play|total_debug|studio_playtest|blueprint_verify|bench_run|luau_check)$/,
      audit: /^(script_check|script_lint|script_analysis|bench_run)$/,
      build: "script_create / script_set_source", verify: "script_read + script_check (start_stop_play + get_console_output when it runs in Play)",
    },
    environment: {
      label: "Environment / terrain", order: 3,
      ask: /\b(terrain|maps?|island|forest|biome|landscape|mountains?|hills?|rivers?|lakes?|ocean|beach|roads?|village|town|city block|open world|world|environment|level layout|arena|dungeon|cave|desert|snow(y)? area|lava field)\b/i,
      did: /^(terrain_(?!info)|map_generate|environment_scatter|road_(build|path_build)|water_body|tree_forest_scatter|lighting_setup_day_night|spawn_box)/,
      proof: /^(terrain_info|total_screenshot|screenshot_compare|quality_audit|workspace_stats|gfx_capture|get_viewport_screenshot)$/,
      audit: /^(quality_audit|perf_audit)$/,
      build: "map_generate / terrain_generate + environment_scatter", verify: "total_screenshot + terrain_info (quality_audit for the finish)",
    },
    model: {
      label: "3D model", order: 3,
      ask: /\b(models?|meshe?s?|build(ing)? (a|an|the|me)? ?(house|castle|tower|bridge|car|vehicle|boat|ship|plane|statue|tree|wall|room|prop|chair|table|shop stall|base|fort|hut)|houses?|castles?|towers?|bridges?|cars?|vehicles?|boats?|statues?|chairs?|tables?|furniture|props?|character model|pedestal|fountain|lamp ?posts?|lanterns?|lamps?|low[- ]poly|fences?|gates?|crates?|barrels?)\b/i,
      did: /^(model_(build|wall|hollow_box|pipe|array_radial|union|subtract|prefab|variant|detail|paint|distribute|group)|generate_procedural_model|furniture_build|vehicle_(build|chassis_create)|mesh_shape_create|kit_place|part_(create|at|above)|weapon_build|spawn_box|mesh_import|blender_send_to_studio|tree_outline|model_craft|rig_)/,
      proof: /^(model_report|model_check|inspect_instance|total_screenshot|screenshot_compare|quality_audit|mesh_import_verify|get_viewport_screenshot|gfx_capture)$/,
      audit: /^(quality_audit|model_check)$/,
      build: "model_build / kit_place / generate_procedural_model (anchored, named, PrimaryPart)", verify: "model_report + total_screenshot (quality_audit for the finish)",
    },
    gui: {
      label: "GUI", order: 4,
      ask: /\b(guis?|ui|ux|huds?|menus?|shop (ui|menu|screen|window|frame)|inventory (ui|screen|menu)|buttons?|screen ?gui|panels?|pop ?ups?|modal|leaderboard|score ?board|health ?bar|stamina bar|dialog(ue)? (box|ui)|settings (menu|screen)|interface|main menu|(winner|win|lose|defeat|victory|death|results?|end|pause|start|title|loading|lobby|shop|inventory|game ?over) screen|notification|toast|tooltip|minimap|crosshair|hotbar|text ?label|frame)\b/i,
      did: /^(ui_(?!audit$|inspect$|list_tree$|layout_report$|responsive_check$|test$|preview$|find$|image_find$|art_theme_get$|export_spec$)|gui_(?!hide_all$|show_all$)|design_(kit_install|tokens_set)|shop_(ui|category_build)|inventory_ui|health_bar_boss_create|damage_(indicator_show|vignette_setup)|quest_tracker_wire|leaderboard_)/,
      proof: /^(ui_audit|ui_test|ui_inspect|ui_list_tree|ui_layout_report|ui_responsive_check|ui_preview|total_screenshot|screenshot_compare|quality_audit|gfx_capture)$/,
      audit: /^(ui_audit|quality_audit|ui_responsive_check)$/,
      build: "ui_screen_generate / ui_from_spec (Scale sizes, layouts, tokens)", verify: "ui_audit + total_screenshot (ui_test for the wiring)",
    },
    animation: {
      label: "Animation", order: 5,
      ask: /\b(animat(e|ed|ion|ions|or)|walk ?cycle|run cycle|idle (pose|loop|animation)|emotes?|dance|keyframes?|poses?|attack combo|swing (animation|anim)|jump animation|cutscene|camera (shot|sequence|path)|timeline|motion)\b/i,
      did: /^(animation_(generate|create|add_keyframe|update_keyframe|set_pose|set_easing|retime|mirror|reverse|polish|refine|import|motion_preset|stagger_parts|layer|loop_set|publish)|anim_blend_space|sequence_create|ability_sequence_create|cutscene_(create|shot_add|camera_track)|tween_(create|sequence)|spring_create|motor6d_set|camera_(shot|path|dolly|orbit)(?!_preview))/,
      proof: /^(animation_(preview|simulate|validate|test|inspect)|sequence_(preview|validate)|cutscene_preview|camera_orbit_preview|start_stop_play|studio_playtest|total_screenshot)$/,
      audit: /^(animation_(validate|test)|sequence_validate)$/,
      build: "animation_create + animation_add_keyframe (or a motion preset)", verify: "animation_validate + animation_preview on the rig",
    },
    vfx: {
      label: "VFX / lighting", order: 6,
      ask: /\b(particles?|vfx|effects?|explosions?|glow(ing)?|trails?|beams?|auras?|sparks|lightning|smoke|fire (effect|burst)|muzzle flash|hit (effect|spark|flash)|slash effect|lighting|atmosphere|fog|bloom|sky ?box|sky|post ?fx|color correction|sun ?rays|shockwave|dissolve|magic circle|neon)\b/i,
      did: /^(fx_(?!emitters_clear$|trails_clear$)|vfx_(play|theme_set|library_install)|particle_emitter_create|beam_(create|laser_grid)|trail_create|lighting_(set|set_preset|setup_day_night)|atmosphere_(set|setup)|sky_set|bloom_set|postfx_cinematic|screen_shake|style_lighting_apply)/,
      proof: /^(vfx_validate|total_screenshot|screenshot_compare|lighting_inspect|gfx_capture|inspect_instance|get_viewport_screenshot)$/,
      audit: /^(vfx_validate|quality_audit)$/,
      build: "fx_create_emitter / fx_burst / vfx_play (lighting_set_preset for the mood)", verify: "vfx_validate + total_screenshot",
    },
    sfx: {
      label: "SFX / audio", order: 7,
      ask: /\b(sounds?|sfx|music|audio|noise|footsteps?|ambience|ambient (sound|audio|noise|music|track|loop)|soundtrack|jingle|voice ?lines?|bgm)\b/i,
      did: /^(audio_(create_sound|setup_sound_hierarchy|loop|volume|pitch|pan|id|muffler_underwater)|sound_(play|library|zone_reverb|volume)|sfx_(event_define|event_play|library_install)|background_music_playlist|ui_sound_effects_wire)$/,
      proof: /^(sfx_validate|sfx_events_list|inspect_instance|get_console_output|start_stop_play|studio_playtest)$/,
      audit: /^(sfx_validate)$/,
      build: "sfx_event_define + sfx_event_play (audio_create_sound for one-offs)", verify: "sfx_validate (and start_stop_play when the trigger is gameplay)",
    },
    blender: {
      label: "Blender asset", order: 3,
      ask: /\b(blender|bpy|fbx|gltf|glb|topology|retopo|uv ?(map|unwrap)|sculpt|armature|modifier stack)\b/i,
      did: /^(blender_(asset_build|add_|extrude|inset|bevel|boolean|solidify|array|mirror|subdivision|join|set_material|principled_material|uv_|bake|rig|parent|transform|delete|duplicate|origin|smooth|decimate|weld|cleanup|primitive|curve|text|modifier|execute_code))/,
      proof: /^(blender_(asset_validate|asset_inspect|render_shot|turntable|asset_stats|scene_info)|get_viewport_screenshot|mesh_import_verify)$/,
      audit: /^(blender_asset_validate)$/,
      build: "blender_asset_build (or the primitive + modifier commands)", verify: "blender_asset_validate + blender_asset_inspect",
    },
    local: {
      label: "Local files / code", order: 2,
      ask: /\b(files?|folders?|repo(sitory)?|project files|typescript|javascript|python|rust|node|npm|cargo|json file|csv|markdown|readme|script file|\.lua\b|\.luau\b|\.py\b|\.js\b|\.ts\b|\.rs\b)\b/i,
      did: /^(write_file|create_file|edit_file|apply_patch|replace_in_file|append_file|mkdir|move_file|copy_file|delete_file|run_command)$/,
      proof: /^(read_file|read_range|list_dir|search_files|run_command|luau_check|list_by_ext|list_recent)$/,
      audit: /^(run_command|luau_check)$/,
      build: "write_file / edit_file", verify: "read_file back (run_command for a test / build step)",
    },
  };
  const DOMAIN_IDS = Object.keys(DOMAINS);
  // Turkish request vocabulary (the extension's second language). Kept apart
  // from the English `ask` regexes because \b is ASCII-only in JS: a term that
  // starts with ı/ş/ç/ü/ö/ğ would never match behind \b.
  const TR = (terms) => new RegExp("(?:^|[\\s,.;:!?\"'(/-])(?:" + terms + ")[a-zçğıöşü]{0,6}(?=[\\s,.;:!?)\"']|$)", "iu");
  const ASK_TR = {
    data: TR("veri ?(deposu|kayd|tabanı)|kaydet|kayıt|kayıtlı|ilerleme(yi|si)? (kaydet|sakla)|datastore"),
    gameplay: TR("sistem|mekanik|savaş|hasar|silah|kılıç|tüfek|yetenek|turlar|dalga|spawn|kontrol noktası|obby|tycoon|simülatör|görev|para|coin|altın|xp|seviye|düşman|boss|npc|kapı|ışınlan|takım|puan|skor|envanter|market|mağaza|dükkan"),
    script: TR("script|betik|kod(u|lar)?|modül|fonksiyon|döngü|remote"),
    environment: TR("harita|arazi|orman|dağ|nehir|göl|yollar|köy|şehir|dünya|çevre|arena|zindan|mağara|çöl|karlı"),
    model: TR("model|mesh|ev(?=[\\s,.;:!?)]|ler|i\\b)|kale|kule|köprü|araba|araç|gemi|tekne|heykel|ağaç|duvar|oda|sandalye|masa|mobilya|çit|sandık|fıçı|lamba"),
    gui: TR("arayüz|gui|ui|hud|menü|buton|düğme|ekran|panel|pencere|skor tablosu|can barı|liderlik tablosu|bildirim"),
    animation: TR("animasyon|yürüme|koşma|idle|emote|dans|keyframe|pozu|ara sahne|kamera"),
    vfx: TR("efekt|parçacık|patlama|parıltı|ışık|iz efekti|aura|kıvılcım|şimşek|duman|ateş efekti|atmosfer|sis efekti|sisli|gökyüzü|bloom|neon"),
    sfx: TR("ses(ler|i)?|müzik|sfx|ayak sesi|ambiyans"),
    blender: TR("blender|bpy|fbx|gltf|glb|topoloji|uv"),
    local: TR("dosya|klasör|repo|proje dosyaları|typescript|javascript|python|rust|npm|cargo|json|markdown|readme"),
  };
  const LOOKS_TURKISH_RE = /[çğıöşüÇĞİÖŞÜ]|(?:^|\s)(bir|ve|için|yap|ekle|olsun|ile|bana|lütfen|istiyorum)(?:\s|$)/;
  let trMode = false; // set per spec() call
  const asks = (id, text) => DOMAINS[id].ask.test(text) || (trMode && ASK_TR[id] && ASK_TR[id].test(text));
  // A prepositional phrase names the CONTEXT of a deliverable, not a second
  // one: "a trail for the sword", "an explosion when the barrel is hit",
  // "fly over the castle". It is removed before the domain lookup.
  const CONTEXT_PP_RE = /\b(for|to|on|onto|into|at|in|from|over|above|under|around|inside|when|whenever|while|after|before|once|if|where|every time)\s+(the|my|our|his|her|its|their|existing|that|this|each|a|an|every)\s+[a-z][a-z0-9' -]{0,40}?(?=[,.;:!?]|\s+(?:and|or|but|then|plus|also)\b|$)/gi;
  const WEAK_GAMEPLAY_RE = /\b(coins?|xp|levels?|points|stats|currency|score|gold|gems?|leaderstats)\b/gi;
  const CONTEXT_IO_RE = /\b(give|let|have|equip|attach)\s+(the|my|our|that|this|each|every)\s+[a-z][a-z0-9']*\b/gi;

  // Clauses whose head is a negation name things the user does NOT want.
  const NEGATED_CLAUSE_RE = /^\s*(?:and |but |also |please |ve |ama )?(?:no|not|without|never|don'?t|do not|dont|skip|avoid|except|excluding|leave out|instead of|rather than|olmasın|olmadan|istemiyorum|ekleme|yapma|hariç)\b/i;
  const NEGATED_INLINE_RE = /\b(?:no|without|skip|avoid|don'?t (?:add|make|create|build|include|touch|change|use)|do not (?:add|make|create|build|include|touch|change|use)|not (?:a|an|the|any)?)\s+([a-z][a-z0-9 \-]{1,40}?)(?=[,.;!?]|\s+(?:and|or|but|please|yet|for now)\b|$)/gi;
  // A clause whose verb only LOOKS at things names nothing to build.
  const INSPECT_CLAUSE_RE = /^\s*(?:and |then |also |please |first |now )?(?:read|inspect|check|show|list|find|look at|look for|open|tell me|explain|describe|print|get|see|view|search|scan|audit|review|analy[sz]e|compare|count|summari[sz]e|what|which|where|how|why|is|are|does|do)\b/i;
  const CLAUSE_SPLIT_RE = /\s*(?:[,;.!?\n]+|\s+(?:and then|then|and also|and|plus|with|also|as well as|along with|including|which|that also|ve|ile|ayrıca|sonra|artı)\s+|\s+[-•*]\s+)\s*/i;
  const NEGATED_TAIL_RE = /\b(olmasın|istemiyorum|istemem|olmadan|ekleme|yapma|hariç|gerek yok|koyma)\s*$/iu;
  const TR_BUILD_VERB_RE = /(?:^|\s)(yap|yapar mısın|oluştur|ekle|kur|üret|tasarla|yaz|inşa et|hazırla|getir|geliştir|düzelt|kodla|modelle|çiz)(?:[a-zçğıöşü]*)?(?:[\s,.!?]|$)/iu;
  const COMPLEX_RE = /\b(full|complete|entire|whole|end[- ]to[- ]end|production|multiplayer|systems?|framework|polished|professional|aaa|everything|all of it|from scratch|masterpiece)\b/i;
  const MODIFY_RE = /\b(existing|my (game|place|project|script|gui|system)|current|already (have|made|built)|the one (i|we) (made|built)|update|improve|extend|refactor|rework|upgrade)\b/i;

  // ───────────────────────── profiles ─────────────────────────
  // Behavioural knobs (every one is used by tracker / main.js):
  //   rounds           creation-check messages a run may get after its first final answer
  //   requireVerify    a built deliverable must also have a proof command
  //   requireIntegration  missing integration evidence counts as missing work
  //   requireAudit     the domain's audit command must have run for substantial builds
  //   review           which static-review severities reach the model (high | medium | all)
  //   reviewNotes      max static-review notes appended to tool results per run
  //   briefMin         minimum deliverables before the spec brief rides on the first result
  //   inspectFirst     Professional+: the report flags mutations made before any read command
  const PROFILES = {
    standard:     { id: "standard",     label: "Standard",     rounds: 1, requireVerify: false, requireIntegration: false, requireAudit: false, review: "high",   reviewNotes: 2, briefMin: 3, inspectFirst: false },
    high:         { id: "high",         label: "High quality", rounds: 1, requireVerify: true,  requireIntegration: true,  requireAudit: false, review: "medium", reviewNotes: 4, briefMin: 2, inspectFirst: false },
    professional: { id: "professional", label: "Professional", rounds: 2, requireVerify: true,  requireIntegration: true,  requireAudit: true,  review: "all",    reviewNotes: 6, briefMin: 2, inspectFirst: true },
    masterpiece:  { id: "masterpiece",  label: "Masterpiece",  rounds: 3, requireVerify: true,  requireIntegration: true,  requireAudit: true,  review: "all",    reviewNotes: 8, briefMin: 1, inspectFirst: true },
  };
  const PROFILE_IDS = Object.keys(PROFILES);
  const DEFAULT_PROFILE = "high";
  function normalizeProfile(id) { const k = String(id || "").toLowerCase().trim(); return PROFILES[k] ? k : DEFAULT_PROFILE; }

  // profileFor(id, caps): the profile CAPPED by the provider's real limits.
  //   caps = TotalOrchestrator.capabilities(P) (tightPrompt / sendCharBudget)
  function profileFor(id, caps) {
    const base = PROFILES[normalizeProfile(id)];
    const c = caps || {};
    const p = Object.assign({}, base, { provider: c.id || null, tight: !!c.tightPrompt, capped: [] });
    if (c.tightPrompt && p.reviewNotes > 3) { p.reviewNotes = 3; p.capped.push("reviewNotes=3 (compact prompt budget)"); }
    if (Number.isFinite(Number(c.sendCharBudget)) && Number(c.sendCharBudget) > 0 && Number(c.sendCharBudget) < 1200) { p.briefMin = Math.max(p.briefMin, 3); p.capped.push("brief only for 3+ deliverables (small send budget)"); }
    return p;
  }

  // ───────────────────────── 1. spec ─────────────────────────
  function uniq(xs) { return xs.filter((x, i) => xs.indexOf(x) === i); }
  function cleanPhrase(s) { return String(s || "").replace(/\s+/g, " ").replace(/^(?:and|then|also|plus|with|but|or)\s+/i, "").trim().slice(0, 60); }

  // spec(text, ctx) → { v, text, profile, complexity, modifies, deliverables, stages, integrations, completion, negated }
  //   ctx.task      TotalOrchestrator.classifyTask record (intent, explainOnly, followUp)
  //   ctx.prev      previous spec of the same chat (follow-ups inherit)
  //   ctx.mode      work mode id (creation | blender | animate)
  //   ctx.engine    roblox | local
  //   ctx.profile   profile id
  function spec(text, ctx) {
    ctx = ctx || {};
    const raw = String(text || "").replace(/\r\n?/g, "\n").replace(/```[\s\S]*?```/g, " ").slice(0, 6000);
    trMode = LOOKS_TURKISH_RE.test(raw);
    const task = ctx.task && typeof ctx.task === "object" ? ctx.task : null;
    const prev = ctx.prev && ctx.prev.v ? ctx.prev : null;
    const profile = normalizeProfile(ctx.profile);
    const negated = [];
    // 1. inline negations ("no GUI", "without sounds") → excluded domains
    // (an inline negation is stripped from its clause; a clause that STARTS
    // with a negation is skipped whole — so "no music" never hides "a slash
    // sound" asked for elsewhere in the same request)
    let m; const nre = new RegExp(NEGATED_INLINE_RE.source, "gi");
    while ((m = nre.exec(raw)) && negated.length < 8) {
      const phrase = cleanPhrase(m[1]);
      if (DOMAIN_IDS.some((id) => asks(id, " " + phrase + " ")) && !negated.includes(phrase)) negated.push(phrase);
    }
    for (const clause of raw.split(CLAUSE_SPLIT_RE)) { const c = cleanPhrase(clause); const nm = NEGATED_CLAUSE_RE.test(c) ? c.replace(NEGATED_CLAUSE_RE, "").trim() : NEGATED_TAIL_RE.test(c) ? c.replace(NEGATED_TAIL_RE, "").trim() : ""; if (nm && nm.length >= 2 && nm.length <= 40 && DOMAIN_IDS.some((id) => asks(id, " " + nm + " ")) && !negated.includes(nm) && negated.length < 8) negated.push(nm); }
    // 2. clauses → deliverables
    const found = {}; // domain → { phrases: [] }
    const clauses = raw.split(CLAUSE_SPLIT_RE).map((c) => cleanPhrase(c)).filter((c) => c.length >= 3);
    for (const clause of clauses) {
      if (NEGATED_CLAUSE_RE.test(clause) || NEGATED_TAIL_RE.test(clause) || INSPECT_CLAUSE_RE.test(clause)) continue;
      const clean = clause.replace(new RegExp(NEGATED_INLINE_RE.source, "gi"), " ").replace(CONTEXT_PP_RE, (m) => (/script|module|gui\b|remote/i.test(m) ? m : " ")).replace(CONTEXT_IO_RE, " ");
      for (const id of DOMAIN_IDS) {
        if (!asks(id, clean)) continue;
        // "save the player's coins" is data, not a coin system: gameplay reached
        // only through currency words yields to data / gui in the same clause
        if (id === "gameplay" && !asks("gameplay", clean.replace(WEAK_GAMEPLAY_RE, " ")) && DOMAIN_IDS.some((o) => o !== "gameplay" && o !== "script" && asks(o, clean))) continue;
        if (!found[id]) found[id] = { phrases: [] };
        if (found[id].phrases.length < 3 && !found[id].phrases.includes(clean)) found[id].phrases.push(clean);
      }
    }
    // Engine / mode sanity: local engine has no Studio deliverables unless the
    // text is explicit; Blender mode without Blender words still builds in Blender.
    if (ctx.engine === "local") for (const id of Object.keys(found)) if (id !== "local" && !/\b(roblox|studio|luau)\b/i.test(raw)) delete found[id];
    if (ctx.mode === "blender" && !found.blender && (found.model || found.environment || (task && task.mutates && !Object.keys(found).length))) found.blender = { phrases: ((found.model || found.environment) || { phrases: [cleanPhrase(raw.split(CLAUSE_SPLIT_RE)[0])] }).phrases.slice() };
    // "script" is a vocabulary domain: when a gameplay system is present the
    // scripts are part of it (one deliverable, one proof), not a second item.
    if (found.gameplay && found.script) { found.gameplay.phrases = uniq(found.gameplay.phrases.concat(found.script.phrases)).slice(0, 3); delete found.script; }
    // Explain / plan / inspect intents produce no deliverables (nothing to build).
    // TotalOrchestrator.classifyTask reads English; a Turkish build request
    // ("… yap", "… ekle") comes back as a question. The build verb wins here.
    const trBuild = TR_BUILD_VERB_RE.test(raw) && Object.keys(found).length > 0;
    const explainOnly = !!(task && task.explainOnly) && !trBuild;
    const inspectOnly = !!(task && (task.intent === "inspect" || task.intent === "review"));
    let deliverables = [];
    if (!explainOnly && !inspectOnly) {
      deliverables = Object.keys(found).map((id) => ({
        id, domain: id, label: DOMAINS[id].label, phrase: found[id].phrases[0] || "", phrases: found[id].phrases.slice(),
        build: DOMAINS[id].build, verify: DOMAINS[id].verify, order: DOMAINS[id].order,
      })).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    }
    // Follow-ups ("make it faster", "continue") keep the referenced spec's items.
    const inherited = !!(prev && task && (task.followUp || task.isContinue) && !deliverables.length);
    if (inherited) deliverables = prev.deliverables.map((d) => Object.assign({}, d));
    // A fix request on an existing thing is tracked as that thing (so the proof is still required).
    const intent = task ? task.intent : "implement";
    const complexity = (() => {
      const words = raw.split(/\s+/).filter(Boolean).length;
      if (deliverables.length >= 3 || (deliverables.length >= 2 && COMPLEX_RE.test(raw)) || words >= 90) return "complex";
      if (deliverables.length >= 2 || COMPLEX_RE.test(raw) || words >= 25) return "standard";
      return "simple";
    })();
    const present = new Set(deliverables.map((d) => d.id));
    const integrations = integrationsFor(present);
    const stages = deliverables.length ? stagesFor(deliverables, integrations, { inspectFirst: PROFILES[profile].inspectFirst, modifies: MODIFY_RE.test(raw) }) : [];
    const completion = [];
    for (const d of deliverables) completion.push(`${d.label}: built (${d.build.split(" (")[0]}) and read back (${d.verify.split(" (")[0]})`);
    for (const i of integrations) completion.push(`${i.label}: ${i.evidence}`);
    if (deliverables.length) completion.push("final report states what ran and what did not");
    return {
      v: 1, version: VERSION, text: raw.slice(0, 280), profile, intent, complexity, modifies: MODIFY_RE.test(raw), inherited,
      deliverables, integrations, stages, completion, negated, explainOnly, inspectOnly, at: Date.now(),
    };
  }

  // Integration checks between present domains. `evidence` is what the tracker
  // looks for in the command log / sources; `fix` is the command to run.
  const INTEGRATIONS = [
    { id: "gui_remote", between: ["gui", "gameplay"], label: "GUI ↔ server", evidence: "a RemoteEvent / RemoteFunction wired on both sides", fix: "remote_scaffold {name} then fire it from the LocalScript and handle it on the server" },
    { id: "gui_remote_data", between: ["gui", "data"], label: "GUI ↔ saved data", evidence: "the UI reads the saved values through a remote or leaderstats", fix: "leaderstats_add or a RemoteFunction that returns the profile" },
    { id: "data_pcall", between: ["data"], label: "Saved data ↔ safety", evidence: "every DataStore call is wrapped in pcall with a retry / fallback", fix: "wrap GetAsync / SetAsync / UpdateAsync in pcall (datastore_profile_scaffold does this)" },
    { id: "sfx_trigger", between: ["sfx", "gameplay|script"], label: "SFX ↔ gameplay", evidence: "a sound that is actually played from the gameplay code or an sfx event", fix: "sfx_event_define + sfx_event_play (or Sound:Play() in the handler)" },
    { id: "sfx_gui", between: ["sfx", "gui"], label: "SFX ↔ GUI", evidence: "button sounds wired", fix: "ui_sound_effects_wire" },
    { id: "vfx_trigger", between: ["vfx", "gameplay|script"], label: "VFX ↔ gameplay", evidence: "the effect fires from the gameplay code (vfx_play / fx_burst / Emit) not only sits in the place", fix: "vfx_play from the server handler or ParticleEmitter:Emit(n) in the script" },
    { id: "anim_playback", between: ["animation", "gameplay|script"], label: "Animation ↔ gameplay", evidence: "a playback path (anim_player_install or Animator:LoadAnimation in a script)", fix: "anim_player_install (or LoadAnimation in the tool script)" },
    { id: "model_gameplay", between: ["model", "gameplay"], label: "Model ↔ gameplay", evidence: "the built model is the thing the script references (tool_create / weapon_build / a named Model path in the source)", fix: "reference the Model by its exact path or build it with tool_create / weapon_build" },
    { id: "env_spawn", between: ["environment", "gameplay"], label: "World ↔ spawn", evidence: "players spawn inside the generated world", fix: "spawn_location_create on the terrain (and snap the models to ground)" },
  ];
  function integrationsFor(present) {
    return INTEGRATIONS.filter((i) => i.between.every((d) => d.split("|").some((x) => present.has(x)))).map((i) => Object.assign({}, i));
  }
  function stagesFor(deliverables, integrations, o) {
    const stages = [];
    if (o && (o.inspectFirst || o.modifies)) stages.push({ id: "inspect", title: "Inspect the place first", what: "get_studio_state / search_game_tree / script_list — reuse what exists, do not duplicate systems" });
    const byOrder = {};
    for (const d of deliverables) (byOrder[d.order] = byOrder[d.order] || []).push(d);
    const names = { 1: "Data layer", 2: "Logic (server first, then client)", 3: "World / geometry", 4: "Interface", 5: "Motion", 6: "Effects", 7: "Audio" };
    for (const k of Object.keys(byOrder).sort((a, b) => a - b)) stages.push({ id: "build" + k, title: names[k] || "Build", what: byOrder[k].map((d) => d.label + (d.phrase ? ` (${d.phrase})` : "")).join(", ") });
    if (integrations.length) stages.push({ id: "integrate", title: "Integrate", what: integrations.map((i) => i.label).join(", ") });
    if (deliverables.length) stages.push({ id: "verify", title: "Verify", what: uniq(deliverables.map((d) => d.verify.split(" (")[0])).join("; ") });
    return stages;
  }

  // brief(spec, {tight}) — the Layer-C style note that rides on the FIRST tool
  // result of a complex request (≤ 760 chars, ≤ 420 tight). Never sent for
  // explain / inspect intents or when fewer than profile.briefMin items exist.
  function brief(sp, opts) {
    opts = opts || {};
    if (!sp || !sp.deliverables || !sp.deliverables.length) return "";
    const prof = PROFILES[normalizeProfile(sp.profile)];
    if (sp.deliverables.length < (opts.briefMin != null ? opts.briefMin : prof.briefMin)) return "";
    const tight = !!opts.tight;
    const first = (x) => x.split(" (")[0].split(" / ")[0].split(/\s+or\s+|,\s*then\s+/)[0];
    const withPhrase = sp.deliverables.length <= 3; // the request itself is still in the chat
    const items = sp.deliverables.map((d) => tight ? d.label : `${d.label}${withPhrase && d.phrase ? ` "${d.phrase}"` : ""} → ${first(d.build)}, prove: ${first(d.verify)}`);
    const cap = tight ? 420 : 760;
    const head = `(Creation spec from TotalScript, not the user · ${prof.label}.) This request has ${sp.deliverables.length} deliverables; all must exist and be read back before you report done:`;
    const sep = tight ? " " : "\n";
    let s = head + sep + (tight ? items.join(" · ") + "." : items.map((x) => "- " + x).join("\n"));
    // optional parts are added only while they fit (never a cut sentence)
    const extras = [];
    if (!tight && sp.stages.length) extras.push("Order: " + sp.stages.map((x) => x.title.replace(/ \(.*\)$/, "")).join(" → ") + ".");
    if (sp.integrations.length) extras.push("Integration: " + sp.integrations.map((i) => tight || sp.integrations.length > 2 ? i.label : `${i.label} (${i.evidence})`).join("; ") + ".");
    if (sp.negated.length) extras.unshift("Excluded by the user: " + sp.negated.join(", ") + ".");
    for (const e of extras) if (s.length + sep.length + e.length <= cap) s += sep + e;
    if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…";
    return s;
  }

  // ───────────────────────── 4. static Luau review ─────────────────────────
  const SOURCE_KEYS = ["source", "code", "text", "content", "luau", "lua", "script", "body"];
  const LUAU_HINT_RE = /\b(local|function|end|game|script|workspace|task\.|Instance\.new|GetService|Connect)\b/;
  function sourceOf(args) {
    if (!args || typeof args !== "object") return "";
    for (const k of SOURCE_KEYS) { const v = args[k]; if (typeof v === "string" && v.length >= 20 && LUAU_HINT_RE.test(v)) return v; }
    if (Array.isArray(args.edits)) { const parts = []; for (const e of args.edits) if (e && typeof e.replace === "string") parts.push(e.replace); const s = parts.join("\n"); if (s.length >= 20 && LUAU_HINT_RE.test(s)) return s; }
    return "";
  }
  // Container of the script: server | client | module | run (execute_luau) | unknown
  function containerOf(tool, args) {
    const a = args || {};
    const kind = String(a.kind || a.type || a.class || a.className || "").toLowerCase();
    if (/module/.test(kind)) return "module";
    if (/local|client/.test(kind)) return "client";
    if (/server|^script$/.test(kind)) return "server";
    const p = String(a.path || a.parent || a.name || "");
    if (/StarterPlayerScripts|StarterCharacterScripts|StarterGui|PlayerGui|StarterPack|LocalScript/i.test(p)) return "client";
    if (/ServerScriptService|ServerStorage|Workspace\.|Script\b/i.test(p) && !/LocalScript/i.test(p)) return "server";
    if (/ReplicatedStorage|Module/i.test(p)) return "module";
    if (/^execute_luau$/.test(tool)) return "run";
    return "unknown";
  }
  function lineOf(src, idx) { return src.slice(0, Math.max(0, idx)).split("\n").length; }
  function firstLine(src, re) { const m = re.exec(src); return m ? lineOf(src, m.index + Math.max(0, m[0].search(/\S/))) : 0; }
  // reviewLuau(src, {container}) → [{ code, sev: high|medium|low, line, msg, fix }]
  function reviewLuau(src, ctx) {
    ctx = ctx || {};
    const s = String(src || "");
    const out = [];
    if (!s.trim()) return out;
    const container = ctx.container || "unknown";
    // strip comments / strings for the structural checks (keep line structure)
    // comments are blanked (line structure kept); strings stay because the
    // service names the checks look for live inside GetService("…") strings
    const code = s.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
    const add = (c, sev, re, msg, fix) => { const line = firstLine(code, re); if (line) out.push({ code: c, sev, line, msg, fix }); };
    const has = (re) => re.test(code);
    // security / correctness
    if (container === "server" || container === "module") add("server_localplayer", "high", /Players\.LocalPlayer|game\.Players\.LocalPlayer|\.LocalPlayer\b/, "LocalPlayer is nil on the server", "use the player argument of the event / PlayerAdded instead");
    if (container === "client") { add("client_datastore", "high", /DataStoreService/, "DataStoreService cannot be used from a LocalScript", "move saving to a server Script and talk to it through a RemoteEvent"); add("client_health", "medium", /\.Health\s*=|TakeDamage\(/, "Health changed on the client does not replicate", "apply damage on the server (RemoteEvent → server validates → Humanoid:TakeDamage)"); }
    if (container !== "client" && has(/DataStoreService/) && !has(/\bpcall\s*\(|\bxpcall\s*\(/)) add("datastore_no_pcall", "high", /DataStoreService/, "DataStore calls without pcall throw on throttles / outages", "wrap GetAsync / SetAsync / UpdateAsync in pcall and retry or fall back");
    add("loadstring", "high", /\bloadstring\s*\(/, "loadstring executes arbitrary code", "remove it; build the logic in the script");
    add("require_id", "high", /\brequire\s*\(\s*\d{4,}\s*\)/, "require(assetId) pulls remote code into the game", "require a ModuleScript in the place instead");
    if (has(/OnServerEvent\s*:\s*Connect|OnServerInvoke\s*=/) && !has(/\btypeof\s*\(|\btype\s*\(|\btonumber\s*\(|math\.clamp|\bassert\s*\(|:IsA\s*\(|IsDescendantOf|Magnitude/)) add("remote_no_validation", "medium", /OnServerEvent|OnServerInvoke/, "the server handler trusts the client's arguments", "validate types / ranges / ownership (typeof, math.clamp, distance check) before acting");
    if (has(/\.Touched\s*:\s*Connect/) && !has(/debounce|cooldown|os\.clock|tick\s*\(|time\s*\(|lastHit|touched\[|busy\b/i)) add("touched_no_debounce", "medium", /\.Touched\s*:\s*Connect/, "Touched fires dozens of times per contact", "add a debounce / per-player cooldown");
    { const loops = [...code.matchAll(/while\s+true\s+do([\s\S]{0,800}?)(?:\bend\b|$)/g)]; const bad = loops.find((lm) => !/task\.wait|\bwait\s*\(|Heartbeat|RenderStepped|Stepped|:Wait\s*\(|\bbreak\b/.test(lm[1])); if (bad) out.push({ code: "busy_loop", sev: "high", line: lineOf(code, bad.index), msg: "while true without a yield freezes Studio / the server", fix: "add task.wait() (or drive it from RunService.Heartbeat)" }); }
    // modern API
    add("legacy_wait", "medium", /(^|[^.\w])wait\s*\(/, "legacy wait() is deprecated and imprecise", "task.wait()");
    add("legacy_spawn", "medium", /(^|[^.\w])(spawn|delay)\s*\(/, "legacy spawn()/delay()", "task.spawn / task.delay");
    add("service_path", "low", /game\.(ReplicatedStorage|ServerScriptService|ServerStorage|Players|Lighting|StarterGui|SoundService|TweenService|RunService)\b/, "service reached by path", "game:GetService(\"…\")");
    if (container === "module" && !/^\s*--!strict/.test(s) && !/^\s*--!nonstrict/.test(s)) out.push({ code: "module_no_strict", sev: "low", line: 1, msg: "ModuleScript without --!strict", fix: "add --!strict and type the public API" });
    const prints = (code.match(/(^|[^\w.])print\s*\(/g) || []).length;
    if (prints >= 3) add("print_leftover", "low", /(^|[^\w.])print\s*\(/, `${prints} print() calls`, "keep one behind a DEBUG flag or remove them");
    if (has(/\bInstance\.new\s*\(\s*"(Part|MeshPart|WedgePart|CornerWedgePart|TrussPart)"/) && !has(/\.Anchored\s*=\s*true/)) add("part_unanchored", "medium", /Instance\.new\s*\(\s*"(Part|MeshPart|WedgePart)/, "parts created without Anchored = true fall", "set Anchored = true (or weld them) before Parent");
    if (has(/Instance\.new\s*\(\s*"(ScreenGui|Frame|TextButton|TextLabel|ImageLabel)"/) && has(/UDim2\.new\s*\(\s*0\s*,\s*\d{2,}/) && !has(/UDim2\.(fromScale|new\s*\(\s*0?\.\d)/)) add("ui_offset_only", "medium", /UDim2\.new\s*\(\s*0\s*,\s*\d{2,}/, "GUI sized in Offset pixels only", "use Scale (UDim2.fromScale) + UIAspectRatioConstraint / UISizeConstraint");
    // assets: placeholder / fabricated ids never ship (10. asset pipeline)
    add("asset_placeholder", "medium", /rbxassetid:\/\/(?:\d{1,5}|(\d)\1{5,}|1234567?8?9?0?)\b|(?:SoundId|Image|Texture|MeshId|TextureId|AnimationId)\s*=\s*""/, "placeholder asset id", "use a real id from the library / audio_id / ui_image_find, or leave the asset out and say so");
    // order: high → medium → low, then by line
    const rank = { high: 0, medium: 1, low: 2 };
    out.sort((a, b) => rank[a.sev] - rank[b.sev] || a.line - b.line);
    return out;
  }
  const SEV_FILTER = { high: new Set(["high"]), medium: new Set(["high", "medium"]), all: new Set(["high", "medium", "low"]) };
  function reviewNote(findings, opts) {
    opts = opts || {};
    const allow = SEV_FILTER[opts.level] || SEV_FILTER.medium;
    const f = (findings || []).filter((x) => allow.has(x.sev)).slice(0, opts.max || 3);
    if (!f.length) return "";
    const items = f.map((x) => `[${x.sev}] L${x.line} ${x.msg} → ${x.fix}`);
    const cap = opts.tight ? 320 : 420;
    const build = (n) => `STATIC REVIEW (TotalScript, automated — not a Studio result)${opts.path ? " of " + opts.path : ""}: ` + items.slice(0, n).join("; ") + (items.length > n ? ` (+${items.length - n} more)` : "") + ". Fix in your next edit, then script_check.";
    let n = items.length, s = build(n);
    while (s.length > cap && n > 1) s = build(--n);
    if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…";
    return s;
  }

  // ───────────────────────── 3. run tracker ─────────────────────────
  const BARE = (n) => String(n || "").replace(/^[^.]*\./, "");
  const READ_RE = /^(get_studio_state|search_game_tree|script_list|script_read|model_report|selection_info|inspect_instance|inspect_service|get_children|get_descendants|tree|workspace_list|project_index|project_health_report|script_outline|get_property|read_file|list_dir|search_files|explorer_|ui_list_tree|lighting_inspect|terrain_info|brief_get)/;
  const MAX_EVENTS = 400;
  const SOURCE_SCAN = { remote: /RemoteEvent|RemoteFunction|UnreliableRemoteEvent/, remoteClient: /FireServer|InvokeServer/, remoteServer: /OnServerEvent|OnServerInvoke/, datastore: /DataStoreService/, pcall: /\bpcall\s*\(|\bxpcall\s*\(/, play: /:Play\s*\(/, soundNew: /Instance\.new\s*\(\s*"Sound"|SoundService/, emit: /:Emit\s*\(|\.Enabled\s*=\s*true|ParticleEmitter/, anim: /LoadAnimation|Animator|AnimationTrack/, spawn: /SpawnLocation|RespawnLocation|CFrame\s*=.*Spawn/i, modelRef: /workspace[.:]|Workspace[.:][A-Z]\w+|WaitForChild\s*\(\s*"[A-Z]\w+"/ };

  // One key per script whatever the tool's arg shape: path | parent.name | name
  function scriptKey(args) {
    const a = args || {};
    const p = String(a.path || "").trim();
    if (p) return p.slice(0, 120);
    const parent = String(a.parent || "").trim(), name = String(a.name || "").trim();
    return (parent && name ? parent + "." + name : name || parent).slice(0, 120);
  }
  function tracker(sp, opts) {
    opts = opts || {};
    const prof = opts.profile && opts.profile.id ? opts.profile : profileFor(sp && sp.profile, opts.caps);
    const events = []; // { i, tool, ok, ms, at, domains: [], container, src: {flags}, path, findings: n }
    const scripts = {}; // path → { open: [...codes], raised, resolved }
    const st = { rounds: 0, lastRoundAt: -1, notes: 0, raised: 0, resolved: 0, firstMutationAt: -1, firstReadAt: -1, done: false, nudges: [] };
    const domainsOfTool = (bare, args) => {
      const ds = [];
      for (const id of DOMAIN_IDS) if (DOMAINS[id].did.test(bare)) ds.push(id);
      // execute_luau that creates a script / instance counts as the matching family
      if (bare === "execute_luau") { const src = String((args && args.code) || ""); if (/Instance\.new\s*\(\s*"(Script|LocalScript|ModuleScript)"/.test(src) || /\.Source\s*=/.test(src)) ds.push("script"); if (/Instance\.new\s*\(\s*"(ScreenGui|Frame|TextButton|TextLabel|ImageLabel|ImageButton)"/.test(src)) ds.push("gui"); if (/Instance\.new\s*\(\s*"(Part|MeshPart|Model|WedgePart)"/.test(src)) ds.push("model"); if (/Instance\.new\s*\(\s*"(ParticleEmitter|Beam|Trail|PointLight|SpotLight)"|Lighting\./.test(src)) ds.push("vfx"); if (/Instance\.new\s*\(\s*"Sound"/.test(src)) ds.push("sfx"); if (/Terrain:/.test(src)) ds.push("environment"); if (/DataStoreService/.test(src)) ds.push("data"); if (/KeyframeSequence|Animation"/.test(src)) ds.push("animation"); }
      return uniq(ds);
    };
    const proofsOfTool = (bare) => DOMAIN_IDS.filter((id) => DOMAINS[id].proof.test(bare));
    const auditsOfTool = (bare) => DOMAIN_IDS.filter((id) => DOMAINS[id].audit.test(bare));

    // observe(call, feedback, meta) → { note } — `note` is the static-review
    // text to append to the tool result ("" when nothing applies).
    function observe(call, feedback, meta) {
      meta = meta || {};
      const bare = BARE(call && call.tool);
      const args = (call && call.arguments) || {};
      const fb = String(feedback || "");
      const ok = !/^ERROR/i.test(fb.trim());
      const src = sourceOf(args);
      const container = src ? containerOf(bare, args) : "";
      const ev = { i: events.length, tool: bare, ok, ms: Number(meta.ms) || 0, at: Date.now(), domains: domainsOfTool(bare, args), proofs: proofsOfTool(bare), audits: auditsOfTool(bare), container, path: scriptKey(args), src: null, findings: 0 };
      if (src) { const f = {}; for (const k of Object.keys(SOURCE_SCAN)) f[k] = SOURCE_SCAN[k].test(src); f.container = container; ev.src = f; }
      if (events.length >= MAX_EVENTS) events.shift();
      events.push(ev);
      if (st.firstReadAt < 0 && READ_RE.test(bare)) st.firstReadAt = ev.i;
      if (st.firstMutationAt < 0 && ev.domains.length && !READ_RE.test(bare)) st.firstMutationAt = ev.i;
      let note = "";
      // static review of the Luau the model sent (only when the write succeeded;
      // a failed write is already an error the model must handle first)
      if (src && ok && container !== "run" && /^(script_|multi_edit|module_scaffold|write_file|edit_file)/.test(bare)) {
        const findings = reviewLuau(src, { container });
        const key = ev.path || bare + "#" + ev.i;
        const rec = scripts[key] || (scripts[key] = { open: [], raised: 0, resolved: 0 });
        const codes = findings.map((x) => x.code);
        const resolved = rec.open.filter((c) => !codes.includes(c)).length;
        const raised = codes.filter((c) => !rec.open.includes(c)).length;
        rec.resolved += resolved; rec.raised += raised; st.resolved += resolved; st.raised += raised;
        rec.open = codes;
        ev.findings = findings.length;
        if (findings.length && st.notes < prof.reviewNotes) {
          note = reviewNote(findings, { level: prof.review, max: prof.tight ? 2 : 3, tight: prof.tight, path: ev.path && ev.path.length < 60 ? ev.path : "" });
          if (note) st.notes++;
        }
      }
      return { note, event: ev };
    }

    // coverage() → per deliverable { id, label, built, verified, audited, builtBy, verifiedBy, status }
    function coverage() {
      const items = (sp && sp.deliverables) || [];
      return items.map((d) => {
        // gameplay accepts plain script writes as its build evidence
        const buildEv2 = events.filter((e) => e.ok && (e.domains.includes(d.id) || (d.id === "gameplay" && e.domains.includes("script"))));
        const firstBuild = buildEv2.length ? buildEv2[0].i : -1;
        const proofEv = events.filter((e) => e.ok && e.proofs.includes(d.id) && e.i > firstBuild);
        const auditEv = events.filter((e) => e.ok && e.audits.includes(d.id) && e.i > firstBuild);
        const built = firstBuild >= 0, verified = built && proofEv.length > 0, audited = built && auditEv.length > 0;
        const failedBuilds = events.filter((e) => !e.ok && e.domains.includes(d.id)).length;
        let status = !built ? (failedBuilds ? "failed" : "missing") : !verified && prof.requireVerify ? "unverified" : prof.requireAudit && !audited && SUBSTANTIAL.has(d.id) ? "unaudited" : "ok";
        return { id: d.id, label: d.label, phrase: d.phrase, built, verified, audited, status, builtBy: uniq(buildEv2.map((e) => e.tool)).slice(0, 4), verifiedBy: uniq(proofEv.map((e) => e.tool)).slice(0, 4), failedBuilds, build: d.build, verify: d.verify };
      });
    }
    const SUBSTANTIAL = new Set(["gui", "model", "environment", "gameplay", "data", "blender"]);

    // integration() → per check { id, label, status: ok | missing | unknown, why, fix }
    function integration() {
      const checks = (sp && sp.integrations) || [];
      // latest successful source per script path (a rewrite supersedes the first draft)
      const byPath = new Map(); let anon = 0;
      for (const e of events) if (e.ok && e.src) byPath.set(e.path || "#" + anon++, e.src);
      const srcs = [...byPath.values()];
      const ran = (re) => events.some((e) => e.ok && re.test(e.tool));
      const any = (k) => srcs.some((s) => s[k]);
      const anyIn = (k, container) => srcs.some((s) => s[k] && s.container === container);
      return checks.map((c) => {
        let status = "unknown", why = "";
        switch (c.id) {
          case "gui_remote": {
            const client = anyIn("remoteClient", "client") || ran(/^ui_bind_button$/), server = anyIn("remoteServer", "server") || ran(/^remote_(scaffold|setup|handler)$/);
            status = client && server ? "ok" : (srcs.length || ran(/^remote_/)) ? "missing" : "unknown"; why = status === "ok" ? "FireServer on the client + OnServerEvent on the server" : `client side ${client ? "✓" : "✗"}, server side ${server ? "✓" : "✗"}`; break; }
          case "gui_remote_data": { const ok = any("remote") || ran(/^leaderstats_/); status = ok ? "ok" : srcs.length ? "missing" : "unknown"; why = ok ? "remote / leaderstats present" : "no remote or leaderstats between UI and data"; break; }
          case "data_pcall": { const ds = srcs.filter((s) => s.datastore); status = !ds.length ? (ran(/^(datastore_profile_scaffold|ds_profile)/) ? "ok" : "unknown") : ds.every((s) => s.pcall) ? "ok" : "missing"; why = !ds.length ? (status === "ok" ? "scaffolded by TotalScript (pcall built in)" : "no DataStore source seen") : status === "ok" ? "every DataStore script uses pcall" : `${ds.filter((s) => !s.pcall).length} DataStore script(s) without pcall`; break; }
          case "sfx_trigger": { const ok = ran(/^(sfx_event_play|sound_play)$/) || any("play"); status = ok ? "ok" : (ran(/^(audio_create_sound|sfx_event_define|sound_library)/) || any("soundNew")) ? "missing" : "unknown"; why = ok ? "a play call exists" : "sound created but never played from the gameplay code"; break; }
          case "sfx_gui": { const ok = ran(/^ui_sound_effects_wire$/) || anyIn("play", "client"); status = ok ? "ok" : ran(/^ui_/) ? "missing" : "unknown"; why = ok ? "button sounds wired" : "UI built without sound wiring"; break; }
          case "vfx_trigger": { const ok = ran(/^(vfx_play|fx_burst|fx_shockwave|fx_create_explosion|screen_shake)$/) || any("emit"); status = ok ? "ok" : ran(/^(fx_|vfx_|particle_emitter_create)/) ? "missing" : "unknown"; why = ok ? "effect fires from code / a play command" : "effect placed but nothing fires it"; break; }
          case "anim_playback": { const ok = ran(/^anim_player_install$/) || any("anim"); status = ok ? "ok" : ran(/^animation_/) ? "missing" : "unknown"; why = ok ? "playback path present" : "clip authored but no LoadAnimation / AnimPlayer"; break; }
          case "model_gameplay": { const ok = ran(/^(tool_create|weapon_build)$/) || any("modelRef"); status = ok ? "ok" : (ran(/^model_/) && srcs.length) ? "missing" : "unknown"; why = ok ? "script references the model / tool" : "model built but no script references it"; break; }
          case "env_spawn": { const ok = ran(/^spawn_location(_create)?$/) || any("spawn"); status = ok ? "ok" : ran(/^(map_generate|terrain_generate)$/) ? "missing" : "unknown"; why = ok ? "spawn placed" : "world generated without a spawn"; break; }
          default: status = "unknown";
        }
        return { id: c.id, label: c.label, status, why, fix: c.fix };
      });
    }

    // What is still missing right now, in the order the model should do it.
    function missing() {
      const cov = coverage(), integ = integration();
      const out = [];
      for (const c of cov) if (c.status !== "ok") out.push({ kind: "deliverable", id: c.id, label: c.label, phrase: c.phrase, status: c.status, text: c.status === "missing" || c.status === "failed" ? `${c.label}${c.phrase ? ` "${c.phrase}"` : ""}: NOT BUILT${c.status === "failed" ? ` (${c.failedBuilds} failed attempt${c.failedBuilds === 1 ? "" : "s"}, no success)` : " (no " + c.label + " command has succeeded)"} — build it: ${c.build}.` : c.status === "unverified" ? `${c.label}: built (${c.builtBy.join(", ")}) but NOT READ BACK — run ${c.verify}.` : `${c.label}: built and read back but never audited — run ${(DOMAINS[c.id].audit.source.replace(/[\^$()?:]/g, "").split("|")[0])} and fix the high / medium findings.` });
      if (prof.requireIntegration) for (const i of integ) if (i.status === "missing") out.push({ kind: "integration", id: i.id, label: i.label, status: i.status, text: `${i.label}: ${i.why} — ${i.fix}.` });
      return out;
    }

    // nudge(ctx) → "" | message. Hard stop rules, in order:
    //   - nothing missing                     → ""
    //   - explain / inspect spec              → ""
    //   - rounds used ≥ profile.rounds        → ""
    //   - no successful relevant command since the previous round → "" (the
    //     model is not acting on the note; repeating it is the death spiral)
    //   - ctx.resendAllowed === false         → ""
    function nudge(ctx) {
      ctx = ctx || {};
      if (!sp || sp.explainOnly || sp.inspectOnly || !sp.deliverables.length) return "";
      if (ctx.resendAllowed === false) return "";
      if (st.rounds >= prof.rounds) return "";
      const miss = missing();
      if (!miss.length) return "";
      if (st.rounds > 0) {
        const progressed = events.some((e) => e.i > st.lastRoundAt && e.ok && (e.domains.length || e.proofs.length));
        if (!progressed) { st.stoppedNoProgress = true; return ""; }
      }
      st.rounds++; st.lastRoundAt = events.length ? events[events.length - 1].i : -1;
      const tight = !!prof.tight;
      const roundTxt = `${st.rounds}/${prof.rounds}`;
      let s;
      if (tight) {
        const short = miss.slice(0, 4).map((m) => m.kind === "integration" ? `${m.label} (${m.status})` : `${m.label} ${m.status === "unverified" ? "unverified → " + m.text.split("run ")[1] : m.status === "unaudited" ? "unaudited" : "not built"}`);
        s = `(TotalScript creation check ${roundTxt}, derived from the command log.) Still missing: ${short.join("; ")}. Do these now, or say plainly which you are not doing and why.`;
      } else {
        s = `━━━ CREATION CHECK ${roundTxt} (System note from TotalScript, not the user · ${prof.label} profile) ━━━\nStatus of the deliverables in your request, read from the command log — not from your message:\n` + miss.slice(0, 6).map((m) => "- " + m.text).join("\n") + `\nFinish these now (one command per step, read each result), or state plainly which ones you are not doing and why. Never describe missing work as done.`;
      }
      const cap = tight ? 460 : 1400;
      if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…";
      st.nudges.push({ at: Date.now(), items: miss.map((m) => m.id) });
      return s;
    }

    // report() → { ...counts, text } — the honest end-of-run report.
    function report() {
      const cov = coverage(), integ = integration();
      const built = cov.filter((c) => c.built).length, verified = cov.filter((c) => c.verified).length, audited = cov.filter((c) => c.audited).length;
      const missingItems = cov.filter((c) => !c.built), unverifiedItems = cov.filter((c) => c.built && !c.verified);
      const iOk = integ.filter((i) => i.status === "ok").length, iMissing = integ.filter((i) => i.status === "missing"), iUnknown = integ.filter((i) => i.status === "unknown").length;
      const openFindings = Object.entries(scripts).filter(([, r]) => r.open.length).map(([p, r]) => ({ path: p, open: r.open.slice(0, 4) }));
      const tools = events.length, failed = events.filter((e) => !e.ok).length;
      const builtBeforeRead = prof.inspectFirst && st.firstMutationAt >= 0 && (st.firstReadAt < 0 || st.firstReadAt > st.firstMutationAt);
      const level = !cov.length ? "none" : missingItems.length || iMissing.length ? "incomplete" : unverifiedItems.length && prof.requireVerify ? "unverified" : "complete";
      const lines = [];
      lines.push(`CREATION REPORT · ${prof.label} · derived from the command log (automated counts, not the model's prose)`);
      if (cov.length) lines.push(`Deliverables ${cov.length}: built ${built} · read back ${verified} · audited ${audited}` + (missingItems.length ? ` · missing: ${missingItems.map((c) => c.label).join(", ")}` : "") + (unverifiedItems.length ? ` · not read back: ${unverifiedItems.map((c) => c.label).join(", ")}` : ""));
      else lines.push("Deliverables: none tracked for this request" + (sp && (sp.explainOnly || sp.inspectOnly) ? " (explain / inspect intent)" : ""));
      if (integ.length) lines.push(`Integration ${integ.length}: ok ${iOk} · missing ${iMissing.length}${iMissing.length ? " (" + iMissing.map((i) => i.label).join(", ") + ")" : ""} · unknown ${iUnknown}`);
      if (st.raised || openFindings.length) lines.push(`Static review: ${st.raised} finding${st.raised === 1 ? "" : "s"} raised · ${st.resolved} resolved · ${openFindings.reduce((n, f) => n + f.open.length, 0)} open` + (openFindings.length ? " (" + openFindings.slice(0, 3).map((f) => f.path + ": " + f.open.join(", ")).join("; ") + ")" : ""));
      if (builtBeforeRead) lines.push("Process: the first change ran before any read of the place (Professional+ expects inspect → build)");
      lines.push(`Commands ${tools} · failed ${failed} · creation checks sent ${st.rounds}/${prof.rounds}${st.stoppedNoProgress ? " · stopped early: no progress after the last check" : ""}${prof.capped.length ? " · provider caps: " + prof.capped.join(", ") : ""}`);
      let short = `${level}: ${built}/${cov.length} built, ${verified} read back` + (missingItems.length ? `, missing ${missingItems.map((c) => c.label).join("/")}` : "") + (integ.length ? `; integration ${iOk}/${integ.length} ok` : "") + (st.raised ? `; review ${st.raised} raised/${st.resolved} fixed` : "") + ` (${prof.label}, ${tools} cmds)`;
      if (short.length > 120) short = short.slice(0, 119) + "…";
      return { version: VERSION, profile: prof.id, level, short, deliverables: cov.length, built, verified, audited, missing: missingItems.map((c) => c.id), unverified: unverifiedItems.map((c) => c.id), integration: { total: integ.length, ok: iOk, missing: iMissing.map((i) => i.id), unknown: iUnknown }, review: { raised: st.raised, resolved: st.resolved, open: openFindings }, builtBeforeRead, tools, failed, rounds: st.rounds, maxRounds: prof.rounds, stoppedNoProgress: !!st.stoppedNoProgress, text: lines.join("\n") };
    }

    return { spec: sp, profile: prof, events, observe, coverage, integration, missing, nudge, report, state: st };
  }

  return { VERSION, DOMAINS, DOMAIN_IDS, PROFILES, PROFILE_IDS, DEFAULT_PROFILE, INTEGRATIONS, normalizeProfile, profileFor, spec, brief, reviewLuau, reviewNote, sourceOf, containerOf, tracker };
})();
if (typeof window !== "undefined") window.TotalCreation = TotalCreation;
if (typeof module !== "undefined" && module.exports) module.exports = TotalCreation;
