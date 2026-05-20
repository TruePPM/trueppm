import { useState, useEffect, useRef } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';

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

/** Project > General settings page. */
export function ProjectGeneralPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [health, setHealth] = useState<Health>('auto');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const [timezone, setTimezone] = useState(TIMEZONES[0]);
  const [calendarInherited, setCalendarInherited] = useState(true);
  const [defaultView, setDefaultView] = useState(VIEWS[0]);

  // Seed once on first successful load — guard prevents refetch from wiping user edits
  const seededRef = useRef(false);
  useEffect(() => {
    if (!project || seededRef.current) return;
    seededRef.current = true;
    setName(project.name);
    setDescription(project.description ?? '');
  }, [project]);

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
            className="w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Project code" hint="Used as a prefix for task IDs and exports.">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-[140px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Description" hint="One paragraph. Shown on the overview page.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-[540px] px-2.5 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Project lead">
          <div className="flex items-center gap-2">
            <span
              className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold text-white shrink-0"
              style={{ background: '#1C6B3A' }}
              aria-hidden="true"
            >
              AK
            </span>
            <span className="text-[13px] font-medium text-neutral-text-primary">Anika Krishnan</span>
            <span className="text-[12px] text-neutral-text-secondary">· PM</span>
            <button
              type="button"
              className="ml-1 text-[12px] text-brand-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
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

        <FieldRow label="Visibility" hint="Workspace = anyone signed in can see this project. Private = invited only.">
          <div className="flex flex-col gap-3">
            {(
              [
                { id: 'workspace' as const, label: 'Workspace', hint: 'Anyone in the workspace can view; editing follows role.' },
                { id: 'private'   as const, label: 'Private',   hint: 'Only invited members and groups can see this project.' },
              ]
            ).map((opt) => (
              <label key={opt.id} className="flex items-center gap-3 cursor-pointer">
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
                  className="sr-only"
                />
                <span className="text-[13px] font-medium text-neutral-text-primary">{opt.label}</span>
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
              className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
              onClick={() => setCalendarInherited(false)}
              aria-pressed={!calendarInherited}
              className={[
                'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
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
              className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
