import type { ProjectResource } from '@/types';

/**
 * The `@owner` inline authoring token (ADR-0774, #2718).
 *
 * Grammar:
 * ```
 *   @ana        → 100% allocation
 *   @ana:50     → 50% allocation
 *   @"ana lee"  → quoted, for names containing spaces
 * ```
 *
 * This module is deliberately pure — no React, no network, no store. It is the one
 * place a percent (`@ana:50`) becomes an allocation, and the only conversion to the
 * API's fraction form lives at the single call site in `ownerTokensToApiPayload`.
 * A second percent↔fraction conversion appearing anywhere in the client is a bug.
 *
 * The token exists because the obvious way to implement "assign this row to Ana" —
 * writing `Task.assignee` — is silently wrong. Every capacity, utilization, heat-map
 * and sprint-capacity computation sums `TaskResource.units` and never reads `assignee`,
 * so a bare-assignee task contributes zero load forever with no warning anywhere.
 */

/** Default allocation for a bare `@name` token, as a percent. */
export const DEFAULT_OWNER_PERCENT = 100;

/** Allocation bounds, mirroring the API's `[0.01, 2.0]` fraction range. */
export const MIN_OWNER_PERCENT = 1;
export const MAX_OWNER_PERCENT = 200;

/** One `@…` token lifted out of a raw cell draft, before resolution. */
export interface OwnerToken {
  /** The literal source text, including the leading `@`. Used to strip and to re-render. */
  raw: string;
  /** The name portion, unquoted and trimmed. */
  query: string;
  /** Allocation as a percent. `@ana` yields 100; `@ana:50` yields 50. */
  units: number;
  /** Index of `raw` within the source string. */
  start: number;
}

/** A token that matched exactly one roster member. */
export interface ResolvedOwner {
  resourceId: string;
  /** The matched resource's display name — used for the confirmation chip. */
  name: string;
  /** Allocation as a percent (see `ownerTokensToApiPayload` for the wire form). */
  units: number;
}

/** The outcome of parsing and resolving one cell draft. */
export interface OwnerTokenParse {
  /**
   * The draft with every RESOLVED token removed and whitespace collapsed — what gets
   * committed as the task name. Unresolved tokens are deliberately left in place.
   */
  name: string;
  /** Tokens that matched exactly one roster member. */
  owners: ResolvedOwner[];
  /**
   * Tokens that matched no roster member (or more than one). The literal text stays in
   * `name`; the row still commits and joins the surface's unresolved count. Dropping
   * the row, or dropping the token silently, are both worse than a visible amber
   * underline the author can correct (ADR-0774 §6).
   */
  unresolved: OwnerToken[];
}

/**
 * Matches `@name` or `@name:percent`, with an optional double-quoted name so multi-word
 * people are expressible without guessing where the name ends. The unquoted form stops
 * at whitespace: a greedy "longest roster match" rule would make the parser's output
 * depend on the roster, which is exactly what makes such parsers untestable in isolation.
 */
const OWNER_TOKEN_RE = /@(?:"([^"]+)"|([A-Za-z0-9._'À-ɏ-]+))(?::(\d{1,3}))?/g;

/**
 * The name portion of a mid-type token fragment — everything before its first `:`
 * modifier, so `ana:50` offers people named "ana" rather than nobody.
 *
 * Deliberately `indexOf`, not `replace(/:.*$/, '')`. A greedy `.*` followed by an
 * anchor backtracks once per character on every fragment the anchor rejects, which is
 * quadratic on text the author types (typescript:S8786). The anchored form is also
 * wrong on a fragment carrying a newline: `.` skips no line breaks and `$` cannot
 * match mid-string without `m`, so the modifier survives into the query instead of
 * being stripped. Both token surfaces call this one function — a second copy of the
 * expression is how the two would drift.
 */
export function tokenFragmentQuery(fragment: string): string {
  const modifier = fragment.indexOf(':');
  return modifier < 0 ? fragment : fragment.slice(0, modifier);
}

