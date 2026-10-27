// 1.69.0 — "nearly infinite" animation: thesaurus (synonyms / implied objects → known vocabulary), verb classes (unknown
// motion verbs → body-region primitives), vocabulary() / inspire(), and the Animation Studio "Describe ANY motion" UI
// (vocabulary meter, Inspire me, motion browser with click-to-insert, live read-back of what the engine understood).
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-anim-anyword.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let n = 0, failed = 0; const ok = (name, cond, detail) => { n++; if (!cond) { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 500) : "")); } };

const ctx = {}; new Function("window", read("src/core/animengine.js"))(ctx);
const E = ctx.TotalAnimEngine;
ok("engine VERSION is 1.78.0", E.VERSION === "1.78.0", E.VERSION);
ok("engine exports the any-word layer", typeof E.expandVocabulary === "function" && typeof E.classGesture === "function" && typeof E.vocabulary === "function" && typeof E.inspire === "function" && Array.isArray(E.THESAURUS) && Array.isArray(E.VERB_CLASSES));

// ── 1. thesaurus: every target phrase is itself understood (no entry maps into the void) ──
const targets = [...new Set(E.THESAURUS.map((x) => x[1]))];
ok("thesaurus has 100+ entries mapping onto 90+ distinct known phrases", E.THESAURUS.length >= 100 && targets.length >= 90, [E.THESAURUS.length, targets.length]);
const dead = targets.filter((t) => { const i = E.parseIntent(t); return i.category === "improv" || i.unsupported.length; });
ok("every thesaurus target parses as a known motion or mood (never improv / unsupported)", dead.length === 0, dead);
const syn = { "guzzle a beer": "drink", "shovel the snow": "dig", "stargazing": "shade", "teeter on the edge": "wall", "sweaty lumberjack": "wipe", "pirouette": "twirl", "waltz with her": null, "devour a taco": "eat", "scamper away": null, "brandish a machete": null, "hammer a nail": "chop", "mop the floor": "sweep", "row with oars": "row", "juggle": null, "take a selfie": "selfie", "doomscrolling": "phone", "air guitar solo": "guitar", "bench press": "lift", "lug a sack": "carry", "bro fist": "fistbump", "bear hug": "hug", "ponder the question": "think", "yoga": null, "sob quietly": "cry", "tantrum": "stomp", "superhero landing": "herolanding", "shadow boxing": "boxing", "flail": "wavearms", "winded": "pant", "white flag": "surrender", "chicken dance": "chicken", "slam dunk": "basketball", "evil laugh": null, "hooray": null, "smh": null, "lob a grenade": null, "nock an arrow": null, "loot the chest": null };
const synBad = [];
for (const [p, act] of Object.entries(syn)) { const c = E.generate(p); const okk = c.intent.category !== "improv" && c.intent.category !== "idle" && (act == null || (c.intent.acts || []).includes(act)); if (!okk) synBad.push([p, c.intent.category, c.intent.acts]); }
ok("40 synonym / implied-object prompts land on real motions", synBad.length === 0, synBad);
const moodSyn = { "a knight sulking": "sad", "furious guard idle": "angry", "wasted pirate walk": "drunk", "terrified villager run": "scared", "grandpa walk": "old", "knackered worker idle": "tired", "smug noble walk": "proud", "hyper kid run": "energetic", "limping soldier walk": "injured" };
const moodBad = Object.entries(moodSyn).filter(([p, m]) => E.generate(p).intent.mood !== m).map(([p]) => [p, E.generate(p).intent.mood]);
ok("mood synonyms (sulking, furious, wasted, terrified, grandpa, knackered, smug, hyper, limping) become mood overlays", moodBad.length === 0, moodBad);
ok("a mood alone or with filler is a mood idle, no longer an improvisation", E.generate("tired").intent.category === "idle" && E.generate("tired").intent.mood === "tired" && E.generate("a knight sulking").intent.category === "idle");
ok("the thesaurus never rewrites what the lexicon already knows (out of breath → pant, not wipe; lift a heavy box → lift)", (E.generate("out of breath").intent.acts || []).includes("pant") && (E.generate("lift a heavy box").intent.acts || []).includes("lift") && (E.generate("scratch their head").intent.acts || []).includes("scratch"));
const g = E.generate("guzzle a cocktail");
ok("swaps are recorded on the intent and the clip keeps the user's words as its prompt", g.intent.swaps.length >= 1 && /cocktail → drink/.test(g.intent.swaps.join()) && g.prompt === "guzzle a cocktail" && (g.intent.acts || []).includes("drink"), [g.intent.swaps, g.prompt]);
ok("seed comes from the user's words, so two synonyms of one act are different takes of it", E.generate("guzzle a beer").fingerprint !== E.generate("swig a beer").fingerprint && (E.generate("swig a beer").intent.acts || []).includes("drink"));

