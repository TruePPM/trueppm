import { Button } from '@/components/Button';
import { type CSSProperties, type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceMembers, type WorkspaceMember } from '../hooks/useWorkspaceMembers';
import {
  useUpdateWorkspaceMember,
  useRemoveWorkspaceMember,
} from '../hooks/useUpdateWorkspaceMember';
import {
  useCreateInvite,
  useRevokeInvite,
  useResendInvite,
  useResendAllInvites,
} from '../hooks/useWorkspaceInvites';
import { toast } from '@/components/Toast';
import { FieldHelp } from '@/components/FieldHelp';
import { IDENTITY_VIOLET, tintedChipStyle } from '@/lib/identityColors';
import { filterMembers } from './filterMembers';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { CheckIcon, CloseIcon } from '@/components/Icons';
import { escapeField } from '@/utils/exportCsv';
import { useDownloadAnnouncer } from '@/hooks/useDownloadAnnouncer';

/** Shared by the header, member rows and pending-invite rows so the columns line up. */
const MEMBER_GRID_COLUMNS = '32px 1.5fr 100px 1.4fr 60px 110px 100px 72px';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

/** The API sends `last_active` as a raw ISO timestamp; render the calendar date instead. */
function formatLastActive(value: string | null, fmtDateLong: (iso: string) => string): string {
  if (!value) return '—';
  if (!ISO_TIMESTAMP.test(value)) return value;
  // An unparseable timestamp must never leak "Invalid Date" into the cell.
  if (Number.isNaN(new Date(value).getTime())) return '—';
  return fmtDateLong(value);
}

const ROLE_PALETTE: Record<string, { bg: string; text: string; style?: CSSProperties }> = {
  // Admin is a distinct identity hue, not a status — the single-sourced violet
  // is applied via inline style (see lib/identityColors) rather than a raw
  // bg-[hex] arbitrary-value class that trips the arbitrary-color gate.
  Admin: { bg: '', text: '', style: tintedChipStyle(IDENTITY_VIOLET) },
  PM: { bg: 'bg-brand-primary-light', text: 'text-brand-primary' },
  // Readable on-tint amber text + rule-86 dark override (#2197).
  Lead: {
    bg: 'bg-brand-accent-light dark:bg-brand-accent/20',
    text: 'text-brand-accent-text dark:text-brand-accent',
  },
  Member: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Viewer: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
};

const STATUS_DOT: Record<string, string> = {
  active: 'bg-semantic-on-track',
  guest: 'bg-semantic-warning',
  deactivated: 'bg-neutral-text-disabled',
};

/**
 * The three grantable workspace roles (`WorkspaceRole`, a distinct enum from the
 * project/program `Role` in `@/lib/roles` — do not reach for `roleLabels.ts`
 * here). Used by the invite role selector and by each member row's role select.
 *
 * `WorkspaceRole`'s own docstring reserves the ADR-0072 100-unit bands for
 * Enterprise (its example is a billing-admin at 250), so `role_value` is NOT
 * closed over these three. A native `<select>` has no "no match" state — it
 * paints the FIRST option — so an unrecognized value would render as "Member"
 * and the next change would commit from that false baseline. See web rule 396;
 * `renderRoleOptions` is what keeps the control honest.
 */
const ROLE_INT_OPTIONS = [
  { label: 'Member', value: 100 },
  { label: 'Admin', value: 300 },
  { label: 'Owner', value: 400 },
];

const GRANTABLE_ROLE_VALUES = new Set(ROLE_INT_OPTIONS.map((o) => o.value));

/**
 * The grantable options, preceded by a `disabled` option naming `value` when it
 * is not one of them. `fallbackLabel` is the server's own `role` string for that
 * member (`WorkspaceRole(role_val).label`), so an Enterprise band role is shown
 * under the name the server gave it rather than as a bare number — and cannot be
 * silently re-granted, because this client does not know what that band means.
 * If even that is missing the label degrades to plain copy, never the raw
 * ordinal, which is an identifier and not user-facing text (web rule 301(c)).
 */
