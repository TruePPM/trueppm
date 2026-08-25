/**
 * What Group / Ungroup did, in words (#2955, epic #2946).
 *
 * The design's rule for this copy is the same one `structuralActs.ts` follows —
 * **state the consequence, not the mechanism** — with one addition that is specific
 * to these two acts and is the reason this module exists separately.
 *
 * The server applies two selection rules of its own: it drops any row whose own
 * ancestor is also selected, and it groups on the parent shared by most of the
 * remainder. So a group can legitimately wrap **fewer rows than the user selected**,
 * and the issue is explicit that the user has to be told when that happened. A group
 * that silently wrapped four of six rows reads as a bug, and the person who would
 * notice is the person who selected the other two on purpose.
 *
 * Two consequences for the shape of this file:
 *
 *  - **Nothing here re-derives the selection rules.** `left_alone` is a server fact
 *    and is rendered from the response, never predicted from the client's own tree.
 *    A client-side mirror of a server-owned classification is web rule 301's failure
 *    mode, and here it would produce a *confident wrong* account of what the user's
 *    plan now looks like.
 *  - **An unrecognized reason still says something true.** The reason vocabulary can
 *    grow server-side without this file. An unknown token takes the cautious branch —
 *    it is counted and named rather than dropped, and it is humanized rather than
 *    leaking `some_new_reason` into a sentence (rule 301(b), 301(c)).
 *
 * Pure on purpose: the wording is the part worth testing, and it is testable without
 * a renderer or a server.
 */
import { countRows } from '../rowVocabulary';
import type { GroupTasksResponse, LeftAloneEntry, UngroupTasksResponse } from '@/hooks/useTaskGrouping';
import { formatChord } from '@/lib/platform';

/** `n item` / `n items`, since every sentence below needs it. */
function items(n: number): string {
  return countRows(n);
}

function rows(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

/** A snake_case token the client does not recognize, rendered as prose (rule 301(c)). */
function humanize(token: string): string {
  return token.replace(/_/g, ' ');
}

/**
 * A structured account of one outcome. Structured rather than a single string so the
 * notice can give the headline its own weight while the live region and the session
 * trail read the same content as one sentence — see {@link flattenOutcome}.
 */
export interface GroupingOutcome {
  /** The consequence, in one short clause. */
  headline: string;
  /** What the user does next, and what they no longer have to do. */
  detail: string;
  /** What the server did NOT do, when it left rows alone. Null when it wrapped everything. */
  leftAlone: string | null;
  /** A condition worth knowing about that is not a failure. Null when there is none. */
  warning: string | null;
}

/**
 * Why a row was left where it was.
 *
 * Deliberately phrased from the user's side of the rule ("already sits inside another
 * row you selected") rather than the server's ("ancestor_selected"). The user did not
 * ask for a taxonomy; they asked for a phase and got one that is smaller than they
 * expected, and the sentence has to make that make sense.
 */
export function describeLeftAlone(entries: readonly LeftAloneEntry[]): string | null {
  if (entries.length === 0) return null;

  let ancestor = 0;
  let differentParent = 0;
  const unknown = new Map<string, number>();
  for (const entry of entries) {
    if (entry.reason === 'ancestor_selected') ancestor += 1;
    else if (entry.reason === 'different_parent') differentParent += 1;
    else unknown.set(entry.reason, (unknown.get(entry.reason) ?? 0) + 1);
  }

  const clauses: string[] = [];
  if (ancestor > 0) {
    clauses.push(
      ancestor === 1
        ? '1 already sits inside another row you selected'
        : `${ancestor} already sit inside another row you selected`,
    );
  }
  if (differentParent > 0) {
    clauses.push(
      differentParent === 1
        ? '1 sits under a different parent'
        : `${differentParent} sit under a different parent`,
    );
  }
  for (const [reason, count] of unknown) {
    clauses.push(`${count} ${count === 1 ? 'was' : 'were'} held back — ${humanize(reason)}`);
  }

  const total = entries.length;
  const stayed = total === 1 ? '1 row stayed where it was' : `${total} rows stayed where they were`;
  return `${stayed}: ${joinClauses(clauses)}.`;
}

/** `a`, `a and b`, `a, b and c` — the list separator every clause list here needs. */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}

