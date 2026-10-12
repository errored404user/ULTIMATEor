# OrScript Figma Bridge

This development plugin uses Figma's official Plugin API to create and inspect native editable nodes. It does not receive or store Figma credentials and makes no network requests.

## Connect

1. Load the unpacked OrScript browser extension.
2. In the Figma desktop app, open an editable Figma Design file.
3. Use **Plugins > Development > Import plugin from manifest** and select this directory's `manifest.json`. Figma assigns development plugin identity; no published plugin ID is fabricated in this repository.
4. Run **OrScript Figma Bridge** and leave its small bridge window open.
5. In OrScript Settings, check the Figma status. `Connected · native design tools ready` is shown only after a live plugin heartbeat.

Figma authentication and file permissions remain owned by Figma. OrScript cannot create a cloud file through the Plugin API; open or create a file in Figma first. The official remote MCP server is not used because Figma currently restricts it to clients in its MCP catalog, and OrScript is not an approved catalog client.

## Security

The plugin has an empty network allowlist. The extension accepts bridge heartbeats only from Figma plugin-sandbox subframes. No access tokens, cookies, or OAuth credentials cross into AI-provider pages or prompts.

## Runtime behavior

`ForgeGui` can turn a natural-language UI category request into normalized design IR with color, spacing, radius, typography, component, and responsive-layout foundations. OrScript validates that IR before sending it to this plugin. Native plugin writes require approval. `figma.toRobloxUI` defaults to a non-mutating mapping preview; passing `execute: true` requires a second approval and sends generated Luau through the existing verified Studio route.

The plugin supports targeted context reads and updates to avoid moving complete files for small edits. Context responses are depth- and count-bounded, provider reads are briefly cached, and exports are explicit rather than included in normal context.
