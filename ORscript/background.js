// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const PORT_ROBLOX = 17613;
const PORT_LOCAL = 17615; // AgentScript — native FS/terminal engine
const RUST_ROBLOX_HTTP = "http://127.0.0.1:3000";
const ENGINE_KEY = "rs-engine";
// Legacy or unknown engine ids safely fall back to the Roblox bridge.
function normalizeEngine(v) { return v === "local" ? "local" : "roblox"; }
let engine = "roblox"; // "roblox" | "local"
let rustMode = false; // true if Rust agent on 3000 is reachable (preferred)
chrome.storage?.local.get(ENGINE_KEY, (o) => {
  const want = normalizeEngine(o && o[ENGINE_KEY]);
  if (want !== engine) {
    engine = want;
    log(`engine init corrected to ${engineLabel()} -> ${engineUrl()}`);
    try { ws?.close(); } catch {}
    connected = false;
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
});
// Probe Rust agent on 3000 at startup — if reachable, use HTTP pipe (CORS bypass) as primary
(async () => {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (r.ok) {
      rustMode = true;
      log("Rust agent detected on 3000 — HTTP pipe enabled (CORS bypass via background)");
    }
  } catch {}
})();
function engineUrl() { return `ws://127.0.0.1:${engine === "local" ? PORT_LOCAL : PORT_ROBLOX}`; }
// 1.42.0 — the AI's web tools (web_fetch / api_request) must never be able to
// probe this machine or the LAN: the local bridge (127.0.0.1:3000), routers,
// cloud metadata (169.254.169.254), *.local hosts. Public internet only.
function privateNetworkReason(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || "")); } catch { return "invalid url"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) urls are allowed";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "missing host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "0.0.0.0") return "local host names are not reachable from the AI's web tools";
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return "private / loopback / link-local addresses are not reachable from the AI's web tools";
    return "";
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || /^fe[89ab]/.test(host) || /^f[cd]/.test(host) || host.startsWith("::ffff:")) return "private / loopback IPv6 addresses are not reachable from the AI's web tools";
  }
  return "";
}
function engineLabel() { return engine === "local" ? "AgentScript" : "Roblox"; }
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ENGINE_KEY]) {
    const want = normalizeEngine(changes[ENGINE_KEY].newValue);
    if (want === engine) return; // dedupe rs-set-engine double fire
    engine = want;
    log(`engine switched to ${engineLabel()} -> ${engineUrl()} — FULL ISOLATION`);
    try { ws?.close(); } catch {}
    connected = false;
    mcpAlive = false;
    toolsCache = [];
    toolsCacheAt = 0;
    serversCache = [];
    setMcpLifecycle(manualStudioDisconnect ? "CLOSED" : "DISCONNECTED", {errorCode:"MCP_CONNECTION_CLOSED"});
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    failAllPending(`engine switched to ${engine}`);
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
});

