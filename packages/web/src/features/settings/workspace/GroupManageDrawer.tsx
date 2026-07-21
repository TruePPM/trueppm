/**
 * GroupManageDrawer — manage one workspace group's members and project access
 * (#2253, ADR-0548).
 *
 * The workspace Groups page (WorkspaceGroupsPage) can create/delete groups but
 * had no way to populate them, so every group was stuck at "0 members / Access
 * to 0 projects." This drawer wires the existing backend endpoints (member
 * add/remove, project grant/revoke — each cascading ProjectMembership rows via
 * reconcile_group_access) to a management surface.
 *
 * Surface (web-rules 89/164/185): a right-side NON-modal drawer on desktop
 * (aria-modal="false", no scrim, no focus trap — the group grid stays visible
 * and usable) and a modal bottom sheet on mobile (< md). All mutations are
 * IMMEDIATE, row-level (rule 115) — no dirty/save bar, like WorkspaceMembersPage.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/Toast';
import { EntitySelectCombobox, type EntityOption } from '@/components/EntitySelectCombobox';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useProjects } from '@/hooks/useProjects';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import type { WorkspaceGroup } from '@/api/types';
import { useWorkspaceMembers } from '../hooks/useWorkspaceMembers';
import {
  useAddGroupMember,
  useGrantGroupProject,
  useRemoveGroupMember,
  useRevokeGroupProject,
} from '../hooks/useWorkspaceGroupMutations';

/** Roles a group may confer — every role below Owner (the server rejects Owner). */
const GRANTABLE_ROLES: ReadonlyArray<{ value: number; label: string }> = [
  { value: ROLE_VIEWER, label: 'Viewer' },
  { value: ROLE_MEMBER, label: 'Team Member' },
  { value: ROLE_SCHEDULER, label: 'Resource Manager' },
  { value: ROLE_ADMIN, label: 'Project Manager' },
];

interface Props {
  /** The group being managed, or null when the drawer is closed. */
  group: WorkspaceGroup | null;
  onClose: () => void;
}

/** Small identity avatar for a member row (rule 6 — decorative, name is the label). */
function MemberAvatar({ initials, color }: { initials: string; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ background: color }}
    >
      {initials}
    </span>
  );
}

