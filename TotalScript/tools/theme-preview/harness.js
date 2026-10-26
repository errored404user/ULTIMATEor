// Dev-only harness: loads overlay.css with the real DOM ids so the 16 themes
// can be eyeballed in a plain browser (no extension APIs needed). Theme data
// is pulled out of src/core/main.js at runtime so it never drifts.
(async () => {
  const src = await (await fetch("/src/core/main.js")).text();
  const grab = (name) => { const m = src.match(new RegExp("const " + name + " ?= ?(\\{[\\s\\S]*?\\n  \\});")); return m ? Function("return " + m[1])() : {}; };
  const TOTAL_THEMES = grab("TOTAL_THEMES"), MEME = grab("MEME_THEME_DATA");
  for (const [id, d] of Object.entries(MEME)) Object.assign(TOTAL_THEMES[id] ||= {}, { background: d[0] + "," + d[1] });
  const memeIds = ["epicface","headooh","ragequit","killfeed","shitpost","skillissue","pogchamp","glitchlord","npcenergy"];
  const html = document.documentElement, root = document.getElementById("rs-root");
  const picker = document.getElementById("picker"), grid = document.getElementById("pv-grid");
  let rail = document.createElement("div"); rail.className = "rs-theme-corners";
  rail.innerHTML = '<span class="rs-theme-corner rs-corner-tl"></span><span class="rs-theme-corner rs-corner-tr"></span><span class="rs-theme-corner rs-corner-bl"></span><span class="rs-theme-corner rs-corner-br"></span>';
  root.appendChild(rail);
  const art = (id) => `ui/swatch-${id}.jpg`;
  // Real synth: evaluate the extension's playSfx + THEME_SOUNDS verbatim so the
  // harness plays exactly what the content script plays.
  const sndSrc = src.match(/const SFX_KINDS = [\s\S]*?\n  const SFX_LABELS = [^\n]*\n/)[0];
  const playSrc = src.match(/  function playSfx\(kind, themeId\) \{[\s\S]*?\n  \}\n/)[0];
  const SFX = Function("TOTAL_THEMES", "let soundOn = true, themeVolume = 70, totalTheme = 'aqua';\n" + sndSrc + playSrc + "\nreturn { playSfx, SFX_KINDS, SFX_LABELS, THEME_SOUNDS, setTheme: (t) => { totalTheme = t; }, setVolume: (v) => { themeVolume = v; } };")(TOTAL_THEMES);
  const soundList = document.getElementById("pv-sounds");
  function apply(id) {
    const th = TOTAL_THEMES[id]; html.dataset.rsTheme = id;
    document.getElementById("pv-theme-name").textContent = th?.name || id;
    document.querySelectorAll("[data-rs-brand]").forEach((b) => (b.textContent = id === "void" ? "VoidScript" : "TotalScript"));
    document.getElementById("rs-ornament").dataset.theme = id;
    rail.dataset.kind = memeIds.includes(id) ? "meme" : "classic";
    rail.hidden = html.dataset.memeEffects === "off";
    picker.querySelectorAll("button[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === id));
    SFX.setTheme(id);
    soundList.innerHTML = `<span class="rs-theme-sound-name">♪ ${SFX.THEME_SOUNDS[id]?.label || ""}</span>` + SFX.SFX_KINDS.map((k) => `<button type="button" data-theme-sound-preview="${id}" data-effect="${k}">${SFX.SFX_LABELS[k]}</button>`).join("");
    soundList.querySelectorAll("button").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); SFX.playSfx(b.dataset.effect, b.dataset.themeSoundPreview); }));
    document.querySelectorAll(".rs-theme-card").forEach((el) => el.classList.toggle("on", el.dataset.theme === id));
  }
  for (const id of Object.keys(TOTAL_THEMES)) {
    const b = document.createElement("button"); b.dataset.t = id; b.textContent = TOTAL_THEMES[id].name || id; b.onclick = () => apply(id); picker.appendChild(b);
    const c = document.createElement("article"); c.className = "rs-work-card rs-theme-card"; c.dataset.theme = id; c.dataset.themeCard = id;
    c.innerHTML = `<span class="rs-theme-art" style="background-image:url(/${art(id)})"></span><span class="rs-work-glyph">${TOTAL_THEMES[id].glyph || ""}</span><span class="rs-work-name">${TOTAL_THEMES[id].name}</span><span class="rs-work-sub">${TOTAL_THEMES[id].sub || ""}</span>`;
    c.onclick = () => apply(id); grid.appendChild(c);
  }
  const mk = (label, attr, vals) => { const l = document.createElement("label"); l.textContent = label; const s = document.createElement("select"); vals.forEach((v) => s.append(new Option(v, v))); s.onchange = () => { html.setAttribute(attr, s.value); apply(html.dataset.rsTheme); }; l.appendChild(s); picker.appendChild(l); };
  mk("glass", "data-rs-glass", ["true", "false"]); mk("effects", "data-meme-effects", ["full", "reduced", "off"]);
  const kinds = ["start", "restart", "start-degraded"]; let k = 0; const act = document.getElementById("rs-action");
  act.onclick = () => { SFX.playSfx(act.dataset.kind === "restart" ? "done" : "start"); k = (k + 1) % (kinds.length + 1); act.disabled = k === kinds.length; act.dataset.kind = kinds[k % kinds.length]; act.textContent = act.disabled ? "Start" : { start: "▶ Start", restart: "↻ Restart", "start-degraded": "▶ Start (degraded)" }[act.dataset.kind]; };
  const gear = document.getElementById("rs-settings-btn"), menu = document.getElementById("rs-menu"), bar = document.getElementById("rs-bar");
  gear.onclick = () => { const open = menu.hidden; menu.hidden = !open; bar.classList.toggle("rs-menu-open", open); bar.classList.toggle("rs-menu-contained", open); if (open) SFX.playSfx("click"); };
  const stop = document.getElementById("rs-stop"); stop.onclick = () => { SFX.playSfx(stop.dataset.state ? "error" : "stop"); if (stop.dataset.state) delete stop.dataset.state; else stop.dataset.state = "stopping"; };
  apply(new URLSearchParams(location.search).get("theme") || "aqua");
})();
