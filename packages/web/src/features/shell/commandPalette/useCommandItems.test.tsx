import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useCommandItems } from './useCommandItems';
import type { CommandItem } from './commandItems';

// ---- Mocks: data hooks, router, stores ------------------------------------
const navigate = vi.fn();
vi.mock('react-router', () => ({ useNavigate: () => navigate }));

let currentId: string | undefined = 'p1';
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => currentId }));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      { id: 'p1', name: 'Atlas', methodology: 'HYBRID' },
      { id: 'p2', name: 'Hoover Dam', methodology: 'WATERFALL' },
    ],
  }),
}));
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({ data: [{ id: 'prog1', name: 'Platform', code: 'PLT' }] }),
}));

// People tier (ADR-0401): server resource search. Default to no results; a test
// sets `peopleResults` + a query to assert the person items. `resourceSearch` is a
// spy so the enabled/gating argument can be asserted.
let peopleResults: { id: string; name: string }[] = [];
const resourceSearch = vi.fn((_query: string, _enabled?: boolean) => ({ data: peopleResults }));
vi.mock('@/hooks/useResourceSearch', () => ({
  useResourceSearch: (query: string, enabled?: boolean) => resourceSearch(query, enabled),
}));

// Recent-projects tier (ADR-0508/#1557). Default to no rows; a test sets
// `recentResults` + a cold (empty) query to assert the recent items. `recentSearch`
// is a spy so the cold-only enabled gating can be asserted.
let recentResults: {
  id: string;
  name: string;
  program_id: string | null;
  program_name: string | null;
  visited_at: string;
}[] = [];
const recentSearch = vi.fn((_enabled?: boolean) => ({ data: recentResults }));
vi.mock('@/hooks/useRecentProjects', () => ({
  useRecentProjects: (enabled?: boolean) => recentSearch(enabled),
}));

// Deterministic relative-time so the recent detail line is stable in assertions.
vi.mock('@/lib/formatRelative', () => ({ formatRelative: () => '2h ago' }));

// Tier-2 hooks. NOTE: the real `useScheduleTasks` falls back to the *route* project
// when handed `undefined`, so it returns tasks even with the palette closed — the
// gating happens in useCommandItems, not here. The default mock mirrors the polite
// arg-honouring shape, but `scheduleTasks` is a spy so a test can simulate the real
// route-fallback (tasks present regardless of the arg).
type MockTask = {
  id: string;
  name: string;
  wbs?: string;
  status?: string;
  shortId?: string;
  sprintId?: string | null;
};
const scheduleTasks = vi.fn((pid?: string): { tasks: MockTask[] | undefined } => ({
  tasks: pid
    ? [{ id: 't1', name: 'Wire OAuth', wbs: '1.4.2', status: 'IN_PROGRESS', shortId: 'A1B2' }]
    : undefined,
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: (pid?: string) => scheduleTasks(pid),
}));
// Active sprint (Tier-2). A spy so a test can force "no active sprint" and assert
// the sprintTask/task split degrades to all-`task` (ADR-0508). Default: an ACTIVE
// sprint `s1` for a routed project, none off-route.
const activeSprintFn = vi.fn((pid?: string) => ({
  sprint: pid ? { id: 's1', name: 'Sprint 14', state: 'ACTIVE' } : null,
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: (pid?: string) => activeSprintFn(pid),
}));
// Shared jump-to-current-sprint targets (#1594). Mirrors the real hook: an
// in-context target for the routed project, empty off-route. Its own combining /
// de-dup logic is covered in useCurrentSprintTargets.test.ts.
const sprintTargets = vi.fn((pid?: string) =>
  pid
    ? [
        {
          projectId: pid,
          projectName: 'Atlas',
          sprintId: 's1',
          sprintName: 'Sprint 14',
          path: `/projects/${pid}/board?sprint=s1`,
        },
      ]
    : [],
);
vi.mock('@/hooks/useCurrentSprintTargets', () => ({
  useCurrentSprintTargets: (pid?: string) => sprintTargets(pid),
}));
const canManage = vi.fn((pid?: string) => !!pid);
vi.mock('@/hooks/useMyFacets', () => ({ useCanManageBacklog: (pid?: string) => canManage(pid) }));

