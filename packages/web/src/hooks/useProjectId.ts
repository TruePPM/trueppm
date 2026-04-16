import { useParams } from 'react-router';

/**
 * Return the current project ID from the URL path param `:projectId`.
 *
 * All project-scoped routes are nested under `/projects/:projectId/` (ADR-0030),
 * so this hook is the canonical way for any component within that route tree to
 * read the active project.  Components rendered outside project routes receive
 * `undefined`.
 */
export function useProjectId(): string | undefined {
  const { projectId } = useParams<{ projectId: string }>();
  return projectId;
}
