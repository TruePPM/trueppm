import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MonteCarloRow } from './MonteCarloRow';

describe('MonteCarloRow', () => {
  it('renders with null ganttApi (pre-init)', () => {
    // Should render without crashing; bars won't be positioned yet
    renderWithProviders(<MonteCarloRow ganttApi={null} />);
    expect(screen.getByLabelText(/Monte Carlo confidence row/i)).toBeInTheDocument();
  });

  it('renders the label cell', () => {
    renderWithProviders(<MonteCarloRow ganttApi={null} />);
    expect(screen.getByText('Monte Carlo')).toBeInTheDocument();
  });

  it('shows sigma symbol in the label', () => {
    renderWithProviders(<MonteCarloRow ganttApi={null} />);
    expect(screen.getByText('σ')).toBeInTheDocument();
  });

  it('renders the timeline area with an accessible label', () => {
    renderWithProviders(<MonteCarloRow ganttApi={null} />);
    const timeline = screen.getByRole('button');
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P50'));
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P80'));
    expect(timeline).toHaveAttribute('aria-label', expect.stringContaining('P95'));
  });
});
