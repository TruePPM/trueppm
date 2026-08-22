import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { Methodology } from '@/types';
import { SettingsPageTitle } from '../SettingsShell';
import { settingsDocsSlug } from '../settingsDocs';
import { ProjectMethodologyPage } from './ProjectMethodologyPage';
import { ProjectWorkflowPage } from './ProjectWorkflowPage';
import { ProjectGuardrailsPage } from './ProjectGuardrailsPage';

/**
 * The former section ids this one section now answers for (#2969).
 *
 * Exported rather than inlined because three separate things have to agree on it
 * and none of them can derive it from the others:
 *   - `ProjectSettingsPage` builds the shell's `anchorAliases` from it, so
 *     `…/settings#methodology` still resolves;
 *   - `router.tsx` redirects the matching `…/settings/<slug>` routes here;
 *   - `settingsDocs.test.ts` counts these ids as reachable help surfaces, so the
 *     per-block "Learn more" links stay resolution-checked against the docs tree
 *     even though they are no longer nav rows.
 *
 * Order is document order — it is what the page renders.
 */
export const TEAM_WORKFLOW_SUBSECTION_IDS = ['methodology', 'workflow', 'guardrails'] as const;

/** The consolidated section's own id, and the target every retired anchor resolves to. */
export const TEAM_WORKFLOW_SECTION_ID = 'how-this-team-works';

/**
 * `gives` takes the project's own word for an iteration rather than saying
 * "sprint" (ADR-0111): this paragraph sits directly above one that already uses
 * the configured label, and a project that relabeled the container would
 * otherwise read "sprints … paced in iterations" in two consecutive sentences.
 */
const METHOD_SUMMARY: Record<Methodology, { label: string; gives: (iteration: string) => string }> =
  {
    AGILE: {
      label: 'Agile',
      gives: (i) => `${i}s, story points and velocity, with the Board leading`,
    },
    WATERFALL: {
      label: 'Waterfall',
      gives: () => 'phases, gates, baselines and the critical path, with the Schedule leading',
    },
    HYBRID: {
      label: 'Hybrid',
      gives: (i) =>
        `phase gates on the outside and ${i}s inside delivery — Schedule and Board together`,
    },
  };

/**
 * A plain-language restatement of the preset, and of what it does *not* do.
 *
 * The constraint on this whole page (epic #2743, issue #2969) is that the
 * methodology preset **communicates and never enforces**. That is easy to state
 * and easy to erode: the natural next control on a page like this is one that
 * stops a team doing something the preset did not anticipate, and each such
 * control is individually defensible. So the position is written on the surface
 * itself, where anyone adding a control has to read it, and this block renders no
 * control at all — it is prose and a link.
 *
 * The escape hatch named here is real: `Surfaces` re-enables anything the preset
 * switched off, which is why "sets defaults, never limits" is a true sentence
 * rather than a reassuring one.
 */
function PresetSummary() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const itl = useIterationLabel(projectId);

  const effective: Methodology = project?.effective_methodology ?? project?.methodology ?? 'HYBRID';
  const summary = METHOD_SUMMARY[effective];
  const cadence = project?.board_cadence ?? 'sprint';
  const isWaterfall = effective === 'WATERFALL';

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-3.5 space-y-2">
      <p className="text-[13px] text-neutral-text-primary">
        This team runs <span className="font-semibold">{summary.label}</span> —{' '}
        {summary.gives(itl.lower)}.
        {!isWaterfall && (
          <>
            {' '}
            Work is paced{' '}
            <span className="font-semibold">
              {cadence === 'continuous' ? 'as continuous flow' : `in ${itl.lower}s`}
            </span>
            .
          </>
        )}
      </p>
      <p className="text-[12px] text-neutral-text-secondary">
        A preset describes how this team works. It sets defaults, never limits — every surface it
        switches off can be turned back on under <span className="font-medium">Surfaces</span>, and
        nothing on this page stops anyone doing something it did not anticipate.
      </p>
    </div>
  );
}

/**
 * Project settings → **How this team works** (#2969, epic #2743).
 *
 * Three settings anchors — Methodology, Workflow &amp; fields, and
 * {iteration} guardrails — used to be three rail rows scattered across two
 * groups. A delivery lead standing a team up had to find all three and could not
 * see them as one decision, which is what they are: the shape of the work, the
 * stages it moves through, and the rules the team holds itself to.
 *
 * The three blocks are the existing section components mounted `embedded` — not
 * reimplementations. In particular the board columns appear here as the Statuses
 * list the Workflow block already renders, with its WIP limits and its lane
 * editor (#2967). There is deliberately no second column editor on this page;
 * two editors over one `BoardColumnConfig` is how the two drift.
 *
 * The retired anchors keep working: the router redirects the three
 * `…/settings/<slug>` routes here, and the shell rewrites the three
 * `…/settings#<slug>` hashes (see `anchorAliases` in `SettingsShell`). A settings
 * URL in someone's runbook must not 404 to make a nav change tidy.
 */
export function ProjectTeamWorkflowPage() {
  return (
    <div>
      <SettingsPageTitle
        title="How this team works"
        subtitle="The planning model, the stages work moves through, and the rules this team holds itself to — one decision, in one place."
      />

      <div className="px-6 pt-4 max-w-[920px]">
        <PresetSummary />
      </div>

      <ProjectMethodologyPage embedded docsHref={settingsDocsSlug('project', 'methodology')} />
      <ProjectWorkflowPage embedded docsHref={settingsDocsSlug('project', 'workflow')} />
      <ProjectGuardrailsPage embedded docsHref={settingsDocsSlug('project', 'guardrails')} />
    </div>
  );
}
