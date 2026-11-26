/**
 * ⌘K find-by-key (#3888, ADR-1237): pure helpers that turn a `/resolve/` answer
 * into one palette row. Kept free of React/router like `omniSearch.ts`.
 *
 * The palette never parses a reference. {@link looksLikeRef} only decides whether
 * a query is worth asking the resolver about; the raw query goes to the server,
 * which owns the rightmost-marker split, retired keys and visibility.
 */
import type { ResolveResponse, ResolveResponseType } from '@/api/types';
import type { RoleContext } from '@/hooks/useCurrentUser';
import { taskDeepLinkPath } from '@/features/shell/lensOrder';
import { programPath, projectPath } from '@/lib/refPath';
import type { CommandItem } from './commandItems';

/** `PLAT-T-10`, `GA-SEC-SP-3`, `plat-r-7`: a key, a marker, a number. */
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]*-(?:T|SP|R)-\d{1,9}$/i;
/** A bare project key as people write it: `PLAT`, `GA-SEC`, `PLAT2`. */
const KEY_SHAPE = /^[A-Z][A-Z0-9-]{1,11}$/;

/**
 * Whether `query` is shaped like something the resolver could answer.
 *
 * Two shapes, both one token: a task/sprint/risk reference in any case, and a bare
 * key typed in capitals. A lowercase word ("plan", "risk") is not sent: it would
 * cost a resolver round trip on most searches, and a current project key is
 * already matched locally through the project rows' keywords. Typing the key in
 * capitals is how a key is written everywhere it appears, so that is the signal.
 *
 * @param query - The raw palette query.
 * @returns `true` when the query should be resolved.
 */
export function looksLikeRef(query: string): boolean {
  const q = query.trim();
  if (q.length < 2 || q.length > 64) return false;
  return REF_SHAPE.test(q) || KEY_SHAPE.test(q);
}

const REF_TAG: Record<ResolveResponseType, string> = {
  project: 'Project',
  program: 'Program',
  task: 'Task',
  sprint: 'Sprint',
  risk: 'Risk',
};

/**
 * Where a resolved reference opens. A task opens its drawer on the lens's landing
 * view (the same deep link omni-search uses), a sprint the board scoped to it, a
 * risk the project's risk register. Every path prefers the current key over the
 * UUID, so the address bar reads the way the user typed it.
 *
 * @returns The route, or null when the answer carries no project to route under.
 */
export function refRoute(resolved: ResolveResponse, lens: RoleContext): string | null {
  if (resolved.type === 'program') {
    return programPath({ id: resolved.id, code: resolved.key }, 'overview');
  }
  if (!resolved.project_id) return null;
  const project = { id: resolved.project_id, code: resolved.key };
  switch (resolved.type) {
    case 'project':
      return projectPath(project, 'overview');
    case 'task':
      return taskDeepLinkPath(
        encodeURIComponent(resolved.key || resolved.project_id),
        resolved.id,
        lens,
      );
    case 'sprint':
      return `${projectPath(project, 'board')}?sprint=${encodeURIComponent(resolved.id)}`;
    case 'risk':
      return projectPath(project, 'risk');
    default:
      return null;
  }
}

/**
 * The palette row for a resolved reference, or nothing.
 *
 * The label is `canonical_ref` (the current form, so a retired key shows what it
 * is called now); the typed query rides in `keywords` so the palette's substring
 * filter keeps the row even when the two differ.
 */
export function buildRefItems(
  resolved: ResolveResponse | null | undefined,
  query: string,
  go: (path: string) => () => void,
  lens: RoleContext,
): CommandItem[] {
  if (!resolved) return [];
  const path = refRoute(resolved, lens);
  if (path === null) return [];
  const typed = query.trim();
  const renamed = typed.toUpperCase() !== resolved.canonical_ref.toUpperCase();
  return [
    {
      id: `ref:${resolved.type}:${resolved.id}`,
      label: resolved.canonical_ref,
      group: 'reference',
      tag: REF_TAG[resolved.type],
      detail: renamed ? `Now ${resolved.canonical_ref} (was ${typed})` : undefined,
      keywords: `${typed} reference key`,
      run: go(path),
    },
  ];
}
