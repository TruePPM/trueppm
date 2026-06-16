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

// Tier-2 hooks honour their projectId arg so we can exercise the enabled-gating:
// when the palette is closed, useCommandItems passes `undefined` and these no-op.
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: (pid?: string) => ({
    tasks: pid
      ? [{ id: 't1', name: 'Wire OAuth', wbs: '1.4.2', status: 'IN_PROGRESS', shortId: 'A1B2' }]
      : undefined,
  }),
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: (pid?: string) => ({
    sprint: pid ? { id: 's1', name: 'Sprint 14', state: 'ACTIVE' } : null,
  }),
}));
const canManage = vi.fn((pid?: string) => !!pid);
vi.mock('@/hooks/useMyFacets', () => ({ useCanManageBacklog: (pid?: string) => canManage(pid) }));

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
  vi.clearAllMocks();
  canManage.mockImplementation((pid?: string) => !!pid);
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
    expect(openTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      'p1',
    );
    expect(navigate).not.toHaveBeenCalled(); // opens drawer, does not navigate
  });

  it('builds Tier-2 active-sprint + retro targets when a sprint is active', () => {
    const { result } = renderHook(() => useCommandItems(true));
    const items = byId(result.current);
    expect(items.get('current:active-sprint:p1')?.label).toBe('Active Sprint — Sprint 14');
    expect(items.get('current:retro:p1')?.label).toBe('Open Sprint 14 retro');
  });

  it('role-gates the grooming target on the manage-backlog capability', () => {
    canManage.mockImplementation((pid?: string) => !!pid); // PO/Admin
    const groomed = renderHook(() => useCommandItems(true));
    expect(byId(groomed.result.current).has('current:groom:p1')).toBe(true);

    canManage.mockImplementation(() => false); // contributor
    const plain = renderHook(() => useCommandItems(true));
    expect(byId(plain.result.current).has('current:groom:p1')).toBe(false);
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
});
