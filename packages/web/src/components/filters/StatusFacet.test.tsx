import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusFacet } from './StatusFacet';
import type { TaskStatus } from '@/types';

const COUNTS: Record<TaskStatus, number> = {
  BACKLOG: 41,
  NOT_STARTED: 12,
  IN_PROGRESS: 96,
  REVIEW: 22,
  ON_HOLD: 0,
  COMPLETE: 51,
};

function setup(overrides: Partial<ComponentProps<typeof StatusFacet>> = {}) {
  const onChange = vi.fn();
  render(<StatusFacet counts={COUNTS} selected={[]} onChange={onChange} {...overrides} />);
  return { onChange };
}

describe('StatusFacet trigger', () => {
  it('reads "Status: any" with nothing selected', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Status: any' })).toBeInTheDocument();
  });

  it('names one selection and collapses several', () => {
    setup({ selected: ['IN_PROGRESS', 'ON_HOLD'] });
    expect(screen.getByRole('button', { name: /Status: In progress \+1/ })).toBeInTheDocument();
  });
});

describe('StatusFacet panel', () => {
  it('lists every status in fixed pipeline order regardless of count', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Status: any' }));
    const names = screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent ?? '');
    expect(names).toHaveLength(6);
    expect(names[0]).toContain('Backlog');
    expect(names[1]).toContain('Not started');
    expect(names[2]).toContain('In progress');
    expect(names[3]).toContain('Review');
    expect(names[4]).toContain('On hold');
    expect(names[5]).toContain('Done');
  });

  it('keeps a zero-count status visible and selectable', async () => {
    // Picking it lands on the zero-result state, which is a legitimate way to
    // confirm nothing is on hold. Hiding it would read as a bug.
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Status: any' }));
    const onHold = screen.getByRole('menuitemcheckbox', { name: /On hold/ });
    expect(onHold).toHaveTextContent('0');
    expect(onHold).not.toBeDisabled();
    await userEvent.click(onHold);
    expect(onChange).toHaveBeenCalledWith(['ON_HOLD']);
  });

  it('never re-sorts by count when a status is selected', async () => {
    setup({ selected: ['COMPLETE'] });
    await userEvent.click(screen.getByRole('button', { name: /Status: Done/ }));
    const names = screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent ?? '');
    expect(names[0]).toContain('Backlog');
    expect(names[5]).toContain('Done');
  });

  it('has no search field — six options never need one', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Status: any' }));
    expect(screen.queryByLabelText('Filter options')).not.toBeInTheDocument();
  });

  it('states the order rule in the footer', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Status: any' }));
    expect(screen.getByText('Fixed pipeline order · zero counts kept')).toBeInTheDocument();
  });

  it('deselects an already-selected status', async () => {
    const { onChange } = setup({ selected: ['IN_PROGRESS', 'REVIEW'] });
    await userEvent.click(screen.getByRole('button', { name: /Status: In progress/ }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /In progress/ }));
    expect(onChange).toHaveBeenCalledWith(['REVIEW']);
  });

  it('Clear statuses drops every selection', async () => {
    const { onChange } = setup({ selected: ['IN_PROGRESS'] });
    await userEvent.click(screen.getByRole('button', { name: /Status: In progress/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear statuses' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('renders the status name beside its dot — color is never the only cue', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Status: any' }));
    for (const name of ['Backlog', 'Not started', 'In progress', 'Review', 'On hold', 'Done']) {
      expect(screen.getByRole('menuitemcheckbox', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });
});
