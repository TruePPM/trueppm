import { useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { Toggle } from '../components/Toggle';
import { useFeatureFlag, setFeatureFlag } from '@/lib/featureFlags';
import { BuildModeCheatsheet } from '@/features/schedule/buildMode';

/** The runtime flag that gates the keyboard-first Schedule build surface. */
const BUILD_MODE_FLAG = 'schedule_build_mode_v1';

/**
 * Schedule preferences section (workspace scope, consolidated /settings page).
 *
 * Home of per-browser Schedule preferences. Today that is the single Build mode
 * toggle — the in-app enable path for the keyboard-first build surface, which
 * was previously reachable only via a `?ff=` URL param, hand-edited
 * localStorage, or a build-time `VITE_FEATURE_FLAGS` default (issue 1633).
 *
 * These are per-user, per-browser preferences written straight to localStorage
 * via `setFeatureFlag`, so — like the theme toggle — they apply instantly and
 * never arm the settings save bar (no dirty-form registration).
 */
export function WorkspaceSchedulePage() {
  const buildModeOn = useFeatureFlag(BUILD_MODE_FLAG);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  return (
    <div>
      <SettingsPageTitle
        title="Schedule"
        subtitle="Keyboard-first plan entry and other Schedule preferences for this browser."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        <FieldRow
          label="Build mode"
          hint="Keyboard-first plan entry on the Schedule list — type, Tab to indent, Enter to open a task. Desktop-only. Applies to this browser."
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Toggle
                on={buildModeOn}
                onChange={(next) => setFeatureFlag(BUILD_MODE_FLAG, next)}
                ariaLabel="Build mode (beta)"
              />
              <span
                className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-secondary"
                // Not a colored/alarming badge — a quiet maturity signal only.
              >
                Beta
              </span>
            </div>
            {buildModeOn && (
              <button
                type="button"
                onClick={() => setCheatsheetOpen(true)}
                className="self-start text-[12px] text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
              >
                View keyboard shortcuts
              </button>
            )}
          </div>
        </FieldRow>
      </div>

      <BuildModeCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </div>
  );
}
