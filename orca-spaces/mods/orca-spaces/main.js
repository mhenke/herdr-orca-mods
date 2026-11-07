// Workspace spaces: worktrees under their checkout, grouped by machine when more than
// one is known. Cards follow Orca's classic card: folder/repo header, a status lane, a
// title and a meta row (branch, then the review badge at its end). Agent state lives in
// the agents list, not here. Click to switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, props, nextCommand } from "herdr";
import { repoMark, tint, parseRemote, avatarUrlFor, ensureAvatar } from "./project.js";
import { statusMark, agentStateMark } from "./status.js";
import { getWorktreeCardContentIndent, getFlushWorktreeCardPaddingLeft, getWorktreeCardSurfaceInset, getFolderWorkspaceCardContentIndent, getFolderWorkspaceCardSurfaceInset, getProjectGroupHeaderPaddingLeft, WORKTREE_CARD_SURFACE_MARGIN, LEGACY_STATUS_LANE_WIDTH } from "./indentation.js";
import { tip, tipMark } from "./tip.js";
import { stopsInit, stop, focusRoot, enter, within } from "./focus.js";
import { parseWorktreeList, place, where, base, readPair, foldKey, projectWorktreePlan } from "./worktree-plan.js";

// `BRANCH_PR_LOOKUP_PAGE_SIZE` (pr-branch-lookup.ts:29): "GitHub lists a branch's PRs newest
// first, so with a page of one a closed PR opened after the live one wins."
const BRANCH_PR_LOOKUP_PAGE_SIZE = 10;

// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Safely read a stored JSON value of the expected shape; a mangled key never throws.
function stored(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(fallback) === Array.isArray(v) && v !== null && typeof v === "object" ? v : fallback;
  } catch { return fallback; }
}
export default class Spaces extends View {
  init(_props, cx) {
    stopsInit(this, cx, "entry");
    // pane.go onto this list (mod.json's "focusable"): the keyboard starts at the heading's button.
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        // A popup over this mod hands focus back when it closes, so the header cluster can stop
        // being held visible for `has-[button[aria-expanded=true]]`
        // (`worktree-list/rows/ProjectHeaderActions.tsx:5-15`) — Herdr has no expanded attribute.
        if (cmd === "focus") { this.menuKey = null; enter(this, cx, "space-new"); }
        // `project-collapse-all.ts` setAllProjectsCollapsed: collapsing adds every project key;
        // expanding clears all project keys (nested ones included), keeping machine folds.
        // Keys are the same ones `header()` folds on: repo name, or `space:<id>` for a folder.
        else if (cmd === "collapse-all" || cmd === "expand-all") {
          if (cmd === "collapse-all") {
            for (const k of this.projectKeys(cx)) this.foldedRepos.add(k);
          } else {
            this.foldedRepos.clear();
          }
          localStorage.setItem("repos.folded", JSON.stringify([...this.foldedRepos]));
          cx.notify();
        }
      }
    });
    // where() -> { name, branch, owner, repo, linked }, null: not a repo.
    // v2: v1 stored no `worktrees` for a space opened on a linked worktree, so the plan
    // could not name that repo's main checkout or its siblings. Retire those entries rather
    // than trust a shape the plan can no longer anchor a group on.
    // Seeded from the last session, the Herdr equivalent of the project list Orca hydrates
    // from its persisted store (`sidebar/index.tsx:69` reads `s.repos`;
    // `main/persistence/loading-store/store.ts:68` owns it). Herdr exposes no project catalog
    // (`defaults/herdr.d.ts`), so a repo no `exec` has ever probed is unreachable; this cache
    // is seeded whenever a space's git is read, and rows paint from it while refresh runs.
    this.git = stored("git.cache.v2", {});
    // Orca keeps reviews out of the worktree row: `buildWorkspaceReviewFacts` reads a
    // persisted cache keyed `repo::branch` (`getGitHubPRCacheKeyCandidates`) and the card
    // draws whatever sits there. Nothing is fetched while rendering. Same shape here:
    // `prCache[key] = { data: { number, state } | null, at }`, keyed `<common-dir>::<branch>`.
    // v2: v1 answered `--head <branch>` with no owner check, so a fork's `main` sat in the
    // `stablyai/orca::main` slot. Bumping the key retires those entries instead of trusting them.
    this.prCache = stored("pr.cache.v2", {});
    this.prAsking = new Set(); // keys with a hydrating `gh` in flight
    this.prChecked = {}; // key -> when the cache last answered
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Orca startupWorktreeRefreshCompleted (startup-worktree-refresh.ts:80).
    // When cached git state exists, rows paint immediately without a loading flash.
    this.loaded = Object.keys(this.git).length > 0;
    // Saved folders (`projects.saved.v1`) are probed once each: a path that is gone is
    // marked, never silently dropped (the row stays, with "missing").
    this.missingFolders = new Set();
    this.savedChecked = new Set();
    this.pressed = null;
    // The group whose menu overlay is open: its header cluster stays visible while the
    // pointer is over the overlay instead of the header.
    this.menuKey = null;
    this.over = null;
    // Orca reveals the sidebar thumb on `.scrollbar-sleek-parent:hover` (`main.css:781-800`);
    // the placed bar's own `hover` mode only sees the bar, so the list's pointer drives it.
    this.listHover = false;
    this.machines = [];
    this.reconnecting = stored("machines.reconnecting", {});
    for (const state of Object.values(this.reconnecting)) if (state && typeof state === "object") state.busy = false;
    this.folded = new Set(stored("machines.folded", []));
    this.foldedRepos = new Set(stored("repos.folded", []));
    // `worktree-card-agents-expansion-state.ts:12-16`: a card's compact agent list starts
    // collapsed (`compactRootListExpanded: false`), so the stored set is the expanded ones.
    this.expandedAgents = new Set(stored("agents.expanded", []));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    cx.timer.every(15000, cx => { void this.checkSaved(cx); });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  // A saved folder can be moved or deleted between runs. Orca keeps a project whose
  // worktree list is gone until the person removes it, so the row says "missing" and
  // the remove control is the only way it disappears.
  async checkSaved(cx) {
    const saved = stored("projects.saved.v1", []);
    const unseen = saved.filter(folder => !this.savedChecked.has(folder));
    if (!unseen.length) return;
    let changed = false;
    for (const folder of unseen) {
      this.savedChecked.add(folder);
      const r = await exec("test", ["-d", folder]).catch(() => null);
      const missing = r ? r.code !== 0 : false;
      if (missing !== this.missingFolders.has(folder)) {
        if (missing) this.missingFolders.add(folder); else this.missingFolders.delete(folder);
        changed = true;
      }
    }
    if (changed) cx.notify();
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    else if (!this.loaded && !this.refreshing) {
      this.loaded = true;
      cx.notify();
    }
    // The row order git implies is committed here, in the task phase, not from `render`.
    this.settleRows(cx);
    // Agent state is read straight from the host model (`space.status`, `agent.status`), so a
    // running agent changes it without touching git and without a new space. Nothing notified
    // in that case, and the indicators sat on whatever the last render caught — the bug that
    // made a working agent look idle. Repaint when any space or agent status differs from the
    // last look: cheap, and only on a real change.
    // `agents()` reports `address`, not `id` (an agent has address/pane/space/tab/status);
    // keying on `a.id` made every entry `undefined:idle`, so a real change never differed.
    const now2 = { spaces: sp.map((s) => `${s.id}:${s.status}`).join(","), agents: agents().map((a) => `${a.address}:${a.status}`).join(",") };
    const changed = now2.spaces !== this.statusSeen?.spaces || now2.agents !== this.statusSeen?.agents;
    this.statusSeen = now2;
    // A git pass writes `this.git` one place at a time; painting mid-pass shows a half-filled
    // list, which is the sidebar's visible jitter. The pass notifies once when it commits, so
    // the status change can wait for it.
    if (changed && !this.refreshing) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => readPair(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (readPair(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(readPair(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their branch).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    // A stored entry can name no machine (older shape, hand edit): nothing to reconnect to.
    if (!machine) return;
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // Runs git checks concurrently across hosts, matching startup-worktree-refresh.ts:51-68
  // Promise.allSettled. A serial queue caused rows to stall behind earlier repositories.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const batch = [...this.pending];
        this.pending.clear();
        await Promise.all(batch.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => readPair(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      this.loaded = true;
      // The refresh is the only writer, so one write per completed pass is enough.
      localStorage.setItem("git.cache.v2", JSON.stringify(this.git));
      cx.notify();
    });
  }

  // One place's git: branch, its repo, and the review on that branch.
  async check(key, cx) {
    const [on, cwd] = readPair(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const topDir = top.stdout.trim();
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      // Orca's RepoIconGlyph shows the fork's PARENT avatar, not the fork's own
      // (`repo-slug-upstream.ts` getRepoUpstream, then `githubAvatarSlug` keeps origin only for
      // a renamed fork). Both reads are local/no-op-safe: `git remote get-url` reads no lock,
      // and `gh` is skipped entirely when the repo has no upstream and isn't a fork.
      let owner = null;
      // `resolveGitHubApiRepositoryCandidates` asks `--repo <upstream>` with `headRepo: origin`
      // (github-api-repository.ts:127-133), then `pullRequestMatchesHeadRepository` drops a PR
      // whose head owner is not origin's (pull-request-lookup-data.ts:187-193). Both owners are
      // needed to ask the question and to reject a fork's same-named branch.
      let baseRepo = null; // the repo PRs are filed in: upstream when there is one
      let head = null; // origin's owner: who the branch must belong to
      try {
        const origin = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
        const o = origin.code === 0 ? parseRemote(origin.stdout) : null;
        if (o) {
          head = o.owner;
          const up = await exec("git", ["remote", "get-url", "upstream"], { cwd, on }).catch(() => null);
          const u = up?.code === 0 ? parseRemote(up.stdout) : null;
          baseRepo = `${(u ?? o).owner}/${(u ?? o).repo}`;
          let slug = u && !(u.owner === o.owner && u.repo === o.repo) ? u : null;
          // No `upstream` remote: ask GitHub whether origin is a fork. `exec` has its own 30s
          // cap (`gpui-kit.d.ts:22202`), so there is no per-call timeout to pass; off-machine
          // reads are skipped because `gh` there may not be authenticated.
          if (!slug && !on) {
            const q = await exec("gh", ["repo", "view", `${o.owner}/${o.repo}`, "--json", "isFork,parent"], { cwd }).catch(() => null);
            if (q?.code === 0) {
              const d = JSON.parse(q.stdout);
              const po = d?.parent?.owner?.login;
              const pr = d?.parent?.name;
              if (d?.isFork && po && pr) slug = { host: o.host, owner: po, repo: pr };
              // A fork with no `upstream` remote still files its PRs on the parent.
              if (slug) baseRepo = `${po}/${pr}`;
            }
          }
          // A renamed fork keeps its own identity; a same-name fork shows the parent's.
          owner = avatarUrlFor(slug && slug.repo !== o.repo ? o : (slug ?? o));
        }
      } catch {}
      const info = { name, top: topDir, branch: null, owner, base: baseRepo, head, repo: JSON.stringify([on, repo]), linked: repo !== `${topDir}/.git` };
      // Only the branch name is read. `# branch.ab` (ahead/behind) fed the removed gitTail,
      // and Orca's card has no such element; the flag still prints the header we parse.
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
      }
      this.git[key] = info;
      // The review is NOT part of the worktree row. Orca's `buildWorkspaceReviewFacts` looks
      // each worktree's own branch up in a persisted PR cache; the row never carries a PR to
      // be inherited by other worktrees. Ask for this exact branch, and only on this machine.
      if (!on && info.branch) this.lookupPRByBranch(`${repo}::${info.branch}`, info.base, info.head, info.branch, cwd, cx);
      // Orca's rows are the repo's worktrees (`listRepoWorktrees`), not its open sessions. A
      // repo is one group whether the open space is the main checkout or a linked worktree —
      // `git worktree list` answers for both — so read it every time. Without this, a repo
      // opened only on linked worktrees could never show its main checkout or its siblings.
      const wt = await exec("git", ["worktree", "list", "--porcelain"], { cwd, on });
      info.worktrees = wt.code === 0 ? parseWorktreeList(wt.stdout) : [];
      if (!on) this.watch(repo, cx);
    } catch (err) {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // `readWorkspaceReviewPR` + `getGitHubPRCacheKeyCandidates`, in Herdr's terms: one key per
  // repo+branch, read at render, refreshed out of band. A cache entry of `null` means asked
  // and there is no PR — Orca's `{ data: null }` — so a miss and a known-empty differ.
  reviewOf(info) {
    if (!info?.branch || !info.repo) return null;
    const entry = this.prCache[`${readPair(info.repo)[1]}::${info.branch}`];
    // `entry` is whatever storage holds (a hand edit, an older shape): read, never trust it.
    return entry?.data ?? null;
  }

  // The writer half of Orca's pipeline, named for what it does. `lookupPRByBranchName`
  // (pr-branch-lookup.ts) is Orca's refresh path; this is its `getRestPRForBranch` branch —
  // REST first, because REST honors `head=<owner>:<branch>` and `gh pr list --head
  // owner:branch` silently returns nothing.
  lookupPRByBranch(key, base, head, branch, cwd, cx) {
    // A settled answer is good for the life of the process: PR state changes on a merge or a
    // close, and the repo watch above already re-asks git on every change under .git.
    // shortcut: no periodic PR refresh, revisit if the badge looks stale after a merge.
    if (this.prAsking.has(key) || this.prCache[key] !== undefined) return;
    // No remote or no branch, no question: `head` is who the branch must belong to.
    if (!base || !head || !branch) { this.setPr(key, null); return; }
    this.prAsking.add(key);
    cx.spawn(async (cx) => {
      try {
        // Orca's exact query (`getRestPRForBranch`, pr-branch-lookup.ts:41-46): the base repo,
        // a head filter qualified with the owner, `state=all`, and a page of ten.
        const [owner, repo] = base.split("/");
        const q = `repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${head}:${branch}`)}`
          + `&state=all&per_page=${BRANCH_PR_LOOKUP_PAGE_SIZE}`;
        const r = await exec("gh", ["api", q], { cwd });
        const list = r.code === 0 ? JSON.parse(r.stdout || "[]") : [];
        // `pullRequestMatchesHeadRepository` (:187-193): the head owner must be this repo's
        // origin, so a same-named branch on someone else's fork cannot answer.
        const mine = list.filter(p => String(p.head?.repo?.owner?.login ?? "").toLowerCase() === String(head).toLowerCase());
        // `preferOpenPullRequest` (:32-34): newest first, so prefer the live one.
        const first = mine.find(p => String(p.state ?? "").toLowerCase() === "open") ?? mine[0];
        // `mapRestPullRequest` (:132) is the one mapping that matters here: REST reports a
        // merged PR as `state: "closed"` with a `merged_at` stamp, so `state` alone would paint
        // every merged PR as closed and never reach `getStateTone`'s purple. Orca derives it.
        // `readWorkspaceReviewFact` passes the cache's `state` through, while `ReviewIcon`
        // switches on `merged`/`closed`/`draft` (review-state-presentation.ts:28-37) — so a
        // draft has to be named too; REST reports it as `draft`.
        this.setPr(key, first?.number
          ? {
            number: first.number,
            state: first.merged_at ? "merged" : first.draft ? "draft" : String(first.state ?? "").toLowerCase(),
          }
          : null);
      } catch {
        this.setPr(key, null);
      } finally {
        this.prAsking.delete(key);
        cx.notify();
      }
    });
  }

  setPr(key, data) {
    this.prCache[key] = { data, at: Date.now() };
    this.prChecked[key] = Date.now();
    localStorage.setItem("pr.cache.v2", JSON.stringify(this.prCache));
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    const s = spaces().find((x) => x.id === w.id);
    const path = s ? place(s, panes()) : null;
    // WorktreeContextMenuView.tsx:147 — `min-w-52` (208).
    openOverlay({ mod: "orca-menu", kind: "popup", width: 208, height: 300, props: { tab: "space", target: { id: w.id, path } } });
  }

  // Orca's rows are worktrees, keyed by host+path (host-qualified-identity.ts), not by open
  // session: two tabs on one checkout are one card. Merge Herdr spaces on the same worktree
  // before emitting, so the card and its agents span them.
  // Rows are a pure derivation of host state, like Orca's `planSidebarRows` under `useMemo`
  // (`use-section-rows.ts:15,147`). Domain projection is delegated to `projectWorktreePlan`
  // (`worktree-plan.js`). Nothing here may mutate this view or dispatch a command:
  // it runs inside `render`, and a reorder fired from render both loses commands and re-enters
  // the frame. Reordering is the drag handler's job (`use-document-drop.ts:72` fires
  // `onReorderWorktrees`); nothing here moves a space.
  discoverable(w, ps) {
    return this.loaded || where(w, ps) in this.git;
  }

  ordered() {
    const plan = projectWorktreePlan({
      spaces: spaces(),
      panes: panes(),
      gitState: this.git,
      foldedRepos: this.foldedRepos,
      loaded: this.loaded,
      whereFn: where,
    });
    this.rowIndex = plan.rowIndex;
    return plan.visibleRows;
  }

  // Everything that must happen in the task phase, once per tick: ask for the reviews of rows
  // that have no open space, then reconcile the host's order with the plan.
  //
  // Orca has no equivalent of the second half, and neither should we: its row order is a pure
  // partition of the plan's items (`orderMainWorktreeFirst` = `[...main, ...rest]`,
  // `section-order.ts:4-16`), recomputed every render. Only a drag commits an order
  // (`use-document-drop.ts:72`).
  //
  // We used to dispatch one `space.move` per out-of-place row from here. Every dispatcher echo
  // re-entered the frame, each move renumbered the rows still to be moved, and the list visibly
  // built itself outward from the middle. Sorting in the plan removes the cascade entirely.
  settleRows(cx) {
    const out = this.ordered();
    // Rows with no open space still need their review: nothing else probes those branches. Ask
    // here, in the task phase, keyed exactly like `reviewOf` looks it up. Local machine only —
    // `gh` on the far side of an ssh may not be authenticated. This used to live in the row
    // builder, which made a network lookup a side effect of rendering.
    for (const r of out) {
      if (!r.unopened || r.w.machine || !r.g?.branch) continue;
      if (this.reviewOf(r.g)) continue;
      this.lookupPRByBranch(`${readPair(r.g.repo)[1]}::${r.g.branch}`, r.g.base, r.g.head, r.g.branch, r.g.top, cx);
    }
  }

  // `worktree-card-agents-expansion-state.ts`: each card's disclosure is its own state,
  // remembered across remounts. Here it survives restarts, in localStorage.
  toggleAgents(id, cx) {
    this.expandedAgents.has(id) ? this.expandedAgents.delete(id) : this.expandedAgents.add(id);
    localStorage.setItem("agents.expanded", JSON.stringify([...this.expandedAgents]));
    cx.notify();
  }

  toggleRepo(repo, cx) {
    this.foldedRepos.has(repo) ? this.foldedRepos.delete(repo) : this.foldedRepos.add(repo);
    localStorage.setItem("repos.folded", JSON.stringify([...this.foldedRepos]));
    // `cx` is absent for a keyboard Enter from `stop` (`focus.js`), which has no render cx.
    cx?.notify();
  }

  // The rows, under a header per machine once one isn't this computer.
  // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state, as in the inbox.
  glow(id) {
    return (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
  }

  grouped(t, cx, rows = this.ordered()) {
    const ps = panes();
    // `SectionHeader.tsx:190-192`: a header draws its collapse chevron only when its group
    // has rows (`row.count > 0`). The count is every card of the group, folded or not.
    const counts = new Map();
    for (const r of rows) { const k = this.foldKey(r); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const draw = (r) => this.row({ ...r, count: counts.get(this.foldKey(r)) ?? 0 }, t, ps);
    const flat = (r) => draw(r);
    // `host-section-rows.ts:236-246`: a host header exists only for a host that has rows.
    // With one such host Orca draws no headers at all (`:135-136`); an empty registered host
    // stays in the host picker, never in the list. A machine being repaired keeps its header
    // even with no rows: its Connect button is Herdr's only recovery path in this mod.
    const repairing = new Set([...Object.keys(this.reconnecting), ...this.machines.filter(m => this.rebuilt(m)).map(m => m.name)]);
    const hasRows = (m) => rows.some((r) => (r.w.machine ?? null) === m);
    const machineNames = [null, ...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...repairing])]
      .filter((m) => hasRows(m) || repairing.has(m));
    if (machineNames.filter(hasRows).length <= 1 && !machineNames.some((m) => repairing.has(m))) {
      return rows.flatMap(flat);
    }
    return machineNames.flatMap((m, i) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      // Drawn as the agents list's group headers, each 8px below what's above it, the heading included: right under it,
      // its + and chevron crowded the heading's buttons, a column of icons unevenly spaced.
      // Its + and chevron stand under the heading's two buttons, in slots built as those are (26px, 2px apart, 10px from the edge), so any zoom rounds them alike.
      const head = h_flex().id(`machine-${m ?? "local"}`).pt(8).h(30).flex_none().pl(8).pr(2).gap(4).items_center()
        // `ProjectHeaderHostLabel.tsx:25`: `text-muted-foreground` (full #acacac, not `t.dim`).
        .text_size(12).font_medium().text_color(t.muted)
        .role("button").accessibility_label(`${folded ? "Expand" : "Collapse"} ${m ?? "This computer"}`)
        .on_hover((on, cx) => {
          // By the row's id: this computer's m is null, which a cleared field would equal.
          if (on) this.overMachine = `machine-${m ?? "local"}`;
          else if (this.overMachine === `machine-${m ?? "local"}`) this.overMachine = null;
          cx.notify();
        })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        // -1: the glyph's own inset, so its edge meets the heading and the spaces' marks.
        .child(svg(`mods/orca-spaces/${m ? "server" : "monitor"}.svg`).size(14).ml(-1).flex_none())
        // The dot describes the machine, so it follows its name, however short.
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().child(m ?? "This computer"))
          .child(tipMark(this, t, `machine-state-${m ?? "local"}`, connected ? "Connected" : (machine?.state ?? "asleep").replace(/_/g, " ").replace(/^./, c => c.toUpperCase()), div().size(6).rounded_full().flex_none().bg(connected ? t.ansi2 : t.dim))))
        // `HostSectionHeader.tsx:11-35,119`: the count badge is always drawn beside the label
        // (its `count` is the host's workspace rows, folded groups included).
        .child(div().flex_none().h(16).px(6).flex().items_center().justify_center().rounded_full().border_1().border_color(t.border).bg(t.hover).text_size(9).line_height("9px").text_color(t.muted).child(String(mine.length)))
        .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
          .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
          .child(tip(this.hot, t, `machine-connect-${m}`, `Connect ${m}`, stop(this, t, `machine-connect-${m}`, div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
            .hover(s => s.text_color(t.foreground)).on_hover(this.glow(`machine-connect-${m}`))
            .role("button").accessibility_label(`Connect ${m}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
            .child(repair?.busy ? "Connecting…" : "Connect"), 4)))))
        .child(h_flex().flex_none().gap(2).items_center()
          .when(connected, el => el.child(tip(this.hot, t, `machine-add-${m ?? "local"}`, "New space here", stop(this, t, `machine-add-${m ?? "local"}`, div().id(`machine-add-${m ?? "local"}`).w(26).h(20).flex_none().flex().items_center().justify_center().rounded(4)
            .text_color(this.hot === `machine-add-${m ?? "local"}` ? t.foreground : t.dim).on_hover(this.glow(`machine-add-${m ?? "local"}`))
            .role("button").accessibility_label("New space here")
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child(svg("mods/orca-spaces/plus.svg").size(12)), 4),
            // The key makes a space on the current space's machine: it names this + only on that one.
            { action: (spaces().find(s => s.active)?.machine ?? null) === m ? "space.new" : null })))
          // An indicator, not a button: the whole row folds, so it lights with the row and has no label of its own.
          // `HostSectionHeader.tsx:121-125`: the chevron is `can-hover:opacity-0` until the
          // header is hovered (`group-hover/host-header:opacity-100`), keeping its slot; and
          // `SectionHeader.tsx:190-192` draws a collapse affordance only when there is something
          // to collapse (`row.count > 0`).
          .when(mine.length > 0, el => el.child(div().id(`machine-fold-${m ?? "local"}`).w(26).flex_none().flex().items_center().justify_center()
            .opacity(this.overMachine === `machine-${m ?? "local"}` ? 1 : 0)
            .child(svg(`mods/orca-spaces/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none()))))
      // `host-section-rows.ts:236-246`: a host header exists only for a host with rows, and a
      // host with no rows draws no section — and no placeholder beneath it.
      const heading = stop(this, t, `machine-${m ?? "local"}`, head, 8);
      if (rebuilt) return [heading];
      return [heading, ...(folded ? [] : mine.flatMap(flat))];
    });
  }

  // `ReviewIcon` (worktree-review-presentation.tsx:74-94): the glyph is state-specific —
  // merged GitMerge, closed GitPullRequestClosed, draft GitPullRequestDraft, else the plain
  // PullRequestIcon — and the tone is `getStateTone` (:54-70): merged purple-400/70, open
  // emerald-500/80, closed muted-foreground/60, draft muted-foreground/50. `size-3` is the
  // MetaIconBadge glyph size.
  prBadge(pr, t, id) {
    const icon = pr.state === "merged" ? "git-merge" : pr.state === "closed" ? "git-pull-request-closed" : pr.state === "draft" ? "git-pull-request-draft" : "git-pull-request";
    // `getStateTone` (worktree-review-presentation.tsx:58-72), dark-mode values:
    //   merged  text-purple-400/70           -> #c084fcb3
    //   open    text-emerald-500/80          -> #10b981cc
    //   closed  text-muted-foreground/60     -> #acacac99
    //   draft   text-muted-foreground/50     -> #acacac80
    //   (none)  text-muted-foreground opacity-70 -> #acacacb3
    // `text-muted-foreground` is `--orca-security-muted-foreground` = #acacac in dark
    // (main.css:328 -> :519), so every muted tone below is that hex at an alpha.
    const tone = pr.state === "merged" ? "#c084fcb3" : pr.state === "open" ? "#10b981cc" : pr.state === "draft" ? "#acacac80" : pr.state === "closed" ? "#acacac99" : "#acacacb3";
    // `MetaIconBadge` (WorktreeCardMetadataControls.tsx:33) is `inline-flex size-3.5
    // shrink-0 items-center justify-center text-muted-foreground/70 [&>svg]:size-3.5` — a 14px
    // box whose glyph is also 14px, 12 was too small. `text-muted-foreground/70` is its default
    // colour; `getStateTone` overrides it per state.
    return div().flex_none().flex().items_center().justify_center().pr(6)
      .child(tip(this.hot, t, `pr-${id}`, `PR #${pr.number}`, stop(this, t, `pr-${id}`, div().id(`pr-${id}`)
        .child(svg(`mods/orca-spaces/${icon}.svg`).size(14).flex_none().text_color(tone)))));
  }

  // `gitTail` used to draw `↑N`/`↓N` at the end of the title row. That was ours, not
  // Orca's: `default-workspace-card.json` has no ahead/behind var (its 32 vars are
  // classic/compact/folder/branch/conflict/details/ports/indicators and friends), and a
  // search for `ahead` across `components/sidebar/` returns only unrelated prose. Orca's
  // only right-side element on a classic card is the review badge in the meta row.

  // Orca's project header (SectionHeader.tsx): h-7, gap-1.5, pr-2, a 16px icon slot, a 13px
  // semibold label, and a 20px collapse button. The header owns the fold; its cards hide under it.
  // A folder workspace folds by its own id: there is no repo to key it on. Shared with
  // collapse-all so the button and the header can never disagree about a row's key.
  foldKey({ w, g }) {
    return foldKey({ w, g });
  }

  // Every project key currently rendered, for `setAllProjectsCollapsed`. Orca collects them
  // from the row plan (`getRenderedProjectCollapseKeys`, project-collapse-all.ts:5); the
  // equivalent here is the group header each rendered row emits.
  projectKeys(cx) {
    const keys = new Set();
    for (const r of this.ordered()) if (!r.unopened) keys.add(this.foldKey(r));
    return [...keys];
  }

  header({ w, g, count }, t, ps) {
    const key = this.foldKey({ w, g });
    const folded = this.foldedRepos.has(key);
    const id = `space-head-${w.id}`;
    return stop(this, t, id, h_flex()
      .id(id)
      .h(28).flex_none().w_full().pl(getProjectGroupHeaderPaddingLeft(0)).pr(8).gap(6).items_center().mt(4)
      .role("button").accessibility_label(g?.name ?? w.name)
      .on_mouse_down("right", () => this.menu(w))
      .on_click((_e, cx) => this.toggleRepo(key, cx))
      .on_hover((on, cx) => {
        if (on) this.hoveredRepo = key;
        else if (this.hoveredRepo === key) this.hoveredRepo = null;
        cx.notify();
      })
      // Orca's RepoIconGlyph: the repo's own image when it has one, else a lucide Folder
      // (repo-icon.tsx:145). Herdr has no per-repo icon, so the origin remote's GitHub owner
      // avatar is the image source; the first render kicks off a one-time fetch and writes it
      // under the app folder, and `image()` reads that cached file from then on.
      .child(repoMark(w, 16, t, ps, g?.owner ?? null))
      .child(div().min_w(0).flex_1().truncate().text_size(13).font_semibold().line_height("16px").text_color(t.foreground).child(g?.name ?? w.name))
      // Orca's hover cluster (`worktree-list/rows/ProjectHeaderActions.tsx:5-15`, used at
      // `rows/SectionHeader.tsx:355-399`): an ABSOLUTE overlay — `can-hover:absolute right-1
      // top-1/2 -translate-y-1/2`, `bg-worktree-sidebar pl-1` — that only fades
      // (`can-hover:opacity-0`). It stays mounted for `has-[:focus-visible]` and
      // `has-[button[aria-expanded=true]]`, so here it is always mounted and faded by opacity:
      // the buttons join the Tab order (`stop` per control), the title is never re-truncated,
      // and the sidebar-coloured bg masks the title behind it. The row is 28px and the slots
      // 20px, so top-4 is `top-1/2 -translate-y-1/2` for this row.
      .child(h_flex().absolute().right(4).top(4).flex_none().items_center().gap(2).rounded(6).bg(t.chrome).pl(4)
        .opacity(this.hoveredRepo === key || this.menuKey === key ||
          within(this, [id, `space-fold-${w.id}`, `space-more-${w.id}`, `space-new-${w.id}`]) ? 1 : 0)
        // ORDER, from SectionHeader.tsx:355-414 — the collapse chevron comes FIRST in
        // `ProjectHeaderActions`, then `RepoHeaderProjectActionsMenu` (the ellipsis, size-3.5,
        // repo-header-project-actions.tsx:113), then `RepoHeaderCreateWorkspaceButton`
        // (the plus, size-3, :250). Left to right: chevron, ellipsis, plus.
        // `SectionHeader.tsx:190-192`: the chevron is omitted entirely when the group has no
        // rows (`row.count > 0`); the menus/plus are not gated on it.
        // SectionHeader.tsx:358: size-5 rounded-md text-muted-foreground,
        // hover:bg-accent/70 and hover:text-foreground — a 70% accent wash, not a 70% white one.
        .when(count > 0, el => el.child(stop(this, t, `space-fold-${w.id}`,
          div().size(20).flex_none().flex().items_center().justify_center().rounded(6)
            .role("button").accessibility_label(folded ? "Expand group" : "Collapse group")
            .text_color(t.muted).hover((s) => s.bg("#404040b3").text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggleRepo(key, cx); })
            .child(svg(`mods/orca-spaces/chevron-${folded ? "right" : "down"}.svg`).size(14).flex_none()),
          6, { enter: () => this.toggleRepo(key, null) })))
        .child(stop(this, t, `space-more-${w.id}`,
          div().size(20).flex_none().flex().items_center().justify_center().rounded(6)
            .role("button").accessibility_label("Group menu")
            .text_color(t.muted).hover((s) => s.bg("#404040b3").text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.menuKey = key;
              // RepoHeaderProjectActionsMenu's DropdownMenuContent has no width class, so Orca's
              // dropdown-menu.tsx:80 `min-w-[11rem]` (176) applies.
              openOverlay({ mod: "orca-menu", kind: "popup", width: 176, height: 220, props: { tab: "group", target: { id: w.id, path: g?.top ?? w.folder } } });
              cx.notify();
            })
            .child(svg("mods/orca-spaces/ellipsis.svg").size(14).flex_none()),
          6, { enter: () => { this.menuKey = key; openOverlay({ mod: "orca-menu", kind: "popup", width: 176, height: 220, props: { tab: "group", target: { id: w.id, path: g?.top ?? w.folder } } }); } }))
        .child(stop(this, t, `space-new-${w.id}`,
          div().size(20).flex_none().flex().items_center().justify_center().rounded(6)
            .role("button").accessibility_label("New space")
            .text_color(t.muted).hover((s) => s.bg("#404040b3").text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { folder: g?.top ?? w.folder }); })
            .child(svg("mods/orca-spaces/plus.svg").size(12).flex_none()),
          6, { enter: () => run("space.new", { folder: g?.top ?? w.folder }) }))), 6,
      { enter: () => this.toggleRepo(key) });
  }

  // Orca's worktree card (worktree-card-surface.tsx): ml-1, py-2 (36px single line), rounded-lg,
  // a status lane, a 13px/20px title, the primary pill on the main checkout.
  card({ w, g, also, unopened, pos }, t, ps) {
    // A merged card lights with any of its spaces and rolls all of their tabs up, as one
    // worktree with two open sessions is still one worktree.
    const group = [w, ...(also ?? []).map(a => a.w)];
    const on = group.some(s => s.active);
    // Orca titles a card by its worktree's branch when the header above already says the
    // repo/folder (`herdr-file-viewer` -> `main`), else the space's own name
    // (`default-workspace-card.json`: `title: trim(ws.title)`).
    const branch = g?.branch ?? w.branch ?? null;
    // Orca's worktree title is the branch for an unnamed worktree; a name the user gave wins.
    const title = !w.named && branch ? branch : w.name;
    // `default-workspace-card.json`: folder cards print the folder's own last segment
    // (`folderInMeta`, `WorktreeCardFolderPath` = `getDirectoryName`), branch cards the branch.
    const meta = g ? branch : base(place(w, ps));
    // Orca's classic card draws the branch unconditionally (`default-workspace-card.json`
    // `branch: "!vars.folder && len(ws.branch) > 0 && !vars.newStyle && ..."`), and an automatic
    // worktree name IS the branch (`shared/worktree/display-name-provenance.ts:17-19`), so Orca
    // really does print `main` twice on such a card.
    //
    // We briefly suppressed that repeat on a user report. It was the wrong fix: `singleLine` is
    // derived from this value (`:912`), so nulling it collapsed EVERY card to a title-only one
    // and the list lost Orca's two-line shape entirely. The duplicate is Orca's, and a card that
    // matches Orca beats a card that is one line short. Reverting rather than special-casing:
    // if the repeat is to go, it goes back as a recorded deviation that keeps the meta row's
    // height, not by pretending the row is title-only.
    const metaText = meta;
    const metaMono = !g;
    // Orca's card lists its own agents (inlineAgents) as `AgentStateDot` rows, from agents():
    // the same rows the agents view reads, so a collapsed card shows real rows, never invented.
    const tabIds = new Set(group.flatMap(s => (s.tabs ?? []).map(c => c.id)));
    const mine = agents().filter(a => tabIds.has(a.tab));
    // The host already rolled each space's agents up (model.rs `rollup`); the worktree's rollup
    // is the most urgent of its sessions (STATUS order: blocked > done > working > idle).
    const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
    const dot = group.map(s => s.status).reduce((b, s) => ((rank[s] ?? -1) > (rank[b] ?? -1) ? s : b), null);
    // `primary` marks the worktree git itself lists first — its own checkout, not a linked
    // one (`worktree-card-header.tsx:115`: `!compactCards && worktree.isMainWorktree && !isFolder`).
    // Orca's parser sets `isMainWorktree: worktrees.length === 0`; ours marks `linked` when the
    // top differs from the common dir's owner, so the check is simply `!linked`.
    const isPrimary = Boolean(g && !g.linked);
    const expanded = this.expandedAgents.has(w.id);
    const toggleId = `space-agents-${w.id}`;
    // An agent row shows the agent, not the folder it shares with the space.
    const agentTitle = (a) => {
      // `program.agent` is a boolean ("is an agent"), never a name; the user-facing name is
      // `program.name` ("Claude Code", "Neovim"). An empty title/app used to draw `true`.
      const label = a.title || a.app || a.program?.name || "agent";
      return label === w.name || label === `π: ${w.name}` ? (a.app || a.program?.name || "agent") : label;
    };
    // worktree-card-compact-agent-row.tsx:301-305 — `flex h-6 items-center gap-1` = 24px,
    // `px-1` = 4px, `text-[11px] text-muted-foreground`, and `worktree-agent-row-hover` washes
    // the row with `--accent` at 18% in dark (assets/main.css:1568-1584,1787-1795).
    // Herdr's `AgentInfo` has no parent/lineage, child count, timestamp or turn text, so Orca's
    // `+N` child disclosure, `text-[10px]` timestamp, `" - "` secondary line and `.75rem`
    // lineage indent (`worktree-card-compact-agent-row.tsx:226-297`) have no data here.
    // The agent-type icon is the program table's `program.icon` (`AgentTypeIcon size={13}`).
    const agentIcon = (a, size) => {
      const p = a.program;
      if (!p?.icon) return null;
      return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.muted) : image(p.icon).w(size).h(size).flex_none();
    };
    const agentRow = (a) => {
      const type = agentIcon(a, 13);
      return h_flex().min_w(0).h(24).px(4).gap(4).items_center()
        .text_size(11).line_height("11px").text_color(t.muted)
        .hover((s) => s.bg("#4040402e"))
        // AgentStateDot size="sm": 10px box, 6px inner, `done` = CircleCheck
        // (`src/renderer/src/components/AgentStateDot.tsx:114-116,148-157`) — not the card lane's StatusIndicator.
        .child(agentStateMark(a.status))
        .when(Boolean(type), (el) => el.child(type))
        .child(div().min_w(0).flex_1().truncate().child(agentTitle(a)));
    };
    // `CompactAgentSummaryButton` (worktree-card-compact-agents.tsx:75-186): the collapsed pill
    // draws per-state clusters — `AgentStateDot` + up to 3 overlapping `size-4` agent-type
    // avatars + `+N` (`:158-176`) — and the text label is the EXPANDED header only (`:153-157`).
    // Groups follow `buildSummaryAgentGroups` (`worktree-card-agent-summary.ts:201-216`) and
    // SUMMARY_STATE_ORDER (`:12-26`), restricted to Herdr's four words; the last 3 groups show
    // and the rest count (`worktree-card-compact-agents.tsx:78-84`).
    const summaryOrder = ["blocked", "working", "done", "idle"];
    const groups = summaryOrder
      .map((state) => ({ state, agents: mine.filter((a) => a.status === state) }))
      .filter((group) => group.agents.length > 0);
    const visibleGroups = groups.slice(0, 3);
    const hiddenGroupCount = groups.slice(3).reduce((n, g) => n + g.agents.length, 0);
    const cluster = (group) => {
      // Herdr has no agent-type; the program table's icon fills Orca's `size-4` identity
      // circle, and is dropped when the table has none — the dot and `+N` still draw.
      const icons = group.agents.map((a) => agentIcon(a, 13)).filter(Boolean).slice(0, 3);
      const hidden = group.agents.length - icons.length;
      return h_flex().flex_none().items_center().gap(2).rounded(2).px(4).py(2).bg("#2a2a2ab3")
        .child(agentStateMark(group.state))
        .child(h_flex().flex_none().items_center().pl(2)
          .children(icons.map((type, i) => div().size(16).flex_none().flex().items_center().justify_center().rounded_full()
            .border_1().border_color("#ffffff0d").bg(t.chrome).when(i > 0, (el) => el.ml(-2)).child(type))))
        // `text-[10px] tabular-nums text-muted-foreground/70`; t.dim is exactly #acacacb3.
        .when(hidden > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${hidden}`)));
    };
    // `WorktreeCardAgents.tsx:371-416`: the summary exists only for MORE THAN ONE agent
    // (`shouldUseSummaryRow = summaryAgents.length > 1`); a single agent is just its row. The
    // list starts collapsed (`worktree-card-agents-expansion-state.ts:12-16`).
    const agentList = v_flex().min_w(0).mt(4).gap(2).children(mine.map(agentRow));
    const agentSummary = v_flex().min_w(0).mt(4).gap(2)
      .child(h_flex().id(toggleId).h(24).w_full().min_w(0).px(4).gap(4).items_center().rounded(2)
        .text_size(11).line_height("11px").text_color(t.muted).cursor_pointer()
        .role("button")
        .accessibility_label(expanded ? `Collapse ${mine.length} agents` : `Expand ${mine.length} agents`)
        // Only the collapsed pill rests on a surface: `border-worktree-sidebar-border/70` =
        // #ffffff 7% x 70%, `bg-worktree-sidebar-accent/35` = #353535 at 35%
        // (`worktree-card-compact-agents.tsx:104-113`). Hover is a `foreground/[0.035]` wash
        // (`#f0f0f009`), text unchanged.
        .when(!expanded, el => el.border_1().border_color("#ffffff0d").bg("#35353559"))
        .hover((s) => s.bg("#f0f0f009"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleAgents(w.id, cx); })
        .when(expanded, el => el.child(div().min_w(0).flex_1().truncate().px(4).font_medium().child(`${mine.length} agents`)))
        .when(!expanded, el => el.child(h_flex().min_w(0).flex_1().items_center().gap(4).overflow_hidden()
          .children(visibleGroups.map(cluster))
          .when(hiddenGroupCount > 0, (s) => s.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${hiddenGroupCount}`)))))
        .child(svg(`mods/orca-spaces/chevron-${expanded ? "down" : "right"}.svg`).size(12).flex_none()))
      .when(expanded, el => el.child(v_flex().min_w(0).gap(2).pt(2).children(mine.map(agentRow))));
    const agentBlock = mine.length > 1 ? agentSummary : agentList;
    // Orca's frame geometry: every row here is lineage depth 0 (no tree indent, no wrapper).
    // `default-workspace-card.json:38`: statusLane = vars.newStyle && options.show.status.
    // `experimentalNewWorktreeCardStyle` is false, so the lane is the LEGACY one and the
    // 8px new-style pullback must not apply (it pulled titles 8px too far left).
    // A folder workspace is a folder-group child (`folder-row.tsx:89`), so it uses the folder
    // path at groupDepth 1 — otherwise `isGrouped: false` gave it indent 0 and its title sat
    // 7px left of the repo cards'. Both paths land on the same 13px anchor.
    const folder = !g;
    const contentIndent = folder
      ? getFolderWorkspaceCardContentIndent({ groupDepth: 1 })
      : getWorktreeCardContentIndent({ isGrouped: Boolean(g), groupDepth: 0, lineageDepth: 0 });
    const surfaceInset = folder
      ? getFolderWorkspaceCardSurfaceInset({ isGrouped: true, groupDepth: 1 })
      : getWorktreeCardSurfaceInset({ isGrouped: Boolean(g), groupDepth: 0 });
    const geometry = { cardPaddingLeft: getFlushWorktreeCardPaddingLeft(Math.max(0, contentIndent - surfaceInset), false), surfaceInset };
    // Orca's classic cards are never `singleLine`: `default-workspace-card.json:29` sets
    // `inlineAgents` from `options.show.inlineAgents && !vars.compact`, and the migration adds
    // `inline-agents` to every user's card props (`normalize-loaded-ui-state.ts:106`), so
    // `singleLine` (`default-workspace-card.json:34`) is false even while the card has no agent.
    // `worktree-card-surface.tsx:67` then always draws `pt-1.25 pb-1.5` = 5/6px. Fixed here so
    // an agent starting/stopping cannot resize the row; `mine.length` must not feed the padding.
    return stop(this, t, `space-${w.id}`, v_flex()
      .relative()
      .id(`space-${w.id}`)
      .ml(WORKTREE_CARD_SURFACE_MARGIN + geometry.surfaceInset).pr(6)
      .pt(5).pb(6)
      .flex_none()
      .rounded(8)
      // `worktree-card-surface.tsx:71-76` draws `border border-transparent` on every card, so
      // the active border adds no geometry and the title does not shift 1px on selection.
      .border_1().border_color("#00000000")
      .role("button")
      .accessibility_label(w.name)
      // Orca active card: bg foreground/10 over sidebar, border foreground/18.
      .when(on, (el) => el.bg("#3e3e3e").border_color("#f0f0f02e"))
      // No background change on hover. Orca does have
      // `.worktree-sidebar-card-hover:hover { background: color-mix(in srgb, var(--sidebar-accent)
      // 40%, transparent) }` (main.css:1488), but washing the row repaints the whole project
      // area on every pointer move, which reads as the list flickering. The hover's only job
      // here is to reveal the row's affordances, so that is all it does.
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      // `WorktreeSidebarDropIndicator.tsx:17-25` — the indicator is not a bar: it is
      // `absolute left-3 right-2 z-30 flex h-3 -translate-y-1/2 items-center` holding
      //   <span size-1.5 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px sidebar] />
      //   <span h-0.5 flex-1 rounded-full bg-worktree-sidebar-ring shadow-... />
      //   <span size-1.5 rounded-full bg-worktree-sidebar-ring shadow-... />
      // so a 2px line with a 6px dot at each end, inset 12px left and 8px right, in the
      // sidebar's ring colour (#737373 in dark, main.css:391). We drew a full-width 2px bar in
      // the theme ACCENT, which was blue — that is the flash the user saw.
      // `drop-indicators.tsx:29-32` renders `WorktreeSidebarDropIndicator`, whose row
      // (`WorktreeSidebarDropIndicator.tsx:18`) is `absolute left-3 right-2 h-3` — the line is
      // drawn only while a card is being dragged and the pointer is over a slot. Its edge follows
      // the drag direction: below the hovered card when dragging down, above it when dragging up
      // (unknown origin -> above).
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => {
        const fromIndex = this.rowIndex?.get(this.pressed) ?? -1;
        return el.child(
          div().absolute().left(12).right(8).h(12).items_center()
            .when(fromIndex >= 0 && fromIndex < pos, line => line.bottom(-6))
            .when(fromIndex < 0 || fromIndex > pos, line => line.top(-6))
            .child(h_flex().w_full().items_center()
              .child(div().size(6).flex_none().rounded_full().bg("#737373"))
              .child(div().h(2).flex_1().rounded_full().bg("#737373"))
              .child(div().size(6).flex_none().rounded_full().bg("#737373"))),
        );
      })
      .on_mouse_down("left", () => {
        if (unopened) return;
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (e, cx) => {
        if (unopened) { run("space.new", { folder: g.top, machine: w.machine ?? undefined }); cx.notify(); return; }
        // Orca's card double-click opens the rename editor: `worktree-card-surface.tsx:98`
        // `onDoubleClick={...handleDoubleClick}` -> `use-worktree-card-activation-actions.ts`
        // `openModal('edit-meta', ...)` with `currentDisplayName`. Herdr's equivalent is
        // `space.rename`, and `MouseButtonEvent.click_count` is `2` on a double-click
        // (`gpui-kit.d.ts`, "How many presses in the current sequence") — the same field the
        // tab strip uses. Rename replaces select, as Orca's double-click replaces its click.
        if (e.click_count === 2) {
          this.pressed = null;
          this.over = null;
          run("space.rename", { id: w.id });
          cx.notify();
          return;
        }
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      // Card root (worktree-card-surface.tsx): ml-1, py-2 for a title-only card, rounded-lg, and a
      // padding-left that the geometry module derives from the group depth. The content row is
      // `flex gap-0.5 items-start`, so the status lane sits at the top and never drives the title.
      // `worktree-card-parent-content.tsx:56` is the row that actually holds the status lane and
      // the text column: `flex w-full min-w-0 gap-0.5`, so the lane-to-text gap is 2px, not the
      // 8px of the *header* row inside the text column (`worktree-card-header.tsx:65` gap-2,
      // which is lane-external). Alignment there is `items-start` unless the card is title-only;
      // the old `pt(2)` on the lane plus `items_start` is Orca's own optical nudge, and the
      // title's 20px line box is what puts the mark on the first line.
      .child(h_flex().w_full().min_w(0).items_start().gap(2).pl(geometry.cardPaddingLeft)
        // WorktreeCardStatusLane, legacy style (`worktree-card-status-lane.tsx:19-23`): the
        // `shrink-0 flex justify-center items-start pt-[2px]` div around the unread button;
        // `WorktreeCardStatusSlot.tsx:246-247` sizes that button `size-4` = 16px even when the
        // card is not the new style, so the LANE is 16px wide while StatusIndicator's own box
        // stays `h-3 w-3` (12px) holding an 8px dot.
        .child(div().flex_none().w(LEGACY_STATUS_LANE_WIDTH).flex().items_start().justify_center().pt(2)
          .child(statusMark(dot, 12)))
        // `worktree-card-parent-content.tsx:66` — `flex min-w-0 flex-1 flex-col gap-1.5`, so
        // title row to meta row to agent summary is 6px. Herdr's gap() is pixels; 6 is 6.
        .child(v_flex().flex_1().min_w(0).gap(6)
          // Title row: title, then Orca's primary pill (h-16, px-1.5, 10px). `ws.isMain` only
          // marks a repo's own checkout: a plain folder workspace is no one's primary branch,
          // and a linked worktree is secondary to its checkout.
          .child(h_flex().w_full().min_w(0).gap(6).items_center()
            .child(div().min_w(0).max_w(150).truncate().text_size(13).line_height("20px").text_color(t.foreground).child(title))
            .when(isPrimary, el => el.child(div().flex_none().h(16).px(6).rounded(4).border_1().border_color("#f0f0f033").bg("#f0f0f00f")
              .text_size(10).font_medium().line_height("14px").text_color("#f0f0f0b3").child("primary")))
            // No trailing element: Orca's title row ends at the title (and the primary pill);
            // its right-hand cluster lives in the meta row below.
            .child(div().flex_1()))
          // Meta row: the branch, or the folder's own last segment — 11px muted, mono for paths
          // (`WorktreeCardFolderPath`: `font-mono text-[11px] leading-none`). The review badge
          // sits at the row's end, which is Orca's `ml-auto ... pr-1.5` cluster
          // (WorktreeCardMetaBadges.tsx:86) and the only thing it holds for a classic card.
          .when(Boolean(metaText), el => el.child(h_flex().w_full().min_w(0).items_center()
            .child(div().min_w(0).truncate().text_size(11).line_height("11px").text_color(t.muted).when(metaMono, m => m.font_family("JetBrains Mono")).child(metaText))
            .child(div().flex_1())
            .when(Boolean(this.reviewOf(g)), row => row.child(this.prBadge(this.reviewOf(g), t, w.id)))))
          // Orca's compact agent summary (worktree-card-compact-agents.tsx): h-6, px-1, 11px
          // muted; the collapsed pill draws state clusters and the rows carry AgentStateDot.
          .when(mine.length > 0, el => el.child(agentBlock))),
      ),
      // A worktree with no space opens one in its folder; anything else selects the space.
      8, { enter: () => unopened ? run("space.new", { folder: g.top, machine: w.machine ?? undefined }) : run("space.select", { id: w.id }) });
  }

  // A repo is a project group: a SectionHeader, then its worktree cards. A bare folder
  // workspace renders its folder row (folder glyph + name, `folder-row.tsx`) above its
  // session card — hence tmp three times: folder row, card title, card path meta.
  row(r, t, ps) {
    // Fold first: Orca collapses the whole repo group (SectionHeader owns the fold), and a
    // linked worktree is still a row of that group. Checking `linked` first left the group
    // header collapsed while its worktree cards kept drawing.
    if (r.g && this.foldedRepos.has(r.g.repo)) return r.head ? [this.header(r, t, ps)] : [];
    if (r.g?.linked) return [this.card(r, t, ps)];
    if (!r.g) {
      const key = `space:${r.w.id}`;
      if (this.foldedRepos.has(key)) return [this.header(r, t, ps)];
      return [this.header(r, t, ps), this.card(r, t, ps)];
    }
    // Only the repo's first space heads the group; its later spaces are further cards.
    if (!r.head) return [this.card(r, t, ps)];
    return [this.header(r, t, ps), this.card(r, t, ps)];
  }

  render(cx) {
    const t = theme();
    const sp = spaces();
    // `WorktreeList.tsx:285-287`: the empty state is the row plan's emptiness, not the raw
    // collection's — an unopened worktree or a group with no rows still counts as a row.
    const rows = this.ordered();
    // The shipped mods (the Terminals picker) still color spaces from "space.colors": the same color, from the name.
    const colors = Object.fromEntries(sp.filter(p => p.name !== "~").map(p => [p.id, tint(p.name, false)]));
    if (JSON.stringify(colors) !== JSON.stringify(shared("space.colors") ?? {})) setShared("space.colors", colors);
    // ProjectsCollapseAllButton's `allCollapsed` prop: Orca computes it from the same set the
    // header folds on (`useAppStore` allCollapsed), so publish the identical predicate here and
    // let orca-nav pick the glyph and the toggle direction. `setShared` does not notify
    // (AGENTS.md rule 9), which is fine: orca-nav re-reads it when orca-spaces re-renders.
    const keys = this.projectKeys(cx);
    const allCollapsed = keys.length > 0 && keys.every((k) => this.foldedRepos.has(k));
    if (allCollapsed !== Boolean(shared("projects.allCollapsed"))) setShared("projects.allCollapsed", allCollapsed);
    // `WorktreeList.tsx:290` mounts the collapse-all button only when
    // `projectsCollapseTarget && projectCollapseKeys.length > 0` — with no projects there is
    // nothing to collapse, so Orca renders no button at all. Publish the count so orca-nav can
    // make the same call; the header cannot see the row plan itself.
    if (keys.length !== shared("projects.count")) setShared("projects.count", keys.length);
    const asks = props()?.newMenu && machines().length > 1;
    // One fetch per repo per session; `ensureAvatar` writes the file and notifies once, so the
    // next render draws the avatar instead of the Folder.
    for (const g of Object.values(this.git)) if (g?.owner) ensureAvatar(g.owner, cx);
    // Fold saved-project rows: folders persisted in localStorage["projects.saved.v1"]
    // that no open space's folder covers. The folder glyph + basename row opens a space
    // in that folder; hover reveals a remove button (Orca's RepositoryRemoveProjectButton).
    // Missing folders are marked but never deleted silently.
    const saved = stored("projects.saved.v1", []);
    const savedRows = saved
      .filter(folder => !sp.some(s => s.folder && s.folder === folder || s.folder.startsWith(folder + "/")))
      .map(folder => {
        const basename = folder.split("/").pop() || folder;
        const missing = this.missingFolders.has(folder);
        // Orca project row geometry (SectionHeader.tsx:355-399; folder-row.tsx): 24px row,
        // folder glyph + 13px name, muted hover. This is the saved-project entry.
        return div()
          .id(`saved-${folder}`)
          .h(24)
          .w_full()
          .flex()
          .items_center()
          .gap(6)
          .px(8)
          .rounded(4)
          .text_color(missing ? t.dim : t.muted)
          .hover(s => s.bg(t.hover).text_color(missing ? t.dim : t.foreground))
          .cursor_pointer()
          .role("button")
          .accessibility_label(missing ? `Saved project ${basename} (folder missing)` : `Open saved project ${basename}`)
          
          .on_click((_e, cx) => {
            cx.spawn(async () => {
              run("space.new", { folder });
            });
          })
          .child(svg("mods/orca-spaces/folder.svg").size(14).flex_none())
          .child(div().flex_1().truncate().text_size(13).child(basename))
          .when(missing, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("missing")))
          .child(div()
            .id(`saved-remove-${folder}`)
            .size(20)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(4)
            .text_color(t.dim)
            .hover(s => s.bg("#404040b3").text_color(t.foreground))
            .cursor_pointer()
            .role("button")
            .accessibility_label(`Remove saved project ${basename}`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              const existing = stored("projects.saved.v1", []);
              const filtered = existing.filter(f => f !== folder);
              localStorage.setItem("projects.saved.v1", JSON.stringify(filtered));
              cx.notify();
            })
            .child(svg("mods/orca-spaces/trash.svg").size(10)));
      });

    const tool = (id, label, icon, fn, more) => tip(this.hot, t, id, label, stop(this, t, id, div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(this.hot === id ? t.foreground : t.dim).on_hover(this.glow(id)).role("button").accessibility_label(label).hover(s => s.bg(t.hover))
      .on_click(fn).child(svg(`mods/orca-spaces/${icon}.svg`).size(14))), more);
    return focusRoot(this, v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // Orca's sidebar bar is an 8px webkit scrollbar with `padding-right: 4px`
      // (`main.css:767-781`), transparent until the sidebar is hovered (`:781-800`). A webkit
      // bar takes layout width, so no row sits under it. Herdr's placed bar fills the box it is
      // put in (`gpui-kit.d.ts:21188-21218`) and the shipped `changes` mod paints one over the
      // scroll area (`defaults/mods/changes/main.js:196`); the same shape here, with the 12px
      // inset on the content, keeps rows clear of the thumb.
      .child(div().w_full().flex_1().min_h(0).relative()
        .child(v_flex().id("space-list").absolute().inset_0().overflow_y_scroll()
          .on_mouse_up("left", (_e, cx) => { this.pressed = this.over = null; cx.notify(); })
          // Herdr reports no release outside the sidebar, so leaving ends a drag, as in the inbox.
          .on_hover((on, cx) => {
            if (this.listHover !== on) { this.listHover = on; cx.notify(); }
            if (on || this.pressed === null) return;
            this.pressed = this.over = null;
            cx.notify();
          })
          .child(v_flex().id("space-content").w_full().flex_none().pr(12).pb(8)
            // StartupWorktreeRefreshStatus.tsx:22-29 status row with mx-3 mb-2 gap-2 text-xs text-muted-foreground.
            // StartupWorktreeRefreshStatus.tsx:14-16 delays 200ms before showing; omitted because Herdr has no frame timer.
            .when(!this.loaded, el => el.child(h_flex().flex_none().mx(12).mb(8).gap(8).items_center()
              .text_size(12).text_color(t.muted)
              .child(svg("mods/orca-spaces/loader-circle.svg").size(16).flex_none().spin(1000))
              .child(div().child("Loading workspaces\u2026"))))
            // EmptyState.tsx:22-27 renders "No workspaces found" when rows are empty.
            // EmptyState.tsx:14 and WorktreeList.tsx:285-287 gate this on startupWorktreeRefreshCompleted.
            .when(this.loaded && rows.length === 0, el => el.child(div().flex().flex_col().items_center().gap(8).px(16).py(24).w_full()
              .text_size(11).text_center().text_color(t.muted)
              .child(div().child("No workspaces found"))))
            .children(rows.length ? this.grouped(t, cx, rows) : [])
            // Saved projects: folders stored in localStorage["projects.saved.v1"] that no
            // open space's folder covers. Click → run("space.new", { folder }).
            // Hover reveals a remove control that drops the folder from the store and notifies.
            .when(savedRows.length > 0, el => el.child(v_flex().flex_none().w_full().mt(8).gap(4)
              .child(div().text_size(11).text_color("#6a6a6a").child("Saved Projects"))
              .children(savedRows)))))
        // The list's `.on_hover` flips the bar to `always`; Orca reveals on the sidebar's hover
        // (`main.css:781-800`), and the bar's own `hover` mode only sees the bar itself.
        .child(Scrollbar.vertical("space-list").mode(this.listHover ? "always" : "hover").absolute().inset_0())));
  }
}
