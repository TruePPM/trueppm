import { useState } from 'react';
import { isFullRetro, type SprintRetroResponse } from '@/hooks/useSprints';

interface Props {
  prior: SprintRetroResponse | null;
}

/**
 * Collapsible "Prior retro" section above the active RetroPanel editor
 * (ADR-0071 §4a). Default-open if a prior retro exists; renders a single
 * disabled-state row if not.
 *
 * Subject to the same visibility threshold as the parent retro — VIEWER-role
 * users on a TEAM_ONLY prior retro see the summary card variant.
 */
export function PriorRetroSection({ prior }: Props) {
  const [open, setOpen] = useState(prior !== null);
  if (prior === null) {
    return (
      <div className="text-xs italic text-neutral-text-disabled">▶ No prior retro on this project</div>
    );
  }
  const hasContent = isFullRetro(prior);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded border border-neutral-border bg-neutral-surface-raised"
    >
      <summary
        className="cursor-pointer px-3 py-2 text-xs font-semibold tracking-widest uppercase
          text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Prior retro
      </summary>
      <div className="px-3 py-2 flex flex-col gap-2">
        {hasContent ? (
          <>
            {prior.notes && (
              <p className="text-sm text-neutral-text-primary whitespace-pre-wrap">{prior.notes}</p>
            )}
            {prior.action_items.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-neutral-text-secondary">
                  <tr>
                    <th className="text-left font-medium px-1 py-0.5">Action item</th>
                    <th className="text-left font-medium px-1 py-0.5 w-32">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {prior.action_items.map((it) => (
                    <tr
                      key={it.id}
                      className="border-t border-neutral-border/60"
                    >
                      <td className="px-1 py-1 text-neutral-text-primary">{it.text}</td>
                      <td className="px-1 py-1 tppm-mono text-neutral-text-secondary">
                        {it.promoted_task_id
                          ? `→ T-${it.promoted_task_id.slice(0, 6)}`
                          : 'Open'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="text-xs italic text-neutral-text-disabled">
            Prior retro is team-only — counts: {prior.action_items_count} items,{' '}
            {prior.promoted_count} promoted.
          </p>
        )}
      </div>
    </details>
  );
}
