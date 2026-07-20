/**
 * MentionAutocomplete — popover triggered by typing `@` inside the composer
 * (ADR-0075 §A.5, #311).
 *
 * Lists auto-groups (admins/schedulers/members/viewers/all/scrum-team) +
 * individual project members filtered by the partial query after `@`. Keyboard
 * navigation (↑ ↓ Enter Esc) is handled by the parent composer so the popover
 * itself is presentation-only.
 *
 * The `@all` row is disabled for non-Admin users — the ADR §C role gate is
 * also enforced server-side, but disabling the row in the UI teaches the
 * constraint without a confusing 400 round-trip.
 */

import type { MentionMemberOption } from '@/hooks/useProjectMembers';
import { ROLE_ADMIN } from '@/lib/roles';

export interface MentionSuggestion {
  /** What the composer inserts (without the leading `@`). */
  value: string;
  /** What appears as the primary text in the dropdown. */
  label: string;
  /** Hint shown after the label, e.g. "Admin role" or "12 members". */
  hint: string;
  kind: 'group' | 'user';
  /** True when the row is shown disabled (e.g. @all for non-Admin). */
  disabled?: boolean;
}

interface AutoGroupSpec {
  key: string;
  description: (memberCount: number) => string;
  /** Optional gate — return true to disable the row. */
  disabledFor?: (currentRole: number | null) => boolean;
}

const AUTO_GROUPS: AutoGroupSpec[] = [
  {
    key: 'all',
    description: () => 'Everyone in this project',
    disabledFor: (r) => r == null || r < ROLE_ADMIN,
  },
  { key: 'admins', description: () => 'Admins + Owners' },
  { key: 'schedulers', description: () => 'Schedulers + Admins + Owners' },
  { key: 'members', description: () => 'Member role' },
  { key: 'viewers', description: () => 'Viewer role' },
  { key: 'scrum-team', description: () => 'Active sprint assignees' },
];

/**
 * Program-scoped auto-groups (#514) — only offered when the current project
 * belongs to a program. They resolve server-side against the union of member-
 * ships across every project in the program. `@program-all` is Admin-gated like
 * `@all`; the server enforces the same gate, so a disabled row just avoids a
 * confusing 400 round-trip. No live member count is shown (the roster loaded
 * here is project-scoped, not program-wide), so the hints are descriptive.
 */
const PROGRAM_AUTO_GROUPS: AutoGroupSpec[] = [
  {
    key: 'program-all',
    description: () => 'Everyone across the program',
    disabledFor: (r) => r == null || r < ROLE_ADMIN,
  },
  { key: 'program-pms', description: () => 'PMs across the program' },
  { key: 'program-schedulers', description: () => 'Schedulers across the program' },
  { key: 'program-stakeholders', description: () => 'Viewers across the program' },
];

/**
 * A user-defined project mention group (ADR-0212, #515) offered in the `@`
 * autocomplete (#2254). The server resolves `@name` against these at write time;
 * names are regex-constrained to a single `[A-Za-z0-9._-]+` token, so every one
 * is a valid mention token.
 */
export interface MentionGroupOption {
  name: string;
  memberCount: number;
}

interface Props {
  /** The substring after `@` the user has typed so far. */
  query: string;
  members: MentionMemberOption[];
  currentRole: number | null;
  /** True when the composer's project belongs to a program (#514) — surfaces
   * the `@program-*` auto-groups. */
  hasProgram?: boolean;
  /** User-defined project mention groups (#2254) — offered after the auto-groups. */
  mentionGroups?: MentionGroupOption[];
  /** Index of the highlighted suggestion (0-based). */
  highlightIndex: number;
  /**
   * Stable DOM id for the listbox element so the composer textarea can
   * point `aria-controls` and `aria-activedescendant` at it (WAI-ARIA combobox
   * pattern). Each option's id is `${listboxId}-opt-${index}`.
   */
  listboxId: string;
  /** Called when a suggestion is clicked. Keyboard Enter is handled by parent. */
  onSelect: (suggestion: MentionSuggestion) => void;
  /** Called when the popover renders so the parent knows how many items exist. */
  onSuggestionsChange?: (suggestions: MentionSuggestion[]) => void;
}

