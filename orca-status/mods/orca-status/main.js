// Orca's bottom bar (StatusBarSurface.tsx:121,136,308-370): provider usage on the
// left (flex-1), maintenance segments right-aligned with 12px gaps, an invisible
// visibility-menu trigger last. Herdr cannot back most of it, and nothing is faked.
// Removed because Orca does not draw it: the palette button and 1px dividers
// (:136 begins the usage roster; :119-373 draws no dividers), the "quota —"
// placeholder (:147-169 is the provider roster), machine name, version-only and
// "N machines away" (:136-328 hold usage, maintenance and a connected-host count
// only), the agent counter (:308-328 has no agent segment), and "checking updates"
// (UpdateStatusSegment.tsx:19 gates to downloading/downloaded/error).
// Other Orca segments with no Herdr primitive: plugins/plugin items (:309-315, mods
// cannot add status-bar items), caffeinate, skill update, native-chat resume, pet,
// resource usage, ports (:316-328), floating-workspace toggle (:330-368,
// layout.toggle cannot toggle a float), and the visibility menu (:370).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { machines, updates, theme, run } from "herdr";

export default class OrcaStatus extends View {

  render() {
    const t = theme();
    const up = updates();
    const openSettings = (section) => () => run("app.settings", { section });

    // Orca's SSH segment hides when no host is configured and otherwise shows the
    // connected count in muted 11px text (SshStatusSegment.tsx:170,177,209-221).
    const hosts = (machines() ?? []).filter(m => m.name !== null);
    const connected = hosts.filter(m => m.layout === "ready").length;
    // machines() stays "loading" until its first read (herdr.d.ts:22323); counting
    // before that would flash "0 hosts" on every start.
    const hostsKnown = hosts.length > 0 && !hosts.some(m => m.layout === "loading");

    // Orca segment shape: gap-1.5 px-1 py-0.5 rounded, 12px glyph, 11px label,
    // hover:bg-accent/70 (UpdateStatusSegment.tsx:115-122); the label keeps #f0f0f0.
    const segment = (id, iconName, label, opts = {}) => h_flex()
      .id(id).gap(6).px(4).py(2).rounded(4).items_center().text_size(11)
      .text_color(opts.muted ? t.muted : t.foreground)
      .when(Boolean(opts.on), el => el.role("button").accessibility_label(label)
        .cursor_pointer().hover(s => s.bg("#404040b3").text_color(t.foreground)).on_click(opts.on))
      .child(svg(`mods/orca-status/${iconName}.svg`).size(12).flex_none()
        .text_color(opts.iconColor ?? t.muted)
        .when(Boolean(opts.spin), el => el.spin(1000)))
      .child(label);

    // StatusBarSurface.tsx:121 — h-6 min-h-[24px] px-3 gap-4 border-t, text-xs,
    // bg-[var(--bg-titlebar,var(--card))] = t.surface (#171717).
    return h_flex().w_full().h(24).min_h(24).flex_none().px(12).gap(16).items_center()
      .bg(t.surface).border_t(1).border_color(t.border).text_size(12).text_color(t.foreground)
      // :136 the left group is flex-1; with no provider usage it stays empty.
      .child(div().flex_1())
      // :308 the middle group: flex w-max gap-3.
      .child(h_flex().gap(12).items_center()
        // Remote-server update (RemoteServerUpdateStatusSegment.tsx:19-70). Herdr
        // updates one core, so Orca's "Updating x/y" cohort (:33) has no count;
        // "N servers updated" (:57) is a post-update phase Herdr never reports, and
        // `core.ready` (a newer core available) is not an Orca bar state.
        .when(up.core.updating, el => el.child(segment("st-core-updating", "refresh-cw", "Updating", { spin: true, on: openSettings("updates") })))
        .when(!up.core.updating && Boolean(up.core.error), el => el.child(segment("st-core-failed", "alert-circle", "1 server update failed", { iconColor: t.blocked, on: openSettings("updates") })))
        // App update (UpdateStatusSegment.tsx:70-88): "Update ready" is the one
        // state Herdr reports (`app.ready`); download %, install-block, preparing
        // and error (:28-56,90-104) have no Herdr field.
        .when(Boolean(up.app.ready), el => el.child(segment("st-app-ready", "circle-check", "Update ready", { iconColor: t.done, on: openSettings("updates") })))
        // Remote hosts: Orca's only segment Herdr backs with a count (:177).
        .when(hostsKnown, el => el.child(segment("st-hosts", "server", `${connected} host${connected === 1 ? "" : "s"}`, { muted: true, on: openSettings("machines") }))));
      // :370 the right end is an invisible visibility-menu trigger, which has no
      // Herdr primitive; nothing is drawn there.
  }
}
