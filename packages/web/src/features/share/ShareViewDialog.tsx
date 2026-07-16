import { WarningIcon } from '@/components/Icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { toast } from '@/components/Toast';
import {
  useCreateShareLink,
  useRevokeShareLink,
  useShareLinks,
  type CreatedShareLink,
  type ShareLink,
} from '@/features/settings/hooks/useShareLinks';

/**
 * One dialog for the whole share lifecycle of a single view (#1486, ADR-0265),
 * launched from the Schedule and Board toolbars and from Project Settings → Sharing.
 * `contentKind` ('schedule' | 'board') is the only difference between the two: it
 * drives the copy, filters the managed list, and is sent to the mint. Three states
 * share one surface — Manage (active links exist), Create (form), Reveal (token shown
 * exactly once, with a copy-guard so an un-copied token is never silently discarded).
 */

const BTN =
  'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium ' +
  'text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ' +
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';
const PRI = `${BTN} !border-brand-primary !bg-brand-primary !text-white hover:!opacity-90`;
const SEG_ON = 'bg-brand-primary text-white';
const SEG_OFF = 'text-neutral-text-primary hover:bg-neutral-surface-sunken';

type ExpiryChoice = 'never' | '30d' | 'custom';

function errorDetail(err: unknown): string | null {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { detail?: string } | undefined;
    return data?.detail ?? null;
  }
  return null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "expires in 27d" / "never expires" / "expired" for a link's line-two clause. */
function expiryClause(expiresAt: string | null): string {
  if (!expiresAt) return 'never expires';
  const days = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  return `expires in ${days}d`;
}

