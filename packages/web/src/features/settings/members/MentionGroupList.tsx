import {
  MentionGroupRow,
  type MentionGroupRowData,
  type ProjectMemberOption,
} from './MentionGroupRow';

interface MentionGroupListProps {
  isLoading: boolean;
  isError: boolean;
  groups: MentionGroupRowData[];
  /** Accessible name for the list — scope-specific ("Mention groups" vs
   *  "Program mention groups") so the two sections stay distinguishable to a
   *  screen reader and to `getByRole('list', { name })` in specs. */
  listLabel: string;
  /** Admin+ (project) / Owner (program) — rename, delete, flip email default. */
  canManageGroup: boolean;
  /** Scheduler+ (project) / Admin+ (program) — add/remove members. */
  canManageMembers: boolean;
  memberOptions: ProjectMemberOption[];
  isBusy: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleEmailDefault: (id: string, value: boolean) => void;
  onAddMember: (id: string, user: string) => void;
  onRemoveMember: (id: string, user: string) => void;
  onToggleMute: (id: string, muted: boolean) => void;
}

/**
 * Loading / error / empty / populated rendering for a user-defined @mention
 * group list, shared by the project and program sections.
 *
 * Presentation only: it takes `canManageGroup`/`canManageMembers` as already
 * decided booleans and never derives them. Each section keeps its own RBAC
 * (ADR-0212 §3 for project, ADR-0248 §3 for program) and its own write gating
 * — notably the program's IsProgramNotClosed fold-in (#2549) — so no permission
 * logic moves here.
 */
export function MentionGroupList({
  isLoading,
  isError,
  groups,
  listLabel,
  canManageGroup,
  canManageMembers,
  memberOptions,
  isBusy,
  onRename,
  onDelete,
  onToggleEmailDefault,
  onAddMember,
  onRemoveMember,
  onToggleMute,
}: MentionGroupListProps) {
  if (isLoading) {
    return (
      <div className="space-y-px">
        {Array.from({ length: 2 }, (_, i) => (
          <div
            key={i}
            className="h-12 rounded bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p role="alert" className="text-sm text-semantic-critical py-2">
        Failed to load mention groups — please refresh.
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="text-sm text-neutral-text-disabled py-2">
        No mention groups yet.
        {canManageGroup && ' Create one below.'}
      </p>
    );
  }

  return (
    <ul
      aria-label={listLabel}
      className="rounded border border-neutral-border divide-y divide-neutral-border bg-neutral-surface"
    >
      {groups.map((g) => (
        <MentionGroupRow
          key={g.id}
          group={g}
          canManageGroup={canManageGroup}
          canManageMembers={canManageMembers}
          memberOptions={memberOptions}
          onRename={onRename}
          onDelete={onDelete}
          onToggleEmailDefault={onToggleEmailDefault}
          onAddMember={onAddMember}
          onRemoveMember={onRemoveMember}
          onToggleMute={onToggleMute}
          isBusy={isBusy}
        />
      ))}
    </ul>
  );
}
