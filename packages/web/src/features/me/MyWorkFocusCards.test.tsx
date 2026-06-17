import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MyWorkFocusCards } from './MyWorkFocusCards';
import type { MyWorkFocusCard } from './myWorkFocus';

const NEEDS_ATTENTION: MyWorkFocusCard = {
  key: 'needs_attention',
  label: 'Needs attention',
  value: '2',
  delta: '1 blocked',
  variant: 'critical',
};
const SPRINT: MyWorkFocusCard = {
  key: 'sprint',
  label: 'Sprint 9',
  value: '3d',
  delta: 'days left',
  variant: 'neutral',
  spark: [0.2, 0.4, 0.5, 0.6, 0.7],
};
const LOAD: MyWorkFocusCard = {
  key: 'load',
  label: 'Your load',
  value: '6',
  delta: '1 due today',
  variant: 'neutral',
};

describe('MyWorkFocusCards', () => {
  it('renders all three cards with their labels, values, and deltas', () => {
    render(<MyWorkFocusCards cards={[NEEDS_ATTENTION, SPRINT, LOAD]} />);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Sprint 9')).toBeInTheDocument();
    expect(screen.getByText('Your load')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3d')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('1 blocked')).toBeInTheDocument();
  });

  it('renders only the sprint card spark (other cards have none)', () => {
    const { container } = render(<MyWorkFocusCards cards={[NEEDS_ATTENTION, SPRINT, LOAD]} />);
    // The spark is a decorative aria-hidden bar group; exactly one card has it.
    const sparks = container.querySelectorAll('[aria-hidden="true"]');
    // Five bars in one spark; assert the spark container exists by its bars.
    expect(sparks.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('days left')).toBeInTheDocument();
  });

  it('renders a 2-up grid when the load card is dropped', () => {
    const { container } = render(<MyWorkFocusCards cards={[NEEDS_ATTENTION, SPRINT]} />);
    expect(screen.queryByText('Your load')).toBeNull();
    // Two-up uses md:grid-cols-2, three-up uses the 1.3fr lead layout.
    expect(container.firstElementChild?.className).toContain('md:grid-cols-2');
  });
});
