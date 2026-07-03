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

// Tier-2 hooks. NOTE: the real `useScheduleTasks` falls back to the *route* project
// when handed `undefined`, so it returns tasks even with the palette closed — the
// gating happens in useCommandItems, not here. The default mock mirrors the polite
// arg-honouring shape, but `scheduleTasks` is a spy so a test can simulate the real
// route-fallback (tasks present regardless of the arg).
type MockTask = { id: string; name: string; wbs?: string; status?: string; shortId?: string };
const scheduleTasks = vi.fn((pid?: string): { tasks: MockTask[] | undefined } => ({
  tasks: pid
    ? [{ id: 't1', name: 'Wire OAuth', wbs: '1.4.2', status: 'IN_PROGRESS', shortId: 'A1B2' }]
    : undefined,
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: (pid?: string) => scheduleTasks(pid),
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: (pid?: string) => ({
    sprint: pid ? { id: 's1', name: 'Sprint 14', state: 'ACTIVE' } : null,
  }),
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
});

describe('useCommandItems — tier assembly', () => {
  it('builds Tier-1 jump targets for every program and project', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.get('jump:program:prog1')?.label).toBe('Platform');
    expect(items.get('jump:project:p1')?.label).toBe('Atlas');
    expect(items.get('jump:project:p2')?.label).toBe('Hoover Dam');
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
    expect(items.get('current:retro:p1')?.label).toBe('Open Sprint 14 retro');
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
});
