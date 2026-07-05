import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '@/types';
import type { ProductBacklog } from '../../types';
import { MobileGroomingPage } from './MobileGroomingPage';

function story(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-001',
    shortId: 'S-1',
    name: 'Untitled',
    taskType: 'story',
    dor: 'idea',
    storyPoints: null,
    acMet: 0,
    acTotal: 0,
    assignees: [],
    serverVersion: 1,
    ...overrides,
  } as Task;
}

function makeBacklog(): ProductBacklog {
  return {
    epics: [
      {
        epic: story({ id: 'EP1', name: 'Telemetry', taskType: 'epic' }),
        stories: [
          story({ id: 'S1', name: 'Failover handling', dor: 'ready', storyPoints: 5 }),
          story({ id: 'S2', name: 'Signal smoothing', dor: 'refine', storyPoints: null }),
        ],
        rollup: { storyCount: 2, pointsTotal: 5, pointsDone: 0 },
      },
    ],
    ungrouped: [story({ id: 'S4', name: 'Loose investigation', dor: 'idea', storyPoints: null })],
    health: {
      dorPct: 80,
      readyCount: 1,
      readyPoints: 5,
      capacityPoints: 20,
      unestimated: 2,
      acMet: 0,
      acTotal: 0,
      storyCount: 3,
    },
    scoring: { model: 'none' },
  } as ProductBacklog;
}

const h = vi.hoisted(() => ({
  data: undefined as ProductBacklog | undefined,
  isLoading: false,
  isError: false,
  canManage: true,
  quickAddIsError: false,
  quickAddIsPending: false,
  setDorMutate: vi.fn(),
  quickAddMutate: vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ lower: 'sprint', lowerPlural: 'sprints', singular: 'Sprint' }),
}));
vi.mock('@/hooks/useMyFacets', () => ({ useCanManageBacklog: () => h.canManage }));
vi.mock('../StoryDetailDrawer', () => ({
  StoryDetailDrawer: ({ story: s, onClose }: { story: Task; onClose: () => void }) => (
    <div data-testid="story-drawer">
      {s.name}
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
vi.mock('../../hooks/useProductBacklog', () => ({
  useProductBacklog: () => ({ data: h.data, isLoading: h.isLoading, isError: h.isError }),
  useSetDor: () => ({ mutate: h.setDorMutate }),
  useQuickAddStory: () => ({
    mutate: h.quickAddMutate,
    isError: h.quickAddIsError,
    isPending: h.quickAddIsPending,
  }),
}));

beforeEach(() => {
  h.data = makeBacklog();
  h.isLoading = false;
  h.isError = false;
  h.canManage = true;
  h.quickAddIsError = false;
  h.quickAddIsPending = false;
  h.setDorMutate.mockClear();
  h.quickAddMutate.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MobileGroomingPage (issue 1044)', () => {
  it('shows a loading state while the backlog query is in flight', () => {
    h.isLoading = true;
    h.data = undefined;
    render(<MobileGroomingPage />);
    expect(screen.getByText('Loading backlog…')).toBeInTheDocument();
  });

  it('shows an error state when the query fails', () => {
    h.isError = true;
    h.data = undefined;
    render(<MobileGroomingPage />);
    expect(screen.getByText('Could not load the product backlog.')).toBeInTheDocument();
  });

  it('shows the empty state when there are no stories', () => {
    h.data = { ...makeBacklog(), epics: [], ungrouped: [] };
    render(<MobileGroomingPage />);
    expect(screen.getByText('The product backlog is empty')).toBeInTheDocument();
  });

  it('renders epic-grouped cards plus the ungrouped bucket', () => {
    render(<MobileGroomingPage />);
    expect(screen.getByRole('heading', { name: 'Product backlog' })).toBeInTheDocument();
    expect(screen.getByText('Telemetry')).toBeInTheDocument();
    expect(screen.getByText('No epic')).toBeInTheDocument();
    expect(screen.getByText('Failover handling')).toBeInTheDocument();
    expect(screen.getByText('Loose investigation')).toBeInTheDocument();
    // Health strip
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('renders the readiness health tone as at-risk below 80%', () => {
    h.data = { ...makeBacklog(), health: { ...makeBacklog().health, dorPct: 50 } };
    render(<MobileGroomingPage />);
    expect(screen.getByText('50%').className).toContain('text-semantic-at-risk');
  });

  it('hides the add button when the user cannot manage the backlog', () => {
    h.canManage = false;
    render(<MobileGroomingPage />);
    expect(screen.queryByLabelText('Add story')).not.toBeInTheDocument();
  });

  it('narrows the visible cards via the search box', async () => {
    render(<MobileGroomingPage />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'signal' } });
    await waitFor(() => expect(screen.queryByText('Failover handling')).not.toBeInTheDocument());
    expect(screen.getByText('Signal smoothing')).toBeInTheDocument();
  });

  it('shows a no-results state with a clear-filters action when nothing matches', async () => {
    render(<MobileGroomingPage />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzznomatch' } });
    await screen.findByText('No stories match your filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Failover handling')).toBeInTheDocument();
  });

  it('filters to unestimated stories via the toggle chip', () => {
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByRole('button', { name: /Unestimated/ }));
    expect(screen.getByText('Signal smoothing')).toBeInTheDocument();
    expect(screen.queryByText('Failover handling')).not.toBeInTheDocument();
  });

  it('toggles a story DoR from its card chip', () => {
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByLabelText('Toggle readiness for Failover handling'));
    expect(h.setDorMutate).toHaveBeenCalledWith({ taskId: 'S1', dor: 'refine' });
  });

  it('opens and closes the story drawer when a card is tapped', () => {
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByLabelText('Open story Failover handling'));
    const drawer = screen.getByTestId('story-drawer');
    expect(drawer).toBeInTheDocument();
    fireEvent.click(within(drawer).getByText('close'));
    expect(screen.queryByTestId('story-drawer')).not.toBeInTheDocument();
  });

  it('commits a quick-add and closes the sheet on success', () => {
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByLabelText('Add story'));
    const input = screen.getByLabelText('Story title');
    fireEvent.change(input, { target: { value: 'New groomable story' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.quickAddMutate).toHaveBeenCalledTimes(1);
    expect(h.quickAddMutate.mock.calls[0][0]).toEqual({ name: 'New groomable story' });
    // The sheet closes on success — the title input is gone.
    expect(screen.queryByLabelText('Story title')).not.toBeInTheDocument();
  });

  it('does not submit an empty quick-add draft', () => {
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByLabelText('Add story'));
    const sheet = screen.getByRole('dialog', { name: 'Add a story' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add story' }));
    expect(h.quickAddMutate).not.toHaveBeenCalled();
  });

  it('surfaces a quick-add error inside the sheet', () => {
    h.quickAddIsError = true;
    render(<MobileGroomingPage />);
    fireEvent.click(screen.getByLabelText('Add story'));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add the story");
  });
});
