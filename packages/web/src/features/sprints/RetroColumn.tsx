import { useEffect, useRef, useState } from 'react';
import type { RetroBoardColumnKey, RetroBoardItem } from '@/hooks/useRetroBoard';
import { RetroStickyCard } from './RetroStickyCard';
import { RetroStickyEditor } from './RetroStickyEditor';

/** A locally-pending optimistic create that hasn't been confirmed by the server. */
export interface PendingSticky {
  tempId: string;
  column: RetroBoardColumnKey;
  text: string;
  /** True once the create request failed; the card stays with retry/discard. */
  failed: boolean;
}

interface Props {
  columnKey: RetroBoardColumnKey;
  label: string;
  /** Confirmed server stickies for this column, already sorted by position. */
  items: RetroBoardItem[];
  /** Optimistic, not-yet-confirmed creates for this column. */
  pending: PendingSticky[];
  /** Set of sticky ids that arrived via a remote WS add (for the enter animation). */
  remoteIds: Set<string>;
  readOnly: boolean;
  /** Active convert request id, so the matching card shows a busy affordance. */
  convertingId: string | null;
  onAdd: (column: RetroBoardColumnKey, text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onConvert: (id: string) => void;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}

/**
 * One retro column (Went well / To improve / Ideas), ADR-0117 §6.
 *
 * The card list is an aria-live="polite" region: when a peer's sticky lands the
 * column announces "{name} added a card to {column}" without stealing focus.
 * Deleting a card moves focus to the previous card (or the +Add tile) so a
 * keyboard user is never stranded on a removed element (WCAG 2.4.3).
 */
export function RetroColumn({
  columnKey,
  label,
  items,
  pending,
  remoteIds,
  readOnly,
  convertingId,
  onAdd,
  onEdit,
  onDelete,
  onConvert,
  onRetry,
  onDiscard,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const prevIdsRef = useRef<Set<string>>(new Set(items.map((it) => it.id)));

  // Announce remote additions for screen readers. We diff the confirmed ids
  // against the previous render: any new id NOT created locally (it's in the
  // remote set) is announced. Local creates are already self-evident to the
  // author, so they are not announced.
  useEffect(() => {
    const currentIds = new Set(items.map((it) => it.id));
    for (const it of items) {
      if (!prevIdsRef.current.has(it.id) && remoteIds.has(it.id)) {
        const who = it.author_username ?? 'A teammate';
        setAnnouncement(`${who} added a card to ${label}`);
        break;
      }
    }
    prevIdsRef.current = currentIds;
  }, [items, remoteIds, label]);

  const empty = items.length === 0 && pending.length === 0;

  function handleDelete(id: string) {
    // Move focus to the previous card, falling back to the +Add tile, before
    // the deleted node unmounts.
    const idx = items.findIndex((it) => it.id === id);
    const prev = idx > 0 ? items[idx - 1] : null;
    onDelete(id);
    requestAnimationFrame(() => {
      if (prev && listRef.current) {
        const el = listRef.current.querySelector<HTMLElement>(
          `[data-sticky-id="${prev.id}"] button`,
        );
        if (el) {
          el.focus();
          return;
        }
      }
      addBtnRef.current?.focus();
    });
  }

  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2 min-w-0 flex-1 rounded-md border border-neutral-border bg-neutral-surface-raised p-2"
    >
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary px-0.5">
        {label}
        <span className="ml-1 tppm-mono text-neutral-text-disabled font-normal">
          {items.length + pending.length}
        </span>
      </h3>

      {/* No aria-live here: the curated status <span> below is the single
          announcer for remote adds, so the list mutation isn't double-read. */}
      <ul ref={listRef} className="flex flex-col gap-2 min-h-0">
        {empty && (
          <li className="text-xs italic text-neutral-text-disabled px-1 py-2">
            Be the first to add a card.
          </li>
        )}
        {items.map((item) => (
          <RetroStickyCard
            key={item.id}
            item={item}
            columnLabel={label}
            isRemote={remoteIds.has(item.id)}
            readOnly={readOnly}
            isConverting={convertingId === item.id}
            onEdit={(text) => onEdit(item.id, text)}
            onDelete={() => handleDelete(item.id)}
            onConvert={() => onConvert(item.id)}
          />
        ))}
        {pending.map((p) => (
          <RetroStickyCard
            key={p.tempId}
            item={{
              id: p.tempId,
              retro: '',
              column: p.column,
              text: p.text,
              author: null,
              author_username: 'You',
              position: 0,
              color: '',
              converted_action_item_id: null,
              created_at: '',
              updated_at: '',
            }}
            columnLabel={label}
            isPending={!p.failed}
            hasError={p.failed}
            readOnly={readOnly}
            onEdit={() => undefined}
            onDelete={() => onDiscard(p.tempId)}
            onConvert={() => undefined}
            onRetry={() => onRetry(p.tempId)}
            onDiscard={() => onDiscard(p.tempId)}
          />
        ))}
      </ul>

      {!readOnly &&
        (adding ? (
          <RetroStickyEditor
            label={`Add a card to ${label}`}
            onSubmit={(text) => {
              onAdd(columnKey, text);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            ref={addBtnRef}
            type="button"
            onClick={() => setAdding(true)}
            className={[
              'w-full min-h-[48px] rounded border border-dashed border-neutral-border',
              'text-sm font-medium text-neutral-text-secondary hover:text-brand-primary hover:border-brand-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            ].join(' ')}
          >
            + Add a card
          </button>
        ))}

      {/* Polite SR announcement of remote additions; visually hidden. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
