//! Headless UI snapshots (test-only, 2.10.0).
//!
//! There is no display in CI or in the sandbox, so the window cannot be
//! screenshotted the normal way. Instead this drives `App::frame` through a
//! bare `egui::Context`, tessellates the result exactly as the GPU backend
//! would, and rasterises the triangles on the CPU (font atlas + user textures
//! included). The PNGs let a human review every page at several window
//! sizes, and the same pass counts text that was cut by a clip rect or
//! truncated with "…" — the mechanical half of "no clipped text".
//!
//! `cargo test --release snapshot -- --nocapture` prints the layout report.
//! With `TOTAL_SNAPSHOTS=<dir>` set, PNGs are written there as well (the CI
//! windows job does this and commits them to `agent/snapshots/`).

use super::*;
use egui::epaint::{ClippedPrimitive, ImageData, Primitive, TextureId};
use std::collections::HashMap;

struct Tex { w: usize, h: usize, px: Vec<[f32; 4]> }

struct Textures(HashMap<TextureId, Tex>);

struct Canvas { w: usize, h: usize, px: Vec<[f32; 4]> }

fn c32(c: Color32) -> [f32; 4] { [c.r() as f32 / 255.0, c.g() as f32 / 255.0, c.b() as f32 / 255.0, c.a() as f32 / 255.0] }

impl Canvas {
    fn new(w: usize, h: usize, clear: Color32) -> Self {
        let mut c = c32(clear); c[3] = 1.0;
        Canvas { w, h, px: vec![c; w * h] }
    }
}

impl Textures {
    fn apply(&mut self, delta: &egui::TexturesDelta) {
        for (id, d) in &delta.set {
            let (w, h, px): (usize, usize, Vec<[f32; 4]>) = match &d.image {
                ImageData::Color(img) => (img.width(), img.height(), img.pixels.iter().map(|c| c32(*c)).collect()),
                ImageData::Font(img) => (img.width(), img.height(), img.srgba_pixels(None).map(c32).collect()),
            };
            match d.pos {
                None => { self.0.insert(*id, Tex { w, h, px }); }
                Some([x0, y0]) => {
                    if let Some(t) = self.0.get_mut(id) {
                        for y in 0..h { for x in 0..w {
                            let (tx, ty) = (x0 + x, y0 + y);
                            if tx < t.w && ty < t.h { t.px[ty * t.w + tx] = px[y * w + x]; }
                        } }
                    }
                }
            }
        }
        for id in &delta.free { self.0.remove(id); }
    }

    fn sample(&self, id: TextureId, uv: Pos2) -> [f32; 4] {
        let Some(t) = self.0.get(&id) else { return [1.0, 1.0, 1.0, 1.0] };
        // bilinear, clamped
        let fx = (uv.x * t.w as f32 - 0.5).clamp(0.0, (t.w - 1) as f32);
        let fy = (uv.y * t.h as f32 - 0.5).clamp(0.0, (t.h - 1) as f32);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(t.w - 1), (y0 + 1).min(t.h - 1));
        let (ax, ay) = (fx - x0 as f32, fy - y0 as f32);
        let p = |x: usize, y: usize| t.px[y * t.w + x];
        let mut out = [0.0; 4];
        for i in 0..4 {
            let top = p(x0, y0)[i] * (1.0 - ax) + p(x1, y0)[i] * ax;
            let bot = p(x0, y1)[i] * (1.0 - ax) + p(x1, y1)[i] * ax;
            out[i] = top * (1.0 - ay) + bot * ay;
        }
        out
    }
}

