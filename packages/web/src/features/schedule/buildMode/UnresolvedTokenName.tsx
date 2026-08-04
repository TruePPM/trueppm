import { useMemo } from 'react';
import type { ProjectResource } from '@/types';
import {
  segmentAuthoringName,
  type ParentCandidate,
  type PredecessorCandidate,
} from './authoringTokens';

interface Props {
  /** The committed task name, which may still contain unresolved tokens. */
  name: string;
  /** The project roster `@owner` tokens resolve against. */
  pool: ProjectResource[];
  /** Tasks `>predecessor` tokens resolve against. Omitted disables the token. */
  tasks?: PredecessorCandidate[];
  /** Phases `[phase]` tokens resolve against. Omitted disables the token. */
  phases?: ParentCandidate[];
}

/**
 * Renders a task name, marking every inline authoring token that did not take
 * (ADR-0774 §6, #2718; generalized to the full grammar in #2722).
 *
 * Two distinct states, because they mean different things to the author:
 *
 * - **Unresolved** (amber wavy underline) — the token matched nothing, or matched
 *   ambiguously. A visible, correctable state rather than an error: the literal text
 *   stays in the name and the row commits normally. Rejecting the commit would throw
 *   away the rest of the row to punish one mistyped name, and silently dropping the
 *   token is the exact failure — work that looks assigned and carries zero capacity —
 *   that the `@owner` contract exists to prevent.
 * - **Overridden** (struck through) — the token parsed and resolved but lost a
 *   conflict, e.g. a `~scrum` on a row that also carried `!`. Echoing it back struck
 *   through is what tells the author their `~scrum` did not take; without it they
 *   would reasonably assume it had.
 *
 * Amber, not red: "needs a second look", not "something broke". The marks are
 * `decoration-*` rather than a background tint so they survive the row's selection,
 * critical-path, and summary styling without a specificity fight, and each state is
 * carried for screen readers by `title` + `aria-label` rather than by color alone
 * (WCAG 1.4.1).
 */
export function UnresolvedTokenName({ name, pool, tasks, phases }: Props) {
  const segments = useMemo(
    () => segmentAuthoringName(name, { pool, tasks: tasks ?? [], phases: phases ?? [] }),
    [name, pool, tasks, phases],
  );

  // Fast path: nothing marked — render plain text so the overwhelmingly common row
  // does not pay for a span-per-segment walk on every virtualized re-render.
  if (segments.length === 1 && segments[0].state === 'plain') return <>{name}</>;

  return (
    <>
      {segments.map((seg, i) => {
        // Segments are positional slices of one string; index is the stable identity.
        if (seg.state === 'unresolved') {
          return (
            <span
              key={`u${String(i)}`}
              className="underline decoration-wavy decoration-semantic-warning underline-offset-2
                decoration-1"
              title={`Nothing on this project matches ${seg.text}`}
              aria-label={`${seg.text} — unresolved`}
            >
              {seg.text}
            </span>
          );
        }
        if (seg.state === 'overridden') {
          return (
            <span
              key={`o${String(i)}`}
              className="line-through text-neutral-text-secondary"
              title={`${seg.text} was overridden by another token on this row`}
              aria-label={`${seg.text} — overridden`}
            >
              {seg.text}
            </span>
          );
        }
        return <span key={`t${String(i)}`}>{seg.text}</span>;
      })}
    </>
  );
}
