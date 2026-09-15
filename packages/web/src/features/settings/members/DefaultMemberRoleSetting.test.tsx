import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import { DefaultMemberRoleSetting } from './DefaultMemberRoleSetting';

const mockUpdate = vi.fn();
const mockRefetch = vi.fn();
let mockProject: { default_member_role: number } | undefined;
let mockIsError = false;

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: mockProject,
    isLoading: mockProject === undefined && !mockIsError,
    isError: mockIsError,
    refetch: mockRefetch,
  }),
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => ({ mutate: mockUpdate, isPending: false, isError: false }),
}));

describe('DefaultMemberRoleSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProject = { default_member_role: ROLE_SCHEDULER };
    mockIsError = false;
  });

  it('shows the project current default role as the picker value', () => {
    renderWithProviders(<DefaultMemberRoleSetting projectId="p1" />);
    expect(screen.getByRole('combobox', { name: /default role for new members/i })).toHaveValue(
      String(ROLE_SCHEDULER),
    );
  });

  it('PATCHes default_member_role on change', async () => {
    renderWithProviders(<DefaultMemberRoleSetting projectId="p1" />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /default role for new members/i }),
      'Project Manager',
    );
    expect(mockUpdate).toHaveBeenCalledWith({ default_member_role: ROLE_ADMIN });
  });

  it('shows a skeleton while the project is loading', () => {
    mockProject = undefined;
    renderWithProviders(<DefaultMemberRoleSetting projectId="p1" />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  // Before the fix, `isLoading || !project` never cleared on a failed GET
  // (`isLoading` settles to false on a terminal failure, but `!project` stays
  // true forever) — the setting pulsed a skeleton placeholder with no error
  // and no retry.
  it('renders an error with Retry, not a perpetual skeleton, when the project GET fails', () => {
    mockProject = undefined;
    mockIsError = true;
    renderWithProviders(<DefaultMemberRoleSetting projectId="p1" />);
    expect(screen.getByText("Couldn't load this setting.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('retries the project query on click', async () => {
    mockProject = undefined;
    mockIsError = true;
    renderWithProviders(<DefaultMemberRoleSetting projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});
