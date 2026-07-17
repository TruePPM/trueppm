import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExcludeFromVelocityToggle } from './ExcludeFromVelocityToggle';
import { makeSprint } from './sprintTestFixtures';

const updateMutate = vi.fn();
const updateSprint = { mutate: updateMutate, isPending: false, isError: false };

vi.mock('@/hooks/useSprints', () => ({
  useSprintMutations: () => ({
    createSprint: { mutate: vi.fn(), isPending: false, isError: false },
    closeSprint: { mutate: vi.fn(), isPending: false, isError: false },
    activateSprint: { mutate: vi.fn(), isPending: false, isError: false },
    updateSprint,
  }),
}));

beforeEach(() => {
  updateMutate.mockReset();
  updateSprint.isPending = false;
});

function renderToggle(
  props: Partial<Parameters<typeof ExcludeFromVelocityToggle>[0]> = {},
) {
  return render(
    <ExcludeFromVelocityToggle
      sprint={makeSprint({ name: 'Sprint 0', exclude_from_velocity: false })}
      projectId="proj-1"
      canEdit
      {...props}
    />,
  );
}

describe('ExcludeFromVelocityToggle', () => {
  it('reflects the off state and exposes a switch', () => {
    renderToggle();
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleName(/Exclude Sprint 0 from velocity/);
  });

  it('reflects the on state', () => {
    renderToggle({ sprint: makeSprint({ name: 'Sprint 0', exclude_from_velocity: true }) });
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAccessibleName(/Sprint 0 is excluded from velocity/);
  });

  it('PATCHes the inverted flag when a Scheduler toggles it on', () => {
    const sprint = makeSprint({ id: 'sp-9', name: 'Sprint 0', exclude_from_velocity: false });
    renderToggle({ sprint });
    fireEvent.click(screen.getByRole('switch'));
    expect(updateMutate).toHaveBeenCalledWith({
      sprintId: 'sp-9',
      payload: { exclude_from_velocity: true },
    });
  });

  it('uses plain language — no scheduler jargon in the helper copy', () => {
    renderToggle();
    expect(screen.getByText(/setup or ramp-up sprint/i)).toBeInTheDocument();
    expect(screen.queryByText(/Monte Carlo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sampling/i)).not.toBeInTheDocument();
  });

  it('renders read-only and does not mutate for non-Scheduler roles', () => {
    renderToggle({ canEdit: false });
    // No interactive switch — the value + provenance shows read-only instead (ADR-0133).
    expect(screen.queryByRole('switch')).toBeNull();
    expect(
      screen.getByLabelText(
        'Exclude from velocity: Not excluded, managed by a Scheduler. View only.',
      ),
    ).toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not double-fire while a write is pending', () => {
    updateSprint.isPending = true;
    renderToggle();
    fireEvent.click(screen.getByRole('switch'));
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
