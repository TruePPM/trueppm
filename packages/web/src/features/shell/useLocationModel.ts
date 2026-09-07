import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProjectUnavailable } from '@/hooks/useProjectUnavailable';
import { useProgram } from '@/hooks/useProgram';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { methodologyStatusLabel } from '@/lib/methodologyLabel';
import type { Program } from '@/api/types';

/**
 * Program-route view segment → display label. Mirrors the rail's `PROGRAM_VIEWS`
 * order (the program nav's source of truth, #1920) so the location switcher's leaf reads the
 * same word the tab did. `settings` stays labelled across every `/settings/*`
 * sub-route (the segment after the id is always `settings`).
 */
const PROGRAM_VIEW_LABEL: Record<string, string> = {
  overview: 'Overview',
  backlog: 'Backlog',
  projects: 'Projects',
  schedule: 'Schedule',
  resources: 'Resources',
  members: 'Members',
  assets: 'Assets',
  settings: 'Settings',
};

/**
 * Off-project/off-program global route (first path segment) → leaf label. The
 * switcher collapses to this single "you are here" word when there is no project
 * or program in context (My Work, Notifications, the listing pages). Falls back to a
 * capitalized segment for any route not enumerated here.
 */
const GLOBAL_ROUTE_LABEL: Record<string, string> = {
  me: 'My Work',
  inbox: 'Notifications',
  notifications: 'Notifications',
  programs: 'Programs',
  projects: 'Projects',
  resources: 'Resources',
};

/** One selectable location — a program or project the user can jump to. */
export interface LocationSegmentOption {
  id: string;
  name: string;
  to: string;
}

/** The program segment's data, or null to omit the segment entirely. */
export interface ProgramSegmentModel {
  options: LocationSegmentOption[];
  current: Program | undefined;
}

/** The project segment's data, or null to omit the segment entirely. */
export interface ProjectSegmentModel {
  options: LocationSegmentOption[];
  /** The active project's id, or undefined off-project (#2102, ADR-0508 D3):
   *  the segment then renders as an unanchored "Jump to project…" placeholder
   *  picker whose options land on each project's Overview. */
  currentId: string | undefined;
  currentName: string | undefined;
  /** The current project's methodology label (web-rule 196: the resolved
   *  `effective_methodology`), shown as the picker's current-row subtitle (#1680).
   *  Only the current project carries a trustworthy value — the `useProjects()`
   *  list rows carry only the raw override — so it is absent for other options. */
  currentMethodologyLabel: string | undefined;
}

/** The resolved location-switcher model for the current route. */
export interface LocationModel {
  /** True on `/settings/*` routes — the switcher self-suppresses (rule 123): the
   *  SettingsShell mounts its own scope switcher there, so a second one collides. */
  suppressed: boolean;
  /** Program segment, or null to omit (a project with no program, or a global route). */
  program: ProgramSegmentModel | null;
  /** Project segment, or null to omit (a program route, or a global route). */
  project: ProjectSegmentModel | null;
  /** The plain "you are here" leaf label (never a dropdown — the rail owns view
   *  switching, so the leaf is the one deliberate dedup). */
  leaf: string;
}

/** The path segment immediately after `id` — the active view (defaults to `fallback`). */
function viewSegment(pathname: string, id: string, fallback: string): string {
  const segments = pathname.split('/');
  const idx = segments.indexOf(id);
  return (idx >= 0 ? segments[idx + 1] : undefined) ?? fallback;
}

/**
 * The active project view for a pathname, or `null` off a project route.
 *
 * A bare `/projects/:id` resolves to `overview`, matching what the location switcher's
 * leaf shows — so a caller reasoning about "which view am I on" agrees with the label
 * the user is reading. Exported so the shell keeps **one** view parser: anything that
 * needs to branch on the view (rule-284 suppression, per-view chip forms) comes
 * through here rather than adding a second `pathname.split('/')`.
 */
export function projectViewSegment(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'projects' || !segments[1]) return null;
  return segments[2] ?? 'overview';
}

