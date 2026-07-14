import { useMemo, useState } from 'react';
import type { Calendar } from '@/hooks/useProjectCalendars';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SearchIcon, CloseIcon } from '@/components/Icons';
import { EnterpriseBadge } from '@/features/settings/components/EnterpriseBadge';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '@/components/dialog';
import { summarizeCalendar } from './calendarDisplay';

/** Enterprise-only picker affordances — rendered disabled, never functional. */
const ENTERPRISE_PICKER_ITEMS = [
  { name: 'Import from public-holiday feed (iCal)', sum: 'Sync national holidays automatically' },
  { name: 'Resource PTO calendars', sum: 'Per-person availability' },
] as const;

interface AddCalendarPickerProps {
  /** The shared org calendar library (already-applied ones are flagged). */
  library: Calendar[];
  /** Calendar ids already applied as overlays — shown disabled as "Applied". */
  appliedIds: ReadonlySet<string>;
  /** Render as a desktop popover or a mobile bottom sheet. */
  variant: 'popover' | 'sheet';
  /** True while the library query is still resolving — shows a loading row
   *  instead of the "no calendars match" empty state. */
  loading: boolean;
  submitting: boolean;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}

/** A small check glyph — no dedicated icon exists in the shared set. */
function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 7V5a3.5 3.5 0 017 0v2M3.5 7h9v6h-9z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Multi-select calendar picker (#906). Desktop renders an inline popover;
 * mobile (`variant="sheet"`) renders a drag-handle bottom sheet over a scrim.
 * Both share the same list, search, and Enterprise-gated section.
 *
 * Focus is trapped while open and restored to the trigger on close (WCAG
 * 2.4.3). Escape, the scrim tap (sheet), the header close button (sheet), and
 * the footer Cancel button all route through the standard dismiss-guard
 * (web-rule 217, issue #1913): with one or more calendars selected the picker
 * prompts "Discard unsaved changes?" instead of silently dropping the
 * selection; with nothing selected it closes immediately.
 */
export function AddCalendarPicker({
  library,
  appliedIds,
  variant,
  loading,
  submitting,
  onAdd,
  onClose,
}: AddCalendarPickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // A non-empty selection is unsaved input — dismissing without confirming
  // would silently drop it (issue #1913). The guard owns its own Escape
  // listener, so the focus trap below is not given an onEscape handler.
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty: selected.size > 0,
    onClose,
  });
  const containerRef = useFocusTrap<HTMLDivElement>(!guardOpen);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? library.filter((c) => c.name.toLowerCase().includes(q)) : library;
  }, [library, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const count = selected.size;
  const list = (
    <div className="max-h-[280px] overflow-auto p-1.5" role="listbox" aria-label="Calendar library" aria-multiselectable="true">
      {loading && (
        <p className="px-3 py-6 text-center text-[12px] text-neutral-text-secondary" aria-live="polite">
          Loading calendars…
        </p>
      )}
      {!loading && filtered.length === 0 && (
        <p className="px-3 py-6 text-center text-[12px] text-neutral-text-secondary">
          {query ? `No calendars match “${query}”.` : 'No calendars in the library yet.'}
        </p>
      )}
      {filtered.map((cal) => {
        const applied = appliedIds.has(cal.id);
        const checked = selected.has(cal.id);
        return (
          <button
            key={cal.id}
            type="button"
            role="option"
            aria-selected={checked || applied}
            aria-disabled={applied || undefined}
            disabled={applied}
            onClick={() => !applied && toggle(cal.id)}
            className={[
              'flex w-full items-center gap-3 rounded-control px-2.5 py-2.5 text-left min-h-[44px]',
              applied
                ? 'opacity-60 cursor-not-allowed'
                : 'hover:bg-neutral-surface-sunken cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            ].join(' ')}
          >
            <span
              className={[
                'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border',
                checked || applied
                  ? 'border-brand-primary bg-brand-primary text-white'
                  : 'border-neutral-border text-transparent',
              ].join(' ')}
              aria-hidden="true"
            >
              {(checked || applied) && <CheckGlyph />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-neutral-text-primary">
                {cal.name}
              </span>
              <span className="block truncate text-[11.5px] text-neutral-text-secondary">
                {summarizeCalendar(cal, cal.exceptions.length > 0 ? 'holidays' : 'project')}
              </span>
            </span>
            {applied && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-disabled">
                Applied
              </span>
            )}
          </button>
        );
      })}

      {/* Enterprise-gated affordances — visible but never functional in OSS. */}
      <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-disabled">
        Available in TruePPM Enterprise
      </div>
      {ENTERPRISE_PICKER_ITEMS.map((item) => (
        <div
          key={item.name}
          className="flex items-center gap-3 rounded-control px-2.5 py-2.5 opacity-60"
          aria-disabled="true"
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-neutral-border text-neutral-text-disabled">
            <LockGlyph />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center text-[13px] font-medium text-neutral-text-primary">
              {item.name}
              <EnterpriseBadge />
            </span>
            <span className="block truncate text-[11.5px] text-neutral-text-secondary">
              {item.sum}
            </span>
          </span>
        </div>
      ))}
    </div>
  );

  const search = (
    <div className="flex h-[38px] items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface-sunken px-2.5 text-neutral-text-secondary">
      <SearchIcon aria-hidden="true" />
      <input
        // Initial focus is delegated to useFocusTrap, which focuses the first
        // focusable in the dialog (this search field in the popover) on open —
        // so no `autoFocus` prop is needed (and jsx-a11y/no-autofocus is satisfied).
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search calendars…"
        aria-label="Search calendars"
        className="w-full bg-transparent text-[13px] text-neutral-text-primary outline-none placeholder:text-neutral-text-disabled"
      />
    </div>
  );

  const footer = (
    <div className="flex items-center gap-2 border-t border-neutral-border bg-neutral-surface-raised px-3 py-2.5">
      <span className="flex-1 text-[12px] text-neutral-text-secondary" aria-live="polite">
        {count} selected
      </span>
      <button
        type="button"
        onClick={requestClose}
        className="min-h-[44px] rounded-control px-3 text-[13px] font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-[32px]"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => onAdd([...selected])}
        disabled={count === 0 || submitting}
        className="inline-flex min-h-[44px] items-center rounded-control border border-brand-primary-dark bg-brand-primary px-3.5 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-[32px]"
      >
        {submitting ? 'Adding…' : `Add ${count} calendar${count === 1 ? '' : 's'}`}
      </button>
    </div>
  );

  if (variant === 'sheet') {
    return (
      <>
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Scrim — a real button so dismiss-on-tap has keyboard parity (Enter/Space);
              Escape also routes through the dismiss-guard (web-rule 217). */}
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="absolute inset-0 bg-neutral-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
          />
          <div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add calendars to this project"
            className="relative flex max-h-[88%] flex-col overflow-hidden rounded-t-[20px] bg-neutral-surface shadow-pop"
          >
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-neutral-border" aria-hidden="true" />
            <div className="flex items-center gap-2 px-4 pb-2 pt-1.5">
              <h2 className="flex-1 text-[15px] font-semibold text-neutral-text-primary">
                Add calendars to this project
              </h2>
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close"
                className="flex h-11 w-11 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
            <div className="px-4 pb-3">{search}</div>
            <div className="flex-1 overflow-auto">{list}</div>
            {footer}
          </div>
        </div>
        {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
      </>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        role="dialog"
        aria-label="Add calendars to this project"
        className="mt-2.5 w-full max-w-[380px] overflow-hidden rounded-card border border-neutral-border bg-neutral-surface shadow-pop"
      >
        <div className="border-b border-neutral-border px-3.5 pb-2.5 pt-3">
          <div className="mb-2.5 text-[13px] font-semibold text-neutral-text-primary">
            Add calendars to this project
          </div>
          {search}
        </div>
        {list}
        {footer}
      </div>
      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
    </>
  );
}
