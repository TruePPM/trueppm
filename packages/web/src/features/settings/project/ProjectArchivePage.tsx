import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';

const PROJECT_CODE = 'ARTM4';

interface LifecycleCardProps {
  title: string;
  tone: 'neutral' | 'warning';
  description: string;
  actionLabel: string;
  notes: string[];
}

function LifecycleCard({ title, tone, description, actionLabel, notes }: LifecycleCardProps) {
  const isWarning = tone === 'warning';
  return (
    <div
      className={[
        'rounded-lg border p-4',
        isWarning
          ? 'border-brand-accent bg-brand-accent-light'
          : 'border-neutral-border bg-neutral-surface-raised',
      ].join(' ')}
    >
      <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-1">{title}</h2>
      <p className="text-[12px] text-neutral-text-secondary mb-2 leading-relaxed">{description}</p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        {notes.map((n) => (
          <li key={n} className="text-[11px] text-neutral-text-secondary">{n}</li>
        ))}
      </ul>
      <button
        type="button"
        className="px-3 py-1.5 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/** Project > Lifecycle (archive / transfer / delete) settings page. */
export function ProjectArchivePage() {
  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmText === PROJECT_CODE;

  return (
    <div>
      <SettingsPageTitle
        title="Lifecycle"
        subtitle="Closing out, handing off, or removing this project. All actions write to the audit log."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-3.5">
        <LifecycleCard
          title="Archive project"
          tone="neutral"
          description="Freezes the project. Members keep read-only access; tasks no longer appear in active views or rollups."
          actionLabel="Archive Artemis IV…"
          notes={[
            'Retains baselines, audit log, time entries, attachments.',
            'Reversible by any Admin.',
          ]}
        />

        <LifecycleCard
          title="Transfer ownership"
          tone="warning"
          description="Hand the PM role to another member. The current PM becomes a Lead unless changed."
          actionLabel="Transfer ownership…"
          notes={[
            'New owner must be in the workspace and have PM or Admin role.',
            'Notifications sent to workspace admins and project members.',
          ]}
        />

        <LifecycleCard
          title="Export project"
          tone="neutral"
          description="Download a portable bundle: tasks (JSON + .mpp), baselines, attachments, time entries, audit log."
          actionLabel="Generate export…"
          notes={[
            'Bundle is encrypted and signed; download link valid 24h.',
            'Auto-deletes after 7 days unless saved.',
          ]}
        />

        {/* Delete — critical zone */}
        <div className="rounded-lg border border-semantic-critical bg-semantic-critical-bg p-4">
          <h2 className="text-[13px] font-bold text-semantic-critical mb-1">Delete project — permanent</h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-relaxed">
            Removes this project and everything in it: tasks, baselines, time entries, attachments. Audit-log
            entries are retained for 365 days for compliance, then purged.{' '}
            <strong className="text-neutral-text-primary">Cross-project dependencies in linked projects will fail.</strong>
          </p>
          <div className="rounded border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
            <div className="text-[12px] text-neutral-text-secondary mb-2">To confirm, type the project code:</div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-0.5 rounded bg-neutral-surface-sunken border border-neutral-border tppm-mono text-[12px] text-neutral-text-primary">
                {PROJECT_CODE}
              </code>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`Type ${PROJECT_CODE} to confirm`}
                className={[
                  'w-[240px] h-8 px-2.5 rounded border tppm-mono text-[12px] text-neutral-text-primary bg-neutral-surface-raised',
                  'placeholder:text-neutral-text-disabled',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical',
                  confirmText && !confirmed ? 'border-semantic-critical' : 'border-neutral-border',
                ].join(' ')}
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!confirmed}
            className={[
              'px-4 py-2 rounded text-[13px] font-semibold text-white bg-semantic-critical transition-opacity',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
              confirmed ? 'opacity-100 hover:opacity-90' : 'opacity-40 cursor-not-allowed',
            ].join(' ')}
          >
            Delete project permanently
          </button>
        </div>
      </div>
    </div>
  );
}
