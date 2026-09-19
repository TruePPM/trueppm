import type { KeyboardEvent } from 'react';
import { extractFieldErrors } from '@/lib/apiError';

/**
 * Keyboard navigation for a search-result `<li role="option">`, shared by the
 * project (`InviteForm`) and program (`ProgramInviteForm`) invite flows
 * (#3903): Enter/Space selects, Arrow keys move focus to the sibling option,
 * Escape closes the list and returns focus to the search input.
 */
export function handleSearchOptionKeyDown<T>(
  e: KeyboardEvent<HTMLLIElement>,
  item: T,
  { onSelect, onClose }: { onSelect: (item: T) => void; onClose: () => void },
): void {
  if (e.key === 'Enter' || e.key === ' ') onSelect(item);
  if (e.key === 'ArrowDown') (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
  if (e.key === 'ArrowUp') (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
  if (e.key === 'Escape') onClose();
}

export interface MemberMutationErrors {
  conflictError: boolean;
  refusalMessage: string | null;
}

/**
 * Classify an add-member mutation's error identically for the project and
 * program invite forms (#3903). A 409 means "already a member"; a 400 the
 * server can explain — most often a target this caller is not allowed to add
 * (#3641) — surfaces its own `user` field message rather than the generic
 * "please try again", since the server has already decided and replaying the
 * identical request is rejected identically. Safe to key off one shared
 * mutation: each form submits one target at a time, so the refusal can only
 * be about the user it names.
 */
export function deriveMemberMutationErrors(error: unknown): MemberMutationErrors {
  const refusalMessage = extractFieldErrors(error).user ?? null;
  const conflictError = Boolean(
    error &&
      typeof error === 'object' &&
      'response' in error &&
      (error as { response?: { status?: number } }).response?.status === 409,
  );
  return { conflictError, refusalMessage };
}