// ── 2. verb classes: unknown motion verbs → body-region primitives, rendered as gesture clips ──
const vc = { "wring his hands": "hands pulse", "stir a cauldron": "arm circle", "swat the mosquito": "arm osc", "press the button": "arm hold", "conduct an orchestra": "arm osc", "read a book": "hands hold", "juggle three balls": "hands osc", "snap his fingers": "arm hold", "high knees": "leg osc", "teeter": "torso sway", "sway to the music": "torso sway", "tremble with fear": "torso tremble", "slump over": "torso slump", "puff out his chest": "torso arch", "peek over his shoulder": "head turn", "glare at him": "head hold", "sniff the air": "head nod", "scream at the sky": "arm osc", "headbutt him": "head nod", "prop himself up": "torso lean", "pogo": "torso bounce", "vogue": "arm hold", "hands over his eyes": "hands hold" };
const vcBad = [];
for (const [p, sig] of Object.entries(vc)) { const c = E.generate(p); const hits = (c.intent.gesture || {}).hits || []; if (c.intent.category !== "gesture" || !c.intent.gesture.synth || !hits.some((h) => h.includes("(" + sig + ")")) || c.report.errors) vcBad.push([p, c.intent.category, hits, c.report.errors]); }
ok("23 verb-class prompts generate as synthesised gestures with the expected body region + pattern and zero errors", vcBad.length === 0, vcBad);
const fps = Object.keys(vc).map((p) => E.generate(p).fingerprint);
ok("they are all different clips (unique fingerprints)", new Set(fps).size === fps.length);
const sn = E.generate("sniff the air");
ok("a synthesised gesture says what it did in the limitations and keeps the prompt", sn.intent.synth === true && /interpreted sniff \(head nod\)/.test(sn.limitations[0]) && sn.prompt === "sniff the air", sn.limitations);
ok("oscillating primitives loop and fast ones (swat, tremble) speed up", E.generate("sway to the music").loop === true && E.generate("tremble with fear").intent.speed > 1.2 && E.generate("slump over").loop === false);
ok("'left' flips an arm primitive to the left side", !!E.generate("stir the pot with the left arm").intent.gesture.pose.ls && !E.generate("stir the pot").intent.gesture.pose.ls);
ok("verb classes never shadow known acts (yawn and stretch → stretch act; read a book then wave → sequence)", (E.generate("big yawn and stretch").intent.acts || []).includes("stretch") && E.generate("read a book then wave").intent.category === "sequence");
ok("a primitive layers on a cycle ('sniff the air while walking')", E.generate("sniff the air while walking").intent.category === "walk" && E.generate("sniff the air while walking").report.errors === 0);
ok("pure gibberish still improvises and says so (unchanged contract)", E.generate("asdf qwerty zxcv").intent.category === "improv" && /improvised/.test(E.generate("asdf qwerty zxcv").limitations[0]));