function renderRoleOptions(value: number, fallbackLabel?: string) {
  return (
    <>
      {!GRANTABLE_ROLE_VALUES.has(value) && (
        <option value={value} disabled>
          {fallbackLabel || 'Unknown role'}
        </option>
      )}
      {ROLE_INT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </>
  );
}

function RoleBadge({ role }: { role: string }) {
  const p = ROLE_PALETTE[role] ?? ROLE_PALETTE.Member;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold ${p.bg} ${p.text}`}
      style={p.style}
    >
      {role}
    </span>
  );
}

function Avatar({
  initials,
  color,
  size = 26,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      className="rounded-full inline-flex items-center justify-center text-xs text-white font-semibold shrink-0"
      style={{ width: size, height: size, background: color }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

interface AvailabilityEditorProps {
  m: WorkspaceMember;
  onSave: (
    userId: string,
    values: {
      availabilityPercent: number;
      availabilityEffectiveFrom: string | null;
      availabilityEffectiveTo: string | null;
      availabilityNotes: string;
    },
  ) => Promise<void>;
  onClose: () => void;
}

/**
 * Inline editor for a member's baseline availability (#542). Opens beneath the
 * row rather than in a modal so the member's name stays in view, and returns
 * focus to the trigger on close. Validation mirrors the server (0–100, from <= to)
 * so a bad range is caught before the round trip; the server stays authoritative.
 */
function AvailabilityEditor({ m, onSave, onClose }: AvailabilityEditorProps) {
  const baseId = useId();
  const [percent, setPercent] = useState(String(m.availabilityPercent));
  const [from, setFrom] = useState(m.availabilityEffectiveFrom ?? '');
  const [to, setTo] = useState(m.availabilityEffectiveTo ?? '');
  const [notes, setNotes] = useState(m.availabilityNotes);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const n = Number(percent);
    if (percent.trim() === '' || !Number.isInteger(n) || n < 0 || n > 100) {
      setError('Availability must be a whole number from 0 to 100.');
      return;
    }
    if (from !== '' && to !== '' && from > to) {
      setError('The end date must be on or after the start date.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(m.id, {
        availabilityPercent: n,
        availabilityEffectiveFrom: from === '' ? null : from,
        availabilityEffectiveTo: to === '' ? null : to,
        availabilityNotes: notes,
      });
      onClose();
    } catch {
      setError('Could not save availability. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'h-8 px-2 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary';
  const labelClass = 'text-[11px] font-medium text-neutral-text-secondary';

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      aria-label={`Availability for ${m.name}`}
      noValidate
      className="px-3.5 py-3 bg-neutral-surface-sunken border-b border-neutral-border/55 flex flex-wrap items-end gap-3"
    >
      <div className="flex flex-col gap-0.5">
        <label htmlFor={`${baseId}-pct`} className={labelClass}>
          Availability (%)
        </label>
        <input
          id={`${baseId}-pct`}
          type="number"
          min={0}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          aria-describedby={error ? `${baseId}-err` : undefined}
          className={`${inputClass} w-[88px]`}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={`${baseId}-from`} className={labelClass}>
          Effective from
        </label>
        <input
          id={`${baseId}-from`}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={`${baseId}-to`} className={labelClass}>
          Effective to
        </label>
        <input
          id={`${baseId}-to`}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-0.5 flex-1 min-w-[200px]">
        <label htmlFor={`${baseId}-notes`} className={labelClass}>
          Notes
        </label>
        <input
          id={`${baseId}-notes`}
          type="text"
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 rounded-control border border-neutral-border text-[13px] text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          Cancel
        </button>
      </div>
      {error && (
        <span
          id={`${baseId}-err`}
          role="alert"
          className="w-full text-semantic-critical text-[11px]"
        >
          {error}
        </span>
      )}
    </form>
  );
}

interface MemberTableRowProps {
  m: WorkspaceMember;
  last: boolean;
  onRoleChange: (userId: string, roleValue: number) => void;
  onRemove: (userId: string) => void;
  onAvailabilitySave: AvailabilityEditorProps['onSave'];
  /** True when the most recent mutation for this row failed. */
  hasError?: boolean;
}

function MemberTableRow({
  m,
  last,
  onRoleChange,
  onRemove,
  onAvailabilitySave,
  hasError,
}: MemberTableRowProps) {
  const { fmtDateLong } = useUserDateFormat();
  // Two-step destructive confirm: the ✕ reveals an inline "Remove? · Confirm ·
  // Cancel" control rather than firing the DELETE immediately, so a misclick
  // does not silently strip a member's workspace access.
  const [confirming, setConfirming] = useState(false);
  const [editingAvailability, setEditingAvailability] = useState(false);
  const availabilityTriggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div
        className={[
          'grid items-center gap-2.5 px-3.5 py-2.5 text-[13px]',
          !last ? 'border-b border-neutral-border/55' : '',
        ].join(' ')}
        style={{ gridTemplateColumns: MEMBER_GRID_COLUMNS }}
      >
        {/* Checkbox */}
        <span
          className="w-3.5 h-3.5 rounded-control border border-neutral-border inline-block shrink-0"
          aria-hidden="true"
        />
        {/* Name */}
        <span className="flex items-center gap-2.5 min-w-0">
          <Avatar initials={m.initials} color={m.color} />
          <span className="flex flex-col min-w-0">
            <span className="font-medium truncate text-neutral-text-primary flex items-center gap-1.5">
              {m.name}
              {m.status === 'guest' && (
                <span className="text-[11px] px-1 py-px rounded-chip bg-brand-accent-light dark:bg-brand-accent/20 text-brand-accent-text dark:text-brand-accent font-semibold">
                  GUEST
                </span>
              )}
            </span>
            <span className="text-[11px] text-neutral-text-secondary truncate">{m.email}</span>
          </span>
        </span>
        {/* Role — editable select, plus the availability baseline chip (#542) */}
        <span className="flex flex-col items-start gap-1">
          <select
            aria-label={`Role for ${m.name}`}
            value={m.roleValue}
            onChange={(e) => onRoleChange(m.id, Number(e.target.value))}
            className="h-7 pl-1.5 pr-5 rounded-control border border-neutral-border text-[11px] bg-neutral-surface-raised appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {renderRoleOptions(m.roleValue, m.role)}
          </select>
          {/* Availability baseline (#542) — the denominator the project allocation check compares against */}
          <button
            ref={availabilityTriggerRef}
            type="button"
            onClick={() => setEditingAvailability((v) => !v)}
            aria-expanded={editingAvailability}
            aria-label={`Availability for ${m.name}: ${m.availabilityPercent}%. Edit`}
            className={[
              'tppm-mono text-[12px] px-1.5 py-0.5 rounded-chip border focus:outline-none focus:ring-2 focus:ring-brand-primary',
              m.availabilityPercent < 100
                ? 'border-brand-accent bg-brand-accent-light dark:bg-brand-accent/20 text-brand-accent-text dark:text-brand-accent font-semibold'
                : 'border-neutral-border/55 text-neutral-text-secondary',
            ].join(' ')}
          >
            {m.availabilityPercent}%
          </button>
        </span>
        {/* Groups */}
        <span className="flex flex-wrap gap-1">
          {m.groups.slice(0, 2).map((g) => (
            <span
              key={g}
              className="text-[11px] px-1.5 py-px rounded-chip border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary font-medium"
            >
              {g}
            </span>
          ))}
          {m.groups.length > 2 && (
            <span className="text-[11px] text-neutral-text-disabled">+{m.groups.length - 2}</span>
          )}
        </span>
        {/* Projects */}
        <span className="tppm-mono text-[12px] text-neutral-text-secondary">
          <span aria-hidden="true">{m.projectCount}</span>
          <span className="sr-only">
            {m.projectCount} {m.projectCount === 1 ? 'project' : 'projects'}
          </span>
        </span>
        {/* Last active */}
        <span className="text-[12px] text-neutral-text-secondary">
          {formatLastActive(m.lastActive, fmtDateLong)}
        </span>
        {/* Status */}
        <span className="flex items-center gap-1.5">
          <span
            className={`w-[7px] h-[7px] rounded-full shrink-0 ${STATUS_DOT[m.status] ?? 'bg-neutral-text-disabled'}`}
            aria-hidden="true"
          />
          <span className="text-[11px] text-neutral-text-secondary capitalize">{m.status}</span>
        </span>
        {/* Actions + badges */}
        <span className="flex flex-col items-end gap-0.5">
          <span className="flex items-center gap-1 justify-end">
            {m.sso && (
              <span className="text-[11px] px-1 py-px rounded-chip bg-neutral-surface-sunken text-neutral-text-secondary font-bold">
                SSO
              </span>
            )}
            {m.twoFa && (
              <span className="text-[11px] px-1 py-px rounded-chip bg-semantic-on-track-bg text-semantic-on-track font-bold">
                2FA
              </span>
            )}
            {confirming ? (
              <span
                className="flex items-center gap-1.5 text-[11px]"
                role="group"
                aria-label={`Confirm remove ${m.name}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    onRemove(m.id);
                  }}
                  className="text-semantic-critical font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded-control"
                >
                  Confirm
                </button>
                <span className="text-neutral-text-disabled" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label={`Remove ${m.name}`}
                aria-expanded={confirming}
                className="ml-1 text-[10px] text-neutral-text-disabled hover:text-semantic-critical focus:outline-none focus:ring-2 focus:ring-semantic-critical rounded-control"
              >
                <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </span>
          {hasError && (
            <span role="alert" className="text-semantic-critical text-[11px]">
              Action failed. Try again.
            </span>
          )}
        </span>
      </div>
      {editingAvailability && (
        <AvailabilityEditor
          m={m}
          onSave={onAvailabilitySave}
          onClose={() => {
            setEditingAvailability(false);
            availabilityTriggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

const ROLE_OPTIONS = ['Admin', 'PM', 'Lead', 'Member', 'Viewer'] as const;

/**
 * Serialize the visible member columns (name, email, role, status, groups) to
 * CSV. Exported for unit testing — pure and deterministic for a given member
 * list. Groups collapse to a single semicolon-joined cell so the row stays
 * one CSV record regardless of group count.
 *
 * Cells go through the shared `escapeField`, which neutralizes a leading
 * formula-trigger character as well as applying RFC 4180 quoting. This page
 * previously carried its own `csvCell` doing quoting only, so a member whose
 * display name began `=`/`+`/`-`/`@` executed as a formula when an admin opened
 * the export in Excel, and an interior lone `\r` split the record (#2892). The
 * guard is deliberately *not* reimplemented here — a second, subtly different
 * copy of an injection guard is how this class survived #2762.
 */
export function buildMembersCsv(members: WorkspaceMember[]): string {
  const header = ['Name', 'Email', 'Role', 'Status', 'Groups'].map(escapeField).join(',');
  const rows = members.map((m) =>
    [m.name, m.email, m.role, m.status, m.groups.join('; ')].map(escapeField).join(','),
  );
  return [header, ...rows].join('\n');
}

/** Workspace > Members management page. */
export function WorkspaceMembersPage() {
  const { members, pendingInvites, isLoading } = useWorkspaceMembers();
  // Rule 297: a download is the one action producing no in-page change, so the
  // announcement rides with the helper rather than being a caller's obligation.
  const { download: downloadMembersCsv, region: downloadRegion } = useDownloadAnnouncer();
  const updateMember = useUpdateWorkspaceMember();
  const removeMember = useRemoveWorkspaceMember();
  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const resendInvite = useResendInvite();
  const resendAll = useResendAllInvites();

  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState(100);
  // The member id whose most recent role-change / removal mutation failed.
  // Tracked per-row (rather than via the shared mutation error) so the inline
  // alert renders next to the control the user actually touched.
  const [errorMemberId, setErrorMemberId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState(false);
  // The pending-invite id whose most recent revoke failed.
  const [errorInviteId, setErrorInviteId] = useState<string | null>(null);
  // Invite ids re-queued this session — drives the transient "Sent ✓" row cue
  // (the 202 is fire-and-forget, so this is the only success signal the admin gets).
  const [resentInviteIds, setResentInviteIds] = useState<Set<string>>(() => new Set());

  const searchInputId = useId();
  const roleSelectId = useId();
  const inviteEmailId = useId();
  const inviteRoleId = useId();

  const visibleMembers = useMemo(
    () => filterMembers(members, { query, role: roleFilter }),
    [members, query, roleFilter],
  );
  const hasFilter = query.trim() !== '' || roleFilter !== null;

  function handleRoleChange(userId: string, roleValue: number) {
    updateMember.mutateAsync({ userId, role: roleValue }).then(
      () => setErrorMemberId((prev) => (prev === userId ? null : prev)),
      () => setErrorMemberId(userId),
    );
  }

  async function handleAvailabilitySave(
    userId: string,
    values: Parameters<typeof updateMember.mutateAsync>[0] extends infer P
      ? Omit<NonNullable<P>, 'userId'>
      : never,
  ) {
    await updateMember.mutateAsync({ userId, ...values });
  }

  function handleRemove(userId: string) {
    removeMember.mutateAsync(userId).then(
      () => setErrorMemberId((prev) => (prev === userId ? null : prev)),
      () => setErrorMemberId(userId),
    );
  }

  function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteError(false);
    createInvite.mutateAsync({ email: inviteEmail.trim(), role: inviteRole }).then(
      () => {
        setInviteEmail('');
        setInviteRole(100);
      },
      () => setInviteError(true),
    );
  }

  function handleRevoke(inviteId: string) {
    revokeInvite.mutateAsync(inviteId).then(
      () => setErrorInviteId((prev) => (prev === inviteId ? null : prev)),
      () => setErrorInviteId(inviteId),
    );
  }

  function markResent(inviteId: string) {
    setErrorInviteId((prev) => (prev === inviteId ? null : prev));
    setResentInviteIds((prev) => new Set(prev).add(inviteId));
  }

  function handleResend(inviteId: string, email: string) {
    resendInvite.mutateAsync(inviteId).then(
      () => {
        markResent(inviteId);
        toast.success(`Invite re-sent to ${email}.`);
      },
      (err) => {
        setErrorInviteId(inviteId);
        const response = (err as { response?: { status?: number; data?: { detail?: unknown } } })
          ?.response;
        const status = response?.status;
        const detail = response?.data?.detail;
        if (status === 429) toast.error('Too many resends — wait a minute and try again.');
        else if (status === 409)
          toast.error(
            typeof detail === 'string' && detail ? detail : 'This invite can no longer be resent.',
          );
        else toast.error('Could not resend the invite. Please try again.');
      },
    );
  }

  function handleResendAll() {
    resendAll.mutateAsync().then(
      (count) => {
        setResentInviteIds(new Set(pendingInvites.map((p) => p.id)));
        toast.success(
          count > 0
            ? `Re-sent ${count} invite${count === 1 ? '' : 's'}.`
            : 'All pending invites are already sending.',
        );
      },
      (err) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 429) toast.error('Too many resends — wait a minute and try again.');
        else toast.error('Could not resend invites. Please try again.');
      },
    );
  }

  if (isLoading) {
    return (
      <div className="px-6 py-8 space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Members"
        count={`${members.length} members · ${pendingInvites.length} pending`}
        subtitle="People with access to this workspace. Workspace role is the highest a member can act with anywhere."
        action={
          <div className="flex gap-2">
            {/* Client-side CSV of the currently-visible member rows (name, email,
              role, status, groups) — mirrors what the table shows under the
              active search/role filter, so the export tracks the view. */}
            <button
              type="button"
              onClick={() =>
                downloadMembersCsv(
                  buildMembersCsv(visibleMembers),
                  'trueppm-workspace-members.csv',
                  `${visibleMembers.length} members downloaded as CSV.`,
                )
              }
              disabled={visibleMembers.length === 0}
              title={
                visibleMembers.length === 0
                  ? 'No members to export'
                  : 'Download the visible members as a CSV file'
              }
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              Export CSV
            </button>
            {downloadRegion}
          </div>
        }
      />

      {/* Invite form */}
      <form
        onSubmit={handleInvite}
        className="px-6 py-3 flex items-end gap-2 border-b border-neutral-border/55 flex-wrap"
      >
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor={inviteEmailId}
            className="text-[11px] font-medium text-neutral-text-secondary"
          >
            Email
          </label>
          <input
            id={inviteEmailId}
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@example.com"
            className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary w-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary placeholder:text-neutral-text-secondary"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          {/* Section-level FieldHelp (web-rule 263): the workspace-role vocabulary
              is policy jargon, so one ⓘ on the invite Role select explains every
              value — it applies equally to the per-row Role selects below (#2266). */}
          <div className="flex items-center gap-1.5">
            <label
              htmlFor={inviteRoleId}
              className="text-[11px] font-medium text-neutral-text-secondary"
            >
              Role
            </label>
            <FieldHelp
              label="Workspace role"
              intro="The workspace role is the highest level a member can act with anywhere. Change it per person in the table below."
              options={[
                {
                  label: 'Member',
                  desc: 'Standard access. Works within the projects they are added to; cannot manage the workspace.',
                },
                {
                  label: 'Admin',
                  desc: 'Manages workspace members, groups, and settings on top of Member access.',
                },
                {
                  label: 'Owner',
                  desc: 'Full control of the workspace, including ownership transfer. The highest workspace role.',
                },
              ]}
              docHref="administration/rbac"
            />
          </div>
          <select
            id={inviteRoleId}
            value={inviteRole}
            onChange={(e) => setInviteRole(Number(e.target.value))}
            className="h-8 pl-2.5 pr-7 rounded-control border border-neutral-border text-[13px] bg-neutral-surface-raised appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {/* Not renderRoleOptions: inviteRole is client-owned state seeded
                from this same list, so it is in the set by construction — there
                is no server value to be surprised by (web rule 396). */}
            {ROLE_INT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          disabled={!inviteEmail.trim() || createInvite.isPending}
        >
          {createInvite.isPending ? 'Sending…' : '+ Invite members'}
        </Button>
        {inviteError && (
          <span role="alert" className="text-semantic-critical text-[11px] w-full">
            Could not send the invite. Check the address and try again.
          </span>
        )}
      </form>

      {/* Search + filters */}
      <div className="px-6 py-3 flex items-center gap-2 border-b border-neutral-border/55 flex-wrap">
        <label htmlFor={searchInputId} className="sr-only">
          Search members by name or email
        </label>
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] w-[280px] focus-within:ring-2 focus-within:ring-brand-primary focus-within:border-brand-primary">
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="text-neutral-text-disabled shrink-0"
          >
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            id={searchInputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="flex-1 bg-transparent outline-none text-[13px] text-neutral-text-primary placeholder:text-neutral-text-secondary min-w-0"
          />
        </div>
        <label htmlFor={roleSelectId} className="sr-only">
          Filter by role
        </label>
        <select
          id={roleSelectId}
          value={roleFilter ?? ''}
          onChange={(e) => setRoleFilter(e.target.value === '' ? null : e.target.value)}
          className="h-7 pl-2.5 pr-7 rounded-control border border-neutral-border text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary bg-neutral-surface-raised appearance-none bg-no-repeat bg-[right_0.45rem_center]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
          }}
        >
          <option value="">All roles</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <span className="text-[11px] text-neutral-text-secondary">
          {hasFilter
            ? `Showing ${visibleMembers.length} of ${members.length}`
            : `Showing all ${members.length}`}
        </span>
      </div>

      {/* Pending invite banner */}
      {pendingInvites.length > 0 && (
        <div className="px-6 pt-3">
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-card bg-brand-accent-light dark:bg-brand-accent/20 border border-brand-accent dark:border-brand-accent/40 text-[13px]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className="text-brand-accent-text dark:text-brand-accent shrink-0"
            >
              <path
                d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            <span className="font-medium text-neutral-text-primary">
              {pendingInvites.length} pending invites
            </span>
            <div className="flex-1" />
            {/* One request re-queues every pending invite (#969) — server bundles it
                into a single throttle bucket, so this cannot email-bomb. */}
            <button
              type="button"
              onClick={handleResendAll}
              disabled={resendAll.isPending}
              className="text-[12px] text-brand-accent-text dark:text-brand-accent font-semibold rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:text-neutral-text-secondary disabled:cursor-not-allowed hover:underline"
            >
              {resendAll.isPending ? 'Resending…' : 'Resend all →'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="px-6 pt-4 pb-8">
        <div className="rounded-card border border-neutral-border overflow-clip">
          {/* Header — sticky so column names stay in view on the long page */}
          <div
            className="sticky top-0 z-10 grid gap-2.5 px-3.5 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: MEMBER_GRID_COLUMNS }}
          >
            <span
              className="w-3.5 h-3.5 rounded-control border border-neutral-border inline-block"
              aria-hidden="true"
            />
            <span>Name</span>
            <span>Role</span>
            <span>Groups</span>
            <span>Projects</span>
            <span>Last active</span>
            <span>Status</span>
            <span />
          </div>

          {/* Rows */}
          {visibleMembers.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-[13px] text-neutral-text-secondary">
              {query.trim() !== ''
                ? `No members match "${query.trim()}"`
                : 'No members match the selected filters'}
            </div>
          ) : (
            visibleMembers.map((m, i) => (
              <MemberTableRow
                key={m.id}
                m={m}
                last={i === visibleMembers.length - 1 && pendingInvites.length === 0}
                onRoleChange={handleRoleChange}
                onRemove={handleRemove}
                onAvailabilitySave={handleAvailabilitySave}
                hasError={errorMemberId === m.id}
              />
            ))
          )}

          {/* Pending invites section */}
          {pendingInvites.length > 0 && (
            <>
              <div className="px-3.5 py-2 bg-neutral-surface-sunken border-t border-neutral-border text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary border-b border-neutral-border/55">
                Pending invites · {pendingInvites.length}
              </div>
              {pendingInvites.map((p, i) => (
                <div
                  key={p.email}
                  className={[
                    'grid items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-neutral-text-secondary',
                    i < pendingInvites.length - 1 ? 'border-b border-neutral-border/55' : '',
                  ].join(' ')}
                  style={{ gridTemplateColumns: MEMBER_GRID_COLUMNS }}
                >
                  <span />
                  <span className="flex items-center gap-2.5">
                    <span
                      className="w-[26px] h-[26px] rounded-full border border-dashed border-neutral-border inline-flex items-center justify-center text-neutral-text-disabled shrink-0"
                      aria-hidden="true"
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                        <path
                          d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          fill="none"
                        />
                      </svg>
                    </span>
                    <span className="truncate">{p.email}</span>
                  </span>
                  <span>
                    <RoleBadge role={p.role} />
                  </span>
                  <span />
                  <span />
                  <span className="text-[11px]">Sent {p.sentAt}</span>
                  <span className="text-[11px]">by {p.sentBy}</span>
                  <span className="flex flex-col items-end gap-0.5">
                    <span className="flex items-center justify-end gap-1">
                      {resentInviteIds.has(p.id) ? (
                        // A resend re-issues the token, so any earlier link the
                        // recipient holds stops working — the cue is intentionally
                        // reassuring ("Sent ✓") rather than warning about that.
                        <span
                          className="text-[11px] text-semantic-on-track font-semibold"
                          data-testid="invite-resent-cue"
                        >
                          Sent
                          <CheckIcon
                            className="inline-block h-3 w-3 align-[-0.125em] ml-1"
                            aria-hidden="true"
                          />
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleResend(p.id, p.email)}
                          disabled={resendInvite.isPending}
                          aria-label={`Resend invite to ${p.email}`}
                          className="text-[11px] text-brand-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:no-underline"
                        >
                          Resend
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRevoke(p.id)}
                        aria-label={`Revoke invite for ${p.email}`}
                        className="text-[11px] text-neutral-text-disabled hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded-control"
                      >
                        Revoke
                      </button>
                    </span>
                    {errorInviteId === p.id && (
                      <span role="alert" className="text-semantic-critical text-[11px]">
                        Could not complete. Try again.
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
