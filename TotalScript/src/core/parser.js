// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/parser.js - RobloxScript command parsing. PURE string logic, zero DOM:
// the provider extracts a turn's text from the site's DOM; everything here
// operates on that text. The command formats (###LUA### blocks, {"command":…}
// JSON) are defined by OUR system prompt, so they are the same on every AI site
// - only the way a site's markdown may mangle them differs (the regexes below
// are whitespace/dash tolerant for that reason).
// eslint-disable-next-line no-unused-vars
const RSParse = (() => {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  // Whitespace-tolerant markers: site markdown can insert spaces around the
  // hashes (e.g. "### LUA ###") or render END_LUA with a dash. These regexes
  // match those variants so a marker mangled by markdown still parses.
  // The optional `:Edit|:Server|:Client` suffix selects the Roblox datamodel
  // execute_luau runs against (the MCP REQUIRES datamodel_type; a bare
  // ###LUA### defaults to "Edit" so the model never has to think about it
  // outside play-testing).
  // 1.99.8: a marker rendered as a markdown HEADING (`### LUA` alone on its
  // line, closer `### END_LUA`) is accepted too - the trailing hashes are what
  // a heading renderer eats first. Only end-of-line qualifies, never prose.
  const LUA_START_RE = /###\s*lua(?:\s*[:\-_ ]\s*(edit|client|server))?\s*(?:###|---|(?=[ \t]*\r?\n))/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*(?:###|(?=[ \t]*(?:\r?\n|$)))/i;
  const LUA_DEFAULT_DM = "Edit";
  const dmName = (m) => (m ? m[0].toUpperCase() + m.slice(1).toLowerCase() : LUA_DEFAULT_DM);

  // 1.81.0: plain-text command envelope - the non-JSON form for every command
  // that is not execute_luau (which already has ###LUA###). Grammar:
  //   ###CMD <name>###            opener: CMD | COMMAND | TOOL, then the exact
  //                               command name (letters, digits, _ . / -)
  //   key: value                  one parameter per line (":" or "=")
  //   key: <<<                    multi-line value: everything up to a line
  //   ...raw lines...             that is only ">>>" - no escaping inside
  //   >>>
  //   ###END_CMD###               closer (END_CMD | END_COMMAND | END_TOOL)
  // Values: true/false/null, numbers, "quoted strings", [arrays] and {objects}
  // are read as JSON; anything else is the literal text. A JSON object as the
  // whole body is accepted too. execute_luau may carry the raw code as its
  // body (no key lines) - the markers are whitespace/dash tolerant like LUA's.
  // No args → opener + closer only. A block with a stray line, an unterminated
  // heredoc or no closer is MALFORMED and never executes (parseToolCalls then
  // returns [] so the caller reports a parse error instead of running half).
  const CMD_START_RE = /###\s*(?:cmd|command|tool)\s*[:\s]\s*([A-Za-z_][A-Za-z0-9_.\/-]*)\s*(?:###|---)/i;
  const CMD_END_RE = /###\s*end[_\- ]?(?:cmd|command|tool)\s*(?:###|---)/i;
  const CMD_KEY_LINE_RE = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*[:=][ \t]?(.*)$/;
  const CMD_CHROME_LINE_RE = /^[ \t]*(?:```[\w-]*|~~~[\w-]*|Copy(?: code)?|json|yaml|text|lua|luau)[ \t]*$/i;
  function findCmdStart(text, from = 0) {
    const m = CMD_START_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length, name: m[1] } : { pos: -1, len: 0, name: "" };
  }
  function findCmdEnd(text, from = 0) {
    const m = CMD_END_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length } : { pos: -1, len: 0 };
  }
  function coerceCmdValue(raw) {
    const v = String(raw == null ? "" : raw).trim();
    if (v === "") return "";
    if (/^(?:true|false|null)$/i.test(v)) return v.toLowerCase() === "true" ? true : v.toLowerCase() === "false" ? false : null;
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)) return Number(v);
    if (/^[\[{]/.test(v)) { try { return parseLoose(v); } catch { return v; } }
    if (/^"[\s\S]*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
    return v;
  }
  // Parse one ###CMD### body into an arguments object; null when malformed.
  function parseCmdArgs(name, rawBody) {
    const lines = String(rawBody == null ? "" : rawBody).replace(/\r/g, "").split("\n");
    const meaningful = lines.filter((l) => l.trim() && !CMD_CHROME_LINE_RE.test(l));
    if (!meaningful.length) return {};
    const joined = meaningful.join("\n").trim();
    if (/^\{[\s\S]*\}$/.test(joined)) {
      try { const o = parseLoose(joined); if (o && typeof o === "object" && !Array.isArray(o)) return o; } catch {}
    }
    if (name === "execute_luau" && !meaningful.some((l) => /^[ \t]*(?:code|datamodel_type|datamodel)[ \t]*[:=]/.test(l))) {
      const code = stripCodeChrome(joined);
      return code ? { code, datamodel_type: LUA_DEFAULT_DM } : null;
    }
    const args = {};
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || CMD_CHROME_LINE_RE.test(line)) { i++; continue; }
      const m = CMD_KEY_LINE_RE.exec(line);
      if (!m) return null; // stray line: refuse rather than guess
      const key = m[1];
      if (/^<<<[ \t]*$/.test(m[2].trim()) || m[2].trim() === "<<<") {
        const buf = [];
        i++;
        while (i < lines.length && !/^[ \t]*>>>[ \t]*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i >= lines.length) return null; // unterminated heredoc
        const raw = buf.join("\n");
        // A heredoc that IS a JSON array/object (multi_edit edits, specs) is
        // decoded; anything else - code, prose - stays the literal text.
        let val = raw;
        if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(raw)) { try { val = parseLoose(raw.trim()); } catch { val = raw; } }
        args[key] = val;
        i++;
        continue;
      }
      args[key] = coerceCmdValue(m[2]);
      i++;
    }
    if (name === "execute_luau") {
      if (args.datamodel && !args.datamodel_type) { args.datamodel_type = args.datamodel; delete args.datamodel; }
      if (typeof args.code === "string") args.code = stripCodeChrome(args.code);
      if (!args.datamodel_type) args.datamodel_type = LUA_DEFAULT_DM;
    }
    return args;
  }
  // Next ###CMD### block at or after `from`: { call, start, end, malformed }.
  function nextCmdCall(text, from) {
    const s = findCmdStart(text, from);
    if (s.pos === -1) return null;
    const e = findCmdEnd(text, s.pos + s.len);
    if (e.pos === -1) return { call: null, start: s.pos, end: text.length - 1, name: s.name, malformed: "unclosed" };
    const args = parseCmdArgs(s.name, text.slice(s.pos + s.len, e.pos));
    if (!args) return { call: null, start: s.pos, end: e.pos + e.len - 1, name: s.name, malformed: "body" };
    return { call: { tool: s.name, arguments: args }, start: s.pos, end: e.pos + e.len - 1, name: s.name };
  }
  // Problems in the reply's ###CMD### blocks (for feedback text): [{name, reason}].
  function cmdBlockProblems(text) {
    text = normalizeTypography(text);
    const out = [];
    let pos = 0, guard = 0;
    while (guard++ < 32) {
      const n = nextCmdCall(text, pos);
      if (!n) break;
      if (n.malformed) out.push({ name: n.name, reason: n.malformed });
      pos = n.end + 1;
    }
    return out;
  }
  // Fenced ```lua / ```luau blocks that carry NO ###LUA### markers anywhere in
  // the reply. Such code is shown, never executed (by design - examples and
  // explanations must not run). Callers use the count to nudge the model once.
  function bareLuaFences(text) {
    text = normalizeTypography(text);
    if (!text || LUA_START_RE.test(text) || LUA_END_RE.test(text)) return 0;
    const m = text.match(/```[ \t]*luau?\b/gi);
    return m ? m.length : 0;
  }
  // Which command-like shapes a reply contains (diagnostics only - no content).
  function describeShapes(text) {
    const t = normalizeTypography(text);
    return {
      len: t.length,
      luaBlock: LUA_START_RE.test(t),
      luaCloserOnly: !LUA_START_RE.test(t) && LUA_END_RE.test(t),
      luaFence: bareLuaFences(t),
      cmdBlock: CMD_START_RE.test(t),
      json: CMD_KEY_RE.test(t),
      relaxed: relaxedShape(t),
      native: NATIVE_TOOL_RE.test(t),
      mcp: t.includes(START_M),
      fences: (t.match(/```/g) || []).length,
    };
  }
  // Format note for providers that run the plain-text protocol (no JSON
  // required). Kept next to the grammar so prompt and parser cannot drift.
  const PLAIN_FORMAT_NOTE = [
    "COMMAND FORMAT ON THIS SITE - plain text, no JSON needed. Put each command in its own fenced code block (a line with three backticks, the block, a line with three backticks) and write it in one of these two forms:",
    "1) Studio Luau (execute_luau):",
    "###LUA###",
    "local p = Instance.new(\"Part\")",
    "p.Name = \"Demo\"",
    "p.Parent = workspace",
    "return p:GetFullName()",
    "###END_LUA###",
    "(use ###LUA:Server### or ###LUA:Client### while the game is playing; bare ###LUA### is Edit mode.)",
    "2) Any other command - a CMD block: the exact command name in the opener, one \"key: value\" line per parameter, then the closer:",
    "###CMD inspect_instance###",
    "path: game.Workspace.Demo",
    "depth: 2",
    "###END_CMD###",
    "Values: plain text stays text; numbers, true/false, [lists] and {objects} are read as such; a multi-line value goes between a line \"key: <<<\" and a line \">>>\" (nothing is escaped inside). A command without parameters is just the opener and the closer.",
    "The JSON form {\"command\": \"name\", \"params\": {...}} is still accepted but never required. Up to 6 independent commands per reply, each in its own block, in the order they must run. Never escape backticks, quotes or braces with backslashes, never show a command as a quoted example or inline code, and never write a bare ```lua block without the ###LUA### markers - code without the markers is NOT executed.",
  ].join("\n");

  // Find the first LUA start marker at or after `from`. Returns { pos, len, dm }
  // where len is the marker's own length to skip past it and dm the requested
  // datamodel ("Edit" when unspecified).
  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length, dm: dmName(m[1]) } : { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }

  // Find the first LUA end marker at or after `from`. Returns its start index or -1.
  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(text.slice(from));
    return m ? from + m.index : -1;
  }

  // Strip a code-block UI label (the "Copy" button caption, or a leftover fence
  // language token like "json") that some sites bleed into the block's text
  // right after the opening marker. Seen live on Kimi: its code-block chrome
  // renders as `###lua### Copy <code>`, so the bare-marker slice below would
  // capture `Copy task.wait(...)` as the Lua code - not valid Lua, so StudioMCP
  // rejects it with "Failed to parse command code". The JSON path already does
  // this at line ~206; mirror it for the raw ###LUA### extraction. Requires
  // trailing whitespace (\s+) so it never eats a legitimate identifier like
  // `Copy(x)` that a script might genuinely start with.
  // Also handles the Notion/Vani shape where the marker is followed by a
  // newline and THEN the tag (`###LUA###\nlua\nprint(1)`) or by a full
  // markdown fence (```lua … ```): the old regex was anchored at ^ with no
  // leading-whitespace trim, so the `lua` line survived and reached Studio.
  function stripCodeChrome(code) {
    let out = String(code || "")
      .replace(/^[\u200B-\u200D\uFEFF\s]+/, "")
      .replace(/^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n/, "")
      .replace(/\r?\n[ \t]*```[ \t]*$/, "")
      // 1.99.8: bold-rendered markers (`**###LUA###**`) leave their closing
      // / opening asterisks on the block's first and last line.
      .replace(/^(?:\*\*|__)[ \t]*\r?\n/, "")
      .replace(/\r?\n[ \t]*(?:\*\*|__)[ \t]*$/, "")
      .replace(/^[\u200B-\u200D\uFEFF\s]+/, "");
    // Strip up to two stacked chrome tokens (`lua` + `Copy` is common).
    for (let i = 0; i < 2; i++) {
      out = out.replace(/^(?:json|copy|copy code|lua|luau|javascript|js|python|py|text)[ \t]*(?:\r?\n|\s+)/i, "");
    }
    // 1.99.8: a block handed over HTML-escaped (`a &lt; b`, `&quot;x&quot;`)
    // is decoded ONLY when the block has no raw < or > at all - mixed content
    // means the entities are the code's own text and must stay.
    if (/&(?:lt|gt|quot|amp|#39|#34);/.test(out) && !/[<>]/.test(out)) {
      out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    }
    return out;
  }

  // A command is `{"command":"name", ...}` (or "tool"). The params/arguments
  // object is OPTIONAL: paramless commands like list_commands are written as
  // `{"command":"list_commands"}`, so requiring "params" too would MISS them
  // (they'd be shown raw and never executed). We key on the `"command":"…"` /
  // `"tool":"…"` shape instead - a string-valued key, which prose almost never
  // contains - so paramless calls are detected without false-positiving on text.
  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;

  // 1.33: typographic normalisation. Rich-text hosts (Notion, Google-Docs-style
  // composers, some mobile keyboards) render the model's straight quotes as
  // curly ones ("path" -> “path”), pad JSON with non-breaking / zero-width
  // spaces and turn `-` into en-dashes inside code the model wrote as plain
  // text. JSON.parse then fails on a command that is visibly correct, and the
  // user sees "cannot get_children path". Fold the double quotes, the exotic
  // spaces and the invisible characters back to ASCII before any shape test or
  // parse. Apostrophes are left alone on purpose: a curly apostrophe inside a
  // Lua string literal ('don’t') is content, not syntax.
  const TYPO_DQUOTE_RE = /[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB\u301D\u301E\uFF02]/g;
  const TYPO_SPACE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  const TYPO_INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const TYPO_ANY_RE = /[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB\u301D\u301E\uFF02\u00A0\u2000-\u200A\u202F\u205F\u3000\u200B-\u200D\u2060\uFEFF]/;
  function normalizeTypography(text) {
    const t = String(text == null ? "" : text);
    if (!TYPO_ANY_RE.test(t)) return t;
    return t.replace(TYPO_DQUOTE_RE, '"').replace(TYPO_SPACE_RE, " ").replace(TYPO_INVISIBLE_RE, "");
  }

  // DeepSeek DSML envelope prefix. The canonical token is `<｜DSML｜invoke`, but
  // the web UI renders it with doubled bars and a space (`<｜｜DSML｜｜ invoke`),
  // some stacks use ASCII bars, and a few surfaces hand the text over
  // HTML-escaped (`&lt;｜DSML｜invoke`). One prefix covers all of them.
  const DSML_PFX = "(?:[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*)?";
  const LT = "(?:<|&lt;)\\s*";
  const GT = "(?:>|&gt;)";
  const DSML_CLOSE = LT + "\\/\\s*" + DSML_PFX;
  const NATIVE_TOOL_RE = new RegExp("<tool_call\\b|" + LT + DSML_PFX + "invoke\\b|<｜tool call begin｜>", "i");
  // Turn the escaped DSML spelling into the real one so the envelope parsers see
  // plain tags (entity-escaped values inside parameters are decoded separately).
  function unescapeDsml(text) {
    const t = String(text == null ? "" : text);
    if (!/&lt;\s*\/?\s*[｜|]{1,2}\s*DSML/i.test(t)) return t;
    return t.replace(/&lt;(\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*[\s\S]*?)&gt;/gi, "<$1>");
  }

  function hasToolSignature(r) {
    r = normalizeTypography(r);
    return (
      r.includes(START_M) ||
      r.includes("MCP_TOOL") ||
      LUA_START_RE.test(r) ||
      CMD_START_RE.test(r) ||
      CMD_KEY_RE.test(r) ||
      NATIVE_TOOL_RE.test(r) ||
      relaxedShape(r)
    );
  }

  // True if the reply contains a tool block that has STARTED but not yet CLOSED
  // (a ###LUA### / ###MCP_TOOL### opener with no matching end marker). Used by the
  // response watcher to avoid finalizing a command that is still being streamed.
  function hasOpenToolBlock(r) {
    r = normalizeTypography(r);
    if (!r) return false;
    const { pos: ls, len } = findLuaStart(r);
    if (ls !== -1 && findLuaEnd(r, ls + len) === -1) return true;
    const sm = r.indexOf(START_M);
    if (sm !== -1) {
      const low = r.toLowerCase();
      if (low.indexOf("###end_mcp_tool###", sm) === -1 && low.indexOf("###end-mcp_tool###", sm) === -1) return true;
    }
    // An inline JSON command ({"command"/"tool": …}) whose object has NOT closed yet
    // is still being streamed (a big multi_edit can take many seconds). Treat it as
    // open so the watcher keeps waiting instead of finalizing - and failing to parse -
    // half a command, which would drop the tool and end the turn as plain text.
    // 1.34: a reply may carry several commands - judge the LAST envelope (the
    // one that can still be streaming); every earlier one precedes it.
    for (const key of ['"command"', '"tool"']) {
      const k = r.lastIndexOf(key);
      if (k === -1) continue;
      const open = r.lastIndexOf("{", k);
      if (open !== -1 && matchBrace(r, open) === -1) return true;
    }
    // Likewise the LAST ###LUA### block: a closed first block must not hide a
    // second one that is still being written.
    const lastLua = (() => { let p = -1, from = 0; while (true) { const m = findLuaStart(r, from); if (m.pos === -1) return p; p = m.pos; from = m.pos + m.len; } })();
    if (lastLua !== -1) { const m = findLuaStart(r, lastLua); if (findLuaEnd(r, lastLua + m.len) === -1) return true; }
    // 1.81.0: the LAST ###CMD name### opener with no ###END_CMD### after it.
    const lastCmd = (() => { let p = null, from = 0; while (true) { const m = findCmdStart(r, from); if (m.pos === -1) return p; p = m; from = m.pos + m.len; } })();
    if (lastCmd && findCmdEnd(r, lastCmd.pos + lastCmd.len).pos === -1) return true;
    return false;
  }

  // Normalise a parsed JSON object into { tool, arguments }, accepting both the
  // new RobloxScript schema ("command"/"params") and the legacy/function-calling
  // schema ("tool"/"arguments"/"name"/"args"). Returns null if not a valid call.
  const FLAT_ENVELOPE_SKIP = new Set(["command", "tool", "params", "arguments", "args", "input", "reason", "reasoning", "explanation", "thought", "thoughts", "note", "notes", "comment", "description", "rationale", "why", "purpose", "id", "type"]);
  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
    let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
    if (typeof name !== "string" || !name) return null;
    // Some gateways JSON-encode the params object a second time. Dropping that
    // string to {} made a syntactically valid native call execute without its
    // required arguments and look like a parser failure.
    if (typeof args === "string") {
      try { args = parseLoose(args); } catch { return null; }
    }
    if (args == null) {
      // 1.99.8: flat envelopes - `{"command":"instance_rename","path":…,
      // "name":…}` - carry the parameters at the root. Adopt every other key
      // except the envelope's own / commentary ones; a bare {"command":"x"}
      // still yields {} exactly as before.
      args = {};
      for (const k of Object.keys(o)) {
        if (FLAT_ENVELOPE_SKIP.has(k) || (k === "name" && o.command == null && o.tool == null)) continue;
        args[k] = o[k];
      }
    }
    else if (typeof args !== "object" || Array.isArray(args)) return null;
    // Code written as an array of lines decodes to a string (seen on Gemini /
    // Qwen for long execute_luau bodies).
    for (const k of ["code", "source"]) {
      if (Array.isArray(args[k]) && args[k].length && args[k].every((x) => typeof x === "string")) args[k] = args[k].join("\n");
    }
    return { tool: name, arguments: args };
  }

  // String-aware matching-brace finder: index of the "}" that closes the "{" at
  // `start`, SKIPPING braces inside JSON string literals (escaped quotes handled).
  // A naive depth counter miscounts the braces embedded in code passed as a string
  // value (e.g. multi_edit's edits / a Lua snippet), grabs the wrong end, and makes
  // JSON.parse fail - which silently dropped the command, so the tool never ran and
  // the turn was treated as a plain-text answer. Returns -1 if unbalanced.
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  // JSON.parse with a fallback for RAW control characters inside string
  // literals (tab/newline/CR). Models sometimes emit a literal TAB instead of
  // \t inside a command's string value (seen live on Gemini in a big
  // multi_edit); strict JSON rejects it, the parse failed silently and the
  // command was never executed. The fallback walks the text string-aware and
  // escapes those characters ONLY inside string literals, then re-parses.
  function parseLoose(raw) {
    try {
      return JSON.parse(raw);
    } catch (e0) {
      let out = "", inStr = false, esc = false;
      for (const c of raw) {
        if (inStr) {
          if (esc) { esc = false; out += c; continue; }
          if (c === "\\") { esc = true; out += c; continue; }
          if (c === '"') { inStr = false; out += c; continue; }
          if (c === "\t") { out += "\\t"; continue; }
          if (c === "\n") { out += "\\n"; continue; }
          if (c === "\r") { out += "\\r"; continue; }
          out += c;
          continue;
        }
        if (c === '"') inStr = true;
        out += c;
      }
      try { return JSON.parse(out); } catch {}

      // Flash models occasionally leave a trailing comma before the closing
      // brace/bracket. Remove only commas outside strings whose next non-space
      // character is } or ]; never rewrite code or text inside a JSON string.
      let cleaned = "", quoted = false, escaped = false;
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (quoted) {
          cleaned += c;
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
          continue;
        }
        if (c === '"') { quoted = true; cleaned += c; continue; }
        if (c === ",") {
          let j = i + 1;
          while (j < out.length && /\s/.test(out[j])) j++;
          if (out[j] === "}" || out[j] === "]") continue;
        }
        cleaned += c;
      }
      try { return JSON.parse(cleaned); } catch {}
      // 1.99.8 repair stages (provider-output corpus, tests/parser-bench.js).
      // Each one only rewrites text OUTSIDE string literals or is gated on a
      // shape that valid JSON cannot have, so a correct command is never
      // altered. They run in order of how common the mangling is live:
      //  3. `// line` and `/* block */` comments between tokens (models annotate
      //     the envelope) and Python literals True/False/None (Gemini / Qwen
      //     when the model "thinks in Python") - then the trailing-comma pass.
      //  4. One level of double escaping (`\\"` everywhere, never a plain
      //     `\"`): the model JSON-encoded a JSON string a second time.
      //  5. A LAST string-valued property (code/source/text/…) written with
      //     RAW quotes and newlines inside - the single most frequent way an
      //     execute_luau / script_set_source envelope breaks. The value is
      //     bounded by the key and the closing braces at the very end, so it
      //     can be re-escaped without guessing where it stops.
      const scrubbed = scrubJsonTokens(cleaned);
      if (scrubbed !== cleaned) { try { return JSON.parse(scrubbed); } catch {} }
      if (/\\\\"/.test(scrubbed) && !/(^|[^\\])\\"/.test(scrubbed)) {
        const once = scrubbed.replace(/\\\\(["\\\/bfnrtu])/g, "\\$1");
        try { return JSON.parse(once); } catch {}
      }
      const repaired = repairRawStringValue(scrubbed);
      if (repaired !== null) return JSON.parse(repaired); // may still throw - callers deliberately catch
      return JSON.parse(cleaned);                          // rethrow the original failure
    }
  }
  // Stage 3 helper: walk `src` outside string literals; drop // and /* */
  // comments, map True/False/None → true/false/null, then drop commas that sit
  // right before a closing } or ]. Inside strings nothing is touched.
  function scrubJsonTokens(src) {
    let out = "", inStr = false, esc = false, i = 0;
    while (i < src.length) {
      const c = src[i];
      if (inStr) {
        out += c;
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl; continue; }
      if (c === "/" && src[i + 1] === "*") { const ce = src.indexOf("*/", i + 2); i = ce === -1 ? src.length : ce + 2; continue; }
      if (/[A-Za-z]/.test(c) && !/[A-Za-z0-9_]/.test(src[i - 1] || "")) {
        const m = /^(True|False|None)(?![A-Za-z0-9_])/.exec(src.slice(i, i + 6));
        if (m) { out += m[1] === "True" ? "true" : m[1] === "False" ? "false" : "null"; i += m[1].length; continue; }
      }
      if (c === ",") {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === "}" || src[j] === "]") { i++; continue; }
      }
      out += c; i++;
    }
    return out;
  }
  // Stage 5 helper. Finds the LAST `"<key>": "` for a code-carrying key and
  // the LAST `"` that is followed only by closers (`}` / `]` / whitespace) up
  // to the end; re-escapes the raw text between them (bare `"` → \", raw
  // newline/tab/CR → escapes, a backslash that does not start a JSON escape →
  // doubled). Returns null when the shape is not there, so nothing else is
  // ever rewritten.
  const RAW_VALUE_KEYS = /"(code|source|text|content|script|luau|lua|body|new|replace|find|old|query|message|value)"\s*:\s*"/g;
  function repairRawStringValue(src) {
    let m, last = null;
    RAW_VALUE_KEYS.lastIndex = 0;
    while ((m = RAW_VALUE_KEYS.exec(src))) last = m;
    if (!last) return null;
    const vStart = last.index + last[0].length;
    const tail = src.slice(vStart);
    const endRel = tail.search(/"[\s}\]]*$/);
    if (endRel === -1) return null;
    let raw = tail.slice(0, endRel), rest = "";
    const closers = tail.slice(endRel + 1);
    if (!/^[\s}\]]*$/.test(closers)) return null;
    // Properties AFTER the broken value (`…", "datamodel_type": "Server"`)
    // stay JSON: split at the last `", "key":` boundary inside the raw span.
    const after = /",\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:(?![\s\S]*",\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:)/.exec(raw);
    if (after) { rest = raw.slice(after.index); raw = raw.slice(0, after.index); }
    let fixed = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\\") {
        const n = raw[i + 1] || "";
        if (/["\\\/bfnrtu]/.test(n)) { fixed += c + n; i++; }
        else fixed += "\\\\";
      }
      else if (c === '"') fixed += '\\"';
      else if (c === "\n") fixed += "\\n";
      else if (c === "\r") fixed += "\\r";
      else if (c === "\t") fixed += "\\t";
      else fixed += c;
    }
    if (fixed === raw) return null;
    return src.slice(0, vStart) + fixed + rest + '"' + closers;
  }

  function extractJson(raw) {
    raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(raw, s);            // string-aware: not the last "}" in code
    if (e === -1) return null;
    try {
      return parseLoose(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  // ── 1.78.1 "shown, not fenced" commands ──────────────────────────────────
  // Reported live on Vani (logged-in account): the model SHOWS the command as
  // plain text instead of writing a real fence - the page then renders visible
  // backticks and the raw reply carries the command in a shape the strict
  // scanner (CMD_KEY_RE: "command" in double quotes) does not accept:
  //   \`\`\`json {\"command\":\"x\",\"params\":{}} \`\`\`      markdown-escaped
  //   {'command':'x','params':{}}                            single quotes
  //   {command:"x", params:{}}                               JS object literal
  //   {&quot;command&quot;:&quot;x&quot;}                    HTML entities
  //   {"command":"list\_commands"}                           escaped underscore
  // The relaxed pass normalises those into strict JSON and runs the SAME strict
  // scanner again. It never parses looser than that: no brace span, no key in
  // one of the shapes above → nothing. Only consulted when the strict pass found
  // no command at all.
  const RELAXED_KEY_RE = /\\"(?:command|tool)\\"\s*:\s*\\"|'(?:command|tool)'\s*:\s*['"]|&quot;(?:command|tool)&quot;\s*:\s*&quot;|[{,]\s*(?:command|tool)\s*:\s*["']/i;
  const ESC_EVIDENCE_RE = /\\"(?:command|tool)\\"|\\`|\\_|\\\{|\\\*/;
  const MD_ESCAPE_RE = /\\([\\"'`{}\[\]_*#~|<>])/g;
  function decodeEntities(t) {
    if (!/&(?:quot|#34|#x22|#39|apos|#x27|lt|gt|amp);/i.test(t)) return t;
    return t.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&apos;|&#x27;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
  }
  // Matching brace that skips both "…" and '…' string literals.
  function matchBraceLoose(text, start) {
    let depth = 0, q = "", esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === q) q = "";
      } else if (c === '"' || c === "'") q = c;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }
  // One brace span: single-quoted strings → double-quoted, bare object keys →
  // quoted, literal "\n" / "\t" between tokens → whitespace. Returns the strict
  // span, or null when nothing changed.
  function strictifySpan(span) {
    let out = "", i = 0, changed = false;
    while (i < span.length) {
      const c = span[i];
      if (c === '"') {
        let j = i + 1; out += c;
        while (j < span.length) { const d = span[j]; out += d; if (d === "\\") { out += span[j + 1] || ""; j += 2; continue; } j++; if (d === '"') break; }
        i = j; continue;
      }
      if (c === "'") {
        changed = true; let j = i + 1, str = '"';
        while (j < span.length) {
          const d = span[j];
          if (d === "\\") { const n = span[j + 1]; str += n === "'" ? "'" : d + (n || ""); j += 2; continue; }
          if (d === "'") break;
          str += d === '"' ? '\\"' : d; j++;
        }
        out += str + '"'; i = j + 1; continue;
      }
      if (c === "\\" && (span[i + 1] === "n" || span[i + 1] === "t" || span[i + 1] === "r")) { out += span[i + 1] === "n" ? "\n" : " "; changed = true; i += 2; continue; }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i; while (j < span.length && /[\w$]/.test(span[j])) j++;
        const word = span.slice(i, j);
        let k = j; while (k < span.length && /[ \t\r\n]/.test(span[k])) k++;
        const prev = out.replace(/[ \t\r\n]+$/, "").slice(-1);
        if (span[k] === ":" && (prev === "{" || prev === ",")) { out += '"' + word + '"'; changed = true; } else out += word;
        i = j; continue;
      }
      out += c; i++;
    }
    return changed ? out : null;
  }
  // A command key in one of the relaxed spellings (entity-encoded strict JSON included).
  function relaxedShape(t) {
    const d = decodeEntities(String(t == null ? "" : t));
    return RELAXED_KEY_RE.test(d) || (d !== t && CMD_KEY_RE.test(d));
  }
  // Returns the normalised text, or null when the reply has none of the shapes.
  function relaxCommandText(text) {
    const t = normalizeTypography(text);
    if (!t) return null;
    let r = decodeEntities(t);
    if (ESC_EVIDENCE_RE.test(r)) r = r.replace(MD_ESCAPE_RE, "$1");
    if (!RELAXED_KEY_RE.test(r) && !CMD_KEY_RE.test(r)) return r !== t ? r : null;
    const keyRe = /"(?:command|tool)"\s*:|'(?:command|tool)'\s*:|[{,]\s*(?:command|tool)\s*:/gi;
    let m, guard = 0;
    while ((m = keyRe.exec(r)) && guard++ < 8) {
      const start = r.lastIndexOf("{", m.index + (m[0][0] === "{" ? 0 : m[0].length));
      if (start === -1) continue;
      const end = matchBraceLoose(r, start);
      if (end === -1) continue;
      const strict = strictifySpan(r.slice(start, end + 1));
      if (strict) { r = r.slice(0, start) + strict + r.slice(end + 1); keyRe.lastIndex = start + strict.length; }
      else keyRe.lastIndex = end + 1;
    }
    return r !== t ? r : null;
  }

  function extractToolAnywhere(text) {
    for (const key of ['"command"', '"tool"']) {
      let pos = 0;
      while (true) {
        const s = text.indexOf(key, pos);
        if (s === -1) break;
        const start = text.lastIndexOf("{", s);
        if (start === -1) { pos = s + 1; continue; }
        const end = matchBrace(text, start); // string-aware brace matching
        if (end === -1) { pos = s + 1; continue; }
        try {
          const call = normalizeCall(parseLoose(text.slice(start, end + 1)));
          if (call) return call;
        } catch {}
        pos = s + 1;
      }
    }
    return null;
  }

  // Some OpenAI-compatible models ignore the visible-response schema and emit
  // their native function envelope instead:
  //   {"name":"list_commands","arguments":{}}
  //   <tool_call>{"toolName":"get_studio_state","parameters":{}}</tool_call>
  // Keep this separate from parseToolCalls: callers must gate the parsed name
  // against the live tool catalogue before executing it, which prevents an
  // arbitrary prose JSON object with a "name" field from becoming a command.
  function normalizeAlternateCall(value, wrapped = false) {
    if (!value || typeof value !== "object") return null;
    if (value.function && typeof value.function === "object") return normalizeAlternateCall(value.function, true);
    const name = value.toolName != null ? value.toolName
      : value.tool_name != null ? value.tool_name
      : typeof value.function === "string" ? value.function
      : value.action != null ? value.action
      : value.name;
    const hasArgs = value.arguments != null || value.args != null || value.parameters != null || value.input != null || value.params != null;
    if (!wrapped && value.toolName == null && value.tool_name == null && typeof value.function !== "string" && value.action == null && !hasArgs) return null;
    if (typeof name !== "string" || !name.trim()) return null;
    let args = value.arguments != null ? value.arguments
      : value.args != null ? value.args
      : value.parameters != null ? value.parameters
      : value.input != null ? value.input
      : value.params;
    if (typeof args === "string") {
      try { args = parseLoose(args); } catch { return null; }
    }
    if (args == null) args = {};
    else if (typeof args !== "object" || Array.isArray(args)) return null;
    return { tool: name.trim(), arguments: args };
  }

  function parseAlternateToolCalls(text) {
    text = unescapeDsml(normalizeTypography(text));
    const out = [];
    const seen = new Set();
    const add = (call) => {
      if (!call) return;
      const sig = call.tool + "\n" + JSON.stringify(call.arguments || {});
      if (!seen.has(sig)) { seen.add(sig); out.push(cleanLuaCall(call)); }
    };
    const decodeEntities = (value) => String(value || "")
      .replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
    const nativeValue = (raw, forceString) => {
      const value = decodeEntities(raw).trim();
      if (forceString === true) return value;
      try { return parseLoose(value); } catch {}
      if (forceString === false) {
        if (value === "true") return true;
        if (value === "false") return false;
        if (value === "null") return null;
        if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
      }
      return value;
    };

    // Explicit XML-ish function wrapper. Some model families does not share
    // one native tool grammar:
    //   Hermes/OpenAI: <tool_call>{"name":"...","arguments":{}}</tool_call>
    //   GLM 5.x:      <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
    //   MiMo 2.6:     <tool_call><function=name><parameter=k>v</parameter></tool_call>
    // A paramless name is important here: list_commands is the bootstrap call.
    // Callers catalogue-gate every result of this function before execution.
    const tagRe = /<tool_call\b[^>]*>([\s\S]*?)(?:<\/tool_call>|$)/gi;
    let tag;
    while ((tag = tagRe.exec(text))) {
      const body = tag[1].trim();
      const parsed = extractJson(body);
      add(normalizeAlternateCall(parsed, true));

      let name = "";
      const mimo = /<function\s*=\s*["']?([^\s"'>]+)["']?\s*>/i.exec(body);
      if (mimo) name = mimo[1];
      if (!name) {
        // GLM's function name is the literal text immediately after the opener.
        const glm = /^\s*([A-Za-z_][\w./-]*)\s*(?=<arg_key\b|<\/tool_call>|$)/i.exec(body);
        if (glm) name = glm[1];
      }
      if (name) {
        const args = {};
        const glmArg = /<arg_key\b[^>]*>([\s\S]*?)<\/arg_key>\s*<arg_value\b[^>]*>([\s\S]*?)<\/arg_value>/gi;
        let pair;
        while ((pair = glmArg.exec(body))) args[decodeEntities(pair[1]).trim()] = nativeValue(pair[2]);
        // MiMo/Qwen XML appears both as <parameter=name> and
        // <parameter name="name" string="false">.
        const mimoArg = /<parameter(?:\s*=\s*["']?([^\s"'>]+)["']?|\s+name\s*=\s*["']?([^\s"'>]+)["']?)([^>]*)>([\s\S]*?)<\/parameter>/gi;
        while ((pair = mimoArg.exec(body))) {
          const attrs = pair[3] || "";
          const stringAttr = /\bstring\s*=\s*["']?(true|false)/i.exec(attrs);
          args[pair[1] || pair[2]] = nativeValue(pair[4], stringAttr ? stringAttr[1].toLowerCase() === "true" : undefined);
        }
        add({ tool: decodeEntities(name), arguments: args });
      }
    }

    // DeepSeek V4 DSML. Accept the single- and double-fullwidth-bar spellings
    // seen from different serving stacks, plus a missing outer tool_calls block.
    const dsmlInvoke = new RegExp(LT + DSML_PFX + "invoke\\b[^>]*\\b(?:name|tool)\\s*=\\s*[\"']?([^\\s\"'>]+)[\"']?[^>]*>([\\s\\S]*?)(?:" + DSML_CLOSE + "invoke\\s*" + GT + "|(?=" + LT + DSML_PFX + "invoke\\b)|(?=" + DSML_CLOSE + "(?:function_|tool_)?calls\\s*" + GT + ")|$)", "gi");
    let invoke;
    while ((invoke = dsmlInvoke.exec(text))) {
      const args = {};
      const param = new RegExp(LT + DSML_PFX + "(?:param|parameter)\\b[^>]*\\bname\\s*=\\s*[\"']?([^\\s\"'>]+)[\"']?([^>]*)>([\\s\\S]*?)" + DSML_CLOSE + "(?:param|parameter)\\s*" + GT, "gi");
      let p;
      while ((p = param.exec(invoke[2]))) {
        const stringAttr = /\bstring\s*=\s*["']?(true|false)/i.exec(p[2] || "");
        args[p[1]] = nativeValue(p[3], stringAttr ? stringAttr[1].toLowerCase() === "true" : undefined);
      }
      add({ tool: decodeEntities(invoke[1]), arguments: args });
    }

    // DeepSeek's older native-token spelling occasionally leaks through an
    // OpenAI-compatible stream as visible content rather than structured calls.
    const tokenCall = /<｜tool call begin｜>\s*(?:function\s*=\s*)?([A-Za-z_][\w./-]*)\s*<｜tool sep｜>([\s\S]*?)(?:<｜tool call end｜>|$)/gi;
    let token;
    while ((token = tokenCall.exec(text))) {
      let args;
      try { args = parseLoose(token[2].trim()); } catch { continue; }
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      add({ tool: token[1], arguments: args });
    }

    const keys = ['"toolName"', '"tool_name"', '"function"', '"action"', '"name"'];
    for (const key of keys) {
      let pos = 0;
      while (true) {
        const at = text.indexOf(key, pos);
        if (at === -1) break;
        const start = text.lastIndexOf("{", at);
        if (start === -1) { pos = at + key.length; continue; }
        const end = matchBrace(text, start);
        if (end === -1) { pos = at + key.length; continue; }
        try { add(normalizeAlternateCall(parseLoose(text.slice(start, end + 1)), false)); } catch {}
        pos = Math.max(at + key.length, end + 1);
      }
    }
    return out;
  }

  function parseToolCalls(r, _relaxed) {
    r = normalizeTypography(r);
    // Lowercase for case-insensitive end-marker search. Models write
    // ###end_mcp_tool### (underscore) or ###end-mcp_tool### (dash).
    const rLow = r.toLowerCase();
    const findEndM = (from) => {
      const a = rLow.indexOf("###end_mcp_tool###", from);
      const b = rLow.indexOf("###end-mcp_tool###", from);
      if (a === -1 && b === -1) return -1;
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    };
    const out = [];
    let from = 0;
    while (true) {
      const sm = r.indexOf(START_M, from);
      if (sm === -1) break;
      const em = findEndM(sm);
      if (em === -1) break;
      const body = r.slice(sm + START_M.length, em);
      const { pos: ls, len: luaLen, dm } = findLuaStart(body);
      const le = findLuaEnd(body, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(body.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
        from = em + END_M.length;
        continue;
      }
      for (const sub of body.split(START_M)) {
        const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
        if (!cleaned) continue;
        const p = normalizeCall(extractJson(cleaned));
        if (p) out.push(p);
      }
      from = em + END_M.length;
    }
    // No ###MCP_TOOL### envelope: walk the reply and collect EVERY command in
    // document order - JSON envelopes ({"command":…}) and bare ###LUA### blocks
    // alike. Before 1.34 this returned only the FIRST one, so a reply carrying
    // two commands silently dropped the second while the model believed both
    // had run. A JSON envelope that wraps execute_luau with the markers INSIDE
    // its code string is taken as JSON (extractJsonAt JSON-decodes it; the
    // ###LUA### markers inside the string are skipped, cleanLuaCall strips them).
    if (out.length === 0) {
      let pos = 0;
      while (pos < r.length) {
        const j = nextJsonCall(r, pos);
        const { pos: ls, len: luaLen, dm } = findLuaStart(r, pos);
        const le = ls === -1 ? -1 : findLuaEnd(r, ls + luaLen);
        const luaOk = ls !== -1 && le !== -1 && le > ls;
        // 1.81.0: ###CMD name### plain-text blocks take part in the same
        // document-order walk. One malformed block voids the WHOLE reply: the
        // caller then reports a parse error and nothing runs half-batched.
        const c = nextCmdCall(r, pos);
        if (!j && !luaOk && !c) break;
        const jAt = j ? j.start : Infinity, lAt = luaOk ? ls : Infinity, cAt = c ? c.start : Infinity;
        if (cAt <= jAt && cAt <= lAt) {
          if (c.malformed) return [];
          out.push(c.call);
          pos = c.end + 1;
        } else if (jAt <= lAt) {
          out.push(j.call);
          pos = j.end + 1;
        } else {
          out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(r.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
          pos = le + 1;
        }
      }
    }
    // 1.78.1: nothing strict - try the "shown, not fenced" normalisation once.
    if (out.length === 0 && !_relaxed) {
      const rx = relaxCommandText(r);
      if (rx) return parseToolCalls(rx, true);
    }
    return out.map(cleanLuaCall);
  }

  // First parseable {"command"/"tool": …} envelope at or after `from`, with its
  // span, so parseToolCalls can continue scanning behind it.
  function nextJsonCall(text, from) {
    let best = null;
    for (const key of ['"command"', '"tool"']) {
      let pos = from;
      while (true) {
        const s = text.indexOf(key, pos);
        if (s === -1) break;
        // 1.99.8: the key is not always the FIRST property - `{"params":{…},
        // "command":"x"}` puts a closed params object between the opener and
        // the key, so the nearest "{" is the wrong one. Step back through up to
        // 4 earlier openers before giving this occurrence up.
        let start = text.lastIndexOf("{", s), call = null, end = -1;
        for (let back = 0; back < 4 && start !== -1 && start >= from; back++) {
          end = matchBrace(text, start); // string-aware brace matching
          // Odd raw quotes inside a code value leave matchBrace "open" even
          // though the envelope visibly ends in }} - try the last closer and
          // let parseLoose's raw-string repair decide (it refuses anything
          // that is not that exact shape).
          if (end !== -1) { try { call = normalizeCall(parseLoose(text.slice(start, end + 1))); } catch {} }
          else {
            // Candidates: a "}" that ENDS its line (only spaces / fence
            // backticks after it) - the envelope's visible end - nearest first,
            // so a second command further down is never swallowed.
            let tries = 0;
            for (let e = text.indexOf("}", s); e !== -1 && tries < 3; e = text.indexOf("}", e + 1)) {
              if (!/^[ \t`]*(?:\r?\n|$)/.test(text.slice(e + 1, e + 12))) continue;
              tries++;
              try { call = normalizeCall(parseLoose(text.slice(start, e + 1))); } catch {}
              if (call) { end = e; break; }
            }
          }
          if (call) break;
          start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
        }
        if (call) { if (!best || start < best.start) best = { call, start, end }; break; }
        pos = s + 1;
      }
    }
    return best;
  }

  // Some models (seen live on GLM) wrap execute_luau in the JSON envelope AND
  // keep the ###LUA### / ###END_LUA### markers INSIDE the code string, e.g.
  //   {"command":"execute_luau","params":{"code":"###LUA###\n<lua>\n###END_LUA###"}}
  // Once JSON-decoded the code still starts with the literal markers, which the
  // MCP rejects ("Failed to parse command code"). Strip a leading start marker
  // and a trailing end marker from execute_luau's code, and adopt the marker's
  // datamodel when none was given. No-op for a clean code string.
  function cleanLuaCall(call) {
    if (!call || call.tool !== "execute_luau") return call;
    const code = call.arguments && call.arguments.code;
    if (typeof code !== "string") return call;
    const s = findLuaStart(code);
    if (s.pos === -1) {
      // No markers, but the same chrome can still be there (```lua fence or a
      // `lua`/`Copy` line pasted into the JSON string) - normalise it too.
      call.arguments.code = stripCodeChrome(code);
      return call;
    }
    const e = findLuaEnd(code, s.pos + s.len);
    call.arguments.code = stripCodeChrome(code.slice(s.pos + s.len, e === -1 ? code.length : e).trim());
    if (!call.arguments.datamodel_type) call.arguments.datamodel_type = s.dm;
    return call;
  }

  // Last-resort salvage of a CUT-OFF JSON command: the model hit its output
  // limit with the whole payload complete but the trailing closers missing
  // (seen live on Qwen: a big multi_edit missing exactly ONE final "}").
  // Strictly conservative - we only auto-close when it is provably just the
  // closing sequence that was lost, never when actual content was amputated:
  //  - the scan must NOT end inside a string literal (a value cut mid-string
  //    means real content is missing → keep the parse_error);
  //  - the last non-whitespace char must terminate a complete JSON value
  //    (`"`, `}`, `]`, digit, or the tail of true/false/null);
  //  - at most MAX_SALVAGE_CLOSERS closers may be appended. 2 covers the
  //    root-brace and params-brace cases; a deeper deficit usually means the
  //    cut fell between items (e.g. mid-edits-array), where running a partial
  //    command would be dangerous - the retry feedback stays the right call.
  // Callers must only invoke this once generation has ENDED (the watcher's
  // parse_error branch), never on a still-streaming reply.
  const MAX_SALVAGE_CLOSERS = 2;
  function salvageCutOff(text) {
    text = normalizeTypography(text);
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const start = text.lastIndexOf("{", k);
      if (start === -1) continue;
      if (matchBrace(text, start) !== -1) continue; // closed → not our case
      // String-aware bracket stack from the opener to the end of the text.
      const stack = [];
      let inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") stack.push("}");
        else if (c === "[") stack.push("]");
        else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return null; // mismatched nesting → hopeless
        }
      }
      if (inStr) return null;                       // cut mid-string value
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      if (!/["}\]0-9]$|(?:true|false|null)$/.test(body)) return null; // value incomplete
      try {
        const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
        if (call) return cleanLuaCall(call);
      } catch {}
      return null;
    }
    return null;
  }

  function toolNameFromText(txt) {
    txt = normalizeTypography(txt);
    // Match the name even BEFORE its closing quote (`[^"]*`), so the chip shows
    // the real command name AS IT IS TYPED instead of a generic "command"
    // placeholder until the JSON closes. A still-empty value falls through.
    // Trim: while the value is still streaming it can be whitespace-only (e.g.
    // Kimi renders `"tool": "    "` for a beat), which would otherwise show a
    // blank chip label until the loop repaints it. A whitespace value falls
    // through to the placeholder below instead.
    const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
    if (m && m[1].trim()) return m[1].trim();
    // 1.78.1: escaped / single-quoted / bare-key / entity-encoded spellings.
    const dec = decodeEntities(txt);
    const rx = dec.match(/"(?:command|tool)"\s*:\s*"([^"]*)|\\"(?:command|tool)\\"\s*:\s*\\"((?:[^"\\]|\\_)*)|'(?:command|tool)'\s*:\s*['"]([^'"]*)|[{,]\s*(?:command|tool)\s*:\s*["']([^"']*)/);
    if (rx) { const v = (rx[1] || rx[2] || rx[3] || rx[4] || "").replace(/\\_/g, "_").trim(); if (v) return v; }
    const native = txt.match(new RegExp(LT + DSML_PFX + "invoke\\b[^>]*(?:name|tool)\\s*=\\s*[\"']?([^\\s\"'>]+)", "i"))
      || txt.match(/<function\s*=\s*["']?([^\s"'>]+)/i)
      || txt.match(/<tool_call\b[^>]*>\s*([A-Za-z_][\w./-]*)/i)
      || txt.match(/<｜tool call begin｜>\s*(?:function\s*=\s*)?([A-Za-z_][\w./-]*)/i);
    if (native && native[1]) return native[1].trim();
    const cmd = CMD_START_RE.exec(txt);
    if (cmd && cmd[1]) return cmd[1].trim();
    if (txt.includes("execute_luau") || LUA_START_RE.test(txt)) return "execute_luau";
    return "command";
  }

  // A turn the EXTENSION injected (always sent as a user turn): a tool result, an
  // ERROR, or a "(System note: …)" control message. Matched ONLY by the fixed
  // shapes we emit - never by command-like keywords, since a parse-error note
  // quotes a {"command": …} example that must NOT be read as a real command.
  function isInjectedFeedback(txt) {
    return /^\s*Output of '/.test(txt) ||
           /^\s*ERROR\b/.test(txt) ||
           /^\s*\(System note:/.test(txt);
  }

  // The assistant emitted a RobloxScript command (JSON or a ###LUA### block).
  function hasCommandShape(txt) {
    txt = normalizeTypography(txt);
    return txt.includes(START_M) ||
           LUA_START_RE.test(txt) ||
           CMD_START_RE.test(txt) ||
           CMD_KEY_RE.test(txt) ||
           NATIVE_TOOL_RE.test(txt) || // includes model-native tool envelopes
           relaxedShape(txt); // 1.78.1: "shown, not fenced" shapes
  }

  return {
    START_M, END_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, NATIVE_TOOL_RE, unescapeDsml,
    CMD_START_RE, CMD_END_RE, findCmdStart, findCmdEnd, parseCmdArgs, cmdBlockProblems, bareLuaFences, describeShapes, PLAIN_FORMAT_NOTE,
    findLuaStart, findLuaEnd, matchBrace, extractJson, normalizeCall,
    hasToolSignature, hasOpenToolBlock, parseToolCalls, parseAlternateToolCalls, salvageCutOff, toolNameFromText,
    isInjectedFeedback, hasCommandShape, normalizeTypography,
    relaxCommandText, RELAXED_KEY_RE,
  };
})();
