import { useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';

import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjectId } from '@/hooks/useProjectId';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useResourceSearch } from '@/hooks/useResourceSearch';
import { useOmniSearch } from '@/hooks/useOmniSearch';
import { useRecentProjects } from '@/hooks/useRecentProjects';
import { useActiveSprint } from '@/hooks/useSprints';
import { formatRelative } from '@/lib/formatRelative';
import { useCurrentSprintTargets } from '@/hooks/useCurrentSprintTargets';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { WORKSPACE_ADMIN_ROLE } from '@/hooks/useIsWorkspaceAdmin';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useLabels } from '@/hooks/useLabels';
import { usePinned, useTogglePin } from '@/hooks/usePins';
import { useShellStore } from '@/stores/shellStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { isTabVisibleForMethodology } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import type { Methodology } from '@/types';
import type { CommandItem, PinTarget } from './commandItems';
import { buildOmniSearchItems } from './omniSearch';
import { buildWorkspaceNavGroups } from '@/features/settings/workspace/workspaceNav';
import { ME_SETTINGS_LINKS } from '@/features/me/MeSettingsSubNav';
import { useFeedbackStore } from '@/stores/feedbackStore';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';

const THEME_CYCLE: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };

/** Humanize a TaskStatus enum ("IN_PROGRESS" → "In progress") for the task detail
 *  line. Tolerates a missing status — nested/WS-delta task payloads can omit it,
 *  in which case the detail line just drops the status segment. */
