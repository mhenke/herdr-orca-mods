// Clipboard and reveal, without a shell helper: exec() has no stdin, so text
// goes through a temp file. Copied into each mod that needs it — a mod cannot
// import outside its own folder (herdr-t3/scripts/sync.sh:10).
import { exec, appHome } from "herdr";

let tool = null;

async function pick() {
  if (tool) return tool;
  for (const [cmd, args] of [["wl-copy", ["--version"]], ["xclip", ["-version"]], ["pbcopy", []], ["powershell.exe", ["-NoProfile", "-Command", "exit"]]]) {
    try { if ((await exec(cmd, args)).code === 0) return (tool = cmd); } catch {}
  }
  return (tool = null);
}

export async function copyText(text) {
  const cmd = await pick();
  if (!cmd) return;
  const tmp = `${appHome()}/data/.clip-${Date.now()}`;
  await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', "copy", tmp, text]);
  const flags = cmd === "xclip" ? ["-selection", "clipboard"] : [];
  await exec("sh", ["-c", '"$@" < "$0"', tmp, cmd, ...flags]);
  await exec("rm", ["-f", tmp]);
}

export async function reveal(path) {
  const dir = path.replace(/\/[^/]*$/, "") || path;
  for (const [cmd, args] of [["xdg-open", [dir]], ["open", [dir]], ["explorer.exe", [dir]]]) {
    try { if ((await exec(cmd, args)).code === 0) return; } catch {}
  }
}