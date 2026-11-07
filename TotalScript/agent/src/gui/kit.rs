//! 2.11.0 widget kit: the small controls every new page is built from —
//! stroke-painted icons (no icon font), icon-only buttons, segmented
//! controls, switches, a spinner and a busy button. All of them are plain
//! egui widgets that read the shared `Theme`, so palette / accent / corner
//! settings apply to them exactly like to the older `Btn` family.

use super::*;

/// Icons painted with strokes so they scale with `ui_scale` and follow the
/// theme colour — the bundled Inter subset has no icon glyphs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Icon { Bell, Search, Close, Check, Copy, Folder, Refresh, Star, StarFilled, Trash, Play, Stop, Gear, Info, Warn, Terminal, Palette, List, Pulse }

pub(super) fn paint_icon(p: &egui::Painter, r: egui::Rect, icon: Icon, c: Color32) {
    let s = Stroke::new(1.6_f32, c);
    let (l, top, w, h) = (r.left(), r.top(), r.width(), r.height());
    let pt = |x: f32, y: f32| egui::pos2(l + x * w, top + y * h);
    match icon {
        Icon::Bell => {
            // dome + clapper
            let pts: Vec<Pos2> = (0..=10).map(|i| { let a = std::f32::consts::PI * (1.0 - i as f32 / 10.0); pt(0.5 + 0.32 * a.cos(), 0.48 - 0.34 * a.sin()) }).collect();
            p.add(egui::Shape::line(pts, s));
            p.line_segment([pt(0.18, 0.48), pt(0.12, 0.72)], s);
            p.line_segment([pt(0.82, 0.48), pt(0.88, 0.72)], s);
            p.line_segment([pt(0.12, 0.72), pt(0.88, 0.72)], s);
            p.line_segment([pt(0.4, 0.86), pt(0.6, 0.86)], Stroke::new(2.0_f32, c));
        }
        Icon::Search => {
            p.circle_stroke(pt(0.42, 0.42), w * 0.28, s);
            p.line_segment([pt(0.64, 0.64), pt(0.9, 0.9)], Stroke::new(2.0_f32, c));
        }
        Icon::Close => {
            p.line_segment([pt(0.22, 0.22), pt(0.78, 0.78)], s);
            p.line_segment([pt(0.78, 0.22), pt(0.22, 0.78)], s);
        }
        Icon::Check => {
            p.line_segment([pt(0.18, 0.54), pt(0.42, 0.78)], Stroke::new(2.0_f32, c));
            p.line_segment([pt(0.42, 0.78), pt(0.84, 0.26)], Stroke::new(2.0_f32, c));
        }
        Icon::Copy => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.34, 0.3), pt(0.9, 0.9)), Rounding::same(2.0), s);
            p.line_segment([pt(0.22, 0.66), pt(0.12, 0.66)], s);
            p.line_segment([pt(0.12, 0.66), pt(0.12, 0.1)], s);
            p.line_segment([pt(0.12, 0.1), pt(0.68, 0.1)], s);
            p.line_segment([pt(0.68, 0.1), pt(0.68, 0.2)], s);
        }
        Icon::Folder => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.28), pt(0.92, 0.86)), Rounding::same(2.0), s);
            p.line_segment([pt(0.08, 0.28), pt(0.38, 0.14)], s);
            p.line_segment([pt(0.38, 0.14), pt(0.5, 0.28)], s);
        }
        Icon::Refresh => {
            let pts: Vec<Pos2> = (0..=14).map(|i| { let a = -0.4 + 5.2 * i as f32 / 14.0; pt(0.5 + 0.34 * a.cos(), 0.5 + 0.34 * a.sin()) }).collect();
            p.add(egui::Shape::line(pts, s));
            p.line_segment([pt(0.84, 0.18), pt(0.84, 0.42)], s);
            p.line_segment([pt(0.84, 0.42), pt(0.6, 0.42)], s);
        }
        Icon::Star | Icon::StarFilled => {
            let pts: Vec<Pos2> = (0..10).map(|i| {
                let a = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::PI / 5.0;
                let rr = if i % 2 == 0 { 0.44 } else { 0.2 };
                pt(0.5 + rr * a.cos(), 0.54 + rr * a.sin())
            }).collect();
            if icon == Icon::StarFilled {
                // Concave shape: inner pentagon + five tip triangles (each convex).
                let inner: Vec<Pos2> = (0..5).map(|i| pts[i * 2 + 1]).collect();
                p.add(egui::Shape::convex_polygon(inner, c, Stroke::NONE));
                for i in 0..5 {
                    let tri = vec![pts[i * 2], pts[(i * 2 + 1) % 10], pts[(i * 2 + 9) % 10]];
                    p.add(egui::Shape::convex_polygon(tri, c, Stroke::NONE));
                }
                p.add(egui::Shape::closed_line(pts, Stroke::new(1.0_f32, c)));
            } else { p.add(egui::Shape::closed_line(pts, s)); }
        }
        Icon::Trash => {
            p.line_segment([pt(0.14, 0.26), pt(0.86, 0.26)], s);
            p.line_segment([pt(0.38, 0.26), pt(0.38, 0.14)], s);
            p.line_segment([pt(0.38, 0.14), pt(0.62, 0.14)], s);
            p.line_segment([pt(0.62, 0.14), pt(0.62, 0.26)], s);
            p.rect_stroke(egui::Rect::from_min_max(pt(0.22, 0.26), pt(0.78, 0.9)), Rounding::same(1.5), s);
            p.line_segment([pt(0.4, 0.4), pt(0.4, 0.76)], s);
            p.line_segment([pt(0.6, 0.4), pt(0.6, 0.76)], s);
        }
        Icon::Play => {
            p.add(egui::Shape::convex_polygon(vec![pt(0.26, 0.14), pt(0.86, 0.5), pt(0.26, 0.86)], c, Stroke::NONE));
        }
        Icon::Stop => {
            p.rect_filled(egui::Rect::from_min_max(pt(0.22, 0.22), pt(0.78, 0.78)), Rounding::same(2.0), c);
        }
        Icon::Gear => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.36, Stroke::new(2.2_f32, c));
            p.circle_stroke(pt(0.5, 0.5), w * 0.13, s);
        }
        Icon::Info => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.42, s);
            p.line_segment([pt(0.5, 0.44), pt(0.5, 0.74)], Stroke::new(2.0_f32, c));
            p.circle_filled(pt(0.5, 0.3), 1.4, c);
        }
        Icon::Warn => {
            p.add(egui::Shape::closed_line(vec![pt(0.5, 0.1), pt(0.92, 0.88), pt(0.08, 0.88)], s));
            p.line_segment([pt(0.5, 0.38), pt(0.5, 0.64)], Stroke::new(2.0_f32, c));
            p.circle_filled(pt(0.5, 0.76), 1.4, c);
        }
        Icon::Terminal => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.15), pt(0.92, 0.85)), Rounding::same(2.0), s);
            p.line_segment([pt(0.25, 0.4), pt(0.42, 0.52)], s);
            p.line_segment([pt(0.42, 0.52), pt(0.25, 0.64)], s);
            p.line_segment([pt(0.5, 0.66), pt(0.75, 0.66)], s);
        }
        Icon::Palette => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.42, s);
            for (x, y) in [(0.32, 0.36), (0.5, 0.26), (0.68, 0.36), (0.72, 0.58)] { p.circle_filled(pt(x, y), 1.6, c); }
            p.circle_filled(pt(0.56, 0.68), w * 0.11, c);
        }
        Icon::List => {
            for y in [0.24, 0.5, 0.76] {
                p.circle_filled(pt(0.16, y), 1.6, c);
                p.line_segment([pt(0.32, y), pt(0.9, y)], s);
            }
        }
        Icon::Pulse => {
            p.add(egui::Shape::line(vec![pt(0.06, 0.55), pt(0.3, 0.55), pt(0.4, 0.22), pt(0.54, 0.84), pt(0.64, 0.55), pt(0.94, 0.55)], s));
        }
    }
}

