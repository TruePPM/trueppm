import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { MemberPicker } from '../components/MemberPicker';
import { StubFieldset } from '../components/StubFieldset';
import { DangerZoneLink } from '../components/DangerZoneLink';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import type { ProjectDefaultView, ProjectHealth, ProjectVisibility } from '@/api/types';
import { InheritableIterationLabelField } from '../components/InheritableIterationLabelField';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { DEFAULT_ITERATION_LABEL } from '@/lib/iterationLabel';

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
];

const DEFAULT_VIEW_OPTIONS: Array<{ id: ProjectDefaultView; label: string }> = [
  { id: 'SCHEDULE', label: 'Schedule (Gantt)' },
  { id: 'BOARD', label: 'Board' },
  { id: 'TABLE', label: 'Table' },
  { id: 'OVERVIEW', label: 'Overview' },
];

const HEALTH_OPTIONS: Array<{ id: ProjectHealth; label: string }> = [
  { id: 'ON_TRACK', label: 'On track' },
  { id: 'AT_RISK', label: 'At risk' },
  { id: 'CRITICAL', label: 'Critical' },
  { id: 'AUTO', label: 'Auto' },
];

const HEALTH_ACTIVE: Record<ProjectHealth, string> = {
  ON_TRACK: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  AT_RISK: 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  CRITICAL: 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40',
  AUTO: 'bg-brand-primary-light text-brand-primary border-brand-primary/40',
};

const VISIBILITY_OPTIONS: Array<{ id: ProjectVisibility; label: string; hint: string }> = [
  {
    id: 'WORKSPACE',
    label: 'Workspace',
    hint: 'Anyone in the workspace can view; editing follows role.',
  },
  {
    id: 'PRIVATE',
    label: 'Private',
    hint: 'Only invited members and groups can see this project.',
  },
];

/**
 * Project > General settings page.
 *
 * All seven editable fields (name, description, code, health, visibility,
 * timezone, default_view) are wired to PATCH /api/v1/projects/:id/. The
 * `calendar` FK toggles between inherited (null) and override; the picker UI
 * for choosing a specific calendar is tracked in #968, so the "+ Override"
 * button stays disabled when no calendar is currently assigned.
 *
 * The save bar appears on the first dirty edit and submits the whole payload
 * as a single PATCH on confirm; useDirtyForm handles the visibility + reset.
 */
