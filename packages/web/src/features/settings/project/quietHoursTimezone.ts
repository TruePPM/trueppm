import type { QuietHoursTimezoneSource } from '@/api/types';

/**
 * Caption copy for the resolved quiet-hours timezone on Project Settings →
 * Notifications (#3397).
 *
 * The window is stored as a bare wall-clock range, so "20:00" on its own does
 * not say 20:00 *where*. The server resolves the zone through a four-tier chain
 * (project → workspace → Django `TIME_ZONE` → UTC) and reports both the winning
 * zone and the tier that supplied it; this turns that pair into one sentence.
 *
 * Why the tier is named rather than just the zone: `project` and `workspace`
 * resolve to the same string whenever both are set the same way, so the value
 * alone cannot tell a member which scope owns it — and that is what decides who
 * they have to ask to change it. Mirrors `calendarSourceCopy` in
 * `calendarDisplay.ts`, the same shape one tier up (ADR-0441).
 *
 * `server` and `fallback` are degradation signals, not member-actionable states:
 * `server` means no workspace row exists yet, `fallback` means every tier was
 * unusable. They are still *stated*, because the zone is the answer to the
 * member's actual question and suppressing it would leave them unable to tell
 * that 20:00 means 20:00 UTC — but they are stated in the same neutral voice as
 * the other two. Warning chrome on a page every member opens, for a condition no
 * member can fix, is noise they cannot act on.
 */
export function quietHoursTimezoneCopy(
  zone: string | undefined,
  source: QuietHoursTimezoneSource | undefined,
): string | null {
  // A response cached from before #3377 carries neither field. Say nothing
  // rather than render a half-sentence about an undefined zone — the same
  // reading `calendarSourceCopy` applies to a missing `effective_calendar`.
  if (!zone || !source) return null;
  switch (source) {
    case 'project':
      return `Times are in ${zone} — this project's timezone.`;
    // "no usable timezone", never "no timezone": a scope that stores an
    // UNPARSEABLE zone also loses its tier — `resolve_quiet_hours_timezone`
    // logs and walks to the next one — so "sets none" would be a false claim
    // about a project or workspace that set a broken value.
    case 'workspace':
      return `Times are in ${zone} — the workspace default timezone. This project sets no usable timezone of its own.`;
    case 'server':
      return `Times are in ${zone} — the server default. Neither this project nor the workspace sets a usable timezone.`;
    case 'fallback':
      return `Times are in ${zone} — no project, workspace, or server timezone could be read.`;
    default:
      // An unrecognized tier from a newer server: the zone is still true, but
      // this build cannot describe where it came from, so it claims nothing.
      return null;
  }
}
