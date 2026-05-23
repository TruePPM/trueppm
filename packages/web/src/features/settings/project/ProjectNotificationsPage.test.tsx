import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectNotificationsPage } from './ProjectNotificationsPage';
import type {
  ProjectNotificationPreferences,
  ProjectNotificationPatch,
} from '@/hooks/useProjectNotificationPreferences';

const useProjectId = vi.fn();
const useProjectNotificationPreferences = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useProjectNotificationPreferences', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/useProjectNotificationPreferences')
  >('@/hooks/useProjectNotificationPreferences');
  return {
    ...actual,
    useProjectNotificationPreferences: (id: string | undefined) =>
      useProjectNotificationPreferences(id) as unknown,
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/notifications']}>
        <Routes>
          <Route
            path="/projects/:projectId/settings/notifications"
            element={<ProjectNotificationsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SEED: ProjectNotificationPreferences = {
  matrix: {
    task_assigned: { in_app: true, email: true, slack: true, mobile_push: true },
    task_overdue: { in_app: true, email: true, slack: true, mobile_push: true },
    comment_mention: { in_app: true, email: true, slack: true, mobile_push: true },
    status_change: { in_app: true, email: false, slack: false, mobile_push: false },
    budget_alert: { in_app: true, email: true, slack: true, mobile_push: true },
    risk_created: { in_app: true, email: true, slack: true, mobile_push: true },
    milestone_reached: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_start: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_end: { in_app: true, email: true, slack: true, mobile_push: false },
  },
  paused: false,
  quietHoursEnabled: true,
  quietHoursFrom: '20:00:00',
  quietHoursUntil: '07:00:00',
};

let mutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
  mutate = vi.fn();
  useProjectNotificationPreferences.mockReturnValue({
    preferences: SEED,
    isLoading: false,
    error: null,
    update: { mutate },
  });
});

describe('ProjectNotificationsPage', () => {
  it('renders one row per event and one column per channel', () => {
    renderPage();
    expect(screen.getByText('Task assigned to me')).toBeInTheDocument();
    expect(screen.getByText('Sprint closed')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(9 * 4); // 36 toggles + quiet hours
  });

  it('reflects seeded matrix values on each toggle', () => {
    renderPage();
    const overdueEmail = screen.getByRole('switch', { name: /task i own is overdue via email/i });
    expect(overdueEmail).toHaveAttribute('aria-checked', 'true');
    const statusEmail = screen.getByRole('switch', { name: /task moves to another column via email/i });
    expect(statusEmail).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles a single matrix cell via partial PATCH', async () => {
    renderPage();
    const toggle = screen.getByRole('switch', { name: /task assigned to me via email/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const arg = mutate.mock.calls[0][0] as ProjectNotificationPatch;
    expect(arg.matrix).toEqual({ task_assigned: { email: false } });
  });

  it('toggles quiet hours via PATCH', async () => {
    renderPage();
    const quiet = screen.getByRole('switch', { name: /quiet hours/i });
    fireEvent.click(quiet);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ quietHoursEnabled: false });
  });

  it('persists a new quiet hours start time as HH:MM:SS', async () => {
    renderPage();
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '22:00' } });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ quietHoursFrom: '22:00:00' });
  });

  it('renders a loading state when the query has not resolved yet', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: undefined,
      isLoading: true,
      error: null,
      update: { mutate },
    });
    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders the pause-all kill-switch above the matrix (#589)', () => {
    renderPage();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    expect(pause).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/one-click opt-out/i)).toBeInTheDocument();
  });

  it('PATCHes paused=true when the kill-switch is toggled on (#589)', async () => {
    renderPage();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    fireEvent.click(pause);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ paused: true });
  });

  it('shows the paused copy and dims the matrix when paused=true (#589)', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: { ...SEED, paused: true },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();
    expect(screen.getByText(/^Paused —/i)).toBeInTheDocument();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    expect(pause).toHaveAttribute('aria-checked', 'true');
  });

  it('renders an error state on API failure', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: undefined,
      isLoading: false,
      error: new Error('boom'),
      update: { mutate },
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load preferences/i);
  });
});
