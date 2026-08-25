import { LINK_TYPES, LINK_TYPE_PROSE_NAME } from './linkTypes';
import type { LinkType } from '@/types';

/**
 * The row's dependency flag — what the Links cell states at rest (#3023).
 *
 * ## Why a type and not a count
 *
 * The shipped row carried `←2` / `→1` count chips. A count cannot distinguish
 * two finish-to-start links from a finish-to-start and a start-to-start, and
 * that is the difference between **a chain and an overlap** — the schedule-shape
 * question a planner is actually asking when they glance at a row. So the flag
 * names the types: `FS×2` when the links agree, `FS·SS` when they differ
 * (`design_handoff_trueppm_v4/README.md`, "Dependency flags name the types
 * rather than only counting them").
 *
 * ## The three-or-more case, which the design does not specify
 *
 * `FS·SS·FF` is where the dot form stops being scannable: it grows with the
 * graph, it is the widest thing in a 76px cell, and at a glance it reads as
 * noise rather than as a shape. The row's job here is to say *which* of three
 * situations this is — all one type, two types, or genuinely mixed — and hand
 * the detail to the tooltip, which is exactly the split the design states
 * ("with the full detail in the tooltip and the picker"). So:
 *
 * | Distinct types | Flag | Reads as |
 * |---|---|---|
 * | 1 | `FS` (n=1) / `FS×3` | a chain |
 * | 2 | `FS·SS` | an overlap |
 * | 3+ | `Mixed×4` | go look |
 *
 * `Mixed×N` counts **links**, not types, so the count means the same thing in
 * every row of that table and the flag never has two counting rules.
 *
 * Everything here is pure and takes the edge summaries as an argument, so the
 * flag is unit-testable without mounting a row.
 */

/** One incoming or outgoing edge, reduced to what the flag and tooltip need. */
export interface DepEdgeSummary {
  type: LinkType;
  /** Calendar-day lag; negative is a lead. Surfaced in the tooltip only. */
  lag: number;
}

export type DepDirection = 'predecessor' | 'successor';

export interface DepFlag {
  /** The scannable token — `FS`, `FS×2`, `FS·SS`, `Mixed×4`. */
  label: string;
  /** Full detail: how many, of which types, at what lag, and whether critical. */
  detail: string;
}

/**
 * Canonical type order. The flag must read the same for a row whose links
 * arrived FS-then-SS as for one whose links arrived SS-then-FS — otherwise two
 * identical schedule shapes get two different tokens and the flag stops being
 * comparable down a column.
 */
const TYPE_ORDER: readonly LinkType[] = LINK_TYPES;

/** Prose names, for the tooltip — see `linkTypes` on why these differ from the
 *  arrow labels a control uses. */
const TYPE_NAMES: Record<LinkType, string> = LINK_TYPE_PROSE_NAME;

/**
 * Distinct types present, canonical first and anything unrecognized after.
 *
 * `dep_type` is cast, not validated, on the way in (`useScheduleTasks`
 * `mapDependency`), so a server that grows a fifth type reaches here as a string
 * outside `TYPE_ORDER`. Filtering `TYPE_ORDER` alone would return an EMPTY list
 * for such a row and drop it into the `Mixed×N` arm — a single link rendering
 * `Mixed×1`, which is a confident wrong statement rather than an honest one.
 * Echo the code the server sent instead: `XX×2` says exactly what is known.
 */
function distinctTypes(edges: readonly DepEdgeSummary[]): LinkType[] {
  const out = TYPE_ORDER.filter((t) => edges.some((e) => e.type === t));
  for (const e of edges) {
    if (!TYPE_ORDER.includes(e.type) && !out.includes(e.type)) out.push(e.type);
  }
  return out;
}

/** Signed calendar-day lag suffix (`+2d` / `-1d`), or '' when there is none. */
function lagSuffix(lag: number): string {
  if (!lag) return '';
  return lag > 0 ? ` +${lag}d` : ` ${lag}d`;
}

/**
 * The flag for one direction's edges, or `null` when there are none.
 *
 * `null` rather than an empty label because "no links" is not a shape — the
 * cell renders its own empty affordance for that, and a caller that got `''`
 * back would have to decide what an empty label means all over again.
 */
