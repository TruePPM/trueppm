import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BurnTooltip, TodayLabel } from './BurnTooltip';
import type { NormPoint, ScopeChange } from './burnChartData';

function point(overrides: Partial<NormPoint> = {}): NormPoint {
  return { date: '2026-04-10', remaining: 12, completed: 8, scope: 20, ideal: 10, ...overrides };
}

const CHANGES: ScopeChange[] = [
  { date: '2026-04-10', delta: 3, newScope: 23 },
  { date: '2026-04-12', delta: -2, newScope: 21 },
];

function renderTip(
  props: Partial<Parameters<typeof BurnTooltip>[0]> = {},
  pt: NormPoint = point(),
) {
  return render(
    <BurnTooltip
      active
      label="2026-04-10"
      payload={[{ payload: pt }]}
      variant="burndown"
      metric="points"
      scopeChanges={[]}
      {...props}
    />,
  );
}

describe('BurnTooltip', () => {
  it('renders nothing when inactive or when Recharts hands it no row', () => {
    const { container } = renderTip({ active: false });
    expect(container).toBeEmptyDOMElement();
    const { container: empty } = renderTip({ payload: [] });
    expect(empty).toBeEmptyDOMElement();
    const { container: bare } = renderTip({ payload: [{}] });
    expect(bare).toBeEmptyDOMElement();
  });

  it('burndown: prints remaining, ideal and the behind-ideal delta in points', () => {
    renderTip();
    expect(screen.getByText('Apr 10')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toHaveTextContent('12 pts');
    expect(screen.getByText('Ideal')).toHaveTextContent('10 pts');
    expect(screen.getByText('2 pts behind')).toHaveClass('text-semantic-critical');
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('burndown: an ahead delta is green, and the unit follows the metric', () => {
    renderTip({ metric: 'tasks' }, point({ remaining: 6.4, ideal: 10 }));
    expect(screen.getByText('4 tasks ahead')).toHaveClass('text-semantic-on-track');
    expect(screen.getByText('Remaining')).toHaveTextContent('6 tasks');
  });

  it('burnup: prints completed only, with no ideal or delta rows', () => {
    renderTip({ variant: 'burnup' });
    expect(screen.getByText('Completed')).toHaveTextContent('8 pts');
    expect(screen.queryByText('Remaining')).toBeNull();
    expect(screen.queryByText('Ideal')).toBeNull();
    expect(screen.queryByText(/ahead|behind/)).toBeNull();
  });

  it('combined: prints both remaining and completed, no ideal', () => {
    renderTip({ variant: 'combined' });
    expect(screen.getByText('Remaining')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Ideal')).toBeNull();
  });

  it('collapses past-last-snapshot nulls to zero instead of NaN', () => {
    renderTip({}, point({ remaining: null, completed: null }));
    expect(screen.getByText('Remaining')).toHaveTextContent('0 pts');
    expect(screen.getByText('10 pts ahead')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('shows the scope change for the hovered day, signed and colored by direction', () => {
    renderTip({ scopeChanges: CHANGES });
    expect(screen.getByText('+3 pts scope change')).toHaveClass('text-semantic-at-risk');

    renderTip({ scopeChanges: CHANGES, label: '2026-04-12' }, point({ date: '2026-04-12' }));
    expect(screen.getByText('-2 pts scope change')).toHaveClass('text-semantic-critical');
  });

  it('tolerates a missing label', () => {
    renderTip({ label: undefined });
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });
});

describe('TodayLabel', () => {
  it('draws TODAY just above the reference line, and nothing without a viewBox', () => {
    const { container } = render(
      <svg>
        <TodayLabel viewBox={{ x: 40, y: 30 }} />
      </svg>,
    );
    const text = container.querySelector('text');
    expect(text).toHaveTextContent('TODAY');
    expect(text).toHaveAttribute('x', '40');
    expect(text).toHaveAttribute('y', '26');

    const { container: empty } = render(
      <svg>
        <TodayLabel />
      </svg>,
    );
    expect(empty.querySelector('text')).toBeNull();
  });
});
