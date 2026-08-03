import type { ProjectResource } from '@/types';
import type { TokenSuggestion } from './TokenAutocomplete';
import {
  DELIVERY_MODE_WORDS,
  type ActiveTokenFragment,
  type ParentCandidate,
  type PredecessorCandidate,
  type TokenKind,
} from './authoringTokens';

/**
 * Candidate lists for every inline authoring token (#2722).
 *
 * Pure functions over the data the grid already holds — no network, no store — so
 * "what does the picker offer for this fragment" is answerable in a unit test
 * without mounting anything.
 *
 * Every list is scoped to the current project. That is a security property, not a
 * convenience: a picker that offered workspace-global people or tasks would let a
 * name typed here bind work across a boundary the author cannot see (ADR-0774 §3).
 */

/** Case-insensitive substring filter, used by every list below. */
function matches(haystack: string, query: string): boolean {
  return query.length === 0 || haystack.toLowerCase().includes(query.toLowerCase());
}

/** Durations offered for a `#` fragment. Common spans first, then what was typed. */
export function durationSuggestions(query: string): TokenSuggestion[] {
  const typed = /^\d+$/.exec(query.trim());
  const presets: TokenSuggestion[] = [
    { id: '#1d', label: '1 day', hint: '#1d' },
    { id: '#3d', label: '3 days', hint: '#3d' },
    { id: '#5d', label: '1 week', hint: '#5d' },
    { id: '#2w', label: '2 weeks', hint: '#2w' },
    { id: '#0', label: 'Milestone (zero duration)', hint: '#0' },
  ];
  if (!typed) return presets;

  // What the author actually typed leads, in both units, so `#2` offers "2 days" and
  // "2 weeks" rather than making them guess the suffix.
  const n = Number.parseInt(typed[0], 10);
  if (n === 0) return [{ id: '#0', label: 'Milestone (zero duration)', hint: '#0' }];
  return [
    { id: `#${n}d`, label: `${n} day${n === 1 ? '' : 's'}`, hint: `#${n}d` },
    { id: `#${n}w`, label: `${n} week${n === 1 ? '' : 's'} (${n * 5} days)`, hint: `#${n}w` },
  ];
}

/** Roster members offered for an `@` fragment. */
export function ownerSuggestions(query: string, pool: ProjectResource[]): TokenSuggestion[] {
  return pool
    .filter((p) => matches(p.resource.name, query))
    .map((p) => ({ id: p.resourceId, label: p.resource.name, hint: p.roleTitle ?? undefined }));
}

/** Tasks offered for a `>` fragment, matched on WBS path or name. */
export function predecessorSuggestions(
  query: string,
  tasks: PredecessorCandidate[],
): TokenSuggestion[] {
  return tasks
    .filter((t) => matches(t.name, query) || matches(t.wbs, query))
    .map((t) => ({ id: t.id, label: t.name, hint: t.wbs || undefined }));
}

/** Delivery-mode words offered for a `~` fragment. */
export function deliveryModeSuggestions(query: string): TokenSuggestion[] {
  return DELIVERY_MODE_WORDS.filter((w) => matches(w, query)).map((w) => ({
    id: w,
    label: w,
    hint: `~${w}`,
  }));
}

/** Phases offered for a `[` fragment. */
export function parentSuggestions(query: string, phases: ParentCandidate[]): TokenSuggestion[] {
  return phases
    .filter((p) => matches(p.name, query))
    .map((p) => ({ id: p.id, label: p.name, hint: 'phase' }));
}

/**
 * The `/` command menu — every token plus every toolbar action, discoverable by
 * typing rather than by memorizing.
 *
 * Selecting a command **inserts its sigil** and leaves the caret inside the new
 * token, so `/` → "Set duration" lands the author in the `#` picker rather than
 * completing anything on its own. The menu is a route into the grammar, not a
 * second way to express it — one grammar, two ways in.
 */
export interface CommandMenuEntry extends TokenSuggestion {
  /** Text inserted at the `/`. The caret ends up at the end of it. */
  insert: string;
}

