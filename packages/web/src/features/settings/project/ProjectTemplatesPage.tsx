/**
 * Project · Settings · Templates — the screen the gallery's empty state promised
 * (#2909, design handoff `handoff-2909-2926` cases 01–03).
 *
 * The gallery has always told people to "publish one from a project's Settings".
 * That affordance did not exist in the web app: the only row-creation site was
 * the API's publish action. So the first job of this page is making that sentence
 * true.
 *
 * It is deliberately **not a form**. It is a statement of what this project would
 * become — six counts, from the server's own dry run — with one primary action
 * and a list of what has already been published from here. The PMO director's
 * question is "is this shape worth enforcing" and the delivery lead's is "what am
 * I about to hand other teams"; both are answered by numbers, before any field is
 * filled in.
 */
import { useState } from 'react';
import { useProject } from '@/hooks/useProject';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import { SettingsPageTitle } from '../SettingsShell';
import {
  usePublishPreview,
  useTemplatesFromProject,
  type ProjectTemplate,
} from '@/hooks/useProjectTemplates';
import { PublishTemplateSheet } from './PublishTemplateSheet';

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <div className="text-xl font-semibold text-neutral-text-primary tabular-nums">{value}</div>
      <div className="text-xs text-neutral-text-secondary">{label}</div>
    </div>
  );
}

function VersionRow({ template }: { template: ProjectTemplate }) {
  const used = template.usage_count ?? 0;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-neutral-border px-3 py-2 text-sm first:border-t-0">
      <span className="font-medium text-neutral-text-primary">{template.name}</span>
      <span className="rounded-chip border border-neutral-border px-1.5 text-xs text-neutral-text-secondary">
        v{template.version}
      </span>
      <span className="text-xs text-neutral-text-secondary">{template.methodology}</span>
      <span className="ml-auto text-xs text-neutral-text-secondary">
        {used} project{used === 1 ? '' : 's'}
        {template.is_superseded ? ' · superseded' : ''}
      </span>
    </li>
  );
}

export function ProjectTemplatesPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const { role, isLoading: roleLoading, isError: roleError } = useCurrentUserRole(projectId);
  const [sheetOpen, setSheetOpen] = useState(false);

  const canPublish = role != null && role >= ROLE_ADMIN;
  // Only fetched for someone who could act on it: the dry run runs a full
  // extraction server-side, and a Viewer opening Settings should not pay for it.
  const { data: preview } = usePublishPreview(canPublish ? (projectId ?? null) : null);
  const { data: published } = useTemplatesFromProject(projectId ?? null);

  return (
    <div className="flex flex-col gap-4">
      <SettingsPageTitle
        title="Templates"
        subtitle="Publish this project's shape so other teams can start from it."
      />

      <p className="max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
        A template carries the <strong>shape</strong> of this plan — the tree, the phases, the
        dependencies. Everything that belongs to a person, a date, or a fact that already happened
        is left behind. Publishing never changes this project, and never touches a project already
        created from an earlier version.
      </p>

      {roleError ? (
        // Distinct from "you are not an Admin". A failed membership read also
        // yields role === null, and reporting that as a permission verdict
        // tells an Admin they lack a role they hold (rule 246).
        <p role="alert" className="text-sm text-semantic-critical">
          Couldn&rsquo;t check your role on this project, so publishing is
          unavailable right now. This is a failed request, not a permission
          decision — reload to try again.
        </p>
      ) : roleLoading ? null : canPublish ? (
        <>
          <div className="rounded-card border border-neutral-border p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
              What would be published today
            </div>
            {preview ? (
              <div className="mt-3 flex flex-wrap gap-6">
                <Stat value={preview.task_count} label="tasks" />
                <Stat value={preview.phase_count} label="phases" />
                <Stat value={preview.gate_count} label="gates" />
                <Stat value={preview.dependency_count} label="dependencies" />
                <Stat value={preview.milestone_count} label="milestones" />
                <Stat value={preview.methodology ?? '—'} label="methodology" />
              </div>
            ) : (
              <p role="status" className="mt-3 text-sm text-neutral-text-secondary">
                Counting this project&rsquo;s shape…
              </p>
            )}
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              disabled={!preview}
              className="mt-4 h-11 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
                         hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:opacity-60
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Publish as template…
            </button>
            <p className="mt-2 text-xs text-neutral-text-secondary">
              Nothing is written until you confirm on the next screen.
            </p>
          </div>

          {sheetOpen && preview && projectId && (
            <PublishTemplateSheet
              projectId={projectId}
              projectName={project?.name ?? 'this project'}
              preview={preview}
              onClose={() => setSheetOpen(false)}
            />
          )}
        </>
      ) : (
        // A disabled button teaches nothing and reads as a bug. The section stays
        // and says what the gate is — being told the rule is more use than being
        // shown a control that cannot be pressed (handoff case 01 annot 4).
        <div className="rounded-card border border-neutral-border p-4">
          <p className="text-sm font-medium text-neutral-text-primary">
            Publishing a template needs Project Manager role
          </p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
            Everything a template would carry is already visible to you in the Schedule —
            publishing is the only act that is gated. Ask a Project Manager or Owner on this
            project to publish its shape.
          </p>
        </div>
      )}

      {published && published.length > 0 && (
        <section aria-labelledby="published-from-here">
          <h3
            id="published-from-here"
            className="mb-2 text-sm font-medium text-neutral-text-primary"
          >
            Published from this project
          </h3>
          {/* Versions accumulate rather than overwrite: the projects already
              created from v1 are the only audit trail a PMO has for why they
              look the way they do. */}
          <ul className="rounded-card border border-neutral-border">
            {published.map((t) => (
              <VersionRow key={t.id} template={t} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-text-secondary">
            A version is never edited in place — republishing writes a new one and leaves the old
            one selectable.
          </p>
        </section>
      )}
    </div>
  );
}
