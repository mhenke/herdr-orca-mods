import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // Changes follow the project, not an unrelated terminal folder.
  const live = pane?.cwd || f?.cwd, project = space?.folder || live;
  const cwd = live && project && !(live.startsWith(project + "/") || live === project) ? project : live || project;
  return { cwd, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// Pathspecs stay under the arg limit while keeping one index write per batch.
const chunks = (paths, size = 200) => Array.from({ length: Math.ceil(paths.length / size) }, (_, i) => paths.slice(i * size, i * size + size));



// Git decoration tones, `git-path-decoration.ts:5-12` -> main.css:489-496 (dark).
function gitTone(mark, t) {
  switch (mark) {
    case "A": return "#81b88b";
    case "D": return "#c74e39";
    case "M": return "#e2c08d";
    case "R": case "U": case "C": return "#73c991";
    case "!": return "#808080";
    default: return t.dim;
  }
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.message = ""; this.handle = cx.focus_handle();
    this.hovered = null; this.collapsed = {}; this.busy = false; this.busyReason = null; this.typing = false;
    this.input = TextareaState.new({ placeholder: "Message", rows: 2 });
    this.input.set_auto_grow(2, 12);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = [];
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Source Control is only available for Git repositories"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const stagedStats = {}, unstagedStats = {};
        const readNumstat = async (args, into) => {
          const r = await git(args);
          if (r.code !== 0) throw new Error(r.stderr);
          for (const entry of r.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            into[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
          }
        };
        await readNumstat(["diff", "--cached", "--numstat", "-z", "--no-renames"], stagedStats);
        await readNumstat(["diff", "--numstat", "-z", "--no-renames"], unstagedStats);
        // Porcelain XY splits into an index (staged) and worktree (unstaged) entry; `??` is
        // untracked and a partially staged file lands in both sections with its own counts
        // (shared/git/status/git-status-porcelain-parser.ts:99-104,126-148). Labels follow
        // shared/git/status/git-status-labels.ts:1-8 (untracked is U; conflicts render a badge).
        const rawEntries = status.stdout.split("\0").filter(Boolean);
        const files = [];
        for (const entry of rawEntries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          if (xy === "??") { files.push({ path, section: "changes", status: "U", fresh: true, add: 0, del: 0 }); continue; }
          if (xy.includes("U") || xy === "AA" || xy === "DD") { files.push({ path, section: "conflicts", status: "!", fresh: false, add: 0, del: 0 }); continue; }
          const staged = xy[0] !== " " && xy[0] !== "?", unstaged = xy[1] !== " " && xy[1] !== "?";
          if (staged) files.push({ path, section: "staged", status: xy[0] === "A" ? "A" : xy[0] === "D" ? "D" : "M", fresh: false, ...(stagedStats[path] ?? { add: 0, del: 0 }) });
          if (unstaged) files.push({ path, section: "changes", status: xy[1] === "A" ? "A" : xy[1] === "D" ? "D" : "M", fresh: false, ...(unstagedStats[path] ?? { add: 0, del: 0 }) });
        }
        this.root = root; this.on = on; this.files = files; this.limited = rawEntries.length > 1000; this.error = null;
        this.watch(root, cx);

      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Orca's primary-action state machine (shared/source-control/decisions/source-control-primary-action-decision.ts:95-140)
  // and commit eligibility (decisions/source-control-commit-eligibility.ts:24-38). Only the local
  // branches are reachable here: nothing staged + stageable -> Stage All; staged + message -> Commit;
  // staged without message -> Commit disabled. The upstream/publish/PR branches are omitted below.
  primaryAction() {
    const staged = this.files.filter((f) => f.section === "staged");
    const changes = this.files.filter((f) => f.section === "changes");
    const conflicts = this.files.filter((f) => f.section === "conflicts");
    if (this.busy) return { kind: "commit", label: "Commit", disabled: true, reason: this.busyReason };
    if (conflicts.length) return { kind: "commit", label: "Commit", disabled: true, reason: "Resolve conflicts before committing" };
    if (staged.length && this.message.trim()) return { kind: "commit", label: "Commit", disabled: false, reason: null };
    if (staged.length) return { kind: "commit", label: "Commit", disabled: true, reason: "Enter a commit message to commit" };
    if (changes.length) return { kind: "stage", label: "Stage All", disabled: false, reason: null };
    return { kind: "commit", label: "Commit", disabled: true, reason: "Stage at least one file to commit" };
  }

  runPrimary(cx) {
    const action = this.primaryAction();
    if (action.disabled || !this.root || this.busy || this.loading) return;
    // Stage All stages only; Commit never stages (src/main/git/source-control/staging.ts:131-153, commit-changes.ts).
    if (action.kind === "stage") this.apply([["add", "--all", "--", "."]], cx);
    else this.apply([["commit", "-m", this.message.trim()]], cx, () => { this.message = ""; this.input.set_value(""); });
  }

  apply(commands, cx, done) {
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.busyReason = commands[0]?.[0] === "commit" ? "Commit in progress…" : null; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of commands) {
          const r = await exec("git", [...READ, ...args], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context && done) done();
      } catch (e) { if (key() === context) this.note = String(e).trim(); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stagePaths(paths, cx) {
    this.apply(chunks(paths).map((c) => ["add", "--", ...c]), cx);
  }

  unstagePaths(paths, cx) {
    this.apply(chunks(paths).map((c) => ["reset", "--quiet", "--", ...c]), cx);
  }

  actionButton(icon, t, cx, onClick) {
    // uncommitted-entry-row.tsx:218-273 overlay buttons are 24px with 14px glyphs (action-button.tsx:31-40).
    return div().w(24).h(24).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.chrome))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(svg(`mods/orca-changes/${icon}`).size(14).text_color(t.muted));
  }

  fileRow(f, t, cx) {
    const id = `${f.section}-${f.path}`, parts = f.path.split("/"), name = parts.pop();
    const hovered = this.hovered === id, buttons = [];
    // Per-file commands match Orca: stage `git add --` (src/main/git/source-control/staging.ts:23-31), unstage
    // `git reset --quiet --` (:88-102), discard `git restore --worktree --` (discard-changes.ts:39),
    // untracked delete `git clean -ffdx --` (:53-69,106-112).
    if (f.section === "changes") {
      buttons.push(this.actionButton(f.fresh ? "trash.svg" : "undo.svg", t, cx, () => this.confirmDiscard(f, name, cx)));
      buttons.push(this.actionButton("plus.svg", t, cx, () => this.apply([["add", "--", f.path]], cx)));
    } else if (f.section === "staged") {
      buttons.push(this.actionButton("minus.svg", t, cx, () => this.apply([["reset", "--quiet", "--", f.path]], cx)));
    }
    // Conflicted rows: Orca's resolve buttons (uncommitted-entry-row.tsx:218-229) need the unmerged
    // record re-read and a conflict-kind decision (src/main/git/source-control/staging.ts:40-86); that read is not exposed, so none are drawn.
    // Row click opens an editor diff tab in Orca (open-uncommitted-entry.ts:28-31); Herdr has no diff command.
    return h_flex().id(id).w_full().h(24).flex_none().pl(20).pr(12).gap(4).items_center().relative()
      // Non-open rows hover at accent/40 (row-layout.ts:9-11); t.hover is --accent.
      .hover((s) => s.bg(t.hover + "66"))
      .on_hover((on, cx) => { if (on !== hovered) { this.hovered = on ? id : null; cx.notify(); } })
      .child(svg("mods/orca-changes/file.svg").size(14).flex_none().text_color(gitTone(f.status, t)))
      .child(h_flex().flex_1().min_w(0).items_center()
        .child(div().flex_none().max_w(260).truncate().text_color(t.foreground).child(name))
        .when(parts.length > 0, (e) => e.child(div().ml(6).flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(parts.join("/")))))
      .when(f.add > 0 || f.del > 0, (e) => e.child(h_flex().flex_none().gap(3)
        .when(f.add > 0, (x) => x.child(div().text_size(10).text_color(gitTone("A", t)).child(`+${f.add}`)))
        .when(f.del > 0, (x) => x.child(div().text_size(10).text_color(gitTone("D", t)).child(`-${f.del}`)))))
      .when(f.section === "conflicts", (e) => e.child(div().rounded(999).px(8).py(1).text_size(10).font_weight(600)
        .bg(gitTone("D", t) + "1f").text_color(gitTone("D", t)).child("Unresolved")))
      .when(f.section !== "conflicts", (e) => e.child(div().w(16).flex_none().text_center().text_size(10).font_bold()
        .text_color(gitTone(f.status, t)).child(f.status)))
      .when(hovered && buttons.length > 0, (e) => e.child(h_flex().absolute().right(0).top(0).bottom(0).flex_none()
        .items_center().gap(6).bg(t.hover).pr(12).pl(8).children(buttons)));
  }

  confirmDiscard(f, name, cx) {
    // Orca gates every per-row discard/delete behind a confirmation dialog
    // (discard-confirmation.ts:13-62, use-discard-confirmation.ts:190-201).
    const t = theme(), deleting = f.fresh, restoring = f.status === "D";
    const title = deleting ? `Delete "${name}"?` : restoring ? `Restore "${name}"?` : `Discard changes to "${name}"?`;
    const text = deleting ? "This will permanently delete this file. This cannot be undone."
      : restoring ? "This will restore the last staged version and discard the deletion. This cannot be undone."
      : "This will revert the unstaged changes to this file. This cannot be undone.";
    const label = deleting ? "Delete" : restoring ? "Restore" : "Discard";
    const command = deleting ? ["clean", "-ffdx", "--", f.path] : ["restore", "--worktree", "--", f.path];
    window.open_dialog(() => v_flex().w(360).p(16).gap(12).rounded(8).bg(t.popover).border_1().border_color(t.border)
      .child(div().text_size(13).font_weight(500).text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(text))
      .child(h_flex().justify_end().gap(8)
        .child(div().h(24).px(12).flex().items_center().rounded(6).border_1().border_color(t.border)
          .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, _cx) => { window.close_dialog(); }).child("Cancel"))
        .child(div().h(24).px(12).flex().items_center().rounded(6).bg(deleting ? t.blocked : t.done)
          .text_color(t.canvas).text_size(11).cursor_pointer()
          .on_click((_e, _cx) => { window.close_dialog(); this.apply([command], cx); }).child(label))));
  }

  section(key, label, t, cx) {
    const items = this.files.filter((f) => f.section === key);
    if (!items.length) return null;
    const collapsed = Boolean(this.collapsed[key]), bulk = [];
    if (key === "changes") bulk.push(this.actionButton("plus.svg", t, cx, () => this.stagePaths(items.map((f) => f.path), cx)));
    if (key === "staged") bulk.push(this.actionButton("minus.svg", t, cx, () => this.unstagePaths(items.map((f) => f.path), cx)));
    // Orca also shows Discard all and View all (uncommitted-sections.tsx:119-175); discard is gated
    // by its destructive confirmation flow and View all opens a combined diff, neither of which exists here.
    return div().child(
      div().pl(4).pr(12).pt(12).pb(4).child(
        h_flex().rounded(6).pr(4).gap(4).items_center()
          .child(div().id(`section-${key}`).flex_1().min_w(0).flex().items_center().gap(4).cursor_pointer()
            .on_click((_e, cx) => { this.collapsed[key] = !collapsed; cx.notify(); })
            .child(svg(`mods/orca-changes/${collapsed ? "chevron-right.svg" : "chevron-down.svg"}`).size(14).flex_none().text_color(t.muted))
            .child(div().truncate().text_size(12).font_weight(600).text_color(t.muted).child(label.toUpperCase()))
            .child(div().flex_none().text_size(11).text_color(t.muted).child(String(items.length))))
          .child(h_flex().flex_none().items_center().gap(6).children(bulk))))
      // One scroll container for the whole panel body, as Orca has (panel/panel-ready.tsx).
      .when(!collapsed, (e) => e.child(v_flex().children(items.map((f) => this.fileRow(f, t, cx)))));
  }

  commitArea(t, action, cx) {
    // Orca renders the commit surface above the list (panel/panel-content.tsx:130): wrapper
    // px-3 pb-2 (commit-area.tsx:216), textarea min-h-14 rounded-md border-input bg-background
    // px-2 py-1.5 text-xs (commit-message-composer.tsx:46), actions on an mt-1 row (:32-80).
    return v_flex().flex_none().px(12).pb(8)
      .child(div().id("commit-message").min_h(56).rounded(6).border_1()
        .border_color(this.typing ? t.accent : t.input).bg(t.canvas).px(8).py(6).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().mt(4).gap(4).items_center()
        .child(div().id("commit-primary").h(24).px(12).flex().flex_none().items_center().rounded(6)
          .border_1().border_color(t.border).text_size(11)
          .text_color(action.disabled ? t.dim : t.foreground)
          .when(!action.disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { if (!action.disabled) this.runPrimary(cx); })
          .child(action.label))
        // commit-action-menu.tsx:57-80's chevron holds Push/Sync/Publish/Create PR; those need the
        // upstream and hosted-review state this panel does not read, so the chevron would be dead UI.
        .when(Boolean(action.reason), (e) => e.child(div().text_size(11).text_color(t.dim).child(action.reason))));
  }

  render(cx) {
    // A task's error is reported, not thrown into the paint: a failed refresh
    // must never replace the pane with the shell's "could not be re-rendered" bar.
    // Deferred off the frame for the same reason as `orca-files`: a spawn body runs immediately
    // up to its first `await`, and calling into a view from render invites the same refusal.
    if (key() !== this.context) cx.timer.after(0, (cx) => this.refresh(cx));
    const t = theme(), action = this.primaryAction();
    // Orca pins conflicts first, then applies the group order (default changes-first):
    // listing/source-control-section-order.ts:121-142, source-control-group-order.ts:3-5. A fourth
    // section, Committed on Branch (listing/branch-section.tsx:92-99), needs a base ref and a branch
    // compare; this panel has no base-ref setting, so it is not drawn.
    const sections = [["conflicts", "Conflicts"], ["changes", "Changes"], ["staged", "Staged Changes"]];
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        // Cmd/Ctrl+Enter commits (src/renderer/src/components/right-sidebar/source-control/commit/commit-shortcut.ts:8-17 -> screen-submit-shortcut.ts:20-27).
        if (e.key === "enter" && !e.modifiers.alt && !e.modifiers.shift && (e.modifiers.platform || e.modifiers.control)) {
          cx.stop_propagation(); this.runPrimary(cx);
        }
      })
      // Toolbar, filter and branch context (panel/header-toolbar.tsx:210-322) are not drawn: no
      // filter or branch-compare state is exposed to a mod.
      .child(this.commitArea(t, action, cx))
      // Orca opens a Monaco DiffEditor in an editor tab (open-uncommitted-entry.ts:28-31); Herdr's
      // EditorState is one buffer with no diff model, so no diff is drawn rather than a look-alike.
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(sections.map(([key, label]) => this.section(key, label, t, cx)).filter(Boolean))
        .when(!this.files.length, (e) => e.child(this.emptyState(t))))
      // The too-many-changes card's Retry and Stage All (src/renderer/src/components/right-sidebar/source-control/listing/too-many-changes-banner.tsx:1-53) are not ported.
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Too many changes detected. Only the first 1,000 changes are shown.")))
      .when(Boolean(this.note), (e) => e.child(div().px(12).pb(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }

  emptyState(t) {
    if (this.error) return div().px(16).py(24).text_size(12).text_color(t.muted).child(this.error);
    if (this.loading) return div().px(16).py(24).text_size(12).text_color(t.muted).child("Loading changes…");
    // panel/panel.tsx:11-16; content-status.tsx:133-151 with empty-state.tsx:11-13.
    if (!this.root) return div().px(16).py(24).text_size(12).text_color(t.muted).child("Select a workspace to view changes");
    return div().px(16).py(24)
      .child(div().text_size(14).font_weight(500).text_color(t.foreground).child("No changes on this branch"))
      // No branch base ref is exposed, so this uses Orca's own 'base' fallback (content-status.tsx:139-150).
      .child(div().mt(4).text_size(12).text_color(t.muted).child("This workspace is clean and this branch has no changes ahead of base"));
  }
}