export function depFlag(
  edges: readonly DepEdgeSummary[],
  direction: DepDirection,
  isCritical = false,
): DepFlag | null {
  if (edges.length === 0) return null;

  const distinct = distinctTypes(edges);

  let label: string;
  if (distinct.length === 1) {
    label = edges.length === 1 ? distinct[0] : `${distinct[0]}×${edges.length}`;
  } else if (distinct.length === 2) {
    label = `${distinct[0]}·${distinct[1]}`;
  } else {
    label = `Mixed×${edges.length}`;
  }

  return { label, detail: describeEdges(edges, direction, isCritical) };
}

/**
 * The tooltip sentence — `2 predecessors: Finish-to-Start, Start-to-Start +2d`.
 *
 * Identical (type, lag) pairs collapse to `2 × Finish-to-Start` so a four-link
 * FS chain does not read as the same phrase four times; a differing lag keeps
 * its own entry, because two FS links at +0d and +5d are not the same link
 * twice and collapsing them would state something false.
 *
 * Criticality is stated in WORDS, not left to the chip's red tint. The tint is
 * the only carrier a sighted mouse user has, and it is no carrier at all for a
 * screen-reader user or for anyone with a red deficiency — a WCAG 1.4.1 failure
 * on the one fact that changes what the reader does next. It was survivable
 * while the chips appeared only on a selected row; a column at rest makes it
 * load-bearing.
 *
 * The group list is capped: a hub row with dozens of distinct (type, lag) pairs
 * would otherwise produce a multi-kilobyte `aria-label` and a tooltip nobody can
 * read. Past the cap the sentence says how many it did not name.
 */
const MAX_DETAIL_GROUPS = 4;

function describeEdges(
  edges: readonly DepEdgeSummary[],
  direction: DepDirection,
  isCritical: boolean,
): string {
  const groups = new Map<string, { type: LinkType; lag: number; count: number }>();
  for (const e of edges) {
    const key = `${e.type}|${e.lag}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { type: e.type, lag: e.lag, count: 1 });
  }

  const ordered = [...groups.values()].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.lag - b.lag,
  );

  const parts = ordered
    .slice(0, MAX_DETAIL_GROUPS)
    .map(
      (g) =>
        `${g.count > 1 ? `${g.count} × ` : ''}${TYPE_NAMES[g.type] ?? g.type}${lagSuffix(g.lag)}`,
    );
  if (ordered.length > MAX_DETAIL_GROUPS) {
    parts.push(`and ${ordered.length - MAX_DETAIL_GROUPS} more`);
  }

  const heading = `${edges.length} ${direction}${edges.length === 1 ? '' : 's'}`;
  const critical = isCritical ? ' — on the critical path' : '';
  return `${heading}: ${parts.join(', ')}${critical}`;
}

/**
 * The whole cell's accessible description — both directions in one sentence,
 * or the empty statement.
 *
 * Takes the two already-derived flags rather than the raw edges: the cell needs
 * each flag for its chip anyway, and deriving them twice meant building and
 * discarding a second copy of every detail string on every row of a virtualized
 * list.
 *
 * The `taskName` is in it because the outline announces rows by name and a bare
 * "2 predecessors" is unattributable once focus has moved.
 */
export function describeLinksCell(
  pred: DepFlag | null,
  succ: DepFlag | null,
  taskName: string,
): string {
  const parts = [pred?.detail, succ?.detail].filter((d): d is string => d !== undefined);
  if (parts.length === 0) return `Links: none for ${taskName}`;
  return `Links for ${taskName} — ${parts.join('; ')}`;
}

/**
 * Per-task dependency data — computed once in ScheduleView over the whole link
 * graph, passed down to the row's Links cell (#3023).
 *
 * Carries the **edges**, not counts: a count is `preds.length`, and holding both
 * would be one fact with two writers, which is how the two get to disagree
 * (#2960 found exactly that on `widths.task`). The types are what the flag names
 * and the lags are what its tooltip states, so the row needs the edges anyway.
 *
 * It lives here rather than beside the panel that passes it down so the row and
 * the panel can both name it without importing each other.
 */
export interface TaskDepChips {
  /** Incoming edges — what governs this row's start. */
  preds: DepEdgeSummary[];
  /** Outgoing edges — what this row governs. */
  succs: DepEdgeSummary[];
  predsCritical: boolean;
  succsCritical: boolean;
}
