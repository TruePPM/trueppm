import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { LinkIcon } from '@/components/Icons';

const VERIFY_COMMAND = 'python manage.py audit_verify';

/**
 * The OSS chain-integrity signal, made human (#2020, design §4.1).
 *
 * Every agent action is one link in a tamper-evident hash chain; the authoritative
 * integrity check is `manage.py audit_verify`, run by the team on its own instance
 * (ADR-0112). The browser cannot make a cryptographic claim the CLI makes, and this
 * panel renders a *filtered* projection of the chain (by program / range / verdict),
 * so a non-contiguous `sequence` here is expected — NOT a tamper signal. We therefore
 * show the honest neutral "Verify locally" state and point at the CLI, never a false
 * green and never a false-positive gap alarm over filtered rows. (An in-browser
 * verify endpoint that re-walks a page is a noted follow-up, not built here.)
 */
export function ChainVerifyBadge() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: 320,
    estimatedHeight: 180,
    align: 'right',
    onDismiss: () => setOpen(false),
  });

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(VERIFY_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (permissions / insecure context) — the command stays
      // visible for manual copy; no error surfacing needed for a convenience action.
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Chain verification — details"
        className="inline-flex items-center gap-1.5 rounded-chip border border-neutral-border bg-neutral-surface-sunken px-2.5 py-1 text-xs font-medium text-neutral-text-secondary transition-colors hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Verify locally
      </button>

      {popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Chain verification"
            style={popoverStyle}
            className="z-50 rounded-card border border-neutral-border bg-neutral-surface p-4 text-sm text-neutral-text-secondary shadow-pop"
          >
            <p className="m-0 leading-snug">
              Every agent action is one link in a tamper-evident chain. Each row&rsquo;s fingerprint
              (<span className="tppm-mono">record_hash</span>) is computed from the one before it,
              so a removed or altered row breaks the chain.
            </p>
            <p className="mt-2 mb-1 leading-snug">
              To verify the full chain on your own instance, run:
            </p>
            <div className="flex items-center gap-2">
              <code className="tppm-mono flex-1 truncate rounded-control bg-neutral-surface-sunken px-2 py-1 text-xs text-neutral-text-primary">
                {VERIFY_COMMAND}
              </code>
              <button
                type="button"
                onClick={() => void copyCommand()}
                className="shrink-0 rounded-control border border-neutral-border px-2 py-1 text-xs font-medium text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
