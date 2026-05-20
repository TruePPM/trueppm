/**
 * AttachmentSection — task drawer section showing pinned + uploaded
 * attachments (ADR-0075 §A.1, #310).
 *
 * Phase 1 scope: list/download/delete. Upload UI (drop-zone, file picker,
 * link-pin modal) lands in phase 2 alongside the offline IndexedDB queue.
 */

import { useMemo, useState } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import {
  useDeleteAttachment,
  useSignedDownloadUrl,
  useTaskAttachments,
} from '@/hooks/useTaskAttachments';
import { formatRelative } from '@/lib/formatRelative';
import type { TaskAttachment } from '@/types';

/** Human-readable file size string (KB / MB) from a byte count. */
function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Single-glyph file icon based on MIME — uses Unicode for zero icon-library cost. */
function fileIcon(mime: string, isExternal: boolean): string {
  if (isExternal) return '🔗';
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📄';
  if (mime.includes('spreadsheet') || mime === 'text/csv') return '📊';
  if (mime.includes('wordprocessing')) return '📝';
  return '📎';
}

interface AttachmentRowProps {
  attachment: TaskAttachment;
  projectId: string;
  taskId: string;
}

function AttachmentRow({ attachment, projectId, taskId }: AttachmentRowProps) {
  const signedUrl = useSignedDownloadUrl();
  const deleteAttachment = useDeleteAttachment();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isExternal = !!attachment.external_url;
  const displayName = isExternal
    ? attachment.external_title || attachment.external_url
    : attachment.file_name;
  const meta = isExternal
    ? new URL(attachment.external_url).host
    : formatBytes(attachment.file_size);
  const uploader = attachment.uploaded_by?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(attachment.created_at));

  function handleDownload() {
    if (isExternal) {
      window.open(attachment.external_url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Fire-and-forget — onSuccess opens the signed URL; onError surfaces via
    // mutation state. The outer handler is sync to satisfy the click-handler
    // void-return contract.
    signedUrl.mutate(
      { projectId, taskId, attachmentId: attachment.id },
      {
        onSuccess: ({ url }) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      },
    );
  }

  function handleDelete() {
    deleteAttachment.mutate(
      { projectId, taskId, attachmentId: attachment.id },
      {
        onSettled: () => setConfirmingDelete(false),
      },
    );
  }

  return (
    <li
      className="flex flex-col gap-1 p-3 rounded border border-neutral-border bg-neutral-surface-raised"
      aria-label={`Attachment: ${displayName}`}
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-base flex-shrink-0" aria-hidden="true">
          {fileIcon(attachment.file_mime, isExternal)}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium text-neutral-text-primary truncate">
            {attachment.is_pinned && (
              <span aria-label="Pinned" title="Pinned" className="mr-1">
                📌
              </span>
            )}
            {displayName}
          </span>
          <span className="text-xs text-neutral-text-secondary tppm-mono">
            {meta && <>{meta} · </>}
            {uploader} · {ts}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 mt-1">
        <button
          type="button"
          onClick={handleDownload}
          disabled={signedUrl.isPending}
          className="text-xs border border-neutral-border rounded px-2 h-7 font-medium
            text-neutral-text-primary hover:bg-neutral-surface
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            focus:outline-none disabled:opacity-50"
          aria-label={isExternal ? `Open ${displayName}` : `Download ${displayName}`}
        >
          {isExternal ? '↗ Open' : '⬇ Download'}
        </button>
        {!confirmingDelete ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="text-xs text-neutral-text-secondary hover:text-semantic-critical
              rounded px-2 h-7
              focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
              focus:outline-none"
            aria-label={`Delete ${displayName}`}
          >
            Delete
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteAttachment.isPending}
              className="text-xs bg-semantic-critical text-white rounded px-2 h-7 font-medium
                hover:opacity-90 disabled:opacity-50
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                focus:outline-none"
              aria-label={`Confirm delete ${displayName}`}
            >
              {deleteAttachment.isPending ? 'Deleting…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs text-neutral-text-secondary rounded px-2 h-7
                hover:bg-neutral-surface
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                focus:outline-none"
            >
              Cancel
            </button>
          </>
        )}
        {deleteAttachment.isError && (
          <span className="text-xs text-semantic-critical ml-1" role="alert">
            Delete failed
          </span>
        )}
      </div>
    </li>
  );
}

export function AttachmentSection({ taskId, projectId }: DrawerSectionProps) {
  const { attachments, isLoading, error } = useTaskAttachments(projectId, taskId);

  // Pinned float to top — server returns pinned-first by default but a stale
  // optimistic mutation could shuffle order, so sort defensively.
  const sorted = useMemo(
    () =>
      [...attachments].sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }),
    [attachments],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading attachments">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-16 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-semantic-critical" role="alert">
        Couldn&apos;t load attachments.
      </p>
    );
  }

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-neutral-text-secondary px-1">
        No attachments yet. Upload UI lands in the next slice (#310 frontend phase 2).
      </p>
    );
  }

  return (
    <ul
      aria-label={`Attachments — ${sorted.length} total`}
      className="grid grid-cols-1 md:grid-cols-2 gap-2 list-none"
    >
      {sorted.map((a) => (
        <AttachmentRow key={a.id} attachment={a} projectId={projectId} taskId={taskId} />
      ))}
    </ul>
  );
}
