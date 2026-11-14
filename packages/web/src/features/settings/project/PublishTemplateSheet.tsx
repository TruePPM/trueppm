/**
 * The two-step publish sheet (#2909, handoff case 02–03).
 *
 * Step 1 collects a name, a description and a methodology, then states — **read
 * only** — what the template will and will not carry. That inventory is not a set
 * of toggles on purpose: per-publish "carries" switches produce templates that
 * differ in invisible ways, and the PMO's whole comparability argument dies the
 * moment two templates named the same thing bring different things. The model
 * decides; the form states the decision with real counts so a delivery lead can
 * audit it in five seconds.
 *
 * Step 2 answers one question — *what changes when I press this* — and the answer
 * is "nothing here". It repeats no field. It states outcomes, two of which are
 * "nothing happens", because that is the fear which stops people publishing at
 * all.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { queryClient } from '@/lib/queryClient';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import {
  usePublishTemplate,
  type ProjectTemplate,
  type PublishPreview,
  type TemplateNameTaken,
} from '@/hooks/useProjectTemplates';
import type { ProgramMethodology } from '@/api/types';
import {
  TEMPLATE_CARD_CLASS,
  TemplateCardBody,
  carriesLine,
} from '@/features/shell/TemplateCard';

/** The 409 body, when the failure is a taken name rather than anything else. */
function nameTaken(err: unknown): TemplateNameTaken | null {
  const data = (err as { response?: { status?: number; data?: TemplateNameTaken } })?.response;
  return data?.status === 409 && data.data?.code === 'name_taken' ? data.data : null;
}

function otherMessage(err: unknown): string | null {
  if (!err || nameTaken(err)) return null;
  return 'Could not publish — the server rejected the request. Nothing was written. Try again.';
}

/** What is left behind. Fixed in code because it is a property of the extraction. */
const DROPPED = [
  'Assignees and resources',
  'Dates, baselines and constraints',
  'Actuals, time entries, progress',
  'Comments, files and notes',
  'Sprints and their contents',
];

/** Human labels for the server's `carries` keys, so the inventory cannot drift. */
const CARRY_LABEL: Record<string, string> = {
  structure: 'Task tree and WBS shape',
  dependencies: 'Dependencies with lag',
  durations: 'Durations',
  milestones: 'Milestones and gates',
  delivery_modes: 'Delivery modes',
  sprint_length: 'Sprint length',
};

export interface PublishTemplateSheetProps {
  projectId: string;
  projectName: string;
  preview: PublishPreview;
  onClose: () => void;
}

