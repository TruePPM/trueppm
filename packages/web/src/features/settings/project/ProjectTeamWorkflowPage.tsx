import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { Methodology } from '@/types';
import {
  SettingsPageTitle,
  SettingsBlock,
  scrollToSettingsSubAnchor,
  DOCS_LINK_INLINE,
} from '../SettingsShell';
import { settingsDocsSlug } from '../settingsDocs';
import { ProjectMethodologyPage } from './ProjectMethodologyPage';
import { ProjectWorkflowPage } from './ProjectWorkflowPage';
import { ProjectGuardrailsPage } from './ProjectGuardrailsPage';

/**
 * The former section ids this one section now answers for (#2969).
 *
 * Exported rather than inlined because four separate things have to agree on it
 * and none of them can derive it from the others:
 *   - `ProjectSettingsPage` builds the shell's `anchorAliases` from it, so
 *     `…/settings#methodology` still resolves;
 *   - `router.tsx` redirects the matching `…/settings/<slug>` routes here;
 *   - each id is also this page's `data-settings-anchor` sub-anchor, so a retired
 *     deep link lands on the block rather than the top of a very tall section;
 *   - `settingsDocs.test.ts` counts these ids as reachable help surfaces, so the
 *     per-block "Learn more" links stay resolution-checked against the docs tree
 *     even though they are no longer nav rows.
 *
 * Order is document order — it is what the page renders, and a test pins that.
 */
export const TEAM_WORKFLOW_SUBSECTION_IDS = ['methodology', 'workflow', 'guardrails'] as const;

export type TeamWorkflowSubsectionId = (typeof TEAM_WORKFLOW_SUBSECTION_IDS)[number];

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
 * A plain-language restatement of the preset, and an honest account of what it
 * does and does not decide.
 *
 * The constraint on this page (epic #2743, issue #2969) is that the methodology
 * preset **communicates and never enforces**. That is easy to state and easy to
 * erode: the natural next control on a page like this is one that stops a team
 * doing something the preset did not anticipate, and each such control is
 * individually defensible. So the position is written on the surface itself,
 * where anyone adding a control has to read it, and this block renders no control
 * — only prose and links.
 *
 * Two claims here are deliberately narrow, because the obvious wider versions are
 * false on this very page:
 *   - the preset **hides** Board / Schedule / Sprints; it does not disable them,
 *     and it is not Settings → Surfaces that brings them back (Surfaces toggles
 *     Reports, Time tracking, Baselines and the Monte-Carlo forecast — a
 *     different set). The way back is to change the preset, which is one block
 *     below;
 *   - **Sprint guardrails**, further down this same page, genuinely can stop an
 *     action: an Owner may escalate a composition rule from Warn to Block. Saying
 *     "nothing on this page stops anyone" would be contradicted two screens later
 *     by a control whose help text reads "Block stops the action outright with no
 *     override."
 *
 * `role="status"` because the summary rewrites itself when the preset changes in
 * the Methodology block below — well off-screen from here. Without the live
 * region the confirmation this block exists to give is announced to nobody.
 */
function PresetSummary() {
  const projectId = useProjectId();
  const { data: project, isLoading } = useProject(projectId);
  const itl = useIterationLabel(projectId);

  // Say nothing rather than assert a default. `?? 'HYBRID'` would state
  // "This team runs Hybrid" as fact to a Waterfall project for the length of the
  // fetch, and this block's whole job is to be the trustworthy restatement.
  const effective: Methodology | null =
    project?.effective_methodology ?? project?.methodology ?? null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-3.5 space-y-2"
    >
      {effective === null ? (
        <p className="text-[13px] text-neutral-text-secondary">
          {isLoading ? 'Reading this project’s setup…' : 'This project’s setup is unavailable.'}
        </p>
      ) : (
        <p className="text-[13px] text-neutral-text-primary">
          This team runs <span className="font-semibold">{METHOD_SUMMARY[effective].label}</span> —{' '}
          {METHOD_SUMMARY[effective].gives(itl.lower)}.
          {effective !== 'WATERFALL' && (
            <>
              {' '}
              Work is paced{' '}
              <span className="font-semibold">
                {(project?.board_cadence ?? 'sprint') === 'continuous'
                  ? 'as continuous flow'
                  : `in ${itl.lower}s`}
              </span>
              .
            </>
          )}
        </p>
      )}
      <p className="text-[12px] text-neutral-text-secondary">
        A preset describes how this team works. It sets defaults, never limits: the surfaces it
        leaves out are hidden, not withdrawn, and changing the preset below brings them back. The
        one place this section can stop an action is{' '}
        <span className="font-medium">{itl.singular} guardrails</span>, at the end of the page,
        where a project Owner may escalate a rule from Warn to Block. Optional surfaces — Reports,
        Time tracking, Baselines, the forecast — are switched on under{' '}
        <a href="#surfaces" className={`text-[12px] ${DOCS_LINK_INLINE}`}>
          Surfaces
        </a>
        .
      </p>
    </div>
  );
}

