/**
 * The badge is placed by ONE permission and now has to speak for two (#2949, #3053).
 *
 * `hasEditRights` — the task-content gate — decides whether this badge stands where
 * the authoring apparatus would be. The Schedule also fronts a second, non-nested
 * permission for dependency edges, and the Resource Manager band fails the first
 * while passing the second. So one of the readers who lands on this badge is
 * actively holding a write capability, and the unqualified "change anything here"
 * denies it — which reads as "the link I just drew will not stick", the exact
 * broken-product conclusion the badge exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleViewOnlyBadge } from './ScheduleViewOnlyBadge';

describe('ScheduleViewOnlyBadge', () => {
  it('claims nothing is editable for a reader who holds no write at all', () => {
    render(<ScheduleViewOnlyBadge />);
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText(/change anything here/)).toBeInTheDocument();
  });

  it('names the one capability a partial-rights reader still holds', () => {
    render(<ScheduleViewOnlyBadge canLinkDependencies />);
    expect(screen.getByText('Links only')).toBeInTheDocument();
    expect(screen.getByText(/You can link tasks here/)).toBeInTheDocument();
    // The claim it must NOT make. This is the assertion that fails if the badge
    // is ever re-collapsed to a single string.
    expect(screen.queryByText(/change anything here/)).not.toBeInTheDocument();
  });

  it('keeps one testid across both variants — it is one status, not two', () => {
    const { rerender } = render(<ScheduleViewOnlyBadge />);
    expect(screen.getByTestId('schedule-view-only')).toBeInTheDocument();
    rerender(<ScheduleViewOnlyBadge canLinkDependencies />);
    expect(screen.getByTestId('schedule-view-only')).toBeInTheDocument();
  });

  it('stays a static element — no action is offered in either variant', () => {
    const { rerender } = render(<ScheduleViewOnlyBadge />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<ScheduleViewOnlyBadge canLinkDependencies />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
