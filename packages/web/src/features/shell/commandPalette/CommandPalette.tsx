import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { SearchIcon } from '@/components/Icons';
import { modifierKeyLabel } from '@/lib/platform';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { filterCommandItems, type CommandItem } from './commandItems';
import { useCommandItems } from './useCommandItems';

const GROUP_LABEL: Record<CommandItem['group'], string> = { jump: 'Jump to', action: 'Actions' };
const GROUP_ORDER: CommandItem['group'][] = ['jump', 'action'];

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
  const allItems = useCommandItems();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => filterCommandItems(allItems, query), [allItems, query]);

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
                <div key={group} className="py-1">
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
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                          isActive ? 'bg-brand-primary/10 text-brand-primary' : 'text-neutral-text-primary'
                        }`}
                      >
                        <span className="min-w-0 truncate">{item.label}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {item.gated && (
                            <span className="tppm-mono rounded-chip bg-semantic-at-risk-bg px-1.5 py-0.5 text-[10px] text-semantic-at-risk">
                              EE
                            </span>
                          )}
                          <span className="tppm-mono rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-[10px] text-neutral-text-secondary">
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

        {/* Footer hint */}
        <div className="flex items-center gap-3 border-t border-neutral-border px-3 py-2 text-[11px] text-neutral-text-secondary">
          <span><kbd className="tppm-mono">↑↓</kbd> navigate</span>
          <span><kbd className="tppm-mono">↵</kbd> open</span>
          <span className="ml-auto tppm-mono">{modifierKeyLabel()}K</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
