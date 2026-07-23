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
import { canEditTask, ROLE_ADMIN } from '@/lib/roles';
import {
  useAcknowledgeComment,
  useDeleteComment,
  useReactToComment,
  useTaskComments,
  useUpdateComment,
} from '@/hooks/useTaskComments';
import { useTaskAttachments } from '@/hooks/useTaskAttachments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { formatRelative } from '@/lib/formatRelative';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import type { TaskAttachment, TaskComment } from '@/types';
import { CommentComposer } from './CommentComposer';

const ATTACHMENT_REF_RE = /\[\[attachment:([0-9a-f-]{36})\]\]/g;
const MENTION_RE = /(^|\s)(\\?)@([A-Za-z0-9_.-]+)/g;

/** ADR-0075 #11 — the author's self-edit window (mirrors COMMENT_EDIT_WINDOW_SECONDS). */
const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Mirrors the composer/server body cap (MAX_COMMENT_BODY_CHARS) so inline edits stay in bounds. */
const MAX_BODY_CHARS = 10_000;

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
  /** Viewer may edit this comment's body (own comment, within the 15-min window). */
  canEditBody: boolean;
  /** Viewer may delete this comment (author or ADMIN+). */
  canDelete: boolean;
  /**
   * True when this (depth-0) comment has replies. Deleting it soft-deletes only
   * this row, orphaning its replies from the thread — a bigger blast radius than
   * a flat note, so we gate it behind an inline confirm (#2171 ux-review).
   */
  hasReplies?: boolean;
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
  canEditBody,
  canDelete,
  hasReplies,
  isReplying,
  onReplyClick,
  onReplyClose,
}: CommentRowProps) {
  const ack = useAcknowledgeComment();
  const react = useReactToComment();
  const update = useUpdateComment();
  const del = useDeleteComment();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function handleDelete() {
    del.mutate({ projectId, taskId, commentId: comment.id });
  }
  function handleDeleteClick() {
    // A leaf/reply deletes immediately (matches the flat Notes contract); a
    // parent with replies confirms first — deleting it orphans the sub-thread.
    if (depth === 0 && hasReplies) setConfirmingDelete(true);
    else handleDelete();
  }

  // A comment's created_at is an INSTANT (#1953, ADR-0410) — re-clock its
  // relative label + full-date tooltip to the viewer's timezone + format.
  const { prefs, formatInstant } = useUserDateFormat();
  const author = comment.author?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(comment.created_at), undefined, prefs);
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
    // Real toggle (#2171): if the user already reacted, DELETE their reaction row
    // by id; otherwise POST a new 👍. Server broadcasts either way (ADR-0075 §A.4).
    react.mutate({
      projectId,
      taskId,
      commentId: comment.id,
      emoji: '👍',
      ...(comment.has_my_reaction && comment.my_reaction_id
        ? { reactionId: comment.my_reaction_id }
        : {}),
    });
  }

  function handleSaveEdit() {
    const body = draft.trim();
    if (!body || body.length > MAX_BODY_CHARS) return;
    update.mutate(
      { projectId, taskId, commentId: comment.id, body },
      { onSuccess: () => setIsEditing(false) },
    );
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
        <time
          dateTime={comment.created_at}
          title={formatInstant(comment.created_at)}
          className="text-xs text-neutral-text-secondary tppm-mono"
        >
          {ts}
        </time>
        {wasEdited && <span className="text-xs text-neutral-text-secondary italic">· edited</span>}
      </div>
      {isEditing ? (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`comment-edit-${comment.id}`}>
            Edit comment
          </label>
          {/* a11y rule 214: form fields (textarea/input) KEEP focus-visible: —
              they focus on keyboard/typing, not stray pointer clicks, so the
              suppressed-on-click behavior is correct here. The standalone action
              buttons below use focus: instead (WCAG 2.4.7 pointer-focus ring). */}
          <textarea
            id={`comment-edit-${comment.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={MAX_BODY_CHARS}
            className="text-sm bg-neutral-surface border border-neutral-border rounded-control p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              resize-y min-h-[60px]"
          />
          {update.isError && (
            <span className="text-xs text-semantic-critical" role="alert">
              Couldn&apos;t save — the 15-minute edit window may have closed.
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={update.isPending || draft.trim().length === 0}
              className="text-xs border border-brand-primary/40 text-brand-primary rounded-control px-3 h-7 font-medium
                hover:bg-brand-primary/10
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
                disabled:opacity-50"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body);
                setIsEditing(false);
              }}
              disabled={update.isPending}
              className="text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
                disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-neutral-text-primary whitespace-pre-wrap break-words">
          {renderBody(comment.body, attachmentIndex)}
        </div>
      )}
      {/* The action bar holds only write affordances (reply / ack / react / edit /
          delete); a non-editor sees the comment body but none of these controls. */}
      {editable && !isEditing && (
        <div className="flex items-center gap-1 mt-1">
          {depth === 0 && onReplyClick && (
            <button
              type="button"
              onClick={onReplyClick}
              className="text-xs border border-neutral-border rounded-control px-2 min-h-11 md:min-h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
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
            className={`text-xs border rounded-control px-2 min-h-11 md:min-h-7 font-medium
              focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
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
            aria-pressed={comment.has_my_reaction}
            aria-label={comment.has_my_reaction ? 'Remove your 👍 reaction' : 'React with 👍'}
            className={`text-xs border rounded-control px-2 min-h-11 md:min-h-7 font-medium
              focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
              disabled:opacity-50
              ${
                comment.has_my_reaction
                  ? 'border-brand-primary/40 text-brand-primary bg-brand-primary/10'
                  : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface'
              }`}
          >
            👍
            {comment.reaction_count > 0 && (
              <span className="ml-1 tppm-mono">{comment.reaction_count}</span>
            )}
          </button>
          {canEditBody && (
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body);
                setIsEditing(true);
              }}
              className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
              aria-label="Edit this comment"
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={handleDeleteClick}
              disabled={del.isPending}
              className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
                text-neutral-text-secondary hover:bg-semantic-critical-bg hover:text-semantic-critical hover:border-semantic-critical/40
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
                disabled:opacity-50"
              aria-label="Delete this comment"
            >
              Delete
            </button>
          )}
        </div>
      )}
      {/* Parent-with-replies delete confirm (#2171 ux-review): soft-deleting a
          top-level comment hides its replies from the thread, so make the author/
          admin acknowledge that before it happens. */}
      {confirmingDelete && (
        <div
          role="alertdialog"
          aria-label="Confirm delete comment with replies"
          className="mt-2 flex flex-col gap-2 p-2 rounded-control border border-semantic-critical/40 bg-semantic-critical-bg"
        >
          <p className="text-xs text-neutral-text-primary">
            Delete this comment? Its replies will be hidden from the thread.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                handleDelete();
              }}
              disabled={del.isPending}
              className="text-xs border border-semantic-critical/40 text-semantic-critical rounded-control px-3 h-7 font-medium
                hover:bg-semantic-critical-bg
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
                disabled:opacity-50"
            >
              Delete anyway
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
            >
              Keep it
            </button>
          </div>
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
  const { user } = useCurrentUser();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // ADR-0133/1142: gate write controls off the server-derived verdict; fall back to the client role rule only when absent.
  const editable = canEdit ?? canEditTask(userRole);
  const isAdmin = (userRole ?? 0) >= ROLE_ADMIN;

  // Mirror the Notes contract (#2171): the author may edit their own comment for
  // 15 min after posting; the author or any ADMIN+ may delete it.
  function canEditBody(c: TaskComment): boolean {
    if (!editable || !user || c.author?.id !== user.id) return false;
    return Date.now() - new Date(c.created_at).getTime() < EDIT_WINDOW_MS;
  }
  function canDelete(c: TaskComment): boolean {
    return editable && (c.author?.id === user?.id || isAdmin);
  }

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
            className="h-16 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
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
                canEditBody={canEditBody(c)}
                canDelete={canDelete(c)}
                hasReplies={(repliesByParent.get(c.id) ?? []).length > 0}
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
                  canEditBody={canEditBody(reply)}
                  canDelete={canDelete(reply)}
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