function titleCase(segment: string): string {
  if (!segment) return 'Home';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * Resolve the top-bar location switcher's model from the current route (issue
 * #1643, ADR-0203). Composes the member-scoped `usePrograms()` / `useProjects()`
 * lists with the active project/program to yield the `Program › Project › Leaf`
 * anatomy. API-first: no new endpoint — the same lists that feed the rail and the
 * former in-chrome `ProjectSwitcher`.
 *
 * State resolution (see `LocationModel`):
 *   - project route with a program  → program picker · project picker · view leaf
 *   - project route, no program      → (program omitted) · project picker · view leaf
 *   - project route, project 404/403 → (program omitted) · "Jump to project…" placeholder
 *                                      · "Project unavailable" leaf (#3469) — the switcher never
 *                                        names a view of a project that is not there
 *   - program route                  → program picker · (project omitted) · program-view leaf
 *   - global route (My Work, …)      → "Jump to project…" placeholder picker · leaf
 *                                      (#2102, ADR-0508 D3; leaf-only with 0 projects)
 *   - settings route                 → `suppressed` (switcher renders nothing)
 *
 * Every option preserves the active view segment on switch: jumping projects keeps
 * you on the same view (`…/schedule` → the target's `…/schedule`); the route is
 * always reachable because methodology hides tabs, never routes (ADR-0041).
 */
export function useLocationModel(): LocationModel {
  const location = useLocation();
  const projectId = useProjectId();
  const programId = useProgramId();
  // Suppress on any settings route (project `/projects/:id/settings/*`, program
  // `/programs/:id/settings/*`, or workspace `/settings/*`): the SettingsShell owns
  // its own scope switcher there (rule 123), so a second one would collide. A plain
  // pathname test rather than `useMatch` — react-router splats must be terminal, so
  // a `/*/settings/*` pattern is invalid and never matches.
  const onSettingsRoute = /\/settings(\/|$)/.test(location.pathname);

  const { data: project } = useProject(projectId);
  // Same predicate ProjectShell renders `ProjectNotFound` on (#3469). On an
  // unavailable project the switcher has nothing true to say about where you are,
  // so it falls back to its off-project anatomy below.
  const projectUnavailable = useProjectUnavailable(projectId);

  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();

  // A project's program drives the program segment; on a program route the program
  // is itself in context. Chained id keeps the hook call unconditional.
  const routeProgramId = projectUnavailable ? undefined : (project?.program_detail?.id ?? programId);
  // `usePrograms()` is the member-scoped program list (DirectoryPagination,
  // page_size=200 — ADR-0401) that already supplies this segment's own options, so
  // a program absent from it is one the caller holds no membership on and
  // `GET /programs/{id}/` would 404 on. Gate the detail fetch on it rather than
  // firing and swallowing the failure: a project member outside the program used to
  // get a failed program request on every page plus a segment that rendered as a
  // bare leading chevron, because `current` stayed undefined and nothing read the
  // error (#3469).
  const memberProgram = routeProgramId
    ? ((programs ?? []).find((p) => p.id === routeProgramId) ?? null)
    : null;
  const { data: program } = useProgram(memberProgram ? routeProgramId : undefined);
  // Fall back to the list row so the segment renders from the first paint rather
  // than popping in when the detail request lands.
  const currentProgram = program ?? memberProgram ?? undefined;

  // The project route's active view — reused for the leaf label and to preserve the
  // view when switching projects. Off a project this is unused.
  const projectView = projectId
    ? viewSegment(location.pathname, projectId, 'overview')
    : 'overview';
  const grouped = useGroupedProjectViews(projectId);

  const programSegment = useMemo<ProgramSegmentModel | null>(() => {
    // Omitted, not blanked, when the caller is not a program member: a segment
    // whose name and picker are both empty renders as a leading chevron pointing at
    // nothing (#3469), and rule 124 already forbids a picker with nothing to pick.
    if (!routeProgramId || !currentProgram) return null;
    // On a program route, preserve the active program view; from a project route,
    // jumping to a program lands on its Overview.
    const targetView = programId
      ? viewSegment(location.pathname, programId, 'overview')
      : 'overview';
    const options: LocationSegmentOption[] = (programs ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      to: `/programs/${p.id}/${targetView}`,
    }));
    return { options, current: currentProgram };
  }, [routeProgramId, currentProgram, programId, location.pathname, programs]);

  const projectSegment = useMemo<ProjectSegmentModel | null>(() => {
    // An unavailable project takes the SAME branch as being off a project entirely
    // (#3469): the switcher keeps offering a one-hop jump into a project you can
    // actually open, and stops naming one you cannot. Anchoring `currentId` to it
    // instead rendered the id's row as checked-and-current with no name.
    if (!projectId || projectUnavailable) {
      // Off-project placeholder picker (#2102, ADR-0508 D3): on a global route
      // (My Work, Notifications, the listing pages) the segment still offers a
      // one-hop jump into any member project — no `current`, options land on each
      // project's Overview. Two deliberate bounds: a program route keeps its
      // program-picker-only anatomy (the D3 off-project anatomy is two-part —
      // `[Jump to project…] › Leaf` — and introduces no third segment), and with
      // zero projects the segment is omitted entirely (leaf-only; a picker with
      // nothing to pick is a dead affordance, rule 124).
      if (routeProgramId) return null;
      const list = projects ?? [];
      if (list.length === 0) return null;
      return {
        options: list.map((p) => ({
          id: p.id,
          name: p.name,
          to: `/projects/${p.id}/overview`,
        })),
        currentId: undefined,
        currentName: undefined,
        currentMethodologyLabel: undefined,
      };
    }
    const options: LocationSegmentOption[] = (projects ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      to: `/projects/${p.id}/${projectView}`,
    }));
    return {
      options,
      currentId: projectId,
      currentName: options.find((o) => o.id === projectId)?.name ?? project?.name,
      currentMethodologyLabel: project?.effective_methodology
        ? methodologyStatusLabel(project.effective_methodology, project.inherited_methodology)
        : undefined,
    };
  }, [
    projectId,
    projectUnavailable,
    routeProgramId,
    projects,
    projectView,
    project?.name,
    project?.effective_methodology,
    project?.inherited_methodology,
  ]);

  const leaf = useMemo(() => {
    // Naming the view ("Dashboard", "Schedule") on a project that is not there is
    // the leaf asserting a destination that does not exist (#3469). The route's own
    // terminal state is what the leaf reports instead. Checked before the
    // `projectId` branch, and before the `/projects` global label, which would
    // otherwise read as the projects listing.
    if (projectUnavailable) return 'Project unavailable';
    if (projectId) return grouped.labelFor(projectView);
    if (programId) {
      const seg = viewSegment(location.pathname, programId, 'overview');
      return PROGRAM_VIEW_LABEL[seg] ?? titleCase(seg);
    }
    const first = location.pathname.split('/').find(Boolean) ?? '';
    return GLOBAL_ROUTE_LABEL[first] ?? titleCase(first);
  }, [projectUnavailable, projectId, programId, projectView, location.pathname, grouped]);

  return {
    suppressed: onSettingsRoute,
    program: programSegment,
    project: projectSegment,
    leaf,
  };
}
