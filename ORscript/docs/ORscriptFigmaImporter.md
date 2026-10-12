# OrScript Figma importer Roblox model

`docs/OrScriptFigmaImporter.rbxm` is an XML-backed Roblox model containing the `FigmaImporter` ModuleScript. Insert it into Studio and call `require(path.To.FigmaImporter).import(tree, parent)` with the validated tree returned by ORscript.

The model is the Roblox-side runtime only. The Figma Plugin API bridge remains in `src/integrations/figma-plugin/`; Roblox cannot replace or execute a Figma plugin. In Roblox Studio, use **Save to File** to convert this XML-backed model to a native binary `.rbxm` if your uploader requires the binary extension.