/// 28 × 28 icon-only button with a tooltip (the tooltip is the label, so the
/// control is still discoverable). `on` paints the accent background.
pub(super) fn icon_button(ui: &mut egui::Ui, t: Theme, icon: Icon, tip: &str, on: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(28.0), Sense::click());
    let hover = resp.hovered();
    let p = ui.painter();
    let fill = if on { alpha(t.accent, 50) } else if hover { t.panel2 } else { Color32::TRANSPARENT };
    p.rect_filled(rect, Rounding::same(t.r_btn), fill);
    if hover || on { p.rect_stroke(rect, Rounding::same(t.r_btn), Stroke::new(1.0_f32, if on { alpha(t.accent, 160) } else { t.border2 })); }
    let col = if on { t.accent } else if hover { t.text } else { t.muted };
    paint_icon(p, egui::Rect::from_center_size(rect.center(), Vec2::splat(15.0)), icon, col);
    if hover { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    resp.on_hover_text(tip)
}

/// Segmented control: one pill with N labelled segments, exactly one active.
/// Returns true when the selection changed.
pub(super) fn segmented<T: Copy + PartialEq>(ui: &mut egui::Ui, t: Theme, items: &[(T, &str)], current: &mut T) -> bool {
    let mut changed = false;
    let font = font_medium(12.5);
    let pad = 11.0;
    let h = 28.0;
    let widths: Vec<f32> = items.iter().map(|(_, label)| ui.painter().layout_no_wrap(label.to_string(), font.clone(), t.text).size().x + pad * 2.0).collect();
    let total: f32 = widths.iter().sum::<f32>() + 2.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(total, h), Sense::hover());
    ui.painter().rect_filled(rect, Rounding::same(t.r_btn), t.bg2);
    ui.painter().rect_stroke(rect, Rounding::same(t.r_btn), Stroke::new(1.0_f32, t.border));
    let mut x = rect.left() + 1.0;
    for ((value, label), w) in items.iter().zip(widths) {
        let seg = egui::Rect::from_min_size(Pos2::new(x, rect.top() + 1.0), Vec2::new(w, h - 2.0));
        let resp = ui.interact(seg, ui.id().with(("seg", *label)), Sense::click());
        let on = *current == *value;
        let p = ui.painter();
        if on {
            p.rect_filled(seg, Rounding::same((t.r_btn - 1.0).max(2.0)), t.accent);
        } else if resp.hovered() {
            p.rect_filled(seg, Rounding::same((t.r_btn - 1.0).max(2.0)), t.panel2);
            ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand);
        }
        p.text(seg.center(), egui::Align2::CENTER_CENTER, *label, font.clone(), if on { t.accent_ink } else { t.text });
        if resp.clicked() && !on { *current = *value; changed = true; }
        x += w;
    }
    changed
}

