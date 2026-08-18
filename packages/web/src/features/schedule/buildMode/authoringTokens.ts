import type { DeliveryMode, ProjectResource } from '@/types';
import {
  DEFAULT_OWNER_PERCENT,
  matchRosterMember,
  parseOwnerTokens,
  tokenFragmentQuery,
  type OwnerToken,
  type ResolvedOwner,
} from './ownerToken';

/**
 * The inline authoring grammar for the row editor (#2722).
 *
 * ```
 *   #5d  #2w  #4h  #0    duration — a bare number is days; `h` converts through the
 *                          calendar's hours_per_day and rounds up; zero makes it a milestone
 *   @ana @ana:50    owner, as a TaskResource allocation (ADR-0774, #2718)
 *   >2.3 >Survey    predecessor, by WBS path or by name; `>2.3+2d` lag, `>2.3-1d` lead
 *   !               milestone
 *   ~sprint ~gated  delivery mode on this row only
 *   [Design]        re-parent under a phase, by name
 * ```
 *
 * This module is deliberately pure — no React, no network, no store. Two properties
 * follow from that and are worth preserving:
 *
 * 1. **Lexing is decidable from the input alone.** `parseAuthoringTokens` never
 *    consults the roster, the task list, or the phase list. Only *resolution*
 *    (`resolveAuthoringDraft`) looks anything up, which is what makes the grammar
 *    testable without fixtures for every surrounding entity.
 * 2. **An unresolvable token is never an error.** It stays in the committed name as
 *    literal text and is returned in `unresolved`, so the row still commits and the
 *    author sees an amber underline they can correct. Dropping the row, or dropping
 *    the token silently, are both worse than a visible mark — silently dropping
 *    `@ana` is the zero-capacity failure ADR-0774 exists to prevent, and the same
 *    reasoning applies to every other token.
 *
 * The `@` token is *not* re-implemented here. It is lifted from `ownerToken.ts`,
 * which owns the one percent→fraction conversion in the client; a second parser for
 * the same syntax is how the two would drift.
 */

/** The four dependency types, in the order `⌥→` cycles through them. */
export const DEPENDENCY_TYPE_CYCLE = ['FS', 'SS', 'FF', 'SF'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPE_CYCLE)[number];

/**
 * Advance a dependency type one step around the cycle, wrapping at the end.
 *
 * Kept here rather than in the component so the binding and the grammar cannot
 * disagree about the order — the cheatsheet renders `DEPENDENCY_TYPE_CYCLE`.
 */
export function cycleDependencyType(current: DependencyType, steps = 1): DependencyType {
  const i = DEPENDENCY_TYPE_CYCLE.indexOf(current);
  const len = DEPENDENCY_TYPE_CYCLE.length;
  // `% len` twice so a negative `steps` (⌥← ) wraps forward rather than indexing out.
  return DEPENDENCY_TYPE_CYCLE[(((i + steps) % len) + len) % len];
}

/** Aliases the author may type for a delivery mode. The key is what they type. */
const DELIVERY_MODE_ALIASES: Record<string, DeliveryMode> = {
  sprint: 'scrum',
  scrum: 'scrum',
  agile: 'scrum',
  kanban: 'kanban',
  flow: 'kanban',
  gated: 'waterfall',
  waterfall: 'waterfall',
  stage: 'waterfall',
  milestone: 'milestone',
  gate: 'milestone',
};

/** Every delivery-mode word the grammar accepts — drives the type-ahead list. */
export const DELIVERY_MODE_WORDS = Object.keys(DELIVERY_MODE_ALIASES);

export type TokenKind = 'duration' | 'owner' | 'predecessor' | 'milestone' | 'deliveryMode' | 'parent';

/** One token lifted out of a raw draft, before anything is resolved. */
export interface AuthoringToken {
  kind: TokenKind;
  /** The literal source text, including its sigil. Used to strip and to re-render. */
  raw: string;
  /** Index of `raw` within the source string. */
  start: number;
  /** The payload between the sigil and any modifier, unquoted and trimmed. */
  query: string;
}

