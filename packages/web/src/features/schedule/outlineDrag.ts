/**
 * The Schedule outline's pointer drop model (#2954, epic #2946).
 *
 * The design ruling this encodes, recorded so it is not relitigated: **the
 * outline is primary; drag is an alternate skin over the same reparent call.**
 * Drag wins for rearranging an existing tree with a pointer and loses badly for
 * the dominant job — typing forty rows into an empty plan — so it is never the
 * primary path, and every gesture here has a non-drag twin (`⌥→`/`⌥←`/`⌥↑`/`⌥↓`
 * and the row menu's "Move to…").
 *
 * One drop model, three zones per row band:
 *
 *   - the **top and bottom edges** are gaps between rows → *sibling*;
 *   - the **middle** is the row itself → *child*, and a leaf target becomes a
 *     phase (the pointer twin of `⇥`).
 *
 * Two refusals, both stated rather than silently ignored: a **milestone refuses
 * work** ("a gate cannot hold work" — the API returns `child_of_milestone` for
 * exactly this), and a **row refuses its own subtree**.
 *
 * Pure on purpose. The interesting part of a drag is the arithmetic that turns a
 * pointer y into a structural claim, and the sentence that claim makes before
 * the user commits to it — both testable without a renderer, a pointer, or a
 * server. The DOM half lives in `useOutlineDrag`; the mutation half in
 * `ScheduleView`'s `moveRow`.
 */

import { WBS_INDENT } from './scheduleConstants';

/** A row, reduced to what the drop model needs to know about it. */
export interface OutlineDragRow {
  id: string;
  name: string;
  /** Dot-separated WBS path — carries both depth and subtree membership. */
  wbs: string;
  parentId: string | null;
  isMilestone: boolean;
  /** Has structural children — a leaf target is the one that *becomes* a phase. */
  hasChildren: boolean;
}

export type DropRefusalReason = 'own-subtree' | 'milestone';

/**
 * What releasing the pointer right now would do.
 *
 * `level` is always the **destination** depth (1-based), never the target row's
 * — it is what the drop indicator's x-origin is derived from, so a child drop
 * draws one indent step deeper than a sibling drop at the same pointer y. That
 * difference is the whole reason the two are distinguishable before release.
 */
export type DropIntent =
  | { kind: 'none' }
  | { kind: 'refused'; reason: DropRefusalReason; targetId: string; level: number }
  | { kind: 'child'; targetId: string; level: number; becomesPhase: boolean }
  | {
      kind: 'sibling';
      /** The row the insertion line sits against. */
      referenceId: string;
      position: 'before' | 'after';
      newParentId: string | null;
      level: number;
    };

/** WBS depth from the dot-separated path: `1.2.3` → 3. */
export function outlineLevelOf(wbs: string): number {
  return wbs.split('.').length;
}

/** WBS parent path: `1.2.3` → `1.2`, `1` → `''` (root level). */
export function outlineParentPath(wbs: string): string {
  const parts = wbs.split('.');
  return parts.slice(0, -1).join('.');
}

/**
 * Is `row` the dragged row or one of its descendants?
 *
 * Compared on the WBS path rather than by walking `parentId`, so a collapsed or
 * filtered-out intermediate row cannot break the chain. The trailing dot is
 * load-bearing: without it `1.1` would claim `1.10` as a descendant.
 */
function isWithinSubtree(row: OutlineDragRow, dragged: OutlineDragRow): boolean {
  return row.wbs === dragged.wbs || row.wbs.startsWith(`${dragged.wbs}.`);
}

/**
 * Depth-guide x-origin, in px, for a 1-based level.
 *
 * The single shared helper required by web rule 309(a): the drop indicator, the
 * depth guides and a phase's band edge all derive their x from this, so a change
 * to `WBS_INDENT` or to the formula cannot move one without moving the others.
 * `RowContainmentChrome` re-exports it for the marks it owns.
 */
