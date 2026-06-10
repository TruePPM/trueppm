/**
 * CommentComposer — write new task comments with @mention autocomplete (#311).
 *
 * Phase 2a scope: textarea + 10 000-char counter + autocomplete + submit.
 *
 * Deferred to phase 2b: `[📎 Attach]` button that uploads to the task and
 * auto-inserts `[[attachment:uuid]]` at the cursor. Deferred to phase 2c:
 * IndexedDB offline queue + offline banner. Edit-window countdown for
 * own-comments is also phase 2b.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/Button';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectMembers } from '@/hooks/useProjectMembers';
import { useCreateComment } from '@/hooks/useTaskComments';
import {
  buildMentionSuggestions,
  MentionAutocomplete,
  type MentionSuggestion,
} from './MentionAutocomplete';

/** ADR-0075 locked constraint #3 — comment body max length. */
const MAX_BODY_CHARS = 10_000;
/** Warn-at threshold — turns the counter at-risk colour. */
const WARN_BODY_CHARS = 9_000;

/** Find the active `@`-token in `body[0..caret]`. Returns null if no token. */
function findActiveMentionToken(
  body: string,
  caret: number,
): { start: number; query: string } | null {
  // Scan backwards from caret looking for the most recent `@` not preceded by
  // a backslash (escape) and with no whitespace between `@` and caret.
  let i = caret - 1;
  while (i >= 0) {
    const ch = body[i];
    if (ch === '@') {
      // Must be at the start of the body OR follow whitespace; \@ is an escape
      const prev = i > 0 ? body[i - 1] : '';
      if (prev === '\\') return null;
      if (i === 0 || /\s/.test(prev)) {
        return { start: i, query: body.slice(i + 1, caret) };
      }
      return null;
    }
    // Whitespace or punctuation that can't be inside a username/groupkey
    // breaks the token.
    if (/\s/.test(ch)) return null;
    if (!/[A-Za-z0-9_.-]/.test(ch)) return null;
    i--;
  }
  return null;
}

interface Props {
  projectId: string;
  taskId: string;
  /** Optional parent comment id for a one-level reply. */
  parentId?: string | null;
  /** Called after a successful submit so the parent can collapse a reply box. */
  onSubmitted?: () => void;
  /** Called when the user clicks Cancel. */
  onCancel?: () => void;
}

export function CommentComposer({ projectId, taskId, parentId, onSubmitted, onCancel }: Props) {
  const [body, setBody] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createComment = useCreateComment();
  const { role: currentRole } = useCurrentUserRole(projectId);
  const { members } = useProjectMembers(projectId);

  // Recompute the @-token + suggestions on every keystroke. Cheap; member
  // list is cached for 5 min so this doesn't hit the API.
  const [caret, setCaret] = useState(0);
  const activeToken = useMemo(() => findActiveMentionToken(body, caret), [body, caret]);
  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (!activeToken) return [];
    return buildMentionSuggestions(activeToken.query, members, currentRole);
  }, [activeToken, members, currentRole]);

  const charCount = body.length;
  const charCounterColor =
    charCount >= MAX_BODY_CHARS
      ? 'text-semantic-critical'
      : charCount >= WARN_BODY_CHARS
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-secondary';

  const canSubmit =
    body.trim().length > 0 && charCount <= MAX_BODY_CHARS && !createComment.isPending;

  const insertSuggestion = useCallback(
    (s: MentionSuggestion) => {
      if (!activeToken) return;
      const before = body.slice(0, activeToken.start);
      const after = body.slice(caret);
      const replaced = `${before}@${s.value} ${after}`;
      setBody(replaced);
      // Move caret to right after the inserted mention + trailing space
      const nextCaret = before.length + 1 + s.value.length + 1;
      setCaret(nextCaret);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(nextCaret, nextCaret);
        }
      });
      setHighlightIndex(0);
    },
    [activeToken, body, caret],
  );

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setBody(e.target.value);
    setCaret(e.target.selectionStart ?? 0);
    setHighlightIndex(0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Esc dismisses the popover whenever it's open — regardless of suggestion
    // count. Previously this branch was gated by `suggestions.length > 0`, so
    // a stuck "No matches" popover was undismissible without typing a space.
    if (activeToken && e.key === 'Escape') {
      e.preventDefault();
      setCaret(-1);
      return;
    }
    // Arrow / Enter navigation — only when there are suggestions to navigate.
    if (activeToken && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const chosen = suggestions[highlightIndex];
        if (chosen && !chosen.disabled) insertSuggestion(chosen);
        return;
      }
    }
    // Cmd/Ctrl+Enter submits
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    createComment.mutate(
      { projectId, taskId, body, parentId: parentId ?? null },
      {
        onSuccess: () => {
          setBody('');
          setCaret(0);
          onSubmitted?.();
        },
      },
    );
  }

  return (
    <div
      className="flex flex-col gap-2 p-3 rounded border border-neutral-border bg-neutral-surface-raised relative"
      aria-label={parentId ? 'Reply composer' : 'Comment composer'}
    >
      <label className="sr-only" htmlFor={`comment-body-${taskId}-${parentId ?? 'top'}`}>
        Comment body
      </label>
      <textarea
        ref={textareaRef}
        id={`comment-body-${taskId}-${parentId ?? 'top'}`}
        value={body}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        rows={parentId ? 2 : 3}
        placeholder="Add a comment. @ to mention someone or a group."
        disabled={createComment.isPending}
        aria-describedby={`comment-counter-${taskId}-${parentId ?? 'top'}`}
        // WAI-ARIA combobox pattern: while the @-autocomplete popover is open,
        // expose listbox id + active option id so AT users hear the highlighted
        // option as they arrow through. Attrs are dropped when the popover
        // closes so screen readers don't read stale state.
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!activeToken}
        aria-controls={activeToken ? `mention-listbox-${taskId}-${parentId ?? 'top'}` : undefined}
        aria-activedescendant={
          activeToken && suggestions.length > 0
            ? `mention-listbox-${taskId}-${parentId ?? 'top'}-opt-${highlightIndex}`
            : undefined
        }
        className="text-sm bg-neutral-surface border border-neutral-border rounded p-2
          text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
          disabled:opacity-50 resize-y min-h-[60px]"
        maxLength={MAX_BODY_CHARS}
      />
      {activeToken && (
        <MentionAutocomplete
          query={activeToken.query}
          members={members}
          currentRole={currentRole}
          highlightIndex={highlightIndex}
          listboxId={`mention-listbox-${taskId}-${parentId ?? 'top'}`}
          onSelect={insertSuggestion}
        />
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          id={`comment-counter-${taskId}-${parentId ?? 'top'}`}
          aria-live="polite"
          className={`text-xs tppm-mono ${charCounterColor}`}
        >
          {charCount.toLocaleString()}/{MAX_BODY_CHARS.toLocaleString()}
        </span>
        {createComment.isError && (
          <span className="text-xs text-semantic-critical" role="alert">
            Couldn&apos;t post. Try again.
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={createComment.isPending}
              className="text-xs border border-neutral-border rounded px-3 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
                disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {createComment.isPending ? 'Posting…' : parentId ? 'Reply' : 'Post'}
          </Button>
        </div>
      </div>
    </div>
  );
}
