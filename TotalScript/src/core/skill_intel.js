// TotalScript — Skill Intelligence (1.99.1)
//
// One small, deterministic brain shared by three surfaces:
//   · the `skill {name}` command (details on demand for the running agent),
//   · the per-request EXPERT rider (rides on the first tool result next to the
//     orchestrator's task brief - concise, budgeted, only when it clearly
//     applies),
//   · the Prompt Enhancer (intent analysis, mode strategy, must-keep list,
//     expert excerpts, post-rewrite checks).
//
// It holds the built-in EXPERT library: a short list of deep, domain-specific
// operating procedures that reference ONLY commands that exist in this build
// (tests/test-skill-intel.js checks every name against the live catalogue).
// It never executes anything, never overrides permissions or validation, and
// never invents tools: experts are text the model reads, the command registry
// stays authoritative.
//
// DOM-free at top level (loaded in node by the tests).
(function (root) {
  "use strict";
  const VERSION = "1.99.1";

  // ───────────────────────── expert library ─────────────────────────
  // Fields: id, title, env (roblox | blender | general), summary (one line
  // for discovery), triggers (weighted words; phrases count double), avoid
  // (words that argue AGAINST this expert), intents (which task intents it
  // serves; empty = any), procedure[] (real commands in backticks),
  // pitfalls[], verify[], brief[] (what a specialist makes explicit in a
  // prompt), complements[] (skills worth loading next to this one).
  const E = [];
  const add = (x) => { E.push(x); return x; };

  add({
    id: "luau_scripting", title: "Luau scripting", env: "roblox",
    summary: "Write, edit and wire Scripts / LocalScripts / ModuleScripts with the right service, context and error handling.",
    triggers: { script: 3, scripts: 3, luau: 4, lua: 3, "module script": 4, modulescript: 4, localscript: 4, "local script": 4, function: 2, coroutine: 3, loop: 1, variable: 1, require: 2, code: 1, "write a script": 5, "server script": 4, bindable: 3, event: 1, metatable: 3, "type checking": 3, strict: 2 },
    avoid: { blender: 4, python: 3, typescript: 3, essay: 4, email: 4 },
    intents: [],
    procedure: [
      "Locate the real code first: `script_list` / `script_grep` / `script_outline` for existing scripts, `inspect_instance` for the objects a script will touch - never guess names.",
      "Choose the container by execution context: server logic → Script in ServerScriptService; input / camera / UI → LocalScript under StarterPlayerScripts or the GUI; shared code → ModuleScript in ReplicatedStorage (both) or ServerStorage (server only). `script_create` / `script_module` create them.",
      "Before overwriting a script that already exists run `script_backup`; then use `script_replace` / `script_insert` for surgical edits, `script_set_source` only for full rewrites, `script_append` to add handlers.",
      "Write modern Luau: task.wait / task.spawn / task.delay (never wait / spawn / delay), :Connect (not :connect), typed function signatures where it helps, pcall around every DataStore / MarketplaceService / HttpService call, no global variables.",
      "Resolve instances safely: WaitForChild on the client, FindFirstChild + nil checks on the server, CollectionService tags for groups of objects instead of name scanning.",
      "Validate syntax with `script_check` (loadstring) and style with `script_lint`; fix every reported line before moving on.",
      "Prove behaviour: `start_stop_play` (or ask the user to play-test) and read `get_console_output` for errors / warnings; a script with no run evidence is not done.",
      "Stop when the script parses, the Output is clean on run and the user's acceptance points are visible in the place - report what was read back, not what was intended.",
    ],
    pitfalls: ["Deprecated wait() / spawn() / :connect() - `script_deprecations_fix` modernises a whole container.", "Server code reading client-only state (Mouse, Camera, LocalPlayer) or LocalScripts placed under ServerScriptService (they never run).", "Overwriting a user's script without a backup; `script_restore` undoes a bad rewrite."],
    verify: ["`script_check` reports syntax OK for every edited script.", "`get_console_output` after a run shows no new errors / warnings from the edited scripts."],
    brief: ["name the exact script(s) and parent service, and whether each is Script / LocalScript / ModuleScript", "say what must be server-authoritative and what runs on the client", "state the error-handling expectation (pcall + retry for external services, no silent failures)"],
    complements: ["networking", "debug_repair"],
  });

  add({
    id: "networking", title: "Server / client & remotes (security)", env: "roblox",
    summary: "RemoteEvent / RemoteFunction design, server authority, validation and exploit hardening.",
    triggers: { remote: 4, remotes: 4, remoteevent: 5, remotefunction: 5, "remote event": 5, "remote function": 5, fireserver: 5, fireclient: 5, onserverevent: 5, "server authoritative": 5, "server-side": 3, "client side": 3, replication: 4, replicate: 3, exploit: 5, exploiter: 5, hacker: 4, cheat: 4, "anti cheat": 5, anticheat: 5, security: 3, secure: 3, "rate limit": 4, sanity: 2, validate: 2, validation: 2, "trust the client": 5 },
    avoid: { blender: 4, essay: 4 },
    intents: [],
    procedure: [
      "Inventory what exists: `remotes_list` for current remotes, `script_grep` for FireServer / OnServerEvent / InvokeServer usages, `script_find_usages` for the handler names.",
      "Design the contract per action (name, payload shape, who may fire it, how often) BEFORE creating remotes; group them with `remote_folder` or `remote_setup` (namespace with sample handlers).",
      "Create exactly the remotes needed with `remote_event_create` / `remote_function_create`; one RemoteEvent per intent, never a generic 'DoAnything' remote.",
      "Server handlers (`remote_handler` for the scaffold, then `script_append` / `script_replace` for real logic) must: type-check every argument, clamp numbers, verify ownership / distance / cooldown, and ignore (not error on) bad input.",
      "Keep money, health, inventory, rewards and progression on the server only; the client sends intents, the server decides and replicates results.",
      "Add rate limiting per player for spammable remotes (timestamp table keyed by UserId) and clean it up on PlayerRemoving.",
      "Test with `remote_fire` plus `get_console_output`, including one deliberately bad payload (wrong type / out of range) to prove the server rejects it quietly.",
      "Stop when every client-callable path validates its input and the only state the client owns is cosmetic.",
    ],
    pitfalls: ["RemoteFunction invoked from server to client (an exploiter can hang the server) - use RemoteEvents client-ward.", "Trusting a damage / price / position value sent by the client.", "Error-ing on bad input (gives exploiters feedback and spams the Output) - drop it and optionally log."],
    verify: ["`remotes_list` shows only the intended remotes.", "A bad payload sent with `remote_fire` changes nothing and raises no error in `get_console_output`."],
    brief: ["list each client→server action, its payload and the server-side checks (type, range, ownership, cooldown)", "state explicitly which values must never be trusted from the client", "mention rate limiting if the action can be spammed"],
    complements: ["luau_scripting", "data_persistence"],
  });

  add({
    id: "data_persistence", title: "Data persistence (DataStore / leaderstats / profiles)", env: "roblox",
    summary: "Player data that survives rejoins: schema, session-safe saving, retries, leaderstats and global leaderboards.",
    triggers: { datastore: 5, "data store": 5, datastoreservice: 5, save: 3, saving: 3, saved: 2, persist: 4, persistence: 4, "player data": 5, leaderstats: 5, leaderboard: 4, "ordered datastore": 5, profile: 3, profileservice: 5, currency: 2, coins: 2, progress: 2, "daily reward": 3, inventory: 1, "updateasync": 5, "bindtoclose": 5, "session lock": 5, "data loss": 5 },
    avoid: { blender: 4, animation: 2 },
    intents: [],
    procedure: [
      "Read what exists: `script_grep` for GetDataStore / UpdateAsync / leaderstats and `get_datastore` to confirm the store name the project already uses - never create a second store for the same data.",
      "Define the schema first (versioned table, defaults, migration rule) and the key (UserId); write it down in the script header.",
      "Scaffold with `datastore_setup` (session-lock-safe UpdateAsync, pcall + retry, BindToClose) or `datastore_profile_scaffold` for a full profile; `profile_setup` when leaderstats + attributes + autosave is the whole requirement; `leaderstats_int` / `leaderstats_add` for simple stats.",
      "Global rankings use an OrderedDataStore: `leaderboard_setup` builds board + refresh loop; never sort a regular DataStore.",
      "Every DataStore call: pcall, exponential backoff (max 3 tries), one write per player on leave + periodic autosave (60-120 s), save on BindToClose with a bounded wait.",
      "Studio needs 'Enable Studio Access to API Services' in Game Settings - say so when a save fails with 502/403 instead of retrying blindly.",
      "Test the loop: set a stat (`leaderstats_set`), leave / rejoin in a play-test or call the save function with `execute_luau`, read it back and confirm the value - `get_console_output` must show no DataStore warnings.",
      "Stop when load → modify → save → reload shows the same value and the Output is clean.",
    ],
    pitfalls: ["SetAsync for read-modify-write (races between servers) - UpdateAsync.", "Saving on every change (throttled; 6 s per key) - batch and autosave.", "Loading failure treated as 'new player' (wipes data) - keep the session read-only until a load succeeds."],
    verify: ["A value written in one session is read back after rejoin.", "`get_console_output` shows no 'DataStore request was added to queue' / 502 warnings during the test."],
    brief: ["name what is saved (fields + defaults), the key, and when saves happen (leave, autosave interval, BindToClose)", "require UpdateAsync with pcall + retry and a read-only fallback when loading fails", "say whether a global leaderboard (OrderedDataStore) is part of the request"],
    complements: ["networking", "luau_scripting"],
  });

  add({
    id: "gameplay_systems", title: "Gameplay systems (combat · NPC · inventory · quests · shop · rounds)", env: "roblox",
    summary: "Mechanics built as real systems: blueprints, weapons and hitboxes, NPC behaviour, pickups, monetisation.",
    triggers: { combat: 5, weapon: 4, sword: 5, gun: 5, melee: 5, hitbox: 5, damage: 4, cooldown: 3, dps: 4, health: 2, npc: 4, npcs: 4, enemy: 4, enemies: 4, boss: 4, ai: 2, pathfinding: 5, patrol: 4, chase: 3, inventory: 4, quest: 5, quests: 5, mission: 3, shop: 3, store: 2, buy: 2, purchase: 3, gamepass: 5, "game pass": 5, "developer product": 5, devproduct: 5, robux: 4, round: 3, rounds: 3, wave: 3, waves: 3, lobby: 3, checkpoint: 4, obby: 4, tycoon: 4, simulator: 4, pet: 3, pets: 3, crafting: 4, loot: 3, pickup: 3, "proximity prompt": 4, dialog: 2, tool: 2, team: 2, teams: 3, spawn: 2, respawn: 3, mechanic: 4, system: 2, "game loop": 4 },
    avoid: { blender: 4, essay: 4 },
    intents: [],
    procedure: [
      "Check what is already installed: `blueprint_status` and `blueprint_list` (currency, shop, pets, combat, rounds, checkpoints, quests, inventory …) - extend an installed system with `blueprint_configure` instead of building a parallel one.",
      "For a new standard system use `blueprint_install` (shared Core + Config + verified services), then `blueprint_verify`; hand-build only what no blueprint covers.",
      "Melee / weapons: `tool_create` for the Tool, `weapon_hitbox_create` (raycast or part hitbox with server damage), `weapon_trail_enable`, `knockback_apply`, `damage_indicator_show`; `target_dummy_spawn` gives a safe test target; `shield_bubble_create` for guards.",
      "NPCs: `npc_spawn_pathfinding` (Humanoid rig + PathfindingService loop); states (idle / patrol / chase / attack) live in one server ModuleScript with a cooldown and a max-distance leash.",
      "Interaction: `proximity_setup` / `proximity_prompt_create` for E-to-use, `dialog_create` for NPC talk, `health_pack` for pickups, `spawn_location_create` + `team_create` / `teams_setup` for team spawns.",
      "Monetisation only with real assets: `gamepass_create` / `gamepass_list`, `developer_product_create` / `developer_product_list`, wired with `marketplace_setup`; ProcessReceipt must be idempotent and return PurchaseGranted only after the grant is saved.",
      "All damage, rewards and state changes are decided on the server (see the networking expert); the client only animates and shows UI.",
      "Prove it: `start_stop_play` plus `get_console_output`; for combat, hit the dummy and read its Humanoid health back with `inspect_instance`. Stop when the numbers the user gave (damage, cooldown, prices) are the numbers you read back.",
    ],
    pitfalls: ["Touched-based melee without debounce / per-swing hit tables (multi-hits per swing).", "Granting a product before its grant is persisted (double grants on retry).", "NPC loops that call ComputeAsync every frame - recompute at most every 0.25-0.5 s or on target move."],
    verify: ["`blueprint_verify` passes for installed systems.", "A play-test shows the mechanic firing once per intended trigger with the Output clean."],
    brief: ["define the rules precisely: numbers (damage, cooldowns, prices, counts), win / lose conditions, what resets and when", "say which parts must be server-authoritative and what the player sees as feedback", "name any existing system it must plug into (currency, inventory, leaderstats)"],
    complements: ["networking", "data_persistence", "ui_ux"],
  });

  add({
    id: "ui_ux", title: "UI / UX (ScreenGui design & behaviour)", env: "roblox",
    summary: "Responsive, readable Roblox GUI built from specs and tokens, with real behaviour, controller support and design QA.",
    triggers: { gui: 5, ui: 4, ux: 4, hud: 5, menu: 3, screengui: 5, "screen gui": 5, frame: 3, button: 3, textlabel: 4, textbutton: 4, imagelabel: 4, scrollingframe: 4, layout: 2, panel: 3, popup: 4, modal: 4, tooltip: 4, "health bar": 4, "shop ui": 5, "inventory ui": 5, "main menu": 5, "title screen": 5, "pause menu": 5, settings: 2, "loading screen": 5, notification: 3, toast: 2, responsive: 3, mobile: 2, gamepad: 4, controller: 2, font: 2, typography: 3, icon: 2, theme: 2 },
    avoid: { blender: 4, "no gui": 6, "without ui": 6 },
    intents: [],
    procedure: [
      "Look before building: `ui_inspect` / `ui_find` / `ui_list_tree` for existing screens, `ui_layout_report` for actual pixel boxes - extend or restyle existing UI rather than stacking a second HUD.",
      "Build whole screens declaratively: `ui_screen_generate` (kinds with runtime scripts) or `ui_from_spec` / `ui_build_spec` for a custom tree; single widgets with `ui_component_place` / `ui_add_element`; cinematic title / pause / results screens with `ui_art_build`.",
      "Root ScreenGui via `ui_screen_create` (IgnoreGuiInset on, ResetOnSpawn off); Scale-based sizes, AnchorPoint set, UIAspectRatioConstraint on cards, TextScaled with UITextSizeConstraint, UIPadding / UIListLayout for spacing.",
      "Style from one token set: `ui_apply_tokens` / `ui_tokens_apply` / `ui_design_system_create`; never hand-pick ten different greys.",
      "Behaviour without hidden scripts: `ui_states_wire` (open / close / toggle), `ui_bind_button`, `ui_state_toggle`, `ui_tween` for motion; data-driven text comes through RemoteEvents from the server.",
      "Make it survive every screen: `ui_make_responsive` / `ui_responsive_fix` (offset → scale), `ui_gamepad_focus` for controller selection, safe margins for the 58 px top bar.",
      "QA: `ui_audit` (WCAG contrast, tiny text, touch targets), `ui_preview` + a screenshot, `ui_layout_report` at 1280x720 and a phone size; fix findings.",
      "Stop when the audit is clean, the screen reads correctly at two resolutions and every button does what the request says.",
    ],
    pitfalls: ["Offset-only sizes (breaks on phones); ZIndex wars instead of DisplayOrder; text without TextScaled constraints.", "Duplicating a ScreenGui per build attempt - clear or reuse the existing one.", "Client-side UI changing game state directly (must go through remotes)."],
    verify: ["`ui_audit` reports no contrast / size failures.", "`ui_layout_report` shows no off-screen or overlapping widgets at two viewport sizes."],
    brief: ["list the screens / widgets and what each shows and does; name the trigger (key, button, event)", "state the style direction (theme, fonts, colours if any) and target devices (PC / mobile / console)", "say which existing GUI must be kept or restyled"],
    complements: ["networking", "gameplay_systems"],
  });

  add({
    id: "animation", title: "Animation (rigs · KeyframeSequence · playback)", env: "roblox",
    summary: "Build, polish, validate and publish animations on R6 / R15 rigs, and play them correctly in game.",
    triggers: { animation: 5, animations: 5, animate: 4, animator: 4, keyframe: 5, keyframes: 5, keyframesequence: 5, rig: 4, rigs: 4, r6: 5, r15: 5, motor6d: 5, pose: 4, "walk cycle": 5, idle: 3, emote: 5, dance: 4, "attack animation": 5, swing: 2, jump: 2, "run cycle": 5, easing: 3, "animation priority": 5, animationtrack: 5, "animation id": 4, tween: 2 },
    avoid: { blender: 2, "ui animation": 3 },
    intents: [],
    procedure: [
      "Pick the rig explicitly: `animation_select_rig` (or `rig_joints_inspect` to see Motor6Ds / rig type); R6 and R15 clips are not interchangeable.",
      "Create the clip: `animation_create` + `animation_set_pose` / `animation_add_keyframe` for hand-authored motion, or `animation_generate` for a described motion; set timing with `animation_set_length` / `animation_set_easing`.",
      "Iterate visually: `animation_preview` (and `animation_stop_preview`), `animation_polish` / `animation_refine` for arcs, anticipation and settle; `animation_mirror` / `animation_reverse` / `animation_retime` for variants.",
      "Validate before export: `animation_validate` (rig compatibility, frame count, duration) and `animation_test`.",
      "Ship it: `animation_publish` creates a real Animation asset (returns the id); `animation_export_rbxmx` for a file; set Loop / Priority with `animation_loop_set` (Idle < Movement < Action).",
      "Playback code loads the id through Animator:LoadAnimation on the character's Animator (not Humanoid), caches tracks, and stops conflicting tracks; `rig_pose_reset` cleans a rig after previews.",
      "Secondary motion on props / NPCs without a clip: `animation_motion_preset`, `animation_stagger_parts`.",
      "Stop when the preview matches the request, validation passes and - if asked - the published id plays in a play-test.",
    ],
    pitfalls: ["Loading animations with Humanoid:LoadAnimation (deprecated) or on a rig without an Animator.", "Wrong priority (idle overriding an attack).", "Publishing from a place the user does not own (the asset must belong to the game's creator)."],
    verify: ["`animation_validate` passes for the target rig type.", "`animation_preview` shows the motion; after publish the asset id is read back."],
    brief: ["name the rig type (R6 / R15 / custom) and the motion, its length and whether it loops", "say how it is triggered in game (tool, input, event) and its priority relative to idle / movement", "state whether publishing an Animation asset is required or a preview is enough"],
    complements: ["luau_scripting", "cinematics"],
  });

  add({
    id: "vfx", title: "VFX (particles · beams · lights · post-processing)", env: "roblox",
    summary: "Production-grade effects from the TotalVFX runtime or hand-built emitters, validated against performance rules.",
    triggers: { vfx: 5, particle: 5, particles: 5, particleemitter: 5, effect: 3, effects: 3, explosion: 4, fire: 2, smoke: 4, sparkle: 4, sparkles: 4, aura: 5, glow: 3, neon: 2, beam: 4, trail: 3, bloom: 4, "sun rays": 4, "post processing": 4, "color correction": 4, "depth of field": 4, hit: 1, impact: 3, slash: 3, magic: 3, spell: 4, portal: 4, "lightning": 4, flicker: 3, pulse: 2 },
    avoid: { blender: 3, "sound effect": 4, sfx: 3 },
    intents: [],
    procedure: [
      "Pick the art direction once: `vfx_theme_set` (palette + tier) so every effect shares colours; read the brief with `brief_get` when one exists.",
      "Install / upgrade the runtime with `vfx_library_install`, then trigger families with `vfx_play` (path or position) from server events; one-offs with `vfx_burst_create`, loops with `vfx_aura_create`, arcs with `vfx_beam_arc_create`.",
      "Hand-built emitters: `fx_create_emitter` / `fx_create_light` / `fx_create_beam` / `fx_create_trail` / `fx_create_explosion`; keep Rate × Lifetime low, use Drag / Acceleration for shape, LightEmission + LightInfluence for glow.",
      "Lighting-side feel: `light_flicker` / `light_pulse` on PointLights; global mood via `lighting_set_preset` or `style_lighting_apply` - but never change global lighting for a local effect.",
      "Audit with `vfx_validate` (emitter counts, lifetimes, rates, unparented emitters) and fix every flag.",
      "Attach effects to Attachments on anchored or welded parts; destroy or disable them when the owner is gone (Debris).",
      "Stop when the effect plays where and when the request says, `vfx_validate` is clean and a screenshot confirms the look.",
    ],
    pitfalls: ["Emitters left Enabled on hidden parts (invisible cost).", "Using Lighting changes as a local effect (affects everyone).", "Rates in the hundreds on mobile targets."],
    verify: ["`vfx_validate` passes on the created effect.", "A screenshot shows the effect at the intended place / moment."],
    brief: ["describe the effect's look (colours, shape, duration) and its trigger / anchor", "state the performance target (mobile-safe or PC-only) and whether it follows the project palette", "say if lighting / post-processing may change globally or must stay local"],
    complements: ["sfx", "cinematics"],
  });

  add({
    id: "sfx", title: "SFX & audio", env: "roblox",
    summary: "Sound events, mixing hierarchy and ambience from asset ids the user provides - never invented ids.",
    triggers: { sound: 5, sounds: 5, sfx: 5, audio: 5, music: 5, "sound effect": 5, ambience: 5, ambient: 3, footsteps: 5, "sound group": 5, soundgroup: 5, volume: 3, pitch: 2, soundservice: 5, "background music": 5, bgm: 5, jingle: 4, "audio id": 5, "sound id": 5 },
    avoid: { blender: 4 },
    intents: [],
    procedure: [
      "Collect the asset ids FROM THE USER or the place (`search_game_tree` for Sound instances); TotalScript never invents audio ids - say so and ask when none are given.",
      "Mixing first: `audio_setup_sound_hierarchy` (Master → Music / SFX / UI / Ambience SoundGroups) so volumes are controllable later.",
      "Define events with `sfx_event_define` (layers, pitch / volume variance, cooldown), install the runtime with `sfx_library_install`, play with `sfx_event_play` (2D, at a position or on a part); `sfx_layered_event_create` for a one-off multi-layer hit; `sfx_ambient_zone_create` for spatial loops.",
      "Single sounds: `audio_create_sound` on a part (3D, RollOffMaxDistance set) or in SoundService (2D); `audio_id` to point an existing Sound at an id and play it.",
      "Verify every id in this Studio with `sfx_validate` - unknown / non-audio assets are reported, not guessed.",
      "Wire triggers server-side for gameplay sounds (so everyone hears them) and client-side for UI clicks.",
      "Stop when each event plays from the right place with the right falloff and `sfx_validate` is clean.",
    ],
    pitfalls: ["Invented or placeholder asset ids (they silently fail or play the wrong thing).", "Sounds parented to Workspace root for 3D audio (no position).", "Looping music started once per player join on the server (stacks)."],
    verify: ["`sfx_validate` reports every event's ids as verified Audio assets.", "`sfx_event_play` reports the actual SoundId played."],
    brief: ["list the sounds with their asset ids (or state that ids are missing and must be supplied)", "say where each plays (UI / 2D / 3D on a part) and the trigger", "state loudness / falloff expectations and whether a mixer hierarchy is wanted"],
    complements: ["vfx", "cinematics"],
  });

  add({
    id: "cinematics", title: "Cinematics (cutscenes · sequences · camera)", env: "roblox",
    summary: "Real cutscenes and multi-domain sequences (camera, animation, VFX, SFX) with previews, triggers and validation.",
    triggers: { cutscene: 6, cutscenes: 6, cinematic: 6, sequence: 4, camera: 3, "camera shake": 5, intro: 3, "boss intro": 5, "opening scene": 5, shot: 3, shots: 3, dolly: 5, orbit: 3, "fov": 4, "field of view": 4, trailer: 4, "title sequence": 5, cinematics: 6, scene: 2, timeline: 3 },
    avoid: { blender: 3, "camera in blender": 6 },
    intents: [],
    procedure: [
      "Scout: `get_studio_state` for the current camera, `cutscene_list` / `sequence_list` for existing material, `camera_look_at` / `camera_focus` to frame candidates.",
      "Camera-only stories → `cutscene_create` (shots with CFrame, FOV, easing); add shots with `cutscene_shot_add`, capture the live view with `cutscene_shot_from_camera`, or build from marker parts with `cutscene_shots_from_path`.",
      "Multi-domain moments (camera + animation + VFX + SFX + lighting) → `sequence_create`; it references the TotalVFX / TotalSFX runtimes, so install them first when effects are involved.",
      "Preview in edit mode before wiring: `cutscene_preview` / `sequence_preview`; adjust timing until every shot reads.",
      "Validate against THIS place: `sequence_validate` (rig, limbs, assets); fix missing references instead of hoping.",
      "Wire the trigger: `cutscene_trigger` (server script: touch / prompt / event) or `sequence_play` for a running game; the client plays cosmetics, the server decides when.",
      "In-game camera feel: `camera_set_style` for controllers, `camera_shake` / `camera_dolly` / `camera_orbit_preview` for moments; always restore CameraType to Custom afterwards.",
      "Stop when the preview matches the storyboard, validation passes and the trigger fires it in a play-test.",
    ],
    pitfalls: ["Leaving the camera Scriptable after the scene (player stuck).", "Hard-coding CFrames of parts that later move - use marker parts.", "Playing the scene on the server (cameras are per client)."],
    verify: ["`cutscene_preview` / `sequence_preview` plays every shot in order.", "`sequence_validate` reports no missing references."],
    brief: ["describe the shots (what the camera sees, duration, easing) and the trigger moment", "list the actors / effects / sounds each shot needs and whether they already exist", "say what happens to player control during and after the scene"],
    complements: ["vfx", "sfx", "animation"],
  });

  add({
    id: "world_building", title: "World building (parts · models · terrain · lighting)", env: "roblox",
    summary: "Proportioned, anchored, well-pivoted geometry and environments built from specs with a style guide.",
    triggers: { build: 2, model: 3, models: 3, part: 2, parts: 2, house: 4, building: 3, castle: 4, tower: 4, bridge: 4, room: 3, wall: 3, walls: 3, door: 2, window: 2, roof: 4, stairs: 4, map: 3, level: 2, arena: 4, terrain: 5, mountain: 4, island: 4, forest: 4, tree: 3, trees: 3, road: 3, village: 4, city: 4, dungeon: 4, lighting: 4, atmosphere: 4, skybox: 4, sky: 3, fog: 3, "day night": 5, environment: 3, prop: 3, props: 3, furniture: 4, pillar: 4, fence: 3, lantern: 3, "low poly": 4 },
    avoid: { blender: 5, gui: 3, ui: 2, script: 2 },
    intents: ["implement", "continue", "plan"],
    procedure: [
      "Set direction before geometry: `brief_get` (or `brief_set` when the user gives genre / palette / scale) and `style_guide` for palette, materials and proportions; read `selection_info` / `inspect_instance` for the site.",
      "Block out at human scale (a door ≈ 7×12 studs, a floor ≈ 12-14 studs): `model_hollow_box` for rooms, `model_wall` for walls, `model_build` for a whole JSON parts spec (arches, roofs), `wedge_create` for slopes, `model_prefab` for hand-proportioned props, `model_pipe` for rails / cables, `model_array_radial` for pillars / seats.",
      "Group and pivot: `model_group`, `model_center_pivot`, `model_snap_to_ground`; align / distribute repeated pieces with `model_align` / `model_distribute`.",
      "Openings and details with CSG only where needed: `model_subtract` (doors, windows), `model_union` sparingly (unions cost more than parts).",
      "Materials and colour from the style guide in one pass: `model_paint`; keep everything anchored (`model_anchor_fix` / `physics_anchor_all`).",
      "Terrain: `terrain_fill_region`, `terrain_paint`, `terrain_height`; clear mistakes with `terrain_clear_region`.",
      "Mood: `lighting_set_preset` or `style_lighting_apply`, `sky_set`, `atmosphere_setup`; snapshot before experimenting (`lighting_snapshot` / `lighting_restore`).",
      "Critique and verify: `model_check` (floating / buried / sliver parts), `model_report`, a screenshot from `camera_look_at`; fix findings, then stop when the scene matches the brief at the stated scale.",
    ],
    pitfalls: ["Unanchored scenery (falls on play).", "Pivots at the model centre (props float) - bottom-centre pivot, snap to ground.", "Dozens of CSG unions for simple shapes (slow, ugly collisions)."],
    verify: ["`model_check` reports no floating / buried parts.", "A screenshot shows proportions matching the brief (doors, floors at human scale)."],
    brief: ["state what to build, where (place, position / selected object), its scale and style (genre, palette, low-poly vs detailed)", "list the must-have pieces and anything that must NOT be changed in the existing map", "say whether lighting / terrain are in scope"],
    complements: ["vfx", "performance"],
  });

  add({
    id: "debug_repair", title: "Debug & repair", env: "roblox",
    summary: "Reproduce, read the real error, find the root cause in the actual code, fix minimally, prove it is gone.",
    triggers: { fix: 5, bug: 5, bugs: 5, broken: 5, error: 5, errors: 5, "doesn't work": 6, "doesnt work": 6, "not working": 6, "won't work": 6, "stopped working": 6, "nothing happens": 6, crash: 5, crashes: 5, debug: 6, issue: 3, fails: 4, failed: 4, exception: 5, "nil value": 6, "attempt to": 6, "stack trace": 6, output: 3, warning: 3, infinite: 3, "yield": 3, lag: 2, "why does": 3 },
    avoid: { blender: 3 },
    intents: ["fix", "review", "inspect", "question"],
    procedure: [
      "Get the real symptom: `get_console_output` (exact message, script path, line), `get_studio_state` (edit vs play), and the user's reproduction steps; do not fix from the description alone.",
      "Read the code at the reported line and its callers: `script_read`, `script_outline`, `script_find_usages`, `script_grep`; `script_analysis` / `script_lint` across the container for related smells.",
      "Form one hypothesis per cause (nil instance → WaitForChild / wrong path; wrong context → Script vs LocalScript; replication → server vs client; timing → race) and confirm it with a read-only probe (`inspect_instance`, `execute_luau` returning a value) before editing.",
      "`script_backup`, then the smallest fix with `script_replace` / `script_insert` / `script_delete_lines`; no drive-by rewrites, no silencing with blanket pcall.",
      "Re-run: `start_stop_play` (or ask the user to repeat the steps) and read `get_console_output` again; the original message must be gone and no new one added.",
      "If the fix fails, revert (`script_restore`) before trying the next hypothesis - never stack speculative edits.",
      "Whole-place health when the user asks 'what is wrong': `project_health_report`, `diagnostics_audit`, `script_todo`.",
      "Stop when the error no longer appears for the reproduction and you can state the root cause in one sentence.",
    ],
    pitfalls: ["Fixing the symptom (adding a nil check) instead of the cause (wrong parent / wrong context).", "Declaring success without re-running.", "Editing many scripts at once so the regression source is unknown."],
    verify: ["`get_console_output` after reproduction shows the original error is gone.", "`script_diff` shows only the intended lines changed."],
    brief: ["quote the exact error / symptom and the steps that reproduce it; name the script and line if known", "state what must NOT change (behaviour, other scripts, data)", "require root cause + minimal fix + proof by re-running"],
    complements: ["luau_scripting", "project_analysis"],
  });

  add({
    id: "performance", title: "Performance & optimisation", env: "roblox",
    summary: "Measure first, then fix the real cost: physics, rendering, scripts, memory, streaming.",
    triggers: { performance: 5, optimise: 5, optimize: 5, optimization: 5, optimisation: 5, lag: 4, laggy: 5, fps: 5, "frame rate": 5, framerate: 5, slow: 3, memory: 4, "memory leak": 6, streaming: 4, streamingenabled: 6, "part count": 5, "triangle count": 5, tris: 3, "draw calls": 5, mobile: 2, "low end": 4, stutter: 5, ping: 3, "server lag": 5 },
    avoid: { blender: 3 },
    intents: [],
    procedure: [
      "Measure: `diagnostics_audit` (unanchored parts, missing humanoid states, emitter counts), `project_health_report`, `model_report` on heavy models, `memory_get`, `script_stats`.",
      "Fix the cheap wins safely: `diagnostics_fix_common` (anchor static scenery, StreamingEnabled, etc.) and `model_optimize` (CastShadow off on tiny parts, surfaces); confirm nothing gameplay-critical was anchored by mistake.",
      "Scripts: `script_lint` for per-frame work in Heartbeat / RenderStepped, busy loops, connections never disconnected; `script_deprecations_fix` for wait()/spawn(); cache services and instances outside loops.",
      "Physics: anchor what never moves (`physics_anchor_all`), reduce unions, use collision groups (`collision_group_set`) to stop needless pair checks.",
      "Effects and audio: `vfx_validate` / `sfx_validate` for runaway emitters and stacked sounds.",
      "Re-measure the same metrics after each change and keep only changes that moved them; report before / after numbers.",
      "Stop when the user's target (fps / memory / part count) is met or you can state exactly what remains and why.",
    ],
    pitfalls: ["Optimising without a baseline.", "Anchoring or deleting things that gameplay moves.", "Mass-decimating meshes when the cost was scripts."],
    verify: ["Before / after numbers from `diagnostics_audit` / `memory_get` are reported.", "A play-test after the changes shows no new errors in `get_console_output`."],
    brief: ["state the symptom with numbers if known (fps, device, where it happens) and the target", "say what may and may not be changed (visual fidelity, gameplay objects)", "require before / after measurements in the report"],
    complements: ["debug_repair", "world_building"],
  });

  add({
    id: "project_analysis", title: "Project analysis & architecture", env: "roblox",
    summary: "Understand an existing place before changing it: index, dependency graph, conventions, memory of verified facts.",
    triggers: { architecture: 5, structure: 3, refactor: 5, refactoring: 5, "clean up": 3, cleanup: 3, modular: 4, "folder structure": 5, "how is": 2, "what does": 2, overview: 4, codebase: 5, "existing code": 5, "my game": 2, understand: 3, review: 4, audit: 4, analyse: 4, analyze: 4, dependencies: 5, "require graph": 6, conventions: 4, document: 3, documentation: 3 },
    avoid: { blender: 3 },
    intents: ["review", "inspect", "plan", "explain", "question", "implement", "fix"],
    procedure: [
      "Index once: `project_index_build` (scripts, functions, exports, requires), then cheap reads: `project_index_summary` (architecture map), `project_index_search`, `project_index_script`, `project_index_graph` (require graph), `project_index_changes` since the last index.",
      "Cross-check with raw tools where precision matters: `script_requires` (orphans / cycles), `script_stats`, `script_outline`, `script_find_usages`.",
      "Record verified facts for later turns with `memory_add_fact` / `memory_update_section` and read them back with `memory_read` / `memory_search` - never store guesses.",
      "For a refactor: plan the module boundaries from the graph, rename with `script_rename_symbol` (dry_run first), move logic in small steps with backups (`script_backup`) and re-check `script_requires` after each step.",
      "Report with paths and line numbers (`script_outline`), separating facts you read from suggestions.",
      "Stop when every claim in the report points at a real script / line and the dependency graph is consistent after changes.",
    ],
    pitfalls: ["Describing architecture from names alone without reading the requires.", "Renames without dry_run across scripts that share identifiers.", "Memory entries written before verification."],
    verify: ["`script_requires` shows no new orphan / cycle after a refactor.", "Each reported finding cites a script path (and line where possible)."],
    brief: ["state the question or the refactor goal and the scope (whole place / a service / a module)", "say whether changes are allowed or this is read-only analysis", "ask for findings tied to real paths and lines"],
    complements: ["debug_repair", "luau_scripting"],
  });

  add({
    id: "blender_modeling", title: "Blender modelling (procedural · hard-surface · organic)", env: "blender",
    summary: "Plan → build → validate → inspect assets in Blender with clean topology, applied transforms and real materials.",
    triggers: { blender: 6, bpy: 6, mesh: 3, meshes: 3, model: 2, modeling: 4, modelling: 4, sculpt: 4, topology: 5, "hard surface": 5, "hard-surface": 5, organic: 3, "low poly": 3, lowpoly: 3, uv: 4, uvs: 4, unwrap: 5, bake: 4, baking: 4, material: 2, materials: 2, pbr: 4, modifier: 4, bevel: 4, boolean: 3, subdivision: 4, armature: 4, bone: 3, bones: 3, "3d asset": 5, asset: 2, prop: 2, "weapon model": 4, "character model": 4, vehicle: 3, "export": 2 },
    avoid: { gui: 4, datastore: 5, remote: 4 },
    intents: [],
    procedure: [
      "Look before touching the user's scene: `get_scene_info`, then `blender_introspect` (version, objects, materials). The extension connects to Blender by itself on the first blender_ call - if that fails, say the Blender bridge is down instead of pretending.",
      "Plan proportions and style BEFORE geometry: `blender_asset_plan` turns the brief into a spec (category, dimensions in metres, part roles, materials); edit the spec, then `blender_asset_build`. Seeded generators: tree_procedural, terrain_tile, rock_cluster, crystal_cluster, stairs, building, fence.",
      "Hand-modelling steps use named tools: primitives (`blender_add_cube`, `blender_add_cylinder` …), `blender_extrude` / `blender_inset` / `blender_bevel` / `blender_solidify`, `blender_boolean` sparingly, `blender_array` / `blender_mirror` for repetition, `blender_add_modifier` + `blender_apply_modifiers` when the shape is final.",
      "Materials: built assets carry procedural texture graphs (`texture: flat` opts out); `blender_asset_bake` writes PNG maps. Hand-made: `blender_principled_material` / `material_assign`; UVs via `blender_uv_unwrap`.",
      "Present: `blender_light_rig` + `blender_camera_rig` (presets fitted to the target), `blender_world_setup`, `blender_render_setup`, then `blender_render_shot` / `blender_turntable`; `blender_studio_clear` removes the rig.",
      "Hygiene every time: `blender_apply_transforms`, `blender_origin_to_bottom`, `blender_recalc_normals`, `blender_scene_cleanup`, `blender_stats`.",
      "Validate structure with `blender_asset_validate` (non-manifold, loose, degenerate, inconsistent normals, unapplied scale) and look at it with `blender_asset_inspect` (front / side / top / iso renders) or `get_viewport_screenshot`.",
      "`execute_blender_code` only for what no named tool does, in small, idempotent snippets; report the exact stdout.",
      "Stop when validation is clean, dimensions match the plan and the inspection renders show the intended silhouette.",
    ],
    pitfalls: ["Unapplied scale / rotation (export comes out wrong-sized).", "Booleans on dense meshes (non-manifold spaghetti).", "Claiming sculpt-level detail from primitives - say what the tools can and cannot do."],
    verify: ["`blender_asset_validate` passes.", "`blender_asset_inspect` renders match the requested proportions."],
    brief: ["give real-world dimensions, style (low-poly / realistic), the parts the asset must have and its purpose (game prop, character, environment)", "state polygon budget and whether UVs / materials / textures are required", "say if the asset is destined for Roblox (export constraints apply)"],
    complements: ["blender_to_roblox"],
  });

  add({
    id: "blender_to_roblox", title: "Blender → Roblox pipeline", env: "blender",
    summary: "Export clean FBX / glTF from Blender, import into Studio, verify the MeshPart and keep within Roblox limits.",
    triggers: { "to roblox": 6, "into roblox": 6, "into studio": 6, "import into studio": 6, fbx: 6, gltf: 5, glb: 5, obj: 3, export: 4, import: 3, "send to studio": 6, meshpart: 5, "mesh part": 5, "roblox mesh": 6, "collision": 2, "triangle limit": 6, "10k": 2, "20k": 2 },
    avoid: { gui: 4, datastore: 5 },
    intents: [],
    procedure: [
      "Inspect first - `blender_asset_inspect` for the real dimensions, triangle count, materials and transforms - then prepare the asset: `blender_apply_transforms`, `blender_origin_to_bottom`, `blender_triangulate` if needed, `blender_recalc_normals`; keep each mesh well under Roblox's import limits (the bridge import caps at 20k triangles / 60k vertices per mesh) - `mesh_decimate` only when the budget demands it and say so.",
      "Export with `blender_asset_export` (preferred: known-good FBX settings) or `blender_export_fbx` / `blender_export_gltf`; note the file path it returns.",
      "Send it: `blender_send_to_studio` or `asset_bridge_import` creates Workspace.Total_Imported (EditableMesh path, local plugin only); when the bridge is unavailable, give the user the exact file path and the manual Import 3D steps - do not pretend it was imported.",
      "Verify in Studio with `mesh_import_verify` (part count, size, materials) and `inspect_instance`; fix scale (Blender metres vs studs, 1 m ≈ 3.571 studs at Roblox default) and collision fidelity as the request needs.",
      "Textures / materials: `mesh_set_texture` with an asset id the user owns; no invented texture ids.",
      "Round-trip is only passed when the object is in the DataModel and read back - an exported file alone is not success.",
    ],
    pitfalls: ["Scale mismatch (metres vs studs) and Y/Z axis confusion.", "Dense meshes rejected or auto-decimated silently.", "Claiming textures / materials transferred when only geometry did."],
    verify: ["`mesh_import_verify` reports the expected part count and size.", "`inspect_instance` on the imported MeshPart shows the intended size / material."],
    brief: ["state target size in studs, collision needs and whether materials / textures must transfer", "say if the Blender bridge is connected or the user will import manually", "require read-back verification in Studio, not just an exported file"],
    complements: ["blender_modeling", "world_building"],
  });

  add({
    id: "creative_production", title: "Creative production (writing · concept · art direction)", env: "general",
    summary: "Stories, scripts, concepts, lore, dialogue, names, art direction and briefs - audience, tone and format made explicit.",
    triggers: { story: 5, stories: 5, lore: 5, dialogue: 4, poem: 5, song: 4, lyrics: 5, essay: 5, blog: 4, article: 4, email: 4, letter: 4, tweet: 4, post: 2, caption: 4, slogan: 5, tagline: 5, name: 1, names: 3, "game name": 5, concept: 4, "concept art": 5, "art direction": 5, "mood board": 5, moodboard: 5, pitch: 4, description: 2, backstory: 5, character: 2, worldbuilding: 5, "world building": 2, script: 1, brand: 4, logo: 4, design: 2, tone: 3, style: 2, creative: 4, "write me": 3 },
    avoid: { luau: 4, datastore: 5, remote: 4, blender: 3, bug: 4 },
    intents: [],
    procedure: [
      "Pin the brief: audience, purpose, medium / format, length, tone and voice, language; what already exists (names, lore, references) must be reused, not reinvented.",
      "Define the constraints that matter for the medium (word / line counts, rating, banned themes, platform rules, brand voice) and the acceptance test (what the user will check).",
      "Offer structure before prose for anything long (outline / beats / sections) when the user wants to steer; otherwise deliver directly and offer one alternative angle.",
      "Make choices explicit and reversible: mark inventions (names, facts, dates) as '(assumed)' / '(invented)' so the user can swap them.",
      "Quality pass: consistency with existing material, tone drift, clichés, repetition, length vs request; cut what does not serve the purpose.",
      "Stop when the piece meets the brief's format and tone and every invented detail is flagged.",
    ],
    pitfalls: ["Inventing canon that contradicts the user's existing lore.", "Generic voice when a brand / character voice exists.", "Over-length - a short request deserves a short result."],
    verify: ["Format, length and language match the brief.", "Every invented name / fact is marked as such."],
    brief: ["state audience, purpose, format, length and tone; the language it must be in", "list existing material (names, lore, references, examples) that must be respected", "say what to avoid and how the user will judge it"],
    complements: ["ui_ux"],
  });

  add({
    id: "general_engineering", title: "General software engineering", env: "general",
    summary: "Non-Roblox code and systems: language / runtime pinned, interfaces, tests, edge cases, error handling.",
    triggers: { python: 5, javascript: 5, typescript: 5, rust: 5, "c#": 5, java: 4, "c++": 5, go: 2, sql: 5, html: 4, css: 4, react: 5, node: 4, api: 3, rest: 3, endpoint: 4, database: 4, docker: 5, regex: 5, algorithm: 4, "data structure": 5, "unit test": 5, tests: 3, cli: 4, library: 3, package: 3, function: 1, class: 2, bug: 1, refactor: 2, script: 1, program: 3, app: 2, website: 4, "web app": 5, server: 1, json: 2, csv: 3, parse: 3, parser: 4 },
    avoid: { roblox: 5, luau: 5, studio: 4, blender: 4, datastore: 5 },
    intents: [],
    procedure: [
      "Pin the environment: language and version, runtime / framework, package manager, OS, how the code is run and tested - from the user's words or the project files, never assumed silently.",
      "Define the interface first (inputs, outputs, errors, side effects) and the acceptance tests; for changes to existing code, read the surrounding code and its tests before editing.",
      "Implement the smallest complete change: idiomatic for the language, explicit error handling at boundaries, no new dependency unless the user agrees.",
      "Cover edge cases on purpose: empty input, large input, unicode, concurrency / ordering, failures of external calls, time zones.",
      "Verify: run the tests or a reproducible command and quote the real output; if nothing can be run, say so and show how the user runs it.",
      "Stop when tests pass (or the exact manual check is documented) and the change is explained in a few sentences.",
    ],
    pitfalls: ["Guessing the language version / framework.", "Rewriting files wholesale for a small fix.", "Reporting 'should work' instead of an observed result."],
    verify: ["Test / run output is quoted, not described.", "The diff touches only what the change needs."],
    brief: ["name language, version, framework, runtime and how it is run / tested", "state inputs, outputs, error behaviour and performance limits that matter", "list what must not change (public API, file layout, dependencies)"],
    complements: ["creative_production"],
  });

  const BY_ID = Object.fromEntries(E.map((x) => [x.id, x]));
  const IDS = E.map((x) => x.id);
  const CMD_RE = /`([a-z][a-z0-9_]{2,60})`/g;
  function commandsOf(x) {
    const out = [];
    for (const line of [].concat(x.procedure || [], x.pitfalls || [], x.verify || [])) {
      let m; CMD_RE.lastIndex = 0;
      while ((m = CMD_RE.exec(line))) if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  // ───────────────────────── analysis ─────────────────────────
  const norm = (t) => String(t || "").toLowerCase().replace(/[`*_#>]+/g, " ").replace(/\s+/g, " ").trim();
  const ROBLOX_RE = /\b(roblox|studio|luau|screengui|remoteevent|datastore|workspace|replicatedstorage|serverscriptservice|starterplayer|startergui|humanoid|leaderstats|r6|r15|rbxassetid|part|parts|meshpart|localscript|modulescript|gui|hud|npc|obby|tycoon|simulator|place|playtest|play test)\b/i;
  const BLENDER_RE = /\b(blender|bpy|fbx|gltf|glb|topology|retopo|uv unwrap|modifier|armature|principled|bake|baking|sculpt)\b/i;
  const CREATIVE_RE = /\b(story|lore|poem|essay|email|letter|blog|article|lyrics|slogan|tagline|backstory|dialogue|worldbuilding|pitch)\b/i;
  const GENERAL_CODE_RE = /\b(python|javascript|typescript|rust|java|c#|c\+\+|sql|react|node\.?js|docker|regex|html|css|django|flask|express)\b/i;
  const FIX_RE = /\b(fix|bug|bugs|broken|error|errors|doesn'?t work|doesnt work|not working|won'?t work|stopped working|nothing happens|crash|crashes|debug|exception|nil value|attempt to|stack trace|why (does|is|doesn'?t|isn'?t))\b/i;
  const EXPLAIN_RE = /^(what|why|how (does|do|is|are|did|can i tell)|explain|describe|tell me|is (it|this|there)|are (there|these)|can you explain|help me understand|compare|define|summari[sz]e)\b/i;
  const REVIEW_RE = /^(review|audit|inspect|analy[sz]e|look (at|over|through)|check|rate)\b/i;
  const PLAN_RE = /\b(plan|outline|roadmap|propose|proposal|strategy|approach|how would you|what steps|break (it )?down|design doc)\b/i;
  const CREATE_RE = /\b(make|create|build|add|write|implement|generate|design|set ?up|spawn|place|insert|put|give me|i need|i want|animate|draw|compose)\b/i;
  const EXCLUSION_RE = /\b(?:do not|don'?t|dont|never|without|no|avoid|not|must not|shouldn'?t|should not)\s+(?:use |using |any |a |an |the |add |adding |touch |touching |change |changing |modify |modifying |create |creating |include |including )*([a-z][a-z0-9'\-]*(?:\s+[a-z][a-z0-9'\-]*){0,2})/gi;
  const EXCLUSION_STOP = new Set(["the", "a", "an", "it", "that", "this", "me", "you", "to", "be", "is", "are", "was", "were", "do", "does", "did", "just", "only", "more", "less", "so", "too", "very", "also", "and", "or", "but", "if", "then", "need", "needs", "want", "wants", "sure", "yet", "now", "work", "working", "works", "matter", "longer", "idea", "clue", "problem", "problems", "worry", "worries", "way", "one", "thing", "things", "point", "question", "questions", "doubt", "doubts", "much", "many", "really", "able", "allowed", "possible", "know", "like"]);
  const NUMBER_RE = /(?<![\w.])(\d+(?:[.,]\d+)?)(\s?(?:%|px|studs?|seconds?|secs?|s\b|ms|minutes?|mins?|hours?|days?|fps|hp|coins?|robux|words?|lines?|items?|slots?|players?|levels?|waves?|rounds?|x|×|k\b|m\b|cm|mm|kb|mb|gb))?/gi;
  const QUOTE_RE = /"([^"\n]{2,80})"|'([^'\n]{2,80})'|“([^”\n]{2,80})”/g;
  const PATH_RE = /\b(?:game\.)?(?:Workspace|ReplicatedStorage|ServerScriptService|ServerStorage|StarterGui|StarterPlayer|StarterPack|Lighting|SoundService|Players|Teams)(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;
  const FILE_RE = /\b[\w\-./]+\.(?:lua|luau|rbxm|rbxmx|rbxl|json|js|ts|tsx|py|rs|fbx|glb|gltf|obj|png|jpg|csv|md|txt|html|css)\b/gi;
  const TECH_RE = /\b(R6|R15|Rthro|TypeScript|JavaScript|Python|Rust|React|Vue|Svelte|Luau|Roact|Fusion|Knit|ProfileService|DataStore2|Rojo|Wally|Blender|Unity|Godot|Unreal|FBX|glTF|OBJ|Node\.js|Deno|Bun|Django|Flask|Express)\b/g;
  const FORMAT_RE = /\b(as (?:a |an )?(?:table|list|bullet(?:ed)? list|json|yaml|csv|markdown|outline|checklist|diagram|one[- ]liner|paragraph|step[- ]by[- ]step)|in (?:bullets|bullet points|prose|markdown|json|a table)|(?:under|max(?:imum)?|at most|no more than) \d+ (?:words|lines|sentences|characters|items|steps)|one (?:sentence|paragraph|line) only|tl;?dr)\b/gi;
  const LANG_HINT_RE = /\b(in (?:english|turkish|türkçe|german|deutsch|french|français|spanish|español|portuguese|português|russian|japanese|korean|chinese|arabic)|türkçe|deutsch|español|français)\b/i;
  const CODE_FENCE_RE = /```[a-zA-Z0-9_-]*\n[\s\S]*?```/g;
  const COMPLEX_RE = /\b(full|complete|entire|whole|end[- ]to[- ]end|production|multiplayer|system|systems|framework|architecture|pipeline|everything|all of|and also|as well as|plus)\b/gi;

  function countHits(re, t) { const m = t.match(re); return m ? m.length : 0; }

  // analyze(text, ctx) → task record for the enhancer / rider. ctx = { engine:
  // "roblox" | "local", task: TotalOrchestrator.classifyTask record (optional,
  // reused for intent so the two layers never disagree), focus }.
  function analyze(text, ctx) {
    ctx = ctx || {};
    const raw = String(text || "").replace(/\r\n?/g, "\n");
    const codeBlocks = raw.match(CODE_FENCE_RE) || [];
    const prose = raw.replace(CODE_FENCE_RE, " ");
    const t = norm(prose);
    const words = t ? t.split(" ").length : 0;
    const task = ctx.task && typeof ctx.task === "object" ? ctx.task : null;
    // Environment
    let env = "general";
    const rb = countHits(new RegExp(ROBLOX_RE.source, "gi"), prose), bl = countHits(new RegExp(BLENDER_RE.source, "gi"), prose);
    const cr = countHits(new RegExp(CREATIVE_RE.source, "gi"), prose), gc = countHits(new RegExp(GENERAL_CODE_RE.source, "gi"), prose);
    if (bl && bl >= rb) env = "blender";
    else if (rb) env = "roblox";
    else if (gc && gc >= cr) env = "general";
    else if (cr) env = "general";
    else if (ctx.engine === "roblox" || ctx.focus === "roblox") env = "roblox";
    if (ctx.focus === "general" && !bl) env = "general";
    if (ctx.engine === "local" && !bl && !rb) env = "general";
    // Intent (reuse the orchestrator's verdict when given)
    let intent = task && task.intent ? task.intent : "";
    if (!intent) {
      if (FIX_RE.test(t) && !/\bfixed\b/.test(t)) intent = "fix";
      else if (REVIEW_RE.test(t)) intent = "review";
      else if (PLAN_RE.test(t) && !CREATE_RE.test(t.replace(PLAN_RE, " "))) intent = "plan";
      else if (EXPLAIN_RE.test(t) && !CREATE_RE.test(t)) intent = "explain";
      else if (CREATE_RE.test(t)) intent = "implement";
      else if (/\?\s*$/.test(t)) intent = "question";
      else intent = words ? "implement" : "question";
    }
    // Constraints the rewrite must keep
    const exclusions = [];
    let m; const exre = new RegExp(EXCLUSION_RE.source, "gi");
    while ((m = exre.exec(prose)) && exclusions.length < 8) {
      const phrase = m[1].toLowerCase().trim();
      const head = phrase.split(" ")[0];
      if (!EXCLUSION_STOP.has(head) && head.length > 2 && !exclusions.includes(phrase)) exclusions.push(phrase);
    }
    const numbers = []; const nre = new RegExp(NUMBER_RE.source, "gi");
    while ((m = nre.exec(prose)) && numbers.length < 12) { const s = (m[1] + (m[2] || "")).trim(); if (!numbers.includes(s)) numbers.push(s); }
    const quotes = []; const qre = new RegExp(QUOTE_RE.source, "g");
    while ((m = qre.exec(prose)) && quotes.length < 8) { const s = (m[1] || m[2] || m[3] || "").trim(); if (s && !quotes.includes(s)) quotes.push(s); }
    const paths = uniq((prose.match(PATH_RE) || []).slice(0, 8));
    const files = uniq((prose.match(FILE_RE) || []).slice(0, 8));
    const tech = uniq((prose.match(TECH_RE) || []).slice(0, 8));
    const formats = uniq((prose.match(FORMAT_RE) || []).map((s) => s.trim()).slice(0, 4));
    const langHint = (prose.match(LANG_HINT_RE) || [""])[0];
    // Complexity
    const complexHits = countHits(COMPLEX_RE, t);
    const sentences = (prose.match(/[.!?]+(\s|$)/g) || []).length;
    let complexity = "simple";
    if (words >= 90 || complexHits >= 3 || sentences >= 6) complexity = "complex";
    else if (words >= 25 || complexHits >= 1 || sentences >= 3 || codeBlocks.length) complexity = "standard";
    const ambiguous = words > 0 && words <= 6 && !paths.length && !numbers.length && !quotes.length && intent === "implement";
    return {
      v: 1, text: raw.slice(0, 4000), words, env, intent, complexity, ambiguous,
      domains: domainScores(t, env, intent),
      constraints: { exclusions, numbers, quotes, paths, files, tech, formats, langHint, codeBlocks: codeBlocks.length },
      codeBlocks,
      taskCategories: task && Array.isArray(task.categories) ? task.categories.slice() : [],
      engine: ctx.engine || "",
    };
  }
  function uniq(xs) { return xs.filter((x, i) => xs.indexOf(x) === i); }

  // domainScores(t, env, intent) → [{id, score, why[]}] for every expert
  // (unsorted; select() ranks). Phrases count double, "avoid" words subtract,
  // env mismatch is a strong penalty, intent affinity a bonus.
  function domainScores(t, env, intent) {
    const padded = " " + t + " ";
    return E.map((x) => {
      let score = 0; const why = [];
      for (const [word, w] of Object.entries(x.triggers)) {
        const phrase = word.includes(" ");
        const re = new RegExp("(^|[^a-z0-9])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "(?=$|[^a-z0-9])", "i");
        if (re.test(padded)) { const pts = w * (phrase ? 2 : 1); score += pts; why.push(word); }
      }
      for (const [word, w] of Object.entries(x.avoid || {})) {
        const re = new RegExp("(^|[^a-z0-9])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "(?=$|[^a-z0-9])", "i");
        if (re.test(padded)) score -= w;
      }
      if (score > 0) {
        if (x.env === env) score += 3;
        else if (x.env === "general" && env !== "general") score -= 6;
        else if (x.env !== "general" && env === "general") score -= 4;
        else if (x.env !== env) score -= 8; // roblox ↔ blender
        if (x.intents && x.intents.length) score += x.intents.includes(intent) ? 2 : -3;
        if (x.id === "debug_repair" && intent !== "fix" && intent !== "review" && intent !== "inspect") score -= 6;
      }
      return { id: x.id, score: Math.round(score * 10) / 10, why: why.slice(0, 6) };
    });
  }

  // ───────────────────────── selection ─────────────────────────
  // select(analysis, { max, min, publicItems }) → { picked[], excluded[], explain }
  // Deterministic: score desc, then library order. Complementary skills only
  // when they scored on their own (never injected blindly). Precedence when
  // two experts of the same slot collide is by score; the caller's own rules
  // (system > project > user explicit) are applied by the consumer, who always
  // treats expert text as advice.
  function select(analysis, opts) {
    opts = opts || {};
    const max = Math.max(1, Math.min(4, opts.max || 3));
    const min = typeof opts.min === "number" ? opts.min : 6;
    const a = analysis && analysis.domains ? analysis : analyze(String(analysis || ""), opts);
    const scored = a.domains.map((d) => ({ id: d.id, score: d.score, why: d.why, order: IDS.indexOf(d.id) }))
      .sort((p, q) => q.score - p.score || p.order - q.order);
    const picked = [], excluded = [];
    for (const s of scored) {
      if (s.score < min) { if (s.score > 0 && excluded.length < 3) excluded.push({ id: s.id, score: s.score, reason: "weak match" }); continue; }
      if (picked.length >= max) { excluded.push({ id: s.id, score: s.score, reason: "over the limit of " + max }); continue; }
      // Primary needs a clear lead; complementary entries ride only when the
      // primary lists them (or they are strong on their own).
      const primary = picked[0];
      const isComplement = !primary || (BY_ID[primary.id].complements || []).includes(s.id) || s.score >= Math.max(min, primary.score * 0.6);
      if (!isComplement) { excluded.push({ id: s.id, score: s.score, reason: "not complementary to " + primary.id }); continue; }
      picked.push({ id: s.id, title: BY_ID[s.id].title, score: s.score, why: s.why, role: picked.length ? "complementary" : "primary" });
    }
    // Installed public abilities / skills: ranked by token overlap, max 2.
    const pub = rankPublic(a, opts.publicItems || [], 2);
    const explain = picked.length
      ? picked.map((p) => `${p.title} (${p.role}: ${p.why.slice(0, 3).join(", ") || "domain match"})`).join(" · ")
      : "no expert matched clearly - generic strategy";
    return { picked, excluded, publicItems: pub, explain, env: a.env, intent: a.intent, complexity: a.complexity };
  }

  // Installed public skills (user-made) are ranked with the same idea: words of
  // the request against name / title / tags / triggers / description.
  function rankPublic(analysis, items, max) {
    const t = " " + norm(analysis && analysis.text || "") + " ";
    // light singular/plural folding only ("lanterns" ↔ "lantern_row"); no
    // other stemming so unrelated words never collide.
    const stem = (w) => (w.length > 4 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    const toks = new Set(t.split(" ").filter((w) => w.length > 2).map(stem));
    const out = [];
    for (const it of items || []) {
      if (!it || it.enabled === false || it.kind === "mode") continue;
      let score = 0; const why = [];
      const fields = [].concat(String(it.name || "").split("_"), it.tags || [], it.triggers || [], String(it.title || "").toLowerCase().split(/\W+/));
      for (const f of fields) { const w = String(f || "").toLowerCase().trim(); if (w.length > 2 && toks.has(stem(w))) { score += 3; if (!why.includes(w)) why.push(w); } }
      for (const tr of it.triggers || []) { const p = String(tr || "").toLowerCase().trim(); if (p.includes(" ") && t.includes(" " + p + " ")) { score += 4; why.push(p); } }
      const desc = norm(it.description || "").split(" ");
      let dh = 0; for (const w of desc) if (w.length > 4 && toks.has(stem(w))) dh++;
      score += Math.min(4, dh);
      if (score >= 5) out.push({ id: it.id, name: it.name, kind: it.kind, score, why: why.slice(0, 4) });
    }
    return out.sort((p, q) => q.score - p.score || String(p.name).localeCompare(String(q.name))).slice(0, max || 2);
  }

  // ───────────────────────── text renderers ─────────────────────────
  // expertText(id) → the full procedure (for the `skill` command).
  function expertText(id) {
    const x = BY_ID[id];
    if (!x) return "";
    const L = [];
    L.push(`SKILL ${x.id} — ${x.title} [${x.env}]`);
    L.push(x.summary);
    L.push("", "PROCEDURE:");
    x.procedure.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push("", "PITFALLS:"); for (const p of x.pitfalls) L.push(`- ${p}`);
    L.push("", "VERIFY BEFORE REPORTING:"); for (const v of x.verify) L.push(`- ${v}`);
    const cmds = commandsOf(x);
    if (cmds.length) L.push("", `COMMANDS THIS SKILL USES (all exist in this build): ${cmds.join(", ")}`);
    if (x.complements && x.complements.length) L.push(`RELATED SKILLS: ${x.complements.map((c) => `skill {name: "${c}"}`).join(", ")}`);
    L.push("", "This skill is guidance only: nothing ran. Commands, permissions and validation stay authoritative; the user's explicit instructions win over any step above.");
    return L.join("\n");
  }
  // listText(query?) → catalogue (or best matches for a free-text query).
  function listText(query) {
    const q = norm(query);
    let rows = E;
    let head = `SKILLS — ${E.length} built-in expert procedures. Load one with skill {name: "<id>"}:`;
    if (q) {
      const a = analyze(q, {});
      const ranked = a.domains.filter((d) => d.score > 0).sort((p, c) => c.score - p.score).slice(0, 5);
      if (ranked.length) { rows = ranked.map((d) => BY_ID[d.id]); head = `SKILLS matching "${String(query).trim().slice(0, 60)}" (best first) - load one with skill {name: "<id>"}:`; }
      else head = `No skill matched "${String(query).trim().slice(0, 60)}". All ${E.length} skills:`;
    }
    return [head].concat(rows.map((x) => `- ${x.id} [${x.env}] — ${x.summary}`)).join("\n");
  }
  // answer(args) → text for the `skill` command (name | query | nothing).
  function answer(args) {
    const a = args && typeof args === "object" ? args : { name: args };
    const ref = String(a.name || a.skill || a.id || a.query || a.topic || "").trim();
    if (!ref) return listText("");
    const id = resolveId(ref);
    if (id) return expertText(id);
    return listText(ref);
  }
  const ALIASES = { debug: "debug_repair", debugging: "debug_repair", remotes: "networking", remote: "networking", security: "networking", pathfinding: "gameplay_systems", npc: "gameplay_systems", combat: "gameplay_systems", datastore: "data_persistence", data: "data_persistence", ui: "ui_ux", gui: "ui_ux", physics: "world_building", building: "world_building", tween: "animation", anim: "animation", blender: "blender_modeling", export: "blender_to_roblox", scripting: "luau_scripting", luau: "luau_scripting", perf: "performance", audio: "sfx", sound: "sfx", cutscene: "cinematics", camera: "cinematics", writing: "creative_production", creative: "creative_production", code: "general_engineering", architecture: "project_analysis" };
  function resolveId(ref) {
    const k = norm(ref).replace(/\s+/g, "_");
    if (BY_ID[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    const hit = E.find((x) => x.id.startsWith(k) || x.title.toLowerCase() === k.replace(/_/g, " "));
    return hit ? hit.id : "";
  }

  // rider(selection, { tight }) → ≤ ~620 chars (≤ ~300 tight) that ride on the
  // first tool result next to the orchestrator's task brief. Only the primary
  // expert's essentials; the rest is one `skill` call away. Empty when nothing
  // matched clearly, so unrelated requests get nothing injected.
  function rider(sel, opts) {
    opts = opts || {};
    if (!sel || !sel.picked || !sel.picked.length) return "";
    const p = sel.picked[0]; const x = BY_ID[p.id];
    if (!x) return "";
    const tight = !!opts.tight;
    const cap = tight ? 300 : 620;
    const head = `(Expert note from TotalScript, not the user.) Specialist: ${x.title}. `;
    const more = [p.id].concat(sel.picked.slice(1).map((q) => q.id));
    const tail = tight
      ? ` Full procedure: ${more.slice(0, 2).map((id) => `skill {name: "${id}"}`).join(", ")}. The user's instructions and the permission mode win over this note.`
      : ` Verify: ${x.verify[0].replace(/`/g, "")} Full procedure${more.length > 1 ? "s" : ""}: ${more.map((id) => `skill {name: "${id}"}`).join(", ")}. The user's explicit instructions and the permission mode override this note.`;
    // The steps are what gets trimmed - the pointer to the full skill and the
    // precedence sentence always survive.
    const room = Math.max(60, cap - head.length - tail.length);
    let steps = x.procedure.slice(0, tight ? 1 : 2).map((s) => s.replace(/`/g, "")).join(" ");
    if (steps.length > room) steps = steps.slice(0, room - 1).replace(/\s+\S*$/, "") + "…";
    return head + steps + tail;
  }

  // ───────────────────────── enhancer: modes, strategy, excerpts, checks ─────────────────────────
  const MODES = [
    { id: "auto", label: "Auto", hint: "Picks Quick / Expert / Deep / Creative / Debug from the request itself" },
    { id: "quick", label: "Quick", hint: "Tidy and complete the request in a few lines - no sections, no extras" },
    { id: "expert", label: "Expert", hint: "Precise brief: scope, behaviour, constraints, done-when; implied requirements made explicit" },
    { id: "deep", label: "Deep Engineering", hint: "Architecture, data flow, failure modes, verification and acceptance tests for complex systems" },
    { id: "creative", label: "Creative Pro", hint: "Audience, tone, format, references and what to avoid - for writing, concepts and art direction" },
    { id: "debug", label: "Debug & Repair", hint: "Symptom, reproduction, suspected area, what must not change, proof the bug is gone" },
  ];
  const MODE_IDS = MODES.map((m) => m.id);
  function pickMode(a) {
    if (!a) return "expert";
    if (a.intent === "fix") return "debug";
    const creative = a.domains && a.domains.some((d) => d.id === "creative_production" && d.score >= 6);
    if (creative && a.env === "general") return "creative";
    if (a.complexity === "complex") return "deep";
    // Quick only when there is nothing to make precise: short questions /
    // explanations. A short BUILD request still gets the Expert pass (that is
    // what the enhancer is for) - Expert is told to keep simple things short.
    if ((a.intent === "explain" || a.intent === "question") && a.words <= 14) return "quick";
    return "expert";
  }
  // Strategy lines per mode: they change WHAT the rewrite does, not add boilerplate.
  function modeStrategy(mode, a) {
    const env = a && a.env || "roblox";
    switch (mode) {
      case "quick": return "MODE: Quick - keep the user's wording, fix only what blocks execution (missing target, missing size / count, ambiguous pronoun). No headings, no acceptance criteria, at most 4 lines. If nothing is missing, return the request nearly unchanged.";
      case "deep": return "MODE: Deep Engineering - this is a multi-part system. Add: COMPONENTS (each piece and where it lives), DATA & FLOW (what state exists, who owns it, how it moves" + (env === "roblox" ? " between server and client" : "") + "), FAILURE MODES (what can go wrong and the expected handling), VERIFICATION (how each part is proven to work), ACCEPTANCE TESTS (3-6 checkable statements). Keep every section factual to the request; mark defaults '(assumed)'.";
      case "creative": return "MODE: Creative Pro - this is creative work, not engineering. Use: GOAL, AUDIENCE & PURPOSE, TONE & VOICE, FORMAT & LENGTH, MUST INCLUDE (names, lore, facts the user gave - verbatim), AVOID, DONE WHEN. Do not add technical requirements, code or implementation detail.";
      case "debug": return "MODE: Debug & Repair - structure as SYMPTOM (exact error / behaviour, quoted), WHERE (scripts, objects, lines if known), REPRODUCTION (steps), SUSPECTED CAUSE (only if the user hinted one; else say 'unknown - find root cause'), MUST NOT CHANGE, DONE WHEN (the error is gone after re-running and the cause is stated). Ask for the minimal fix, not a rewrite.";
      case "expert": default: return "MODE: Expert - make implied requirements explicit at the right level of detail (names, counts, where things live, who owns state), add acceptance points only for things that can be checked, and keep a simple request short.";
    }
  }
  // preserveLines(analysis) → one deterministic MUST-KEEP line (or "").
  function preserveLines(a) {
    if (!a || !a.constraints) return "";
    const c = a.constraints; const bits = [];
    if (c.exclusions.length) bits.push("exclusions: " + c.exclusions.map((e) => `no ${e}`).join("; "));
    if (c.numbers.length) bits.push("numbers: " + c.numbers.join(", "));
    if (c.quotes.length) bits.push("exact strings: " + c.quotes.map((q) => `"${q}"`).join(", "));
    if (c.paths.length) bits.push("paths: " + c.paths.join(", "));
    if (c.files.length) bits.push("files: " + c.files.join(", "));
    if (c.tech.length) bits.push("technology: " + c.tech.join(", "));
    if (c.formats.length) bits.push("output format: " + c.formats.join("; "));
    if (c.langHint) bits.push("language: " + c.langHint);
    if (c.codeBlocks) bits.push(`${c.codeBlocks} code block${c.codeBlocks > 1 ? "s" : ""}: copy verbatim, unchanged`);
    if (!bits.length) return "";
    return "MUST KEEP (found in the rough request; restate each one, never drop or invert): " + bits.join(" · ") + ".";
  }
  // expertise(selection, { maxChars }) → the excerpt block for the request (or "").
  function expertise(sel, opts) {
    opts = opts || {};
    if (!sel || !sel.picked || !sel.picked.length) return "";
    const cap = opts.maxChars || 900;
    const L = ["DOMAIN EXPERTISE (use it to make implied requirements explicit and to pick defaults - never to add features the user did not ask for):"];
    for (const p of sel.picked.slice(0, 3)) {
      const x = BY_ID[p.id]; if (!x) continue;
      L.push(`- ${x.title}: ${x.brief.join("; ")}.`);
    }
    if (sel.publicItems && sel.publicItems.length) L.push(`- Installed user procedures that may be named in the prompt: ${sel.publicItems.map((p) => p.name).join(", ")}.`);
    let s = L.join("\n");
    if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…";
    return s;
  }

  // validateEnhanced(rough, enhanced, { analysis, knownCommands, mode }) →
  // { ok, issues[{kind, severity:"warn"|"info", text}], repaired }
  // Deterministic checks a reviewer would do; `repaired` is the enhanced text
  // with dropped code blocks re-attached verbatim (never anything invented).
  function validateEnhanced(rough, enhanced, opts) {
    opts = opts || {};
    const a = opts.analysis || analyze(rough, {});
    const out = String(enhanced || "");
    const lo = norm(out);
    const issues = [];
    const c = a.constraints || {};
    const missing = (xs, label, fmt) => { const gone = xs.filter((x) => !lo.includes(norm(x))); if (gone.length) issues.push({ kind: label, severity: "warn", text: `dropped ${label}: ${gone.map(fmt || ((s) => s)).join(", ")}` }); return gone; };
    missing(c.numbers || [], "numbers");
    missing(c.quotes || [], "exact strings", (s) => `"${s}"`);
    missing(c.paths || [], "paths");
    missing(c.files || [], "files");
    missing(c.tech || [], "technology");
    // Exclusions must be restated with a negation nearby.
    for (const ex of c.exclusions || []) {
      const i = lo.indexOf(norm(ex));
      if (i < 0) { issues.push({ kind: "exclusion", severity: "warn", text: `exclusion not restated: "no ${ex}"` }); continue; }
      const window = lo.slice(Math.max(0, i - 60), i);
      if (!/\b(no|not|never|without|avoid|don'?t|do not|must not|exclude|excluding|forbidden|disallow)\b/.test(window)) issues.push({ kind: "exclusion", severity: "warn", text: `"${ex}" appears without its negation - the rewrite may have turned "no ${ex}" into a requirement` });
    }
    // Code blocks verbatim.
    let repaired = out; const dropped = [];
    for (const block of a.codeBlocks || []) {
      const body = block.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "").trim();
      if (!out.includes(body)) dropped.push(block);
    }
    if (dropped.length) {
      issues.push({ kind: "code", severity: "warn", text: `${dropped.length} code block${dropped.length > 1 ? "s" : ""} from the request ${dropped.length > 1 ? "are" : "is"} missing or changed` });
      repaired = out.replace(/\s+$/, "") + "\n\nCODE FROM MY REQUEST (keep exactly as written):\n" + dropped.join("\n\n");
    }
    // Rewrite that acts instead of rewriting / asks questions.
    if (/^\s*(?:sure|certainly|here(?:'s| is)|i (?:will|can|have|'ve))\b/i.test(out)) issues.push({ kind: "preamble", severity: "info", text: "starts with assistant chatter - trim the first line" });
    if (/\?\s*$/.test(out.trim()) && (out.match(/\?/g) || []).length >= 2) issues.push({ kind: "questions", severity: "warn", text: "the rewrite asks questions instead of stating assumptions" });
    // Length discipline.
    const rw = a.words || 1, ow = (lo.match(/\S+/g) || []).length;
    const ratio = ow / Math.max(6, rw);
    const limit = opts.mode === "quick" ? 3 : a.complexity === "complex" ? 10 : a.complexity === "standard" ? 7 : 6;
    if (ratio > limit && ow > 90) issues.push({ kind: "length", severity: "info", text: `${ow} words for a ${rw}-word request - likely over-specified; cut what the user did not imply` });
    if (ow < 3) issues.push({ kind: "empty", severity: "warn", text: "the rewrite is empty or trivial" });
    // Command / tool names that do not exist in this build.
    const known = opts.knownCommands instanceof Set ? opts.knownCommands : Array.isArray(opts.knownCommands) ? new Set(opts.knownCommands) : null;
    if (known && known.size) {
      const roughLo = norm(rough);
      const names = uniq(out.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4}\b/g) || []).filter((n) => !known.has(n) && !roughLo.includes(n) && !/^(e_g|i_e|snake_case|camel_case|user_id|player_id|asset_id|game_pass|dev_product|max_health|is_|has_|get_|set_|on_|total_|my_)/.test(n));
      if (names.length) issues.push({ kind: "commands", severity: "warn", text: `names that look like commands but do not exist in this build: ${names.slice(0, 5).join(", ")}` });
    }
    // Technology flips the user did not ask for.
    const FLIPS = [["r6", "r15"], ["localscript", "server script"], ["client", "server-only"], ["2d", "3d"]];
    const rl = norm(rough);
    for (const [p, q] of FLIPS) {
      const inR = rl.includes(p) && !rl.includes(q), inO = lo.includes(q) && !lo.includes(p);
      if (inR && inO) issues.push({ kind: "flip", severity: "warn", text: `request says "${p}" but the rewrite says "${q}"` });
    }
    return { ok: !issues.some((i) => i.severity === "warn"), issues, repaired: dropped.length ? repaired : out, dropped: dropped.length };
  }

  // One-call helper for the enhancer: everything main.js needs to build the
  // request and describe it in the UI.
  function plan(rough, ctx) {
    ctx = ctx || {};
    const a = analyze(rough, ctx);
    const mode = MODE_IDS.includes(ctx.mode) && ctx.mode !== "auto" ? ctx.mode : pickMode(a);
    const sel = select(a, { max: mode === "quick" ? 1 : 3, min: 6, publicItems: ctx.publicItems || [] });
    return {
      analysis: a, mode, modeAuto: !(MODE_IDS.includes(ctx.mode) && ctx.mode !== "auto"), selection: sel,
      strategy: modeStrategy(mode, a),
      preserve: preserveLines(a),
      expertise: mode === "quick" ? "" : expertise(sel, { maxChars: mode === "deep" ? 1100 : 900 }),
      focus: a.env === "roblox" ? "roblox" : "general",
    };
  }

  const api = {
    VERSION, EXPERTS: E.map((x) => Object.assign({}, x, { commands: commandsOf(x) })), IDS, MODES,
    analyze, select, rankPublic, expertText, listText, answer, resolveId, rider,
    pickMode, modeStrategy, preserveLines, expertise, validateEnhanced, plan, commandsOf: (id) => BY_ID[id] ? commandsOf(BY_ID[id]) : [],
  };
  root.TotalSkillIntel = api;
})(typeof window !== "undefined" ? window : globalThis);
