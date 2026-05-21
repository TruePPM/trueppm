import { useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';

type ProgramHealth = 'onTrack' | 'atRisk' | 'critical' | 'auto';

const HEALTH_OPTIONS: Array<{ id: ProgramHealth; label: string }> = [
  { id: 'onTrack',  label: 'On track' },
  { id: 'atRisk',   label: 'At risk' },
  { id: 'critical', label: 'Critical' },
  { id: 'auto',     label: 'Auto' },
];

const HEALTH_ACTIVE: Record<ProgramHealth, string> = {
  onTrack:  'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  atRisk:   'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  critical: 'bg-semantic-critical/10 text-semantic-critical border-semantic-critical/40',
  auto:     'bg-brand-primary-light text-brand-primary border-brand-primary/40',
};

const METHODOLOGIES = ['Waterfall', 'Agile', 'Hybrid'] as const;

/** Program > General settings page. */
export function ProgramGeneralPage() {
  const [name, setName] = useState('Artemis Launch Vehicle Program');
  const [description, setDescription] = useState(
    'End-to-end development and launch program for the Artemis family of crewed lift vehicles. Encompasses design, build, test, and flight readiness milestones across all vehicle variants.',
  );
  const [health, setHealth] = useState<ProgramHealth>('onTrack');
  const [methodology, setMethodology] = useState<string>('Waterfall');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');

  return (
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Program identity and delivery model. Settings here affect all projects within this program."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow label="Program name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Description" hint="Shown on the program overview and in rollup dashboards.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-[540px] px-2.5 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Program manager">
          <div className="flex items-center gap-2">
            <span
              className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold text-white shrink-0"
              style={{ background: '#1C6B3A' }}
              aria-hidden="true"
            >
              AK
            </span>
            <span className="text-[13px] font-medium text-neutral-text-primary">Anika Krishnan</span>
            <span className="text-[12px] text-neutral-text-secondary">· Program Manager</span>
            <button
              type="button"
              className="ml-1 text-[12px] text-brand-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
            >
              Change
            </button>
          </div>
        </FieldRow>

        <FieldRow label="Health" hint="Drives the health dot in program lists and portfolio rollups.">
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

        <FieldRow label="Methodology" hint="Default delivery model for new projects added to this program.">
          <div className="flex gap-2">
            {METHODOLOGIES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethodology(m)}
                aria-pressed={methodology === m}
                className={[
                  'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  methodology === m
                    ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Visibility" hint="Who can see this program and its rollup KPIs.">
          <div className="flex flex-col gap-3">
            {(
              [
                { id: 'workspace' as const, label: 'Workspace', hint: 'Anyone in the workspace can see this program.' },
                { id: 'private'   as const, label: 'Private',   hint: 'Only invited members can see this program.' },
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
                  name="program-visibility"
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
      </div>
    </div>
    </StubFieldset>
  );
}
