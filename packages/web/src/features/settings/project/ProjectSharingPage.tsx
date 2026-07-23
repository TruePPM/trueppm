import { useState } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { toast } from '@/components/Toast';
import { FieldHelp } from '@/components/FieldHelp';
import { ShareViewDialog } from '@/features/share/ShareViewDialog';
import { SettingsPageTitle } from '../SettingsShell';
import { useRevokeShareLink, useShareLinks, type ShareLink } from '../hooks/useShareLinks';

const BTN =
  'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium ' +
  'text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ' +
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "expires in 27d" / "never expires" / "expired" clause for a link's line two. */
function expiryClause(expiresAt: string | null): string {
  if (!expiresAt) return 'never expires';
  const days = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  return `expires in ${days}d`;
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
            <span className="tppm-mono">
              share/{link.contentKind}/{link.tokenPrefix}…
            </span>
            {' · '}
            {link.showAssignees ? 'names shown' : 'names hidden'}
            {' · '}
            <span className={link.expiresAt ? 'text-semantic-warning' : undefined}>
              {expiryClause(link.expiresAt)}
            </span>
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
          <button type="button" onClick={() => setConfirming(true)} className={`${BTN} shrink-0`}>
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

function LinkGroup({
  icon,
  label,
  links,
  projectId,
}: {
  icon: string;
  label: string;
  links: ShareLink[];
  projectId: string;
}) {
  if (links.length === 0) return null;
  return (
    <div className="mb-5">
      <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-neutral-text-primary">
        <span aria-hidden="true">{icon}</span>
        {label} links
        <span className="rounded-chip bg-neutral-surface-sunken px-1.5 text-[11px] tppm-mono text-neutral-text-secondary">
          {links.length}
        </span>
      </h3>
      <div className="space-y-2.5">
        {links.map((link) => (
          <ShareLinkRow key={link.id} link={link} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}

/** Project → Sharing settings section (#283 board, extended for #1486 schedule).
 * Admin+ (gated by the shell). Manages board and schedule tokens together. */
export function ProjectSharingPage() {
  // The parent ProjectSettingsPage guards `!projectId` before mounting any section,
  // so this is always set here; coerce to satisfy the string-typed hooks/props.
  const projectId = useProjectId() ?? '';
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: links, isLoading } = useShareLinks(projectId);

  const active = (links ?? []).filter((l) => l.isActive);
  const scheduleLinks = active.filter((l) => l.contentKind === 'schedule');
  const boardLinks = active.filter((l) => l.contentKind === 'board');
  const hasAny = active.length > 0;

  return (
    <div>
      <SettingsPageTitle
        title="Sharing"
        subtitle="Generate public, read-only links to this project's schedule or board. Anyone with a link can view — no login required."
      />

      <div className="max-w-[720px] px-6 pb-8">
        <div className="mb-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-[13px] font-semibold text-neutral-text-primary">Public links</h2>
                <FieldHelp
                  label="Public links"
                  body="Create link opens a chooser: pick what to share — the project schedule or its board — set an expiry (a 30-day nudge is prefilled, or choose Never), and decide whether assignee names are shown (hidden by default). The link is public and read-only: anyone with it can view without signing in, and comments, notes, and attachments are never included. You can revoke any link here at any time."
                  docHref="administration/sharing-and-access"
                />
              </div>
              <p className="mt-0.5 text-[11px] text-neutral-text-secondary">
                Comments, notes, and attachments are never shown. Assignee names are hidden by
                default.
              </p>
            </div>
            <button type="button" onClick={() => setDialogOpen(true)} className={`${BTN} shrink-0`}>
              Create link…
            </button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-[12px] text-neutral-text-secondary">Loading…</p>
        ) : hasAny ? (
          <>
            <LinkGroup icon="◷" label="Schedule" links={scheduleLinks} projectId={projectId} />
            <LinkGroup icon="▦" label="Board" links={boardLinks} projectId={projectId} />
          </>
        ) : (
          <div className="rounded-card border border-dashed border-neutral-border p-6 text-center">
            <p className="text-[12px] text-neutral-text-secondary">
              No share links yet. Create one to share this project with a stakeholder.
            </p>
          </div>
        )}
      </div>

      {dialogOpen ? (
        <ShareViewDialog
          projectId={projectId}
          contentKind="schedule"
          allowKindChoice
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