// Per-user nav visibility (ADR-0139). Default to nothing hidden; a test mutates
// `hiddenViews` to assert the "Go to {label}" jumps appear.
let hiddenViews: string[] = [];
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { hidden_views: hiddenViews }, isLoading: false }),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ singular: 'Sprint', plural: 'Sprints' }),
}));

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: (sel: (s: unknown) => unknown) => sel({ theme: 'dark', setTheme: vi.fn() }),
}));
vi.mock('@/stores/shellStore', () => ({
  useShellStore: (sel: (s: unknown) => unknown) => sel({ toggleSidebar: vi.fn() }),
}));
vi.mock('@/stores/commandPaletteStore', () => ({
  useCommandPaletteStore: (sel: (s: unknown) => unknown) => sel({ setOpen: vi.fn() }),
}));
const openTask = vi.fn();
vi.mock('@/stores/taskDrawerStore', () => ({
  useTaskDrawerStore: (sel: (s: unknown) => unknown) => sel({ openTask }),
}));

const byId = (items: CommandItem[]) => new Map(items.map((i) => [i.id, i]));

afterEach(() => {
  currentId = 'p1';
  hiddenViews = [];
  peopleResults = [];
  recentResults = [];
  vi.clearAllMocks();
  canManage.mockImplementation((pid?: string) => !!pid);
  sprintTargets.mockImplementation((pid?: string) =>
    pid
      ? [
          {
            projectId: pid,
            projectName: 'Atlas',
            sprintId: 's1',
            sprintName: 'Sprint 14',
            path: `/projects/${pid}/board?sprint=s1`,
          },
        ]
      : [],
  );
  scheduleTasks.mockImplementation((pid?: string) => ({
    tasks: pid
      ? [{ id: 't1', name: 'Wire OAuth', wbs: '1.4.2', status: 'IN_PROGRESS', shortId: 'A1B2' }]
      : undefined,
  }));
  activeSprintFn.mockImplementation((pid?: string) => ({
    sprint: pid ? { id: 's1', name: 'Sprint 14', state: 'ACTIVE' } : null,
  }));
});