/**
 * Group's warning tokens. Client-side because the server sends a token, not a tone —
 * so the unknown branch is the cautious one and never the reassuring one (rule 301(b)).
 */
function describeGroupWarning(warning: string | null): string | null {
  if (!warning) return null;
  if (warning === 'has_assignments') {
    return 'The phase this one now sits in has people assigned to it directly. Assignments belong on the work inside a phase, not on the phase — move them down so the rollup counts them.';
  }
  return `Worth checking: ${humanize(warning)}.`;
}

function describeUngroupWarning(warning: string | null): string | null {
  if (!warning) return null;
  if (warning === 'has_assignments') {
    return 'That phase had people assigned to it directly, and those assignments went with it. The work inside kept its own.';
  }
  return `Worth checking: ${humanize(warning)}.`;
}

/**
 * "4 items are now a phase." — the copy the issue specifies, verbatim in its shape.
 *
 * The second sentence is the load-bearing one: a planner who has just watched four
 * rows disappear into a container needs to know that the container's dates, status and
 * estimate are *derived*, or they will go looking for fields to fill in that do not
 * exist. The third promises the reversal, which #2974 made true — the endpoint returns
 * an `operation_id` and the whole group is one ledger row, so `⌘Z` really does undo it
 * in one step rather than unwinding four reparents.
 */
export function describeGroupOutcome(response: GroupTasksResponse): GroupingOutcome {
  const n = response.grouped_ids.length;
  return {
    headline: `${items(n)} ${n === 1 ? 'is' : 'are'} now a phase.`,
    detail:
      `Name it — its dates, status and estimate roll up from the work inside, so there is nothing else to fill in. ${formatChord('mod+z')} undoes the whole group.`,
    leftAlone: describeLeftAlone(response.left_alone),
    warning: describeGroupWarning(response.warning),
  };
}

/**
 * "Design is no longer a phase."
 *
 * Names what survived rather than what was removed, because "keeping links, owners and
 * estimates" is the question a user actually has about dissolving a container — the
 * fear is that the wrapper took the work's history with it. Only the wrapper's *own*
 * edges go, and when there were any this says so rather than letting links vanish and
 * be discovered later.
 */
export function describeUngroupOutcome(
  response: UngroupTasksResponse,
  containerName: string,
): GroupingOutcome {
  const name = containerName.trim() || 'Untitled';
  const n = response.lifted_ids.length;
  const linkCount = response.removed_dependency_ids.length;
  const links =
    linkCount > 0
      ? ` ${linkCount} ${linkCount === 1 ? 'link that pointed' : 'links that pointed'} at the phase itself went with it.`
      : '';
  return {
    headline: `${name} is no longer a phase.`,
    detail:
      n === 0
        ? `It was empty, so nothing moved.${links} ${formatChord('mod+z')} puts it back.`
        : `Its ${items(n)} moved up one level, keeping their links, owners and estimates.${links} ${formatChord('mod+z')} puts the phase back.`,
    leftAlone: null,
    warning: describeUngroupWarning(response.warning),
  };
}

/**
 * The same outcome as one sentence, for the polite live region and the session trail.
 *
 * One derivation, two audiences: the notice shows the parts with the headline in bold
 * and this flattens them, so a screen-reader user and a sighted user are never told
 * different things about what just happened to their plan (the rule-316 concern
 * applied to an outcome rather than to a prediction).
 */
