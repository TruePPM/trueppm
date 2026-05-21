import { useEffect, useState } from 'react';

export interface StubPageBannerProps {
  /**
   * GitLab issue number tracking the API wiring for this page. Used both as
   * the dismissal key in `sessionStorage` (so the user dismisses each page's
   * banner independently) and as the issue link in the banner copy.
   */
  pageIssue: number;
}

const STORAGE_PREFIX = 'trueppm.settings.stub-banner-dismissed.';
const ISSUE_URL_BASE = 'https://gitlab.com/trueppm/trueppm/-/issues/';

/**
 * Header strip rendered at the top of every settings page whose backing API
 * hasn't shipped yet. Filed from VoC audit on #538 (Sarah / Marcus): stub
 * pages were visually identical to live ones and Marcus couldn't honestly
 * answer a compliance-officer drill-through.
 *
 * Dismiss state is per-issue and per-session (`sessionStorage`). The banner
 * reappears on every new tab/session until the page's API ships and the
 * caller removes the `<StubPageBanner>` from the page entirely. That
 * removal — rather than an in-component "is the hook live?" check — is the
 * single source of truth the issue requires: a wired page has no banner in
 * its source.
 */
export function StubPageBanner({ pageIssue }: StubPageBannerProps) {
  const storageKey = `${STORAGE_PREFIX}${pageIssue}`;
  const [dismissed, setDismissed] = useState(false);

  // Read the dismissal flag inside an effect so server-side rendering and
  // initial mount stay consistent (sessionStorage is not available during SSR
  // and accessing it synchronously during render causes a hydration mismatch).
  useEffect(() => {
    try {
      if (sessionStorage.getItem(storageKey) === '1') {
        setDismissed(true);
      }
    } catch {
      // sessionStorage may be unavailable (private mode, embedded iframe with
      // restricted cookies). Treat that as "show the banner" — failing closed
      // is safer than failing open for an honesty signal.
    }
  }, [storageKey]);

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(storageKey, '1');
    } catch {
      // See above — silent failure is acceptable. The banner still dismisses
      // visually for this render; it will reappear on the next navigation.
    }
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="stub-page-banner"
      className="flex items-center gap-2.5 px-6 py-2 bg-semantic-warning-bg border-b border-semantic-warning/40"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="text-semantic-warning shrink-0"
        aria-hidden="true"
      >
        <path
          d="M8 1.5L1.5 13.5h13L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
      </svg>
      <p className="text-[12px] text-neutral-text-primary leading-snug">
        <span className="font-semibold">Preview</span>
        <span className="text-neutral-text-secondary"> — your changes will not be saved yet. Tracked in </span>
        <a
          href={`${ISSUE_URL_BASE}${pageIssue}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
        >
          #{pageIssue}
        </a>
        <span className="text-neutral-text-secondary">.</span>
      </p>
      <div className="flex-1" />
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss preview banner for this session"
        className="text-neutral-text-secondary hover:text-neutral-text-primary p-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