// Chat sites where an OR provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://www.claude.ai/*", "https://claude.com/*", "https://www.claude.com/*", "https://gemini.google.com/*", "https://www.kimi.com/*", "https://kimi.com/*", "https://kimi.ai/*", "https://www.kimi.ai/*", "https://build.nvidia.com/moonshotai/kimi-k3/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://gpt.crax.lol/*", "https://oxalpha.com/*", "https://www.oxalpha.com/*", "https://oxalpha.org/*", "https://www.oxalpha.org/*", "https://c.vani.ai/*", "https://app.clickup.com/*", "https://agent.minimax.io/*", "https://overchat.ai/*", "https://*.overchat.ai/*", "https://huggingface.co/chat/*", "https://chat.mistral.ai/*", "https://mistral.ai/*", "https://openrouter.ai/*", "https://www.openrouter.ai/*", "https://console.groq.com/*", "https://dashboard.cohere.com/*", "https://api.together.ai/*", "https://fireworks.ai/*", "https://app.fireworks.ai/*", "https://www.notion.so/*", "https://app.notion.so/*", "https://www.notion.com/*", "https://notion.com/*", "https://*.notion.com/*"];
// CodeCraft API has no web chat: ORscript hosts one at codecraft.html (an
// extension page), which runs the same bundle and needs the same broadcasts.
const CODECRAFT_PAGE = "codecraft.html";
// Queried separately from the web patterns: if an extension-URL pattern were
// ever rejected by tabs.query it must not take the whole broadcast down.
async function providerTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: PROVIDER_URLS }); } catch {}
  try { tabs = tabs.concat(await chrome.tabs.query({ url: chrome.runtime.getURL(CODECRAFT_PAGE) + "*" })); } catch {}
  return tabs;
}

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 140000; // above 120s tool timeout so a long execute_luau never looks half-open
const REQUEST_TIMEOUT_DEFAULT = 130000; // tool execution timeout; connection/discovery use separate bounds
const MCP_CONNECT_TIMEOUT_MS = 6000;
const MCP_DISCOVERY_TIMEOUT_MS = 10000;
const MCP_CACHE_TTL_MS = 60000;
const MCP_MAX_RECONNECT_ATTEMPTS = 3;

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let reconnectAttempts = 0;
let mcpLifecycle = "DISCONNECTED";
let connectionId = null;
let mcpConnectStarted=0;
let toolsCacheAt = 0;
const mcpDiagnostics = [];
function mcpTrace(operation, detail={}) { const row={timestamp:new Date().toISOString(),connectionId,requestId:detail.requestId||null,server:engineLabel(),transport:"websocket",operation,duration:detail.duration||0,status:detail.status||mcpLifecycle,errorCode:detail.errorCode||null,retryCount:detail.retryCount??reconnectAttempts};mcpDiagnostics.push(row);if(mcpDiagnostics.length>100)mcpDiagnostics.shift(); }
function setMcpLifecycle(next, detail={}) { mcpLifecycle=next;mcpTrace("lifecycle",{...detail,status:next}); }
let manualStudioDisconnect = false;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;
let robloxProc = false;
// Editor-backed status. A local bridge socket is not an editor connection.
let robloxEditorConnected = false;
let localReady = false; // agent's workspace is up (from /api/status local_ready)
let localFull = false; // AgentScript FULL PC ACCESS (agent is source of truth)
let fullSyncedOnce = false; // one-shot FULL re-sync after an agent restart (refreshProcStatus)
let localRoot = ""; // workspace path, injected into the AI's state line
let blenderAddon = false; // blender-mcp addon listening on TCP 9876
let blenderError = "";
let blenderScriptsReady = false;
const BLENDER_TOOL_NAMES = new Set([
  "get_scene_info", "get_object_info", "execute_blender_code", "get_viewport_screenshot",
  "blender_export_fbx", "blender_import_fbx", "blender_export_obj", "blender_import_obj",
  "blender_mesh_dump", "blender_send_to_studio", "blender_execute_code",
  "blender_get_scene_info", "blender_get_object_info", "blender_screenshot",
  "export_blender_fbx", "import_blender_fbx",
]);
function btool(name, description, props, required) {
  return { name, server: "blender", description, inputSchema: { type: "object", properties: props || {}, required: required || [] } };
}
const BLENDER_TOOLS = [
  btool("get_scene_info", "Inspect the live Blender scene (objects, cameras, lights, collections).", {}, []),
  btool("get_object_info", "Details for one object in the Blender scene.", { name: { type: "string" } }, ["name"]),
  btool("execute_blender_code", "Run Python (bpy) inside Blender. Prefer the named blender_* tools.", { code: { type: "string" } }, ["code"]),
  btool("get_viewport_screenshot", "Capture the Blender 3D viewport.", { max_size: { type: "integer" } }, []),
  btool("blender_send_to_studio", "ONE SHOT: read the live Blender meshes (selected objects, or objects[]; modifiers applied, world transforms, material base colour) and build them in Roblox Studio as real MeshParts (EditableMesh) under Workspace.OR_Imported. No file, no FBX. Limits per send: 20k triangles per mesh (blender_decimate first), 40k triangles total (send in groups). publish:true also uploads each mesh as a Mesh asset you own (permanent MeshId; asks for approval).", { objects: { type: "array", items: { type: "string" } }, dest: { type: "string", description: "parent in Workspace (default Workspace)" }, scale: { type: "number", description: "studs per Blender metre (default 20)" }, publish: { type: "boolean" }, append: { type: "boolean", description: "keep the previous OR_Imported and add to it" } }, []),
  btool("blender_export_fbx", "Export meshes to an FBX (Forward -Z, Up Y). filepath optional. Also dumps meshes so blender_send_to_studio / asset_bridge_import can run with no path.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_fbx", "Import an FBX into the live Blender scene. filepath optional — defaults to the last OR export.", { filepath: { type: "string" } }, []),
  btool("blender_export_obj", "Export selected/all meshes to OBJ. filepath optional.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_obj", "Import an OBJ into the live Blender scene.", { filepath: { type: "string" } }, ["filepath"]),
  btool("blender_add_cube", "Add a cube.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array", items: { type: "number" } } }, []),
  btool("blender_add_sphere", "Add a UV sphere.", { name: { type: "string" }, radius: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cylinder", "Add a cylinder.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cone", "Add a cone.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_plane", "Add a plane.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_torus", "Add a torus.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_monkey", "Add Suzanne (monkey head).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_empty", "Add an Empty (use as a group parent).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_camera", "Add a camera.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_light", "Add a light (SUN/POINT/SPOT/AREA).", { name: { type: "string" }, type: { type: "string" }, location: { type: "array" }, energy: { type: "number" } }, []),
  btool("blender_group", "Group objects: parent them to a new Empty and put them in a collection of the same name.", { name: { type: "string", description: "Group name" }, objects: { type: "array", items: { type: "string" }, description: "Object names; omit = selected/all meshes" } }, []),
  btool("blender_ungroup", "Ungroup: clear parent, keep world transforms, remove the group Empty.", { name: { type: "string" } }, []),
  btool("blender_parent", "Parent objects under an existing object/Empty.", { parent: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, ["parent"]),
  btool("blender_unparent", "Clear parent, keep world transforms.", { objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_join", "Join mesh objects into one.", { objects: { type: "array", items: { type: "string" } }, name: { type: "string" } }, []),
  btool("blender_move_to_collection", "Move objects into a collection (created if missing).", { collection: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_list_collections", "List collections and their objects.", {}, []),
  btool("blender_list_objects", "List every object: type, location, parent, collections.", {}, []),
  btool("blender_delete", "Delete objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_duplicate", "Duplicate objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_rename", "Rename an object.", { name: { type: "string" }, new_name: { type: "string" } }, ["new_name"]),
  btool("blender_select", "Select objects by name.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_transform", "Set location / rotation (radians) / scale.", { name: { type: "string" }, objects: { type: "array" }, location: { type: "array" }, rotation: { type: "array" }, scale: { type: "array" } }, []),
  btool("blender_apply_transforms", "Apply rotation/scale (and optional location).", { objects: { type: "array" }, location: { type: "boolean" }, rotation: { type: "boolean" }, scale: { type: "boolean" } }, []),
  btool("blender_set_origin", "Set object origin (ORIGIN_GEOMETRY, ORIGIN_CURSOR, ORIGIN_CENTER_OF_MASS).", { name: { type: "string" }, type: { type: "string" } }, []),
  btool("blender_shade_smooth", "Shade smooth.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_material", "Assign a Principled BSDF material. color = [r,g,b] or [r,g,b,a] 0–1.", { name: { type: "string" }, material: { type: "string" }, color: { type: "array" } }, []),
  btool("blender_add_modifier", "Add a modifier: SUBSURF, BEVEL, SOLIDIFY, MIRROR, ARRAY, BOOLEAN, DECIMATE. apply=true to apply.", { name: { type: "string" }, type: { type: "string" }, levels: { type: "integer" }, apply: { type: "boolean" }, target: { type: "string" } }, []),
  btool("blender_boolean", "Boolean one mesh with another (DIFFERENCE/UNION/INTERSECT) and apply.", { name: { type: "string" }, target: { type: "string" }, operation: { type: "string" } }, ["target"]),
  btool("blender_clear_scene", "Delete objects. keep = names to leave.", { keep: { type: "array", items: { type: "string" } } }, []),
  btool("blender_add_grid", "Add a grid.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_text", "Add 3D text. text=string, extrude=thickness.", { name: { type: "string" }, text: { type: "string" }, extrude: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_translate", "Move objects by offset [x,y,z] (relative).", { offset: { type: "array" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_rotate", "Set rotation in DEGREES [x,y,z]. add=true to add.", { rotation_deg: { type: "array" }, add: { type: "boolean" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_dimensions", "Set object size in meters [x,y,z].", { dimensions: { type: "array" }, name: { type: "string" } }, []),
  btool("blender_origin_to_bottom", "Put origin at the lowest point (Roblox feet).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_drop_to_ground", "Move objects so the lowest vertex sits on Z=0.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_array", "Duplicate along offset, count times.", { count: { type: "integer" }, offset: { type: "array" }, objects: { type: "array" } }, []),
  btool("blender_mirror", "Mirror-duplicate across X/Y/Z.", { axis: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_triangulate", "Convert faces to triangles (needed before Studio).", { objects: { type: "array" } }, []),
  btool("blender_apply_modifiers", "Apply every modifier so dump/export sees the result.", { objects: { type: "array" } }, []),
  btool("blender_merge", "Merge-by-distance (remove doubles).", { distance: { type: "number" }, objects: { type: "array" } }, []),
  btool("blender_recalc_normals", "Recalculate outside normals.", { objects: { type: "array" } }, []),
  btool("blender_hide", "Hide objects.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_unhide", "Unhide objects (omit names = all).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_undo", "Undo last Blender action.", {}, []),
  btool("blender_stats", "Vertex/face/modifier counts.", { objects: { type: "array" } }, []),
  btool("blender_get_selection", "Names of selected objects.", {}, []),
  btool("blender_uv_unwrap", "Smart UV project.", { objects: { type: "array" } }, []),
  btool("blender_look_at", "Point an object/camera at a target or location.", { name: { type: "string" }, target: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_align_camera", "Align the scene camera to an axis (front/back/left/right/top/bottom/iso) looking at a target or the selection.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_align_camera_axis", "Same as blender_align_camera.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_view_axis", "Align the 3D viewport to FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM (or iso via camera).", { axis: { type: "string" } }, []),
  btool("blender_camera_to_view", "Move the scene camera to match the current 3D viewport.", {}, []),
  btool("blender_set_camera_lens", "Set camera focal length, clip planes, or orthographic mode.", { name: { type: "string" }, lens: { type: "number" }, clip_start: { type: "number" }, clip_end: { type: "number" }, ortho: { type: "boolean" }, ortho_scale: { type: "number" } }, []),
  btool("blender_scale", "Scale selected/named objects. scale:[x,y,z] or a number. multiply=true multiplies current scale.", { name: { type: "string" }, scale: { type: "array" }, factor: { type: "array" }, multiply: { type: "boolean" } }, []),
  btool("blender_bevel", "Bevel mesh edges in edit mode.", { name: { type: "string" }, width: { type: "number" }, segments: { type: "number" } }, []),
  btool("blender_solidify", "Add a Solidify modifier (thickness).", { name: { type: "string" }, thickness: { type: "number" } }, []),
  btool("blender_extrude", "Extrude the mesh along normals.", { name: { type: "string" }, distance: { type: "number" } }, []),
  btool("blender_add_curve", "Add a Bezier curve.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_armature", "Add an armature (single bone).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_keyframe_insert", "Insert a keyframe on location/rotation/scale (or data_path) at frame.", { name: { type: "string" }, frame: { type: "number" }, data_path: { type: "string" } }, []),
  btool("blender_set_frame", "Set the current scene frame.", { frame: { type: "number" } }, []),
  btool("blender_set_active_camera", "Make a camera the scene camera.", { name: { type: "string" } }, []),
  btool("blender_track_to", "TRACK_TO constraint from selected objects toward target.", { target: { type: "string" }, name: { type: "string" } }, ["target"]),
  btool("blender_cursor_to_selected", "Move the 3D cursor to the selection midpoint.", { name: { type: "string" } }, []),
  btool("blender_randomize_transform", "Jitter location/rotation/scale of selected objects.", { name: { type: "string" }, location: { type: "number" }, rotation: { type: "number" }, scale: { type: "number" }, seed: { type: "number" } }, []),
  btool("blender_hide_render", "Hide (or unhide) objects from render.", { name: { type: "string" }, hide: { type: "boolean" } }, []),
  btool("blender_subdivision", "Add a Subdivision Surface modifier.", { name: { type: "string" }, levels: { type: "number" }, render_levels: { type: "number" } }, []),
  btool("blender_origin_to_geometry", "Set origin to geometry for selected objects.", { name: { type: "string" } }, []),
  btool("blender_capture_id", "Capture unique IDs (session_uid, data name, materials, collections) for selected Blender objects.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("capture_id", "Capture unique IDs for selected Blender objects (alias of blender_capture_id).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_export_gltf", "Export selected/all objects to GLTF or GLB.", { filepath:{type:"string"}, objects:{type:"array"}, format:{type:"string",enum:["GLB","GLTF_SEPARATE"]} }, []),
  btool("blender_import_gltf", "Import a GLTF or GLB file.", { filepath:{type:"string"} }, ["filepath"]),
  btool("blender_scene_cleanup", "Remove orphan data, empty collections, and optionally unused materials.", { purge_orphans:{type:"boolean"}, empty_collections:{type:"boolean"}, unused_materials:{type:"boolean"} }, []),
  btool("blender_set_world", "Set world background color and strength.", { color:{type:"array"}, strength:{type:"number"} }, []),
  btool("blender_set_render", "Set render engine, resolution, samples, frame range and output path.", { engine:{type:"string"}, width:{type:"integer"}, height:{type:"integer"}, samples:{type:"integer"}, frame_start:{type:"integer"}, frame_end:{type:"integer"}, filepath:{type:"string"} }, []),
  btool("blender_render_image", "Render the active camera to an image file.", { filepath:{type:"string"}, frame:{type:"integer"} }, []),
  btool("blender_principled_material", "Create/update a node-based Principled material with color, metallic, roughness and emission.", { name:{type:"string"}, material:{type:"string"}, color:{type:"array"}, metallic:{type:"number"}, roughness:{type:"number"}, emission:{type:"array"}, emission_strength:{type:"number"} }, []),
  btool("blender_inset", "Inset selected/all faces on mesh objects.", { name:{type:"string"}, thickness:{type:"number"}, depth:{type:"number"} }, []),
  btool("blender_add_bone", "Add a named bone to an armature with head/tail coordinates and optional parent.", { armature:{type:"string"}, name:{type:"string"}, head:{type:"array"}, tail:{type:"array"}, parent:{type:"string"} }, ["armature","name"]),
  btool("blender_normalize_weights", "Normalize all vertex-group weights on selected mesh objects.", { objects:{type:"array"} }, []),
  btool("scene_list", "List real Blender scenes.", {}, []),
  btool("scene_create", "Create a Blender scene.", {name:{type:"string"}}, ["name"]),
  btool("scene_delete", "Delete a Blender scene except the only remaining scene.", {name:{type:"string"}}, ["name"]),
  btool("scene_duplicate", "Duplicate a Blender scene.", {name:{type:"string"},new_name:{type:"string"}}, []),
  btool("scene_set_active", "Set the active Blender scene.", {name:{type:"string"}}, ["name"]),
  btool("object_delete", "Delete selected or named objects.", {name:{type:"string"},objects:{type:"array"}}, []),
  btool("object_duplicate", "Duplicate selected or named objects.", {name:{type:"string"},objects:{type:"array"}}, []),
  btool("object_select", "Select named objects.", {name:{type:"string"},objects:{type:"array"}}, []),
  btool("object_deselect", "Deselect every object.", {}, []),
  btool("object_rename", "Rename an object.", {name:{type:"string"},new_name:{type:"string"}}, ["name","new_name"]),
  btool("object_parent", "Parent objects while preserving transforms.", {parent:{type:"string"},objects:{type:"array"}}, ["parent"]),
  btool("object_unparent", "Clear object parents while preserving transforms.", {objects:{type:"array"}}, []),
  btool("object_join", "Join mesh objects.", {objects:{type:"array"},name:{type:"string"}}, []),
  btool("object_separate", "Separate mesh loose parts.", {name:{type:"string"}}, []),
  btool("object_get_transform", "Read object location, rotation, scale and dimensions.", {name:{type:"string"}}, []),
  btool("object_set_transform", "Set object location, rotation and scale.", {name:{type:"string"},location:{type:"array"},rotation:{type:"array"},scale:{type:"array"}}, []),
  btool("object_apply_transform", "Apply object transforms.", {objects:{type:"array"},location:{type:"boolean"},rotation:{type:"boolean"},scale:{type:"boolean"}}, []),
  btool("mesh_bevel", "Bevel mesh edges.", {name:{type:"string"},width:{type:"number"},segments:{type:"integer"}}, []),
  btool("mesh_extrude", "Extrude selected mesh faces.", {name:{type:"string"},distance:{type:"number"}}, []),
  btool("mesh_inset", "Inset mesh faces.", {name:{type:"string"},thickness:{type:"number"},depth:{type:"number"}}, []),
  btool("mesh_subdivide", "Subdivide mesh geometry.", {name:{type:"string"},cuts:{type:"integer"}}, []),
  btool("mesh_merge", "Merge vertices by distance.", {objects:{type:"array"},distance:{type:"number"}}, []),
  btool("mesh_decimate", "Decimate selected meshes.", {objects:{type:"array"},ratio:{type:"number"}}, []),
  btool("mesh_cleanup", "Clean scene and mesh data.", {purge_orphans:{type:"boolean"},empty_collections:{type:"boolean"}}, []),
  btool("modifier_add", "Add a supported Blender modifier.", {name:{type:"string"},type:{type:"string"},target:{type:"string"}}, ["type"]),
  btool("modifier_remove", "Remove a named modifier.", {name:{type:"string"},modifier:{type:"string"}}, ["modifier"]),
  btool("modifier_configure", "Set validated properties on a modifier.", {name:{type:"string"},modifier:{type:"string"},properties:{type:"object"}}, ["modifier","properties"]),
  btool("modifier_apply", "Apply all modifiers on selected objects.", {objects:{type:"array"}}, []),
  btool("modifier_list", "List modifiers on an object.", {name:{type:"string"}}, []),
  btool("material_create", "Create a node-enabled material.", {material:{type:"string"}}, ["material"]),
  btool("material_assign", "Assign or create a Principled material.", {name:{type:"string"},material:{type:"string"},color:{type:"array"}}, []),
  btool("material_remove", "Remove and unlink a material.", {material:{type:"string"}}, ["material"]),
  btool("material_duplicate", "Duplicate a material.", {material:{type:"string"},new_name:{type:"string"}}, ["material"]),
  btool("node_create", "Create a shader node in a material.", {material:{type:"string"},type:{type:"string"},name:{type:"string"}}, ["material","type"]),
  btool("node_delete", "Delete a shader node.", {material:{type:"string"},name:{type:"string"}}, ["material","name"]),
  btool("node_inspect", "Inspect material nodes and links.", {material:{type:"string"}}, ["material"]),
  btool("uv_unwrap", "Smart unwrap selected mesh objects.", {objects:{type:"array"}}, []),
  btool("uv_pack", "Pack UV islands.", {objects:{type:"array"},margin:{type:"number"}}, []),
  btool("uv_inspect", "Inspect UV layers.", {objects:{type:"array"}}, []),
  btool("animation_list", "List actions and animated objects.", {}, []),
  btool("keyframe_insert", "Insert an object keyframe.", {name:{type:"string"},frame:{type:"integer"},data_path:{type:"string"}}, ["name","frame"]),
  btool("timeline_set", "Set current timeline frame.", {frame:{type:"integer"}}, ["frame"]),
  btool("camera_create", "Create a camera.", {name:{type:"string"},location:{type:"array"}}, []),
  btool("camera_set_active", "Set active scene camera.", {name:{type:"string"}}, ["name"]),
  btool("light_create", "Create a light.", {name:{type:"string"},type:{type:"string"},location:{type:"array"},energy:{type:"number"}}, []),
  btool("world_set", "Set world color and strength.", {color:{type:"array"},strength:{type:"number"}}, []),
];
for (const t of BLENDER_TOOLS) BLENDER_TOOL_NAMES.add(t.name);

function blenderServers(list) {
  const rest = (Array.isArray(list) ? list : []).filter((s) => s && s.id !== "blender");
  if (blenderAddon) {
    rest.push({
      id: "blender", name: "Blender",
      alive: true, tools: BLENDER_TOOLS.length,
    });
  }
  return rest;
}
function mergeBlenderTools(tools) {
  const base = Array.isArray(tools) ? tools.slice() : [];
  if (!blenderAddon) return base;
  const have = new Set(base.map((t) => t && t.name));
  for (const t of BLENDER_TOOLS) if (!have.has(t.name)) base.push(t);
  return base;
}

function log(...a) {
  console.log("[or-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (manualStudioDisconnect) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  const url = engineUrl();
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }
  ws = sock;
  mcpConnectStarted=performance.now();setMcpLifecycle(reconnectAttempts ? "RECONNECTING" : "CONNECTING");

  sock.onopen = () => {
    if (sock !== ws) return;
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    reconnectAttempts = 0;
    connectionId = `mcp-${Date.now().toString(36)}`;
    setMcpLifecycle("CONNECTED");mcpTrace("connect",{duration:Math.round(performance.now()-mcpConnectStarted),status:"CONNECTED"});
    lastMessageAt = Date.now();
    log(`connected to ${engineLabel()} bridge (${url})`);
    startHeartbeat();
    refreshProcStatus();
    broadcastStatus();
  };

  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  sock.onclose = () => {
    if (sock !== ws) return;
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    robloxEditorConnected = false;
    toolsCache = [];
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  sock.onerror = () => {
    if (sock !== ws) return;
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { sock.close(); } catch {}
  };
}

const RECONNECT_SLOW_MS = 15000; // after the fast attempts, keep knocking gently
function scheduleReconnect() {
  if (manualStudioDisconnect) return;
  if (reconnectAttempts >= MCP_MAX_RECONNECT_ATTEMPTS) {
    // Fast attempts exhausted: report ERROR for the UI, but never stop trying.
    // or-core is usually started AFTER the browser, so a slow background
    // retry (plus the /api/status nudge) is what makes Start unlock on its own.
    if (mcpLifecycle !== "ERROR") setMcpLifecycle("ERROR", { errorCode: "MCP_SERVER_UNAVAILABLE" });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_SLOW_MS);
    return;
  }
  clearTimeout(reconnectTimer);reconnectAttempts++;
  const delay=Math.min(RECONNECT_MAX,reconnectDelay)+Math.floor(Math.random()*Math.max(50,reconnectDelay*.2));
  setMcpLifecycle("RECONNECTING",{retryCount:reconnectAttempts});
  reconnectTimer=setTimeout(connect,delay);reconnectDelay=Math.min(reconnectDelay*2,RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      const toolPending = [...pending.values()].some((p) => p.type === "call_tool");
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        if (toolPending) return; // execute_luau owns the helper — pong resumes after it
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      // Use short timeout so pending ping doesn't leak for 130s
      send({ type: "ping" }, 12000).catch(() => {});
      refreshStudioStatus();
      // ── MCP auto-heal (v1.12) ────────────────────────────────────────────
      // The StudioMCP helper the agent spawns can die on its own (Studio
      // update, sleep/resume, crash). The agent only recycles it when a TOOL
      // call proves the helper dead - so between calls the bar kept showing
      // "connected" with a corpse helper and every command failed. If the
      // helper has been dead for two consecutive heartbeats, restart it
      // proactively (max once per 3 min so a legitimately closed Studio can't
      // cause a restart loop - the agent refuses when Studio's MCP option is
      // off, and that answer must win).
      if ((engine === "roblox" || engine === "anim") && !toolPending) {
        // Studio closed / MCP plugin off: do not restart-loop the helper.
        if (studioProc === false || studioApp === false) {
          mcpDownStreak = 0;
        } else if (!mcpAlive) {
          mcpDownStreak++;
          // Idle heal: one missed heartbeat, 30s cooldown. Never heal mid-tool.
          if (mcpDownStreak >= 2 && mcpHealAttempts < 3 && Date.now() - lastMcpHealAt > 30000 * Math.pow(2,mcpHealAttempts)) {
            lastMcpHealAt = Date.now();
            mcpDownStreak = 0;
            mcpHealAttempts++;
            log("MCP helper down across heartbeats - auto-restarting Studio MCP");
            send({ type: "restart_mcp" }, 30000).then((r) => {
              if (r && r.ok) {
                send({ type: "list_tools" }, 10000).catch(() => {});
                refreshStudioStatus();
              }
            }).catch(() => {});
          }
        } else {
          mcpDownStreak = 0;mcpHealAttempts=0;
        }
      }
    }
  }, HEARTBEAT_MS);
}
// Auto-heal state (see startHeartbeat).
let mcpDownStreak = 0;
let lastMcpHealAt = 0;
let mcpHealAttempts = 0;

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = MCP_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
const IDEMPOTENT_STUDIO_TOOLS = new Set([
  "script_read","script_search","script_grep","inspect_instance","search_game_tree",
  "get_studio_state","get_console_output","get_children","get_descendants",
  "find_first_child","list_roblox_studios","selection_info","screen_capture"
]);
function bridgeRequestIsIdempotent(obj) {
  if (!obj || obj.type !== "call_tool") return true;
  const name=String(obj.name||"").split("/").pop();
  return IDEMPOTENT_STUDIO_TOOLS.has(name);
}
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(20000);
  }
  const attempt = () => new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok:false,kind:"disconnected",errorCode:mcpLifecycle==="ERROR"?"MCP_SERVER_UNAVAILABLE":"MCP_CONNECTION_REFUSED",error:"bridge not connected",sent:false });
      return;
    }
    const id = nextId++;
    const requestId = obj.requestId || `or-${Date.now().toString(36)}-${id}-${crypto.randomUUID().slice(0,8)}`;
    const payload = {
      ...obj,
      version: "1.0",
      requestId,
      command: obj.type === "call_tool" ? obj.name : obj.type,
      args: obj.arguments || {},
      timestamp: Date.now(),
      id
    };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ok:false,kind:"timeout",errorCode:obj.type==="list_tools"?"MCP_TOOL_DISCOVERY_FAILED":"MCP_REQUEST_TIMEOUT",error:"bridge did not respond in time",sent:true});
      }
    }, timeout);
    pending.set(id, { resolve, timer, type: obj.type, requestId, createdAt: Date.now() });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e), sent: true });
    }
  });
  let r = await attempt();
  // Never replay a mutating Studio request after it may have reached the bridge.
  // A timeout is ambiguous: the first execution may still complete. Read-only
  // operations may be retried once after reconnect; requests proven unsent may
  // also be attempted once. This replaces the former unconditional 3 retries.
  const retryable = r && r.kind === "disconnected" &&
    (r.sent === false || bridgeRequestIsIdempotent(obj));
  if (retryable) {
    try { if (ws) ws.close(); } catch {}
    ws = null;
    connected = false;
    connect();
    await waitForConnection(12000);
    r = await attempt();
  }
  return r;
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  if ([...pending.values()].some((p) => p.type === "call_tool")) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = v === true;
    // local readiness comes from the agent's /api/status (local_ready), not editor probes
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    } else {
      // The probe result can change independently of the tri-state cache when a
      // timeout returns null, so still publish the strict editor flag.
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    const online = studioConnected === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: true, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) { toolsCache = msg.tools; toolsCacheAt=Date.now(); }
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    setMcpLifecycle("READY");
    if (Array.isArray(msg.tools)) { toolsCache = msg.tools; toolsCacheAt=Date.now(); }
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: !!msg.ok, tools: toolsCache, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    const result = msg.result && typeof msg.result === "object" ? msg.result : null;
    const rawError = msg.error ?? result?.error;
    const errorCode = msg.errorCode || msg.code || rawError?.code || result?.errorCode;
    const errorText = typeof rawError === "string" ? rawError : rawError?.message || (rawError == null ? "" : JSON.stringify(rawError));
    const text = msg.text ?? result?.text ?? (typeof result?.content === "string" ? result.content : undefined);
    resolvePending(msg.id ?? msg.requestId, msg.ok !== false
      ? { ok: true, text, images: msg.images || result?.images || [], version:msg.version, requestId:msg.requestId }
      : { ok: false, kind: msg.kind || "execution", error: errorText || "Bridge command failed", errorCode: errorCode || "BRIDGE_COMMAND_FAILED", version:msg.version, requestId:msg.requestId });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) { toolsCache = msg.tools; toolsCacheAt=Date.now(); }
    if (Array.isArray(msg.servers)) {
      serversCache = msg.servers;
      const rbx = serversCache.find((x) => x.id === "roblox" || x.id === "studio");
      if (rbx) robloxEditorConnected = !!rbx.alive;
      const loc = serversCache.find((x) => x.id === "local");
      if (loc) localReady = !!loc.alive;
    }
    resolvePending(msg.id, { ok: !!msg.ok, alive: mcpAlive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    const err = msg.error;
    resolvePending(msg.id ?? msg.requestId, { ok: false, kind: "protocol", error: typeof err === "string" ? err : err?.message || JSON.stringify(err || "Bridge error"), errorCode: msg.errorCode || msg.code || err?.code || "BRIDGE_PROTOCOL_ERROR", requestId: msg.requestId });
    return;
  }}

