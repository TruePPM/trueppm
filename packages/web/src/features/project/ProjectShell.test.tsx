import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { renderWithRouter } from '@/test/utils';
import { ProjectShell } from './ProjectShell';

// Keep the shell isolated: stub the WebSocket, the recalc store, and the two
// presentational children so the test targets only the not-found gate (#1111).
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProjectWebSocket', () => ({ useProjectWebSocket: () => undefined }));
vi.mock('@/stores/schedulerStore', () => ({ useSchedulerStore: () => false }));
vi.mock('./ProjectSampleIndicator', () => ({ ProjectSampleIndicator: () => null }));
vi.mock('./RecalculatingBadge', () => ({ RecalculatingBadge: () => null }));

const mockUseProject = vi.fn<() => { error: unknown }>();
vi.mock('@/hooks/useProject', () => ({ useProject: () => mockUseProject() }));

function axios404(): AxiosError {
  const err = new AxiosError('Not found');
  err.response = { status: 404 } as never;
  return err;
}

describe('ProjectShell not-found gate (#1111)', () => {
  beforeEach(() => mockUseProject.mockReset());

  it('renders ProjectNotFound when the project query 404s', () => {
    mockUseProject.mockReturnValue({ error: axios404() });
    renderWithRouter(<ProjectShell />);
    expect(screen.getByRole('heading', { name: /isn.t available/i })).toBeInTheDocument();
  });

  it('renders the project layout (not the not-found state) when the project resolves', () => {
    mockUseProject.mockReturnValue({ error: null });
    renderWithRouter(<ProjectShell />);
    expect(screen.queryByRole('heading', { name: /isn.t available/i })).not.toBeInTheDocument();
  });

  it('does not treat a non-404 error (e.g. transient 500) as not-found', () => {
    const err = new AxiosError('Server error');
    err.response = { status: 500 } as never;
    mockUseProject.mockReturnValue({ error: err });
    renderWithRouter(<ProjectShell />);
    expect(screen.queryByRole('heading', { name: /isn.t available/i })).not.toBeInTheDocument();
  });
});
