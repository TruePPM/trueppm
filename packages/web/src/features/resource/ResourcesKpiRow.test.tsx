/**
 * Unit tests for ResourcesKpiRow (#3477, #3478).
 *
 *  - #3477: zero real team members (headcount === 0, the canonical
 *    zero-denominator signal) must render Avg Utilization muted with the
 *    shared "No assignments yet" reason instead of a fabricated "0%".
 *  - #3478: `headcount` is an explicit prop, not read off `data.headcount` —
 *    the caller (HeatmapPage) is what keeps it in agreement with the page's
 *    empty state; this component just renders whatever it is given.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ResourcesKpiRow } from './ResourcesKpiRow';
import type { ResourceSummary } from '@/hooks/useResourceSummary';

function makeSummary(overrides: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    avg_utilization_pct: 82,
    over_allocated_count: 0,
    over_allocated_weeks: '',
    under_utilized_count: 0,
    under_utilized_names: [],
    headcount: 6,
    contractor_count: 0,
    ...overrides,
  };
}

describe('ResourcesKpiRow', () => {
  it('renders the real average utilization when the team is staffed', () => {
    render(<ResourcesKpiRow data={makeSummary({ avg_utilization_pct: 82 })} headcount={6} />);
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('vs. 80% target')).toBeInTheDocument();
    expect(screen.queryByText('No assignments yet')).not.toBeInTheDocument();
  });

  it('renders the headcount from the `headcount` prop, not `data.headcount` (#3478)', () => {
    render(<ResourcesKpiRow data={makeSummary({ headcount: 3 })} headcount={0} />);
    expect(screen.getByText('0 active')).toBeInTheDocument();
    expect(screen.queryByText('3 active')).not.toBeInTheDocument();
  });

  describe('zero-denominator "not computable" avg utilization (#3477)', () => {
    it('renders the shared muted reason instead of a fabricated 0%', () => {
      render(
        <ResourcesKpiRow data={makeSummary({ avg_utilization_pct: 0 })} headcount={0} />,
      );
      expect(screen.getByText('No assignments yet')).toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
      expect(screen.queryByText('vs. 80% target')).not.toBeInTheDocument();
    });

    it('gives the muted card a dashed border and a disabled-tone value (rule 119)', () => {
      render(
        <ResourcesKpiRow data={makeSummary({ avg_utilization_pct: 0 })} headcount={0} />,
      );
      const reason = screen.getByText('No assignments yet');
      const card = reason.closest('div');
      expect(card?.className).toContain('border-dashed');
      const value = screen.getByText('—');
      expect(value.className).toMatch(/text-neutral-text-disabled/);
    });

    it('renders a real 0% normally once the team has any members', () => {
      render(
        <ResourcesKpiRow data={makeSummary({ avg_utilization_pct: 0 })} headcount={1} />,
      );
      expect(screen.getByText('0%')).toBeInTheDocument();
      expect(screen.queryByText('No assignments yet')).not.toBeInTheDocument();
    });
  });

  it('uses readable-copy tokens for sub-lines, never the disabled token (rule 169, #3477)', () => {
    render(
      <ResourcesKpiRow
        data={makeSummary({ contractor_count: 2 })}
        headcount={6}
      />,
    );
    const sub = screen.getByText('+2 contractors');
    expect(sub.className).toMatch(/text-neutral-text-secondary/);
    expect(sub.className).not.toMatch(/text-neutral-text-disabled/);
  });
});