export function outlineGuideX(level: number): number {
  return (level - 1) * WBS_INDENT + 8;
}

/**
 * Edge band, in px, at a fine pointer. A mouse can hit 8px; the middle of a
 * 28px row still leaves 12px for the child zone.
 */
export const FINE_EDGE_PX = 8;

export interface ResolveDropArgs {
  /** Visible rows, in outline order. */
  rows: OutlineDragRow[];
  draggedId: string;
  /** Pointer y in px, relative to the top of the first row. */
  localY: number;
  rowHeight: number;
  /**
   * `pointer: coarse`. A finger cannot aim at an 8px edge, so the band splits
   * into equal thirds instead — the whole row is a drop zone, and the gap zones
   * are as large as the row lets them be.
   */
  coarse?: boolean;
}

/**
 * Turn a pointer position into a structural claim.
 *
 * Returns `{ kind: 'none' }` for a position that would change nothing — dropping
 * a row where it already is is not a refusal, and drawing an indicator for it
 * would promise an edit that never lands.
 */
export function resolveDropIntent(args: ResolveDropArgs): DropIntent {
  const { rows, draggedId, localY, rowHeight, coarse = false } = args;
  if (rows.length === 0 || rowHeight <= 0) return { kind: 'none' };
  const dragged = rows.find((r) => r.id === draggedId);
  if (!dragged) return { kind: 'none' };

  const rawIndex = Math.floor(localY / rowHeight);
  // Past the last row entirely: the only thing below the list is "after it".
  if (rawIndex >= rows.length) return gapAt(rows, rows.length, dragged);
  const index = Math.max(0, rawIndex);
  const offset = localY - index * rowHeight;

  const edge = coarse ? rowHeight / 3 : Math.min(FINE_EDGE_PX, rowHeight / 3);
  if (offset < edge) return gapAt(rows, index, dragged);
  if (offset > rowHeight - edge) return gapAt(rows, index + 1, dragged);
  return ontoRow(rows[index], dragged);
}

/** The gap immediately above `rows[gapIndex]` (or below the last row). */
function gapAt(rows: OutlineDragRow[], gapIndex: number, dragged: OutlineDragRow): DropIntent {
  if (gapIndex >= rows.length) {
    return siblingOf(rows[rows.length - 1], 'after', rows, dragged);
  }
  return siblingOf(rows[gapIndex], 'before', rows, dragged);
}

/**
 * A gap resolves to "sibling of the row it sits against", at that row's level
 * and under that row's parent.
 *
 * Deliberately unambiguous rather than clever. A gap between a deep row and a
 * shallow one could mean any depth in between, and every scheme that tries to
 * infer which one from horizontal pointer drift produces a drop the user did not
 * ask for. Binding the gap to one named row makes the claim readable: the
 * insertion line lands on that row's indent origin, which is the same x its
 * depth guide already runs on.
 */
function siblingOf(
  reference: OutlineDragRow,
  position: 'before' | 'after',
  rows: OutlineDragRow[],
  dragged: OutlineDragRow,
): DropIntent {
  const level = outlineLevelOf(reference.wbs);
  if (reference.id === dragged.id) return { kind: 'none' };

  const parent = reference.parentId ? rows.find((r) => r.id === reference.parentId) : null;
  if (parent && isWithinSubtree(parent, dragged)) {
    return { kind: 'refused', reason: 'own-subtree', targetId: reference.id, level };
  }
  if (parent?.isMilestone) {
    return { kind: 'refused', reason: 'milestone', targetId: reference.id, level };
  }
  return {
    kind: 'sibling',
    referenceId: reference.id,
    position,
    newParentId: reference.parentId,
    level,
  };
}

