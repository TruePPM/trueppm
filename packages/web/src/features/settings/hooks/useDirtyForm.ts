import { useEffect, useMemo } from 'react';
import { useSettingsSaveStore } from './useSettingsSaveStore';
import { useSettingsSectionId } from '../SettingsSectionContext';

export interface UseDirtyFormOptions<T extends Record<string, unknown>> {
  /** Current form values — usually derived from page-local `useState`. */
  values: T;
  /** Last-saved snapshot. Compared structurally against `values` to derive `dirty`. */
  initialValues: T;
  /** Save handler. Awaited by the shell when the user clicks "Save changes". */
  onSave: () => Promise<void> | void;
  /** Reset handler. Page must restore its local state to `initialValues` synchronously. */
  onReset: () => void;
  /**
   * False = stub page; save bar never arms and inputs should be wrapped in `<StubFieldset>`.
   * Pages flip to true when their per-page API issue (#517–#530) wires a real mutation.
   */
  apiReady: boolean;
}

/**
 * Page-side hook for the settings save contract.
 *
 * Publishes (dirty, onSave, onReset, apiReady) up to `useSettingsSaveStore`,
 * which `SettingsShell` reads to render the save bar, the confirm-discard
 * dialog, and the `beforeunload` listener.
 *
 * The hook does **not** own field state — pages keep their existing
 * `useState` for each field. The hook observes a `values` / `initialValues`
 * pair (compared via `JSON.stringify` — matches `BoardSettingsPanel`
 * precedent) and emits the dirty flag.
 *
 * @example
 * const [name, setName] = useState(project?.name ?? '');
 * const initial = { name: project?.name ?? '' };
 * const values = { name };
 * useDirtyForm({
 *   values,
 *   initialValues: initial,
 *   onSave: () => updateProject.mutateAsync({ name }),
 *   onReset: () => setName(initial.name),
 *   apiReady: true,
 * });
 */
export function useDirtyForm<T extends Record<string, unknown>>({
  values,
  initialValues,
  onSave,
  onReset,
  apiReady,
}: UseDirtyFormOptions<T>): { dirty: boolean } {
  // JSON.stringify is sufficient for settings forms — values are flat
  // primitives. Match the BoardSettingsPanel precedent rather than pulling
  // in a deep-equal dep.
  const dirty = useMemo(
    () => apiReady && JSON.stringify(values) !== JSON.stringify(initialValues),
    [apiReady, values, initialValues],
  );

  // The section this form belongs to (ADR-0146). On the consolidated page each
  // `<SettingsSection id>` provides its own key so multiple sections register
  // independently; outside one, the default key preserves single-registration.
  const sectionId = useSettingsSectionId();

  const register = useSettingsSaveStore((s) => s.register);
  const unregister = useSettingsSaveStore((s) => s.unregister);

  useEffect(() => {
    register(sectionId, {
      dirty,
      apiReady,
      onSave,
      onReset,
    });
  }, [sectionId, dirty, apiReady, onSave, onReset, register]);

  // Remove only this section's entry on unmount — sibling sections stay registered.
  useEffect(() => {
    return () => {
      unregister(sectionId);
    };
  }, [sectionId, unregister]);

  return { dirty };
}
