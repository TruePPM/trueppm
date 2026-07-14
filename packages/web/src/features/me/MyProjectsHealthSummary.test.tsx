import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { MyProjectsHealthSummary } from './MyProjectsHealthSummary';
import type { ProjectHealthRow } from '@/hooks/useProjectsHealthSummary';

const state = vi.hoisted(() => ({
  value: {
    data: undefined as ProjectHealthRow[] | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));
vi.mock('@/hooks/useProjectsHealthSummary', () => ({
  useProjectsHealthSummary: () => state.value,
}));

function renderCard() {
  return render(
    <MemoryRouter>
      <MyProjectsHealthSummary />
    </MemoryRouter>,
  );
}

function row(over: Partial<ProjectHealthRow> & Pick<ProjectHealthRow, 'id' | 'name' | 'healthBand'>): ProjectHealthRow {
  return { atRiskCount: 0, criticalCount: 0, ...over };
}

describe('MyProjectsHealthSummary', () => {
  beforeEach(() => {
    state.value = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
  });

  it('renders nothing with fewer than 2 projects (nothing to triage)', () => {
    state.value.data = [row({ id: 'p1', name: 'Solo', healthBand: 'critical', criticalCount: 2 })];
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows band tallies (project counts) and drills to the worst project', () => {
    state.value.data = [
      row({ id: 'p1', name: 'Apollo', healthBand: 'critical', criticalCount: 3, atRiskCount: 1 }),
      row({ id: 'p2', name: 'Gemini', healthBand: 'at_risk', atRiskCount: 2 }),
      row({ id: 'p3', name: 'Mercury', healthBand: 'on_track' }),
      row({ id: 'p4', name: 'Vostok', healthBand: 'on_track' }),
    ];
    renderCard();
    // Tallies: 1 critical, 1 at risk, 2 on track (project counts by band).
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('at risk')).toBeInTheDocument();
    expect(screen.getByText('on track')).toBeInTheDocument();
    // Worst = the critical project with the most critical tasks.
    const link = screen.getByRole('link', { name: /Apollo/ });
    expect(link).toHaveAttribute('href', '/projects/p1/overview');
    expect(screen.getByText('3 critical tasks')).toBeInTheDocument();
  });

  it('singularizes the worst-project reason', () => {
    state.value.data = [
      row({ id: 'p1', name: 'Apollo', healthBand: 'at_risk', atRiskCount: 1 }),
      row({ id: 'p2', name: 'Gemini', healthBand: 'on_track' }),
    ];
    renderCard();
    expect(screen.getByText('1 at-risk task')).toBeInTheDocument();
  });

  it('shows a calm "All on track" instead of a chip when nothing needs attention', () => {
    state.value.data = [
      row({ id: 'p1', name: 'Apollo', healthBand: 'on_track' }),
      row({ id: 'p2', name: 'Gemini', healthBand: 'on_track' }),
    ];
    renderCard();
    expect(screen.getByText('All on track')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an inline error with retry on fetch failure', () => {
    state.value.error = new Error('down');
    renderCard();
    expect(screen.getByText(/Couldn't load project health/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });
});
