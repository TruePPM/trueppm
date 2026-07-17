/**
 * Member picker for the Project lead / Program manager fields on Settings →
 * General (#966). A thin adapter over the pure `EntitySelectCombobox` (web-rule
 * 160): it fetches the scope's member roster and maps rows to options; the
 * primitive owns the interaction. Selection sets the page's `lead` state via
 * `onChange` — it does NOT PATCH (the page's rule-115 save bar commits).
 */

import { useMemo } from 'react';
import { EntitySelectCombobox, type EntityOption } from '@/components/EntitySelectCombobox';
import { ReadOnlyIndicator } from './ReadOnlyIndicator';
import { useProjectMembers } from '@/hooks/useProjectMembers';
import { useProgramMembers } from '@/features/programs/hooks/useProgramMembers';

/** 1–2 char initials from a username (e.g. "anika.krishnan" → "AK"). */
function initialsOf(username: string): string {
  const parts = username.split(/[._\s-]+/).filter(Boolean);
  if (parts.length === 0) return username.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

interface MemberPickerProps {
  scope: 'project' | 'program';
  scopeId: string | undefined;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Listbox accessible name + placeholder noun, e.g. "project lead". */
  label: string;
  canEdit: boolean;
  /**
   * Provenance clause for the read-only branch (below-role users), rendered after
   * "· " by {@link ReadOnlyIndicator}. Defaults to a generic "managed by an admin".
   */
  readOnlyProvenance?: string;
  /**
   * The currently-assigned member's display payload, from the record's
   * `lead_detail`. Merged into the option list so the resting row renders the
   * real name even before the roster query resolves (or if the saved lead is
   * not in the fetched page of members) — without it the picker would briefly
   * read "Unassigned" for an assigned lead.
   */
  selectedDetail?: { id: string; username: string; email?: string } | null;
}

export function MemberPicker({
  scope,
  scopeId,
  value,
  onChange,
  label,
  canEdit,
  readOnlyProvenance = 'managed by an admin',
  selectedDetail,
}: MemberPickerProps) {
  // Both hooks are called unconditionally (rules of hooks); only the active
  // scope passes an id, so the other query stays disabled (`enabled: !!id`).
  const projectQuery = useProjectMembers(scope === 'project' ? scopeId : undefined);
  const programQuery = useProgramMembers(scope === 'program' ? scopeId : undefined);

  const { options, isLoading } = useMemo(() => {
    const roster: EntityOption[] =
      scope === 'project'
        ? projectQuery.members.map((m) => ({
            id: m.id,
            primaryText: m.username,
            initials: initialsOf(m.username),
          }))
        : (programQuery.data ?? []).map((m) => ({
            id: m.user_detail.id,
            primaryText: m.user_detail.username,
            secondaryText: m.user_detail.email,
            initials: initialsOf(m.user_detail.username),
          }));
    // Ensure the saved lead is always present so the resting row resolves it.
    const merged =
      selectedDetail && !roster.some((o) => o.id === selectedDetail.id)
        ? [
            {
              id: selectedDetail.id,
              primaryText: selectedDetail.username,
              secondaryText: selectedDetail.email,
              initials: initialsOf(selectedDetail.username),
            },
            ...roster,
          ]
        : roster;
    return {
      options: merged,
      isLoading: scope === 'project' ? projectQuery.isLoading : programQuery.isLoading,
    };
  }, [
    scope,
    projectQuery.members,
    projectQuery.isLoading,
    programQuery.data,
    programQuery.isLoading,
    selectedDetail,
  ]);

  // Below-role users get the effective value + provenance, never a disabled
  // combobox (ADR-0133, web-rule 175/164).
  if (!canEdit) {
    const selectedLabel =
      options.find((o) => o.id === value)?.primaryText ?? selectedDetail?.username;
    return (
      <ReadOnlyIndicator
        label={label}
        value={selectedLabel ?? 'None'}
        provenance={readOnlyProvenance}
        filled={value != null}
      />
    );
  }

  return (
    <EntitySelectCombobox
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      isLoading={isLoading}
    />
  );
}
