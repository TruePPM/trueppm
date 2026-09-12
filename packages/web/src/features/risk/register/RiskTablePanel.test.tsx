/**
 * RiskTablePanel — right edge-fade affordance (web rule 290, #3618).
 *
 * The scroll container (`data-testid="risk-table-scroll"`) always starts at
 * the left origin (unlike StatusClusterScroller, which can be Tab-scrolled to
 * an arbitrary offset), so only the right edge is asserted here — see
 * useHasScrollRight.test.ts for the underlying hook's own exhaustive
 * fit/overflow/scroll-position coverage. This file covers the wiring: does
 * RiskTablePanel actually render the fade when the table overflows, keep it
 * pointer-transparent, and omit it when the table fits.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Risk } from '@/api/types';
import { RiskTablePanel } from './RiskTablePanel';

const FIXTURE_RISK: Risk = {
  id: 'risk-001',
  short_id: '1',
  short_id_display: 'R-001',
  qualified_id: 'PLAT-R-001',
  server_version: 1,
  project: 'p1',
  title: 'Critical infrastructure failure',
  description: 'Infra may fail',
  status: 'OPEN',
  probability: 5,
  impact: 5,
  severity: 25,
  owner: null,
  owner_name: null,
  owner_initials: null,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  tasks: [],
  category: 'TECHNICAL',
  response: 'MITIGATE',
  mitigation_due_date: null,
  trigger: '',
  contingency: '',
  notes: '',
};

let roCallback: (() => void) | null = null;

function baseProps() {
  return {
    risks: [FIXTURE_RISK],
    displayRisks: [FIXTURE_RISK],
    isLoading: false,
    error: null,
    canImport: false,
    onOpenImport: vi.fn(),
    onCreate: vi.fn(),
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    filterCounts: { all: 1, high: 1, unmitigated: 1, mine: 0 },
    filterEmptyCopy: {
      high: 'No high-severity risks.',
      unmitigated: 'No unmitigated risks.',
      mine: 'No risks assigned to you.',
    },
    selectedCell: null,
    onClearCell: vi.fn(),
    isFiltered: false,
    onClearAllFilters: vi.fn(),
    severitySort: 'none' as const,
    onSeveritySortChange: vi.fn(),
    newestSort: false,
    onNewestSortChange: vi.fn(),
    renderRow: (risk: Risk) => (
      <tr key={risk.id}>
        <td>{risk.short_id_display}</td>
      </tr>
    ),
  };
}

/** Sets the scroll container's geometry and fires the captured ResizeObserver. */
function setGeometry(m: { clientWidth: number; scrollWidth: number }) {
  const el = screen.getByTestId('risk-table-scroll');
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: m.clientWidth });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: m.scrollWidth });
  act(() => roCallback?.());
}

beforeEach(() => {
  roCallback = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RiskTablePanel — scroll edge-fade (rule 290)', () => {
  it('does not render the fade when the table fits its container', () => {
    render(<RiskTablePanel {...baseProps()} />);
    setGeometry({ clientWidth: 800, scrollWidth: 800 });
    expect(screen.queryByTestId('risk-table-scroll-fade-right')).not.toBeInTheDocument();
  });

  it('renders a pointer-transparent, decorative fade when the table overflows', () => {
    render(<RiskTablePanel {...baseProps()} />);
    setGeometry({ clientWidth: 800, scrollWidth: 1200 });

    const fade = screen.getByTestId('risk-table-scroll-fade-right');
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade.className).toContain('pointer-events-none');
  });

  it('hides the fade again once scrolled fully right', () => {
    render(<RiskTablePanel {...baseProps()} />);
    setGeometry({ clientWidth: 800, scrollWidth: 1200 });
    expect(screen.getByTestId('risk-table-scroll-fade-right')).toBeInTheDocument();

    const el = screen.getByTestId('risk-table-scroll');
    act(() => {
      Object.defineProperty(el, 'scrollLeft', { configurable: true, value: 400 });
      el.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByTestId('risk-table-scroll-fade-right')).not.toBeInTheDocument();
  });

  it('does not render the scroll container at all in the empty state', () => {
    render(<RiskTablePanel {...baseProps()} risks={[]} displayRisks={[]} />);
    expect(screen.queryByTestId('risk-table-scroll')).not.toBeInTheDocument();
  });
});
