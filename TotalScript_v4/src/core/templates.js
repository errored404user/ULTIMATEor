// Production templates providers can pin (Settings) or fetch via get_template.
const TotalTemplates = (() => {
  "use strict";

  const T = {
    hud: {
      title: "HUD",
      blurb: "Live stats, mobile-safe",
      commands: "ui_build, ui_auto_layout, ui_set_text, leaderstats_int, inspect_instance",
      brief:
        "Build a finished ScreenGui HUD in StarterGui: health, currency, and a named title. Use Scale (not offset) so it fits mobile. Named instances, corners, stroke, no default-grey art. Server owns the values; the HUD only displays them.",
      body:
        "Layout: ScreenGui.HUD > Frame.Root (center-top, UDim2 scale) > Health, Coins, Title.\nWire Humanoid.HealthChanged and a leaderstats IntValue.\nVerify with ui_list_tree / inspect_instance.",
    },
    shop: {
      title: "Shop",
      blurb: "GUI + currency + buy",
      commands: "ui_build, remote_event_create, leaderstats_int, marketplace_setup",
      brief:
        "Ship a working shop: ScreenGui with item cards, a currency leaderstat, a RemoteEvent for BuyItem, and a server Script that validates price and grants the item. Client never decides the price. Feedback: sound + brief colour flash on success.",
      body:
        "ReplicatedStorage.Remotes.BuyItem. Server: gold check, deduct, clone tool into Backpack.\nClient: buttons FireServer(itemId). Named everything.",
    },
    tool: {
      title: "Tool",
      blurb: "Handle + activate",
      commands: "tool_create, script_set_source, sound_play, inspect_instance",
      brief:
        "Create a Tool with a Handle part, equipped weld, Activated cooldown, and a visible effect (beam, particle, or swing). Server deals damage if it is a weapon. No grey stud Handle as finished art — colour and material it.",
      body:
        "Tool in StarterPack. Handle CanCollide false. LocalScript for input, Script for damage via a remote or touched hitbox.",
    },
    door: {
      title: "Door",
      blurb: "Tween open / close",
      commands: "part_create, tween_create, click_detector, set_waypoint",
      brief:
        "A named door model that tweens open on ClickDetector or ProximityPrompt and closes after a delay. Set a ChangeHistoryService waypoint first. Hinge via PivotTo or CFrame tween, not by deleting the wall.",
      body:
        "Model.Door with PrimaryPart. TweenService CFrame. Debounce. Optional key attribute.",
    },
    leaderboard: {
      title: "Leaderboard",
      blurb: "leaderstats + save",
      commands: "leaderstats_int, get_datastore, datastore_setup",
      brief:
        "PlayerJoined creates leaderstats (Coins, Wins). DataStore GetAsync on join, SetAsync on leave. pcall every store call. Studio API Services must be on. Do not invent fake saves.",
      body:
        "Server Script in ServerScriptService. DataStoreService:GetDataStore('Total_Player').",
    },
    npc: {
      title: "NPC",
      blurb: "Dummy + pathfinding",
      commands: "dummy_spawn, character_navigation, proximity_setup, npc_spawn_pathfinding",
      brief:
        "Spawn a named Dummy with a Humanoid, simple wander or MoveTo a tagged point, and a ProximityPrompt that talks or gives an item. Anchor only the spawn pad, not the character.",
      body:
        "PathfindingService or character_navigation. Prompt holds, not loops forever without a yield.",
    },
    obby: {
      title: "Obby",
      blurb: "Pads, kill, spawn",
      commands: "spawn_location, kill_brick, part_create, generate_procedural_model",
      brief:
        "A short obby: Start spawn, 6–10 platforms with varied materials (not all plastic grey), one kill brick, a checkpoint, and a finish pad that adds Wins. Named stages Stage1… Finish looks celebrated (gold / neon), not a grey slab.",
      body:
        "Use generate_procedural_model for a platform or stairs, then colour. SpawnLocation TeamColor optional.",
    },
    vfx: {
      title: "VFX",
      blurb: "Trail, beam, burst",
      commands: "fx_create_vfx, fx_create_trail, fx_create_beam, generate_material",
      brief:
        "A visible effect the player can trigger: trail on a tool, a beam attack, or a burst on a pad. Attach to a named Attachment. Lifetime via Debris:AddItem. Colour matches the place, not random neon unless asked.",
      body:
        "fx_create_vfx with a real effect name. Verify with inspect_instance on the emitter.",
    },
  };

  function norm(id) {
    return String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function get(id) {
    const k = norm(id);
    if (T[k]) return Object.assign({ id: k }, T[k]);
    for (const key of Object.keys(T)) {
      if (key.indexOf(k) >= 0 || T[key].title.toLowerCase().indexOf(String(id || "").toLowerCase()) >= 0) {
        return Object.assign({ id: key }, T[key]);
      }
    }
    return null;
  }

  function list() {
    return Object.keys(T).map((id) => Object.assign({ id: id }, T[id]));
  }

  return { get: get, list: list, all: T };
})();