function resolvePending(id, value) {
  let transportId = id;
  let p = pending.get(transportId);
  if (!p && id != null) {
    for (const [candidate, entry] of pending) { if (entry.requestId === String(id)) { transportId=candidate; p=entry; break; } }
  }
  if (!p) return; // duplicate, cancelled, timed-out, or stale response
  // The transport id is allocated per send and is the authoritative correlation
  // key. Older MCP bridges return their own nested requestId (or omit it), so
  // treating that optional diagnostic field as a second correlation key caused
  // valid Studio replies to fail with BRIDGE_PROTOCOL_ERROR. A stale reply can
  // still never resolve another operation: it must match an active transport id.
  if (value && value.requestId && value.requestId !== p.requestId) {
    mcpTrace("response_request_id_normalized", {requestId:p.requestId,status:"OK"});
    value={...value,requestId:p.requestId};
  }
  clearTimeout(p.timer);
  pending.delete(transportId);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  return {
    type: "rs-status", connected, mcpAlive, studio: studioConnected, studioApp, studioProc,
    robloxProc, roblox_connected: robloxEditorConnected,
    local_connected: localReady, local_full: localFull,
    local_root: localRoot,
    tools: mergeBlenderTools(toolsCache).length,
    servers: blenderServers(serversCache), engine,
    blender: blenderAddon, blender_error: blenderError || undefined,
  };
}

async function refreshProcStatus() {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (!r.ok) return;
    // or-core answers on 3000 but our WebSocket is down: the agent was started
    // AFTER the worker gave up its bounded reconnect attempts. Re-arm the
    // backoff and dial again right away so Start unlocks within one poll.
    if (!connected && !manualStudioDisconnect && !(ws && ws.readyState === WebSocket.CONNECTING)) {
      reconnectAttempts = 0;
      reconnectDelay = RECONNECT_MIN;
      connect();
    }
    const j = await r.json();
    const nr = !!j.roblox_proc;
    const nl = j.local_ready === true;
    const nf = j.local_full === true;
    const nrRoot = typeof j.local_root === "string" ? j.local_root : localRoot;
    const changed = nr !== robloxProc || nl !== localReady || nf !== localFull || nrRoot !== localRoot;
    robloxProc = nr;
    localReady = nl;
    localFull = nf;
    localRoot = nrRoot;
    // One-shot re-sync: if the agent restarted with FULL off but the user's
    // persisted toggle says ON, re-apply their choice once.
    if (!fullSyncedOnce) {
      fullSyncedOnce = true;
      try {
        chrome.storage.local.get("rs-local-full", (o) => {
          const want = o && o["rs-local-full"];
          if (typeof want === "boolean" && want !== nf) {
            fetch("http://127.0.0.1:3000/api/local-full", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: want }),
            }).then((r2) => r2.json()).then((j2) => { localFull = j2.local_full === true; broadcastStatus(); }).catch(() => {});
          }
        });
      } catch {}
    }
    if (changed) broadcastStatus();
  } catch {}
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  providerTabs().then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}


async function ddgSearch(query, limit) {
  const q = String(query || "").trim();
  const n = Math.max(1, Math.min(8, Number(limit) || 5));
  if (!q) return [];
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  const pushUnique = (arr, item) => {
    if (!item || !item.url) return;
    let url = String(item.url);
    try {
      const um = url.match(/[?&]uddg=([^&]+)/);
      if (um) url = decodeURIComponent(um[1]);
    } catch {}
    if (!/^https?:\/\//i.test(url)) return;
    if (/duckduckgo\.com|javascript:/i.test(url)) return;
    if (arr.some((x) => x.url === url)) return;
    arr.push({ title: String(item.title || url).replace(/<[^>]+>/g, "").trim() || url, url: url, snippet: String(item.snippet || "").replace(/<[^>]+>/g, "").trim() });
  };
  const parseHtmlLinks = (html, max) => {
    const out = [];
    const reA = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = reA.exec(html)) && out.length < max) pushUnique(out, { url: m[1], title: m[2] });
    const reLite = /<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]{3,200}?)<\/a>/gi;
    while ((m = reLite.exec(html)) && out.length < max) pushUnique(out, { url: m[1], title: m[2] });
    const reBing = /<li class="b_algo"[\s\S]*?<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = reBing.exec(html)) && out.length < max) pushUnique(out, { url: m[1], title: m[2] });
    return out;
  };

  try {
    const res = await fetch("https://api.duckduckgo.com/?q=" + encodeURIComponent(q) + "&format=json&no_html=1&skip_disambig=1", {
      headers: { "Accept": "application/json", "User-Agent": ua },
    });
    if (res.ok) {
      const j = await res.json();
      const out = [];
      if (j.AbstractURL) pushUnique(out, { title: j.Heading || q, url: j.AbstractURL, snippet: j.AbstractText || "" });
      const topics = [];
      for (const t of (j.RelatedTopics || [])) {
        if (t.FirstURL) topics.push(t);
        if (t.Topics) for (const s of t.Topics) if (s.FirstURL) topics.push(s);
      }
      for (const t of topics) pushUnique(out, { title: t.Text, url: t.FirstURL, snippet: t.Text });
      for (const r of (j.Results || [])) pushUnique(out, { title: r.Text, url: r.FirstURL });
      if (out.length) return out.slice(0, n);
    }
  } catch {}

  for (const url of [
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
    "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q),
  ]) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua, "Accept": "text/html" } });
      if (!res.ok) continue;
      const hits = parseHtmlLinks(await res.text(), n);
      if (hits.length) return hits;
    } catch {}
  }

  try {
    const res = await fetch("https://en.wikipedia.org/w/api.php?action=opensearch&limit=" + n + "&namespace=0&format=json&origin=*&search=" + encodeURIComponent(q), {
      headers: { "Accept": "application/json", "User-Agent": ua },
    });
    if (res.ok) {
      const j = await res.json();
      const out = [];
      const titles = j[1] || [], descs = j[2] || [], urls = j[3] || [];
      for (let i = 0; i < urls.length; i++) pushUnique(out, { title: titles[i], url: urls[i], snippet: descs[i] });
      if (out.length) return out;
    }
  } catch {}

  try {
    const res = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=" + n + "&utf8=1&format=json&origin=*&srsearch=" + encodeURIComponent(q), {
      headers: { "Accept": "application/json", "User-Agent": ua },
    });
    if (res.ok) {
      const j = await res.json();
      const rows = (j.query && j.query.search) || [];
      const out = [];
      for (const row of rows) {
        pushUnique(out, {
          title: row.title,
          url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(row.title || "").replace(/ /g, "_")),
          snippet: String(row.snippet || "").replace(/<[^>]+>/g, ""),
        });
      }
      if (out.length) return out.slice(0, n);
    }
  } catch {}

  try {
    const res = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": ua, "Accept": "text/html" },
    });
    if (res.ok) {
      const hits = parseHtmlLinks(await res.text(), n);
      if (hits.length) return hits;
    }
  } catch {}

  try {
    const res = await fetch("https://search.brave.com/search?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": ua, "Accept": "text/html" },
    });
    if (res.ok) {
      const hits = parseHtmlLinks(await res.text(), n);
      if (hits.length) return hits;
    }
  } catch {}

  try {
    const res = await fetch("https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), {
      headers: { "Accept": "text/plain", "User-Agent": ua },
    });
    if (res.ok) {
      const md = await res.text();
      const out = [];
      const re = /\[([^\]]{3,120})\]\((https?:[^)\s]+)\)/g;
      let m;
      while ((m = re.exec(md)) && out.length < n) pushUnique(out, { title: m[1], url: m[2] });
      if (out.length) return out;
    }
  } catch {}
  return [];
}
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  s = s.replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return " "; } });
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return s;
}