function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  const lower = status.replaceAll('_', ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Action wrappers threaded through every section builder: `act` closes the
// overlay before running an effect; `go` is `act` specialized to a route push.
type Act = (fn: () => void) => () => void;
type Go = (path: string) => () => void;

// Hook-derived data shapes, so the section builders below can live at module
// scope (keeping the useMemo body's cognitive complexity low, issue 2369) while
// still tracking the hooks' real return types.
type ScheduleTasks = ReturnType<typeof useScheduleTasks>['tasks'];
type TaskItem = NonNullable<ScheduleTasks>[number];
type ActiveSprintData = ReturnType<typeof useActiveSprint>['sprint'];
type SprintTargets = ReturnType<typeof useCurrentSprintTargets>;
type ProjectsData = ReturnType<typeof useProjects>['data'];
type ProgramsData = ReturnType<typeof usePrograms>['data'];
type ProjectItem = NonNullable<ProjectsData>[number];
type PeopleData = ReturnType<typeof useResourceSearch>['data'];
type RecentProjectsData = ReturnType<typeof useRecentProjects>['data'];
type PinnedData = ReturnType<typeof usePinned>['data'];
type CurrentUser = ReturnType<typeof useCurrentUser>['user'];
type IterationLabel = ReturnType<typeof useIterationLabel>;
type LabelsData = ReturnType<typeof useLabels>['data'];

// ---- Jump to current sprint (first-class, top-ranked) ----------------------
// The issue 1594 headline action: one entry per team with a live ACTIVE sprint,
// each landing directly on that sprint's board (`?sprint=` scope). Works from
// anywhere (not just a project route) so a multi-team Scrum Master reaches any
// of their boards without hunting through the SPRINT view tabs.
function buildSprintJumps(sprintTargets: SprintTargets, go: Go): CommandItem[] {
  return sprintTargets.map((t) => ({
    id: `sprint:${t.sprintId}`,
    label: `Current sprint — ${t.sprintName}`,
    group: 'sprint',
    tag: 'Sprint',
    detail: t.projectName,
    keywords: `jump current active sprint board ${t.projectName}`,
    run: go(t.path),
  }));
}

// ---- Tier 2: Tasks (current project) ---------------------------------------
// Built for every current-project task; the palette query filters them and caps
// the visible set. Split into two disjoint groups (ADR-0508/#1557): tasks in the
// current project's ACTIVE sprint land in `sprintTask` (raised cap 25), everything
// else in `task` (cap 8). A task is in exactly one group, so keyboard nav stays
// single-listed. With no active sprint, `sprintTaskItems` is empty and `taskItems`
// holds every task — unchanged behavior for Waterfall / no-sprint projects.
function buildTaskItems(
  tier2Id: string | undefined,
  tasks: ScheduleTasks,
  activeSprint: ActiveSprintData,
  act: Act,
  openTask: (task: TaskItem, projectId: string) => void,
): { sprintTaskItems: CommandItem[]; taskItems: CommandItem[] } {
  const sprintTaskItems: CommandItem[] = [];
  const taskItems: CommandItem[] = [];
  if (!tier2Id) return { sprintTaskItems, taskItems };
  const activeSprintId = activeSprint?.id ?? null;
  for (const task of tasks ?? []) {
    const detail = [task.wbs, formatStatus(task.status)].filter(Boolean).join(' · ');
    const inActiveSprint = activeSprintId !== null && task.sprintId === activeSprintId;
    (inActiveSprint ? sprintTaskItems : taskItems).push({
      id: `task:${task.id}`,
      label: `Open task: ${task.name}`,
      group: inActiveSprint ? 'sprintTask' : 'task',
      tag: 'Task',
      detail,
      keywords: `${task.shortId ?? ''} ${task.wbs ?? ''} ${task.status ?? ''}`,
      run: act(() => openTask(task, tier2Id)),
    });
  }
  return { sprintTaskItems, taskItems };
}

// ---- Tier 2: Current project (sprint retro + role-gated grooming + hidden) --
function buildCurrentItems(
  tier2Id: string | undefined,
  currentProject: ProjectItem | null,
  activeSprint: ActiveSprintData,
  canManageBacklog: boolean,
  user: CurrentUser,
  iteration: IterationLabel,
  go: Go,
): CommandItem[] {
  const currentItems: CommandItem[] = [];
  if (!tier2Id) return currentItems;
  const projectName = currentProject?.name ?? 'this project';
  // The in-context active sprint's *board* jump lives in the top-ranked `sprint`
  // group (issue 1594); the retro jump stays here as an in-context target.
  if (activeSprint) {
    currentItems.push({
      id: `current:retro:${tier2Id}`,
      label: `Open ${activeSprint.name} retro`,
      group: 'current',
      tag: 'Sprint',
      keywords: 'retrospective sprint',
      // Deep-link the active sprint so the view selects it directly (#2046),
      // rather than landing on the default selection.
      run: go(`/projects/${tier2Id}/sprints?sprint=${activeSprint.id}`),
    });
  }
  // Role/facet-gated: backlog grooming is Product-Owner-facet or Admin+ only, and
  // only meaningful on a methodology that has a backlog (ADR-0105). The gate reads
  // the server-provided role/facets — never an invented client rule.
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
  // Hidden views stay reachable via ⌘K (ADR-0139). Surface a "Go to {label}" jump
  // for each view the user has personally hidden that *would* be visible for this
  // project's methodology — methodology-hidden views are excluded (the user can't
  // hide those, and they communicate "not how we work here").
  const hiddenViews = new Set(user?.hidden_views ?? []);
  if (hiddenViews.size === 0) return currentItems;
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
  return currentItems;
}

// ---- People (global, query-gated) ------------------------------------------
// Server-searched resources (ADR-0401/#1940). Selecting one opens the org resource
// catalog pre-filtered to that name (`/resources?q=`) — there is no per-resource
// detail route, so the catalog + seeded search is the destination.
function buildPeopleItems(peopleEnabled: boolean, people: PeopleData, go: Go): CommandItem[] {
  if (!peopleEnabled) return [];
  return (people ?? []).map((person) => ({
    id: `person:${person.id}`,
    label: person.name,
    group: 'person',
    tag: 'Person',
    keywords: `person resource member teammate ${person.name}`,
    run: go(`/resources?q=${encodeURIComponent(person.name)}`),
  }));
}

// ---- Recent (cold-only recently-visited projects) --------------------------
// ADR-0508/#1557. Bare project name + "{program} · {relative}" recency hint. Cold,
// a project can appear in BOTH `recent` and the full `jump` list — the intentional
// Spotlight shortcut-strip pattern (web-rule 268). Deep-links to project overview
// (the one view present for every methodology).
function buildRecentItems(
  recentEnabled: boolean,
  recentProjects: RecentProjectsData,
  go: Go,
): CommandItem[] {
  if (!recentEnabled) return [];
  return (recentProjects ?? []).map((rp) => ({
    id: `recent:${rp.id}`,
    label: rp.name,
    group: 'recent' as const,
    tag: 'Project',
    detail: [rp.program_name, formatRelative(new Date(rp.visited_at))].filter(Boolean).join(' · '),
    keywords: `recent recently visited project ${rp.program_name ?? ''}`,
    run: go(`/projects/${rp.id}/overview`),
  }));
}

// ---- Pinned (cold-only, the caller's own pins) -----------------------------
// #2390, design §4.6. Sits ABOVE `recent` cold: a pin is a standing intent, a
// recent visit is an accident of history. Reads the same `/auth/me/pinned/`
// cache the rail does, so the two can never disagree. Deep-links to overview —
// the one view every methodology has.
function buildPinnedItems(pinnedEnabled: boolean, pinned: PinnedData, go: Go): CommandItem[] {
  if (!pinnedEnabled) return [];
  return (pinned ?? []).map((p) => ({
    id: `pinned:${p.kind}:${p.id}`,
    label: p.name,
    group: 'pinned' as const,
    tag: p.kind === 'program' ? 'Program' : 'Project',
    detail: p.program_name ?? undefined,
    keywords: `pinned pin ${p.code ?? ''} ${p.program_name ?? ''}`,
    pinTarget: { kind: p.kind, id: p.id, name: p.name, pinned: true },
    run: go(p.kind === 'program' ? `/programs/${p.id}/overview` : `/projects/${p.id}/overview`),
  }));
}

// ---- Pin / unpin as searchable commands ------------------------------------
// #2390, design §4.6: "the keyboard-only path that needs no glyph at all".
// Query-gated — a cold palette listing an Unpin command for every project the
// user can reach would bury the navigation it exists to provide.
function buildPinActions(
  enabled: boolean,
  projects: ProjectsData,
  programs: ProgramsData,
  togglePin: (target: PinTarget) => void,
  act: Act,
): CommandItem[] {
  if (!enabled) return [];
  const targets: PinTarget[] = [
    ...(projects ?? []).map((p) => ({
      kind: 'project' as const,
      id: p.id,
      name: p.name,
      pinned: p.isPinned ?? false,
    })),
    ...(programs ?? []).map((p) => ({
      kind: 'program' as const,
      id: p.id,
      name: p.name,
      pinned: p.is_pinned,
    })),
  ];
  return targets.map((t) => ({
    id: `action:pin:${t.kind}:${t.id}`,
    label: `${t.pinned ? 'Unpin' : 'Pin'} ${t.name}`,
    group: 'action' as const,
    tag: 'Action',
    keywords: `pin unpin pinned favorite ${t.name}`,
    pinTarget: t,
    run: act(() => togglePin(t)),
  }));
}

// ---- Tier 1: Jump to (global) + always-findable Settings landings ----------
function buildJumps(
  programs: ProgramsData,
  projects: ProjectsData,
  isWorkspaceAdmin: boolean,
  go: Go,
): CommandItem[] {
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
      // Carries a pin target so the accelerator works on any navigable row, not
      // only on rows that exist because they are pinned (#2390).
      pinTarget: {
        kind: 'program',
        id: program.id,
        name: program.name,
        pinned: program.is_pinned,
      },
      run: go(`/programs/${program.id}/overview`),
    });
  }
  for (const project of projects ?? []) {
    jumps.push({
      id: `jump:project:${project.id}`,
      label: project.name,
      group: 'jump',
      tag: 'Project',
      pinTarget: {
        kind: 'project',
        id: project.id,
        name: project.name,
        pinned: project.isPinned ?? false,
      },
      // Overview is the one view present for every methodology — a safe default.
      run: go(`/projects/${project.id}/overview`),
    });
  }
  // Cold-visible top-level landings (#2298). Workspace settings + Trash are
  // admin-only, so they are HIDDEN (not shown-disabled) for members — a palette
  // entry a member can never act on is noise. Personal settings is any-role.
  if (isWorkspaceAdmin) {
    jumps.push({
      id: 'jump:workspace-settings',
      label: 'Workspace settings',
      group: 'jump',
      tag: 'Settings',
      keywords: 'settings preferences configuration admin workspace members sso email retention',
      run: go('/settings'),
    });
  }
  jumps.push({
    id: 'jump:personal-settings',
    label: 'Personal settings',
    group: 'jump',
    tag: 'Settings',
    keywords: 'settings preferences profile account me notifications tokens connected',
    run: go('/me/settings/general'),
  });
  if (isWorkspaceAdmin) {
    jumps.push({
      id: 'jump:trash',
      label: 'Trash',
      group: 'jump',
      tag: 'Settings',
      keywords: 'trash deleted restore recover projects',
      run: go('/settings/trash'),
    });
  }
  return jumps;
}

