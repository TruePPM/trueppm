import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isFullRetro,
  useSaveSprintRetro,
  useSprintRetro,
  useSprintRetroPrior,
  useUpdateRetroVisibility,
  usePromoteRetroActionItem,
  type SprintRetroActionItem,
  type SprintRetroActionItemInput,
  type SprintRetroPayload,
} from '@/hooks/useSprints';
import {
  useRetroBoard,
  useCreateBoardItem,
  useUpdateBoardItem,
  useDeleteBoardItem,
  useConvertStickyToAction,
  type RetroBoardColumnKey,
} from '@/hooks/useRetroBoard';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { PriorRetroSection } from './PriorRetroSection';
import { RetroSummaryCard } from './RetroSummaryCard';
import { RetroBoardHeader } from './RetroBoardHeader';
import { RetroColumns } from './RetroColumns';
import { RetroActionItems, type DraftActionItem } from './RetroActionItems';
import { RetroNotes } from './RetroNotes';
import { TeamHealthPulse } from './TeamHealthPulse';
import type { PendingSticky } from './RetroColumn';

interface Props {
  sprintId: string;
  /** True when the sprint is COMPLETED — switches copy to read-only emphasis. */
  isClosed: boolean;
  /** When the requesting user can change visibility (retro author or Project ADMIN+). */
  canEditVisibility?: boolean;
  /** Sprint lifecycle state, when available, to gate the board read-only / not-yet-open. */
  sprintState?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

let tempCounter = 0;
function nextTempId(): string {
  tempCounter += 1;
  return `temp-${Date.now()}-${tempCounter}`;
}

/** A one-time amber toast shown when a peer's edit superseded a local in-flight edit. */
interface ReconcileToast {
  id: string;
  author: string;
  /** The local text that was replaced — re-PATCHed if the user hits Undo. */
  localText: string;
  itemId: string;
}

/**
 * The live multi-writer retro surface (#851 / ADR-0117).
 *
 * Composes the sticky board (multi-writer), the existing single-author action
 * items (with the #858 Promote button, preserved unchanged), the notes
 * facilitator field, and the team-health pulse. Below the retro's visibility
 * threshold it falls back to the counts-only summary card (psych-safety, same
 * as the original RetroPanel). Owns the optimistic-create pending list, the
 * LWW reconcile toast, and the single-author notes/actions save.
 */
export function RetroBoardSurface({
  sprintId,
  isClosed,
  canEditVisibility = false,
  sprintState,
}: Props) {
  const itl = useIterationLabel();
  const retroQuery = useSprintRetro(sprintId);
  const priorQuery = useSprintRetroPrior(sprintId);
  const board = useRetroBoard(sprintId);

  const createItem = useCreateBoardItem(sprintId);
  const updateItem = useUpdateBoardItem(sprintId);
  const deleteItem = useDeleteBoardItem(sprintId);
  const convert = useConvertStickyToAction(sprintId);

  const save = useSaveSprintRetro(sprintId);
  const updateVisibility = useUpdateRetroVisibility(sprintId);
  const promote = usePromoteRetroActionItem(sprintId);

  const wsState = useWsConnectionStore((s) => s.state);
  const offline = wsState === 'stale' || wsState === 'failed';

  // Lifecycle gating (ADR-0117 §6): writable when ACTIVE or COMPLETED; CANCELLED
  // locks the board read-only; PLANNED shows a "not yet open" message. When the
  // sprint state isn't passed, fall back to the isClosed prop (COMPLETED ⇒
  // editable) so the board stays usable.
  const lifecycle: NonNullable<Props['sprintState']> =
    sprintState ?? (isClosed ? 'COMPLETED' : 'ACTIVE');
  const cancelled = lifecycle === 'CANCELLED';
  const planned = lifecycle === 'PLANNED';
  const boardReadOnly = cancelled || planned;

  // --- Optimistic pending creates (not yet confirmed by the server) ---
  const [pending, setPending] = useState<PendingSticky[]>([]);

  // --- Remote-add tracking for the enter animation + SR announcement ---
  // We diff the server item ids across renders; any id that appears without a
  // matching local create is "remote".
  const knownIdsRef = useRef<Set<string>>(new Set());
  const localCreatedIdsRef = useRef<Set<string>>(new Set());
  const [remoteIds, setRemoteIds] = useState<Set<string>>(new Set());

  const serverItems = useMemo(() => board.data?.items ?? [], [board.data]);

  useEffect(() => {
    const next = new Set<string>();
    const fresh = new Set(remoteIds);
    for (const it of serverItems) {
      if (!knownIdsRef.current.has(it.id)) {
        // New id this render. If we created it locally it's not remote.
        if (!localCreatedIdsRef.current.has(it.id)) {
          fresh.add(it.id);
        }
      }
      next.add(it.id);
    }
    knownIdsRef.current = next;
    // Drop remote flags for ids that are gone (deleted) to keep the set bounded.
    for (const id of fresh) {
      if (!next.has(id)) fresh.delete(id);
    }
    setRemoteIds(fresh);
    // serverItems identity changes only when the board cache changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverItems]);

  // --- LWW reconcile toast: a peer's edit superseded a local in-flight edit ---
  const inflightEditsRef = useRef<Map<string, string>>(new Map()); // itemId -> local text
  const [toast, setToast] = useState<ReconcileToast | null>(null);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Sticky handlers ---
  const handleAdd = useCallback(
    (column: RetroBoardColumnKey, text: string) => {
      const tempId = nextTempId();
      setPending((cur) => [...cur, { tempId, column, text, failed: false }]);
      createItem.mutate(
        { column, text, tempId },
        {
          onSuccess: (created) => {
            localCreatedIdsRef.current.add(created.id);
            setPending((cur) => cur.filter((p) => p.tempId !== tempId));
          },
          onError: () => {
            setPending((cur) =>
              cur.map((p) => (p.tempId === tempId ? { ...p, failed: true } : p)),
            );
          },
        },
      );
    },
    [createItem],
  );

  const handleRetry = useCallback(
    (tempId: string) => {
      const failed = pending.find((p) => p.tempId === tempId);
      if (!failed) return;
      setPending((cur) =>
        cur.map((p) => (p.tempId === tempId ? { ...p, failed: false } : p)),
      );
      createItem.mutate(
        { column: failed.column, text: failed.text, tempId },
        {
          onSuccess: (created) => {
            localCreatedIdsRef.current.add(created.id);
            setPending((cur) => cur.filter((p) => p.tempId !== tempId));
          },
          onError: () => {
            setPending((cur) =>
              cur.map((p) => (p.tempId === tempId ? { ...p, failed: true } : p)),
            );
          },
        },
      );
    },
    [pending, createItem],
  );

  const handleDiscard = useCallback((tempId: string) => {
    setPending((cur) => cur.filter((p) => p.tempId !== tempId));
  }, []);

  const handleEdit = useCallback(
    (id: string, text: string) => {
      const before = serverItems.find((it) => it.id === id);
      const beforeText = before?.text ?? '';
      inflightEditsRef.current.set(id, text);
      updateItem.mutate(
        { id, text },
        {
          onSettled: (data) => {
            inflightEditsRef.current.delete(id);
            // LWW reconcile: the server returned text that differs from BOTH
            // what we sent and the pre-edit value — a peer's write landed first
            // and superseded ours. Offer a one-time Undo that re-applies ours.
            if (data && data.text !== text && data.text !== beforeText) {
              setToast({
                id: nextTempId(),
                author: data.author_username ?? 'a teammate',
                localText: text,
                itemId: id,
              });
            }
          },
        },
      );
    },
    [updateItem, serverItems],
  );

  const handleUndoReconcile = useCallback(() => {
    if (!toast) return;
    updateItem.mutate({ id: toast.itemId, text: toast.localText });
    setToast(null);
  }, [toast, updateItem]);

  const handleDelete = useCallback(
    (id: string) => {
      deleteItem.mutate(id);
    },
    [deleteItem],
  );

  const handleConvert = useCallback(
    (id: string) => {
      convert.mutate(id);
    },
    [convert],
  );

  // -------------------------------------------------------------------------
  // Below-threshold summary branch — identical to the original RetroPanel.
  // -------------------------------------------------------------------------
  if (retroQuery.data && !isFullRetro(retroQuery.data)) {
    return (
      <Layout>
        {/* The region's accessible name on the below-threshold branch (the full
            branch gets it from RetroBoardHeader's heading). */}
        <h2
          id="retro-panel-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Retrospective
        </h2>
        <PriorRetroSection prior={priorQuery.data ?? null} />
        <RetroSummaryCard summary={retroQuery.data} />
      </Layout>
    );
  }

  const retro: SprintRetroPayload | null | undefined = retroQuery.data;

  return (
    <Layout>
      <RetroBoardHeader
        visibility={retro?.team_visibility ?? null}
        canEditVisibility={canEditVisibility}
        visibilityPending={updateVisibility.isPending}
        onChangeVisibility={(v) => updateVisibility.mutate(v)}
        offline={offline}
      />

      <PriorRetroSection prior={priorQuery.data ?? null} />

      {planned ? (
        <p className="text-sm italic text-neutral-text-secondary px-1 py-2">
          The retro board opens when this {itl.lower} is active.
        </p>
      ) : (
        <>
          {cancelled && (
            <p role="status" className="text-xs italic text-neutral-text-disabled">
              This {itl.lower} was canceled — the retro is read-only.
            </p>
          )}
          {board.data && (
            <RetroColumns
              columns={board.data.columns}
              items={serverItems}
              pending={pending}
              remoteIds={remoteIds}
              readOnly={boardReadOnly}
              convertingId={convert.isPending ? (convert.variables ?? null) : null}
              onAdd={handleAdd}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onConvert={handleConvert}
              onRetry={handleRetry}
              onDiscard={handleDiscard}
            />
          )}
        </>
      )}

      {/* LWW reconcile toast (role=status; one-time, 8s Undo). */}
      {toast && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded border border-semantic-warning/40
            bg-semantic-warning-bg px-3 py-2 text-xs text-neutral-text-primary"
        >
          <span>This card was updated by {toast.author} — your version was replaced.</span>
          <button
            type="button"
            onClick={handleUndoReconcile}
            className="font-medium text-brand-primary hover:text-brand-primary-dark underline whitespace-nowrap
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Undo
          </button>
        </div>
      )}

      {!planned && (
        <SingleAuthorSections
          sprintId={sprintId}
          isClosed={isClosed}
          readOnly={cancelled}
          retro={retro}
          save={save}
          promote={promote}
        />
      )}

      {!planned && <TeamHealthPulse sprintId={sprintId} canRespond={!boardReadOnly} />}
    </Layout>
  );
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="retro-panel-heading"
      className="border-t border-neutral-border bg-neutral-surface px-6 py-4 flex flex-col gap-4"
    >
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Single-author Notes + Action items, preserving the original FullEditor.
// ---------------------------------------------------------------------------

interface SingleAuthorProps {
  sprintId: string;
  isClosed: boolean;
  readOnly: boolean;
  retro: SprintRetroPayload | null | undefined;
  save: ReturnType<typeof useSaveSprintRetro>;
  promote: ReturnType<typeof usePromoteRetroActionItem>;
}

const EMPTY_DRAFT: DraftActionItem = { text: '', story_points: '' };

function SingleAuthorSections({
  sprintId: _sprintId,
  isClosed,
  readOnly,
  retro,
  save,
  promote,
}: SingleAuthorProps) {
  const itl = useIterationLabel();
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftActionItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (retro === undefined) return;
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

  const persistedByText = useMemo<Map<string, SprintRetroActionItem>>(
    () => new Map((retro?.action_items ?? []).map((it) => [it.text, it])),
    [retro],
  );

  function handleSave() {
    const payload: SprintRetroActionItemInput[] = items.flatMap<SprintRetroActionItemInput>(
      (it) => {
        const text = it.text.trim();
        if (!text) return [];
        const sp = it.story_points.trim();
        return [{ text, story_points: sp ? Number(sp) : null }];
      },
    );
    save.mutate({ notes: notes.trim(), action_items: payload });
  }

  return (
    <>
      <p className="text-xs text-neutral-text-disabled italic">
        {isClosed
          ? 'Notes and action items are still editable — retros can be amended after close.'
          : `Add action items mid-${itl.lower}; promote each explicitly to land it in the project backlog.`}
      </p>

      <RetroNotes notes={notes} onChange={setNotes} />

      <RetroActionItems
        items={items}
        persistedByText={persistedByText}
        savePending={save.isPending}
        promotePending={promote.isPending}
        onAdd={() => setItems((cur) => [...cur, { ...EMPTY_DRAFT }])}
        onUpdate={(idx, patch) =>
          setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
        }
        onRemove={(idx) => setItems((cur) => cur.filter((_, i) => i !== idx))}
        onPromote={(id) => promote.mutate(id)}
      />

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
          disabled={save.isPending || readOnly}
          className="ml-auto h-8 px-3 rounded text-xs font-medium bg-brand-primary text-neutral-text-inverse
            disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
            focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
        >
          {save.isPending ? 'Saving…' : 'Save notes & actions'}
        </button>
      </div>
    </>
  );
}