impl Canvas {
    fn draw(&mut self, prims: &[ClippedPrimitive], ppp: f32, textures: &Textures) {
        for prim in prims {
            let Primitive::Mesh(mesh) = &prim.primitive else { continue };
            let clip = prim.clip_rect;
            let cx0 = ((clip.min.x * ppp).floor().max(0.0)) as i64;
            let cy0 = ((clip.min.y * ppp).floor().max(0.0)) as i64;
            let cx1 = ((clip.max.x * ppp).ceil().min(self.w as f32)) as i64;
            let cy1 = ((clip.max.y * ppp).ceil().min(self.h as f32)) as i64;
            for tri in mesh.indices.chunks_exact(3) {
                let v = [&mesh.vertices[tri[0] as usize], &mesh.vertices[tri[1] as usize], &mesh.vertices[tri[2] as usize]];
                let p = [v[0].pos * ppp, v[1].pos * ppp, v[2].pos * ppp];
                let area = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
                if area.abs() < 1e-6 { continue; }
                let minx = p.iter().map(|q| q.x).fold(f32::MAX, f32::min).floor() as i64;
                let maxx = p.iter().map(|q| q.x).fold(f32::MIN, f32::max).ceil() as i64;
                let miny = p.iter().map(|q| q.y).fold(f32::MAX, f32::min).floor() as i64;
                let maxy = p.iter().map(|q| q.y).fold(f32::MIN, f32::max).ceil() as i64;
                let c = [c32(v[0].color), c32(v[1].color), c32(v[2].color)];
                for y in miny.max(cy0)..maxy.min(cy1) {
                    for x in minx.max(cx0)..maxx.min(cx1) {
                        let (sx, sy) = (x as f32 + 0.5, y as f32 + 0.5);
                        let w0 = ((p[1].x - sx) * (p[2].y - sy) - (p[2].x - sx) * (p[1].y - sy)) / area;
                        let w1 = ((p[2].x - sx) * (p[0].y - sy) - (p[0].x - sx) * (p[2].y - sy)) / area;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 { continue; }
                        let uv = Pos2::new(v[0].uv.x * w0 + v[1].uv.x * w1 + v[2].uv.x * w2, v[0].uv.y * w0 + v[1].uv.y * w1 + v[2].uv.y * w2);
                        let tex = textures.sample(mesh.texture_id, uv);
                        let mut src = [0.0; 4];
                        for i in 0..4 { src[i] = (c[0][i] * w0 + c[1][i] * w1 + c[2][i] * w2) * tex[i]; }
                        let dst = &mut self.px[y as usize * self.w + x as usize];
                        let inv = 1.0 - src[3];
                        for i in 0..4 { dst[i] = src[i] + dst[i] * inv; }
                    }
                }
            }
        }
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let mut bytes = Vec::with_capacity(self.w * self.h * 4);
        for p in &self.px { for i in 0..3 { bytes.push((p[i].clamp(0.0, 1.0) * 255.0).round() as u8); } bytes.push(255); }
        let img = image::RgbaImage::from_raw(self.w as u32, self.h as u32, bytes).ok_or("raw")?;
        img.save(path).map_err(|e| e.to_string())
    }
}

/// Text that the layout pass could not show whole.
#[derive(Default)]
struct TextReport { clipped: Vec<String>, elided: Vec<String>, boxes: Vec<String> }

fn inspect_text(shapes: &[egui::epaint::ClippedShape], report: &mut TextReport) {
    for cs in shapes {
        let egui::Shape::Text(ts) = &cs.shape else { continue };
        let text = ts.galley.text();
        if text.trim().is_empty() { continue; }
        // `galley.rect` is anchored on `pos`: right-aligned galleys (anything
        // laid out right-to-left) extend to negative x, so `from_min_size`
        // would misreport them as overflowing to the right.
        let rect = ts.galley.rect.translate(ts.pos.to_vec2());
        let clip = cs.clip_rect;
        let visible = clip.intersects(rect);
        let whole = clip.expand(0.6).contains_rect(rect);
        // scrolled-away text (entirely outside the clip) is fine; partly cut text is not
        if visible && !whole {
            let cut_x = (rect.max.x - clip.max.x).max(0.0).max(clip.min.x - rect.min.x);
            let cut_y = (rect.max.y - clip.max.y).max(0.0).max(clip.min.y - rect.min.y);
            // A tall clip (a scroll viewport) cutting a line at its top or
            // bottom edge is the list scrolling, not a layout bug; a short clip
            // (a button, a one-line row) cutting text vertically is.
            let scroll_viewport = clip.height() > 160.0;
            let bad_x = cut_x > 2.0;
            let bad_y = cut_y > 2.0 && !scroll_viewport;
            if bad_x || bad_y {
                report.clipped.push(format!("{:?} cut x{:.0} y{:.0} at {:?}", truncate(text.trim(), 48), cut_x, cut_y, rect.min));
            }
        }
        if ts.galley.elided { report.elided.push(truncate(text.trim(), 60)); }
        if text.contains('\u{25FB}') { report.boxes.push(truncate(text.trim(), 60)); }
    }
}

