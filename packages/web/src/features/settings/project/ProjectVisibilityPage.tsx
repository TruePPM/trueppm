import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';

/**
 * The four toggleable leaf surfaces (ADR-0193, issue 956), in display order. Each
 * `field` is the project column (`null` = inherit the methodology default); `key`
 * indexes the server-computed `inherited_surface_visibility` object for the
 * provenance label. Copy explains what turning the surface OFF does — and that the
 * data stays computed and URL-reachable (ADR-0041 hide-only), so an ADMIN reads the
 * toggle as "hide the chrome", never "delete the capability".
 */
const SURFACES = [
  {
    field: 'show_reporting',
    key: 'reporting',
    label: 'Reports',
    hint: 'Show the Reports view for this project. Turning it off hides the Reports tab; the reporting data is still computed and the page stays reachable by direct link.',
    ariaLabel: 'Show the Reports surface',
  },
  {
    field: 'show_time_tracking',
    key: 'time_tracking',
    label: 'Time tracking',
    hint: 'Show time-entry surfaces for this project. Turning it off hides the time-logging chrome (currently mobile); existing time entries are kept and the API is untouched.',
    ariaLabel: 'Show the Time tracking surface',
  },
  {
    field: 'show_baselines',
    key: 'baselines',
    label: 'Baselines',
    hint: 'Show the baseline-vs-current comparison in the task drawer. Turning it off hides that section; captured baselines are kept and stay reachable.',
    ariaLabel: 'Show the Baselines surface',
  },
  {
    field: 'show_monte_carlo',
    key: 'monte_carlo',
    label: 'Monte-Carlo forecast',
    hint: 'Show the probabilistic finish-date forecast on the Schedule. Turning it off hides the forecast bar; the simulation still runs and its results stay available via the API.',
    ariaLabel: 'Show the Monte-Carlo forecast surface',
  },
] as const;

type SurfaceField = (typeof SURFACES)[number]['field'];
type SurfaceState = Record<SurfaceField, boolean | null>;

/** The all-inherit blank state used before the project detail loads. */
const BLANK: SurfaceState = {
  show_reporting: null,
  show_time_tracking: null,
  show_baselines: null,
  show_monte_carlo: null,
};

/**
 * Project > Surface visibility settings section (ADR-0193, issue 956).
 *
 * Four independent tri-state toggles — each `null` (inherit the methodology
 * default), `true` (force-show), or `false` (hide). They seed from
 * `effective_methodology` (the server resolves the default) but override
 * independently. Hide-only (ADR-0041): a hidden surface keeps its endpoint and
 * data; only the chrome is suppressed.
 *
 * State commits through the shared project PATCH via `useDirtyForm`. Writes are
 * Admin+ (the server auto-403s these fields for lower roles); the render-gate just
 * spares a doomed save and shows the inherited provenance read-only below ADMIN.
 */
export function ProjectVisibilityPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const { role } = useCurrentUserRole(projectId);

  const [values, setValues] = useState<SurfaceState>(BLANK);
  const [initialValues, setInitialValues] = useState<SurfaceState>(BLANK);
  const seededProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    const seeded: SurfaceState = {
      show_reporting: project.show_reporting ?? null,
      show_time_tracking: project.show_time_tracking ?? null,
      show_baselines: project.show_baselines ?? null,
      show_monte_carlo: project.show_monte_carlo ?? null,
    };
    setValues(seeded);
    setInitialValues(seeded);
  }, [project]);

  const setField = useCallback((field: SurfaceField, next: boolean | null) => {
    setValues((prev) => ({ ...prev, [field]: next }));
  }, []);

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync(values);
    setInitialValues(values);
  }, [updateProject, values]);

  const handleReset = useCallback(() => {
    setValues(initialValues);
  }, [initialValues]);

  useDirtyForm({ values, initialValues, onSave: handleSave, onReset: handleReset, apiReady: !!project });

  // Admin+ may edit; reads are open. Gate pessimistically while the role loads
  // (mirrors ProjectAttachmentsPage's gate, ADR-0133).
  const canEdit = role !== null && role >= ROLE_ADMIN;

  return (
    <div>
      <SettingsPageTitle
        title="Surface visibility"
        subtitle="Turn optional surfaces on or off for this project. Each inherits a sensible default from the project's methodology unless you override it. Hiding a surface only removes its chrome — the data stays computed and reachable by direct link."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        {SURFACES.map((s) => (
          <FieldRow key={s.field} label={s.label} hint={s.hint}>
            <InheritableToggleField
              value={values[s.field]}
              onChange={(next) => setField(s.field, next)}
              inherited={project?.inherited_surface_visibility?.[s.key] ?? true}
              inheritFromLabel="the methodology default"
              scopeNoun="project"
              onLabel="Shown"
              offLabel="Hidden"
              ariaLabel={s.ariaLabel}
              canEdit={canEdit}
            />
          </FieldRow>
        ))}
      </div>
    </div>
  );
}
