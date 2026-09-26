import { useContext } from 'react';
import { useParams } from 'react-router';
import { isUuid } from '@/lib/refPath';
import { ProgramRefContext } from '@/router/refContext';
import { useResolveRef } from './useResolveRef';

/**
 * The active program's **UUID** (ADR-0070, ADR-0095, ADR-1237 §7).
 *
 * The `:programId` route param may be a program key (`atlas-platform-launch`) or a
 * UUID, so it must never reach an API call raw. Below `ProgramRefBoundary` this
 * reads the resolved id from context; above it (the `AppShell` chrome) it reads the
 * same `['resolve', 'program', ref]` cache entry. Returns `undefined` off a program
 * route — including on project routes — and while a key is still resolving.
 * Mirrors `useProjectId`.
 */
export function useProgramId(): string | undefined {
  const resolved = useContext(ProgramRefContext);
  const { programId: param } = useParams<{ programId: string }>();
  const lookup = useResolveRef('program', resolved || isUuid(param) ? undefined : param);
  if (resolved) return resolved.id;
  if (isUuid(param)) return param;
  return lookup.data?.type === 'program' ? lookup.data.id : undefined;
}
