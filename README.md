# Herdr Orca Mods

Standalone mods ported from [Orca](https://github.com/stablyai/orca) for [Herdr App](https://herdr.dev).

If you already have a Herdr layout you like (such as the default `main` layout or `herdr-t3`), but want Orca's file tree, Git staging panel, worktree grouping, or flat tabs, you can drop any of these mods right into your existing setup without adopting the full Orca layout.

Every mod here is self-contained. Each folder includes its own code, SVG icons, and a complete recipe.

## Available mods

| Mod | What it does |
|---|---|
| [`orca-files/`](orca-files/) | Full-bleed file tree with 30+ extension icons, a Names filter, a regex and glob Contents search, and Git status rollups. |
| [`orca-changes/`](orca-changes/) | Git changes inspector with staged and unstaged file lists, per-file diff views, and an inline commit composer. |
| [`orca-spaces/`](orca-spaces/) | Worktree sidebar with collapsible project headers, primary badges on main checkouts, and live agent status marks. |
| [`new-menu/`](new-menu/) | 288px create dropdown for launching agents (OpenCode, Antigravity, Claude Code, Codex), opening folders, or adding Git worktrees. |
| [`orca-tabs/`](orca-tabs/) | Flat tab strip with full-width 2px bottom underline indicators, tab color dots, and an integrated sidebar toggle button. |
| [`orca-status/`](orca-status/) | Slim 24px bottom status bar showing your branch, dirty file count, ahead/behind sync stats, and active agent status. |

## How to use a mod

Adding a mod to your setup takes three quick steps:

1. Copy the mod folder into your Herdr directory (`~/.config/herdr-app/mods/`):
   ```sh
   cp -r <mod-folder>/mods/<name> ~/.config/herdr-app/mods/
   ```
2. Reference the mod name in your layout JSON (e.g. `~/.config/herdr-app/layouts/my-layout.json`) inside any block:
   ```json
   {
     "type": "block",
     "content": {
       "mod": "orca-files"
     }
   }
   ```
3. Verify the mod loads cleanly:
   ```sh
   herdr-app check ~/.config/herdr-app/mods/<name>
   ```

## Recipes

Every mod folder includes a `RECIPE.md` written to Herdr Community standards. It details the exact geometry, behaviors, Herdr API contracts, and verification checks needed to build or adapt the mod from scratch.

## Credits and license

Ported from [stablyai/orca](https://github.com/stablyai/orca) (MIT License, Copyright Orca). Licensed under Apache-2.0, matching Herdr App.
