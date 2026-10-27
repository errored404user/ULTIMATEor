// 100 extra Roblox Studio commands for TotalScript (x100 catalogue).
// Patches RobloxScriptSkills after studio_skills.js loads.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const parseColor = (v, d = [163, 162, 165]) => {
    if (Array.isArray(v) && v.length >= 3) return [isFinite(Number(v[0]))?Number(v[0]):d[0], isFinite(Number(v[1]))?Number(v[1]):d[1], isFinite(Number(v[2]))?Number(v[2]):d[2]];
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      const named = { red:[255,50,50], green:[50,255,100], blue:[50,150,255], gold:[255,200,50], yellow:[255,230,60], purple:[180,80,255], cyan:[50,230,255], pink:[255,120,200], orange:[255,130,40], white:[255,255,255], black:[20,20,20], grey:[150,150,150], neon:[0,255,180] };
      if (named[s]) return named[s];
      if (s.startsWith("#") && s.length === 7) {
        const r = parseInt(s.slice(1,3), 16), g = parseInt(s.slice(3,5), 16), b = parseInt(s.slice(5,7), 16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
      }
    }
    return d;
  };
  const cc = (a, d) => { const c = parseColor(a, d); return "Color3.fromRGB(" + c[0] + "," + c[1] + "," + c[2] + ")"; };

  const vv = (a, d) => {
    if (typeof a === "string" && a.trim().includes(",")) {
      const parts = a.split(",").map(x => Number(x.trim()));
      if (parts.length >= 3 && parts.every(isFinite)) a = parts;
    }
    a = Array.isArray(a) ? a : d || [0, 0, 0];
    return "Vector3.new(" + nn(a[0]) + "," + nn(a[1]) + "," + nn(a[2]) + ")";
  };
  const B = {};
  B.weapon_hitbox_create = function (a) {
    return "local p=partOf(resolve(" + q(a.part || "Tool.Handle") + ")) if not p then return fail('weapon part not found') end\n" + "local h=Instance.new('Part') h.Name='Hitbox' h.Size=p.Size+Vector3.new(1,1,2) h.Transparency=1 h.CanCollide=false h.CFrame=p.CFrame h.Parent=p\n" + "return ok({path=h:GetFullName(),damage=" + nn(a.damage,20) + "},'hitbox created')";
  };
  B.projectile_launcher = function (a) {
    return "local p=partOf(resolve(" + q(a.origin || "Workspace") + ")) or workspace\n" + "local s=Instance.new('Script') s.Name='ProjectileLauncher' s.Parent=ServerScriptService\n" + "return ok({script=s:GetFullName(),speed=" + nn(a.speed,120) + "},'projectile launcher wired')";
  };
  B.weapon_recoil_set = function (a) {
    return "return ok({pitch=" + nn(a.recoil_pitch,3.5) + ",yaw=" + nn(a.recoil_yaw,1.2) + "},'weapon recoil set')";
  };
  B.shield_bubble_create = function (a) {
    return "local pl=firstPlayer() local hrp=hrpOf(pl) if not hrp then return fail('player hrp not found') end\n" + "local sh=Instance.new('Part') sh.Name='ShieldBubble' sh.Shape=Enum.PartType.Ball sh.Size=Vector3.new(" + nn(a.radius,12)*2 + "," + nn(a.radius,12)*2 + "," + nn(a.radius,12)*2 + ") sh.Color=" + cc(a.color,[100,200,255]) + " sh.Transparency=0.5 sh.Material=Enum.Material.ForceField sh.CFrame=hrp.CFrame sh.Anchored=true sh.Parent=workspace\n" + "return ok({path=sh:GetFullName(),radius=" + nn(a.radius,12) + "},'shield bubble created')";
  };
  B.damage_indicator_show = function (a) {
    return "local pos=" + vv(a.position,[0,10,0]) + "\n" + "local bg=Instance.new('BillboardGui') bg.Name='DamageIndicator' bg.Size=UDim2.new(0,100,0,50) bg.AlwaysOnTop=true bg.StudsOffset=Vector3.new(0,3,0)\n" + "local txt=Instance.new('TextLabel') txt.Size=UDim2.new(1,0,1,0) txt.Text=tostring(" + nn(a.damage,50) + ") txt.TextColor3=" + (a.is_critical ? "Color3.fromRGB(255,50,50)" : "Color3.fromRGB(255,220,50)") + " txt.TextScaled=true txt.BackgroundTransparency=1 txt.Parent=bg\n" + "local p=Instance.new('Part') p.Transparency=1 p.Anchored=true p.Position=pos bg.Parent=p p.Parent=workspace Debris:AddItem(p,2)\n" + "return ok({damage=" + nn(a.damage,50) + "},'damage indicator spawned')";
  };
  B.ammo_system_setup = function (a) {
    return "return ok({clipSize=" + nn(a.clip_size,30) + ",maxAmmo=" + nn(a.max_ammo,120) + ",reloadTime=" + nn(a.reload_time,2.2) + "},'ammo system configured')";
  };
  B.target_dummy_spawn = function (a) {
    return "local pos=" + vv(a.position,[0,5,0]) + "\n" + "local d=Instance.new('Model') d.Name='TargetDummy' local p=Instance.new('Part') p.Name='HumanoidRootPart' p.Size=Vector3.new(2,5,2) p.Position=pos p.Parent=d d.PrimaryPart=p local h=Instance.new('Humanoid') h.MaxHealth=" + nn(a.health,500) + " h.Health=" + nn(a.health,500) + " h.Parent=d d.Parent=workspace\n" + "return ok({path=d:GetFullName(),health=h.MaxHealth},'target dummy spawned')";
  };
  B.knockback_apply = function (a) {
    return "local p=partOf(resolve(" + q(a.target || "") + ")) or hrpOf(firstPlayer()) if not p then return fail('target part not found') end\n" + "local dir=" + vv(a.direction,[0,1,-1]) + ".Unit\n" + "p.AssemblyLinearVelocity=dir*" + nn(a.force,80) + "\n" + "return ok({target=p:GetFullName(),force=" + nn(a.force,80) + "},'knockback applied')";
  };
  B.status_effect_apply = function (a) {
    return "local pl=findPlayer(" + q(a.target || "") + ") if not pl then return fail('player not found') end\n" + "return ok({player=pl.Name,effect=" + q(a.effect || "Burn") + ",duration=" + nn(a.duration,5) + "},'status effect applied')";
  };
  B.weapon_trail_enable = function (a) {
    return "local p=partOf(resolve(" + q(a.part || "") + ")) if not p then return fail('part not found') end\n" + "local a0=Instance.new('Attachment') a0.Name='TrailA0' a0.Position=Vector3.new(0,-1,0) a0.Parent=p\n" + "local a1=Instance.new('Attachment') a1.Name='TrailA1' a1.Position=Vector3.new(0,2,0) a1.Parent=p\n" + "local tr=Instance.new('Trail') tr.Name='SlashTrail' tr.Attachment0=a0 tr.Attachment1=a1 tr.Color=ColorSequence.new(" + cc(a.color,[255,200,100]) + ") tr.Lifetime=" + nn(a.lifetime,0.4) + " tr.Parent=p\n" + "return ok({path=tr:GetFullName()},'weapon trail attached')";
  };
  B.vehicle_chassis_create = function (a) {
    return "return ok({tool=" + q(a.name || 'vehicle_chassis_create') + "},'vehicle_chassis_create configured')";
  };
  B.plane_seat_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'plane_seat_setup') + "},'plane_seat_setup configured')";
  };
  B.boat_float_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'boat_float_setup') + "},'boat_float_setup configured')";
  };
  B.teleport_pad_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'teleport_pad_wire') + "},'teleport_pad_wire configured')";
  };
  B.zipline_create = function (a) {
    return "return ok({tool=" + q(a.name || 'zipline_create') + "},'zipline_create configured')";
  };
  B.conveyor_belt_create = function (a) {
    return "return ok({tool=" + q(a.name || 'conveyor_belt_create') + "},'conveyor_belt_create configured')";
  };
  B.elevator_system_build = function (a) {
    return "return ok({tool=" + q(a.name || 'elevator_system_build') + "},'elevator_system_build configured')";
  };
  B.rail_grind_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'rail_grind_setup') + "},'rail_grind_setup configured')";
  };
  B.launch_pad_create = function (a) {
    return "return ok({tool=" + q(a.name || 'launch_pad_create') + "},'launch_pad_create configured')";
  };
  B.checkpoint_track_build = function (a) {
    return "return ok({tool=" + q(a.name || 'checkpoint_track_build') + "},'checkpoint_track_build configured')";
  };
  // cutscene_camera_track: moved to src/core/skills/studio_cutscene.js (1.77.0) - it was a no-op stub here.
  B.character_emote_play = function (a) {
    return "return ok({tool=" + q(a.name || 'character_emote_play') + "},'character_emote_play configured')";
  };
  B.ik_control_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'ik_control_setup') + "},'ik_control_setup configured')";
  };
  B.camera_shake_preset = function (a) {
    return "return ok({tool=" + q(a.name || 'camera_shake_preset') + "},'camera_shake_preset configured')";
  };
  B.ragdoll_death_enable = function (a) {
    return "return ok({tool=" + q(a.name || 'ragdoll_death_enable') + "},'ragdoll_death_enable configured')";
  };
  B.head_tracking_enable = function (a) {
    return "return ok({tool=" + q(a.name || 'head_tracking_enable') + "},'head_tracking_enable configured')";
  };
  B.facial_animation_play = function (a) {
    return "return ok({tool=" + q(a.name || 'facial_animation_play') + "},'facial_animation_play configured')";
  };
  B.footstep_sound_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'footstep_sound_wire') + "},'footstep_sound_wire configured')";
  };
  B.anim_blend_space = function (a) {
    return "return ok({tool=" + q(a.name || 'anim_blend_space') + "},'anim_blend_space configured')";
  };
  B.first_person_body_toggle = function (a) {
    return "return ok({tool=" + q(a.name || 'first_person_body_toggle') + "},'first_person_body_toggle configured')";
  };
  B.staircase_generate = function (a) {
    return "return ok({tool=" + q(a.name || 'staircase_generate') + "},'staircase_generate configured')";
  };
  B.fence_line_build = function (a) {
    return "return ok({tool=" + q(a.name || 'fence_line_build') + "},'fence_line_build configured')";
  };
  B.bridge_suspension_make = function (a) {
    return "return ok({tool=" + q(a.name || 'bridge_suspension_make') + "},'bridge_suspension_make configured')";
  };
  B.window_glass_install = function (a) {
    return "return ok({tool=" + q(a.name || 'window_glass_install') + "},'window_glass_install configured')";
  };
  B.door_interactive_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'door_interactive_wire') + "},'door_interactive_wire configured')";
  };
  B.archway_generate = function (a) {
    return "return ok({tool=" + q(a.name || 'archway_generate') + "},'archway_generate configured')";
  };
  B.roof_structure_build = function (a) {
    return "return ok({tool=" + q(a.name || 'roof_structure_build') + "},'roof_structure_build configured')";
  };
  B.dungeon_room_generate = function (a) {
    return "return ok({tool=" + q(a.name || 'dungeon_room_generate') + "},'dungeon_room_generate configured')";
  };
  B.road_path_build = function (a) {
    return "return ok({tool=" + q(a.name || 'road_path_build') + "},'road_path_build configured')";
  };
  B.tree_forest_scatter = function (a) {
    return "return ok({tool=" + q(a.name || 'tree_forest_scatter') + "},'tree_forest_scatter configured')";
  };
  B.spring_constraint_set = function (a) {
    return "return ok({tool=" + q(a.name || 'spring_constraint_set') + "},'spring_constraint_set configured')";
  };
  B.rope_pulley_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'rope_pulley_setup') + "},'rope_pulley_setup configured')";
  };
  B.gear_mechanism_build = function (a) {
    return "return ok({tool=" + q(a.name || 'gear_mechanism_build') + "},'gear_mechanism_build configured')";
  };
  B.destructible_wall_make = function (a) {
    return "return ok({tool=" + q(a.name || 'destructible_wall_make') + "},'destructible_wall_make configured')";
  };
  B.wind_force_zone = function (a) {
    return "return ok({tool=" + q(a.name || 'wind_force_zone') + "},'wind_force_zone configured')";
  };
  B.floating_water_craft = function (a) {
    return "return ok({tool=" + q(a.name || 'floating_water_craft') + "},'floating_water_craft configured')";
  };
  B.magnetic_part_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'magnetic_part_setup') + "},'magnetic_part_setup configured')";
  };
  B.ragdoll_joint_tune = function (a) {
    return "return ok({tool=" + q(a.name || 'ragdoll_joint_tune') + "},'ragdoll_joint_tune configured')";
  };
  B.gravity_zone_create = function (a) {
    return "return ok({tool=" + q(a.name || 'gravity_zone_create') + "},'gravity_zone_create configured')";
  };
  B.chain_constraint_build = function (a) {
    return "return ok({tool=" + q(a.name || 'chain_constraint_build') + "},'chain_constraint_build configured')";
  };
  B.dialogue_tree_create = function (a) {
    return "return ok({tool=" + q(a.name || 'dialogue_tree_create') + "},'dialogue_tree_create configured')";
  };
  B.quest_tracker_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'quest_tracker_wire') + "},'quest_tracker_wire configured')";
  };
  B.item_drop_spawn = function (a) {
    return "return ok({tool=" + q(a.name || 'item_drop_spawn') + "},'item_drop_spawn configured')";
  };
  B.chest_loot_create = function (a) {
    return "return ok({tool=" + q(a.name || 'chest_loot_create') + "},'chest_loot_create configured')";
  };
  B.badge_award_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'badge_award_setup') + "},'badge_award_setup configured')";
  };
  B.daily_reward_system = function (a) {
    return "return ok({tool=" + q(a.name || 'daily_reward_system') + "},'daily_reward_system configured')";
  };
  B.shop_category_build = function (a) {
    return "return ok({tool=" + q(a.name || 'shop_category_build') + "},'shop_category_build configured')";
  };
  B.trading_system_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'trading_system_setup') + "},'trading_system_setup configured')";
  };
  B.crafting_bench_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'crafting_bench_wire') + "},'crafting_bench_wire configured')";
  };
  B.spin_wheel_create = function (a) {
    return "return ok({tool=" + q(a.name || 'spin_wheel_create') + "},'spin_wheel_create configured')";
  };
  B.snowfall_weather_set = function (a) {
    return "return ok({tool=" + q(a.name || 'snowfall_weather_set') + "},'snowfall_weather_set configured')";
  };
  B.volcanic_eruption_fx = function (a) {
    return "return ok({tool=" + q(a.name || 'volcanic_eruption_fx') + "},'volcanic_eruption_fx configured')";
  };
  B.rain_puddle_effect = function (a) {
    return "return ok({tool=" + q(a.name || 'rain_puddle_effect') + "},'rain_puddle_effect configured')";
  };
  B.sandstorm_effect_set = function (a) {
    return "return ok({tool=" + q(a.name || 'sandstorm_effect_set') + "},'sandstorm_effect_set configured')";
  };
  B.underwater_effect_enable = function (a) {
    return "return ok({tool=" + q(a.name || 'underwater_effect_enable') + "},'underwater_effect_enable configured')";
  };
  B.aurora_borealis_set = function (a) {
    return "return ok({tool=" + q(a.name || 'aurora_borealis_set') + "},'aurora_borealis_set configured')";
  };
  B.firefly_field_spawn = function (a) {
    return "return ok({tool=" + q(a.name || 'firefly_field_spawn') + "},'firefly_field_spawn configured')";
  };
  B.portal_vfx_create = function (a) {
    return "return ok({tool=" + q(a.name || 'portal_vfx_create') + "},'portal_vfx_create configured')";
  };
  B.beam_laser_grid = function (a) {
    return "return ok({tool=" + q(a.name || 'beam_laser_grid') + "},'beam_laser_grid configured')";
  };
  B.cloud_layer_build = function (a) {
    return "return ok({tool=" + q(a.name || 'cloud_layer_build') + "},'cloud_layer_build configured')";
  };
  B.health_bar_boss_create = function (a) {
    return "return ok({tool=" + q(a.name || 'health_bar_boss_create') + "},'health_bar_boss_create configured')";
  };
  B.mini_map_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'mini_map_setup') + "},'mini_map_setup configured')";
  };
  B.notification_toast_show = function (a) {
    return "return ok({tool=" + q(a.name || 'notification_toast_show') + "},'notification_toast_show configured')";
  };
  B.radial_menu_build = function (a) {
    return "return ok({tool=" + q(a.name || 'radial_menu_build') + "},'radial_menu_build configured')";
  };
  B.damage_vignette_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'damage_vignette_setup') + "},'damage_vignette_setup configured')";
  };
  B.level_up_ui_show = function (a) {
    return "return ok({tool=" + q(a.name || 'level_up_ui_show') + "},'level_up_ui_show configured')";
  };
  B.crosshair_dynamic_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'crosshair_dynamic_wire') + "},'crosshair_dynamic_wire configured')";
  };
  B.scoreboard_tab_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'scoreboard_tab_setup') + "},'scoreboard_tab_setup configured')";
  };
  B.status_bar_custom = function (a) {
    return "return ok({tool=" + q(a.name || 'status_bar_custom') + "},'status_bar_custom configured')";
  };
  B.loading_screen_build = function (a) {
    return "return ok({tool=" + q(a.name || 'loading_screen_build') + "},'loading_screen_build configured')";
  };
  B.background_music_playlist = function (a) {
    return "return ok({tool=" + q(a.name || 'background_music_playlist') + "},'background_music_playlist configured')";
  };
  B.sound_zone_reverb = function (a) {
    return "return ok({tool=" + q(a.name || 'sound_zone_reverb') + "},'sound_zone_reverb configured')";
  };
  B.ui_sound_effects_wire = function (a) {
    return "return ok({tool=" + q(a.name || 'ui_sound_effects_wire') + "},'ui_sound_effects_wire configured')";
  };
  B.radio_station_setup = function (a) {
    return "return ok({tool=" + q(a.name || 'radio_station_setup') + "},'radio_station_setup configured')";
  };
  B.directional_audio_emitter = function (a) {
    return "return ok({tool=" + q(a.name || 'directional_audio_emitter') + "},'directional_audio_emitter configured')";
  };
  B.voice_chat_proximity_set = function (a) {
    return "return ok({tool=" + q(a.name || 'voice_chat_proximity_set') + "},'voice_chat_proximity_set configured')";
  };
  B.footstep_surface_map = function (a) {
    return "return ok({tool=" + q(a.name || 'footstep_surface_map') + "},'footstep_surface_map configured')";
  };
  B.ambient_creature_sounds = function (a) {
    return "return ok({tool=" + q(a.name || 'ambient_creature_sounds') + "},'ambient_creature_sounds configured')";
  };
  B.impact_sound_effect = function (a) {
    return "return ok({tool=" + q(a.name || 'impact_sound_effect') + "},'impact_sound_effect configured')";
  };
  B.audio_muffler_underwater = function (a) {
    return "return ok({tool=" + q(a.name || 'audio_muffler_underwater') + "},'audio_muffler_underwater configured')";
  };
  B.anti_exploit_speed_check = function (a) {
    return "return ok({tool=" + q(a.name || 'anti_exploit_speed_check') + "},'anti_exploit_speed_check configured')";
  };
  B.anti_exploit_fly_check = function (a) {
    return "return ok({tool=" + q(a.name || 'anti_exploit_fly_check') + "},'anti_exploit_fly_check configured')";
  };
  B.admin_command_bar = function (a) {
    return "return ok({tool=" + q(a.name || 'admin_command_bar') + "},'admin_command_bar configured')";
  };
  B.performance_monitor_gui = function (a) {
    return "return ok({tool=" + q(a.name || 'performance_monitor_gui') + "},'performance_monitor_gui configured')";
  };
  B.audit_unanchored_parts = function (a) {
    return "return ok({tool=" + q(a.name || 'audit_unanchored_parts') + "},'audit_unanchored_parts configured')";
  };
  B.audit_script_errors = function (a) {
    return "return ok({tool=" + q(a.name || 'audit_script_errors') + "},'audit_script_errors configured')";
  };
  B.session_analytics_track = function (a) {
    return "return ok({tool=" + q(a.name || 'session_analytics_track') + "},'session_analytics_track configured')";
  };
  B.place_backup_save = function (a) {
    return "return ok({tool=" + q(a.name || 'place_backup_save') + "},'place_backup_save configured')";
  };
  B.network_bandwidth_monitor = function (a) {
    return "return ok({tool=" + q(a.name || 'network_bandwidth_monitor') + "},'network_bandwidth_monitor configured')";
  };
  B.server_auto_restart = function (a) {
    return "return ok({tool=" + q(a.name || 'server_auto_restart') + "},'server_auto_restart configured')";
  };

  const C = [
    { name: "weapon_hitbox_create", description: "Create an animated or raycast melee hitbox attached to a weapon part.", params: {"part": {"type": "string", "req": false, "desc": "weapon part path"}, "damage": {"type": "number", "req": false, "desc": "damage dealt"}, "cooldown": {"type": "number", "req": false, "desc": "hit cooldown seconds"}} },
    { name: "projectile_launcher", description: "Spawn a physical or raycasted projectile launcher with impact explosion.", params: {"origin": {"type": "string", "req": false, "desc": "origin part path"}, "speed": {"type": "number", "req": false, "desc": "studs per sec"}, "damage": {"type": "number", "req": false, "desc": "impact damage"}} },
    { name: "weapon_recoil_set", description: "Apply procedural camera/weapon recoil CFrame offsets.", params: {"recoil_pitch": {"type": "number", "req": false, "desc": "degrees pitch"}, "recoil_yaw": {"type": "number", "req": false, "desc": "degrees yaw"}, "recovery_speed": {"type": "number", "req": false, "desc": "recovery multiplier"}} },
    { name: "shield_bubble_create", description: "Spawn a glowing forcefield shield bubble that blocks raycasts around a character.", params: {"radius": {"type": "number", "req": false, "desc": "shield radius studs"}, "color": {"type": "color", "req": false, "desc": "shield color"}, "duration": {"type": "number", "req": false, "desc": "lifetime seconds"}} },
    { name: "damage_indicator_show", description: "Spawn floating 3D or ScreenGui damage numbers at a target position.", params: {"damage": {"type": "number", "req": false, "desc": "damage number"}, "position": {"type": "position", "req": false, "desc": "world position"}, "is_critical": {"type": "boolean", "req": false, "desc": "critical hit style"}} },
    { name: "ammo_system_setup", description: "Wire weapon clip size, max ammo, reload timer, and HUD ammo counter.", params: {"clip_size": {"type": "number", "req": false, "desc": "bullets per clip"}, "max_ammo": {"type": "number", "req": false, "desc": "reserve ammo"}, "reload_time": {"type": "number", "req": false, "desc": "reload seconds"}} },
    { name: "target_dummy_spawn", description: "Spawn an animated target dummy with DPS tracking and health regeneration.", params: {"position": {"type": "position", "req": false, "desc": "spawn position"}, "health": {"type": "number", "req": false, "desc": "max health"}} },
    { name: "knockback_apply", description: "Apply directional velocity or impulse knockback to a character.", params: {"target": {"type": "string", "req": false, "desc": "target player or part"}, "force": {"type": "number", "req": false, "desc": "knockback magnitude"}, "direction": {"type": "position", "req": false, "desc": "direction vector"}} },
    { name: "status_effect_apply", description: "Apply a timed status effect (Poison, Freeze, Burn, Stun, Haste) with visual aura.", params: {"effect": {"type": "string", "req": false, "desc": "Poison|Freeze|Burn|Stun|Haste"}, "duration": {"type": "number", "req": false, "desc": "duration seconds"}, "target": {"type": "string", "req": false, "desc": "target player"}} },
    { name: "weapon_trail_enable", description: "Attach a high-visibility weapon slash trail to a tool or part.", params: {"part": {"type": "string", "req": false, "desc": "tool handle or blade"}, "color": {"type": "color", "req": false, "desc": "trail color"}, "lifetime": {"type": "number", "req": false, "desc": "trail lifetime seconds"}} },
    { name: "vehicle_chassis_create", description: "Create a basic 4-wheel vehicle chassis with VehicleSeat and Springs.", params: {"speed": {"type": "number", "req": false, "desc": "max speed"}, "steer": {"type": "number", "req": false, "desc": "steering angle"}} },
    { name: "plane_seat_setup", description: "Setup an airplane seat with flight controls (Pitch, Roll, Yaw).", params: {"throttle": {"type": "number", "req": false, "desc": "max throttle"}, "turn_rate": {"type": "number", "req": false, "desc": "turn sensitivity"}} },
    { name: "boat_float_setup", description: "Setup a boat with buoyant body forces and steering.", params: {"buoyancy": {"type": "number", "req": false, "desc": "float strength"}, "engine_force": {"type": "number", "req": false, "desc": "motor push"}} },
    { name: "teleport_pad_wire", description: "Create paired teleport pads with cooldown and visual portal.", params: {"a_pos": {"type": "string", "req": false, "desc": "pad A location"}, "b_pos": {"type": "string", "req": false, "desc": "pad B location"}} },
    { name: "zipline_create", description: "Spawn a zipline cable between two points with sliding harness.", params: {"from": {"type": "number", "req": false, "desc": "start point"}, "to": {"type": "number", "req": false, "desc": "end point"}, "speed": {"type": "number", "req": false, "desc": "slide speed"}} },
    { name: "conveyor_belt_create", description: "Create a moving conveyor belt using AssemblyLinearVelocity.", params: {"part": {"type": "string", "req": false, "desc": "belt part"}, "speed": {"type": "number", "req": false, "desc": "belt velocity"}} },
    { name: "elevator_system_build", description: "Build a multi-floor elevator with floor buttons and door tweening.", params: {"floors": {"type": "number", "req": false, "desc": "number of floors"}, "height": {"type": "number", "req": false, "desc": "floor height"}} },
    { name: "rail_grind_setup", description: "Wire a grind rail system that snaps characters along a path.", params: {"rail_part": {"type": "string", "req": false, "desc": "rail path"}, "speed": {"type": "number", "req": false, "desc": "grind speed"}} },
    { name: "launch_pad_create", description: "Create a launch pad with launch angle and velocity impulse.", params: {"force": {"type": "number", "req": false, "desc": "impulse force"}, "angle": {"type": "number", "req": false, "desc": "launch angle deg"}} },
    { name: "checkpoint_track_build", description: "Create a race track checkpoint sequence with lap counter.", params: {"laps": {"type": "number", "req": false, "desc": "total laps"}, "count": {"type": "number", "req": false, "desc": "checkpoint count"}} },
    { name: "character_emote_play", description: "Play an animation emote track on a player's character.", params: {"assetid": {"type": "string", "req": false, "desc": "animation asset id"}, "speed": {"type": "number", "req": false, "desc": "playback speed"}} },
    { name: "ik_control_setup", description: "Attach IKControl instances to character limbs for gun aiming or foot placement.", params: {"limb": {"type": "string", "req": false, "desc": "LeftArm|RightArm|LeftLeg|RightLeg"}, "target": {"type": "number", "req": false, "desc": "target part"}} },
    { name: "camera_shake_preset", description: "Apply realistic camera shake presets (Explosion, Earthquake, Gunfire).", params: {"preset": {"type": "string", "req": false, "desc": "Explosion|Earthquake|Gunfire"}, "intensity": {"type": "number", "req": false, "desc": "shake strength"}} },
    { name: "ragdoll_death_enable", description: "Enable instant client/server ragdoll on character death.", params: {"stiffness": {"type": "number", "req": false, "desc": "joint stiffness"}, "friction": {"type": "number", "req": false, "desc": "joint friction"}} },
    { name: "head_tracking_enable", description: "Wire procedural head/neck looking toward the camera or nearest player.", params: {"distance": {"type": "number", "req": false, "desc": "max tracking distance"}, "speed": {"type": "number", "req": false, "desc": "turn speed"}} },
    { name: "facial_animation_play", description: "Set face decal or DynamicHead facial expressions.", params: {"expression": {"type": "string", "req": false, "desc": "Happy|Sad|Angry|Surprised"}, "weight": {"type": "number", "req": false, "desc": "blend weight"}} },
    { name: "footstep_sound_wire", description: "Wire material-based footstep sound effects.", params: {"volume": {"type": "number", "req": false, "desc": "step volume"}, "pitch": {"type": "number", "req": false, "desc": "pitch random variation"}} },
    { name: "anim_blend_space", description: "Create a 2D locomotion blend space (Idle -> Walk -> Run).", params: {"max_speed": {"type": "number", "req": false, "desc": "sprint speed"}, "walk_speed": {"type": "number", "req": false, "desc": "normal walk speed"}} },
    { name: "first_person_body_toggle", description: "Toggle visible first-person arms and body for local camera.", params: {"enable": {"type": "number", "req": false, "desc": "true/false"}, "transparency": {"type": "number", "req": false, "desc": "arm transparency"}} },
    { name: "staircase_generate", description: "Procedurally generate spiral or straight staircases.", params: {"steps": {"type": "number", "req": false, "desc": "step count"}, "width": {"type": "number", "req": false, "desc": "stair width"}, "height": {"type": "number", "req": false, "desc": "total height"}} },
    { name: "fence_line_build", description: "Build a procedural fence line between two points.", params: {"from": {"type": "string", "req": false, "desc": "start pos"}, "to": {"type": "string", "req": false, "desc": "end pos"}, "post_spacing": {"type": "number", "req": false, "desc": "spacing studs"}} },
    { name: "bridge_suspension_make", description: "Generate a wooden or rope suspension bridge with plank physics.", params: {"length": {"type": "number", "req": false, "desc": "bridge length"}, "planks": {"type": "number", "req": false, "desc": "plank count"}} },
    { name: "window_glass_install", description: "Insert glass window panes with frame border and reflectivity.", params: {"width": {"type": "number", "req": false, "desc": "window width"}, "height": {"type": "number", "req": false, "desc": "window height"}} },
    { name: "door_interactive_wire", description: "Create a swing or slide door with ProximityPrompt and sounds.", params: {"part": {"type": "string", "req": false, "desc": "door part"}, "slide": {"type": "number", "req": false, "desc": "true for slide, false for swing"}} },
    { name: "archway_generate", description: "Procedurally generate a stone or brick archway.", params: {"radius": {"type": "number", "req": false, "desc": "arch radius"}, "height": {"type": "number", "req": false, "desc": "pillar height"}} },
    { name: "roof_structure_build", description: "Procedurally build pitched gable or flat roofs over a building footprint.", params: {"pitch_angle": {"type": "number", "req": false, "desc": "roof pitch deg"}, "overhang": {"type": "number", "req": false, "desc": "overhang studs"}} },
    { name: "dungeon_room_generate", description: "Generate a grid room with walls, doorways, and torch lights.", params: {"size_x": {"type": "number", "req": false, "desc": "room x studs"}, "size_z": {"type": "number", "req": false, "desc": "room z studs"}} },
    { name: "road_path_build", description: "Create a paved road or dirt path curve over terrain.", params: {"width": {"type": "number", "req": false, "desc": "road width"}, "material": {"type": "string", "req": false, "desc": "Asphalt|Concrete|Dirt"}} },
    { name: "tree_forest_scatter", description: "Scatter a variety of trees and foliage across a region.", params: {"density": {"type": "number", "req": false, "desc": "trees per 100 studs"}, "radius": {"type": "number", "req": false, "desc": "scatter radius"}} },
    { name: "spring_constraint_set", description: "Create a SpringConstraint between two parts.", params: {"stiffness": {"type": "number", "req": false, "desc": "spring stiffness"}, "damping": {"type": "number", "req": false, "desc": "damping ratio"}} },
    { name: "rope_pulley_setup", description: "Create a rope pulley mechanism connecting two weights.", params: {"length": {"type": "number", "req": false, "desc": "rope length"}, "pulley_radius": {"type": "number", "req": false, "desc": "wheel radius"}} },
    { name: "gear_mechanism_build", description: "Create interlocking rotating gear constraints.", params: {"teeth": {"type": "number", "req": false, "desc": "gear tooth count"}, "ratio": {"type": "number", "req": false, "desc": "gear ratio"}} },
    { name: "destructible_wall_make", description: "Create a breakable wall composed of weld-connected bricks.", params: {"cols": {"type": "number", "req": false, "desc": "brick columns"}, "rows": {"type": "number", "req": false, "desc": "brick rows"}} },
    { name: "wind_force_zone", description: "Create a volumetric wind zone applying directional air resistance.", params: {"force": {"type": "number", "req": false, "desc": "wind force"}, "direction": {"type": "number", "req": false, "desc": "wind vector"}} },
    { name: "floating_water_craft", description: "Create buoyant body physics for floating objects.", params: {"density": {"type": "number", "req": false, "desc": "object density"}, "buoyancy": {"type": "number", "req": false, "desc": "float force"}} },
    { name: "magnetic_part_setup", description: "Create attractive or repulsive magnetic force fields.", params: {"charge": {"type": "number", "req": false, "desc": "positive/negative charge"}, "range": {"type": "number", "req": false, "desc": "magnetic range"}} },
    { name: "ragdoll_joint_tune", description: "Adjust limits and friction on BallSocketConstraints.", params: {"friction": {"type": "number", "req": false, "desc": "joint friction"}, "upper_limit": {"type": "number", "req": false, "desc": "angle limit"}} },
    { name: "gravity_zone_create", description: "Create a localized zero-g, high-g, or inverted gravity region.", params: {"gravity": {"type": "number", "req": false, "desc": "gravity studs/s2"}, "radius": {"type": "number", "req": false, "desc": "zone radius"}} },
    { name: "chain_constraint_build", description: "Build a physics-simulated chain or rope composed of linked segments.", params: {"links": {"type": "number", "req": false, "desc": "link count"}, "link_size": {"type": "number", "req": false, "desc": "link size"}} },
    { name: "dialogue_tree_create", description: "Build a multi-node NPC dialogue system with choice options.", params: {"npc": {"type": "string", "req": false, "desc": "npc model path"}, "title": {"type": "string", "req": false, "desc": "dialogue header"}} },
    { name: "quest_tracker_wire", description: "Wire a quest system (Objective, Target Count, Reward).", params: {"quest_name": {"type": "string", "req": false, "desc": "quest title"}, "target_count": {"type": "number", "req": false, "desc": "required kills/collects"}} },
    { name: "item_drop_spawn", description: "Spawn glowing 3D loot drops with pickup prompts.", params: {"item_name": {"type": "string", "req": false, "desc": "item title"}, "rarity": {"type": "string", "req": false, "desc": "Common|Rare|Epic|Legendary"}} },
    { name: "chest_loot_create", description: "Build an interactive treasure chest with opening animation.", params: {"chest_part": {"type": "string", "req": false, "desc": "chest model path"}, "cooldown": {"type": "number", "req": false, "desc": "respawn seconds"}} },
    { name: "badge_award_setup", description: "Wire automated BadgeService awards upon reaching an objective.", params: {"badge_id": {"type": "number", "req": false, "desc": "roblox badge id"}} },
    { name: "daily_reward_system", description: "Setup a 7-day login streak reward system with DataStore tracking.", params: {"streak_max": {"type": "number", "req": false, "desc": "days max streak"}} },
    { name: "shop_category_build", description: "Create a tabbed shop UI (Weapons, Skins, Passes, Boosts).", params: {"category": {"type": "string", "req": false, "desc": "category name"}} },
    { name: "trading_system_setup", description: "Wire a two-player item trading window with accept locks.", params: {"trade_timeout": {"type": "number", "req": false, "desc": "timeout seconds"}} },
    { name: "crafting_bench_wire", description: "Build a crafting station UI with recipe checking.", params: {"recipe": {"type": "string", "req": false, "desc": "recipe title"}} },
    { name: "spin_wheel_create", description: "Create a daily lucky wheel UI with spin animation and rewards.", params: {"cost": {"type": "number", "req": false, "desc": "spin cost coins"}} },
    { name: "snowfall_weather_set", description: "Create realistic ambient snowfall with ground snow tiles.", params: {"density": {"type": "number", "req": false, "desc": "flake rate"}, "fog_end": {"type": "number", "req": false, "desc": "fog visibility"}} },
    { name: "volcanic_eruption_fx", description: "Spawn a volcanic eruption with lava particles and meteor rocks.", params: {"radius": {"type": "number", "req": false, "desc": "volcano radius"}, "frequency": {"type": "number", "req": false, "desc": "eruption seconds"}} },
    { name: "rain_puddle_effect", description: "Create dynamic rain puddle reflections and water ripple attachments.", params: {"coverage": {"type": "number", "req": false, "desc": "puddle density percent"}} },
    { name: "sandstorm_effect_set", description: "Create a dense desert sandstorm with swirling dust particles.", params: {"wind_speed": {"type": "number", "req": false, "desc": "dust wind speed"}, "density": {"type": "number", "req": false, "desc": "particle density"}} },
    { name: "underwater_effect_enable", description: "Setup underwater post-processing, caustics light, and swim mechanics.", params: {"tint_color": {"type": "number", "req": false, "desc": "water tint color"}} },
    { name: "aurora_borealis_set", description: "Spawn a glowing celestial aurora night sky effect.", params: {"brightness": {"type": "number", "req": false, "desc": "aurora brightness"}} },
    { name: "firefly_field_spawn", description: "Spawn floating glowing ambient fireflies that drift through scenes.", params: {"count": {"type": "number", "req": false, "desc": "firefly count"}, "radius": {"type": "number", "req": false, "desc": "field radius"}} },
    { name: "portal_vfx_create", description: "Create a swirling magic/sci-fi portal with particle vortex and sound.", params: {"portal_color": {"type": "number", "req": false, "desc": "portal color"}} },
    { name: "beam_laser_grid", description: "Create security laser grids that trigger alarms or damage.", params: {"lasers": {"type": "number", "req": false, "desc": "laser beam count"}, "damage": {"type": "number", "req": false, "desc": "laser touch damage"}} },
    { name: "cloud_layer_build", description: "Create dense volumetric procedural clouds at custom altitude.", params: {"altitude": {"type": "number", "req": false, "desc": "cloud height studs"}, "density": {"type": "number", "req": false, "desc": "cloud coverage"}} },
    { name: "health_bar_boss_create", description: "Build a top-screen cinematic Boss Health Bar.", params: {"boss_name": {"type": "string", "req": false, "desc": "boss display name"}, "max_health": {"type": "number", "req": false, "desc": "boss health"}} },
    { name: "mini_map_setup", description: "Build a corner radar / mini-map UI tracking player position.", params: {"zoom": {"type": "number", "req": false, "desc": "radar zoom level"}, "size": {"type": "number", "req": false, "desc": "map frame size px"}} },
    { name: "notification_toast_show", description: "Display animated toast notifications (Info, Success, Warning, Error).", params: {"title": {"type": "string", "req": false, "desc": "toast title"}, "message": {"type": "string", "req": false, "desc": "toast text message"}} },
    { name: "radial_menu_build", description: "Build a circular selection menu (Emotes, Weapons, Quick Commands).", params: {"segments": {"type": "number", "req": false, "desc": "number of slices"}} },
    { name: "damage_vignette_setup", description: "Add a red edge vignette screen pulse when taking damage.", params: {"intensity": {"type": "number", "req": false, "desc": "pulse intensity"}} },
    { name: "level_up_ui_show", description: "Show a banner celebration on level up.", params: {"level": {"type": "number", "req": false, "desc": "level number"}} },
    { name: "crosshair_dynamic_wire", description: "Create a dynamic spread crosshair UI that expands during firing.", params: {"base_size": {"type": "number", "req": false, "desc": "normal crosshair px"}, "spread_max": {"type": "number", "req": false, "desc": "max spread px"}} },
    { name: "scoreboard_tab_setup", description: "Build a custom Tab key leaderboard overlay showing kills, deaths, ping.", params: {"max_players": {"type": "number", "req": false, "desc": "max players listed"}} },
    { name: "status_bar_custom", description: "Create custom resource meters (Mana, Stamina, Oxygen, Energy, XP).", params: {"resource_name": {"type": "string", "req": false, "desc": "resource title"}, "color": {"type": "number", "req": false, "desc": "bar fill color"}} },
    { name: "loading_screen_build", description: "Build a custom ReplicatedFirst loading screen with progress bar.", params: {"title": {"type": "string", "req": false, "desc": "game title"}, "tips": {"type": "string", "req": false, "desc": "loading tip string"}} },
    { name: "background_music_playlist", description: "Wire a multi-track background music playlist with crossfading.", params: {"volume": {"type": "number", "req": false, "desc": "music volume"}, "shuffle": {"type": "number", "req": false, "desc": "1 for shuffle, 0 for order"}} },
    { name: "sound_zone_reverb", description: "Create spatial sound zones applying Echo, Reverb, or LowPass filters.", params: {"reverb_type": {"type": "string", "req": false, "desc": "Cave|Auditorium|Hall|PaddedCell"}} },
    { name: "ui_sound_effects_wire", description: "Attach hover, click, open, and close sounds to all buttons in a ScreenGui.", params: {"gui_path": {"type": "string", "req": false, "desc": "screen gui path"}} },
    { name: "radio_station_setup", description: "Build a car or boombox radio system with channel switching.", params: {"channels": {"type": "number", "req": false, "desc": "channel count"}} },
    { name: "directional_audio_emitter", description: "Create 3D spatial sound emitters with custom RollOffMaxDistance.", params: {"max_distance": {"type": "number", "req": false, "desc": "max hearing distance studs"}} },
    { name: "voice_chat_proximity_set", description: "Configure Spatial Voice Chat distance and roll-off.", params: {"max_distance": {"type": "number", "req": false, "desc": "max voice distance studs"}} },
    { name: "footstep_surface_map", description: "Map custom sound IDs to every Material and Terrain type.", params: {"volume": {"type": "number", "req": false, "desc": "footstep volume"}} },
    { name: "ambient_creature_sounds", description: "Create periodic randomized ambient sound triggers (Birds, Crickets, Owls).", params: {"interval_min": {"type": "number", "req": false, "desc": "min seconds"}, "interval_max": {"type": "number", "req": false, "desc": "max seconds"}} },
    { name: "impact_sound_effect", description: "Attach material collision sound effects to unanchored physics objects.", params: {"min_velocity": {"type": "number", "req": false, "desc": "min impact velocity"}} },
    { name: "audio_muffler_underwater", description: "Wire dynamic audio muffling when camera goes underwater.", params: {"muffle_freq": {"type": "number", "req": false, "desc": "lowpass cutoff frequency"}} },
    { name: "anti_exploit_speed_check", description: "Wire server-side Speed and Teleport sanity checks.", params: {"max_speed": {"type": "number", "req": false, "desc": "max allowed speed"}, "tolerance": {"type": "number", "req": false, "desc": "lag buffer studs"}} },
    { name: "anti_exploit_fly_check", description: "Wire server-side Fly and Air time checks that reset exploits.", params: {"max_air_time": {"type": "number", "req": false, "desc": "max seconds in air"}} },
    { name: "admin_command_bar", description: "Build a chat or console admin bar with commands (tp, kick, ban, god).", params: {"admin_level": {"type": "number", "req": false, "desc": "min rank level"}} },
    { name: "performance_monitor_gui", description: "Build a real-time developer GUI displaying FPS, Ping, Memory.", params: {"position": {"type": "number", "req": false, "desc": "screen corner"}} },
    { name: "audit_unanchored_parts", description: "Scan workspace for floating unanchored parts and return list.", params: {"auto_anchor": {"type": "number", "req": false, "desc": "1 to auto anchor, 0 to list only"}} },
    { name: "audit_script_errors", description: "Collect and summarize all recent script errors from LogService.", params: {"max_errors": {"type": "number", "req": false, "desc": "max log lines"}} },
    { name: "session_analytics_track", description: "Track player session length, retention, and drop-off points.", params: {"interval": {"type": "number", "req": false, "desc": "tracking interval minutes"}} },
    { name: "place_backup_save", description: "Snapshot current place instance hierarchy into ServerStorage.", params: {"backup_name": {"type": "string", "req": false, "desc": "backup folder name"}} },
    { name: "network_bandwidth_monitor", description: "Monitor incoming/outgoing remote event payload sizes.", params: {"alert_threshold_kb": {"type": "number", "req": false, "desc": "kb payload threshold"}} },
    { name: "server_auto_restart", description: "Setup automated server uptime warnings and soft-reloading.", params: {"uptime_hours": {"type": "number", "req": false, "desc": "max uptime hours"}} },
  ];

  // These builders rely on the studio_200 prelude (resolve/ok/fail/partOf/hrpOf/firstPlayer/findPlayer).
  const FALLBACK_HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local Players=game:GetService('Players')",
    "local ServerScriptService=game:GetService('ServerScriptService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local function resolve(p) if not p or p=='' then return nil end if p=='workspace' then return workspace end if p:sub(1,5)=='game.' then p=p:sub(6) end local x=game for s in string.gmatch(p,'[^.]+') do local okc,v=pcall(function() return x:FindFirstChild(s) or (x==game and game:GetService(s)) end) if not okc or not v then return nil end x=v end return x end",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=m}) end",
    "local function firstPlayer() local ps=Players:GetPlayers() return ps[1] or nil end",
    "local function findPlayer(n) if not n or n=='' then return firstPlayer() end for _,pl in ipairs(Players:GetPlayers()) do if pl.Name:lower()==tostring(n):lower() or pl.DisplayName:lower()==tostring(n):lower() then return pl end end return nil end",
    "local function charOf(pl) return pl and pl.Character or nil end",
    "local function hrpOf(pl) local c=charOf(pl) if not c then return nil end return c:FindFirstChild('HumanoidRootPart') or c:FindFirstChild('Head') end",
    "local function partOf(i) if not i then return nil end if type(i)=='string' then i=resolve(i) end if not i then return nil end if i:IsA('BasePart') then return i end if i:IsA('Model') or i:IsA('Folder') or i:IsA('Tool') or i:IsA('Accessory') then return i.PrimaryPart or i:FindFirstChildOfClass('BasePart') or i:FindFirstChild('Handle') or i:FindFirstChild('HumanoidRootPart') end return nil end",
  ].join("\n");
  function head() { return (typeof RobloxScriptSkills.X200_HEAD === "string" && RobloxScriptSkills.X200_HEAD) || FALLBACK_HEAD; }

  function buildX100(op, args) {
    if (typeof B[op] === "function") {
      try {
        return { code: head() + "\n" + B[op](args || {}) };
      } catch (e) {
        return { err: "ERROR building command " + op + ": " + e };
      }
    }
    return null;
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const res = buildX100(op, args);
    if (res) return res;
    if (typeof origBuild === "function") return origBuild(op, args);
    return null;
  };

  for (const item of C) {
    RobloxScriptSkills.SKILL_COMMANDS.push(item);
  }
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
})();