export function flattenOutcome(outcome: GroupingOutcome): string {
  return [outcome.headline, outcome.detail, outcome.leftAlone, outcome.warning]
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * What `⌥⌘G` would act on right now, or why it would not act.
 *
 * The button and the keybinding both read this, so the control's presence, its
 * description and the mutation cannot disagree about their target (rule 316). It
 * deliberately answers only questions the client can answer from its own state — how
 * many rows are selected — and never predicts which of them the server will wrap.
 */
export interface GroupTarget {
  /** Rows to send, in visible order. Empty when the act is unavailable. */
  taskIds: string[];
  /** Why it is unavailable, for the refusal sentence. Null when it is available. */
  blocked: 'no-selection' | null;
}

export function deriveGroupTarget(
  selectedIds: ReadonlySet<string> | null,
  focusedRowId: string | null,
  visibleOrder: readonly string[],
): GroupTarget {
  // A multi-row selection is the normal case. A single focused row is still a legal
  // group — wrapping one row in a phase you are about to fill is exactly how the
  // design says a phase gets made — so it is not refused.
  const ids =
    selectedIds && selectedIds.size > 0
      ? visibleOrder.filter((id) => selectedIds.has(id))
      : focusedRowId
        ? [focusedRowId]
        : [];
  return ids.length > 0 ? { taskIds: ids, blocked: null } : { taskIds: [], blocked: 'no-selection' };
}

/**
 * The sentence a Group button carries in its description.
 *
 * States the count it will send and the rule that can shrink it, and states both
 * *before* the act — a user who is told afterwards that two rows were left alone has
 * already lost the chance to change the selection. It never names which rows will be
 * dropped, because that is the server's verdict and predicting it is rule 301's trap.
 */
export function describeGroupTarget(target: GroupTarget): string | null {
  if (target.blocked !== null) return null;
  const n = target.taskIds.length;
  return `${formatChord('mod+alt+g')} wraps ${rows(n)} in a new phase. A row already inside another selected row stays where it is.`;
}

/**
 * What `⌥⇧⌘G` would dissolve, or why it would not.
 *
 * Ungroup acts on the focused row, not on the selection: dissolving is a statement
 * about one container, and a multi-row selection has no single wrapper to name.
 */
export interface UngroupTarget {
  taskId: string | null;
  containerName: string;
  blocked: 'no-row' | 'not-a-phase' | null;
}

export function deriveUngroupTarget(
  focusedRow: { id: string; name: string } | null,
  focusedRowIsPhase: boolean,
): UngroupTarget {
  if (!focusedRow) return { taskId: null, containerName: '', blocked: 'no-row' };
  if (!focusedRowIsPhase) {
    return { taskId: null, containerName: focusedRow.name, blocked: 'not-a-phase' };
  }
  return { taskId: focusedRow.id, containerName: focusedRow.name, blocked: null };
}

export function describeUngroupTarget(target: UngroupTarget): string | null {
  if (target.blocked !== null) return null;
  const name = target.containerName.trim() || 'Untitled';
  return `${formatChord('mod+shift+alt+g')} dissolves ${name}, lifting its rows one level. Their links, owners and estimates stay.`;
}

/**
 * A refusal, said out loud rather than swallowed (web rule 311(c)).
 *
 * A keystroke that does nothing teaches the user the product is broken. Every branch
 * that declines to act returns a sentence here, and the caller announces it.
 */
export function describeGroupRefusal(target: GroupTarget): string {
  return target.blocked === 'no-selection'
    ? 'Nothing to group — select the rows you want to wrap in a phase first.'
    : '';
}

export function describeUngroupRefusal(target: UngroupTarget): string {
  if (target.blocked === 'no-row') {
    return 'Nothing to ungroup — focus the phase you want to dissolve first.';
  }
  if (target.blocked === 'not-a-phase') {
    const name = target.containerName.trim() || 'That row';
    return `${name} is not a phase, so there is nothing to dissolve. Use ${formatChord('alt+ArrowLeft')} to outdent a single row.`;
  }
  return '';
}
