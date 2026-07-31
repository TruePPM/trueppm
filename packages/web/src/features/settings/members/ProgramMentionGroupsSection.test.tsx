import { screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';
import { ProgramMentionGroupsSection } from './ProgramMentionGroupsSection';

const useProgramMentionGroups = vi.fn();
const create = { mutate: vi.fn(), isPending: false, error: null };
const update = { mutate: vi.fn(), isPending: false };
const remove = { mutate: vi.fn(), isPending: false };
const addMember = { mutate: vi.fn(), isPending: false };
const removeMember = { mutate: vi.fn(), isPending: false };
const mute = { mutate: vi.fn(), isPending: false };

vi.mock('../hooks/useProgramMentionGroups', () => ({
  useProgramMentionGroups: () =>
    useProgramMentionGroups() as { data: unknown; isLoading: boolean; isError: boolean },
  useProgramMentionGroupMutations: () => ({
    create,
    update,
    remove,
    addMember,
    removeMember,
    mute,
  }),
}));

const MEMBERS: ProgramMembership[] = [
  {
    id: 'm-1',
    server_version: 1,
    program: 'p-1',
    user: 'u-1',
    user_detail: { id: 'u-1', username: 'anika.k', email: 'anika@example.com' },
    role: ROLE_OWNER,
    role_label: 'Owner',
    joined_at: '2026-01-01T00:00:00Z',
    role_changed_at: null,
  },
];

const GROUP = {
  id: 'g-1',
  name: 'tech-leads',
  description: '',
  email_default_on: false,
  members: [],
  member_count: 0,
  muted_by_me: false,
};

function renderSection(overrides: { isClosed?: boolean; myRole?: number | null } = {}) {
  return renderWithProviders(
    <ProgramMentionGroupsSection
      programId="p-1"
      myRole={overrides.myRole ?? ROLE_OWNER}
      members={MEMBERS}
      isClosed={overrides.isClosed ?? false}
    />,
  );
}

describe('ProgramMentionGroupsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the create form for an Owner on an open program', () => {
    useProgramMentionGroups.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderSection({ isClosed: false });
    expect(screen.getByPlaceholderText('tech-leads')).toBeInTheDocument();
  });

  // #2549: every write on this viewset (create/update/destroy/add-member/
  // remove-member) is gated by IsProgramNotClosed, so an Owner on a closed
  // program must not see a live create form, and the section must say why.
  it('hides the create form for an Owner on a closed program, and says why', () => {
    useProgramMentionGroups.mockReturnValue({
      data: [GROUP],
      isLoading: false,
      isError: false,
    });
    renderSection({ isClosed: true, myRole: ROLE_OWNER });

    expect(screen.queryByPlaceholderText('tech-leads')).not.toBeInTheDocument();
    expect(
      screen.getByText(/This program is closed — reopen it to manage mention groups/i),
    ).toBeInTheDocument();
  });

  it('renders nothing for an Admin on a closed program with no existing groups', () => {
    // Nothing to manage (closed blocks create) and nothing to mute (no groups) —
    // matches the existing below-Owner "nothing to show" behavior.
    useProgramMentionGroups.mockReturnValue({ data: [], isLoading: false, isError: false });
    const { container } = renderSection({ isClosed: true, myRole: ROLE_ADMIN });
    expect(container).toBeEmptyDOMElement();
  });
});
