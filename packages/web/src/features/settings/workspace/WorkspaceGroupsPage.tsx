import { type FormEvent, useId, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceGroups, type WorkspaceGroup } from '../hooks/useWorkspaceGroups';
import { useCreateGroup, useDeleteGroup } from '../hooks/useWorkspaceGroupMutations';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { GroupManageDrawer } from './GroupManageDrawer';
import { FieldHelp } from '@/components/FieldHelp';

// Below this member count the card shows member NAMES (who is in the group);
// at or above it the roster collapses to the overlapping initial stack (an
// identity glance) with an authoritative +N overflow. 4 is the cutover because
// a half-width settings card can seat ~3 name pills before it pushes the
// Lead / "Access to N projects" segment onto a third line.
const MEMBER_NAMES_THRESHOLD = 4;
// Cap of avatars drawn in the overlapping stack before the +N chip takes over.
const MEMBER_STACK_CAP = 5;

/**
 * The group member roster shown on a card.
 *
 * - 0 members → a muted "No members yet" read (the divider is suppressed by the
 *   caller so nothing dangles beside an empty slot).
 * - 1–3 members → name pills: an 18px identity avatar (decorative, rule 6) plus
 *   the member's real name as text — the name is the accessible signal.
 * - 4+ members → the overlapping 22px initial stack, drawn from real member
 *   `initials` + identity `color` (rule 208), capped at {@link MEMBER_STACK_CAP}
 *   with a +N chip. Overflow is computed from the authoritative `memberCount`,
 *   so a server-truncated `members` array still counts correctly. Avatars are
 *   decorative, so the names are reachable via a composite `role="img"` label
 *   (rule 171/172 — `role="img"` because Chromium prunes named groups).
 */
