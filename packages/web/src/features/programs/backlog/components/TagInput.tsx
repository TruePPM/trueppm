/**
 * Tokenized tag input shared by the detail and create forms. Existing tags
 * render as chips with a remove affordance; typing + Enter (or comma) adds a
 * new one. Backspace on an empty field removes the last chip. Duplicate and
 * blank tags are ignored.
 */

import { useState, type KeyboardEvent } from 'react';
import { CloseIcon } from '@/components/Icons';
import { FOCUS_RING } from './styles';

interface TagInputProps {
  tags: string[];
  onChange: (next: string[]) => void;
  /** Existing program tags, surfaced as datalist suggestions. */
  suggestions?: string[];
  id?: string;
}

export function TagInput({ tags, onChange, suggestions = [], id }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = id ? `${id}-suggestions` : undefined;

  function add(raw: string) {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...tags, tag]);
    setDraft('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1 rounded-control border border-neutral-border bg-neutral-surface px-1.5 py-1 ${FOCUS_RING}`}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-chip bg-neutral-surface-sunken py-0.5 pl-1.5 pr-1 text-[11px] text-neutral-text-secondary"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-neutral-text-disabled hover:bg-neutral-border hover:text-neutral-text-primary"
          >
            <CloseIcon aria-hidden="true" className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        list={listId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => add(draft)}
        placeholder={tags.length === 0 ? 'Type to add…' : ''}
        aria-label="Add a tag"
        className="min-w-[80px] flex-1 bg-transparent px-1 text-[11px] text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
      />
      {listId && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  );
}
