/**
 * AttachmentDropZone — drag-drop target above the AttachmentSection grid (#310).
 *
 * Calls back with each File via `onFile`; AttachmentSection wires that to
 * useCreateAttachment. Client-side MIME + size validation runs here to give
 * a fast, friendly error before the multipart POST burns a round-trip.
 */

import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';
import {
  ALLOWED_ATTACHMENT_MIMES,
  MAX_ATTACHMENT_SIZE_BYTES,
} from '@/hooks/useTaskAttachments';

interface Props {
  /** Called once per dropped file. Rejected files surface via `onError`. */
  onFile: (file: File) => void;
  /** Called with a user-friendly error message when a file is rejected. */
  onError: (message: string) => void;
  /** Disable interaction (e.g. during an in-progress upload). */
  disabled?: boolean;
  /** When true, the zone is always visible. When false, only on dragover. */
  alwaysVisible: boolean;
}

export function validateFileForUpload(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    const cap = Math.round(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024));
    const got = (file.size / (1024 * 1024)).toFixed(1);
    return `${file.name} is ${got} MB. The limit is ${cap} MB.`;
  }
  const mime = (file.type || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
    return `${file.name}: ${mime || 'unknown type'} not allowed. Use PDF, JPG, PNG, WebP, XLSX, CSV, or DOCX.`;
  }
  return null;
}

export function AttachmentDropZone({ onFile, onError, disabled, alwaysVisible }: Props) {
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
        const err = validateFileForUpload(file);
        if (err) {
          onError(err);
          continue;
        }
        onFile(file);
      }
    },
    [disabled, onError, onFile],
  );

  // Hidden-until-dragover behavior matches the ux-design spec. Always-visible
  // mode is used in the empty state to teach the drop affordance.
  const visible = alwaysVisible || dragOver;

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-hidden={!visible}
      className={`rounded border-2 border-dashed text-xs text-center transition-opacity
        ${visible ? 'opacity-100 p-3' : 'opacity-0 h-0 overflow-hidden p-0 border-0'}
        ${dragOver ? 'border-brand-primary bg-brand-primary/5' : 'border-neutral-border bg-neutral-surface'}
        ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="text-neutral-text-secondary">
        Drop file here · max 100 MB · PDF, JPG, PNG, WebP, XLSX, CSV, DOCX
      </span>
    </div>
  );
}
