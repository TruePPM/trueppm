import { useParams } from 'react-router';

/**
 * Return the current program ID from the URL path param `:programId`.
 *
 * All program-scoped routes are nested under `/programs/:programId/` (ADR-0070),
 * so this hook is the canonical way for any component within that route tree to
 * read the active program. Components rendered outside program routes — and on
 * project routes — receive `undefined`. Mirrors `useProjectId` (ADR-0095).
 */
export function useProgramId(): string | undefined {
  const { programId } = useParams<{ programId: string }>();
  return programId;
}
