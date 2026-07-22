import { useEffect, useRef, useState } from 'react';

const MAX_LEN = 2000;

interface Props {
  /** Initial text — empty for an add, the existing body for an edit. */
  initialText?: string;
  /** Accessible label for the textarea (e.g. "Add a card to What went well"). */
  label: string;
  /** Commit the text (create or save). No-op for empty/whitespace on add. */
  onSubmit: (text: string) => void;
  /** Cancel the editor without committing. */
  onCancel: () => void;
}

/**
 * Inline textarea for adding or editing a retro sticky (ADR-0117 §6).
 *
 * Autofocuses on mount so a keyboard "+ Add a card" flow lands the cursor in
 * the textarea immediately (WCAG keyboard-add requirement). Enter commits;
 * Shift+Enter inserts a newline; Escape cancels. Enforces the 2000-char server
 * cap with a live counter.
 */
export function RetroStickyEditor({ initialText = '', label, onSubmit, onCancel }: Props) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      // Place the caret at the end for edits.
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  function commit() {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={commit}
        rows={3}
        maxLength={MAX_LEN}
        aria-label={label}
        placeholder="Type a card… (Enter to save, Esc to cancel)"
        className="w-full px-2 py-1.5 rounded border border-neutral-border bg-neutral-surface
          text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary resize-y
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <div className="flex items-center justify-between">
        <span
          className="text-xs tppm-mono text-neutral-text-disabled"
          aria-live="polite"
        >
          {text.length}/{MAX_LEN}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center px-3 text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault() /* keep textarea focus through blur */}
            onClick={commit}
            className="inline-flex min-h-[44px] items-center px-3 text-xs font-medium text-brand-primary hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