// ---- Settings sections (ADR-0606/#2319) ------------------------------------
// Individual settings sections as a query-only group so typing "smtp" / "oidc"
// jumps straight to Email & SMTP / Single sign-on. Workspace sections derive from
// the SAME builder that feeds the rail and are admin-gated as a whole; personal
// sections come from ME_SETTINGS_LINKS and are ungated.
function buildSettingsSections(isWorkspaceAdmin: boolean, go: Go): CommandItem[] {
  const settingsSections: CommandItem[] = [];
  if (isWorkspaceAdmin) {
    for (const group of buildWorkspaceNavGroups({ linked: true })) {
      for (const item of group.items) {
        if (item.id === 'trash' || !item.to) continue; // trash → cold jump above
        settingsSections.push({
          id: `settings:ws:${item.id}`,
          label: item.label,
          group: 'settings',
          tag: 'Settings',
          detail: 'Workspace',
          keywords: item.keywords,
          run: go(item.to),
        });
      }
    }
  }
  for (const link of ME_SETTINGS_LINKS) {
    settingsSections.push({
      id: `settings:me:${link.to}`,
      label: link.label,
      group: 'settings',
      tag: 'Settings',
      detail: 'Personal',
      keywords: link.keywords,
      run: go(link.to),
    });
  }
  return settingsSections;
}

