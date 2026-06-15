/**
 * AttachmentSection — task drawer section showing pinned + uploaded
 * attachments (ADR-0075 §A.1, #310).
 *
 * Phase 1 scope: list/download/delete. Upload UI (drop-zone, file picker,
 * link-pin modal) lands in phase 2 alongside the offline IndexedDB queue.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import {
  useCreateAttachment,
  useDeleteAttachment,
  useSignedDownloadUrl,
  useTaskAttachments,
} from '@/hooks/useTaskAttachments';
import { formatRelative } from '@/lib/formatRelative';
import { safeExternalHref } from '@/lib/safeExternalHref';
import type { TaskAttachment } from '@/types';
import { AttachmentDropZone, validateFileForUpload } from './AttachmentDropZone';
import { LinkInputModal } from './LinkInputModal';

/** Human-readable file size string (KB / MB) from a byte count. */
function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Single-glyph file icon based on MIME — uses Unicode for zero icon-library cost. */
function fileIcon(mime: string, isExternal: boolean, externalUrl: string | null): string {
  if (isExternal) return externalLinkIcon(externalUrl);
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📄';
  if (mime.includes('spreadsheet') || mime === 'text/csv') return '📊';
  if (mime.includes('wordprocessing')) return '📝';
  return '📎';
}

/**
 * Per-host glyph for pinned external URLs. Matches the host substring against
 * the most common knowledge-base / docs / design hosts in PMO tooling
 * (Google Docs, SharePoint / OneDrive, Confluence, Notion, Figma, Jira,
 * GitHub, GitLab, Miro, Dropbox, Slack). Anything unrecognized falls back to
 * the generic link glyph. The full hostname is still rendered next to the
 * title via the `meta` line, so the glyph is decorative — `aria-hidden` on
 * the span carries the WCAG fallback.
 */
function externalLinkIcon(externalUrl: string | null): string {
  if (!externalUrl) return '🔗';
  let host = '';
  try {
    host = new URL(externalUrl).host.toLowerCase();
  } catch {
    return '🔗';
  }
  if (host.includes('docs.google.') || host.includes('drive.google.')) return '📝';
  if (host.includes('sharepoint.') || host.includes('onedrive.') || host.includes('office.com'))
    return '📘';
  if (host.includes('atlassian.net') || host.includes('confluence.')) return '📚';
  if (host.includes('notion.')) return '📓';
  if (host.includes('figma.')) return '🎨';
  if (host.includes('jira.')) return '🟦';
  if (host.includes('github.')) return '🐙';
  if (host.includes('gitlab.')) return '🦊';
  if (host.includes('miro.')) return '🗒';
  if (host.includes('dropbox.')) return '📦';
  if (host.includes('slack.')) return '💬';
  return '🔗';
}

/**
 * Host string for a pinned external URL's meta line. A malformed `external_url`
 * would otherwise throw in `new URL(...)` and crash the whole row render
 * (#898), so unparseable values fall back to a neutral label.
 */
function externalHost(externalUrl: string | null): string {
  if (!externalUrl) return 'external link';
  try {
    return new URL(externalUrl).host;
  } catch {
    return 'external link';
  }
}

interface AttachmentRowProps {
  attachment: TaskAttachment;
  projectId: string;
  taskId: string;
  canEdit: boolean;
}

function AttachmentRow({ attachment, projectId, taskId, canEdit }: AttachmentRowProps) {
  const signedUrl = useSignedDownloadUrl();
  const deleteAttachment = useDeleteAttachment();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isExternal = !!attachment.external_url;
  const displayName = isExternal
    ? attachment.external_title || attachment.external_url
    : attachment.file_name;
  const meta = isExternal
    ? externalHost(attachment.external_url)
    : formatBytes(attachment.file_size);
  const uploader = attachment.uploaded_by?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(attachment.created_at));

  function handleDownload() {
    if (isExternal) {
      // Only open a safe http(s) URL — a stored javascript:/data: URL must
      // never reach window.open (#898). Malformed/unsafe URLs are inert.
      const safeUrl = safeExternalHref(attachment.external_url ?? '');
      if (safeUrl) {
        window.open(safeUrl, '_blank', 'noopener,noreferrer');
      }
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
          {fileIcon(attachment.file_mime, isExternal, attachment.external_url)}
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
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track
            focus-visible:outline-none disabled:opacity-50"
          aria-label={isExternal ? `Open ${displayName}` : `Download ${displayName}`}
        >
          {isExternal ? '↗ Open' : '⬇ Download'}
        </button>
        {canEdit &&
          (!confirmingDelete ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="text-xs text-neutral-text-secondary hover:text-semantic-critical
              rounded px-2 h-7
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track
              focus-visible:outline-none"
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
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track
                focus-visible:outline-none"
              aria-label={`Confirm delete ${displayName}`}
            >
              {deleteAttachment.isPending ? 'Deleting…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs text-neutral-text-secondary rounded px-2 h-7
                hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track
                focus-visible:outline-none"
            >
              Cancel
            </button>
          </>
          ))}
        {canEdit && deleteAttachment.isError && (
          <span className="text-xs text-semantic-critical ml-1" role="alert">
            Delete failed
          </span>
        )}
      </div>
    </li>
  );
}

