/**
 * LinkInputModal — small modal for pinning an external link as an attachment
 * (#310 phase 2b).
 *
 * Server enforces http(s)-only scheme; client mirrors with a quick check so
 * the typing user sees the error before the POST round-trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (url: string, title: string) => void;
  /** Pass `true` while the parent mutation is in flight to disable the form. */
  submitting?: boolean;
}

export function LinkInputModal({ open, onClose, onSubmit, submitting }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Focus the URL input on open so keyboard-only users land in the right place.
  useEffect(() => {
    if (open) {
      setUrl('');
      setTitle('');
      setError(null);
      requestAnimationFrame(() => urlInputRef.current?.focus());
    }
  }, [open]);

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (!trimmed) {
        setError('URL is required.');
        return;
      }
      if (!/^https?:\/\//i.test(trimmed)) {
        setError('Only http(s) URLs are accepted.');
        return;
      }
      setError(null);
      onSubmit(trimmed, title.trim());
    },
    [url, title, onSubmit],
  );

  // Esc closes — handled at the form level via the native cancel button + tab focus.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 w-full max-w-md p-4 bg-neutral-surface
          border border-neutral-border rounded"
      >
        <h2 id="link-modal-title" className="text-sm font-semibold text-neutral-text-primary">
          Pin a link
        </h2>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-text-secondary">URL</span>
          <input
            ref={urlInputRef}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://figma.com/…"
            required
            maxLength={2048}
            disabled={submitting}
            className="text-sm bg-neutral-surface border border-neutral-border rounded p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
              disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-text-secondary">Title (optional)</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Drawing rev 3"
            maxLength={255}
            disabled={submitting}
            className="text-sm bg-neutral-surface border border-neutral-border rounded p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
              disabled:opacity-50"
          />
        </label>
        {error && (
          <p className="text-xs text-semantic-critical" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-xs border border-neutral-border rounded px-3 h-7 font-medium
              text-neutral-text-secondary hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="text-xs bg-brand-primary text-white rounded px-3 h-7 font-medium
              hover:opacity-90
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none
              disabled:opacity-50"
          >
            {submitting ? 'Pinning…' : 'Pin link'}
          </button>
        </div>
      </form>
    </div>
  );
}
