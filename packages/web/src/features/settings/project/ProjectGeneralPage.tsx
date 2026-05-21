import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';

const TIMEZONES = [
  'America/Los_Angeles · UTC−7',
  'America/Denver · UTC−6',
  'America/Chicago · UTC−5',
  'America/New_York · UTC−4',
  'Europe/London · UTC+1',
  'Europe/Paris · UTC+2',
  'Asia/Tokyo · UTC+9',
];

const VIEWS = ['Schedule (Gantt)', 'Board', 'Table', 'Overview'];

type Health = 'onTrack' | 'atRisk' | 'critical' | 'auto';

const HEALTH_OPTIONS: Array<{ id: Health; label: string }> = [
  { id: 'onTrack',  label: 'On track' },
  { id: 'atRisk',   label: 'At risk' },
  { id: 'critical', label: 'Critical' },
  { id: 'auto',     label: 'Auto' },
];

const HEALTH_ACTIVE: Record<Health, string> = {
  onTrack:  'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  atRisk:   'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  critical: 'bg-semantic-critical/10 text-semantic-critical border-semantic-critical/40',
  auto:     'bg-brand-primary-light text-brand-primary border-brand-primary/40',
};

/**
 * Project > General settings page.
 *
 * `name` and `description` are wired to the real API (PATCH /api/v1/projects/:id/).
 * Extended fields (code, health, visibility, timezone, calendar, default view)
 * are disabled here pending #520, which extends the serializer and removes the
 * per-field `disabled` flag below.
 */
