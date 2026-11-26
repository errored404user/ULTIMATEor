//! Easter eggs (2.9.1). Settings → Appearance → "Search palettes…": three
//! trigger words open a small window instead of filtering the grid.
//!
//! * `FeatherScript` — a black-and-white feather (drawn with the painter, no
//!   image asset) and the FeatherScript Discord invite.
//! * `PlazCode` — one dramatic line.
//! * `Shang` — "Erm im a little nobody" with a short goofy tune. The tune is
//!   synthesised here (a four-note "wah-wah-wah-waaah" trombone slide, 16-bit
//!   mono WAV) and handed to the OS player that is already on the machine
//!   (PowerShell `Media.SoundPlayer` on Windows, `afplay` on macOS,
//!   `paplay` / `aplay` on Linux) — no audio crate, no bundled file.
//!
//! Nothing here touches settings, the bridge or the chat.

use eframe::egui;
use egui::{Color32, Pos2, Rect, RichText, Stroke, Vec2};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Discord invite shown by the FeatherScript egg.
pub const FEATHER_DISCORD: &str = "https://discord.gg/Je8WS2N2q";
/// The PlazCode line, verbatim.
pub const PLAZ_LINE: &str = "He took my ORscript and became popular and I'MMMM!!!! left in the shadows...";
/// The Shang line, verbatim.
pub const SHANG_LINE: &str = "Erm im a little nobody";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Egg {
    Feather,
    Plaz,
    Shang,
}

impl Egg {
    /// Window title.
    pub fn title(self) -> &'static str {
        match self {
            Egg::Feather => "FeatherScript",
            Egg::Plaz => "PlazCode",
            Egg::Shang => "Shang",
        }
    }
    /// The trigger word (case-insensitive, surrounding spaces ignored).
    pub fn trigger(self) -> &'static str {
        match self {
            Egg::Feather => "featherscript",
            Egg::Plaz => "plazcode",
            Egg::Shang => "shang",
        }
    }
}

/// Which egg (if any) a palette-search query opens. Exact word only, so the
/// search box keeps working for everything else ("feather" or "shanghai"
/// still just filter palettes).
pub fn detect(query: &str) -> Option<Egg> {
    let q = query.trim().to_lowercase();
    [Egg::Feather, Egg::Plaz, Egg::Shang].into_iter().find(|e| e.trigger() == q)
}

/// Per-window state kept by the GUI.
#[derive(Default)]
pub struct EggState {
    /// Currently open egg.
    pub open: Option<Egg>,
    /// Query that opened it (so closing the window does not reopen it on the
    /// next frame while the same text is still in the box).
    pub armed_query: String,
    /// Last playback note for the Shang window ("♪ playing" or why not).
    pub music_note: String,
    /// Reused temp file for the tune.
    wav_path: Option<std::path::PathBuf>,
}

impl EggState {
    /// Feed the live palette query. Returns true when a window was opened.
    pub fn observe(&mut self, query: &str) -> bool {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            self.armed_query.clear();
            return false;
        }
        if trimmed.eq_ignore_ascii_case(&self.armed_query) { return false; }
        match detect(trimmed) {
            Some(egg) => {
                self.armed_query = trimmed.to_string();
                self.open = Some(egg);
                if egg == Egg::Shang { self.play_tune(); }
                true
            }
            None => false,
        }
    }

    /// Start (or restart) the Shang tune.
    pub fn play_tune(&mut self) {
        let path = match &self.wav_path {
            Some(p) => p.clone(),
            None => {
                let p = std::env::temp_dir().join("totalscript-shang.wav");
                self.wav_path = Some(p.clone());
                p
            }
        };
        self.music_note = match std::fs::write(&path, shang_tune_wav()).map_err(|e| e.to_string()).and_then(|_| play_wav(&path)) {
            Ok(()) => "♪ playing…".to_string(),
            Err(e) => format!("(no sound: {e})"),
        };
    }

    /// Draw the open window, if any.
    pub fn show(&mut self, ctx: &egui::Context, text: Color32, muted: Color32, accent: Color32) {
        let Some(egg) = self.open else { return };
        let mut open = true;
        egui::Window::new(egg.title())
            .id(egui::Id::new("easter-egg-window"))
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .default_width(300.0)
            .show(ctx, |ui| {
                ui.set_width(300.0);
                match egg {
                    Egg::Feather => {
                        ui.vertical_centered(|ui| {
                            let (rect, _) = ui.allocate_exact_size(Vec2::new(180.0, 220.0), egui::Sense::hover());
                            ui.painter().extend(feather_shapes(rect));
                            ui.add_space(6.0);
                            ui.label(RichText::new("FeatherScript").size(18.0).strong().color(text));
                            ui.label(RichText::new("Light as a feather.").small().color(muted));
                            ui.add_space(4.0);
                            let link = ui.add(egui::Label::new(RichText::new(FEATHER_DISCORD).color(accent).underline()).sense(egui::Sense::click()))
                                .on_hover_cursor(egui::CursorIcon::PointingHand)
                                .on_hover_text("Open the FeatherScript Discord in your browser");
                            if link.clicked() { crate::gui::open_external(FEATHER_DISCORD); }
                            if ui.small_button("Copy invite").clicked() { ui.output_mut(|o| o.copied_text = FEATHER_DISCORD.to_string()); }
                            ui.add_space(4.0);
                        });
                    }
                    Egg::Plaz => {
                        ui.add_space(8.0);
                        ui.label(RichText::new(PLAZ_LINE).size(15.0).italics().color(text));
                        ui.add_space(8.0);
                    }
                    Egg::Shang => {
                        ui.vertical_centered(|ui| {
                            ui.add_space(10.0);
                            ui.label(RichText::new(SHANG_LINE).size(20.0).strong().color(text));
                            ui.add_space(6.0);
                            ui.label(RichText::new(self.music_note.clone()).small().color(muted));
                            ui.add_space(6.0);
                            if ui.small_button("Play again").clicked() { self.play_tune(); }
                            ui.add_space(6.0);
                        });
                    }
                }
            });
        if !open { self.open = None; }
    }
}

