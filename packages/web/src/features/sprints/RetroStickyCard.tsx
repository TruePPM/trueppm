import { useState } from 'react';
import type { RetroBoardItem } from '@/hooks/useRetroBoard';
import { RetroStickyEditor } from './RetroStickyEditor';

interface Props {
  item: RetroBoardItem;
  columnLabel: string;
  /** True while the optimistic create is in flight (renders at 70% opacity). */
  isPending?: boolean;
  /** True when the last create failed — shows inline retry/discard, keeps text. */
  hasError?: boolean;
  /** True to fade/slide in (a card added remotely by a peer). Motion-safe only. */
  isRemote?: boolean;
  /** Read-only board (CANCELLED sprint or below-edit lifecycle) — hide affordances. */
  readOnly?: boolean;
  onEdit: (text: string) => void;
  onDelete: () => void;
  onConvert: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Whether a convert-to-action request is in flight for this card. */
  isConverting?: boolean;
}

/**
 * Map an optional DS-token swatch key to a decorative dot color class. The dot
 * is purely presentational (aria-hidden) — color never carries meaning, so a
 * screen reader is told nothing by it (WCAG 1.4.1 use-of-color).
 */
function swatchClass(color: string): string {
  switch (color) {
    case 'on-track':
      return 'bg-semantic-on-track';
    case 'at-risk':
      return 'bg-semantic-at-risk';
    case 'critical':
      return 'bg-semantic-critical';
    case 'warning':
      return 'bg-semantic-warning';
    case 'primary':
      return 'bg-brand-primary';
    default:
      return 'bg-neutral-text-disabled';
  }
}

/**
 * A single retro discussion sticky (ADR-0117 §1/§6).
 *
 * Renders the body, an author attribution chip, an optional decorative color
 * dot, and the convert/edit/delete affordances (each ≥44px touch target).
 * Optimistic creates render at 70% opacity until confirmed; a failed create
 * surfaces an inline "Couldn't save" with retry/discard and keeps the text
 * editable so the card never silently vanishes.
 */
export function RetroStickyCard({
  item,
  columnLabel,
  isPending = false,
  hasError = false,
  isRemote = false,
  readOnly = false,
  onEdit,
  onDelete,
  onConvert,
  onRetry,
  onDiscard,
  isConverting = false,
}: Props) {
  const [editing, setEditing] = useState(false);
  const converted = item.converted_action_item_id != null;
  const author = item.author_username ?? 'Unknown';

  if (editing) {
    return (
      <li className="rounded border border-neutral-border bg-neutral-surface p-2">
        <RetroStickyEditor
          initialText={item.text}
          label={`Edit card in ${columnLabel}`}
          onSubmit={(text) => {
            setEditing(false);
            if (text !== item.text) onEdit(text);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      data-sticky-id={item.id}
      className={[
        'group relative rounded border border-neutral-border bg-neutral-surface p-2 flex flex-col gap-1.5',
        isPending ? 'opacity-70' : '',
        isRemote ? 'motion-safe:animate-retro-card-in border-l-2 border-l-brand-primary' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-start gap-1.5">
        {item.color ? (
          <span
            aria-hidden="true"
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${swatchClass(item.color)}`}
          />
        ) : null}
        <p className="flex-1 text-sm text-neutral-text-primary whitespace-pre-wrap break-words">
          {item.text}
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-text-secondary tppm-mono">
          {author}
          {converted ? ' · converted' : ''}
        </span>

        {!readOnly && !isPending && !hasError && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onConvert}
              disabled={converted || isConverting}
              aria-label={
                converted
                  ? `Card already converted to an action item`
                  : `Convert card "${truncate(item.text)}" to an action item`
              }
              title={converted ? 'Already converted' : 'Convert to action item'}
              className="inline-flex h-11 w-11 items-center justify-center rounded text-neutral-text-secondary
                hover:text-brand-primary disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true">⤴</span>
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit card "${truncate(item.text)}"`}
              title="Edit"
              className="inline-flex h-11 w-11 items-center justify-center rounded text-neutral-text-secondary
                hover:text-brand-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true">✎</span>
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete card "${truncate(item.text)}"`}
              title="Delete"
              className="inline-flex h-11 w-11 items-center justify-center rounded text-neutral-text-secondary
                hover:text-semantic-critical
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
      </div>

      {hasError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-semantic-critical">
          <span>Couldn&apos;t save</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="text-neutral-text-secondary underline
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
