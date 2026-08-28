import { useEffect, useRef, useState } from 'react';
import type { ProjectResource } from '@/types';

interface Props {
  /** The `@…` fragment the caret currently sits inside (without the `@`). */
  query: string;
  /** The project's resource roster — the ONLY index an owner token resolves against. */
  pool: ProjectResource[];
  /** Called with the chosen roster member's display name. */
  onSelect: (resource: ProjectResource) => void;
  onDismiss: () => void;
}

const MAX_SUGGESTIONS = 6;

/**
 * Owner picker for the `@` inline authoring token in build mode (ADR-0774, #2718).
 * Mirrors `NameAutocomplete`'s positioning, sizing, and keyboard contract so the two
 * popovers in the same cell behave identically; it differs only in what it lists.
 *
 * Candidates come from the **project roster**, never a workspace-global directory —
 * the scoping is what stops a name typed here binding work to somebody who is a member
 * of no project the author can see.
 */
export function OwnerAutocomplete({ query, pool, onSelect, onDismiss }: Props) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const matches = pool
    .filter((p) => q.length === 0 || p.resource.name.toLowerCase().includes(q))
    .slice(0, MAX_SUGGESTIONS);

  useEffect(() => {
    setActiveIdx(-1);
  }, [matches.length]);

  // Captured on the document so the popover consumes the key before EditableCell's own
  // Enter/Escape handling — same interception NameAutocomplete uses.
  useEffect(() => {
    if (matches.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(matches[activeIdx]);
      } else if (e.key === 'Escape') {
        onDismiss();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [matches, activeIdx, onSelect, onDismiss]);

  if (matches.length === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox" // dropdown-scroll-ok: hard-capped slice(0, MAX_SUGGESTIONS)
      aria-label="Assign owner"
      className="absolute top-full left-0 z-50 w-[280px] mt-0.5 rounded-card border border-chrome-border
        bg-chrome-surface-raised overflow-hidden"
    >
      {matches.map((p, i) => (
        <li
          key={p.resourceId}
          role="option"
          aria-selected={i === activeIdx}
          className={[
            'flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer text-chrome-text-primary',
            i === activeIdx ? 'bg-brand-primary/10 text-brand-primary' : 'hover:bg-chrome-row-hover',
          ].join(' ')}
          onMouseDown={(e) => {
            // mousedown, not click — it must land before the input's onBlur commits.
            e.preventDefault();
            onSelect(p);
          }}
        >
          <span className="truncate">{p.resource.name}</span>
          {p.roleTitle && (
            <span className="ml-auto shrink-0 text-chrome-text-secondary truncate max-w-[96px]">
              {p.roleTitle}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
