import { useContext } from 'react';
import { useParams } from 'react-router';
import { isUuid } from '@/lib/refPath';
import { ProjectRefContext } from '@/router/refContext';
import { useResolveRef } from './useResolveRef';

/**
 * The active project's **UUID** (ADR-0030, ADR-1237 §7).
 *
 * The `:projectId` route param is no longer necessarily a UUID — it may be a key
 * (`PLAT`), a retired key, or a UUID — so reading it with `useParams()` and handing
 * it to an API call sends a key to a UUID-typed endpoint. This hook is the one
 * reader, and the eslint `no-restricted-syntax` rule bans the raw param everywhere
 * else.
 *
 * Below `ProjectRefBoundary` it reads the resolved id from context. Above it — the
 * rail, TopBar and status chrome mounted by `AppShell` outside the route element —
 * it reads the same `['resolve', 'project', ref]` cache entry the boundary fills,
 * so both sides agree without a second request. Returns `undefined` off a project
 * route and while a key is still resolving.
 */
export function useProjectId(): string | undefined {
  const resolved = useContext(ProjectRefContext);
  const { projectId: param } = useParams<{ projectId: string }>();
  const lookup = useResolveRef('project', resolved || isUuid(param) ? undefined : param);
  if (resolved) return resolved.id;
  if (isUuid(param)) return param;
  return lookup.data?.type === 'project' ? lookup.data.id : undefined;
}
