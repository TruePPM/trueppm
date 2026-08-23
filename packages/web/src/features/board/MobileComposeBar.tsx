import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface MobileComposeBarProps {
  /**
   * Where a committed row lands, in the user's words — "Backlog", "To Do".
   * Stated on the bar rather than assumed: the destination is derived from the
   * column swiped into view, so it changes under the user without them
   * touching anything that looks like a setting.
   */
  destinationLabel: string;
  /**
   * Commit a typed name. `opts.onError` restores the optimistically-cleared
   * text — the bar clears on submit so a second item can be typed immediately,
   * and a silent POST failure would otherwise lose it with no trace (#2030).
   */
  onCommit: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a create is in flight — the field and Add button go inert. */
  isPending?: boolean;
  /** Dismiss the bar. The FAB is what brings it back. */
  onClose: () => void;
}

/**
 * The touch compose bar (#2952, design `v6-cases.js` case 18).
 *
 * The mobile FAB used to open `TaskFormModal` as a full-screen bottom sheet:
 * a phone-sized form with a name, a description, an assignee, a date and a
 * status, to add one row. This is the same trade the shell's `+ New task`
 * demotion already made (#2031) — a name is the only field the plan actually
 * needs, and everything else is one tap away in the task drawer on the row that
 * now exists.
 *
 * What a bar buys over a sheet, specifically: it does not cover the board. The
 * sheet's own destination was the column *behind* it, which the user could no
 * longer see; the bar leaves that column on screen and names it in the label,
 * so "where does this land" is answered by looking rather than by remembering.
 *
 * It stays open after a commit, with the caret kept, because intake on a phone
 * is bursty — a site walk produces five items, not one. That is the same
 * rapid-fire contract the backlog rail's capture field already has.
 */
export function MobileComposeBar({
  destinationLabel,
  onCommit,
  isPending = false,
  onClose,
}: MobileComposeBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Held in a ref so the Escape listener binds once and never restages on a
  // parent re-render — the handler identity is not what the listener is for.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [value, setValue] = useState('');

  // Open with the caret already in the field. The FAB press was the user
  // saying "I want to type"; making them tap a second time to start is the
  // friction the modal had.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function commit() {
    const name = value.trim();
    if (!name || isPending) return;
    // Clear and re-focus BEFORE the mutation resolves so the next item can be
    // typed into an empty field immediately; `onError` puts it back.
    setValue('');
    inputRef.current?.focus();
    onCommit(name, {
      // Never clobber a half-typed replacement to hand back the failed one.
      onError: () => setValue((cur) => (cur === '' ? name : cur)),
    });
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commit();
  }

  // Escape is bound to the BAR, not to the input: the field advertises
  // `aria-keyshortcuts="Enter Escape"`, and once focus has tabbed onto Add or ×
  // — reachable with a Bluetooth keyboard on a tablet — an input-bound handler
  // would silently stop honoring the shortcut it advertises. A native listener
  // on the wrapper rather than an `onKeyDown` prop, because the wrapper is a
  // plain container: giving it a JSX keyboard handler makes it a non-native
  // interactive element, and giving it a role to satisfy that would make the
  // bar announce as something it is not (it is modeless and traps nothing).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCloseRef.current();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      // Sits ON the 56px bottom nav (`h-14`), not over the board — the whole
      // point is that the destination column stays visible above it.
      className="fixed bottom-14 inset-x-0 z-20 md:hidden border-t border-neutral-border
        bg-neutral-surface-raised px-3 py-2"
      ref={barRef}
      data-testid="mobile-compose-bar"
    >
      <div className="flex items-center justify-between pb-1.5">
        <span className="text-xs text-neutral-text-secondary">
          Lands in{' '}
          <span className="font-semibold text-neutral-text-primary">{destinationLabel}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close compose bar"
          // 24px glyph + invisible expander to the 44px touch floor (rule 5).
          className="relative inline-flex items-center justify-center rounded-control
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            before:absolute before:inset-[-10px] before:content-['']"
          style={{ width: 24, height: 24 }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <form
        aria-label={`Add a task to ${destinationLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
        className="flex items-center gap-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          // `readOnly`, never `disabled`, while a create is in flight. A
          // disabled element is blurred by the browser, which on a phone closes
          // the soft keyboard — and nothing re-focuses on re-enable, so every
          // item after the first would cost a tap plus a keyboard re-open. That
          // is the opposite of the rapid-fire intake this bar exists for. The
          // `isPending` guard in `commit()` is what stops a double-fire.
          readOnly={isPending}
          placeholder="Name a task, then press Enter"
          aria-label={`Task name — lands in ${destinationLabel}`}
          aria-keyshortcuts="Enter Escape"
          className="flex-1 min-w-0 rounded-control border border-neutral-border bg-neutral-surface
            px-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary
            read-only:cursor-progress"
          // 44px touch floor (rule 5) — this is the primary phone input.
          style={{ height: 44 }}
        />
        <button
          type="submit"
          disabled={isPending || value.trim() === ''}
          aria-busy={isPending}
          className="shrink-0 rounded-control bg-brand-primary px-4 text-sm font-semibold
            text-neutral-text-inverse
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
            disabled:cursor-not-allowed"
          style={{ height: 44, minWidth: 64 }}
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </form>
    </div>
  );
}
