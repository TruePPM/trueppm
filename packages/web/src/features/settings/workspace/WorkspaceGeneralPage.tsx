import { useCallback, useEffect, useId, useState } from 'react';
import { DangerZoneLink } from '../components/DangerZoneLink';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { FiscalYearStartField } from '../components/FiscalYearStartField';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { IterationLabelField } from '../project/IterationLabelField';
import { WorkspaceLogoField } from './WorkspaceLogoField';
import { Toggle } from '../components/Toggle';
import {
  MC_ATTRIBUTION_OPTIONS,
  MC_ATTRIBUTION_HINT,
  MC_HISTORY_HINT,
} from '../forecastHistory';
import { DURATION_CHANGE_POLICY_OPTIONS, DURATION_CHANGE_POLICY_HINT } from '../durationChangePolicy';
import type {
  DurationChangePercentPolicy,
  MCAttributionAudience,
  MCHistoryOverridePolicy,
} from '@/api/types';
import { MC_HISTORY_RETENTION_MAX, MC_HISTORY_RETENTION_MIN } from '@/api/types';

/** Cascade policy for the workspace iteration label (ADR-0116, #1106). */
type IterationLabelPolicy = 'inherit' | 'suggest' | 'enforce';

/** Clamp the retention cap into the server-enforced [1, 500] range. */
function clampRetention(n: number): number {
  if (Number.isNaN(n)) return MC_HISTORY_RETENTION_MIN;
  return Math.min(MC_HISTORY_RETENTION_MAX, Math.max(MC_HISTORY_RETENTION_MIN, Math.round(n)));
}

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'UTC',
];

const DEFAULT_VIEW_OPTIONS = ['Overview', 'Board', 'Schedule', 'WBS', 'Table', 'Calendar'];

const SELECT_CLASS =
  'h-8 pl-2.5 pr-7 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

