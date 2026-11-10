//! 2.11.0 notification center. Replaces the single 3-second toast with a
//! bounded list the user can open from the bell in the title bar
//! (Ctrl+Shift+N): every bridge / Studio / error event and every action
//! result lands here with a timestamp, the newest few also pop up as stacked
//! toasts in the bottom-right corner. Nothing is persisted — notices are
//! in-memory for the current run only.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum NoticeKind { Info, Ok, Warn, Err }

impl NoticeKind {
    pub(super) fn color(self, t: Theme) -> Color32 {
        match self { NoticeKind::Info => t.info, NoticeKind::Ok => t.ok, NoticeKind::Warn => t.warn, NoticeKind::Err => t.bad }
    }
    pub(super) fn label(self) -> &'static str {
        match self { NoticeKind::Info => "info", NoticeKind::Ok => "ok", NoticeKind::Warn => "warning", NoticeKind::Err => "error" }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Notice {
    pub id: u64,
    pub kind: NoticeKind,
    pub text: String,
    pub clock: String,
    pub at: Instant,
    pub read: bool,
    /// Where it came from: "app", "bridge", "studio", "chat", "pair", "error".
    pub source: String,
    /// How many times this notice repeated (folded repeats bump the counter
    /// instead of popping a new toast). Shown as "×N".
    pub count: u32,
    /// Listed in the center but never shown as a toast (error bursts).
    pub quiet: bool,
}

impl Notice {
    /// Text with the repeat counter, for the toast and the list.
    pub fn display(&self) -> String {
        if self.count > 1 { format!("{} ×{}", self.text, self.count) } else { self.text.clone() }
    }
}

pub(super) const NOTICE_CAP: usize = 100;
/// How long a fresh notice also shows as a toast.
const TOAST_SECS: f32 = 3.2;
const TOAST_MAX: usize = 3;
/// 2.20.0 anti-spam. A repeat of the same notice (same kind, same text once
/// numbers / ids / timings are blanked) inside this window folds into the
/// existing one: the counter grows, the bell badge counts it, but no new
/// toast pops. Errors fold for longer because the same failing probe or
/// tool tends to come back every few seconds.
const FOLD_SECS_ERR: f32 = 120.0;
const FOLD_SECS_WARN: f32 = 30.0;
const FOLD_SECS_OTHER: f32 = 5.0;
/// Beyond this many distinct error toasts per minute the rest go straight to
/// the center (quiet) and one warning explains it.
const ERR_BURST_MAX: usize = 3;
const ERR_BURST_SECS: f32 = 60.0;
const FOLD_LOOKBACK: usize = 40;

/// Normalised fold key: case-folded, every digit run → "#", clipped. So
/// "get_studio_state (roblox) failed: timed out after 25 s" and the same line
/// with 26 s are one notice; two different tools stay two notices.
pub(super) fn fold_key(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(96));
    let mut in_digits = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            if !in_digits { out.push('#'); in_digits = true; }
            continue;
        }
        in_digits = false;
        for lc in ch.to_lowercase() { out.push(lc); }
        if out.len() >= 96 { break; }
    }
    out
}

#[derive(Default)]
pub(super) struct NoticeCenter {
    pub items: std::collections::VecDeque<Notice>,
    pub open: bool,
    next_id: u64,
    /// Ids dismissed from the toast stack early (still listed in the center).
    hidden_toasts: Vec<u64>,
    /// When each non-folded error notice was created (burst detection).
    err_times: std::collections::VecDeque<Instant>,
    /// The burst warning was shown for the burst that is still running.
    burst_warned: bool,
}

impl NoticeCenter {
    pub fn push(&mut self, kind: NoticeKind, text: String, source: &str) -> u64 {
        self.push_at(kind, text, source, Instant::now())
    }