function GroupMembersSection({ group }: { group: WorkspaceGroup }) {
  const { members: workspaceMembers, isLoading } = useWorkspaceMembers();
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();

  // Only members not already in the group are addable.
  const memberIds = useMemo(() => new Set(group.members.map((m) => m.id)), [group.members]);
  const addable: EntityOption[] = useMemo(
    () =>
      workspaceMembers
        .filter((m) => !memberIds.has(m.id))
        .map((m) => ({
          id: m.id,
          primaryText: m.name,
          secondaryText: m.email,
          initials: m.initials,
        })),
    [workspaceMembers, memberIds],
  );

  function handleAdd(userId: string | null) {
    if (!userId) return;
    addMember.mutate(
      { groupId: group.id, userId },
      {
        onSuccess: () => toast.success('Member added'),
        onError: () => toast.error('Could not add the member. Try again.'),
      },
    );
  }

  function handleRemove(userId: string, name: string) {
    removeMember.mutate(
      { groupId: group.id, userId },
      {
        onSuccess: () => toast.success(`Removed ${name}`),
        onError: () => toast.error('Could not remove the member. Try again.'),
      },
    );
  }

  return (
    <section aria-label="Group members" className="px-4 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-text-secondary">
        Members
        <span className="ml-1.5 tppm-mono font-normal text-neutral-text-secondary">
          {group.members.length}
        </span>
      </h3>

      {group.members.length === 0 ? (
        <p className="text-[13px] text-neutral-text-secondary">
          No members yet. Add someone below to grant them this group&rsquo;s project access.
        </p>
      ) : (
        <ul className="space-y-1">
          {group.members.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-2.5 rounded-control px-1 py-1 text-[13px]"
            >
              <MemberAvatar initials={m.initials} color={m.color} />
              <span className="flex-1 truncate text-neutral-text-primary">{m.name}</span>
              <button
                type="button"
                onClick={() => handleRemove(m.id, m.name)}
                disabled={removeMember.isPending}
                aria-label={`Remove ${m.name} from ${group.name}`}
                className="shrink-0 rounded-control px-1.5 py-0.5 text-[12px] font-medium text-semantic-critical hover:underline focus:outline-none focus:ring-2 focus:ring-semantic-critical focus:ring-offset-1 disabled:cursor-not-allowed disabled:text-neutral-text-secondary"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5">
        <EntitySelectCombobox
          value={null}
          options={addable}
          onChange={handleAdd}
          label="member"
          nullable={false}
          isLoading={isLoading}
          unassignLabel="Add a member…"
          triggerLabel={{ set: 'Add', unset: 'Add' }}
        />
      </div>
    </section>
  );
}

function GroupProjectAccessSection({ group }: { group: WorkspaceGroup }) {
  const { data: projects = [], isLoading } = useProjects();
  const grant = useGrantGroupProject();
  const revoke = useRevokeGroupProject();

  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<number>(ROLE_MEMBER);

  const linkedIds = useMemo(() => new Set(group.projects.map((p) => p.id)), [group.projects]);
  const grantable: EntityOption[] = useMemo(
    () =>
      projects
        .filter((p) => !linkedIds.has(p.id))
        .map((p) => ({
          id: p.id,
          primaryText: p.name,
          initials: p.name.slice(0, 2).toUpperCase(),
        })),
    [projects, linkedIds],
  );

  function handleGrant() {
    if (!pendingProjectId) return;
    grant.mutate(
      { groupId: group.id, projectId: pendingProjectId, role: pendingRole },
      {
        onSuccess: () => {
          toast.success('Project access granted');
          setPendingProjectId(null);
          setPendingRole(ROLE_MEMBER);
        },
        onError: () => toast.error('Could not grant access. Try again.'),
      },
    );
  }

  function handleRevoke(projectId: string, name: string) {
    revoke.mutate(
      { groupId: group.id, projectId },
      {
        onSuccess: () => toast.success(`Revoked access to ${name}`),
        onError: () => toast.error('Could not revoke access. Try again.'),
      },
    );
  }

  return (
    <section aria-label="Project access" className="border-t border-neutral-border px-4 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-text-secondary">
        Project access
        <span className="ml-1.5 tppm-mono font-normal text-neutral-text-secondary">
          {group.projects.length}
        </span>
      </h3>

      {group.projects.length === 0 ? (
        <p className="text-[13px] text-neutral-text-secondary">
          Not linked to any project yet. Grant access below to give every member this group&rsquo;s
          role on that project.
        </p>
      ) : (
        <ul className="space-y-1">
          {group.projects.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2.5 rounded-control px-1 py-1 text-[13px]"
            >
              <span className="flex-1 truncate text-neutral-text-primary">{p.name}</span>
              <span className="shrink-0 rounded-chip bg-neutral-surface-sunken px-2 py-0.5 text-[11px] font-medium text-neutral-text-secondary">
                {p.roleLabel}
              </span>
              <button
                type="button"
                onClick={() => handleRevoke(p.id, p.name)}
                disabled={revoke.isPending}
                aria-label={`Revoke ${group.name} access to ${p.name}`}
                className="shrink-0 rounded-control px-1.5 py-0.5 text-[12px] font-medium text-semantic-critical hover:underline focus:outline-none focus:ring-2 focus:ring-semantic-critical focus:ring-offset-1 disabled:cursor-not-allowed disabled:text-neutral-text-secondary"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <EntitySelectCombobox
          value={pendingProjectId}
          options={grantable}
          onChange={setPendingProjectId}
          label="project"
          nullable={false}
          isLoading={isLoading}
          unassignLabel="Choose a project…"
          triggerLabel={{ set: 'Change', unset: 'Choose' }}
        />
        <label className="sr-only" htmlFor={`grant-role-${group.id}`}>
          Role to confer
        </label>
        <select
          id={`grant-role-${group.id}`}
          value={pendingRole}
          onChange={(e) => setPendingRole(Number(e.target.value))}
          className="h-7 rounded-control border border-neutral-border bg-neutral-surface px-2 text-[12px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          {GRANTABLE_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleGrant}
          disabled={!pendingProjectId || grant.isPending}
          className="h-7 rounded-control bg-brand-primary px-3 text-[12px] font-medium text-neutral-text-inverse hover:bg-brand-primary-dark focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
        >
          Grant
        </button>
      </div>
    </section>
  );
}

/** Shared drawer/sheet body: header + members + project access. */
function GroupManageBody({
  group,
  onClose,
  titleId,
}: {
  group: WorkspaceGroup;
  onClose: () => void;
  titleId: string;
}) {
  return (
    <div>
      <header className="flex items-start gap-3 border-b border-neutral-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-[15px] font-semibold text-neutral-text-primary">
            {group.name}
          </h2>
          {group.description && (
            <p className="mt-0.5 truncate text-[12px] text-neutral-text-secondary">
              {group.description}
            </p>
          )}
          <p className="mt-1 text-[12px] text-neutral-text-secondary">
            Members get their granted role on each linked project.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close group management"
          className="shrink-0 rounded-control px-1.5 text-[16px] leading-none text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <GroupMembersSection group={group} />
      <GroupProjectAccessSection group={group} />
    </div>
  );
}

export function GroupManageDrawer({ group, onClose }: Props) {
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'sm';
  const titleId = 'group-manage-title';

  // Slide the desktop drawer in from the right on mount (rule 185 — transform,
  // ease-brand). `entered` flips true one frame after mount so the transition runs.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (group && !isMobile) {
      const id = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(id);
    }
    setEntered(false);
    return undefined;
  }, [group, isMobile]);

  // Capture the opener so a desktop (non-modal, no focus trap) close restores
  // focus to it rather than dropping to <body> (WCAG 2.4.3, best-effort).
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (group && !isMobile) {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [group, isMobile]);

  // Escape closes the desktop drawer (the mobile BottomSheet owns its own Escape).
  useEffect(() => {
    if (!group || isMobile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [group, isMobile, onClose]);

  function handleClose() {
    const opener = openerRef.current;
    onClose();
    if (opener && opener.isConnected) opener.focus();
  }

  if (!group) return null;

  if (isMobile) {
    return (
      <BottomSheet isOpen onClose={onClose} titleId={titleId} size="large">
        <GroupManageBody group={group} onClose={onClose} titleId={titleId} />
      </BottomSheet>
    );
  }

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={`fixed inset-y-0 right-0 z-40 w-full max-w-[480px] overflow-y-auto border-l border-neutral-border bg-neutral-surface shadow-pop motion-safe:transition-transform motion-safe:duration-slow motion-safe:ease-brand ${
        entered ? 'translate-x-0' : 'translate-x-full motion-reduce:translate-x-0'
      }`}
    >
      <GroupManageBody group={group} onClose={handleClose} titleId={titleId} />
    </aside>
  );
}
