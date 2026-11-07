// Orca's tab-bar `+` menu: a 288px dropdown (tab-bar-surface.tsx:224-240) with an omnibox
// (TabBarCreateEntry.tsx:317-350) and static create rows (tab-bar-static-create-menu.tsx).
// Opened by orca-tabs, orca-landing and orca-nav.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces, panes, run, props, closeOverlay, openOverlay, pickFolder, keys, window } from "herdr";

// Herdr keys are dash-joined (herdr's own keys.json ships "ctrl-shift-t"); Orca's menu shows
// the combo in caps (ShortcutKeyCombo.tsx:6-18).
function shortcut(name) {
  const k = keys().find((b) => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map((stroke) => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  rows() {
    const space = spaces().find((s) => s.active);
    const pane = panes().find((p) => p.focused);
    const folder = pane?.cwd;
    return [
      // tab-bar-static-create-menu.tsx:213-225 — New Terminal (TerminalSquare).
      ["New Terminal", "square-terminal", shortcut("tab.new"), () => run("tab.new", space ? { space: space.id } : {})],
      // Omitted for lack of a Herdr backend: the omnibox (TabBarCreateEntry.tsx:317-350 — no
      // unified tab/history/file search command and no text input in this popup), the agent
      // picker (TabBarAgentPickerEntry.tsx:19), New Browser Tab (:227), New Markdown (:239),
      // plugin new files, Open Markdown... (:283) and New Mobile Emulator (:266) — Herdr has no
      // browser, editor or emulator. Of Orca's non-terminal tabs, the file browser is Herdr's
      // one real mod pane, so it opens beside the terminal through pane.split (commands.md).
      ...(pane ? [["New File Browser", "folder-open", "", () => run("pane.split", { direction: "right", pane: pane.pane, mod: "orca-files" })]] : []),
      // Orca's "Open Markdown..." (:283) opens a file; Herdr opens folders as terminals.
      ["New Terminal in Folder…", "folder-open", "", "pick"],
      // Orca has no worktree rows here; the stock Herdr menu did, and orca-landing's
      // "Create workspace" button opens this menu for them.
      ["New worktree…", "git-branch-plus", "", () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: space?.id, folder, action: "new" } }), true],
      ["Open worktree…", "workflow", "", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder, action: "open" } })],
    ];
  }

  choose(i, cx) {
    const row = this.rows()[i];
    if (!row) return;
    if (row[3] === "pick") {
      const overlay = props()?.overlay;
      cx.spawn(async () => {
        const folder = await pickFolder({ prompt: "Choose a folder for the terminal" });
        if (!folder) return;
        closeOverlay(overlay);
        run("terminal.open", { folder });
      });
      return;
    }
    closeOverlay(props()?.overlay);
    row[3]();
  }

  render(cx) {
    const t = theme();
    const list = this.rows();
    return v_flex()
      .id("new-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      // Content: w-72 p-1 rounded-[11px] border-border/80 shadow-[0_16px_36px_rgba(0,0,0,0.24)]
      // (tab-bar-surface.tsx:232). The overlay frame owns radius, border and shadow.
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "home") this.at = 0;
        else if (e.key === "end") this.at = list.length - 1;
        else if (e.key === "enter" || e.key === "space") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(list.map(([label, icon, hint, , sep], i) => v_flex()
        .when(sep, (el) => el.child(div().mx(6).my(5).h(1).bg(t.border)))
        .child(h_flex()
          .id(`new-${i}`)
          // tab-bar-static-create-menu.tsx:222 — gap-2 rounded-[7px] px-2 py-1.5 text-[12px]
          // leading-5 font-medium; icon size-4 (16).
          .h(32)
          .px(8)
          .gap(8)
          .rounded(7)
          .items_center()
          .whitespace_nowrap()
          .font_medium()
          .text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .on_hover((hovered, cx) => { if (hovered && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(`mods/new-menu/${icon}.svg`).size(16).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(label))
          // Shortcut: ml-auto pl-4 text-muted-foreground (dropdown-menu.tsx:219).
          .child(div().flex_none().pl(16).text_color(t.muted).child(hint)))));
  }
}
