import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
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
import type {
  DurationChangePercentPolicy,
  MCAttributionAudience,
  PrioritizationModel,
  ProjectDefaultView,
  ProjectHealth,
  ProjectVisibility,
} from '@/api/types';
import { MC_HISTORY_RETENTION_MAX, MC_HISTORY_RETENTION_MIN } from '@/api/types';
import { InheritableIterationLabelField } from '../components/InheritableIterationLabelField';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { InheritableNumberField } from '../components/InheritableNumberField';
import { InheritableSelectField } from '../components/InheritableSelectField';
import { MC_ATTRIBUTION_OPTIONS, MC_ATTRIBUTION_HINT, MC_HISTORY_HINT } from '../forecastHistory';
import { DURATION_CHANGE_POLICY_OPTIONS, DURATION_CHANGE_POLICY_HINT } from '../durationChangePolicy';
import { calendarSourceCopy } from './calendarDisplay';
import { DEFAULT_ITERATION_LABEL } from '@/lib/iterationLabel';
import { HEALTH_OPTIONS, HEALTH_ACTIVE } from '@/features/project/projectHealth';

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

// Product-backlog scoring model (ADR-0105 §3, #922). `none` hides the scoring surface.
const PRIORITIZATION_OPTIONS: Array<{ id: PrioritizationModel; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'wsjf', label: 'WSJF' },
  { id: 'rice', label: 'RICE' },
  { id: 'value_effort', label: 'Value / Effort' },
];

// Notification-threshold bounds (validated server-side, 1–365).
const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 365;

