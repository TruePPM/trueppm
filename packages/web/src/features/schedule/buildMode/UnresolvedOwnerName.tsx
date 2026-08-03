import { useMemo } from 'react';
import type { ProjectResource } from '@/types';
import { segmentUnresolvedOwners } from './ownerToken';

interface Props {
  /** The committed task name, which may still contain unresolved `@` tokens. */
  name: string;
  /** The project roster the tokens are resolved against. */
  pool: ProjectResource[];
}

/**
 * Renders a task name, underlining any `@owner` token that matched no roster member
 * (ADR-0774 §6, #2718).
 *
 * An unresolvable owner is a **visible, correctable state**, not an error: the literal
 * text stays in the name and the row commits normally. Rejecting the commit would throw
 * away the rest of the row to punish one mistyped name, and silently dropping the token
 * is the exact failure — work that looks assigned and carries zero capacity — that the
 * whole `@owner` contract exists to prevent.
 *
 * Amber, not red: this is "needs a second look", not "something broke". The underline is
 * `decoration-*` rather than a background tint so it survives the row's selection,
 * critical-path, and summary styling without a specificity fight, and the state is
 * carried for screen readers by `title` + `aria-label` on the token span rather than by
 * color alone (WCAG 1.4.1).
 */
export function UnresolvedOwnerName({ name, pool }: Props) {
  const segments = useMemo(() => segmentUnresolvedOwners(name, pool), [name, pool]);

  // Fast path: nothing unresolved — render plain text so the overwhelmingly common row
  // does not pay for a span-per-segment walk on every virtualized re-render.
  if (segments.length === 1 && !segments[0].unresolved) return <>{name}</>;

  return (
    <>
      {segments.map((seg, i) =>
        seg.unresolved ? (
          <span
            // Segments are positional slices of one string; index is the stable identity.
            key={`u${String(i)}`}
            className="underline decoration-wavy decoration-semantic-warning underline-offset-2
              decoration-1"
            title={`No one on this project's roster matches ${seg.text}`}
            aria-label={`${seg.text} — unresolved owner`}
          >
            {seg.text}
          </span>
        ) : (
          <span key={`t${String(i)}`}>{seg.text}</span>
        ),
      )}
    </>
  );
}