/** The row's middle band: become its child. */
function ontoRow(target: OutlineDragRow, dragged: OutlineDragRow): DropIntent {
  const level = outlineLevelOf(target.wbs) + 1;
  if (isWithinSubtree(target, dragged)) {
    return { kind: 'refused', reason: 'own-subtree', targetId: target.id, level };
  }
  if (target.isMilestone) {
    return { kind: 'refused', reason: 'milestone', targetId: target.id, level };
  }
  // Already inside it — "into this phase" would claim a move that is a no-op.
  if (target.id === dragged.parentId) return { kind: 'none' };
  return { kind: 'child', targetId: target.id, level, becomesPhase: !target.hasChildren };
}

/**
 * What the drop says before release.
 *
 * `chip` is the short form that rides the target row — the design's "state the
 * consequence, not the mechanism". `sentence` is the same claim spelled out for
 * the polite live region, because a chip pinned to a row the screen reader is
 * not on says nothing.
 */
export interface DropDescription {
  chip: string;
  sentence: string;
  tone: 'ok' | 'refused';
}

export function describeDropIntent(
  intent: DropIntent,
  rows: OutlineDragRow[],
  draggedId: string,
): DropDescription | null {
  if (intent.kind === 'none') return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const draggedName = nameOf(byId.get(draggedId));

  if (intent.kind === 'refused') {
    const target = nameOf(byId.get(intent.targetId));
    if (intent.reason === 'milestone') {
      return {
        chip: 'a gate cannot hold work',
        sentence: `${target} is a milestone — a gate cannot hold work.`,
        tone: 'refused',
      };
    }
    return {
      chip: 'can’t go inside itself',
      sentence: `${draggedName} can’t move inside its own subtree.`,
      tone: 'refused',
    };
  }

  if (intent.kind === 'child') {
    const target = nameOf(byId.get(intent.targetId));
    return intent.becomesPhase
      ? {
          chip: '↳ becomes a phase',
          sentence: `Drop to move ${draggedName} into ${target}, which becomes a phase.`,
          tone: 'ok',
        }
      : {
          chip: 'into this phase',
          sentence: `Drop to move ${draggedName} into ${target}.`,
          tone: 'ok',
        };
  }

  const reference = nameOf(byId.get(intent.referenceId));
  return {
    chip: `same level as ${reference}`,
    sentence: `Drop to place ${draggedName} ${intent.position} ${reference}, at the same level.`,
    tone: 'ok',
  };
}

