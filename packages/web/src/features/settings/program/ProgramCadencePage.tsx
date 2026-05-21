import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';
import { StubPageBanner } from '../components/StubPageBanner';

interface CeremonyTemplate {
  id: string;
  name: string;
  cadence: string;
  duration: string;
  owner: string;
  enabled: boolean;
}

const CEREMONIES: CeremonyTemplate[] = [
  { id: 'program-sync',   name: 'Program sync',         cadence: 'Weekly · Mon 10:00',    duration: '60 min', owner: 'Program Manager', enabled: true  },
  { id: 'steering',       name: 'Steering committee',   cadence: 'Monthly · 1st Thu 14:00', duration: '90 min', owner: 'Program Manager', enabled: true  },
  { id: 'phase-gate',     name: 'Phase gate review',    cadence: 'On milestone',           duration: '120 min', owner: 'Program Manager', enabled: true  },
  { id: 'risk-review',    name: 'Risk review',          cadence: 'Bi-weekly · Wed 11:00',  duration: '45 min', owner: 'Risk Lead',       enabled: true  },
  { id: 'resource-sync',  name: 'Resource sync',        cadence: 'Weekly · Fri 09:00',     duration: '30 min', owner: 'Scheduler',       enabled: false },
];

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2',
        on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </span>
  );
}

/** Program > Cadence & ceremonies settings page. */
export function ProgramCadencePage() {
  return (
    <>
    <StubPageBanner pageIssue={528} />
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Cadence & ceremonies"
        subtitle="Recurring meeting templates. Instances are created when the program starts and linked to milestones."
        action={
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + Add ceremony
          </button>
        }
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        <SettingsCard>
          {/* Table header */}
          <div
            className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: '1.6fr 1.4fr 90px 1fr 60px 44px' }}
          >
            <span>Ceremony</span>
            <span>Cadence</span>
            <span>Duration</span>
            <span>Owner</span>
            <span className="text-center">Active</span>
            <span />
          </div>

          {CEREMONIES.map((c, i) => (
            <div
              key={c.id}
              className={['grid items-center px-4 py-3 text-[13px]', i < CEREMONIES.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
              style={{ gridTemplateColumns: '1.6fr 1.4fr 90px 1fr 60px 44px' }}
            >
              <span className="font-medium text-neutral-text-primary">{c.name}</span>
              <span className="text-[12px] text-neutral-text-secondary">{c.cadence}</span>
              <span className="tppm-mono text-[12px] text-neutral-text-secondary">{c.duration}</span>
              <span className="text-[12px] text-neutral-text-secondary">{c.owner}</span>
              <span className="flex justify-center">
                <Toggle on={c.enabled} />
              </span>
              <button
                type="button"
                className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
                aria-label={`More options for ${c.name}`}
              >
                ···
              </button>
            </div>
          ))}
        </SettingsCard>

        {/* Phase gate calendar */}
        <section aria-labelledby="phasegate-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4">
          <h2 id="phasegate-heading" className="text-[13px] font-semibold text-neutral-text-primary mb-1">Phase gate calendar</h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-snug">
            Gate reviews are automatically scheduled when a phase boundary milestone is saved. Attach a calendar invite template here.
          </p>
          <button
            type="button"
            className="px-3 py-1.5 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Configure gate template…
          </button>
        </section>
      </div>
    </div>
    </StubFieldset>
    </>
  );
}
