import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { StubPageBanner } from '../components/StubPageBanner';

interface LifecycleCardProps {
  title: string;
  tone: 'neutral' | 'warning';
  description: string;
  actionLabel: string;
  notes: string[];
}

function LifecycleCard({ title, tone, description, actionLabel, notes }: LifecycleCardProps) {
  return (
    <div
      className={[
        'rounded-lg border p-4',
        tone === 'warning'
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

/** Program > Archive / Transfer / Close settings page. */
export function ProgramArchivePage() {
  const [confirmText, setConfirmText] = useState('');
  const slug = 'ARTEMIS';
  const confirmed = confirmText === slug;

  return (
    <div>
      <StubPageBanner pageIssue={530} />
      <SettingsPageTitle
        title="Archive / Close"
        subtitle="Lifecycle actions for this program. All actions are logged and can be reviewed in the workspace audit log."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-3.5">
        <LifecycleCard
          title="Close program"
          tone="neutral"
          description="Marks all projects in this program as read-only. Member access is retained; tasks no longer appear in active views or resource utilization."
          actionLabel="Close program…"
          notes={[
            'Baselines, audit log, time entries, and attachments are retained.',
            'Reversible by any workspace Admin.',
          ]}
        />

        <LifecycleCard
          title="Transfer sponsorship"
          tone="warning"
          description="Assign a new sponsor and optionally a new program manager. The current PM is demoted to Member unless changed."
          actionLabel="Transfer sponsorship…"
          notes={[
            'New sponsor must have Admin or Owner role in the workspace.',
            'Sends notification to all program members.',
          ]}
        />

        <LifecycleCard
          title="Split into sub-programs"
          tone="neutral"
          description="Divide this program into two or more independent programs. Projects are redistributed by phase or by project list."
          actionLabel="Split program…"
          notes={[
            'Original program is archived after split.',
            'All project links, dependencies, and baselines are preserved.',
          ]}
        />

        {/* Delete — critical zone */}
        <div className="rounded-lg border border-semantic-critical bg-semantic-critical-bg p-4">
          <h2 className="text-[13px] font-bold text-semantic-critical mb-1">Delete program — permanent</h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-relaxed">
            Removes this program record. Member projects are <strong className="text-neutral-text-primary">not</strong> deleted — they revert to unaffiliated projects.
            Program-level baselines, rollup KPIs, and audit entries are deleted.
          </p>
          <div className="rounded border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
            <div className="text-[12px] text-neutral-text-secondary mb-2">To confirm, type the program slug:</div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-0.5 rounded bg-neutral-surface-sunken border border-neutral-border tppm-mono text-[12px] text-neutral-text-primary">
                {slug}
              </code>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`Type ${slug} to confirm`}
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
            Delete program permanently
          </button>
        </div>
      </div>
    </div>
  );
}