// ---- Tier 2: Labels (#2334) ------------------------------------------------
// The project's label catalog as a query-gated group that deep-links into the
// Board with the label facet pre-applied. Tier-2 by necessity, not by choice:
// the catalog is only reachable as `GET /projects/{id}/labels/` (ADR-0400) —
// there is no workspace-wide label endpoint — so a cross-project "tasks with
// label X" view needs new API surface and is tracked separately (#2333).
//
// The Board is the only destination: it already parses `?fl=` today
// (`boardFacets.PARAM_LABELS`) and BoardView lets a URL that carries facets win
// over stored state, so no new filter plumbing is needed. Table/Grid and
// Schedule label filtering land separately (#2383, #2384).
function buildLabelItems(
  enabled: boolean,
  projectId: string | undefined,
  labels: LabelsData,
  go: Go,
): CommandItem[] {
  if (!enabled || !projectId || !labels) return [];
  return labels.map((label) => ({
    id: `label:${label.id}`,
    label: label.name,
    group: 'label' as const,
    tag: 'Label',
    // A zero-count label is still listed — hiding it would leave the user
    // wondering why a label they know exists never appears; the Board's own
    // zero-match state is the honest answer.
    detail: label.taskCount === 1 ? '1 task' : `${label.taskCount} tasks`,
    keywords: 'label tag filter',
    swatch: label.color,
    run: go(`/projects/${projectId}/board?fl=${encodeURIComponent(label.id)}`),
  }));
}

