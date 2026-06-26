/**
 * CommentSection — task drawer thread (ADR-0075 §A.2, #311).
 *
 * Phase 1 scope: list comments (flat + one-level reply nesting), render
 * acknowledged_count / reaction_count, ack toggle, 👍 reaction toggle,
 * inline [[attachment:uuid]] chip rendering, @mention highlighting.
 *
 * Composer (write new comments), @mention autocomplete, attachment auto-
 * insert, edit window countdown, and the IndexedDB offline queue all land
 * in frontend phase 2.
 */

import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import { useAcknowledgeComment, useReactToComment, useTaskComments } from '@/hooks/useTaskComments';
import { useTaskAttachments } from '@/hooks/useTaskAttachments';
import { formatRelative } from '@/lib/formatRelative';
import type { TaskAttachment, TaskComment } from '@/types';
import { CommentComposer } from './CommentComposer';

const ATTACHMENT_REF_RE = /\[\[attachment:([0-9a-f-]{36})\]\]/g;
const MENTION_RE = /(^|\s)(\\?)@([A-Za-z0-9_.-]+)/g;

/**
 * Renders comment body into JSX, expanding:
 *   - `[[attachment:uuid]]` → AttachmentChip
 *   - `@username` / `@group-key` → highlighted span
 *   - `\@name` → literal text
 *
 * Returns a list of nodes; React's default escape behavior handles XSS.
 */