/** Resolve the chosen expiry option to an ISO timestamp (or null for "Never"). */
function resolveExpiry(choice: ExpiryChoice, customDate: string): string | null {
  if (choice === 'never') return null;
  if (choice === '30d') return new Date(Date.now() + 30 * 86_400_000).toISOString();
  if (customDate) {
    const ms = Date.parse(`${customDate}T23:59:59Z`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function CreatedLinkRow({
  link,
  projectId,
  origin,
}: {
  link: ShareLink;
  projectId: string;
  origin: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeShareLink(projectId);
  const url = `${origin}/share/${link.contentKind}/${link.tokenPrefix}`;

  const onCopyPrefix = () => {
    // Only a token PREFIX is known after creation (the full token is one-time), so
    // "Copy" here copies the row's display URL fragment as a convenience, not a
    // working link — matching the settings management list. The working link is
    // copied at the reveal step.
    void navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy — select manually'),
    );
  };

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-neutral-text-primary">
            {link.label || 'Untitled link'}
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-text-secondary">
            <span className="tppm-mono">
              share/{link.contentKind}/{link.tokenPrefix}…
            </span>{' '}
            · {link.showAssignees ? 'names shown' : 'names hidden'} ·{' '}
            <span className={link.expiresAt ? 'text-semantic-warning' : undefined}>
              {expiryClause(link.expiresAt)}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-text-secondary">
            Viewed {link.accessCount}×
            {link.accessCount > 0 ? ` · last ${relativeTime(link.lastAccessedAt)}` : ''}
          </div>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                revoke.mutate(link.id, {
                  onSuccess: () => toast.success('Share link revoked'),
                  onError: () => toast.error('Could not revoke — try again'),
                })
              }
              disabled={revoke.isPending}
              className={`${BTN} !border-semantic-critical !text-semantic-critical`}
            >
              {revoke.isPending ? 'Revoking…' : 'Confirm'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={BTN}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={onCopyPrefix} className={BTN}>
              Copy
            </button>
            <button type="button" onClick={() => setConfirming(true)} className={BTN}>
              Revoke
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ShareViewDialog({
  projectId,
  contentKind,
  onClose,
  allowKindChoice = false,
}: {
  projectId: string;
  contentKind: 'board' | 'schedule';
  onClose: () => void;
  /** When true (settings, context-free), the create form offers a Board/Schedule
   * selector. When false (toolbar), the kind is fixed to the launching view. */
  allowKindChoice?: boolean;
}) {
  // The active kind: fixed from the launching view, or user-selectable in settings.
  const [kind, setKind] = useState<'board' | 'schedule'>(contentKind);
  const noun = kind === 'schedule' ? 'schedule' : 'board';
  const { data: allLinks } = useShareLinks(projectId);
  // Expiry is an instant — render it through the user's date-format preference
  // (rule 257) so "Expires …" cannot show a different calendar day than the rest
  // of the app (the ADR-0144/#1953 bug class), which matters on a security string.
  const { formatInstantDate } = useUserDateFormat();
  const links = useMemo(
    () => (allLinks ?? []).filter((l) => l.contentKind === kind && l.isActive),
    [allLinks, kind],
  );

  const [mode, setMode] = useState<'manage' | 'create'>('create');
  // Land on Manage when active links already exist; otherwise start in Create.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!primed && allLinks) {
      setMode(links.length > 0 ? 'manage' : 'create');
      setPrimed(true);
    }
  }, [primed, allLinks, links.length]);

  const [label, setLabel] = useState('');
  const [showAssignees, setShowAssignees] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>('30d');
  const [customDate, setCustomDate] = useState('');
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const create = useCreateShareLink(projectId);

  // Once the token is revealed, Escape / backdrop must NOT discard it before the
  // user has copied it — they click Done instead (the #283 copy-guard pattern).
  const trapRef = useFocusTrap<HTMLDivElement>(true, created ? undefined : onClose);
  const revealRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (created) revealRef.current?.focus();
  }, [created]);

  const origin = window.location.origin;
  const shareUrl = created ? `${origin}${created.sharePath}` : '';
  const detail = create.error ? errorDetail(create.error) : null;

  const onSubmit = () => {
    create.mutate(
      {
        label: label.trim(),
        showAssignees,
        contentKind: kind,
        expiresAt: resolveExpiry(expiry, customDate),
      },
      { onSuccess: (link) => setCreated(link) },
    );
  };

  const onCopy = () => {
    void navigator.clipboard.writeText(shareUrl).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy — select and copy manually'),
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-view-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !created) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="mx-4 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in"
      >
        {created ? (
          <>
            <h2
              id="share-view-dialog-title"
              className="mb-2 text-sm font-semibold text-neutral-text-primary"
            >
              Link created
            </h2>
            <p
              className="mb-3 flex items-start gap-1.5 rounded-card border border-semantic-warning/70 bg-semantic-warning-bg px-2.5 py-2 text-xs text-semantic-warning"
              role="alert"
            >
              <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
              Copy this link now — you won&rsquo;t be able to see it again.
            </p>
            <div className="mb-2 flex items-center gap-2">
              <input
                ref={revealRef}
                type="text"
                readOnly
                value={shareUrl}
                aria-label="Public share link"
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 flex-1 rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[12px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <button type="button" onClick={onCopy} className={BTN}>
                Copy
              </button>
            </div>
            <p className="mb-4 tppm-mono text-[11px] text-neutral-text-secondary">
              {created.expiresAt
                ? `Expires ${formatInstantDate(created.expiresAt)}`
                : 'Never expires'}{' '}
              · {created.showAssignees ? 'assignee names shown' : 'assignee names hidden'}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className={PRI}>
                Done
              </button>
            </div>
          </>
        ) : mode === 'manage' && links.length > 0 ? (
          <>
            <div className="mb-1 flex items-center justify-between">
              <h2
                id="share-view-dialog-title"
                className="text-sm font-semibold text-neutral-text-primary"
              >
                Shared {noun} links
              </h2>
              <button type="button" onClick={() => setMode('create')} className={`${BTN} !px-2 !py-1`}>
                + New link
              </button>
            </div>
            <p className="mb-3 text-[11px] text-neutral-text-secondary">
              {links.length} active. Revoking a link takes effect immediately.
            </p>
            <div className="mb-4 space-y-2">
              {links.map((link) => (
                <CreatedLinkRow key={link.id} link={link} projectId={projectId} origin={origin} />
              ))}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className={BTN}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <h2
              id="share-view-dialog-title"
              className="mb-1 text-sm font-semibold text-neutral-text-primary"
            >
              Share this {noun}
            </h2>
            <p className="mb-4 text-[11px] text-neutral-text-secondary">
              Anyone with the link can view this {noun}, read-only. No sign-in required.
            </p>

            {allowKindChoice ? (
              <>
                <span className="mb-1 block text-[12px] font-medium text-neutral-text-primary">
                  What to share
                </span>
                <div
                  className="mb-4 inline-flex rounded-control border border-neutral-border p-0.5 text-[12px]"
                  role="group"
                  aria-label="What to share"
                >
                  {(['schedule', 'board'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={kind === k}
                      onClick={() => setKind(k)}
                      className={`rounded-[6px] px-2.5 py-1 font-medium capitalize ${kind === k ? SEG_ON : SEG_OFF}`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <label
              htmlFor="share-link-label"
              className="mb-1 block text-[12px] font-medium text-neutral-text-primary"
            >
              Label <span className="font-normal text-neutral-text-secondary">(optional)</span>
            </label>
            <input
              id="share-link-label"
              type="text"
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Client review — Q3 steering"
              className="mb-4 h-8 w-full rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[12px] text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />

            <span className="mb-1 block text-[12px] font-medium text-neutral-text-primary">
              Link expires
            </span>
            <div
              className="mb-1 inline-flex rounded-control border border-neutral-border p-0.5 text-[12px]"
              role="group"
              aria-label="Link expiry"
            >
              {(['never', '30d', 'custom'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={expiry === choice}
                  onClick={() => setExpiry(choice)}
                  className={`rounded-[6px] px-2.5 py-1 font-medium ${expiry === choice ? SEG_ON : SEG_OFF}`}
                >
                  {choice === 'never' ? 'Never' : choice === '30d' ? 'In 30 days' : 'Pick date…'}
                </button>
              ))}
            </div>
            {expiry === 'custom' ? (
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                aria-label="Expiry date"
                className="mb-4 mt-1 block h-8 rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[12px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
            ) : (
              <div className="mb-4" />
            )}

            <span className="mb-1 block text-[12px] font-medium text-neutral-text-primary">
              What the public view reveals
            </span>
            <label className="mb-4 flex items-start gap-2">
              <input
                type="checkbox"
                checked={showAssignees}
                onChange={(e) => setShowAssignees(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-[12px] text-neutral-text-primary">
                Show assignee names
                <span className="block text-[11px] text-neutral-text-secondary">
                  Off by default — the {noun} is visible, but who&rsquo;s on each task stays private.
                </span>
              </span>
            </label>

            {detail ? (
              <p className="mb-3 text-[11px] text-semantic-critical" role="alert">
                {detail}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => (links.length > 0 ? setMode('manage') : onClose())}
                className={BTN}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={create.isPending || (expiry === 'custom' && !customDate)}
                className={PRI}
              >
                {create.isPending ? 'Creating…' : 'Create link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
