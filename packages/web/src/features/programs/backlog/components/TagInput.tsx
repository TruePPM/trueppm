/**
 * Tag combobox shared by the detail and create forms (#2026). Existing tags
 * render as removable chips; the inline input is a searchable combobox over the
 * program's existing tags (case-insensitive substring) with a trailing
 * "Create …" row when the typed text isn't already a tag. Selection is additive
 * (a tag is a plain string with no backing catalog entity), so committing a row
 * keeps the popover open for rapid multi-add.
 *
 * Positioning + dismissal use the shared `useAnchoredPopover` (web-rule 260) so
 * the list escapes the detail pane / mobile BottomSheet clip and never spills
 * off a narrow viewport. The keyboard model mirrors the rule-124 combobox
 * contract (roving `aria-activedescendant`, Arrow/Home/End, Enter, two-stage
 * Escape). Backspace on an empty query removes the last chip. Unlike the old
 * free-text field this does NOT commit the typed draft on blur — an outside
 * click discards the uncommitted query (parity with the app's other comboboxes);
 * an explicit Enter / click / comma commits.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '@/components/Icons';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { FOCUS_RING_INPUT } from './styles';

interface TagInputProps {
  tags: string[];
  onChange: (next: string[]) => void;
  /** Existing program tags, offered as combobox suggestions. */
  suggestions?: string[];
  id?: string;
}

type Row = { kind: 'tag'; value: string } | { kind: 'create'; value: string };

export function TagInput({ tags, onChange, suggestions = [], id }: TagInputProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    triggerRef: anchorRef,
    popoverRef,
    popoverStyle,
  } = useAnchoredPopover<HTMLDivElement, HTMLDivElement>({
    open,
    width: 'trigger',
    estimatedHeight: 224,
    onDismiss: () => {
      // Outside click discards the uncommitted query (no blur-commit).
      setOpen(false);
      setQuery('');
    },
  });

  const q = query.trim();
  const qLower = q.toLowerCase();
  const lowerTags = useMemo(() => tags.map((t) => t.toLowerCase()), [tags]);

  // Existing program tags not already on this item, substring-filtered by query.
  const filtered = useMemo(() => {
    const available = suggestions.filter((s) => !lowerTags.includes(s.toLowerCase()));
    return qLower ? available.filter((s) => s.toLowerCase().includes(qLower)) : available;
  }, [suggestions, lowerTags, qLower]);

  const exactInSuggestions = qLower !== '' && suggestions.some((s) => s.toLowerCase() === qLower);
  const alreadyAdded = qLower !== '' && lowerTags.includes(qLower);
  // Offer "Create" only for genuinely new text — not a case-dupe of an existing
  // suggestion (already in the list) or a chip already on this item.
  const showCreate = qLower !== '' && !exactInSuggestions && !alreadyAdded;

  const rows: Row[] = useMemo(() => {
    const list: Row[] = filtered.map((s) => ({ kind: 'tag' as const, value: s }));
    if (showCreate) list.push({ kind: 'create', value: q });
    return list;
  }, [filtered, showCreate, q]);

  function add(value: string) {
    const tag = value.trim();
    if (!tag) return;
    // Idempotent: never add a case-duplicate of an existing chip.
    if (!lowerTags.includes(tag.toLowerCase())) onChange([...tags, tag]);
    setQuery('');
    setActiveIndex(0);
    // Stay open for rapid multi-add; keep focus in the input.
    inputRef.current?.focus();
  }

  function commit(index: number) {
    const row = rows[index];
    if (row) add(row.value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        setActiveIndex((i) => (rows.length ? (i + 1) % rows.length : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        setActiveIndex((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
        break;
      case 'Home':
        if (rows.length) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (rows.length) {
          e.preventDefault();
          setActiveIndex(rows.length - 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (rows.length) commit(activeIndex);
        break;
      case ',':
        // Comma is a quick "add exactly what I typed" (parity with the old field).
        if (q) {
          e.preventDefault();
          add(q);
        }
        break;
      case 'Escape':
        // Two-stage: clear a non-empty query first, then close the popover.
        if (query) {
          e.preventDefault();
          setQuery('');
          setActiveIndex(0);
        } else if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'Backspace':
        if (query === '' && tags.length > 0) onChange(tags.slice(0, -1));
        break;
    }
  }

  const activeDescId = open && rows.length ? `${baseId}-opt-${activeIndex}` : undefined;

  return (
    <div
      ref={anchorRef}
      className={`flex flex-wrap items-center gap-1 rounded-control border border-neutral-border bg-neutral-surface px-1.5 py-1 ${FOCUS_RING_INPUT}`}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-chip bg-neutral-surface-sunken py-0.5 pl-1.5 pr-1 text-xs text-neutral-text-secondary"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
            className="relative flex h-3.5 w-3.5 items-center justify-center rounded-full text-neutral-text-disabled hover:bg-neutral-border hover:text-neutral-text-primary max-md:before:absolute max-md:before:-inset-[15px] max-md:before:content-['']"
          >
            <CloseIcon aria-hidden="true" className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? 'Type to add or search…' : ''}
        aria-label="Add a tag"
        className="min-w-[80px] flex-1 bg-transparent px-1 text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
      />

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            // z-[60] to sit above the mobile BottomSheet panel (z-50) that hosts
            // the create form; portaled to body so it escapes the pane's clip.
            className="z-[60] rounded-card border border-neutral-border bg-neutral-surface py-0.5"
          >
            <div
              role="listbox"
              id={listboxId}
              aria-label="Tags"
              className="max-h-56 overflow-y-auto"
            >
              {rows.length === 0 ? (
                <div role="status" className="px-2 py-1.5 text-xs text-neutral-text-secondary">
                  {alreadyAdded
                    ? `"${q}" is already added`
                    : q
                      ? `No tags match "${q}"`
                      : 'No tags yet — type to create one.'}
                </div>
              ) : (
                rows.map((row, index) => {
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={row.kind === 'create' ? '__create__' : row.value}
                      type="button"
                      id={`${baseId}-opt-${index}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commit(index)}
                      className={[
                        'flex min-h-[44px] w-full items-center gap-1.5 px-2 text-left text-xs text-neutral-text-primary md:min-h-8 md:h-8',
                        row.kind === 'create' ? 'border-t border-neutral-border/60' : '',
                        isActive ? 'bg-neutral-surface-sunken' : '',
                      ].join(' ')}
                    >
                      {row.kind === 'create' ? (
                        <>
                          <span aria-hidden="true" className="text-neutral-text-secondary">
                            +
                          </span>
                          <span className="truncate">{`Create "${row.value}"`}</span>
                        </>
                      ) : (
                        <span className="truncate">{row.value}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
