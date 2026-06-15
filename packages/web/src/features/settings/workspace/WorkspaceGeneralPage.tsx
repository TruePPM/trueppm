import { useCallback, useEffect, useId, useState } from 'react';
import { DangerZoneLink } from '../components/DangerZoneLink';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { FiscalYearStartField } from '../components/FiscalYearStartField';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { IterationLabelField } from '../project/IterationLabelField';
import { Toggle } from '../components/Toggle';

/** Cascade policy for the workspace iteration label (ADR-0116, #1106). */
type IterationLabelPolicy = 'inherit' | 'suggest' | 'enforce';

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
  'h-8 pl-2.5 pr-7 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary';
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
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: true });

  function toggleDay(i: number) {
    setWorkWeek((prev) => prev.map((on, j) => (j === i ? !on : on)));
  }

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 rounded bg-neutral-surface-raised animate-pulse" />
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
              className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
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
            className="w-full max-w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Subdomain" hint="Members sign in here.">
          <div className="flex items-center h-8 rounded border border-neutral-border bg-neutral-surface-raised px-2.5 w-full max-w-[420px] gap-1 text-[13px]">
            <span className="text-neutral-text-secondary shrink-0">https://</span>
            <span className="font-mono text-neutral-text-primary">{ws.subdomain}</span>
            <span className="text-neutral-text-secondary shrink-0">.trueppm.app</span>
          </div>
        </FieldRow>

        <FieldRow label="Workspace logo" hint="Square. SVG or PNG. 256×256 minimum.">
          <div className="flex items-center gap-3">
            <span className="w-14 h-14 rounded-lg bg-brand-primary inline-flex items-center justify-center text-white text-xl font-bold shrink-0">
              tS
            </span>
            {/* Logo upload not wired yet — disabled until the endpoint ships (#969). */}
            <button
              type="button"
              disabled
              title="Logo upload isn't available yet — tracked in #969"
              className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              Replace
            </button>
            <span className="text-[11px] text-neutral-text-secondary">logo.svg · 12 KB</span>
          </div>
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
                  'w-8 h-8 rounded text-[12px] font-semibold border transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  workWeek[i]
                    ? 'bg-brand-primary text-white border-brand-primary-dark'
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
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-brand-primary-light text-brand-primary text-[12px] font-medium">
              US federal · 2026
            </span>
            {/* Holiday-calendar management not wired yet — disabled until it ships (#969). */}
            <button
              type="button"
              disabled
              title="Adding a holiday calendar isn't available yet — tracked in #969"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-neutral-border text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
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
      </div>

      {/* The destructive, typed-confirmation actions live on their own Archive /
          Delete page (#641), always reachable via the DANGER nav section. A single
          inline signpost here is enough — the old full card just duplicated that nav
          entry and padded the page (#977). */}
      <DangerZoneLink to="/settings/danger" />
    </div>
  );
}
