/**
 * Containment legibility on the Schedule outline (#2956) — phase bands and
 * depth guides.
 *
 * The invariant worth pinning is not "a line appears". It is that the
 * container's own edge and its children's deepest guide land on the **same x**,
 * because that is what makes "inside that phase" a line you can follow rather
 * than two marks that happen to be near each other. A change to `WBS_INDENT`,
 * to the task cell's padding, or to either offset formula breaks the design
 * and nothing else would notice.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepthGuides, PhaseBandEdge } from './RowContainmentChrome';
import { WBS_INDENT } from './scheduleConstants';

const leftOf = (el: HTMLElement) => el.style.left;

describe('DepthGuides', () => {
  it('renders nothing at the root level — there is no ancestor to trace', () => {
    render(<DepthGuides level={1} />);
    expect(screen.queryByTestId('depth-guides')).not.toBeInTheDocument();
  });

  it('renders one rule per ancestor level', () => {
    const { container } = render(<DepthGuides level={4} />);
    expect(container.querySelectorAll('[data-depth]')).toHaveLength(3);
  });

  it('places each rule on its level indent origin, matching the cell padding', () => {
    const { container } = render(<DepthGuides level={3} />);
    const rules = Array.from(container.querySelectorAll<HTMLElement>('[data-depth]'));
    // The task cell uses paddingLeft: (level - 1) * WBS_INDENT + 8.
    expect(rules.map(leftOf)).toEqual([`8px`, `${WBS_INDENT + 8}px`]);
  });

  it('is hidden from assistive tech — aria-level already carries the depth', () => {
    render(<DepthGuides level={3} />);
    expect(screen.getByTestId('depth-guides')).toHaveAttribute('aria-hidden', 'true');
  });

  it('never intercepts pointer events (the #2782 class)', () => {
    const { container } = render(<DepthGuides level={3} />);
    expect(screen.getByTestId('depth-guides').className).toContain('pointer-events-none');
    for (const rule of container.querySelectorAll<HTMLElement>('[data-depth]')) {
      // Each rule is inside the pointer-events-none wrapper; assert the wrapper
      // is an ancestor rather than assuming inheritance.
      expect(screen.getByTestId('depth-guides').contains(rule)).toBe(true);
    }
  });
});

describe('PhaseBandEdge', () => {
  it('sits at the phase row own indent origin, not at the row far-left edge', () => {
    // Far-left is already spoken for twice over: `border-l-2 border-brand-primary`
    // is selection, and ModeGutter's 3px stripe is delivery mode.
    render(<PhaseBandEdge level={2} />);
    expect(leftOf(screen.getByTestId('phase-band-edge'))).toBe(`${WBS_INDENT + 8}px`);
  });

  it('is hidden from assistive tech', () => {
    render(<PhaseBandEdge level={1} />);
    expect(screen.getByTestId('phase-band-edge')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the edge and the guide are one line', () => {
  it.each([1, 2, 3, 5])(
    'a phase at level %i shares its x with its children deepest guide',
    (level) => {
      render(<PhaseBandEdge level={level} />);
      const edgeX = leftOf(screen.getByTestId('phase-band-edge'));

      const { container } = render(<DepthGuides level={level + 1} />);
      const childRules = Array.from(container.querySelectorAll<HTMLElement>('[data-depth]'));

      expect(childRules).not.toHaveLength(0);
      expect(leftOf(childRules[childRules.length - 1])).toBe(edgeX);
    },
  );
});