export function ProjectGeneralPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const { role } = useCurrentUserRole(projectId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [health, setHealth] = useState<ProjectHealth>('AUTO');
  const [visibility, setVisibility] = useState<ProjectVisibility>('WORKSPACE');
  const [timezone, setTimezone] = useState('');
  const [defaultView, setDefaultView] = useState<ProjectDefaultView>('SCHEDULE');
  const [calendarId, setCalendarId] = useState<string | null>(null);
  // null = Unassigned. User id of the project lead (#966).
  const [lead, setLead] = useState<string | null>(null);
  // null = inherit the program/workspace default (ADR-0116, #1106).
  const [iterationLabel, setIterationLabel] = useState<string | null>(null);
  // null = inherit the program/workspace value (ADR-0135).
  const [publicSharing, setPublicSharing] = useState<boolean | null>(null);
  const [allowGuests, setAllowGuests] = useState<boolean | null>(null);

  // Re-seed whenever the loaded project's identity changes. React Router reuses
  // this component across `:projectId` changes (no `key` → no remount), so a
  // one-shot boolean guard would strand the form on the first project's values
  // when the user switches projects in Settings (#750). Keying on the id — rather
  // than on every `project` reference — still prevents a same-project background
  // refetch from clobbering in-progress edits, which was the original guard's intent.
  // The `initial*` snapshots are what the discard handler reverts to and what
  // useDirtyForm compares against to compute the dirty flag.
  const seededProjectIdRef = useRef<string | null>(null);
  const [initialName, setInitialName] = useState('');
  const [initialDescription, setInitialDescription] = useState('');
  const [initialCode, setInitialCode] = useState('');
  const [initialHealth, setInitialHealth] = useState<ProjectHealth>('AUTO');
  const [initialVisibility, setInitialVisibility] = useState<ProjectVisibility>('WORKSPACE');
  const [initialTimezone, setInitialTimezone] = useState('');
  const [initialDefaultView, setInitialDefaultView] = useState<ProjectDefaultView>('SCHEDULE');
  const [initialCalendarId, setInitialCalendarId] = useState<string | null>(null);
  const [initialLead, setInitialLead] = useState<string | null>(null);
  const [initialIterationLabel, setInitialIterationLabel] = useState<string | null>(null);
  const [initialPublicSharing, setInitialPublicSharing] = useState<boolean | null>(null);
  const [initialAllowGuests, setInitialAllowGuests] = useState<boolean | null>(null);

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    setName(project.name);
    setDescription(project.description ?? '');
    setCode(project.code);
    setHealth(project.health);
    setVisibility(project.visibility);
    setTimezone(project.timezone);
    setDefaultView(project.default_view);
    setCalendarId(project.calendar);
    setLead(project.lead ?? null);
    setIterationLabel(project.iteration_label ?? null);
    setPublicSharing(project.public_sharing ?? null);
    setAllowGuests(project.allow_guests ?? null);
    setInitialName(project.name);
    setInitialDescription(project.description ?? '');
    setInitialCode(project.code);
    setInitialHealth(project.health);
    setInitialVisibility(project.visibility);
    setInitialTimezone(project.timezone);
    setInitialDefaultView(project.default_view);
    setInitialCalendarId(project.calendar);
    setInitialLead(project.lead ?? null);
    setInitialIterationLabel(project.iteration_label ?? null);
    setInitialPublicSharing(project.public_sharing ?? null);
    setInitialAllowGuests(project.allow_guests ?? null);
  }, [project]);

  const values = useMemo(
    () => ({
      name,
      description,
      code,
      health,
      visibility,
      timezone,
      default_view: defaultView,
      calendar: calendarId,
      lead,
      iteration_label: iterationLabel,
      public_sharing: publicSharing,
      allow_guests: allowGuests,
    }),
    [
      name,
      description,
      code,
      health,
      visibility,
      timezone,
      defaultView,
      calendarId,
      lead,
      iterationLabel,
      publicSharing,
      allowGuests,
    ],
  );
  const initialValues = useMemo(
    () => ({
      name: initialName,
      description: initialDescription,
      code: initialCode,
      health: initialHealth,
      visibility: initialVisibility,
      timezone: initialTimezone,
      default_view: initialDefaultView,
      calendar: initialCalendarId,
      lead: initialLead,
      iteration_label: initialIterationLabel,
      public_sharing: initialPublicSharing,
      allow_guests: initialAllowGuests,
    }),
    [
      initialName,
      initialDescription,
      initialCode,
      initialHealth,
      initialVisibility,
      initialTimezone,
      initialDefaultView,
      initialCalendarId,
      initialLead,
      initialIterationLabel,
      initialPublicSharing,
      initialAllowGuests,
    ],
  );

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync({
      name,
      description,
      code,
      health,
      visibility,
      timezone,
      default_view: defaultView,
      calendar: calendarId,
      lead,
      // null clears the override (inherit); a blank custom string normalizes to null
      // too — "inherit" is the explicit null and the serializer rejects empty strings
      // (ADR-0116).
      iteration_label: iterationLabel === null ? null : iterationLabel.trim() || null,
      // null clears the sharing override so the project inherits program/workspace (ADR-0135).
      public_sharing: publicSharing,
      allow_guests: allowGuests,
    });
    const savedIterationLabel = iterationLabel === null ? null : iterationLabel.trim() || null;
    setIterationLabel(savedIterationLabel);
    setInitialName(name);
    setInitialDescription(description);
    setInitialCode(code);
    setInitialHealth(health);
    setInitialVisibility(visibility);
    setInitialTimezone(timezone);
    setInitialDefaultView(defaultView);
    setInitialCalendarId(calendarId);
    setInitialLead(lead);
    setInitialIterationLabel(savedIterationLabel);
    setInitialPublicSharing(publicSharing);
    setInitialAllowGuests(allowGuests);
  }, [
    updateProject,
    name,
    description,
    code,
    health,
    visibility,
    timezone,
    defaultView,
    calendarId,
    lead,
    iterationLabel,
    publicSharing,
    allowGuests,
  ]);

  const handleReset = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    setCode(initialCode);
    setHealth(initialHealth);
    setVisibility(initialVisibility);
    setTimezone(initialTimezone);
    setDefaultView(initialDefaultView);
    setCalendarId(initialCalendarId);
    setLead(initialLead);
    setIterationLabel(initialIterationLabel);
    setPublicSharing(initialPublicSharing);
    setAllowGuests(initialAllowGuests);
  }, [
    initialName,
    initialDescription,
    initialCode,
    initialHealth,
    initialVisibility,
    initialTimezone,
    initialDefaultView,
    initialCalendarId,
    initialLead,
    initialIterationLabel,
    initialPublicSharing,
    initialAllowGuests,
  ]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project,
  });

  const calendarInherited = calendarId === null;
  // The whole General page is editable only at Admin+ (issue 1084). Reads are open;
  // writes are gated server-side (ProjectSerializer.validate / _SCHEDULER_WRITABLE_FIELDS),
  // so this render-gate only spares a sub-Admin the arm-save-bar → 400 round-trip.
  // `role` is null while the membership query loads, so gate pessimistically
  // (read-only until proven Admin) to avoid a flash of editable controls. The
  // ADR-0135 sharing toggles already used this exact gate; it now governs every field.
  const canEdit = role !== null && role >= ROLE_ADMIN;

  return (
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Identity, defaults, and scheduling rules for this project. These override workspace defaults."
      />

      {/* Below Admin the whole form is read-only (issue 1084): StubFieldset disables
          every native control with the rule-122 recipe, and the custom pickers /
          toggles get canEdit={canEdit} so they render their own read-only view. */}
      <StubFieldset disabled={!canEdit}>
        <div className="px-6 pb-8 max-w-[720px]">
          <FieldRow label="Project name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Project name"
              className="w-full max-w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </FieldRow>

          <FieldRow
            label="Project code"
            hint="Used as a prefix for task IDs and exports. Uppercase letters, digits, hyphens; up to 12 characters."
          >
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={12}
              aria-label="Project code"
              placeholder="ENG-2026"
              className="w-[140px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </FieldRow>

          <FieldRow label="Description" hint="One paragraph. Shown on the overview page.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              aria-label="Description"
              className="w-full max-w-[540px] px-2.5 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </FieldRow>

          <FieldRow label="Project lead">
            {/* Real lead from the project record (Unassigned when null), set via
              the member picker (#966). Selection updates page state → the save
              bar commits; the server enforces Admin + member-of-scope. */}
            <MemberPicker
              scope="project"
              scopeId={projectId}
              value={lead}
              onChange={setLead}
              label="project lead"
              canEdit={canEdit}
              selectedDetail={project?.lead_detail ?? null}
            />
          </FieldRow>

          <FieldRow
            label="Health"
            hint="Drives the dot color in project lists and rollups. Override is auto-cleared after 14 days."
          >
            <div className="flex gap-2">
              {HEALTH_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setHealth(opt.id)}
                  aria-pressed={health === opt.id}
                  className={[
                    'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    health === opt.id
                      ? HEALTH_ACTIVE[opt.id]
                      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldRow>

          <FieldRow
            label="Visibility"
            hint="Workspace = anyone signed in can see this project. Private = invited only."
          >
            <div className="flex flex-col gap-3">
              {VISIBILITY_OPTIONS.map((opt) => (
                <label key={opt.id} className="flex items-center gap-3 cursor-pointer">
                  <span
                    className={[
                      'w-4 h-4 rounded-full border-2 shrink-0 transition-colors',
                      visibility === opt.id
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-neutral-border',
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    {visibility === opt.id && (
                      <span className="block w-full h-full rounded-full scale-[0.4] bg-white" />
                    )}
                  </span>
                  <input
                    type="radio"
                    name="project-visibility"
                    value={opt.id}
                    checked={visibility === opt.id}
                    onChange={() => setVisibility(opt.id)}
                    className="sr-only"
                  />
                  <span className="text-[13px] font-medium text-neutral-text-primary">
                    {opt.label}
                  </span>
                  <span className="text-[12px] text-neutral-text-secondary">· {opt.hint}</span>
                </label>
              ))}
            </div>
          </FieldRow>

          <FieldRow
            label="Allow guests"
            hint="Guests are external collaborators (vendors, auditors), limited to what they're invited to. Inherits the program or workspace setting unless you override it here."
          >
            <InheritableToggleField
              value={allowGuests}
              onChange={setAllowGuests}
              inherited={project?.inherited_allow_guests ?? false}
              inheritFromLabel="the program or workspace default"
              scopeNoun="project"
              onLabel="On"
              offLabel="Off"
              ariaLabel="Allow guest access"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Public sharing"
            hint="Anyone with the link can view selected reports — no sign-in required. Inherits the program or workspace setting unless you override it here."
          >
            <InheritableToggleField
              value={publicSharing}
              onChange={setPublicSharing}
              inherited={project?.inherited_public_sharing ?? false}
              inheritFromLabel="the program or workspace default"
              scopeNoun="project"
              onLabel="On"
              offLabel="Off"
              ariaLabel="Allow public link sharing"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Timezone"
            hint="Used for due dates, Gantt rendering, and sprint cutovers."
          >
            <div className="relative inline-block w-[280px]">
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                aria-label="Timezone"
                className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                <option value="">Workspace default</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <svg
                className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary"
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </FieldRow>

          <FieldRow
            label="Working calendar"
            hint="Override the workspace work-week and holidays. Picker UI ships with a follow-up issue."
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCalendarId(null)}
                  aria-pressed={calendarInherited}
                  className={[
                    'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    calendarInherited
                      ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  Inherit from workspace
                </button>
                <button
                  type="button"
                  disabled
                  aria-pressed={!calendarInherited}
                  title="Calendar picker isn't available yet — tracked in #968"
                  className={[
                    'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
                    !calendarInherited
                      ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  + Override
                </button>
              </div>
              {/* The per-project calendar picker isn't wired yet (#968); give the user a
              path forward instead of a dead disabled button (#668, Sarah/PM). */}
              <p className="text-[12px] text-neutral-text-secondary">
                Workaround: set the work week per task under Task → Calendar until the project-level
                calendar picker ships.
              </p>
            </div>
          </FieldRow>

          <FieldRow label="Default view">
            <div className="relative inline-block w-[200px]">
              <select
                value={defaultView}
                onChange={(e) => setDefaultView(e.target.value as ProjectDefaultView)}
                aria-label="Default view"
                className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {DEFAULT_VIEW_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <svg
                className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary"
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </FieldRow>

          {/* Iteration terminology (ADR-0111, #862). Agile/hybrid only — waterfall
          projects have no iteration container, so the control is irrelevant there
          (same methodology gate as the Team and Signal-privacy tabs). */}
          {(project?.methodology === 'AGILE' || project?.methodology === 'HYBRID') && (
            <FieldRow
              label="Iteration terminology"
              hint="What this team calls a time-boxed iteration. Display only — it never changes how anything works."
            >
              <InheritableIterationLabelField
                value={iterationLabel}
                onChange={setIterationLabel}
                inheritedLabel={project?.inherited_iteration_label ?? DEFAULT_ITERATION_LABEL}
                inheritFromLabel="the program or workspace default"
              />
            </FieldRow>
          )}
        </div>
      </StubFieldset>

      {/* Destructive actions live on the Archive / Delete page (#977). */}
      <DangerZoneLink to="../lifecycle" />
    </div>
  );
}
