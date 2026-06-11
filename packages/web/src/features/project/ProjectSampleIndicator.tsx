import { Link } from 'react-router';
import { useProject } from '@/hooks/useProject';

/**
 * Compact "this is demo data" strip for project-level views (#1053).
 *
 * The full {@link SampleDataBanner} lives on the program overview; once an
 * evaluator navigates into a project's Schedule/Board/Sprints they lose that
 * signal and may not realize edits mutate demo data. This thinner indicator
 * keeps the cue present and links back to the program overview where the demo
 * can be removed — it deliberately does not duplicate the destructive teardown.
 *
 * Renders nothing unless the project belongs to a bundled sample program.
 */
export function ProjectSampleIndicator({ projectId }: { projectId: string | null }) {
  const { data: project } = useProject(projectId ?? undefined);
  if (!project?.is_sample) return null;

  const program = project.program_detail;
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
      </span>
      {program ? (
        <Link
          to={`/programs/${program.id}`}
          className="underline hover:text-neutral-text-primary focus:outline-none
            focus:ring-2 focus:ring-brand-primary rounded"
        >
          Manage demo data
        </Link>
      ) : null}
    </div>
  );
}
