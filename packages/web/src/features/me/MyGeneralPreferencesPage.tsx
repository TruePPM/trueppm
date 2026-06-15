/**
 * MyGeneralPreferencesPage — per-user general preferences at
 * /me/settings/general (ADR-0129).
 *
 * Mirrors NotificationPreferencesPage's page chrome and per-change auto-save:
 * no save bar, no dirty-form gate. Selecting a landing option PATCHes
 * immediately (optimistic), announces "Saved." in an aria-live region, and
 * reverts with an error line on failure. Offline blocks the PATCH with an inline
 * note rather than silently dropping the change.
 *
 * Auto is first and pre-selected here (it's the stored default). Its helper text
 * is role-aware: while the stored preference is "auto" it echoes the live
 * resolved intent; once a concrete preference is set it explains what "auto"
 * would do.
 */
import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { useCurrentUser, type DefaultLanding } from '@/hooks/useCurrentUser';
import { useUpdateDefaultLanding } from '@/hooks/useDefaultLanding';
import { LANDING_CHOICES, humanizeIntent } from '@/features/me/landing';
import {
  LandingChoiceRadioGroup,
  type LandingChoiceOption,
} from '@/features/me/LandingChoiceRadioGroup';

const SAVED_TOAST_MS = 3000;

/** In-page secondary nav across the flat /me/settings/* pages. */
function SettingsSubNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm rounded px-1 -mx-1',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
      isActive
        ? 'font-medium text-neutral-text-primary'
        : 'text-neutral-text-secondary hover:text-neutral-text-primary',
    ].join(' ');
  return (
    <nav aria-label="Preferences sections" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <NavLink to="/me/settings/general" className={linkClass}>
        General
      </NavLink>
      <span aria-hidden="true" className="text-neutral-text-disabled">
        ·
      </span>
      <NavLink to="/me/settings/notifications" className={linkClass}>
        Notifications
      </NavLink>
      <span aria-hidden="true" className="text-neutral-text-disabled">
        ·
      </span>
      <NavLink to="/me/settings/connected-accounts" className={linkClass}>
        Connected accounts
      </NavLink>
    </nav>
  );
}

export function MyGeneralPreferencesPage() {
  const { user } = useCurrentUser();
  const updateLanding = useUpdateDefaultLanding();
  // Optimistic selection — seeded from the server value, reverted on error.
  const [selected, setSelected] = useState<DefaultLanding | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const serverValue = user?.default_landing ?? 'auto';
  const value: DefaultLanding = selected ?? serverValue;

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  // Build the option list with Auto FIRST and its role-aware helper text.
  const options = useMemo<LandingChoiceOption[]>(() => {
    const autoDescription =
      serverValue === 'auto' && user?.landing
        ? `Right now this opens ${humanizeIntent(user.landing.intent)}. Changes automatically if your role changes.`
        : 'Picks the best screen based on your role.';
    const auto: LandingChoiceOption = {
      value: 'auto',
      label: 'Auto (recommended)',
      description: autoDescription,
    };
    const concrete = LANDING_CHOICES.filter((c) => c.value !== 'auto');
    return [auto, ...concrete];
  }, [serverValue, user?.landing]);

  // Auto-dismiss the "Saved." indicator after 3 s.
  useEffect(() => {
    if (savedAt == null) return;
    const handle = setTimeout(() => setSavedAt(null), SAVED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [savedAt]);

  function handleSelect(next: DefaultLanding) {
    if (next === value) return;
    if (offline) return; // inline note explains; no PATCH while offline
    const previous = value;
    setSelected(next); // optimistic
    updateLanding.mutate(next, {
      onSuccess: () => setSavedAt(Date.now()),
      onError: () => setSelected(previous), // revert
    });
  }

  return (
    <main aria-label="General preferences" className="flex flex-col gap-4 p-6 max-w-3xl mx-auto">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-neutral-text-primary">Preferences</h1>
        <SettingsSubNav />
      </header>

      <section
        aria-labelledby="default-landing-heading"
        className="flex flex-col gap-3 rounded border border-neutral-border p-4"
      >
        <div>
          <h2
            id="default-landing-heading"
            className="text-sm font-semibold text-neutral-text-primary"
          >
            Default landing screen
          </h2>
          <p className="mt-0.5 text-sm text-neutral-text-secondary">
            The screen TruePPM opens when you sign in or click the logo.
          </p>
        </div>

        <LandingChoiceRadioGroup
          label="Default landing screen"
          options={options}
          value={value}
          onChange={handleSelect}
          disabled={offline}
        />

        {offline && (
          <p className="text-xs text-neutral-text-secondary">
            You&rsquo;re offline — reconnect to change your home screen.
          </p>
        )}
      </section>

      <p aria-live="polite" role="status" className="text-xs text-neutral-text-secondary">
        {updateLanding.isError
          ? "Couldn't save preference. Try again."
          : savedAt != null
            ? 'Saved.'
            : 'Changes save automatically.'}
      </p>
    </main>
  );
}
