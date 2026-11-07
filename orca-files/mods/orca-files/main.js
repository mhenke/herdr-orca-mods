// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, props, run, openOverlay, closeOverlay, shared, setShared, nextCommand } from "herdr";
import { copyText, reveal } from "./clip.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // Orca scopes the panel to the project, not to whatever folder the focused
  // terminal happens to sit in: a terminal in /tmp must not empty the tree.
  const live = pane?.cwd || f?.cwd;
  const project = space?.folder || live;
  const cwd = live && project && !(live.startsWith(project + "/") || live === project) ? project : live || project;
  return { cwd, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

// Orca mixes the accent at 70%/80% and uses `bg-input/50` (FileExplorerNameFilter.tsx:23,
// main.css:1453-1471). Herdr stores colors as `#rrggbb[aa]`, so scale the alpha.
function fade(color, factor) {
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  return color.slice(0, 7) + Math.round(alpha * factor).toString(16).padStart(2, "0");
}

// Orca's FileTypeIcon tables (file-type-icons.ts:24-54, file-type-icon-extension-table.ts,
// file-type-icon-name-table.ts). Grouped by icon so the port stays one table, not two hundred.
const FILE_ICONS = Object.assign(Object.create(null), {
  "file-code": "astro c cc clj cjs cpp cs cts cxx dart erl ex exs fs fsx go h hpp hrl hs htm html java js jsx kt kts lua mjs mts nim php pl pm py r rb rs scala sol svelte swift ts tsx vb vue xhtml xml zig",
  "file-archive": "7z br bz2 dmg gz iso rar tar tbz2 tgz txz xz zip",
  "file-image": "ai avif bmp eps gif heic ico jpeg jpg png psd svg tif tiff webp",
  "file-text": "adoc doc docx log md mdx pdf qmd rmarkdown rmd rst rtf tex txt",
  "file-sliders": "cfg conf hcl ini properties tf tfvars toml yaml yml",
  "file-type": "css eot less otf sass scss ttf woff woff2",
  "file-video": "avi m4v mkv mov mp4 mpeg mpg webm",
  "file-music": "aac flac m4a mp3 ogg opus wav",
  "file-key": "asc cer crt gpg key pem pub",
  "database": "db duckdb prisma sql sqlite sqlite3",
  "file-spreadsheet": "csv ods tsv xls xlsx",
  "file-chart-column": "ipynb mmd ppt pptx",
  "file-json": "json json5 jsonc",
  "file-braces": "gql graphql proto",
  "file-diff": "diff patch",
  "file-terminal": "bash bat cmd fish nu ps1 sh zsh",
  "file-cog": "gradle",
  "file-axis-3d": "blend fbx glb gltf obj stl",
  "file-lock": "lock p12 pfx",
});
const FILE_ICON_EXT = Object.create(null), FILE_ICON_NAME = Object.create(null);
for (const [icon, list] of Object.entries(FILE_ICONS)) for (const ext of list.split(" ")) FILE_ICON_EXT[ext] = icon;
for (const [icon, list] of Object.entries({
  "file-sliders": ".babelrc .dockerignore .editorconfig .eslintrc .eslintrc.cjs .eslintrc.js .eslintrc.yaml .eslintrc.yml .gitattributes .gitignore .npmrc .prettierrc .prettierrc.yaml .prettierrc.yml components.json postcss.config.cjs postcss.config.js postcss.config.mjs postcss.config.ts tailwind.config.cjs tailwind.config.js tailwind.config.mjs tailwind.config.ts tsconfig.json vite.config.js vite.config.mjs vite.config.ts vitest.config.js vitest.config.mjs vitest.config.ts",
  "file-json": ".eslintrc.json .prettierrc.json",
  "file-text": "agents.md authors changelog changelog.md contributing contributing.md readme readme.md todo",
  "file-box": "bun.lock bun.lockb cargo.lock cargo.toml composer.json composer.lock gemfile go.mod go.sum package-lock.json package.json pipfile pnpm-lock.yaml pnpm-workspace.yaml poetry.lock pom.xml pyproject.toml requirements-dev.txt requirements.txt yarn.lock",
  "file-key": "codeowners copying license notice",
  "file-lock": "security security.md",
  "file-cog": "cmakelists.txt dockerfile meson.build settings.gradle settings.gradle.kts",
  "file-terminal": "makefile",
})) for (const name of list.split(" ")) if (name) FILE_ICON_NAME[name] = icon;
// getExtension + getFileTypeIcon (file-type-icons.ts:14-54): compound suffix first, then the
// last dot, `.env`/Dockerfile/Makefile special cases, and File as the fallback.
function fileIcon(name) {
  const lower = name.toLowerCase(), dot = lower.lastIndexOf(".");
  if (FILE_ICON_NAME[lower]) return FILE_ICON_NAME[lower];
  if (lower === ".env" || lower.startsWith(".env.")) return "file-lock";
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "file-cog";
  if (lower === "makefile" || lower.startsWith("makefile.")) return "file-terminal";
  for (const compound of ["tar.bz2", "tar.gz", "tar.xz"]) if (lower.endsWith(`.${compound}`)) return "file-archive";
  return (dot > 0 ? FILE_ICON_EXT[lower.slice(dot + 1)] : undefined) ?? "file";
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))); link=($_.LinkType -ne $null) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  // `l`: a link to a non-directory, so the row can draw Link (FileExplorerRow.tsx:219-220).
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; elif [ -L "$p" ]; then kind=l; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d", link: fields[i] === "l" });
  return out;
}

