import { Link } from 'react-router';

import { useProjectId } from '@/hooks/useProjectId';
import type { SprintRetroActionItem } from '@/hooks/useSprints';

export interface DraftActionItem {
  text: string;
  story_points: string;
}

interface Props {
  items: DraftActionItem[];
  /** Persisted action items keyed by text — drives the Promote button state. */
  persistedByText: Map<string, SprintRetroActionItem>;
  savePending: boolean;
  promotePending: boolean;
  onAdd: () => void;
  onUpdate: (idx: number, patch: Partial<DraftActionItem>) => void;
  onRemove: (idx: number) => void;
  onPromote: (id: string) => void;
}

/**
 * Retro action items — the distilled outcomes the team commits to (ADR-0117 §1).
 *
 * Refactored out of the original RetroPanel editor with its behavior preserved
 * EXACTLY: the per-item "Promote ↗" button (#858, unchanged), the
 * "→ T-xxxxxx" promoted chip, and the "Save first" state for unsaved items.
 * Distinct from the multi-writer discussion stickies (a sticky can be converted
 * into one of these via the card's convert affordance).
 */
export function RetroActionItems({
  items,
  persistedByText,
  savePending,
  promotePending,
  onAdd,
  onUpdate,
  onRemove,
  onPromote,
}: Props) {
  const projectId = useProjectId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
          Action items
        </h3>
        <button
          type="button"
          onClick={onAdd}
          className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
        >
          + Add item
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs italic text-neutral-text-disabled">No action items yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item, idx) => {
            const persisted = persistedByText.get(item.text);
            const isPromoted = persisted?.promoted_task_id != null;
            return (
              <li
                key={idx}
                className="flex items-start gap-2 rounded border border-neutral-border bg-neutral-surface p-2"
              >
                <input
                  type="text"
                  value={item.text}
                  onChange={(e) => onUpdate(idx, { text: e.target.value })}
                  placeholder="What did the team agree to do?"
                  aria-label={`Action item ${idx + 1} text`}
                  className="flex-1 h-8 px-2 rounded border border-neutral-border bg-neutral-surface
                    text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  value={item.story_points}
                  onChange={(e) => onUpdate(idx, { story_points: e.target.value })}
                  placeholder="pts"
                  aria-label={`Action item ${idx + 1} story points`}
                  className="w-16 h-8 px-2 rounded border border-neutral-border bg-neutral-surface
                    text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled tppm-mono
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                {isPromoted && persisted ? (
                  <Link
                    to={`/projects/${projectId}/schedule#task-${persisted.promoted_task_id}`}
                    title={`Promoted to task ${persisted.promoted_task_id} — open in Schedule`}
                    className="tppm-mono text-xs px-1.5 py-0.5 rounded border border-semantic-on-track/40 text-semantic-on-track
                      whitespace-nowrap
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    → T-{persisted.promoted_task_id!.slice(0, 6)}
                  </Link>
                ) : persisted ? (
                  <button
                    type="button"
                    onClick={() => onPromote(persisted.id)}
                    disabled={savePending || promotePending}
                    aria-label={`Promote action item ${idx + 1} to backlog`}
                    className="h-8 px-2 rounded text-xs font-medium bg-brand-primary text-white
                      disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                      focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary
                      whitespace-nowrap"
                  >
                    Promote ↗
                  </button>
                ) : (
                  <span
                    className="text-xs text-neutral-text-disabled italic whitespace-nowrap px-2"
                    title="Save retro first to enable promote"
                  >
                    Save first
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  aria-label={`Remove action item ${idx + 1}`}
                  className="h-8 px-2 rounded text-xs text-neutral-text-secondary hover:text-semantic-critical
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