    /// `now` is injectable so the folding windows are testable.
    pub fn push_at(&mut self, kind: NoticeKind, text: String, source: &str, now: Instant) -> u64 {
        let clock = chrono::Local::now().format("%H:%M:%S").to_string();
        // 1. Fold repeats: same kind + same normalised text inside the window →
        //    bump the counter on the existing notice, no new toast.
        let key = fold_key(&text);
        let window = match kind { NoticeKind::Err => FOLD_SECS_ERR, NoticeKind::Warn => FOLD_SECS_WARN, _ => FOLD_SECS_OTHER };
        if let Some(existing) = self.items.iter_mut().take(FOLD_LOOKBACK).find(|n| n.kind == kind && now.duration_since(n.at).as_secs_f32() < window && fold_key(&n.text) == key) {
            existing.count = existing.count.saturating_add(1);
            existing.clock = clock;
            existing.read = false;
            existing.text = text; // keep the latest wording (newest timing / id)
            return existing.id;
        }
        // 2. Error bursts: after ERR_BURST_MAX distinct errors in a minute the
        //    rest are listed quietly (bell badge, no toast), with one warning.
        let mut quiet = false;
        if kind == NoticeKind::Err {
            while let Some(t) = self.err_times.front() {
                if now.duration_since(*t).as_secs_f32() > ERR_BURST_SECS { self.err_times.pop_front(); } else { break; }
            }
            if self.err_times.len() >= ERR_BURST_MAX {
                quiet = true;
                if !self.burst_warned {
                    self.burst_warned = true;
                    self.insert(NoticeKind::Warn, "Errors are repeating — new ones are collected in the notification center (bell) instead of popping up.".to_string(), "app", clock.clone(), now, false);
                }
            } else {
                self.burst_warned = false;
            }
            self.err_times.push_back(now);
            while self.err_times.len() > 32 { self.err_times.pop_front(); }
        }
        self.insert(kind, text, source, clock, now, quiet)
    }

    fn insert(&mut self, kind: NoticeKind, text: String, source: &str, clock: String, at: Instant, quiet: bool) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.items.push_front(Notice { id, kind, text, clock, at, read: false, source: source.to_string(), count: 1, quiet });
        while self.items.len() > NOTICE_CAP { self.items.pop_back(); }
        id
    }
    pub fn unread(&self) -> usize { self.items.iter().filter(|n| !n.read).count() }
    pub fn mark_all_read(&mut self) { for n in self.items.iter_mut() { n.read = true; } }
    pub fn clear(&mut self) { self.items.clear(); self.hidden_toasts.clear(); }
    pub fn dismiss(&mut self, id: u64) { self.items.retain(|n| n.id != id); }
    pub fn hide_toast(&mut self, id: u64) { self.hidden_toasts.push(id); }
    /// Fresh, unread notices that still deserve a toast (newest first).
    pub fn toasts(&self) -> Vec<Notice> {
        self.items.iter().filter(|n| !n.read && !n.quiet && n.at.elapsed().as_secs_f32() < TOAST_SECS && !self.hidden_toasts.contains(&n.id)).take(TOAST_MAX).cloned().collect()
    }
}

impl App {
    pub(super) fn notify(&mut self, kind: NoticeKind, text: impl Into<String>, source: &str) {
        self.notices.push(kind, text.into(), source);
    }

    /// Stacked toasts bottom-right; clicking one opens the center.
    pub(super) fn draw_toasts(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        let toasts = self.notices.toasts();
        if toasts.is_empty() { return; }
        ctx.request_repaint_after(Duration::from_millis(100));
        let mut open = false;
        let mut hide: Option<u64> = None;
        let mut y = -20.0;
        for n in toasts {
            let age = n.at.elapsed().as_secs_f32();
            let (rise, fade) = if self.settings.motion { ((age / 0.18).min(1.0), ((TOAST_SECS - age) / 0.4).min(1.0)) } else { (1.0, 1.0) };
            let ease = 1.0 - (1.0 - rise) * (1.0 - rise);
            let color = n.kind.color(t);
            let resp = egui::Area::new(egui::Id::new(("toast", n.id)))
                .order(egui::Order::Foreground)
                .anchor(egui::Align2::RIGHT_BOTTOM, Vec2::new(-20.0, y + 14.0 * (1.0 - ease)))
                .interactable(true)
                .show(ctx, |ui| {
                    ui.set_opacity(ease.min(fade));
                    let frame = egui::Frame::none().fill(t.panel2).stroke(Stroke::new(1.0_f32, color)).rounding(Rounding::same(t.r_btn)).inner_margin(Margin::symmetric(14.0, 10.0))
                        .shadow(egui::epaint::Shadow { offset: Vec2::new(0.0, 6.0), blur: 18.0, spread: 0.0, color: alpha(Color32::BLACK, if t.light { 40 } else { 120 }) });
                    frame.show(ui, |ui| {
                        ui.set_max_width(360.0);
                        ui.horizontal(|ui| {
                            status_dot(ui, color);
                            ui.add(egui::Label::new(RichText::new(n.display()).color(t.text)).wrap()).on_hover_text(format!("{} · {} · click to open the notification center", n.kind.label(), n.clock));
                            if icon_button(ui, t, Icon::Close, "Dismiss", false).clicked() { hide = Some(n.id); }
                        });
                    });
                }).response;
            let resp = resp.interact(Sense::click());
            if resp.clicked() { open = true; }
            y -= 56.0;
        }
        if let Some(id) = hide { self.notices.hide_toast(id); }
        if open { self.notices.open = true; self.notices.mark_all_read(); }
    }

