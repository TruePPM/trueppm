/**
 * Unit tests for ResourceCell overallocation drawer wiring.
 *
 * Renders the actual component (JSDOM) and exercises the a11y branch (rule 89):
 * overallocated + onOpenDrawer → accessible <button> that opens the drawer on
 * click or keyboard (Enter/Space); everything else → a focusable <div> with no
 * drawer wiring. The load%, band, and overallocated verdict are server-owned
 * (#989), so entries are constructed with those fields set directly rather than
 * re-derived from raw hours + capacity.
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ResourceCell } from './ResourceCell';
import type { UtilizationDayEntry } from './resourceUtils';

const baseEntry: UtilizationDayEntry = {
  hours: 9,
  tasks: ['task-1', 'task-2'],
  load_pct: 112.5,
  load_band: 'critical',
  overallocated: true,
};

const defaultProps = {
  iso: '2026-07-06',
  hoursPerDay: 8,
  maxUnits: 1,
  tooltipId: 'tooltip-1',
  resourceId: 'res-1',
  resourceName: 'Ada Lovelace',
};

describe('ResourceCell — overallocated + onOpenDrawer', () => {
  it('renders an accessible button', () => {
    render(<ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /113% load on 2026-07-06 — overallocated/i })
    ).toBeInTheDocument();
  });

  it('calls onOpenDrawer with the target on click', async () => {
    const onOpenDrawer = vi.fn();
    render(<ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={onOpenDrawer} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDrawer).toHaveBeenCalledWith({
      resourceId: 'res-1',
      resourceName: 'Ada Lovelace',
      iso: '2026-07-06',
      entry: baseEntry,
      hoursPerDay: 8,
      maxUnits: 1,
    });
  });

  it('calls onOpenDrawer on Enter keypress', async () => {
    const onOpenDrawer = vi.fn();
    render(<ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={onOpenDrawer} />);
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenDrawer on Space keypress', async () => {
    const onOpenDrawer = vi.fn();
    render(<ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={onOpenDrawer} />);
    screen.getByRole('button').focus();
    await userEvent.keyboard(' ');
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceCell — non-overallocated', () => {
  // A loaded, non-overallocated cell is still a focusable role="button" DIV (it
  // toggles the hover tooltip via keyboard, WCAG 2.1.1) — the branch under test
  // is whether the DOM node is a native <button> wired to onOpenDrawer, not
  // whether an accessibility role is present. Assert on tagName, not role.
  it('renders a div, not a native button, even with onOpenDrawer wired', () => {
    const entry: UtilizationDayEntry = { ...baseEntry, load_pct: 60, load_band: 'on-track', overallocated: false };
    const { container } = render(
      <ResourceCell {...defaultProps} entry={entry} onOpenDrawer={vi.fn()} />
    );
    expect(container.querySelector('button')).not.toBeInTheDocument();
    expect(screen.getByRole('button').tagName).toBe('DIV');
  });

  it('does not call onOpenDrawer when clicked', async () => {
    const onOpenDrawer = vi.fn();
    const entry: UtilizationDayEntry = { ...baseEntry, load_pct: 60, load_band: 'on-track', overallocated: false };
    render(<ResourceCell {...defaultProps} entry={entry} onOpenDrawer={onOpenDrawer} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });
});

describe('ResourceCell — overallocated but no onOpenDrawer wired', () => {
  it('falls back to a div, not a native button, when onOpenDrawer is missing', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={baseEntry} />);
    expect(container.querySelector('button')).not.toBeInTheDocument();
    expect(screen.getByRole('button').tagName).toBe('DIV');
  });

  it('does not throw when clicked without a drawer handler', async () => {
    render(<ResourceCell {...defaultProps} entry={baseEntry} />);
    await expect(userEvent.click(screen.getByRole('button'))).resolves.not.toThrow();
  });
});

describe('ResourceCell — no entry for the day', () => {
  it('renders without a load bar or overallocation button', () => {
    render(<ResourceCell {...defaultProps} entry={undefined} onOpenDrawer={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
