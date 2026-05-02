import { useEffect, useState } from 'react';
import {
  useSaveSprintRetro,
  useSprintRetro,
  type SprintRetroActionItemInput,
} from '@/hooks/useSprints';

interface Props {
  sprintId: string;
  /** True when the sprint is COMPLETED — switches copy to read-only emphasis. */
  isClosed: boolean;
  /** Optional explicit promote target; falls back to next planned sprint server-side. */
  promoteToSprintId?: string | null;
}

interface DraftItem {
  text: string;
  promote: boolean;
  story_points: string;
}

const EMPTY_DRAFT: DraftItem = { text: '', promote: true, story_points: '' };

/**
 * Sprint retrospective panel — bottom of the Sprints view (#231).
 *
 * For active sprints: an inline editor where the team can type notes
 * and queue action items mid-sprint. Promotion happens server-side
 * (next planned sprint by default; see ``promote_to_sprint_id``).
 *
 * For closed sprints: a read-only-feeling view of the saved retro;
 * the form is still editable so retros can be amended after close.
 */
export function RetroPanel({ sprintId, isClosed, promoteToSprintId }: Props) {
  const retroQuery = useSprintRetro(sprintId);
  const save = useSaveSprintRetro(sprintId);

  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  // Remote retro hydrates the form once it lands.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (retroQuery.data === null) {
      setHydrated(true);
      return;
    }
    if (retroQuery.data) {
      setNotes(retroQuery.data.notes);
      setItems(
        retroQuery.data.action_items.map((it) => ({
          text: it.text,
          promote: it.promoted_task_id !== null,
          story_points: it.story_points ? String(it.story_points) : '',
        })),
      );
      setHydrated(true);
    }
  }, [retroQuery.data, hydrated]);

  // Promoted ids on the server-side payload — used to render T-XXX links.
  const persistedById = new Map(
    (retroQuery.data?.action_items ?? []).map((it) => [it.text, it]),
  );

  function addItem() {
    setItems((cur) => [...cur, { ...EMPTY_DRAFT }]);
  }

  function updateItem(idx: number, patch: Partial<DraftItem>) {
    setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function removeItem(idx: number) {
    setItems((cur) => cur.filter((_, i) => i !== idx));
  }

  function handleSave() {
    const payload: SprintRetroActionItemInput[] = items.flatMap<SprintRetroActionItemInput>((it) => {
      const text = it.text.trim();
      if (!text) return [];
      const sp = it.story_points.trim();
      return [{ text, promote: it.promote, story_points: sp ? Number(sp) : null }];
    });

    save.mutate({
      notes: notes.trim(),
      action_items: payload,
      promote_to_sprint_id: promoteToSprintId ?? null,
    });
  }

  return (
    <section
      aria-labelledby="retro-panel-heading"
      className="border-t border-neutral-border bg-neutral-surface px-6 py-4 flex flex-col gap-3"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="retro-panel-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Retrospective
        </h2>
        <p className="text-xs text-neutral-text-disabled italic">
          {isClosed
            ? 'Read-only fields are still editable — retros can be amended after close.'
            : 'Add action items mid-sprint; promotion happens on save.'}
        </p>
      </header>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-text-secondary">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="What went well, what blocked the team, what to try next…"
          className="px-3 py-2 rounded border border-neutral-border bg-neutral-surface
            text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-y
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            Action items
          </h3>
          <button
            type="button"
            onClick={addItem}
            className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            + Add item
          </button>
        </div>

        {items.length === 0 ? (
          <p className="text-xs italic text-neutral-text-disabled">
            No action items yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item, idx) => {
              const persisted = persistedById.get(item.text);
              return (
                <li
                  key={idx}
                  className="flex items-start gap-2 rounded border border-neutral-border bg-neutral-surface p-2"
                >
                  <input
                    type="text"
                    value={item.text}
                    onChange={(e) => updateItem(idx, { text: e.target.value })}
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
                    onChange={(e) => updateItem(idx, { story_points: e.target.value })}
                    placeholder="pts"
                    aria-label={`Action item ${idx + 1} story points`}
                    className="w-16 h-8 px-2 rounded border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled tppm-mono
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                  <label className="flex items-center gap-1 text-xs text-neutral-text-secondary whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={item.promote}
                      onChange={(e) => updateItem(idx, { promote: e.target.checked })}
                      aria-label={`Promote action item ${idx + 1} to next sprint backlog`}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                    />
                    Add to next sprint
                  </label>
                  {persisted?.promoted_task_id && (
                    <span
                      className="tppm-mono text-[10px] px-1.5 py-0.5 rounded border border-semantic-on-track/40 text-semantic-on-track"
                      title={`Created task ${persisted.promoted_task_id}`}
                    >
                      → T-{persisted.promoted_task_id.slice(0, 6)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
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

      <div className="flex items-center justify-between gap-3">
        {save.isError && (
          <p role="alert" className="text-xs text-semantic-critical">
            Failed to save retro. Please try again.
          </p>
        )}
        {save.isSuccess && !save.isPending && (
          <p role="status" className="text-xs text-semantic-on-track">
            Retro saved.
          </p>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={save.isPending}
          className="ml-auto h-8 px-3 rounded text-xs font-medium bg-brand-primary text-white
            disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
            focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
        >
          {save.isPending ? 'Saving…' : 'Save retro'}
        </button>
      </div>
    </section>
  );
}
