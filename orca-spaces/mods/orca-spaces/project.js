// Marks for the Projects list. Orca's RepoIconGlyph draws a lucide icon, `Folder` by default,
// and only uses an image when the user set one on the repo. Herdr stores no per-space icon, so
// every repo draws the folder; scraping favicons off disk (T3's ProjectFavicon) put site logos
// in the header, which Orca never shows.
import { svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, exec } from "herdr";

// T3's project colors in its order, each as Tailwind's 400 (dark themes) and 600 (light).
const PALETTE = [
  ["#9ca3af", "#4b5563"], ["#f87171", "#dc2626"], ["#fb923c", "#ea580c"], ["#fbbf24", "#d97706"],
  ["#facc15", "#ca8a04"], ["#a3e635", "#65a30d"], ["#4ade80", "#16a34a"], ["#34d399", "#059669"],
  ["#2dd4bf", "#0d9488"], ["#22d3ee", "#0891b2"], ["#38bdf8", "#0284c7"], ["#60a5fa", "#2563eb"],
  ["#818cf8", "#4f46e5"], ["#a78bfa", "#7c3aed"], ["#c084fc", "#9333ea"], ["#e879f9", "#c026d3"],
  ["#f472b6", "#db2777"], ["#fb7185", "#e11d48"],
];

// As T3: the name, folded, hashed into the palette, so a name has one color everywhere.
export function tint(name, dark) {
  const seed = name.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let i = 0;
  for (const g of seed) i = (i * 31 + g.codePointAt(0)) % PALETTE.length;
  return PALETTE[i][dark ? 0 : 1];
}

// RepoIconGlyph's fallback branch: lucide `Folder` at the tile's size, in the header's foreground.
// SectionHeader.tsx:328-338: a `size-4` (16px) slot holding RepoIconGlyph with
// `iconClassName="size-3.5"` (14px), colored by resolveProjectGroupHeaderColor ->
// resolveRepoHeaderColor, which returns DEFAULT_REPO_BADGE_COLOR (#737373) when the repo
// sets no badge color. That inline color wins over the wrapper's text-muted-foreground.
const REPO_BADGE_COLOR = "#737373";

// `shared/repo-icon.ts` `githubAvatarIcon`: `https://<host>/<owner>.png?size=64`, host
// `github.com` unless a GHES host is configured, and `isSupportedImageSrc` accepts only an
// owner-avatar path (`/^\/[^/?#]+\.png$/i`).
//
// Which owner is `getRepoUpstream` in `main/github/client/fetch/repo-slug-upstream.ts`: an
// `upstream` remote wins when it differs from origin, else `gh repo view --json isFork,parent`
// names the fork's parent. `githubAvatarSlug` (shared/repo-icon.ts) then keeps origin only when
// the fork was RENAMED (`origin.repo !== upstream.repo`), because a same-name fork shows the
// parent's avatar while a renamed one keeps its own identity.
export function parseRemote(remoteUrl) {
  const m = String(remoteUrl ?? "").trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m || !/^[A-Za-z0-9-]+$/.test(m[2]) || !m[3]) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
}

export function avatarUrlFor({ host, owner }) {
  return /^[A-Za-z0-9-]+$/.test(owner) ? `https://${host}/${owner}.png?size=64` : null;
}

const avatarPath = (url) => `avatars/${url.replace(/[^A-Za-z0-9.-]+/g, "_")}.png`;
const avatarTried = new Set();
const avatarWritten = new Set();

// RepoIconGlyph prefers the repo's image; Herdr has no per-repo icon, so a repo whose origin
// names a GitHub owner gets Orca's owner avatar (`githubAvatarIcon`). `image()` takes a path
// under the app folder, so the first sight downloads once to `avatars/<host>_<owner>.png`; a
// failed download leaves the lucide Folder, which is what repo-icon.tsx:158 `onError` falls
// back to. `fetch` returns text only (`ShellFetchResponse`), so the bytes come from curl.
export function ensureAvatar(url, cx) {
  if (!url || avatarTried.has(url)) return;
  avatarTried.add(url);
  const path = `${appHome()}/${avatarPath(url)}`;
  // `cx` here is the render's own handle, and the download outlives it: notifying through it
  // throws "cx is no longer valid: it was captured during an earlier call and used later".
  // Spawn so the notify belongs to a live callback, which is what that error asks for.
  cx.spawn(async (cx) => {
  try {
    const { default: fsp } = await import("fs/promises");
    try {
      await fsp.access(path);
    } catch {
      await fsp.mkdir(`${appHome()}/avatars`, { recursive: true });
      const r = await exec("curl", ["-sfL", "--max-time", "10", url, "-o", path]);
      if (r.code !== 0) return;
    }
    avatarWritten.add(url);
    cx.notify();
  } catch (e) { console.log("avatar", url, String(e)); }
  });
}

export const avatarFile = (url) => (url && avatarWritten.has(url) ? avatarPath(url) : null);

export function repoMark(s, size, t, ps, avatarUrl) {
  const file = avatarFile(avatarUrl);
  return h_flex().size(size).flex_none().items_center().justify_center().rounded(4).overflow_hidden()
    .child(file
      ? image(file).size(16)
      : svg("mods/orca-spaces/folder.svg").size(14).text_color(REPO_BADGE_COLOR));
}
