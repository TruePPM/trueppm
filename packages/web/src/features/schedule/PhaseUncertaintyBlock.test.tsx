import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';

const mcSpy = vi.hoisted(() =>
  vi.fn<(projectId?: string) => UseMonteCarloResultReturn>(),
);

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: (projectId?: string) => mcSpy(projectId),
}));

// Import after mock registration
const { PhaseUncertaintyBlock } = await import('./PhaseUncertaintyBlock');

const MCResult = {
  projectId: 'p1',
  runs: 1000,
  p50: '2026-09-15',
  p80: '2026-10-01',
  p95: '2026-10-20',
  buckets: [],
  cpmFinish: null,
  deltaVsCpm: { p50: null, p80: null, p95: null },
  confidenceCurve: [],
};

describe('PhaseUncertaintyBlock', () => {
  beforeEach(() => {
    mcSpy.mockReset();
    mcSpy.mockReturnValue({ data: MCResult, isLoading: false, error: null });
  });

  it('renders nothing while loading', () => {
    mcSpy.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = renderWithProviders(<PhaseUncertaintyBlock projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Run Monte Carlo hint when no MC result', () => {
    mcSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    renderWithProviders(<PhaseUncertaintyBlock projectId="p1" />);
    expect(screen.getByText(/Run Monte Carlo to see phase confidence dates/i)).toBeInTheDocument();
    expect(screen.getByText(/Edit estimates on leaf tasks/i)).toBeInTheDocument();
  });

  it('renders Phase P50/P80/P95 chips when MC result is available', () => {
    renderWithProviders(<PhaseUncertaintyBlock projectId="p1" />);
    expect(screen.getByText(/Phase P50/)).toBeInTheDocument();
    expect(screen.getByText(/Phase P80/)).toBeInTheDocument();
    expect(screen.getByText(/Phase P95/)).toBeInTheDocument();
  });

  it('shows derived-from subtext', () => {
    renderWithProviders(<PhaseUncertaintyBlock projectId="p1" />);
    expect(
      screen.getByText(/Derived from child task estimates/i),
    ).toBeInTheDocument();
  });

  it('labels the region for screen readers', () => {
    renderWithProviders(<PhaseUncertaintyBlock projectId="p1" />);
    expect(screen.getAllByRole('region', { name: /phase schedule confidence/i })).toHaveLength(1);
  });

  it('forwards projectId to useMonteCarloResult', () => {
    renderWithProviders(<PhaseUncertaintyBlock projectId="proj-xyz" />);
    expect(mcSpy).toHaveBeenCalledWith('proj-xyz');
  });
});
