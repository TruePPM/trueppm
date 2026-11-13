import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';
import { ProgramMembersTab } from './ProgramMembersTab';

const state = vi.hoisted(() => ({
  program: { my_role: 400, is_closed: false } as { my_role: number; is_closed: boolean },
  members: [] as unknown[],
}));

vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => 'p-1' }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id: '1' } }) }));
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => ({ data: state.program }) }));
vi.mock('../hooks/useProgramMembers', () => ({
  useProgramMembers: () => ({ data: state.members, isLoading: false, isError: false }),
}));
vi.mock('../hooks/useProgramMemberMutations', () => ({
  useRemoveProgramMember: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProgramMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('./ProgramInviteForm', () => ({
  ProgramInviteForm: () => <form data-testid="invite-form" />,
}));
vi.mock('./ProgramMemberRow', () => ({
  ProgramMemberRow: ({ membership }: { membership: ProgramMembership }) => (
    <li data-testid="member-row">{membership.id}</li>
  ),
}));

function member(id: string, role = ROLE_MEMBER) {
  return { id, role, user: 1 };
}

describe('ProgramMembersTab invite placement (#3617)', () => {
  beforeEach(() => {
    state.program = { my_role: ROLE_OWNER, is_closed: false };
    state.members = [member('m-1', ROLE_OWNER), member('m-2'), member('m-3')];
  });

  it('renders the invite form before the member list, not after it', () => {
    renderWithProviders(<ProgramMembersTab />);
    const form = screen.getByTestId('invite-form');
    const list = screen.getByRole('list', { name: 'Program members' });
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Add a member' })).toContainElement(form);
  });

  it('hides the invite form from non-owners', () => {
    state.program = { my_role: ROLE_MEMBER, is_closed: false };
    renderWithProviders(<ProgramMembersTab />);
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
  });

  it('hides the invite form on a closed program', () => {
    state.program = { my_role: ROLE_OWNER, is_closed: true };
    renderWithProviders(<ProgramMembersTab />);
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
  });

  it('points an owner at the form above when there are no members', () => {
    state.members = [];
    renderWithProviders(<ProgramMembersTab />);
    expect(screen.getByText(/Add someone above/)).toBeInTheDocument();
  });
});
