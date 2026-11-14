/**
 * Project · Settings · Template divergence — the team's own copy (#2971, epic #2743).
 *
 * This section exists because of an ordering constraint, not a feature request:
 *
 * > A report about a team's decisions that the team cannot read is surveillance
 * > with better typography.
 *
 * So it is the *team-side* half, and it ships first. It reads
 * `GET /projects/:id/template-divergence/`, which has no audience parameter and no
 * narrower sibling — a PMO looking at this project's divergence fires the identical
 * request. That is deliberately structural: two surfaces kept in agreement by
 * discipline drift, one endpoint cannot.
 *
 * Three things this screen refuses to do, per the governance position settled in
 * #2970/#2909 and restated on the epic: **no verdict, no score, no action.** There is
 * no "compliance" percentage, no band, no colored health pill, and no button that
 * submits anything for approval. Divergence produces a visible signal, never a block.
 * The numbers are plain numerals with plain labels; nothing on the page encodes
 * "good" or "bad", because the product has no position on whether a team should have
 * changed the plan they were handed.
 */
import { useProjectId } from '@/hooks/useProjectId';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { useTemplateDivergence, type TemplateDivergence } from '@/hooks/useProjectTemplates';
import { SettingsPageTitle } from '../SettingsShell';

function Stat({ value, label, hint }: { value: number; label: string; hint: string }) {
  return (
    <div className="min-w-24">
      {/* Plain numerals and a text label, no color encoding: rule 120, and the
          product's refusal to grade the number. */}
      <dt className="text-xs text-neutral-text-secondary">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-neutral-text-primary">{value}</dd>
      <p className="mt-0.5 max-w-40 text-xs leading-snug text-neutral-text-secondary">{hint}</p>
    </div>
  );
}

/** The line every reader sees, whichever side of the org chart they sit on. */
function SymmetryNote() {
  return (
    <p className="max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
      <strong className="font-medium text-neutral-text-primary">
        Everyone on this project sees exactly this page
      </strong>{' '}
      — Viewers included — and there is no fuller version of it anywhere else. It is a
      signal, never a gate: nothing here approves, rejects, queues, or scores what this
      team decided.
    </p>
  );
}

function Adopted({ digest }: { digest: TemplateDivergence }) {
  const { formatInstantDate } = useUserDateFormat();
  const applied = digest.applied_at ? formatInstantDate(digest.applied_at) : null;
  const who = digest.applied_by_name;

  return (
    <>
      <div className="rounded-card border border-neutral-border p-4">
        <p className="text-sm text-neutral-text-primary">
          This project started from{' '}
          <strong className="font-medium">
            {digest.template_name} v{digest.template_version}
          </strong>
          {who ? `, applied by ${who}` : ''}
          {applied ? ` on ${applied}` : ''}.
          {digest.application_count > 1
            ? ` ${digest.application_count} templates have been applied here; the counts below cover all of them.`
            : ''}
        </p>
        {!digest.template_available && (
          // Not an error state and not styled as one. The adoption record is
          // denormalized precisely so it outlives the template.
          <p className="mt-1 text-sm text-neutral-text-secondary">
            That template has since been deleted. What it wrote here is unaffected.
          </p>
        )}

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-4">
          <Stat
            value={digest.unchanged}
            label="Unchanged"
            hint="Still exactly as the template wrote them."
          />
          <Stat
            value={digest.adapted}
            label="Adapted"
            hint="Someone on this team edited them."
          />
          <Stat
            value={digest.removed}
            label="Removed"
            hint="Deleted since the template wrote them."
          />
          <Stat
            value={digest.added}
            label="Added"
            hint="Rows here that no template wrote."
          />
        </dl>

        <p className="mt-4 text-xs text-neutral-text-secondary">
          Of the {digest.seeded_row_count} row{digest.seeded_row_count === 1 ? '' : 's'} the
          template wrote.
        </p>
      </div>

      <p className="max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
        Adapting a template is the expected outcome. A skeleton is a starting point that
        somebody else&rsquo;s project made sense of first; the parts of it this team changed
        are the parts that did not fit, and that is information about the template as much
        as about the project.
      </p>

      <SymmetryNote />
    </>
  );
}

function NotAdopted({ digest }: { digest: TemplateDivergence }) {
  return (
    <>
      <div className="rounded-card border border-neutral-border p-4">
        <p className="text-sm font-medium text-neutral-text-primary">
          This project wasn&rsquo;t created from a template
        </p>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
          Its {digest.added} row{digest.added === 1 ? '' : 's'} were all authored here, so there
          is no divergence to report. If a template is ever applied to this project, the
          summary appears on this page — and this is where it appears first.
        </p>
      </div>
      <SymmetryNote />
    </>
  );
}

export function ProjectTemplateDivergencePage() {
  const projectId = useProjectId();
  const { data: digest, isLoading, isError } = useTemplateDivergence(projectId ?? null);

  return (
    <div className="flex flex-col gap-4">
      <SettingsPageTitle
        title="Template divergence"
        subtitle="What is reported about how this project differs from the template it started from."
      />

      {isError ? (
        // A failed read is not "no divergence". Reporting an empty digest on a
        // failed request would tell a team nothing is being said about them at
        // the exact moment we cannot see what is.
        <p role="alert" className="text-sm text-semantic-critical">
          Couldn&rsquo;t load this project&rsquo;s divergence summary. This is a failed
          request, not an empty report — reload to try again.
        </p>
      ) : isLoading || !digest ? (
        <div role="status" aria-label="Loading template divergence…" className="flex flex-col gap-3">
          <div
            aria-hidden="true"
            className="h-24 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse"
          />
          <div
            aria-hidden="true"
            className="h-4 w-3/4 rounded-control bg-neutral-surface-sunken motion-safe:animate-pulse"
          />
        </div>
      ) : digest.adopted ? (
        <Adopted digest={digest} />
      ) : (
        <NotAdopted digest={digest} />
      )}
    </div>
  );
}