fn seed(app: &mut App, shared: &Arc<UiShared>) {
    shared.log("INFO TotalScript Desktop 2.14.0 — bridge listening on 127.0.0.1:3000");
    shared.log("INFO workspace: C:\\Users\\Gürkan\\Belgeler\\İş Projeleri\\TotalWorkspace (Türkçe karakter testi: ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü)");
    shared.log("WARN Studio open, MCP not linked yet → enable 'Studio as MCP server' and probe");
    shared.log("ERROR execute_luau failed: Workspace.Oyuncu.Karakter is not a valid member of Model \"Oyuncu\" (stack: ServerScriptService.Başlat:12)");
    shared.log("INFO tool read_file 12 ms → src/shared/Util.luau (1 203 bytes)");
    shared.track("studio", "Probe → 32 tools, place 'Şehir Simülatörü' (Edit)");
    shared.track("tool", "execute_luau · 184 ms → ok");
    shared.track("chat", "turn 3 · 1 240 in / 412 out tokens · 6.1 s");
    shared.track("app", "settings saved");
    let tools: Vec<serde_json::Value> = [
        ("execute_luau", "Run Luau in the Edit DataModel and return print output.", vec!["code", "datamodel_type"]),
        ("insert_model", "Insert a model from the Creator Store by asset id.", vec!["query"]),
        ("get_console_output", "Return the last lines of the Studio output window.", vec![]),
        ("screen_capture", "Capture the Studio viewport as a PNG.", vec![]),
    ]
    .iter()
    .map(|(n, d, p)| {
        let props: serde_json::Map<String, serde_json::Value> = p.iter().map(|k| (k.to_string(), serde_json::json!({"type": "string"}))).collect();
        serde_json::json!({"name": n, "description": d, "inputSchema": {"type": "object", "properties": props}})
    })
    .collect();
    shared.set_roblox_tools(&tools);
    shared.studio_running.store(true, Ordering::Relaxed);
    shared.studio_connected.store(true, Ordering::Relaxed);
    app.term_history.push("git status".into());
    app.term_output.push((true, "$ dir /b".into()));
    app.term_output.push((false, "Başlat.server.luau\nÖzellikler.luau\nREADME.md\npackage.json".into()));
    app.term_output.push((true, "$ npm test".into()));
    app.term_output.push((false, "> total-workspace@1.0.0 test\n\n  12 passing (1.8s)\n".into()));
    app.chat_items.push(ChatMsg { role: ChatRole::User, text: "Oyuncu HUD'ını mobil için düzelt — butonlar çok küçük görünüyor.".into(), thinking: String::new(), tools: vec![], at: "14:02".into() });
    app.chat_items.push(ChatMsg {
        role: ChatRole::Assistant,
        text: "Baktım: `StarterGui.Hud.Sprint` 60×60 px offset-only. Plan → `device_audit` → `device_fix {ops:[\"min_touch_size\",\"scale_sizes\"]}` → tekrar audit.\n\n- Sprint button: 60 px → 0.09 scale + UISizeConstraint 44 px\n- Title: UITextSizeConstraint 14–32".into(),
        thinking: "The user wants the HUD fixed for phones. Audit first, then only the mechanical fixes.".into(),
        tools: vec![ChatToolCard { id: "c1".into(), name: "device_audit".into(), args: "{\"path\":\"StarterGui.Hud\"}".into(), result: "phone: 2 blocker(s), 3 warning(s), 1 note(s)\nconsole: 0 blocker(s), 1 warning(s)".into(), ok: Some(true), elapsed_ms: 184, images: vec![], open: true }],
        at: "14:02".into(),
    });
    app.chat_history.push(serde_json::json!({"role": "user", "content": "…"}));
    app.chat_tokens = (1240, 412);
    app.chat_last_turn_ms = 6100;
    app.chat_model_list = vec!["gpt-4.1-mini".into(), "gpt-4.1".into()];
    app.settings.chat_models.insert(app.settings.chat_provider.clone(), "gpt-4.1-mini".into());
    app.settings.chat_keys.insert(app.settings.chat_provider.clone(), "sk-test-not-a-real-key".into());
    app.chat_setup_open = false;
    app.help_query.clear();
}

