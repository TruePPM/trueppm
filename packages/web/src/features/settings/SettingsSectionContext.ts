import { createContext, useContext } from 'react';
import { DEFAULT_SECTION_KEY } from './hooks/useSettingsSaveStore';
import type { SettingsScope } from './settingsDocs';

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

/**
 * Which settings scope the current subtree belongs to (ADR-0682). `SettingsShell`
 * provides it from the `scope` prop it already receives; `SettingsSection` reads it
 * to resolve its own docs link out of `SETTINGS_DOCS` without every section
 * component — or every `<SettingsSection>` mount site — having to pass one.
 *
 * `null` outside a shell (standalone tool pages, unit tests), in which case no
 * section-level help is resolved and `SettingsPageTitle` renders a link only if
 * given an explicit `docsHref`.
 */
export const SettingsScopeContext = createContext<SettingsScope | null>(null);

/** The settings scope of the current subtree, or `null` outside a `SettingsShell`. */
export function useSettingsScope(): SettingsScope | null {
  return useContext(SettingsScopeContext);
}

/**
 * The resolved documentation slug for the current section, or `undefined` when the
 * section has no mapping or is rendered outside a `SettingsSection`.
 *
 * Provided by `SettingsSection` (which has both the scope and the section id) and
 * consumed by `SettingsPageTitle`, so the link travels from configuration to render
 * without passing through any section component.
 */
export const SettingsSectionDocsContext = createContext<string | undefined>(undefined);

/** The docs slug for the current section, or `undefined` when it has none. */
export function useSettingsSectionDocs(): string | undefined {
  return useContext(SettingsSectionDocsContext);
}