export function ProjectGeneralPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);

  // Wired-to-API fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Pending-#520 fields (disabled — visible to set expectations but cannot be saved)
  const [code, setCode] = useState('');
  const [health, setHealth] = useState<Health>('auto');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const [timezone, setTimezone] = useState(TIMEZONES[0]);
  const [calendarInherited, setCalendarInherited] = useState(true);
  const [defaultView, setDefaultView] = useState(VIEWS[0]);

  // Seed once on first successful load — guard prevents refetch from wiping user edits.
  // `initialName` / `initialDescription` are the "last-saved snapshot" the discard
  // handler reverts to, and useDirtyForm compares against to compute dirty.
  const seededRef = useRef(false);
  const [initialName, setInitialName] = useState('');
  const [initialDescription, setInitialDescription] = useState('');
  useEffect(() => {
    if (!project || seededRef.current) return;
    seededRef.current = true;
    setName(project.name);
    setDescription(project.description ?? '');
    setInitialName(project.name);
    setInitialDescription(project.description ?? '');
  }, [project]);

  const values = useMemo(() => ({ name, description }), [name, description]);
  const initialValues = useMemo(
    () => ({ name: initialName, description: initialDescription }),
    [initialName, initialDescription],
  );

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync({ name, description });
    // Bump the snapshot — dirty flips back to false and the save bar collapses.
    setInitialName(name);
    setInitialDescription(description);
  }, [updateProject, name, description]);

  const handleReset = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
  }, [initialName, initialDescription]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project,
  });

  return (
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Identity, defaults, and scheduling rules for this project. These override workspace defaults."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow label="Project name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Project name"
            className="w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:border-neutral-border/55"
          />
        </FieldRow>

        <FieldRow label="Project code" hint="Used as a prefix for task IDs and exports.">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled
            className="w-[140px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:border-neutral-border/55"
          />
        </FieldRow>

        <FieldRow label="Description" hint="One paragraph. Shown on the overview page.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            aria-label="Description"
            className="w-[540px] px-2.5 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:border-neutral-border/55"
          />
        </FieldRow>

        {/* Mixed live/disabled state on this page (#591): Name + Description are
            API-wired; the fields below are visible but disabled until #520
            ships the extended-fields serializer. Without this notice Sarah
            clicks "At risk" before a Friday client call and can't tell
            whether the control is broken, hidden, or unimplemented. */}
        <div
          role="status"
          aria-live="polite"
          data-testid="project-general-extended-stub-notice"
          className="my-4 flex items-start gap-2.5 px-3 py-2 rounded border border-semantic-warning/40 bg-semantic-warning-bg"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className="text-semantic-warning shrink-0 mt-0.5"
            aria-hidden="true"
          >
            <path d="M8 1.5L1.5 13.5h13L8 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
          </svg>
          <p className="text-[12px] text-neutral-text-primary leading-snug">
            <span className="font-semibold">The fields below ship with </span>
            <a
              href="https://gitlab.com/trueppm/trueppm/-/issues/520"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
            >
              #520
            </a>
            <span className="text-neutral-text-secondary">
              {' '}— they&rsquo;re shown here to set expectations but can&rsquo;t be saved yet.
            </span>
          </p>
        </div>

        <FieldRow label="Project lead">
          <div className="flex items-center gap-2">
            <span
              className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold text-white shrink-0 bg-brand-primary"
              aria-hidden="true"
            >
              AK
            </span>
            <span className="text-[13px] font-medium text-neutral-text-primary">Anika Krishnan</span>
            <span className="text-[12px] text-neutral-text-secondary">· PM</span>
            <button
              type="button"
              disabled
              className="ml-1 text-[12px] text-brand-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:no-underline"
            >
              Change
            </button>
          </div>
        </FieldRow>

        <FieldRow label="Health" hint="Drives the dot color in project lists and rollups. Override is auto-cleared after 14 days.">
          <div className="flex gap-2">
            {HEALTH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setHealth(opt.id)}
                aria-pressed={health === opt.id}
                disabled
                className={[
                  'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
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

        <FieldRow label="Visibility" hint="Workspace = anyone signed in can see this project. Private = invited only.">
          <div className="flex flex-col gap-3">
            {(
              [
                { id: 'workspace' as const, label: 'Workspace', hint: 'Anyone in the workspace can view; editing follows role.' },
                { id: 'private'   as const, label: 'Private',   hint: 'Only invited members and groups can see this project.' },
              ]
            ).map((opt) => (
              <label key={opt.id} className="flex items-center gap-3 cursor-not-allowed" aria-disabled="true">
                <span
                  className={[
                    'w-4 h-4 rounded-full border-2 shrink-0 transition-colors',
                    visibility === opt.id ? 'border-brand-primary bg-brand-primary' : 'border-neutral-border',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {visibility === opt.id && (
                    <span className="block w-full h-full rounded-full scale-[0.4] bg-white" />
                  )}
                </span>
                <input
                  type="radio"
                  name="visibility"
                  value={opt.id}
                  checked={visibility === opt.id}
                  onChange={() => setVisibility(opt.id)}
                  disabled
                  className="sr-only"
                />
                <span className="text-[13px] font-medium text-neutral-text-secondary">{opt.label}</span>
                <span className="text-[12px] text-neutral-text-secondary">· {opt.hint}</span>
              </label>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Timezone" hint="Used for due dates, Gantt rendering, and sprint cutovers.">
          <div className="relative inline-block w-[280px]">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled
              className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:border-neutral-border/55"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </FieldRow>

        <FieldRow label="Working calendar" hint="Override the workspace work-week and holidays.">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCalendarInherited(true)}
              aria-pressed={calendarInherited}
              disabled
              className={[
                'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
                calendarInherited
                  ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                  : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
              ].join(' ')}
            >
              Inherit from workspace
            </button>
            <button
              type="button"
              onClick={() => setCalendarInherited(false)}
              aria-pressed={!calendarInherited}
              disabled
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
        </FieldRow>

        <FieldRow label="Default view">
          <div className="relative inline-block w-[200px]">
            <select
              value={defaultView}
              onChange={(e) => setDefaultView(e.target.value)}
              disabled
              className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:border-neutral-border/55"
            >
              {VIEWS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </FieldRow>
      </div>
    </div>
  );
}
