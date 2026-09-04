import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleSeedingState, ScheduleSeedingOutlineRows } from './ScheduleSeedingState';

describe('ScheduleSeedingState', () => {
  it('announces the setting-up status for assistive tech', () => {
    render(<ScheduleSeedingState />);
    // A plain string `name` is a full-string match in Testing Library (unlike
    // Playwright's `getByRole`, where it is a substring and the e2e spec below
    // therefore pins `exact: true`).
    expect(
      screen.getByRole('status', { name: 'Setting up your schedule' }),
    ).toBeInTheDocument();
  });

  it('names the cause and the resolution, not just the wait', () => {
    render(<ScheduleSeedingState />);
    expect(screen.getByText('Setting up your schedule…')).toBeInTheDocument();
    expect(screen.getByText(/Writing rows from your template/)).toBeInTheDocument();
  });

  it('carries none of the empty-state vocabulary it stands in for', () => {
    render(<ScheduleSeedingState />);
    const body = document.body.textContent ?? '';
    // A copy guard, not the regression guard. What actually withholds the
    // invitation is the SWAP in `TaskListPanel` / `MobileSchedule` — pinned in
    // those files' own suites. This only stops the skeleton from reintroducing
    // the vocabulary those swaps exist to suppress.
    expect(body).not.toMatch(/Type your first item/);
    expect(body).not.toMatch(/No items yet/);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides every skeleton bar from the accessibility tree', () => {
    const { container } = render(<ScheduleSeedingState />);
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBe(6);
    // A screen reader hears the sentence, not six unnamed boxes.
    for (const bar of bars) expect(bar.textContent).toBe('');
  });

  it('animates only under motion-safe', () => {
    const { container } = render(<ScheduleSeedingState />);
    for (const bar of container.querySelectorAll('[aria-hidden="true"]')) {
      expect(bar.className).toContain('motion-safe:animate-pulse');
      // The pulse is decorative; an unconditional `animate-pulse` would run
      // under `prefers-reduced-motion`.
      expect(bar.className).not.toMatch(/(?<!motion-safe:)animate-pulse/);
    }
  });
});

describe('ScheduleSeedingOutlineRows', () => {
  it('is silent — the canvas state owns the only live region', () => {
    const { container } = render(<ScheduleSeedingOutlineRows rowHeight={28} />);
    // Two `role="status"` regions announcing the same wait is a double
    // announcement; this half is `aria-hidden` in full.
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('declares no grid roles of its own', () => {
    const { container } = render(<ScheduleSeedingOutlineRows rowHeight={28} />);
    // A `role="row"` stand-in would make the treegrid lie about how many rows it
    // has, and a row with no `aria-level` is an invalid tree node besides. The
    // consequence for `aria-rowcount` is asserted where the treegrid actually
    // exists — `TaskListPanel.test.tsx`; in isolation this is only the premise.
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);
    expect(container.querySelectorAll('[role="gridcell"]').length).toBe(0);
  });

  it('lines its stand-ins up with real rows', () => {
    const { container } = render(<ScheduleSeedingOutlineRows rowHeight={44} leftReserve={20} />);
    const rows = container.firstElementChild?.children ?? [];
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect((row as HTMLElement).style.height).toBe('44px');
      // Grip + structural-nudge lane, so the stand-ins do not shift left of
      // where the real rows will land.
      expect((row.firstElementChild as HTMLElement).style.width).toBe('20px');
    }
  });

  it('reserves nothing when the outline reserves nothing', () => {
    const { container } = render(<ScheduleSeedingOutlineRows rowHeight={28} />);
    const firstRow = container.firstElementChild?.firstElementChild;
    expect(firstRow?.children.length).toBe(1);
  });
});
