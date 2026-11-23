import type { CurrentUser } from '@/hooks/useCurrentUser';

/** The shell-v2 front door. Rail Home, `/` and the login redirect go here when `shell_v2` is on. */
export const HOME_PATH = '/home';

/** The four role homes the server resolves (`landing.home`). */
export type HomeKind = 'contributor' | 'pm' | 'rm' | 'exec';

/**
 * What `/home` renders. `rm` still shows the Resources page in place until its own
 * home ships (#4770). The Executive home carries the program the server chose (or
 * none); the client selects nothing, and its switcher changes only the view.
 */
export type HomeSurface =
  | { kind: 'contributor' }
  | { kind: 'pm' }
  | { kind: 'resources' }
  | { kind: 'exec'; programId: string | null };

/**
 * Map the server-resolved home onto the surface `/home` renders.
 *
 * Pure: no role logic lives here: `landing.home` already encodes the precedence.
 * An unknown or missing value (an older server) reads as the contributor home, the
 * same fail-open default the server resolver uses.
 */
export function resolveHomeSurface(landing: CurrentUser['landing'] | undefined): HomeSurface {
  switch (landing?.home) {
    case 'pm':
      return { kind: 'pm' };
    case 'rm':
      return { kind: 'resources' };
    case 'exec':
      return { kind: 'exec', programId: landing.home_program?.id ?? null };
    default:
      return { kind: 'contributor' };
  }
}
