/**
 * TimezoneFormatSection — per-user timezone + date-format preferences on
 * /me/settings/general (#1953, ADR-0410).
 *
 * Two independent display preferences, each with its own optimistic local state
 * and per-change auto-save (no save bar): selecting a value PATCHes immediately,
 * announces "Saved." in the shared aria-live status line, and reverts on error.
 * The two mutations (timezone, date_format) revert independently. Offline blocks
 * both writes with an inline note.
 *
 * The timezone control is a rule-124 searchable switcher (trigger → popover →
 * combobox + listbox) rather than a native ~400-item <select>: native type-ahead
 * only prefix-matches, so "london" could never surface "Europe/London". The
 * date-format control is a native radio <fieldset> (rule 167 gives arrow-key
 * roving for free) with a live sample rendered through the shared styler so the
 * user sees the actual output of each style.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUpdateTimezone, useUpdateDateFormat } from '@/hooks/useUpdateDisplayPrefs';
import { formatDateWithStyle, type DateFormatStyle } from '@/lib/dateFormatStyle';

const SAVED_TOAST_MS = 3000;

/**
 * Small curated fallback for the (rare) engines without `Intl.supportedValuesOf`.
 * Never the primary source — just enough to keep the picker usable.
 */
const FALLBACK_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
];

interface DateFormatOption {
  value: DateFormatStyle;
  /** Style name (primary, color-independent label). */
  name: string;
  /** The WCAG-1.4.1 non-color differentiator — us vs auto can render identically. */
  note: string;
}

const DATE_FORMAT_OPTIONS: DateFormatOption[] = [
  { value: 'auto', name: 'Automatic', note: 'Follows your device' },
  { value: 'iso', name: 'ISO 8601', note: 'Year first' },
  { value: 'us', name: 'US', note: 'Month first' },
  { value: 'eu', name: 'European', note: 'Day first' },
];

function CheckGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className="shrink-0 text-semantic-on-track"
      aria-hidden="true"
    >
      <path
        d="M3 8l3.5 3.5L13 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function TimezoneFormatSection() {
  const { user } = useCurrentUser();
  const updateTimezone = useUpdateTimezone();
  const updateDateFormat = useUpdateDateFormat();

  const loading = user === undefined;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  // Optimistic selections — seeded from the server value, reverted on error.
  const [tzSelected, setTzSelected] = useState<string | null>(null);
  const [tzSavedAt, setTzSavedAt] = useState<number | null>(null);
  const [dfSelected, setDfSelected] = useState<DateFormatStyle | null>(null);
  const [dfSavedAt, setDfSavedAt] = useState<number | null>(null);

  const serverTz = user?.timezone ?? 'auto';
  const tzValue = tzSelected ?? serverTz;
  const serverDf = user?.date_format ?? 'auto';
  const dfValue: DateFormatStyle = dfSelected ?? serverDf;

  // Browser's detected zone — labels the "auto" option and the trigger.
  const browserZone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const triggerLabel =
    tzValue === 'auto' ? `Automatic — detected: ${browserZone}` : tzValue;

  // ── Timezone popover state ────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const headingId = `${baseId}-heading`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Full IANA list, computed once. Guard the (rare) absence of supportedValuesOf.
  const zones = useMemo<string[]>(() => {
    const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return typeof fn === 'function' ? fn('timeZone') : FALLBACK_ZONES;
  }, []);

  // Case-insensitive substring on the whole id, plus a normalized form so both
  // "europe" and "london" match "Europe/London".
  const filteredZones = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => {
      const lower = z.toLowerCase();
      const normalized = lower.replace(/_/g, ' ').replace(/\//g, ' ');
      return lower.includes(q) || normalized.includes(q);
    });
  }, [zones, query]);

  // Keyboard-navigable option list: auto is always index 0 (exempt from filter).
  const options = useMemo(
    () => ['auto', ...filteredZones],
    [filteredZones],
  );

  // Auto-dismiss each "Saved." indicator after 3 s (independent timers).
  useEffect(() => {
    if (tzSavedAt == null) return;
    const handle = setTimeout(() => setTzSavedAt(null), SAVED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [tzSavedAt]);

  useEffect(() => {
    if (dfSavedAt == null) return;
    const handle = setTimeout(() => setDfSavedAt(null), SAVED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [dfSavedAt]);

  // On open: focus the search input and seed the highlight to the current zone.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const idx = tzValue === 'auto' ? 0 : zones.indexOf(tzValue) + 1;
    setActiveIndex(idx > 0 ? idx : 0);
    // Only re-seed when the popover transitions open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the highlight to the top whenever the filter changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Click-outside dismiss — closes without commit, does not return focus.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  function closePopover(returnFocus: boolean) {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }

  function commitTimezone(next: string) {
    closePopover(true);
    if (next === tzValue) return; // no-op beyond closing
    if (offline) return; // inline note explains; no PATCH while offline
    const previous = tzValue;
    setTzSelected(next); // optimistic
    updateTimezone.mutate(next, {
      onSuccess: () => setTzSavedAt(Date.now()),
      onError: () => setTzSelected(previous), // revert
    });
  }

  function commitDateFormat(next: DateFormatStyle) {
    if (next === dfValue) return;
    if (offline) return;
    const previous = dfValue;
    setDfSelected(next); // optimistic
    updateDateFormat.mutate(next, {
      onSuccess: () => setDfSavedAt(Date.now()),
      onError: () => setDfSelected(previous), // revert
    });
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, n - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(Math.max(0, n - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const value = options[activeIndex];
        if (value) commitTimezone(value);
        break;
      }
      case 'Escape':
        e.preventDefault();
        // Two-stage: clear a non-empty query first; only close when empty.
        if (query) {
          setQuery('');
          setActiveIndex(0);
        } else {
          closePopover(true);
        }
        break;
    }
  }

  const controlsDisabled = loading || offline;
  const activeDescendant =
    activeIndex >= 0 && activeIndex < options.length ? optionId(activeIndex) : undefined;

  const anyError = updateTimezone.isError || updateDateFormat.isError;
  const anySavedAt = tzSavedAt != null || dfSavedAt != null;

  return (
    <>
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-4 rounded-card border border-neutral-border p-4"
      >
        <div>
          <h2 id={headingId} className="text-sm font-semibold text-neutral-text-primary">
            Timezone &amp; date format
          </h2>
          <p className="mt-0.5 text-sm text-neutral-text-secondary">
            Sets how times and dates look for you. Changing your timezone re-clocks when things
            happened — activity, comments, &ldquo;2 hours ago&rdquo;. The date format changes how
            every date is written, including the schedule and forecast.
          </p>
        </div>

        {/* ── Timezone control ── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-text-primary">Timezone</span>
          {loading ? (
            <div
              aria-busy="true"
              aria-hidden="true"
              className="h-11 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse"
            />
          ) : (
            <div className="relative">
              <button
                ref={triggerRef}
                type="button"
                disabled={controlsDisabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`Timezone: ${triggerLabel}`}
                onClick={() => setOpen((v) => !v)}
                onKeyDown={handleTriggerKeyDown}
                className="w-full h-11 flex items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-3 text-left text-sm text-neutral-text-primary
                  disabled:cursor-not-allowed disabled:text-neutral-text-secondary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                <span className="flex-1 truncate">{triggerLabel}</span>
                <span aria-hidden="true" className="shrink-0 text-neutral-text-secondary">
                  ▾
                </span>
              </button>

              {open && (
                <div
                  ref={popoverRef}
                  className="absolute left-0 right-0 top-full z-50 mt-1 rounded-card border border-neutral-border bg-neutral-surface-raised shadow-pop"
                >
                  <div
                    className="flex items-center gap-2 border-b border-neutral-border px-3 h-11
                      focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary"
                  >
                    <input
                      ref={inputRef}
                      type="text"
                      role="combobox"
                      aria-expanded
                      aria-controls={listboxId}
                      aria-activedescendant={activeDescendant}
                      aria-label="Search timezones"
                      placeholder="Search by city or region…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={handleInputKeyDown}
                      className="w-full min-w-0 bg-transparent text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
                    />
                  </div>

                  <ul
                    id={listboxId}
                    role="listbox"
                    aria-label="Timezones"
                    className="max-h-[50vh] overflow-y-auto py-1"
                  >
                    {/* Auto — pinned above a hairline divider, exempt from the filter. */}
                    <li
                      id={optionId(0)}
                      role="option"
                      aria-selected={tzValue === 'auto'}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        commitTimezone('auto');
                      }}
                      className={[
                        'min-h-11 flex items-center gap-2 px-3 text-sm cursor-pointer border-b border-neutral-border text-neutral-text-primary',
                        activeIndex === 0 ? 'bg-brand-primary/10' : 'hover:bg-neutral-surface',
                      ].join(' ')}
                    >
                      <span className="flex-1">Automatic — detected: {browserZone}</span>
                      {tzValue === 'auto' && <CheckGlyph />}
                    </li>

                    {filteredZones.length === 0 ? (
                      <li
                        role="status"
                        className="flex items-center px-3 min-h-11 text-sm text-neutral-text-secondary"
                      >
                        No timezones match &ldquo;{query}&rdquo;.
                      </li>
                    ) : (
                      filteredZones.map((z, i) => {
                        const idx = i + 1;
                        const selected = tzValue === z;
                        return (
                          <li
                            key={z}
                            id={optionId(idx)}
                            role="option"
                            aria-selected={selected}
                            onPointerDown={(e) => {
                              e.preventDefault();
                              commitTimezone(z);
                            }}
                            className={[
                              'min-h-11 flex items-center gap-2 px-3 text-sm cursor-pointer text-neutral-text-primary',
                              activeIndex === idx
                                ? 'bg-brand-primary/10'
                                : 'hover:bg-neutral-surface',
                            ].join(' ')}
                          >
                            <span className="flex-1">{z}</span>
                            {selected && <CheckGlyph />}
                          </li>
                        );
                      })
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Date format control ── */}
        <fieldset className="border-0 p-0 m-0 flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-neutral-text-primary">Date format</legend>
          {DATE_FORMAT_OPTIONS.map((opt) => {
            const sample = formatDateWithStyle(new Date(), opt.value, 'UTC', 'long');
            return (
              <label
                key={opt.value}
                className="min-h-11 flex items-center gap-3 cursor-pointer"
              >
                <input
                  type="radio"
                  name="date-format"
                  value={opt.value}
                  checked={dfValue === opt.value}
                  disabled={controlsDisabled}
                  onChange={() => commitDateFormat(opt.value)}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                <span className="font-medium text-sm text-neutral-text-primary flex-1">
                  {opt.name}
                </span>
                <span className="text-xs text-neutral-text-secondary">{opt.note}</span>
                <span className="text-sm ml-auto tppm-mono">{sample}</span>
              </label>
            );
          })}
        </fieldset>

        {offline && (
          <p className="text-xs text-neutral-text-secondary">
            You&rsquo;re offline — reconnect to change your timezone or date format.
          </p>
        )}
      </section>

      <p aria-live="polite" role="status" className="text-xs text-neutral-text-secondary">
        {anyError
          ? "Couldn't save. Try again."
          : anySavedAt
            ? 'Saved.'
            : 'Changes save automatically.'}
      </p>
    </>
  );
}
