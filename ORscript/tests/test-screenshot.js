// Screenshot routing regressions: Studio images must survive MCP and must never
// be silently replaced with a browser-tab capture.
const fs = require("fs");
const path = require("path");

const shotCode = fs.readFileSync(path.join(__dirname, "../src/core/screenshot.js"), "utf8");
const mainCode = fs.readFileSync(path.join(__dirname, "../src/core/main.js"), "utf8");
const agentCode = fs.readFileSync(path.join(__dirname, "../agent/src/main.rs"), "utf8");
let failures = 0;
const ok = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures++;
};

let tabCaptures = 0;
global.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      tabCaptures++;
      callback({ ok: true, images: [{ mimeType: "image/jpeg", data: "TAB_IMAGE" }] });
    },
  },
};
const ORScreenshot = new Function(shotCode + "; return ORScreenshot;")();

(async () => {
  tabCaptures = 0;
  const studio = await ORScreenshot.run({ target: "studio" }, {
    studio: async () => ({ ok: true, images: [{ mimeType: "image/png", data: "STUDIO_IMAGE" }] }),
  });
  ok("explicit Studio capture returns the game viewport", studio.ok && studio.images[0].data === "STUDIO_IMAGE" && /studio ×1/.test(studio.text));
  ok("successful Studio capture never captures the browser", tabCaptures === 0);

  tabCaptures = 0;
  const failedStudio = await ORScreenshot.run({ target: "studio" }, {
    studio: async () => ({ ok: false, error: "screen_capture returned no image" }),
  });
  ok("failed Studio capture reports an error", !failedStudio.ok && /screen_capture returned no image/.test(failedStudio.text));
  ok("failed Studio capture does not masquerade as a browser screenshot", tabCaptures === 0);

  tabCaptures = 0;
  const failedAuto = await ORScreenshot.run({}, {
    studio: async () => ({ ok: true, text: "capture completed", images: [] }),
    blender: async () => ({ ok: true, images: [{ mimeType: "image/png", data: "WRONG_VIEWPORT" }] }),
  });
  ok("default auto does not replace a failed game capture with another viewport", !failedAuto.ok && tabCaptures === 0);

  tabCaptures = 0;
  const explicitTab = await ORScreenshot.run({ target: "tab" }, {});
  ok("explicit tab capture still works", explicitTab.ok && explicitTab.images[0].data === "TAB_IMAGE" && tabCaptures === 1);

  ok("native agent preserves MCP image content", agentCode.includes('"image" =>') && agentCode.includes('"images":output.images') && agentCode.includes('"mimeType": mime'));
  ok("Studio capture uses editor-specific connectivity", mainCode.includes("bridge.roblox_connected === true") && !mainCode.includes("A.bridge && (A.bridge.connected || A.bridge.ok)"));
  ok("virtual target is not forwarded into strict Studio schema", mainCode.includes('if (key === "target" || key === "source") continue;') && mainCode.includes('studioToolByBare("screen_capture")'));
  ok("native screen_capture also receives normalized Studio arguments", mainCode.includes('if (bareName === "screen_capture")') && mainCode.includes("args = await screenCaptureArgs(args, screenTool)"));

  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