/// Switch (34 × 18) with a label; the whole row toggles. Returns true on change.
pub(super) fn toggle(ui: &mut egui::Ui, t: Theme, on: &mut bool, label: &str) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(34.0, 18.0), Sense::click());
        let k = ui.ctx().animate_bool_with_time(resp.id, *on, 0.12);
        let p = ui.painter();
        let track = mix(t.border2, t.accent, k);
        p.rect_filled(rect, Rounding::same(9.0), track);
        let knob = Pos2::new(rect.left() + 9.0 + 16.0 * k, rect.center().y);
        p.circle_filled(knob, 7.0, if t.light && k < 0.5 { Color32::WHITE } else { mix(t.text, t.accent_ink, k) });
        let text = ui.add(egui::Label::new(RichText::new(label).color(t.text)).sense(Sense::click()).wrap());
        if resp.clicked() || text.clicked() { *on = !*on; changed = true; }
        if resp.hovered() || text.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    });
    changed
}

/// Rotating arc; asks for a repaint while visible.
pub(super) fn spinner(ui: &mut egui::Ui, t: Theme, size: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let time = ui.input(|i| i.time) as f32;
    let start = time * 4.0;
    let pts: Vec<Pos2> = (0..=12).map(|i| { let a = start + 4.2 * i as f32 / 12.0; rect.center() + Vec2::new(a.cos(), a.sin()) * (size * 0.38) }).collect();
    ui.painter().add(egui::Shape::line(pts, Stroke::new(2.0_f32, t.accent)));
    ui.ctx().request_repaint();
}

