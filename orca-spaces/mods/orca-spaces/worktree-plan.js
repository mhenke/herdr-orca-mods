// Worktree plan projection module: transforms raw git worktrees and Herdr spaces into
// ordered, grouped, and deduplicated worktree rows.
//
// Ports corresponding Orca concepts:
// - `parseWorktreeList`: `src/shared/git/worktrees/git-worktree-porcelain-parser.ts:4`
// - Host-qualified identity & space deduplication: `src/shared/worktree/host-qualified-identity.ts`
// - Catalog hydration & unvisited worktree synthesis: `src/renderer/src/store/slices/worktrees/listing/hydrated-worktree-purge.ts:19-31`
// - Main worktree first ordering: `src/shared/sidebar-list/section-order.ts:3-16` (`orderMainWorktreeFirst`)
// - Repo-based group headers & ordering: `src/shared/sidebar-list/sidebar-row-plan.ts:58,155` (`buildOrderedGroups`)
// - Rendered project collapse keys: `src/renderer/src/components/sidebar/worktree-list/listing/project-collapse-all.ts:4-16` (`getRenderedProjectCollapseKeys`)
// - Discovery gate: `src/renderer/src/startup/startup-worktree-refresh.ts:78-82`, `EmptyState.tsx:14`

/**
 * Parses raw git worktree porcelain output (`git worktree list --porcelain`).
 * Port of Orca's `parseWorktreeList` (`git-worktree-porcelain-parser.ts:4`).
 * The first worktree emitted is the main checkout.
 */
export function parseWorktreeList(output) {
  const out = [];
  for (const block of output.trim().split(/\r?\n\r?\n/)) {
    let path = "", branch = "", bare = false;
    for (const line of block.trim().split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") bare = true;
    }
    if (path && !bare) out.push({ path, branch });
  }
  return out;
}

/**
 * Where a space is now: its first terminal's live folder, else where it was made.
 * `ps`: panes(), read once by the caller (each read copies every pane).
 */
export function place(s, ps = []) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

/**
 * Host-qualified workspace identity key [machine, folder].
 * Port of `getWorktreeHostIdentity` (`host-qualified-identity.ts`).
 */
export const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);

export const base = (path) => path.replace(/\/+$/, "").split("/").pop();

/**
 * A `[machine, path|repo]` pair written by `where`: anything else reads as [].
 */
export const readPair = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * Project group fold key: repo path for repository worktrees, or `space:<id>` for standalone folders.
 * Port of Orca's project section collapse keys (`project-collapse-all.ts:10-12`).
 */
export function foldKey({ w, g }) {
  return g?.repo ?? `space:${w.id}`;
}

/**
 * Projects the worktree plan from active spaces, terminal panes, and cached git state.
 * Pure data transformation: no UI components, timers, or side effects.
 *
 * Port of Orca's `planSidebarRows` (`sidebar-row-plan.ts:64-165`) and `useMemo` row derivation
 * (`use-section-rows.ts:147`).
 *
 * @param {Object} options
 * @param {Array} [options.spaces] Active Herdr spaces
 * @param {Array} [options.panes] Active terminal panes
 * @param {Object} [options.gitState] Cached repository status map keyed by `where()`
 * @param {Set} [options.foldedRepos] Set of collapsed project keys
 * @param {boolean} [options.loaded] Whether startup worktree refresh has completed
 * @param {Function} [options.whereFn] Custom space location resolver (defaults to `where`)
 * @returns {{ groups: Array, list: Array, visibleRows: Array, projectKeys: string[], rowIndex: Map<string, number>, out: Array }}
 */