/** A row with no name yet is a real state — `insertBelow` creates one before the user types. */
function nameOf(row: OutlineDragRow | undefined): string {
  const trimmed = (row?.name ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

/**
 * Where the drop indicator draws, in px within the virtualized row container.
 *
 * `indent` is the destination's guide x, so a child drop's line sits exactly one
 * `WBS_INDENT` deeper than a sibling drop's — the two are told apart by the same
 * x-origin ladder the depth guides already use, not by color alone (rule 6.1).
 */
export interface DropIndicatorGeometry {
  /** Insertion-line y, or null for a target-row highlight with no line. */
  lineTop: number | null;
  /** Row band the consequence chip and any ring belong to. */
  targetTop: number | null;
  indent: number;
}

export function dropIndicatorGeometry(
  intent: DropIntent,
  rows: OutlineDragRow[],
  rowHeight: number,
): DropIndicatorGeometry | null {
  if (intent.kind === 'none') return null;
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id);

  if (intent.kind === 'sibling') {
    const idx = indexOf(intent.referenceId);
    if (idx === -1) return null;
    const lineTop = intent.position === 'before' ? idx * rowHeight : (idx + 1) * rowHeight;
    return { lineTop, targetTop: idx * rowHeight, indent: outlineGuideX(intent.level) };
  }

  const idx = indexOf(intent.targetId);
  if (idx === -1) return null;
  return {
    // A child drop lands at the END of the target's children, so its line sits
    // on the target's bottom edge — one indent step in, which is what tells it
    // apart from the sibling drop at the same pointer y.
    lineTop: intent.kind === 'child' ? (idx + 1) * rowHeight : null,
    targetTop: idx * rowHeight,
    indent: outlineGuideX(intent.level),
  };
}

/**
 * The structural move a drop asks for, as a *position anchor* rather than a
 * finished sibling list.
 *
 * Deliberately not an `ordered_ids` array. The reorder endpoint rejects a
 * partial list (400 `Missing siblings from ordered_ids`), and the rows this
 * module sees are the **visible** ones — filtered, collapsed. Resolving the
 * complete destination level is the job of the one caller that holds every task
 * (`ScheduleView`), so the plan names the anchor and lets it do that.
 */
export interface OutlineMovePlan {
  taskId: string;
  /** null = root level. */
  newParentId: string | null;
  /** Place immediately before this sibling; null = append at the end. */
  beforeSiblingId: string | null;
  /** Destination row's name, for the trail sentence. */
  destinationName: string | null;
  /** The target was a leaf and gains its first structural child. */
  becomesPhase: boolean;
}

/** Null for a refusal, a no-op, or an intent whose rows are no longer present. */
export function planOutlineMove(
  intent: DropIntent,
  rows: OutlineDragRow[],
  draggedId: string,
): OutlineMovePlan | null {
  if (intent.kind === 'none' || intent.kind === 'refused') return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dragged = byId.get(draggedId);
  if (!dragged) return null;

  if (intent.kind === 'child') {
    const target = byId.get(intent.targetId);
    if (!target) return null;
    return {
      taskId: draggedId,
      newParentId: target.id,
      beforeSiblingId: null,
      destinationName: target.name,
      becomesPhase: intent.becomesPhase,
    };
  }

  const reference = byId.get(intent.referenceId);
  if (!reference) return null;
  const parent = intent.newParentId ? byId.get(intent.newParentId) : null;
  return {
    taskId: draggedId,
    newParentId: intent.newParentId,
    beforeSiblingId: intent.position === 'before' ? reference.id : nextSiblingAfter(rows, reference),
    destinationName: parent?.name ?? null,
    becomesPhase: false,
  };
}

/**
 * The sibling that follows `reference` at its own level, or null when it is the
 * last one. "After X" is expressed as "before whatever follows X" so the anchor
 * has a single shape — and skipping X's own descendants on the way is what keeps
 * "after a phase" from meaning "before its first child".
 */
function nextSiblingAfter(rows: OutlineDragRow[], reference: OutlineDragRow): string | null {
  const idx = rows.findIndex((r) => r.id === reference.id);
  if (idx === -1) return null;
  for (let i = idx + 1; i < rows.length; i++) {
    if (rows[i].parentId === reference.parentId) return rows[i].id;
  }
  return null;
}

/**
 * Candidate destinations for the row menu's "Move to…" (#2954).
 *
 * The same refusals as the drag, applied up front: a milestone cannot hold work,
 * and a row cannot move inside its own subtree. Rows already holding the dragged
 * row are kept — moving a row to where it already is is inert, not wrong, and
 * hiding its current home from the list makes the list harder to read.
 */
export interface MoveDestination {
  id: string | null;
  name: string;
  level: number;
  becomesPhase: boolean;
  isCurrentParent: boolean;
}

export function moveDestinations(
  rows: OutlineDragRow[],
  draggedId: string,
  rootLabel = 'Top level',
): MoveDestination[] {
  const dragged = rows.find((r) => r.id === draggedId);
  if (!dragged) return [];
  const out: MoveDestination[] = [
    {
      id: null,
      name: rootLabel,
      level: 0,
      becomesPhase: false,
      isCurrentParent: dragged.parentId === null,
    },
  ];
  for (const row of rows) {
    if (isWithinSubtree(row, dragged)) continue;
    if (row.isMilestone) continue;
    out.push({
      id: row.id,
      name: nameOf(row),
      level: outlineLevelOf(row.wbs),
      becomesPhase: !row.hasChildren,
      isCurrentParent: row.id === dragged.parentId,
    });
  }
  return out;
}