/// A button that shows a spinner and is disabled while `busy`.
pub(super) fn busy_button(ui: &mut egui::Ui, t: Theme, text: &str, busy_text: &str, busy: bool, kind: Btn) -> egui::Response {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        if busy { spinner(ui, t, 16.0); }
        ui.add_enabled(!busy, button_widget(t, if busy { busy_text } else { text }, kind))
    }).inner
}

/// Standard panel card with the theme's card radius; closure draws the body.
pub(super) fn card<R>(ui: &mut egui::Ui, t: Theme, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(14.0));
    frame.show(ui, |ui| { ui.set_width(ui.available_width()); add(ui) }).inner
}

/// Card heading row: title on the left, closure draws the right-aligned actions.
pub(super) fn card_title(ui: &mut egui::Ui, t: Theme, title: &str, right: impl FnOnce(&mut egui::Ui)) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(title).size(15.0).strong().color(t.text));
        ui.with_layout(Layout::right_to_left(Align::Center), right);
    });
    ui.add_space(6.0);
}

/// Centered "nothing here" block.
pub(super) fn empty_state(ui: &mut egui::Ui, t: Theme, title: &str, hint: &str) {
    ui.add_space(8.0);
    ui.vertical_centered(|ui| {
        ui.label(RichText::new(title).strong().color(t.text));
        ui.add(egui::Label::new(RichText::new(hint).small().color(t.muted)).wrap());
    });
    ui.add_space(8.0);
}

/// "key   value" line used by stats cards.
pub(super) fn kv(ui: &mut egui::Ui, t: Theme, key: &str, value: &str) {
    ui.horizontal(|ui| {
        ui.add(egui::Label::new(RichText::new(key).color(t.muted)).truncate());
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| { ui.label(RichText::new(value).strong().color(t.text)); });
    });
}

/// Big number + caption tile for the dashboard.
pub(super) fn stat_tile(ui: &mut egui::Ui, t: Theme, value: &str, caption: &str, color: Color32) {
    let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::symmetric(12.0, 10.0));
    frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(RichText::new(value).size(20.0).strong().color(color));
        ui.add(egui::Label::new(RichText::new(caption).small().color(t.muted)).truncate());
    });
}

/// Keyboard shortcut chip ("Ctrl+K").
pub(super) fn key_chip(ui: &mut egui::Ui, t: Theme, keys: &str) {
    let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border2)).rounding(Rounding::same(t.r_chip)).inner_margin(Margin::symmetric(6.0, 1.0));
    frame.show(ui, |ui| { ui.label(RichText::new(keys).small().monospace().color(t.muted)); });
}

/// Every shortcut the window handles — one table, used by Settings →
/// Shortcuts, the Help page and the command palette.
pub(super) const SHORTCUTS: &[(&str, &str)] = &[
    ("Ctrl+K", "Command palette (also Ctrl+P)"),
    ("Ctrl+1 … Ctrl+9", "Home · AI Chat · Explorer · MCP Servers · Terminal · Help · Settings · Activity · Diagnostics"),
    ("Ctrl+,", "Settings"),
    ("Ctrl+J", "Toggle the AI chat side panel"),
    ("Ctrl+R", "Restart the Studio MCP helper"),
    ("Ctrl+Shift+S", "Capture the Studio viewport"),
    ("Ctrl+Shift+N", "Notification center"),
    ("F1", "Help"),
    ("F5", "Probe Studio + refresh the Explorer"),
    ("Esc", "Close the palette / notifications; clear searches and armed buttons"),
];
