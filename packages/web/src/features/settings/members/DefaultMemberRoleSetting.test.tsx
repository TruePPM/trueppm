import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import { DefaultMemberRoleSetting } from './DefaultMemberRoleSetting';

const mockUpdate = vi.fn();
let mockProject: { default_member_role: number } | undefined;

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: mockProject, isLoading: mockProject === undefined }),
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => ({ mutate: mockUpdate, isPending: false, isError: false }),
}));

describe('DefaultMemberRoleSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProject = { default_member_role: ROLE_SCHEDULER };
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
});
