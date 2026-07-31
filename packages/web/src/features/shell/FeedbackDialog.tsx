/**
 * "Report a bug / Send feedback" — shows exactly what will be sent, then lets
 * the user leave with it (#2392).
 *
 * **A link, not a beacon.** Opening this dialog makes no network request and
 * sends nothing. The body below is assembled in the browser, displayed verbatim,
 * and travels only when the user clicks through to the tracker — in a URL they
 * can read and edit on arrival. A self-hosted instance never phones home as a
 * side effect of the control existing.
 *
 * The textarea is editable on purpose: "here is what we would send" is not a
 * real promise unless the user can change it before it goes.
 */
import { useMemo, useState } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useBuildInfo } from '@/hooks/useEdition';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';
import {
  DEFAULT_FEEDBACK_URL,
  buildFeedbackBody,
  buildFeedbackUrl,
  collectFeedbackContext,
} from '@/lib/feedbackContext';

interface FeedbackDialogProps {
  onClose: () => void;
}

export function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const build = useBuildInfo();
  const { data: workspace } = useWorkspaceSettings();
  const panelRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const context = useMemo(
    () =>
      collectFeedbackContext({
        version: build.version,
        edition: build.edition,
        buildSha: build.buildSha,
        href: typeof window === 'undefined' ? '/' : window.location.href,
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      }),
    [build.version, build.edition, build.buildSha],
  );

  // Derived until the user types, then theirs. `useBuildInfo` reads a query that
  // may still be in flight when the dialog mounts, so a body snapshotted at mount
  // freezes the "unknown" placeholder and reports it forever.
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? buildFeedbackBody(context);

  // An operator-set URL wins; empty means the built-in public tracker. The
  // default is resolved here rather than stored, so an upgrade can move it.
  const target = workspace?.feedbackUrl.trim() || DEFAULT_FEEDBACK_URL;
  const href = useMemo(
    () => buildFeedbackUrl(target, { ...context, routePath: context.routePath }),
    [target, context],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4"
      // Matches the repo's modal-backdrop idiom: `presentation` + a target check
      // dismisses on a backdrop click without making a div pretend to be a
      // control. Escape is handled by the focus trap.
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="w-full max-w-lg rounded-card border border-neutral-border bg-neutral-surface p-4 shadow-pop"
      >
        <h2 id="feedback-title" className="text-sm font-semibold text-neutral-text-primary">
          Report a bug or send feedback
        </h2>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          This opens your tracker with the text below already filled in.{' '}
          <strong className="font-medium">Nothing is sent from here</strong> — you can edit anything
          first, and nothing leaves until you submit it there.
        </p>

        <label className="sr-only" htmlFor="feedback-body">
          Report contents
        </label>
        <textarea
          id="feedback-body"
          value={body}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          className="tppm-mono mt-3 w-full rounded-control border border-neutral-border bg-neutral-surface-sunken
            p-2 text-[11px] text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary"
        />

        <p className="mt-2 text-xs text-neutral-text-secondary">
          Included: the TruePPM version, edition, the screen you were on, and your browser. Not
          included: your name or email, and any project, task, or schedule content.
        </p>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-control border border-neutral-border px-3 text-xs font-medium
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            Cancel
          </button>
          <a
            href={hrefWithBody(href, body)}
            target="_blank"
            // `noopener` is the security half; `noreferrer` also withholds the
            // referrer, which would otherwise hand the tracker the full URL —
            // ids and query string included — that this feature exists to strip.
            rel="noopener noreferrer"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-control bg-brand-primary px-3 text-xs
              font-medium text-white no-underline hover:bg-brand-primary-dark
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Continue to tracker
          </a>
        </div>
      </div>
    </div>
  );
}

/** Re-apply the user's edits over the generated description. */
function hrefWithBody(href: string, body: string): string {
  const url = new URL(href);
  url.searchParams.set('issue[description]', body);
  return url.toString();
}
