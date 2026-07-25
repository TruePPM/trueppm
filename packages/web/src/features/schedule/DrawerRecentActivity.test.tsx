import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DrawerRecentActivity } from './DrawerRecentActivity';

// Mutable hook stub so each test supplies its own entries / loading state.
let hookState: { data: unknown; isLoading: boolean };
vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => hookState,
}));
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({ prefs: {}, formatInstant: (iso: string) => iso }),
}));
vi.mock('@/lib/formatRelative', () => ({ formatRelative: () => '2h ago' }));

function page(results: unknown[]) {
  return { data: { pages: [{ results }] }, isLoading: false };
}

const NEWEST = {
  event_type: 'fields_changed',
  actor: { id: 'u1', display_name: 'Alice' },
  timestamp: '2026-04-25T13:00:00Z',
  detail: {},
  diff: [{ field: 'duration', old: '8', new: '10' }],
};

beforeEach(() => {
  hookState = page([]);
});

describe('DrawerRecentActivity (#2315 slice 3)', () => {
  it('shows the latest 3 entries newest-first, filtering empty changes', () => {
    hookState = page([
      { event_type: 'comment_added', actor: { id: 'u2', display_name: 'Bob' }, timestamp: '2026-04-25T11:00:00Z', detail: {} },
      { event_type: 'fields_changed', actor: { id: 'u3', display_name: 'Cara' }, timestamp: '2026-04-25T12:00:00Z', detail: {}, diff: [] }, // empty → filtered
      NEWEST,
      { event_type: 'risk_linked', actor: null, timestamp: '2026-04-25T09:00:00Z', detail: {} },
    ]);
    render(<DrawerRecentActivity projectId="p1" taskId="t1" onViewActivity={vi.fn()} />);

    // Alice (newest, 13:00) → Bob (11:00) → System (09:00); the empty Cara change is dropped.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Alice changed duration');
    expect(items[1]).toHaveTextContent('Bob commented');
    expect(items[2]).toHaveTextContent('System linked a risk');
  });

  it('the "Activity" affordance switches to the Activity tab', async () => {
    const onViewActivity = vi.fn();
    hookState = page([NEWEST]);
    render(<DrawerRecentActivity projectId="p1" taskId="t1" onViewActivity={onViewActivity} />);
    await userEvent.click(screen.getByRole('button', { name: /Activity/i }));
    expect(onViewActivity).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while loading', () => {
    hookState = { data: undefined, isLoading: true };
    const { container } = render(<DrawerRecentActivity projectId="p1" taskId="t1" onViewActivity={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no readable history', () => {
    hookState = page([
      { event_type: 'fields_changed', actor: null, timestamp: '2026-04-25T10:00:00Z', detail: {}, diff: [] },
    ]);
    const { container } = render(<DrawerRecentActivity projectId="p1" taskId="t1" onViewActivity={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
