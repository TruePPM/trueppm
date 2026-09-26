import { useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { NotFoundPage } from '@/components/NotFoundPage';
import { ProjectNotFound, PROJECT_LINK_NEEDS_CONNECTION } from '@/features/project/ProjectNotFound';
import { ProjectShellFrame } from '@/features/project/ProjectShell';
import { replaceRefSegment, type RefKind } from '@/lib/refPath';
import { ProgramRefContext, ProjectRefContext, type ResolvedRef } from './refContext';
import { useRouteRef, type RouteRef } from './useRouteRef';

/**
 * Keep the address bar on the object's current key (ADR-1237 UX §3 "Rewrite").
 *
 * `history.replace`, never push: a retired key or UUID URL simply *becomes* the
 * current one, with no toast and no visual change, and Back still leaves the
 * object rather than bouncing between two spellings of it. Everything after the
 * object segment — the rest of the path, the query and the hash — is kept.
 */
function useCanonicalRewrite(kind: RefKind, param: string | undefined, route: RouteRef): void {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, ref } = route;
  useEffect(() => {
    if (status !== 'resolved' || !ref || !param || ref === param) return;
    const pathname = replaceRefSegment(location.pathname, kind, ref);
    if (pathname === location.pathname) return;
    void navigate(`${pathname}${location.search}${location.hash}`, {
      replace: true,
      state: location.state as unknown,
    });
  }, [
    status,
    ref,
    param,
    kind,
    navigate,
    location.pathname,
    location.search,
    location.hash,
    location.state,
  ]);
}

/**
 * Route boundary for `/projects/:projectId/*` (ADR-1237 §7).
 *
 * Resolves the raw param — a key, a retired key or a UUID — once, provides the
 * UUID to everything below through `ProjectRefContext` (read with
 * `useProjectId()`), and rewrites the URL to the current key.
 *
 * - **Resolving:** the ProjectShell frame with an empty body — no spinner, no
 *   blank page, no new component (UX §3).
 * - **404:** the existing `ProjectNotFound`, identical to a UUID the caller cannot
 *   see, because the resolver makes the two cases indistinguishable on purpose.
 * - **Offline, never resolved:** the same not-found body with the connection copy;
 *   `AppShell` already paints the offline banner above it.
 *
 * This module is the only place allowed to read `useParams().projectId`
 * (`no-restricted-syntax` in `eslint.config.js`).
 */
export function ProjectRefBoundary({ children }: { children: ReactNode }) {
  const { projectId: param } = useParams<{ projectId: string }>();
  const route = useRouteRef('project', param);
  useCanonicalRewrite('project', param, route);
  const value = useMemo<ResolvedRef | null>(
    () => (route.id && route.ref ? { id: route.id, ref: route.ref } : null),
    [route.id, route.ref],
  );

  if (route.error) throw route.error;
  if (route.status === 'not-found') return <ProjectNotFound />;
  if (route.status === 'offline') return <ProjectNotFound body={PROJECT_LINK_NEEDS_CONNECTION} />;
  if (!value) return <ProjectShellFrame />;
  return <ProjectRefContext.Provider value={value}>{children}</ProjectRefContext.Provider>;
}

/**
 * Route boundary for `/programs/:programId/*` — the program twin of
 * {@link ProjectRefBoundary}. A program ref is a key or a UUID only. Its
 * not-found is the app's existing `NotFoundPage` (programs have no dedicated
 * one), and it renders an empty frame while resolving.
 */
export function ProgramRefBoundary({ children }: { children: ReactNode }) {
  const { programId: param } = useParams<{ programId: string }>();
  const route = useRouteRef('program', param);
  useCanonicalRewrite('program', param, route);
  const value = useMemo<ResolvedRef | null>(
    () => (route.id && route.ref ? { id: route.id, ref: route.ref } : null),
    [route.id, route.ref],
  );

  if (route.error) throw route.error;
  if (route.status === 'not-found' || route.status === 'offline') return <NotFoundPage />;
  if (!value) return <div className="flex h-full flex-col bg-neutral-surface" />;
  return <ProgramRefContext.Provider value={value}>{children}</ProgramRefContext.Provider>;
}