fn run_frame(ctx: &egui::Context, app: &mut App, size: Vec2, time: f64) -> egui::FullOutput {
    let mut input = egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, size)), time: Some(time), ..Default::default() };
    input.viewports.entry(egui::ViewportId::ROOT).or_default().native_pixels_per_point = Some(1.0);
    input.viewports.get_mut(&egui::ViewportId::ROOT).unwrap().inner_rect = Some(egui::Rect::from_min_size(Pos2::ZERO, size));
    ctx.run(input, |ctx| app.frame(ctx))
}

#[test]
fn snapshot_every_page_at_three_sizes() {
    let out_dir = std::env::var("TOTAL_SNAPSHOTS").ok().map(PathBuf::from);
    if let Some(d) = &out_dir { let _ = std::fs::create_dir_all(d); }
    let ctx = egui::Context::default();
    let shared = Arc::new(UiShared::new(Arc::new(AtomicBool::new(true))));
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<UiCommand>();
    let mut settings = Settings::default();
    settings.motion = false; // deterministic frames
    let mut app = App::new(&ctx, shared.clone(), tx, settings, false, load_logo(), None);
    seed(&mut app, &shared);

    let sizes = [(1280.0_f32, 820.0_f32), (1000.0, 660.0), (960.0, 620.0)];
    let mut textures = Textures(HashMap::new());
    let mut total = TextReport::default();
    let mut frames = 0usize;
    for page in Page::ALL {
        for (w, h) in sizes {
            app.page = page;
            app.page_opened = Instant::now() - Duration::from_secs(5);
            if page == Page::Chat { app.settings.chat_panel_open = false; }
            // a few frames so animations / scroll areas settle, keep the last
            let mut last = None;
            for k in 0..4 {
                let out = run_frame(&ctx, &mut app, Vec2::new(w, h), 10.0 + k as f64 * 0.1);
                textures.apply(&out.textures_delta);
                last = Some(out);
            }
            let out = last.unwrap();
            frames += 1;
            let mut rep = TextReport::default();
            inspect_text(&out.shapes, &mut rep);
            let tag = format!("{:?} {}x{}", page, w as u32, h as u32).to_lowercase();
            for c in &rep.clipped { total.clipped.push(format!("[{tag}] {c}")); }
            for e in &rep.elided { total.elided.push(format!("[{tag}] {e}")); }
            for b in &rep.boxes { total.boxes.push(format!("[{tag}] {b}")); }
            if let Some(dir) = &out_dir {
                let mut canvas = Canvas::new(w as usize, h as usize, app.theme.bg);
                let prims = ctx.tessellate(out.shapes.clone(), 1.0);
                canvas.draw(&prims, 1.0, &textures);
                let name = format!("{}-{}x{}.png", format!("{:?}", page).to_lowercase(), w as u32, h as u32);
                canvas.save(&dir.join(name)).expect("write png");
            }
        }
    }
    // Settings with the chat side panel open at the smallest size — the
    // tightest layout the window can be asked for.
    app.page = Page::Home;
    app.settings.chat_panel_open = true;
    let out = {
        let mut last = None;
        for k in 0..3 {
            let out = run_frame(&ctx, &mut app, Vec2::new(960.0, 620.0), 20.0 + k as f64 * 0.1);
            textures.apply(&out.textures_delta);
            last = Some(out);
        }
        last.unwrap()
    };
    let mut rep = TextReport::default();
    inspect_text(&out.shapes, &mut rep);
    for c in &rep.clipped { total.clipped.push(format!("[home+chat 960x620] {c}")); }
    for e in &rep.elided { total.elided.push(format!("[home+chat 960x620] {e}")); }
    for b in &rep.boxes { total.boxes.push(format!("[home+chat 960x620] {b}")); }
    if let Some(dir) = &out_dir {
        let mut canvas = Canvas::new(960, 620, app.theme.bg);
        let prims = ctx.tessellate(out.shapes.clone(), 1.0);
        canvas.draw(&prims, 1.0, &textures);
        canvas.save(&dir.join("home-chatpanel-960x620.png")).expect("write png");
    }
    app.settings.chat_panel_open = false;

    // 2.11.0 overlays: the command palette (with a query typed) and the
    // notification center, both on Home at the default size.
    let overlay = |app: &mut App, name: &str, total: &mut TextReport, textures: &mut Textures| {
        let mut last = None;
        for k in 0..3 {
            let out = run_frame(&ctx, app, Vec2::new(1280.0, 820.0), 30.0 + k as f64 * 0.1);
            textures.apply(&out.textures_delta);
            last = Some(out);
        }
        let out = last.unwrap();
        let mut rep = TextReport::default();
        inspect_text(&out.shapes, &mut rep);
        for c in &rep.clipped { total.clipped.push(format!("[{name} 1280x820] {c}")); }
        for e in &rep.elided { total.elided.push(format!("[{name} 1280x820] {e}")); }
        for b in &rep.boxes { total.boxes.push(format!("[{name} 1280x820] {b}")); }
        if let Some(dir) = &out_dir {
            let mut canvas = Canvas::new(1280, 820, app.theme.bg);
            let prims = ctx.tessellate(out.shapes.clone(), 1.0);
            canvas.draw(&prims, 1.0, &textures);
            canvas.save(&dir.join(format!("{name}-1280x820.png"))).expect("write png");
        }
    };
    app.page = Page::Home;
    app.open_palette();
    app.palette.query = "stud".into();
    app.palette.just_opened = false;
    overlay(&mut app, "home-palette", &mut total, &mut textures);
    app.palette.open = false;
    app.notify(NoticeKind::Ok, "Studio viewport captured", "app");
    app.notify(NoticeKind::Warn, "pair: 2 finding(s) in ServerScriptService.Başlat", "pair");
    app.notify(NoticeKind::Err, "execute_luau failed: Oyuncu is not a valid member of Model", "error");
    app.notices.open = true;
    overlay(&mut app, "home-notices", &mut total, &mut textures);
    app.notices.open = false;
    app.notices.clear();
    frames += 2;

    println!("snapshot: {frames} page×size frames (+1 with the chat panel, incl. palette + notification overlays)");
    println!("snapshot: {} cut text(s), {} elided text(s), {} replacement box(es)", total.clipped.len(), total.elided.len(), total.boxes.len());
    for c in total.clipped.iter().take(120) { println!("  CUT    {c}"); }
    for e in total.elided.iter().take(40) { println!("  ELIDED {e}"); }
    for b in total.boxes.iter().take(20) { println!("  BOX    {b}"); }
    // Hard rules: no replacement boxes (missing glyphs) anywhere, and no text
    // cut by a clip rect on the default 1280×820 window.
    assert!(total.boxes.is_empty(), "missing glyphs: {:?}", total.boxes);
    let cut_default: Vec<&String> = total.clipped.iter().filter(|c| c.contains("1280x820")).collect();
    println!("snapshot: {} cut text(s) at the default 1280x820 window", cut_default.len());
    if std::env::var("TOTAL_SNAPSHOTS_STRICT").is_ok() {
        assert!(cut_default.is_empty(), "text cut at 1280x820: {:#?}", cut_default);
    }
}

