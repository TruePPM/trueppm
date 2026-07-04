import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import Markdown from 'react-markdown';

/**
 * Markdown subset the Description renders (issue 1048, MVP scope): paragraphs,
 * bold, italic, bullet/numbered lists, inline code, and hard breaks. Anything
 * outside this whitelist is unwrapped to its text content — a task description
 * is not a document, and a narrow allow-list is the XSS floor. `skipHtml` drops
 * any raw HTML nodes entirely (react-markdown never executes raw HTML without
 * rehype-raw, which is deliberately not enabled — this is belt-and-suspenders).
 */
const ALLOWED_MARKDOWN_ELEMENTS = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'code', 'br'] as const;

// Style the rendered nodes with arbitrary child variants rather than
// react-markdown's `components` override, so no custom element functions (and
// no unused `node` params) are needed. Tailwind's JIT compiles each `[&_x]:`.
const RENDERED_MARKDOWN_CLASSES = [
  'text-sm leading-relaxed text-neutral-text-primary',
  '[&_p]:mb-2 [&_p:last-child]:mb-0',
  '[&_ul]:mb-2 [&_ul:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:mb-2 [&_ol:last-child]:mb-0 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_strong]:font-semibold',
  '[&_code]:rounded [&_code]:bg-neutral-surface-sunken [&_code]:px-1 [&_code]:py-0.5',
  '[&_code]:tppm-mono [&_code]:text-[0.85em]',
].join(' ');

function RenderedMarkdown({ value }: { value: string }) {
  return (
    <div className={RENDERED_MARKDOWN_CLASSES}>
      <Markdown allowedElements={[...ALLOWED_MARKDOWN_ELEMENTS]} unwrapDisallowed skipHtml>
        {value}
      </Markdown>
    </div>
  );
}

export interface TaskDescriptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  changedElsewhere: boolean;
  /**
   * 1046: Viewers see the description read-only rather than an editable field
   * whose PATCH 403s on blur.
   */
  readOnly?: boolean;
  /**
   * Parent-owned scroll cache (issue 1048). The Details panel unmounts on tab
   * switch, so a ref local to this component would not survive; the parent keeps
   * one ref alive for the drawer session and the textarea restores its
   * `scrollTop` from it when edit mode re-mounts.
   */
  scrollTopRef?: RefObject<number>;
}

/**
 * Deferred-save Description field with a Markdown read/edit swap (issue 1048,
 * building on the #962 save-bar model).
 *
 * Read mode renders `task.notes` as formatted Markdown (bold, lists, inline
 * code) via a narrow react-markdown allow-list — safe React nodes, no
 * `dangerouslySetInnerHTML`. Clicking (or Enter/Space on) the rendered block
 * swaps in a plain textarea holding the raw Markdown source; blurring the
 * textarea flushes the deferred edit (`onBlur`) and returns to read mode. The
 * save bar / dirty / concurrent-edit contract is untouched: entering edit mode
 * never saves, and blur/tab-switch/close still flush.
 *
 * Viewers (`readOnly`) get the rendered view with no click-to-edit affordance,
 * so the absence of an editable control is unambiguous rather than a field that
 * would 403 on save.
 */
export function TaskDescriptionField({
  value,
  onChange,
  onBlur,
  changedElsewhere,
  readOnly = false,
  scrollTopRef,
}: TaskDescriptionFieldProps) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;

  // On entering edit mode, focus the textarea and restore the last scroll
  // position (issue 1048). useLayoutEffect so the caret/scroll are set before
  // paint — the user never sees a flash at the top.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    if (scrollTopRef) el.scrollTop = scrollTopRef.current;
    // Place the caret at the end so typing continues the description rather than
    // landing at an arbitrary point.
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing, scrollTopRef]);

  const label = (
    <div className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
      Description
    </div>
  );

  // Read-only (Viewer): rendered Markdown or a muted empty state, never editable.
  if (readOnly) {
    return (
      <div>
        {label}
        {hasContent ? (
          <RenderedMarkdown value={value} />
        ) : (
          <p className="text-sm italic text-neutral-text-secondary">No description</p>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div>
        {label}
        <textarea
          ref={textareaRef}
          aria-label="Description"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (scrollTopRef) scrollTopRef.current = e.currentTarget.scrollTop;
          }}
          onBlur={() => {
            onBlur();
            setEditing(false);
          }}
          rows={5}
          placeholder="Add a description…  **bold**, - lists, `code`"
          className={[
            'w-full rounded-control border border-neutral-border px-3 py-2.5 bg-neutral-surface',
            'text-sm leading-relaxed text-neutral-text-primary placeholder:text-neutral-text-disabled',
            'resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          ].join(' ')}
        />
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Markdown supported: <span className="tppm-mono">**bold**</span>,{' '}
          <span className="tppm-mono">- lists</span>, <span className="tppm-mono">1. numbered</span>,{' '}
          <span className="tppm-mono">`code`</span>
        </p>
        {changedElsewhere && (
          <p role="status" className="mt-1.5 text-xs text-semantic-at-risk">
            Updated by someone else since you started editing — saving will overwrite their change.
          </p>
        )}
      </div>
    );
  }

  // Read mode (editable): a focusable block that swaps to the textarea on click
  // or Enter/Space. role="button" (not a real <button>) because the rendered
  // Markdown contains block content — <ul>/<p> inside a <button> is invalid
  // HTML — while a role="button" div may host it and still expose the click
  // affordance to assistive tech and the drawer's focus trap.
  const enterEdit = () => setEditing(true);
  return (
    <div>
      {label}
      <div
        role="button"
        tabIndex={0}
        aria-label="Description"
        title="Click to edit"
        onClick={enterEdit}
        onFocus={enterEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            enterEdit();
          }
        }}
        className={[
          'w-full rounded-control border border-transparent px-3 py-2.5 -mx-3 cursor-text',
          'hover:bg-neutral-surface-sunken hover:border-neutral-border',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        ].join(' ')}
      >
        {hasContent ? (
          <RenderedMarkdown value={value} />
        ) : (
          <p className="text-sm text-neutral-text-disabled">Add a description…</p>
        )}
      </div>
      {changedElsewhere && (
        <p role="status" className="mt-1.5 text-xs text-semantic-at-risk">
          Updated by someone else since you started editing — saving will overwrite their change.
        </p>
      )}
    </div>
  );
}