// Git decoration tones, `git-path-decoration.ts:5-12` -> main.css:489-496 (dark).
function gitTone(mark, t) {
  switch (mark) {
    case "A": return "#81b88b";               // added
    case "D": return "#c74e39";               // deleted
    case "M": return "#e2c08d";               // modified
    case "R": case "U": case "C": return "#73c991"; // renamed / untracked / copied
    case "!": return "#808080";               // ignored
    default: return t.dim;
  }
}

// Toolbar filter state is shared because the More menu opens as a second copy of this mod
// (openOverlay instantiates it again); keyed by root like Orca's per-worktree store
// (FileExplorer.tsx:73-74). Both default true, as Orca does
// (FileExplorer.tsx:73-74, useFileExplorerVisibleRowProjection.ts:167).
function filters(root) {
  const all = shared("orca-files.filters") ?? {};
  return { dotfiles: all[root]?.dotfiles ?? true, ignored: all[root]?.ignored ?? true };
}
function setFilter(root, name, value) {
  const all = shared("orca-files.filters") ?? {};
  setShared("orca-files.filters", { ...all, [root]: { ...(all[root] ?? {}), [name]: value } });
}

// Orca's status priority: deleted > modified > added/untracked > renamed > copied
// (git-path-decoration.ts:14-22); labels are U/A/M/D/R/C (git-status-labels.ts:3-10).
// Porcelain chars outside the set (T, unmerged U) are `modified`, as parseStatusChar does
// (git-status-porcelain-parser.ts:179-194).
function statusRank(letter) {
  return letter === "D" ? 5 : letter === "M" ? 4 : letter === "A" || letter === "U" ? 3 : letter === "R" ? 2 : 1;
}
function statusLetter(char) {
  return char === "D" ? "D" : char === "M" ? "M" : char === "A" ? "A" : char === "R" ? "R" : char === "C" ? "C" : "M";
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.ignored = new Set(); this.git = false; this.folderMarks = {}; this.folderErrors = {};
    this.inputHandle = cx.focus_handle();
    this.hits = null; this.searching = false; this.qFocused = false; this.view = "files";
    // FileExplorerViewSwitch.tsx:21-41 — Names filters the tree by name, Contents searches
    // file text; both inputs stay mounted, as FileExplorer.tsx:294-309 keeps them.
    // Names matches a flat worktree listing (use-file-explorer-name-filter.ts:45-50), cached
    // in `names` and projected into `nfMap`; `nfCollapsed` is nameFilterCollapsedPaths.
    this.names = null; this.nfMap = null; this.nfCollapsed = new Set(); this.nfLoading = false;
    this.name = InputState.new({ placeholder: "Find files" }); // FileExplorerNameFilter.tsx:39
    // A new query blanks the projection and shows the listing spinner, as Orca's
    // `relativePaths: null` does while `nameFilterFiles.loading` (use-file-explorer-name-filter.ts:57-61).
    this.name.on("change", (_e, cx) => {
      if (this.name.value().trim()) { this.nfMap = null; this.nfLoading = true; }
      cx.notify(); this.scheduleName(cx);
    });
    // SearchQueryRow.tsx:53 — the Contents input's placeholder is `Search`.
    this.q = InputState.new({ placeholder: "Search" });
    // Debounce through `cx.timer.after`, not `setTimeout`: a `cx` captured in a
    // `setTimeout` closure is stale by the time it fires, and the runtime rejects it
    // ("cx is no longer valid…", `scope.rs:420`). A rejected build makes the shell
    // replace the pane with its "could not be re-rendered" banner — which is the
    // orange 2px bar at the top of the sidebar that appeared while typing.
    // `cx.timer.after` hands each callback a fresh context (`typings.rs:3914-3921`).
    let timer = null;
    this.q.on("change", (_e, cx) => {
      const v = this.q.value().trim();
      timer?.cancel();
      this.searching = Boolean(v); cx.notify();
      timer = cx.timer.after(200, (cx) => {
        if (!v) { this.hits = null; this.searching = false; cx.notify(); return; }
        cx.spawn(async (cx) => {
          const h = await this.search(v);
          this.hits = h; this.searching = false; cx.notify();
        });
      });
    });
    // `focus-within:border-ring ring-1 ring-ring` (FileExplorerNameFilter.tsx:23): GPUI has no
    // `:focus-within` or ring, so the input's own focus events paint the border in ring colour.
    this.q.on("focus", (_e, cx) => { this.qFocused = true; cx.notify(); });
    this.q.on("blur", (_e, cx) => { this.qFocused = false; cx.notify(); });
    this.input = InputState.new({ placeholder: "Name" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => { void this.apply(this.input.value().trim(), cx); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c) await this.command(c, cx).catch(() => {});
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.folderMarks = {}; this.folderErrors = {};
      this.ignored = new Set(); this.git = false;
      this.names = null; this.nfMap = null; this.nfCollapsed = new Set(); this.nfLoading = false;
      this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    this.names = null; // a fresh listing each cycle picks up files the filter must see
    cx.notify();
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        // Status keys are relative to `this.root`, as Orca looks them up by `relativePath`
        // (FileExplorerVirtualRows.tsx:198-232): the tree root is the focused pane's folder,
        // which can sit below the repo root `git rev-parse` reports.
        const posix = p => p.replace(/\\/g, "/").replace(/\/+$/, "");
        const root = posix(this.root ?? ""), base = top?.stdout.trim() ? posix(top.stdout.trim()) : "";
        const marks = {}, folderMarks = {}, ignored = new Set();
        if (top?.code === 0) {
          // --ignored: Orca draws ignored rows with CircleSlash (FileExplorerRow.tsx:258-267).
          // Renames stay on so R/C rows reach the parser (git-status-porcelain-parser.ts:127-150).
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { cwd, on }).catch(() => null);
          if (status?.code === 0) {
            const fields = status.stdout.split("\0").filter(Boolean);
            for (let i = 0; i < fields.length && i < TOTAL; i++) {
              const entry = fields[i], xy = entry.slice(0, 2);
              const abs = `${base}/${entry.slice(3).replace(/\/$/, "")}`;
              if (!abs.startsWith(`${root}/`)) continue;
              const rel = abs.slice(root.length + 1);
              if (xy === "!!") { marks[rel] = "!"; ignored.add(rel); continue; }
              // `??` is untracked, not added (git-status-labels.ts:3-10).
              if (xy === "??") { marks[rel] = "U"; continue; }
              let best = "M", rank = 0;
              for (const char of xy) {
                if (char === " " || char === ".") continue;
                const next = statusRank(statusLetter(char));
                if (next > rank) { best = statusLetter(char); rank = next; }
              }
              marks[rel] = best;
              // Rename/copy entries put the original path in the next NUL field (-z).
              if (xy[0] === "R" || xy[0] === "C") i += 1;
            }
            // buildFolderStatusMap (git-path-decoration.ts:53-88): a folder takes the
            // dominant status of its descendants; deleted files do not propagate (:86-88).
            for (const [rel, letter] of Object.entries(marks)) {
              if (letter === "!" || letter === "D") continue;
              let cur = "";
              for (const segment of rel.split("/").slice(0, -1)) {
                cur = cur ? `${cur}/${segment}` : segment;
                if (!folderMarks[cur] || statusRank(letter) > statusRank(folderMarks[cur])) folderMarks[cur] = letter;
              }
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.folderMarks = folderMarks;
        this.ignored = ignored; this.git = top?.code === 0;
        this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        if (this.view === "files" && this.name.value().trim()) this.scheduleName(cx);
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
        delete this.folderErrors[folder];
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); delete this.folderErrors[path]; }
          catch (e) { if (this.current(context)) this.folderErrors[path] = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // `canCollapseAll` is `expanded.size > 0` (FileExplorer.tsx:150); collapsing drops the
  // expanded folders and their cached listings, as `toggle` does.
  collapseAll(cx) {
    if (!this.folders.size) return;
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders.clear();
    cx.notify();
  }

  // `isPathIgnored`: the path or any ancestor (git-path-decoration.ts:90-108). The ignored
  // set is keyed relative to the tree root, like the marks.
  isGitIgnored(path) {
    if (!this.git || !this.ignored.size) return false;
    for (let p = path; ;) {
      if (this.ignored.has(p)) return true;
      const i = p.lastIndexOf("/");
      if (i < 0) return false;
      p = p.slice(0, i);
    }
  }

  // Debounced like the Contents input above: a keystroke must not re-list the worktree.
  scheduleName(cx) {
    this.nfTimer?.cancel();
    const query = this.name.value().trim();
    if (!query) {
      this.nfMap = null; this.nfCollapsed = new Set(); this.nfLoading = false;
      cx.notify();
      return;
    }
    this.nfTimer = cx.timer.after(200, cx => { cx.spawn(cx => this.nameMatches(cx)); });
  }

  // The listing behind Names: one `git ls-files` (tracked + untracked, ignored included —
  // the toggle filters later) or `rg --files` outside git, NUL-separated, capped at
  // Orca's QUICK_OPEN_LISTING_MAX_RESULTS (quick-open-listing-limits.ts:2). Cached per root
  // so narrowing a query reuses it; every `refresh` drops it for a fresh listing.
  async fileList() {
    const key = `${this.root ?? ""}\n${this.git}`;
    if (this.names?.key === key) return this.names.paths;
    const root = this.root;
    if (!root) return [];
    let paths = [];
    if (this.git) {
      const r = await exec("git", ["ls-files", "-z", "-c", "-o"], { cwd: root, on: this.on }).catch(() => null);
      if (r?.code === 0) paths = r.stdout.split("\0");
    }
    if (!paths.length) {
      const r = await exec("rg", ["--files", "--hidden", "--no-ignore", "--null"], { cwd: root, on: this.on }).catch(() => null);
      if (r?.code === 0) paths = r.stdout.split("\0").map(p => p.replace(/^\.\//, ""));
    }
    // `.git` never enters the tree (directory() skips it).
    paths = paths.filter(p => p && p !== "." && p !== ".git" && !p.startsWith(".git/")).slice(0, 20001);
    this.names = { key, paths };
    return paths;
  }

  // createNameFilteredFileExplorerProjection (:111-194): a matching file keeps every
  // ancestor directory; dotfiles and ignored paths follow the same two toggles (:149-154);
  // all query tokens must appear in the relative path (file-name-filter-tokens.ts:50-60);
  // over FILE_NAME_FILTER_QUERY_MAX_BYTES (2 KiB) nothing matches (:5).
  async nameMatches(cx) {
    const query = this.name.value().trim(), context = this.context;
    if (!query) { this.nfMap = null; this.nfCollapsed = new Set(); this.nfLoading = false; cx.notify(); return; }
    const f = filters(this.root);
    this.nfLoading = true; cx.notify();
    if (query.length > 2048) { // FILE_NAME_FILTER_QUERY_MAX_BYTES, approximated by string length
      this.nfMap = new Map(); this.nfLoading = false; cx.notify(); return;
    }
    // Tokens are whitespace-split and lowercased by splitFileNameFilterTokens (:15-32).
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean), paths = await this.fileList();
    if (!this.current(context) || this.name.value().trim() !== query) return;
    const map = new Map(), seen = new Set(), add = (prefix, name, dir) => {
      const id = `${prefix}\0${name}`;
      if (seen.has(id)) return;
      seen.add(id);
      const list = map.get(prefix) ?? [];
      list.push({ name, dir }); map.set(prefix, list);
    };
    let count = 0;
    for (const rel of paths) {
      if (count >= TOTAL) break;
      if (!f.dotfiles && rel.split("/").some(s => s.length > 1 && s.startsWith("."))) continue;
      if (!f.ignored && this.isGitIgnored(rel)) continue;
      if (this.marks[rel] === "D") continue; // the index still lists an unstaged deletion
      const hay = rel.toLowerCase();
      if (!tokens.every(token => hay.includes(token))) continue;
      count++;
      const parts = rel.split("/");
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) { add(prefix, parts[i], true); prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]; }
      add(prefix, parts[parts.length - 1], false);
    }
    // appendNameFilteredEntries (:196-205) sorts directories first, then by name.
    for (const list of map.values()) list.sort((a, b) => a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name));
    this.nfMap = map; this.nfLoading = false;
    cx.notify();
  }

  // nameFilterCollapsedPaths (use-file-explorer-name-filter.ts:15): the filtered tree opens
  // every ancestor of a match; a click collapses just that branch.
  nameToggle(path, cx) {
    if (this.nfCollapsed.has(path)) this.nfCollapsed.delete(path); else this.nfCollapsed.add(path);
    cx.notify();
  }

  // Orca's fallback is `basename(worktreePath)` (FileExplorer.tsx:93); Herdr has no
  // repo displayName.
  repo() {
    return this.root ? this.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : "";
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A row's menu. It opens as this mod's own popup: props() carries the target.
  // New/Rename ask in the popup's own prompt because run("<mod>.<cmd>") delivers only
  // the command name to nextCommand(), so typed text cannot cross mods.
  menu(path, entry) {
    openOverlay({ mod: "orca-files", kind: "popup", width: 230, height: 300,
      props: { tab: "file", target: { path, dir: entry.dir } } });
  }

  full(path) { return this.root ? `${this.root}/${path}` : path; }

  act(name, cx) {
    const target = props()?.target;
    if (!target) return;
    const { path, dir } = target;
    const full = this.full(path);
    const overlay = props()?.overlay;
    const close = () => { if (overlay) closeOverlay(overlay); };
    // New File / New Folder target a folder; for a file row that is its parent, as Orca
    // computes `targetDir` (FileExplorerVirtualRows.tsx:242 ->
    // file-explorer-row-context-menu.tsx:153,160).
    const parent = dir ? full : full.replace(/\/[^/]*$/, "");
    // Typed text cannot cross mods: run("<mod>.<cmd>") delivers only the command
    // string to nextCommand(). So New/Rename ask in this mod's own popup instead.
    // Stay in this popup: closing it first would take the prompt with it.
    const ask = (mode, title, value, base = full) => {
      this.prompt = { mode, title, full: base, overlay, value: value ?? "" };
      if (value) this.input.set_value(value), this.input.set_selected_range({ start: 0, end: value.length });
      else this.input.set_value("");
      this.input.focus();
      cx.notify();
    };
    switch (name) {
      case "new-file": return ask("touch", "New File", null, parent);
      case "new-folder": return ask("mkdir", "New Folder", null, parent);
      case "copy-path": void copyText(full); return close();
      case "copy-rel": void copyText(path); return close();
      case "terminal": run("terminal.open", { folder: dir ? full : this.root }); return close();
      case "reveal": void reveal(full); return close();
      case "rename": return ask("mv", "Rename", path.replace(/^.*\//, ""));
      case "delete":
        close();
        setShared("orca-files.target", full);
        return openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 180,
          props: { title: "Delete?", detail: full, command: { name: "orca-files.remove" } } });
    }
  }

  // The pending New/Rename, applied here because typed text cannot cross mods.
  // `cx` is a click or submit context, so the writes run in a task whose own
  // `cx` is what `refresh` gets: the caller's would be stale after the awaits.
  apply(name, cx) {
    const p = this.prompt;
    this.prompt = null;
    if (p?.overlay) closeOverlay(p.overlay);
    if (!p || !name) return;
    const parent = p.full.replace(/\/[^/]*$/, "");
    cx.spawn(async (cx) => {
      if (p.mode === "touch") await writeTextFile(`${p.full}/${name}`, "", null);
      if (p.mode === "mkdir") await exec("mkdir", ["-p", `${p.full}/${name}`]);
      if (p.mode === "mv") await exec("mv", [p.full, `${parent}/${name}`]);
      this.refresh(cx);
    });
  }

  // Delete needs no typed text, so the shipped confirm mod can drive it.
  // `cx` is the `nextCommand` loop's AsyncContext (see `command`), which stays
  // valid across awaits.
  async remove(cx) {
    const full = shared("orca-files.target");
    setShared("orca-files.target", null);
    if (full) await exec("rm", ["-rf", full]);
    this.refresh(cx);
  }

  command(c, cx) { if (c === "remove") return this.remove(cx); }

  // Bounded: exec caps at 8 MiB / 30s, so cap hits rather than fail.
  async search(query) {
    if (!query) return [];
    const r = await exec("rg", ["--vimgrep", "--smart-case", "--max-count", "20", query], { cwd: this.root, on: this.on }).catch(() => null);
    if (!r || r.code > 1) return [];
    return (r.stdout || "").split("\n").slice(0, 200).filter(Boolean).map(l => {
      const [file, line, , ...rest] = l.split(":");
      return { file, line: Number(line), text: rest.join(":").trim() };
    });
  }

  // `source === "name"` walks `nfMap`, the projection nameMatches built from the worktree
  // listing; the plain tree walks the loaded folder cache.
  rows(prefix, depth, out, t, source) {
    if (out.length >= TOTAL || depth > 40) return out;
    const named = source === "name", f = filters(this.root);
    for (const entry of (named ? this.nfMap?.get(prefix) : this.entries.get(prefix)) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Show Dotfiles: Orca drops any dot-prefixed segment (file-explorer-entries.ts:7-14).
      if (!named && !f.dotfiles && entry.name.length > 1 && entry.name !== ".." && entry.name.startsWith(".")) continue;
      // Show Git Ignored Files: Orca hides ignored paths and their ancestors
      // (git-path-decoration.ts:90-108). nameMatches already applied both toggles.
      if (!named && !f.ignored && this.isGitIgnored(path)) continue;
      // The filtered tree opens every ancestor of a match unless the branch was collapsed
      // (nameFilterCollapsedPaths, file-explorer-name-filter-projection.ts:206-208).
      const open = named ? !this.nfCollapsed.has(path) : this.folders.has(path);
      const kids = entry.dir && open ? this.rows(path, depth + 1, [], t, source) : [];
      // A folder row shows its descendants' dominant status when it has no mark of its own
      // (buildFolderStatusMap, git-path-decoration.ts:53-88; FileExplorerVirtualRows.tsx:170-176).
      const mark = this.marks[path] ?? (entry.dir ? this.folderMarks[path] : undefined);
      // FileExplorerRow.tsx:204-226,242-248 — Loader2 while the folder loads, CircleAlert on a
      // read error, Link for a symlink, FileTypeIcon per extension.
      const loading = entry.dir && this.pending.has(path), failed = entry.dir ? this.folderErrors[path] : null;
      const icon = entry.dir
        ? loading ? svg("mods/orca-files/loader-circle.svg").size(12).flex_none().text_color(t.muted).spin(1000)
          : failed ? svg("mods/orca-files/circle-alert.svg").size(12).flex_none().text_color(t.blocked)
          : svg(`mods/orca-files/${open ? "folder-open" : "folder"}.svg`).size(12).flex_none().text_color(t.muted)
        : entry.link ? svg("mods/orca-files/link.svg").size(12).flex_none().text_color(t.muted)
        : svg(`mods/orca-files/${fileIcon(entry.name)}.svg`).size(12).flex_none().text_color(t.muted);
      // FileExplorerRow.tsx:147-152 — px-2 py-1 text-xs gap-1, indent depth*16 + 8; 26px is
      // Orca's own row constant (virtualizer estimateSize, inline-input row, drag ghost).
      // Colours: git-path-decoration.ts:5-12 -> main.css:489-496.
      // Selected row: main.css:1453-1471 — accent at 70% (80% hovered), inset 1px border,
      // accent-foreground text; hover is `bg-accent` (FileExplorerRow.tsx:148).
      // Divergence: rounded(2), not rounded-sm (6px): the hover fill is only 26px tall.
      out.push(h_flex().id(`file-${path}`).w_full().h(26).flex_none().pl(8 + depth * 16).pr(8).gap(4).items_center().rounded(2).text_size(12).cursor_pointer()
        .when(this.file === path, el => el.bg(fade(t.accent, 0.7)).border_1().border_color(t.border).text_color(t.accent_foreground).hover(s => s.bg(fade(t.accent, 0.8))))
        .when(this.file !== path, el => el.hover(s => s.bg(t.accent)))
        .on_click((_e, cx) => entry.dir ? (named ? this.nameToggle(path, cx) : this.toggle(path, cx)) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry); })
        .child(entry.dir ? svg(`mods/orca-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(icon)
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(gitTone(mark, t))).child(entry.name))
        // FileExplorerRow.tsx:242-248 — the read error rides the row as a destructive truncation.
        .when(Boolean(failed), el => el.child(div().w(0).flex_1().truncate().text_color(t.blocked).tooltip(failed).child(failed)))
        // FileExplorerRow.tsx:251-267 — status `text-[10px] font-semibold tracking-wide mr-2`;
        // ignored rows swap the label for CircleSlash size-3. `tracking-wide` has no gpui-kit
        // method, so only the size and weight are ported.
        .when(mark === "!", el => el.child(div().mr(8).flex_none().child(svg("mods/orca-files/circle-slash.svg").size(12).flex_none().text_color(gitTone(mark, t)))))
        .when(Boolean(mark) && mark !== "!", el => el.child(div().mr(8).flex_none().text_size(10).font_semibold().text_color(gitTone(mark, t)).child(mark))));
      if (entry.dir && open) out.push(...kids);
    }
    return out;
  }

  promptView(t) {
    const close = (cx) => { this.prompt = null; cx.notify(); };
    return v_flex().id("orca-files-prompt").w_full().min_h(0).p(14).gap(10).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(14).font_semibold().child(this.prompt.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")).on_key_down((e, cx) => {
          if (e.key === "escape") { close(cx); cx.stop_propagation(); }
        }).track_focus(this.inputHandle))
      .child(div().text_size(11).text_color(t.dim).child(this.prompt.full))
      .child(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.surface).text_size(12.8).text_color(t.foreground)
        .on_key_down((e, cx) => { if (e.key === "enter") { void this.apply(this.input.value().trim(), cx); cx.stop_propagation(); } }))
      .child(h_flex().gap(8).justify_end()
        .child(h_flex().id("fx-cancel").h(30).px(12).items_center().rounded(7).border_1().border_color(t.input).text_size(12).cursor_pointer().hover(s => s.opacity(0.88)).on_click((_e, cx) => close(cx)).child("Cancel"))
        .child(h_flex().id("fx-save").h(30).px(12).items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium().cursor_pointer()
          .hover(s => s.opacity(0.88)).on_click((_e, cx) => { void this.apply(this.input.value().trim(), cx); cx.notify(); }).child("Save")));
  }

  menuView(t) {
    const item = (i, label, icon, name) => h_flex().id(`fx-${i}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.act(name, cx))
      .child(svg(`mods/orca-files/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().child(label));
    return v_flex().id("orca-files-menu").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .child(div().px(8).py(4).text_size(11).text_color(t.dim).child(props()?.target?.path ?? ""))
      .child(item(0, "New File", "plus", "new-file"))
      .child(item(1, "New Folder", "folder", "new-folder"))
      .child(item(2, "Copy Path", "copy", "copy-path"))
      .child(item(3, "Copy Relative Path", "copy", "copy-rel"))
      .child(item(4, "Open in Terminal", "terminal", "terminal"))
      .child(item(5, "Reveal", "file", "reveal"))
      .child(item(6, "Rename", "square-pen", "rename"))
      .child(item(7, "Delete", "x", "delete"));
  }

  // FileExplorerToolbar.tsx:66 — `flex h-8 min-h-8 items-center gap-2 border-b border-border px-2`;
  // controls are icon-xs ghost buttons: 24x24 rounded-md with 12px glyphs (button.tsx:41).
  toolbar(t) {
    // canCollapseAll = !hasNameFilter && expanded.size > 0 (FileExplorer.tsx:150).
    const name = this.repo(), collapse = this.folders.size > 0 && !this.q.value().trim();
    const btn = (id, label, icon, action, enabled) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).tooltip(label).disabled(!enabled)
      .when(enabled, s => s.cursor_pointer().hover(x => x.bg(t.hover).text_color(t.foreground)))
      .when(!enabled, s => s.opacity(0.5)).role("button").accessibility_label(label)
      .when(enabled, s => s.on_click(action)).child(icon);
    return h_flex().id("files-toolbar").h(32).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
      // :67-72 — `min-w-0 flex-1 truncate text-xs font-medium text-foreground`, title=repoName.
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground)
        .when(Boolean(name), s => s.tooltip(name)).child(name))
      // :73-106 — Collapse All; `aria-disabled` + `opacity-50` when nothing is expanded.
      .child(btn("files-collapse", "Collapse All", svg("mods/orca-files/list-collapse.svg").size(12).flex_none(),
        (_e, cx) => this.collapseAll(cx), collapse))
      // :107-144 — Refresh Explorer; Loader2-style spinner while `refresh.isRefreshing`.
      .child(btn("files-refresh", "Refresh Explorer",
        this.loading ? svg("mods/orca-files/refresh-cw.svg").size(12).flex_none().spin(1000) : svg("mods/orca-files/refresh-cw.svg").size(12).flex_none(),
        (_e, cx) => this.refresh(cx), !this.loading))
      // :145-198 — More Explorer Actions; the dropdown opens at the pointer.
      .child(btn("files-more", "More Explorer Actions", svg("mods/orca-files/ellipsis.svg").size(12).flex_none(),
        () => openOverlay({ mod: "orca-files", kind: "popup", width: 192, height: this.git ? 140 : 112,
          props: { tab: "more", root: this.root, git: this.git } }), true));
  }

  // FileExplorerToolbar.tsx:170-197 — `align="end" min-w-[12rem]`: two checkbox items, a
  // separator, then WorktreeOpenInMenuItems.
  moreView(t) {
    const { root, git } = props() ?? {}, f = filters(root);
    const close = () => closeOverlay(props().overlay);
    const check = (i, label, on, action) => h_flex().id(`fx-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click(action)
      .child(div().w(14).flex_none().text_size(12).child(on ? "✓" : ""))
      .child(div().child(label));
    const item = (i, label, icon, action) => h_flex().id(`fx-${i}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click(action)
      .child(svg(`mods/orca-files/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().child(label));
    const fm = window()?.platform === "windows" ? "File Explorer" : window()?.platform === "macos" ? "Finder" : "File Manager";
    return v_flex().id("orca-files-more").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .child(check(0, "Show Dotfiles", f.dotfiles, () => setFilter(root, "dotfiles", !f.dotfiles)))
      // Orca renders this item while the repo supports Git (FileExplorerToolbar.tsx:177-187).
      .when(git, el => el.child(check(1, "Show Git Ignored Files", f.ignored, () => setFilter(root, "ignored", !f.ignored))))
      .child(div().h(1).mt(4).mb(4).bg(t.border))
      // WorktreeOpenInMenuItems (:189-196): Orca lists its `openInApplications` editors then
      // the file manager. Herdr has no editor setting or editor command, so only the rows it
      // can drive are ported.
      .child(item(2, "Open in Terminal", "terminal", () => { if (root) run("terminal.open", { folder: root }); close(); }))
      .child(item(3, `Open in ${fm}`, "folder-open", () => { if (root) void reveal(root); close(); }));
  }

  // FileExplorerQueryStrip.tsx:35-52 — `border-b border-border px-2 py-2` around a
  // `flex flex-col gap-2`: the Names/Contents switch sits above the active query input.
  queryStrip(t) {
    const search = this.view === "search";
    // FileExplorerViewSwitch.tsx:44-73 — `rounded-md bg-muted p-0.5`, group `h-6 w-full`,
    // items sized `xs` (h-6, text-xs, flex-1); selected `bg-card text-card-foreground`.
    const seg = (id, label, view) => div().id(id).flex_1().h(24).flex().items_center().justify_center().rounded(6).text_size(12)
      .cursor_pointer().role("button").accessibility_label(label)
      .when(this.view === view, s => s.bg(t.raised).text_color(t.foreground))
      .when(this.view !== view, s => s.text_color(t.muted).hover(x => x.text_color(t.foreground)))
      .on_click((_e, cx) => { this.view = view; cx.notify(); })
      .child(label);
    const input = search ? this.q : this.name;
    return v_flex().id("files-query").flex_none().p(8).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().w_full().h(28).p(2).gap(4).rounded(6).bg(t.hover)
        .child(seg("files-names", "Names", "files"))
        .child(seg("files-contents", "Contents", "search")))
      // FileExplorerNameFilter.tsx:23 and SearchQueryRow.tsx:47 share the `h-8 rounded-md`
      // input chrome; `focus-within:border-ring ring-1` paints the border in ring colour.
      .child(h_flex().w_full().h(32).px(8).gap(4).items_center().rounded(8).overflow_hidden().border_1().border_color(this.qFocused ? t.ring : t.border).bg(fade(t.input, 0.5))
        .child(svg("mods/orca-files/list-filter.svg").size(14).flex_none().text_color(t.muted))
        .child(Input.new(input).flex_1().min_w(0).text_size(12).text_color(t.foreground).bg("#00000000"))
        // FileExplorerNameFilter.tsx:47-62 / SearchQueryRow.tsx:50-51 — Loader2 while the
        // listing or the search runs; X clears the active input and its projection.
        .when((search && this.searching) || (!search && this.nfLoading), el => el.child(svg("mods/orca-files/loader-circle.svg").size(12).flex_none().text_color(t.muted).spin(1000)))
        .when(Boolean(input.value().trim()), el => el.child(div().id("files-clear").p(2).flex_none().rounded(6).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            input.set_value(""); this.hits = null; this.searching = false;
            this.nfMap = null; this.nfCollapsed = new Set(); this.nfLoading = false;
            cx.notify();
          })
          .child(svg("mods/orca-files/x.svg").size(12)))));
  }

  render(cx) {
    // A task's error is reported, not thrown into the paint: a failed refresh
    // must never replace the pane with the shell's "could not be re-rendered" bar.
    //
    // `cx.spawn` runs its body immediately up to the first `await` (scheduler.rs:582 `body.call`),
    // and `refresh()` calls `cx.notify()` before it awaits anything — so spawning it here ran a
    // notify inside the render phase, which the engine refuses. A timer runs after the frame, so
    // the refresh lands in the task phase where notify is allowed.
    if (key() !== this.context?.key) cx.timer.after(0, (cx) => this.refresh(cx));
    const t = theme();
    if (this.prompt) return this.promptView(t);
    if (props()?.tab === "file") return this.menuView(t);
    if (props()?.tab === "more") return this.moreView(t);
    return v_flex().id("files").size_full().min_h(0).overflow_hidden().text_color(t.foreground).text_size(13)
      .when(Boolean(this.file), el => el.child(h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ?? ""))))
      // FileExplorerToolbar.tsx:66-198 (the h-8 title/actions band, above) then
      // FileExplorerQueryStrip.tsx:35-52 (switch + active query input) then the tree.
      .when(!this.file, el => el.child(this.toolbar(t)))
      .when(!this.file, el => el.child(this.queryStrip(t)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().mode("always").py(4)
        .children(this.view === "search"
          ? this.hits?.length
            ? this.hits.map((h, i) => h_flex().id(`hit-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.show(h.file, cx))
                .child(div().flex_1().min_w(0).truncate().text_size(12).child(h.text))
                .child(div().flex_none().text_size(11).text_color(t.dim).child(`${h.file}:${h.line}`)))
            : []
          : this.name.value().trim()
            ? this.rows("", 0, [], t, "name")
            : this.rows("", 0, [], t))
        // FileExplorerFilesTreePane.tsx:116-136 — with a name filter the empty state is a
        // Loader2 while the listing is pending, then "No files match this filter".
        .when(this.view === "files" && Boolean(this.name.value().trim()) && !this.nfMap && this.nfLoading, el => el.child(div().flex_1().flex().items_center().justify_center().child(svg("mods/orca-files/loader-circle.svg").size(16).flex_none().text_color(t.muted).spin(1000))))
        .when(this.view === "files" && Boolean(this.name.value().trim()) && this.nfMap?.size === 0, el => el.child(div().flex_1().flex().items_center().justify_center().px(16).text_center().text_size(11).text_color(t.muted).child("No files match this filter")))
        // FileExplorerTreeStatus.tsx:38-95, FileExplorerFilesTreePane.tsx:131-135 — every empty
        // state is a centred 11px muted line; loading is a bare 16px Loader2. The contents-search
        // no-results copy is SearchResultsPane.tsx:153-158.
        .when(this.view === "search" && this.hits && !this.hits.length && !this.searching, el => el.child(div().flex_1().flex().items_center().justify_center().px(16).text_center().text_size(11).text_color(t.muted).child("No results. Try another search or adjust your filters.")))
        .when(this.view === "files" && !this.name.value().trim() && (this.error || !this.entries.get("")?.length), el => el.child(this.error
          ? div().flex_1().flex().items_center().justify_center().px(16).text_center().text_size(11).text_color(t.muted).child(`Could not load files for this workspace: ${this.error}`)
          : this.loading ? div().flex_1().flex().items_center().justify_center().child(svg("mods/orca-files/loader-circle.svg").size(16).flex_none().text_color(t.muted).spin(1000))
          : div().flex_1().flex().items_center().justify_center().px(16).text_center().text_size(11).text_color(t.muted).child(this.root ? "No files in this workspace" : "Select a workspace to browse files")))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        // The editor is a native element with no scroll API of its own, so it rides the
        // retained scroll container: the same `overflow_y_scrollbar` the tree uses, or a long
        // file cannot be read past the first screen.
        ? div().flex_1().min_h(0).overflow_y_scrollbar().mode("always").child(Editor.new(this.code))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
