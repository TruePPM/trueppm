import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
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
 *
 * Three of the four have a reader; **Time tracking has none** (#3376), which is
 * why it alone carries `notEnforced`. The inventory, so the next reader can check
 * it rather than trust it:
 *
 * - `reporting`   → `methodologyTabs.surfaceHiddenViews` (the reports tab)
 * - `baselines`   → `schedule/sections/BaselineSection`
 * - `monte_carlo` → `ScheduleView` forecast bar + `ProjectOverviewPage`
 * - `time_tracking` → **nothing**, on web or mobile
 *
 * ADR-0193 §5 deferred the time-tracking gate "until a web time-entry surface
 * ships". Those surfaces then shipped (#926/#1258) and every one of them is
 * **user-scoped and cross-project** — the top-bar `TimerChip` and `QuickLogTime`,
 * `/me/timesheet`, the My Work `LogTimePopover`. A per-project boolean has nothing
 * to gate. Wiring it needs a per-task delivery flag on the My Work payload, which
 * is a feature nobody has filed — not a wiring fix. Until one exists the control
 * stays inert rather than editable, because a save that is accepted and changes
 * nothing is the failure this product exists to remove. Delete `notEnforced` from
 * the entry, not the entry itself, the day a surface reads the flag.
 */
const SURFACES = [
  {
    field: 'show_reporting',
    key: 'reporting',
    label: 'Reports',
    hint: 'Show the Reports view for this project. Turning it off hides the Reports tab; the reporting data is still computed and the page stays reachable by direct link.',
    ariaLabel: 'Show the Reports surface',
    helpBody:
      'The Reports view for this project. Turning it off only hides the Reports tab — the reporting data is still computed, and the page stays reachable by direct link (hide-only).',
    docHref: 'administration/project-settings',
  },
  {
    field: 'show_time_tracking',
    key: 'time_tracking',
    label: 'Time tracking',
    hint: 'Stored, but nothing reads it — every time-logging surface in TruePPM is personal and spans all your projects, so there is no per-project time surface for this to hide.',
    ariaLabel: 'Show the Time tracking surface',
    helpBody:
      'Time logging in TruePPM is personal and cross-project: the top-bar timer, Quick log, My Work and your timesheet each cover every project you are on, and none of them is per-project chrome that a project setting could hide. So this toggle saves a value that nothing reads. It is shown inert rather than removed because the column, the API field and the methodology default are all still live — only the consequence is missing.',
    notEnforced:
      'Not enforced — no surface reads this setting. Time logging is personal and spans every project you are on, so turning this off would hide nothing. Nothing tracks per-project time chrome yet.',
    docHref: 'administration/project-settings/#surfaces',
  },
  {
    field: 'show_baselines',
    key: 'baselines',
    label: 'Baselines',
    hint: 'Show the baseline-vs-current comparison in the task drawer. Turning it off hides that section; captured baselines are kept and stay reachable.',
    ariaLabel: 'Show the Baselines surface',
    helpBody:
      'The baseline-vs-current comparison in the task drawer. Turning it off hides that section; captured baselines are kept and stay reachable.',
    docHref: 'features/baselines',
  },
  {
    field: 'show_monte_carlo',
    key: 'monte_carlo',
    label: 'Monte-Carlo forecast',
    hint: 'Show the probabilistic finish-date forecast on the Schedule. Turning it off hides the forecast bar; the simulation still runs and its results stay available via the API.',
    ariaLabel: 'Show the Monte-Carlo forecast surface',
    helpBody:
      'The probabilistic finish-date forecast on the Schedule. Turning it off hides the forecast bar; the simulation still runs and its results stay available via the API.',
    docHref: 'features/monte-carlo',
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
          <FieldRow
            key={s.field}
            label={s.label}
            hint={s.hint}
            // Unconditional ⓘ: this page has no StubFieldset, so the trigger is
            // never inside a disabled fieldset and stays reachable for read-only
            // viewers (matches ProgramRollupPage; the read-only-reachable pattern
            // deferred from #2266 MR3).
            help={<FieldHelp label={s.label} body={s.helpBody} docHref={s.docHref} />}
          >
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
              // `in` rather than `s.notEnforced`: SURFACES is `as const`, so the
              // entries are a union and only the Time tracking member declares
              // the key. Narrowing here keeps the array literal honest — an
              // entry without the key genuinely has a reader.
              notEnforced={'notEnforced' in s ? s.notEnforced : undefined}
            />
          </FieldRow>
        ))}
      </div>
    </div>
  );
}