/** Clamp a parsed percent into the API's supported allocation range. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OWNER_PERCENT;
  return Math.min(MAX_OWNER_PERCENT, Math.max(MIN_OWNER_PERCENT, value));
}

/**
 * Lift every `@…` token out of a raw draft string. Pure lexing — no roster involved,
 * so this is decidable from the input alone.
 */
export function parseOwnerTokens(raw: string): OwnerToken[] {
  const tokens: OwnerToken[] = [];
  // `matchAll` on a /g regex needs a fresh lastIndex; constructing per call keeps this
  // function reentrant (a module-level /g regex carrying lastIndex across calls is a
  // classic source of every-other-call-returns-nothing bugs).
  const re = new RegExp(OWNER_TOKEN_RE.source, 'g');
  for (const m of raw.matchAll(re)) {
    const query = (m[1] ?? m[2] ?? '').trim();
    if (!query) continue;
    tokens.push({
      raw: m[0],
      query,
      units: m[3] !== undefined ? clampPercent(Number.parseInt(m[3], 10)) : DEFAULT_OWNER_PERCENT,
      start: m.index,
    });
  }
  return tokens;
}

/** Why a roster lookup produced no single person — the two cases need different repairs. */
export type RosterMatchStatus = 'matched' | 'unmatched' | 'ambiguous';

export interface RosterMatch {
  status: RosterMatchStatus;
  /** The person, when exactly one was identified. Null on both failure kinds. */
  member: ProjectResource | null;
  /** The people an ambiguous query named. Empty unless `status` is `ambiguous`. */
  candidates: ProjectResource[];
}

/**
 * Resolve a roster query, stating *why* it failed when it does.
 *
 * Matching is exact-name first, then unique prefix, then unique substring — each tier
 * only wins when it identifies exactly ONE person. An ambiguous query resolves to
 * nothing rather than picking the first candidate: silently binding work to the wrong
 * person is the failure this contract exists to prevent, and `Ana` matching both
 * "Ana Rivera" and "Ana Silva" is a question only the author can answer.
 *
 * The status is the point (#2905). `matchRosterMember` collapses both failures to
 * `null`, which is right for a caller that only needs the person but wrong for any
 * caller that has to *report* the failure: a typo needs correcting and an ambiguous
 * name needs disambiguating, and telling an author "1 owner not applied" without
 * saying which it was leaves them guessing at a fix.
 */
export function resolveRosterMember(query: string, pool: ProjectResource[]): RosterMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { status: 'unmatched', member: null, candidates: [] };

  const tiers = [
    pool.filter((p) => p.resource.name.toLowerCase() === q),
    pool.filter((p) => p.resource.name.toLowerCase().startsWith(q)),
    pool.filter((p) => p.resource.name.toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { status: 'matched', member: tier[0], candidates: [] };
    // A tier that names several people stops the walk: a broader tier can only
    // name more, so falling through would never disambiguate, and the narrower
    // tiers have already been tried.
    if (tier.length > 1) return { status: 'ambiguous', member: null, candidates: tier };
  }
  return { status: 'unmatched', member: null, candidates: [] };
}

/**
 * Find the single roster member a token names, case-insensitively.
 *
 * The person-only view of {@link resolveRosterMember}, kept because most callers
 * genuinely only need the person and reading `.member` at each of them would be noise.
 * Reach for `resolveRosterMember` when the failure has to be *reported*.
 */
export function matchRosterMember(query: string, pool: ProjectResource[]): ProjectResource | null {
  return resolveRosterMember(query, pool).member;
}

/**
 * Parse a cell draft and resolve its `@` tokens against the project roster.
 *
 * Resolution is scoped to the roster the grid already holds — never a global directory.
 * That scoping is a security property, not a convenience: it is what stops a name typed
 * on one project binding work to somebody who is a member of none of them
 * (ADR-0774 §3).
 */