// ---- Tier 1: Backlog + Board (global) --------------------------------------
function buildBacklogAndBoard(
  projects: ProjectsData,
  go: Go,
): { backlog: CommandItem[]; board: CommandItem[] } {
  const backlog: CommandItem[] = [];
  const board: CommandItem[] = [];
  for (const project of projects ?? []) {
    // Backlog exists only for Agile/Hybrid projects (ADR-0105); methodology is on
    // the list payload, so this gates with no extra fetch.
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
  return { backlog, board };
}

// ---- Global actions --------------------------------------------------------
function buildActions(
  theme: Theme,
  setTheme: (theme: Theme) => void,
  toggleSidebar: () => void,
  act: Act,
  openFeedback: (() => void) | null,
): CommandItem[] {
  return [
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
    // Omitted entirely when the operator disabled the control (#2392) — the
    // palette must not offer a route a locked-down install has closed.
    ...(openFeedback
      ? [
          {
            id: 'action:report-bug',
            label: 'Report a bug',
            group: 'action' as const,
            tag: 'Action',
            keywords: 'feedback report a bug support issue problem',
            run: act(openFeedback),
          },
        ]
      : []),
  ];
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
 *
 * `query` drives the global people tier (ADR-0401/#1940): a server-side
 * `/resources/?search=` fires only while the palette is open AND the query is
 * non-empty, so a cold or closed palette never pulls the whole catalog. People
 * results deep-link to the resource catalog pre-filtered.
 */
export function useCommandItems(enabled = true, query = ''): CommandItem[] {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  // Same operator gate as the user-menu row (#2392): when feedback is disabled
  // the palette offers nothing, rather than a dead entry.
  const setFeedbackOpen = useFeedbackStore((s) => s.setOpen);
  const { data: workspaceSettings } = useWorkspaceSettings();
  const openFeedback =
    workspaceSettings?.feedbackEnabled !== false ? () => setFeedbackOpen(true) : null;
  // Held in a ref so the items memo does not rebuild on every render just
  // because this closure is new each time; the store setter is stable.
  const openFeedbackRef = useRef(openFeedback);
  openFeedbackRef.current = openFeedback;
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
  // Label catalog (#2334). Gated on `tier2Id` like every other Tier-2 read, so a
  // closed palette or a non-project route never fetches it. Usually already warm
  // from the Board, which reads the same `['labels', projectId]` cache key.
  const { data: labels } = useLabels(tier2Id);

  const currentProject = useMemo(
    () => projects?.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  // Global people tier (ADR-0401/#1940): server-side resource search, gated on an
  // open palette with a non-empty query so it never fetches the catalog cold.
  const trimmedQuery = query.trim();
  const peopleEnabled = enabled && trimmedQuery.length > 0;
  const { data: people } = useResourceSearch(trimmedQuery, peopleEnabled);

  // Global Epic/Story omni-search tier (ADR-0508 D4/#2103): a debounced,
  // membership-scoped cross-program search. Gated on an open palette with a
  // non-empty query — the hook additionally holds the request below its 2-char
  // floor — so a cold palette never fetches. The endpoint enforces access scope
  // server-side; the client only renders what it is handed.
  const omniEnabled = enabled && trimmedQuery.length > 0;
  const { data: omniResults } = useOmniSearch(trimmedQuery, omniEnabled);

  // Recent-projects tier (ADR-0508/#1557): the cold-only "recently visited"
  // strip. Gated on an open palette with an EMPTY query — the inverse of the
  // query-gated task/people tiers — so it renders only cold and never fires
  // while the user is typing a search.
  const recentEnabled = enabled && trimmedQuery.length === 0;
  const { data: recentProjects } = useRecentProjects(recentEnabled);

  // Pinned tier (#2390): cold-only like `recent`, reading the same cache the rail
  // does. The mutation is shared too, so a pin made from the palette lands
  // everywhere at once.
  const pinnedEnabled = enabled && trimmedQuery.length === 0;
  const { data: pinnedItems } = usePinned();
  const togglePinMutation = useTogglePin();
  const togglePin = useCallback(
    (t: PinTarget) =>
      togglePinMutation.mutate({ kind: t.kind, id: t.id, name: t.name, next: !t.pinned }),
    [togglePinMutation],
  );

  return useMemo(() => {
    // Wrap every action so the overlay closes first, then the effect runs; `go`
    // is `act` specialized to a route push.
    const act: Act = (fn) => () => {
      setOpen(false);
      fn();
    };
    const go: Go = (path) =>
      act(() => {
        void navigate(path);
      });

    // Each tier is assembled by a module-scope builder so this callback stays a
    // thin orchestration seam (issue 2369). Gating notes preserved on the builders.
    const sprintJumps = buildSprintJumps(sprintTargets, go);
    // Gated on `tier2Id` (not `currentProjectId`) so Tier-2 items build only while
    // the palette is open — `useScheduleTasks` falls back to the route project when
    // handed `undefined`, so gating on the raw route id would build task items (and
    // read possibly-partial task data) on every project route even when closed.
    const { sprintTaskItems, taskItems } = buildTaskItems(
      tier2Id,
      tasks,
      activeSprint,
      act,
      openTask,
    );
    const currentItems = buildCurrentItems(
      tier2Id,
      currentProject,
      activeSprint,
      canManageBacklog,
      user,
      iteration,
      go,
    );
    // Query-gated like the task/people tiers: a cold palette is not a label browser.
    const labelItems = buildLabelItems(trimmedQuery.length > 0, tier2Id, labels, go);
    const peopleItems = buildPeopleItems(peopleEnabled, people, go);

    // ---- Epic / Story (global, query-gated cross-program omni-search) --------
    // ADR-0508 D4/#2103. Server-ranked, membership-scoped results split into the
    // `epic` and `story` groups by agile type; each row carries an agile-vocabulary
    // "program ▸ project ▸ epic" breadcrumb (never a WBS code) and deep-links to the
    // task drawer on the lens's own landing view (#2441) or the program backlog (an
    // intake item).
    const omniItems: CommandItem[] = omniEnabled
      ? buildOmniSearchItems(omniResults ?? [], go, user?.role_context ?? 'unified')
      : [];
    const epicItems = omniItems.filter((i) => i.group === 'epic');
    const storyItems = omniItems.filter((i) => i.group === 'story');
    const milestoneItems = omniItems.filter((i) => i.group === 'milestone');
    const omniTaskItems = omniItems.filter((i) => i.group === 'omniTask');

    const pinnedRows = buildPinnedItems(pinnedEnabled, pinnedItems, go);
    const recentItems = buildRecentItems(recentEnabled, recentProjects, go);
    const isWorkspaceAdmin = (user?.workspace_role ?? -1) >= WORKSPACE_ADMIN_ROLE;
    const jumps = buildJumps(programs, projects, isWorkspaceAdmin, go);
    const settingsSections = buildSettingsSections(isWorkspaceAdmin, go);
    const { backlog, board } = buildBacklogAndBoard(projects, go);
    const actions = [
      ...buildActions(theme, setTheme, toggleSidebar, act, openFeedbackRef.current),
      ...buildPinActions(trimmedQuery.length > 0, projects, programs, togglePin, act),
    ];

    // Order matches the palette's GROUP_ORDER so keyboard nav and the visual
    // sections agree.
    return [
      ...sprintJumps,
      ...sprintTaskItems,
      ...taskItems,
      ...labelItems,
      ...currentItems,
      ...peopleItems,
      ...epicItems,
      ...storyItems,
      ...milestoneItems,
      ...omniTaskItems,
      ...pinnedRows,
      ...recentItems,
      ...jumps,
      ...settingsSections,
      ...backlog,
      ...board,
      ...actions,
    ];
  }, [
    navigate,
    programs,
    projects,
    people,
    peopleEnabled,
    omniResults,
    omniEnabled,
    recentProjects,
    recentEnabled,
    pinnedItems,
    pinnedEnabled,
    togglePin,
    theme,
    setTheme,
    toggleSidebar,
    setOpen,
    openTask,
    tier2Id,
    labels,
    trimmedQuery,
    currentProject,
    tasks,
    activeSprint,
    sprintTargets,
    canManageBacklog,
    user,
    iteration,
  ]);
}
