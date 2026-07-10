import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjectId } from '@/hooks/useProjectId';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useActiveSprint } from '@/hooks/useSprints';
import { useCurrentSprintTargets } from '@/hooks/useCurrentSprintTargets';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useShellStore } from '@/stores/shellStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { isTabVisibleForMethodology } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import type { Methodology } from '@/types';
import type { CommandItem } from './commandItems';

const THEME_CYCLE: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };

/** Humanize a TaskStatus enum ("IN_PROGRESS" → "In progress") for the task detail
 *  line. Tolerates a missing status — nested/WS-delta task payloads can omit it,
 *  in which case the detail line just drops the status segment. */
function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  const lower = status.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Assembles the live command-palette items (ADR-0138, issue 647) in two tiers:
 *
 * - **Tier 1** (global): every reachable program/project → overview, plus
 *   methodology-gated Backlog and Board targets. Built from the already-loaded
 *   project/program lists — no per-project fetches.
 * - **Tier 2** (current project only, when on a `/projects/:id` route): task
 *   search → inline drawer, active-sprint + retro targets, and a role/facet-gated
 *   backlog-grooming target. Each is a single (often already-cached) fetch for the
 *   one in-context project, so there is no N+1 fan-out.
 *
 * The detail hooks (tasks, sprints, role/facets) are disabled while the palette is
 * closed (`enabled === false`) so the feature stays inert until it is opened. Each
 * item closes the palette before acting so focus returns cleanly.
 */
