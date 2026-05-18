import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  isFullRetro,
  useSaveSprintRetro,
  useSprintRetro,
  useSprintRetroPrior,
  useUpdateRetroVisibility,
  usePromoteRetroActionItem,
  type RetroVisibility,
  type SprintRetroActionItem,
  type SprintRetroActionItemInput,
  type SprintRetroPayload,
} from '@/hooks/useSprints';
import { PriorRetroSection } from './PriorRetroSection';
import { RetroSummaryCard } from './RetroSummaryCard';
import { RetroVisibilityToggle } from './RetroVisibilityToggle';

interface Props {
  sprintId: string;
  /** True when the sprint is COMPLETED — switches copy to read-only emphasis. */
  isClosed: boolean;
  /**
   * @deprecated since ADR-0071. Action items no longer auto-promote on save.
   * Promotion happens via the explicit Promote button per item.
   */
  promoteToSprintId?: string | null;
  /** When the requesting user can change visibility (retro author or Project ADMIN+). */
  canEditVisibility?: boolean;
}

interface DraftItem {
  text: string;
  story_points: string;
}

const EMPTY_DRAFT: DraftItem = { text: '', story_points: '' };

/**
 * Sprint retrospective panel — bottom of the Sprints view (#486 / ADR-0071).
 *
 * For active sprints: an inline editor where the team can type notes
 * and queue action items mid-sprint. Items remain unpromoted until the
 * team explicitly clicks "Promote to backlog" on each — sprint sovereignty
 * (ADR-0069) is enforced structurally; this UI cannot bulk-promote to a sprint.
 *
 * For closed sprints: a read-only-feeling view of the saved retro;
 * the form is still editable so retros can be amended after close.
 *
 * Below the retro's ``team_visibility`` threshold, the panel renders a
 * counts-only summary card via ``RetroSummaryCard`` (psych-safety per
 * ADR-0071 §3).
 */
export function RetroPanel({ sprintId, isClosed, canEditVisibility = false }: Props) {
  const retroQuery = useSprintRetro(sprintId);
  const priorQuery = useSprintRetroPrior(sprintId);

  if (retroQuery.data && !isFullRetro(retroQuery.data)) {
    // VIEWER-role on a TEAM_ONLY retro receives the summary serializer.
    return (
      <RetroPanelLayout>
        <PriorRetroSection prior={priorQuery.data ?? null} />
        <RetroSummaryCard summary={retroQuery.data} />
      </RetroPanelLayout>
    );
  }

  // ``data`` is now either null or full (the summary branch returned above).
  const retro: SprintRetroPayload | null = retroQuery.data ?? null;
  return (
    <RetroPanelLayout>
      <PriorRetroSection prior={priorQuery.data ?? null} />
      <FullEditor
        sprintId={sprintId}
        isClosed={isClosed}
        retro={retro}
        canEditVisibility={canEditVisibility}
      />
    </RetroPanelLayout>
  );
}

function RetroPanelLayout({ children }: { children: ReactNode }) {
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
      </header>
      {children}
    </section>
  );
}

interface FullEditorProps {
  sprintId: string;
  isClosed: boolean;
  retro: SprintRetroPayload | null;
  canEditVisibility: boolean;
}

function FullEditor({ sprintId, isClosed, retro, canEditVisibility }: FullEditorProps) {
  const save = useSaveSprintRetro(sprintId);
  const updateVisibility = useUpdateRetroVisibility(sprintId);
  const promote = usePromoteRetroActionItem(sprintId);

  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (retro === null) {
      setHydrated(true);
      return;
    }
    setNotes(retro.notes);
    setItems(
      retro.action_items.map((it) => ({
        text: it.text,
        story_points: it.story_points ? String(it.story_points) : '',
      })),
    );
    setHydrated(true);
  }, [retro, hydrated]);

  // Map persisted action items by text for the Promote button state lookup.
  const persistedById = useMemo<Map<string, SprintRetroActionItem>>(
    () => new Map((retro?.action_items ?? []).map((it) => [it.text, it])),
    [retro],
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
      return [{ text, story_points: sp ? Number(sp) : null }];
    });
    save.mutate({ notes: notes.trim(), action_items: payload });
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-neutral-text-disabled italic">
          {isClosed
            ? 'Read-only fields are still editable — retros can be amended after close.'
            : 'Add action items mid-sprint; promote each explicitly to land it in the project backlog.'}
        </p>
        {canEditVisibility && retro && (
          <RetroVisibilityToggle
            value={retro.team_visibility}
            disabled={updateVisibility.isPending}
            onChange={(v: RetroVisibility) => updateVisibility.mutate(v)}
          />
        )}
      </div>

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
          <p className="text-xs italic text-neutral-text-disabled">No action items yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item, idx) => {
              const persisted = persistedById.get(item.text);
              const isPromoted = persisted?.promoted_task_id != null;
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
                  {isPromoted && persisted ? (
                    <a
                      href={`#task-${persisted.promoted_task_id}`}
                      title={`Promoted to task ${persisted.promoted_task_id}`}
                      className="tppm-mono text-xs px-1.5 py-0.5 rounded border border-semantic-on-track/40 text-semantic-on-track
                        whitespace-nowrap
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                    >
                      → T-{persisted.promoted_task_id!.slice(0, 6)}
                    </a>
                  ) : persisted ? (
                    <button
                      type="button"
                      onClick={() => promote.mutate(persisted.id)}
                      disabled={save.isPending || promote.isPending}
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
        {promote.isError && (
          <p role="alert" className="text-xs text-semantic-critical">
            Failed to promote item. Please try again.
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
    </>
  );
}
