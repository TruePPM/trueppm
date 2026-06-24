/**
 * AttachmentDropZone — drag-drop target above the AttachmentSection grid (#310).
 *
 * Calls back with each File via `onFile`; AttachmentSection wires that to
 * useCreateAttachment. Client-side MIME + size validation runs here to give
 * a fast, friendly error before the multipart POST burns a round-trip. The MIME
 * allow-list is the project's server-resolved policy (ADR-0153, issue 976) threaded
 * in via `allowedMimes` — there is no static client-side Set.
 */

import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  isMimeAllowed,
  normalizeMime,
} from '@/hooks/useTaskAttachments';
import { labelForMime } from '@/lib/attachmentTypes';

interface Props {
  /** Called once per dropped file. Rejected files surface via `onError`. */
  onFile: (file: File) => void;
  /** Called with a user-friendly error message when a file is rejected. */
  onError: (message: string) => void;
  /** The project's resolved MIME allow-list (effective_allowed_attachment_types). */
  allowedMimes: readonly string[];
  /** Disable interaction (e.g. during an in-progress upload). */
  disabled?: boolean;
  /** When true, the zone is always visible. When false, only on dragover. */
  alwaysVisible: boolean;
}

/**
 * Validate a file against the resolved allow-list + size cap. Returns an error
 * message, or `null` when the file passes. The allow-list is the project policy,
 * so the friendly "use X, Y, Z" hint is derived from it rather than hardcoded.
 */
export function validateFileForUpload(file: File, allowedMimes: readonly string[]): string | null {
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    const cap = Math.round(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024));
    const got = (file.size / (1024 * 1024)).toFixed(1);
    return `${file.name} is ${got} MB. The limit is ${cap} MB.`;
  }
  const mime = normalizeMime(file.type);
  if (!isMimeAllowed(mime, allowedMimes)) {
    const allowedLabels = allowedMimes.map(labelForMime).join(', ');
    const suffix = allowedLabels ? ` Allowed: ${allowedLabels}.` : ' No file types are allowed.';
    return `${file.name}: ${mime || 'unknown type'} not allowed.${suffix}`;
  }
  return null;
}

export function AttachmentDropZone({ onFile, onError, allowedMimes, disabled, alwaysVisible }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const onDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      setDragOver(true);
    },
    [disabled],
  );

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        const err = validateFileForUpload(file, allowedMimes);
        if (err) {
          onError(err);
          continue;
        }
        onFile(file);
      }
    },
    [disabled, onError, onFile, allowedMimes],
  );

  // Hidden-until-dragover behavior matches the ux-design spec. Always-visible
  // mode is used in the empty state to teach the drop affordance.
  const visible = alwaysVisible || dragOver;

  // The hint lists the project's resolved types (truncated) so the drop zone
  // reflects the actual policy, not a frozen default (ADR-0153).
  const typeHint =
    allowedMimes.length === 0
      ? 'no file types allowed'
      : allowedMimes.slice(0, 6).map(labelForMime).join(', ') +
        (allowedMimes.length > 6 ? `, +${allowedMimes.length - 6} more` : '');

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-hidden={!visible}
      className={`rounded-card border-2 border-dashed text-xs text-center transition-opacity
        ${visible ? 'opacity-100 p-3' : 'opacity-0 h-0 overflow-hidden p-0 border-0'}
        ${dragOver ? 'border-brand-primary bg-brand-primary/5' : 'border-neutral-border bg-neutral-surface'}
        ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="text-neutral-text-secondary">
        Drop file here · max 100 MB · {typeHint}
      </span>
    </div>
  );
}