export function useCommandItems(enabled = true): CommandItem[] {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const openTask = useTaskDrawerStore((s) => s.openTask);

  // Current project context (Tier 2). Undefined off a project route — every
  // Tier-2 hook below is no-op'd in that case, and while the palette is closed.
  const currentProjectId = useProjectId();
  const tier2Id = enabled ? currentProjectId : undefined;
  const { tasks } = useScheduleTasks(tier2Id);
  const { sprint: activeSprint } = useActiveSprint(tier2Id);
  // First-class "jump to current sprint" targets (issue 1594) — the current project's
  // active sprint plus every other team's, shared with the pinned shell control.
  const sprintTargets = useCurrentSprintTargets(tier2Id);
  const canManageBacklog = useCanManageBacklog(tier2Id);
  const { user } = useCurrentUser();
  const iteration = useIterationLabel(tier2Id ?? null);

  const currentProject = useMemo(
    () => projects?.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  return useMemo(() => {
    // Wrap every action so the overlay closes first, then the effect runs.
    const act = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const go = (path: string) =>
      act(() => {
        void navigate(path);
      });

    // ---- Jump to current sprint (first-class, top-ranked) --------------------
    // The issue 1594 headline action: one entry per team with a live ACTIVE sprint,
    // each landing directly on that sprint's board (`?sprint=` scope). Works from
    // anywhere (not just a project route) so a multi-team Scrum Master reaches any
    // of their boards without hunting through the SPRINT view tabs.
    const sprintJumps: CommandItem[] = sprintTargets.map((t) => ({
      id: `sprint:${t.sprintId}`,
      label: `Current sprint — ${t.sprintName}`,
      group: 'sprint',
      tag: 'Sprint',
      detail: t.projectName,
      keywords: `jump current active sprint board ${t.projectName}`,
      run: go(t.path),
    }));

    // ---- Tier 2: Tasks (current project) -------------------------------------
    // Built for every current-project task; the palette query filters them and
    // caps the visible set. Selecting one opens the app-wide drawer in place.
    // Gated on `tier2Id` (not `currentProjectId`) so the Tier-2 items are built
    // only while the palette is open — `useScheduleTasks` falls back to the route
    // project when handed `undefined`, so gating on the raw route id would build
    // task items (and read possibly-partial task data) on every project route even
    // with the palette closed.
    const taskItems: CommandItem[] = [];
    if (tier2Id) {
      for (const task of tasks ?? []) {
        const detail = [task.wbs, formatStatus(task.status)].filter(Boolean).join(' · ');
        taskItems.push({
          id: `task:${task.id}`,
          label: `Open task: ${task.name}`,
          group: 'task',
          tag: 'Task',
          detail,
          keywords: `${task.shortId ?? ''} ${task.wbs ?? ''} ${task.status ?? ''}`,
          run: act(() => openTask(task, tier2Id)),
        });
      }
    }

    // ---- Tier 2: Current project (sprint + role-gated grooming) ---------------
    const currentItems: CommandItem[] = [];
    if (tier2Id) {
      const projectName = currentProject?.name ?? 'this project';
      // The in-context active sprint's *board* jump lives in the top-ranked
      // `sprint` group (issue 1594); the retro jump stays here as an in-context target.
      if (activeSprint) {
        currentItems.push({
          id: `current:retro:${tier2Id}`,
          label: `Open ${activeSprint.name} retro`,
          group: 'current',
          tag: 'Sprint',
          keywords: 'retrospective sprint',
          run: go(`/projects/${tier2Id}/sprints`),
        });
      }
      // Role/facet-gated: backlog grooming is Product-Owner-facet or Admin+ only,
      // and only meaningful on a methodology that has a backlog (ADR-0105). The
      // gate reads the server-provided role/facets — never an invented client rule.
      if (canManageBacklog && currentProject?.methodology !== 'WATERFALL') {
        currentItems.push({
          id: `current:groom:${tier2Id}`,
          label: `Groom backlog — ${projectName}`,
          group: 'current',
          tag: 'Backlog',
          keywords: 'product backlog grooming prioritize',
          run: go(`/projects/${tier2Id}/product-backlog`),
        });
      }
      // Hidden views stay reachable via ⌘K (ADR-0139). Surface a "Go to {label}"
      // jump for each view the user has personally hidden that *would* be visible
      // for this project's methodology — methodology-hidden views are excluded
      // (the user can't hide those, and they communicate "not how we work here").
      const hiddenViews = new Set(user?.hidden_views ?? []);
      if (hiddenViews.size > 0) {
        const methodology: Methodology = currentProject?.methodology ?? 'HYBRID';
        for (const view of hiddenViews) {
          if (!isTabVisibleForMethodology(view, methodology)) continue;
          const label = view === 'sprints' ? iteration.plural : VIEW_TAB_META[view]?.label;
          if (!label) continue;
          currentItems.push({
            id: `current:hidden-view:${tier2Id}:${view}`,
            label: `Go to ${label}`,
            group: 'current',
            tag: 'View',
            keywords: `view hidden ${view}`,
            run: go(`/projects/${tier2Id}/${view}`),
          });
        }
      }
    }

    // ---- Tier 1: Jump to (global) --------------------------------------------
    const jumps: CommandItem[] = [
      { id: 'jump:my-work', label: 'My Work', group: 'jump', tag: 'View', run: go('/me/work') },
      {
        id: 'jump:inbox',
        label: 'Notifications',
        group: 'jump',
        tag: 'View',
        keywords: 'notifications inbox',
        run: go('/me/notifications'),
      },
      { id: 'jump:programs', label: 'Programs', group: 'jump', tag: 'View', run: go('/programs') },
    ];
    for (const program of programs ?? []) {
      jumps.push({
        id: `jump:program:${program.id}`,
        label: program.name,
        group: 'jump',
        tag: 'Program',
        keywords: program.code,
        run: go(`/programs/${program.id}/overview`),
      });
    }
    for (const project of projects ?? []) {
      jumps.push({
        id: `jump:project:${project.id}`,
        label: project.name,
        group: 'jump',
        tag: 'Project',
        // Overview is the one view present for every methodology — a safe default.
        run: go(`/projects/${project.id}/overview`),
      });
    }

    // ---- Tier 1: Backlog + Board (global) ------------------------------------
    const backlog: CommandItem[] = [];
    const board: CommandItem[] = [];
    for (const project of projects ?? []) {
      // Backlog exists only for Agile/Hybrid projects (ADR-0105); methodology is
      // on the list payload, so this gates with no extra fetch.
      if (project.methodology !== 'WATERFALL') {
        backlog.push({
          id: `backlog:${project.id}`,
          label: `Backlog: ${project.name}`,
          group: 'backlog',
          tag: 'Backlog',
          keywords: 'product backlog',
          run: go(`/projects/${project.id}/product-backlog`),
        });
      }
      board.push({
        id: `board:${project.id}`,
        label: `Board: ${project.name}`,
        group: 'board',
        tag: 'Board',
        keywords: 'kanban sprint board',
        run: go(`/projects/${project.id}/board`),
      });
    }

    // ---- Global actions ------------------------------------------------------
    const actions: CommandItem[] = [
      {
        id: 'action:cycle-theme',
        label: `Switch theme (now: ${theme})`,
        group: 'action',
        tag: 'Action',
        keywords: 'dark light auto appearance',
        run: act(() => setTheme(THEME_CYCLE[theme])),
      },
      {
        id: 'action:toggle-sidebar',
        label: 'Toggle sidebar',
        group: 'action',
        tag: 'Action',
        keywords: 'collapse expand rail',
        run: act(toggleSidebar),
      },
    ];

    // Order matches the palette's GROUP_ORDER so keyboard nav and the visual
    // sections agree.
    return [
      ...sprintJumps,
      ...taskItems,
      ...currentItems,
      ...jumps,
      ...backlog,
      ...board,
      ...actions,
    ];
  }, [
    navigate,
    programs,
    projects,
    theme,
    setTheme,
    toggleSidebar,
    setOpen,
    openTask,
    tier2Id,
    currentProject,
    tasks,
    activeSprint,
    sprintTargets,
    canManageBacklog,
    user,
    iteration,
  ]);
}
