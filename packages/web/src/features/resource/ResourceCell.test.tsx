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
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('is not focusable and carries no load description', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={undefined} />);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.tagName).toBe('DIV');
    expect(cell).not.toHaveAttribute('tabindex');
    expect(cell).not.toHaveAttribute('aria-label');
    expect(cell).not.toHaveAttribute('aria-describedby');
  });

  it('renders no load bar', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={undefined} />);
    expect(container.querySelector('div[style]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Load bar geometry and weekend dimming
// ---------------------------------------------------------------------------

const loadedEntry: UtilizationDayEntry = {
  hours: 4.8,
  tasks: ['task-1'],
  load_pct: 60,
  load_band: 'on-track',
  overallocated: false,
};

const emptyEntry: UtilizationDayEntry = {
  hours: 0,
  tasks: [],
  load_pct: 0,
  load_band: 'on-track',
  overallocated: false,
};

function bar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('div[style]');
}

describe('ResourceCell — load bar', () => {
  it('scales the bar proportionally below the 120% cap', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    // 60 / 120 * 24 = 12px
    expect(bar(container)?.style.height).toBe('12px');
  });

  it('caps the bar at the 120% ceiling for extreme overload', () => {
    const entry: UtilizationDayEntry = { ...baseEntry, load_pct: 300, hours: 24 };
    const { container } = render(<ResourceCell {...defaultProps} entry={entry} />);
    expect(bar(container)?.style.height).toBe('24px');
  });

  it('renders no bar when the day has an entry but zero hours', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={emptyEntry} />);
    expect(bar(container)).toBeNull();
  });

  it('colors the bar from the server-owned load band', () => {
    const atRisk: UtilizationDayEntry = { ...loadedEntry, load_pct: 92, load_band: 'at-risk' };
    const { container } = render(<ResourceCell {...defaultProps} entry={atRisk} />);
    expect(bar(container)?.className).toContain('bg-semantic-at-risk');
  });

  it('labels the bar with the rounded load percentage when not overallocated', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    expect(bar(container)).toHaveAttribute('aria-label', '60% load on 2026-07-06');
  });

  it('leaves the bar unlabeled when the cell button already announces the load', () => {
    const { container } = render(
      <ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={vi.fn()} />,
    );
    expect(bar(container)).not.toHaveAttribute('aria-label');
  });
});

describe('ResourceCell — weekend dimming', () => {
  it('dims a Saturday cell', () => {
    const { container } = render(
      <ResourceCell {...defaultProps} iso="2026-07-04" entry={loadedEntry} />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('opacity-50');
  });

  it('dims a Sunday cell', () => {
    const { container } = render(
      <ResourceCell {...defaultProps} iso="2026-07-05" entry={loadedEntry} />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('opacity-50');
  });

  it('does not dim a weekday cell', () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain('opacity-50');
  });
});

// ---------------------------------------------------------------------------
// Hover / focus / keyboard tooltip (WCAG 2.1.1)
// ---------------------------------------------------------------------------

describe('ResourceCell — load tooltip', () => {
  it('exposes a loaded cell as a focusable button described by the tooltip id', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    const cell = screen.getByRole('button', { name: '60% load on 2026-07-06' });
    expect(cell).toHaveAttribute('tabindex', '0');
    expect(cell).toHaveAttribute('aria-describedby', 'tooltip-1');
  });

  it('shows the tooltip on hover and hides it on unhover', async () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    const cell = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await userEvent.hover(cell);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('2026-07-06');
    expect(tip).toHaveTextContent('4.8 h / 8.0 h (60%)');
    expect(tip).toHaveTextContent('task-1');

    await userEvent.unhover(cell);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows the tooltip on keyboard focus and hides it on blur', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    const cell = screen.getByRole('button');
    fireEvent.focus(cell);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(cell);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('toggles the tooltip with Enter', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    const cell = screen.getByRole('button');
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('toggles the tooltip with Space', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    const cell = screen.getByRole('button');
    fireEvent.keyDown(cell, { key: ' ' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(cell, { key: ' ' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('ignores unrelated keys', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'a' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes the tooltip on Escape', () => {
    render(<ResourceCell {...defaultProps} entry={loadedEntry} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not open a tooltip for an unloaded cell', async () => {
    const { container } = render(<ResourceCell {...defaultProps} entry={emptyEntry} />);
    const cell = container.firstElementChild as HTMLElement;
    await userEvent.hover(cell);
    fireEvent.focus(cell);
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not open a tooltip on an overallocated cell — the drawer is the affordance', async () => {
    render(<ResourceCell {...defaultProps} entry={baseEntry} onOpenDrawer={vi.fn()} />);
    await userEvent.hover(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('still offers the hover tooltip when the cell is overallocated but no drawer is wired', async () => {
    render(<ResourceCell {...defaultProps} entry={baseEntry} />);
    await userEvent.hover(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('9.0 h / 8.0 h (113%)');
  });
});
