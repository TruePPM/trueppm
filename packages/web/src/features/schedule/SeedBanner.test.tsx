import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SeedBanner } from './SeedBanner';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import type { Task } from '@/types';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function t(id: string, extra: Partial<Task> = {}): Task {
  return { id, isUntouchedSeed: false, ...extra } as Task;
}

const application = {
  id: 'app-1',
  template: 'tmpl-1',
  template_name: 'Kickoff skeleton',
  template_version: 1,
  project: 'proj-1',
  status: 'success',
  result_summary: { tasks_created: 5, milestones_created: 1, dependencies_created: 3 },
  error_detail: '',
  created_at: '2026-08-05T00:00:00Z',
  completed_at: '2026-08-05T00:00:01Z',
  undone_at: null,
};

const project = {
  id: 'proj-1',
  effective_calendar: { id: 'cal-1', name: 'Standard 5-day', working_days: 31, hours_per_day: 8, timezone: 'UTC', holiday_count: 0 },
};

function mockGets() {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/template-applications/')) return Promise.resolve({ data: application });
    if (url.includes('/projects/')) return Promise.resolve({ data: project });
    return Promise.resolve({ data: {} });
  });
}

describe('SeedBanner (#2731, ADR-0799 §1)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('renders the template name and the rows/milestones/dependencies/calendar counts', async () => {
    mockGets();
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[]}
        currentRole={ROLE_ADMIN}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    await screen.findByTestId('seed-banner');
    // "Kickoff skeleton" and the counts appear both in the visible summary and
    // the sr-only live region — assert against the visible counts line by test
    // id rather than a text query that matches both.
    expect(screen.getAllByText(/Kickoff skeleton/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('seed-banner-counts')).toHaveTextContent(
      '5 rows · 1 milestone · 3 dependencies · scheduled on Standard 5-day',
    );
  });

  it('renders nothing while the application is still pending or running', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/template-applications/')) {
        return Promise.resolve({ data: { ...application, status: 'pending' } });
      }
      return Promise.resolve({ data: project });
    });
    const { container } = render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[]}
        currentRole={ROLE_ADMIN}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="seed-banner"]')).toBeNull();
  });

  it('shows "Delete untouched rows (N)" only when N > 0, counting isUntouchedSeed live', async () => {
    mockGets();
    const tasks = [t('a', { isUntouchedSeed: true }), t('b', { isUntouchedSeed: true }), t('c')];
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={tasks}
        currentRole={ROLE_ADMIN}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    expect(await screen.findByRole('button', { name: 'Delete untouched rows (2)' })).toBeInTheDocument();
  });

  it('hides "Delete untouched rows" when nothing is untouched', async () => {
    mockGets();
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[t('a', { isUntouchedSeed: false })]}
        currentRole={ROLE_ADMIN}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    await screen.findByTestId('seed-banner');
    expect(screen.queryByTestId('seed-banner-delete-untouched')).toBeNull();
  });

  it('requires a second click to confirm delete, then POSTs the project id', async () => {
    mockGets();
    postMock.mockResolvedValue({ data: { deleted: 2 } });
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[t('a', { isUntouchedSeed: true }), t('b', { isUntouchedSeed: true })]}
        currentRole={ROLE_ADMIN}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    const deleteBtn = await screen.findByRole('button', { name: 'Delete untouched rows (2)' });
    fireEvent.click(deleteBtn);
    expect(postMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Confirm delete (2)?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete (2)?' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/delete-untouched-seeded/', { project: 'proj-1' }),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it('Undo apply POSTs the undo action and dismisses the banner on success', async () => {
    mockGets();
    postMock.mockResolvedValue({ data: { ...application, undo: { deleted: 5, kept: 0 } } });
    const onDismiss = vi.fn();
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[]}
        currentRole={ROLE_ADMIN}
        onDismiss={onDismiss}
      />,
      { wrapper },
    );
    fireEvent.click(await screen.findByRole('button', { name: /Undo apply/ }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/template-applications/app-1/undo/', {}),
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('below Admin, the banner shows but management controls are hidden', async () => {
    mockGets();
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[t('a', { isUntouchedSeed: true })]}
        currentRole={ROLE_MEMBER}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    await screen.findByTestId('seed-banner');
    expect(screen.queryByTestId('seed-banner-delete-untouched')).toBeNull();
    expect(screen.queryByRole('button', { name: /Undo apply/ })).toBeNull();
  });

  it('the dismiss control calls onDismiss without any request', async () => {
    mockGets();
    const onDismiss = vi.fn();
    render(
      <SeedBanner
        projectId="proj-1"
        applicationId="app-1"
        tasks={[]}
        currentRole={ROLE_ADMIN}
        onDismiss={onDismiss}
      />,
      { wrapper },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss seed banner' }));
    expect(onDismiss).toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });
});
