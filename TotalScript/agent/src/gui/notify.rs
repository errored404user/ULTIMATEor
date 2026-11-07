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
}

pub(super) const NOTICE_CAP: usize = 100;
/// How long a fresh notice also shows as a toast.
const TOAST_SECS: f32 = 3.2;
const TOAST_MAX: usize = 3;

#[derive(Default)]
pub(super) struct NoticeCenter {
    pub items: std::collections::VecDeque<Notice>,
    pub open: bool,
    next_id: u64,
    /// Ids dismissed from the toast stack early (still listed in the center).
    hidden_toasts: Vec<u64>,
}

impl NoticeCenter {
    pub fn push(&mut self, kind: NoticeKind, text: String, source: &str) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        // Collapse exact repeats within two seconds (helpers that flap, repeated probes).
        if let Some(last) = self.items.front_mut() {
            if last.text == text && last.kind == kind && last.at.elapsed().as_secs_f32() < 2.0 { last.at = Instant::now(); return last.id; }
        }
        self.items.push_front(Notice { id, kind, text, clock: chrono::Local::now().format("%H:%M:%S").to_string(), at: Instant::now(), read: false, source: source.to_string() });
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
        self.items.iter().filter(|n| !n.read && n.at.elapsed().as_secs_f32() < TOAST_SECS && !self.hidden_toasts.contains(&n.id)).take(TOAST_MAX).cloned().collect()
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
                            ui.add(egui::Label::new(RichText::new(&n.text).color(t.text)).wrap());
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
                                ui.add(egui::Label::new(RichText::new(&n.text).color(t.text)).wrap());
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
