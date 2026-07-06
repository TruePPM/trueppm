import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useProjectId } from '@/hooks/useProjectId';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { toast } from '@/components/Toast';
import { SettingsPageTitle } from '../SettingsShell';
import {
  useCreateShareLink,
  useRevokeShareLink,
  useShareLinks,
  type CreatedShareLink,
  type ShareLink,
} from '../hooks/useShareLinks';

const BTN =
  'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium ' +
  'text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ' +
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Detail message from a DRF error response, if any. */
function errorDetail(err: unknown): string | null {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { detail?: string } | undefined;
    return data?.detail ?? null;
  }
  return null;
}

function CreateShareLinkDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [showAssignees, setShowAssignees] = useState(false);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const create = useCreateShareLink(projectId);
  // Once the token is revealed, Escape must NOT silently discard it before the user
  // has copied it — they click Done instead. (Same guard as PersonalAccessTokensPage.)
  const trapRef = useFocusTrap<HTMLDivElement>(true, created ? undefined : onClose);
  const revealRef = useRef<HTMLInputElement>(null);

  // Re-seat focus onto the reveal field when the dialog transitions form → reveal,
  // so keyboard users land on the one-time URL (multi-state-modal focus rule).
  useEffect(() => {
    if (created) revealRef.current?.focus();
  }, [created]);

  const shareUrl = created ? `${window.location.origin}${created.sharePath}` : '';
  // Server detail is already user-facing ("…disabled on this instance." /
  // "Public sharing is turned off for this project.") — surface it verbatim.
  const detail = create.error ? errorDetail(create.error) : null;

  const onSubmit = () => {
    create.mutate(
      { label: label.trim(), showAssignees },
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
      aria-labelledby="share-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        // Same guard as Escape: a backdrop click must not discard an un-copied token.
        if (e.target === e.currentTarget && !created) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="mx-4 w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in"
      >
        {created ? (
          <>
            <h2 id="share-dialog-title" className="mb-2 text-sm font-semibold text-neutral-text-primary">
              Link created
            </h2>
            <p
              className="mb-3 flex items-start gap-1.5 rounded-card border border-semantic-warning/70 bg-semantic-warning-bg px-2.5 py-2 text-xs text-semantic-warning"
              role="alert"
            >
              <span aria-hidden="true">⚠</span>
              Copy this link now — you won&rsquo;t be able to see it again.
            </p>
            <div className="mb-4 flex items-center gap-2">
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
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className={BTN}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="share-dialog-title" className="mb-2 text-sm font-semibold text-neutral-text-primary">
              Create share link
            </h2>
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
              placeholder="e.g. Client review board"
              className="mb-4 h-8 w-full rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[12px] text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
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
                  Off by default — names stay hidden from the public view to protect the team.
                </span>
              </span>
            </label>
            {detail ? (
              <p className="mb-3 text-[11px] text-semantic-critical" role="alert">
                {detail}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={BTN}>
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={create.isPending}
                className={`${BTN} !border-brand-primary !bg-brand-primary !text-white hover:!opacity-90`}
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

function ShareLinkRow({ link, projectId }: { link: ShareLink; projectId: string }) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeShareLink(projectId);

  const onRevoke = () => {
    revoke.mutate(link.id, {
      onSuccess: () => toast.success('Share link revoked'),
      onError: () => toast.error('Could not revoke — try again'),
    });
  };

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-neutral-text-primary">
            {link.label || 'Untitled link'}
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-text-secondary">
            <span className="tppm-mono">share/board/{link.tokenPrefix}…</span>
            {' · '}
            {link.showAssignees ? 'names shown' : 'names hidden'}
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-text-secondary">
            {link.createdBy ? `Created by ${link.createdBy}` : 'Created'} ·{' '}
            {`Viewed ${link.accessCount}×`}
            {link.accessCount > 0 ? ` · last ${relativeTime(link.lastAccessedAt)}` : ''}
          </div>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-neutral-text-secondary">Revoke?</span>
            <button
              type="button"
              onClick={onRevoke}
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
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`${BTN} shrink-0`}
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

/** Project → Sharing settings section (#283, ADR-0245). Admin+ (gated by the shell). */
export function ProjectSharingPage() {
  // The parent ProjectSettingsPage guards `!projectId` before mounting any section,
  // so this is always set here; coerce to satisfy the string-typed hooks/props.
  const projectId = useProjectId() ?? '';
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: links, isLoading } = useShareLinks(projectId);

  return (
    <div>
      <SettingsPageTitle
        title="Sharing"
        subtitle="Generate a public, read-only link to this project's board. Anyone with the link can view — no login required."
      />

      <div className="max-w-[720px] px-6 pb-8">
        <div className="mb-3 rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold text-neutral-text-primary">
                Public board links
              </h2>
              <p className="mt-0.5 text-[11px] text-neutral-text-secondary">
                Comments and internal notes are never shown. Assignee names are hidden by default.
              </p>
            </div>
            <button type="button" onClick={() => setDialogOpen(true)} className={`${BTN} shrink-0`}>
              Create link…
            </button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-[12px] text-neutral-text-secondary">Loading…</p>
        ) : links && links.length > 0 ? (
          <div className="space-y-2.5">
            {links.map((link) => (
              <ShareLinkRow key={link.id} link={link} projectId={projectId} />
            ))}
          </div>
        ) : (
          <div className="rounded-card border border-dashed border-neutral-border p-6 text-center">
            <p className="text-[12px] text-neutral-text-secondary">
              No share links yet. Create one to share this board with a stakeholder.
            </p>
          </div>
        )}
      </div>

      {dialogOpen ? (
        <CreateShareLinkDialog projectId={projectId} onClose={() => setDialogOpen(false)} />
      ) : null}
    </div>
  );
}