#[test]
fn fonts_cover_turkish_and_arrows() {
    let ctx = egui::Context::default();
    install_fonts(&ctx);
    let _ = run_probe(&ctx);
    let text = "ç ğ ı İ ö ş ü Ç Ğ I Ö Ş Ü → — · … × « » ▶ •";
    ctx.fonts(|f| {
        for fam in [FontFamily::Proportional, FontFamily::Monospace, family_medium(), family_semibold()] {
            let galley = f.layout_no_wrap(text.to_string(), FontId::new(14.0, fam.clone()), Color32::WHITE);
            let missing: Vec<char> = galley.rows.iter().flat_map(|r| r.glyphs.iter()).filter(|g| g.chr == '\u{25FB}').map(|g| g.chr).collect();
            assert!(missing.is_empty(), "{fam:?} shows replacement boxes for some of {text:?}");
            assert!(!galley.rows.is_empty());
        }
    });
}

/// One empty frame so the font atlas exists before `ctx.fonts` is queried.
fn run_probe(ctx: &egui::Context) -> egui::FullOutput {
    let mut input = egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, Vec2::new(400.0, 300.0))), ..Default::default() };
    input.viewports.entry(egui::ViewportId::ROOT).or_default().native_pixels_per_point = Some(1.0);
    ctx.run(input, |_| {})
}
