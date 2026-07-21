/**
 * NotesComposer — low-ceremony add-a-note input (ADR-0143, issue 740).
 *
 * Deliberately minimal (Priya 🟡: the add flow must not feel like PM overhead):
 * one textarea, a char counter, and a single Add action. No @mention, no
 * attachments, no parent threading — those belong to Comments, not the decision
 * log. Cmd/Ctrl+Enter saves.
 */

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/Button';
import { useCreateNote } from '@/hooks/useTaskNotes';
import { useReportComposerDirty } from '../ComposerDirtyContext';

/** ADR-0143 body cap — mirrors the server's MAX_NOTE_BODY_CHARS. */
const MAX_BODY_CHARS = 10_000;
/** Warn-at threshold — turns the counter at-risk colour. */
const WARN_BODY_CHARS = 9_000;

interface Props {
  projectId: string;
  taskId: string;
}

export function NotesComposer({ projectId, taskId }: Props) {
  const [body, setBody] = useState('');
  const createNote = useCreateNote();

  const charCount = body.length;
  const charCounterColor =
    charCount >= MAX_BODY_CHARS
      ? 'text-semantic-critical'
      : charCount >= WARN_BODY_CHARS
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-secondary';

  const canSubmit = body.trim().length > 0 && charCount <= MAX_BODY_CHARS && !createNote.isPending;

  // Register unstaged text with the drawer so its unsaved-changes guard covers a
  // half-written note — an Escape or task-swap must not destroy it silently
  // (#2153).
  useReportComposerDirty(body.trim().length > 0);

  function handleSubmit() {
    if (!canSubmit) return;
    createNote.mutate(
      { projectId, taskId, body },
      {
        onSuccess: () => {
          setBody('');
        },
      },
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter submits — matches the comment composer's muscle memory.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault();
      handleSubmit();
      return;
    }
    // Swallow Escape while there is unstaged text so it never bubbles to the
    // drawer's Escape-to-close guard and destroys the half-written note (#2153).
    if (e.key === 'Escape' && body.trim().length > 0) {
      e.stopPropagation();
    }
  }

  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-card border border-neutral-border bg-neutral-surface-raised"
      aria-label="Note composer"
    >
      <label className="sr-only" htmlFor={`note-body-${taskId}`}>
        Note body
      </label>
      <textarea
        id={`note-body-${taskId}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder="Capture a decision or the why behind this work."
        disabled={createNote.isPending}
        aria-describedby={`note-counter-${taskId}`}
        className="text-sm bg-neutral-surface border border-neutral-border rounded-control p-2
          text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
          disabled:opacity-50 resize-y min-h-[60px]"
        maxLength={MAX_BODY_CHARS}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <span
          id={`note-counter-${taskId}`}
          aria-live="polite"
          className={`text-xs tppm-mono ${charCounterColor}`}
        >
          {charCount.toLocaleString()}/{MAX_BODY_CHARS.toLocaleString()}
        </span>
        {createNote.isError && (
          <span className="text-xs text-semantic-critical" role="alert">
            Couldn&apos;t add note. Try again.
          </span>
        )}
        <div className="ml-auto">
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {createNote.isPending ? 'Adding…' : 'Add note'}
          </Button>
        </div>
      </div>
    </div>
  );
}
