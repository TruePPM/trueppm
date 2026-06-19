import { createContext, useContext } from 'react';
import { DEFAULT_SECTION_KEY } from './hooks/useSettingsSaveStore';

/**
 * Identifies which anchored settings section the current subtree belongs to
 * (ADR-0146). `<SettingsSection id>` provides the id; `useDirtyForm` reads it so
 * each form section registers under its own key in `useSettingsSaveStore`.
 *
 * Outside a `<SettingsSection>` (standalone settings routes such as the System
 * Health "Retention & purge" tool, or unit tests) the value is the default key,
 * which preserves the pre-0146 single-registration behavior.
 */
export const SettingsSectionContext = createContext<string>(DEFAULT_SECTION_KEY);

/** The section id the current subtree is rendered under. */
export function useSettingsSectionId(): string {
  return useContext(SettingsSectionContext);
}