export const COMMAND_MENU: CommandMenuEntry[] = [
  { id: 'duration', label: 'Set duration', hint: '#', insert: '#' },
  { id: 'owner', label: 'Assign owner', hint: '@', insert: '@' },
  { id: 'predecessor', label: 'Add predecessor', hint: '>', insert: '>' },
  { id: 'milestone', label: 'Make milestone', hint: '!', insert: '! ' },
  { id: 'mode-sprint', label: 'Delivery mode: sprint', hint: '~sprint', insert: '~sprint ' },
  { id: 'mode-gated', label: 'Delivery mode: gated', hint: '~gated', insert: '~gated ' },
  { id: 'mode-kanban', label: 'Delivery mode: kanban', hint: '~kanban', insert: '~kanban ' },
  { id: 'parent', label: 'Move under phase', hint: '[ ]', insert: '[' },
];

/** Command-menu entries matching a `/` fragment. */
export function commandSuggestions(query: string): CommandMenuEntry[] {
  return COMMAND_MENU.filter((c) => matches(c.label, query) || matches(c.hint ?? '', query));
}

export interface SuggestionContext {
  pool: ProjectResource[];
  tasks: PredecessorCandidate[];
  phases: ParentCandidate[];
}

/** Accessible name for each picker, so a screen reader says what is being chosen. */
const ARIA_LABELS: Record<TokenKind, string> = {
  duration: 'Set duration',
  owner: 'Assign owner',
  predecessor: 'Add predecessor',
  deliveryMode: 'Set delivery mode',
  parent: 'Move under phase',
  milestone: 'Make milestone',
};

/** Everything the popover needs for the fragment the caret currently sits in. */
export function suggestionsForFragment(
  fragment: ActiveTokenFragment,
  context: SuggestionContext,
): { suggestions: TokenSuggestion[]; ariaLabel: string } {
  const { query, kind } = fragment;
  const ariaLabel = ARIA_LABELS[kind];
  switch (kind) {
    case 'duration':
      return { suggestions: durationSuggestions(query), ariaLabel };
    case 'owner':
      return { suggestions: ownerSuggestions(query, context.pool), ariaLabel };
    case 'predecessor':
      return { suggestions: predecessorSuggestions(query, context.tasks), ariaLabel };
    case 'deliveryMode':
      return { suggestions: deliveryModeSuggestions(query), ariaLabel };
    case 'parent':
      return { suggestions: parentSuggestions(query, context.phases), ariaLabel };
    default:
      return { suggestions: [], ariaLabel };
  }
}

/**
 * Replace the fragment under the caret with the chosen literal.
 *
 * Returns the whole new draft, so the caller never has to reason about offsets — the
 * one place token text is spliced back into a draft.
 */
export function applySuggestion(
  draft: string,
  fragment: { start: number; query: string },
  literal: string,
): string {
  const before = draft.slice(0, fragment.start);
  const after = draft.slice(fragment.start + 1 + fragment.query.length);
  return `${before}${literal}${after}`;
}

/** Quote a value only when it needs it, so `@ana` stays short and readable. */
function maybeQuote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The literal token text a chosen suggestion expands to.
 *
 * The one place a suggestion becomes syntax. Keeping it beside the grammar means a
 * change to how a token is spelled updates both the picker and the parser together —
 * a picker that emits text its own parser rejects is the failure mode this prevents.
 */
export function tokenLiteralFor(kind: TokenKind, suggestion: TokenSuggestion): string {
  switch (kind) {
    case 'duration':
      // The id IS the literal (`#5d`), because durations are chosen from presets.
      return suggestion.id;
    case 'owner':
      return `@${maybeQuote(suggestion.label)}`;
    case 'predecessor':
      // Prefer the WBS path: it is stable under a rename, and shorter.
      return `>${suggestion.hint ? suggestion.hint : maybeQuote(suggestion.label)}`;
    case 'deliveryMode':
      return `~${suggestion.label}`;
    case 'parent':
      return `[${suggestion.label}]`;
    default:
      return suggestion.label;
  }
}
