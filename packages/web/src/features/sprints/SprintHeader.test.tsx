import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SprintHeader } from './SprintHeader';
import { makeSprint } from './sprintTestFixtures';
import type { ComponentProps } from 'react';

const noop = () => undefined;

/**
 * Render the header with sensible defaults. `canManageLifecycle` defaults to
 * true (a SCHEDULER+ view) so the pre-#2146 assertions about Plan/Close still
 * apply; the gating tests override it to false.
 */
function renderHeader(props: Partial<ComponentProps<typeof SprintHeader>> = {}) {
  return render(
    <SprintHeader
      sprint={makeSprint({ state: 'ACTIVE' })}
      sprintNumber={1}
      hasPlannedSprint={false}
      onPlanNext={noop}
      onCloseSprint={noop}
      onFilter={noop}
      canManageLifecycle
      {...props}
    />,
  );
}

describe('SprintHeader', () => {
  it('renders the H1 with sprint number and name', () => {
    renderHeader({ sprintNumber: 12 });
    expect(
      screen.getByRole('heading', { level: 1, name: /Sprint 12 — Telemetry & FAT prep/i }),
    ).toBeInTheDocument();
  });

  it('shows "Active" pill in semantic-on-track when sprint is active', () => {
    renderHeader();
    const pill = screen.getByLabelText(/Sprint state: Active/i);
    expect(pill.className).toMatch(/text-semantic-on-track/);
  });

  it('Close sprint is enabled only when sprint state is ACTIVE', () => {
    const { rerender } = renderHeader({
      sprint: makeSprint({ state: 'PLANNED' }),
      sprintNumber: 0,
    });
    expect(screen.getByRole('button', { name: /Close sprint/i })).toBeDisabled();

    rerender(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={1}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
        canManageLifecycle
      />,
    );
    expect(screen.getByRole('button', { name: /Close active sprint/i })).not.toBeDisabled();
  });

  it('Plan next sprint is disabled when a planned sprint already exists', () => {
    renderHeader({ hasPlannedSprint: true });
    expect(
      screen.getByRole('button', { name: /Plan next sprint \(a planned sprint already exists\)/i }),
    ).toBeDisabled();
  });

  // Rule 122: disabled controls use the explicit neutral recipe, never
  // disabled:opacity-50 (a faded-red "Close sprint" still reads as a clickable
  // destructive action) — issue #1026.
  it('disabled buttons use the explicit disabled recipe, not opacity-50', () => {
    renderHeader({ sprint: makeSprint({ state: 'PLANNED' }), sprintNumber: 0, hasPlannedSprint: true });
    const close = screen.getByRole('button', { name: /Close sprint/i });
    expect(close.className).toContain('disabled:bg-neutral-surface-sunken');
    expect(close.className).not.toContain('disabled:opacity-50');

    const plan = screen.getByRole('button', {
      name: /Plan next sprint \(a planned sprint already exists\)/i,
    });
    expect(plan.className).toContain('disabled:bg-neutral-surface-sunken');
    expect(plan.className).not.toContain('disabled:opacity-50');
  });

  it('fires onCloseSprint when the active Close button is clicked', async () => {
    const onClose = vi.fn();
    renderHeader({ onCloseSprint: onClose });
    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders "No sprint yet" placeholder when sprint is null', () => {
    renderHeader({ sprint: null, sprintNumber: 0 });
    expect(
      screen.getByRole('heading', { level: 1, name: /No sprint yet/i }),
    ).toBeInTheDocument();
  });

  // #2146 — lifecycle write controls are SCHEDULER+; a Viewer/Member below that
  // sees no Plan/Close chrome at all (consistent with the gated empty-state CTA),
  // but Filter stays available to every role.
  it('hides Plan next and Close sprint when canManageLifecycle is false', () => {
    renderHeader({ canManageLifecycle: false });
    expect(screen.queryByRole('button', { name: /Plan next sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close active sprint/i })).not.toBeInTheDocument();
    // Filter is available to viewers.
    expect(screen.getByRole('button', { name: /^Filter$/i })).toBeInTheDocument();
  });

  it('shows Plan next and Close sprint when canManageLifecycle is true', () => {
    renderHeader({ canManageLifecycle: true });
    expect(screen.getByRole('button', { name: /Plan next sprint/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close active sprint/i })).toBeInTheDocument();
  });
});