// ── 3. breadth: 60 fresh sentences, none collapse into idle or improv ──
const fresh = ["guzzle a beer", "devour a burrito", "pirouette gracefully", "shovel snow off the path", "waltz slowly", "snooze on the job", "saunter down the street", "scamper away in panic", "vault over the fence", "clamber up the rope", "doggy paddle", "plop down on the bench", "skulk through the shadows", "wallop the bully", "punt the ball", "brandish a cutlass", "swing a sledgehammer", "rake the leaves", "whitewash the fence", "reel in a fish", "paddle the canoe", "pedal uphill", "steer the truck", "doomscroll on the couch", "code on a laptop", "shred on an electric guitar", "bang the bongos", "show off his biceps", "bench press", "lug a heavy sack", "shove the cart", "yank the chain", "fist bump", "up top high five", "bear hug", "firm handshake", "thumbs up", "air kiss", "ponder the puzzle", "limber up", "teeth chattering", "sob into her hands", "throw a tantrum", "rap on the window", "burst through the door", "scan the horizon", "phew wipe sweat", "burpees", "sun salutation", "say a prayer", "stroke the cat", "moment of silence", "flag down a taxi", "balance on the ledge", "watch the sunset", "reach for the top shelf", "seeing stars", "gasp for air", "hands up don't shoot", "brace for impact"];
const freshClips = fresh.map((p) => E.generate(p));
const freshBad = freshClips.map((c, i) => [fresh[i], c.intent.category, c.report.errors]).filter(([, cat, err]) => cat === "improv" || cat === "idle" || err > 0);
ok("60 fresh everyday sentences → 60 real clips, no idle / improv fallbacks, no validation errors", freshBad.length === 0, freshBad);
ok("…and they are 60 distinct clips", new Set(freshClips.map((c) => c.fingerprint)).size === fresh.length);

// ── 4. vocabulary() + inspire() ──
const v = E.vocabulary();
ok("vocabulary() reports the size of the space", v.acts >= 70 && v.categories >= 50 && v.moods >= 12 && v.synonyms >= 900 && v.verbClasses >= 300 && Array.isArray(v.composition) && v.composition.includes("then-chains"), v);
const ideas = Array.from({ length: 40 }, (_, i) => E.inspire(i));
ok("inspire(seed) is deterministic and varied (40 seeds → 30+ different prompts)", E.inspire(7) === E.inspire(7) && new Set(ideas).size >= 30, ideas.slice(0, 8));
const ideaClips = ideas.map((p) => E.generate(p));
ok("every inspired prompt generates a real clip (never improv) with no errors", ideaClips.every((c) => c.intent.category !== "improv" && c.report.errors === 0), ideaClips.filter((c) => c.intent.category === "improv" || c.report.errors).map((c) => [c.prompt, c.intent.category]));
ok("inspired prompts use the composition forms (then, while, moods, speeds, repeats)", ideas.some((p) => / then /.test(p)) && ideas.some((p) => / while walking/.test(p)) && ideas.some((p) => /slowly|fast|slow motion|half speed|quickly/.test(p)) && ideas.some((p) => /twice|three times|x4/.test(p)), ideas);

// ── 5. the Studio UI ──
const studio = read("src/core/animstudio.js"), css = read("overlay.css");
for (const s of ['Describe ANY motion', 'data-ref="vocabTag"', 'data-ref="understood"', 'data-ref="vocabLine"', 'data-act="inspire"', 'data-act="browse"', 'data-ref="browse"', "function vocabBrowserHtml()", "function insertVocab(word, mode)", "function renderUnderstood()", 'case "inspire": return inspire();', 'case "browse": return toggleBrowse();', 'const ins = e.target.closest("[data-ins]");', "Describe ANY animation, then Generate"]) ok("studio has " + s, studio.includes(s));
for (const s of [".rsa-h-tag {", ".rsa-understood {", ".rsa-understood.warn {", ".rsa-vocab {", ".rsa-vocab-n b {", ".rsa-browse {", ".rsa-browse[hidden] { display: none !important; }", ".rsa-understood[hidden] { display: none !important; }", ".rsa-btn.small {"]) ok("css has " + s, css.includes(s));