export interface DurationToken extends AuthoringToken {
  kind: 'duration';
  /** Working days. `#2w` is 10. `#0` is a milestone (see `parseAuthoringTokens`). */
  days: number;
}

export interface PredecessorToken extends AuthoringToken {
  kind: 'predecessor';
  /** Working days of lag. Negative is lead (`>2.3-1d`). */
  lag: number;
  depType: DependencyType;
}

export interface DeliveryModeToken extends AuthoringToken {
  kind: 'deliveryMode';
  /** Absent when the author typed a word the alias table does not know. */
  mode?: DeliveryMode;
}

/** Any token the grammar can produce. */
export type AnyAuthoringToken =
  | AuthoringToken
  | DurationToken
  | PredecessorToken
  | DeliveryModeToken;

/**
 * Duration forms — #5d, #2w, #0, and a bare #3.
 *
 * A bare number is days — but only as the **last** thing in the draft. With a unit
 * (#5d, #2w) the token is unambiguous and may sit anywhere; without one, #3 is
 * indistinguishable from the ordinary English of "Sprint #3 planning", and eating
 * that would be hostile. Trailing position is the disambiguator because a duration
 * is what an author types last, after the name.
 *
 * Two regexes rather than one with a conditional lookahead, because the difference
 * is precisely the anchor and a single pattern would hide that.
 */
