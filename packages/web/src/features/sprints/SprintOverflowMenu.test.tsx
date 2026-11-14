import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintOverflowMenu } from './SprintOverflowMenu';
import { SprintHeader } from './SprintHeader';
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

function renderMenu(
  props: Partial<Parameters<typeof SprintOverflowMenu>[0]> = {},
) {
  return render(
    <SprintOverflowMenu
      sprint={makeSprint({ id: 'sp-9', name: 'Sprint 0', exclude_from_velocity: false })}
      projectId="proj-1"
      canEdit
      {...props}
    />,
  );
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /Sprint options/i }));

describe('SprintOverflowMenu', () => {
  it('is closed until the trigger is pressed and exposes a menu', () => {
    renderMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sprint options/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('reflects the off and on states on the menuitemcheckbox', () => {
    const { unmount } = renderMenu();
    openMenu();
    let item = screen.getByRole('menuitemcheckbox');
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveAccessibleName(/Exclude Sprint 0 from velocity/);
    unmount();
    renderMenu({ sprint: makeSprint({ name: 'Sprint 0', exclude_from_velocity: true }) });
    openMenu();
    item = screen.getByRole('menuitemcheckbox');
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveAccessibleName(/Sprint 0 is excluded from velocity/);
  });

  it('PATCHes the inverted flag and closes when a Scheduler toggles it', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox'));
    expect(updateMutate).toHaveBeenCalledWith({
      sprintId: 'sp-9',
      payload: { exclude_from_velocity: true },
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    renderMenu();
    openMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: /Sprint options/i })).toHaveFocus();
  });

  it('shows the state but does not mutate for a read-only role', () => {
    renderMenu({ canEdit: false });
    openMenu();
    const item = screen.getByRole('menuitemcheckbox');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/managed by a Scheduler or above/i)).toBeInTheDocument();
    fireEvent.click(item);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not mutate while a write is pending', () => {
    updateSprint.isPending = true;
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox'));
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe('SprintHeader overflow wiring', () => {
  const base = {
    sprintNumber: 1,
    hasPlannedSprint: false,
    onPlanNext: () => undefined,
    onGenerateCadence: () => undefined,
    onCloseSprint: () => undefined,
    onFilter: () => undefined,
    canManageLifecycle: true,
    projectId: 'proj-1',
    canEditSprintSettings: true,
  };

  it('renders the overflow trigger and a standing chip when the sprint is excluded', () => {
    render(
      <SprintHeader
        {...base}
        sprint={makeSprint({ state: 'ACTIVE' })}
        menuSprint={makeSprint({ state: 'COMPLETED', exclude_from_velocity: true })}
      />,
    );
    expect(screen.getByRole('button', { name: /Sprint options/i })).toBeInTheDocument();
    expect(screen.getByText('Excluded from velocity')).toBeInTheDocument();
  });

  it('renders no overflow menu when no sprint is shown', () => {
    render(<SprintHeader {...base} sprint={null} menuSprint={null} />);
    expect(screen.queryByRole('button', { name: /Sprint options/i })).toBeNull();
  });
});