    /// The bell in the title bar: unread badge + click toggles the popover.
    pub(super) fn bell_button(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let unread = self.notices.unread();
        let resp = icon_button(ui, t, Icon::Bell, if unread == 0 { "Notifications (Ctrl+Shift+N)" } else { "Notifications — unread" }, self.notices.open);
        if unread > 0 {
            let r = resp.rect;
            let c = Pos2::new(r.right() - 6.0, r.top() + 6.0);
            let text = if unread > 9 { "9+".to_string() } else { unread.to_string() };
            ui.painter().circle_filled(c, 7.5, t.bad);
            ui.painter().text(c, egui::Align2::CENTER_CENTER, text, FontId::new(9.0, FontFamily::Proportional), Color32::WHITE);
        }
        if resp.clicked() { self.toggle_notices(); }
    }

    pub(super) fn toggle_notices(&mut self) {
        self.notices.open = !self.notices.open;
        if self.notices.open { self.notices.mark_all_read(); }
    }

    /// Popover under the bell. Esc closes it (handled in `handle_shortcuts`).
    pub(super) fn draw_notice_center(&mut self, ctx: &egui::Context) {
        if !self.notices.open { return; }
        let t = self.theme;
        let mut close = false;
        let mut clear = false;
        let mut dismiss: Option<u64> = None;
        let items: Vec<Notice> = self.notices.items.iter().cloned().collect();
        let resp = egui::Area::new(egui::Id::new("notice-center"))
            .order(egui::Order::Foreground)
            .anchor(egui::Align2::RIGHT_TOP, Vec2::new(-12.0, 46.0))
            .show(ctx, |ui| {
                let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border2)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(12.0))
                    .shadow(egui::epaint::Shadow { offset: Vec2::new(0.0, 8.0), blur: 24.0, spread: 0.0, color: alpha(Color32::BLACK, if t.light { 50 } else { 140 }) });
                frame.show(ui, |ui| {
                    ui.set_width(380.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Notifications").size(15.0).strong().color(t.text));
                        ui.label(RichText::new(format!("{} · this run only", items.len())).small().color(t.muted));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if icon_button(ui, t, Icon::Close, "Close (Esc)", false).clicked() { close = true; }
                            if !items.is_empty() && icon_button(ui, t, Icon::Trash, "Clear all", false).clicked() { clear = true; }
                        });
                    });
                    ui.add_space(6.0);
                    if items.is_empty() {
                        empty_state(ui, t, "Nothing yet", "Bridge, Studio, chat and action results appear here with a timestamp.");
                        return;
                    }
                    egui::ScrollArea::vertical().id_salt("notice-list").max_height(420.0).auto_shrink([false, true]).show(ui, |ui| {
                        for n in &items {
                            let color = n.kind.color(t);
                            let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, alpha(color, 90))).rounding(Rounding::same(t.r_card)).inner_margin(Margin::symmetric(10.0, 8.0));
                            frame.show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                ui.horizontal(|ui| {
                                    status_dot(ui, color);
                                    ui.label(RichText::new(&n.clock).small().monospace().color(t.muted));
                                    tag(ui, &n.source, color);
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if icon_button(ui, t, Icon::Close, "Dismiss", false).clicked() { dismiss = Some(n.id); }
                                    });
                                });
                                ui.add(egui::Label::new(RichText::new(n.display()).color(t.text)).wrap());
                            });
                            ui.add_space(4.0);
                        }
                    });
                });
            }).response;
        // Click anywhere outside closes the popover.
        if ctx.input(|i| i.pointer.any_pressed()) {
            if let Some(pos) = ctx.input(|i| i.pointer.interact_pos()) {
                if !resp.rect.expand(4.0).contains(pos) && pos.y > 40.0 { close = true; }
            }
        }
        if let Some(id) = dismiss { self.notices.dismiss(id); }
        if clear { self.notices.clear(); }
        if close { self.notices.open = false; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(base: Instant, s: f32) -> Instant { base + Duration::from_secs_f32(s) }

    #[test]
    fn fold_key_blanks_numbers_and_case() {
        assert_eq!(fold_key("Tool X failed: timed out after 25 s"), fold_key("tool x failed: timed out after 26 s"));
        assert_ne!(fold_key("get_studio_state (roblox) failed"), fold_key("bb_status (roblox) failed"));
        assert_eq!(fold_key("bbjob-17 done in 1234 ms"), "bbjob-# done in # ms");
    }

    #[test]
    fn repeats_fold_into_one_notice_without_a_new_toast() {
        let mut c = NoticeCenter::default();
        let t0 = Instant::now();
        let a = c.push_at(NoticeKind::Err, "bb_cubes (roblox) failed: Blockbench is not connected (try 1)".into(), "error", t0);
        let b = c.push_at(NoticeKind::Err, "bb_cubes (roblox) failed: Blockbench is not connected (try 2)".into(), "error", secs(t0, 20.0));
        let c3 = c.push_at(NoticeKind::Err, "bb_cubes (roblox) failed: Blockbench is not connected (try 3)".into(), "error", secs(t0, 100.0));
        assert_eq!(a, b); assert_eq!(a, c3);
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0].count, 3);
        assert!(c.items[0].display().ends_with("×3"));
        assert_eq!(c.items[0].at, t0, "a folded repeat must not re-arm the toast");
        // outside the window → a fresh notice
        let d = c.push_at(NoticeKind::Err, "bb_cubes (roblox) failed: Blockbench is not connected (try 4)".into(), "error", secs(t0, 130.0));
        assert_ne!(a, d);
        assert_eq!(c.items.len(), 2);
    }

    #[test]
    fn info_folds_only_briefly_and_different_tools_stay_apart() {
        let mut c = NoticeCenter::default();
        let t0 = Instant::now();
        let a = c.push_at(NoticeKind::Info, "Bridge connected".into(), "bridge", t0);
        let b = c.push_at(NoticeKind::Info, "Bridge connected".into(), "bridge", secs(t0, 10.0));
        assert_ne!(a, b, "info repeats fold for 5 s only");
        let x = c.push_at(NoticeKind::Err, "tool_a (roblox) failed: boom".into(), "error", t0);
        let y = c.push_at(NoticeKind::Err, "tool_b (roblox) failed: boom".into(), "error", t0);
        assert_ne!(x, y);
    }

    #[test]
    fn error_bursts_go_quiet_after_three_with_one_warning() {
        let mut c = NoticeCenter::default();
        let t0 = Instant::now();
        for i in 0..6 {
            c.push_at(NoticeKind::Err, format!("tool_{i} (roblox) failed: boom"), "error", secs(t0, i as f32));
        }
        let errs: Vec<&Notice> = c.items.iter().filter(|n| n.kind == NoticeKind::Err).collect();
        assert_eq!(errs.len(), 6, "every error is listed in the center");
        assert_eq!(errs.iter().filter(|n| !n.quiet).count(), 3, "only the first three may toast");
        assert_eq!(errs.iter().filter(|n| n.quiet).count(), 3);
        let warns: Vec<&Notice> = c.items.iter().filter(|n| n.kind == NoticeKind::Warn).collect();
        assert_eq!(warns.len(), 1, "one explanation per burst");
        assert!(warns[0].text.contains("notification center"));
        assert_eq!(c.unread(), 7);
        // a minute later the burst is over: errors toast again and a new burst warns again
        let late = c.push_at(NoticeKind::Err, "tool_late (roblox) failed: boom".into(), "error", secs(t0, 70.0));
        assert!(!c.items.iter().find(|n| n.id == late).unwrap().quiet);
    }

    #[test]
    fn quiet_notices_never_toast() {
        let mut c = NoticeCenter::default();
        let t0 = Instant::now();
        for i in 0..5 { c.push_at(NoticeKind::Err, format!("tool_{i} (roblox) failed: boom"), "error", t0); }
        let toasts = c.toasts();
        assert!(toasts.iter().all(|n| !n.quiet));
        assert!(toasts.len() <= TOAST_MAX);
    }
}
