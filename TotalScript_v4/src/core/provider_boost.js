// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/provider_boost.js — TotalScript 4.0 Provider Boost & Quality Engine.
// Pure deterministic JS (zero DOM / chrome / fetch). Upgrades ALL 12 AI chat &
// API providers with tailored execution coaching, universal lazy-reply rescue
// (tutorials / unexecuted promises / unrequested plans / simulated tool output),
// domain-specific AAA craft riders, and live per-provider reliability scoring.
// eslint-disable-next-line no-unused-vars
const TotalProviderBoost = (() => {
  "use strict";

  const VERSION = "4.0.0";
  const LEVELS = Object.freeze(["standard", "pro", "ultra"]);

  function normalizeLevel(v) {
    const s = String(v || "").trim().toLowerCase();
    if (s === "std" || s === "standard" || s === "off" || s === "low") return "standard";
    if (s === "ultra" || s === "max" || s === "op" || s === "high") return "ultra";
    return "pro";
  }

  function nextLevel(v) {
    const cur = normalizeLevel(v);
    return LEVELS[(LEVELS.indexOf(cur) + 1) % LEVELS.length];
  }

  // Provider-specific profiles addressing real-world failure modes on each site.
  // Never states "must be JSON" / "JSON only" (plain-text lanes & parity rules).
  const PROFILES = Object.freeze({
    chatgpt: {
      id: "chatgpt",
      name: "ChatGPT",
      tier: "Frontier",
      strengths: "Strong architecture, broad Luau/UI/3D knowledge, vision support",
      weaknesses: "Often writes DIY tutorials, asks permission to proceed, or abbreviates long code with '// rest of code'",
      rules:
        "Act immediately on turn 1 with a real command — never write a DIY tutorial, never ask 'Would you like me to proceed?', and never abbreviate code with TODO/placeholder comments. Batch up to 4 independent commands per reply and read back before claiming done.",
      tightRules:
        "Act on turn 1 with real commands — no tutorials, no permission stalls, no placeholder/TODO stubs. Batch independent calls and verify.",
      ultraRules:
        "Engineer production-grade architecture on the first pass: modular code, layered visuals, full edge-case handling, and live verification proof.",
    },
    claude: {
      id: "claude",
      name: "Claude",
      tier: "Frontier",
      strengths: "Deep reasoning, clean modular Luau, strong UI & visual craft",
      weaknesses: "Occasionally emits Anthropic {\"tool\":...,\"input\":...} or verbose preambles/plans before acting",
      rules:
        "Zero preamble — emit your TotalScript command block on turn 1 using {\"command\":\"...\",\"params\":{...}} or ###LUA###...###END_LUA###. Skip unrequested essays and permission checks; deliver complete runnable systems and verify real output.",
      tightRules:
        "Zero preamble: emit {\"command\",\"params\"} or ###LUA### on turn 1. Complete runnable code only; verify real state.",
      ultraRules:
        "Apply senior-studio craft: cohesive design tokens, zero magic-number hacks, strict server authority, and verified read-back/visual proof.",
    },
    gemini: {
      id: "gemini",
      name: "Gemini",
      tier: "Frontier",
      strengths: "Huge context window, fast multimodal vision, strong 3D & scripting",
      weaknesses: "Often outputs plain ```lua code blocks instead of ###LUA###, gives multi-step guides, or stops after step 1",
      rules:
        "Run Luau inside ###LUA###...###END_LUA### (plain ```lua fences are NOT executed) and other tools as {\"command\":\"...\",\"params\":{...}}. Never answer a build request with a manual guide; inspect first if unsure, batch up to 4 independent calls, and finish every requested part.",
      tightRules:
        "Use ###LUA###...###END_LUA### for Luau (plain ```lua never runs) and {\"command\",\"params\"} for tools. Act directly, never write guides.",
      ultraRules:
        "Deliver rich multi-layered builds with deliberate materials, lighting contrast, responsive UI polish, and end-to-end verification.",
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      tier: "Reasoning",
      strengths: "Strong algorithmic Luau, math, geometry, and root-cause debugging",
      weaknesses: "Can leak native DSML XML tags or over-explain reasoning in the visible reply before acting",
      rules:
        "Emit clean {\"command\":\"...\",\"params\":{...}} or ###LUA###...###END_LUA### in the visible reply (never DSML XML). Keep visible narration to 1 short line and put all effort into complete, bug-free commands and real verification.",
      tightRules:
        "Use {\"command\",\"params\"} or ###LUA### (never DSML XML). One short line of prose; complete verified commands.",
      ultraRules:
        "Eliminate root causes completely, avoid brittle workarounds, and validate every created script/model with live Studio checks.",
    },
    qwen: {
      id: "qwen",
      name: "Qwen",
      tier: "Fast / Reasoning",
      strengths: "Fast iteration, solid coding & math, multilingual",
      weaknesses: "Long JSON payloads can truncate or break escaping; sometimes emits XML tool tags or stops mid-task",
      rules:
        "Use ###LUA###...###END_LUA### for Luau so quotes never break JSON; keep JSON command payloads concise and split very large edits into clean sequential steps. Never output fake tool logs — run real commands until every deliverable is built and verified.",
      tightRules:
        "Prefer ###LUA### for Luau; keep JSON commands clean and concise; never truncate or stop halfway — verify every deliverable.",
      ultraRules:
        "Prioritize crisp structure, full non-stub implementations, clean visual detailing, and verified completion across every step.",
    },
    glm: {
      id: "glm",
      name: "GLM",
      tier: "Fast / Multimodal",
      strengths: "Good vision & code generation, responsive turns",
      weaknesses: "Sometimes nests ###LUA### inside JSON, emits bare grey blockout primitives, or finishes after partial work",
      rules:
        "Emit bare ###LUA###...###END_LUA### directly (do not nest ###LUA### inside JSON). Build finished, multi-part polished work with real colors, materials, UI polish, and clean wiring — never leave bare placeholder grey blocks or unfinished scripts.",
      tightRules:
        "Use bare ###LUA### (never nested in JSON). Deliver complete polished visuals & code — no grey placeholders, always verify.",
      ultraRules:
        "Push visual and engineering depth: layered trim/bevels, cohesive palettes, juicy feedback, and confirmed read-back proof.",
    },
    kimi: {
      id: "kimi",
      name: "Kimi",
      tier: "Long Context",
      strengths: "Large context retention, clean structured explanations & scripting",
      weaknesses: "Unescaped quotes inside JSON code strings, verbose preambles without executing",
      rules:
        "Prefer ###LUA###...###END_LUA### for Luau to avoid JSON quote-escaping failures, and escape all inner quotes carefully in JSON tool calls. Act immediately instead of describing what you would do; finish and verify all parts.",
      tightRules:
        "Use ###LUA### for Luau (avoids quote errors); escape JSON strings cleanly; act immediately and verify.",
      ultraRules:
        "Use full context awareness to keep naming, remotes, lighting, and UI styling 100% consistent across the whole place.",
    },
    arena: {
      id: "arena",
      name: "Arena",
      tier: "Multi-Model",
      strengths: "Access to top frontier models in Direct Chat with vision support",
      weaknesses: "Underlying model may act like a generic chatbot and ignore the live TotalScript tool bridge",
      rules:
        "The TotalScript extension bridge IS live on this page and executes your commands for real in Studio/Blender. Never refuse or give manual steps — emit {\"command\":\"...\",\"params\":{...}} or ###LUA###...###END_LUA### immediately and build complete, verified results.",
      tightRules:
        "TotalScript bridge is LIVE here — never refuse or give tutorials. Emit {\"command\",\"params\"} or ###LUA### immediately.",
      ultraRules:
        "Treat this as an autonomous senior engineering session: inspect, build with AAA polish, verify live, and report concrete proof.",
    },
    aistudio: {
      id: "aistudio",
      name: "Google AI Studio",
      tier: "API Playground",
      strengths: "Full Gemini Pro/Flash context, crisp code generation, controllable behavior",
      weaknesses: "Defaults to markdown tutorial/code-explanation style instead of runnable command blocks",
      rules:
        "Execute directly via ###LUA###...###END_LUA### or {\"command\":\"...\",\"params\":{...}} — plain markdown code blocks are NOT executed. Never dump DIY instructions; batch independent calls cleanly and verify every created asset.",
      tightRules:
        "Use ###LUA### or {\"command\",\"params\"} directly — plain code fences never execute. Act on turn 1 and verify.",
      ultraRules:
        "Exploit long context for end-to-end consistency: complete scripts, rich 3D/UI detailing, zero stubs, and full verification.",
    },
    vani: {
      id: "vani",
      name: "Vani Chat",
      tier: "Plain-Text",
      strengths: "Fast plain-text command execution with ###CMD### and ###LUA###",
      weaknesses: "Prone to prose-only replies, unexecuted ```lua fences, or trying its own built-in tools",
      rules:
        "Act immediately with ###CMD <name>###...###END_CMD### or ###LUA###...###END_LUA###. Never describe steps without running them, never use Vani's own tools for Studio work, and finish every requested feature with real verification.",
      tightRules:
        "Act immediately with ###CMD### or ###LUA### — no prose-only plans, no Vani-native tools, complete & verify.",
      ultraRules:
        "Keep every ###LUA### / ###CMD### block dense, self-contained, polished, and verified in minimal turns.",
    },
    huggingchat: {
      id: "huggingchat",
      name: "HuggingChat / OpenRouter",
      tier: "Open / Multi-Model",
      strengths: "Choice of open-weight & frontier models (DeepSeek, Qwen, Llama, Mistral, etc.)",
      weaknesses: "Open models often emit tutorials, ReAct thought loops, or half-finished placeholder scripts",
      rules:
        "Start acting on turn 1 with a real {\"command\":\"...\",\"params\":{...}} or ###LUA###...###END_LUA### block — never write a how-to guide or fake 'Output of ...' text. Deliver full, complete code with zero placeholders and verify your work.",
      tightRules:
        "Act on turn 1 with {\"command\",\"params\"} or ###LUA### — never write guides or fake outputs. Complete code only.",
      ultraRules:
        "Keep outputs disciplined: inspect before editing, write complete modular code, detail visuals thoroughly, and confirm live.",
    },
    codecraft: {
      id: "codecraft",
      name: "CodeCraft API",
      tier: "Direct API",
      strengths: "Clean streaming API across 33 models, reasoning control, reliable formatting",
      weaknesses: "Model behavior varies across the 33 selectable models; verbose turns waste tokens",
      rules:
        "Act decisively on turn 1 with clean {\"command\":\"...\",\"params\":{...}} or ###LUA###...###END_LUA###. Batch independent reads/writes (up to 4) to save turns, write complete production code with zero stubs, and verify before concluding.",
      tightRules:
        "Act on turn 1, batch independent commands (up to 4), zero placeholder stubs, and verify before finishing.",
      ultraRules:
        "Maximize craft per token: cohesive architecture, rich visual/UI polish, strict error handling, and verifiable Studio proof.",
    },
    default: {
      id: "default",
      name: "AI Provider",
      tier: "Standard",
      strengths: "TotalScript agentic execution",
      weaknesses: "May default to prose or incomplete stubs without clear execution coaching",
      rules:
        "Act on turn 1 using real TotalScript commands — never reply with a manual guide, unexecuted promise, or placeholder stubs. Batch up to 4 independent calls and verify the live result before claiming done.",
      tightRules:
        "Act on turn 1 with real commands — no tutorials, no stubs; batch independent calls and verify.",
      ultraRules:
        "Deliver finished, polished, verified work on every request with zero shortcuts.",
    },
  });

  function profileFor(providerId) {
    const key = String(providerId || "").trim().toLowerCase();
    if (PROFILES[key]) return PROFILES[key];
    if (key.includes("openrouter") || key.includes("multichat") || key.includes("hugging")) return PROFILES.huggingchat;
    return PROFILES.default;
  }

  function promptBoost(providerId, opts) {
    opts = opts || {};
    const level = normalizeLevel(opts.level);
    const tight = !!opts.tight;
    const plain = !!opts.plain;
    const prof = profileFor(providerId);
    const fmtHint = plain
      ? "###CMD <name>###...###END_CMD### or ###LUA###...###END_LUA###"
      : '{"command":"...","params":{...}} or ###LUA###...###END_LUA###';

    if (level === "standard") {
      return `Execution boost (${prof.name}): act directly with ${fmtHint}; never reply with manual tutorials or placeholder stubs.`;
    }

    let core = tight ? prof.tightRules : prof.rules;
    if (plain) {
      core = core
        .replace(/\{"command":"[^"]*","params":\{[^}]*\}\}/g, "###CMD <name>###...###END_CMD###")
        .replace(/\{"command","params"\}/g, "###CMD###");
    }

    const head = `[PROVIDER BOOST · ${prof.name.toUpperCase()} · ${level.toUpperCase()}]`;
    const qualityBar = tight
      ? "Quality bar: full runnable code (zero TODO/stubs), clean visuals/UI, verify real output before done."
      : "Quality bar: (1) complete runnable code — zero TODOs, ellipsis, or grey stub blocks; (2) inspect real state before guessing paths/APIs; (3) batch up to 4 independent commands; (4) verify what you built (read-back, console, or screenshot) before summarizing.";

    if (level === "pro") {
      return `${head}\n- ${core}\n- ${qualityBar}`;
    }

    // Ultra level: full AAA execution + craft bar
    const ultraLine = tight
      ? prof.ultraRules
      : `${prof.ultraRules} Check edge cases (nil safety, pcall on DataStore/HTTP, server-side validation, anchored parts, responsive UI) and fix any error immediately rather than handing broken output to the user.`;
    return `${head}\n- ${core}\n- ${qualityBar}\n- AAA Craft: ${ultraLine}`;
  }

  // ── Universal Lazy-Reply Detector ─────────────────────────────────────────
  // Catches prose-only replies on mutating tasks when 0 tools have run:
  //   - simulated_output: model faked "Output of '...'" or "[Executed]"
  //   - tutorial: DIY step-by-step instructions or copy-paste code instead of acting
  //   - unrequested_plan: plan wall when Plan Mode is OFF
  //   - promise: "I'll start by...", "Let me inspect...", or "Would you like me to proceed?"
  // Strictly safe: NEVER fires if tools already ran, Plan Mode is active, task is
  // explainOnly / read-only, a command block already exists, or the model asked a
  // genuine clarifying question.
  const HAS_CMD_RE = /###\s*(?:lua|cmd|command|tool|mcp_tool)\b|"(?:command|tool|tool_name|toolName)"\s*:\s*"|<tool_call\b|[｜|]\s*DSML\s*[｜|]/i;
  const SIMULATED_OUT_RE = /(?:^|\n)\s*(?:Output of ['"][^'"]+['"]\s*:|\[(?:Executed|Tool Result|Studio Output|Command Output)\]|Running\s+(?:`?[a-z_]+`?|command\b)|(?:✓|✔|✅)\s*(?:Executed|Ran|Created|Updated)\s+`?[a-z_]+`?)/i;
  const TUTORIAL_RE = /\b(here(?:'s| is) how (?:you can |to )|follow these steps|step\s*1\s*[:.\-]\s*(?:open|in|create|insert|go to|click|add|select)|copy and paste|paste this (?:code |script )?into|you can (?:create|add|insert|put) (?:a |the )?(?:script|localscript|modulescript|part|model|screengui)|in roblox studio,?\s*(?:open|go to|insert|create|right[- ]click)|to (?:build|make|create|implement|fix) this (?:yourself|in roblox studio)|manually (?:create|add|insert|paste))\b/i;
  const PERMISSION_STALL_RE = /(?:would you like|do you want|shall i|should i|want me to|ready for me to)\s+(?:me\s+to\s+)?(?:proceed|go ahead|start|begin|implement|build|create|apply|write|make these changes|continue|do that|do this)\b[^.!?\n]{0,60}\?\s*$/i;
  const PROMISE_RE = /\b(i(?:'ll| will) (?:start by|now |first |go ahead and |begin by |inspect|check|create|build|write|fix|set up)|let me (?:first |start by |now )?(?:inspect|check|look at|explore|create|build|write|fix|verify|examine)|first,?\s*(?:i(?:'ll| will)|let(?:'s| me))\s+(?:inspect|check|look|explore|create|build|read|list)|sure!?\s*(?:i(?:'ll| will)|let(?:'s| me))|(?:i'm |i am )?(?:starting now|getting started|working on (?:it|that|this) now))\b/i;
  const PLAN_WALL_RE = /(?:^|\n)\s*(?:#{1,3}\s*(?:implementation\s+|build\s+|action\s+)?(?:plan|architecture|roadmap|steps|approach|overview)\b|(?:here(?:'s| is) (?:the |my )?(?:implementation\s+)?(?:plan|approach|breakdown)|my plan:|implementation plan:))/i;

  function isGenuineQuestion(trimmed) {
    if (!trimmed || !/\?\s*$/.test(trimmed)) return false;
    if (PERMISSION_STALL_RE.test(trimmed)) return false;
    // A real clarifying question is relatively short and does not dump fenced code or multi-step guides
    if (trimmed.length > 750) return false;
    if (/```/.test(trimmed)) return false;
    return true;
  }

  function detectLazyReply(text, ctx) {
    ctx = ctx || {};
    const raw = String(text || "");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (Number(ctx.toolTurns) > 0) return null;
    if (ctx.planMode) return null;
    const task = ctx.task || null;
    if (!task || !task.mutates || task.explainOnly) return null;
    if (HAS_CMD_RE.test(trimmed)) return null;

    if (SIMULATED_OUT_RE.test(trimmed)) {
      return { lazy: true, kind: "simulated_output", reason: "Model simulated command output instead of emitting a runnable command" };
    }
    if (TUTORIAL_RE.test(trimmed)) {
      return { lazy: true, kind: "tutorial", reason: "Model wrote a DIY tutorial instead of executing commands" };
    }
    // Numbered how-to steps with a fenced code block (non-Lua or multi-step DIY)
    const numberedSteps = (trimmed.match(/(?:^|\n)\s*[1-9]\.\s+\S/g) || []).length;
    if (numberedSteps >= 3 && /```/.test(trimmed) && !isGenuineQuestion(trimmed)) {
      return { lazy: true, kind: "tutorial", reason: "Model gave numbered DIY steps with unexecuted code blocks" };
    }
    if (PERMISSION_STALL_RE.test(trimmed)) {
      return { lazy: true, kind: "promise", reason: "Model asked for permission instead of executing the requested build" };
    }
    if (trimmed.length >= 220 && PLAN_WALL_RE.test(trimmed) && !isGenuineQuestion(trimmed)) {
      return { lazy: true, kind: "unrequested_plan", reason: "Model output a prose plan without running any command" };
    }
    if (PROMISE_RE.test(trimmed) && !isGenuineQuestion(trimmed)) {
      return { lazy: true, kind: "promise", reason: "Model promised to act but omitted the command block" };
    }
    return null;
  }

  function starterCommandFor(opts) {
    opts = opts || {};
    const plain = !!opts.plain;
    const engine = String(opts.engine || "roblox").toLowerCase();
    const mode = String(opts.mode || "").toLowerCase();
    if (mode === "blender") {
      return plain ? "###CMD get_scene_info###\n###END_CMD###" : '```json\n{"command":"get_scene_info","params":{}}\n```';
    }
    if (mode === "blockbench") {
      return plain ? "###CMD bb_status###\n###END_CMD###" : '```json\n{"command":"bb_status","params":{}}\n```';
    }
    if (engine === "local") {
      return plain ? "###CMD total_status###\n###END_CMD###" : '```json\n{"command":"total_status","params":{}}\n```';
    }
    return plain
      ? "###CMD get_studio_state###\n###END_CMD###"
      : '```json\n{"command":"get_studio_state","params":{}}\n```';
  }

  function rescuePrompt(providerId, kind, opts) {
    opts = opts || {};
    const round = Math.max(1, Number(opts.round) || 1);
    const plain = !!opts.plain;
    const prof = profileFor(providerId);
    const starter = starterCommandFor(opts);
    const syntax = plain
      ? "###CMD <name>### ... ###END_CMD### or ###LUA### ... ###END_LUA### (no JSON needed)"
      : '```json\n{"command":"<name>","params":{...}}\n``` or ###LUA### ... ###END_LUA###';

    const reasonLine = kind === "simulated_output"
      ? "You simulated tool output in plain text — NOTHING actually executed."
      : kind === "tutorial"
        ? "You wrote a manual how-to guide instead of running commands — NOTHING changed in the project."
        : kind === "unrequested_plan"
          ? "Plan Mode is OFF — do not stop at a prose plan; start building right now."
          : kind === "promise"
            ? "You said you would act (or asked permission to proceed), but your reply had NO command block."
            : "Your previous reply contained no runnable TotalScript command.";

    if (round >= 2) {
      return (
        `(System note from TotalScript · Provider Boost final rescue for ${prof.name}: ${reasonLine} ` +
        `The TotalScript bridge IS active on this page right now. Reply NOW with a real runnable command using ${syntax} — zero prose tutorial, zero apology. ` +
        `If you need to inspect first, send:\n${starter}\nor emit your build command directly.)`
      );
    }

    return (
      `(System note from TotalScript · Provider Boost: ${reasonLine} ` +
      `Execute step 1 immediately using ${syntax}. Do not ask for permission and do not repeat prose — emit the runnable command now.)`
    );
  }

  // ── Domain-Specific AAA Craft Rider (sent ONCE on first tool result) ──────
  function detectCraftDomain(task, mode) {
    const m = String(mode || "").toLowerCase();
    if (m === "blender") return "blender";
    if (m === "blockbench") return "blockbench";
    if (m === "animate") return "animate";
    if (m === "gui") return "gui";
    if (m === "model") return "model";
    if (m === "totality") return "totality";
    const primary = String((task && task.primary) || "").toLowerCase();
    if (/gui|ui|hud|menu|shop/.test(primary)) return "gui";
    if (/model|build|map|env|scene|world/.test(primary)) return "model";
    if (/anim|rig|cutscene/.test(primary)) return "animate";
    if (/blender|mesh/.test(primary)) return "blender";
    return "gameplay";
  }

  const CRAFT_BARS = Object.freeze({
    gui: {
      full: "AAA UI Craft: cohesive palette & typography hierarchy, UICorner/UIStroke/UIGradient depth, UIScale/UIAspectRatio responsiveness (desktop + mobile), smooth TweenService hover/press states, zero overlapping or clipped labels, and real RemoteEvent wiring.",
      tight: "UI Craft: clean hierarchy, UICorner/UIStroke/UIGradient, responsive UDim2 scaling, TweenService feedback, zero overlap.",
    },
    model: {
      full: "AAA 3D Craft: layered multi-part silhouettes (base, trim, framing, accent props — never bare single boxes), cohesive Material/Color palette, grounded Anchored geometry with zero Z-fighting, warm/cool lighting accents, and visual verification.",
      tight: "3D Craft: layered multi-part silhouettes (trim/props, no bare boxes), cohesive materials, anchored & grounded, zero Z-fighting.",
    },
    blender: {
      full: "AAA Blender Craft: clean manifold topology, intentional bevels/edge flow, Principled BSDF PBR materials (roughness/metallic contrast), applied scale & grounded origin, smooth shading with weighted normals, and multi-angle viewport screenshot check.",
      tight: "Blender Craft: clean bevelled topology, Principled BSDF PBR materials, applied scale/origin, viewport screenshot verification.",
    },
    blockbench: {
      full: "AAA Blockbench Craft: crisp silhouette readable at game distance, organized bone/pivot hierarchy for clean animation, cohesive UV-mapped pixel palette with subtle shading, and clean export readiness.",
      tight: "Blockbench Craft: crisp silhouette, clean pivot groups, cohesive UV palette, export-ready geometry.",
    },
    animate: {
      full: "AAA Animation Craft: distinct silhouettes across anticipation → action → follow-through, expressive easing curves (no robotic linear tweens), clean AnimationPriority & loop settings, and grounded root/pelvis motion.",
      tight: "Anim Craft: anticipation/action/follow-through poses, smooth easing (non-linear), clean AnimationPriority & loop.",
    },
    gameplay: {
      full: "AAA Gameplay/Code Craft: modular server-authoritative Luau, strict input/distance validation on RemoteEvents, pcall around DataStore/external APIs, juicy VFX/SFX/UI feedback on player actions, zero TODO/stubs, and verified read-back/playtest.",
      tight: "Code Craft: server-authoritative Luau, validated remotes, pcall on DataStore, juicy feedback, zero TODOs, verify live.",
    },
    totality: {
      full: "AAA Totality Craft: unite architecture, visuals, UI, audio/VFX, and gameplay into one cohesive vertical slice — zero stub scripts, zero grey placeholder blocks, strict server authority, and verified end-to-end.",
      tight: "Totality Craft: cohesive polished scripts + visuals + UI + feedback — zero stubs, verified end-to-end.",
    },
  });

  function craftRider(providerId, task, mode, level, opts) {
    opts = opts || {};
    const lvl = normalizeLevel(level);
    if (lvl === "standard") return "";
    if (task && task.explainOnly) return "";
    const domain = detectCraftDomain(task, mode);
    const bar = CRAFT_BARS[domain] || CRAFT_BARS.gameplay;
    const body = opts.tight ? bar.tight : bar.full;
    const prof = profileFor(providerId);
    const extra = lvl === "ultra" && !opts.tight
      ? " Before finishing, inspect your own output critically and fix any rough edge, warning, or missing polish."
      : "";
    return `[CRAFT STANDARD · ${prof.name} · ${lvl.toUpperCase()}]\n${body}${extra}`;
  }

  // ── Live Provider Telemetry Scoring & Rankings ────────────────────────────
  function scoreProvider(stats) {
    const s = stats && typeof stats === "object" ? stats : {};
    const turns = Math.max(0, Number(s.turns) || 0);
    const toolCalls = Math.max(0, Number(s.toolCalls) || 0);
    const toolOk = Math.max(0, Math.min(toolCalls, Number(s.toolOk) || 0));
    const parseErrors = Math.max(0, Number(s.parseErrors) || 0);
    const rescues = Math.max(0, Number(s.rescues) || 0);
    const providerErrors = Math.max(0, Number(s.providerErrors) || 0);
    const avgMs = Math.max(0, Number(s.avgMs) || 0);

    if (turns === 0 && toolCalls === 0 && parseErrors === 0 && providerErrors === 0) {
      return {
        score: null,
        grade: "—",
        turns: 0,
        toolCalls: 0,
        toolSuccessRate: 0,
        cleanParseRate: 100,
        autonomyRate: 100,
        avgMs: 0,
      };
    }

    const totalEvents = Math.max(1, turns + parseErrors + providerErrors);
    const toolRate = toolCalls > 0 ? (toolOk / toolCalls) : 0.75;
    const cleanParseRate = Math.max(0, 1 - parseErrors / Math.max(1, toolCalls + parseErrors));
    const autonomyRate = Math.max(0, 1 - rescues / Math.max(1, turns));
    const reliabilityRate = Math.max(0, 1 - providerErrors / totalEvents);
    // Speed bonus/penalty gentle (0..5 pts): <= 6s = +5, >= 45s = 0
    const speedPts = avgMs > 0 ? Math.max(0, Math.min(5, Math.round(5 * (1 - Math.max(0, avgMs - 6000) / 39000)))) : 3;

    const raw = Math.round(
      toolRate * 38 +
      cleanParseRate * 24 +
      autonomyRate * 18 +
      reliabilityRate * 15 +
      speedPts
    );
    const score = Math.max(0, Math.min(100, raw));
    const grade = score >= 92 ? "S" : score >= 82 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";

    return {
      score,
      grade,
      turns,
      toolCalls,
      toolSuccessRate: Math.round(toolRate * 100),
      cleanParseRate: Math.round(cleanParseRate * 100),
      autonomyRate: Math.round(autonomyRate * 100),
      reliabilityRate: Math.round(reliabilityRate * 100),
      avgMs: Math.round(avgMs),
    };
  }

  function rankProviders(statsMap) {
    const map = statsMap && typeof statsMap === "object" ? statsMap : {};
    const ids = new Set(Object.keys(PROFILES).filter((k) => k !== "default"));
    for (const k of Object.keys(map)) if (k && k !== "default") ids.add(k);

    const rows = [];
    for (const id of ids) {
      const prof = profileFor(id);
      const metrics = scoreProvider(map[id]);
      rows.push({
        id,
        name: prof.name,
        tier: prof.tier,
        ...metrics,
      });
    }
    rows.sort((a, b) => {
      const sa = a.score == null ? -1 : a.score;
      const sb = b.score == null ? -1 : b.score;
      if (sb !== sa) return sb - sa;
      if (b.toolCalls !== a.toolCalls) return b.toolCalls - a.toolCalls;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  return {
    VERSION,
    LEVELS,
    PROFILES,
    normalizeLevel,
    nextLevel,
    profileFor,
    promptBoost,
    detectLazyReply,
    rescuePrompt,
    craftRider,
    detectCraftDomain,
    scoreProvider,
    rankProviders,
  };
})();

if (typeof window !== "undefined") window.TotalProviderBoost = TotalProviderBoost;
if (typeof module !== "undefined" && module.exports) module.exports = TotalProviderBoost;
