import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportProvenanceSection } from './ImportProvenanceSection';
import type { ImportProvenanceRow } from '@/hooks/useImportRequests';

const useImportRequests = vi.fn();

vi.mock('@/hooks/useImportRequests', () => ({
  useImportRequests: () =>
    useImportRequests() as { data: unknown; isLoading: boolean; isError: boolean },
}));

function renderSection(projectId = 'proj-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportProvenanceSection projectId={projectId} />
    </QueryClientProvider>,
  );
}

const mkRow = (overrides: Partial<ImportProvenanceRow> = {}): ImportProvenanceRow => ({
  id: 'imp-1',
  filename: 'old-plan.xml',
  status: 'done',
  creates_project: false,
  requested_at: new Date('2026-05-25T12:00:00Z').toISOString(),
  initiated_by: 7,
  initiated_by_username: 'marcus',
  task_count: 12,
  ...overrides,
});

beforeEach(() => {
  useImportRequests.mockReset();
});

describe('ImportProvenanceSection', () => {
  it('renders nothing when the project has no imports', () => {
    useImportRequests.mockReturnValue({ data: [], isLoading: false, isError: false });
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the query is loading', () => {
    useImportRequests.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on error (degrades silently)', () => {
    useImportRequests.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it('renders the filename, status badge, user, and task count', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow()],
      isLoading: false,
      isError: false,
    });
    renderSection();
    expect(screen.getByRole('region', { name: /project history/i })).toBeInTheDocument();
    expect(screen.getByText('old-plan.xml')).toBeInTheDocument();
    expect(screen.getByLabelText(/Import status: Complete/)).toBeInTheDocument();
    expect(screen.getByText('marcus')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/tasks imported/)).toBeInTheDocument();
  });

  it('uses the "Imported into a new project" verb for create-from-import rows', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow({ creates_project: true })],
      isLoading: false,
      isError: false,
    });
    renderSection();
    expect(screen.getByText(/Imported into a new project from/i)).toBeInTheDocument();
  });

  it('falls back to a placeholder when the initiating user was deleted', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow({ initiated_by: null, initiated_by_username: null })],
      isLoading: false,
      isError: false,
    });
    renderSection();
    // "by " is rendered in a parent span and the username in a nested one,
    // so getByText with the full phrase fails. Match the username alone.
    expect(screen.getByText('an unknown user')).toBeInTheDocument();
  });

  it('hides the task-count fragment when the count is null', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow({ status: 'pending', task_count: null })],
      isLoading: false,
      isError: false,
    });
    renderSection();
    expect(screen.queryByText(/tasks imported/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Import status: Queued/)).toBeInTheDocument();
  });

  it('uses singular "task imported" when count is exactly 1', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow({ task_count: 1 })],
      isLoading: false,
      isError: false,
    });
    renderSection();
    expect(screen.getByText(/task imported/)).toBeInTheDocument();
    expect(screen.queryByText(/tasks imported/)).not.toBeInTheDocument();
  });

  it('shows a Failed badge for dead imports so the operator notices', () => {
    useImportRequests.mockReturnValue({
      data: [mkRow({ status: 'dead', task_count: null })],
      isLoading: false,
      isError: false,
    });
    renderSection();
    expect(screen.getByLabelText(/Import status: Failed/)).toBeInTheDocument();
  });
});
