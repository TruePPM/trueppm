import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MonteCarloRow } from './MonteCarloRow';

import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

// Mutable state used by individual tests to override the hook return.
let mockResult: { data: unknown; isLoading: boolean; error: null } = {
  data: FIXTURE_MC_RESULT,
  isLoading: false,
  error: null,
};

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => mockResult,
}));

describe('MonteCarloRow', () => {
  it('renders nothing when result is undefined', () => {
    mockResult = { data: undefined, isLoading: false, error: null };
    const { container } = renderWithProviders(
      <MonteCarloRow engine={null} taskListWidth={364} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders with null engine (pre-init)', () => {
    mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
    // Should render without crashing; bars won't be positioned yet
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByLabelText(/Monte Carlo confidence row/i)).toBeInTheDocument();
  });

  it('renders the label cell', () => {
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByText('Monte Carlo')).toBeInTheDocument();
  });

  it('shows sigma symbol in the label', () => {
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByText('σ')).toBeInTheDocument();
  });

  it('renders the timeline area with an accessible label', () => {
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    const timeline = screen.getByRole('button');
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P50'));
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P80'));
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P95'));
  });
});