// ───────────────────────── feather (vector) ─────────────────────────

/// A black-and-white feather that fills `rect`: a curved shaft, a vane whose
/// left half is black and right half white (each with contrasting barbs), a
/// bare quill at the bottom and a soft light backdrop so both halves read on
/// any palette. Returned as plain shapes so it is testable without a GPU.
pub fn feather_shapes(rect: Rect) -> Vec<egui::Shape> {
    let mut out = Vec::new();
    let black = Color32::from_rgb(18, 18, 20);
    let white = Color32::from_rgb(250, 250, 250);
    let backdrop = Color32::from_rgb(236, 236, 238);
    let ink = Stroke::new(1.3_f32, black);
    out.push(egui::Shape::rect_filled(rect, 18.0, backdrop));

    // shaft: quadratic bezier from the quill (bottom right) sweeping up to the tip
    let (w, h, c) = (rect.width(), rect.height(), rect.center());
    let p0 = Pos2::new(c.x + w * 0.16, rect.bottom() - h * 0.03);
    let p1 = Pos2::new(c.x - w * 0.26, c.y + h * 0.12);
    let p2 = Pos2::new(c.x + w * 0.02, rect.top() + h * 0.04);
    let n = 64usize;
    let shaft: Vec<Pos2> = (0..=n).map(|i| bezier(p0, p1, p2, i as f32 / n as f32)).collect();
    let tangent = |i: usize| -> Vec2 { (shaft[(i + 1).min(n)] - shaft[i.saturating_sub(1)]).normalized() };
    let vane_from = 0.24_f32; // bare quill below this
    let max_half = w * 0.27;
    // vane profile: widest around 45 % of the way up, pointed at the tip; the
    // outer (left) vane is narrower than the inner one, like a real flight feather
    let profile = |t: f32| -> f32 {
        if t < vane_from { return 0.0; }
        let u = (t - vane_from) / (1.0 - vane_from);
        u.powf(0.45) * (1.0 - u).powf(0.75) / 0.5
    };
    let half_l = |t: f32| max_half * profile(t) * 0.62;
    let half_r = |t: f32| max_half * profile(t);

    let mut mesh = egui::Mesh::default();
    let mut left_edge = Vec::with_capacity(n + 1);
    let mut right_edge = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let t = i as f32 / n as f32;
        let tn = tangent(i);
        let nrm = Vec2::new(-tn.y, tn.x);
        let l = shaft[i] + nrm * half_l(t);
        let r = shaft[i] - nrm * half_r(t);
        left_edge.push(l);
        right_edge.push(r);
        mesh.colored_vertex(l, black);
        mesh.colored_vertex(shaft[i], black);
        mesh.colored_vertex(shaft[i], white);
        mesh.colored_vertex(r, white);
        if i > 0 {
            let b = (i * 4) as u32;
            let a = b - 4;
            mesh.add_triangle(a, a + 1, b); mesh.add_triangle(b, a + 1, b + 1);
            mesh.add_triangle(a + 2, a + 3, b + 2); mesh.add_triangle(b + 2, a + 3, b + 3);
        }
    }
    out.push(egui::Shape::mesh(mesh));

    // barbs: slanted towards the tip, light on the black vane, dark on the white one
    let quill_end = (vane_from * n as f32) as usize;
    let mut i = quill_end + 2;
    while i < n {
        let ahead = (i + 5).min(n);
        if half_r(i as f32 / n as f32) > 2.0 {
            out.push(egui::Shape::line_segment([shaft[i], left_edge[ahead]], Stroke::new(0.9_f32, Color32::from_rgb(205, 205, 210))));
            out.push(egui::Shape::line_segment([shaft[i], right_edge[ahead]], Stroke::new(0.9_f32, Color32::from_rgb(140, 140, 146))));
        }
        i += 2;
    }
    // a few splits in the vane (backdrop-coloured wedges from the edge inwards)
    for (i, right) in [(22usize, true), (31, false), (38, true), (47, false), (52, true)] {
        let ahead = (i + 5).min(n);
        let e = if right { right_edge[ahead] } else { left_edge[ahead] };
        let inner = e + (shaft[i] - e) * 0.45;
        out.push(egui::Shape::line_segment([e, inner], Stroke::new(2.0_f32, backdrop)));
    }
    // outline, shaft, quill (black with a white highlight), downy wisps at the vane base
    out.push(egui::Shape::line(left_edge, ink));
    out.push(egui::Shape::line(right_edge, ink));
    out.push(egui::Shape::line(shaft.clone(), Stroke::new(2.0_f32, black)));
    out.push(egui::Shape::line(shaft[..=quill_end].to_vec(), Stroke::new(3.4_f32, black)));
    out.push(egui::Shape::line(shaft[..=quill_end].to_vec(), Stroke::new(1.2_f32, white)));
    for k in 0..6usize {
        let i = quill_end + 1 + k;
        let tn = tangent(i);
        let nrm = Vec2::new(-tn.y, tn.x);
        let len = 4.0 + k as f32 * 1.5;
        out.push(egui::Shape::line_segment([shaft[i], shaft[i] + nrm * len - tn * len * 0.8], Stroke::new(1.0_f32, black)));
        out.push(egui::Shape::line_segment([shaft[i], shaft[i] - nrm * len * 1.3 - tn * len * 0.8], Stroke::new(1.0_f32, black)));
    }
    out
}

