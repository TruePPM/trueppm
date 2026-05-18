import { useAcceptSuggestion, useDeclineSuggestion } from '@/hooks/useSprints';
import type { MyWorkRetroActionItem } from '@/hooks/useMyWork';

interface Props {
  items: MyWorkRetroActionItem[];
}

/**
 * "From retros" section on the My Work page (ADR-0071 §4c).
 *
 * Two subsections: Suggested for you (PENDING suggestions awaiting accept/
 * decline) and Owned (items the user has accepted, surfaced only when the
 * promoted Task is not yet in a sprint — those already appear in the
 * existing sprint groups of My Work).
 *
 * Section suppresses itself when ``items`` is empty.
 */
export function MyWorkRetroSection({ items }: Props) {
  const suggested = items.filter((it) => it.suggestion_state === 'suggested');
  const owned = items.filter((it) => it.suggestion_state === 'owned');
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="from-retros-heading"
      className="px-4 md:px-3 pt-4 pb-1 flex flex-col gap-2"
    >
      <h2
        id="from-retros-heading"
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      >
        From retros
      </h2>
      {suggested.length > 0 && (
        <SuggestedGroup items={suggested} />
      )}
      {owned.length > 0 && (
        <OwnedGroup items={owned} />
      )}
    </section>
  );
}

function SuggestedGroup({ items }: { items: MyWorkRetroActionItem[] }) {
  const accept = useAcceptSuggestion();
  const decline = useDeclineSuggestion();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs text-neutral-text-secondary">
        Suggested for you <span className="tppm-mono text-neutral-text-disabled">{items.length}</span>
      </h3>
      <ul className="flex flex-col gap-1">
        {items.map((it) => {
          if (!it.suggestion_id) return null;
          return (
            <li
              key={it.suggestion_id}
              className="rounded border border-neutral-border bg-neutral-surface-raised p-2 flex flex-col gap-1"
            >
              <p className="text-sm font-medium text-neutral-text-primary">{it.text}</p>
              <p className="text-xs text-neutral-text-secondary">
                {it.from_sprint_short_id ? `Sprint ${it.from_sprint_short_id} retro` : 'retro'} ·
                from {it.suggested_by_username ?? '(unknown)'}
                {it.reason ? ` — ${it.reason}` : ''}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    accept.mutate({ taskId: it.task_id, suggestionId: it.suggestion_id! })
                  }
                  disabled={accept.isPending}
                  className="h-9 px-3 rounded text-xs font-medium bg-brand-primary text-white
                    disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                    focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() =>
                    decline.mutate({ taskId: it.task_id, suggestionId: it.suggestion_id! })
                  }
                  disabled={decline.isPending}
                  className="h-9 px-3 rounded text-xs font-medium border border-neutral-border text-neutral-text-primary
                    hover:bg-neutral-surface
                    disabled:opacity-50 disabled:cursor-not-allowed
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Decline
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OwnedGroup({ items }: { items: MyWorkRetroActionItem[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs text-neutral-text-secondary">
        Owned <span className="tppm-mono text-neutral-text-disabled">{items.length}</span>
      </h3>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li
            key={it.task_id}
            className="border-b border-neutral-border/60 px-2 py-2 flex items-center gap-2"
          >
            <span className="tppm-mono text-xs text-neutral-text-secondary w-20 shrink-0">
              T-{it.task_short_id ?? it.task_id.slice(0, 6)}
            </span>
            <span className="flex-1 text-sm text-neutral-text-primary truncate">{it.text}</span>
            <span className="text-xs text-neutral-text-disabled tppm-mono shrink-0">
              {it.from_sprint_short_id ? `Sprint ${it.from_sprint_short_id} retro` : 'retro'}
            </span>
            <span className="text-xs text-neutral-text-secondary tppm-mono uppercase tracking-wide shrink-0">
              {it.task_status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
