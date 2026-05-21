import { SettingsPageTitle } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';

interface Phase {
  id: number;
  name: string;
  color: string;
  tasks: number;
}

interface Status {
  name: string;
  color: string;
}

interface Field {
  name: string;
  type: string;
  builtin: boolean;
  required: boolean;
}

const PHASES: Phase[] = [
  { id: 1, name: 'Engineering',  color: '#1C6B3A', tasks: 36 },
  { id: 2, name: 'Procurement',  color: '#C17A10', tasks: 18 },
  { id: 3, name: 'Build',        color: '#7C3AED', tasks: 27 },
  { id: 4, name: 'Test',         color: '#0EA5E9', tasks: 24 },
  { id: 5, name: 'Launch ops',   color: '#DC2626', tasks: 16 },
];

const STATUSES: Status[] = [
  { name: 'Backlog',     color: '#6B6965' },
  { name: 'Ready',       color: '#0EA5E9' },
  { name: 'In progress', color: '#C17A10' },
  { name: 'Review',      color: '#7C3AED' },
  { name: 'Done',        color: '#16A34A' },
  { name: 'Blocked',     color: '#DC2626' },
];

const FIELDS: Field[] = [
  { name: 'Phase',           type: 'Single-select',  builtin: true,  required: true  },
  { name: 'Owner',           type: 'Person',         builtin: true,  required: true  },
  { name: 'Duration',        type: 'Duration',       builtin: true,  required: false },
  { name: 'Risk',            type: 'Single-select',  builtin: true,  required: false },
  { name: 'Critical-path',   type: 'Boolean (auto)', builtin: true,  required: false },
  { name: 'Vendor',          type: 'Single-select',  builtin: false, required: false },
  { name: 'Compliance gate', type: 'Multi-select',   builtin: false, required: false },
  { name: 'Drawing rev',     type: 'Text',           builtin: false, required: false },
  { name: 'Mass (kg)',       type: 'Number',         builtin: false, required: false },
];

/** Project > Workflow & fields settings page. */
export function ProjectWorkflowPage() {
  return (
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Workflow & fields"
        subtitle="Phases, statuses, and custom fields. These shape every Board, Schedule, and Table view in this project."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        {/* Phases */}
        <section aria-labelledby="phases-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
            <h2 id="phases-heading" className="text-[13px] font-semibold text-neutral-text-primary">Phases</h2>
            <span className="text-[12px] text-neutral-text-secondary">· Swim-lanes on the board, summary rows on the schedule</span>
            <div className="flex-1" />
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              + Add phase
            </button>
          </div>
          {PHASES.map((p, i) => (
            <div
              key={p.id}
              className={['grid items-center gap-2.5 px-4 py-2.5', i < PHASES.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
              style={{ gridTemplateColumns: '28px 28px 1fr 90px 90px 48px' }}
            >
              <span className="text-neutral-text-disabled select-none text-[16px] leading-none" aria-hidden="true">⠿</span>
              <span
                className="w-[18px] h-[18px] rounded"
                style={{ background: p.color }}
                aria-hidden="true"
              />
              <span className="text-[13px] font-medium text-neutral-text-primary">{p.name}</span>
              <span className="tppm-mono text-[11px] text-neutral-text-secondary">Phase {p.id}</span>
              <span className="tppm-mono text-[11px] text-neutral-text-secondary">{p.tasks} tasks</span>
              <button
                type="button"
                className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
                aria-label={`More options for ${p.name} phase`}
              >
                ···
              </button>
            </div>
          ))}
        </section>

        {/* Statuses */}
        <section aria-labelledby="statuses-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
            <h2 id="statuses-heading" className="text-[13px] font-semibold text-neutral-text-primary">Statuses</h2>
            <span className="text-[12px] text-neutral-text-secondary">· Columns on the board · Status pill on cards</span>
            <div className="flex-1" />
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              + Add status
            </button>
          </div>
          <div className="px-4 py-3 flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <span
                key={s.name}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-neutral-border/55 bg-neutral-surface-sunken text-[12px] font-medium text-neutral-text-primary"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                {s.name}
                <span className="text-neutral-text-disabled ml-0.5 select-none" aria-hidden="true">⠿</span>
              </span>
            ))}
          </div>
        </section>

        {/* Fields */}
        <section aria-labelledby="fields-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
            <h2 id="fields-heading" className="text-[13px] font-semibold text-neutral-text-primary">Fields</h2>
            <span className="text-[12px] text-neutral-text-secondary">· Built-ins are required by the scheduler. Custom fields appear in the task drawer.</span>
            <div className="flex-1" />
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              + New field
            </button>
          </div>
          {/* Table header */}
          <div
            className="grid px-4 py-2 bg-neutral-surface-sunken border-b border-neutral-border/55 text-xs font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: '28px 1.2fr 1fr 100px 100px 48px' }}
          >
            <span />
            <span>Field</span>
            <span>Type</span>
            <span>Required</span>
            <span>Source</span>
            <span />
          </div>
          {FIELDS.map((f, i) => (
            <div
              key={f.name}
              className={['grid items-center gap-2.5 px-4 py-2.5 text-[13px]', i < FIELDS.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
              style={{ gridTemplateColumns: '28px 1.2fr 1fr 100px 100px 48px' }}
            >
              <span className="text-neutral-text-disabled select-none text-[16px] leading-none" aria-hidden="true">⠿</span>
              <span className="font-medium text-neutral-text-primary">{f.name}</span>
              <span className="text-[12px] text-neutral-text-secondary">{f.type}</span>
              <span>
                {f.required
                  ? <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-brand-primary-light text-brand-primary">Required</span>
                  : <span className="text-neutral-text-disabled text-[11px]">—</span>
                }
              </span>
              <span>
                {f.builtin
                  ? <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border/55">Built-in</span>
                  : <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-brand-accent-light text-brand-accent-dark">Custom</span>
                }
              </span>
              <button
                type="button"
                className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
                aria-label={`More options for ${f.name} field`}
              >
                ···
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
    </StubFieldset>
  );
}
