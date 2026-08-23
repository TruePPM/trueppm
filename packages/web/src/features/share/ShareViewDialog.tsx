import { WarningIcon } from '@/components/Icons';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import axios from 'axios';
import { Link } from 'react-router';
import { useProject } from '@/hooks/useProject';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';
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
const PRI = `${BTN} !border-brand-primary !bg-brand-primary !text-neutral-text-inverse hover:!opacity-90`;
const SEG_ON = 'bg-brand-primary text-neutral-text-inverse';
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

/**
 * The create phase — the form that decides a link's scope before it exists.
 *
 * Every reveal toggle defaults to the private setting, so an accidental
 * Create produces the least-exposing link rather than the most. The submit is
 * blocked while a custom expiry has no date, since an unparsed date would
 * otherwise fall back to "never expires".
 */
function CreateForm({
  noun,
  allowKindChoice,
  kind,
  setKind,
  label,
  setLabel,
  expiry,
  setExpiry,
  customDate,
  setCustomDate,
  showAssignees,
  setShowAssignees,
  showMilestoneDates,
  setShowMilestoneDates,
  detail,
  isPending,
  onSubmit,
  onCancel,
  sharingBlocked,
  sharingNotice,
}: {
  noun: string;
  allowKindChoice: boolean;
  kind: 'board' | 'schedule';
  setKind: (next: 'board' | 'schedule') => void;
  label: string;
  setLabel: (next: string) => void;
  expiry: 'never' | '30d' | 'custom';
  setExpiry: (next: 'never' | '30d' | 'custom') => void;
  customDate: string;
  setCustomDate: (next: string) => void;
  showAssignees: boolean;
  setShowAssignees: (next: boolean) => void;
  showMilestoneDates: boolean;
  setShowMilestoneDates: (next: boolean) => void;
  detail: string | null;
  isPending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  /** Server-resolved `effective_public_sharing === false` — the mint will 403 (#2910). */
  sharingBlocked: boolean;
  sharingNotice: ReactNode;
}) {
  return (
    <>
      <h2
        id="share-view-dialog-title"
        className="mb-1 text-sm font-semibold text-neutral-text-primary"
      >
        Share this {noun}
      </h2>
      <p className="mb-4 text-xs text-neutral-text-secondary">
        Anyone with the link can view this {noun}, read-only. No sign-in required.
      </p>

      {allowKindChoice ? (
        <>
          <span className="mb-1 block text-[12px] font-medium text-neutral-text-primary">
            What to share
          </span>
          <SegmentedChoice
            ariaLabel="What to share"
            options={['schedule', 'board'] as const}
            labelFor={(k) => k}
            value={kind}
            onSelect={setKind}
            buttonClassName="capitalize"
          />
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
        className="mb-4 h-8 w-full rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[12px] text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />

      <span className="mb-1 block text-[12px] font-medium text-neutral-text-primary">
        Link expires
      </span>
      <SegmentedChoice
        ariaLabel="Link expiry"
        options={['never', '30d', 'custom'] as const}
        labelFor={expiryLabel}
        value={expiry}
        onSelect={setExpiry}
        className="mb-1"
      />
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
      <label className="mb-3 flex items-start gap-2">
        <input
          type="checkbox"
          checked={showAssignees}
          onChange={(e) => setShowAssignees(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-[12px] text-neutral-text-primary">
          Show assignee names
          <span className="block text-xs text-neutral-text-secondary">
            Off by default — the {noun} is visible, but who&rsquo;s on each task stays
            private.
          </span>
        </span>
      </label>
      {/* Schedule only (#2532, #1486 handoff): a board has no milestone lane to
          hide, so the board dialog keeps exactly one reveal toggle. */}
      {kind === 'schedule' ? (
        <label className="mb-4 flex items-start gap-2">
          <input
            type="checkbox"
            checked={showMilestoneDates}
            onChange={(e) => setShowMilestoneDates(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[12px] text-neutral-text-primary">
            Show milestone dates
            <span className="block text-xs text-neutral-text-secondary">
              On by default — milestones are the headline. Turn it off and
              milestone rows are left out of the shared timeline entirely, so the
              audience sees progress without committed dates.
            </span>
          </span>
        </label>
      ) : (
        <div className="mb-4" />
      )}

      {sharingNotice}
      {detail ? (
        <p className="mb-3 text-xs text-semantic-critical" role="alert">
          {detail}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={sharingBlocked || isPending || (expiry === 'custom' && !customDate)}
          className={PRI}
          // Named by the notice above rather than a tooltip: the reason and the remedy
          // must survive into the accessible name, and a disabled button is not
          // hoverable or focusable (#2910).
          aria-describedby={sharingBlocked ? 'share-sharing-disabled' : undefined}
        >
          {isPending ? 'Creating…' : 'Create link'}
        </button>
      </div>
    </>
  );
}

/**
 * Why the Create button is blocked, and the one click that unblocks it (#2910).
 *
 * `Workspace.public_sharing` defaults to **false**, so on a fresh install an Admin could
 * open this dialog from any of its three launch points, fill it in, submit, and receive a
 * 403 from the mint (`share_views.py`, which correctly checks the ADR-0135 policy). The
 * dialog surfaced the server's detail string honestly but read no
 * `effective_public_sharing` and offered no route to the setting — a dead end, and the
 * shape web rules 8 and 274 exist to prevent.
 *
 * This states the blocked status *before* the user fills in a form that cannot succeed,
 * and names the actual lever. The setting is **workspace**-scoped and lives on Workspace
 * Settings → General; the resolution is project override ?? program override ?? workspace
 * (ADR-0135), but the workspace toggle is the only one with a UI.
 *
 * The link is offered only to a workspace admin. That route is `RequireWorkspaceAdmin`,
 * so pointing a project-admin-but-plain-workspace-member at it would bounce them — the
 * enabled-but-403 shape #2012 removed from the settings tree. They are told who can turn
 * it on instead, which is the actionable thing for them.
 */
function SharingDisabledNotice({
  projectId,
  isWorkspaceAdmin,
  onNavigate,
}: {
  projectId: string;
  isWorkspaceAdmin: boolean | null;
  onNavigate: () => void;
}) {
  return (
    <div
      id="share-sharing-disabled"
      className="mb-4 rounded-control border border-semantic-warning bg-semantic-warning-bg p-3"
      role="status"
    >
      <p className="flex items-start gap-2 text-[12px] font-medium text-neutral-text-primary">
        <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Public sharing is turned off for this workspace</span>
      </p>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        Read-only share links are disabled, so this form cannot create one yet.
        {isWorkspaceAdmin === false
          ? ' A workspace admin can turn it on in Workspace Settings → General.'
          : null}
      </p>
      {isWorkspaceAdmin !== false ? (
        <Link
          to="/settings#general"
          onClick={onNavigate}
          state={{ from: `/projects/${projectId}` }}
          className="mt-2 inline-block text-xs font-medium text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Turn on public sharing in Workspace Settings
        </Link>
      ) : null}
    </div>
  );
}

/** Human label for each expiry choice. */
function expiryLabel(choice: 'never' | '30d' | 'custom'): string {
  switch (choice) {
    case 'never':
      return 'Never';
    case '30d':
      return 'In 30 days';
    default:
      return 'Pick date…';
  }
}

/**
 * Segmented single-choice control, shared by the "what to share" and "link
 * expires" pickers.
 *
 * `aria-pressed` on each button rather than a radiogroup: these are immediate
 * toggles within an already-labelled `role="group"`, which is how the rest of
 * the dialog's segmented controls announce.
 */
function SegmentedChoice<T extends string>({
  ariaLabel,
  options,
  labelFor,
  value,
  onSelect,
  className = 'mb-4',
  buttonClassName = '',
}: {
  ariaLabel: string;
  options: readonly T[];
  labelFor: (option: T) => string;
  value: T;
  onSelect: (option: T) => void;
  className?: string;
  buttonClassName?: string;
}) {
  return (
    <div
      className={`${className} inline-flex rounded-control border border-neutral-border p-0.5 text-[12px]`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onSelect(option)}
          className={`rounded-[6px] px-2.5 py-1 font-medium ${buttonClassName} ${value === option ? SEG_ON : SEG_OFF}`}
        >
          {labelFor(option)}
        </button>
      ))}
    </div>
  );
}

/**
 * The manage phase — every live link for this resource.
 *
 * The token itself is never shown here (the server keeps only a hash), so this
 * lists labels and scopes and offers revocation. Revoking takes effect
 * immediately, which the copy states rather than leaving to be discovered.
 */
function ManagePanel({
  links,
  noun,
  projectId,
  onNewLink,
  onClose,
}: {
  links: ShareLink[];
  noun: string;
  projectId: string;
  onNewLink: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="mb-1 flex items-center justify-between">
        <h2 id="share-view-dialog-title" className="text-sm font-semibold text-neutral-text-primary">
          Shared {noun} links
        </h2>
        <button type="button" onClick={onNewLink} className={`${BTN} !px-2 !py-1`}>
          + New link
        </button>
      </div>
      <p className="mb-3 text-xs text-neutral-text-secondary">
        {links.length} active. Revoking a link takes effect immediately.
      </p>
      <div className="mb-4 space-y-2">
        {links.map((link) => (
          <CreatedLinkRow key={link.id} link={link} projectId={projectId} />
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={BTN}>
          Close
        </button>
      </div>
    </>
  );
}

/**
 * One-line summary of exactly what the new link exposes.
 *
 * Stated in full at reveal time because this is the last moment the creator
 * sees the token — the scope has to be legible now, not discoverable later from
 * the manage list.
 */
function describeShareScope(
  created: CreatedShareLink,
  formatInstantDate: (iso: string) => string,
): string {
  const expiry = created.expiresAt
    ? `Expires ${formatInstantDate(created.expiresAt)}`
    : 'Never expires';
  const assignees = created.showAssignees ? 'assignee names shown' : 'assignee names hidden';
  const parts = [expiry, assignees];
  if (created.contentKind === 'schedule') {
    parts.push(created.showMilestoneDates ? 'milestone dates shown' : 'milestone dates hidden');
  }
  return parts.join(' · ');
}

/**
 * The reveal phase — the only time the share token is displayed.
 *
 * The dialog cannot show it again (the server stores a hash), which is why the
 * warning is a role="alert" and the input is focused and pre-selected on mount.
 */
function RevealPanel({
  created,
  shareUrl,
  revealRef,
  formatInstantDate,
  onCopy,
  onClose,
}: {
  created: CreatedShareLink;
  shareUrl: string;
  revealRef: RefObject<HTMLInputElement | null>;
  formatInstantDate: (iso: string) => string;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <h2 id="share-view-dialog-title" className="mb-2 text-sm font-semibold text-neutral-text-primary">
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
      <p className="mb-4 tppm-mono text-xs text-neutral-text-secondary">
        {describeShareScope(created, formatInstantDate)}
      </p>
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={PRI}>
          Done
        </button>
      </div>
    </>
  );
}

function CreatedLinkRow({ link, projectId }: { link: ShareLink; projectId: string }) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeShareLink(projectId);
  // Only the token PREFIX survives creation (the full token is one-time), so a
  // manage-row copy can never reproduce a working link. Copy the bare reference
  // fragment — no origin, so it never reads as a clickable URL — for correlating
  // this row against access logs, and label/toast it honestly (#2163).
  const reference = `share/${link.contentKind}/${link.tokenPrefix}`;

  const onCopyReference = () => {
    void navigator.clipboard.writeText(reference).then(
      () => toast.info('Reference copied — the full link was only shown at creation'),
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
          <div className="mt-0.5 text-xs text-neutral-text-secondary">
            <span className="tppm-mono">
              share/{link.contentKind}/{link.tokenPrefix}…
            </span>{' '}
            · {link.showAssignees ? 'names shown' : 'names hidden'} ·{' '}
            {/* Milestone visibility is a schedule-only reveal (#2532) — a board link
                has no milestone lane, so the clause would be meaningless noise there. */}
            {link.contentKind === 'schedule' ? (
              <>
                {link.showMilestoneDates ? 'milestone dates shown' : 'milestone dates hidden'} ·{' '}
              </>
            ) : null}
            <span className={link.expiresAt ? 'text-semantic-warning' : undefined}>
              {expiryClause(link.expiresAt)}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-neutral-text-secondary">
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
            <button
              type="button"
              onClick={onCopyReference}
              className={BTN}
              title="Copy this link's reference ID (the full link was only shown at creation)"
            >
              Copy ID
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
  // ADR-0135 resolves this server-side (project override ?? program ?? workspace); the
  // client reads the effective value and never the raw nullable overrides. Gated on an
  // explicit `=== false` so the form is never blocked while the project is still
  // loading — a real Admin must not see a spurious "sharing is off" on every open.
  const { data: project } = useProject(projectId);
  const sharingBlocked = project?.effective_public_sharing === false;
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
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
  // Defaults ON, unlike assignees (#2532, #1486 handoff): milestones are the headline
  // an external audience wants, so this reveal is an opt-OUT for the narrower case
  // where committed dates must stay internal.
  const [showMilestoneDates, setShowMilestoneDates] = useState(true);
  const [expiry, setExpiry] = useState<ExpiryChoice>('30d');
  const [customDate, setCustomDate] = useState('');
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const create = useCreateShareLink(projectId);

  // Once the token is revealed, Escape / backdrop must NOT discard it before the
  // user has copied it — they click Done instead (the #283 copy-guard pattern).
  //
  // The three states (create → manage → reveal) swap the dialog's focusable
  // content while the trap stays active; without a focusKey the previously
  // focused control unmounts on a phase change and focus drops to <body>, letting
  // Tab escape the modal (rule 245a). Passing the phase re-seats focus on each swap.
  const phase = created ? 'reveal' : mode === 'manage' && links.length > 0 ? 'manage' : 'create';
  const trapRef = useFocusTrap<HTMLDivElement>(true, created ? undefined : onClose, phase);
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
        // A board link has no milestone lane; always send the server default for it
        // so the stored flag can never read as a deliberate opt-out on a board row.
        showMilestoneDates: kind === 'schedule' ? showMilestoneDates : true,
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
          <RevealPanel
            created={created}
            shareUrl={shareUrl}
            revealRef={revealRef}
            formatInstantDate={formatInstantDate}
            onCopy={onCopy}
            onClose={onClose}
          />
        ) : mode === 'manage' && links.length > 0 ? (
          <ManagePanel
            links={links}
            noun={noun}
            projectId={projectId}
            onNewLink={() => setMode('create')}
            onClose={onClose}
          />
        ) : (
          <CreateForm
            noun={noun}
            allowKindChoice={allowKindChoice}
            kind={kind}
            setKind={setKind}
            label={label}
            setLabel={setLabel}
            expiry={expiry}
            setExpiry={setExpiry}
            customDate={customDate}
            setCustomDate={setCustomDate}
            showAssignees={showAssignees}
            setShowAssignees={setShowAssignees}
            showMilestoneDates={showMilestoneDates}
            setShowMilestoneDates={setShowMilestoneDates}
            detail={detail}
            isPending={create.isPending}
            onSubmit={onSubmit}
            onCancel={() => (links.length > 0 ? setMode('manage') : onClose())}
            sharingBlocked={sharingBlocked}
            sharingNotice={
              sharingBlocked ? (
                <SharingDisabledNotice
                  projectId={projectId}
                  isWorkspaceAdmin={isWorkspaceAdmin}
                  onNavigate={onClose}
                />
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}