const DURATION_WITH_UNIT_RE = /(?:^|\s)(#(\d+)\s*([dwh]))(?=\s|$)/g;
const TRAILING_BARE_DURATION_RE = /(?:^|\s)(#(\d+))\s*$/;

/**
 * `>2.3`, `>Survey`, `>"Design review"`, with an optional dependency type and lag:
 * `>2.3:SS`, `>2.3+2d`, `>2.3:FF-1d`.
 *
 * The type suffix exists because `⌥→` cycles FS → SS → FF → SF, and a binding that
 * changes a value the grammar cannot spell would leave the row unable to round-trip
 * through its own text. Omitted means `FS`, which is the overwhelmingly common case
 * and keeps the short form short.
 *
 * The unquoted body excludes `:`, `+` and `-` so a type or lag suffix always splits
 * cleanly; a name containing those characters is expressible in the quoted form.
 */
const PREDECESSOR_RE =
  /(?:^|\s)(>(?:"([^"]+)"|([^\s:+-]+))(?::(FS|SS|FF|SF))?(?:([+-]\d+)([dw])?)?)(?=\s|$)/gi;

/** `~sprint`, `~gated`. Word characters only — the alias table decides validity. */
const DELIVERY_MODE_RE = /(?:^|\s)(~([A-Za-z]+))(?=\s|$)/g;

/** `[Design]`, `[Design review]`. Brackets are the delimiter, so spaces are free. */
const PARENT_RE = /(\[([^\][]+)\])/g;

/** A bare `!` at a whitespace boundary. `Ship it!` is not a milestone. */
const MILESTONE_RE = /(?:^|\s)(!)(?=\s|$)/g;

/**
 * Convert a `d`/`w`/`h` unit to working days. Weeks are 5 working days.
 *
 * Hours (#2975) divide by the project calendar's `hours_per_day` and round **up**
 * — `Task.duration` is an integer working-day count by engine invariant
 * (ADR-0132), and rounding an estimate down silently under-plans the task. The
 * lexer is pure, so it takes the rate rather than reading a calendar; callers
 * that have no calendar loaded pass the 8h default.
 */
function toDays(count: number, unit: string | undefined, hoursPerDay = 8): number {
  if (unit === 'w') return count * 5;
  if (unit === 'h') {
    const rate = hoursPerDay > 0 ? hoursPerDay : 8;
    return Math.max(0, Math.ceil(count / rate));
  }
  return count;
}

/**
 * Lift every token out of a raw draft. Pure lexing — no roster, no task list, so
 * the result is decidable from the input alone.
 *
 * Tokens come back sorted by position, which is what lets `stripTokens` remove them
 * without re-scanning and lets the renderer segment the string in one pass.
 */
export function parseAuthoringTokens(raw: string): AnyAuthoringToken[] {
  const tokens: AnyAuthoringToken[] = [];

  // A fresh RegExp per call: a module-level /g regex carries `lastIndex` across
  // calls, which is the classic every-other-call-returns-nothing bug.
  const durationMatches = [...raw.matchAll(new RegExp(DURATION_WITH_UNIT_RE.source, 'g'))];
  const bare = TRAILING_BARE_DURATION_RE.exec(raw);
  if (bare && !durationMatches.some((m) => m.index === bare.index)) {
    durationMatches.push(bare as unknown as RegExpExecArray & RegExpMatchArray);
  }
  for (const m of durationMatches) {
    const count = Number.parseInt(m[2], 10);
    const days = toDays(count, m[3]);
    const start = (m.index ?? 0) + m[0].indexOf(m[1]);
    // `#0` is the milestone spelling of a duration, and the two encodings must not
    // both be emitted — a milestone token plus a zero-duration token would make the
    // conflict resolver arbitrate against itself.
    const durationToken: AnyAuthoringToken =
      days === 0
        ? { kind: 'milestone', raw: m[1], start, query: '' }
        : { kind: 'duration', raw: m[1], start, query: m[2], days };
    tokens.push(durationToken);
  }

  for (const m of raw.matchAll(new RegExp(PREDECESSOR_RE.source, 'gi'))) {
    const query = (m[2] ?? m[3] ?? '').trim();
    if (!query) continue;
    const lagCount = m[5] ? Number.parseInt(m[5], 10) : 0;
    const predecessorToken: PredecessorToken = {
      kind: 'predecessor',
      raw: m[1],
      start: m.index + m[0].indexOf(m[1]),
      query,
      lag: toDays(lagCount, m[6]),
      // Omitted means FS — the default, and by far the common case.
      depType: (m[4]?.toUpperCase() as DependencyType | undefined) ?? 'FS',
    };
    tokens.push(predecessorToken);
  }

  for (const m of raw.matchAll(new RegExp(DELIVERY_MODE_RE.source, 'g'))) {
    const word = m[2].toLowerCase();
    const mode = DELIVERY_MODE_ALIASES[word];
    const start = m.index + m[0].indexOf(m[1]);
    if (!mode) {
      // An unknown mode word is still a token — it has to reach `unresolved` so it
      // gets an amber underline, rather than vanishing into the task name.
      const unknownMode: DeliveryModeToken = { kind: 'deliveryMode', raw: m[1], start, query: word };
      tokens.push(unknownMode);
      continue;
    }
    const modeToken: DeliveryModeToken = { kind: 'deliveryMode', raw: m[1], start, query: word, mode };
    tokens.push(modeToken);
  }

  for (const m of raw.matchAll(new RegExp(PARENT_RE.source, 'g'))) {
    const query = m[2].trim();
    if (!query) continue;
    tokens.push({ kind: 'parent', raw: m[1], start: m.index, query });
  }

  for (const m of raw.matchAll(new RegExp(MILESTONE_RE.source, 'g'))) {
    tokens.push({ kind: 'milestone', raw: '!', start: m.index + m[0].indexOf('!'), query: '' });
  }

  for (const t of parseOwnerTokens(raw)) {
    tokens.push({ kind: 'owner', raw: t.raw, start: t.start, query: t.query });
  }

  return tokens.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A task the `>` token may name, by WBS path or by name. */
export interface PredecessorCandidate {
  id: string;
  name: string;
  /** Dotted WBS path, e.g. `2.3`. Empty for a backlog row that never had one. */
  wbs: string;
}

/** A phase the `[…]` token may re-parent under. */
export interface ParentCandidate {
  id: string;
  name: string;
}

export interface ResolvedPredecessor {
  taskId: string;
  /** The matched task's display name — used for the confirmation chip. */
  name: string;
  /** Working days of lag; negative is lead. */
  lag: number;
  depType: DependencyType;
}

export interface AuthoringResolutionContext {
  pool?: ProjectResource[];
  tasks?: PredecessorCandidate[];
  phases?: ParentCandidate[];
}

export interface AuthoringDraftParse {
  /** The draft with every RESOLVED token removed and whitespace collapsed. */
  name: string;
  /** Working days, or `null` when the draft carried no duration token. */
  duration: number | null;
  isMilestone: boolean;
  deliveryMode: DeliveryMode | null;
  owners: ResolvedOwner[];
  predecessors: ResolvedPredecessor[];
  parentId: string | null;
  /**
   * Tokens that matched nothing (or matched ambiguously). Their literal text stays
   * in `name`; the row still commits and joins the surface's unresolved count.
   */
  unresolved: AnyAuthoringToken[];
  /**
   * Tokens that parsed and resolved but LOST a conflict — a `~scrum` alongside `!`,
   * or a duration such as #5d on a milestone row. Rendered struck through so the author can see
   * what the row did with their input, rather than watching it silently disappear.
   */
  overridden: AnyAuthoringToken[];
}

/**
 * Find the single task a `>` token names, by WBS path first and then by name.
 *
 * WBS is tried first and matched exactly, because `2.3` is unambiguous by
 * construction while a name may not be. Name matching then follows the roster
 * rules: exact, unique prefix, unique substring — each tier winning only when it
 * identifies exactly ONE task. An ambiguous token resolves to nothing rather than
 * picking the first candidate; binding the wrong predecessor silently reshapes the
 * schedule, and which "Design" was meant is a question only the author can answer.
 */
export function matchPredecessor(
  query: string,
  tasks: PredecessorCandidate[],
): PredecessorCandidate | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const byWbs = tasks.filter((t) => t.wbs.toLowerCase() === q);
  if (byWbs.length === 1) return byWbs[0];
  if (byWbs.length > 1) return null;

  const tiers = [
    tasks.filter((t) => t.name.toLowerCase() === q),
    tasks.filter((t) => t.name.toLowerCase().startsWith(q)),
    tasks.filter((t) => t.name.toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) return null;
  }
  return null;
}

/** Find the single phase a `[…]` token names. Same tiering as `matchPredecessor`. */
export function matchParent(query: string, phases: ParentCandidate[]): ParentCandidate | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const tiers = [
    phases.filter((p) => p.name.toLowerCase() === q),
    phases.filter((p) => p.name.toLowerCase().startsWith(q)),
    phases.filter((p) => p.name.toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) return null;
  }
  return null;
}

/**
 * Parse a cell draft and resolve every token against the surrounding project.
 *
 * Resolution is scoped to what the grid already holds — the project roster, this
 * project's tasks, this project's phases — never a global directory. That scoping
 * is a security property rather than a convenience: it is what stops a name typed
 * on one project binding work to somebody who is a member of none of them
 * (ADR-0774 §3).
 */
export function resolveAuthoringDraft(
  raw: string,
  context: AuthoringResolutionContext = {},
): AuthoringDraftParse {
  const { pool = [], tasks = [], phases = [] } = context;
  const tokens = parseAuthoringTokens(raw);

  const unresolved: AnyAuthoringToken[] = [];
  const overridden: AnyAuthoringToken[] = [];
  const resolvedRaws: string[] = [];
  const owners: ResolvedOwner[] = [];
  const predecessors: ResolvedPredecessor[] = [];

  let duration: number | null = null;
  let durationToken: AnyAuthoringToken | null = null;
  let isMilestone = false;
  let deliveryMode: DeliveryMode | null = null;
  let deliveryModeToken: AnyAuthoringToken | null = null;
  let parentId: string | null = null;

  for (const token of tokens) {
    switch (token.kind) {
      case 'milestone':
        isMilestone = true;
        resolvedRaws.push(token.raw);
        break;

      case 'duration':
        // Last one wins — #5d followed by #3d reads as a correction, not a contradiction.
        if (durationToken) overridden.push(durationToken);
        duration = (token as DurationToken).days;
        durationToken = token;
        resolvedRaws.push(token.raw);
        break;

      case 'deliveryMode': {
        const mode = (token as DeliveryModeToken).mode;
        if (!mode) {
          unresolved.push(token);
          break;
        }
        if (deliveryModeToken) overridden.push(deliveryModeToken);
        deliveryMode = mode;
        deliveryModeToken = token;
        resolvedRaws.push(token.raw);
        break;
      }

      case 'owner': {
        const match = matchRosterMember(token.query, pool);
        if (!match) {
          unresolved.push(token);
          break;
        }
        // Re-lex the owner token to recover its allocation — `ownerToken` owns the
        // percent grammar, so re-deriving `:50` here would be a second parser.
        const withUnits = parseOwnerTokens(token.raw)[0] as OwnerToken | undefined;
        const units = withUnits?.units ?? DEFAULT_OWNER_PERCENT;
        const existing = owners.findIndex((o) => o.resourceId === match.resourceId);
        if (existing >= 0) owners[existing] = { ...owners[existing], units };
        else owners.push({ resourceId: match.resourceId, name: match.resource.name, units });
        resolvedRaws.push(token.raw);
        break;
      }

      case 'predecessor': {
        const match = matchPredecessor(token.query, tasks);
        if (!match) {
          unresolved.push(token);
          break;
        }
        const t = token as PredecessorToken;
        const already = predecessors.findIndex((p) => p.taskId === match.id);
        const entry = { taskId: match.id, name: match.name, lag: t.lag, depType: t.depType };
        if (already >= 0) predecessors[already] = entry;
        else predecessors.push(entry);
        resolvedRaws.push(token.raw);
        break;
      }

      case 'parent': {
        const match = matchParent(token.query, phases);
        if (!match) {
          unresolved.push(token);
          break;
        }
        parentId = match.id;
        resolvedRaws.push(token.raw);
        break;
      }
    }
  }

  // The coupled invariant: is_milestone ⟺ delivery_mode 'milestone' ⟺ duration 0.
  // A row carrying both `!` and `~scrum` resolves to milestone, and the losing token
  // is echoed back struck through rather than dropped — the author needs to see that
  // their `~scrum` did not take, or they will assume it did.
  if (isMilestone) {
    if (deliveryModeToken && deliveryMode !== 'milestone') overridden.push(deliveryModeToken);
    if (durationToken && duration !== 0) overridden.push(durationToken);
    deliveryMode = 'milestone';
    duration = 0;
  } else if (deliveryMode === 'milestone') {
    // `~milestone` is the long spelling of `!`, so it implies the same invariant.
    isMilestone = true;
    if (durationToken && duration !== 0) overridden.push(durationToken);
    duration = 0;
  }

  let name = raw;
  for (const rawToken of resolvedRaws) name = name.replace(rawToken, ' ');

  return {
    name: name.replace(/\s+/g, ' ').trim(),
    duration,
    isMilestone,
    deliveryMode,
    owners,
    predecessors,
    parentId,
    unresolved,
    overridden,
  };
}

// ---------------------------------------------------------------------------
// Live caret state — what the popover reads
// ---------------------------------------------------------------------------

/** The sigils that open a type-ahead, and the token kind each one opens. */
const SIGIL_KINDS: Record<string, TokenKind> = {
  '@': 'owner',
  '>': 'predecessor',
  '~': 'deliveryMode',
  '[': 'parent',
  '#': 'duration',
};

export interface ActiveTokenFragment {
  kind: TokenKind;
  /** Text typed after the sigil, up to the caret. */
  query: string;
  /** Index of the sigil within the draft. */
  start: number;
}

/**
 * The token fragment the caret is currently inside, or null.
 *
 * Drives every type-ahead: a popover opens only while the author is mid-token, so a
 * `#` or `@` sitting elsewhere in a name never summons one. A sigil must follow
 * whitespace or start the draft, which is what keeps an email address and a literal
 * "Sprint #3" from being read as syntax.
 *
 * Returns the LAST open sigil before the caret, so typing `>2.3 @an` offers people
 * rather than tasks.
 */
export function activeTokenFragment(draft: string, caret = draft.length): ActiveTokenFragment | null {
  const upToCaret = draft.slice(0, caret);

  let best: ActiveTokenFragment | null = null;
  for (const [sigil, kind] of Object.entries(SIGIL_KINDS)) {
    const at = upToCaret.lastIndexOf(sigil);
    if (at < 0) continue;
    if (at > 0 && !/\s/.test(upToCaret[at - 1])) continue;
    const fragment = upToCaret.slice(at + sigil.length);
    // Whitespace ends every token except `[…]`, whose brackets delimit it — so a
    // multi-word phase name stays one fragment.
    if (kind !== 'parent' && /\s/.test(fragment)) continue;
    if (kind === 'parent' && fragment.includes(']')) continue;
    if (best === null || at > best.start) {
      best = { kind, query: tokenFragmentQuery(fragment), start: at };
    }
  }
  return best;
}

/**
 * Segment a committed name into plain text, unresolved tokens, and overridden ones,
 * so the row can render its underlines without the renderer re-implementing the
 * grammar.
 */
export function segmentAuthoringName(
  name: string,
  context: AuthoringResolutionContext = {},
): { text: string; state: 'plain' | 'unresolved' | 'overridden' }[] {
  const parse = resolveAuthoringDraft(name, context);
  const marked = [
    ...parse.unresolved.map((t) => ({ token: t, state: 'unresolved' as const })),
    ...parse.overridden.map((t) => ({ token: t, state: 'overridden' as const })),
  ].sort((a, b) => a.token.start - b.token.start);

  if (marked.length === 0) return [{ text: name, state: 'plain' }];

  const segments: { text: string; state: 'plain' | 'unresolved' | 'overridden' }[] = [];
  let cursor = 0;
  for (const { token, state } of marked) {
    if (token.start > cursor) {
      segments.push({ text: name.slice(cursor, token.start), state: 'plain' });
    }
    segments.push({ text: token.raw, state });
    cursor = token.start + token.raw.length;
  }
  if (cursor < name.length) segments.push({ text: name.slice(cursor), state: 'plain' });
  return segments;
}

/**
 * Rewrite the predecessor token nearest the caret to the next dependency type.
 *
 * Backs the `⌥→` binding. Returns the new draft, or `null` when the caret is not on
 * a predecessor token — the caller then lets the keystroke fall through rather than
 * swallowing an arrow key the author meant for cursor movement.
 *
 * Pure string work, so "what does ⌥→ do here" is answerable without a DOM. `steps`
 * is negative for `⌥←`.
 */
export function cycleDependencyTypeInDraft(
  draft: string,
  caret: number,
  steps = 1,
): string | null {
  const tokens = parseAuthoringTokens(draft).filter(
    (t): t is PredecessorToken => t.kind === 'predecessor',
  );
  if (tokens.length === 0) return null;

  // The token the caret sits in, else the last one before it — typing `>2.3 ` and
  // hitting ⌥→ should still cycle the edge just authored.
  const inside = tokens.find((t) => caret >= t.start && caret <= t.start + t.raw.length);
  const target = inside ?? [...tokens].reverse().find((t) => t.start <= caret);
  if (!target) return null;

  const next = cycleDependencyType(target.depType, steps);
  const lagSuffix =
    target.lag === 0 ? '' : `${target.lag > 0 ? '+' : '-'}${Math.abs(target.lag)}d`;
  const body = /\s/.test(target.query) ? `"${target.query}"` : target.query;
  // FS is the default spelling, so cycling back to it drops the suffix rather than
  // leaving a redundant `:FS` behind.
  const rewritten = `>${body}${next === 'FS' ? '' : `:${next}`}${lagSuffix}`;
  return (
    draft.slice(0, target.start) + rewritten + draft.slice(target.start + target.raw.length)
  );
}
