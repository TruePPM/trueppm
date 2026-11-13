import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiSprint } from '@/types';
import { CompactBurnChart } from './CompactBurnChart';

function sprint(overrides: Partial<ApiSprint>): ApiSprint {
  return { id: 'sp-1', state: 'PLANNED', ...overrides } as ApiSprint;
}

function renderCompact(s: ApiSprint, sprintHasNoRealData: boolean) {
  return render(
    <CompactBurnChart
      sprint={s}
      metric="points"
      points={null}
      isLoading={false}
      isError={false}
      sprintHasNoRealData={sprintHasNoRealData}
      iterationLabel="Sprint 1"
    />,
  );
}

describe('CompactBurnChart caption', () => {
  it('says the commitment is unset instead of "0 pts committed" (#4964)', () => {
    renderCompact(sprint({ committed_points: null }), true);
    expect(screen.getByText(/no commitment set/)).toBeInTheDocument();
    expect(screen.queryByText(/0 pts/)).not.toBeInTheDocument();
  });

  it('keeps the committed caption when a commitment exists', () => {
    renderCompact(sprint({ committed_points: 12 }), true);
    expect(screen.getByText(/12 pts/)).toBeInTheDocument();
  });

  it('shows the remaining count without "of N" for an active uncommitted sprint', () => {
    renderCompact(sprint({ committed_points: null, state: 'ACTIVE' }), false);
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });
});
