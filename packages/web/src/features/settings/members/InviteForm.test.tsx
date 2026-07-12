import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { InviteForm } from './InviteForm';
import type { UserSearchResult } from '@/api/types';

const mockAddMember = vi.fn();
let mockSearchResults: UserSearchResult[] = [];
let mockAddError: unknown = null;
let mockProjectDefaultRole: number | undefined;

vi.mock('../hooks/useAddMember', () => ({
  useAddMember: () => ({ mutate: mockAddMember, isPending: false, error: mockAddError }),
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data:
      mockProjectDefaultRole === undefined
        ? undefined
        : { default_member_role: mockProjectDefaultRole },
  }),
}));

vi.mock('../hooks/useUserSearch', () => ({
  useUserSearch: () => ({ data: mockSearchResults, isFetching: false }),
}));

const searchResult: UserSearchResult = {
  id: 'user-dave',
  username: 'dave',
  display_name: 'Dave',
  initials: 'DA',
};

describe('InviteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchResults = [];
    mockAddError = null;
    mockProjectDefaultRole = undefined;
  });

  function render() {
    return renderWithProviders(<InviteForm projectId="proj-1" />);
  }

  it('shows "must have account" hint', () => {
    render();
    expect(screen.getByText(/must have an existing TruePPM account/i)).toBeInTheDocument();
  });

  it('Add button is disabled when no user is selected', () => {
    render();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });

  it('shows search results in dropdown after two characters', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(screen.getByRole('combobox', { name: /search/i }), 'da');
    expect(await screen.findByRole('option', { name: /dave/i })).toBeInTheDocument();
  });

  it('selects a user and enables Add', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(screen.getByRole('combobox', { name: /search/i }), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
  });

  it('calls addMember with selected user id and role on submit', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(screen.getByRole('combobox', { name: /search/i }), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(mockAddMember).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_MEMBER },
      expect.any(Object),
    );
  });

  it("defaults the role picker to the project's default_member_role (ADR-0363)", async () => {
    mockProjectDefaultRole = ROLE_SCHEDULER;
    mockSearchResults = [searchResult];
    render();
    // Picker reflects the project default without the user touching it.
    expect(screen.getByRole('combobox', { name: /role/i })).toHaveValue(String(ROLE_SCHEDULER));
    await userEvent.type(screen.getByRole('combobox', { name: /search/i }), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(mockAddMember).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_SCHEDULER },
      expect.any(Object),
    );
  });

  it('shows conflict error when API returns 409', () => {
    mockAddError = { response: { status: 409 } };
    render();
    expect(screen.getByRole('alert')).toHaveTextContent(/already a member/i);
  });

  it('shows generic error for non-409 failures', () => {
    mockAddError = { response: { status: 500 } };
    render();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to add/i);
  });
});
