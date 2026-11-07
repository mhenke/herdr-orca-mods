// The status mark for a card or an agent row.
//
// Herdr's model already rolls status up: `Model::rollup` (model.rs:554) reduces an agent set to
// the most urgent of `working | blocked | done | idle`, and `Model::status` (model.rs:528) maps
// the raw word there — `blocked` and `error` both land on "blocked". `space.status` and
// `tab.status` are that rollup; an agent's own `status` is the same vocabulary. So neither the
// ranking nor the `error` mapping belongs here; re-deriving them is how the card and its rows
// came to disagree with the app.
//
// Ported from `StatusIndicator.tsx`, which is a box plus a different mark per state — not a dot
// per state. Every branch is `inline-flex h-3 w-3 shrink-0 items-center justify-center` (a 12px
// box) holding something smaller:
//
//   working  <AgentWorkingSpinner className="size-2" />  — 8px ring, `border-2
//            border-agent-working border-t-transparent` (AgentWorkingSpinner.tsx:38-41), so a
//            yellow ring with a gap, NOT a filled dot. The gap is what the rotation reads as.
//   done     <span className="block size-2 rounded-full bg-emerald-500" />         (8px dot)
//   idle     <span className="block size-2 rounded-full bg-neutral-500/40" />     (8px, 40% alpha)
//   permission  <AgentQuestionIcon className="size-3" /> — a full 12px glyph, the only branch
//            that fills the box. Herdr's `blocked` is Orca's `permission`.
// Orca also has `failed` (6px red-500 dot) and `interrupted` (6px muted dot). They are not
// ported: Herdr's `Model::status` (model.rs:528-536) only ever returns `working`, `blocked`,
// `done` or `idle` — `blocked | error` both fold into "blocked" before reaching a mod — so a
// branch for either would be dead code pretending to be parity.
//
// `working` is the case an 8px filled dot gets wrong: at a glance it reads as `done`.
//
// Two vocabularies, deliberately: this file's `statusMark` is the card lane's
// `StatusIndicator` (12px box, 8px inner, `done` = emerald dot), while `agentStateMark` is
// `AgentStateDot size="sm"` for agent rows (10px box, 6px inner, `done` = CircleCheck) —
// `src/renderer/src/components/AgentStateDot.tsx:22-23`: "completion uses a check while sidebar StatusIndicator uses an
// emerald dot/tooltip". One mark for both is the bug this split fixes.
import { div, svg } from "gpui-kit";

// Tailwind v4 defaults, resolved from the token vars (`main.css:254-258`):
//   --agent-question: var(--color-orange-600)   --agent-working: var(--color-yellow-500)
export const STATUS_COLORS = {
  blocked: "#ea580c", // orange-600
  working: "#eab308", // yellow-500
  done: "#10b981", // emerald-500
  idle: "#73737366", // neutral-500 at 40%
};

// The 12px box every branch shares (`h-3 w-3`).
const box = (size) => div().size(size).flex_none().flex().items_center().justify_center();

// An inner dot inside the box: 8px for the card lane (`size-2`), 6px for an agent row
// (`size-1.5`).
const dot = (size, inner, color) => box(size).child(div().size(inner).rounded_full().flex_none().bg(color));

/**
 * `size` is the box, defaulting to Orca's 12 (`h-3 w-3`). Inner marks do not scale with it:
 * `size-2`/`size-1.5`/`size-3` are fixed in `StatusIndicator.tsx`, which is why this takes only
 * the box and keeps every mark at its own literal.
 */
export function statusMark(status, size = 12) {
  if (status === "blocked") {
    // `permission`: the one branch that fills the box (`size-3`).
    return box(size).child(
      svg("mods/orca-spaces/message-circle-question.svg").size(size).flex_none().text_color(STATUS_COLORS.blocked),
    );
  }
  if (status === "working") {
    // `AgentWorkingSpinner`: `size-2` ring, `border-2` in agent-working with a transparent top
    // (`AgentWorkingSpinner.tsx:38-41`) — an 8px circle with a gap, turning forever.
    // Herdr's `border_color` colours all four sides and has no per-side colour, so the ring is
    // an SVG arc with a real gap; and `spin(ms)` turns an svg natively at ~30fps, only while
    // drawn (`gpui-kit.d.ts:1215-1220`, "Turns an `svg` once every `ms`, forever ... draw an
    // arc"). Orca runs `rotate(86400turn)` over `86400s` (main.css:1830-1837) — exactly 1
    // revolution per second, so 1000ms here.
    return box(size).child(
      svg("mods/orca-spaces/agent-working-spinner.svg").size(12).flex_none()
        .text_color(STATUS_COLORS.working).spin(1000),
    );
  }
  // `done`/`active` share emerald; everything else falls to the quiet idle dot.
  return dot(size, 8, STATUS_COLORS[status] ?? STATUS_COLORS.idle);
}

// `AgentStateDot` at its default `size="sm"` (`src/renderer/src/components/AgentStateDot.tsx:114-116`): a 10px box
// (`h-2.5 w-2.5`), a 6px dot or spinner (`size-1.5`), a 10px glyph (`size-2.5`).
// `done` is the `CircleCheck` branch (`:148-157`), not an emerald dot — the card lane keeps
// its dot. `working` is the same 6px ring the card draws at 12px; the asset scales.
export function agentStateMark(status) {
  const size = 10, inner = 6;
  if (status === "blocked") {
    // `permission`/`waiting` (`:165-172`): the question glyph, `size-2.5` at this size.
    return box(size).child(
      svg("mods/orca-spaces/message-circle-question.svg").size(size).flex_none().text_color(STATUS_COLORS.blocked),
    );
  }
  if (status === "working") {
    // `src/renderer/src/components/AgentStateDot.tsx:126-134` -> `AgentWorkingSpinner className="size-1.5"`.
    return box(size).child(
      svg("mods/orca-spaces/agent-working-spinner.svg").size(inner).flex_none()
        .text_color(STATUS_COLORS.working).spin(1000),
    );
  }
  if (status === "done") {
    return box(size).child(
      svg("mods/orca-spaces/circle-check.svg").size(size).flex_none().text_color(STATUS_COLORS.done),
    );
  }
  return dot(size, inner, STATUS_COLORS[status] ?? STATUS_COLORS.idle);
}