const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, url: "https://chatgpt.com/" });
const w = dom.window; w.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0); w.cancelAnimationFrame = (id) => clearTimeout(id);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 800; } }); Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 400; } });
w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : () => undefined), set: () => true }); };
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const mem = {}; Object.defineProperty(w, "localStorage", { value: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } });
w.prompt = () => "0.25"; w.confirm = () => true;
for (const f of ["src/core/animengine.js", "src/core/animstudio.js"]) { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); }
const AS = w.TotalAnimStudio;
AS.open({ send: async () => true, runTool: async () => "", studioReady: () => false, engine: () => "", toast: () => {}, diag: () => {}, clips: () => ({}) });
const host = w.document.getElementById("rs-anim"); const ref = (k) => host.querySelector(`[data-ref="${k}"]`), act = (k) => host.querySelector(`[data-act="${k}"]`);
const toast = () => host.querySelector(".rsa-toast").textContent;
const click = (el, o) => el.dispatchEvent(new w.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true }, o || {})));
ok("card 1 says Describe ANY motion with the unlimited tag and the vocabulary meter", /Describe ANY motion/.test(host.querySelector(".rsa-card .rsa-h").textContent) && ref("vocabTag").textContent === "unlimited" && /\d+ motions · \d+ move types · 12 moods · [\d.]+k\+ synonyms · \d+\+ verbs/.test(ref("vocabLine").textContent) && /unlimited/.test(ref("vocabLine").textContent), ref("vocabLine").textContent);
ok("the empty state invites ANY animation", /Describe ANY animation/.test(ref("empty").textContent) && /nearly any sentence/.test(ref("empty").textContent));
ok("the browser is closed by default and toggles with its button", ref("browse").hidden === true && (click(act("browse")), ref("browse").hidden === false && act("browse").classList.contains("on")) && host.querySelectorAll(".rsa-browse-g").length >= 8 && host.querySelectorAll("[data-ins]").length >= 150, host.querySelectorAll("[data-ins]").length);
ref("prompt").value = "";
click(host.querySelector('[data-ins="drink a potion"]'));
ok("clicking a motion chip inserts it", ref("prompt").value === "drink a potion", ref("prompt").value);
click(host.querySelector('[data-ins="wave"]'));
ok("a second motion chip chains with 'then'", ref("prompt").value === "drink a potion then wave", ref("prompt").value);
click(host.querySelector('[data-ins="tired"]'));
ok("a mood chip prefixes", ref("prompt").value === "tired drink a potion then wave", ref("prompt").value);
click(host.querySelector('[data-ins="tired"]'));
ok("the same mood is not prefixed twice", ref("prompt").value === "tired drink a potion then wave", ref("prompt").value);
click(host.querySelector('[data-ins="… while walking"]'));
ok("a compose chip appends its clause", ref("prompt").value === "tired drink a potion then wave while walking", ref("prompt").value);
ok("the live read-back shows what the engine understood before Generate", ref("understood").hidden === false && /motions in a row|drink/.test(ref("understood").textContent) && /mood tired/.test(ref("understood").textContent), ref("understood").textContent);
ref("prompt").value = ""; click(host.querySelector('[data-ins="walk cycle"]')); click(host.querySelector('[data-ins="run cycle"]'));
ok("cycle chips build a set with commas and the read-back announces separate clips", ref("prompt").value === "walk cycle, run cycle" && /2 separate clips/.test(ref("understood").textContent), [ref("prompt").value, ref("understood").textContent]);
ref("prompt").value = "sniff the air"; AS._state; host.querySelector("[data-ref=prompt]").dispatchEvent(new w.Event("input", { bubbles: true }));
setTimeout(() => {
  ok("typing updates the read-back (debounced) and shows the interpreted primitive", /interpreted sniff \(head nod\)/.test(ref("understood").textContent), ref("understood").textContent);
  ref("prompt").value = "asdf qwerty"; host.querySelector("[data-ref=prompt]").dispatchEvent(new w.Event("input", { bubbles: true }));
  setTimeout(() => {
    ok("gibberish is flagged as a warning in the read-back before generating", ref("understood").classList.contains("warn") && /no motion word yet/.test(ref("understood").textContent), ref("understood").textContent);
    click(act("inspire"));
    const idea = ref("prompt").value;
    ok("Inspire me fills the prompt with a composed idea and toasts it", idea.length > 4 && /^Try: /.test(toast()) && toast().includes(idea) && !ref("understood").classList.contains("warn"), [idea, toast()]);
    const clip = AS.generate("guzzle a beer");
    ok("generating a synonym prompt toasts the act and what was understood", clip && (clip.intent.acts || []).includes("drink") && /understood guzzle → drink|understood .*→ drink/.test(toast()), toast());
    const c2 = AS.generate("stir a cauldron");
    ok("generating a verb-class prompt toasts the interpreted primitive", c2 && c2.intent.category === "gesture" && /gesture: stir \(arm circle\)/.test(toast()), toast());
    ok("no window errors during the session", errors.length === 0, errors);
    console.log(`test-anim-anyword: ${n} checks, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }, 300);
}, 300);
