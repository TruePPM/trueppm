import type { CurrentUser } from '@/hooks/useCurrentUser';

/** The shell-v2 front door. Rail Home, `/` and the login redirect go here when `shell_v2` is on. */
export const HOME_PATH = '/home';

/** The four role homes the server resolves (`landing.home`, ADR-1298 amendment). */
export type HomeKind = 'contributor' | 'pm' | 'rm' | 'exec';

/**
 * What `/home` renders in place until each home's own issue ships (#4768–#4771).
 * `exec-program` carries the program the server chose; the client selects nothing.
 */
export type HomeSurface =
  | { kind: 'my-work' }
  | { kind: 'programs' }
  | { kind: 'resources' }
  | { kind: 'program-overview'; programId: string };

/**
 * Map the server-resolved home onto the existing page `/home` renders.
 *
 * Pure: no role logic lives here — `landing.home` already encodes the precedence.
 * An unknown or missing value (an older server) reads as the contributor home, the
 * same fail-open default the server resolver uses. An Executive with no program
 * (`home_program` null) gets the programs list rather than an empty overview.
 */
export function resolveHomeSurface(landing: CurrentUser['landing'] | undefined): HomeSurface {
  switch (landing?.home) {
    case 'pm':
      return { kind: 'programs' };
    case 'rm':
      return { kind: 'resources' };
    case 'exec':
      return landing.home_program
        ? { kind: 'program-overview', programId: landing.home_program.id }
        : { kind: 'programs' };
    default:
      return { kind: 'my-work' };
  }
}