export function AttachmentSection({
  taskId,
  projectId,
  userRole,
  canEdit: canEditCap,
}: DrawerSectionProps) {
  const { attachments, isLoading, error } = useTaskAttachments(projectId, taskId);
  // #1046 / ADR-0133: Viewers can list/download but not upload, pin, or delete.
  // Prefer the server-derived per-task verdict; fall back to the client role rule
  // only when it is absent (and it returns false while the role loads, so the
  // controls never flash).
  const canEdit = canEditCap ?? canEditTask(userRole);
  const createAttachment = useCreateAttachment();
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Offline guard — blocks drop zone + upload buttons + pin link button while
  // the browser reports no connectivity. Mirrors the navigator.onLine pattern
  // used in useDragCpm / useScheduleCommit. IndexedDB write queue is deferred
  // to #311 phase 2c; for now we surface a clear blocked state instead of
  // letting a 100 MB multipart sit pending for 30s before failing.
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const uploadBlocked = !isOnline || createAttachment.isPending;

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

  function uploadFile(file: File) {
    const err = validateFileForUpload(file);
    if (err) {
      setUploadError(err);
      return;
    }
    setUploadError(null);
    createAttachment.mutate(
      { projectId, taskId, file },
      {
        onError: (err) => {
          setUploadError(err.message || 'Upload failed.');
        },
      },
    );
  }

  function handleFilePickerChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) uploadFile(file);
    // Allow re-picking the same file (input.value carries last selection).
    e.target.value = '';
  }

  function handleLinkSubmit(url: string, title: string) {
    setUploadError(null);
    createAttachment.mutate(
      { projectId, taskId, externalUrl: url, externalTitle: title },
      {
        onSuccess: () => setLinkModalOpen(false),
        onError: (err) => setUploadError(err.message || 'Pin link failed.'),
      },
    );
  }

  const showAddControls = !isLoading && !error && canEdit;

  return (
    <div className="flex flex-col gap-2">
      {/* Drop zone: always-visible when grid is empty (teach the affordance);
          hover-to-show otherwise (keeps the section quiet). */}
      {showAddControls && (
        <AttachmentDropZone
          alwaysVisible={sorted.length === 0}
          disabled={uploadBlocked}
          onFile={uploadFile}
          onError={setUploadError}
        />
      )}

      {isLoading && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading attachments">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-semantic-critical" role="alert">
          Couldn&apos;t load attachments.
        </p>
      )}

      {!isLoading && !error && sorted.length > 0 && (
        <ul
          aria-label={`Attachments — ${sorted.length} total`}
          className="grid grid-cols-1 md:grid-cols-2 gap-2 list-none"
        >
          {sorted.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              projectId={projectId}
              taskId={taskId}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}

      {showAddControls && (
        <div className="mt-1">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            onChange={handleFilePickerChange}
            aria-hidden="true"
            tabIndex={-1}
          />
          {/* Buttons live in their own non-shrinking row; status/error messages
              stack below so a long validation message can never squeeze the
              buttons and wrap their labels (e.g. "+ Attach\nfile"). */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadBlocked}
              className="text-xs border border-neutral-border rounded px-3 h-7 font-medium
                shrink-0 whitespace-nowrap
                text-neutral-text-primary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
                disabled:opacity-50"
            >
              + Attach file
            </button>
            <button
              type="button"
              onClick={() => setLinkModalOpen(true)}
              disabled={uploadBlocked}
              className="text-xs border border-neutral-border rounded px-3 h-7 font-medium
                shrink-0 whitespace-nowrap
                text-neutral-text-primary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
                disabled:opacity-50"
            >
              + Pin link
            </button>
          </div>
          {(createAttachment.isPending || !isOnline || uploadError) && (
            <div className="flex flex-col gap-1 mt-1.5">
              {createAttachment.isPending && (
                <span className="text-xs text-neutral-text-secondary" aria-live="polite">
                  Uploading…
                </span>
              )}
              {!isOnline && (
                <span className="text-xs text-neutral-text-secondary" role="status">
                  You&apos;re offline — attachments resume when you reconnect.
                </span>
              )}
              {uploadError && (
                <span className="text-xs text-semantic-critical" role="alert">
                  {uploadError}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <LinkInputModal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        onSubmit={handleLinkSubmit}
        submitting={createAttachment.isPending}
      />
    </div>
  );
}
