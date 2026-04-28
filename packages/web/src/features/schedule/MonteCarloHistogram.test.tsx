import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { MonteCarloHistogram } from './MonteCarloHistogram';

describe('MonteCarloHistogram', () => {
  it('renders an accessible SVG with a descriptive label', () => {
    renderWithProviders(<MonteCarloHistogram result={FIXTURE_MC_RESULT} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('P50'),
    );
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('P80'),
    );
  });

  it('renders the correct number of bars (one per bucket)', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    // Each bucket becomes one <rect> bar (plus none from rules which are <line>)
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(FIXTURE_MC_RESULT.buckets.length);
  });

  it('renders three percentile rules (P50/P80/P95)', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    // Three <line> elements: P50, P80, P95 + one baseline = 4
    const lines = container.querySelectorAll('line');
    expect(lines).toHaveLength(4); // P50, P80, P95 + x-axis baseline
  });

  it('renders P80 as a dashed line', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const dashedLine = container.querySelector('line[stroke-dasharray="4 2"]');
    expect(dashedLine).toBeInTheDocument();
    expect(dashedLine).toHaveAttribute('aria-label', expect.stringContaining('P80'));
  });

  it('renders P95 as a dotted line', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const dottedLine = container.querySelector('line[stroke-dasharray="1 2"]');
    expect(dottedLine).toBeInTheDocument();
    expect(dottedLine).toHaveAttribute('aria-label', expect.stringContaining('P95'));
  });

  it('renders a <title> element for screen readers', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const title = container.querySelector('title');
    expect(title).not.toBeNull();
    expect(title?.textContent).toContain('P50');
  });
});
