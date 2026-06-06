import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Program } from '@/api/types';
import type { ProjectScope } from '@/stores/shellStore';

interface ScopeOption {
  /** 'all' | 'none' | programId */
  id: ProjectScope;
  name: string;
  /** Number of projects in this scope. */
  count: number;
}

interface Props {
  scope: ProjectScope;
  onScope: (scope: ProjectScope) => void;
  programs: Program[];
  /** Per-program project counts, keyed by program id. */
  countFor: (programId: string) => number;
  /** Total project count (drives the "All programs" option). */
  totalCount: number;
  /** Count of projects with no program; the "No program" option is hidden when 0. */
  noProgramCount: number;
  /** Opens the New Program modal. */
  onNewProgram: () => void;
}

/**
 * Searchable program scope picker for the sidebar (issue #959, Direction C "at scale").
 *
 * Replaces the old flat PROGRAMS list. A single fixed-height control shows the
 * active scope + its project count; clicking opens a searchable dropdown that
 * stays one control tall no matter how many programs exist. Selecting a program
 * narrows the project list below it; "All programs" clears the scope.
 *
 * Accessibility: the trigger is `aria-haspopup="listbox"`; the open popover is a
 * combobox search input over a `role="listbox"` of `role="option"` rows with
 * roving `aria-activedescendant` highlight (no per-row tab stops), mirroring the
 * settings context switcher pattern (web-rule 124).
 */
export function ProjectScopePicker({
  scope,
  onScope,
  programs,
  countFor,
  totalCount,
  noProgramCount,
  onNewProgram,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const optionPrefix = useId();

  const options = useMemo<ScopeOption[]>(() => {
    const q = query.trim().toLowerCase();
    const matchesAll = !q || 'all programs'.includes(q);
    const base: ScopeOption[] = matchesAll
      ? [{ id: 'all', name: 'All programs', count: totalCount }]
      : [];
    const progOpts: ScopeOption[] = programs
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => ({ id: p.id, name: p.name, count: countFor(p.id) }));
    const noneOpt: ScopeOption[] =
      noProgramCount > 0 && (!q || 'no program'.includes(q))
        ? [{ id: 'none', name: 'No program', count: noProgramCount }]
        : [];
    return [...base, ...progOpts, ...noneOpt];
  }, [query, programs, countFor, totalCount, noProgramCount]);

  const scopeName =
    scope === 'all'
      ? 'All programs'
      : scope === 'none'
        ? 'No program'
        : (programs.find((p) => p.id === scope)?.name ?? 'All programs');
  const scopeCount =
    scope === 'all'
      ? totalCount
      : scope === 'none'
        ? noProgramCount
        : countFor(scope);

  // Keep the active descendant in range as the filtered list shrinks/grows.
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(i, 0), Math.max(options.length - 1, 0)));
  }, [options.length]);

  // Focus the filter input when the popover opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the keyboard-highlighted option in view inside the scrollable list.
  // (scrollIntoView is unimplemented in jsdom, so guard the call for tests.)
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${optionPrefix}-${activeIndex}`);
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, optionPrefix]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function pick(id: ProjectScope) {
    onScope(id);
    close();
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (options.length ? (i + 1) % options.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt) pick(opt.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Two-stage Escape: clear the query first, then close.
      if (query) setQuery('');
      else close();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(Math.max(options.length - 1, 0));
    }
  }

  return (
    <div ref={rootRef} className="relative px-2 pb-2 pt-1">
      <div className="flex items-center justify-between px-1">
        <h2
          className="text-xs font-semibold uppercase tracking-widest text-chrome-text-secondary"
          aria-label="Program scope"
        >
          Program
        </h2>
        {/* 44x44 touch target with 12x12 icon (rule 5). */}
        <button
          type="button"
          onClick={onNewProgram}
          aria-label="New program"
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded
            text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Scope control */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Program scope: ${scopeName}, ${scopeCount} project${scopeCount === 1 ? '' : 's'}`}
        className={[
          'mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors',
          'bg-chrome-surface-raised border',
          open ? 'border-brand-primary' : 'border-chrome-border/15 hover:border-chrome-border/30',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
          'focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
        ].join(' ')}
      >
        {/* Programs (grid) glyph */}
        <svg
          width="15"
          height="15"
          viewBox="0 0 14 14"
          fill="currentColor"
          aria-hidden="true"
          className="shrink-0 text-brand-primary"
        >
          <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-chrome-text-primary">
          {scopeName}
        </span>
        <span className="tppm-mono shrink-0 rounded bg-chrome-surface px-1.5 text-xs font-medium text-chrome-text-secondary">
          {scopeCount}
        </span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0 text-chrome-text-secondary transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-2 right-2 z-30 mt-1 overflow-hidden rounded-lg border border-chrome-border/20 bg-chrome-surface-raised"
        >
          <div className="border-b border-chrome-border/10 p-2">
            <div className="flex h-8 items-center gap-2 rounded-md border border-chrome-border/15 bg-chrome-surface px-2 focus-within:border-brand-primary">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-chrome-text-secondary">
                <path d="M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM10.6 10.6l2.9 2.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={options[activeIndex] ? `${optionPrefix}-${activeIndex}` : undefined}
                aria-label="Filter programs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Filter programs…"
                className="min-w-0 flex-1 bg-transparent text-sm text-chrome-text-primary outline-none placeholder:text-chrome-text-secondary"
              />
            </div>
          </div>
          <ul id={listboxId} role="listbox" aria-label="Program scope" className="max-h-56 overflow-y-auto p-1.5">
            {options.map((opt, i) => {
              const selected = scope === opt.id;
              const active = i === activeIndex;
              return (
                // Keyboard selection is handled on the combobox input via
                // aria-activedescendant (Arrow/Enter); the option click is a
                // pointer affordance, so no per-option key handler is needed.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={opt.id}
                  id={`${optionPrefix}-${i}`}
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(opt.id)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={[
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    selected ? 'text-brand-primary' : 'text-chrome-text-primary',
                    active ? 'bg-neutral-text-primary/5' : '',
                  ].join(' ')}
                >
                  <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold' : ''}`}>
                    {opt.name}
                  </span>
                  <span className="tppm-mono shrink-0 rounded bg-chrome-surface px-1.5 text-xs font-medium text-chrome-text-secondary">
                    {opt.count}
                  </span>
                  {selected && (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-brand-primary">
                      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </li>
              );
            })}
            {options.length === 0 && (
              <li role="status" className="px-2 py-3 text-center text-sm text-chrome-text-secondary">
                No programs match
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
