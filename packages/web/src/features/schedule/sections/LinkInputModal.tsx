/**
 * LinkInputModal — small modal for pinning an external link as an attachment
 * (#310 phase 2b).
 *
 * Server enforces http(s)-only scheme; client mirrors with a quick check so
 * the typing user sees the error before the POST round-trip.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

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
  // Traps Tab/Shift+Tab inside the dialog, focuses the first field (the URL
  // input, the first focusable descendant) on open, routes Escape to onClose,
  // and restores focus to the "+ Pin link" trigger on close (issue 575 —
  // this `role="dialog" aria-modal="true"` previously let Tab escape into the
  // body). Reuse this hook on any future modal rather than re-deriving it.
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) {
      setUrl('');
      setTitle('');
      setError(null);
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

  if (!open) return null;

  return (
    <div
      ref={trapRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 w-full max-w-md p-4 bg-neutral-surface
          border border-neutral-border rounded-card"
      >
        <h2 id="link-modal-title" className="text-sm font-semibold text-neutral-text-primary">
          Pin a link
        </h2>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-text-secondary">URL</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://figma.com/…"
            required
            maxLength={2048}
            disabled={submitting}
            className="text-sm bg-neutral-surface border border-neutral-border rounded-control p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
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
            className="text-sm bg-neutral-surface border border-neutral-border rounded-control p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
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
            className="text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
              text-neutral-text-secondary hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50"
          >
            Cancel
          </button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={submitting || !url.trim()}
          >
            {submitting ? 'Pinning…' : 'Pin link'}
          </Button>
        </div>
      </form>
    </div>
  );
}