// ── Blender (one-shot TCP 9876 via AgentScript) ─────────────────────────
// Native bin/or-core.exe rejects add_server/uvx. Chrome cannot open raw TCP.
// Connect is a short PowerShell/Python probe of the blender-mcp addon the
// user already started. Tool calls write a JSON request, run blender_once,
// then read the JSON response. No daemon, so the agent console is not
// flooded with failed `start /B py` / shim-restart loops.
function isBlenderToolName(name) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  return BLENDER_TOOL_NAMES.has(bare) || /^blender_/.test(bare);
}
const BLENDER_KEY = "rs-blender-on";
try {
  chrome.storage?.local.get(BLENDER_KEY, (o) => {
    if (o && o[BLENDER_KEY]) blenderAddon = true;
  });
} catch {}
function setBlender(on, err) {
  const was = blenderAddon;
  blenderAddon = !!on;
  blenderError = on ? "" : (err || blenderError);
  try { chrome.storage.local.set({ [BLENDER_KEY]: !!on }); } catch {}
  if (was !== blenderAddon) broadcastStatus();
}

async function sendLocalEngine(obj, timeout = 25000) {
  if (engine === "local" && connected && ws && ws.readyState === WebSocket.OPEN) {
    return send(obj, timeout);
  }
  return await new Promise((resolve) => {
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${PORT_LOCAL}`); }
    catch (e) { resolve({ ok: false, error: "bin/or-core.exe is not running" }); return; }
    const id = 800000 + Math.floor(Math.random() * 99999);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: "bin/or-core.exe did not answer — is it running?" }), timeout);
    sock.onerror = () => done({ ok: false, error: "bin/or-core.exe is not running" });
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ ...obj, id })); }
      catch (e) { done({ ok: false, error: String(e) }); }
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "connected") {
        if (typeof msg.workspace_root === "string" && msg.workspace_root) localRoot = msg.workspace_root;
        return;
      }
      const matches = msg.id == null || msg.id === id || msg.requestId === obj.requestId;
      if (msg.type === "tool_result" && matches) {
        const result = msg.result && typeof msg.result === "object" ? msg.result : null;
        const raw = msg.error ?? result?.error;
        const text = typeof raw === "string" ? raw : raw?.message || (raw == null ? "" : JSON.stringify(raw));
        done(msg.ok !== false ? { ok: true, text: msg.text ?? result?.text, images: msg.images || result?.images || [], requestId:msg.requestId } : { ok: false, kind:msg.kind||"execution", error: text || "Local command failed", errorCode:msg.errorCode || msg.code || raw?.code || "LOCAL_COMMAND_FAILED", requestId:msg.requestId });
        return;
      }
      if (msg.type === "error" && matches) {
        const raw=msg.error; done({ ok:false, kind:"protocol", error:typeof raw === "string" ? raw : raw?.message || JSON.stringify(raw || "Bridge error"), errorCode:msg.errorCode || msg.code || raw?.code || "BRIDGE_PROTOCOL_ERROR", requestId:msg.requestId });
      }
    };
  });
}

async function extText(name) {
  const r = await fetch(chrome.runtime.getURL(name));
  if (!r.ok) throw new Error("extension file missing: " + name);
  return await r.text();
}

async function localWrite(path, content) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "write_file",
    arguments: { path, content },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not write " + path));
  return r.text || "";
}

async function localRead(path, offset, limit=4000) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "read_file",
    arguments: { path, offset: offset || 1, limit },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not read " + path));
  const lines = String(r.text || "").split("\n");
  const body = [];
  let more = false;
  let next = offset || 1;
  for (const ln of lines) {
    const cont = ln.match(/\.\.\. lines (\d+)/);
    if (cont) { more = true; next = Number(cont[1]); continue; }
    const m = ln.match(/^\s*\d+\s+\|\s(.*)$/);
    if (m) body.push(m[1]);
  }
  return { text: body.join("\n"), more, next, count: body.length };
}
async function localReadAll(path) {
  let offset = 1, chunks = [];
  for (let i = 0; i < 20; i++) {
    const part = await localRead(path, offset);
    if (part.text) chunks.push(part.text);
    if (!part.more || !part.count) break;
    offset = part.next || (offset + part.count);
  }
  return chunks.join("\n");
}

// Read a file that was written as short (<= 3000-char) lines by
// blender_once.* / blender_ops.py and join the lines back together. or-core's
// read_file clips ONE read at 40k characters, so a 1 MB mesh dump can only
// cross the native transport eight short lines at a time (same trick as the
// screenshot base64 below). Returns "" when the file is missing.
async function localReadWrapped(path) {
  let offset = 1, chunks = [];
  for (let i = 0; i < 4000; i++) {
    let part;
    try { part = await localRead(path, offset, 8); } catch (e) { if (!chunks.length) throw e; break; }
    if (part.text) chunks.push(part.text.split("\n").join(""));
    if (!part.more || !part.count) break;
    offset = part.next || (offset + part.count);
  }
  return chunks.join("").replace(/^\uFEFF/, "").trim();
}

async function localImageBase64(imagePath) {
  // The upstream Blender addon requires a filepath and returns metadata, not
  // transferable image bytes. Encode the workspace-owned capture in bounded
  // text lines so the native read_file transport never truncates one huge line.
  const script=[
    "import base64,sys,textwrap",
    "data=base64.b64encode(open(sys.argv[1],'rb').read()).decode('ascii')",
    "open(sys.argv[2],'w',encoding='ascii').write('\\n'.join(textwrap.wrap(data,3000)))",
  ].join("\n");
  await localWrite("or_encode_image.py",script);
  const input=String(imagePath||"or_blender_shot.png");
  const output="or_blender_shot.b64";
  let encoded=false,last="";
  for(const command of [`py -3 or_encode_image.py "${input.replace(/"/g,'')}" ${output}`,`python or_encode_image.py "${input.replace(/"/g,'')}" ${output}`,`python3 or_encode_image.py "${input.replace(/"/g,'')}" ${output}`]){
    const r=await localRun(command,20);last=String(r&&r.text||r&&r.error||"");
    if(r&&r.ok&&!/exit code [1-9]/i.test(last)){encoded=true;break;}
  }
  if(!encoded)throw new Error(last||"No Python runner could encode the Blender screenshot");
  let offset=1,chunks=[];
  for(let i=0;i<1000;i++){
    const part=await localRead(output,offset,8);
    if(part.text)chunks.push(part.text.replace(/\s+/g,""));
    if(!part.more||!part.count)break;
    offset=part.next||offset+part.count;
  }
  const data=chunks.join("");
  if(data.length<100||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new Error("Encoded Blender screenshot was empty or malformed");
  return data;
}

async function localRun(command, timeoutSeconds = 12) {
  return sendLocalEngine({
    type: "call_tool", name: "run_command",
    arguments: { command, timeout_seconds: timeoutSeconds },
  }, (timeoutSeconds + 8) * 1000);
}

function probeCommands(win) {
  if (win) {
    return [
      "powershell -NoProfile -Command try{$c=New-Object Net.Sockets.TcpClient;$c.ReceiveTimeout=2500;$c.Connect('127.0.0.1',9876);$c.Close();Write-Output BLENDER_UP}catch{Write-Output BLENDER_DOWN}",
    ];
  }
  return [
    "python3 -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "python -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "(echo >/dev/tcp/127.0.0.1/9876) >/dev/null 2>&1 && echo BLENDER_UP || echo BLENDER_DOWN",
  ];
}

async function probeBlenderTcp() {
  let plat = { os: "win" };
  try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
  const win = plat.os === "win";
  let last = "";
  for (const cmd of probeCommands(win)) {
    const r = await localRun(cmd, 8);
    const text = String((r && (r.text || r.error)) || "");
    last = text;
    if (/BLENDER_UP/.test(text)) return { ok: true };
    if (r && r.ok === false && /not running|not connected|timeout/i.test(text)) {
      return { ok: false, error: "bin/or-core.exe is not running — start it, then Connect Blender again." };
    }
  }
  const down = /BLENDER_DOWN/.test(last);
  const err = down
    ? "Blender addon is not on port 9876. In Blender: press N → MCP for Blender → Start MCP Server."
    : (last && last.slice(0, 220)) || "Could not reach Blender. Run bin/or-core.exe, then Start MCP Server in Blender.";
  return { ok: false, error: err };
}

async function connectBlender() {
  const p = await probeBlenderTcp();
  if (!p.ok) {
    setBlender(false, p.error);
    broadcastStatus();
    return { ok: false, blender: false, error: p.error };
  }
  setBlender(true, "");
  try {
    const ping = await blenderCall("get_scene_info", {}, 20000);
    if (ping && ping.ok === false && /not listening|closed|refused|10061|Connection refused/i.test(String(ping.error || ""))) {
      setBlender(false, ping.error);
      broadcastStatus();
      return { ok: false, blender: false, error: ping.error };
    }
  } catch {}
  broadcastStatus();
  return { ok: true, blender: true };
}

async function agentWorkspaceRoot() {
  if (localRoot) return localRoot;
  const r = await sendLocalEngine({ type: "call_tool", name: "workspace_info", arguments: {} }, 12000);
  const t = String((r && r.text) || "");
  const m = t.match(/Workspace root:\s*(.+)/);
  if (m) { localRoot = m[1].trim(); return localRoot; }
  return "";
}

function pyLiteral(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyLiteral).join(", ") + "]";
  const parts = [];
  for (const [k, val] of Object.entries(v)) parts.push(JSON.stringify(k) + ": " + pyLiteral(val));
  return "{" + parts.join(", ") + "}";
}

const BLENDER_CMD = {
  blender_export_fbx: "export_fbx", export_blender_fbx: "export_fbx",
  blender_import_fbx: "import_fbx", import_blender_fbx: "import_fbx",
  blender_export_obj: "export_obj", blender_import_obj: "import_obj",
  blender_mesh_dump: "dump", blender_send_to_studio: "dump",
  blender_group: "group", blender_ungroup: "ungroup",
  blender_parent: "parent", blender_unparent: "unparent", blender_join: "join",
  blender_move_to_collection: "move_to_collection",
  blender_list_collections: "list_collections", blender_list_objects: "list_objects",
  blender_delete: "delete", blender_duplicate: "duplicate", blender_rename: "rename",
  blender_select: "select", blender_transform: "transform",
  blender_apply_transforms: "apply_transforms", blender_set_origin: "set_origin",
  blender_shade_smooth: "shade_smooth", blender_set_material: "set_material",
  blender_add_modifier: "add_modifier", blender_boolean: "boolean",
  blender_add_cube: "add_cube", blender_add_sphere: "add_sphere",
  blender_add_cylinder: "add_cylinder", blender_add_cone: "add_cone",
  blender_add_plane: "add_plane", blender_add_torus: "add_torus",
  blender_add_monkey: "add_monkey", blender_add_empty: "add_empty",
  blender_add_camera: "add_camera", blender_add_light: "add_light",
  blender_add_ico_sphere: "add_ico_sphere", blender_add_grid: "add_grid",
  blender_add_circle: "add_circle", blender_add_text: "add_text",
  blender_clear_scene: "clear_scene",
  blender_select_all: "select_all", blender_deselect: "deselect",
  blender_invert_selection: "invert_selection", blender_select_children: "select_children",
  blender_get_selection: "get_selection",
  blender_translate: "translate", blender_rotate: "rotate_deg", blender_rotate_deg: "rotate_deg",
  blender_set_dimensions: "set_dimensions",
  blender_origin_to_bottom: "origin_to_bottom", blender_drop_to_ground: "drop_to_ground",
  blender_center: "center", blender_snap_to_grid: "snap_to_grid",
  blender_shade_flat: "shade_flat",
  blender_apply_modifiers: "apply_modifiers", blender_remove_modifier: "remove_modifier",
  blender_triangulate: "triangulate", blender_decimate: "decimate",
  blender_merge: "merge", blender_recalc_normals: "recalc_normals",
  blender_flip_normals: "flip_normals", blender_separate: "separate_loose",
  blender_subdivide: "subdivide", blender_uv_unwrap: "uv_unwrap",
  blender_array: "array", blender_mirror: "mirror",
  blender_hide: "hide", blender_unhide: "unhide", blender_unhide_all: "unhide_all",
  blender_hide_unselected: "hide_unselected",
  blender_undo: "undo", blender_redo: "redo",
  blender_frame_selected: "frame_selected", blender_stats: "stats",
  blender_save: "save_blend", blender_look_at: "look_at",
  blender_convert_to_mesh: "convert_to_mesh",
  blender_align_camera: "align_camera_axis", blender_align_camera_axis: "align_camera_axis",
  blender_view_axis: "view_axis", blender_camera_to_view: "camera_to_view",
  blender_set_camera_lens: "set_camera_lens",
  blender_scale: "scale", blender_bevel: "bevel", blender_solidify: "solidify",
  blender_extrude: "extrude", blender_add_curve: "add_curve", blender_add_armature: "add_armature",
  blender_keyframe: "keyframe_insert", blender_keyframe_insert: "keyframe_insert",
  blender_set_frame: "set_frame", blender_set_active_camera: "set_active_camera",
  blender_track_to: "track_to", blender_cursor_to_selected: "cursor_to_selected",
  blender_randomize: "randomize_transform", blender_randomize_transform: "randomize_transform",
  blender_hide_render: "hide_render", blender_subdivision: "subdivision",
  blender_subsurf: "subdivision", blender_origin_to_geometry: "origin_to_geometry",
  blender_capture_id: "capture_id", capture_id: "capture_id",
  blender_export_gltf: "export_gltf", blender_import_gltf: "import_gltf",
  blender_scene_cleanup: "scene_cleanup", blender_set_world: "set_world",
  blender_set_render: "set_render", blender_render_image: "render_image",
  blender_principled_material: "principled_material", blender_inset: "inset",
  blender_add_bone: "add_bone", blender_normalize_weights: "normalize_weights",
  scene_list:"scene_list",scene_create:"scene_create",scene_delete:"scene_delete",scene_duplicate:"scene_duplicate",scene_set_active:"scene_set_active",
  object_delete:"delete",object_duplicate:"duplicate",object_select:"select",object_deselect:"deselect",object_rename:"rename",object_parent:"parent",object_unparent:"unparent",object_join:"join",object_separate:"separate_loose",object_get_transform:"get_transform",object_set_transform:"transform",object_apply_transform:"apply_transforms",
  mesh_bevel:"bevel",mesh_extrude:"extrude",mesh_inset:"inset",mesh_subdivide:"subdivide",mesh_merge:"merge",mesh_decimate:"decimate",mesh_cleanup:"scene_cleanup",
  modifier_add:"add_modifier",modifier_remove:"remove_modifier",modifier_configure:"modifier_configure",modifier_apply:"apply_modifiers",modifier_list:"modifier_list",
  material_create:"material_create",material_assign:"set_material",material_remove:"material_remove",material_duplicate:"material_duplicate",
  node_create:"node_create",node_delete:"node_delete",node_inspect:"node_inspect",uv_unwrap:"uv_unwrap",uv_pack:"uv_pack",uv_inspect:"uv_inspect",
  animation_list:"animation_list",keyframe_insert:"keyframe_insert",timeline_set:"set_frame",camera_create:"add_camera",camera_set_active:"set_active_camera",light_create:"add_light",world_set:"set_world",
};

