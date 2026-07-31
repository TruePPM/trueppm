import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import { HeaderEstimateChip } from './HeaderEstimateChip';

// Mutable project stub so each test picks the methodology / scale it needs.
let project: { effective_methodology: string; effective_estimation_scale: string } | undefined;
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: project }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    readiness: 'estimated',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  };
}

describe('HeaderEstimateChip (#2315 slice 3)', () => {
  beforeEach(() => {
    project = { effective_methodology: 'AGILE', effective_estimation_scale: 'fibonacci' };
  });

  it('labels a points estimate as "{pts} pts · {Readiness}"', () => {
    render(<HeaderEstimateChip task={makeTask({ storyPoints: 5, readiness: 'estimated' })} projectId="p1" />);
    expect(screen.getByText('5 pts')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toBeInTheDocument();
  });

  it('renders a T-shirt size without the " pts" unit', () => {
    project = { effective_methodology: 'AGILE', effective_estimation_scale: 'tshirt' };
    render(<HeaderEstimateChip task={makeTask({ storyPoints: 3, readiness: 'ready' })} projectId="p1" />);
    // 3 → "M" on the T-shirt scale; no " pts" suffix.
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
  });

  it('shows amber "Unestimated" for a points-based leaf with no estimate', () => {
    render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'idea' })} projectId="p1" />);
    expect(screen.getByText('Unestimated')).toBeInTheDocument();
  });

  it('never scolds a Waterfall task as Unestimated — falls back to the readiness chip', () => {
    project = { effective_methodology: 'WATERFALL', effective_estimation_scale: 'fibonacci' };
    render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'estimated' })} projectId="p1" />);
    expect(screen.queryByText('Unestimated')).not.toBeInTheDocument();
    expect(screen.getByText('estimated')).toBeInTheDocument(); // ReadinessChip's lowercase word
  });

  it('never marks a summary/rollup as Unestimated', () => {
    render(
      <HeaderEstimateChip
        task={makeTask({ storyPoints: null, isSummary: true, readiness: 'estimated' })}
        projectId="p1"
      />,
    );
    expect(screen.queryByText('Unestimated')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no estimate, no readiness, and points are not used', () => {
    project = { effective_methodology: 'WATERFALL', effective_estimation_scale: 'fibonacci' };
    const { container } = render(
      <HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: undefined })} projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // #2662 — the chip's explanation was previously carried only in `aria-label`,
  // invisible to sighted mouse/touch users. Both branches now surface it via the
  // shared `Tooltip` on hover, keyboard focus, and tap (web-rule 287).
  describe('tooltip (#2662)', () => {
    it('explains the amber "Unestimated" chip on hover, resolving the two-channel confusion', async () => {
      const user = userEvent.setup();
      render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'idea' })} projectId="p1" />);

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      await user.hover(screen.getByText('Unestimated'));
      const panel = await screen.findByText(/points size the work for velocity and burndown/, {
        selector: 'div',
      });
      // `describe={false}` — the tooltip sentence restates the trigger's own
      // `aria-label`, so the panel is `aria-hidden` and AT hears it once, from
      // the label, not twice (rule 287(c) corollary / the WF precedent).
      expect(panel).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByText('Unestimated')).not.toHaveAttribute('aria-describedby');
    });

    it('opens the "Unestimated" tooltip on keyboard focus', async () => {
      const user = userEvent.setup();
      render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'idea' })} projectId="p1" />);

      await user.tab();
      expect(screen.getByText('Unestimated')).toHaveFocus();
      // An `aria-hidden` panel is out of the accessibility tree, so query it via
      // the DOM directly rather than `getByRole('tooltip')` (rule 287(c)).
      expect(
        await screen.findByText(/points size the work for velocity and burndown/, { selector: 'div' }),
      ).toBeInTheDocument();
    });

    it('explains a pointed chip on hover, naming both the point value and the readiness word', async () => {
      const user = userEvent.setup();
      render(
        <HeaderEstimateChip
          task={makeTask({ storyPoints: 5, readiness: 'estimated' })}
          projectId="p1"
        />,
      );

      await user.hover(screen.getByText('5 pts'));
      const panel = await screen.findByText(/on this project's estimation scale/, { selector: 'div' });
      expect(panel).toHaveTextContent('5 pts');
      expect(panel).toHaveTextContent('Estimated');
      expect(panel).toHaveAttribute('aria-hidden', 'true');
    });

    it('opens the pointed chip tooltip on keyboard focus', async () => {
      const user = userEvent.setup();
      render(<HeaderEstimateChip task={makeTask({ storyPoints: 5, readiness: 'ready' })} projectId="p1" />);

      await user.tab();
      // Focus lands on the outer chip span (the `Tooltip` trigger), which carries
      // the accessible name — not the inner "5 pts" text span.
      expect(screen.getByLabelText(/on this project's estimation scale/)).toHaveFocus();
      expect(
        await screen.findByText(/on this project's estimation scale/, { selector: 'div' }),
      ).toBeInTheDocument();
    });

    it('the pointed chip explanation omits the readiness clause when there is no readiness', async () => {
      const user = userEvent.setup();
      render(
        <HeaderEstimateChip task={makeTask({ storyPoints: 5, readiness: undefined })} projectId="p1" />,
      );

      await user.hover(screen.getByText('5 pts'));
      const panel = await screen.findByText(/on this project's estimation scale/, { selector: 'div' });
      expect(panel).not.toHaveTextContent(':');
    });
  });
});
