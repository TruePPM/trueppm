import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { setActiveDateFormat } from '@/lib/formatUtcDate';
import { BeforeProjectStartDialog } from '@/features/schedule/BeforeProjectStartDialog';
import { BoardSprintSwitcher } from './BoardSprintSwitcher';
import type { ApiSprint } from '@/types';

// #4394: calendar dates in the board and schedule dialogs must follow the user's
// date_format preference and must not roll back a day west of UTC.

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ singular: 'Sprint', plural: 'Sprints', possessive: "Sprint's" }),
}));

const sprint = {
  id: 'sp-1',
  name: 'Sprint 24',
  start_date: '2026-03-04',
  finish_date: '2026-03-19',
  state: 'ACTIVE',
} as ApiSprint;

afterEach(() => {
  setActiveDateFormat('us');
});

describe('Board sprint switcher date range follows date_format', () => {
  it('renders month-first for us', () => {
    setActiveDateFormat('us');
    renderWithProviders(
      <BoardSprintSwitcher sprints={[sprint]} selectedSprintId="sp-1" onSelectSprint={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Mar 4 – Mar 19')).toBeInTheDocument();
  });

  it('renders day-first for eu', () => {
    setActiveDateFormat('eu');
    renderWithProviders(
      <BoardSprintSwitcher sprints={[sprint]} selectedSprintId="sp-1" onSelectSprint={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('4 Mar – 19 Mar')).toBeInTheDocument();
  });
});

describe('BeforeProjectStartDialog dates', () => {
  const props = {
    projectStartDate: '2026-03-19',
    effectiveFloorDate: '2026-03-19',
    attemptedStart: '2026-03-01',
    canMoveStart: true,
    error: null,
    isPending: false,
    onSnap: () => {},
    onMoveStart: () => {},
    onCancel: () => {},
  };

  it('renders the UTC calendar day, restyled by date_format (eu)', () => {
    setActiveDateFormat('eu');
    renderWithProviders(<BeforeProjectStartDialog {...props} />);
    expect(document.body.textContent).toContain('19 Mar 2026');
  });
});
