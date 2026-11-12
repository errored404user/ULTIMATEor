// TotalScript Agent Crew — the Multi-Agent system behind `total_agent`.
//
// Before 1.22.0 `total_agent {role}` only echoed a one-line role description back
// to the model: nothing remembered the plan, nothing stopped a "planner" from
// mutating the place, nothing told the model when to hand off, and "done" was
// whatever the model felt like. This module turns the feature into a real
// crew protocol with a shared board:
//
//   planner  → writes GOAL + numbered PLAN on the board (read-only)
//   builder  → modeling / instances / UI, ONE mutating command per reply
//   scripter → Luau, ONE mutating command per reply
//   reviewer → read-only inspection, records FINDINGS
//   tester   → playtests (start_stop_play, console, screenshots) and VERIFIES
//   debugger → total_debug first, then the smallest fix
//   done     → completion gate: refused until the tester verified a clean run
//
// main.js wires it in at four points: `total_agent` → handoff(), every tool call →
// guard() (read-only roles cannot mutate), every tool result → afterTool()
// (board bookkeeping + handoff hints), SYSTEM_STATE / total_status → stateTag() /
// summary(). config.js embeds promptBlock() in the system prompt.
//
// Everything is plain strings in and out, so the module also runs under node
// (tests/test-agent-crew.js) without a DOM.
const TotalAgentCrew = (() => {
  "use strict";

  const MUTATOR_ROLES = new Set(["builder", "scripter", "debugger"]);

  const ROLES = {
    planner: {
      title: "Planner", badge: "PLAN", mutates: false,
      brief: "Read the place first (get_studio_state, search_game_tree, script_list, model_report, selection_info). Restate the request as GOAL + the systems it implies (server/client scripts, models, UI, data). Write a numbered PLAN of 3-8 concrete steps that ships a finished, styled creation — each step names the owner (builder or scripter) and its verification. Do not build anything.",
      next: "Put the plan on the board with total_agent {\"role\":\"builder\" or \"scripter\", \"goal\":\"...\", \"plan\":[\"step 1\",\"step 2\",...], \"step\":1, \"task\":\"what step 1 needs\"}.",
      allowed: "read-only commands only (role guard blocks anything that changes the place).",
    },
    builder: {
      title: "Builder", badge: "BUILD", mutates: true,
      brief: "Modeling, instances, terrain, UI and properties for the CURRENT step. Finished parts only: anchored, named, materials and colors set, grouped into a named Model with a PrimaryPart, placed where the plan says. Prefer one well-formed command (execute_luau builds a whole model in one go) over many tiny ones. Read what you touch before you change it.",
      next: "When the step is visibly complete, advance: total_agent {\"role\":\"builder\"|\"scripter\", \"step\":N+1, \"task\":\"...\"}. After the last build step, or every 4 changes, hand off: total_agent {\"role\":\"reviewer\", \"task\":\"verify steps ...\"}.",
      allowed: "any command, ONE per reply.",
    },
    scripter: {
      title: "Scripter", badge: "LUAU", mutates: true,
      brief: "Luau for the CURRENT step. script_read / script_outline before editing, script_backup before a rewrite, then the smallest write (script_set_source / multi_edit / script_create). Production Luau: typed where cheap, services via GetService, WaitForChild with timeouts, no loadstring, server authority for anything that matters, RemoteEvents validated on the server, connections cleaned up. After the write, script_lint or script_check it.",
      next: "When the step compiles clean, advance with total_agent {\"step\":N+1,...} or hand off to the reviewer: total_agent {\"role\":\"reviewer\", \"task\":\"review <script paths>\"}.",
      allowed: "any command, ONE per reply.",
    },
    reviewer: {
      title: "Reviewer", badge: "REVIEW", mutates: false,
      brief: "Independent read-only audit of what the builder/scripter produced: inspect_instance / model_report on every new model, script_read + script_lint / script_analysis on every touched script, total_debug for console errors, total_screenshot {target:\"studio\"} for the look. Judge against the GOAL and the plan step, not against the previous agent's claims. Record each defect as a FINDING with path + what is wrong + how to fix.",
      next: "Defects found → total_agent {\"role\":\"debugger\", \"findings\":[\"...\"], \"task\":\"fix finding 1\"}. Nothing wrong → total_agent {\"role\":\"tester\", \"task\":\"playtest ...\"}.",
      allowed: "read-only commands only (role guard blocks anything that changes the place).",
    },
    tester: {
      title: "Tester", badge: "TEST", mutates: false,
      brief: "Prove it works like a player would: start_stop_play (or an execute_luau smoke test that only reads), then get_console_output / total_debug, then total_screenshot {target:\"game\"} where the result is visual. Exercise the actual behaviour (touch the trigger, fire the remote, open the UI). A clean console AFTER the behaviour ran is the only pass.",
      next: "Clean → total_agent {\"role\":\"done\", \"summary\":\"what was built + what was checked\"}. Errors → total_agent {\"role\":\"debugger\", \"findings\":[\"<first error>\"]}. Missing feature → total_agent {\"role\":\"builder\"|\"scripter\", \"task\":\"...\"}.",
      allowed: "read-only commands plus start_stop_play / screenshots (role guard blocks edits).",
    },
    debugger: {
      title: "Debugger", badge: "DEBUG", mutates: true,
      brief: "total_debug {} first, then reproduce (start_stop_play if needed), read the script around the failing line (script_read with a range), fix the CAUSE with the smallest command, add a guard so it cannot silently recur, total_debug again. First error only. Do not widen scope, do not refactor.",
      next: "Console clean → total_agent {\"role\":\"tester\", \"task\":\"re-run the playtest\"}. Fixed one of several findings → stay debugger and take the next finding.",
      allowed: "any command, ONE per reply.",
    },
  };

  const ALIASES = {
    plan: "planner", planning: "planner", architect: "planner", lead: "planner",
    build: "builder", model: "builder", modeler: "builder", modeller: "builder", artist: "builder", designer: "builder", ui: "builder",
    script: "scripter", scripts: "scripter", coder: "scripter", programmer: "scripter", developer: "scripter", luau: "scripter", engineer: "scripter",
    review: "reviewer", critic: "reviewer", auditor: "reviewer", qa: "tester",
    test: "tester", tests: "tester", testing: "tester", playtest: "tester", verifier: "tester",
    debug: "debugger", fixer: "debugger", fix: "debugger",
    done: "done", finish: "done", finished: "done", complete: "done", completed: "done", report: "done",
  };

  // Commands that never change the place / workspace. Everything else is a
  // mutation for the role guard (conservative on purpose — a planner that is
  // told "no" once hands off; a planner that destroys a model does not).
  const READ_ONLY = /^(get_|list_|search_|inspect_|find_|script_(read|search|grep|outline|find_usages|requires|analysis|check|lint|stats|list|diff|exists)|audit_|selection_info|total_|debug_|web_|api_|capture_id|instance_(find|find_class|descendants|bounding_box|info|exists)|model_report|workspace_(stats|list)|memory_get|read_|file_exists|count_lines|grep_|which_cmd|env_info|git_(status|diff|log)|dir_size|file_stat|status$|totalscript_help|search_commands|get_command|command_registry_stats|generate_command_docs|project\.|mcp\.|chatgpt\.|creator\.get|template_|screenshot$|take_screenshot|send_screenshot|list_by_ext|find_todos|read_range|list_recent|public_item_(get|list|search)|developer_product_list|devproduct_list|property_get|attribute_get|tag_list|ds_get|datastore_get|describe_|count_|measure_|raycast|path_find|check_)/;
  // Allowed for the tester on top of READ_ONLY: running the game is not an edit.
  const PLAY = /^(start_stop_play|start_play|stop_play|playtest|play_test|run_playtest|screen_capture|get_console_output)$/;
  const LUAU_RUNNERS = /^(execute_luau|run_luau|run_code|luau_run|eval_luau|execute_script)$/;
  // Luau that writes. A read-only snippet (prints, returns, GetDescendants…)
  // stays allowed for planner/reviewer/tester.
  const LUAU_MUTATION = /Instance\.new|:Destroy\s*\(|:Clone\s*\(|\.Parent\s*=|\bSource\s*=|:ClearAllChildren|InsertService|:LoadAsset|:SetAttribute|:AddTag|:RemoveTag|:SetPrimaryPartCFrame|:PivotTo|:MoveTo|:SetAsync|:UpdateAsync|:RemoveAsync|:IncrementAsync|:FillBlock|:FillBall|:FillRegion|:FillWedge|:FillCylinder|:WriteVoxels|:SetWaypoint|:Undo\s*\(|:Redo\s*\(|\.(Anchored|CFrame|Position|Size|Name|Color|BrickColor|Material|Transparency|Value|Text|Enabled|Visible|CanCollide|Orientation|Rotation|Reflectance|Shape|Massless|Locked|Archivable|Disabled)\s*=[^=]/;
  const SCRIPT_TOOL = /^(script_|multi_edit|luau_|module_|remote_|bindable_|datastore_|ds_|leaderstats_)/;

  const MAX_PLAN = 12;
  const MAX_FINDINGS = 12;
  const MAX_HISTORY = 40;
  const EDITS_BEFORE_REVIEW = 4;

  const S = fresh();
  function fresh() {
    return {
      role: "", goal: "", plan: [], step: 0, findings: [], history: [],
      verified: false, edits: 0, editsSinceReview: 0, failStreak: 0,
      guardHits: 0, handoffs: 0, notes: [], startedAt: 0, lastSummary: "",
    };
  }
  function reset() { Object.assign(S, fresh()); emit(); }

  function active() {
    try { if (typeof globalThis.__rsMultiAgent === "function") return !!globalThis.__rsMultiAgent(); } catch {}
    return false;
  }

  function emit() {
    try {
      if (typeof globalThis.dispatchEvent === "function" && typeof globalThis.CustomEvent === "function") {
        globalThis.dispatchEvent(new CustomEvent("total-crew-change", { detail: summary() }));
      }
    } catch {}
  }

  function normalizeRole(raw) {
    const r = String(raw || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!r) return "";
    if (ROLES[r] || r === "done") return r;
    if (ALIASES[r]) return ALIASES[r];
    for (const k of Object.keys(ROLES)) if (r.startsWith(k) || k.startsWith(r)) return k;
    return "";
  }

  function classify(tool, args) {
    const name = String(tool || "").replace(/^[^:]*:/, "");
    if (!name) return "read";
    if (LUAU_RUNNERS.test(name)) {
      const code = String((args && (args.code || args.source || args.script)) || "");
      return LUAU_MUTATION.test(code) ? "mutate" : "read";
    }
    if (PLAY.test(name)) return "play";
    if (READ_ONLY.test(name)) return "read";
    return "mutate";
  }

  function toList(v) {
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : (x && (x.text || x.step || x.title)) || JSON.stringify(x))).map((x) => String(x || "").trim()).filter(Boolean);
    if (v && typeof v === "object") return Object.values(v).map((x) => String(x || "").trim()).filter(Boolean);
    const s = String(v || "").trim();
    if (!s) return [];
    if (s.startsWith("[")) { try { const arr = JSON.parse(s); if (Array.isArray(arr)) return toList(arr); } catch {} }
    return s.split(/\r?\n|(?:^|\s)(?=\d{1,2}[.)]\s)/).map((x) => x.replace(/^\s*\d{1,2}[.)]\s*/, "").trim()).filter(Boolean);
  }

  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function setPlan(items) {
    const list = toList(items).slice(0, MAX_PLAN);
    if (!list.length) return false;
    S.plan = list.map((text, i) => {
      const old = S.plan[i];
      return { text: clip(text, 160), status: old && old.text === clip(text, 160) ? old.status : "todo" };
    });
    if (!S.step || S.step > S.plan.length) S.step = 1;
    return true;
  }

  function setStep(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n < 1) return;
    n = Math.floor(n);
    if (S.plan.length) {
      n = Math.min(n, S.plan.length);
      for (let i = 0; i < n - 1; i++) if (S.plan[i].status === "todo" || S.plan[i].status === "now") S.plan[i].status = "done";
      for (let i = n; i < S.plan.length; i++) if (S.plan[i].status === "now") S.plan[i].status = "todo";
      S.plan[n - 1].status = "now";
    }
    S.step = n;
  }

  // step_done:N — steps 1..N are finished; the board moves to N+1 (if any).
  function markDone(n) {
    n = Math.floor(Number(n));
    if (!Number.isFinite(n) || n < 1 || !S.plan.length) return;
    n = Math.min(n, S.plan.length);
    for (let i = 0; i < n; i++) S.plan[i].status = "done";
    if (n < S.plan.length) { S.step = n + 1; if (S.plan[n].status === "todo") S.plan[n].status = "now"; }
    else S.step = S.plan.length;
  }

  function addFindings(v) {
    const list = toList(v);
    for (const f of list) {
      const text = clip(f, 220);
      if (!S.findings.some((x) => x.text === text)) S.findings.push({ text, status: "open" });
    }
    if (S.findings.length > MAX_FINDINGS) S.findings = S.findings.slice(-MAX_FINDINGS);
  }

  function resolveFindings(v) {
    const list = toList(v);
    for (const f of list) {
      const idx = Number(f);
      if (Number.isFinite(idx) && S.findings[idx - 1]) { S.findings[idx - 1].status = "fixed"; continue; }
      for (const x of S.findings) if (x.text.toLowerCase().includes(String(f).toLowerCase().slice(0, 40))) x.status = "fixed";
    }
  }

  function planLines() {
    if (!S.plan.length) return "PLAN: (none yet — the planner writes it with total_agent {plan:[...]})";
    const mark = { todo: " ", now: ">", done: "x" };
    return "PLAN:\n" + S.plan.map((p, i) => `  ${i + 1}. [${mark[p.status] || " "}] ${p.text}`).join("\n");
  }
  function findingLines() {
    const open = S.findings.filter((f) => f.status === "open");
    if (!S.findings.length) return "";
    return "FINDINGS:\n" + S.findings.map((f, i) => `  ${i + 1}. [${f.status === "fixed" ? "fixed" : "open"}] ${f.text}`).join("\n") + (open.length ? "" : "\n  (all fixed)");
  }
  function doneCount() { return S.plan.filter((p) => p.status === "done").length; }

  // ── total_agent ──────────────────────────────────────────────────────────────
  function handoff(args) {
    args = args && typeof args === "object" ? args : {};
    const requested = args.role || args.agent || args.to || args.next || "";
    let role = normalizeRole(requested);
    if (!role) {
      return "ERROR in total_agent: unknown role '" + clip(requested, 40) + "'. Roles: planner, builder, scripter, reviewer, tester, debugger, done. Example: total_agent {\"role\":\"planner\",\"task\":\"plan the request\"}.";
    }
    const task = clip(args.task || args.prompt || args.goal_for_role || args.instructions || "", 1200);
    if (!S.startedAt) S.startedAt = Date.now();
    if (args.goal) S.goal = clip(args.goal, 400);
    if (args.plan || args.steps) setPlan(args.plan || args.steps);
    if (args.findings || args.issues || args.bugs || args.notes) addFindings(args.findings || args.issues || args.bugs || args.notes);
    if (args.fixed || args.resolved) resolveFindings(args.fixed || args.resolved);
    if (args.step_done != null || args.done_step != null) markDone(args.step_done != null ? args.step_done : args.done_step);
    if (args.step != null) setStep(args.step);

    if (role === "done") return completionGate(args);

    const def = ROLES[role];
    const prev = S.role;
    S.role = role;
    S.handoffs++;
    S.guardHits = 0;
    S.failStreak = 0;
    if (role === "reviewer" || role === "tester") S.editsSinceReview = 0;
    if (role === "reviewer" && prev && MUTATOR_ROLES.has(prev)) S.verified = false;
    S.history.push({ role, task: clip(task, 120), at: Date.now() });
    if (S.history.length > MAX_HISTORY) S.history.shift();
    emit();

    const stepNow = S.plan.length && S.step ? S.plan[S.step - 1] : null;
    const lines = [];
    lines.push(`Output of 'total_agent':`);
    lines.push(`CREW HANDOFF #${S.handoffs}${prev ? ` ${ROLES[prev] ? ROLES[prev].title : prev} →` : ""} ROLE=${role} (${def.title})`);
    if (S.goal) lines.push(`GOAL: ${S.goal}`);
    lines.push(planLines());
    if (stepNow) lines.push(`CURRENT STEP ${S.step}/${S.plan.length}: ${stepNow.text}`);
    const fl = findingLines();
    if (fl) lines.push(fl);
    lines.push(`TASK: ${task || (stepNow ? stepNow.text : "(continue the user's request)")}`);
    lines.push(`BRIEF: ${def.brief}`);
    lines.push(`ALLOWED: ${def.allowed}`);
    lines.push(`HAND OFF: ${def.next}`);
    if (role === "planner" && S.plan.length) lines.push("NOTE: a plan already exists — revise it only if the request changed, otherwise hand off to the owner of the current step.");
    if (MUTATOR_ROLES.has(role) && !S.plan.length && S.handoffs > 1) lines.push("NOTE: no plan on the board. Pass plan:[...] with your next total_agent call so progress can be tracked.");
    lines.push(`Reply as the ${def.title} only. ONE command per reply.`);
    return lines.join("\n");
  }

  function completionGate(args) {
    const summary = clip(args.summary || args.report || args.task || "", 1500);
    const openFindings = S.findings.filter((f) => f.status === "open");
    const unfinished = S.plan.filter((p) => p.status !== "done");
    const blockers = [];
    if (S.edits > 0 && !S.verified) blockers.push("the TESTER has not verified a clean run since the last change (start_stop_play / execute_luau smoke test, then total_debug — console must be clean)");
    if (openFindings.length) blockers.push(`${openFindings.length} open finding(s): ${openFindings.map((f, i) => `(${i + 1}) ${clip(f.text, 90)}`).join("; ")}`);
    if (unfinished.length && S.plan.length) blockers.push(`${unfinished.length} plan step(s) not marked done: ${unfinished.map((p) => clip(p.text, 60)).join(" | ")} — pass step_done:N as each finishes, or explain in summary why a step was dropped`);
    if (blockers.length && !args.force) {
      const next = S.edits > 0 && !S.verified ? "total_agent {\"role\":\"tester\",\"task\":\"playtest and verify\"}" : openFindings.length ? "total_agent {\"role\":\"debugger\",\"task\":\"fix finding 1\"}" : "total_agent {\"role\":\"builder\"|\"scripter\",\"step\":" + (S.step || 1) + "}";
      return "ERROR in total_agent: NOT DONE YET.\n- " + blockers.join("\n- ") + "\nNext: " + next + "\n(If the user explicitly accepted an unfinished state, call total_agent {\"role\":\"done\",\"force\":true,\"summary\":\"...\"} and say so in the report.)";
    }
    S.lastSummary = summary;
    S.role = "";
    emit();
    const stats = `${S.handoffs} handoff(s), ${S.edits} change(s), ${S.findings.filter((f) => f.status === "fixed").length} finding(s) fixed${S.plan.length ? `, ${doneCount()}/${S.plan.length} steps` : ""}`;
    return "Output of 'total_agent':\nCREW DONE — " + stats + ".\n" + (summary ? "SUMMARY: " + summary + "\n" : "") + "Report to the user now in plain language: what was built (paths), what was verified (playtest / console / screenshot) and anything left open. No further commands unless the user asks.";
  }

  // ── role guard (runTool, before execution) ───────────────────────────────
  function guard(tool, args) {
    if (!active() || !S.role || !ROLES[S.role]) return null;
    const def = ROLES[S.role];
    if (def.mutates) return null;
    const kind = classify(tool, args);
    if (kind === "read") return null;
    if (kind === "play" && S.role === "tester") return null;
    S.guardHits++;
    if (S.guardHits >= 2) {
      // Twice in a row the read-only agent insisted on acting. Promote instead
      // of dead-locking the loop; the next result says so.
      const promoted = kind === "play" ? "tester" : (SCRIPT_TOOL.test(String(tool).replace(/^[^:]*:/, "")) ? "scripter" : "builder");
      const was = def.title;
      S.role = promoted;
      S.guardHits = 0;
      S.handoffs++;
      S.history.push({ role: promoted, task: "auto-promoted from " + was, at: Date.now() });
      S.notes.push(`[CREW] Auto-handoff: the ${was} tried to change the place twice, so you are now the ${ROLES[promoted].title}. Keep ONE command per reply and hand off to the reviewer after this step.`);
      emit();
      return null;
    }
    const alt = S.role === "planner" ? "total_agent {\"role\":\"builder\"|\"scripter\",\"goal\":\"...\",\"plan\":[...],\"step\":1,\"task\":\"...\"}"
      : S.role === "reviewer" ? "total_agent {\"role\":\"debugger\",\"findings\":[\"...\"],\"task\":\"fix finding 1\"}"
      : "total_agent {\"role\":\"debugger\",\"findings\":[\"<error>\"]}";
    return `ERROR ROLE GUARD in ${tool}: the ${def.title} agent is read-only and '${tool}' would change the place. Nothing was executed. Either run a read-only command (inspect_instance, script_read, get_studio_state, total_debug, total_screenshot) or hand off first: ${alt}`;
  }

  // ── after every tool result (agentLoop) ──────────────────────────────────
  function afterTool(tool, args, feedback) {
    if (!active() || !S.role || !ROLES[S.role]) return feedback;
    const text = String(feedback || "");
    const failed = /^\s*ERROR\b/.test(text);
    const name = String(tool || "").replace(/^[^:]*:/, "");
    const kind = classify(name, args);
    const notes = S.notes.splice(0, S.notes.length);
    if (name === "total_agent" || name === "multi_agent") return notes.length ? text + "\n" + notes.join("\n") : text;

    if (kind === "mutate") {
      if (failed) {
        S.failStreak++;
        if (S.failStreak >= 2 && S.role !== "debugger") notes.push(`[CREW] ${S.failStreak} failed changes in a row as ${ROLES[S.role].title}. Hand off: total_agent {"role":"debugger","findings":["${clip(text.split("\n")[0].replace(/"/g, "'"), 100)}"],"task":"read the error, fix the cause"}.`);
      } else {
        S.failStreak = 0;
        S.edits++;
        S.editsSinceReview++;
        S.verified = false;
        if (S.plan.length && S.step && S.plan[S.step - 1] && S.plan[S.step - 1].status === "todo") S.plan[S.step - 1].status = "now";
        if (MUTATOR_ROLES.has(S.role) && S.editsSinceReview >= EDITS_BEFORE_REVIEW) {
          notes.push(`[CREW] ${S.editsSinceReview} changes since the last review. Hand off now: total_agent {"role":"reviewer","task":"review ${S.plan.length ? `step ${S.step}` : "the latest changes"}"}.`);
          S.editsSinceReview = 0;
        } else if (S.role === "debugger") {
          notes.push("[CREW] Fix applied — total_debug {} next, then total_agent {\"role\":\"tester\"} once the console is clean.");
        }
      }
    }

    const consoleTool = /^(total_debug|debug_run|debug_console|get_console_output)$/.test(name);
    if (consoleTool && !failed) {
      const clean = /Output is clean|no errors|0 error\(s\)/i.test(text) && !/\d+ error\(s\):/.test(text);
      const errorsFound = /\d+ error\(s\):/.test(text) || /\berror\b/i.test(text) && !clean;
      if (S.role === "tester") {
        if (clean) {
          S.verified = true;
          const left = S.plan.filter((p) => p.status !== "done").length;
          notes.push(left && S.plan.length
            ? `[CREW] Tester: console clean, run verified. ${left} plan step(s) still open — hand back: total_agent {"role":"builder"|"scripter","step":${Math.min(S.step + 1, S.plan.length)}} or mark them: total_agent {"role":"done","summary":"..."} with step_done.`
            : "[CREW] Tester: console clean, run verified. Finish: total_agent {\"role\":\"done\",\"summary\":\"what was built + what was checked\"}.");
        } else if (errorsFound) {
          notes.push("[CREW] Tester found errors — hand off: total_agent {\"role\":\"debugger\",\"findings\":[\"<first error above>\"]}.");
        }
      } else if (S.role === "reviewer") {
        notes.push(clean
          ? "[CREW] Reviewer: console clean. Finish the audit (inspect / script_lint / screenshot) and hand off: total_agent {\"role\":\"tester\",\"task\":\"playtest\"} or record findings for the debugger."
          : "[CREW] Reviewer: errors present — record them: total_agent {\"role\":\"debugger\",\"findings\":[\"...\"]}.");
      } else if (S.role === "debugger" && clean) {
        notes.push("[CREW] Debugger: console clean. Hand off: total_agent {\"role\":\"tester\",\"task\":\"re-run the playtest\"}.");
      }
    }
    if (kind === "play" && S.role === "tester" && /start_stop_play|play/.test(name) && !failed) {
      notes.push("[CREW] Tester: now read the result — get_console_output or total_debug {} (and total_screenshot {target:\"game\"} if visual).");
    }
    if (kind === "mutate" && !failed && (S.role === "planner" || S.role === "reviewer" || S.role === "tester")) {
      // Only reachable after an auto-promotion note; nothing extra to say.
    }
    if (notes.length) emit();
    return notes.length ? text + "\n" + notes.join("\n") : text;
  }

  // ── status surfaces ──────────────────────────────────────────────────────
  function stateTag() {
    if (!active()) return "OFF";
    const role = S.role || "unassigned";
    const prog = S.plan.length ? ` ${doneCount()}/${S.plan.length}` : "";
    return `ON:${role}${prog}${S.verified ? " verified" : ""}`;
  }
  function role() { return S.role; }
  function summary() {
    return {
      active: active(),
      role: S.role,
      role_title: S.role && ROLES[S.role] ? ROLES[S.role].title : "",
      goal: S.goal,
      plan: S.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`),
      step: S.step,
      findings: S.findings.map((f, i) => `${i + 1}. [${f.status}] ${f.text}`),
      verified: S.verified,
      edits: S.edits,
      handoffs: S.handoffs,
      history: S.history.slice(-8).map((h) => h.role + (h.task ? ": " + h.task : "")),
    };
  }
  function badge() {
    if (!active()) return { text: "", title: "" };
    const def = S.role && ROLES[S.role];
    const text = def ? def.badge : "CREW";
    const prog = S.plan.length ? ` · step ${Math.min(S.step || 1, S.plan.length)}/${S.plan.length}` : "";
    const title = def ? `Multi-Agent crew — ${def.title} is active${prog}${S.verified ? " · verified" : ""}` : "Multi-Agent crew on — waiting for the first total_agent handoff";
    return { text, title, role: S.role || "" };
  }

  // System-prompt block (config.js embeds this when Multi-Agent is on).
  function promptBlock() {
    return [
      "━━━ MULTI-AGENT (user enabled) ━━━",
      "You are a crew of specialists sharing one board. Hand off with total_agent {role, task, goal?, plan?:[...], step?, step_done?, findings?:[...], fixed?:[...], summary?}; the result shows the board (GOAL, PLAN with [x]/[>]/[ ], FINDINGS) and your brief.",
      "Roles: planner (read-only: GOAL + numbered PLAN with owners), builder (modeling/instances/UI, ONE mutating command per reply), scripter (Luau, ONE mutating command per reply), reviewer (read-only audit → FINDINGS), tester (start_stop_play + console + screenshot → verifies), debugger (total_debug first, smallest fix). done = finish.",
      "Rules: start as planner unless a role is already assigned. Read-only roles cannot mutate — the ROLE GUARD refuses and tells you how to hand off. Advance the plan with step:N / step_done:N. Every 4 changes, or when a step is complete, hand off to the reviewer; the reviewer hands to tester (clean) or debugger (findings). total_agent {role:\"done\"} is REFUSED until the tester verified a clean run after the last change and no findings are open — then report to the user.",
      "Never play several roles in one reply. [CREW] lines appended to results are the board talking: follow them.",
    ].join("\n");
  }

  return { ROLES, normalizeRole, classify, handoff, guard, afterTool, stateTag, summary, badge, role, reset, active, promptBlock, _state: S };
})();

try { if (typeof module !== "undefined" && module.exports) module.exports = TotalAgentCrew; } catch {}
try { globalThis.TotalAgentCrew = TotalAgentCrew; } catch {}
