import { SettingsPageTitle } from '../SettingsShell';
import { StubPageBanner } from '../components/StubPageBanner';

interface Integration {
  id: string;
  name: string;
  category: string;
  description: string;
  status: 'connected' | 'available';
  detail?: string;
}

const INTEGRATIONS: Integration[] = [
  { id: 'gitlab',    name: 'GitLab',          category: 'Source',   status: 'connected', detail: 'trueScope/* groups',      description: 'Branches, MRs, and CI attached to tasks.' },
  { id: 'github',    name: 'GitHub',          category: 'Source',   status: 'connected', detail: 'trueScope-helios org',    description: 'Helios firmware repo integration.' },
  { id: 'msproject', name: 'MS Project',      category: 'Schedule', status: 'connected', detail: 'Last sync 4m ago',        description: 'Two-way sync of .mpp baselines.' },
  { id: 'slack',     name: 'Slack',           category: 'Comms',    status: 'connected', detail: 'trueScope.slack.com',     description: 'Notifications, /trueppm command, daily digest.' },
  { id: 'gcal',      name: 'Google Calendar', category: 'Calendar', status: 'connected', detail: '1-way export',           description: 'Project milestones land on subscribed calendars.' },
  { id: 'gdrive',    name: 'Google Drive',    category: 'Files',    status: 'connected', detail: 'trueScope.com workspace', description: 'Inline previews of attached documents.' },
  { id: 'outlook',   name: 'Outlook 365',     category: 'Calendar', status: 'available', description: 'Milestones → M365 calendar.' },
  { id: 'jira',      name: 'Jira',            category: 'Tracker',  status: 'available', description: 'Mirror tasks ↔ issues. One project at a time.' },
  { id: 'linear',    name: 'Linear',          category: 'Tracker',  status: 'available', description: 'Mirror tasks ↔ issues. Bidirectional cycle.' },
  { id: 'zoom',      name: 'Zoom',            category: 'Comms',    status: 'available', description: 'Attach a Zoom meeting to any milestone.' },
  { id: 'siem',      name: 'Datadog SIEM',    category: 'Security', status: 'available', description: 'Stream the audit log to Datadog.' },
  { id: 'servicenow',name: 'ServiceNow',      category: 'Tracker',  status: 'available', description: 'Risk and incident sync.' },
];

const CATEGORIES = ['All', ...Array.from(new Set(INTEGRATIONS.map((i) => i.category)))];

function IntegrationCard({ it }: { it: Integration }) {
  const abbrev = it.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const connected = it.status === 'connected';

  return (
    <div
      className={[
        'rounded-lg p-3.5 flex flex-col gap-2',
        connected
          ? 'border border-neutral-border bg-neutral-surface-raised'
          : 'border border-dashed border-neutral-border bg-neutral-surface-raised opacity-90',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        {/* Icon */}
        <span
          className={[
            'w-9 h-9 rounded-md inline-flex items-center justify-center text-[13px] font-bold shrink-0',
            connected ? 'bg-brand-primary-light text-brand-primary' : 'bg-neutral-surface-sunken text-neutral-text-secondary',
          ].join(' ')}
          aria-hidden="true"
        >
          {abbrev}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-semibold text-neutral-text-primary">{it.name}</span>
            <span className="text-[10px] px-1.5 py-px rounded border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary font-medium">
              {it.category}
            </span>
          </div>
          <p className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">{it.description}</p>
        </div>
      </div>

      <div className={['flex items-center gap-2 pt-2', connected ? 'border-t border-neutral-border/55' : 'border-t border-dashed border-neutral-border/55'].join(' ')}>
        {connected ? (
          <>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-semantic-on-track-bg text-semantic-on-track text-[10px] font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-semantic-on-track" aria-hidden="true" />
              Connected
            </span>
            {it.detail && (
              <span className="text-[11px] text-neutral-text-secondary truncate">{it.detail}</span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              className="text-[11px] text-brand-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
            >
              Configure
            </button>
          </>
        ) : (
          <>
            <span className="text-[10px] px-2 py-0.5 rounded border border-neutral-border bg-neutral-surface text-neutral-text-secondary font-medium">
              Available
            </span>
            <div className="flex-1" />
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Connect
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Workspace > Integrations page. */
export function WorkspaceIntegrationsPage() {
  const connectedCount = INTEGRATIONS.filter((i) => i.status === 'connected').length;
  const availableCount = INTEGRATIONS.filter((i) => i.status === 'available').length;

  return (
    <div>
      <StubPageBanner pageIssue={569} />
      <SettingsPageTitle
        title="Integrations"
        count={`${connectedCount} connected · ${availableCount} available`}
        subtitle="Connect TruePPM to your stack. Per-project routing lives under Project → Notifications."
        action={
          <button
            type="button"
            className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Browse marketplace
          </button>
        }
      />

      {/* Filters */}
      <div className="px-6 py-3 flex items-center gap-2 border-b border-neutral-border/55 flex-wrap">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] w-[280px]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-neutral-text-disabled shrink-0">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-neutral-text-disabled">Search integrations…</span>
        </div>
        <div className="w-px h-4 bg-neutral-border" aria-hidden="true" />
        {CATEGORIES.map((cat, i) => (
          <button
            key={cat}
            type="button"
            className={[
              'px-2.5 py-1 rounded text-[12px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
              i === 0
                ? 'bg-brand-primary-light text-brand-primary'
                : 'border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Cards grid */}
      <div className="px-6 py-5">
        <div className="grid grid-cols-3 gap-3.5">
          {INTEGRATIONS.map((it) => (
            <IntegrationCard key={it.id} it={it} />
          ))}
        </div>
      </div>
    </div>
  );
}