fn bezier(p0: Pos2, p1: Pos2, p2: Pos2, t: f32) -> Pos2 {
    let a = 1.0 - t;
    Pos2::new(
        a * a * p0.x + 2.0 * a * t * p1.x + t * t * p2.x,
        a * a * p0.y + 2.0 * a * t * p1.y + t * t * p2.y,
    )
}

// ───────────────────────── the tune ─────────────────────────

pub const TUNE_RATE: u32 = 22_050;

/// (start Hz, end Hz, seconds) — three short falling "wah"s and a long wobbly
/// "waaah" that sinks a whole tone while it fades. Classic.
const TUNE: &[(f32, f32, f32)] = &[
    (246.9, 233.1, 0.42),
    (233.1, 220.0, 0.42),
    (220.0, 207.7, 0.42),
    (207.7, 185.0, 1.50),
];
const TUNE_GAP: f32 = 0.08;

/// Samples of the tune at `TUNE_RATE`, mono, -1..1.
pub fn shang_tune_samples() -> Vec<f32> {
    let sr = TUNE_RATE as f32;
    let mut out: Vec<f32> = Vec::new();
    let mut phase = 0.0_f32;
    for (k, &(f0, f1, secs)) in TUNE.iter().enumerate() {
        let len = (secs * sr) as usize;
        let last = k + 1 == TUNE.len();
        for i in 0..len {
            let u = i as f32 / len as f32;
            // pitch: hold a moment, then slide down; the last note also wobbles
            let slide = ((u - 0.25) / 0.55).clamp(0.0, 1.0);
            let mut f = f0 + (f1 - f0) * slide;
            if last { f *= 1.0 + 0.035 * (2.0 * std::f32::consts::PI * 5.5 * u * secs).sin(); }
            phase = (phase + f / sr).fract();
            // soft sawtooth: first six harmonics, 1/n — brassy enough
            let mut s = 0.0;
            for h in 1..=6 { s += (2.0 * std::f32::consts::PI * h as f32 * phase).sin() / h as f32; }
            s *= 0.42;
            // envelope: 25 ms attack, release over the last 15 % (the last note fades out fully)
            let att = (i as f32 / (0.025 * sr)).min(1.0);
            let rel = if last { 1.0 - u.powf(1.6) } else { ((1.0 - u) / 0.15).min(1.0) };
            out.push((s * att * rel).clamp(-1.0, 1.0));
        }
        if !last { out.extend(std::iter::repeat(0.0).take((TUNE_GAP * sr) as usize)); }
    }
    out
}

