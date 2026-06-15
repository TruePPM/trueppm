import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MyWorkEmptyState } from './MyWorkEmptyState';

const loadSampleMutate = vi.fn();
let loadSampleState = { isPending: false };

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useLoadSampleProgram: () => ({ mutate: loadSampleMutate, ...loadSampleState }),
}));

beforeEach(() => {
  loadSampleMutate.mockReset();
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
