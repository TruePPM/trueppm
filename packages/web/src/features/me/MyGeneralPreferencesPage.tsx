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
import { MeSettingsSubNav } from '@/features/me/MeSettingsSubNav';
import { useCurrentUser, type DefaultLanding, type RoleContext } from '@/hooks/useCurrentUser';
import { useUpdateDefaultLanding } from '@/hooks/useDefaultLanding';
import { useUpdateRoleContext } from '@/hooks/useRoleContext';
import { LANDING_CHOICES, humanizeIntent } from '@/features/me/landing';
import {
  LandingChoiceRadioGroup,
  type LandingChoiceOption,
} from '@/features/me/LandingChoiceRadioGroup';
import { RoleContextRadioGroup } from '@/features/me/RoleContextRadioGroup';
import { ROLE_CONTEXT_LABEL } from '@/features/me/roleContext';
import { ViewVisibilitySection } from '@/features/me/ViewVisibilitySection';
import { TimezoneFormatSection } from '@/features/me/TimezoneFormatSection';

const SAVED_TOAST_MS = 3000;

export function MyGeneralPreferencesPage() {
  const { user } = useCurrentUser();
  const updateLanding = useUpdateDefaultLanding();
  // Optimistic selection — seeded from the server value, reverted on error.
  const [selected, setSelected] = useState<DefaultLanding | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Role-context lens (issue 1263, ADR-0162) — same optimistic/auto-save shape, kept
  // in its own state so a save on one preference never disturbs the other.
  const updateRoleContext = useUpdateRoleContext();
  const [selectedFocus, setSelectedFocus] = useState<RoleContext | null>(null);
  const [focusSavedAt, setFocusSavedAt] = useState<number | null>(null);

  const serverValue = user?.default_landing ?? 'auto';
  const value: DefaultLanding = selected ?? serverValue;

  const focusServerValue: RoleContext = user?.role_context ?? 'unified';
  const focusValue: RoleContext = selectedFocus ?? focusServerValue;

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

  useEffect(() => {
    if (focusSavedAt == null) return;
    const handle = setTimeout(() => setFocusSavedAt(null), SAVED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [focusSavedAt]);

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

  function handleSelectFocus(next: RoleContext) {
    if (next === focusValue) return;
    if (offline) return;
    const previous = focusValue;
    setSelectedFocus(next); // optimistic
    updateRoleContext.mutate(next, {
      onSuccess: () => setFocusSavedAt(Date.now()),
      onError: () => setSelectedFocus(previous), // revert
    });
  }

  return (
    <section aria-label="General preferences" className="flex flex-col gap-4 p-6 max-w-3xl mx-auto">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-neutral-text-primary">Preferences</h1>
        <MeSettingsSubNav />
      </header>

      <section
        aria-labelledby="default-landing-heading"
        className="flex flex-col gap-3 rounded-card border border-neutral-border p-4"
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

      <section
        aria-labelledby="view-focus-heading"
        className="flex flex-col gap-3 rounded-card border border-neutral-border p-4"
      >
        <div>
          <h2 id="view-focus-heading" className="text-sm font-semibold text-neutral-text-primary">
            {ROLE_CONTEXT_LABEL}
          </h2>
          <p className="mt-0.5 text-sm text-neutral-text-secondary">
            How projects are organized for the hat you&rsquo;re wearing. Doesn&rsquo;t change your
            permissions or what anyone else sees.
          </p>
        </div>

        <RoleContextRadioGroup
          label={ROLE_CONTEXT_LABEL}
          value={focusValue}
          onChange={handleSelectFocus}
          disabled={offline}
        />

        {offline && (
          <p className="text-xs text-neutral-text-secondary">
            You&rsquo;re offline — reconnect to change your view focus.
          </p>
        )}
      </section>

      <p aria-live="polite" role="status" className="text-xs text-neutral-text-secondary">
        {updateRoleContext.isError
          ? "Couldn't save view focus. Try again."
          : focusSavedAt != null
            ? 'Saved.'
            : 'Changes save automatically.'}
      </p>

      <ViewVisibilitySection />

      <TimezoneFormatSection />
    </section>
  );
}
