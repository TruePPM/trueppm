import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectIntegrationsPage } from './ProjectIntegrationsPage';

const useProjectIntegrationsSummary = vi.fn();
const useProjectId = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useProjectIntegrationsSummary', () => ({
  useProjectIntegrationsSummary: () =>
    useProjectIntegrationsSummary() as {
      summary: unknown;
      isLoading: boolean;
      error: Error | null;
      failedSection: 'webhooks' | 'api_tokens' | null;
      refetch: () => Promise<unknown>;
    },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/integrations']}>
        <Routes>
          <Route
            path="/projects/:projectId/settings/integrations"
            element={<ProjectIntegrationsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const EMPTY_SUMMARY = {
  webhooks: { items: [], total: 0, active_total: 0, last_delivery_at: null },
  api_tokens: { items: [], active_total: 0, last_used_at: null },
};

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
});

describe('ProjectIntegrationsPage', () => {
  it('renders skeleton while loading', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: undefined,
      isLoading: true,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByLabelText(/Loading Outbound webhooks/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Loading Inbound API tokens/i)).toBeInTheDocument();
  });

  it('renders page-level empty state when both sections are empty', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: EMPTY_SUMMARY,
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/No integrations yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Add a webhook/i)).toBeInTheDocument();
    expect(screen.getByText(/Generate an API token/i)).toBeInTheDocument();
  });

  it('renders webhook rows when webhooks exist', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: {
        webhooks: {
          items: [
            {
              id: 'wh-1',
              url: 'https://hooks.slack.com/services/X/Y/Z',
              is_active: true,
              events: ['task.created'],
              created_at: '2026-05-20T12:00:00Z',
              last_delivery: {
                status: 'success',
                created_at: '2026-05-20T12:30:00Z',
                response_status: 200,
                attempt_count: 1,
              },
              recent_failure_count: 0,
            },
          ],
          total: 1,
          active_total: 1,
          last_delivery_at: '2026-05-20T12:30:00Z',
        },
        api_tokens: { items: [], active_total: 0, last_used_at: null },
      },
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(
      screen.getByText('https://hooks.slack.com/services/X/Y/Z'),
    ).toBeInTheDocument();
  });

  it('renders API token rows with their prefix when tokens exist', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: {
        webhooks: { items: [], total: 0, active_total: 0, last_delivery_at: null },
        api_tokens: {
          items: [
            {
              id: 'tok-1',
              name: 'CI Pipeline',
              token_prefix: 'abc12345',
              created_at: '2026-05-15T00:00:00Z',
              last_used_at: '2026-05-20T11:00:00Z',
            },
          ],
          active_total: 1,
          last_used_at: '2026-05-20T11:00:00Z',
        },
      },
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
    expect(screen.getByText(/abc12345/)).toBeInTheDocument();
  });

  it('renders per-section error card with Retry when one subservice fails', () => {
    const refetch = vi.fn();
    useProjectIntegrationsSummary.mockReturnValue({
      summary: undefined,
      isLoading: false,
      error: new Error('503'),
      failedSection: 'webhooks',
      refetch,
    });
    renderPage();
    expect(screen.getByText(/Couldn.t load this section/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    expect(retry).toBeInTheDocument();
  });

  it('exposes the Refresh button in the header', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: EMPTY_SUMMARY,
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    const refresh = screen.getByRole('button', { name: /Refresh integrations summary/i });
    expect(refresh).toBeInTheDocument();
  });

  it('renders the connected accounts teaser explaining where credentials live', () => {
    useProjectIntegrationsSummary.mockReturnValue({
      summary: {
        ...EMPTY_SUMMARY,
        webhooks: { ...EMPTY_SUMMARY.webhooks, total: 1, items: [
          {
            id: 'wh-1',
            url: 'https://hooks.example.com/h',
            is_active: true,
            events: ['task.created'],
            created_at: '2026-05-20T12:00:00Z',
            last_delivery: null,
            recent_failure_count: 0,
          },
        ] },
      },
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/Your connected accounts/i)).toBeInTheDocument();
  });

  it('returns null when projectId is unavailable', () => {
    useProjectId.mockReturnValue(undefined);
    useProjectIntegrationsSummary.mockReturnValue({
      summary: undefined,
      isLoading: false,
      error: null,
      failedSection: null,
      refetch: vi.fn(),
    });
    const { container } = renderPage();
    // Router still mounts the route; the page returns null inside it, so the
    // root has no integration-page content.
    expect(within(container).queryByText(/Outbound webhooks/i)).toBeNull();
  });
});
