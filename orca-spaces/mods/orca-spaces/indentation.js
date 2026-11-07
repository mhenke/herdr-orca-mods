// Port of orca src/renderer/src/components/sidebar/worktree-list/rows/indentation.ts.
// Every card inset in Orca is derived here, so the constants are the only place a width
// can change. Hard-coding the results per row is what let the lane, indent and title drift.

export const SIDEBAR_TREE_INDENT = 18;
const PROJECT_WORKTREE_CARD_EXTRA_INDENT = 2;
export const FLUSH_CARD_CONTENT_PULLBACK = 4;
export const NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK = 8;
export const FLUSH_CARD_MIN_CONTENT_INSET = 2;
export const WORKTREE_CARD_SURFACE_MARGIN = 4;
// The legacy status lane's box is its unread button, `size-4` = 16px
// (`surface/WorktreeCardStatusSlot.tsx:246-247`); the lane div itself has no width
// (`surface/worktree-card-status-lane.tsx:19-23`). Ours is a bare 12px mark, so the slot has to
// make up the other 4px or every title sits 4px left of its group-header label.
export const LEGACY_STATUS_LANE_WIDTH = 16;
// The card always draws `border border-transparent` (`surface/worktree-card-surface.tsx:71-76`),
// so the active border never shifts the title by 1px.
export const WORKTREE_CARD_BORDER_WIDTH = 1;
// Header label inset inside its group header: a 16px icon slot plus `gap-1.5`
// (`worktree-list/rows/SectionHeader.tsx:249,328`).
const HEADER_ICON_SLOT = 16;
const HEADER_ICON_GAP = 6;
// The card's lane-to-text gap (`card-primitives.tsx:8-13` gap xs = `gap-0.5` = 2px;
// `worktree-card-parent-content.tsx` root row `gap-xs`).
const CARD_ROW_GAP = 2;
export const LINEAGE_IMMEDIATE_PARENT_STEP = SIDEBAR_TREE_INDENT + PROJECT_WORKTREE_CARD_EXTRA_INDENT;
export const LINEAGE_CHILDREN_INLINE_OFFSET =
  LINEAGE_IMMEDIATE_PARENT_STEP - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET;
// Why: header icon+gap vs. card margin+border+legacy lane+gap minus the pullback lands the title
// on the header label. Derived, not nudged: change a lane width and the anchor follows.
const GROUPED_CARD_TITLE_HEADER_LABEL_OFFSET =
  HEADER_ICON_SLOT + HEADER_ICON_GAP - (WORKTREE_CARD_SURFACE_MARGIN + WORKTREE_CARD_BORDER_WIDTH + LEGACY_STATUS_LANE_WIDTH + CARD_ROW_GAP - FLUSH_CARD_CONTENT_PULLBACK);
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10;
const PROJECT_GROUP_HEADER_INDENT = 10;
const MAX_PROJECT_GROUP_HEADER_DEPTH = 6;

const clampDepth = (d) => Math.max(0, Math.floor(Number.isFinite(d) ? d : 0));

export function getProjectGroupHeaderPaddingLeft(depth) {
  return PROJECT_GROUP_HEADER_BASE_PADDING + Math.min(clampDepth(depth), MAX_PROJECT_GROUP_HEADER_DEPTH) * PROJECT_GROUP_HEADER_INDENT;
}

export function getWorktreeCardContentIndent({ isGrouped, groupDepth, lineageDepth }) {
  const lineageIndent = clampDepth(lineageDepth) * SIDEBAR_TREE_INDENT;
  return isGrouped
    ? getProjectGroupHeaderPaddingLeft(groupDepth) + GROUPED_CARD_TITLE_HEADER_LABEL_OFFSET + lineageIndent
    : lineageIndent;
}

// `folder-row.tsx:89` uses these instead of the plain card path whenever the row is a
// folder-backed workspace child (`groupBy === 'repo' && createdFrom === 'folder-scan'`).
export function getFolderWorkspaceCardContentIndent({ groupDepth }) {
  // Folder workspaces are direct children of their folder group, so they align to its label.
  const parentGroupDepth = Math.max(0, clampDepth(groupDepth) - 1);
  return getProjectGroupHeaderPaddingLeft(parentGroupDepth) + GROUPED_CARD_TITLE_HEADER_LABEL_OFFSET;
}

export function getFolderWorkspaceCardSurfaceInset({ isGrouped, groupDepth }) {
  const contentAnchor = getFolderWorkspaceCardContentIndent({ groupDepth });
  const maxSurfaceInset = contentAnchor - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET;
  // Caps deep surfaces so flush-card margin plus minimum padding keep the anchor compact.
  return Math.min(getWorktreeCardSurfaceInset({ isGrouped, groupDepth }), Math.max(0, maxSurfaceInset));
}

export function getWorktreeCardSurfaceInset({ isGrouped, groupDepth }) {
  // Steps with group headers so each card edge keeps the same offset from its header icon.
  return isGrouped ? getProjectGroupHeaderPaddingLeft(groupDepth) - PROJECT_GROUP_HEADER_BASE_PADDING : 0;
}

// `getFlushWorktreeCardPaddingLeft`: the new card's lane is 8px wider than the legacy one,
// and the pullback keeps the title on the header's label.
export function getFlushWorktreeCardPaddingLeft(contentIndent, applyNewCardStyleStatusLaneOffset = false) {
  const pullback = FLUSH_CARD_CONTENT_PULLBACK + (applyNewCardStyleStatusLaneOffset ? NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK : 0);
  return contentIndent > 0
    ? Math.max(FLUSH_CARD_MIN_CONTENT_INSET, contentIndent - pullback)
    : FLUSH_CARD_MIN_CONTENT_INSET;
}

export function getNewCardStyleParentContentMarginLeft(contentIndent) {
  if (contentIndent <= 0) return 0;
  const legacyInnerPadding = Math.max(FLUSH_CARD_MIN_CONTENT_INSET, contentIndent - FLUSH_CARD_CONTENT_PULLBACK);
  const newInnerPadding = Math.max(FLUSH_CARD_MIN_CONTENT_INSET, contentIndent - FLUSH_CARD_CONTENT_PULLBACK - NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK);
  const paddingShift = legacyInnerPadding - newInnerPadding;
  const remainingShift = NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK - paddingShift;
  if (remainingShift <= 0) return 0;
  // Shallow rows hit the padding floor; finish with margin but never pass the inner edge.
  return Math.max(-newInnerPadding, -remainingShift);
}
