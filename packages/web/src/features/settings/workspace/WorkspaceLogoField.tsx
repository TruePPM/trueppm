import { useCallback, useId, useRef, useState } from 'react';
import { toast } from '@/components/Toast';
import {
  LOGO_ACCEPT_ATTR,
  useDeleteWorkspaceLogo,
  useUploadWorkspaceLogo,
  validateLogoFile,
  type LogoValidationLevel,
} from '../hooks/useWorkspaceLogo';

/** Derive a 1–2 letter mark from the workspace name for the empty-logo fallback. */
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

interface Props {
  /** Public serve URL when a logo is set, else null (renders the letter-mark). */
  logoUrl: string | null;
  /** Workspace name — drives the fallback letter-mark. */
  name: string;
}

/**
 * Wired "Workspace logo" control (#969, ADR-0149).
 *
 * Shows the current logo (or a name-derived letter-mark when unset), an Upload/
 * Replace file picker that also accepts a drop onto the thumbnail, client-side
 * pre-validation (type/size hard-block, under-256px soft warning), and a
 * lightweight inline confirm for Remove. Uploads are raster-only (PNG/WebP); the
 * server re-validates by magic bytes, so this is convenience, not the gate.
 */
export function WorkspaceLogoField({ logoUrl, name }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadWorkspaceLogo();
  const remove = useDeleteWorkspaceLogo();
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const errorId = useId();

  const busy = upload.isPending || remove.isPending;
  const hasLogo = Boolean(logoUrl);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      setWarning(null);
      if (!file) return;
      const result = await validateLogoFile(file);
      if (result?.level === ('error' satisfies LogoValidationLevel)) {
        toast.error(result.message);
        return;
      }
      if (result?.level === ('warning' satisfies LogoValidationLevel)) {
        // Soft advisory — keep it visible next to the control, still upload.
        setWarning(result.message);
      }
      try {
        await upload.mutateAsync(file);
        toast.success('Workspace logo updated.');
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 413) toast.error('Logo must be 2 MB or smaller.');
        else if (status === 415) toast.error('Logo must be a PNG or WebP image.');
        else toast.error('Could not upload the logo. Please try again.');
      }
    },
    [upload],
  );

  const handleRemove = useCallback(async () => {
    setConfirmRemove(false);
    setWarning(null);
    try {
      await remove.mutateAsync();
      toast.success('Workspace logo removed.');
    } catch {
      toast.error('Could not remove the logo. Please try again.');
    }
  }, [remove]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        {/* Thumbnail doubles as a drop zone. */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}
          disabled={busy}
          aria-label={hasLogo ? 'Replace workspace logo' : 'Upload workspace logo'}
          className={`relative w-14 h-14 rounded-control shrink-0 overflow-hidden inline-flex items-center justify-center transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
            dragOver ? 'ring-2 ring-brand-primary ring-offset-1' : ''
          } ${hasLogo ? 'border border-neutral-border bg-neutral-surface-raised' : 'bg-brand-primary'}`}
        >
          {hasLogo ? (
            <img src={logoUrl ?? undefined} alt="Workspace logo" className="w-full h-full object-contain" />
          ) : (
            <span className="text-white text-xl font-bold">{initialsFor(name)}</span>
          )}
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-neutral-surface-sunken/70">
              <span className="w-4 h-4 rounded-full border-2 border-brand-primary border-t-transparent animate-spin" />
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {hasLogo ? 'Replace' : 'Upload'}
          </button>

          {hasLogo &&
            (confirmRemove ? (
              <span className="inline-flex items-center gap-1.5 text-[12px]">
                <span className="text-neutral-text-secondary">Remove?</span>
                <button
                  type="button"
                  onClick={() => void handleRemove()}
                  disabled={busy}
                  className="px-2 py-1 rounded-control text-danger-text font-medium hover:bg-danger-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text disabled:opacity-60"
                >
                  Yes, remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="px-2 py-1 rounded-control text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
                className="px-3 py-1.5 rounded-control text-[13px] font-medium text-neutral-text-secondary hover:text-danger-text hover:bg-danger-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Remove
              </button>
            ))}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT_ATTR}
          className="sr-only"
          aria-describedby={warning ? errorId : undefined}
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            // Reset so re-selecting the same file re-fires change.
            e.target.value = '';
          }}
        />
      </div>

      {warning && (
        <p id={errorId} className="text-[11px] text-warning-text" role="status">
          {warning}
        </p>
      )}
    </div>
  );
}
