import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MyWorkEmptyState } from './MyWorkEmptyState';

const loadSampleMutate = vi.fn();
let loadSampleState = { isPending: false };

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useLoadSampleProgram: () => ({ mutate: loadSampleMutate, ...loadSampleState }),
}));

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateMock,
}));

beforeEach(() => {
  loadSampleMutate.mockReset();
  navigateMock.mockReset();
  loadSampleState = { isPending: false };
  vi.restoreAllMocks();
});

describe('MyWorkEmptyState v2 (#499 / ADR-0129)', () => {
  it('flavor A (no projects) — warm welcome + Explore a demo project CTA + Learn more', () => {
    renderWithRouter(<MyWorkEmptyState hasProjects={false} />);
    expect(screen.getByRole('heading', { name: /get you started/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explore a demo project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Learn more/i })).toBeInTheDocument();
  });

  it('flavor A — clicking the demo CTA fires the load-sample mutation', () => {
    renderWithRouter(<MyWorkEmptyState hasProjects={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore a demo project' }));
    expect(loadSampleMutate).toHaveBeenCalledTimes(1);
  });

  it('flavor A — on success routes the contributor to the assigned board with the sample key (issue 1054)', () => {
    loadSampleMutate.mockImplementation(
      (_arg: unknown, opts: { onSuccess: (r: unknown) => void }) => {
        opts.onSuccess({
          program: { id: 'prog-1' },
          landing_project_id: 'proj-9',
          sample_key: 'atlas-platform-launch',
        });
      },
    );
    renderWithRouter(<MyWorkEmptyState hasProjects={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore a demo project' }));
    expect(navigateMock).toHaveBeenCalledWith('/projects/proj-9/board', {
      state: { startExploringSample: 'atlas-platform-launch' },
    });
  });

  it('flavor A — falls back to the program overview when the sample has no open sprint (issue 1054)', () => {
    loadSampleMutate.mockImplementation(
      (_arg: unknown, opts: { onSuccess: (r: unknown) => void }) => {
        opts.onSuccess({
          program: { id: 'prog-1' },
          landing_project_id: null,
          sample_key: 'bayside-civic-center',
        });
      },
    );
    renderWithRouter(<MyWorkEmptyState hasProjects={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore a demo project' }));
    expect(navigateMock).toHaveBeenCalledWith('/programs/prog-1/overview', {
      state: { startExploringSample: 'bayside-civic-center' },
    });
  });

  it('flavor B (has projects, no assignments) — refreshed copy, NO demo CTA', () => {
    renderWithRouter(<MyWorkEmptyState hasProjects />);
    expect(screen.getByRole('heading', { name: /all caught up/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Explore a demo project/i })).toBeNull();
    expect(screen.getByRole('link', { name: /Learn more/i })).toBeInTheDocument();
  });

  it('offline — shows the offline copy and disables the demo CTA', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderWithRouter(<MyWorkEmptyState hasProjects={false} />);
    expect(screen.getByRole('heading', { name: /offline/i })).toBeInTheDocument();
    expect(screen.getByText(/Your work will appear here once you reconnect/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explore a demo project' })).toBeDisabled();
  });
});
