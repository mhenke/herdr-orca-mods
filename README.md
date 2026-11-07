# Herdr Orca Mods

A collection of [Orca](https://github.com/stablyai/orca)-inspired standalone mods for [Herdr App](https://herdr.dev).

Every mod in this repository is self-contained and can be dropped into any Herdr layout to upgrade specific window panels with Orca's aesthetics, geometry, and behaviors.

## Included Mods

| Mod | Category | Description |
|---|---|---|
| [`orca-files/`](orca-files/) | Explorer | Full-bleed file explorer tree with 30+ extension icons, live debounced filter input, and Git status rollups. |
| [`orca-changes/`](orca-changes/) | Source Control | Git changes inspector with staged/unstaged partitioning, diff viewer, and commit composer. |
| [`orca-spaces/`](orca-spaces/) | Sidebar | Project group hierarchy, worktree cards with primary badge, and aggregated agent status marks. |
| [`new-menu/`](new-menu/) | Launcher | 288px create dropdown for launching agents, opening folders, and creating worktrees. |
| [`orca-tabs/`](orca-tabs/) | Chrome | Flat tabs strip with 2px bottom active underline indicator and sidebar toggle. |
| [`orca-status/`](orca-status/) | Status | Minimal 24px bottom status bar with git indicators and agent turn status. |

## Installing a Mod

To add any mod to your Herdr App setup:

1. Copy the `mods/<name>/` folder into your Herdr config directory:
   ```sh
   cp -r <mod-folder>/mods/<name> ~/.config/herdr-app/mods/
   ```
2. Reference the mod name in your layout JSON (e.g. `~/.config/herdr-app/layouts/<name>.json`) inside any block's content:
   ```json
   {
     "type": "block",
     "content": {
       "mod": "orca-files"
     }
   }
   ```
3. Test with `herdr-app check ~/.config/herdr-app/mods/<name>`.

## Recipes

Each mod contains a `RECIPE.md` detailing its exact geometry, behaviors, Herdr API contracts, and verification criteria following the Herdr Community specification.
