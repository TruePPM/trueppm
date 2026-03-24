import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MonteCarloRow } from './MonteCarloRow';

describe('MonteCarloRow', () => {
  it('renders with null engine (pre-init)', () => {
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
