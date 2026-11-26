import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleFeasibility } from '@/api/types';
import { isScheduleFeasibility } from '@/hooks/useScheduleFeasibility';
import { ScheduleFeasibilityBanner, describeLoop } from './ScheduleFeasibilityBanner';

let data: ScheduleFeasibility | null | undefined;
vi.mock('@/hooks/useScheduleFeasibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useScheduleFeasibility')>();
  return { ...actual, useScheduleFeasibility: () => ({ data }) };
});

const t = (n: string) => ({ id: `id-${n}`, name: n });
const LOOP: ScheduleFeasibility = {
  project_id: 'p1',
  computable: false,
  code: 'cyclic_dependency',
  cycle: [t('Design'), t('Build'), t('Test')],
  tasks: [],
  detail: null,
  definition: 'Server sentence about loops.',
  as_of: '2026-11-26T10:00:00Z',
};

describe('describeLoop', () => {
  it('returns to the first task so the path reads as a loop', () => {
    expect(describeLoop(LOOP.cycle)).toBe('Design → Build → Test → Design');
  });
  it('elides a long loop after four names and counts the rest', () => {
    const long = ['A', 'B', 'C', 'D', 'E', 'F'].map(t);
    expect(describeLoop(long)).toBe('A → B → C → D → … (2 more) → A');
  });
  it('is empty for no loop', () => {
    expect(describeLoop([])).toBe('');
  });
});

describe('ScheduleFeasibilityBanner', () => {
  beforeEach(() => {
    data = undefined;
  });

  it('names the loop and renders the server definition verbatim', () => {
    data = LOOP;
    render(<ScheduleFeasibilityBanner projectId="p1" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Schedule couldn't be computed");
    expect(screen.getByTestId('schedule-feasibility-loop')).toHaveTextContent(
      'Design → Build → Test → Design',
    );
    expect(screen.getByText('Server sentence about loops.')).toBeInTheDocument();
  });

  it('shows the scheduler detail for a non-loop refusal', () => {
    data = { ...LOOP, code: 'invalid_input', cycle: [], detail: 'Bad SS link.' };
    render(<ScheduleFeasibilityBanner projectId="p1" />);
    expect(screen.getByText('Bad SS link.')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-feasibility-loop')).not.toBeInTheDocument();
  });

  it.each([
    ['loading', undefined],
    ['no verdict', null],
    ['computable', { ...LOOP, computable: true, code: null, cycle: [], definition: null }],
  ])('renders nothing while %s', (_label, value) => {
    data = value as ScheduleFeasibility | null | undefined;
    const { container } = render(<ScheduleFeasibilityBanner projectId="p1" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('isScheduleFeasibility', () => {
  it('rejects the catch-all list shape so it never reads as a refusal', () => {
    expect(isScheduleFeasibility({ count: 0, next: null, previous: null, results: [] })).toBe(
      false,
    );
    expect(isScheduleFeasibility(LOOP)).toBe(true);
  });
});
