import { SettingsPageTitle } from '../SettingsShell';
import { StubPageBanner } from '../components/StubPageBanner';

interface ProgramProject {
  id: string;
  name: string;
  code: string;
  health: 'onTrack' | 'atRisk' | 'critical';
  methodology: string;
  taskCount: number;
  pm: { initials: string; color: string; name: string };
}

const HEALTH_DOT: Record<string, string> = {
  onTrack:  'bg-semantic-on-track',
  atRisk:   'bg-semantic-at-risk',
  critical: 'bg-semantic-critical',
};

const HEALTH_LABEL: Record<string, string> = {
  onTrack:  'On track',
  atRisk:   'At risk',
  critical: 'Critical',
};

const PROJECTS: ProgramProject[] = [
  {
    id: 'proj-1',
    name: 'Artemis IV Lift',
    code: 'ARTM4',
    health: 'atRisk',
    methodology: 'Waterfall',
    taskCount: 121,
    pm: { initials: 'AK', color: '#1C6B3A', name: 'Anika Krishnan' },
  },
  {
    id: 'proj-2',
    name: 'Artemis III Test Vehicle',
    code: 'ARTM3',
    health: 'onTrack',
    methodology: 'Hybrid',
    taskCount: 84,
    pm: { initials: 'JT', color: '#C17A10', name: 'James Torres' },
  },
  {
    id: 'proj-3',
    name: 'Ground Support Equipment',
    code: 'GSE1',
    health: 'onTrack',
    methodology: 'Waterfall',
    taskCount: 57,
    pm: { initials: 'SP', color: '#0EA5E9', name: 'Sofia Petrov' },
  },
  {
    id: 'proj-4',
    name: 'Launch Control Software',
    code: 'LCS2',
    health: 'critical',
    methodology: 'Agile',
    taskCount: 39,
    pm: { initials: 'MC', color: '#7C3AED', name: 'Marcus Chen' },
  },
];

/** Program > Projects settings page. */
export function ProgramProjectsPage() {
  return (
    <div>
      <StubPageBanner pageIssue={524} />
      <SettingsPageTitle
        title="Projects"
        count={`${PROJECTS.length} projects`}
        subtitle="Projects assigned to this program. Each project inherits the program methodology unless overridden."
        action={
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + Add project
          </button>
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Table header */}
        <div
          className="grid items-center px-4 py-2 bg-neutral-surface-sunken border border-neutral-border rounded-t-lg text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mt-4"
          style={{ gridTemplateColumns: '1.8fr 80px 110px 110px 90px 110px 52px' }}
        >
          <span>Project</span>
          <span>Code</span>
          <span>Health</span>
          <span>Methodology</span>
          <span className="tppm-mono">Tasks</span>
          <span>PM</span>
          <span />
        </div>

        <div className="bg-neutral-surface-raised border-x border-b border-neutral-border rounded-b-lg overflow-hidden">
          {PROJECTS.map((p, i) => (
            <div
              key={p.id}
              className={['grid items-center px-4 py-3 text-[13px]', i < PROJECTS.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
              style={{ gridTemplateColumns: '1.8fr 80px 110px 110px 90px 110px 52px' }}
            >
              <span className="font-medium text-neutral-text-primary">{p.name}</span>
              <span className="tppm-mono text-[12px] text-neutral-text-secondary">{p.code}</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${HEALTH_DOT[p.health]}`}
                  aria-hidden="true"
                />
                <span className="text-[12px] text-neutral-text-secondary">{HEALTH_LABEL[p.health]}</span>
              </span>
              <span className="text-[12px] text-neutral-text-secondary">{p.methodology}</span>
              <span className="tppm-mono text-[12px] text-neutral-text-secondary">{p.taskCount}</span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                  style={{ background: p.pm.color }}
                  aria-hidden="true"
                >
                  {p.pm.initials}
                </span>
                <span className="text-[12px] text-neutral-text-secondary truncate">{p.pm.name}</span>
              </span>
              <button
                type="button"
                className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
                aria-label={`More options for ${p.name}`}
              >
                ···
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
