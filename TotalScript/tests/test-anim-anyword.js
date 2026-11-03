// 1.69.0 — "nearly infinite" animation: thesaurus (synonyms / implied objects → known vocabulary), verb classes (unknown
// motion verbs → body-region primitives), vocabulary() / inspire(), and the Animation Studio "Describe ANY motion" UI
// (vocabulary meter, Inspire me, motion browser with click-to-insert, live read-back of what the engine understood).
// Run: node tests/test-anim-anyword.js (2.0.3: engine-only - the Animation Studio window was removed)
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let n = 0, failed = 0; const ok = (name, cond, detail) => { n++; if (!cond) { failed++; console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 500) : "")); } };

const ctx = {}; new Function("window", read("src/core/animengine.js"))(ctx);
const E = ctx.TotalAnimEngine;
ok("engine VERSION is 2.6.0", E.VERSION === "2.6.0", E.VERSION);
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

console.log(`test-anim-anyword: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
