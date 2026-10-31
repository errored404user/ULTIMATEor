// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/orchestrator.js - 1.69.0 provider orchestration layer.
//
// Pure, dependency-free helpers that main.js threads through the request →
// execution pipeline for EVERY provider:
//
//   1. classifyTask(text)        - task understanding (category, intent,
//                                  follow-up detection, constraints, how to
//                                  verify) computed when the user sends a
//                                  message, BEFORE the model acts.
//   2. taskLayer(task)           - Layer C of the instruction stack: a short,
//                                  task-specific brief that rides on the first
//                                  tool result of the run (never rewrites the
//                                  user's composer, never repeats the system
//                                  prompt).
//   3. classifyProviderError()   - one error taxonomy for every site/API:
//                                  context limit, rate limit, quota, auth,
//                                  busy/server, network, moderation, invalid.
//      retryDelay()              - bounded back-off per class (permanent
//                                  failures are never retried).
//   4. validateToolArgs()        - schema-driven argument validation + gentle
//                                  coercion ("5" → 5, "true" → true, JSON text
//                                  → object, enum case fix) with a model-facing
//                                  problem report. Unknown keys are dropped only
//                                  when the schema forbids them.
//   5. claimsCompletion()        - false-success detector: prose that says
//                                  "done / created / added" while NO command ran.
//   6. capabilities(P)           - normalised capability record of the active
//                                  provider adapter (what main.js can rely on).
//   7. redact()                  - secret scrubbing for diagnostics.
//
// Everything here is side-effect free and runs in node (tests) and in the
// content script (window.TotalOrchestrator).
const TotalOrchestrator = (() => {
  "use strict";
  const VERSION = "1.99.8";

  // ───────────────────────── 1. task understanding ─────────────────────────
  const CATEGORY_RE = {
    animation: /\b(animat(e|ion|ions|or)|rig(s|ged|ging)?|keyframe|pose|walk ?cycle|idle|emote|motor6d|keyframesequence|run cycle|dance|attack combo)\b/i,
    gui: /\b(gui|ui|ux|hud|button|frame|screen ?gui|menu|shop ui|inventory ui|scroll(ing)? ?frame|textlabel|textbutton|imagelabel|layout|panel|popup|modal|tooltip|billboardgui|surfacegui)\b/i,
    luau: /\b(script|lua|luau|module ?script|local ?script|function|remote ?(event|function)|datastore|bindable|coroutine|metatable|loop|variable|table|require)\b/i,
    roblox_studio: /\b(roblox|studio|workspace|part|mesh ?part|model|place|instance|service|humanoid|npc|terrain|baseplate|spawn ?location|tool|folder|explorer|properties)\b/i,
    gameplay: /\b(mechanic|game ?play|system|combat|damage|health|weapon|sword|gun|inventory|round|wave|leaderboard|leaderstats|shop|quest|tycoon|obby|simulator|checkpoint|currency|coins|xp|level ?up|enemy|boss|ability|skill tree|crafting|pet)\b/i,
    vfx: /\b(particle|vfx|effect|lighting|atmosphere|bloom|sun ?rays|fog|skybox|sound|sfx|music|trail|beam|glow|neon)\b/i,
    debug: /\b(fix|bug|bugs|bugged|buggy|error(s|ing|ed)?|broken|doesn'?t work|doesnt work|does not work|don'?t work|dont work|won'?t work|wont work|isn'?t working|not working|stopped working|nothing happens|crash(es|ed|ing)?|debug|issue|fail(s|ed|ing)?|exception|nil value|attempt to|stack trace|output says|warning)\b/i,
    review: /\b(review|audit|inspect|analy[sz]e|look (at|over|through)|check (the|my|this)|find (issues|problems|bugs)|what'?s wrong|code quality|rate my)\b/i,
    architecture: /\b(architecture|structure|refactor|reorgani[sz]e|organi[sz]e|design pattern|module layout|folder structure|clean ?up|modular|scalable|best way to structure)\b/i,
    research: /\b(research|compare|comparison|best practice|documentation|docs|which is better|pros and cons|recommend|options for|how do (other|people))\b/i,
    files: /\b(file|folder|read|export|import|rbxmx|rbxm|json|csv|download|upload|save as|open the|project files|workspace folder)\b/i,
    code: /\b(code|program|write|implement|function|class|algorithm|snippet|typescript|javascript|python|rust|api)\b/i,
  };
  // Order used to pick the PRIMARY category when several match.
  const PRIMARY_ORDER = ["debug", "animation", "gui", "vfx", "gameplay", "luau", "roblox_studio", "architecture", "review", "research", "files", "code"];
  const STRONG_IMPLEMENT_RE = /\b(create|make|build|add|write|implement|generate|fix|change|update|edit|modify|remove|delete|refactor|rewrite|replace|install|set ?up)\b/i;
  const IMPLEMENT_RE = /\b(create|make|build|add|write|implement|generate|animate|design|set ?up|spawn|place|insert|put|give|attach|wire|hook ?up|connect|rename|move|resize|change|update|edit|modify|replace|remove|delete|improve|optimi[sz]e|convert|migrate|refactor|configure|enable|disable|turn (on|off)|install|deploy|publish|save|export|import|apply|increase|decrease|tweak|polish|finish|complete|do it|go ahead)\b/i;
  const EXPLAIN_RE = /^(what|why|how (does|do|is|are|did|can i tell)|explain|describe|tell me (about|what|why|how)|is (it|this|there)|are (there|these)|does|do (you|they|i need)|can (you )?(explain|tell)|which|when|where|who|difference between|meaning of|define)\b/i;
  const PLAN_RE = /\b(plan|outline|roadmap|propose|proposal|strategy|approach|how would you|what steps|steps (to|for)|break (it )?down|design doc|spec(ification)? for)\b/i;
  const PLAN_ONLY_RE = /\b((don'?t|do not|without|no need to|before (you|we)) (do|implement|build|change|code|write|touch|run)|just (a |the )?plan|plan only|only (a |the )?plan|first,? (plan|outline)|don'?t (build|implement|change) (it|anything) yet)\b/i;
  const PLAN_THEN_DO_RE = /\b(plan(,)? (and |then |and then )(implement|build|do|execute|create|make|code|write)|then (implement|build|do|create|make) it|and (then )?(implement|build|create|make) it)\b/i;
  const CONTINUE_RE = /^(continue|go on|keep going|proceed|next|resume|carry on|more|again|retry|try again|one more|finish( it)?|and the rest)\b[\s.!]*$/i;
  const FOLLOWUP_REF_RE = /\b(that|this|it|those|them|these)\b(?=\s*($|[.,!?;]|too\b|as well\b|also\b|instead\b|again\b|now\b|please\b|a bit\b|more\b|less\b|faster\b|slower\b|better\b|smaller\b|bigger\b|and\b|but\b|so\b|work\b|works\b|doesn|does\b|dont\b|don't|is\b|isn|was\b|won|wont|didn|did\b|stopped\b|broke|keeps\b|still\b))|\b(the same|previous one|the previous|above|earlier|last one|the other one|that one|this one)\b/i;
  const QUESTION_END_RE = /\?\s*$/;
  // Negated verbs ("don't change anything", "without modifying") must not count as implement verbs.
  const NEGATED_VERB_RE = /\b(don'?t|do not|dont|without|never|no need to|not|avoid|instead of|rather than|before (you|we)|shouldn'?t|must not)\s+(\w+\s+)?(create|make|build|add|write|implement|generate|change|update|edit|modify|remove|delete|replace|touch|run|execute|rewrite|refactor|break|move|rename|changing|modifying|editing|deleting|removing|touching|running|breaking)\b/gi;
  // Inspect-only requests: read / show / list / find - tools yes, mutation no.
  const INSPECT_LEAD_RE = /^(read|show( me)?|list|find|where (is|are|does)|look at|look through|open and (read|show)|inspect|print|dump|search( for)?|check what|tell me what|what('s| is) (in|inside)|which (scripts?|parts?|instances?|files?)|summari[sz]e|count)\b/i;
  const CONSTRAINT_RE = /\b(only|don'?t|do not|never|must|must not|without|keep|no more than|at most|at least|under|max(imum)?|min(imum)?|exactly|avoid|instead of|make sure|ensure|should not|shouldn'?t|not allowed|limit(ed)? to|in (one|a single) (script|file|part|command))\b[^.;\n]{0,90}?(?=[.;\n]|$|,? (and|but|also|plus) (only|don'?t|do not|never|must|without|keep|avoid|no more than|at most|at least|make sure|ensure|should not|shouldn'?t)\b)/gi;
  const VERIFY_HINT = {
    debug: "Reproduce or read the failing code first, apply the fix, then re-run / read the Output to prove the error is gone.",
    animation: "Preview or validate the clip (frame count, duration, rig type) and read the saved object back before you call it done.",
    gui: "List the built GUI tree (or take a screenshot) and check sizes / anchors / text against the request before finishing.",
    vfx: "Read the created instances back (properties, parents) and confirm they are enabled / visible in the right place.",
    gameplay: "Read back the scripts and instances you created and run a short check (print / play-test) that the mechanic actually fires.",
    luau: "Read the script back and confirm it parses (no Output errors) before reporting success.",
    roblox_studio: "Read back what you created / changed (names, parents, properties) so the final report states facts, not intentions.",
    architecture: "Finish with a short map of what changed and why; confirm nothing referenced by other scripts was broken.",
    review: "Quote the exact places you looked at; do not report problems in code you did not read.",
    research: "Separate verified facts (from docs / tool output) from assumptions and say which is which.",
    files: "Confirm the file / instance exists after the operation and state its exact path.",
    code: "Run or read back the result; never report a result you did not observe.",
    general: "State clearly what was executed and what was not.",
  };
  const CATEGORY_LABEL = {
    debug: "debugging / error diagnosis", animation: "animation creation", gui: "UI / UX implementation", vfx: "visual / audio effects",
    gameplay: "game mechanics", luau: "Roblox Luau scripting", roblox_studio: "Roblox Studio building", architecture: "architecture / refactor",
    review: "code review / inspection", research: "research / technical analysis", files: "file inspection / transformation", code: "programming", general: "general request",
  };

  function uniq(xs) { return xs.filter((x, i) => xs.indexOf(x) === i); }

  // classifyTask(text, { prev }) → task record. `prev` (the previous task of
  // the same chat) lets a short follow-up ("fix that", "make it faster")
  // inherit the categories and constraints of the request it refers to.
  function classifyTask(text, ctx) {
    ctx = ctx || {};
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    const t = raw.slice(0, 4000);
    const prev = ctx.prev && typeof ctx.prev === "object" ? ctx.prev : null;
    const words = t ? t.split(" ").length : 0;
    const cats = [];
    for (const k of Object.keys(CATEGORY_RE)) if (CATEGORY_RE[k].test(t)) cats.push(k);
    const isContinue = CONTINUE_RE.test(t);
    const tNoNeg = t.replace(NEGATED_VERB_RE, " ");
    const implementVerb = IMPLEMENT_RE.test(tNoNeg);
    const inspectLead = INSPECT_LEAD_RE.test(t);
    const explainLead = EXPLAIN_RE.test(t);
    const question = QUESTION_END_RE.test(t);
    const planWord = PLAN_RE.test(t);
    const planOnly = planWord && (PLAN_ONLY_RE.test(t) || (!implementVerb && !PLAN_THEN_DO_RE.test(t)) || /^(plan|outline|propose)\b/i.test(t)) && !PLAN_THEN_DO_RE.test(t);
    const strongImplement = STRONG_IMPLEMENT_RE.test(tNoNeg);
    // Explicit targets (a Studio path like ServerScriptService.Main, an inspect
    // lead) mean the request stands on its own even if it says "it".
    const explicitTarget = inspectLead || /\b[A-Z]\w+\.[A-Za-z]\w*/.test(t);
    const followUp = !isContinue && !!prev && !explicitTarget && FOLLOWUP_REF_RE.test(t) && (words <= 8 || (words <= 14 && !strongImplement));
    let intent;
    if (isContinue) intent = "continue";
    else if (planOnly) intent = "plan";
    else if (explainLead && !implementVerb) intent = "explain";
    else if (inspectLead && !strongImplement) intent = "inspect";
    else if (cats.includes("review") && !strongImplement && /^(review|audit|inspect|analy[sz]e|look (at|over|through)|check|rate)\b/i.test(t)) intent = "review";
    else if (cats.includes("debug")) intent = "fix";
    else if (cats.includes("review") && !strongImplement) intent = "review";
    else if (implementVerb) intent = "implement";
    else if (question) intent = "question";
    else if (words <= 3 && prev) intent = "continue";
    else intent = cats.length ? "implement" : "question";
    // Inherit from the referenced request on follow-ups / continues.
    let categories = cats.filter((c) => c !== "debug" && c !== "review" || intent === "fix" || intent === "review");
    if ((followUp || isContinue) && prev && Array.isArray(prev.categories)) categories = uniq(prev.categories.concat(categories));
    if (!categories.length) categories = ["general"];
    const primary = PRIMARY_ORDER.find((c) => categories.includes(c)) || categories[0];
    // Explicit constraints the model must not lose ("only one script", "don't touch the lighting").
    const constraints = [];
    let m; const re = new RegExp(CONSTRAINT_RE.source, "gi");
    while ((m = re.exec(t)) && constraints.length < 6) { const s = m[0].trim(); if (s.length >= 8) constraints.push(s.slice(0, 100)); }
    if ((followUp || isContinue) && prev && Array.isArray(prev.constraints)) for (const c of prev.constraints) if (constraints.length < 6 && !constraints.includes(c)) constraints.push(c);
    const needsTools = intent === "implement" || intent === "fix" || intent === "review" || intent === "inspect" || intent === "continue" || (intent === "question" && categories.some((c) => c !== "general" && c !== "research" && c !== "code"));
    const mutates = intent === "implement" || intent === "fix" || (intent === "continue" && (!prev || prev.mutates !== false));
    const outcome = (() => {
      if (intent === "plan") return "a plan only - no changes";
      if (intent === "explain" || intent === "question") return "an answer / explanation";
      if (intent === "review") return "findings from inspecting the real project";
      if (intent === "inspect") return "what the project actually contains, read with commands - no changes";
      if (intent === "fix") return "the error gone, proven by re-running or reading back";
      return "the requested change exists in the project and was read back";
    })();
    return {
      v: 1, text: t.slice(0, 280), words, primary, categories, intent, followUp, isContinue,
      planOnly: intent === "plan", explainOnly: intent === "explain" || intent === "question" || intent === "plan",
      needsTools, mutates, constraints, verify: VERIFY_HINT[primary] || VERIFY_HINT.general, outcome,
      inherited: !!((followUp || isContinue) && prev), at: Date.now(),
    };
  }

  // ───────────────────────── 2. Layer C: task brief ─────────────────────────
  // Short enough to ride on any tool result (≤ ~700 chars, ≤ ~360 when tight).
  function taskLayer(task, opts) {
    opts = opts || {};
    if (!task || task.explainOnly) return "";
    const tight = !!opts.tight;
    const label = CATEGORY_LABEL[task.primary] || CATEGORY_LABEL.general;
    const parts = [];
    parts.push(`(Task brief from TotalScript, not the user.) Task: ${label} · intent: ${task.intent}${task.inherited ? " (follow-up to the previous request - keep its requirements)" : ""}. Expected outcome: ${task.outcome}.`);
    if (task.constraints && task.constraints.length) {
      const cs = task.constraints.slice(0, tight ? 2 : 4).map((c) => `"${c}"`).join(", ");
      parts.push(`Constraints from the user that still apply: ${cs}.`);
    }
    if (!tight) parts.push(`Before you finish: ${task.verify}`);
    parts.push(tight ? "Report only what actually ran." : "Your final message must report what actually ran and what did not - never describe an intended change as done.");
    let s = parts.join(" ");
    const cap = tight ? 420 : 760;
    if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…";
    return s;
  }

  // ───────────────────────── 3. provider error taxonomy ─────────────────────────
  // One classifier for text coming from a site banner, a network tap, an HTTP
  // body or an exception message. `retryable` means "the same request can
  // succeed later without any change"; everything else needs the user.
  const ERROR_CLASSES = {
    context_limit: { retryable: false, hint: "The conversation is too long for this model - open a fresh chat and continue there." },
    // 1.99.0: the ACCOUNT (not this request) was suspended or throttled for bot-like
    // use of the web chat. Never retried - every extra message lengthens the ban.
    account_block: { retryable: false, hint: "The provider suspended or throttled this ACCOUNT for bot-like use of its web chat. TotalScript stopped and will not resend. Wait the stated time out, keep automatic messages paced (gentle mode), and for heavy automation use the desktop app with your own official API key." },
    // 1.99.3: "you are sending messages too frequently" - a slow-down request, NOT
    // a suspension. One retry of the undelivered message after a long cool-down
    // (minutes, like a person would), pacing tightened for the rest of the session.
    throttled: { retryable: true, hint: "The provider asked to slow down (not a suspension). TotalScript cools down for a few minutes, retries the undelivered message once with tighter pacing, and otherwise stops so you can resume later." },
    rate_limit: { retryable: true, hint: "The provider is rate limiting this account - TotalScript waits and retries, then stops if it persists." },
    quota: { retryable: false, hint: "The account's usage allowance / credits are exhausted - wait for the reset or switch provider." },
    auth: { retryable: false, hint: "The session or API key is not accepted - sign in again / check the key, then press Start." },
    moderation: { retryable: false, hint: "The provider's content filter blocked this message - rephrase and send again." },
    invalid_request: { retryable: false, hint: "The provider rejected the request shape - this is a bug or an unsupported parameter, not a transient error." },
    busy: { retryable: true, hint: "The provider is overloaded or returned a server error - TotalScript retries with back-off." },
    network: { retryable: true, hint: "The connection dropped - TotalScript retries once the network is back." },
    unsupported_model: { retryable: false, hint: "The selected model does not exist on this provider / account - pick another model in the site's picker." },
    cancelled: { retryable: false, hint: "The request was cancelled (Stop pressed or the site aborted it) - nothing was resent." },
    unknown: { retryable: false, hint: "The provider reported an error OR could not classify - check the site and send \"continue\"." },
  };
  const MAX_ATTEMPTS = { rate_limit: 2, busy: 2, network: 2, throttled: 1 };
  function classifyProviderError(text) {
    const t = String(text || "").slice(0, 2000);
    const l = t.toLowerCase();
    let cls = "unknown";
    let waitMs = 0;
    const ra = l.match(/retry[- ]after[:\s]*(\d+)\s*(ms|milliseconds|s|sec|seconds|m|min|minutes)?/) || l.match(/(?:try again|retry|wait)\s+(?:in|after)\s+(\d+)\s*(ms|milliseconds|s|sec|seconds|m|min|minutes)?/);
    if (ra) { const n = parseInt(ra[1], 10); const u = ra[2] || "s"; waitMs = /^m(s|illiseconds)$/.test(u) ? n : /^m/.test(u) ? n * 60000 : n * 1000; }
    if (/\b(cancel+ed|canceled) by (the )?user|user (cancel+ed|aborted|stopped)|stop(ped)? by user|operation (was )?cancel+ed|request (was )?cancel+ed/.test(l)) cls = "cancelled";
    else if (ACCOUNT_SUSPEND_RE.test(t)) cls = "account_block";
    else if (THROTTLE_RE.test(t)) cls = "throttled";
    else if (/model.{0,30}(not found|does not exist|doesn't exist|is not available|unavailable|not available|has been (deprecated|retired)|decommissioned)|no such model|unknown model|invalid model|unsupported model|model_not_found|\b404\b.{0,40}model|model.{0,40}\b404\b/.test(l)) cls = "unsupported_model";
    else if (/context.{0,24}(limit|length|window|exceed)|maximum.{0,20}tokens|too many tokens|conversation.{0,24}too long|prompt is too long|input is too long|message is too long|exceeds? the (maximum|limit)|token limit/.test(l)) cls = "context_limit";
    else if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (api )?key|incorrect api key|api key (is )?(invalid|missing|not)|authentication|not authenticated|session expired|please (log|sign) in|login required|access denied|permission denied/.test(l)) cls = "auth";
    else if (/\b402\b|insufficient (credits|quota|balance|funds)|out of credits|quota exceeded|exceeded your (current )?quota|weekly[_ ]limit|daily limit|usage limit reached|allowance|billing|payment required|upgrade (your plan|to continue)|plan limit|message limit reached|reached (your|the) (message|usage) limit|no credits/.test(l)) cls = "quota";
    else if (/\b429\b|rate[- ]?limit|too many requests|slow down|requests per (minute|second|day)|rpm limit|concurrency[_ ]limit|concurrent request/.test(l)) cls = "rate_limit";
    else if (/content[_ ]?filter|content policy|moderation|flagged|blocked by (safety|policy)|unsafe content|violat(es|ion)/.test(l)) cls = "moderation";
    else if (/\b(500|502|503|504|520|521|522|524)\b|server error|internal error|bad gateway|service unavailable|gateway time-?out|overloaded|capacity|high demand|server is busy|something went wrong|temporarily unavailable|try again later|upstream/.test(l)) cls = "busy";
    else if (/network ?error|failed to fetch|fetch failed|connection (reset|refused|closed|lost|failed)|econnreset|econnrefused|enotfound|etimedout|timed? ?out|socket hang up|dns|offline|no internet|stream (error|interrupted|closed)|aborted/.test(l)) cls = "network";
    else if (/\b400\b|\b422\b|bad request|invalid (request|parameter|argument|schema|json|value)|unsupported (parameter|model|value)|unknown (parameter|field|model)|strict_mode|unrecognized|not supported|does not support|schema validation|validation error|malformed/.test(l)) cls = "invalid_request";
    const meta = ERROR_CLASSES[cls];
    return { cls, retryable: meta.retryable, waitMs, hint: meta.hint, detail: t.slice(0, 300) };
  }
  // 1.99.0: account-level suspension / throttling notices (DeepSeek wording as
  // reported by users in 2026: "Due to violation of user policies, your account
  // has been suspended until <date>", "sending messages too frequently"), with
  // the French / Chinese UI strings the same site renders.
  // 1.99.3: split in two. A THROTTLE toast ("sending messages too frequently",
  // "请求过于频繁") is the site asking to slow down NOW - it is not a suspension
  // and must never be reported as one (that was a false "account blocked"
  // verdict in 1.99.0-1.99.2). ACCOUNT_BLOCK_RE stays exported as the union.
  const ACCOUNT_SUSPEND_RE = /account (has been |is |was )?(temporarily )?(suspended|banned|restricted|locked|disabled|blocked)|suspended until|violation of (the )?user polic|compte (a été |est )?(suspendu|bloqué)|账号.{0,8}(封禁|暂停|冻结|异常)/i;
  const THROTTLE_RE = /(sending|sent) (messages |requests )?too (frequently|often|fast|quickly)|too frequently|trop fréquemment|请求过于频繁|操作过于频繁/i;
  const ACCOUNT_BLOCK_RE = new RegExp(ACCOUNT_SUSPEND_RE.source + "|" + THROTTLE_RE.source, "i");
  // suspendedUntil(text) → Date | null, from "suspended until September 20, 2026 02:55".
  function suspendedUntil(text) {
    const m = String(text || "").match(/until\s+([A-Za-z]+ \d{1,2},? \d{4}(?:[ ,]+\d{1,2}:\d{2})?)/i);
    if (!m) return null;
    const d = new Date(m[1].replace(/,\s*(\d{1,2}:\d{2})$/, " $1"));
    return isNaN(d.getTime()) ? null : d;
  }

  // ── 1.99.0 gentle pacing ──────────────────────────────────────────────────
  // paceDelay(sendLog, now, pacing, jitter) → { waitMs, reason, sentLastHour }.
  // sendLog: timestamps (ms) of earlier sends; pacing: the provider's contract
  // { minGapMs, maxGapMs, perHour }; jitter: 0..1 (caller passes Math.random()).
  // The gap keeps automatic turns at a human cadence instead of firing the next
  // message the millisecond a reply ends; the hourly budget caps a long agent run
  // at what a person could plausibly type. Pure so it can be unit-tested.
  function paceDelay(sendLog, now, pacing, jitter) {
    const log = Array.isArray(sendLog) ? sendLog : [];
    const p = pacing || {};
    const hour = 3600000;
    const recent = log.filter((t) => now - t < hour);
    let waitMs = 0;
    let reason = null;
    const minGap = Math.max(0, Number(p.minGapMs) || 0);
    const maxGap = Math.max(minGap, Number(p.maxGapMs) || minGap);
    const last = log.length ? Math.max.apply(null, log) : null;
    if (last != null && minGap > 0) {
      const j = Math.min(1, Math.max(0, Number(jitter) || 0));
      const gap = Math.round(minGap + (maxGap - minGap) * j);
      if (now - last < gap) { waitMs = gap - (now - last); reason = "gap"; }
    }
    const perHour = Number(p.perHour) || 0;
    if (perHour > 0 && recent.length >= perHour) {
      const oldest = Math.min.apply(null, recent);
      const until = oldest + hour - now;
      if (until > waitMs) { waitMs = until; reason = "budget"; }
    }
    // 1.99.3 additive fields (all optional, 0/absent = off):
    //   breakEvery / breakMinMs / breakMaxMs - after every N sends of an unbroken
    //     streak (gaps < 10 min) the next send waits a longer "break" instead of
    //     the usual gap. Steady 8-20 s metronome ticks for an hour are the thing
    //     a cadence detector sees; people pause.
    //   perDay - rolling 24 h cap on everything this tab sent (reason "day").
    //   checkpointEvery - after N sends in one unbroken streak the plan carries
    //     `checkpoint: true`: the caller must get a human click before sending
    //     more. Nothing waits on a timer here; a person has to be present.
    const dayMs = 86400000;
    const today = log.filter((t) => now - t < dayMs);
    const streak = streakLength(log, now);
    const breakEvery = Number(p.breakEvery) || 0;
    if (breakEvery > 0 && last != null && streak > 0 && streak % breakEvery === 0) {
      const bmin = Math.max(0, Number(p.breakMinMs) || 60000);
      const bmax = Math.max(bmin, Number(p.breakMaxMs) || bmin);
      const j = Math.min(1, Math.max(0, Number(jitter) || 0));
      const brk = Math.round(bmin + (bmax - bmin) * j);
      if (now - last < brk && brk - (now - last) > waitMs) { waitMs = brk - (now - last); reason = "break"; }
    }
    const perDay = Number(p.perDay) || 0;
    if (perDay > 0 && today.length >= perDay) {
      const oldest = Math.min.apply(null, today);
      const until = oldest + dayMs - now;
      if (until > waitMs) { waitMs = until; reason = "day"; }
    }
    const checkpointEvery = Number(p.checkpointEvery) || 0;
    const checkpoint = checkpointEvery > 0 && streak > 0 && streak % checkpointEvery === 0 && last != null && now - last < 600000;
    return { waitMs: Math.max(0, waitMs), reason, sentLastHour: recent.length, sentToday: today.length, streak, checkpoint };
  }
  // streakLength(sendLog, now) → number of most-recent sends with < 10 min between
  // neighbours (0 when the last send is itself older than 10 min = streak over).
  function streakLength(sendLog, now) {
    const log = (Array.isArray(sendLog) ? sendLog : []).slice().sort((a, b) => a - b);
    if (!log.length || now - log[log.length - 1] >= 600000) return 0;
    let n = 1;
    for (let i = log.length - 1; i > 0; i--) { if (log[i] - log[i - 1] < 600000) n++; else break; }
    return n;
  }
  // tightenPacing(pacing, strikes) → a stricter copy of the contract after the
  // site asked to slow down `strikes` times this session: gaps double, the
  // hourly budget halves (floor 4/h), the break comes sooner. Capped at 3
  // strikes (x8). Pure - the caller keeps the strike count.
  function tightenPacing(pacing, strikes) {
    const p = Object.assign({}, pacing || {});
    const s = Math.min(3, Math.max(0, strikes | 0));
    if (!s) return p;
    const f = Math.pow(2, s);
    if (p.minGapMs) p.minGapMs = p.minGapMs * f;
    if (p.maxGapMs) p.maxGapMs = p.maxGapMs * f;
    if (p.perHour) p.perHour = Math.max(4, Math.floor(p.perHour / f));
    if (p.breakEvery) p.breakEvery = Math.max(2, Math.ceil(p.breakEvery / 2));
    p.strikes = s;
    return p;
  }

  // retryDelay(cls, attempt /*1-based*/, waitMs) → ms to wait before retry
  // number `attempt`, or null when this class must not be retried (again).
  function retryDelay(cls, attempt, waitMs) {
    const max = MAX_ATTEMPTS[cls] || 0;
    const n = Math.max(1, attempt | 0);
    if (n > max) return null;
    const base = cls === "throttled" ? [180000] : cls === "rate_limit" ? [15000, 45000] : cls === "network" ? [4000, 12000] : [6000, 20000];
    let ms = base[Math.min(n, base.length) - 1];
    if (waitMs > 0) ms = Math.max(ms, Math.min(waitMs + 500, cls === "throttled" ? 600000 : 120000));
    return ms;
  }

  // ───────────────────────── 4. tool argument validation ─────────────────────────
  function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
  }
  function allowedTypes(prop) {
    const t = prop && prop.type;
    if (!t) return null;
    return Array.isArray(t) ? t.map(String) : [String(t)];
  }
  function matchesType(types, v) {
    const got = typeOf(v);
    return types.some((t) => t === got || (t === "number" && got === "integer") || (t === "any") || (t === "object" && got === "object"));
  }
  function coerceTo(types, v) {
    // Returns { ok, value } - only safe, lossless conversions.
    if (typeof v === "string") {
      const s = v.trim();
      if (types.includes("integer") && /^-?\d+$/.test(s)) return { ok: true, value: parseInt(s, 10) };
      if (types.includes("number") && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return { ok: true, value: Number(s) };
      if (types.includes("boolean") && /^(true|false|yes|no|on|off|1|0)$/i.test(s)) return { ok: true, value: /^(true|yes|on|1)$/i.test(s) };
      if ((types.includes("object") || types.includes("array")) && /^[\[{]/.test(s)) { try { const p = JSON.parse(s); if (matchesType(types, p)) return { ok: true, value: p }; } catch {} }
      if (types.includes("array")) return { ok: true, value: [v] };
    }
    if (typeof v === "number" && types.includes("string") && !types.includes("number") && !types.includes("integer")) return { ok: true, value: String(v) };
    if (typeof v === "boolean" && types.includes("string")) return { ok: true, value: v ? "true" : "false" };
    if (typeof v === "number" && types.includes("integer") && Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9) return { ok: true, value: Math.round(v) };
    return { ok: false, value: v };
  }
  // validateToolArgs(schema, args, opts) → { args, problems:[{key,msg}], coerced:[key], dropped:[key] }
  // Never throws; a schema-less tool passes through untouched. Keys starting
  // with "_total" are TotalScript-internal and ignored. Required-ness is checked by the
  // caller (requiredParamsMissing) so the two messages stay distinct.
  function validateToolArgs(schema, args, opts) {
    opts = opts || {};
    const out = { args: args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {}, problems: [], coerced: [], dropped: [] };
    const props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    if (!props) return out;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      for (const k of Object.keys(out.args)) {
        if (/^_total/.test(k)) continue;
        const prop = props[k];
        if (!prop) {
          if (schema.additionalProperties === false && !opts.keepUnknown) { delete out.args[k]; out.dropped.push(k); }
          continue;
        }
        let v = out.args[k];
        if (v === undefined) continue;
        const types = allowedTypes(prop);
        if (types && !(v === null && types.includes("null")) && !matchesType(types, v)) {
          const c = coerceTo(types, v);
          if (c.ok) { out.args[k] = v = c.value; out.coerced.push(k); }
          else { out.problems.push({ key: k, msg: `'${k}' must be ${types.join(" | ")} (got ${typeOf(v)})` }); continue; }
        }
        if (Array.isArray(prop.enum) && prop.enum.length) {
          if (!prop.enum.includes(v)) {
            const hit = typeof v === "string" ? prop.enum.find((e) => typeof e === "string" && e.toLowerCase() === v.trim().toLowerCase()) : undefined;
            if (hit !== undefined) { out.args[k] = v = hit; out.coerced.push(k); }
            else out.problems.push({ key: k, msg: `'${k}' must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")} (got ${JSON.stringify(v).slice(0, 40)})` });
          }
        }
        if (typeof v === "number") {
          if (Number.isFinite(prop.minimum) && v < prop.minimum) out.problems.push({ key: k, msg: `'${k}' must be >= ${prop.minimum}` });
          if (Number.isFinite(prop.maximum) && v > prop.maximum) out.problems.push({ key: k, msg: `'${k}' must be <= ${prop.maximum}` });
        }
        if (typeof v === "string" && Number.isFinite(prop.maxLength) && v.length > prop.maxLength) out.problems.push({ key: k, msg: `'${k}' is longer than ${prop.maxLength} characters` });
        if (Array.isArray(v) && prop.items && prop.items.type && !Array.isArray(prop.items.type)) {
          const it = [String(prop.items.type)];
          for (let i = 0; i < v.length; i++) {
            if (!matchesType(it, v[i])) { const c = coerceTo(it, v[i]); if (c.ok) { v[i] = c.value; if (!out.coerced.includes(k)) out.coerced.push(k); } else { out.problems.push({ key: k, msg: `'${k}[${i}]' must be ${it[0]} (got ${typeOf(v[i])})` }); break; } }
          }
        }
      }
    }
    return out;
  }
  function argProblemsMessage(name, v, schemaLine) {
    const list = (v && v.problems || []).map((p) => "- " + p.msg).join("\n");
    return `ERROR INVALID_PARAMS calling '${name}': the call did not match the command schema, so it was NOT run.\n${list}` +
      (schemaLine ? `\nSchema:\n${schemaLine}` : "") +
      "\nFix the value(s) and resend the same command now - no list_commands needed.";
  }

  // ───────────────────────── 5. false-success detector ─────────────────────────
  const DONE_CLAIM_RE = /\b(i('ve| have)? (now )?(created|added|built|made|implemented|updated|fixed|changed|set up|wired|inserted|placed|written|generated|applied|removed|deleted|renamed|configured|finished|completed)|(has|have) been (created|added|built|implemented|updated|fixed|changed|set up|inserted|placed|applied|removed|configured)|is now (in place|ready|done|working|set up|live|complete)|(all )?done[.!]|(task|everything|that) (is )?(complete|completed|finished)|successfully (created|added|built|implemented|updated|fixed|changed|applied|removed)|✅)/i;
  const HEDGE_RE = /\b(here('s| is) (the|a|an) (script|code|plan|example|snippet)|you can (paste|add|put|create|run)|paste this|copy this|would|could|should|if you want|let me know|i can('t| not)|cannot|unable|could not|couldn'?t|did not run|didn'?t run|was not (run|executed)|not executed|nothing (was )?(ran|executed)|no command)\b/i;
  function claimsCompletion(text, toolTurns) {
    const t = String(text || "");
    if (!t || (toolTurns | 0) > 0) return false;
    if (/```|###\s*LUA\s*###/.test(t)) return false; // code / a command in the reply - not a bare claim
    if (!DONE_CLAIM_RE.test(t)) return false;
    return !HEDGE_RE.test(t);
  }
  const FEEDBACK = {
    falseSuccess:
      "(System note from TotalScript, not the user.) Your reply describes the work as done, but NO command has run in this task - nothing was created or changed in Studio. " +
      "Either run the commands now (one fenced json command or a ###LUA### block per step), or state plainly that nothing was executed and why. Never report an intended change as completed.",
    providerRetry: (cls, attempt, seconds) =>
      `(System note: the previous message hit a transient provider error (${cls}); TotalScript waited ${seconds}s and re-sent it - attempt ${attempt}. Nothing was executed twice. Continue exactly where you left off.)`,
  };

  // ───────────────────────── 6. capability registry ─────────────────────────
  // Normalises what main.js can rely on for the ACTIVE provider adapter. All
  // values come from the adapter itself (never invented); missing optional
  // features read as false / null so callers degrade explicitly.
  function capabilities(P) {
    if (!P || typeof P !== "object") return null;
    const has = (k) => typeof P[k] === "function";
    const num = (k) => (Number.isFinite(Number(P[k])) && Number(P[k]) > 0 ? Number(P[k]) : null);
    const T = P.timings || {};
    return {
      id: String(P.id || "?"), name: String(P.displayName || P.id || "?"), version: VERSION,
      vision: !!P.supportsVision && has("attachImages"),
      streamTap: !!(P.genDebug || (P.snapshot && /net|tap|stream/i.test(JSON.stringify((() => { try { return P.snapshot(); } catch { return {}; } })()).slice(0, 400)))),
      nativeStop: has("stopGeneration"), nativeContinue: has("findContinueBtn") && has("clickContinueBtn"),
      errorScan: has("scanError"), tooLongScan: has("isTooLongMsg"), busyScan: has("isBusyMsg"),
      compactCommandList: !!P.compactCommandList, embedCatalogue: P.embedCatalogue !== false,
      sysMaxChars: num("sysMaxChars"), sendCharBudget: num("sendCharBudget"), commandListMaxChars: num("commandListMaxChars"),
      maxBatchCommands: Math.max(1, Math.min(8, Number(P.maxBatchCommands) || 6)),
      resendSystemEvery: num("resendSystemEvery"), reliableCounts: !!P.reliableCounts, immutableTranscript: !!P.immutableTranscript,
      thinkingVisible: !!P.thinkingSel, commandsMayAppearInThinking: !!P.commandsMayAppearInThinking,
      tightPrompt: !!(num("sysMaxChars") && num("sysMaxChars") < 16000) || !!P.compactCommandList,
      timings: { genIdleMs: T.GEN_IDLE_MS || null, reasonIdleMs: T.REASON_IDLE_MS || null, warmupMs: T.WARMUP_MS || null, reasonNoReplyMs: T.REASON_NOREPLY_MS || null, stableMs: T.STABLE_MS || null, responseTimeoutMs: T.RESPONSE_TIMEOUT_MS || null, prestartMs: T.PRESTART_MS || null, genStopGraceMs: T.GEN_STOP_GRACE_MS || null },
      promptExtra: typeof P.promptExtra === "string" ? P.promptExtra.length : 0,
    };
  }

  // ───────────────────────── 7. redaction ─────────────────────────
  const SECRET_RES = [
    /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
    /\b(sk-(?:or-|proj-|ant-)?[A-Za-z0-9_\-]{12,})/g,
    /\b(cc_[A-Za-z0-9]{16,})/g,
    /\b(gsk_[A-Za-z0-9]{16,})/g,
    /\b(xai-[A-Za-z0-9]{16,})/g,
    /\b(AIza[0-9A-Za-z\-_]{30,})/g,
    /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
    /\b(vani_[A-Za-z0-9]{12,})/g,
    /("?(?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|cookie|x-api-key)"?\s*[:=]\s*"?)([^"\s,;]{6,})/gi,
  ];
  function redact(s) {
    let out = String(s == null ? "" : s);
    out = out.replace(SECRET_RES[0], "$1 [redacted]");
    for (let i = 1; i < SECRET_RES.length - 1; i++) out = out.replace(SECRET_RES[i], "[redacted]");
    out = out.replace(SECRET_RES[SECRET_RES.length - 1], "$1[redacted]");
    return out;
  }
  const SECRET_KEY_RE = /^(api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|cookie|cookies|x-api-key|bearer|private[_-]?key)$/i;
  // Deep copy with secret-named keys masked (whatever their length) and
  // secret-looking substrings redacted inside strings. Non-plain values
  // (functions, DOM nodes) are passed through untouched.
  function redactData(data, depth) {
    depth = depth | 0;
    if (data == null || depth > 12) return data;
    if (typeof data === "string") return redact(data);
    if (Array.isArray(data)) return data.map((v) => redactData(v, depth + 1));
    if (typeof data === "object") {
      const proto = Object.getPrototypeOf(data);
      if (proto !== Object.prototype && proto !== null) return data;
      const out = {};
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (SECRET_KEY_RE.test(k) && v != null && (typeof v !== "object")) out[k] = "[redacted]";
        else out[k] = redactData(v, depth + 1);
      }
      return out;
    }
    return data;
  }

  // ───────────────────────── 8. tool-feedback compaction (1.99.8) ─────────────────────────
  // Every provider is a chat box with a finite turn budget (ChatGPT / Vani /
  // Notion run the tight prompt). Before 1.99.8 an oversized tool result was
  // cut head+tail at a fixed offset - which could drop the one ERROR line in
  // the middle of a 300-line log, or slice a JSON payload mid-string so the
  // model could not read counts. compactFeedback keeps the SIGNAL:
  //   - the "Output of 'x':" / "ERROR" prefix is preserved untouched (the loop
  //     classifies on startsWith("ERROR"));
  //   - a JSON body is shrunk structurally: long arrays keep their first items
  //     + a "(+n more)" marker and long strings are clipped with their length,
  //     so keys/counts survive and the result still parses;
  //   - a text body keeps every line that looks like a problem (error / warn /
  //     fail / exception / stack / traceback / nil / attempt to), folds runs of
  //     identical lines into one "(×N)" line, then fills the rest of the budget
  //     with the head and the tail of the output in order;
  //   - the footer says exactly what was dropped and how to ask for the rest.
  // Pure function: same input → same output; never throws (falls back to the
  // old head+tail cut).
  const PROBLEM_LINE_RE = /\b(error|warn(?:ing)?|fail(?:ed|ure)?|exception|traceback|stack(?:trace| begin)|attempt to|nil value|not a valid member|cannot|denied|timed? ?out|missing|invalid|expected|infinite yield|unknown)\b/i;
  function compactJson(v, depth, budget) {
    if (depth > 6) return typeof v === "object" && v !== null ? (Array.isArray(v) ? `[…${v.length} items]` : "{…}") : v;
    if (typeof v === "string") return v.length > budget.str ? v.slice(0, budget.str) + `…[+${v.length - budget.str} chars]` : v;
    if (Array.isArray(v)) {
      const keep = v.length > budget.arr ? v.slice(0, budget.arr) : v;
      const out = keep.map((x) => compactJson(x, depth + 1, budget));
      if (v.length > budget.arr) out.push(`(+${v.length - budget.arr} more items, ${v.length} total)`);
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      const keys = Object.keys(v);
      for (const k of keys.slice(0, budget.keys)) out[k] = compactJson(v[k], depth + 1, budget);
      if (keys.length > budget.keys) out["…"] = `+${keys.length - budget.keys} more keys`;
      return out;
    }
    return v;
  }
  function compactFeedback(text, name, max) {
    const s = String(text == null ? "" : text);
    const MAX = Number(max) > 500 ? Number(max) : 10000;
    if (s.length <= MAX) return s;
    const label = String(name || "tool");
    try {
      const pm = /^((?:ERROR[^\n]*\n)?Output of '[^']*':\s*\n?|ERROR[^\n]*\n)/.exec(s);
      const prefix = pm ? pm[1] : "";
      const body = s.slice(prefix.length);
      const footer = (kept, note) => `\n[TotalScript context compression: ${note}; dropped ${Math.max(0, s.length - kept)} of ${s.length} chars from ${label}. Ask again with a narrower command (path / limit / query / line range) for the rest.]`;
      // JSON body: shrink structurally at decreasing budgets until it fits.
      const trimmed = body.trim();
      if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
        let parsed = null;
        try { parsed = JSON.parse(trimmed); } catch {}
        if (parsed !== null && typeof parsed === "object") {
          for (const b of [{ arr: 40, str: 600, keys: 60 }, { arr: 20, str: 300, keys: 40 }, { arr: 8, str: 160, keys: 25 }, { arr: 3, str: 80, keys: 12 }]) {
            const out = JSON.stringify(compactJson(parsed, 0, b));
            if (prefix.length + out.length + 220 <= MAX) return prefix + out + footer(prefix.length + out.length, "JSON shrunk structurally (arrays keep their first items, long strings clipped - keys and counts are exact)");
          }
        }
      }
      // Text body: problem lines first, folded repeats, then head + tail.
      const rawLines = body.split("\n");
      const lines = [];
      for (const ln of rawLines) {
        const last = lines[lines.length - 1];
        if (last && last.text === ln && ln.trim()) last.n++;
        else lines.push({ text: ln, n: 1 });
      }
      const render = (l) => (l.n > 1 ? `${l.text}  (×${l.n})` : l.text);
      const budget = MAX - prefix.length - 260;
      const pick = new Set();
      let used = 0;
      const take = (i) => { if (pick.has(i)) return true; if (lines[i].dup) return true; const len = render(lines[i]).length + 1; if (used + len > budget) return false; pick.add(i); used += len; return true; };
      // Problem lines: the first occurrence of each distinct message is kept
      // (digits normalised, so "line 12" / "line 40" of the same error fold
      // into one "(×N)" line); at most 40 distinct ones.
      let problems = 0;
      const seenProblem = new Map();
      for (let i = 0; i < lines.length; i++) {
        if (!PROBLEM_LINE_RE.test(lines[i].text) || lines[i].text.length > 400) continue;
        const sig = lines[i].text.replace(/\d+/g, "#").trim();
        const first = seenProblem.get(sig);
        if (first !== undefined) { lines[first].n += lines[i].n; lines[i].dup = true; continue; }
        seenProblem.set(sig, i);
        if (problems < 40 && take(i)) problems++;
      }
      const headShare = Math.floor((budget - used) * 0.65);
      let acc = 0;
      for (let i = 0; i < lines.length && acc < headShare; i++) { if (take(i)) acc += render(lines[i]).length + 1; else break; }
      for (let i = lines.length - 1; i >= 0; i--) { if (!take(i)) break; }
      const outLines = [];
      let gap = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].dup) continue;
        if (pick.has(i)) { if (gap) { outLines.push("  […]"); gap = false; } outLines.push(render(lines[i])); }
        else gap = true;
      }
      const out = outLines.join("\n");
      return prefix + out + footer(prefix.length + out.length, `kept ${pick.size} of ${lines.length} lines (${problems} problem line${problems === 1 ? "" : "s"} kept in full, repeats folded)`);
    } catch {
      return s.slice(0, Math.floor(MAX * 0.65)) + "\n[TotalScript context compression: dropped " + (s.length - Math.floor(MAX * 0.9)) + " chars from " + label + "]\n" + s.slice(-Math.floor(MAX * 0.25));
    }
  }

  return { VERSION, classifyTask, taskLayer, classifyProviderError, retryDelay, ERROR_CLASSES, ACCOUNT_BLOCK_RE, ACCOUNT_SUSPEND_RE, THROTTLE_RE, suspendedUntil, paceDelay, streakLength, tightenPacing, validateToolArgs, argProblemsMessage, claimsCompletion, FEEDBACK, capabilities, redact, redactData, CATEGORY_LABEL, compactFeedback, PROBLEM_LINE_RE };
})();
if (typeof window !== "undefined") window.TotalOrchestrator = TotalOrchestrator;
if (typeof module !== "undefined" && module.exports) module.exports = TotalOrchestrator;