/** Parse a threshold input, clamping to [1, 365] and mapping empty/NaN to the min. */
function clampThreshold(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return THRESHOLD_MIN;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
}

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
 * `calendar` FK toggles between inherited (null) and override: "Inherit from
 * workspace" clears it, and the picker (#968) sets it to a chosen org-level
 * calendar from GET /api/v1/calendars/. Either way the change flows through the
 * same save bar as every other field.
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
  // Schedule anchor (#2018). Required; empty is never persisted (guarded in handleSave).
  const [startDate, setStartDate] = useState('');
  // Forecasting data date (ADR-0132, #2018). null = "Today (dynamic)"; a string = fixed anchor.
  const [statusDate, setStatusDate] = useState<string | null>(null);
  // Backlog scoring model (ADR-0105, #2018).
  const [prioritizationModel, setPrioritizationModel] = useState<PrioritizationModel>('none');
  // Notification-nudge thresholds in days (ADR-0200 / #1911, #2018). Validated 1–365.
  const [staleThresholdDays, setStaleThresholdDays] = useState<number>(THRESHOLD_MIN);
  const [endShiftThresholdDays, setEndShiftThresholdDays] = useState<number>(THRESHOLD_MIN);
  // null = Unassigned. User id of the project lead (#966).
  const [lead, setLead] = useState<string | null>(null);
  // null = inherit the program/workspace default (ADR-0116, #1106).
  const [iterationLabel, setIterationLabel] = useState<string | null>(null);
  // null = inherit the program/workspace value (ADR-0135).
  const [publicSharing, setPublicSharing] = useState<boolean | null>(null);
  const [allowGuests, setAllowGuests] = useState<boolean | null>(null);
  // null = inherit the program/workspace value (ADR-0144, issue 1232).
  const [mcHistoryEnabled, setMcHistoryEnabled] = useState<boolean | null>(null);
  const [mcHistoryRetentionCap, setMcHistoryRetentionCap] = useState<number | null>(null);
  const [mcHistoryAttributionAudience, setMcHistoryAttributionAudience] =
    useState<MCAttributionAudience | null>(null);
  // null = inherit the program/workspace value (ADR-0151, issue 1254).
  const [taskDurationChangePercentPolicy, setTaskDurationChangePercentPolicy] =
    useState<DurationChangePercentPolicy | null>(null);

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
  const [initialStartDate, setInitialStartDate] = useState('');
  const [initialStatusDate, setInitialStatusDate] = useState<string | null>(null);
  const [initialPrioritizationModel, setInitialPrioritizationModel] =
    useState<PrioritizationModel>('none');
  const [initialStaleThresholdDays, setInitialStaleThresholdDays] = useState<number>(THRESHOLD_MIN);
  const [initialEndShiftThresholdDays, setInitialEndShiftThresholdDays] =
    useState<number>(THRESHOLD_MIN);
  const [initialLead, setInitialLead] = useState<string | null>(null);
  const [initialIterationLabel, setInitialIterationLabel] = useState<string | null>(null);
  const [initialPublicSharing, setInitialPublicSharing] = useState<boolean | null>(null);
  const [initialAllowGuests, setInitialAllowGuests] = useState<boolean | null>(null);
  const [initialMcHistoryEnabled, setInitialMcHistoryEnabled] = useState<boolean | null>(null);
  const [initialMcHistoryRetentionCap, setInitialMcHistoryRetentionCap] = useState<number | null>(
    null,
  );
  const [initialMcHistoryAttributionAudience, setInitialMcHistoryAttributionAudience] =
    useState<MCAttributionAudience | null>(null);
  const [
    initialTaskDurationChangePercentPolicy,
    setInitialTaskDurationChangePercentPolicy,
  ] = useState<DurationChangePercentPolicy | null>(null);

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
    setStartDate(project.start_date);
    setStatusDate(project.status_date ?? null);
    setPrioritizationModel(project.prioritization_model);
    setStaleThresholdDays(project.stale_task_threshold_days);
    setEndShiftThresholdDays(project.end_date_shift_threshold_days);
    setLead(project.lead ?? null);
    setIterationLabel(project.iteration_label ?? null);
    setPublicSharing(project.public_sharing ?? null);
    setAllowGuests(project.allow_guests ?? null);
    setMcHistoryEnabled(project.mc_history_enabled ?? null);
    setMcHistoryRetentionCap(project.mc_history_retention_cap ?? null);
    setMcHistoryAttributionAudience(project.mc_history_attribution_audience ?? null);
    setTaskDurationChangePercentPolicy(project.task_duration_change_percent_policy ?? null);
    setInitialName(project.name);
    setInitialDescription(project.description ?? '');
    setInitialCode(project.code);
    setInitialHealth(project.health);
    setInitialVisibility(project.visibility);
    setInitialTimezone(project.timezone);
    setInitialDefaultView(project.default_view);
    setInitialStartDate(project.start_date);
    setInitialStatusDate(project.status_date ?? null);
    setInitialPrioritizationModel(project.prioritization_model);
    setInitialStaleThresholdDays(project.stale_task_threshold_days);
    setInitialEndShiftThresholdDays(project.end_date_shift_threshold_days);
    setInitialLead(project.lead ?? null);
    setInitialIterationLabel(project.iteration_label ?? null);
    setInitialPublicSharing(project.public_sharing ?? null);
    setInitialAllowGuests(project.allow_guests ?? null);
    setInitialMcHistoryEnabled(project.mc_history_enabled ?? null);
    setInitialMcHistoryRetentionCap(project.mc_history_retention_cap ?? null);
    setInitialMcHistoryAttributionAudience(project.mc_history_attribution_audience ?? null);
    setInitialTaskDurationChangePercentPolicy(project.task_duration_change_percent_policy ?? null);
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
      start_date: startDate,
      status_date: statusDate,
      prioritization_model: prioritizationModel,
      stale_task_threshold_days: staleThresholdDays,
      end_date_shift_threshold_days: endShiftThresholdDays,
      lead,
      iteration_label: iterationLabel,
      public_sharing: publicSharing,
      allow_guests: allowGuests,
      mc_history_enabled: mcHistoryEnabled,
      mc_history_retention_cap: mcHistoryRetentionCap,
      mc_history_attribution_audience: mcHistoryAttributionAudience,
      task_duration_change_percent_policy: taskDurationChangePercentPolicy,
    }),
    [
      name,
      description,
      code,
      health,
      visibility,
      timezone,
      defaultView,
      startDate,
      statusDate,
      prioritizationModel,
      staleThresholdDays,
      endShiftThresholdDays,
      lead,
      iterationLabel,
      publicSharing,
      allowGuests,
      mcHistoryEnabled,
      mcHistoryRetentionCap,
      mcHistoryAttributionAudience,
      taskDurationChangePercentPolicy,
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
      start_date: initialStartDate,
      status_date: initialStatusDate,
      prioritization_model: initialPrioritizationModel,
      stale_task_threshold_days: initialStaleThresholdDays,
      end_date_shift_threshold_days: initialEndShiftThresholdDays,
      lead: initialLead,
      iteration_label: initialIterationLabel,
      public_sharing: initialPublicSharing,
      allow_guests: initialAllowGuests,
      mc_history_enabled: initialMcHistoryEnabled,
      mc_history_retention_cap: initialMcHistoryRetentionCap,
      mc_history_attribution_audience: initialMcHistoryAttributionAudience,
      task_duration_change_percent_policy: initialTaskDurationChangePercentPolicy,
    }),
    [
      initialName,
      initialDescription,
      initialCode,
      initialHealth,
      initialVisibility,
      initialTimezone,
      initialDefaultView,
      initialStartDate,
      initialStatusDate,
      initialPrioritizationModel,
      initialStaleThresholdDays,
      initialEndShiftThresholdDays,
      initialLead,
      initialIterationLabel,
      initialPublicSharing,
      initialAllowGuests,
      initialMcHistoryEnabled,
      initialMcHistoryRetentionCap,
      initialMcHistoryAttributionAudience,
      initialTaskDurationChangePercentPolicy,
    ],
  );

  const handleSave = useCallback(async () => {
    // start_date is required (#2018) — an accidentally-cleared native date input
    // normalizes back to the last saved value rather than 400-ing the whole batch,
    // mirroring the iteration_label empty→null normalization below.
    const savedStartDate = startDate || initialStartDate;
    await updateProject.mutateAsync({
      name,
      description,
      code,
      health,
      visibility,
      timezone,
      default_view: defaultView,
      start_date: savedStartDate,
      // null = "Today (dynamic)"; a string = a fixed forecasting data date (ADR-0132).
      status_date: statusDate,
      prioritization_model: prioritizationModel,
      stale_task_threshold_days: staleThresholdDays,
      end_date_shift_threshold_days: endShiftThresholdDays,
      lead,
      // null clears the override (inherit); a blank custom string normalizes to null
      // too — "inherit" is the explicit null and the serializer rejects empty strings
      // (ADR-0116).
      iteration_label: iterationLabel === null ? null : iterationLabel.trim() || null,
      // null clears the sharing override so the project inherits program/workspace (ADR-0135).
      public_sharing: publicSharing,
      allow_guests: allowGuests,
      // null clears the forecast-history override so the project inherits program/workspace (ADR-0144).
      mc_history_enabled: mcHistoryEnabled,
      mc_history_retention_cap: mcHistoryRetentionCap,
      mc_history_attribution_audience: mcHistoryAttributionAudience,
      // null clears the duration-change override so the project inherits program/workspace (ADR-0151).
      task_duration_change_percent_policy: taskDurationChangePercentPolicy,
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
    setStartDate(savedStartDate);
    setInitialStartDate(savedStartDate);
    setInitialStatusDate(statusDate);
    setInitialPrioritizationModel(prioritizationModel);
    setInitialStaleThresholdDays(staleThresholdDays);
    setInitialEndShiftThresholdDays(endShiftThresholdDays);
    setInitialLead(lead);
    setInitialIterationLabel(savedIterationLabel);
    setInitialPublicSharing(publicSharing);
    setInitialAllowGuests(allowGuests);
    setInitialMcHistoryEnabled(mcHistoryEnabled);
    setInitialMcHistoryRetentionCap(mcHistoryRetentionCap);
    setInitialMcHistoryAttributionAudience(mcHistoryAttributionAudience);
    setInitialTaskDurationChangePercentPolicy(taskDurationChangePercentPolicy);
  }, [
    updateProject,
    name,
    description,
    code,
    health,
    visibility,
    timezone,
    defaultView,
    startDate,
    initialStartDate,
    statusDate,
    prioritizationModel,
    staleThresholdDays,
    endShiftThresholdDays,
    lead,
    iterationLabel,
    publicSharing,
    allowGuests,
    mcHistoryEnabled,
    mcHistoryRetentionCap,
    mcHistoryAttributionAudience,
    taskDurationChangePercentPolicy,
  ]);

  const handleReset = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    setCode(initialCode);
    setHealth(initialHealth);
    setVisibility(initialVisibility);
    setTimezone(initialTimezone);
    setDefaultView(initialDefaultView);
    setStartDate(initialStartDate);
    setStatusDate(initialStatusDate);
    setPrioritizationModel(initialPrioritizationModel);
    setStaleThresholdDays(initialStaleThresholdDays);
    setEndShiftThresholdDays(initialEndShiftThresholdDays);
    setLead(initialLead);
    setIterationLabel(initialIterationLabel);
    setPublicSharing(initialPublicSharing);
    setAllowGuests(initialAllowGuests);
    setMcHistoryEnabled(initialMcHistoryEnabled);
    setMcHistoryRetentionCap(initialMcHistoryRetentionCap);
    setMcHistoryAttributionAudience(initialMcHistoryAttributionAudience);
    setTaskDurationChangePercentPolicy(initialTaskDurationChangePercentPolicy);
  }, [
    initialName,
    initialDescription,
    initialCode,
    initialHealth,
    initialVisibility,
    initialTimezone,
    initialDefaultView,
    initialStartDate,
    initialStatusDate,
    initialPrioritizationModel,
    initialStaleThresholdDays,
    initialEndShiftThresholdDays,
    initialLead,
    initialIterationLabel,
    initialPublicSharing,
    initialAllowGuests,
    initialMcHistoryEnabled,
    initialMcHistoryRetentionCap,
    initialMcHistoryAttributionAudience,
    initialTaskDurationChangePercentPolicy,
  ]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project,
  });

  // The working calendar is now read-only here (ADR-0441, #2009): the base FK plus
  // holiday overlays are composed on the Working calendars sub-page, the single
  // write surface. This row is a summary that names the resolved calendar and its
  // provenance, and links there. `effective_calendar` is the resolved calendar
  // (the override itself when `calendar_source === 'project'`, else the inherited
  // one); `calendar_source` is optional (a stale cached read from before #1987),
  // so its absence yields no breadcrumb rather than guessing a scope.
  const calendarSource = project?.calendar_source ?? null;
  const calendarIsOverride = calendarSource === 'project';
  const calendarName = project?.effective_calendar?.name ?? null;
  const calendarBreadcrumb =
    calendarSource && !calendarIsOverride
      ? calendarSourceCopy(calendarSource, project?.effective_calendar ?? null)
      : null;
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
              className="w-full max-w-[420px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
              className="w-[140px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </FieldRow>

          <FieldRow label="Description" hint="One paragraph. Shown on the overview page.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              aria-label="Description"
              className="w-full max-w-[540px] px-2.5 py-2 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
                    'px-3 py-1 rounded-control border text-[12px] font-medium transition-colors',
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

          {/* Visibility is stored and rendered but authorization never reads it —
              access is membership-scoped for every project regardless of this
              value (#2011). Rather than present a control that gives false
              assurance (PRIVATE promises a distinction that isn't implemented),
              the whole control is disabled with a "not yet enforced" note until
              real queryset/permission enforcement ships. Re-enable both radios
              and drop the note then. TODO(#2066): enforce WORKSPACE vs PRIVATE. */}
          <FieldRow
            label="Visibility"
            hint="Workspace = anyone signed in can see this project. Private = invited only."
          >
            <div className="flex flex-col gap-3">
              {VISIBILITY_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className="flex items-center gap-3 cursor-not-allowed"
                  aria-disabled="true"
                >
                  <span
                    className={[
                      'w-4 h-4 rounded-full border-2 shrink-0 transition-colors',
                      visibility === opt.id
                        ? 'border-neutral-text-disabled bg-neutral-text-disabled'
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
                    disabled
                    readOnly
                    aria-describedby="project-visibility-not-enforced"
                    className="sr-only"
                  />
                  <span className="text-[13px] font-medium text-neutral-text-disabled">
                    {opt.label}
                  </span>
                  <span className="text-[12px] text-neutral-text-disabled">· {opt.hint}</span>
                </label>
              ))}
              <p
                id="project-visibility-not-enforced"
                className="text-[12px] text-neutral-text-secondary"
              >
                Coming soon — access is currently membership-scoped for all projects, so this
                setting is not enforced yet.
              </p>
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

          {/* Forecast history (ADR-0144, issue 1232). Inherits the program or workspace
              settings unless this project overrides. */}
          <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
            Forecast history
          </h3>

          <FieldRow
            label="Keep Monte Carlo run history"
            hint={`${MC_HISTORY_HINT} Inherits the program or workspace setting unless you override it here.`}
          >
            <InheritableToggleField
              value={mcHistoryEnabled}
              onChange={setMcHistoryEnabled}
              inherited={project?.inherited_mc_history_enabled ?? true}
              inheritFromLabel="the program or workspace default"
              scopeNoun="project"
              onLabel="On"
              offLabel="Off"
              ariaLabel="Keep Monte Carlo run history"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Run history limit"
            hint="The most recent runs kept for this project. Older runs are pruned. Inherits the program or workspace setting unless you override it here."
          >
            <InheritableNumberField
              value={mcHistoryRetentionCap}
              onChange={setMcHistoryRetentionCap}
              inherited={project?.inherited_mc_history_retention_cap ?? 100}
              inheritFromLabel="the program or workspace default"
              min={MC_HISTORY_RETENTION_MIN}
              max={MC_HISTORY_RETENTION_MAX}
              ariaLabel="Run history limit"
              overrideHint={`Between ${MC_HISTORY_RETENTION_MIN} and ${MC_HISTORY_RETENTION_MAX} runs.`}
              scopeNoun="project"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Run attribution visible to"
            hint={`${MC_ATTRIBUTION_HINT} Inherits the program or workspace setting unless you override it here.`}
          >
            <InheritableSelectField
              value={mcHistoryAttributionAudience}
              onChange={setMcHistoryAttributionAudience}
              inherited={project?.inherited_mc_history_attribution_audience ?? 'ADMIN_OWNER'}
              options={MC_ATTRIBUTION_OPTIONS}
              inheritFromLabel="the program or workspace default"
              ariaLabel="Run attribution visible to"
              scopeNoun="project"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Duration change &rarr; percent complete"
            hint={`${DURATION_CHANGE_POLICY_HINT} Inherits the program or workspace setting unless you override it here.`}
          >
            <InheritableSelectField
              value={taskDurationChangePercentPolicy}
              onChange={setTaskDurationChangePercentPolicy}
              inherited={project?.inherited_task_duration_change_percent_policy ?? 'keep'}
              options={DURATION_CHANGE_POLICY_OPTIONS}
              inheritFromLabel="the program or workspace default"
              ariaLabel="Duration change percent policy"
              scopeNoun="project"
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
                className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
            hint="The base calendar and holiday overlays are composed on the Working calendars page — the single place they're edited (ADR-0441)."
          >
            {/* Read-only summary + link (#2009). The base FK used to be editable here
                AND on the Working calendars page, so a save here could silently clobber
                that page's overlay composition. The base is now written only there;
                this row names the resolved calendar and its provenance and links across.
                A <Link> is not a form control, so the enclosing StubFieldset (which
                disables inputs below Admin) leaves it navigable for every role. */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  {calendarName ?? 'System default (Mon–Fri, 8h/day)'}
                </span>
                <span className="shrink-0 rounded border border-neutral-border/55 bg-neutral-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
                  {calendarIsOverride ? 'Override' : 'Inherited'}
                </span>
              </div>
              {calendarBreadcrumb && (
                <p className="text-[12px] text-neutral-text-secondary">{calendarBreadcrumb}</p>
              )}
              <Link
                to={`/projects/${projectId}/settings/calendars`}
                className="inline-flex w-fit items-center gap-1 text-[12.5px] font-medium text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
              >
                Manage in Working calendars
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </FieldRow>

          <FieldRow label="Default view">
            <div className="relative inline-block w-[200px]">
              <select
                value={defaultView}
                onChange={(e) => setDefaultView(e.target.value as ProjectDefaultView)}
                aria-label="Default view"
                className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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

          {/* Scheduling & forecasting (#2018). start_date is the schedule anchor;
              status_date is the ADR-0132 data date Monte Carlo forecasts from. */}
          <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
            Scheduling &amp; forecasting
          </h3>

          <FieldRow
            label="Start date"
            hint="The schedule's anchor. Moving it shifts dated work and recomputes the critical path."
          >
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label="Start date"
              className="w-[170px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </FieldRow>

          <FieldRow
            label="Status date (data date)"
            hint="Forecasts and % complete are measured as of this date. Leave on Today to always use the current date (ADR-0132)."
          >
            {/* null = "Today (dynamic)"; picking a date arms a fixed anchor. Mirrors the
                inherit/override toggle pattern used elsewhere on this page. */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStatusDate(null)}
                aria-pressed={statusDate === null}
                className={[
                  'px-3 py-1 rounded-control border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  statusDate === null
                    ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                Today (dynamic)
              </button>
              <input
                type="date"
                value={statusDate ?? ''}
                onChange={(e) => setStatusDate(e.target.value === '' ? null : e.target.value)}
                aria-label="Fixed status date"
                className="w-[170px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
            </div>
          </FieldRow>

          {/* Backlog scoring (ADR-0105, #2018). estimation_mode lives on the
              Methodology page (it's Scheduler-editable, unlike this Admin-only page). */}
          <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
            Backlog scoring
          </h3>

          <FieldRow
            label="Backlog scoring model"
            hint="How backlog items are scored for ranking. None hides the scoring inputs — pure manual order (ADR-0105)."
          >
            <div className="relative inline-block w-[200px]">
              <select
                value={prioritizationModel}
                onChange={(e) => setPrioritizationModel(e.target.value as PrioritizationModel)}
                aria-label="Backlog scoring model"
                className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {PRIORITIZATION_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
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
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
          </FieldRow>

          <p className="text-[12px] text-neutral-text-secondary -mt-1 mb-1">
            Who may write estimates is set on the Methodology page.
          </p>

          {/* Notification thresholds (ADR-0200 / #1911, #2018). Both validated 1–365. */}
          <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
            Notification thresholds
          </h3>

          <FieldRow
            label="Stale-task nudge after"
            hint="Warn when a task's status hasn't changed in this many days. Between 1 and 365."
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                value={staleThresholdDays}
                onChange={(e) => setStaleThresholdDays(clampThreshold(e.target.value))}
                aria-label="Stale-task nudge after"
                className="w-[90px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <span className="text-[12px] text-neutral-text-secondary">days</span>
            </div>
          </FieldRow>

          <FieldRow
            label="Notify on end-date shift of"
            hint="Alert the project lead when a recompute moves the finish by at least this many days. Between 1 and 365."
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                value={endShiftThresholdDays}
                onChange={(e) => setEndShiftThresholdDays(clampThreshold(e.target.value))}
                aria-label="Notify on end-date shift of"
                className="w-[90px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <span className="text-[12px] text-neutral-text-secondary">days</span>
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
      <DangerZoneLink to="#lifecycle" />
    </div>
  );
}
