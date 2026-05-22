import { useId, useMemo, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { StubPageBanner } from '../components/StubPageBanner';
import { useWorkspaceMembers, type WorkspaceMember } from '../hooks/useWorkspaceMembers';
import { filterMembers } from './filterMembers';

const ROLE_PALETTE: Record<string, { bg: string; text: string }> = {
  Admin:  { bg: 'bg-[#7C3AED]/10', text: 'text-[#7C3AED]' },
  PM:     { bg: 'bg-brand-primary-light', text: 'text-brand-primary' },
  Lead:   { bg: 'bg-brand-accent-light',  text: 'text-brand-accent-dark' },
  Member: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Viewer: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
};

const STATUS_DOT: Record<string, string> = {
  active:      'bg-semantic-on-track',
  guest:       'bg-semantic-warning',
  deactivated: 'bg-neutral-text-disabled',
};

function RoleBadge({ role }: { role: string }) {
  const p = ROLE_PALETTE[role] ?? ROLE_PALETTE.Member;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${p.bg} ${p.text}`}>
      {role}
    </span>
  );
}

function Avatar({ initials, color, size = 26 }: { initials: string; color: string; size?: number }) {
  return (
    <span
      className="rounded-full inline-flex items-center justify-center text-white font-semibold shrink-0"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

function MemberTableRow({ m, last }: { m: WorkspaceMember; last: boolean }) {
  return (
    <div
      className={[
        'grid items-center gap-2.5 px-3.5 py-2.5 text-[13px]',
        !last ? 'border-b border-neutral-border/55' : '',
      ].join(' ')}
      style={{ gridTemplateColumns: '32px 1.5fr 100px 1.4fr 60px 110px 100px 72px' }}
    >
      {/* Checkbox */}
      <span
        className="w-3.5 h-3.5 rounded border border-neutral-border inline-block shrink-0"
        aria-hidden="true"
      />
      {/* Name */}
      <span className="flex items-center gap-2.5 min-w-0">
        <Avatar initials={m.initials} color={m.color} />
        <span className="flex flex-col min-w-0">
          <span className="font-medium truncate text-neutral-text-primary flex items-center gap-1.5">
            {m.name}
            {m.status === 'guest' && (
              <span className="text-[10px] px-1 py-px rounded bg-brand-accent-light text-brand-accent-dark font-semibold">
                GUEST
              </span>
            )}
          </span>
          <span className="text-[11px] text-neutral-text-secondary truncate">{m.email}</span>
        </span>
      </span>
      {/* Role */}
      <span><RoleBadge role={m.role} /></span>
      {/* Groups */}
      <span className="flex flex-wrap gap-1">
        {m.groups.slice(0, 2).map((g) => (
          <span key={g} className="text-[10px] px-1.5 py-px rounded border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary font-medium">
            {g}
          </span>
        ))}
        {m.groups.length > 2 && (
          <span className="text-[10px] text-neutral-text-disabled">+{m.groups.length - 2}</span>
        )}
      </span>
      {/* Projects */}
      <span className="tppm-mono text-[12px] text-neutral-text-secondary">{m.projectCount}</span>
      {/* Last active */}
      <span className="text-[12px] text-neutral-text-secondary">{m.lastActive}</span>
      {/* Status */}
      <span className="flex items-center gap-1.5">
        <span
          className={`w-[7px] h-[7px] rounded-full shrink-0 ${STATUS_DOT[m.status] ?? 'bg-neutral-text-disabled'}`}
          aria-hidden="true"
        />
        <span className="text-[11px] text-neutral-text-secondary capitalize">{m.status}</span>
      </span>
      {/* Badges */}
      <span className="flex items-center gap-1 justify-end">
        {m.sso  && <span className="text-[9px] px-1 py-px rounded bg-neutral-surface-sunken text-neutral-text-secondary font-bold">SSO</span>}
        {m.twoFa && <span className="text-[9px] px-1 py-px rounded bg-semantic-on-track-bg text-semantic-on-track font-bold">2FA</span>}
      </span>
    </div>
  );
}

const ROLE_OPTIONS = ['Admin', 'PM', 'Lead', 'Member', 'Viewer'] as const;

/** Workspace > Members management page. */
export function WorkspaceMembersPage() {
  const { members, pendingInvites, isLoading } = useWorkspaceMembers();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const searchInputId = useId();
  const roleSelectId = useId();

  // Client-side filter against the hook's data. When #518 swaps the hook to
  // the real API, this same call site keeps working — the filter is a pure
  // function over WorkspaceMember[].
  const visibleMembers = useMemo(
    () => filterMembers(members, { query, role: roleFilter }),
    [members, query, roleFilter],
  );
  const hasFilter = query.trim() !== '' || roleFilter !== null;

  if (isLoading) {
    return (
      <div className="px-6 py-8 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded bg-neutral-surface-raised animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <StubPageBanner pageIssue={518} />
      <SettingsPageTitle
        title="Members"
        count={`${members.length} members · ${pendingInvites.length} pending`}
        subtitle="People with access to this workspace. Workspace role is the highest a member can act with anywhere."
        action={
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Export CSV
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              + Invite members
            </button>
          </div>
        }
      />

      {/* Search + filters */}
      <div className="px-6 py-3 flex items-center gap-2 border-b border-neutral-border/55 flex-wrap">
        <label htmlFor={searchInputId} className="sr-only">
          Search members by name or email
        </label>
        <div className="flex items-center gap-2 h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] w-[280px] focus-within:ring-2 focus-within:ring-brand-primary focus-within:border-brand-primary">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-neutral-text-disabled shrink-0">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            id={searchInputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="flex-1 bg-transparent outline-none text-[13px] text-neutral-text-primary placeholder:text-neutral-text-disabled min-w-0"
          />
        </div>
        <label htmlFor={roleSelectId} className="sr-only">
          Filter by role
        </label>
        <select
          id={roleSelectId}
          value={roleFilter ?? ''}
          onChange={(e) => setRoleFilter(e.target.value === '' ? null : e.target.value)}
          className="h-7 pl-2.5 pr-7 rounded border border-neutral-border text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary bg-neutral-surface-raised appearance-none bg-no-repeat bg-[right_0.45rem_center]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
          }}
        >
          <option value="">All roles</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
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
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-brand-accent-light border border-brand-accent text-[13px]">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="text-brand-accent-dark shrink-0">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
            <span className="font-medium text-neutral-text-primary">{pendingInvites.length} pending invites</span>
            <div className="flex-1" />
            <span className="text-[12px] text-brand-accent-dark font-semibold">Resend all →</span>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="px-6 py-4">
        <div className="rounded-lg border border-neutral-border overflow-hidden">
          {/* Header */}
          <div
            className="grid gap-2.5 px-3.5 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: '32px 1.5fr 100px 1.4fr 60px 110px 100px 72px' }}
          >
            <span
              className="w-3.5 h-3.5 rounded border border-neutral-border inline-block"
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
              />
            ))
          )}

          {/* Pending invites section */}
          {pendingInvites.length > 0 && (
            <>
              <div className="px-3.5 py-2 bg-neutral-surface-sunken border-t border-neutral-border text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary border-b border-neutral-border/55">
                Pending invites · {pendingInvites.length}
              </div>
              {pendingInvites.map((p, i) => (
                <div
                  key={p.email}
                  className={[
                    'grid items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-neutral-text-secondary',
                    i < pendingInvites.length - 1 ? 'border-b border-neutral-border/55' : '',
                  ].join(' ')}
                  style={{ gridTemplateColumns: '32px 1.5fr 100px 1.4fr 60px 110px 100px 72px' }}
                >
                  <span />
                  <span className="flex items-center gap-2.5">
                    <span
                      className="w-[26px] h-[26px] rounded-full border border-dashed border-neutral-border inline-flex items-center justify-center text-neutral-text-disabled shrink-0"
                      aria-hidden="true"
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
                      </svg>
                    </span>
                    <span className="truncate">{p.email}</span>
                  </span>
                  <span><RoleBadge role={p.role} /></span>
                  <span /><span />
                  <span className="text-[11px]">Sent {p.sentAt}</span>
                  <span className="text-[11px]">by {p.sentBy}</span>
                  <span className="flex justify-end">
                    <button type="button" className="text-[11px] text-brand-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded">
                      Resend
                    </button>
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