/**
 * Build the full suggestion list given the current query + role context.
 *
 * When `hasProgram` is true (the project belongs to a program), the program-
 * scoped auto-groups (`@program-pms`, …) are appended after the project groups.
 * User-defined project mention groups (`mentionGroups`, #2254) are offered after
 * all auto-groups and before individual users.
 */
export function buildMentionSuggestions(
  query: string,
  members: MentionMemberOption[],
  currentRole: number | null,
  hasProgram = false,
  mentionGroups: MentionGroupOption[] = [],
): MentionSuggestion[] {
  const q = query.toLowerCase();
  const groupSpecs = hasProgram ? [...AUTO_GROUPS, ...PROGRAM_AUTO_GROUPS] : AUTO_GROUPS;
  const groups: MentionSuggestion[] = groupSpecs
    .filter((g) => g.key.startsWith(q) || q === '')
    .map((g) => ({
      value: g.key,
      label: `@${g.key}`,
      hint: g.description(members.length),
      kind: 'group' as const,
      disabled: g.disabledFor ? g.disabledFor(currentRole) : false,
    }));
  const userGroups: MentionSuggestion[] = mentionGroups
    .filter((g) => g.name.toLowerCase().startsWith(q) || q === '')
    .map((g) => ({
      value: g.name,
      label: `@${g.name}`,
      hint: `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
      kind: 'group' as const,
    }));
  const users: MentionSuggestion[] = members
    .filter((m) => m.username.toLowerCase().startsWith(q) || q === '')
    .slice(0, 10) // hard cap on user suggestions so popover stays scannable
    .map((m) => ({
      value: m.username,
      label: `@${m.username}`,
      hint: '',
      kind: 'user' as const,
    }));
  return [...groups, ...userGroups, ...users];
}

export function MentionAutocomplete({
  query,
  members,
  currentRole,
  hasProgram = false,
  mentionGroups = [],
  highlightIndex,
  listboxId,
  onSelect,
  onSuggestionsChange,
}: Props) {
  const suggestions = buildMentionSuggestions(
    query,
    members,
    currentRole,
    hasProgram,
    mentionGroups,
  );
  // Notify parent of suggestion count for keyboard handlers (does NOT use
  // useEffect — parent re-renders on the same input so this is deterministic).
  onSuggestionsChange?.(suggestions);

  if (suggestions.length === 0) {
    return (
      <div
        id={listboxId}
        role="listbox"
        aria-label="Mention suggestions"
        className="absolute z-50 min-w-[240px] bg-neutral-surface border border-neutral-border rounded-card p-1"
      >
        <div className="px-2 py-1.5 text-xs text-neutral-text-secondary">No matches</div>
      </div>
    );
  }

  return (
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute z-50 min-w-[240px] max-h-[280px] overflow-y-auto bg-neutral-surface
        border border-neutral-border rounded-card p-1 list-none"
    >
      {suggestions.map((s, idx) => {
        const active = idx === highlightIndex;
        return (
          <li
            key={`${s.kind}-${s.value}`}
            id={`${listboxId}-opt-${idx}`}
            role="option"
            aria-selected={active}
            aria-disabled={s.disabled}
            className={`flex items-baseline gap-2 px-2 py-1.5 rounded-control text-xs cursor-pointer
              ${active && !s.disabled ? 'bg-brand-primary/10 text-neutral-text-primary' : ''}
              ${s.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-neutral-surface-raised'}`}
            onMouseDown={(e) => {
              // Use mousedown not click so the composer's blur handler doesn't
              // close the popover before the selection registers.
              e.preventDefault();
              if (!s.disabled) onSelect(s);
            }}
          >
            <span className="flex-shrink-0" aria-hidden="true">
              {s.kind === 'group' ? '👥' : '👤'}
            </span>
            <span className="font-medium">{s.label}</span>
            {s.hint && <span className="text-neutral-text-secondary">{s.hint}</span>}
            {s.disabled && (
              <span
                className="text-neutral-text-secondary ml-auto"
                title="@all requires Admin role"
              >
                Admin+ only
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