async function blenderOpsCode(cmd, args) {
  let py = await extText("tools/blender_ops.py");
  const status = "or_status.json";
  const mesh = "or_mesh.json";
  // Blender's working directory is its install folder (often read-only) and
  // never the or-core workspace that OR reads from, so hand it absolute paths
  // inside the workspace. OR keeps reading the relative names (same files).
  let root = "";
  try { root = await agentWorkspaceRoot(); } catch {}
  root = String(root || "").replace(/[\\/]+$/, "");
  const sep = /\\/.test(root) ? "\\" : "/";
  const abs = (name) => (root ? root + sep + name : name);
  py = py.split("__OR_CMD__").join(String(cmd || ""));
  py = py.split("__OR_ARGS__").join(JSON.stringify(args || {}));
  py = py.split("__OR_OUT__").join(JSON.stringify(abs(status)));
  py = py.split("__OR_MESH__").join(JSON.stringify(abs(mesh)));
  return { py, status, mesh };
}

function wrapBlenderUserCode(code) {
  const src = String(code || "");
  if (!src.trim()) return src;
  if (src.indexOf("_or_items") >= 0 && src.indexOf("_or_src =") >= 0) return src;
  return [
    "import bpy, re as _or_re",
    "_or_src = " + JSON.stringify(src),
    "try:",
    "    _or_items = set(getattr(it, 'identifier', str(it)) for it in bpy.context.scene.render.bl_rna.properties['engine'].enum_items)",
    "except Exception:",
    "    _or_items = set()",
    "if 'BLENDER_EEVEE_NEXT' not in _or_items and 'BLENDER_EEVEE' in _or_items:",
    "    _or_src = _or_src.replace('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE')",
    "elif 'BLENDER_EEVEE' not in _or_items and 'BLENDER_EEVEE_NEXT' in _or_items:",
    "    _or_src = _or_re.sub(r'BLENDER_EEVEE(?!_NEXT)', 'BLENDER_EEVEE_NEXT', _or_src)",
    "if not hasattr(bpy.context.scene, 'eevee_next') and hasattr(bpy.context.scene, 'eevee'):",
    "    _or_src = _or_src.replace('.eevee_next', '.eevee')",
    "exec(compile(_or_src, '<or_blender>', 'exec'))",
  ].join("\n");
}

async function blenderPayload(name, args) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  const a = args || {};
  if (bare === "get_scene_info" || bare === "blender_get_scene_info") return { type: "get_scene_info", params: {} };
  if (bare === "get_object_info" || bare === "blender_get_object_info") return { type: "get_object_info", params: { name: a.name || a.object_name || "" } };
  if (bare === "execute_blender_code" || bare === "execute_code" || bare === "blender_execute_code") return { type: "execute_code", params: { code: wrapBlenderUserCode(a.code || "") } };
  if (bare === "get_viewport_screenshot" || bare === "blender_screenshot") {
    // The installed Blender MCP addon requires an explicit filepath. Keep it in
    // OrScript's sandboxed workspace, then convert it to an attachment after the
    // addon finishes; the machine-local path is never exposed to the AI page.
    let shot="or_blender_shot.png";const root=await agentWorkspaceRoot();
    if(root)shot=root.replace(/[\\/]+$/,"")+"/or_blender_shot.png";
    return {type:"get_viewport_screenshot",params:{max_size:Math.max(256,Math.min(1600,Number(a.max_size)||800)),filepath:shot,format:"png"},_orScreenshotPath:shot};
  }
  const mapped = BLENDER_CMD[bare];
  if (mapped) {
    const packed = await blenderOpsCode(mapped, a);
    return { type: "execute_code", params: { code: packed.py }, _orStatus: packed.status, _orMesh: packed.mesh };
  }
  const params = Object.assign({}, a);
  delete params.user_prompt;
  return { type: bare, params };
}

async function ensureBlenderScripts() {
  if (blenderScriptsReady) return;
  const py = await extText("tools/blender_once.py");
  const ps = await extText("tools/blender_once.ps1");
  await localWrite("blender_once.py", py);
  await localWrite("blender_once.ps1", ps);
  blenderScriptsReady = true;
}

