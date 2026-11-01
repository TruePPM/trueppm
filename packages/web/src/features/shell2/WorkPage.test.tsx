import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from './ShellGate';
import { WorkPage, visibleTreeRows } from './WorkPage';
import type { WorkRow } from './workModel';

const model = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('./workModel', async (orig) => ({
  ...(await orig<typeof import('./workModel')>()),
  useWorkModel: () => model.current,
}));

const programs: WorkRow[] = [
  { key: 'program:pm', label: 'Platform', to: '/programs/pm/overview', kind: 'program' },
  {
    key: 'project:a',
    label: 'Atlas',
    to: '/projects/a/overview',
    indent: true,
    kind: 'project',
    parentKey: 'program:pm',
  },
  { key: 'project:s', label: 'Solo', to: '/projects/s/overview', kind: 'project' },
];
const ready = {
  rows: { pinned: [], programs },
  loading: false,
  failed: false,
  isEmpty: false,
  refetch: vi.fn(),
};

describe('visibleTreeRows', () => {
  it('hides children of a collapsed program unless searching', () => {
    const collapsed = new Set(['program:pm']);
    expect(visibleTreeRows(programs, collapsed, false).map((r) => r.label)).toEqual([
      'Platform',
      'Solo',
    ]);
    expect(visibleTreeRows(programs, collapsed, true)).toHaveLength(3);
  });
});

describe('WorkPage', () => {
  beforeEach(() => {
    localStorage.clear();
    setFeatureFlag(SHELL_V2_FLAG, true);
    model.current = ready;
  });

  it('redirects to /programs when the flag is off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    renderWithRouter(<WorkPage />, { initialEntries: ['/work'] });
    expect(screen.queryByRole('heading', { name: 'Work' })).toBeNull();
  });

  it('renders a tree with one tab stop and arrow-key navigation', () => {
    renderWithRouter(<WorkPage />, { initialEntries: ['/work'] });
    const items = screen.getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    items[0].focus();
    fireEvent.keyDown(items[0], { key: 'ArrowLeft' });
    expect(items[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: 'Atlas' })).toBeNull();
    fireEvent.keyDown(items[0], { key: 'ArrowRight' });
    fireEvent.keyDown(items[0], { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Atlas' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Atlas' }), { key: 'End' });
    expect(screen.getByRole('treeitem', { name: 'Solo' })).toHaveFocus();
  });

  it('shows the skeleton, the retryable error, and the empty state', () => {
    model.current = { ...ready, loading: true };
    const { unmount } = renderWithRouter(<WorkPage />, { initialEntries: ['/work'] });
    expect(screen.queryByRole('tree')).toBeNull();
    unmount();

    model.current = { ...ready, failed: true };
    const view = renderWithRouter(<WorkPage />, { initialEntries: ['/work'] });
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(ready.refetch).toHaveBeenCalled();
    view.unmount();

    model.current = { ...ready, isEmpty: true, rows: { pinned: [], programs: [] } };
    renderWithRouter(<WorkPage />, { initialEntries: ['/work'] });
    expect(screen.getByText('No programs or projects yet')).toBeInTheDocument();
  });
});
