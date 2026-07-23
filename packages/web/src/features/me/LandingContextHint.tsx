/**
 * Transparency hint for the role-based front door (ADR-0129).
 *
 * A slim, dismissible `role="status"` strip at the top of the landing surface
 * that explains *why* the user landed here — calm neutral styling, no semantic
 * hue (nothing is wrong). Two copy variants, one component:
 *
 *   - role_policy: the front door came from the role policy (no preference set).
 *     "TruePPM opens here based on your role." Persisted per-intent so it shows
 *     once per distinct landing intent.
 *   - fallback: the user's saved home was unreachable, so we opened My Work.
 *     Only shown when they actually had a concrete preference. Persisted under a
 *     separate key.
 *
 * Mounted on My Work (the common landing); kept lightweight.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { CloseIcon } from '@/components/Icons';
import { LANDING_HINT_SEEN_KEY, LANDING_FALLBACK_NOTICE_SEEN_KEY } from '@/features/me/landing';

type HintVariant = 'role_policy' | 'fallback';

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — hint re-appears next visit, acceptable */
  }
}

/**
 * Decide which hint (if any) to show for the current landing. Exported for unit
 * tests of the seen-key gating.
 */
export function resolveLandingHint(
  resolvedBy: string | undefined,
  intent: string | undefined,
  defaultLanding: string | undefined,
): HintVariant | null {
  if (resolvedBy === 'role_policy' && intent) {
    return readKey(LANDING_HINT_SEEN_KEY) === intent ? null : 'role_policy';
  }
  if (resolvedBy === 'fallback' && defaultLanding && defaultLanding !== 'auto') {
    return readKey(LANDING_FALLBACK_NOTICE_SEEN_KEY) ? null : 'fallback';
  }
  return null;
}

export function LandingContextHint() {
  const { user } = useCurrentUser();
  const [dismissed, setDismissed] = useState(false);

  const variant = user
    ? resolveLandingHint(user.landing?.resolved_by, user.landing?.intent, user.default_landing)
    : null;

  if (!user || variant == null || dismissed) return null;

  function handleDismiss() {
    if (!user) return;
    if (variant === 'role_policy' && user.landing?.intent) {
      writeKey(LANDING_HINT_SEEN_KEY, user.landing.intent);
    } else if (variant === 'fallback') {
      writeKey(LANDING_FALLBACK_NOTICE_SEEN_KEY, '1');
    }
    setDismissed(true);
  }

  const message =
    variant === 'fallback'
      ? "Your saved home isn't available right now, so we opened My Work."
      : 'TruePPM opens here based on your role.';
  const linkLabel =
    variant === 'fallback' ? 'Update your default in Settings' : 'Change your home in Settings';

  return (
    <div
      role="status"
      className="mx-4 mt-3 flex min-h-[44px] items-center gap-2 rounded-card border border-neutral-border
        bg-neutral-surface-raised px-3 py-3 text-xs text-neutral-text-secondary md:mx-6"
    >
      <span className="flex-1">
        {message}{' '}
        <Link
          to="/me/settings/general"
          className="font-medium text-brand-primary hover:underline
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
        >
          {linkLabel} →
        </Link>
      </span>
      {/* 44px touch target (item 3, rule 5 / WCAG 2.5.5) */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