/// A complete 16-bit PCM WAV of the tune.
pub fn shang_tune_wav() -> Vec<u8> {
    let samples = shang_tune_samples();
    let data_len = (samples.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data_len as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVE");
    w.extend_from_slice(b"fmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&TUNE_RATE.to_le_bytes());
    w.extend_from_slice(&(TUNE_RATE * 2).to_le_bytes()); // byte rate
    w.extend_from_slice(&2u16.to_le_bytes()); // block align
    w.extend_from_slice(&16u16.to_le_bytes()); // bits
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for s in samples { w.extend_from_slice(&((s * 32_000.0) as i16).to_le_bytes()); }
    w
}

/// Hand a WAV file to whatever player the OS ships with. Fire and forget.
fn play_wav(path: &std::path::Path) -> Result<(), String> {
    let p = path.to_string_lossy().to_string();
    let result: Result<(), String>;
    #[cfg(windows)]
    {
        let script = format!("(New-Object Media.SoundPlayer '{}').PlaySync()", p.replace('\'', "''"));
        result = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("powershell: {e}"));
    }
    #[cfg(target_os = "macos")]
    {
        result = std::process::Command::new("afplay").arg(&p).spawn().map(|_| ()).map_err(|e| format!("afplay: {e}"));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        result = ["paplay", "aplay"]
            .iter()
            .find(|player| std::process::Command::new(player).arg(&p).spawn().is_ok())
            .map(|_| ())
            .ok_or_else(|| "no paplay / aplay on this machine".to_string());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_is_exact_and_case_insensitive() {
        assert_eq!(detect("FeatherScript"), Some(Egg::Feather));
        assert_eq!(detect("  plazcode "), Some(Egg::Plaz));
        assert_eq!(detect("SHANG"), Some(Egg::Shang));
        assert_eq!(detect("feather"), None, "partial words keep filtering palettes");
        assert_eq!(detect("shanghai"), None);
        assert_eq!(detect(""), None);
    }

    #[test]
    fn observe_opens_once_per_query_and_rearms_after_clear() {
        let mut st = EggState::default();
        assert!(st.observe("PlazCode"));
        assert_eq!(st.open, Some(Egg::Plaz));
        st.open = None; // user closed the window
        assert!(!st.observe("PlazCode"), "same text still in the box must not reopen");
        assert!(!st.observe("plazcode"));
        st.observe("");
        assert!(st.observe("PlazCode"), "cleared and typed again reopens");
        assert!(!st.observe("gold"), "normal searches never open anything");
    }

    #[test]
    fn feather_fits_its_rect_and_is_black_and_white() {
        let rect = Rect::from_min_size(Pos2::new(10.0, 20.0), Vec2::new(180.0, 220.0));
        let shapes = feather_shapes(rect);
        assert!(shapes.len() > 20, "{}", shapes.len());
        let mut mesh_tris = 0;
        for s in &shapes {
            match s {
                egui::Shape::Mesh(m) => {
                    mesh_tris += m.indices.len() / 3;
                    for v in &m.vertices {
                        assert!(rect.expand(0.5).contains(v.pos), "{:?} outside {:?}", v.pos, rect);
                        assert!(v.color == Color32::from_rgb(18, 18, 20) || v.color == Color32::from_rgb(250, 250, 250), "{:?}", v.color);
                    }
                }
                egui::Shape::Path(p) => { for q in &p.points { assert!(rect.expand(0.5).contains(*q)); } }
                egui::Shape::LineSegment { points, .. } => { for q in points { assert!(rect.expand(0.5).contains(*q)); } }
                _ => {}
            }
        }
        assert!(mesh_tris >= 4 * 64, "vane mesh has {mesh_tris} triangles");
    }

    #[test]
    fn tune_is_a_valid_short_wav() {
        let wav = shang_tune_wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(wav.len(), 44 + data_len);
        let riff_len = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]) as usize;
        assert_eq!(riff_len, 36 + data_len);
        let secs = data_len as f32 / 2.0 / TUNE_RATE as f32;
        assert!((2.5..4.5).contains(&secs), "tune is {secs} s");
        let samples = shang_tune_samples();
        let peak = samples.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak <= 1.0, "peak {peak}");
        // the last note fades to silence
        let tail = &samples[samples.len() - 200..];
        assert!(tail.iter().all(|s| s.abs() < 0.02));
        // and the first note is louder than the last note's end
        let head_peak = samples[..4000].iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        assert!(head_peak > 0.3);
    }
}
