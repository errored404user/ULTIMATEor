// ORscript — Quality Gate pack (1.47.0)
//
// The gap between "the command returned success" and work a player would call
// finished is almost always the same handful of things: default grey Plastic,
// parts still called "Part", nothing anchored, Lighting never touched, a white
// Frame with a 1px border and SourceSans, Offset-only sizes, wait() and print()
// left in scripts, a DataStore without pcall. This pack turns those into a
// measurable gate the agent runs on itself:
//
//   style_guide          art-direction bible per genre (palette hex + RGB, materials,
//                        lighting recipe, UI tokens, scale, motifs, do / don't) - JS only
//   brief_set / brief_get  the project brief the agent builds to (ServerStorage._ORBrief)
//   style_lighting_apply   write the genre's lighting recipe into Lighting in one call
//   quality_audit        score the place / a path 0-100 with findings + exact fix commands
//   quality_fix          the mechanical fixes (anchor, primary parts, names, UI borders /
//                        corners / TextScaled / fonts) in one undoable step
//
// quality_audit is the hand-off gate: Creation mode re-runs it until the score
// is >= 85 and reports the number.
(() => {
  if (typeof RobloxScriptSkills === "undefined") return;
  const QUALITY_VERSION = "1.47.0";
  const PASS_SCORE = 85;

  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  const jj = (o) => q(JSON.stringify(o));
  const nn = (v, d) => (isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  const hex = (rgb) => "#" + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
  const col = (name, rgb) => ({ name, hex: hex(rgb), rgb, color3: "Color3.fromRGB(" + rgb.join(", ") + ")" });

  // ───────────────────────── style guides ─────────────────────────
  // Every entry is deliberately opinionated: the point is to give the model
  // concrete numbers to type instead of "a nice medieval palette".
  const G = {};
  G.medieval = {
    summary: "Weathered stone, dark timber and wrought iron under warm torchlight; heavy proportions, nothing symmetrical for its own sake.",
    palette: { base: col("castle stone", [122, 116, 108]), secondary: col("dark oak", [74, 50, 34]), accent: col("royal crimson", [138, 28, 36]), ground: col("mossy cobble", [86, 92, 72]), trim: col("wrought iron", [38, 36, 40]), glow: col("torch amber", [255, 170, 70]) },
    materials: { walls: ["Cobblestone", "Slate", "Brick"], floors: ["Cobblestone", "WoodPlanks", "Slate"], trim: ["Wood", "Metal", "DiamondPlate (banded)"], props: ["Wood", "Fabric", "Metal", "Granite"], avoid: ["Plastic", "SmoothPlastic", "Neon on buildings", "Marble everywhere"] },
    lighting: { preset: "fantasy_vibrant", postfx: "filmic", ClockTime: 17.5, Brightness: 2, Ambient: [60, 56, 54], OutdoorAmbient: [110, 100, 92], ExposureCompensation: 0.1, atmosphere: { Density: 0.38, Color: [199, 184, 160], Haze: 1.6, Glare: 0.3 }, bloom: { Intensity: 0.5, Size: 32, Threshold: 1.2 }, color_correction: { Saturation: 0.05, Contrast: 0.12, TintColor: [255, 244, 228] }, fog: { FogStart: 150, FogEnd: 900, FogColor: [190, 176, 156] } },
    ui: { tokens_preset: "royal_gold", primary: [212, 170, 60], secondary: [138, 28, 36], surface: [26, 20, 18], text: [246, 236, 214], font: "Garamond", radius: 6, stroke: "1px antique gold (212,170,60) at 0.4 transparency", notes: "parchment panels, ornate corner studs, banner-shaped headers" },
    scale: { wall_height: 14, door: "7 x 12", wall_thickness: 2, tower_radius: 10, notes: "thick walls (2-3 studs), battlements every 4 studs, stairs 1 x 1 steps" },
    motifs: ["crenellations", "arched windows (archway_generate)", "banners and heraldry", "torches with PointLight + flame emitter", "barrels, crates, hay", "ivy and moss on the shadow side", "chimney smoke"],
    vfx: ["torch flames (fx_create_vfx fire, small)", "dust motes in sunbeams", "chimney smoke", "embers"],
    sfx: ["crackling torch loop", "wind", "distant birds", "heavy wooden door"],
    avoid: ["perfectly straight long walls with no breaks", "pure black or pure white", "modern fonts (Gotham) on medieval UI", "symmetrical prop placement"],
  };
  G.fantasy = {
    summary: "Saturated storybook colours, glowing crystals and floating particles; soft rounded forms and a dreamy warm-cool contrast.",
    palette: { base: col("enchanted teal", [46, 134, 128]), secondary: col("violet dusk", [112, 72, 168]), accent: col("crystal cyan", [120, 240, 255]), ground: col("spring moss", [96, 160, 72]), trim: col("ancient gold", [214, 176, 84]), glow: col("fairy pink", [255, 150, 220]) },
    materials: { walls: ["Marble", "Granite", "Cobblestone"], floors: ["Grass", "LeafyGrass", "Marble"], trim: ["Metal", "Neon (crystals only)", "Glass"], props: ["Wood", "Fabric", "Neon", "Ice"], avoid: ["Plastic", "Concrete", "DiamondPlate"] },
    lighting: { preset: "fantasy_vibrant", postfx: "dreamy", ClockTime: 16.8, Brightness: 2.4, Ambient: [80, 70, 110], OutdoorAmbient: [130, 120, 170], ExposureCompensation: 0.25, atmosphere: { Density: 0.32, Color: [214, 196, 255], Haze: 2.2, Glare: 0.5 }, bloom: { Intensity: 0.9, Size: 48, Threshold: 0.9 }, color_correction: { Saturation: 0.2, Contrast: 0.1, TintColor: [250, 240, 255] }, fog: { FogStart: 200, FogEnd: 1400, FogColor: [200, 190, 240] } },
    ui: { tokens_preset: "royal_gold", primary: [120, 240, 255], secondary: [255, 150, 220], surface: [24, 18, 44], text: [245, 240, 255], font: "Fantasy", radius: 14, stroke: "1px crystal cyan at 0.3", notes: "glowing UIStroke on buttons, gradient headers, floating particle ImageLabels" },
    scale: { wall_height: 12, door: "6 x 11", wall_thickness: 1.5, notes: "exaggerate: towers 1.5x taller than realistic, oversized mushrooms and crystals" },
    motifs: ["floating crystals with PointLight", "glowing runes on the floor", "mushrooms and oversized flowers", "waterfalls with Beam + mist", "fireflies (sparkles emitter, slow)", "stone circles"],
    vfx: ["fireflies", "crystal glow + pulse tween", "magic circles (fx_magic_circle)", "mist along the ground"],
    sfx: ["soft chime loop", "running water", "wind in leaves"],
    avoid: ["grey or brown dominant palettes", "realistic lighting (ClockTime 14, no atmosphere)", "sharp 90-degree UI corners"],
  };
  G.scifi = {
    summary: "Clean panelled surfaces, cool whites and gunmetal with one emissive accent colour; hard light, long sightlines and strict modularity.",
    palette: { base: col("hull white", [214, 220, 226]), secondary: col("gunmetal", [58, 64, 74]), accent: col("reactor cyan", [0, 220, 255]), ground: col("deck plate", [40, 44, 52]), trim: col("warning amber", [255, 170, 0]), glow: col("plasma blue", [80, 140, 255]) },
    materials: { walls: ["SmoothPlastic", "Metal", "Glass"], floors: ["DiamondPlate", "Metal", "SmoothPlastic"], trim: ["Neon (light strips)", "Metal", "CorrodedMetal (damage)"], props: ["Metal", "Glass", "Neon", "Plastic"], avoid: ["Wood", "Brick", "Grass", "Fabric"] },
    lighting: { preset: "space_void", postfx: "clean", ClockTime: 0, Brightness: 1.2, Ambient: [40, 48, 60], OutdoorAmbient: [60, 70, 90], ExposureCompensation: 0.1, atmosphere: { Density: 0.1, Color: [160, 190, 220], Haze: 0.4, Glare: 0 }, bloom: { Intensity: 0.7, Size: 24, Threshold: 1.1 }, color_correction: { Saturation: -0.05, Contrast: 0.18, TintColor: [230, 240, 255] }, fog: { FogStart: 400, FogEnd: 3000, FogColor: [20, 24, 32] } },
    ui: { tokens_preset: "midnight", primary: [0, 220, 255], secondary: [255, 170, 0], surface: [12, 16, 24], text: [230, 240, 255], font: "Michroma", radius: 4, stroke: "1px cyan at 0.5, 2px on focus", notes: "thin HUD lines, chamfered corner brackets, monospaced data readouts (Code / RobotoMono)" },
    scale: { wall_height: 12, door: "8 x 11 (sliding, split)", wall_thickness: 1, corridor_width: 10, notes: "build from 4-stud modules; light strips at 0.3 studs; floor grating 0.2 proud" },
    motifs: ["neon light strips (Neon part 0.2 x 0.2 + SurfaceLight)", "holographic panels (SurfaceGui + Transparency 0.3)", "pipes and conduits (model_pipe)", "sliding doors", "vents and grates", "warning stripes"],
    vfx: ["steam vents (Enabled bursts)", "hologram flicker tween", "reactor core glow pulse", "sparks from damaged panels"],
    sfx: ["low engine hum", "door hiss", "console beeps", "ventilation"],
    avoid: ["more than ONE emissive accent colour", "warm wood or brick", "daylight sky with ClockTime 14", "curved organic shapes everywhere"],
  };
  G.cyberpunk = {
    summary: "Night, rain and neon: near-black surfaces so the magenta / cyan signage carries the scene; wet reflective ground, vertical clutter.",
    palette: { base: col("asphalt black", [18, 16, 24]), secondary: col("steel violet", [48, 40, 70]), accent: col("neon magenta", [255, 0, 170]), ground: col("wet concrete", [30, 30, 38]), trim: col("hologram cyan", [0, 240, 230]), glow: col("sodium orange", [255, 120, 30]) },
    materials: { walls: ["Concrete", "Metal", "CorrodedMetal"], floors: ["Asphalt", "Concrete (Reflectance 0.15)", "Metal"], trim: ["Neon", "Glass", "Metal"], props: ["Metal", "Plastic", "Neon", "Fabric (awnings)"], avoid: ["Grass", "Wood", "Marble", "bright daylight"] },
    lighting: { preset: "cyberpunk", postfx: "vivid", ClockTime: 0.3, Brightness: 0.6, Ambient: [22, 14, 40], OutdoorAmbient: [36, 20, 60], ExposureCompensation: 0.2, atmosphere: { Density: 0.42, Color: [120, 70, 160], Haze: 2.8, Glare: 0.8 }, bloom: { Intensity: 1.1, Size: 56, Threshold: 0.8 }, color_correction: { Saturation: 0.3, Contrast: 0.2, TintColor: [235, 220, 255] }, fog: { FogStart: 60, FogEnd: 500, FogColor: [40, 18, 60] } },
    ui: { tokens_preset: "neon", primary: [0, 240, 230], secondary: [255, 0, 170], surface: [8, 8, 16], text: [235, 245, 255], font: "Arcade", radius: 2, stroke: "1px magenta at 0.2 with a glitch tween on hover", notes: "scanline UIGradient, cut corners, glitch tween on open" },
    scale: { wall_height: 16, door: "6 x 10", street_width: 24, notes: "stack signage at 3 heights (3, 8, 14 studs); awnings; cables between buildings (beam_create)" },
    motifs: ["neon signs (Neon parts + SurfaceGui text)", "holograms (billboard ImageLabel, Transparency 0.4)", "puddles (flat Glass parts, Reflectance 0.4)", "steam from grates", "cables", "vending machines", "rain (fx_create_vfx rain)"],
    vfx: ["rain", "steam", "neon flicker tween", "hologram scanlines"],
    sfx: ["rain loop", "distant traffic", "electric buzz", "synth pad"],
    avoid: ["daylight", "clean uncluttered streets", "grey Plastic buildings", "more than three neon hues"],
  };
  G.horror = {
    summary: "Almost no light, desaturated greens and rust, long shadows and one sickly accent; the player should see less than they want to.",
    palette: { base: col("rotten plaster", [64, 66, 58]), secondary: col("old blood", [92, 24, 26]), accent: col("sickly green", [120, 160, 70]), ground: col("wet dirt", [34, 30, 26]), trim: col("rust", [110, 60, 34]), glow: col("flashlight", [255, 236, 200]) },
    materials: { walls: ["Concrete", "Brick", "WoodPlanks (rotten)"], floors: ["WoodPlanks", "Concrete", "Mud"], trim: ["CorrodedMetal", "Wood", "Fabric"], props: ["Wood", "Fabric", "CorrodedMetal", "Glass"], avoid: ["SmoothPlastic", "Neon", "Marble", "saturated colours except the accent"] },
    lighting: { preset: "horror_dark", postfx: "horror", ClockTime: 0.5, Brightness: 0.35, Ambient: [12, 14, 12], OutdoorAmbient: [22, 26, 22], ExposureCompensation: -0.35, atmosphere: { Density: 0.55, Color: [60, 70, 60], Haze: 3, Glare: 0 }, bloom: { Intensity: 0.3, Size: 20, Threshold: 1.6 }, color_correction: { Saturation: -0.45, Contrast: 0.25, TintColor: [200, 215, 200] }, fog: { FogStart: 10, FogEnd: 140, FogColor: [14, 16, 14] } },
    ui: { tokens_preset: "horror", primary: [170, 20, 30], secondary: [120, 120, 130], surface: [10, 8, 10], text: [220, 210, 205], font: "Creepster", radius: 0, stroke: "none; use TextStroke and a vignette ImageLabel", notes: "minimal HUD, typewriter text reveal, red only for danger" },
    scale: { wall_height: 11, door: "5 x 9 (narrow)", corridor_width: 6, notes: "narrow corridors, low ceilings, doors slightly ajar (rotate 20 degrees)" },
    motifs: ["flickering lights (tween Brightness)", "boarded windows", "stains (Decal Transparency 0.4)", "scattered furniture", "fog hugging the floor", "long single-light corridors"],
    vfx: ["dust in flashlight cones", "fog", "flicker tween", "breath mist"],
    sfx: ["low drone", "creaks on a timer", "distant knocks", "heartbeat on low health"],
    avoid: ["ClockTime 14 / Brightness 2-3", "visible full rooms with no shadows", "cartoon fonts", "jump scares without build-up"],
  };
  G.cozy = {
    summary: "Warm cream and wood, rounded furniture, soft golden-hour light; everything slightly oversized and friendly.",
    palette: { base: col("cream", [244, 232, 212]), secondary: col("honey wood", [176, 126, 76]), accent: col("sage", [128, 160, 120]), ground: col("warm plank", [150, 110, 70]), trim: col("terracotta", [196, 108, 76]), glow: col("lamp gold", [255, 200, 130]) },
    materials: { walls: ["Fabric (wallpaper)", "WoodPlanks", "Brick (painted)"], floors: ["WoodPlanks", "Carpet", "Cobblestone (paths)"], trim: ["Wood", "Fabric", "Marble (counters)"], props: ["Fabric", "Wood", "Glass", "Grass (plants)"], avoid: ["Metal", "DiamondPlate", "Neon", "Concrete"] },
    lighting: { preset: "sunset_warm", postfx: "dreamy", ClockTime: 16.5, Brightness: 2.6, Ambient: [120, 104, 90], OutdoorAmbient: [170, 150, 130], ExposureCompensation: 0.3, atmosphere: { Density: 0.3, Color: [255, 220, 180], Haze: 1.8, Glare: 0.4 }, bloom: { Intensity: 0.8, Size: 40, Threshold: 1 }, color_correction: { Saturation: 0.1, Contrast: 0.02, TintColor: [255, 244, 230] }, fog: { FogStart: 300, FogEnd: 1600, FogColor: [240, 220, 200] } },
    ui: { tokens_preset: "sakura", primary: [196, 108, 76], secondary: [128, 160, 120], surface: [255, 248, 240], text: [70, 50, 40], font: "FredokaOne", radius: 18, stroke: "none; soft drop shadow ImageLabel", notes: "pill buttons, rounded cards, soft pastel badges" },
    scale: { wall_height: 10, door: "5 x 9", notes: "furniture 10 percent oversized; low fences 2.5 studs; wide paths" },
    motifs: ["string lights (PointLight chain)", "potted plants", "rugs", "bookshelves", "fireplace with embers", "window boxes", "picnic blankets"],
    vfx: ["chimney smoke", "fireflies at dusk", "leaf drift", "steam from mugs"],
    sfx: ["acoustic loop", "birds", "fire crackle", "wind chimes"],
    avoid: ["cold blue light", "sharp corners", "metal or concrete dominance", "empty large rooms"],
  };
  G.nature = {
    summary: "Layered greens with earthy browns, sun shafts through canopy, organic placement in clusters and curves, never grids.",
    palette: { base: col("canopy green", [66, 124, 60]), secondary: col("bark brown", [92, 66, 44]), accent: col("wildflower", [230, 110, 150]), ground: col("forest floor", [78, 70, 44]), trim: col("river stone", [120, 124, 118]), glow: col("sun shaft", [255, 240, 200]) },
    materials: { walls: ["Rock", "Slate", "Wood"], floors: ["Grass", "LeafyGrass", "Ground", "Mud"], trim: ["Wood", "Cobblestone", "Pebble"], props: ["Wood", "Grass", "Rock", "Sand"], avoid: ["Plastic", "SmoothPlastic", "Metal", "Neon"] },
    lighting: { preset: "realistic_noon", postfx: "vivid", ClockTime: 15.5, Brightness: 2.8, Ambient: [70, 84, 60], OutdoorAmbient: [120, 140, 100], ExposureCompensation: 0.15, atmosphere: { Density: 0.33, Color: [210, 222, 190], Haze: 1.4, Glare: 0.6 }, bloom: { Intensity: 0.5, Size: 36, Threshold: 1.2 }, color_correction: { Saturation: 0.15, Contrast: 0.08, TintColor: [250, 255, 240] }, fog: { FogStart: 200, FogEnd: 1500, FogColor: [200, 214, 190] } },
    ui: { tokens_preset: "forest", primary: [80, 190, 110], secondary: [230, 160, 60], surface: [18, 30, 24], text: [236, 246, 238], font: "Merriweather", radius: 12, stroke: "1px moss (80,190,110) at 0.5", notes: "leaf-shaped badges, wood-grain panels" },
    scale: { tree_height: "18-30 (vary 40 percent)", rock_sizes: "3 sizes, 5:3:1 ratio", path_width: 5, notes: "cluster in odd numbers (3, 5), vary rotation and scale per instance" },
    motifs: ["layered trees (3 canopy spheres offset)", "rock clusters", "fallen logs", "streams with Beam water", "flower patches", "mushrooms", "sun shafts (sunrays_set)"],
    vfx: ["pollen / dust motes", "falling leaves", "butterflies", "waterfall mist"],
    sfx: ["birds", "stream", "wind in leaves", "insects at night"],
    avoid: ["trees in rows", "one green for everything", "flat terrain", "default sky with no atmosphere"],
  };
  G.desert = {
    summary: "Bleached sand and ochre rock under harsh high sun; long shadows, heat haze and terracotta settlements with deep shade.",
    palette: { base: col("sun sand", [222, 196, 148]), secondary: col("ochre rock", [176, 118, 72]), accent: col("oasis turquoise", [60, 180, 170]), ground: col("dune", [206, 176, 128]), trim: col("sunbaked clay", [160, 92, 62]), glow: col("noon white", [255, 248, 230]) },
    materials: { walls: ["Sandstone", "Concrete", "Brick"], floors: ["Sand", "Sandstone", "Ground"], trim: ["Wood", "Fabric (awnings)", "Metal"], props: ["Fabric", "Wood", "Rock", "Glass"], avoid: ["Grass", "Marble", "SmoothPlastic", "Neon"] },
    lighting: { preset: "realistic_noon", postfx: "filmic", ClockTime: 13.5, Brightness: 3.2, Ambient: [120, 104, 80], OutdoorAmbient: [190, 170, 140], ExposureCompensation: 0.2, atmosphere: { Density: 0.28, Color: [240, 220, 180], Haze: 2.4, Glare: 1.2 }, bloom: { Intensity: 0.6, Size: 30, Threshold: 1.3 }, color_correction: { Saturation: 0.08, Contrast: 0.12, TintColor: [255, 242, 220] }, fog: { FogStart: 400, FogEnd: 2500, FogColor: [236, 216, 180] } },
    ui: { tokens_preset: "clean_light", primary: [176, 118, 72], secondary: [60, 180, 170], surface: [250, 242, 228], text: [60, 40, 28], font: "Bangers", radius: 8, stroke: "1px clay at 0.4", notes: "woven texture UIGradient, sun-bleached badges" },
    scale: { wall_height: 10, door: "5 x 9", notes: "flat roofs, thick walls (2.5), rock mesas 40+ studs, dunes as gentle 6-stud hills" },
    motifs: ["mesas and arches", "cacti and dead trees", "market awnings", "wells and oases", "bones", "wind-carved rock (model_subtract)"],
    vfx: ["heat haze (BlurEffect low + atmosphere)", "blowing sand (fx_create_vfx dust)", "dust devils", "oasis sparkle"],
    sfx: ["wind", "distant hawk", "sand hiss", "market chatter"],
    avoid: ["cool blue shade", "green vegetation except the oasis", "soft overcast light", "symmetrical rock formations"],
  };
  G.winter = {
    summary: "Blue-white snow with warm cabin interiors as the contrast; soft overcast light, crisp rim light at night, thick snow caps on everything.",
    palette: { base: col("fresh snow", [236, 242, 250]), secondary: col("pine", [34, 72, 56]), accent: col("cabin red", [170, 44, 46]), ground: col("packed snow", [210, 222, 236]), trim: col("dark timber", [70, 50, 40]), glow: col("window warmth", [255, 190, 110]) },
    materials: { walls: ["WoodPlanks", "Snow", "Rock"], floors: ["Snow", "Ice", "WoodPlanks"], trim: ["Wood", "Metal", "Glass"], props: ["Snow", "Ice", "Fabric", "Wood"], avoid: ["Grass", "Sand", "Neon", "Plastic"] },
    lighting: { preset: "overcast_moody", postfx: "clean", ClockTime: 15.8, Brightness: 2, Ambient: [120, 130, 150], OutdoorAmbient: [160, 172, 196], ExposureCompensation: 0.2, atmosphere: { Density: 0.4, Color: [220, 230, 245], Haze: 2, Glare: 0.2 }, bloom: { Intensity: 0.5, Size: 36, Threshold: 1.1 }, color_correction: { Saturation: -0.1, Contrast: 0.05, TintColor: [236, 244, 255] }, fog: { FogStart: 120, FogEnd: 900, FogColor: [220, 230, 242] } },
    ui: { tokens_preset: "ocean", primary: [40, 170, 230], secondary: [170, 44, 46], surface: [16, 28, 44], text: [236, 244, 255], font: "Nunito", radius: 14, stroke: "1px ice blue at 0.4", notes: "frosted glass panels (Transparency 0.15), snow-cap on headers" },
    scale: { wall_height: 11, door: "5 x 9", snow_cap: "0.6 studs proud, 0.4 wider than the surface", notes: "steep roofs (45 degrees), snow caps as separate Snow parts on every top face" },
    motifs: ["snow caps", "pine trees (3 stacked cones)", "frozen lake (Ice, Reflectance 0.3)", "icicles (wedges)", "smoke from chimneys", "lanterns", "footprints (dark decals)"],
    vfx: ["snowfall (fx_create_vfx snow)", "breath mist", "chimney smoke", "aurora at night (beam_create)"],
    sfx: ["wind", "snow crunch", "fire crackle inside", "distant wolves"],
    avoid: ["pure white parts (use 236,242,250)", "harsh noon sun", "green ground", "flat snow with no caps or drifts"],
  };
  G.tropical = {
    summary: "Saturated turquoise water, white sand and lush palms; bright sun, high contrast shade, wooden boardwalks and bamboo.",
    palette: { base: col("lagoon", [40, 190, 200]), secondary: col("palm green", [70, 150, 70]), accent: col("hibiscus", [240, 70, 100]), ground: col("white sand", [238, 224, 190]), trim: col("bamboo", [196, 164, 92]), glow: col("sunset coral", [255, 140, 90]) },
    materials: { walls: ["WoodPlanks", "Fabric", "Sandstone"], floors: ["Sand", "WoodPlanks", "Grass"], trim: ["Wood", "Fabric", "Rock"], props: ["Wood", "Fabric", "Grass", "Glass"], avoid: ["Concrete", "Metal", "Neon", "Snow"] },
    lighting: { preset: "sunset_warm", postfx: "vivid", ClockTime: 14.8, Brightness: 3, Ambient: [110, 120, 110], OutdoorAmbient: [170, 180, 160], ExposureCompensation: 0.25, atmosphere: { Density: 0.26, Color: [230, 236, 240], Haze: 1.2, Glare: 0.9 }, bloom: { Intensity: 0.7, Size: 32, Threshold: 1.2 }, color_correction: { Saturation: 0.28, Contrast: 0.1, TintColor: [255, 250, 240] }, fog: { FogStart: 500, FogEnd: 3000, FogColor: [220, 234, 240] } },
    ui: { tokens_preset: "candy", primary: [40, 190, 200], secondary: [240, 70, 100], surface: [255, 250, 240], text: [40, 50, 60], font: "LuckiestGuy", radius: 20, stroke: "2px white at 0.2", notes: "wave-shaped dividers, sticker badges, bright pill buttons" },
    scale: { palm_height: "14-24", hut: "10 x 10 x 8", pier_width: 6, notes: "lean palms 10-15 degrees toward the sea; huts on 2-stud stilts" },
    motifs: ["palms (bent trunk from 5 tilted cylinders)", "huts on stilts", "piers", "surfboards", "tiki torches", "shells and starfish", "hammocks"],
    vfx: ["water sparkle (sparkles emitter, slow)", "sea spray", "torch flames", "floating petals"],
    sfx: ["waves", "gulls", "ukulele loop", "tiki torch crackle"],
    avoid: ["grey anything", "overcast light", "dark UI surfaces", "straight palms in a row"],
  };
  G.city = {
    summary: "Modern urban: concrete, glass and steel in neutral greys warmed by signage and street lights; strong vertical rhythm and ground-level clutter.",
    palette: { base: col("concrete", [150, 150, 148]), secondary: col("glass blue", [120, 160, 190]), accent: col("taxi yellow", [250, 200, 40]), ground: col("asphalt", [52, 52, 56]), trim: col("steel", [90, 94, 100]), glow: col("street lamp", [255, 214, 160]) },
    materials: { walls: ["Concrete", "Glass", "Brick", "Metal"], floors: ["Asphalt", "Concrete", "Pavement"], trim: ["Metal", "Glass", "SmoothPlastic"], props: ["Metal", "Plastic", "Glass", "Fabric"], avoid: ["Grass as a road", "Wood buildings", "Neon everywhere", "Marble streets"] },
    lighting: { preset: "realistic_noon", postfx: "filmic", ClockTime: 16, Brightness: 2.4, Ambient: [90, 92, 96], OutdoorAmbient: [140, 144, 150], ExposureCompensation: 0.1, atmosphere: { Density: 0.3, Color: [200, 206, 214], Haze: 1.5, Glare: 0.4 }, bloom: { Intensity: 0.4, Size: 28, Threshold: 1.3 }, color_correction: { Saturation: 0.05, Contrast: 0.1, TintColor: [250, 250, 255] }, fog: { FogStart: 300, FogEnd: 2200, FogColor: [196, 204, 214] } },
    ui: { tokens_preset: "clean_light", primary: [40, 100, 255], secondary: [250, 200, 40], surface: [250, 250, 253], text: [24, 26, 36], font: "GothamMedium", radius: 10, stroke: "none; subtle shadow", notes: "card layouts, map-pin icons, bold numerals" },
    scale: { floor_height: 13, door: "7 x 11", road_width: 28, sidewalk: 6, notes: "window grid 4 x 5 studs with 1-stud mullions; ground floor 1.3x taller; curb 0.5 proud" },
    motifs: ["window grids (model_array)", "awnings and shop fronts", "street lights", "traffic lights", "benches, bins, hydrants", "rooftop AC units and water tanks", "crosswalk stripes"],
    vfx: ["steam from manholes", "exhaust", "flickering sign", "rain on windows at night"],
    sfx: ["traffic bed", "crosswalk beep", "distant siren", "footsteps"],
    avoid: ["every building the same height and colour", "empty streets with no props", "no ground-floor detail", "grey sky with no atmosphere"],
  };
  G.cartoon = {
    summary: "Simulator / low-poly cartoon: bold flat colours, thick outlines, chunky rounded shapes, bright even light; readable at a glance from the lobby camera.",
    palette: { base: col("sky blue", [90, 190, 255]), secondary: col("grass green", [110, 210, 90]), accent: col("sunny yellow", [255, 220, 60]), ground: col("path tan", [226, 196, 140]), trim: col("outline navy", [30, 40, 70]), glow: col("coin gold", [255, 190, 50]) },
    materials: { walls: ["SmoothPlastic"], floors: ["SmoothPlastic", "Grass"], trim: ["SmoothPlastic", "Neon (pickups only)"], props: ["SmoothPlastic", "Neon"], avoid: ["Concrete", "CorrodedMetal", "Slate", "realistic textures"] },
    lighting: { preset: "realistic_noon", postfx: "clean", ClockTime: 13, Brightness: 3, Ambient: [130, 130, 130], OutdoorAmbient: [160, 160, 160], ExposureCompensation: 0.3, atmosphere: { Density: 0.2, Color: [220, 236, 255], Haze: 0.8, Glare: 0.3 }, bloom: { Intensity: 0.6, Size: 24, Threshold: 1.4 }, color_correction: { Saturation: 0.3, Contrast: 0.08, TintColor: [255, 255, 255] }, fog: { FogStart: 600, FogEnd: 4000, FogColor: [200, 228, 255] } },
    ui: { tokens_preset: "candy", primary: [90, 190, 255], secondary: [255, 220, 60], surface: [255, 255, 255], text: [40, 44, 70], font: "FredokaOne", radius: 16, stroke: "3px navy (30,40,70) at 0", notes: "thick UIStroke on every button and label, pop-in tween (Back), rainbow UIGradient on rewards" },
    scale: { tree: "10-16 (3 sphere canopy)", pickup: "2 x 2 spinning", notes: "exaggerate proportions: big heads, short bodies, oversized buttons; 2-stud grid" },
    motifs: ["spinning coins / pickups (Neon + tween)", "sphere-canopy trees", "chunky fences", "bouncy pads", "floating islands", "progress gates", "confetti on rewards"],
    vfx: ["coin sparkle", "confetti bursts", "level-up ring (fx_shockwave)", "trail on dash"],
    sfx: ["pop", "coin ding", "level-up jingle", "whoosh"],
    avoid: ["realistic materials", "dark or desaturated palettes", "thin fonts", "unlabelled icons"],
  };
  G.candy = {
    summary: "Pastel pinks and mints with glossy highlights, swirl and drip shapes, warm bright light and a sugar-sparkle layer over everything.",
    palette: { base: col("cotton pink", [255, 170, 210]), secondary: col("mint", [150, 236, 210]), accent: col("cherry", [230, 50, 90]), ground: col("vanilla", [255, 240, 220]), trim: col("chocolate", [96, 58, 40]), glow: col("lemon", [255, 236, 120]) },
    materials: { walls: ["SmoothPlastic", "Glass (hard candy)", "Marble (icing)"], floors: ["SmoothPlastic", "Fabric (frosting)"], trim: ["Neon (sprinkles)", "Glass", "SmoothPlastic"], props: ["SmoothPlastic", "Glass", "Neon"], avoid: ["Metal", "Concrete", "Brick", "earth tones except chocolate"] },
    lighting: { preset: "vaporwave", postfx: "dreamy", ClockTime: 13.5, Brightness: 2.8, Ambient: [150, 130, 150], OutdoorAmbient: [190, 170, 190], ExposureCompensation: 0.35, atmosphere: { Density: 0.25, Color: [255, 220, 240], Haze: 1.5, Glare: 0.6 }, bloom: { Intensity: 1, Size: 40, Threshold: 1 }, color_correction: { Saturation: 0.25, Contrast: 0.05, TintColor: [255, 245, 252] }, fog: { FogStart: 500, FogEnd: 3000, FogColor: [255, 226, 240] } },
    ui: { tokens_preset: "candy", primary: [255, 96, 160], secondary: [150, 236, 210], surface: [255, 244, 250], text: [90, 40, 70], font: "FredokaOne", radius: 24, stroke: "2px white at 0.1 with a glossy UIGradient", notes: "lollipop buttons, drip-shaped headers, sprinkle particle ImageLabels" },
    scale: { lollipop: "12 tall, head 5", notes: "round everything (Ball / Cylinder shapes), drips 1 x 3 wedges, oversized sweets as landmarks" },
    motifs: ["lollipops", "candy canes", "gumdrops", "chocolate rivers (Beam)", "icing drips", "giant cupcakes", "sprinkle confetti"],
    vfx: ["sugar sparkle", "bubble drift", "confetti", "steam from cocoa"],
    sfx: ["bubbly pops", "xylophone", "squish", "sparkle chime"],
    avoid: ["grey, brown except chocolate, black", "sharp corners", "realistic light"],
  };
  G.industrial = {
    summary: "Rust, concrete and warning yellow under flat sodium light; heavy machinery, pipes, grates and hazard markings everywhere.",
    palette: { base: col("concrete grey", [112, 112, 108]), secondary: col("rust", [128, 72, 40]), accent: col("hazard yellow", [250, 190, 20]), ground: col("oil-stained floor", [56, 56, 54]), trim: col("gunmetal", [60, 64, 70]), glow: col("sodium lamp", [255, 180, 90]) },
    materials: { walls: ["Concrete", "CorrodedMetal", "Metal", "Brick"], floors: ["DiamondPlate", "Concrete", "Metal"], trim: ["Metal", "DiamondPlate", "CorrodedMetal"], props: ["Metal", "Plastic", "Fabric", "Wood (pallets)"], avoid: ["Marble", "Grass", "Neon except warning lights", "Fabric walls"] },
    lighting: { preset: "overcast_moody", postfx: "noir", ClockTime: 17.8, Brightness: 1.4, Ambient: [60, 56, 50], OutdoorAmbient: [100, 96, 88], ExposureCompensation: 0, atmosphere: { Density: 0.45, Color: [170, 160, 140], Haze: 2.6, Glare: 0.2 }, bloom: { Intensity: 0.4, Size: 24, Threshold: 1.4 }, color_correction: { Saturation: -0.2, Contrast: 0.18, TintColor: [255, 236, 210] }, fog: { FogStart: 80, FogEnd: 700, FogColor: [120, 112, 100] } },
    ui: { tokens_preset: "retro", primary: [250, 190, 20], secondary: [0, 180, 255], surface: [28, 28, 32], text: [240, 236, 220], font: "Oswald", radius: 2, stroke: "2px hazard yellow at 0.3; diagonal stripe UIGradient on headers", notes: "stencil labels, riveted panels, gauge-style progress bars" },
    scale: { wall_height: 20, door: "8 x 12 (roller)", pipe_diameter: "1, 2, 4", catwalk_width: 4, notes: "pipes in bundles of 3 with brackets every 8 studs; catwalks 12 studs up; hazard stripes 1 stud" },
    motifs: ["pipes (model_pipe)", "catwalks and railings", "crates and barrels", "cranes", "conveyor belts (texture_add animated)", "hazard stripes", "chain-link fences"],
    vfx: ["steam bursts", "sparks (welding)", "smoke stacks", "flickering sodium lamps"],
    sfx: ["machinery hum", "metal clanks", "steam hiss", "alarm klaxon"],
    avoid: ["clean uniform grey", "no clutter", "bright white light", "rounded corners"],
  };
  G.underwater = {
    summary: "Deep teal gradients with caustic light, coral accents and particulate everywhere; slow motion, soft blue fog closing in.",
    palette: { base: col("deep teal", [16, 80, 100]), secondary: col("coral", [255, 110, 90]), accent: col("bioluminescent", [80, 255, 220]), ground: col("sea floor sand", [160, 150, 110]), trim: col("kelp", [40, 110, 70]), glow: col("caustic", [160, 230, 255]) },
    materials: { walls: ["Rock", "Slate", "Sand"], floors: ["Sand", "Pebble", "Rock"], trim: ["Neon (bioluminescence)", "Glass", "Marble (ruins)"], props: ["Rock", "Neon", "Glass", "Fabric (nets)"], avoid: ["Wood (except wrecks)", "Metal shine", "warm light", "Grass"] },
    lighting: { preset: "overcast_moody", postfx: "dreamy", ClockTime: 12, Brightness: 1.2, Ambient: [20, 60, 80], OutdoorAmbient: [30, 90, 120], ExposureCompensation: -0.1, atmosphere: { Density: 0.6, Color: [30, 110, 140], Haze: 3, Glare: 0 }, bloom: { Intensity: 0.8, Size: 48, Threshold: 1 }, color_correction: { Saturation: 0.1, Contrast: 0.1, TintColor: [170, 220, 255] }, fog: { FogStart: 20, FogEnd: 260, FogColor: [16, 70, 100] } },
    ui: { tokens_preset: "ocean", primary: [40, 170, 230], secondary: [255, 110, 90], surface: [10, 30, 46], text: [230, 244, 255], font: "Nunito", radius: 18, stroke: "1px aqua at 0.4", notes: "bubble-shaped badges, wavy UIGradient headers, slow float tween on panels" },
    scale: { coral: "2-8 clustered", ruins: "columns 12-16", notes: "cluster coral in 3 sizes; kelp as 1 x 10 tilted parts swaying with tweens" },
    motifs: ["coral clusters", "kelp forests", "sunken ruins and wrecks", "treasure chests", "jellyfish (Neon + PointLight, float tween)", "caustics (texture on sea floor)", "bubbles"],
    vfx: ["bubbles (fx_create_emitter rising)", "particulate drift", "caustic light flicker", "bioluminescent pulse"],
    sfx: ["muffled low-pass loop", "bubbles", "whale calls", "creaking wreck"],
    avoid: ["clear visibility (FogEnd above 400)", "warm colour cast", "fast motion", "flat sea floor"],
  };
  G.space = {
    summary: "Black void, star fields and distant nebula colours; hard key light with no fill, metallic stations with a single accent hue.",
    palette: { base: col("void", [6, 6, 12]), secondary: col("station grey", [150, 156, 170]), accent: col("nebula violet", [140, 80, 255]), ground: col("regolith", [92, 90, 96]), trim: col("solar gold", [230, 180, 60]), glow: col("thruster blue", [90, 170, 255]) },
    materials: { walls: ["Metal", "SmoothPlastic", "Foil"], floors: ["DiamondPlate", "Metal", "Slate (moon surface)"], trim: ["Neon", "Glass", "Metal"], props: ["Metal", "Glass", "Neon"], avoid: ["Wood", "Grass", "Fabric", "Brick"] },
    lighting: { preset: "space_void", postfx: "clean", ClockTime: 0, Brightness: 2.2, Ambient: [10, 10, 20], OutdoorAmbient: [20, 20, 36], ExposureCompensation: 0, atmosphere: { Density: 0, Color: [0, 0, 0], Haze: 0, Glare: 0 }, bloom: { Intensity: 0.9, Size: 40, Threshold: 1.2 }, color_correction: { Saturation: 0.05, Contrast: 0.2, TintColor: [235, 235, 255] }, fog: { FogStart: 1000, FogEnd: 100000, FogColor: [0, 0, 0] } },
    ui: { tokens_preset: "midnight", primary: [140, 80, 255], secondary: [230, 180, 60], surface: [10, 10, 20], text: [236, 236, 255], font: "Michroma", radius: 6, stroke: "1px violet at 0.5", notes: "orbit-ring progress bars, star-field background, telemetry-style labels" },
    scale: { module_diameter: 12, corridor: "8 x 8", notes: "hard shadows: GlobalShadows on, Brightness 2+, almost no ambient; everything modular in 4-stud rings" },
    motifs: ["solar panels", "airlocks", "antenna arrays", "asteroids (scaled rotated spheres with Slate)", "planet backdrop (huge sphere 2000 studs away)", "thrusters (Neon + fire emitter)", "star field (sky_set)"],
    vfx: ["thruster plumes", "drifting debris", "warp streaks (beam_create)", "shield hex shimmer"],
    sfx: ["deep hum", "radio chatter", "airlock cycle", "silence outside"],
    avoid: ["atmosphere density above 0.1", "warm fill light", "a visible default sky", "gravity-ignorant clutter"],
  };
  const ALIASES = {
    castle: "medieval", kingdom: "medieval", knight: "medieval", dungeon: "medieval", viking: "medieval",
    magic: "fantasy", enchanted: "fantasy", elf: "fantasy", wizard: "fantasy", rpg: "fantasy",
    "sci-fi": "scifi", "sci_fi": "scifi", futuristic: "scifi", lab: "scifi", spaceship: "scifi", station: "scifi", robot: "scifi",
    neon: "cyberpunk", synthwave: "cyberpunk", vaporwave: "cyberpunk", night_city: "cyberpunk",
    scary: "horror", haunted: "horror", zombie: "horror", backrooms: "horror", asylum: "horror",
    cafe: "cozy", home: "cozy", house: "cozy", village: "cozy", farm: "cozy", bakery: "cozy", hangout: "cozy",
    forest: "nature", jungle: "nature", woods: "nature", park: "nature", meadow: "nature", garden: "nature",
    sand: "desert", egypt: "desert", western: "desert", canyon: "desert", wasteland: "desert",
    snow: "winter", ice: "winter", arctic: "winter", christmas: "winter", frozen: "winter",
    beach: "tropical", island: "tropical", pirate: "tropical", summer: "tropical", hawaii: "tropical",
    urban: "city", town: "city", street: "city", roleplay: "city", school: "city", mall: "city", modern: "city",
    simulator: "cartoon", obby: "cartoon", tycoon: "cartoon", lowpoly: "cartoon", low_poly: "cartoon", kids: "cartoon", lobby: "cartoon", minigame: "cartoon",
    sweet: "candy", dessert: "candy", bakery_land: "candy", sugar: "candy",
    factory: "industrial", warehouse: "industrial", mine: "industrial", steampunk: "industrial", military: "industrial", bunker: "industrial",
    ocean: "underwater", sea: "underwater", atlantis: "underwater", aquarium: "underwater", reef: "underwater",
    moon: "space", galaxy: "space", planet: "space", mars: "space", asteroid: "space", cosmic: "space",
  };
  const GENRES = Object.keys(G);
  const UNIVERSAL = {
    composition: ["3 scales in every scene: landmark (40+ studs) / structure (10-20) / detail (under 3)", "odd-number clusters, 10-30 percent scale and rotation variation per repeated prop", "every surface has a trim, cap or skirting where it meets another", "silhouette test: hide materials, is it still recognisable?"],
    palette_rule: "60 percent base, 30 percent secondary, 10 percent accent; glow colour only on light sources and pickups; never default grey 163,162,165",
    lighting_rule: "set ClockTime, Ambient and OutdoorAmbient together; one Atmosphere, one Bloom, one ColorCorrection; GlobalShadows on; never leave ClockTime 14 / Brightness 3 / no Atmosphere",
    ui_rule: "design_tokens_set first; Scale sizes with UIAspectRatioConstraint or UISizeConstraint; UIPadding + UIListLayout in every container; UICorner + UIStroke; TextScaled with UITextSizeConstraint; one font family, 2 weights; hover and press tweens on every button",
    script_rule: "--!strict modules, task.wait, pcall around DataStore / HTTP / Marketplace, validated remotes, no print() in shipped code, scripts named for what they do",
    hand_off: "quality_audit >= " + PASS_SCORE + " then report the score, the palette hex, the lighting values and the screenshots",
  };

  function resolveGenre(raw) {
    const s = String(raw == null ? "" : raw).toLowerCase().trim();
    if (!s || s === "list" || s === "all") return null;
    if (G[s]) return s;
    const norm = s.replace(/[\s-]+/g, "_");
    if (G[norm]) return norm;
    if (ALIASES[norm]) return ALIASES[norm];
    const words = norm.split(/[_\/,.+&]+/).filter(Boolean);
    for (const w of words) { if (G[w]) return w; if (ALIASES[w]) return ALIASES[w]; }
    for (const k of GENRES) if (norm.includes(k)) return k;
    for (const k of Object.keys(ALIASES)) if (norm.includes(k)) return ALIASES[k];
    return null;
  }

  function recipeFor(genre, g) {
    const L = g.lighting, U = g.ui, P = g.palette;
    return [
      "brief_set {title, genre: " + JSON.stringify(genre) + ", palette: [" + ["base", "secondary", "accent", "ground", "trim", "glow"].map((k) => JSON.stringify(P[k].hex)).join(", ") + "], scale: " + JSON.stringify(g.scale.notes || "") + "}",
      "style_lighting_apply {genre: " + JSON.stringify(genre) + "}  (or lighting_set_preset {preset: " + JSON.stringify(L.preset) + "} + postfx_cinematic {preset: " + JSON.stringify(L.postfx) + "})",
      "design_tokens_set {preset: " + JSON.stringify(U.tokens_preset) + ", primary: [" + U.primary.join(", ") + "], secondary: [" + U.secondary.join(", ") + "], font: " + JSON.stringify(U.font) + "}",
      "build: material_set / color_set with base " + P.base.hex + " (60%), secondary " + P.secondary.hex + " (30%), accent " + P.accent.hex + " (10%), ground " + P.ground.hex + ", trim " + P.trim.hex + "; glow " + P.glow.hex + " on light sources only",
      "quality_audit {} until score >= " + PASS_SCORE,
    ];
  }

  function styleGuideLocal(a) {
    a = a || {};
    const genre = resolveGenre(a.genre || a.style || a.theme || a.name);
    if (!genre) {
      const list = GENRES.map((k) => ({ genre: k, summary: G[k].summary, palette: [G[k].palette.base.hex, G[k].palette.secondary.hex, G[k].palette.accent.hex] }));
      return { ok: true, data: { version: QUALITY_VERSION, genres: list, aliases: Object.keys(ALIASES).length, universal: UNIVERSAL }, text: "style_guide: pass genre (one of " + GENRES.join(", ") + " - aliases like castle / neon / forest / snow / simulator / obby also work). " + (a.genre ? "'" + a.genre + "' did not match; pick the closest." : "") };
    }
    const g = G[genre];
    const compact = a.compact === true || a.palette_only === true;
    const data = { version: QUALITY_VERSION, genre, summary: g.summary, palette: g.palette, palette_rule: UNIVERSAL.palette_rule };
    if (!compact) Object.assign(data, { materials: g.materials, lighting: g.lighting, ui: g.ui, scale: g.scale, motifs: g.motifs, vfx: g.vfx, sfx: g.sfx, avoid: g.avoid, universal: UNIVERSAL, recipe: recipeFor(genre, g) });
    const txt = "STYLE GUIDE " + genre + ": " + g.summary + " Palette base " + g.palette.base.hex + " / secondary " + g.palette.secondary.hex + " / accent " + g.palette.accent.hex + " / ground " + g.palette.ground.hex + " / trim " + g.palette.trim.hex + " / glow " + g.palette.glow.hex + ". Lighting ClockTime " + g.lighting.ClockTime + ", Brightness " + g.lighting.Brightness + ", preset " + g.lighting.preset + " + postfx " + g.lighting.postfx + ". UI tokens " + g.ui.tokens_preset + " / font " + g.ui.font + " / radius " + g.ui.radius + ". Build to these numbers (brief_set stores them), then quality_audit before hand-off.";
    return { ok: true, data, text: txt };
  }

  // ───────────────────────── Luau prelude ─────────────────────────
  const HEAD = `local HttpService=game:GetService('HttpService')
local Lighting=game:GetService('Lighting')
local Workspace=game:GetService('Workspace')
local StarterGui=game:GetService('StarterGui')
local ServerStorage=game:GetService('ServerStorage')
local ChangeHistoryService=game:GetService('ChangeHistoryService')
local QUALITY_VERSION=${q(QUALITY_VERSION)}
local PASS_SCORE=${PASS_SCORE}
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end local cur=game for seg in string.gmatch(p,'[^%.]+') do local okS,svc=pcall(function() return cur==game and game:GetService(seg) or nil end) local nxt=(okS and svc) or cur:FindFirstChild(seg) if not nxt then return nil end cur=nxt end return cur end
local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end
local function wp(label) local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording(label or 'ORscript quality') end) return okW and w or nil end
local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end
local function short(i) local okN,n=pcall(function() return i:GetFullName() end) n=okN and n or tostring(i) return (n:gsub('^Workspace%.','WS.'):gsub('^StarterGui%.','SG.'):gsub('^ServerScriptService%.','SSS.'):gsub('^ReplicatedStorage%.','RS.')) end
local function getp(i,k) local okP,v=pcall(function() return i[k] end) if okP then return v end return nil end
local function near(c,r,g,b,tol) if typeof(c)~='Color3' then return false end tol=(tol or 6)/255 return math.abs(c.R-r/255)<=tol and math.abs(c.G-g/255)<=tol and math.abs(c.B-b/255)<=tol end
local function isDefaultGrey(c) return near(c,163,162,165,6) end
local function enumName(v) if v==nil then return '' end if typeof(v)=='EnumItem' or type(v)=='table' then local okN,n=pcall(function() return v.Name end) if okN and n then return tostring(n) end end return (tostring(v):gsub('^Enum%.%w+%.','')) end
local function hexToC3(h) h=tostring(h or ''):gsub('#','') if #h<6 then return nil end local r,g,b=tonumber(h:sub(1,2),16),tonumber(h:sub(3,4),16),tonumber(h:sub(5,6),16) if not (r and g and b) then return nil end return Color3.fromRGB(r,g,b) end
local function cdist(a,b) local dr,dg,db=a.R-b.R,a.G-b.G,a.B-b.B return math.sqrt(dr*dr+dg*dg+db*db) end
local function inHumanoid(i) local m=i:FindFirstAncestorOfClass('Model') while m do if m:FindFirstChildOfClass('Humanoid') then return true end m=m:FindFirstAncestorOfClass('Model') end return false end
local function skipTree(i) local n=i.Name return n=='OR_GFX' or n=='Terrain' or n=='Camera' or n:sub(1,8)=='_ORBrief' end
local function skipAnc(i) local p=i while p and p~=game do if skipTree(p) then return true end p=p.Parent end return false end
local function briefFolder(create) local f=ServerStorage:FindFirstChild('_ORBrief') if not f and create then f=Instance.new('StringValue') f.Name='_ORBrief' f.Value='{}' f.Parent=ServerStorage end return f end
local function briefRead() local f=briefFolder(false) if not f then return nil end local okJ,j=pcall(function() return HttpService:JSONDecode(f.Value) end) if okJ and type(j)=='table' and next(j) then return j end return nil end
local function mkRoots(pathArg) local R={build={},ui={},scripts={},lighting=true,scoped=false} if pathArg and pathArg~='' then local r=need(pathArg,'path') R.scoped=true R.lighting=false if r:IsA('LayerCollector') or r:IsA('GuiObject') or r:IsDescendantOf(StarterGui) then R.ui={r} elseif r:IsA('LuaSourceContainer') then R.scripts={r} elseif r==Lighting then R.lighting=true else R.build={r} R.ui={r} R.scripts={r} end return R end R.build={Workspace} R.ui={StarterGui} local svcs={'ServerScriptService','ServerStorage','ReplicatedStorage','ReplicatedFirst','StarterGui','StarterPlayer','StarterPack','Workspace'} for _,n in ipairs(svcs) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then R.scripts[#R.scripts+1]=s end end return R end
local function eachDesc(roots,fn,limit) local n=0 for _,r in ipairs(roots) do if not skipTree(r) then fn(r) n=n+1 end for _,d in ipairs(r:GetDescendants()) do if limit and n>=limit then return n end if not skipAnc(d) then fn(d) n=n+1 end end end return n end`;

  // ───────────────────────── builders ─────────────────────────
  const B = {};

  B.brief_set = (a) => {
    const brief = {};
    for (const k of ["title", "genre", "style", "palette", "scale", "must_have", "avoid", "audience", "notes", "reference"]) if (a[k] != null && a[k] !== "") brief[k] = a[k];
    if (typeof brief.palette === "string") brief.palette = brief.palette.split(/[\s,;]+/).filter(Boolean);
    if (typeof brief.must_have === "string") brief.must_have = brief.must_have.split(/\s*[;,]\s*|\n+/).filter(Boolean);
    if (typeof brief.avoid === "string") brief.avoid = brief.avoid.split(/\s*[;,]\s*|\n+/).filter(Boolean);
    const genre = resolveGenre(brief.genre || brief.style);
    if (genre && !brief.palette) brief.palette = ["base", "secondary", "accent", "ground", "trim", "glow"].map((k) => G[genre].palette[k].hex);
    if (genre) brief.genre = genre;
    return [
      "local NEW=HttpService:JSONDecode(" + jj(brief) + ")",
      "local REPLACE=" + (a.replace === true ? "true" : "false"),
      "local f=briefFolder(true) local cur=(not REPLACE) and briefRead() or {}",
      "for k,v in pairs(NEW) do cur[k]=v end",
      "cur.updated_at=os.time() cur.version=QUALITY_VERSION",
      "if not cur.title or cur.title=='' then error('brief_set needs a title (and ideally genre, palette, scale, must_have, avoid)') end",
      "f.Value=HttpService:JSONEncode(cur) f:SetAttribute('Title',tostring(cur.title)) f:SetAttribute('Genre',tostring(cur.genre or ''))",
      "local pal=type(cur.palette)=='table' and table.concat(cur.palette,' ') or 'none'",
      "return ok({brief=cur,path='ServerStorage._ORBrief'},'BRIEF saved: '..tostring(cur.title)..' ('..tostring(cur.genre or cur.style or 'no genre')..'), palette '..pal..'. Build to it: every material_set / color_set / design_tokens_set / lighting value comes from this brief; quality_audit checks parts against the palette.')",
    ].join("\n");
  };

  B.brief_get = () => [
    "local b=briefRead()",
    "if not b then return ok({has_brief=false},'No brief yet. Run style_guide {genre} for the numbers, then brief_set {title, genre, palette, scale, must_have, avoid} once - every later colour, material, lighting and UI value comes from it.') end",
    "local must=type(b.must_have)=='table' and table.concat(b.must_have,'; ') or ''",
    "return ok({has_brief=true,brief=b},'BRIEF: '..tostring(b.title)..' ['..tostring(b.genre or b.style or '')..'] palette '..(type(b.palette)=='table' and table.concat(b.palette,' ') or '-')..(must~='' and ('; must have: '..must) or '')..(b.scale and ('; scale: '..tostring(b.scale)) or '')..'. Keep building to it.')",
  ].join("\n");

  B.style_lighting_apply = (a) => {
    const genre = resolveGenre(a.genre || a.style || a.theme);
    if (!genre) throw new Error("style_lighting_apply needs genre (one of " + GENRES.join(", ") + ")");
    const L = G[genre].lighting;
    const strength = Math.max(0.2, Math.min(1.5, nn(a.strength, 1)));
    const cfg = { genre, L, strength, keep_time: a.keep_time === true };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local L=A.L local s=A.strength local rec=wp('ORscript style lighting') local done={}",
      "local function c3(t) return Color3.fromRGB(t[1],t[2],t[3]) end",
      "if not A.keep_time then Lighting.ClockTime=L.ClockTime done[#done+1]='ClockTime '..L.ClockTime end",
      "Lighting.Brightness=L.Brightness Lighting.Ambient=c3(L.Ambient) Lighting.OutdoorAmbient=c3(L.OutdoorAmbient) Lighting.ExposureCompensation=L.ExposureCompensation*s Lighting.GlobalShadows=true",
      "pcall(function() Lighting.FogStart=L.fog.FogStart Lighting.FogEnd=L.fog.FogEnd Lighting.FogColor=c3(L.fog.FogColor) end)",
      "pcall(function() Lighting.EnvironmentDiffuseScale=0.5 Lighting.EnvironmentSpecularScale=0.5 end)",
      "local function one(class,name,props) local e=nil for _,c in ipairs(Lighting:GetChildren()) do if c:IsA(class) and (c.Name==name or c:GetAttribute('OR_Style')) then e=c break end end if not e then for _,c in ipairs(Lighting:GetChildren()) do if c:IsA(class) then e=c break end end end if not e then e=Instance.new(class) e.Name=name e.Parent=Lighting end e:SetAttribute('OR_Style',A.genre) for k,v in pairs(props) do pcall(function() e[k]=v end) end done[#done+1]=class return e end",
      "one('Atmosphere','OR_Atmosphere',{Density=L.atmosphere.Density*s,Color=c3(L.atmosphere.Color),Decay=c3(L.atmosphere.Color),Haze=L.atmosphere.Haze*s,Glare=L.atmosphere.Glare*s,Offset=0.25})",
      "one('BloomEffect','OR_Bloom',{Enabled=true,Intensity=L.bloom.Intensity*s,Size=L.bloom.Size,Threshold=L.bloom.Threshold})",
      "one('ColorCorrectionEffect','OR_ColorCorrection',{Enabled=true,Saturation=L.color_correction.Saturation*s,Contrast=L.color_correction.Contrast*s,TintColor=c3(L.color_correction.TintColor),Brightness=0})",
      "if L.atmosphere.Glare>0.4 then one('SunRaysEffect','OR_SunRays',{Enabled=true,Intensity=0.08*s,Spread=0.6}) end",
      "wpDone(rec)",
      "return ok({genre=A.genre,applied=done,lighting=L},'Lighting styled for '..A.genre..': ClockTime '..L.ClockTime..', Brightness '..L.Brightness..', Atmosphere density '..L.atmosphere.Density..', Bloom '..L.bloom.Intensity..', preset equivalent '..L.preset..' / postfx '..L.postfx..'. Take or_screenshot and judge it; fine-tune with lighting_set / bloom_set / color_correction_set.')",
    ].join("\n");
  };

  B.quality_audit = (a) => {
    const cfg = { path: a.path || "", scope: String(a.scope || "all").toLowerCase(), limit: Math.max(50, Math.min(20000, nn(a.limit, 6000))), max_findings: Math.max(5, Math.min(60, nn(a.max_findings, 24))), max_scripts: Math.max(10, Math.min(600, nn(a.max_scripts, 250))) };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local R=mkRoots(A.path) local scope=A.scope",
      "local function want(s) return scope=='all' or scope==s end",
      "local F={} local ded=0 local counts={}",
      "local function add(sev,kind,w,msg,fix,paths) F[#F+1]={severity=sev,kind=kind,weight=w,message=msg,fix=fix,examples=paths} ded=ded+w end",
      "local function ex(list) local t={} for i=1,math.min(5,#list) do t[i]=short(list[i]) end if #list>5 then t[#t+1]='+'..(#list-5)..' more' end return t end",
      "local brief=briefRead() local briefPal={} if brief and type(brief.palette)=='table' then for _,h in ipairs(brief.palette) do local c=hexToC3(h) if c then briefPal[#briefPal+1]=c end end end",
      // BUILD
      "if want('build') and #R.build>0 then",
      " local parts,grey,badName,unanch,loose,noPrim,models,offPal,coloured={},{},{},{},{},{},{},{},0 local mats,cols={},{} local shapes={plain=0,other=0}",
      " local function partLike(d) return d:IsA('BasePart') and not d:IsA('Terrain') end",
      " eachDesc(R.build,function(d)",
      "  if partLike(d) then",
      "   if inHumanoid(d) then return end",
      "   parts[#parts+1]=d",
      "   local isBase=(d.Name=='Baseplate' or d.Name=='SpawnLocation')",
      "   local mat=enumName(getp(d,'Material')) mats[mat]=(mats[mat] or 0)+1",
      "   local c=getp(d,'Color') if typeof(c)=='Color3' then local key=math.floor(c.R*7+0.5)..','..math.floor(c.G*7+0.5)..','..math.floor(c.B*7+0.5) cols[key]=true end",
      "   if not isBase and isDefaultGrey(c) and mat=='Plastic' then grey[#grey+1]=d end",
      "   if not isBase and typeof(c)=='Color3' and #briefPal>0 and not isDefaultGrey(c) then coloured=coloured+1 local best=10 for _,pc in ipairs(briefPal) do local dd=cdist(c,pc) if dd<best then best=dd end end if best>0.42 then offPal[#offPal+1]=d end end",
      "   local n=d.Name if n==d.ClassName or n=='Part' or n=='Union' or n=='Wedge' or n:match('^Part%d+$') then badName[#badName+1]=d end",
      "   if getp(d,'Anchored')==false and not d:FindFirstChildWhichIsA('JointInstance') and not d:FindFirstChildWhichIsA('WeldConstraint') and not d:FindFirstChildWhichIsA('Constraint') and not d:FindFirstChildWhichIsA('Attachment') then local par=d.Parent local held=false if par and par:IsA('BasePart') and par:FindFirstChildWhichIsA('WeldConstraint') then held=true end if not held then unanch[#unanch+1]=d end end",
      "   if d.Parent==Workspace and not isBase then loose[#loose+1]=d end",
      "   local sh=getp(d,'Shape') if d.ClassName=='Part' and (sh==nil or sh==Enum.PartType.Block) then shapes.plain=shapes.plain+1 else shapes.other=shapes.other+1 end",
      "  elseif d:IsA('Model') and not d:FindFirstChildOfClass('Humanoid') then",
      "   local np=0 for _,c in ipairs(d:GetChildren()) do if c:IsA('BasePart') then np=np+1 end end",
      "   if np>0 then models[#models+1]=d if not getp(d,'PrimaryPart') then noPrim[#noPrim+1]=d end end",
      "   if d.Name=='Model' then badName[#badName+1]=d end",
      "  end",
      " end,A.limit)",
      " local nm=0 for _ in pairs(mats) do nm=nm+1 end local nc=0 for _ in pairs(cols) do nc=nc+1 end",
      " counts.parts=#parts counts.models=#models counts.materials=nm counts.colour_buckets=nc counts.default_grey=#grey counts.default_names=#badName counts.unanchored=#unanch counts.loose_in_workspace=#loose counts.models_without_primary=#noPrim counts.off_brief_palette=#offPal",
      " if #parts==0 then if R.scoped or scope=='build' then add('info','empty_build',0,'No parts in scope - nothing built yet.','part_create blockout at real scale, then model_build / model_wall and a material_set + color_set palette',{}) end else",
      "  if #grey>0 then add(#grey>=4 and 'high' or 'medium','default_grey',math.min(#grey*4,20),#grey..' part(s) still default grey Plastic (163,162,165).','style_guide {genre} for a palette, then material_set {path, material} + color_set {path, color} per role (base / secondary / accent / ground / trim); quality_fix cannot choose colours for you',ex(grey)) end",
      "  if #parts>=8 and nm<=1 then add('medium','monotone_material',6,'Every part uses the same material ('..next(mats)..').','mix 3-5 materials from style_guide.materials: walls / floors / trim / props each get their own',ex(parts)) end",
      "  if #parts>=8 and nc<=2 then add('medium','flat_palette',6,'Only '..nc..' colour bucket(s) across '..#parts..' parts.','60 / 30 / 10 palette: base, secondary, accent (+ ground, trim) from style_guide',ex(parts)) end",
      "  if #parts>=12 and shapes.other==0 then add('low','boxy',4,'All '..#parts..' parts are plain blocks - no wedges, cylinders, MeshParts or CSG.','add trims, wedges, cylinders and props: model_build, archway_generate, roof_structure_build, model_subtract, prop clones',ex(parts)) end",
      "  if #unanch>0 then add(#unanch>=3 and 'high' or 'medium','unanchored',math.min(#unanch*3,15),#unanch..' unanchored part(s) without joints will fall at runtime.','quality_fix {fixes:[\"anchor\"]} (or anchored_set) - moving assemblies need weld_assemble instead',ex(unanch)) end",
      "  if #noPrim>0 then add('medium','no_primary_part',math.min(#noPrim*2,6),#noPrim..' Model(s) without PrimaryPart (pivot / MoveTo / tween unreliable).','quality_fix {fixes:[\"primary_part\"]} or set_primary_part',ex(noPrim)) end",
      "  if #badName>0 then add(#badName>=6 and 'medium' or 'low','default_names',math.min(#badName,8),#badName..' instance(s) still named by class (Part / Model / Union).','quality_fix {fixes:[\"names\"]} renames by material + role; instance_rename for the hero objects',ex(badName)) end",
      "  if #loose>=4 then add('low','loose_parts',math.min(#loose,6),#loose..' part(s) sit directly in Workspace instead of a Model / Folder.','model_group {paths, name} per object, folder_create per category',ex(loose)) end",
      "  if #briefPal>0 and coloured>=6 and #offPal*100/coloured>35 then add('medium','off_brief_palette',5,math.floor(#offPal*100/coloured)..'% of coloured parts are far from the brief palette.','color_set to the brief colours (brief_get lists them) or brief_set {palette} if the palette changed deliberately',ex(offPal)) end",
      " end",
      "end",
      // LIGHTING
      "if want('lighting') and R.lighting then",
      " local ct,br=getp(Lighting,'ClockTime'),getp(Lighting,'Brightness') local amb=getp(Lighting,'Ambient')",
      " local hasAtm,hasBloom,hasCC=false,false,false for _,c in ipairs(Lighting:GetChildren()) do if c:IsA('Atmosphere') then hasAtm=true elseif c:IsA('BloomEffect') and getp(c,'Enabled')~=false then hasBloom=true elseif c:IsA('ColorCorrectionEffect') and getp(c,'Enabled')~=false then hasCC=true end end",
      " counts.lighting={ClockTime=ct,Brightness=br,atmosphere=hasAtm,bloom=hasBloom,color_correction=hasCC}",
      " local untouched=(ct==14 and near(amb,70,70,70,2) and not hasAtm)",
      " if untouched then add('high','lighting_untouched',8,'Lighting is at Studio defaults (ClockTime 14, Brightness '..tostring(br)..', Ambient 70,70,70).','style_lighting_apply {genre} (one call) or lighting_set_preset / postfx_cinematic, then or_screenshot',{'Lighting'}) end",
      " if not hasAtm then add('medium','no_atmosphere',4,'No Atmosphere - the sky reads flat and distance has no depth.','style_lighting_apply {genre} or atmosphere_setup / atmosphere_set {density 0.3-0.45}',{'Lighting'}) end",
      " if not hasBloom and not hasCC then add('low','no_post_stack',3,'No Bloom / ColorCorrection - no glow on lights, no colour grade.','postfx_cinematic {preset} or bloom_set + color_correction_set',{'Lighting'}) end",
      " if getp(Lighting,'GlobalShadows')==false then add('low','no_shadows',2,'GlobalShadows is off.','lighting_set {property:\"GlobalShadows\", value:\"true\"}',{'Lighting'}) end",
      "end",
      // UI
      "if want('ui') and #R.ui>0 then",
      " local guis,rawFrames,borders,noCorner,defFont,unscaled,offsetOnly,noLayout,texts={},{},{},{},{},{},{},{},0",
      " local function visibleBg(d) return (getp(d,'BackgroundTransparency') or 0)<0.95 end",
      " eachDesc(R.ui,function(d)",
      "  if d:IsA('LayerCollector') then if d.Name~='OR_GFX_Overlay' then guis[#guis+1]=d end return end",
      "  if not d:IsA('GuiObject') then return end",
      "  if d:FindFirstAncestor('OR_GFX_Overlay') then return end",
      "  local isText=d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox')",
      "  local bg=getp(d,'BackgroundColor3') local vis=visibleBg(d)",
      "  if vis and near(bg,255,255,255,1) and (getp(d,'BorderSizePixel') or 0)>0 and (d:IsA('Frame') or d:IsA('TextButton') or d:IsA('TextLabel') or d:IsA('ScrollingFrame')) then rawFrames[#rawFrames+1]=d",
      "  elseif vis and (getp(d,'BorderSizePixel') or 0)>0 then borders[#borders+1]=d end",
      "  if vis and (d:IsA('Frame') or d:IsA('GuiButton') or d:IsA('ScrollingFrame')) and not d:FindFirstChildOfClass('UICorner') then noCorner[#noCorner+1]=d end",
      "  if isText then texts=texts+1 local f=enumName(getp(d,'Font')) if f=='Legacy' or f=='SourceSans' or f=='Arial' or f=='SourceSansBold' then defFont[#defFont+1]=d end",
      "   if getp(d,'TextScaled')==false and not d:FindFirstChildOfClass('UITextSizeConstraint') and (getp(d,'TextSize') or 14)<=14 and (getp(d,'AutomaticSize')==nil or getp(d,'AutomaticSize')==Enum.AutomaticSize.None) then unscaled[#unscaled+1]=d end end",
      "  local par=d.Parent if par and par:IsA('LayerCollector') then local sz=getp(d,'Size') if sz and sz.X.Scale==0 and sz.Y.Scale==0 and (sz.X.Offset>0 or sz.Y.Offset>0) then offsetOnly[#offsetOnly+1]=d end end",
      "  if d:IsA('Frame') or d:IsA('ScrollingFrame') then local kids=0 for _,c in ipairs(d:GetChildren()) do if c:IsA('GuiObject') then kids=kids+1 end end if kids>=3 and not d:FindFirstChildWhichIsA('UILayout') and not d:FindFirstChildOfClass('UIPadding') then noLayout[#noLayout+1]=d end end",
      " end,A.limit)",
      " counts.ui={screen_guis=#guis,text_objects=texts,raw_default_frames=#rawFrames,legacy_borders=#borders,no_uicorner=#noCorner,default_font=#defFont,unscaled_text=#unscaled,offset_only_roots=#offsetOnly,containers_without_layout=#noLayout}",
      " if #guis==0 and (R.scoped or scope=='ui') then add('info','no_ui',0,'No ScreenGui in scope.','design_tokens_set {preset, primary} then ui_screen_generate {kind} / ui_from_spec',{}) end",
      " if #rawFrames>0 then add(#rawFrames>=3 and 'high' or 'medium','raw_default_frames',math.min(#rawFrames*3,15),#rawFrames..' white 1px-border default Frame(s) / label(s) - the \"grey Frame\" look.','design_tokens_set {preset, primary} then ui_apply_tokens / ui_apply_theme {path}; quality_fix {fixes:[\"ui\"]} strips borders and adds UICorner first',ex(rawFrames)) end",
      " if #borders>0 then add('low','legacy_borders',math.min(#borders,6),#borders..' element(s) with BorderSizePixel > 0 (dated look).','quality_fix {fixes:[\"ui\"]} sets BorderSizePixel 0 and adds UIStroke-ready corners',ex(borders)) end",
      " if #noCorner>=2 then add('low','no_uicorner',math.min(#noCorner,6),#noCorner..' container(s) / button(s) with no UICorner.','quality_fix {fixes:[\"ui\"]} or ui_add_element UICorner {radius 8-16}',ex(noCorner)) end",
      " if #defFont>0 then add(#defFont>=3 and 'medium' or 'low','default_font',math.min(#defFont*2,10),#defFont..' text object(s) in the default font (Legacy / SourceSans / Arial).','design_tokens_set {font} + ui_apply_tokens, or quality_fix {fixes:[\"ui\"]} (GothamMedium)',ex(defFont)) end",
      " if #unscaled>0 then add('low','unscaled_text',math.min(#unscaled,6),#unscaled..' text object(s) at fixed 14px with no TextScaled / UITextSizeConstraint (unreadable on phones, clipped on 4K).','quality_fix {fixes:[\"ui\"]} enables TextScaled + UITextSizeConstraint',ex(unscaled)) end",
      " if #offsetOnly>0 then add(#offsetOnly>=2 and 'high' or 'medium','offset_only_roots',math.min(#offsetOnly*4,12),#offsetOnly..' top-level element(s) sized in Offset only - they will not fit other screens.','ui_make_responsive {path} / ui_set_scale + UIAspectRatioConstraint (ui_constraints)',ex(offsetOnly)) end",
      " if #noLayout>0 then add('low','no_layout',math.min(#noLayout*2,8),#noLayout..' container(s) with 3+ children but no UIListLayout / UIGridLayout / UIPadding.','ui_add_element UIListLayout {padding} + UIPadding, or rebuild the screen with ui_from_spec',ex(noLayout)) end",
      "end",
      // SCRIPTS
      "if want('scripts') and #R.scripts>0 then",
      " local n,legacy,localInServer,lpInServer,dsNoPcall,noStrict,badName,instParent,lowerConnect,prints,todos=0,{},{},{},{},{},{},{},{},0,0",
      " eachDesc(R.scripts,function(d)",
      "  if not d:IsA('LuaSourceContainer') or n>=A.max_scripts then return end",
      "  local src=getp(d,'Source') if type(src)~='string' or #src==0 then return end",
      "  if d:FindFirstAncestor('OR_GFX') then return end",
      "  n=n+1",
      "  if src:find('%f[%w_%.:]wait%(') or src:find('%f[%w_%.:]spawn%(') or src:find('%f[%w_%.:]delay%(') then legacy[#legacy+1]=d end",
      "  if d:IsA('LocalScript') and (d:IsDescendantOf(game:GetService('ServerScriptService')) or d:IsDescendantOf(ServerStorage)) then localInServer[#localInServer+1]=d end",
      "  if d.ClassName=='Script' and d:IsDescendantOf(game:GetService('ServerScriptService')) and src:find('%.LocalPlayer') then local rc=getp(d,'RunContext') if rc==nil or rc==Enum.RunContext.Legacy or rc==Enum.RunContext.Server then lpInServer[#lpInServer+1]=d end end",
      "  if src:find('GetDataStore%(') and not src:find('pcall') and not src:find('xpcall') then dsNoPcall[#dsNoPcall+1]=d end",
      "  if d:IsA('ModuleScript') and not src:sub(1,300):find('%-%-!strict') and not src:sub(1,300):find('%-%-!nonstrict') then noStrict[#noStrict+1]=d end",
      "  if d.Name==d.ClassName then badName[#badName+1]=d end",
      "  if src:find('Instance%.new%(%s*[\"\\'][%w]+[\"\\']%s*,') then instParent[#instParent+1]=d end",
      "  if src:find(':connect%(') then lowerConnect[#lowerConnect+1]=d end",
      "  local _,pc=src:gsub('%f[%w_%.:]print%(','') prints=prints+pc",
      "  local _,tc=src:gsub('TODO','') todos=todos+tc",
      " end)",
      " counts.scripts={scanned=n,legacy_wait=#legacy,localscript_in_server=#localInServer,localplayer_in_server_script=#lpInServer,datastore_without_pcall=#dsNoPcall,modules_without_strict=#noStrict,default_names=#badName,instance_new_parent_arg=#instParent,lowercase_connect=#lowerConnect,print_calls=prints,todos=todos}",
      " if n==0 then if R.scoped or scope=='scripts' then add('info','no_scripts',0,'No scripts in scope.','script_create / module_scaffold',{}) end else",
      "  if #localInServer>0 then add('high','localscript_in_server',math.min(#localInServer*5,10),#localInServer..' LocalScript(s) in a server container - they never run.','move them to StarterPlayerScripts / StarterGui (move_path) or rewrite as a Script',ex(localInServer)) end",
      "  if #lpInServer>0 then add('high','localplayer_in_server',math.min(#lpInServer*5,10),#lpInServer..' server Script(s) read Players.LocalPlayer (always nil on the server).','use the player passed by the event / PlayerAdded; client-only code belongs in a LocalScript',ex(lpInServer)) end",
      "  if #dsNoPcall>0 then add('high','datastore_without_pcall',math.min(#dsNoPcall*5,10),#dsNoPcall..' script(s) call DataStores without pcall - one throttle wipes the session.','wrap GetAsync / SetAsync / UpdateAsync in pcall + retry (datastore_profile_scaffold / profile_setup do this for you)',ex(dsNoPcall)) end",
      "  if #legacy>0 then add(#legacy>=3 and 'medium' or 'low','legacy_wait',math.min(#legacy*2,10),#legacy..' script(s) use wait() / spawn() / delay().','script_deprecations_fix {path} per script (task.wait / task.spawn / task.delay)',ex(legacy)) end",
      "  if #noStrict>0 then add('low','modules_without_strict',math.min(#noStrict,5),#noStrict..' ModuleScript(s) without --!strict.','prepend --!strict (multi_edit) and fix the type errors script_check reports',ex(noStrict)) end",
      "  if prints>8 then add('low','debug_prints',2,prints..' print() calls left in shipped scripts.','remove or route through a Debug module with a flag',{}) end",
      "  if #badName>0 then add('low','script_default_names',math.min(#badName,5),#badName..' script(s) still named Script / LocalScript / ModuleScript.','instance_rename to what they do (CoinService, ShopController, Types)',ex(badName)) end",
      "  if #instParent>0 then add('low','instance_new_parent_arg',math.min(#instParent,3),#instParent..' script(s) pass parent as the 2nd argument of Instance.new (property replication cost).','set properties first, then .Parent last',ex(instParent)) end",
      "  if #lowerConnect>0 then add('low','lowercase_connect',math.min(#lowerConnect,3),#lowerConnect..' script(s) use :connect( (deprecated).','script_deprecations_fix {path}',ex(lowerConnect)) end",
      " end",
      "end",
      // SCORE
      "table.sort(F,function(x,y) if x.weight~=y.weight then return x.weight>y.weight end return x.kind<y.kind end)",
      "local score=math.max(0,100-ded) local grade=(score>=90 and 'A') or (score>=80 and 'B') or (score>=65 and 'C') or (score>=50 and 'D') or 'F'",
      "local sevN={high=0,medium=0,low=0,info=0} for _,f in ipairs(F) do sevN[f.severity]=(sevN[f.severity] or 0)+1 end",
      "local out={} for i=1,math.min(A.max_findings,#F) do out[i]=F[i] end",
      "local top={} for i=1,math.min(3,#F) do if F[i].weight>0 then top[#top+1]=F[i].kind..' -> '..F[i].fix end end",
      "local pass=score>=PASS_SCORE",
      "local verdict=pass and ('PASS - hand-off allowed; report the score and the remaining low items.') or ('FAIL - fix the high / medium findings (quality_fix for the mechanical ones), then quality_audit again until score >= '..PASS_SCORE..'.')",
      "local scopeTxt=(A.path~='' and A.path or 'whole place')..(scope~='all' and (' / '..scope) or '')",
      "return ok({version=QUALITY_VERSION,score=score,grade=grade,pass=pass,pass_score=PASS_SCORE,scope=scopeTxt,findings=out,total_findings=#F,severity=sevN,counts=counts,brief=brief},'QUALITY '..score..'/100 ('..grade..') for '..scopeTxt..': '..sevN.high..' high, '..sevN.medium..' medium, '..sevN.low..' low. '..(#top>0 and ('Top fixes: '..table.concat(top,' | ')..'. ') or '')..verdict)",
    ].join("\n");
  };

  B.quality_fix = (a) => {
    let fixes = a.fixes;
    if (typeof fixes === "string") fixes = fixes.split(/[\s,;]+/).filter(Boolean);
    if (!Array.isArray(fixes) || !fixes.length) fixes = ["anchor", "primary_part", "names", "ui"];
    const set = {}; for (const f of fixes) set[String(f).toLowerCase()] = true;
    if (set.all) Object.assign(set, { anchor: true, primary_part: true, names: true, ui: true });
    if (set.borders || set.corners || set.text || set.fonts) set.ui = true;
    const cfg = { path: a.path || "", fixes: set, dry_run: a.dry_run === true, limit: Math.max(50, Math.min(20000, nn(a.limit, 6000))), radius: Math.max(0, Math.min(40, nn(a.radius, 10))), font: String(a.font || "GothamMedium") };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local R=mkRoots(A.path) local DRY=A.dry_run local rec=(not DRY) and wp('ORscript quality_fix') or nil",
      "local done={anchored={},primary_part={},renamed={},ui_borders=0,ui_corners=0,ui_text=0,ui_fonts=0} local examples={anchor={},primary_part={},names={},ui={}}",
      "local function note(list,i) if #list<6 then list[#list+1]=short(i) end end",
      "local function roleOf(sz) local x,y,z=sz.X,sz.Y,sz.Z local mn=math.min(x,y,z) local mx=math.max(x,y,z) if y>=mx and y>2*math.max(x,z) then return 'Pillar' end if y<=mn and y<0.35*math.min(x,z) then return 'Slab' end if (x<=mn and x<0.3*math.max(y,z)) or (z<=mn and z<0.3*math.max(x,y)) then return 'Wall' end if mx<=2 then return 'Detail' end return 'Block' end",
      "local nameCounter={}",
      "if (A.fixes.anchor or A.fixes.primary_part or A.fixes.names) and #R.build>0 then",
      " eachDesc(R.build,function(d)",
      "  if d:IsA('BasePart') and not d:IsA('Terrain') and not inHumanoid(d) then",
      "   if A.fixes.anchor and getp(d,'Anchored')==false and not d:FindFirstChildWhichIsA('JointInstance') and not d:FindFirstChildWhichIsA('WeldConstraint') and not d:FindFirstChildWhichIsA('Constraint') and not d:FindFirstChildWhichIsA('Attachment') and not d:IsA('Seat') then if not DRY then d.Anchored=true end done.anchored[#done.anchored+1]=d note(examples.anchor,d) end",
      "   if A.fixes.names and (d.Name==d.ClassName or d.Name=='Part' or d.Name=='Union' or d.Name=='Wedge' or d.Name:match('^Part%d+$')) then local mat=enumName(getp(d,'Material')) local sz=getp(d,'Size') local role=sz and roleOf(sz) or 'Part' local base=mat..role nameCounter[base]=(nameCounter[base] or 0)+1 local nm=base..'_'..nameCounter[base] if not DRY then d.Name=nm end done.renamed[#done.renamed+1]=d note(examples.names,d) end",
      "  elseif d:IsA('Model') and not d:FindFirstChildOfClass('Humanoid') then",
      "   if A.fixes.primary_part and not getp(d,'PrimaryPart') then local best,bv=nil,-1 for _,c in ipairs(d:GetDescendants()) do if c:IsA('BasePart') then local s=c.Size local v=s.X*s.Y*s.Z if v>bv then bv=v best=c end end end if best then if not DRY then d.PrimaryPart=best end done.primary_part[#done.primary_part+1]=d note(examples.primary_part,d) end end",
      "   if A.fixes.names and d.Name=='Model' then local first=d:FindFirstChildWhichIsA('BasePart',true) local mat=first and enumName(getp(first,'Material')) or 'Group' nameCounter[mat..'Model']=(nameCounter[mat..'Model'] or 0)+1 if not DRY then d.Name=mat..'Model_'..nameCounter[mat..'Model'] end done.renamed[#done.renamed+1]=d note(examples.names,d) end",
      "  end",
      " end,A.limit)",
      "end",
      "if A.fixes.ui and #R.ui>0 then",
      " local font=Enum.Font.GothamMedium pcall(function() font=Enum.Font[A.font] end)",
      " eachDesc(R.ui,function(d)",
      "  if not d:IsA('GuiObject') or d:FindFirstAncestor('OR_GFX_Overlay') then return end",
      "  local vis=(getp(d,'BackgroundTransparency') or 0)<0.95",
      "  if (getp(d,'BorderSizePixel') or 0)>0 then if not DRY then d.BorderSizePixel=0 end done.ui_borders=done.ui_borders+1 note(examples.ui,d) end",
      "  if vis and A.radius>0 and (d:IsA('Frame') or d:IsA('GuiButton') or d:IsA('ScrollingFrame') or d:IsA('TextLabel')) and not d:FindFirstChildOfClass('UICorner') then if not DRY then local c=Instance.new('UICorner') c.CornerRadius=UDim.new(0,A.radius) c.Parent=d end done.ui_corners=done.ui_corners+1 note(examples.ui,d) end",
      "  if d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox') then",
      "   local f=enumName(getp(d,'Font')) if f=='Legacy' or f=='SourceSans' or f=='Arial' or f=='SourceSansBold' then if not DRY then pcall(function() d.Font=font end) end done.ui_fonts=done.ui_fonts+1 end",
      "   if getp(d,'TextScaled')==false and not d:FindFirstChildOfClass('UITextSizeConstraint') and (getp(d,'TextSize') or 14)<=14 and (getp(d,'AutomaticSize')==nil or getp(d,'AutomaticSize')==Enum.AutomaticSize.None) then if not DRY then d.TextScaled=true d.TextWrapped=true local c=Instance.new('UITextSizeConstraint') c.MinTextSize=10 c.MaxTextSize=22 c.Parent=d end done.ui_text=done.ui_text+1 note(examples.ui,d) end",
      "  end",
      " end,A.limit)",
      "end",
      "wpDone(rec)",
      "local summary={anchored=#done.anchored,primary_part_set=#done.primary_part,renamed=#done.renamed,ui_borders_removed=done.ui_borders,ui_corners_added=done.ui_corners,ui_text_scaled=done.ui_text,ui_fonts_replaced=done.ui_fonts}",
      "local total=0 for _,v in pairs(summary) do total=total+v end",
      "local parts={} for k,v in pairs(summary) do if v>0 then parts[#parts+1]=k..' '..v end end table.sort(parts)",
      "if total==0 then return ok({dry_run=DRY,summary=summary},'quality_fix: nothing mechanical to fix in '..(A.path~='' and A.path or 'the place')..'. Remaining findings need design decisions (palette, lighting, layout) - quality_audit lists the commands.') end",
      "return ok({dry_run=DRY,summary=summary,examples=examples},(DRY and 'quality_fix DRY RUN would change ' or 'quality_fix changed ')..total..' thing(s): '..table.concat(parts,', ')..'. Now quality_audit again; the colour / material / lighting / layout findings are yours to design (style_guide + brief_get).')",
    ].join("\n");
  };

  // ───────────────────────── catalogue ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const C = [
    { name: "style_guide", description: "Art-direction bible for a genre (no Studio needed): palette (6 roles as hex + Color3), materials per surface, a complete lighting recipe (ClockTime / Ambient / Atmosphere / Bloom / ColorCorrection values + the matching lighting_set_preset and postfx_cinematic names), UI tokens (design_tokens_set preset, colours, font, radius), real-scale notes, motifs, VFX / SFX beats, what to avoid and a 5-step recipe. Genres: medieval, fantasy, scifi, cyberpunk, horror, cozy, nature, desert, winter, tropical, city, cartoon (simulator / obby / tycoon), candy, industrial, underwater, space - aliases like castle, neon, forest, snow, beach work. Run it BEFORE the first build / UI / lighting command and type its numbers.", params: { genre: S("string", true, "medieval | fantasy | scifi | cyberpunk | horror | cozy | nature | desert | winter | tropical | city | cartoon | candy | industrial | underwater | space (or an alias; 'list' for all)"), compact: S("boolean", false, "palette + summary only") } },
    { name: "brief_set", description: "Store the project brief the whole job builds to (ServerStorage._ORBrief): title, genre, palette (hex list - filled from style_guide when omitted), scale notes, must_have list, avoid list, audience, notes. quality_audit then flags parts far from the palette. Merges with an existing brief unless replace:true.", params: { title: S("string", true), genre: S("string", false, "style_guide genre or alias"), style: S("string", false, "free-text look, e.g. 'low-poly cozy'"), palette: S("array", false, "hex colours"), scale: S("string", false, "e.g. 'walls 12 studs, doors 7x12'"), must_have: S("array", false), avoid: S("array", false), audience: S("string", false), notes: S("string", false), replace: S("boolean", false) } },
    { name: "brief_get", description: "Read the stored project brief (title, genre, palette, scale, must_have, avoid). Run it when continuing a project so every new colour / material / UI token still matches.", params: {} },
    { name: "style_lighting_apply", description: "Write a genre's lighting recipe into Lighting in one undoable step: ClockTime, Brightness, Ambient / OutdoorAmbient, Exposure, fog, plus OR_Atmosphere, OR_Bloom, OR_ColorCorrection (and SunRays when the genre has glare). strength 0.2-1.5 scales the post stack; keep_time:true leaves ClockTime alone. Follow with or_screenshot.", params: { genre: S("string", true, "style_guide genre or alias"), strength: S("number", false, "default 1"), keep_time: S("boolean", false) } },
    { name: "quality_audit", description: "Score the place (or one path) 0-100 the way a reviewer would and list findings with the exact fix command: BUILD - default grey Plastic, one material / two colours everywhere, all plain blocks, unanchored parts, Models without PrimaryPart, Part / Model names, loose parts in Workspace, parts off the brief palette; LIGHTING - untouched defaults (ClockTime 14), no Atmosphere / Bloom / ColorCorrection; UI - white 1px-border Frames, legacy borders, no UICorner, default fonts, fixed 14px text, Offset-only roots, containers without layouts; SCRIPTS - wait()/spawn(), LocalScript in server containers, LocalPlayer in server Scripts, DataStore without pcall, modules without --!strict, print() leftovers, default script names. Hand-off gate: fix high / medium, re-run until score >= 85 and report the number.", params: { path: S("string", false, "a Model / Folder / ScreenGui / script container; omit for the whole place"), scope: S("string", false, "all | build | ui | scripts | lighting (default all)"), max_findings: S("number", false, "default 24"), max_scripts: S("number", false, "default 250") } },
    { name: "quality_fix", description: "Apply the mechanical quality fixes in one undoable step: anchor (free parts without joints), primary_part (largest part per Model), names (Part -> BrickWall_3 by material + role), ui (BorderSizePixel 0, UICorner on visible containers / buttons, TextScaled + UITextSizeConstraint on fixed 14px text, default fonts -> GothamMedium). Default fixes: all four. dry_run:true only reports. Colours, materials, lighting and layout stay design decisions - use style_guide + material_set / color_set / design_tokens_set for those.", params: { path: S("string", false, "omit for the whole place"), fixes: S("array", false, "anchor | primary_part | names | ui | all"), dry_run: S("boolean", false), radius: S("number", false, "UICorner px (default 10, 0 = skip corners)"), font: S("string", false, "replacement Enum.Font name (default GothamMedium)") } },
  ];

  function buildQuality(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      // 1.51.2: the audit / fix programs are 15-18 KB of STATIC Luau behind a
      // one-line config. Keep the static part in the cached library (see
      // main.js runSkillLuau) so each call ships only its config line.
      const m = body.match(/^local A=HttpService:JSONDecode\(('(?:[^'\\]|\\.)*')\)\n/);
      if (m) {
        const lib = HEAD + "\nlocal function OR_RUN_" + op + "(A)\n" + body.slice(m[0].length) + "\nend";
        const tailLuau = "\nlocal okRun,resRun=pcall(function()\nlocal A=HttpService:JSONDecode(" + m[1] + ")\nreturn OR_RUN_" + op + "(A)\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
        return { code: lib + "\n" + tailLuau, lib, body: tailLuau };
      }
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildQuality(op, args);
    if (op === "style_guide") { const r = styleGuideLocal(args || {}); const tailLuau = "\nlocal okRun,resRun=pcall(function()\nreturn ok(HttpService:JSONDecode(" + jj(r.data) + ")," + q(r.text) + ")\nend)\nif okRun then return resRun end\nreturn fail(tostring(resRun))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau }; }
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.QUALITY_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.QUALITY_GENRES = GENRES.slice();
  RobloxScriptSkills.QUALITY_PASS_SCORE = PASS_SCORE;
  RobloxScriptSkills.QUALITY_VERSION = QUALITY_VERSION;
  RobloxScriptSkills.styleGuideLocal = styleGuideLocal;
  RobloxScriptSkills.resolveStyleGenre = resolveGenre;
})();