export function projectWorktreePlan({
  spaces: sp = [],
  panes: ps = [],
  gitState = {},
  foldedRepos = new Set(),
  loaded = false,
  whereFn = where,
} = {}) {
  const getWhere = (w) => (whereFn ? whereFn(w, ps) : where(w, ps));
  // Orca draws rows only after discovery completes.
  // startup-worktree-refresh.ts:78-82 sets startupWorktreeRefreshCompleted in a finally block,
  // and EmptyState.tsx:14 gates "No workspaces found" on that flag.
  const isDiscoverable = (w) => loaded || getWhere(w) in gitState;

  const rows = sp.map((w, i) => ({
    w,
    i,
    g: gitState[getWhere(w)] ?? null,
    ok: isDiscoverable(w),
  }));

  // Orca's projects are repos, not sessions (`listRepoWorktrees`): a group exists because the
  // repo is known, and its rows are `git worktree list` — main first
  // (`orderMainWorktreeFirst`, section-order.ts:4-16). What is open must not decide this: all
  // of a repo's spaces can be linked worktrees, and the main checkout still has a card.
  const open = new Set(sp.map((w) => getWhere(w)));
  const anchored = new Set();
  const mainRows = [];
  for (const key of Object.keys(gitState)) {
    const g = gitState[key];
    if (!g || anchored.has(g.repo)) continue;
    anchored.add(g.repo);
    // An older cache entry has no worktree list; a non-linked one is its own main checkout.
    const main = g.worktrees?.[0] ?? (g.linked ? null : { path: readPair(key)[1], branch: g.branch });
    if (!main?.path) continue;
    const [on] = readPair(key);
    const mainKey = JSON.stringify([on ?? null, main.path]);
    if (open.has(mainKey)) continue;
    mainRows.push({
      w: {
        id: `repo:${mainKey}`,
        name: g.name,
        named: false,
        tabs: [],
        active: false,
        status: null,
        machine: on ?? null,
        folder: main.path,
      },
      i: -1,
      g: { ...g, top: main.path, linked: false, branch: main.branch ?? g.branch },
      ok: true,
      unopened: true,
    });
  }
  // Main first inside its group (`[...main, ...rest]`), before the spaces opened on it.
  rows.unshift(...mainRows);

  // A repo worktree is one card: `linked` worktrees and second same-checkout spaces fold
  // into the first space on that top-level folder. Folder spaces merge only with themselves.
  // (host-qualified-identity.ts: getWorktreeHostIdentity)
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const key = r.g ? JSON.stringify([r.w.machine ?? null, r.g.top]) : `space:${r.w.id}`;
    if (seen.has(key)) {
      (list.find((l) => l.key === key).also ??= []).push(r);
      continue;
    }
    seen.add(key);
    list.push({ ...r, key, also: [] });
  }

  // Sibling worktrees are flat cards under the group header, main first
  // (`orderMainWorktreeFirst`, section-order.ts:4-16). Orca nests only explicit lineage
  // (created-from records), which Herdr doesn't track, so every row here is depth 0 —
  // no tree indent, no wrapper.
  const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
  const nested = (r) => r.g?.linked && mains.has(r.g.repo);
  const out = [];
  const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
  const headed = new Set(); // repos whose header is already drawn

  for (const r of list) {
    // Orca's `groupBy: 'repo'` plan emits ONE header per repo group
    // (sidebar-row-plan.ts -> buildOrderedGroups), with every worktree of that repo as a
    // card beneath it. A second space in the same repo is another card, not a new group.
    const head = !r.g || !headed.has(r.g.repo);
    if (r.g) headed.add(r.g.repo);
    const top = { ...r, kids: 0, head };
    out.push(top);
    if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
    placed.add(r.g.repo);

    // Main worktree first, then the rest — a pure partition, re-evaluated every pass, exactly
    // as Orca's `orderMainWorktreeFirst` (`section-order.ts:4-16`). `list` is in space
    // order, so a linked worktree that happens to be an earlier space would otherwise sort
    // above the main checkout. Nothing is written to the host: the order is a view.
    const kids = [
      ...list.filter((k) => nested(k) && k.g.repo === r.g.repo && !k.g.linked),
      ...list.filter((k) => nested(k) && k.g.repo === r.g.repo && k.g.linked),
    ];
    top.kids = kids.length;

    // Orca lists every worktree of the repo, opened or not. A worktree with no space is a
    // card that opens it on click (`space.new {folder}`), so the group's rows match git.
    const opened = new Set(list.filter((k) => k.g?.repo === r.g.repo).map((k) => k.g.top));
    for (const wt of (r.g.worktrees ?? []).slice(1)) {
      if (opened.has(wt.path)) continue;
      opened.add(wt.path);
      const w = {
        id: `wt:${r.g.repo}:${wt.path}`,
        name: wt.branch || wt.path.split("/").pop(),
        named: false,
        tabs: [],
        active: false,
        status: null,
        machine: r.w.machine,
        folder: wt.path,
      };
      // No `...r.g`: a sibling worktree shares the repo but not the review. Orca reads each
      // worktree's own branch, so carrying the main worktree's PR onto this row was the bug.
      const g = { ...r.g, top: wt.path, branch: wt.branch || r.g.branch, linked: true, pr: undefined };
      kids.push({ w, i: -1, g, key: `wt:${wt.path}`, also: [], unopened: true });
    }
    top.kids = kids.length;

    // Not filtered here: `row()` hides a folded repo's cards so its header stays, which is
    // what a fold means. Filtering it here too made the whole group disappear.
    kids.forEach((k) => out.push({ ...k, head: false }));
  }

  // Nothing here mutates or dispatches: the order below IS the answer, recomputed each pass.
  // Ordering it in the plan is what keeps the list from rewriting itself while it loads.
  const visibleRows = out.filter((r) => r.unopened || r.ok);

  // The drag indicator needs both cards' row positions. `i` is the space index, not the
  // row index (folded groups, merged spaces and unopened worktrees all shift it), so the
  // dragging card's position is looked up here, by its row id.
  // Port of `use-document-drop.ts:72`.
  const rowIndex = new Map(visibleRows.map((r, i) => [r.w.id, i]));

  // Every project key currently rendered, for `setAllProjectsCollapsed`. Orca collects them
  // from the row plan (`getRenderedProjectCollapseKeys`, project-collapse-all.ts:5); the
  // equivalent here is the group header each rendered row emits.
  const projectKeys = [...new Set(visibleRows.filter((r) => !r.unopened).map(foldKey))];

  // Grouped structure by project key (repo or space:<id>)
  const groupMap = new Map();
  const groups = [];
  for (const r of visibleRows) {
    const k = foldKey(r);
    let g = groupMap.get(k);
    if (!g) {
      g = { key: k, repo: r.g?.repo ?? null, rows: [] };
      groupMap.set(k, g);
      groups.push(g);
    }
    g.rows.push(r);
  }

  return {
    groups,
    list,
    visibleRows,
    projectKeys,
    rowIndex,
    out,
  };
}