export function PublishTemplateSheet({
  projectId,
  projectName,
  preview,
  onClose,
}: PublishTemplateSheetProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [name, setName] = useState(`${projectName} delivery shape`);
  const [description, setDescription] = useState('');
  const [methodology, setMethodology] = useState<ProgramMethodology>(
    (preview.methodology as ProgramMethodology) ?? 'HYBRID',
  );
  const [published, setPublished] = useState<ProjectTemplate | null>(null);

  const publish = usePublishTemplate();
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, step);
  const collision = nameTaken(publish.error);
  const failure = otherMessage(publish.error);

  function submit(newVersion: boolean) {
    publish.mutate(
      { projectId, name: name.trim(), description, newVersion },
      {
        onSuccess: (template) => {
          setPublished(template);
          setStep('done');
          void queryClient.invalidateQueries({ queryKey: ['project-templates'] });
          void queryClient.invalidateQueries({ queryKey: ['project-templates-from', projectId] });
        },
      },
    );
  }

  const carries = preview.carries.map((key) => CARRY_LABEL[key] ?? key);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={step === 'done' ? 'Template published' : `Publish ${projectName} as a template`}
        className="mt-10 w-full max-w-2xl rounded-card border border-neutral-border bg-neutral-surface p-5"
      >
        {step === 'form' && (
          <>
            <h2 className="text-base font-semibold text-neutral-text-primary">
              Publish {projectName} as a template
            </h2>
            <p className="mt-1 text-xs text-neutral-text-secondary">
              Step 1 of 2 · nothing is written until you confirm
            </p>

            {collision && (
              <div
                role="alert"
                className="mt-3 rounded-card border-l-4 border-semantic-critical bg-semantic-critical-bg p-3 text-sm"
              >
                <p className="font-medium">{collision.detail}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    className="h-11 rounded-control border border-neutral-border px-3 text-sm font-medium
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Publish as v{collision.next_version} of that template
                  </button>
                  <button
                    type="button"
                    onClick={() => publish.reset()}
                    className="h-11 rounded-control px-3 text-sm font-medium text-neutral-text-secondary
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Keep editing the name
                  </button>
                </div>
              </div>
            )}

            <label className="mt-4 block">
              <span className="text-xs font-medium text-neutral-text-secondary">Template name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-11 w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              />
            </label>

            <label className="mt-3 block">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Description
                <span className="ml-1 font-normal">
                  — say who it is for, not what it contains
                </span>
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-control border border-neutral-border bg-neutral-surface p-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              />
            </label>

            <div className="mt-3">
              <label className="block">
                <span className="text-xs font-medium text-neutral-text-secondary">
                  Methodology
                </span>
                <select
                  value={methodology}
                  onChange={(e) => setMethodology(e.target.value as ProgramMethodology)}
                  aria-describedby="publish-methodology-help"
                  className="mt-1 h-11 w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                >
                  <option value="AGILE">Agile</option>
                  <option value="WATERFALL">Waterfall</option>
                  <option value="HYBRID">Hybrid</option>
                </select>
              </label>
              {/* Outside the <label> on purpose: accname concatenates every text
                  node a label contains, so nesting this paragraph made the select
                  announce as "Methodology From this project, and changeable. It
                  also decides where an adopting project lands: an Agile template
                  opens on…". Described, not named. */}
              <p
                id="publish-methodology-help"
                className="mt-1 text-xs text-neutral-text-secondary"
              >
                From this project, and changeable. It also decides where an adopting project
                lands: an <strong>Agile</strong> template opens on a seeded Product Backlog, not
                on a Schedule of dateless bars.
              </p>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-card border border-neutral-border p-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
                  Carried into every new project
                </h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {carries.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                  <li className="text-neutral-text-secondary">
                    {preview.task_count} tasks · {preview.phase_count} phases ·{' '}
                    {preview.dependency_count} dependencies
                  </li>
                </ul>
              </div>
              <div className="rounded-card border border-neutral-border p-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
                  Dropped — stays in this project only
                </h3>
                <ul className="mt-2 space-y-1 text-sm text-neutral-text-secondary">
                  {DROPPED.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-2 text-xs text-neutral-text-secondary">
              This list is not editable, and that is deliberate — what a template carries is a
              property of the model, not a per-publish preference.
            </p>

            {/* The card as a delivery lead will meet it, rendered from the same
                component the gallery uses (#2970). The choice this template will
                actually face is a side-by-side one against four other cards, and
                a name that reads fine in a text input can be the one nobody picks.
                Not a focus stop and not selectable: it advertises no choice here. */}
            <section aria-labelledby="publish-card-preview" className="mt-4">
              <h3
                id="publish-card-preview"
                className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary"
              >
                How a team choosing a template will see it
              </h3>
              <div
                data-testid="template-card-preview"
                className={`${TEMPLATE_CARD_CLASS} mt-2 border-neutral-border bg-neutral-surface-raised`}
              >
                <TemplateCardBody
                  label={name.trim() || 'Untitled template'}
                  detail={
                    description.trim() ||
                    `${preview.task_count} row${preview.task_count === 1 ? '' : 's'}`
                  }
                  chip="Yours"
                  methodology={methodology}
                  taskCount={preview.task_count}
                  carries={preview.carries}
                  carriesLine={carriesLine(preview)}
                  usageLine={`v${preview.next_version}`}
                />
              </div>
              <p className="mt-1 text-xs text-neutral-text-secondary">
                The description is the only line that argues for it — say who it is for.
              </p>
            </section>

            <footer className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-11 rounded-control px-3 text-sm font-medium text-neutral-text-secondary
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!name.trim()}
                onClick={() => setStep('confirm')}
                className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
                           hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:opacity-60
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Review and publish
              </button>
            </footer>
          </>
        )}

        {step === 'confirm' && (
          <>
            <h2 className="text-base font-semibold text-neutral-text-primary">
              Publish &ldquo;{name.trim()}&rdquo; v{preview.next_version}
            </h2>
            <p className="mt-1 text-xs text-neutral-text-secondary">
              Step 2 of 2 · this is the last screen before anything is written
            </p>

            {/* Consequences, in sentences. This step repeats no field — it states
                four outcomes, two of which are "nothing happens". */}
            <ul className="mt-4 space-y-2 text-sm">
              <li className="rounded-card border border-neutral-border p-3">
                <strong>Creates a template other projects can start from.</strong>
                <span className="block text-neutral-text-secondary">
                  {preview.task_count} tasks · {preview.phase_count} phases · {preview.gate_count}{' '}
                  gates · {preview.dependency_count} dependencies · {methodology}
                </span>
              </li>
              <li className="rounded-card border border-neutral-border p-3">
                <strong>Leaves behind everything that is not shape.</strong>
                <span className="block text-neutral-text-secondary">
                  No assignees, no dates, no baselines, no actuals, no comments, no sprints.
                </span>
              </li>
              <li className="rounded-card border border-neutral-border p-3">
                <strong>Changes nothing in {projectName}, or in any running project.</strong>
                <span className="block text-neutral-text-secondary">
                  Projects created from an earlier version keep the version they adopted.
                </span>
              </li>
              <li className="rounded-card border border-neutral-border p-3">
                <strong>Appears in the Start sheet immediately.</strong>
                <span className="block text-neutral-text-secondary">
                  Nobody is notified — a published template is an option that appears, not an
                  announcement.
                </span>
              </li>
            </ul>

            {failure && (
              <p role="alert" className="mt-3 text-sm text-semantic-critical">
                {failure}
              </p>
            )}

            <footer className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStep('form')}
                className="h-11 rounded-control px-3 text-sm font-medium text-neutral-text-secondary
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Back
              </button>
              <button
                type="button"
                disabled={publish.isPending}
                onClick={() => submit(false)}
                className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
                           hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:opacity-60
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {publish.isPending ? 'Publishing…' : `Publish v${preview.next_version}`}
              </button>
            </footer>
          </>
        )}

        {step === 'done' && published && (
          <>
            <h2 className="text-base font-semibold text-neutral-text-primary">
              Published as v{published.version}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-text-secondary">
              &ldquo;{published.name}&rdquo; is now in the Start sheet for everyone in the
              workspace. {projectName} itself is unchanged.
            </p>

            {/* A toast cannot carry a version number or a route, and this flow is
                rare enough that a dedicated success panel costs nothing. The
                primary exit is the proof: seeing what a new team actually gets is
                the only real verification that publish did what the inventory
                claimed. */}
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void navigate('/projects/new');
                }}
                className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
                           hover:bg-brand-primary-dark
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Start a project from it
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-11 rounded-control border border-neutral-border px-3 text-sm font-medium
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Back to Settings
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
