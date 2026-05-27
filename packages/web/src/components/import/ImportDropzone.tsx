import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

export interface ImportDropzoneProps {
  /** Accepted file extensions, e.g. ['.mpp', '.xml']. Used for the picker and validation. */
  accept: readonly string[];
  /** Soft client-side size cap in MB. The server enforces the authoritative limit. */
  maxSizeMb: number;
  /** The currently selected file, or null for the empty state. */
  file: File | null;
  /** Called with a valid file after extension + size checks pass. */
  onSelect: (file: File) => void;
  /** Called when the user clears the selected file. */
  onClear: () => void;
  /** Called with a human-readable message when a dropped/picked file is rejected. */
  onReject?: (message: string) => void;
  disabled?: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Reusable drag-and-drop file picker for import flows.
 *
 * Validates extension and size against the `accept`/`maxSizeMb` props before
 * calling `onSelect`; rejections are surfaced via `onReject` so the host
 * (modal) can show a message without the dropzone owning that UI. This is the
 * shared shell the file-IO surfaces build on — MS Project import (#68) today,
 * the CSV/Excel wizard (#111) and risk CSV (#223) next.
 */
export function ImportDropzone({
  accept,
  maxSizeMb,
  file,
  onSelect,
  onClear,
  onReject,
  disabled = false,
}: ImportDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Persistent polite announcement; selection has no visual focus change an AT
  // user would notice, so we voice it here.
  const [announcement, setAnnouncement] = useState('');
  const acceptLabel = accept.join(', ');

  const acceptList = accept.map((a) => a.toLowerCase());

  function validateAndSelect(candidate: File) {
    if (!acceptList.includes(extensionOf(candidate.name))) {
      onReject?.(`That file can't be imported. ${acceptLabel} only, up to ${maxSizeMb} MB.`);
      return;
    }
    if (candidate.size > maxSizeMb * 1024 * 1024) {
      onReject?.(`That file is too large. ${acceptLabel} only, up to ${maxSizeMb} MB.`);
      return;
    }
    setAnnouncement(`${candidate.name} selected, ${formatBytes(candidate.size)}`);
    onSelect(candidate);
  }

  // Persistent live region — kept mounted across both states so the selection
  // confirmation is reliably announced.
  const liveRegion = (
    <span aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) validateAndSelect(dropped);
  }

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  }

  // File-selected state.
  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-neutral-border bg-neutral-surface-raised p-4">
        <span aria-hidden="true" className="text-2xl">
          📄
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-text-primary">{file.name}</p>
          <p className="text-xs text-neutral-text-secondary">{formatBytes(file.size)}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAnnouncement('File removed');
            onClear();
          }}
          disabled={disabled}
          className="rounded px-2 py-1 text-xs font-medium text-neutral-text-secondary
            hover:text-neutral-text-primary disabled:opacity-50
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          Remove
        </button>
        {liveRegion}
      </div>
    );
  }

  // Empty state.
  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Choose file or drag one here, ${acceptLabel}, up to ${maxSizeMb} megabytes`}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={handleKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex h-56 flex-col items-center justify-center gap-2 rounded-lg border-[1.5px]
          border-dashed p-6 text-center transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
          ${
            dragOver
              ? 'border-brand-primary bg-brand-primary/10'
              : 'border-neutral-border bg-neutral-surface-raised'
          }`}
      >
        <span aria-hidden="true" className="text-3xl">
          📂
        </span>
        <p className="text-sm font-medium text-neutral-text-primary">
          {dragOver ? 'Drop to upload' : 'Drag a file here, or browse…'}
        </p>
        <p className="text-xs text-neutral-text-secondary">
          {acceptLabel} · up to {maxSizeMb} MB
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(',')}
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) validateAndSelect(picked);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = '';
        }}
      />
      {liveRegion}
    </>
  );
}