function GroupMemberRoster({ group }: { group: WorkspaceGroup }) {
  if (group.memberCount === 0) {
    return <span className="text-[11px] text-neutral-text-secondary">No members yet</span>;
  }

  if (group.memberCount < MEMBER_NAMES_THRESHOLD) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {group.members.map((m) => (
          <span key={m.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="w-[18px] h-[18px] rounded-full inline-flex items-center justify-center text-white font-semibold shrink-0"
              style={{ background: m.color, fontSize: 10 }}
            >
              {m.initials}
            </span>
            {/* Name is the accessible signal (rule 6); title guards a long name (rule 255). */}
            <span
              className="text-[11px] text-neutral-text-primary truncate max-w-[128px]"
              title={m.name}
            >
              {m.name}
            </span>
          </span>
        ))}
      </div>
    );
  }

  const shown = group.members.slice(0, MEMBER_STACK_CAP);
  const overflow = group.memberCount - shown.length;
  const names = group.members.map((m) => m.name);
  const unnamed = group.memberCount - names.length;
  // Name every member the roster knows; fall back to a bare count only if the
  // server returned no member detail (avoids a "Members:  and N more" grammar).
  const label = names.length
    ? `Members: ${names.join(', ')}${unnamed > 0 ? ` and ${unnamed} more` : ''}`
    : `${group.memberCount} members`;

  return (
    <div className="flex" role="img" aria-label={label}>
      {shown.map((m, i) => (
        <span
          key={m.id}
          aria-hidden="true"
          className="rounded-full border-2 border-neutral-surface-raised inline-flex items-center justify-center text-white font-semibold"
          style={{
            width: 22,
            height: 22,
            marginLeft: i === 0 ? 0 : -6,
            background: m.color,
            fontSize: 10,
          }}
        >
          {m.initials}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="rounded-full border-2 border-neutral-surface-raised bg-neutral-surface-sunken inline-flex items-center justify-center text-neutral-text-secondary font-bold"
          style={{ width: 22, height: 22, marginLeft: -6, fontSize: 10 }}
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

interface GroupCardProps {
  group: WorkspaceGroup;
  onDelete: (id: string) => void;
  /** Opens the management drawer for this group. */
  onManage: (id: string) => void;
  /** True when the most recent delete for this group failed. */
  hasError?: boolean;
}

function GroupCard({ group, onDelete, onManage, hasError }: GroupCardProps) {
  // Deleting a group cascades project-access removal for every member, so the
  // ✕ opens a two-step inline confirm rather than firing the DELETE directly.
  const [confirming, setConfirming] = useState(false);
  const abbrev = group.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3.5">
      <div className="flex items-start gap-2.5">
        {/* Group icon */}
        <span className="w-8 h-8 rounded-chip bg-brand-primary-light text-brand-primary inline-flex items-center justify-center text-[13px] font-bold shrink-0">
          {abbrev}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-neutral-text-primary">{group.name}</div>
          <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">
            {group.description}
          </div>
        </div>
        <span className="tppm-mono text-[11px] px-2 py-0.5 rounded-chip bg-neutral-surface-sunken text-neutral-text-secondary font-semibold shrink-0">
          {group.memberCount} members
        </span>
        <button
          type="button"
          onClick={() => onManage(group.id)}
          aria-label={`Manage ${group.name}`}
          className="shrink-0 rounded-control border border-neutral-border px-2 py-0.5 text-[11px] font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          Manage
        </button>
        {confirming ? (
          <span
            className="flex items-center gap-1.5 text-[11px] shrink-0"
            role="group"
            aria-label={`Confirm delete ${group.name}`}
          >
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete(group.id);
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
            aria-label={`Delete group ${group.name}`}
            aria-expanded={confirming}
            // Enabled control must rest at a readable color, not the 2.70:1
            // disabled token that relies on hover to become legible (#2207).
            className="ml-1 text-[11px] text-neutral-text-secondary hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded-control shrink-0"
          >
            ✕
          </button>
        )}
      </div>
      {hasError && (
        <p role="alert" className="text-semantic-critical text-[11px] mt-1.5">
          Could not delete this group. Try again.
        </p>
      )}

      {/* Member roster — names when few, an identity stack when many (#2295) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <GroupMemberRoster group={group} />

        {/* Suppress the divider for an empty group so nothing dangles (#2295). */}
        {group.memberCount > 0 && (
          <div className="w-px h-4 bg-neutral-border shrink-0" aria-hidden="true" />
        )}

        {group.lead && (
          <span className="text-[11px] text-neutral-text-secondary flex items-center gap-1">
            Lead:{' '}
            <span
              className="w-[18px] h-[18px] rounded-full bg-brand-primary inline-flex items-center justify-center text-neutral-text-inverse font-bold"
              style={{ fontSize: 10 }}
              aria-hidden="true"
            >
              {group.lead}
            </span>
          </span>
        )}

        <div className="flex-1" />
        <span className="text-[11px] text-neutral-text-secondary">
          Access to{' '}
          <strong className="text-neutral-text-primary font-semibold">
            {`${group.projects.length} project${group.projects.length !== 1 ? 's' : ''}`}
          </strong>
        </span>
      </div>

      {/* Project tags */}
      <div className="mt-2.5 flex flex-wrap gap-1">
        {group.projects.slice(0, 4).map((p) => (
          <span
            key={p.id}
            className="text-[11px] px-2 py-0.5 rounded-chip border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary"
          >
            {p.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Workspace > Groups & teams page. */
export function WorkspaceGroupsPage() {
  const { data: groups = [], isLoading } = useWorkspaceGroups();
  const createGroup = useCreateGroup();
  const deleteGroup = useDeleteGroup();

  const nameId = useId();
  const descId = useId();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [createError, setCreateError] = useState(false);
  // The group id whose most recent delete failed.
  const [errorGroupId, setErrorGroupId] = useState<string | null>(null);
  // The group whose management drawer is open, or null when closed.
  const [manageGroupId, setManageGroupId] = useState<string | null>(null);

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setCreateError(false);
    createGroup
      .mutateAsync({
        name: newGroupName.trim(),
        description: newGroupDesc.trim() || undefined,
      })
      .then(
        () => {
          setNewGroupName('');
          setNewGroupDesc('');
          setShowCreateForm(false);
        },
        () => setCreateError(true),
      );
  }

  function handleDelete(id: string) {
    deleteGroup.mutateAsync(id).then(
      () => setErrorGroupId((prev) => (prev === id ? null : prev)),
      () => setErrorGroupId(id),
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Groups & teams"
        count={`${groups.length} groups`}
        subtitle="Groups bundle members to grant project access in bulk and roll up resource capacity. They aren't for @-mentioning — to notify a named audience in comments, use a project's Mention groups."
        action={
          <div className="flex items-center gap-2">
            {/* Directory (LDAP/AD) sync is an Enterprise capability
                (enterprise-check 2026-05-27). Manual group creation stays OSS;
                this button is disabled with the EnterpriseBadge (community-only)
                as the reachable upsell link. */}
            <span className="inline-flex items-center">
              <button
                type="button"
                disabled
                title="Directory sync is available in TruePPM Enterprise"
                className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
              >
                Sync from directory
              </button>
              <EnterpriseBadge />
            </span>
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              className="px-3 py-1.5 rounded-control bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              + Create group
            </button>
          </div>
        }
      />

      {/* Section-level FieldHelp (web-rule 263): one ⓘ explains what groups do
          (bulk project access + capacity rollup) and the groups-vs-mention-groups
          distinction — the surrounding policy jargon, not the self-evident name /
          description inputs (#2266, #2253/#2254). Rendered unconditionally so it
          stays reachable before any group exists. */}
      <div className="px-6 pt-1">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[13px] font-semibold text-neutral-text-primary">
            How groups work
          </h2>
          <FieldHelp
            label="Groups & teams"
            body="Groups bundle members so you can grant project access in bulk and roll up team capacity. Adding a member to a group grants them access to every project the group can reach; deleting a group removes that access from all of its members. Groups are not for @-mentions — to notify a named audience in comments, use a project's Mention groups instead."
            docHref="administration/sharing-and-access"
          />
        </div>
      </div>

      {/* Inline create form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreate}
          className="mx-6 mb-4 p-4 rounded-card border border-brand-primary bg-neutral-surface-raised flex flex-col gap-2"
        >
          <p className="text-[13px] font-semibold text-neutral-text-primary">New group</p>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor={nameId}
                className="text-[11px] font-medium text-neutral-text-secondary"
              >
                Name
              </label>
              <input
                id={nameId}
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Avionics"
                required
                className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary placeholder:text-neutral-text-secondary"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor={descId}
                className="text-[11px] font-medium text-neutral-text-secondary"
              >
                Description
              </label>
              <input
                id={descId}
                type="text"
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Optional"
                className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary w-[280px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary placeholder:text-neutral-text-secondary"
              />
            </div>
            <button
              type="submit"
              disabled={!newGroupName.trim() || createGroup.isPending}
              className="h-8 px-3 rounded-control bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed"
            >
              {createGroup.isPending ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreateForm(false);
                setNewGroupName('');
                setNewGroupDesc('');
                setCreateError(false);
              }}
              className="h-8 px-3 rounded-control border border-neutral-border text-[13px] text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Cancel
            </button>
          </div>
          {createError && (
            <p role="alert" className="text-semantic-critical text-[11px]">
              Could not create the group. Try again.
            </p>
          )}
        </form>
      )}

      <div className="px-6 pt-5 pb-8">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3.5">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-32 rounded-card bg-neutral-surface-raised border border-neutral-border motion-safe:animate-pulse"
              />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-neutral-text-secondary">
            No groups yet. Create one to bundle members and grant bulk project access.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3.5">
            {groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                onDelete={handleDelete}
                onManage={setManageGroupId}
                hasError={errorGroupId === g.id}
              />
            ))}
          </div>
        )}
      </div>

      <GroupManageDrawer
        group={groups.find((g) => g.id === manageGroupId) ?? null}
        onClose={() => setManageGroupId(null)}
      />
    </div>
  );
}
