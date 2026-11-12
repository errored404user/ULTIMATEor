// 1.45.0 — Monetization + publishing: game passes, developer products and
// animation uploads on the CURRENT Open Cloud routes (Roblox retired the legacy
// game-pass / developer-product endpoints on 2026-04-23). Three layers are
// checked: the extension's browser-session route (background.js, exercised
// against a fake fetch), total-core's API-key route (agent/src/plugin.rs, static
// pins — CI compiles it), and the Studio plugin's KeyframeSequence → .rbxmx
// serialiser (plugin/TotalScript.lua, pinned; executed by the lupa scan).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const bg = read("background.js");
const main = read("src/core/main.js");
const rs = read("agent/src/plugin.rs");
const lua = read("plugin/TotalScript.lua");
const plus = read("src/core/skills/studio_plus.js");
const config = read("src/core/config.js");
const readme = read("README.md");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  → " + String(extra).slice(0, 400) : "")); }
}

// ── 1. No layer still calls a retired endpoint ──
const retired = [
  "/game-passes/v1/game-passes\"", "game-passes/v1/game-passes/\" + gamePassId + \"/details", "{GAMEPASS_API}/{id}/details",
  "/developerproducts", "games.roblox.com/v1/games/", "/game-passes/{gamePassId}/details",
];
for (const [label, src] of [["background.js", bg], ["plugin.rs", rs], ["main.js", main]]) {
  const hits = retired.filter((r) => src.split("\n").some((line) => line.includes(r) && !/^\s*(\/\/|\*|#|--)/.test(line) && !line.includes("retired") && !line.includes("legacy")));
  ok("S: " + label + " has no live call to a retired game-pass / developer-product endpoint", hits.length === 0, hits.join(", "));
}

// ── 2. total-core (API key) pins ──
ok("S: plugin.rs — Open Cloud routes: create/update/list passes, create/update/list products, assets upload + operation poll", [
  'format!("{APIS}/game-passes/v1/universes/{universe}/game-passes")',
  'format!("{APIS}/game-passes/v1/universes/{universe}/game-passes/{id}")',
  '/game-passes/v1/universes/{universe}/game-passes/creator?pageSize=100',
  'format!("{APIS}/developer-products/v2/universes/{universe}/developer-products")',
  'format!("{APIS}/developer-products/v2/universes/{universe}/developer-products/{id}")',
  '/developer-products/v2/universes/{universe}/developer-products/creator?pageSize=100',
  'format!("{APIS}/assets/v1/assets")', 'format!("{APIS}/assets/v1/{path}")', '"assetType": "Animation"', 'mp_file(&mut body, &b, "fileContent", "animation.rbxmx", "model/x-rbxm", xml.as_bytes())',
  'reqwest::Method::PATCH', 'mp_field(&mut body, &b, "isForSale"', 'mp_file(&mut body, &b, "imageFile"',
].every((s) => rs.includes(s)));
ok("S: plugin.rs — new tools cloud_product_update + cloud_animation_publish are dispatched, listed and gated on the key", [
  '"cloud_product_update" => cloud::product_update(state, &args)', '"cloud_animation_publish" => cloud::animation_publish(state, &args)',
  'tool("cloud_product_update"', 'tool("cloud_animation_publish"',
].every((s) => rs.includes(s)) && /const CLOUD_COMMANDS: &\[&str\] = &\[[^\]]*"cloud_product_update"[^\]]*"cloud_animation_publish"/.test(rs));
ok("S: plugin.rs — animation_export / animation_apply are plugin commands with budgets and tool cards", rs.includes('("animation_export", 60)') && rs.includes('("animation_apply", 30)') && rs.includes('tool("animation_export"') && rs.includes('tool("animation_apply"'));
ok("S: plugin.rs — animation upload validates the rbxmx, picks user vs group creator, polls until done, surfaces moderation", [
  'class=\\"KeyframeSequence\\"', 'json!({ "groupId": creator_id.to_string() })', 'json!({ "userId": creator_id.to_string() })',
  'last.get("done")', '/response/assetId', 'moderationResult/moderationState', 'icon_data_url',
].every((s) => rs.includes(s)));
ok("S: plugin.rs — multipart still built by hand (no reqwest multipart feature) and the key header is x-api-key", rs.includes("multipart/form-data; boundary=") && !/reqwest::multipart/.test(rs) && rs.includes('"x-api-key"'));

// ── 3. Studio plugin pins ──
ok("S: TotalScript.lua — animation_export / animation_apply handlers + capabilities", ["function H.animation_export(a)", "function H.animation_apply(a)", '"animation_export", "animation_apply"', "local function keyframeSequenceXml(ks)", "local function poseXml(pose, out, st)"].every((s) => lua.includes(s)));
ok("S: TotalScript.lua — the rbxmx carries Loop / Priority / AuthoredHipHeight, Keyframe Time, Pose CFrame + easing + Weight, KeyframeMarkers, XML-escaped names", [
  '<Item class="KeyframeSequence" referent="RBX1">', '<bool name="Loop">', '<token name="Priority">', '<float name="AuthoredHipHeight">',
  '<Item class="Keyframe" referent="RBX', '<float name="Time">', 'xmlCFrame("CFrame", pose.CFrame)', '<token name="EasingDirection">', '<token name="EasingStyle">', '<float name="Weight">',
  '<Item class="KeyframeMarker" referent="RBX', '["&"] = "&amp;"', 'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4"',
].every((s) => lua.includes(s)));
ok("S: TotalScript.lua — export refuses empty clips and oversize payloads, reports creator ids; apply writes ReplicatedStorage.Animations.<name> with rbxassetid:// and tags the source", [
  'has no Keyframes - nothing to publish', '#xml > 1500000', 'creator_type = (tostring(game.CreatorType):gsub("^Enum%.CreatorType%.", ""))', 'StudioService:GetUserId()',
  'anim.AnimationId = "rbxassetid://" .. tostring(id)', 'ks:SetAttribute("PublishedAssetId", id)', 'parent.Name = "Animations" parent.Parent = ReplicatedStorage',
].every((s) => lua.includes(s)));
ok("S: TotalScript.lua — key label mentions animations and the needed scopes", lua.includes("asset:write") && lua.includes("publish animations"));

// ── 4. extension orchestration pins ──
ok("S: main.js — animation_publish is virtual, approval-gated, intercepted before the Luau animation_* block, with export → session → Open Cloud → Studio dialog → apply", [
  'if (bareName === "animation_publish") return await publishAnimation(args);', 'async function publishAnimation(args)', 'bridgeTool("animation_export"', 'type: "publish_animation"',
  'bridgeTool("cloud_animation_publish"', 'bridgeTool("studio_publish_selection", { paths: [exp.path] }', 'bridgeTool("animation_apply"', 'publish_animation: "animation_publish"',
].every((s) => main.includes(s)) && /PUBLISH_OPS=new Set\(\[[^\]]*"animation_publish"/.test(main) && /CORE_VIRTUAL_TOOLS = new Set\(\[[\s\S]*?"animation_publish"[\s\S]*?\]\)/.test(main) && main.indexOf('if (bareName === "animation_publish")') < main.indexOf('if (name.startsWith("animation_")) {'));
ok("S: main.js — developer_product_update exists (session first, total-core second) and create/list fall back to cloud_product_*", [
  'async function updateDeveloperProduct(args)', 'type: "update_dev_product"', 'bridgeTool("cloud_product_update"', 'pluginToolAvailable("cloud_product_create")', 'pluginToolAvailable("cloud_product_list")',
  'update_developer_product: "developer_product_update"', 'if (bareName === "developer_product_update" || bareName === "devproduct_update")',
].every((s) => main.includes(s)) && /PUBLISH_OPS=new Set\(\[[^\]]*"developer_product_update"/.test(main));
ok("S: main.js — gamepass_update now carries the universe (PATCH needs it) and icons", main.includes('const payload = { gamePassId: gamePassId, universeId: universeU, placeId:') && main.includes('universe_id: universeU || undefined'));
ok("S: main.js — creator.publishAnimation runs the real flow (no more instructions-only)", main.includes('if(toolName==="creator.publishAnimation")return await publishAnimation('));
ok("S: catalogue + mandates teach animation_publish / developer_product_update", plus.includes('{ name: "animation_publish"') && plus.includes('{ name: "developer_product_update"') && config.includes("\\`animation_publish\\` {animation | path, name?}") && config.includes("\\`developer_product_update\\` {product_id"));
ok("S: README changelog covers 1.45.0 monetization + publishing", /\*\*1\.45\.0 — /.test(readme) && readme.includes("animation_publish") && readme.includes("developer-products/v2"));

// ── 5. background.js behaviour against a fake Roblox ──
const start = bg.indexOf("async function robloxCsrf() {");
const end = bg.indexOf("chrome.runtime.onMessage.addListener(");
ok("S: background.js monetization block found", start > 0 && end > start);
const block = bg.slice(start, end);
const calls = [];
let csrfIssued = 0;
class FakeHeaders { constructor(o) { this.m = {}; for (const k in (o || {})) this.m[k.toLowerCase()] = o[k]; } get(k) { return this.m[String(k).toLowerCase()] || null; } }
class FakeFormData { constructor() { this.entries = []; } append(k, v, fn) { this.entries.push([k, v, fn]); } get(k) { const e = this.entries.find((x) => x[0] === k); return e ? e[1] : null; } has(k) { return this.entries.some((x) => x[0] === k); } }
class FakeBlob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type || ""; this.size = parts.reduce((n, p) => n + String(p).length, 0); } }
const routes = {};
function respond(status, body, headers) { return { ok: status >= 200 && status < 300, status, headers: new FakeHeaders(headers || {}), text: async () => typeof body === "string" ? body : JSON.stringify(body) }; }
async function fakeFetch(url, opts) {
  opts = opts || {};
  const rec = { url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body, credentials: opts.credentials };
  calls.push(rec);
  if (url === "https://auth.roblox.com/v2/logout") { csrfIssued++; return respond(403, "", { "x-csrf-token": "tok-" + csrfIssued }); }
  if (url.startsWith("data:image/")) return { blob: async () => new FakeBlob(["png"], { type: "image/png" }) };
  // every mutating call must carry the CSRF token
  if (rec.method !== "GET" && !rec.headers["X-CSRF-TOKEN"]) return respond(403, { errors: [{ message: "Token Validation Failed" }] }, { "x-csrf-token": "tok-fresh" });
  for (const key of Object.keys(routes)) {
    const [m, prefix] = key.split(" ");
    if (rec.method === m && url.startsWith(prefix)) return routes[key](rec, url);
  }
  return respond(404, { errorMessage: "no route " + rec.method + " " + url });
}
const ctx = { fetch: fakeFetch, FormData: FakeFormData, Blob: FakeBlob, URLSearchParams, setTimeout: (f) => f(), console, JSON, Number, String, Math, Array, Object, Promise, Error, RegExp, encodeURIComponent };
vm.createContext(ctx);
vm.runInContext(block + "\nthis.api = { robloxCreateGamePass, robloxUpdateGamePass, robloxListGamePasses, robloxCreateDevProduct, robloxUpdateDevProduct, robloxListDevProducts, robloxPublishAnimation, robloxAuthedFetch };", ctx, { filename: "background-monetize.js" });
const api = ctx.api;
const UNIVERSE = 4242;
routes["GET https://apis.roblox.com/universes/v1/places/777/universe"] = () => respond(200, { universeId: UNIVERSE });
routes["GET https://users.roblox.com/v1/users/authenticated"] = () => respond(200, { id: 1337, name: "Builder" });
routes["POST https://apis.roblox.com/game-passes/v1/universes/4242/game-passes"] = (rec) => {
  const f = rec.body;
  if (!(f instanceof FakeFormData)) return respond(415, { errorMessage: "multipart expected" });
  if (!f.get("name")) return respond(400, { errorMessage: "name required", field: "name" });
  return respond(200, { gamePassId: 9001, name: f.get("name"), description: f.get("description"), isForSale: f.get("isForSale") === "true", iconAssetId: 1, priceInformation: { defaultPriceInRobux: Number(f.get("price") || 0) } });
};
routes["PATCH https://apis.roblox.com/game-passes/v1/universes/4242/game-passes/9001"] = (rec) => rec.body instanceof FakeFormData && rec.body.entries.length ? respond(204, "") : respond(400, { errorMessage: "empty" });
routes["GET https://apis.roblox.com/game-passes/v1/universes/4242/game-passes/creator"] = () => respond(200, { gamePasses: [{ gamePassId: 9001, name: "VIP", isForSale: true, priceInformation: { defaultPriceInRobux: 99 } }, { gamePassId: 9002, name: "Draft", isForSale: false, priceInformation: {} }], nextPageToken: "" });
routes["POST https://apis.roblox.com/developer-products/v2/universes/4242/developer-products"] = (rec) => rec.body instanceof FakeFormData && rec.body.get("price") ? respond(200, { productId: 5001, name: rec.body.get("name"), isForSale: rec.body.get("isForSale") === "true", universeId: UNIVERSE }) : respond(400, { errorMessage: "price required", field: "price" });
routes["PATCH https://apis.roblox.com/developer-products/v2/universes/4242/developer-products/5001"] = (rec) => respond(204, "");
routes["GET https://apis.roblox.com/developer-products/v2/universes/4242/developer-products/creator"] = () => respond(200, { developerProducts: [{ productId: 5001, name: "100 Coins", isForSale: true, priceInformation: { defaultPriceInRobux: 25 } }] });
let opPolls = 0;
routes["POST https://apis.roblox.com/assets/user-auth/v1/assets"] = (rec) => {
  const f = rec.body;
  const req = JSON.parse(f.get("request"));
  if (req.assetType !== "Animation") return respond(400, { message: "bad type" });
  const file = f.get("fileContent");
  if (!(file instanceof FakeBlob) || file.type !== "model/x-rbxm" || !String(file.parts[0]).includes("KeyframeSequence")) return respond(400, { message: "bad file" });
  return respond(200, { path: "operations/op-1", operationId: "op-1", done: false });
};
routes["GET https://apis.roblox.com/assets/user-auth/v1/operations/op-1"] = () => { opPolls++; return opPolls < 2 ? respond(200, { done: false }) : respond(200, { done: true, response: { assetId: "123456789", moderationResult: { moderationState: "Approved" } } }); };
const XML = '<roblox xmlns:xmime="x" version="4"><Item class="KeyframeSequence" referent="RBX1"><Properties><string name="Name">Walk</string></Properties></Item></roblox>';

(async () => {
  // CSRF dance
  const r0 = await api.robloxAuthedFetch("https://apis.roblox.com/game-passes/v1/universes/4242/game-passes/creator", { method: "GET" });
  ok("walk: robloxAuthedFetch fetches a CSRF token from auth.roblox.com/v2/logout and sends cookies", r0.ok && calls[0].url === "https://auth.roblox.com/v2/logout" && calls.every((c) => c.credentials === "include"));

  // game pass create: price at creation, icon, universe resolved from the place
  calls.length = 0;
  const gp = await api.robloxCreateGamePass({ placeId: 777, name: "VIP", description: "Gold name", price: 99, iconDataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  const gpCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/universes/4242/game-passes"));
  ok("walk: gamepass create → POST /game-passes/v1/universes/{u}/game-passes multipart with name/description/price/isForSale(+icon), universe resolved from placeId", gp.ok && gp.gamePassId === 9001 && gp.universeId === UNIVERSE && gp.price === 99 && gp.forSale === true && gpCall && gpCall.body.get("price") === "99" && gpCall.body.get("isForSale") === "true" && gpCall.body.has("imageFile") && gpCall.headers["X-CSRF-TOKEN"], JSON.stringify(gp).slice(0, 300));
  const gp0 = await api.robloxCreateGamePass({ universeId: UNIVERSE, name: "Draft" });
  const gp0Call = calls.filter((c) => c.method === "POST" && c.url.endsWith("/universes/4242/game-passes")).pop();
  ok("walk: gamepass create with no price → isForSale=false and no price field", gp0.ok && gp0.forSale === false && gp0Call.body.get("isForSale") === "false" && !gp0Call.body.has("price"));
  ok("walk: gamepass create refuses an empty name before any request", (await api.robloxCreateGamePass({ universeId: UNIVERSE, name: "  " })).error === "name required");

  // update: PATCH with universe
  calls.length = 0;
  const up = await api.robloxUpdateGamePass({ gamePassId: 9001, universeId: UNIVERSE, price: 149 });
  const upCall = calls.find((c) => c.method === "PATCH");
  ok("walk: gamepass update → PATCH /game-passes/v1/universes/{u}/game-passes/{id}; a price alone also sets isForSale=true; 204 is success", up.ok && up.updated === 2 && upCall && upCall.url.endsWith("/game-passes/9001") && upCall.body.get("price") === "149" && upCall.body.get("isForSale") === "true", JSON.stringify(up).slice(0, 300));
  ok("walk: gamepass update with nothing to change is refused locally", /nothing to update/.test((await api.robloxUpdateGamePass({ gamePassId: 9001, universeId: UNIVERSE })).error || ""));

  // list: creator endpoint, price from priceInformation
  const ls = await api.robloxListGamePasses({ universeId: UNIVERSE });
  ok("walk: gamepass list → /game-passes/creator, price read from priceInformation.defaultPriceInRobux, off-sale passes keep price null", ls.ok && ls.passes.length === 2 && ls.passes[0].id === 9001 && ls.passes[0].price === 99 && ls.passes[0].forSale === true && ls.passes[1].price === null && ls.passes[1].forSale === false, JSON.stringify(ls.passes));

  // developer products
  calls.length = 0;
  const dp = await api.robloxCreateDevProduct({ universeId: UNIVERSE, name: "100 Coins", priceInRobux: 25 });
  const dpCall = calls.find((c) => c.method === "POST" && c.url.includes("/developer-products/v2/universes/4242/developer-products"));
  ok("walk: developer product create → POST /developer-products/v2/universes/{u}/developer-products multipart (name, description, price, isForSale=true)", dp.ok && dp.productId === 5001 && dp.price === 25 && dpCall && dpCall.body.get("price") === "25" && dpCall.body.get("isForSale") === "true" && dpCall.body.get("description") === "100 Coins", JSON.stringify(dp).slice(0, 300));
  ok("walk: developer product create needs a price >= 1", /priceInRobux must be >= 1/.test((await api.robloxCreateDevProduct({ universeId: UNIVERSE, name: "Free" })).error || ""));
  const dpu = await api.robloxUpdateDevProduct({ productId: 5001, universeId: UNIVERSE, price: 30, isForSale: false });
  const dpuCall = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/developer-products/5001"));
  ok("walk: developer product update → PATCH …/developer-products/{id} with price + isForSale", dpu.ok && dpu.updated === 2 && dpuCall && dpuCall.body.get("isForSale") === "false");
  const dpl = await api.robloxListDevProducts({ universeId: UNIVERSE });
  ok("walk: developer product list → /developer-products/creator with prices", dpl.ok && dpl.products.length === 1 && dpl.products[0].id === 5001 && dpl.products[0].price === 25);

  // errors: 403 twice (bad rights) is explained, not retried forever
  routes["POST https://apis.roblox.com/game-passes/v1/universes/1/game-passes"] = () => respond(403, { errorMessage: "You do not have permission to manage this universe" });
  calls.length = 0;
  const denied = await api.robloxCreateGamePass({ universeId: 1, name: "Nope" });
  ok("walk: a 403 from Roblox becomes a sign-in / rights message with the dashboard fallback, after at most one CSRF retry", !denied.ok && /Not signed into Roblox|edit rights/.test(denied.error) && denied.error.includes("permission to manage") && denied.dashboard.includes("/experiences/1/monetization/passes") && calls.filter((c) => c.method === "POST" && c.url.includes("/universes/1/")).length <= 2, denied.error);

  // animation publish: route 1 (Assets API with the session) + operation poll
  calls.length = 0;
  const an = await api.robloxPublishAnimation({ xml: XML, name: "Walk", description: "Walk cycle", creatorType: "User" });
  const anCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/assets/user-auth/v1/assets"));
  ok("walk: animation publish → Assets API multipart {request: Animation + creator userId, fileContent: .rbxmx} then polls the operation until done", an.ok && an.assetId === 123456789 && an.animationId === "rbxassetid://123456789" && an.moderation === "Approved" && anCall && JSON.parse(anCall.body.get("request")).creationContext.creator.userId === "1337" && opPolls >= 2, JSON.stringify(an).slice(0, 300));
  const anG = await api.robloxPublishAnimation({ xml: XML, name: "GroupWalk", creatorType: "Group", creatorId: 555 });
  const anGCall = calls.filter((c) => c.method === "POST" && c.url.endsWith("/assets/user-auth/v1/assets")).pop();
  ok("walk: group-owned places publish under the group (creationContext.creator.groupId)", anG.ok && JSON.parse(anGCall.body.get("request")).creationContext.creator.groupId === "555");
  ok("walk: animation publish refuses non-KeyframeSequence payloads before any upload", /rbxmx of a KeyframeSequence/.test((await api.robloxPublishAnimation({ xml: "<roblox><Item class=\"Model\"/></roblox>" })).error));
  // route 2 fallback when the Assets API route is unavailable
  routes["POST https://apis.roblox.com/assets/user-auth/v1/assets"] = () => respond(404, { message: "nope" });
  routes["POST https://www.roblox.com/ide/publish/uploadnewanimation"] = (rec, url) => { const u = new URL(url); return u.searchParams.get("assetTypeName") === "Animation" && u.searchParams.get("name") === "Walk" && rec.headers["Content-Type"] === "application/xml" && String(rec.body).includes("KeyframeSequence") ? respond(200, "987654321") : respond(400, "bad"); };
  calls.length = 0;
  const an2 = await api.robloxPublishAnimation({ xml: XML, name: "Walk" });
  ok("walk: when the Assets API route fails, the classic uploadnewanimation route is used (query params, XML body, numeric id reply)", an2.ok && an2.assetId === 987654321 && /animation upload/.test(an2.via), JSON.stringify(an2).slice(0, 300));
  routes["POST https://www.roblox.com/ide/publish/uploadnewanimation"] = () => respond(500, "down");
  const an3 = await api.robloxPublishAnimation({ xml: XML, name: "Walk" });
  ok("walk: both routes failing → one error listing what was tried (no silent success)", !an3.ok && an3.tried.length === 2 && /assets api/.test(an3.error) && /upload/.test(an3.error));
  routes["GET https://users.roblox.com/v1/users/authenticated"] = () => respond(401, { errors: [{ message: "Authorization has been denied" }] });
  const an4 = await api.robloxPublishAnimation({ xml: XML, name: "Walk" });
  ok("walk: not signed in → clear sign-in error before uploading anything", !an4.ok && /Not signed into Roblox/.test(an4.error));

  console.log(`test-monetize: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error", e); process.exit(1); });
