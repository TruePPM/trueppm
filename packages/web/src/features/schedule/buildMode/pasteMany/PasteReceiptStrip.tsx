import type { PasteSummary } from './buildPasteOperations';
import { formatChord } from '@/lib/platform';

const FIELD_LABEL: Record<string, string> = { name: 'name', duration: 'duration', owner: 'owner' };

/** Builds the receipt copy — "38 rows pasted. Hierarchy read from leading
 *  indentation — 4 levels. name · duration · owner matched · 2 columns ignored
 *  · 3 rows need a duration." Each clause only appears when it has something
 *  to say, so a clean flat paste reads as a short, confident sentence. */
export function buildPasteReceiptMessage(summary: PasteSummary): string {
  const noun = `row${summary.rowCount !== 1 ? 's' : ''}`;
  const sentences = [`${summary.rowCount} ${noun} pasted.`];
  if (summary.levelCount > 1) {
    sentences.push(`Hierarchy read from leading indentation — ${summary.levelCount} levels.`);
  }

  const clauses: string[] = [];
  if (summary.matchedFields.length > 0) {
    clauses.push(`${summary.matchedFields.map((f) => FIELD_LABEL[f] ?? f).join(' · ')} matched`);
  }
  if (summary.ignoredColumnCount > 0) {
    clauses.push(
      `${summary.ignoredColumnCount} column${summary.ignoredColumnCount !== 1 ? 's' : ''} ignored`,
    );
  }
  if (summary.needsDurationCount > 0) {
    const isPlural = summary.needsDurationCount !== 1;
    clauses.push(
      `${summary.needsDurationCount} row${isPlural ? 's' : ''} need${isPlural ? '' : 's'} a duration`,
    );
  }
  if (clauses.length > 0) sentences.push(`${clauses.join(' · ')}.`);
  return sentences.join(' ');
}

interface PasteReceiptStripProps {
  summary: PasteSummary;
  isUndoing: boolean;
  onUndo: () => void;
  onKeep: () => void;
  onMapColumns: () => void;
}

/**
 * Undo-able receipt after a paste-many batch commits (#2724). Stays on screen
 * until the author acts — Keep, Undo (⌘Z), or "Map columns…" — rather than
 * auto-dismissing like a delete toast: the needs-a-duration count it reports
 * stays walkable with F8 for as long as the strip is up.
 */
export function PasteReceiptStrip({
  summary,
  isUndoing,
  onUndo,
  onKeep,
  onMapColumns,
}: PasteReceiptStripProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="paste-receipt-strip"
      className="flex items-center gap-3 w-full px-3 py-2 rounded border border-neutral-border
        bg-neutral-surface-raised text-xs text-neutral-text-primary"
    >
      <span className="flex-1 min-w-0">{buildPasteReceiptMessage(summary)}</span>
      <button
        type="button"
        onClick={onMapColumns}
        className="flex-shrink-0 h-7 px-2 rounded text-xs font-medium text-neutral-text-secondary
          hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Map columns…
      </button>
      <button
        type="button"
        onClick={onUndo}
        disabled={isUndoing}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-semibold text-brand-primary
          underline underline-offset-2 hover:no-underline disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {isUndoing ? 'Undoing…' : `Undo (${formatChord('mod+z')})`}
      </button>
      <button
        type="button"
        onClick={onKeep}
        disabled={isUndoing}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Keep
      </button>
    </div>
  );
}