export function parseOwnerDraft(raw: string, pool: ProjectResource[]): OwnerTokenParse {
  const tokens = parseOwnerTokens(raw);
  const owners: ResolvedOwner[] = [];
  const unresolved: OwnerToken[] = [];
  const resolvedRaws: string[] = [];

  for (const token of tokens) {
    const match = matchRosterMember(token.query, pool);
    if (!match) {
      unresolved.push(token);
      continue;
    }
    // Last token wins for a repeated person: `@ana @ana:50` reads as a correction, not
    // as two assignments the API would have to reconcile.
    const existing = owners.findIndex((o) => o.resourceId === match.resourceId);
    if (existing >= 0) owners[existing] = { ...owners[existing], units: token.units };
    else
      owners.push({ resourceId: match.resourceId, name: match.resource.name, units: token.units });
    resolvedRaws.push(token.raw);
  }

  let name = raw;
  for (const rawToken of resolvedRaws) name = name.replace(rawToken, ' ');

  return { name: name.replace(/\s+/g, ' ').trim(), owners, unresolved };
}

/**
 * Convert resolved owners to the API's `owners` write field.
 *
 * The ONE percent→fraction conversion in the client. `TaskResource.units` is a fraction
 * of full capacity (`1.0` = 100%), matching `TaskResourceSerializer`'s `[0.01, 2.0]`
 * range; the token's percent form never leaves this module.
 */
export function ownerTokensToApiPayload(
  owners: ResolvedOwner[],
): { resource: string; units: number }[] {
  return owners.map((o) => ({ resource: o.resourceId, units: o.units / 100 }));
}

/**
 * The `@…` fragment the caret is currently inside, or null.
 *
 * Drives the autocomplete popover: it opens only while the author is mid-token, so
 * typing an email address or a `foo@bar` literal elsewhere in the name never summons it.
 */
export function activeOwnerQuery(
  draft: string,
  caret = draft.length,
): { query: string; start: number; units: number } | null {
  const upToCaret = draft.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at < 0) return null;
  // A bare `@` must follow whitespace or start the draft — otherwise an email address
  // or a `foo@bar` literal anywhere in the name would summon the picker.
  if (at > 0 && !/\s/.test(upToCaret[at - 1])) return null;
  const fragment = upToCaret.slice(at + 1);
  // Whitespace ends the token: once the author types a space they are back in the name.
  if (/\s/.test(fragment)) return null;
  const percent = /:(\d{1,3})$/.exec(fragment);
  return {
    query: tokenFragmentQuery(fragment),
    start: at,
    // `@ana:5` mid-type is a real (if small) allocation, so an in-progress percent is
    // honored rather than discarded — picking from the list must not silently reset
    // an allocation the author already typed.
    units: percent ? clampPercent(Number.parseInt(percent[1], 10)) : DEFAULT_OWNER_PERCENT,
  };
}

/**
 * True when `name` contains at least one `@owner` token that matched no roster member.
 * The predicate F8/Shift+F8 jump between (#2727, ADR-0776 §3) — the only concept the
 * codebase itself calls "unresolved" inside the Schedule surface.
 */
export function hasUnresolvedOwnerToken(name: string, pool: ProjectResource[]): boolean {
  return parseOwnerTokens(name).some((t) => matchRosterMember(t.query, pool) === null);
}

/**
 * Segment a committed task name into plain text and unresolved `@` tokens, so the row
 * can render the amber underline without the renderer re-implementing the grammar.
 */
export function segmentUnresolvedOwners(
  name: string,
  pool: ProjectResource[],
): { text: string; unresolved: boolean }[] {
  const tokens = parseOwnerTokens(name).filter((t) => matchRosterMember(t.query, pool) === null);
  if (tokens.length === 0) return [{ text: name, unresolved: false }];

  const segments: { text: string; unresolved: boolean }[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ text: name.slice(cursor, token.start), unresolved: false });
    }
    segments.push({ text: token.raw, unresolved: true });
    cursor = token.start + token.raw.length;
  }
  if (cursor < name.length) segments.push({ text: name.slice(cursor), unresolved: false });
  return segments;
}