const BLOCK_LABEL: Record<TeamWorkflowSubsectionId, (iterationSingular: string) => string> = {
  methodology: () => 'Methodology',
  workflow: () => 'Workflow & fields',
  guardrails: (i) => `${i} guardrails`,
};

/**
 * In-section jump strip.
 *
 * The merge buys one rail row and pays for it in navigability: the rail's
 * scroll-spy now stays pinned to a single row across the tallest stretch of the
 * settings page, and on mobile the rail is a `<select>` whose one option covers
 * many screens. These three buttons are what pays that back — and they are the
 * only in-page route to a block for a user who did not arrive by a retired
 * deep link.
 *
 * Buttons rather than `<a href="#…">`: the retired hashes are exactly what the
 * shell rewrites, so linking to one would move the URL off the block the user
 * just asked for. They scroll and move focus; they change no state, which keeps
 * the "this section configures, it does not gate" position intact.
 */
function BlockJumpStrip({ iterationSingular }: { iterationSingular: string }) {
  return (
    <nav aria-label="In this section" className="flex flex-wrap items-center gap-1.5">
      {TEAM_WORKFLOW_SUBSECTION_IDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => scrollToSettingsSubAnchor(id)}
          className="min-h-[32px] px-2.5 rounded-control text-[12px] font-medium
            text-neutral-text-secondary hover:text-neutral-text-primary
            hover:bg-neutral-surface-sunken
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          {BLOCK_LABEL[id](iterationSingular)}
        </button>
      ))}
    </nav>
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
 * The three blocks are the existing section components mounted inside
 * `SettingsBlock` — not reimplementations. In particular the board columns appear
 * here as the Statuses list the Workflow block already renders, with its WIP
 * limits and its lane editor (#2967). There is deliberately no second column
 * editor on this page; two editors over one `BoardColumnConfig` is how the two
 * drift.
 *
 * The retired anchors keep working: the router redirects the three
 * `…/settings/<slug>` routes here, and the shell rewrites the three
 * `…/settings#<slug>` hashes and refines the scroll onto the matching
 * `data-settings-anchor` block. A settings URL in someone's runbook must not 404
 * — nor land three viewports short — to make a nav change tidy.
 */
export function ProjectTeamWorkflowPage() {
  const projectId = useProjectId();
  const itl = useIterationLabel(projectId);

  return (
    <div>
      <SettingsPageTitle
        title="How this team works"
        subtitle="The planning model, the stages work moves through, and the rules this team holds itself to — one decision, in one place."
      />

      <div className="px-6 pt-4 max-w-[920px] space-y-3">
        <PresetSummary />
        <BlockJumpStrip iterationSingular={itl.singular} />
      </div>

      <SettingsBlock anchor="methodology">
        <ProjectMethodologyPage embedded docsHref={settingsDocsSlug('project', 'methodology')} />
      </SettingsBlock>
      <SettingsBlock anchor="workflow">
        <ProjectWorkflowPage embedded docsHref={settingsDocsSlug('project', 'workflow')} />
      </SettingsBlock>
      <SettingsBlock anchor="guardrails">
        <ProjectGuardrailsPage embedded docsHref={settingsDocsSlug('project', 'guardrails')} />
      </SettingsBlock>
    </div>
  );
}