describe('useCommandItems — tier assembly', () => {
  it('builds Tier-1 jump targets for every program and project', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.get('jump:program:prog1')?.label).toBe('Platform');
    expect(items.get('jump:project:p1')?.label).toBe('Atlas');
    expect(items.get('jump:project:p2')?.label).toBe('Hoover Dam');
  });

  it('builds a global people tier from the resource search, deep-linking to the catalog (#1940)', () => {
    peopleResults = [
      { id: 'r1', name: 'Ann Rivera' },
      { id: 'r2', name: 'Ben Cho' },
    ];
    const { result } = renderHook(() => useCommandItems(true, 'an'));
    const items = byId(result.current);
    const ann = items.get('person:r1');
    expect(ann?.label).toBe('Ann Rivera');
    expect(ann?.group).toBe('person');
    expect(ann?.tag).toBe('Person');
    // deep-links to the org catalog pre-filtered to the name
    ann?.run();
    expect(navigate).toHaveBeenCalledWith('/resources?q=Ann%20Rivera');
    // the search hook was gated ON (open + non-empty query)
    expect(resourceSearch).toHaveBeenCalledWith('an', true);
  });

  it('gates the people search OFF when the query is empty (no cold catalog fetch)', () => {
    peopleResults = [{ id: 'r1', name: 'Ann Rivera' }];
    const { result } = renderHook(() => useCommandItems(true, '   '));
    expect(result.current.some((i) => i.group === 'person')).toBe(false);
    expect(resourceSearch).toHaveBeenCalledWith('', false);
  });

  it('gates the Tier-1 Backlog target to non-Waterfall projects; Board is universal', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.has('backlog:p1')).toBe(true); // HYBRID
    expect(items.has('backlog:p2')).toBe(false); // WATERFALL — no backlog
    expect(items.has('board:p1')).toBe(true);
    expect(items.has('board:p2')).toBe(true);
  });

  it('builds Tier-2 task results that open the drawer in place', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const task = byId(result.current).get('task:t1');
    expect(task?.group).toBe('task');
    expect(task?.label).toBe('Open task: Wire OAuth');
    expect(task?.detail).toBe('1.4.2 · In progress');
    task?.run();
    expect(openTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'p1');
    expect(navigate).not.toHaveBeenCalled(); // opens drawer, does not navigate
  });

  it('builds the top-ranked sprint jump + in-context retro target when a sprint is active', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    // The board jump is the first-class, top-ranked `sprint` group (#1594)…
    const jump = items.get('sprint:s1');
    expect(jump?.label).toBe('Current sprint — Sprint 14');
    expect(jump?.group).toBe('sprint');
    expect(jump?.detail).toBe('Atlas');
    // …the retro jump stays as an in-context `current` target.
    const retro = items.get('current:retro:p1');
    expect(retro?.label).toBe('Open Sprint 14 retro');
    // …and deep-links the active sprint so the view selects it directly (#2046).
    retro?.run();
    expect(navigate).toHaveBeenCalledWith('/projects/p1/sprints?sprint=s1');
    expect(items.has('current:active-sprint:p1')).toBe(false);
  });

  it('role-gates the grooming target on the manage-backlog capability', () => {
    canManage.mockImplementation((pid?: string) => !!pid); // PO/Admin
    const groomed = renderHook(() => useCommandItems(true));
    expect(byId(groomed.result.current).has('current:groom:p1')).toBe(true);

    canManage.mockImplementation(() => false); // contributor
    const plain = renderHook(() => useCommandItems(true));
    expect(byId(plain.result.current).has('current:groom:p1')).toBe(false);
  });

  // ADR-0139 — hidden views stay reachable via ⌘K
  it('emits a "Go to {label}" jump for each personally-hidden, methodology-visible view', () => {
    hiddenViews = ['schedule', 'reports'];
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.get('current:hidden-view:p1:schedule')?.label).toBe('Go to Schedule');
    expect(items.get('current:hidden-view:p1:reports')?.label).toBe('Go to Reports');
    expect(items.get('current:hidden-view:p1:schedule')?.tag).toBe('View');
  });

  it('does not surface a hidden view that the methodology already hides', () => {
    // p2 (Hoover Dam) is WATERFALL — sprints is methodology-hidden, so even if the
    // user hid it globally, ⌘K does not offer a jump to it on this project.
    currentId = 'p2';
    hiddenViews = ['sprints'];
    const { result } = renderHook(() => useCommandItems(true));
    expect(byId(result.current).has('current:hidden-view:p2:sprints')).toBe(false);
  });

  it('emits no hidden-view jumps when nothing is hidden', () => {
    const { result } = renderHook(() => useCommandItems(true));
    expect([...byId(result.current).keys()].some((k) => k.startsWith('current:hidden-view:'))).toBe(
      false,
    );
  });

  it('emits no Tier-2 items off a project route', () => {
    currentId = undefined;
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect([...items.keys()].some((k) => k.startsWith('task:'))).toBe(false);
    expect([...items.keys()].some((k) => k.startsWith('current:'))).toBe(false);
    // Tier-1 still present.
    expect(items.has('jump:project:p1')).toBe(true);
  });

  it('disables Tier-2 detail fetches while the palette is closed (enabled=false)', () => {
    const { result } = renderHook(() => useCommandItems(false));
    const items = byId(result.current);
    expect([...items.keys()].some((k) => k.startsWith('task:'))).toBe(false);
    expect([...items.keys()].some((k) => k.startsWith('current:'))).toBe(false);
    expect(items.has('jump:project:p1')).toBe(true);
  });

  // Regression (#647): the real useScheduleTasks falls back to the route project
  // when handed `undefined`, so `tasks` is populated even while the palette is
  // closed. Gating the Tier-2 loop on the raw route id (not the enabled id) built
  // task items off route data on every project route — and route task payloads can
  // omit `status`, which crashed the whole app via formatStatus(undefined).
  it('builds no task items while closed even when the tasks hook returns route tasks', () => {
    scheduleTasks.mockImplementation(() => ({
      tasks: [{ id: 't9', name: 'Legacy task', wbs: '2.1' /* route payload, no status */ }],
    }));
    const { result } = renderHook(() => useCommandItems(false));
    const items = byId(result.current);
    expect([...items.keys()].some((k) => k.startsWith('task:'))).toBe(false);
  });

  it('tolerates a task with no status — detail line drops the status segment', () => {
    scheduleTasks.mockImplementation(() => ({
      tasks: [{ id: 't9', name: 'Legacy task', wbs: '2.1' /* no status */ }],
    }));
    const { result } = renderHook(() => useCommandItems(true));
    const task = byId(result.current).get('task:t9');
    expect(task?.detail).toBe('2.1');
  });

  // ---- Recent-projects tier (ADR-0508/#1557) --------------------------------
  it('builds the cold-only Recent group with a program breadcrumb + recency hint', () => {
    recentResults = [
      { id: 'p1', name: 'Atlas', program_id: 'prog1', program_name: 'Platform', visited_at: 'x' },
      { id: 'p2', name: 'Solo', program_id: null, program_name: null, visited_at: 'y' },
    ];
    const { result } = renderHook(() => useCommandItems(true, '')); // cold
    const items = byId(result.current);
    const atlas = items.get('recent:p1');
    expect(atlas?.group).toBe('recent');
    expect(atlas?.tag).toBe('Project');
    expect(atlas?.label).toBe('Atlas'); // bare name, no "Open:" prefix
    expect(atlas?.detail).toBe('Platform · 2h ago');
    // A project with no program drops the breadcrumb, keeping only recency.
    expect(items.get('recent:p2')?.detail).toBe('2h ago');
    // Deep-links to the project overview.
    atlas?.run();
    expect(navigate).toHaveBeenCalledWith('/projects/p1/overview');
    // The hook was gated ON only because the query is empty (cold).
    expect(recentSearch).toHaveBeenCalledWith(true);
  });

  it('drops Recent and gates its fetch OFF once a query is typed', () => {
    recentResults = [
      { id: 'p1', name: 'Atlas', program_id: 'prog1', program_name: 'Platform', visited_at: 'x' },
    ];
    const { result } = renderHook(() => useCommandItems(true, 'atl'));
    expect(result.current.some((i) => i.group === 'recent')).toBe(false);
    expect(recentSearch).toHaveBeenCalledWith(false);
  });

  it('does not build Recent while the palette is closed', () => {
    recentResults = [
      { id: 'p1', name: 'Atlas', program_id: 'prog1', program_name: 'Platform', visited_at: 'x' },
    ];
    const { result } = renderHook(() => useCommandItems(false));
    expect(result.current.some((i) => i.group === 'recent')).toBe(false);
    expect(recentSearch).toHaveBeenCalledWith(false);
  });

  // ---- Scope-aware task cap: sprintTask vs task split (ADR-0508) ------------
  it('splits active-sprint tasks into `sprintTask` and the rest into `task`', () => {
    scheduleTasks.mockImplementation((pid?: string) => ({
      tasks: pid
        ? [
            { id: 'ta', name: 'In sprint', wbs: '1.1', status: 'IN_PROGRESS', sprintId: 's1' },
            { id: 'tb', name: 'Backlog-y', wbs: '1.2', status: 'TODO', sprintId: null },
            { id: 'tc', name: 'Other sprint', wbs: '1.3', status: 'TODO', sprintId: 's-other' },
          ]
        : undefined,
    }));
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    // Active sprint is s1 (useActiveSprint mock) → only ta lands in sprintTask.
    expect(items.get('task:ta')?.group).toBe('sprintTask');
    expect(items.get('task:tb')?.group).toBe('task');
    expect(items.get('task:tc')?.group).toBe('task');
    // sprintTask items are ordered before task items in the flat list.
    const ids = result.current.map((i) => i.id);
    expect(ids.indexOf('task:ta')).toBeLessThan(ids.indexOf('task:tb'));
  });

  it('puts every task in `task` (never `sprintTask`) when there is no active sprint', () => {
    activeSprintFn.mockImplementation(() => ({ sprint: null })); // no active sprint
    scheduleTasks.mockImplementation((pid?: string) => ({
      tasks: pid
        ? [
            { id: 'ta', name: 'A', wbs: '1', status: 'TODO', sprintId: 's1' },
            { id: 'tb', name: 'B', wbs: '2', status: 'TODO', sprintId: null },
          ]
        : undefined,
    }));
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.get('task:ta')?.group).toBe('task');
    expect(items.get('task:tb')?.group).toBe('task');
    expect(result.current.some((i) => i.group === 'sprintTask')).toBe(false);
  });
});
