import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextStrip } from './NextStrip';
import type { Task } from '@/types';

function t(id: string, wbs: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    wbs,
    isSummary: false,
    isMilestone: false,
    isUntouchedSeed: false,
    assignees: [],
    ...extra,
  } as Task;
}

describe('NextStrip (#2731, ADR-0799 §4)', () => {
  it('renders nothing when there are no suggestions', () => {
    const { container } = render(<NextStrip tasks={[]} links={[]} />);
    expect(container.querySelector('[data-testid="next-strip"]')).toBeNull();
  });

  it('renders nothing once every seeded row has been touched', () => {
    const tasks = [t('l1', '1.1', { isUntouchedSeed: false })];
    const { container } = render(<NextStrip tasks={tasks} links={[]} />);
    expect(container.querySelector('[data-testid="next-strip"]')).toBeNull();
  });

  it('shows a chip for each non-zero suggestion, in stable order', () => {
    const tasks = [
      t('l1', '1.1', { isUntouchedSeed: true, assignees: [] }),
      t('m1', '2', { isMilestone: true, isUntouchedSeed: true }),
    ];
    render(<NextStrip tasks={tasks} links={[]} />);
    expect(screen.getByTestId('next-strip')).toBeInTheDocument();
    const unowned = screen.getByTestId('next-strip-chip-unowned');
    const gates = screen.getByTestId('next-strip-chip-unconfirmedGates');
    expect(unowned).toHaveTextContent('1 task has no owner yet');
    expect(gates).toHaveTextContent("1 milestone hasn't been confirmed");
    // unowned precedes unconfirmedGates in the DOM (fixed order).
    expect(
      unowned.compareDocumentPosition(gates) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('carries a role="status" live region summarizing the count', () => {
    const tasks = [t('l1', '1.1', { isUntouchedSeed: true, assignees: [] })];
    render(<NextStrip tasks={tasks} links={[]} />);
    const live = screen.getByTestId('next-strip-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveTextContent('1 thing worth a look, none required');
  });

  it('states the strip is not required', () => {
    const tasks = [t('l1', '1.1', { isUntouchedSeed: true, assignees: [] })];
    render(<NextStrip tasks={tasks} links={[]} />);
    expect(screen.getByText(/not required/)).toBeInTheDocument();
  });
});
