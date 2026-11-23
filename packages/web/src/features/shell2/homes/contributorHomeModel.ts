/**
 * View model for the Contributor home (#4768): which of four states applies, and the
 * one line under the greeting. Counts come from the My Work payload (the server's
 * `due_today_count` and the assigned rows); nothing is derived from dates here.
 *
 * Vocabulary is the contributor's: tasks and what is due. Never float, critical
 * path, health or forecast: those are the PM's words (#1561).
 */
export type ContributorHomeState =
  /** The first read is in flight and nothing is cached. */
  | { kind: 'loading' }
  /** The read failed with nothing cached to show. */
  | { kind: 'error' }
  /** The read succeeded and there is nothing assigned. */
  | { kind: 'empty' }
  /** There is work to show. `staleError` keeps cached work visible under a retry banner. */
  | { kind: 'ready'; staleError: boolean };

export interface ContributorHomeInput {
  isLoading: boolean;
  hasError: boolean;
  /** Assigned tasks + retro action items + visible external items. */
  itemCount: number;
}

export function contributorHomeState(i: ContributorHomeInput): ContributorHomeState {
  if (i.itemCount > 0) return { kind: 'ready', staleError: i.hasError };
  // An error is never rendered as "nothing assigned" (rule 246).
  if (i.hasError) return { kind: 'error' };
  if (i.isLoading) return { kind: 'loading' };
  return { kind: 'empty' };
}

/** "3 tasks due today · 12 assigned", or the all-clear line. Subject-verb agreement included. */
export function contributorSubline(dueToday: number, assigned: number): string {
  const parts: string[] = [];
  if (dueToday > 0) parts.push(dueToday === 1 ? '1 task due today' : `${dueToday} tasks due today`);
  if (assigned > 0)
    parts.push(assigned === 1 ? '1 task assigned to you' : `${assigned} tasks assigned to you`);
  return parts.length === 0 ? "You're all caught up." : parts.join(' · ');
}
