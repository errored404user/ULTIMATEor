// Static Luau sanity check for every virtual Studio command (run: node tests/test-luau-syntax.js).
//
// Every studio_* skill is a JavaScript generator that emits a Luau program for
// Studio's execute_luau. Nothing in the repo could compile that Luau, so a
// single missing `end` or an unescaped "\n" inside a Lua string silently broke
// EVERY command that shares the generated library (seen in 1.21.1: three such
// bugs in SKILLS_LIB_LUA took all 33 core skills down with "Malformed string" /
// "Expected 'end'"). This test generates each command with schema-derived
// arguments and with no arguments, then checks:
//   * the generator returns {code} or a clean {err} (never throws / undefined)
//   * no quoted Lua string contains a raw newline
//   * function/if/do/repeat blocks and (), [], {} are balanced
//   * no catalogue name is advertised twice with conflicting parameters
const fs = require("fs");
const vm = require("vm");

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
const files = bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = typeof RobloxScriptSkills !== "undefined" ? RobloxScriptSkills : null; // script-scope global from the vm scripts

let failed = 0;
const ok = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); if (!cond) failed++; };

function sample(p) {
  const t = String(p.type || "").toLowerCase();
  if (/\[\]|array|list/.test(t)) return /number|num/.test(t) ? [1, 2, 3] : ["a", "b"];
  if (/number|int|float/.test(t)) return 1;
  if (/bool/.test(t)) return true;
  if (/object|dict|map|json/.test(t)) return { a: 1 };
  return (p.enum && p.enum[0]) || (p.desc && /path/i.test(p.desc) ? "Workspace.Part" : "Test");
}

// Blank out comments and strings; keep newlines so line numbers survive.
// Returns {text, brokenStringLine} where brokenStringLine is the first quoted
// string that hits a newline before its closing quote.
function strip(code) {
  let out = "", i = 0, broken = 0, line = 1;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "\n") line++;
    if (c === "-" && code[i + 1] === "-") {
      const m = /^--\[(=*)\[/.exec(code.slice(i, i + 12));
      if (m) { const close = "]" + m[1] + "]"; const j = code.indexOf(close, i + m[0].length); const end = j < 0 ? n : j + close.length; out += code.slice(i, end).replace(/[^\n]/g, " "); line += (code.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
      while (i < n && code[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== "\n") { if (code[j] === "\\") j++; j++; }
      if (code[j] === "\n" || j >= n) { if (!broken) broken = line; }
      out += '""'; i = j + 1; continue;
    }
    if (c === "[") {
      const m = /^\[(=*)\[/.exec(code.slice(i, i + 12));
      if (m) { const close = "]" + m[1] + "]"; const j = code.indexOf(close, i + m[0].length); const end = j < 0 ? n : j + close.length; out += '""' + code.slice(i, end).replace(/[^\n]/g, ""); line += (code.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
    }
    out += c; i++;
  }
  return { text: out, brokenStringLine: broken };
}

function problems(code) {
  const { text, brokenStringLine } = strip(code);
  const out = [];
  if (brokenStringLine) out.push(`raw newline inside a quoted string near line ${brokenStringLine}`);
  const toks = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*|""|\.\.|[()\[\]{}=,]/g) || [];
  let blk = 0, par = 0, brk = 0, brc = 0, prev = "";
  for (const t of toks) {
    if (t === "function" || t === "do" || t === "repeat") blk++;
    // Luau if-expressions (`x = if c then a else b`) have no `end`.
    else if (t === "if") { if (!/^(=|\(|,|return|\.\.|\{|\[)$/.test(prev)) blk++; }
    else if (t === "end" || t === "until") blk--;
    else if (t === "(") par++; else if (t === ")") par--;
    else if (t === "[") brk++; else if (t === "]") brk--;
    else if (t === "{") brc++; else if (t === "}") brc--;
    if (blk < 0 || par < 0 || brk < 0 || brc < 0) { out.push(`closes more than it opens at '${t}'`); break; }
    prev = t;
  }
  if (blk > 0) out.push(`${blk} unclosed block(s) (missing 'end')`);
  if (par) out.push(`parentheses off by ${par}`);
  if (brk) out.push(`brackets off by ${brk}`);
  if (brc) out.push(`braces off by ${brc}`);
  return out;
}

ok("skills loaded", S && Array.isArray(S.SKILL_COMMANDS) && S.SKILL_COMMANDS.length > 500, S && String(S.SKILL_COMMANDS && S.SKILL_COMMANDS.length));
const names = S.SKILL_COMMANDS.map((c) => c.name);
const dups = names.filter((n, i) => names.indexOf(n) !== i);
ok("no duplicate catalogue names", dups.length === 0, dups.join(", "));

let generated = 0, bad = [];
for (const c of S.SKILL_COMMANDS) {
  const args = {};
  for (const [k, p] of Object.entries(c.params || {})) args[k] = sample(p);
  for (const [label, a] of [["sample", args], ["empty", {}]]) {
    let built;
    try { built = S.buildLuau(c.name, a); } catch (e) { bad.push(`${c.name} (${label}) threw: ${e && e.message}`); continue; }
    if (!built || (!built.code && !built.err)) { bad.push(`${c.name} (${label}) returned nothing`); continue; }
    if (built.err) { if (!/^ERROR/.test(String(built.err))) bad.push(`${c.name} (${label}) err without ERROR prefix`); continue; }
    generated++;
    if (built.code.includes("__ARGS_JSON__")) bad.push(`${c.name} (${label}) left the __ARGS_JSON__ placeholder`);
    const p = problems(built.code);
    if (p.length) bad.push(`${c.name} (${label}): ${p.join("; ")}`);
  }
}
ok(`every command generates (${generated} programs checked)`, bad.length === 0);
for (const b of bad.slice(0, 40)) console.log("      " + b);
if (bad.length > 40) console.log(`      … ${bad.length - 40} more`);

process.exitCode = failed ? 1 : 0;
