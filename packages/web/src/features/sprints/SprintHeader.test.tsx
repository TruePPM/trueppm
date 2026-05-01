import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SprintHeader } from './SprintHeader';
import { makeSprint } from './sprintTestFixtures';

const noop = () => undefined;

describe('SprintHeader', () => {
  it('renders the H1 with sprint number and name', () => {
    render(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={12}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: /Sprint 12 — Telemetry & FAT prep/i }),
    ).toBeInTheDocument();
  });

  it('shows "Active" pill in semantic-on-track when sprint is active', () => {
    render(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={1}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    const pill = screen.getByLabelText(/Sprint state: Active/i);
    expect(pill.className).toMatch(/text-semantic-on-track/);
  });

  it('Close sprint is enabled only when sprint state is ACTIVE', () => {
    const { rerender } = render(
      <SprintHeader
        sprint={makeSprint({ state: 'PLANNED' })}
        sprintNumber={0}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /Close sprint/i })).toBeDisabled();

    rerender(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={1}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /Close active sprint/i })).not.toBeDisabled();
  });

  it('Plan next sprint is disabled when a planned sprint already exists', () => {
    render(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={1}
        hasPlannedSprint={true}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /Plan next sprint \(a planned sprint already exists\)/i }),
    ).toBeDisabled();
  });

  it('fires onCloseSprint when the active Close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <SprintHeader
        sprint={makeSprint({ state: 'ACTIVE' })}
        sprintNumber={1}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={onClose}
        onFilter={noop}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders "No sprint yet" placeholder when sprint is null', () => {
    render(
      <SprintHeader
        sprint={null}
        sprintNumber={0}
        hasPlannedSprint={false}
        onPlanNext={noop}
        onCloseSprint={noop}
        onFilter={noop}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: /No sprint yet/i }),
    ).toBeInTheDocument();
  });
});