/** Workspace > General settings page. */
export function WorkspaceGeneralPage() {
  const { data: ws, isLoading } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();
  const timezoneId = useId();
  const defaultViewId = useId();

  // Page-local form state — initialised from the loaded settings.
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [fiscalMonth, setFiscalMonth] = useState(1);
  const [fiscalDay, setFiscalDay] = useState(1);
  const [defaultProjectView, setDefaultProjectView] = useState('');
  const [workWeek, setWorkWeek] = useState<boolean[]>([true, true, true, true, true, false, false]);
  const [allowGuests, setAllowGuests] = useState(false);
  const [publicSharing, setPublicSharing] = useState(false);
  const [iterationLabel, setIterationLabel] = useState('Sprint');
  const [iterationLabelPolicy, setIterationLabelPolicy] = useState<IterationLabelPolicy>('suggest');
  // Forecast-history config (ADR-0144, issue 1232) — workspace is the non-null root.
  const [mcHistoryEnabled, setMcHistoryEnabled] = useState(true);
  const [mcHistoryRetentionCap, setMcHistoryRetentionCap] = useState(100);
  const [mcHistoryAttributionAudience, setMcHistoryAttributionAudience] =
    useState<MCAttributionAudience>('ADMIN_OWNER');
  const [mcHistoryOverridePolicy, setMcHistoryOverridePolicy] =
    useState<MCHistoryOverridePolicy>('allow');
  // Duration-change percent policy (ADR-0151, issue 1254) — workspace is the non-null root.
  const [taskDurationChangePercentPolicy, setTaskDurationChangePercentPolicy] =
    useState<DurationChangePercentPolicy>('keep');
  const [taskDurationChangePercentOverridePolicy, setTaskDurationChangePercentOverridePolicy] =
    useState<'inherit' | 'suggest' | 'enforce'>('suggest');

  // Last-saved snapshot — bumped after a successful PATCH so useDirtyForm
  // can detect whether the current local state has diverged again.
  const [initial, setInitial] = useState({
    name: '',
    timezone: '',
    fiscalMonth: 1,
    fiscalDay: 1,
    defaultProjectView: '',
    workWeek: [true, true, true, true, true, false, false] as boolean[],
    allowGuests: false,
    publicSharing: false,
    iterationLabel: 'Sprint',
    iterationLabelPolicy: 'suggest' as IterationLabelPolicy,
    mcHistoryEnabled: true,
    mcHistoryRetentionCap: 100,
    mcHistoryAttributionAudience: 'ADMIN_OWNER' as MCAttributionAudience,
    mcHistoryOverridePolicy: 'allow' as MCHistoryOverridePolicy,
    taskDurationChangePercentPolicy: 'keep' as DurationChangePercentPolicy,
    taskDurationChangePercentOverridePolicy: 'suggest' as 'inherit' | 'suggest' | 'enforce',
  });

  // Seed local state once the query resolves (or re-resolves after invalidation).
  useEffect(() => {
    if (!ws) return;
    const snap = {
      name: ws.name,
      timezone: ws.timezone,
      fiscalMonth: ws.fiscalYearStartMonth,
      fiscalDay: ws.fiscalYearStartDay,
      defaultProjectView: ws.defaultProjectView,
      workWeek: ws.workWeek,
      allowGuests: ws.allowGuests,
      publicSharing: ws.publicSharing,
      iterationLabel: ws.iterationLabel,
      iterationLabelPolicy: ws.iterationLabelOverridePolicy,
      mcHistoryEnabled: ws.mcHistoryEnabled,
      mcHistoryRetentionCap: ws.mcHistoryRetentionCap,
      mcHistoryAttributionAudience: ws.mcHistoryAttributionAudience,
      mcHistoryOverridePolicy: ws.mcHistoryOverridePolicy,
      taskDurationChangePercentPolicy: ws.taskDurationChangePercentPolicy,
      taskDurationChangePercentOverridePolicy: ws.taskDurationChangePercentOverridePolicy,
    };
    setName(snap.name);
    setTimezone(snap.timezone);
    setFiscalMonth(snap.fiscalMonth);
    setFiscalDay(snap.fiscalDay);
    setDefaultProjectView(snap.defaultProjectView);
    setWorkWeek(snap.workWeek);
    setAllowGuests(snap.allowGuests);
    setPublicSharing(snap.publicSharing);
    setIterationLabel(snap.iterationLabel);
    setIterationLabelPolicy(snap.iterationLabelPolicy);
    setMcHistoryEnabled(snap.mcHistoryEnabled);
    setMcHistoryRetentionCap(snap.mcHistoryRetentionCap);
    setMcHistoryAttributionAudience(snap.mcHistoryAttributionAudience);
    setMcHistoryOverridePolicy(snap.mcHistoryOverridePolicy);
    setTaskDurationChangePercentPolicy(snap.taskDurationChangePercentPolicy);
    setTaskDurationChangePercentOverridePolicy(snap.taskDurationChangePercentOverridePolicy);
    setInitial(snap);
  }, [ws]);

  const values = {
    name,
    timezone,
    fiscalMonth,
    fiscalDay,
    defaultProjectView,
    workWeek,
    allowGuests,
    publicSharing,
    iterationLabel,
    iterationLabelPolicy,
    mcHistoryEnabled,
    mcHistoryRetentionCap,
    mcHistoryAttributionAudience,
    mcHistoryOverridePolicy,
    taskDurationChangePercentPolicy,
    taskDurationChangePercentOverridePolicy,
  };

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({
      name,
      timezone,
      fiscalYearStartMonth: fiscalMonth,
      fiscalYearStartDay: fiscalDay,
      defaultProjectView,
      workWeek,
      allowGuests,
      publicSharing,
      iterationLabel,
      iterationLabelOverridePolicy: iterationLabelPolicy,
      mcHistoryEnabled,
      mcHistoryRetentionCap: clampRetention(mcHistoryRetentionCap),
      mcHistoryAttributionAudience,
      mcHistoryOverridePolicy,
      taskDurationChangePercentPolicy,
      taskDurationChangePercentOverridePolicy,
    });
    // Bump the saved snapshot so dirty goes false immediately.
    setInitial({
      name,
      timezone,
      fiscalMonth,
      fiscalDay,
      defaultProjectView,
      workWeek,
      allowGuests,
      publicSharing,
      iterationLabel,
      iterationLabelPolicy,
      mcHistoryEnabled,
      mcHistoryRetentionCap: clampRetention(mcHistoryRetentionCap),
      mcHistoryAttributionAudience,
      mcHistoryOverridePolicy,
      taskDurationChangePercentPolicy,
      taskDurationChangePercentOverridePolicy,
    });
  }, [
    name,
    timezone,
    fiscalMonth,
    fiscalDay,
    defaultProjectView,
    workWeek,
    allowGuests,
    publicSharing,
    iterationLabel,
    iterationLabelPolicy,
    mcHistoryEnabled,
    mcHistoryRetentionCap,
    mcHistoryAttributionAudience,
    mcHistoryOverridePolicy,
    taskDurationChangePercentPolicy,
    taskDurationChangePercentOverridePolicy,
    updateSettings,
  ]);

  const onReset = useCallback(() => {
    setName(initial.name);
    setTimezone(initial.timezone);
    setFiscalMonth(initial.fiscalMonth);
    setFiscalDay(initial.fiscalDay);
    setDefaultProjectView(initial.defaultProjectView);
    setWorkWeek(initial.workWeek);
    setAllowGuests(initial.allowGuests);
    setPublicSharing(initial.publicSharing);
    setIterationLabel(initial.iterationLabel);
    setIterationLabelPolicy(initial.iterationLabelPolicy);
    setMcHistoryEnabled(initial.mcHistoryEnabled);
    setMcHistoryRetentionCap(initial.mcHistoryRetentionCap);
    setMcHistoryAttributionAudience(initial.mcHistoryAttributionAudience);
    setMcHistoryOverridePolicy(initial.mcHistoryOverridePolicy);
    setTaskDurationChangePercentPolicy(initial.taskDurationChangePercentPolicy);
    setTaskDurationChangePercentOverridePolicy(initial.taskDurationChangePercentOverridePolicy);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: true });

  function toggleDay(i: number) {
    setWorkWeek((prev) => prev.map((on, j) => (j === i ? !on : on)));
  }

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Workspace identity, defaults, and conventions that every project inherits."
        action={
          // Workspace-settings change history is an audit trail — an Enterprise
          // capability (enterprise-check 2026-05-27). The button is disabled on
          // the OSS surface; the EnterpriseBadge (community-only) is the reachable
          // upsell link. The enterprise build wires the real action via its slot.
          <span className="inline-flex items-center">
            <button
              type="button"
              disabled
              title="Workspace change history is available in TruePPM Enterprise"
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              View change history
            </button>
            <EnterpriseBadge />
          </span>
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        <FieldRow label="Workspace name" hint="Shown in the top bar and on every export.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full max-w-[420px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Subdomain" hint="Members sign in here.">
          <div className="flex items-center h-8 rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 w-full max-w-[420px] gap-1 text-[13px]">
            <span className="text-neutral-text-secondary shrink-0">https://</span>
            <span className="font-mono text-neutral-text-primary">{ws.subdomain}</span>
            <span className="text-neutral-text-secondary shrink-0">.trueppm.app</span>
          </div>
        </FieldRow>

        <FieldRow label="Workspace logo" hint="Square PNG or WebP. 256×256 minimum. Max 2 MB.">
          <WorkspaceLogoField logoUrl={ws.logoUrl} name={ws.name} />
        </FieldRow>

        <FieldRow
          label="Default timezone"
          hint="Used for due dates and Gantt rendering when a project doesn't override."
        >
          <label htmlFor={timezoneId} className="sr-only">
            Default timezone
          </label>
          <select
            id={timezoneId}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className={`${SELECT_CLASS} w-[280px]`}
            style={SELECT_STYLE}
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          label="Fiscal year starts"
          hint="Controls how quarters are labeled across the workspace, including the Schedule timeline."
        >
          <FiscalYearStartField
            month={fiscalMonth}
            day={fiscalDay}
            onChange={(m, d) => {
              setFiscalMonth(m);
              setFiscalDay(d);
            }}
          />
        </FieldRow>

        <FieldRow label="Work week" hint="Non-working days are skipped by the scheduler.">
          <div className="flex gap-1" role="group" aria-label="Work week days">
            {DAYS.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                aria-pressed={workWeek[i]}
                aria-label={DAY_NAMES[i]}
                className={[
                  'w-8 h-8 rounded-control text-[12px] font-semibold border transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  workWeek[i]
                    ? 'bg-sage-500 text-navy-900 border-sage-600'
                    : 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border hover:border-neutral-text-disabled',
                ].join(' ')}
              >
                {d}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label="Default project view"
          hint="Where members land when they open a project for the first time."
        >
          <label htmlFor={defaultViewId} className="sr-only">
            Default project view
          </label>
          <select
            id={defaultViewId}
            value={defaultProjectView}
            onChange={(e) => setDefaultProjectView(e.target.value)}
            className={`${SELECT_CLASS} w-[180px]`}
            style={SELECT_STYLE}
          >
            {DEFAULT_VIEW_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          label="Iteration terminology"
          hint="The word every project uses for its time-boxed iteration container. Programs and projects inherit this unless they set their own."
        >
          <div className="flex flex-col gap-3">
            <IterationLabelField value={iterationLabel} onChange={setIterationLabel} />
            <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
              <legend className="text-[12px] font-medium text-neutral-text-secondary mb-0.5">
                Programs &amp; projects
              </legend>
              <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
                <input
                  type="radio"
                  name="iteration-policy"
                  checked={iterationLabelPolicy !== 'enforce'}
                  onChange={() => setIterationLabelPolicy('suggest')}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                May override this default
              </label>
              {/* ENFORCE locks the term so lower scopes cannot override it — an
                  Enterprise capability (ADR-0116). Disabled on the OSS surface; the
                  EnterpriseBadge (community-only) is the reachable upsell link. */}
              <span className="inline-flex items-center gap-1.5">
                <label className="flex items-center gap-2 text-[13px] text-neutral-text-disabled cursor-not-allowed">
                  <input
                    type="radio"
                    name="iteration-policy"
                    checked={iterationLabelPolicy === 'enforce'}
                    disabled
                    readOnly
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                  Enforce workspace-wide
                </label>
                <EnterpriseBadge />
              </span>
            </fieldset>
          </div>
        </FieldRow>

        <FieldRow label="Holiday calendar">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-chip bg-brand-primary-light text-brand-primary text-[12px] font-medium">
              US federal · 2026
            </span>
            {/* Holiday-calendar management depends on composable calendars (#906);
                deferred out of #969 until that ships. */}
            <button
              type="button"
              disabled
              title="Adding a holiday calendar isn't available yet — tracked in #906"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-control border border-neutral-border text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              + Add calendar
            </button>
          </div>
        </FieldRow>

        <FieldRow
          label="Allow guests"
          hint="Guests are external collaborators (vendors, auditors). Limited to projects they're invited to."
        >
          <Toggle
            on={allowGuests}
            onChange={setAllowGuests}
            ariaLabel="Allow guest access"
            hint="3 guests currently in the workspace"
          />
        </FieldRow>

        <FieldRow
          label="Public sharing"
          hint="Anyone with the link can view selected reports — no sign-in required."
        >
          <Toggle
            on={publicSharing}
            onChange={setPublicSharing}
            ariaLabel="Allow public link sharing"
          />
        </FieldRow>

        {/* Forecast history (ADR-0144, issue 1232). Workspace is the non-null root of the
            Workspace → Program → Project inheritance chain; programs and projects
            inherit these unless they override. */}
        <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
          Forecast history
        </h3>

        <FieldRow label="Keep Monte Carlo run history" hint={MC_HISTORY_HINT}>
          <Toggle
            on={mcHistoryEnabled}
            onChange={setMcHistoryEnabled}
            ariaLabel="Keep Monte Carlo run history"
            onLabel="On"
            offLabel="Off"
          />
        </FieldRow>

        <FieldRow
          label="Run history limit"
          hint="The most recent runs kept per project. Older runs are pruned. Maximum 500."
        >
          <div className="flex flex-col gap-1">
            <input
              type="number"
              min={MC_HISTORY_RETENTION_MIN}
              max={MC_HISTORY_RETENTION_MAX}
              value={mcHistoryRetentionCap}
              aria-label="Run history limit"
              onChange={(e) => setMcHistoryRetentionCap(clampRetention(e.target.valueAsNumber))}
              className="w-[120px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary"
            />
            <span className="text-[12px] text-neutral-text-secondary">
              Between {MC_HISTORY_RETENTION_MIN} and {MC_HISTORY_RETENTION_MAX} runs.
            </span>
          </div>
        </FieldRow>

        <FieldRow label="Run attribution visible to" hint={MC_ATTRIBUTION_HINT}>
          <label htmlFor={`${defaultViewId}-mc-attr`} className="sr-only">
            Run attribution visible to
          </label>
          <select
            id={`${defaultViewId}-mc-attr`}
            value={mcHistoryAttributionAudience}
            onChange={(e) =>
              setMcHistoryAttributionAudience(e.target.value as MCAttributionAudience)
            }
            className={`${SELECT_CLASS} w-[220px]`}
            style={SELECT_STYLE}
          >
            {MC_ATTRIBUTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow label="Duration change &rarr; percent complete" hint={DURATION_CHANGE_POLICY_HINT}>
          <label htmlFor={`${defaultViewId}-duration-change`} className="sr-only">
            Duration change to percent complete
          </label>
          <select
            id={`${defaultViewId}-duration-change`}
            value={taskDurationChangePercentPolicy}
            onChange={(e) =>
              setTaskDurationChangePercentPolicy(e.target.value as DurationChangePercentPolicy)
            }
            className={`${SELECT_CLASS} w-[220px]`}
            style={SELECT_STYLE}
          >
            {DURATION_CHANGE_POLICY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          label="Program &amp; project overrides"
          hint="Whether programs and projects may choose their own duration-change policy."
        >
          <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
            <legend className="sr-only">Duration-change override policy</legend>
            <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
              <input
                type="radio"
                name="duration-change-policy"
                checked={taskDurationChangePercentOverridePolicy !== 'enforce'}
                onChange={() => setTaskDurationChangePercentOverridePolicy('suggest')}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
              Programs and projects can choose their own policy.
            </label>
            {/* ENFORCE pins the workspace policy so lower scopes cannot override — an
                Enterprise capability (ADR-0151). Disabled on the OSS surface; the
                EnterpriseBadge (community-only) is the reachable upsell link. OSS
                stores the value but never enforces the lock downstream. */}
            <span className="inline-flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-[13px] text-neutral-text-disabled cursor-not-allowed">
                <input
                  type="radio"
                  name="duration-change-policy"
                  checked={taskDurationChangePercentOverridePolicy === 'enforce'}
                  disabled
                  readOnly
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                Force this policy everywhere; overrides are ignored.
              </label>
              <EnterpriseBadge />
            </span>
          </fieldset>
        </FieldRow>

        <FieldRow
          label="Programs &amp; projects"
          hint="Whether programs and projects may override these forecast-history settings."
        >
          <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
            <legend className="sr-only">Forecast-history override policy</legend>
            <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
              <input
                type="radio"
                name="mc-history-policy"
                checked={mcHistoryOverridePolicy !== 'lock'}
                onChange={() => setMcHistoryOverridePolicy('allow')}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
              May override these settings
            </label>
            {/* LOCK pins the workspace values so lower scopes cannot override — an
                Enterprise capability (ADR-0144). Disabled on the OSS surface; the
                EnterpriseBadge (community-only) is the reachable upsell link. OSS
                stores the value but never enforces the lock downstream. */}
            <span className="inline-flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-[13px] text-neutral-text-disabled cursor-not-allowed">
                <input
                  type="radio"
                  name="mc-history-policy"
                  checked={mcHistoryOverridePolicy === 'lock'}
                  disabled
                  readOnly
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                Lock workspace-wide
              </label>
              <EnterpriseBadge />
            </span>
          </fieldset>
        </FieldRow>
      </div>

      {/* The destructive, typed-confirmation actions live on their own Archive /
          Delete page (#641), always reachable via the DANGER nav section. A single
          inline signpost here is enough — the old full card just duplicated that nav
          entry and padded the page (#977). */}
      <DangerZoneLink to="#danger" />
    </div>
  );
}