let blenderCallLock = Promise.resolve();
function blenderScreenshotImages(result) {
  let value=result;
  if(typeof value==="string"&&/^\s*[\[{]/.test(value)){try{value=JSON.parse(value);}catch{}}
  const out=[];
  const add=(candidate,mime)=>{
    if(candidate&&typeof candidate==="object")candidate=candidate.data||candidate.base64||candidate.image;
    if(typeof candidate!=="string")return;
    const match=candidate.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
    const data=(match?match[2]:candidate).replace(/\s+/g,"");
    // Reject paths, messages, and tiny malformed payloads; screenshots are PNG/JPEG base64.
    if(data.length<100||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return;
    const normalizedMime=/^image\//i.test(String(mime||""))?String(mime):String(mime||"").toLowerCase()==="jpg"?"image/jpeg":"image/png";
    out.push({mimeType:match?match[1]:normalizedMime,data});
  };
  if(value&&typeof value==="object"){
    for(const image of Array.isArray(value.images)?value.images:[])add(image,image&&image.mimeType);
    add(value.data,value.mimeType||value.format);
    add(value.base64,value.mimeType||value.format);
    add(value.image,value.mimeType||value.format);
    if(value.screenshot&&typeof value.screenshot==="object")add(value.screenshot,value.screenshot.mimeType);
  }
  return out;
}

function blenderInlinePayload(stdoutText) {
  const lines = String(stdoutText || "").split(/\r?\n/).filter((l) => l.startsWith("OR_MESH_JSON:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i].slice(13));
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return null;
}

async function blenderCall(name, args, timeout) {
  if (!blenderAddon) {
    return { ok: false, error: "Blender is not connected. Click Connect Blender (Blender: N → MCP for Blender → Start MCP Server)." };
  }
  const run = async () => {
    await ensureBlenderScripts();
    const payload = await blenderPayload(name, args);
    const statusPath = payload._orStatus || "";
    const meshPath = payload._orMesh || "";
    const wire = { type: payload.type, params: payload.params };
    await localWrite("or_blender_in.json", JSON.stringify(wire));
    let plat = { os: "win" };
    try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
    const win = plat.os === "win";
    const secs = Math.max(20, Math.min(180, Math.round((timeout || 120000) / 1000)));
    const cmds = win ? [
      "powershell -NoProfile -ExecutionPolicy Bypass -File blender_once.ps1 or_blender_in.json or_blender_out.json",
      "py -3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ] : [
      "python3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ];
    let last = "";
    let okRun = false;
    for (const cmd of cmds) {
      const r = await localRun(cmd, secs);
      last = String((r && (r.text || r.error)) || "");
      if (/OR_BLENDER_OK/.test(last)) { okRun = true; break; }
      // Blender refused / socket error — do not try py/python after PowerShell already ran.
      if (/OR_BLENDER_ERR/.test(last)) break;
      // Missing interpreter only: try the next runner. Anything else is a real error.
      if (!/not recognized|cannot find|No such file|not found|is not recognized/i.test(last)) break;
    }
    let raw = "";
    try { raw = await localReadWrapped("or_blender_out.json"); } catch (e) {
      if (!okRun) return { ok: false, error: last.slice(0, 400) || String(e.message || e) };
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      return { ok: false, error: raw ? raw.slice(0, 400) : (last.slice(0, 400) || "empty Blender response") };
    }
    if (data && data.status === "error") {
      const msg = data.message || "Blender addon error";
      if (/not listening|closed|actively refused|10061|Connection refused/i.test(msg)) {
        setBlender(false, "Blender addon dropped. Start MCP Server in Blender, then Connect Blender again.");
      }
      return { ok: false, error: msg };
    }
    let result = (data && Object.prototype.hasOwnProperty.call(data, "result")) ? data.result : data;
    // execute_code answers {executed:true, result:"<captured stdout>"}; our ops
    // script prints its whole payload on one "OR_MESH_JSON:" line there. Read
    // it from the stdout STRING (the old code searched JSON.stringify(result),
    // where the payload's quotes are escaped, so JSON.parse never succeeded).
    const stdoutText = result && typeof result === "object" && typeof result.result === "string" ? result.result
      : typeof result === "string" ? result : "";
    const inline = blenderInlinePayload(stdoutText);
    if (inline) result = inline;
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender FBX failed", skipped: result.skipped };
    }
    if (statusPath && !inline) {
      // Fallback only: the status file lives in the workspace when or-core told
      // us its root; otherwise Blender wrote it next to its own executable.
      try {
        const st = await localReadWrapped(statusPath);
        if (st) {
          try { result = JSON.parse(st); } catch {}
        }
      } catch {}
    }
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender command failed" };
    }
    let meshes = result && result.meshes;
    const mf = (result && result.mesh_file) || meshPath || "or_mesh.json";
    const wantsMeshes = payload.type === "execute_code" && /"dump"|"export_fbx"/.test(String(payload.params && payload.params.code || "").slice(0, 400));
    if ((!meshes || !meshes.length) && mf && (wantsMeshes || (result && result.inline === false))) {
      for (const cand of [meshPath || "or_mesh.json", "or_mesh.json"]) {
        try {
          const rawM = await localReadWrapped(cand);
          if (!rawM) continue;
          const parsed = JSON.parse(rawM);
          meshes = parsed.meshes || (parsed.result && parsed.result.meshes);
          if (meshes && meshes.length) break;
        } catch {}
      }
    }
    if (meshes && meshes.length && result && typeof result === "object") result.meshes = meshes;
    const screenshotImages=payload.type==="get_viewport_screenshot"?blenderScreenshotImages(result):[];
    if(payload.type==="get_viewport_screenshot"&&!screenshotImages.length&&payload._orScreenshotPath){
      try{screenshotImages.push({mimeType:"image/png",data:await localImageBase64(payload._orScreenshotPath)});}
      catch(e){return {ok:false,error:`Blender created the viewport capture, but OrScript could not attach it: ${String(e&&e.message||e)}`};}
    }
    if(payload.type==="get_viewport_screenshot"&&!screenshotImages.length)return {ok:false,error:"Blender returned no viewport image data"};
    let textResult = result;
    if (result && typeof result === "object" && Array.isArray(result.meshes)) {
      textResult = Object.assign({}, result);
      delete textResult.meshes;
      textResult.mesh_summary = result.meshes.map((m) => ({ name: m.name, verts: (m.verts || []).length, tris: m.tris || Math.floor((m.faces || []).length / 3) }));
    }
    let textOut = typeof textResult === "string" ? textResult : JSON.stringify(textResult, null, 2);
    return { ok: true, text: textOut, images: screenshotImages, meshFile: mf, filepath: result && result.filepath, meshes: meshes || undefined, skipped: result && result.skipped };
  };
  const prev = blenderCallLock;
  let release;
  blenderCallLock = new Promise((res) => { release = res; });
  await prev.catch(() => {});
  try { return await run(); }
  finally { release(); }
}

async function robloxCsrf() {
  try {
    const r = await fetch("https://auth.roblox.com/v2/logout", { method: "POST", credentials: "include" });
    return r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
  } catch {
    return "";
  }
}
async function robloxAuthedFetch(url, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  // FormData bodies must set their own multipart boundary - never force JSON on them.
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers = Object.assign({}, method !== "GET" && !isForm ? { "Content-Type": "application/json" } : {}, opts.headers || {});
  const go = async (token) => {
    const h = Object.assign({}, headers);
    if (token) h["X-CSRF-TOKEN"] = token;
    const r = await fetch(url, { method, credentials: "include", headers: h, body: opts.body });
    const text = await r.text();
    const csrf = r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
    return { r, text, csrf };
  };
  let token = await robloxCsrf();
  let res = await go(token);
  if ((res.r.status === 403 || res.r.status === 401) && res.csrf && res.csrf !== token) {
    res = await go(res.csrf);
  }
  let data = null;
  try { data = JSON.parse(res.text); } catch {}
  return { ok: res.r.ok, status: res.r.status, text: res.text, data };
}
async function robloxResolveUniverse(msg) {
  let universeId = Number(msg.universeId || msg.universe_id || msg.gameId || 0) || 0;
  const placeId = Number(msg.placeId || msg.place_id || 0) || 0;
  if (universeId > 0) return { ok: true, universeId, placeId };
  if (placeId > 0) {
    const res = await robloxAuthedFetch("https://apis.roblox.com/universes/v1/places/" + placeId + "/universe", { method: "GET" });
    const id = Number(res.data && (res.data.universeId || res.data.id) || 0) || 0;
    if (id > 0) return { ok: true, universeId: id, placeId };
  }
  const listed = await robloxAuthedFetch("https://develop.roblox.com/v1/user/universes?limit=50&sortOrder=Desc", { method: "GET" });
  const rows = (listed.data && listed.data.data) || [];
  if (placeId > 0) {
    const hit = rows.find((u) => Number(u.rootPlaceId) === placeId || Number(u.id) === placeId);
    if (hit) return { ok: true, universeId: Number(hit.id), placeId, name: hit.name };
  }
  if (rows.length === 1) return { ok: true, universeId: Number(rows[0].id), placeId: Number(rows[0].rootPlaceId) || placeId, name: rows[0].name };
  if (rows.length > 1) {
    const top = rows[0];
    return {
      ok: true,
      universeId: Number(top.id),
      placeId: Number(top.rootPlaceId) || placeId,
      name: top.name,
      candidates: rows.slice(0, 8).map((u) => ({ id: u.id, name: u.name, rootPlaceId: u.rootPlaceId })),
    };
  }
  const who = await robloxAuthedFetch("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
  if (!who.ok) return { ok: false, error: "Could not reach the game. Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry." };
  return { ok: false, error: "Could not reach a universe for this place (GameId/PlaceId empty). Publish the place (File > Publish to Roblox) so it has a Universe ID." };
}
async function creatorAssetInfo(assetId){
  const id=Number(assetId);if(!Number.isInteger(id)||id<1)return {success:false,error:{code:"INVALID_PARAMETER",message:"assetId must be a positive integer"}};
  try{const r=await fetch(`https://economy.roblox.com/v2/assets/${id}/details`,{method:"GET",credentials:"include",redirect:"error"});const raw=await r.text();let data=null;try{data=JSON.parse(raw);}catch{}if(r.status===401||r.status===403)return {success:false,error:{code:"AUTH_REQUIRED",message:"Roblox authentication or asset permission is required"},status:r.status};if(!r.ok)return {success:false,error:{code:r.status===404?"COMMAND_NOT_FOUND":"PERMISSION_DENIED",message:data&&data.message||raw.slice(0,300)||`HTTP ${r.status}`},status:r.status};return {success:true,operation:"getPublishedAsset",assetId:id,status:"verified",asset:data};}catch(e){return {success:false,error:{code:"PUBLISH_FAILED",message:String(e&&e.message||e)}};}
}
// ── Monetization through the user's roblox.com browser session ──
// 1.45.0: Roblox retired the legacy routes on 2026-04-23 (POST game-passes/v1/
// game-passes, …/{id}/details, developer-products/v1 …/developerproducts,
// games.roblox.com/v1/games/{id}/game-passes). The documented Open Cloud
// endpoints accept the same .ROBLOSECURITY cookie (+ X-CSRF-TOKEN), so the
// extension keeps working with zero setup — and or-core offers the identical
// calls with an API key (cloud_* tools) for people who prefer that.
const RBX_APIS = "https://apis.roblox.com";
function robloxErrorText(res) {
  const d = res.data || {};
  return String(d.errorMessage || d.message || d.error || (Array.isArray(d.errors) && d.errors[0] && d.errors[0].message) || (res.text || "").slice(0, 280) || ("HTTP " + res.status)) + (d.field ? " (field " + d.field + ")" : "") + (d.hint ? " — " + d.hint : "");
}
function robloxPrice(p) {
  if (!p || typeof p !== "object") return null;
  if (p.price != null) return p.price;
  const pi = p.priceInformation;
  if (pi && typeof pi === "object") {
    for (const k of ["defaultPriceInRobux", "price", "priceInRobux"]) if (pi[k] != null) return pi[k];
  }
  return p.priceInRobux != null ? p.priceInRobux : null;
}
async function robloxIconBlob(msg, placeholderLabel) {
  if (msg.iconDataUrl && /^data:image\//.test(String(msg.iconDataUrl))) {
    try { return await (await fetch(String(msg.iconDataUrl))).blob(); } catch {}
  }
  return placeholderLabel ? await robloxPlaceholderIcon(placeholderLabel) : null;
}
async function robloxCreateDevProduct(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const name = String(msg.name || "").trim();
  const description = String(msg.description || name).trim();
  const priceInRobux = Math.floor(Number(msg.priceInRobux || msg.price || 0));
  if (!name) return { ok: false, error: "name required" };
  if (!priceInRobux || priceInRobux < 1) return { ok: false, error: "priceInRobux must be >= 1" };
  const form = new FormData();
  form.append("name", name);
  form.append("description", description);
  form.append("price", String(priceInRobux));
  form.append("isForSale", msg.isForSale === false ? "false" : "true");
  const icon = await robloxIconBlob(msg, "");
  if (icon) form.append("imageFile", icon, "icon.png");
  const res = await robloxAuthedFetch(RBX_APIS + "/developer-products/v2/universes/" + universeId + "/developer-products", { method: "POST", body: form });
  if (!res.ok) {
    return { ok: false, error: robloxAuthError(res) + " (universe " + universeId + (resolved.name ? " / " + resolved.name : "") + ")", status: res.status, universeId: universeId, dashboard: "https://create.roblox.com/dashboard/creations/experiences/" + universeId + "/monetization/developer-products" };
  }
  const product = res.data || {};
  return { ok: true, product: product, productId: Number(product.productId || product.id || 0) || 0, universeId: universeId, universeName: resolved.name || "", price: priceInRobux, text: JSON.stringify(product) };
}
async function robloxUpdateDevProduct(msg) {
  const productId = Number(msg.productId || msg.product_id || msg.id || 0) || 0;
  if (!productId) return { ok: false, error: "productId required" };
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const form = new FormData();
  let fields = 0;
  if (msg.name != null && String(msg.name).trim()) { form.append("name", String(msg.name).trim()); fields++; }
  if (msg.description != null) { form.append("description", String(msg.description)); fields++; }
  const price = msg.price != null ? Math.floor(Number(msg.price)) : NaN;
  if (Number.isFinite(price) && price >= 1) { form.append("price", String(price)); fields++; }
  if (msg.isForSale != null) { form.append("isForSale", msg.isForSale ? "true" : "false"); fields++; }
  const icon = await robloxIconBlob(msg, "");
  if (icon) { form.append("imageFile", icon, "icon.png"); fields++; }
  if (!fields) return { ok: false, error: "nothing to update - pass name, description, price, isForSale or iconDataUrl" };
  const res = await robloxAuthedFetch(RBX_APIS + "/developer-products/v2/universes/" + resolved.universeId + "/developer-products/" + productId, { method: "PATCH", body: form });
  if (!res.ok) return { ok: false, error: robloxAuthError(res), status: res.status };
  return { ok: true, productId: productId, universeId: resolved.universeId, updated: fields, details: res.data || {}, text: res.text || ("HTTP " + res.status) };
}
async function robloxListDevProducts(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const res = await robloxAuthedFetch(RBX_APIS + "/developer-products/v2/universes/" + universeId + "/developer-products/creator?pageSize=100", { method: "GET" });
  if (!res.ok) return { ok: false, error: robloxAuthError(res), status: res.status };
  const list = (res.data && Array.isArray(res.data.developerProducts) ? res.data.developerProducts : []).map((p) => ({ id: p.productId, name: p.name, price: robloxPrice(p), forSale: p.isForSale, description: p.description }));
  return { ok: true, universeId: universeId, universeName: resolved.name || "", products: list, text: JSON.stringify(list) };
}

// ── Game passes (same browser session, same Open Cloud routes) ──
function robloxAuthError(res) {
  const err = robloxErrorText(res);
  if (res.status === 401 || res.status === 403) {
    return "Not signed into Roblox in this Chrome profile (or no edit rights on this experience). Open roblox.com, log in with the account that owns the game, then retry. (" + err + ")";
  }
  return String(err);
}
// 512x512 PNG icon so a pass can be created without the user drawing one.
async function robloxPlaceholderIcon(label) {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const c = new OffscreenCanvas(512, 512);
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, 512);
    bg.addColorStop(0, "#1b1a22"); bg.addColorStop(1, "#2a2436");
    g.fillStyle = bg; g.fillRect(0, 0, 512, 512);
    const disc = g.createRadialGradient(256, 236, 20, 256, 256, 190);
    disc.addColorStop(0, "#ffe9a3"); disc.addColorStop(0.6, "#f2b63a"); disc.addColorStop(1, "#b87414");
    g.fillStyle = disc; g.beginPath(); g.arc(256, 256, 186, 0, Math.PI * 2); g.fill();
    g.lineWidth = 14; g.strokeStyle = "#5a3a0a"; g.stroke();
    const text = String(label || "").trim().slice(0, 2).toUpperCase() || "GP";
    g.fillStyle = "#3a2405"; g.font = "bold 190px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 256, 268);
    return await c.convertToBlob({ type: "image/png" });
  } catch {
    return null;
  }
}
async function robloxCreateGamePass(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const name = String(msg.name || "").trim();
  const description = String(msg.description || name).trim();
  const price = Math.floor(Number(msg.price || msg.priceInRobux || 0)) || 0;
  if (!name) return { ok: false, error: "name required" };
  const form = new FormData();
  form.append("name", name);
  form.append("description", description);
  if (price > 0) form.append("price", String(price));
  form.append("isForSale", price > 0 && msg.isForSale !== false ? "true" : "false");
  const icon = await robloxIconBlob(msg, name);
  if (icon) form.append("imageFile", icon, "icon.png");
  const res = await robloxAuthedFetch(RBX_APIS + "/game-passes/v1/universes/" + universeId + "/game-passes", { method: "POST", body: form });
  if (!res.ok) {
    return { ok: false, error: robloxAuthError(res) + " (universe " + universeId + (resolved.name ? " / " + resolved.name : "") + ")", status: res.status, universeId: universeId, dashboard: "https://create.roblox.com/dashboard/creations/experiences/" + universeId + "/monetization/passes" };
  }
  const created = res.data || {};
  const gamePassId = Number(created.gamePassId || created.id || 0) || 0;
  return { ok: true, gamePassId: gamePassId, universeId: universeId, universeName: resolved.name || "", name: name, price: price > 0 ? price : 0, forSale: price > 0 && msg.isForSale !== false, created: created, text: JSON.stringify(created) };
}
async function robloxUpdateGamePass(msg) {
  const gamePassId = Number(msg.gamePassId || msg.gamepass_id || msg.id || 0) || 0;
  if (!gamePassId) return { ok: false, error: "gamePassId required" };
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const form = new FormData();
  let fields = 0;
  if (msg.name != null && String(msg.name).trim()) { form.append("name", String(msg.name).trim()); fields++; }
  if (msg.description != null) { form.append("description", String(msg.description)); fields++; }
  const price = msg.price != null ? Math.floor(Number(msg.price)) : NaN;
  if (Number.isFinite(price) && price >= 0) { form.append("price", String(price)); fields++; }
  const forSale = msg.isForSale != null ? !!msg.isForSale : (Number.isFinite(price) && price > 0 ? true : null);
  if (forSale !== null) { form.append("isForSale", forSale ? "true" : "false"); fields++; }
  const icon = await robloxIconBlob(msg, "");
  if (icon) { form.append("imageFile", icon, "icon.png"); fields++; }
  if (!fields) return { ok: false, error: "nothing to update - pass name, description, price, isForSale or iconDataUrl" };
  const res = await robloxAuthedFetch(RBX_APIS + "/game-passes/v1/universes/" + resolved.universeId + "/game-passes/" + gamePassId, { method: "PATCH", body: form });
  if (!res.ok) return { ok: false, error: robloxAuthError(res), status: res.status };
  return { ok: true, gamePassId: gamePassId, universeId: resolved.universeId, updated: fields, details: res.data || {}, text: res.text || ("HTTP " + res.status) };
}
async function robloxListGamePasses(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const res = await robloxAuthedFetch(RBX_APIS + "/game-passes/v1/universes/" + universeId + "/game-passes/creator?pageSize=100", { method: "GET" });
  if (!res.ok) return { ok: false, error: robloxAuthError(res), status: res.status };
  const list = (res.data && Array.isArray(res.data.gamePasses) ? res.data.gamePasses : []).map((p) => ({ id: p.gamePassId, name: p.name, price: robloxPrice(p), forSale: p.isForSale, description: p.description }));
  return { ok: true, universeId: universeId, universeName: resolved.name || "", passes: list, text: JSON.stringify(list) };
}

// ── Animations (browser session) ──
// The Studio plugin serialises the KeyframeSequence to .rbxmx (animation_export);
// the upload itself needs a roblox.com identity. Two cookie routes, in order:
//   1. apis.roblox.com/assets/user-auth/v1/assets — the Assets API as Studio's
//      own asset manager calls it (same payload as Open Cloud, cookie + CSRF),
//      then the operation is polled for the asset id;
//   2. www.roblox.com/ide/publish/uploadnewanimation — the classic Animation
//      Editor upload (response body = the new asset id).
// or-core's cloud_animation_publish is the API-key variant of route 1.
async function robloxWhoAmI() {
  const who = await robloxAuthedFetch("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
  return who.ok && who.data ? { id: Number(who.data.id || 0) || 0, name: String(who.data.name || "") } : { id: 0, name: "" };
}
async function robloxPublishAnimation(msg) {
  const xml = String(msg.xml || "");
  if (!/^\s*<roblox[\s>]/.test(xml) || !xml.includes('class="KeyframeSequence"')) return { ok: false, error: "xml must be the .rbxmx of a KeyframeSequence (animation_export)" };
  if (xml.length > 4000000) return { ok: false, error: "animation too large to upload (" + xml.length + " bytes)" };
  const name = String(msg.name || "Animation").trim().slice(0, 50) || "Animation";
  const description = String(msg.description || name).trim().slice(0, 1000);
  const isGroup = /group/i.test(String(msg.creatorType || "")) && Number(msg.creatorId) > 0;
  let userId = Number(msg.userId || 0) || 0;
  const me = await robloxWhoAmI();
  if (!me.id) return { ok: false, error: "Not signed into Roblox in this Chrome profile. Open roblox.com, log in with the account that owns the game, then retry." };
  if (!userId) userId = me.id;
  const creator = isGroup ? { groupId: String(msg.creatorId) } : { userId: String(userId) };
  const tried = [];
  // Route 1 — Assets API with the browser session.
  try {
    const form = new FormData();
    form.append("request", JSON.stringify({ assetType: "Animation", displayName: name, description: description, creationContext: { creator: creator } }));
    form.append("fileContent", new Blob([xml], { type: "model/x-rbxm" }), "animation.rbxmx");
    const res = await robloxAuthedFetch(RBX_APIS + "/assets/user-auth/v1/assets", { method: "POST", body: form });
    if (res.ok) {
      const op = res.data || {};
      let assetId = Number(op.response && op.response.assetId || 0) || 0;
      const path = op.path || (op.operationId ? "operations/" + op.operationId : "");
      let last = op;
      for (let i = 0; !assetId && path && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await robloxAuthedFetch(RBX_APIS + "/assets/user-auth/v1/" + path, { method: "GET" });
        if (!poll.ok) continue;
        last = poll.data || {};
        if (last.done) { assetId = Number(last.response && last.response.assetId || 0) || 0; break; }
      }
      if (assetId) return { ok: true, assetId: assetId, animationId: "rbxassetid://" + assetId, name: name, via: "roblox.com session (Assets API)", creator: isGroup ? "group" : "user", moderation: last.response && last.response.moderationResult && last.response.moderationResult.moderationState || null };
      tried.push("assets api: " + (last.error ? JSON.stringify(last.error).slice(0, 200) : "operation did not finish"));
    } else {
      tried.push("assets api: HTTP " + res.status + " " + robloxErrorText(res).slice(0, 160));
    }
  } catch (e) { tried.push("assets api: " + String(e && e.message || e).slice(0, 160)); }
  // Route 2 — the classic animation upload.
  try {
    const q = new URLSearchParams({ assetTypeName: "Animation", name: name, description: description, AllID: "1", ispublic: "False", allowComments: "True", isGamesAsset: "False" });
    if (isGroup) q.set("groupId", String(msg.creatorId));
    const res = await robloxAuthedFetch("https://www.roblox.com/ide/publish/uploadnewanimation?" + q.toString(), { method: "POST", body: xml, headers: { "Content-Type": "application/xml" } });
    const id = Number(String(res.text || "").trim()) || 0;
    if (res.ok && id > 0) return { ok: true, assetId: id, animationId: "rbxassetid://" + id, name: name, via: "roblox.com session (animation upload)", creator: isGroup ? "group" : "user" };
    tried.push("upload: HTTP " + res.status + " " + String(res.text || "").slice(0, 160));
  } catch (e) { tried.push("upload: " + String(e && e.message || e).slice(0, 160)); }
  return { ok: false, error: "could not upload the animation with the browser session — " + tried.join(" | "), tried: tried };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      sendResponse({ ok:false, kind:"invalid-message", error:"background message requires a string type" });
      return;
    }
    switch (msg.type) {
      case "creator_asset_info":
        sendResponse(await creatorAssetInfo(msg.assetId));break;
      case "command_catalog":
        sendResponse({ok:true,commands:BLENDER_TOOLS,environment:"BLENDER",connected:blenderAddon});
        break;
      case "rs-get-engine":
        sendResponse({ engine });
        break;
      case "rs-open-extension-page": {
        // Only pages we ship may be opened this way (the AI switcher on a web
        // page cannot open chrome-extension:// URLs itself).
        const page = String(msg.page || "");
        if (page !== CODECRAFT_PAGE) { sendResponse({ ok: false, error: "unknown extension page" }); break; }
        const url = chrome.runtime.getURL(page);
        try {
          const tabs = await chrome.tabs.query({ url: url + "*" });
          if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch {} }
          else await chrome.tabs.create({ url });
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "rs-set-engine":
        engine = normalizeEngine(msg.engine);
        try { await chrome.storage.local.set({ [ENGINE_KEY]: engine }); } catch {}
        // fully isolate — wipe previous engine's cache so hallucination impossible
        try { ws?.close(); } catch {}
        connected = false;
        mcpAlive = false;
        toolsCache = [];
        serversCache = [];
        studioConnected = null;
        studioApp = null;
        studioProc = null;
        robloxEditorConnected = false;
        failAllPending(`engine switched to ${engine}`);
        reconnectDelay = RECONNECT_MIN;
        connect();
        broadcastStatus();
          // also push to all provider tabs so their bars / prompts flip instantly.
          // tabs.sendMessage returns a Promise in MV3 — orphaned content scripts
          // (tab not refreshed after reload) reject with "Receiving end does not
          // exist"; that's expected and harmless here, so swallow it.
          try {
            const tabs = await providerTabs();
            for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "rs-engine", engine }).catch(() => {});
          } catch {}
        sendResponse({ engine });
        break;
      case "rs-set-full": {
        // FULL PC ACCESS toggle for the AgentScript engine. The agent process
        // is the source of truth; mirror its answer into the status broadcast.
        const want = !!msg.enabled;
        try {
          const r = await fetch("http://127.0.0.1:3000/api/local-full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: want }),
          });
          const j = await r.json().catch(() => ({}));
          localFull = j.local_full === true ? true : j.local_full === false ? false : want;
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        } catch {
          localFull = want; // agent unreachable — optimistic, corrected on next poll
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        }
        broadcastStatus();
        sendResponse({ ok: true, enabled: localFull });
        break;
      }
      case "rs-get-full":
        sendResponse({ enabled: localFull });
        break;
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        if(!connected&&toolsCache.length===0){connect();sendResponse({ok:false,tools:mergeBlenderTools([]),studio:false,roblox_connected:false,servers:blenderServers(serversCache),errorCode:"MCP_SERVER_UNAVAILABLE",error:"MCP unavailable. Normal AI responses remain available."});break;}
        if(!msg.refresh&&toolsCache.length&&Date.now()-toolsCacheAt<MCP_CACHE_TTL_MS){sendResponse({ok:true,tools:mergeBlenderTools(toolsCache),studio:robloxEditorConnected===true,roblox_connected:robloxEditorConnected===true,servers:blenderServers(serversCache),cached:true,cacheAge:Date.now()-toolsCacheAt});break;}
        const discoveryStarted=Date.now();
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // Cached SCHEMAS are still useful while Studio is closed, but they are
        // not proof that an editor is attached. Preserve the strict probe bit in
        // this response so the content script cannot turn `tools.length > 0`
        // into a fake live Studio during bootstrap.
        const r = await send({ type: "list_tools" }, MCP_DISCOVERY_TIMEOUT_MS) || { ok: false, error: "bridge did not answer" };mcpTrace("tool_discovery",{duration:Date.now()-discoveryStarted,status:r.ok?"READY":"ERROR",errorCode:r.ok?null:"MCP_TOOL_DISCOVERY_FAILED"});
        if (r.ok && Array.isArray(r.tools)) toolsCache = r.tools;
        const tools = mergeBlenderTools(toolsCache);
        const isRobloxEngine = engine === "roblox" || engine === "anim";
        const liveStudio = isRobloxEngine
          ? (typeof r.studio === "boolean" ? r.studio : robloxEditorConnected)
          : false;
        if (isRobloxEngine) robloxEditorConnected = liveStudio === true;
        const ok = r.ok || tools.length > 0;
        sendResponse({
          ok, tools,
          studio: liveStudio === true,
          roblox_connected: liveStudio === true,
          servers: blenderServers(serversCache),
          error: r.ok ? undefined : r.error,
        });
        break;
      }
      case "studio_status": {
        // On-demand ground truth for bootstrap/list_commands. The periodic probe
        // can be a tick behind exactly when Studio was just closed or opened. If
        // that same probe is already in flight, wait for it instead of returning
        // the stale pre-probe bit.
        if (studioProbing) {
          const until = Date.now() + 12500;
          while (studioProbing && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } else {
          await refreshStudioStatus();
        }
        const liveStudio = connected && robloxEditorConnected === true;
        sendResponse({
          ok: connected,
          studio: liveStudio,
          roblox_connected: liveStudio,
        });
        break;
      }
      case "mcp.healthCheck": {const t=performance.now();const live=connected&&ws&&ws.readyState===WebSocket.OPEN;const ping=live?await send({type:"ping"},2000):null;const healthy=!!(ping&&ping.ok);if(live&&!healthy)setMcpLifecycle("ERROR",{errorCode:ping?.errorCode||"MCP_TRANSPORT_ERROR"});sendResponse({success:true,connected:live&&healthy,state:mcpLifecycle,transport:"websocket",server:engineLabel(),latency:healthy?Math.round(performance.now()-t):null,capabilities:{tools:toolsCache.length},lastSuccessfulRequest:lastMessageAt||null,lastError:healthy?null:(ping?.errorCode||mcpDiagnostics.slice().reverse().find(x=>x.errorCode)||null),diagnostics:msg.debug?mcpDiagnostics.slice(-25):undefined});break;}
      case "mcp.reconnect":
        manualStudioDisconnect=false;reconnectAttempts=0;clearTimeout(reconnectTimer);try{ws&&ws.close();}catch{}ws=null;connected=false;connect();{const ok=await waitForConnection(MCP_CONNECT_TIMEOUT_MS);sendResponse(ok?{success:true,state:mcpLifecycle,connectionId}:{success:false,state:mcpLifecycle,error:{code:"MCP_CONNECTION_TIMEOUT",message:"MCP transport did not connect within the connection timeout"}});}break;
      case "mcp.refreshTools": {const r=await send({type:"list_tools"},MCP_DISCOVERY_TIMEOUT_MS);if(r?.ok&&Array.isArray(r.tools)){toolsCache=r.tools;toolsCacheAt=Date.now();setMcpLifecycle("READY");}sendResponse(r?.ok?{success:true,state:mcpLifecycle,tools:toolsCache.length}:{success:false,error:{code:"MCP_TOOL_DISCOVERY_FAILED",message:String(r?.error||"Tool discovery failed")}});break;}
      case "mcp.disconnect":
        manualStudioDisconnect=true;clearTimeout(reconnectTimer);try{ws&&ws.close();}catch{}ws=null;connected=false;setMcpLifecycle("CLOSED");sendResponse({success:true,state:"CLOSED"});break;
      case "studio.connect":
        manualStudioDisconnect=false;connect();await waitForConnection(12000);await refreshStudioStatus();sendResponse({success:connected&&robloxEditorConnected===true,state:connected&&robloxEditorConnected===true?"CONNECTED":connected?"CONNECTING":"DISCONNECTED",error:connected&&robloxEditorConnected===true?null:{code:"STUDIO_BRIDGE_OFFLINE",message:"Studio MCP is not reachable"}});break;
      case "studio.disconnect":
        manualStudioDisconnect=true;clearTimeout(reconnectTimer);try{ws&&ws.close();}catch{}ws=null;connected=false;robloxEditorConnected=false;studioConnected=false;failAllPending("Studio bridge disconnected by user");broadcastStatus();sendResponse({success:true,state:"DISCONNECTED"});break;
      case "studio.status":
      case "studio.healthCheck":
        if(!manualStudioDisconnect){connect();await waitForConnection(6000);await refreshStudioStatus();}sendResponse({success:connected&&robloxEditorConnected===true,state:manualStudioDisconnect||!connected?"DISCONNECTED":robloxEditorConnected===true?([...pending.values()].some(p=>p.type==="call_tool")?"BUSY":"CONNECTED"):"ERROR",bridge:connected,studio:robloxEditorConnected===true,protocolVersion:"1.0",error:connected&&robloxEditorConnected===true?null:{code:"STUDIO_BRIDGE_OFFLINE",message:"Studio MCP did not answer the health probe"}});break;
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        if (blenderAddon && isBlenderToolName(msg.name)) {
          sendResponse(await blenderCall(msg.name, msg.arguments, timeout));
          break;
        }
        if (engine === "roblox" || engine === "anim") {
          if (!connected || robloxEditorConnected !== true) await refreshStudioStatus();
          if (!connected || robloxEditorConnected !== true) {
            sendResponse({ok:false,kind:"disconnected",errorCode:"STUDIO_BRIDGE_OFFLINE",error:"Roblox Studio MCP is not reachable. Open Studio, enable its bridge, and retry."});
            break;
          }
        }
        const bareTool=String(msg.name||"").split("/").pop();
        const toolStarted=performance.now();let r = await send({ type:"call_tool",name:msg.name,arguments:msg.arguments,timeout:msg.timeout,requestId:msg.requestId },timeout);
        // A bridge restart can race one read-only command. Retry only safe,
        // idempotent commands once; never replay writes or Luau mutations.
        const bareForRetry=String(msg.name||"").split("/").pop();
        if (r && !r.ok && ["BRIDGE_COMMAND_ERROR","BRIDGE_COMMAND_FAILED","BRIDGE_PROTOCOL_ERROR","MCP_CONNECTION_CLOSED"].includes(r.errorCode) && IDEMPOTENT_STUDIO_TOOLS.has(bareForRetry)) {
          try { if(ws) ws.close(); } catch {} ws=null; connected=false; await waitForConnection(8000);
          const retry=await send({ type:"call_tool",name:msg.name,arguments:msg.arguments,timeout:msg.timeout,requestId:msg.requestId },timeout);
          if (retry) r=retry;
        }
        mcpTrace("tool_invocation",{requestId:r?.requestId||msg.requestId,duration:Math.round(performance.now()-toolStarted),status:r?.ok?"OK":"ERROR",errorCode:r?.mcpErrorCode||r?.errorCode});
        if (r && !r.ok && !r.errorCode) {
          const detail=String(r.error||"");
          r.mcpErrorCode = r.kind === "timeout" ? "MCP_REQUEST_TIMEOUT" : r.kind === "disconnected" ? "MCP_CONNECTION_CLOSED" : "MCP_PROTOCOL_ERROR";
          r.errorCode = r.kind === "timeout" ? "STUDIO_TIMEOUT" :
            r.kind === "disconnected" ? "STUDIO_BRIDGE_OFFLINE" :
            /not found|no instance/i.test(detail)?"SCRIPT_NOT_FOUND":
            /not a script|LuaSourceContainer|Source access|permission|denied/i.test(detail)?"SCRIPT_NOT_READABLE":"BRIDGE_PROTOCOL_ERROR";
        }
        if (bareTool==="script_read" && r && r.ok && String(r.text||"").trim().startsWith("{")) {
          try { const payload=JSON.parse(r.text);if(payload&&payload.success===false||payload&&payload.ok===false){const err=payload.error||{};sendResponse({ok:false,kind:"execution",errorCode:err.code||"BRIDGE_PROTOCOL_ERROR",error:err.message||String(payload.error||"script_read failed"),details:err.details});break;} } catch {}
        }
        if (bareTool==="script_read" && r && r.ok && !String(r.text||"").length) {
          sendResponse({ok:false,kind:"protocol",errorCode:"BRIDGE_PROTOCOL_ERROR",error:"script_read returned no serialized Source payload"});
          break;
        }
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        try { connect(); } catch {}
        await waitForConnection(12000);
        const r = await send({ type: "restart_mcp" }, 30000);
        if (r && r.ok) {
          const tools = await send({ type: "list_tools" }, 10000);
          if (tools && tools.ok && Array.isArray(tools.tools)) toolsCache = tools.tools;
          mcpAlive = true;
        }
        sendResponse(r);
        break;
      }
      case "local_read": {
        try {
          const text = await localReadAll(String(msg.path || ""));
          sendResponse({ ok: true, text });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "blender_connect": {
        sendResponse(await connectBlender());
        break;
      }
      case "blender_status": {
        sendResponse({ ok: blenderAddon, blender: blenderAddon, error: blenderError || undefined });
        break;
      }
      case "blender_disconnect": {
        setBlender(false, "");
        broadcastStatus();
        sendResponse({ ok: true, blender: false });
        break;
      }
      case "add_server": {
        // Native bin/or-core.exe rejects custom MCP. Blender uses blender_connect.
        if (String(msg.server_id || "").toLowerCase() === "blender") {
          sendResponse(await connectBlender());
          break;
        }
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      // ── ZeroScript Rust pipe — CORS bypass via background (content script → background → 127.0.0.1) ──
      case "rs-push":
      case "push_payload": {
        // Content script payload from AI chat (Gemini/ChatGPT/Claude) → local bridge
        // Must go through background to bypass chat site CORS on http://127.0.0.1
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg.payload || msg),
          });
          const j = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, ...j });
        } catch (e) {
          // Fallback to legacy WS if Rust HTTP not reachable
          const r = await send({ type: "call_tool", name: msg.name || "push_payload", arguments: msg.arguments || msg.payload || {} }, 10000);
          sendResponse(r);
        }
        break;
      }
      case "rs-poll": {
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/poll?client_id=${encodeURIComponent(msg.client_id || engine)}`);
          const j = await res.json().catch(() => ({}));
          sendResponse(j);
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "api_request":
      case "web_api": {
        try {
          let url = String(msg.url || "").trim();
          if (!url || !/^https?:\/\//i.test(url)) {
            sendResponse({ ok: false, error: "url must start with http:// or https://" });
            break;
          }
          { const why = privateNetworkReason(url); if (why) { sendResponse({ ok: false, error: "api_request refused: " + why + " (" + url + ")" }); break; } }
          const method = String(msg.method || "GET").toUpperCase();
          const maxChars = Math.max(500, Math.min(100000, Number(msg.max_chars) || 16000));
          let headers = {};
          if (typeof msg.headers === "object" && msg.headers !== null) {
            headers = { ...msg.headers };
          } else if (typeof msg.headers === "string" && msg.headers.trim()) {
            try { headers = JSON.parse(msg.headers); } catch {}
          }
          if (!headers["Content-Type"] && (method === "POST" || method === "PUT" || method === "PATCH")) {
            headers["Content-Type"] = "application/json";
          }
          if (!headers["Accept"]) {
            headers["Accept"] = "application/json, text/plain, */*";
          }
          let body = msg.body;
          if (body !== undefined && body !== null && typeof body === "object") {
            body = JSON.stringify(body);
          } else if (typeof body === "string" && body.trim()) {
            body = body.trim();
          } else {
            body = undefined;
          }

          const options = { method, headers, redirect: "follow" };
          if (body !== undefined && method !== "GET" && method !== "HEAD") {
            options.body = body;
          }

          const res = await fetch(url, options);
          const status = res.status;
          const statusText = res.statusText;
          const resCtype = (res.headers.get("content-type") || "").toLowerCase();
          let rawText = await res.text();
          let parsedData = null;
          let isJson = false;

          if (resCtype.includes("json") || /^\s*[\{\[]/.test(rawText)) {
            try {
              parsedData = JSON.parse(rawText);
              isJson = true;
            } catch {}
          }

          const origLen = rawText.length;
          const truncated = origLen > maxChars;
          const text = truncated ? rawText.slice(0, maxChars) + `\n…[truncated ${origLen - maxChars} chars]` : rawText;

          sendResponse({
            ok: res.ok,
            status,
            statusText,
            url,
            method,
            isJson,
            data: parsedData,
            text,
            truncated
          });
        } catch (e) {
          sendResponse({ ok: false, error: "Web API request failed: " + String(e && e.message || e) });
        }
        break;
      }
      case "web_fetch": {
        try {
          let url = String(msg.url || "").trim();
          const query = String(msg.query || "").trim();
          if (!url) {
            const q = String(msg.q || query).trim();
            if (/^https?:\/\//i.test(q)) url = q;
          }
          let searchNote = "";
          if (!url) {
            const q = query || String(msg.q || "").trim();
            if (!q) { sendResponse({ ok: false, error: "url or query is required" }); break; }
            const hits = await ddgSearch(q, 3);
            if (!hits.length) { sendResponse({ ok: false, error: "no search results for: " + q }); break; }
            url = hits[0].url;
            searchNote = "Searched \"" + q + "\". Top result: " + url + "\n" +
              hits.map((h, i) => (i+1) + ". " + h.title + " — " + h.url).join("\n") + "\n\n";
          }
          if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: "url must start with http:// or https://" }); break; }
          { const why = privateNetworkReason(url); if (why) { sendResponse({ ok: false, error: "web_fetch refused: " + why + " (" + url + ")" }); break; } }
          const maxChars = Math.max(500, Math.min(50000, Number(msg.max_chars) || 12000));
          const fetchHeaders = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml,application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" };
          let res = await fetch(url, { headers: fetchHeaders, redirect: "follow" });
          if (!res.ok) {
            try { res = await fetch(url, { redirect: "follow" }); } catch {}
          }
          if (!res || !res.ok) { sendResponse({ ok: false, error: "fetch failed HTTP " + ((res && res.status) || "?") + " for " + url }); break; }
          let text = await res.text();
          const ctype = (res.headers.get("content-type") || "").toLowerCase();
          const looksHtml = /html|xml/.test(ctype) || /^\s*</.test(text);
          if (looksHtml) text = htmlToText(text);
          const origLen = text.length;
          const truncated = origLen > maxChars;
          if (truncated) text = text.slice(0, maxChars) + `\n\n…[truncated ${origLen - maxChars} chars]`;
          sendResponse({ ok: true, text: searchNote + text, truncated, status: res.status, url, content_type: ctype });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "web_search": {
        try {
          const q = String(msg.query || msg.q || "").trim();
          if (!q) { sendResponse({ ok: false, error: "query is required" }); break; }
          const limit = Math.max(1, Math.min(8, Number(msg.limit) || 5));
          const results = await ddgSearch(q, limit);
          if (!results.length) {
            sendResponse({ ok: false, error: "no results for '" + q + "'. Try web_fetch with a full https URL." });
            break;
          }
          const txt = results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url + (r.snippet ? "\n   " + r.snippet : "")).join("\n\n");
          sendResponse({ ok: true, text: "Search results for \"" + q + "\":\n\n" + txt, results: results, query: q });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "resolve_universe": {
        try { sendResponse(await robloxResolveUniverse(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "create_dev_product": {
        try { sendResponse(await robloxCreateDevProduct(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "list_dev_products": {
        try { sendResponse(await robloxListDevProducts(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "update_dev_product": {
        try { sendResponse(await robloxUpdateDevProduct(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "publish_animation": {
        try { sendResponse(await robloxPublishAnimation(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "create_game_pass": {
        try { sendResponse(await robloxCreateGamePass(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "update_game_pass": {
        try { sendResponse(await robloxUpdateGamePass(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "list_game_passes": {
        try { sendResponse(await robloxListGamePasses(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "screenshot_capture":
      case "capture_tab": {
        try {
          const C = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : (typeof browser !== "undefined" ? browser : null);
          if (!C || !C.tabs || !C.tabs.captureVisibleTab) {
            sendResponse({ ok: false, error: "this browser cannot capture tabs" });
            break;
          }
          const qtabs = (query) => new Promise((resolve) => {
            try {
              const ret = C.tabs.query(query, (tabs) => resolve(tabs || []));
              if (ret && typeof ret.then === "function") ret.then((tabs) => resolve(tabs || [])).catch(() => resolve([]));
            } catch { resolve([]); }
          });
          const snap = (wid, opts) => new Promise((resolve, reject) => {
            let settled = false;
            const done = (url) => {
              if (settled) return;
              const err = C.runtime && C.runtime.lastError && C.runtime.lastError.message;
              if (err) { settled = true; reject(new Error(err)); return; }
              if (!url) { settled = true; reject(new Error("empty capture")); return; }
              settled = true; resolve(url);
            };
            try {
              let ret;
              if (wid != null) ret = C.tabs.captureVisibleTab(wid, opts, done);
              else ret = C.tabs.captureVisibleTab(opts, done);
              if (ret && typeof ret.then === "function") ret.then((url) => done(url)).catch((e) => { if (!settled) { settled = true; reject(e); } });
            } catch (e) { reject(e); }
          });
          const tabId = sender && sender.tab && sender.tab.id;
          let windowId = (sender && sender.tab && sender.tab.windowId);
          if (windowId == null) {
            for (const query of [{ active: true, lastFocusedWindow: true }, { active: true, currentWindow: true }, { highlighted: true, lastFocusedWindow: true }]) {
              const tabs = await qtabs(query);
              if (tabs[0] && tabs[0].windowId != null) { windowId = tabs[0].windowId; break; }
            }
          }
          if (tabId && C.tabs.update) {
            await new Promise((resolve) => {
              try {
                const ret = C.tabs.update(tabId, { active: true }, () => resolve());
                if (ret && typeof ret.then === "function") ret.then(() => resolve()).catch(() => resolve());
              } catch { resolve(); }
            });
          }
          if (windowId != null && C.windows && C.windows.update) {
            await new Promise((resolve) => {
              try {
                const ret = C.windows.update(windowId, { focused: true }, () => resolve());
                if (ret && typeof ret.then === "function") ret.then(() => resolve()).catch(() => resolve());
              } catch { resolve(); }
            });
          }
          await new Promise((r) => setTimeout(r, 500));
          // The first capture after a focus change can come back empty on some
          // Chromium builds; retry with short pauses until we get a real frame.
          let dataUrl = "";
          let lastErr = "";
          const attempts = [
            [windowId, { format: "jpeg", quality: 85 }],
            [windowId, { format: "jpeg", quality: 85 }],
            [windowId, { format: "png" }],
            [undefined, { format: "jpeg", quality: 85 }],
            [undefined, { format: "png" }],
          ];
          for (let ai = 0; ai < attempts.length && !dataUrl; ai++) {
            const pair = attempts[ai];
            try {
              const shot = await snap(pair[0], pair[1]);
              // <150 base64 chars is an empty/blank frame, not a screenshot.
              if (shot && shot.length > 150) dataUrl = shot;
            } catch (e) { lastErr = String(e && e.message || e); }
            if (!dataUrl) await new Promise((r) => setTimeout(r, 260));
          }
          if (!dataUrl) throw new Error(lastErr || "captureVisibleTab returned an empty image");
          const m = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
          if (!m) throw new Error("capture was not a data URL");
          let mime = m[1], data = m[2];
          try {
            if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
              const raw = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
              const bmp = await createImageBitmap(new Blob([raw], { type: m[1] }));
              const maxW = 1600;
              const scale = Math.min(1, maxW / Math.max(1, bmp.width));
              const w = Math.max(1, Math.round(bmp.width * scale));
              const h = Math.max(1, Math.round(bmp.height * scale));
              const canvas = new OffscreenCanvas(w, h);
              canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
              const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
              const buf = new Uint8Array(await out.arrayBuffer());
              let bin = "";
              for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
              mime = "image/jpeg";
              data = btoa(bin);
            }
          } catch {}
          sendResponse({ ok: true, images: [{ mimeType: mime, data: data }] });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      default:
        sendResponse({ ok: false, kind:"unknown-message", error: `unknown message type: ${msg.type}` });
    }
  })().catch((e) => {
    const error=String(e&&e.message||e||"unknown background failure");
    log("message handler failed", msg&&msg.type, error);
    try { sendResponse({ok:false,kind:"background-error",error:`${msg&&msg.type||"unknown"}: ${error}`}); } catch {}
  });
  return true; // async sendResponse
});

// Proc poll — keeps RS availability gated on the live Studio process
refreshProcStatus();
setInterval(refreshProcStatus, 5000);

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
try {
  chrome.alarms.create("or-keep", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === "or-keep") { try { connect(); } catch {} }
  });
} catch {}
chrome.runtime.onInstalled.addListener(connect);

connect();
