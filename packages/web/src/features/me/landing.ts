/**
 * Shared helpers for the role-based app front door (ADR-0129, issue #1181).
 *
 * The server resolves *where* a user lands (`me.landing.path`); the client only
 * navigates there. This module owns the one piece of client-side safety the
 * server can't enforce — a prefix allowlist on the path it's told to navigate
 * to — plus the small presentational helpers (humanized intent labels, the
 * localStorage keys for one-time hints) shared across the prompt, the settings
 * page, and the transparency hint.
 */
import type { DefaultLanding, LandingIntent } from '@/hooks/useCurrentUser';

/** Paths the client will navigate to from the server-resolved landing. */
const ALLOWED_LANDING_PREFIXES = ['/me/work', '/projects/'] as const;

/** Where we send a user when a path is missing, off-allowlist, or unsafe. */
export const LANDING_FALLBACK_PATH = '/me/work';

/**
 * Mirror of `loginRedirectDest`'s open-redirect guard, narrowed to landing.
 *
 * The path comes from the server (trusted), but treating it as an allowlisted
 * relative route — never a protocol-relative / off-origin value, and only the
 * surfaces we actually route to — means a future server bug or an unreachable
 * Enterprise `portfolio` path in the community edition degrades to My Work
 * instead of a dead route or an open redirect. Returns a safe path always.
 */
export function safeLandingPath(path: string | undefined | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return LANDING_FALLBACK_PATH;
  }
  if (!ALLOWED_LANDING_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return LANDING_FALLBACK_PATH;
  }
  return path;
}

/** Human-readable label for a resolved landing intent (used in echo copy). */
export function humanizeIntent(intent: LandingIntent): string {
  switch (intent) {
    case 'my_work':
      return 'My Work';
    case 'project_overview':
      return "a project's Overview";
    case 'portfolio':
      return 'Portfolio';
  }
}

/** The four selectable preference values, in display order for each surface. */
export const LANDING_CHOICES: ReadonlyArray<{
  value: DefaultLanding;
  label: string;
  /** Per-choice helper line shown beneath the option label. */
  description: string;
  /** Enterprise-reserved in the community edition (rule-122 stub treatment). */
  enterprise?: boolean;
}> = [
  { value: 'my_work', label: 'My Work', description: 'Your cross-project task list.' },
  {
    value: 'project_overview',
    label: "A project's Overview",
    description: 'Open straight into your most recent project.',
  },
  {
    value: 'portfolio',
    label: 'Portfolio',
    description: 'The cross-program portfolio dashboard.',
    enterprise: true,
  },
];

/** localStorage keys for the one-time first-login prompt and transparency hints. */
export const LANDING_PROMPT_SEEN_KEY = 'trueppm.landingPromptSeen';
export const LANDING_HINT_SEEN_KEY = 'trueppm.landingHintSeen';
export const LANDING_FALLBACK_NOTICE_SEEN_KEY = 'trueppm.landingFallbackNoticeSeen';
