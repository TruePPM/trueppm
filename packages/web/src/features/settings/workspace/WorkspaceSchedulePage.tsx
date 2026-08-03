import { useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { BuildModeCheatsheet } from '@/features/schedule/buildMode';

/**
 * Schedule preferences section (workspace scope, consolidated /settings page).
 *
 * Home of Schedule preferences. Build mode — the keyboard-first row-entry
 * surface — is on by default on desktop (ADR-0054, #2682); this page no
 * longer gates it behind a toggle, it just surfaces the shortcuts reference.
 */
export function WorkspaceSchedulePage() {
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
          hint="Keyboard-first plan entry on the Schedule list — type, Tab to indent, Enter to open a task. Desktop-only."
          help={
            <FieldHelp
              label="Build mode"
              body="Build mode is a keyboard-first way to enter a plan on the Schedule list — type a task name, Tab to indent it under its parent, and Enter to open it. It's desktop-only and on by default."
              docHref="features/schedule-build-mode/"
            />
          }
        >
          <button
            type="button"
            onClick={() => setCheatsheetOpen(true)}
            className="self-start text-[12px] text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            View keyboard shortcuts
          </button>
        </FieldRow>
      </div>

      <BuildModeCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </div>
  );
}
