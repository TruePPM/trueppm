import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Risk } from '@/api/types';
import { RiskMatrix } from './RiskMatrix';

const BASE_RISK: Risk = {
  id: 'risk-001',
  short_id: '1',
  short_id_display: 'R-007',
  qualified_id: 'PLAT-R-007',
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

describe('RiskMatrix', () => {
  it('renders the 5×5 grid of cells', () => {
    render(<RiskMatrix risks={[]} />);
    expect(screen.getByRole('grid', { name: 'Risk matrix' })).toBeInTheDocument();
    // 25 cells (probability 1–5 × impact 1–5), each a button.
    expect(screen.getAllByRole('button')).toHaveLength(25);
  });

  it('shows a populated cell with its risk count and score in the accessible name', () => {
    render(<RiskMatrix risks={[BASE_RISK]} />);
    // The P5 × I5 cell holds one risk; score is probability × impact = 25.
    const cell = screen.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    expect(cell).toBeInTheDocument();
    // The compact badge label drops the "R-" prefix from short_id_display.
    expect(cell).toHaveTextContent('007');
  });

  it('applies the severity zone token class to a cell', () => {
    render(<RiskMatrix risks={[BASE_RISK]} />);
    // P5 × I5 = severity 25 → critical zone token (rule 88, no hex literals).
    const cell = screen.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    expect(cell).toHaveClass('bg-risk-zone-critical');
    // A low-severity cell (P1 × I1 = 1) uses the minimal zone token.
    const minimalCell = screen.getByRole('button', { name: 'P1 × I1 = 1, 0 risks' });
    expect(minimalCell).toHaveClass('bg-risk-zone-minimal');
  });
});

describe('RiskMatrix unmitigated callout (issue 1230)', () => {
  it('shows "N unmitigated need action" for OPEN/MITIGATING risks', () => {
    render(
      <RiskMatrix
        risks={[
          { ...BASE_RISK, id: 'a', status: 'OPEN' },
          { ...BASE_RISK, id: 'b', status: 'MITIGATING' },
          { ...BASE_RISK, id: 'c', status: 'RESOLVED' },
        ]}
      />,
    );
    expect(screen.getByText('2 unmitigated need action')).toBeInTheDocument();
  });

  it('suppresses the callout when every risk is handled', () => {
    render(
      <RiskMatrix
        risks={[
          { ...BASE_RISK, id: 'a', status: 'RESOLVED' },
          { ...BASE_RISK, id: 'b', status: 'ACCEPTED' },
        ]}
      />,
    );
    expect(screen.queryByText(/unmitigated need action/)).not.toBeInTheDocument();
  });
});
