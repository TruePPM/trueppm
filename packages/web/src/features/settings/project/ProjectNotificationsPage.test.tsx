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
  // Mirrors the server's #2904 classification: only comment_mention is wired.
  eventDelivery: {
    task_assigned: false,
    task_overdue: false,
    comment_mention: true,
    status_change: false,
    budget_alert: false,
    risk_created: false,
    milestone_reached: false,
    sprint_start: false,
    sprint_end: false,
  },
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

  it('renders contextual help for the routing matrix and quiet hours (#2266)', () => {
    renderPage();
    expect(
      screen.getByRole('button', { name: /About the Notification routing options/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /About the Quiet hours options/i }),
    ).toBeInTheDocument();
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
    // Rule 248: a skeleton ghost with a named status node, never bare text (#2431).
    expect(screen.getByRole('status', { name: /Loading notification rules/i })).toBeInTheDocument();
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

  // #2904 — eight of the nine rows are dispatched by nothing. They render, and
  // toggling one has no effect in either direction. The page must say so rather
  // than presenting them identically to the one that works.
  it('labels the rows the server reports as not dispatched', () => {
    renderPage();

    // By title, not text: the explanatory banner repeats the badge wording, so a
    // text query would count 9 (8 badges + the banner's inline reference).
    expect(screen.getAllByTitle(/not dispatched yet/i)).toHaveLength(8);
    expect(
      screen.getByText(/are not\s+dispatched by TruePPM yet/i),
    ).toBeInTheDocument();
  });

  it('leaves an undispatched row fully interactive', () => {
    renderPage();

    // De-emphasis must never remove function: the preference is still saved, and
    // applies once the dispatcher lands. A disabled toggle would discard intent.
    const toggle = screen.getByRole('switch', { name: /Sprint started via email/i });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('shows no labels or banner when every row is dispatched', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        eventDelivery: Object.fromEntries(
          Object.keys(SEED.eventDelivery).map((event) => [event, true]),
        ),
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.queryByTitle(/not dispatched yet/i)).not.toBeInTheDocument();
    // Scoped to the banner, not a bare /not delivered yet/ text query: the Slack
    // and Mobile push COLUMN markers (#3249) carry the same wording and are
    // always present, independent of the per-row classification asserted here.
    expect(screen.queryByText(/^Rows marked/i)).not.toBeInTheDocument();
  });

  it('shows no labels when an older server sends no classification', () => {
    // Absence is "no claim made", never "nothing is delivered" — an older API
    // must not make the whole matrix look broken.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: { ...SEED, eventDelivery: {} },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.queryByTitle(/not dispatched yet/i)).not.toBeInTheDocument();
    // Scoped to the banner, not a bare /not delivered yet/ text query: the Slack
    // and Mobile push COLUMN markers (#3249) carry the same wording and are
    // always present, independent of the per-row classification asserted here.
    expect(screen.queryByText(/^Rows marked/i)).not.toBeInTheDocument();
  });

  // #3249 — nothing in apps/notifications delivers on Slack or mobile push, and
  // no setting anywhere turns them on. Unmarked, the columns read as working
  // controls. The row badges are per-event and cannot cover this: the channel is
  // dead for every row, including the one event that IS dispatched.
  it('marks the channels with no delivery path, and only those', () => {
    renderPage();

    const marked = screen.getAllByTitle(/does not deliver on this channel yet/i);
    expect(marked).toHaveLength(2);
    marked.forEach((el) => expect(el).toHaveTextContent(/not delivered yet/i));
  });

  it('marks the undeliverable columns even when every event is dispatched', () => {
    // The two markers are independent of the per-event classification — a server
    // that wires all nine dispatchers still cannot deliver to Slack or push.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        eventDelivery: Object.fromEntries(
          Object.keys(SEED.eventDelivery).map((event) => [event, true]),
        ),
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.getAllByTitle(/does not deliver on this channel yet/i)).toHaveLength(2);
  });

  it('does not tell the user to configure Slack notification delivery in Integrations', () => {
    // The card used to read "Configure Slack channels for your workspace in
    // Project Settings → Integrations" and route three levels to "Configure in
    // Integrations". That page has no Slack configuration and none exists, so the
    // instruction sent people somewhere that could not help them.
    renderPage();

    expect(screen.queryByText(/Slack channel routing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Configure in Integrations/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not deliver notifications to Slack or mobile push yet/i))
      .toBeInTheDocument();
    // The webhook pointer is a real, different capability — it must stay marked
    // as project-wide so it is not read as a fix for the matrix above.
    expect(screen.getByText(/project-wide feed/i)).toBeInTheDocument();
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
