import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { SearchIcon } from '@/components/Icons';
import { modifierKeyLabel } from '@/lib/platform';
import { useProjectId } from '@/hooks/useProjectId';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { filterCommandItems, type CommandItem } from './commandItems';
import { useCommandItems } from './useCommandItems';

const GROUP_LABEL: Record<CommandItem['group'], string> = {
  task: 'Tasks',
  current: 'Current project',
  jump: 'Jump to',
  backlog: 'Backlog',
  board: 'Board',
  action: 'Actions',
};
// Render + keyboard-nav order. `task` leads (the #1 jump-to ask); `current` (the
// in-context sprint/role targets) sits above the global navigation.
const GROUP_ORDER: CommandItem['group'][] = ['task', 'current', 'jump', 'backlog', 'board', 'action'];

/** Calm mono chip styling per tag. Only "Sprint" (live/now) gets a brand tint;
 *  every other type stays neutral so the result list reads as one quiet column. */
const CHIP_CLASS: Record<string, string> = {
  Sprint: 'bg-brand-primary/10 text-brand-primary',
};
const DEFAULT_CHIP_CLASS = 'bg-neutral-surface-sunken text-neutral-text-secondary';

/** Max task results shown (ADR-0136) — keep the list scannable. */
const TASK_RESULT_CAP = 8;

/**
 * Apply the Tasks section rules to the filtered list, preserving order so the
 * flat list drives both rendering and keyboard nav identically:
 *  - Tasks are query-gated (a cold palette never dumps arbitrary tasks).
 *  - Tasks are capped at {@link TASK_RESULT_CAP}.
 */
function applyTaskRules(items: CommandItem[], query: string): CommandItem[] {
  const hasQuery = query.trim().length > 0;
  const out: CommandItem[] = [];
  let taskCount = 0;
  for (const item of items) {
    if (item.group === 'task') {
      if (!hasQuery || taskCount >= TASK_RESULT_CAP) continue;
      taskCount += 1;
    }
    out.push(item);
  }
  return out;
}

/**
 * ⌘K / Ctrl+K command palette (v2 design system). A centered overlay with a fuzzy
 * filter over Jump-to destinations (My Work, programs, projects) and global
 * Actions. Keyboard-first: ↑/↓ move, Enter runs, Esc closes. Built on the v2
 * golden tokens (shadow-pop is sanctioned for this pop surface; ADR-0126).
 *
 * Accessibility: a labelled modal dialog; the input is a combobox driving a
 * listbox via `aria-activedescendant`, so focus stays in the field while the
 * arrow keys move the visual selection (the standard combobox pattern).
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  // Build live items only while open so the Tier-2 detail queries stay inert.
  const allItems = useCommandItems(open);
  const currentProjectId = useProjectId();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => applyTaskRules(filterCommandItems(allItems, query), query),
    [allItems, query],
  );

  // Reset query + selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer so the element exists and the browser doesn't scroll-jank.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Keep the active row in view as the selection moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[aria-selected="true"]');
    // Optional call: jsdom (tests) does not implement scrollIntoView.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open, items.length]);

  if (!open) return null;

  const clampedActive = Math.min(activeIndex, Math.max(items.length - 1, 0));
  const activeItem = items[clampedActive];

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activeItem?.run();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* Backdrop — click to close (mirrors the shell drawer pattern). */}
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-[560px] overflow-hidden rounded-card border border-neutral-border bg-neutral-surface shadow-pop motion-safe:animate-cmdk-in"
      >
        {/* Search field — owns all keyboard interaction (focus lives here). */}
        <div className="flex items-center gap-2 border-b border-neutral-border px-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-neutral-text-secondary" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeItem ? `cmdk-opt-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            placeholder="Search or jump to…"
            value={query}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            className="w-full bg-transparent py-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none"
          />
          <kbd className="tppm-mono shrink-0 rounded-chip border border-neutral-border px-1.5 py-0.5 text-[10px] text-neutral-text-secondary">
            Esc
          </kbd>
        </div>

        {/* Off-project hint — teaches the current-project capability without nagging.
            Only shown cold (no query) when there is no project in context. */}
        {!currentProjectId && !query.trim() && (
          <p className="border-b border-neutral-border px-4 py-1.5 text-[11px] text-neutral-text-secondary">
            Open a project to search its tasks and sprint.
          </p>
        )}

        {/* Results */}
        <div ref={listRef} id="cmdk-listbox" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-neutral-text-secondary">
              No matches for “{query}”.
            </p>
          ) : (
            GROUP_ORDER.map((group) => {
              const groupItems = items.filter((i) => i.group === group);
              if (groupItems.length === 0) return null;
              return (
                <div
                  key={group}
                  className="py-1"
                  role="group"
                  aria-label={GROUP_LABEL[group]}
                  data-testid={`cmdk-group-${group}`}
                >
                  <p className="tppm-mono px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-text-disabled">
                    {GROUP_LABEL[group]}
                  </p>
                  {groupItems.map((item) => {
                    const isActive = item.id === activeItem?.id;
                    return (
                      <button
                        key={item.id}
                        id={`cmdk-opt-${item.id}`}
                        role="option"
                        aria-selected={isActive}
                        type="button"
                        onMouseMove={() => setActiveIndex(items.indexOf(item))}
                        onClick={() => item.run()}
                        className={`flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm ${
                          isActive ? 'bg-brand-primary/10 text-brand-primary' : 'text-neutral-text-primary'
                        }`}
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="min-w-0 truncate">{item.label}</span>
                          {item.detail && (
                            <span className="tppm-mono hidden shrink-0 text-[11px] text-neutral-text-secondary sm:inline">
                              {item.detail}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {item.gated && (
                            <span className="tppm-mono rounded-chip bg-semantic-at-risk-bg px-1.5 py-0.5 text-[10px] text-semantic-at-risk">
                              EE
                            </span>
                          )}
                          <span
                            className={`tppm-mono rounded-chip px-1.5 py-0.5 text-[10px] ${
                              CHIP_CLASS[item.tag] ?? DEFAULT_CHIP_CLASS
                            }`}
                          >
                            {item.tag}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint — the action verb adapts so a task open is announced as
            "open in drawer" (it does not navigate away) before the user commits. */}
        <div className="flex items-center gap-3 border-t border-neutral-border px-3 py-2 text-[11px] text-neutral-text-secondary">
          <span><kbd className="tppm-mono">↑↓</kbd> navigate</span>
          <span>
            <kbd className="tppm-mono">↵</kbd>{' '}
            {activeItem?.group === 'task' ? 'open in drawer' : 'open'}
          </span>
          <span className="ml-auto tppm-mono">{modifierKeyLabel()}K</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
