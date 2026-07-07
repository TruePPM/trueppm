import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { methodologyLabel } from '@/lib/methodologyLabel';
import type { Program } from '@/api/types';

/**
 * Program-route view segment → display label. Mirrors `ProgramTabs`' `TABS` order
 * (the program nav's source of truth) so the location switcher's leaf reads the
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
 * or program in context (My Work, Inbox, the listing pages). Falls back to a
 * capitalized segment for any route not enumerated here.
 */
const GLOBAL_ROUTE_LABEL: Record<string, string> = {
  me: 'My Work',
  inbox: 'Inbox',
  notifications: 'Inbox',
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
  currentId: string;
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
 *   - program route                  → program picker · (project omitted) · program-view leaf
 *   - global route (My Work, …)      → leaf only (both segments omitted)
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
  // A project's program drives the program segment; on a program route the program
  // is itself in context. Chained id keeps the hook call unconditional.
  const effectiveProgramId = project?.program_detail?.id ?? programId;
  const { data: program } = useProgram(effectiveProgramId);

  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();

  // The project route's active view — reused for the leaf label and to preserve the
  // view when switching projects. Off a project this is unused.
  const projectView = projectId
    ? viewSegment(location.pathname, projectId, 'overview')
    : 'overview';
  const grouped = useGroupedProjectViews(projectId);

  const programSegment = useMemo<ProgramSegmentModel | null>(() => {
    if (!effectiveProgramId) return null;
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
    return { options, current: program };
  }, [effectiveProgramId, programId, location.pathname, programs, program]);

  const projectSegment = useMemo<ProjectSegmentModel | null>(() => {
    if (!projectId) return null;
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
        ? methodologyLabel(project.effective_methodology)
        : undefined,
    };
  }, [projectId, projects, projectView, project?.name, project?.effective_methodology]);

  const leaf = useMemo(() => {
    if (projectId) return grouped.labelFor(projectView);
    if (programId) {
      const seg = viewSegment(location.pathname, programId, 'overview');
      return PROGRAM_VIEW_LABEL[seg] ?? titleCase(seg);
    }
    const first = location.pathname.split('/').filter(Boolean)[0] ?? '';
    return GLOBAL_ROUTE_LABEL[first] ?? titleCase(first);
  }, [projectId, programId, projectView, location.pathname, grouped]);

  return {
    suppressed: onSettingsRoute,
    program: programSegment,
    project: projectSegment,
    leaf,
  };
}
