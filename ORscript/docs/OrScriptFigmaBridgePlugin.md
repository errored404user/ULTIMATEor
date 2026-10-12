# OrScript Figma Roblox companion plugin

This `.rbxm` is a Roblox Studio companion plugin. Insert it into Studio and save it as a local plugin. Its toolbar button checks the local OrScript agent at `http://127.0.0.1:3000/api/status`, and its `FigmaImporter` module applies validated Figma-to-Roblox UI trees.

The official Figma Plugin API bridge remains required for Figma operations. A Roblox `.rbxm` cannot contain or execute the Figma HTML/JavaScript plugin because Roblox and Figma are separate runtimes.