function renderBody(body: string, attachmentIndex: Map<string, TaskAttachment>): ReactElement[] {
  // Split on attachment refs first; preserve order, render each segment.
  const parts: { kind: 'text' | 'attachment'; value: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  ATTACHMENT_REF_RE.lastIndex = 0;
  while ((match = ATTACHMENT_REF_RE.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', value: body.slice(lastIndex, match.index) });
    }
    parts.push({ kind: 'attachment', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push({ kind: 'text', value: body.slice(lastIndex) });
  }
  if (parts.length === 0) parts.push({ kind: 'text', value: body });

  return parts.flatMap((part, idx) => {
    if (part.kind === 'attachment') {
      const att = attachmentIndex.get(part.value);
      if (!att) {
        return [
          <span
            key={`att-${idx}`}
            className="text-xs text-neutral-text-secondary italic"
            title="Attachment no longer available"
          >
            📎 (deleted attachment)
          </span>,
        ];
      }
      const name = att.external_url ? att.external_title || att.external_url : att.file_name;
      return [
        <span
          key={`att-${idx}`}
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-chip border
            border-neutral-border bg-neutral-surface align-baseline"
          title={`Attachment: ${name}`}
        >
          📎 {name}
        </span>,
      ];
    }
    // Text segment — expand @mentions with highlighting.
    return renderTextWithMentions(part.value, `txt-${idx}`);
  });
}

function renderTextWithMentions(text: string, keyPrefix: string): ReactElement[] {
  const out: ReactElement[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  let i = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const leadingWs = match[1];
    const escapeChar = match[2];
    const name = match[3];
    if (match.index > lastIndex) {
      out.push(<span key={`${keyPrefix}-pre-${i}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    if (escapeChar === '\\') {
      // \@name renders literal @name
      out.push(
        <span key={`${keyPrefix}-esc-${i}`}>
          {leadingWs}@{name}
        </span>,
      );
    } else {
      out.push(
        <span key={`${keyPrefix}-ws-${i}`}>{leadingWs}</span>,
        <span
          key={`${keyPrefix}-m-${i}`}
          className="text-brand-primary font-medium"
          title={`Mention: @${name}`}
        >
          @{name}
        </span>,
      );
    }
    lastIndex = match.index + fullMatch.length;
    i++;
  }
  if (lastIndex < text.length) {
    out.push(<span key={`${keyPrefix}-tail`}>{text.slice(lastIndex)}</span>);
  }
  if (out.length === 0) out.push(<span key={`${keyPrefix}-only`}>{text}</span>);
  return out;
}

interface CommentRowProps {
  comment: TaskComment;
  projectId: string;
  taskId: string;
  attachmentIndex: Map<string, TaskAttachment>;
  /** Indent depth — 0 for top-level, 1 for reply. (One-level nesting only.) */
  depth: number;
  /**
   * Whether the viewer may post/reply/react/ack (ADR-0133/1142). When false,
   * the comment body still renders but every write affordance is hidden.
   */
  editable: boolean;
  /** True when this row's reply composer is open. Reply only available on top-level rows. */
  isReplying?: boolean;
  /** Called when the user clicks Reply. */
  onReplyClick?: () => void;
  /** Called when the reply composer cancels or submits. */
  onReplyClose?: () => void;
}

function CommentRow({
  comment,
  projectId,
  taskId,
  attachmentIndex,
  depth,
  editable,
  isReplying,
  onReplyClick,
  onReplyClose,
}: CommentRowProps) {
  const ack = useAcknowledgeComment();
  const react = useReactToComment();

  const author = comment.author?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(comment.created_at));
  const wasEdited = comment.edited_at != null;

  function handleAckToggle() {
    ack.mutate({
      projectId,
      taskId,
      commentId: comment.id,
      acknowledge: !comment.has_my_acknowledgement,
    });
  }

  function handleReact() {
    // Phase 1: 👍 only. Phase 2 will look up the user's existing reaction id
    // for toggle-off; for now POST always (server unique constraint guards dup).
    react.mutate({
      projectId,
      taskId,
      commentId: comment.id,
      emoji: '👍',
    });
  }

  return (
    <li
      className={`flex flex-col gap-1 p-3 rounded-card border border-neutral-border bg-neutral-surface-raised ${
        depth > 0 ? 'ml-6 border-l-2 border-l-neutral-border/60' : ''
      }`}
      aria-label={`Comment by ${author}, ${ts}${wasEdited ? ', edited' : ''}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-medium text-neutral-text-primary">{author}</span>
        <span className="text-xs text-neutral-text-secondary tppm-mono">{ts}</span>
        {wasEdited && <span className="text-xs text-neutral-text-secondary italic">· edited</span>}
      </div>
      <div className="text-sm text-neutral-text-primary whitespace-pre-wrap break-words">
        {renderBody(comment.body, attachmentIndex)}
      </div>
      {/* The action bar holds only write affordances (reply / ack / react);
          a non-editor sees the comment body but none of these controls. */}
      {editable && (
        <div className="flex items-center gap-1 mt-1">
          {depth === 0 && onReplyClick && (
            <button
              type="button"
              onClick={onReplyClick}
              className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              aria-label="Reply to this comment"
            >
              ↩ Reply
            </button>
          )}
          <button
            type="button"
            onClick={handleAckToggle}
            disabled={ack.isPending}
            aria-pressed={comment.has_my_acknowledgement}
            aria-label={
              comment.has_my_acknowledgement
                ? 'Remove your acknowledgement'
                : 'Acknowledge this comment'
            }
            className={`text-xs border rounded-control px-2 h-7 font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50
              ${
                comment.has_my_acknowledgement
                  ? 'border-semantic-on-track/40 text-semantic-on-track bg-semantic-on-track-bg'
                  : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface'
              }`}
          >
            ✅
            {comment.acknowledged_count > 0 && (
              <span className="ml-1 tppm-mono">{comment.acknowledged_count}</span>
            )}
          </button>
          <button
            type="button"
            onClick={handleReact}
            disabled={react.isPending}
            aria-label="React with 👍"
            className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
              text-neutral-text-secondary hover:bg-neutral-surface
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50"
          >
            👍
            {comment.reaction_count > 0 && (
              <span className="ml-1 tppm-mono">{comment.reaction_count}</span>
            )}
          </button>
        </div>
      )}
      {editable && isReplying && depth === 0 && (
        <div className="mt-2 ml-6">
          <CommentComposer
            projectId={projectId}
            taskId={taskId}
            parentId={comment.id}
            onSubmitted={onReplyClose}
            onCancel={onReplyClose}
          />
        </div>
      )}
    </li>
  );
}

export function CommentSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { comments, isLoading, error } = useTaskComments(projectId, taskId);
  const { attachments } = useTaskAttachments(projectId, taskId);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // ADR-0133/1142: gate write controls off the server-derived verdict; fall back to the client role rule only when absent.
  const editable = canEdit ?? canEditTask(userRole);

  // Lookup table for [[attachment:uuid]] rendering. Soft-deleted attachments
  // are filtered out at the list endpoint so missing-id is the soft-delete
  // signal (renders as "(deleted attachment)").
  const attachmentIndex = useMemo(() => {
    const m = new Map<string, TaskAttachment>();
    for (const a of attachments) m.set(a.id, a);
    return m;
  }, [attachments]);

  // Group replies under their parent (server returns flat ordered by created_at).
  const { topLevel, repliesByParent } = useMemo(() => {
    const top: TaskComment[] = [];
    const replies = new Map<string, TaskComment[]>();
    for (const c of comments) {
      if (c.parent == null) {
        top.push(c);
      } else {
        const list = replies.get(c.parent) ?? [];
        list.push(c);
        replies.set(c.parent, list);
      }
    }
    return { topLevel: top, repliesByParent: replies };
  }, [comments]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading comments">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-card border border-neutral-border animate-pulse bg-neutral-surface-raised"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-semantic-critical" role="alert">
        Couldn&apos;t load comments.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {topLevel.length === 0 ? (
        <p className="text-sm text-neutral-text-secondary px-1">
          {editable ? 'Be the first to comment.' : 'No comments yet.'}
        </p>
      ) : (
        <ol
          aria-label={`Comments — ${comments.length} total`}
          className="flex flex-col gap-2 list-none p-0"
        >
          {topLevel.map((c) => (
            <li key={c.id} className="list-none">
              <CommentRow
                comment={c}
                projectId={projectId}
                taskId={taskId}
                attachmentIndex={attachmentIndex}
                depth={0}
                editable={editable}
                isReplying={replyingTo === c.id}
                onReplyClick={() => setReplyingTo(c.id)}
                onReplyClose={() => setReplyingTo(null)}
              />
              {(repliesByParent.get(c.id) ?? []).map((reply) => (
                <CommentRow
                  key={reply.id}
                  comment={reply}
                  projectId={projectId}
                  taskId={taskId}
                  attachmentIndex={attachmentIndex}
                  depth={1}
                  editable={editable}
                />
              ))}
            </li>
          ))}
        </ol>
      )}
      {editable && <CommentComposer projectId={projectId} taskId={taskId} />}
    </div>
  );
}
