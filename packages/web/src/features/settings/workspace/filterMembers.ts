import type { WorkspaceMember } from '../hooks/useWorkspaceMembers';

export interface MemberFilter {
  query: string;
  role: string | null;
}

/**
 * Pure client-side filter for the workspace Members table.
 *
 * Matches on `name` and `email` case-insensitively against `query`, and on an
 * exact role match when `role` is non-null. The match is intentionally simple
 * (substring, not fuzzy) so behaviour stays predictable when the hook swaps
 * from fixture data to the real API (#518) — no rework required.
 */
export function filterMembers(
  members: readonly WorkspaceMember[],
  { query, role }: MemberFilter,
): WorkspaceMember[] {
  const q = query.trim().toLowerCase();
  return members.filter((m) => {
    if (role && m.role !== role) return false;
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
    );
  });
}
