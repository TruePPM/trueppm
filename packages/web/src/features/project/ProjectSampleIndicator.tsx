import { Link } from 'react-router';
import { useProject } from '@/hooks/useProject';
import { useDemoMode } from '@/hooks/useDemoMode';

/**
 * Compact "this is demo data" strip for project-level views (#1053).
 *
 * The full {@link SampleDataBanner} lives on the program overview; once an
 * evaluator navigates into a project's Schedule/Board/Sprints they lose that
 * signal and may not realize edits mutate demo data. This thinner indicator
 * keeps the cue present and links back to the program overview where the demo
 * can be removed — it deliberately does not duplicate the destructive teardown.
 *
 * Once the demo's dates have drifted (#3481) the strip says so, but it carries
 * **no** shift control — for the same reason it carries no teardown: notice in
 * many places, act in one. "Manage demo data" is the route to both.
 *
 * Renders nothing unless the project belongs to a bundled sample program.
 *
 * **The whole strip is absent in the read-only interactive demo (#4050 A1).**
 * Everything it says is said by `DemoModeBar`: the mode, the sample-data
 * provenance, the program name, and — as a switcher rather than a caption — the
 * project. It was one of five strips that between them left the landing Gantt a
 * third of the viewport, and the cheapest of the five to remove, because its
 * replacement already renders one row up. A self-hoster's own demo program is
 * unaffected: that deployment is not `isDemoReadOnly`, and the strip is the only
 * sample-data cue it has.
 *
 * **"Manage demo data" is hidden, not rendered inert, when the strip DOES
 * render on a demo deployment (#4049).** The comment composer and attachment controls
 * disable-and-explain with {@link DEMO_DISABLED_NOTE} because they are
 * actions attempted in place — the visitor is already looking at the
 * surface a note can sit beside. This is a navigation link: following it
 * takes the read-only `atlas-visitor` to the program overview only to meet
 * every teardown/reset control refused there too, and it reads as an admin
 * affordance on the very first screen. Hiding it is the same call
 * `DemoModeBar` makes for the whole indicator — nothing to explain because
 * there is nothing to click.
 */
export function ProjectSampleIndicator({ projectId }: { projectId: string | null }) {
  const { data: project } = useProject(projectId ?? undefined);
  const { isDemoReadOnly } = useDemoMode();
  if (isDemoReadOnly) return null;
  if (!project?.is_sample) return null;

  const program = project.program_detail;
  // Matches SampleDataBanner's STALE_THRESHOLD_DAYS. Below four weeks the drift
  // is cosmetic and this strip has only one line to spend.
  const daysStale = program?.sample_days_stale ?? null;
  const isStale = daysStale !== null && daysStale >= 28;
  return (
    <div
      role="note"
      aria-label="This is sample data"
      className="flex items-center justify-between gap-2 flex-shrink-0 px-4 py-1 text-xs
        border-b border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary"
    >
      <span>
        Demo project
        {program ? (
          <>
            {' — part of '}
            <span className="font-medium text-neutral-text-primary">{program.name}</span>
          </>
        ) : null}
        {isStale ? (
          <>
            {' · '}
            <span className="font-medium text-neutral-text-primary">
              dates {daysStale} days out of date
            </span>
          </>
        ) : null}
      </span>
      {program && !isDemoReadOnly ? (
        <Link
          to={`/programs/${program.id}`}
          className="underline hover:text-neutral-text-primary focus:outline-none
            focus:ring-2 focus:ring-brand-primary rounded-control"
        >
          Manage demo data
        </Link>
      ) : null}
    </div>
  );
}
