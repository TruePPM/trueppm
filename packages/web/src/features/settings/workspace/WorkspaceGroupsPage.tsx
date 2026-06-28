import { type FormEvent, useId, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceGroups, type WorkspaceGroup } from '../hooks/useWorkspaceGroups';
import { useCreateGroup, useDeleteGroup } from '../hooks/useWorkspaceGroupMutations';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { IDENTITY_SWATCHES } from '@/lib/identityColors';

interface GroupCardProps {
  group: WorkspaceGroup;
  onDelete: (id: string) => void;
  /** True when the most recent delete for this group failed. */
  hasError?: boolean;
}

function GroupCard({ group, onDelete, hasError }: GroupCardProps) {
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
            className="ml-1 text-[11px] text-neutral-text-disabled hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded-control shrink-0"
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

      {/* Member stack */}
      <div className="mt-3 flex items-center gap-3">
        <div className="flex">
          {Array.from({ length: Math.min(6, group.memberCount) }).map((_, i) => (
            <span
              key={i}
              className="rounded-full border-2 border-neutral-surface-raised inline-flex items-center justify-center text-white font-semibold"
              style={{
                width: 22,
                height: 22,
                marginLeft: i === 0 ? 0 : -6,
                background: IDENTITY_SWATCHES[i % IDENTITY_SWATCHES.length],
                fontSize: 10,
              }}
              aria-hidden="true"
            />
          ))}
          {group.memberCount > 6 && (
            <span
              className="rounded-full border-2 border-neutral-surface-raised bg-neutral-surface-sunken inline-flex items-center justify-center text-neutral-text-secondary font-bold"
              style={{ width: 22, height: 22, marginLeft: -6, fontSize: 10 }}
              aria-hidden="true"
            >
              +{group.memberCount - 6}
            </span>
          )}
        </div>

        <div className="w-px h-4 bg-neutral-border shrink-0" aria-hidden="true" />

        {group.lead && (
          <span className="text-[11px] text-neutral-text-secondary flex items-center gap-1">
            Lead:{' '}
            <span
              className="w-[18px] h-[18px] rounded-full bg-brand-primary inline-flex items-center justify-center text-white font-bold"
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
            {group.projects[0] === 'all'
              ? 'all projects'
              : `${group.projects.length} project${group.projects.length !== 1 ? 's' : ''}`}
          </strong>
        </span>
      </div>

      {/* Project tags */}
      <div className="mt-2.5 flex flex-wrap gap-1">
        {group.projects.slice(0, 4).map((p) => (
          <span
            key={p}
            className="text-[11px] px-2 py-0.5 rounded-chip border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary"
          >
            {p === 'all' ? 'All projects' : p}
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
        subtitle="Groups bundle members. Use them to grant project access in bulk and to roll up resource capacity."
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
              className="px-3 py-1.5 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              + Create group
            </button>
          </div>
        }
      />

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
                className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary placeholder:text-neutral-text-disabled"
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
                className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary w-[280px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary placeholder:text-neutral-text-disabled"
              />
            </div>
            <button
              type="submit"
              disabled={!newGroupName.trim() || createGroup.isPending}
              className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed"
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

      <div className="px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3.5">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-32 rounded-card bg-neutral-surface-raised border border-neutral-border animate-pulse"
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
                hasError={errorGroupId === g.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
