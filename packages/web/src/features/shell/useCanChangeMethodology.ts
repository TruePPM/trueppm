import { useAdminSettingsAccess } from '@/hooks/useAdminSettingsAccess';

/**
 * Whether the "Change/Review methodology" action may be offered.
 *
 * It must track the Settings page's own rail condition, not the project role:
 * the full rail (which mounts `how-this-team-works`) is shown to anyone whose
 * `/auth/me` says `can_access_admin_settings !== false` (Admin+ in any project),
 * and the reduced member rail is shown only on a definite `false`. A role read
 * on this project would hide the link from someone the rail would serve, and
 * show it to someone it would not.
 *
 * Verdict handling: `admin` and `unknown` offer the action; `not-admin` and
 * `loading` withhold it. `loading` withholds so a contributor never sees the
 * button flash before the verdict lands. `unknown` (a failed `/auth/me`) offers
 * it so a transient error cannot strand an Admin — the same rail renders full on
 * an absent signal, and the server refuses any write a non-admin attempts.
 */
export function useCanChangeMethodology(): boolean {
  const { verdict } = useAdminSettingsAccess();
  return verdict === 'admin' || verdict === 'unknown';
}
