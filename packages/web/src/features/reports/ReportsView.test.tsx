import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProvidersAndRouter as render } from '@/test/utils';
import { ReportsView } from './ReportsView';

const useProjectIdMock = vi.hoisted(() => vi.fn());
const useSprintsMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: useProjectIdMock }));
vi.mock('@/hooks/useSprints', () => ({ useSprints: useSprintsMock }));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ singular: 'Sprint', lower: 'sprint', plural: 'Sprints' }),
}));
// The tab content is out of scope for the tablist keyboard test — stub the two
// heavy panels so the test isolates the tablist behavior (#2158).
vi.mock('./BurnChart', () => ({ BurnChart: () => <div data-testid="burn-chart" /> }));
vi.mock('@/features/decisions/DecisionsPanel', () => ({
  DecisionsPanel: () => <div data-testid="decisions-panel" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useProjectIdMock.mockReturnValue('p1');
  useSprintsMock.mockReturnValue({ sprints: [] });
});

describe('ReportsView tablist', () => {
  it('roving tabindex: only the selected tab is tabbable (rule 167, #2158)', () => {
    render(<ReportsView />);
    const metrics = screen.getByRole('tab', { name: 'Metrics' });
    const decisions = screen.getByRole('tab', { name: 'Decisions' });
    expect(metrics).toHaveAttribute('aria-selected', 'true');
    expect(metrics).toHaveAttribute('tabindex', '0');
    expect(decisions).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move focus across tabs WITHOUT activating them (rule 167, #2158)', () => {
    render(<ReportsView />);
    const metrics = screen.getByRole('tab', { name: 'Metrics' });
    const decisions = screen.getByRole('tab', { name: 'Decisions' });
    metrics.focus();
    // ArrowRight moves DOM focus to the Decisions tab — previously it was out of
    // the tab order and the Decisions report was keyboard-unreachable (WCAG 2.1.1).
    fireEvent.keyDown(metrics, { key: 'ArrowRight' });
    expect(decisions).toHaveFocus();
    // ...but focus movement alone must NOT switch the panel — Metrics stays selected.
    expect(metrics).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('burn-chart')).toBeInTheDocument();
    // Activation (click / Enter / Space via the native button) switches the tab.
    fireEvent.click(decisions);
    expect(decisions).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('decisions-panel')).toBeInTheDocument();
  });

  it('Home/End move focus to the first/last tab (rule 167, #2158)', () => {
    render(<ReportsView />);
    const metrics = screen.getByRole('tab', { name: 'Metrics' });
    const decisions = screen.getByRole('tab', { name: 'Decisions' });
    metrics.focus();
    fireEvent.keyDown(metrics, { key: 'End' });
    expect(decisions).toHaveFocus();
    fireEvent.keyDown(decisions, { key: 'Home' });
    expect(metrics).toHaveFocus();
  });
});
