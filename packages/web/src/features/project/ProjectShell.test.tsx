import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { renderWithRouter } from '@/test/utils';
import { ProjectShell } from './ProjectShell';

// Spy on the WS hook so tests can assert it is suppressed (called with null) once
// the project becomes unavailable (#2040). Hoisted so the vi.mock factory below
// can close over it.
const wsSpy = vi.hoisted(() => vi.fn());

// Keep the shell isolated: stub the WebSocket, the recalc store, and the two
// presentational children so the test targets only the availability gate.
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: (id: string | null) => {
    wsSpy(id);
  },
}));
vi.mock('@/hooks/useRecordProjectVisit', () => ({ useRecordProjectVisit: () => undefined }));
vi.mock('@/stores/schedulerStore', () => ({ useSchedulerStore: () => false }));
vi.mock('./ProjectSampleIndicator', () => ({ ProjectSampleIndicator: () => null }));
vi.mock('./RecalculatingBadge', () => ({ RecalculatingBadge: () => null }));

const mockUseProject = vi.fn<() => { error: unknown }>();
vi.mock('@/hooks/useProject', () => ({ useProject: () => mockUseProject() }));

function axiosStatus(statusCode: number): AxiosError {
  const err = new AxiosError('boom');
  err.response = { status: statusCode } as never;
  return err;
}

describe('ProjectShell availability gate (#1111, #2040)', () => {
  beforeEach(() => {
    mockUseProject.mockReset();
    wsSpy.mockReset();
  });

  it('renders ProjectNotFound when the project query 404s (deleted / no access)', () => {
    mockUseProject.mockReturnValue({ error: axiosStatus(404) });
    renderWithRouter(<ProjectShell />);
    expect(screen.getByRole('heading', { name: /isn.t available/i })).toBeInTheDocument();
  });

  it('renders the unavailable state when the project query 403s (revoked access)', () => {
    mockUseProject.mockReturnValue({ error: axiosStatus(403) });
    renderWithRouter(<ProjectShell />);
    expect(screen.getByRole('heading', { name: /isn.t available/i })).toBeInTheDocument();
  });

  it('renders the project layout (not the unavailable state) when the project resolves', () => {
    mockUseProject.mockReturnValue({ error: null });
    renderWithRouter(<ProjectShell />);
    expect(screen.queryByRole('heading', { name: /isn.t available/i })).not.toBeInTheDocument();
  });

  it('does not treat a non-403/404 error (e.g. transient 500) as unavailable', () => {
    mockUseProject.mockReturnValue({ error: axiosStatus(500) });
    renderWithRouter(<ProjectShell />);
    expect(screen.queryByRole('heading', { name: /isn.t available/i })).not.toBeInTheDocument();
  });

  it('keeps the WebSocket live on a healthy project', () => {
    mockUseProject.mockReturnValue({ error: null });
    renderWithRouter(<ProjectShell />);
    expect(wsSpy).toHaveBeenCalledWith('proj-1');
  });

  it('suppresses the WebSocket (passes null) once the project is unavailable', () => {
    mockUseProject.mockReturnValue({ error: axiosStatus(403) });
    renderWithRouter(<ProjectShell />);
    expect(wsSpy).toHaveBeenCalledWith(null);
    expect(wsSpy).not.toHaveBeenCalledWith('proj-1');
  });
});
