import { useState } from 'react';
import { Button } from '@/components/Button';
import type { MentionGroupMember } from '../hooks/useMentionGroups';

export interface ProjectMemberOption {
  userId: string;
  username: string;
}

/**
 * The subset of a mention group this row renders. Both the project-scoped
 * `MentionGroup` (ADR-0212) and the program-scoped `ProgramMentionGroup`
 * (ADR-0248, #516) structurally satisfy it, so the row is shared across scopes —
 * it never reads the scope-specific `project` / `program` field.
 */
export interface MentionGroupRowData {
  id: string;
  name: string;
  description: string;
  email_default_on: boolean;
  members: MentionGroupMember[];
  member_count: number;
  muted_by_me: boolean;
}

interface MentionGroupRowProps {
  group: MentionGroupRowData;
  /** Admin+ — rename, delete, flip the email default. */
  canManageGroup: boolean;
  /** Scheduler+ — add/remove members. */
  canManageMembers: boolean;
  /** Project members eligible to be added (not already in the group). */
  memberOptions: ProjectMemberOption[];
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleEmailDefault: (id: string, value: boolean) => void;
  onAddMember: (id: string, user: string) => void;
  onRemoveMember: (id: string, user: string) => void;
  onToggleMute: (id: string, muted: boolean) => void;
  isBusy: boolean;
}

export function MentionGroupRow({
  group,
  canManageGroup,
  canManageMembers,
  memberOptions,
  onRename,
  onDelete,
  onToggleEmailDefault,
  onAddMember,
  onRemoveMember,
  onToggleMute,
  isBusy,
}: MentionGroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addSelection, setAddSelection] = useState('');

  const available = memberOptions.filter(
    (o) => !group.members.some((m) => m.id === o.userId),
  );

  function submitRename() {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(group.id, trimmed);
    }
    setRenaming(false);
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-2">
              <label htmlFor={`rename-${group.id}`} className="sr-only">
                Rename group
              </label>
              <input
                id={`rename-${group.id}`}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="h-8 flex-1 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <Button size="sm" onClick={submitRename} disabled={isBusy}>
                Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setRenaming(false);
                  setNameDraft(group.name);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-neutral-text-primary truncate">
                <span className="tppm-mono text-brand-primary">@{group.name}</span>
                <span className="ml-2 tppm-mono text-xs font-normal text-neutral-text-secondary">
                  {group.member_count}
                </span>
              </p>
              {group.description && (
                <p className="text-xs text-neutral-text-secondary truncate">
                  {group.description}
                </p>
              )}
            </>
          )}
        </div>

        {/* Mute toggle — any member, own subscription */}
        {!renaming && (
          <button
            type="button"
            onClick={() => onToggleMute(group.id, !group.muted_by_me)}
            aria-pressed={group.muted_by_me}
            className="shrink-0 rounded border border-neutral-border px-2 py-1 text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {group.muted_by_me ? 'Muted' : 'Mute'}
          </button>
        )}

        {!renaming && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Manage'} @${group.name}`}
            className="shrink-0 rounded border border-neutral-border px-2 py-1 text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {expanded ? 'Close' : 'Manage'}
          </button>
        )}
      </div>

      {expanded && !renaming && (
        <div className="mt-3 space-y-3 rounded border border-neutral-border bg-neutral-surface-raised p-3">
          {/* Members */}
          <div>
            <p className="mb-1 text-xs font-semibold text-neutral-text-secondary">Members</p>
            {group.members.length === 0 ? (
              <p className="text-xs text-neutral-text-disabled">No members yet.</p>
            ) : (
              <ul className="space-y-1">
                {group.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-text-primary">{m.username}</span>
                    {canManageMembers && (
                      <button
                        type="button"
                        onClick={() => onRemoveMember(group.id, m.id)}
                        disabled={isBusy}
                        aria-label={`Remove ${m.username} from @${group.name}`}
                        className="text-xs font-medium text-semantic-critical hover:text-semantic-critical/80 disabled:cursor-not-allowed disabled:text-neutral-text-disabled"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add member — Scheduler+ */}
          {canManageMembers && available.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor={`add-${group.id}`} className="sr-only">
                Add member to @{group.name}
              </label>
              <select
                id={`add-${group.id}`}
                value={addSelection}
                onChange={(e) => setAddSelection(e.target.value)}
                className="h-8 flex-1 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                <option value="">Add a member…</option>
                {available.map((o) => (
                  <option key={o.userId} value={o.userId}>
                    {o.username}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!addSelection || isBusy}
                onClick={() => {
                  if (addSelection) {
                    onAddMember(group.id, addSelection);
                    setAddSelection('');
                  }
                }}
              >
                Add
              </Button>
            </div>
          )}

          {/* Group management — Admin+ */}
          {canManageGroup && (
            <div className="flex flex-wrap items-center gap-3 border-t border-neutral-border pt-3">
              <label className="flex items-center gap-2 text-xs text-neutral-text-secondary">
                <input
                  type="checkbox"
                  checked={group.email_default_on}
                  onChange={(e) => onToggleEmailDefault(group.id, e.target.checked)}
                  disabled={isBusy}
                  className="h-4 w-4 rounded border-neutral-border text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary"
                />
                Email members by default
              </label>
              <button
                type="button"
                onClick={() => {
                  setNameDraft(group.name);
                  setRenaming(true);
                }}
                className="text-xs font-medium text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
              >
                Rename
              </button>
              {confirmDelete ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-neutral-text-secondary">Delete group?</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(group.id);
                      setConfirmDelete(false);
                    }}
                    disabled={isBusy}
                    className="font-medium text-semantic-critical hover:text-semantic-critical/80"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="text-neutral-text-secondary hover:text-neutral-text-primary"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label={`Delete @${group.name}`}
                  className="text-xs font-medium text-semantic-critical hover:text-semantic-critical/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
