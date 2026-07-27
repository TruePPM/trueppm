import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { InviteForm } from './InviteForm';
import type { UserSearchResult } from '@/api/types';

type AddMemberOptions = { onSuccess?: () => void };
const mockAddMember = vi.fn<(vars: { user: string; role: number }, opts: AddMemberOptions) => void>();
let mockSearchResults: UserSearchResult[] = [];
let mockIsFetching = false;
let mockAddError: unknown = null;
let mockAddPending = false;
let mockProjectDefaultRole: number | null | undefined;

vi.mock('../hooks/useAddMember', () => ({
  useAddMember: () => ({ mutate: mockAddMember, isPending: mockAddPending, error: mockAddError }),
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
  useUserSearch: () => ({ data: mockSearchResults, isFetching: mockIsFetching }),
}));

const searchResult: UserSearchResult = {
  id: 'user-dave',
  username: 'dave',
  display_name: 'Dave',
  initials: 'DA',
};

const secondResult: UserSearchResult = {
  id: 'user-erin',
  username: 'erin',
  display_name: 'Erin',
  initials: 'ER',
};

describe('InviteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchResults = [];
    mockIsFetching = false;
    mockAddError = null;
    mockAddPending = false;
    mockProjectDefaultRole = undefined;
  });

  function render() {
    return renderWithProviders(<InviteForm projectId="proj-1" />);
  }

  const searchBox = () => screen.getByRole('combobox', { name: /search/i });
  const rolePicker = () => screen.getByRole('combobox', { name: /^role$/i });
  const addButton = () => screen.getByRole('button', { name: /^add$/i });
  /**
   * The role picker is a native <select>, so its <option>s share the `option`
   * role with the search results. Every result-list query must be scoped to the
   * listbox or it silently picks up "Viewer" as the first option.
   */
  const resultOptions = () => within(screen.getByRole('listbox')).getAllByRole('option');

  it('shows "must have account" hint', () => {
    render();
    expect(screen.getByText(/must have an existing TruePPM account/i)).toBeInTheDocument();
  });

  it('Add button is disabled when no user is selected', () => {
    render();
    expect(addButton()).toBeDisabled();
  });

  it('shows search results in dropdown after two characters', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    expect(await screen.findByRole('option', { name: /dave/i })).toBeInTheDocument();
  });

  it('selects a user and enables Add', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    expect(addButton()).toBeEnabled();
  });

  it('calls addMember with selected user id and role on submit', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(addButton());
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
    expect(rolePicker()).toHaveValue(String(ROLE_SCHEDULER));
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(addButton());
    expect(mockAddMember).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_SCHEDULER },
      expect.any(Object),
    );
  });

  it('falls back to Team Member when the project has no default role set', () => {
    mockProjectDefaultRole = null;
    render();
    expect(rolePicker()).toHaveValue(String(ROLE_MEMBER));
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

  it('shows generic error for an error with no response envelope', () => {
    mockAddError = new Error('network down');
    render();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/failed to add/i);
    expect(screen.queryByText(/already a member/i)).not.toBeInTheDocument();
  });

  it('renders no error text at all when the mutation has not failed', () => {
    render();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Dropdown visibility guards — open / min-query-length / already-selected
  // ---------------------------------------------------------------------------

  it('keeps the dropdown closed for a single-character query', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'd');
    // Give the 300 ms debounce time to land so this is a real "too short" assert
    // rather than merely "hasn't debounced yet".
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the dropdown once a user is selected', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue('dave');
  });

  it('re-opens the search and drops the selection when the query is edited again', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    expect(addButton()).toBeEnabled();

    await userEvent.type(input, 'x');
    // Selection cleared, so Add goes back to disabled and the list re-opens.
    expect(addButton()).toBeDisabled();
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('closes the dropdown shortly after the field loses focus', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    input.blur();
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('re-opens the dropdown when the field regains focus', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    input.blur();
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    input.focus();
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('Escape in the search field clears the query and closes the dropdown', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape after a selection also clears the pending invite', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    expect(addButton()).toBeEnabled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(addButton()).toBeDisabled();
    expect(searchBox()).toHaveValue('');
  });

  // ---------------------------------------------------------------------------
  // Dropdown contents — loading / empty / results
  // ---------------------------------------------------------------------------

  it('shows a searching indicator while the query is in flight', async () => {
    mockIsFetching = true;
    mockSearchResults = [];
    render();
    await userEvent.type(searchBox(), 'da');
    expect(await screen.findByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByText(/no users found/i)).not.toBeInTheDocument();
  });

  it('shows an empty state when the search returns nothing', async () => {
    mockIsFetching = false;
    mockSearchResults = [];
    render();
    await userEvent.type(searchBox(), 'da');
    expect(await screen.findByText(/no users found/i)).toBeInTheDocument();
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Keyboard navigation of the results list
  // ---------------------------------------------------------------------------

  it('ArrowDown from the search field moves focus into the results list', async () => {
    mockSearchResults = [searchResult, secondResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    await screen.findByRole('listbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(resultOptions()[0]).toHaveFocus();
  });

  it('ArrowDown from the search field is a no-op while the list is closed', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('ArrowDown and ArrowUp walk between options', async () => {
    mockSearchResults = [searchResult, secondResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await screen.findByRole('listbox');
    const [first, second] = resultOptions();

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
  });

  it('ArrowUp on the first option and ArrowDown on the last stay put', async () => {
    mockSearchResults = [searchResult, secondResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await screen.findByRole('listbox');
    const [first, second] = resultOptions();

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(first).toHaveFocus();

    second.focus();
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
  });

  it('Enter on an option selects that user', async () => {
    mockSearchResults = [searchResult, secondResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await screen.findByRole('listbox');

    fireEvent.keyDown(resultOptions()[1], { key: 'Enter' });
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('erin');
    expect(addButton()).toBeEnabled();
  });

  it('Space on an option selects that user', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await screen.findByRole('listbox');

    fireEvent.keyDown(resultOptions()[0], { key: ' ' });
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('dave');
  });

  it('an unhandled key on an option changes nothing', async () => {
    mockSearchResults = [searchResult];
    render();
    await userEvent.type(searchBox(), 'da');
    await screen.findByRole('listbox');
    const option = resultOptions()[0];
    option.focus();

    fireEvent.keyDown(option, { key: 'a' });
    expect(option).toHaveFocus();
    expect(addButton()).toBeDisabled();
  });

  it('Escape on an option returns focus to the search field', async () => {
    mockSearchResults = [searchResult];
    render();
    const input = searchBox();
    await userEvent.type(input, 'da');
    await screen.findByRole('listbox');
    const option = resultOptions()[0];
    option.focus();

    fireEvent.keyDown(option, { key: 'Escape' });
    expect(input).toHaveFocus();
    // Escape from the list abandons the highlight without picking anyone.
    expect(addButton()).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Submit paths
  // ---------------------------------------------------------------------------

  it('does not call addMember when the form is submitted with no selection', () => {
    const { container } = render();
    const form = container.querySelector<HTMLFormElement>('form');
    if (!form) throw new Error('InviteForm did not render a <form>');
    fireEvent.submit(form);
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it('sends the explicitly picked role instead of the project default', async () => {
    mockProjectDefaultRole = ROLE_MEMBER;
    mockSearchResults = [searchResult];
    render();
    await userEvent.selectOptions(rolePicker(), String(ROLE_ADMIN));
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(addButton());
    expect(mockAddMember).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_ADMIN },
      expect.any(Object),
    );
  });

  it('resets the query and the role override after a successful add', async () => {
    mockProjectDefaultRole = ROLE_SCHEDULER;
    mockSearchResults = [searchResult];
    mockAddMember.mockImplementation((_vars, opts) => opts.onSuccess?.());
    render();
    await userEvent.selectOptions(rolePicker(), String(ROLE_ADMIN));
    await userEvent.type(searchBox(), 'da');
    await userEvent.click(await screen.findByRole('option', { name: /dave/i }));
    await userEvent.click(addButton());

    expect(searchBox()).toHaveValue('');
    expect(addButton()).toBeDisabled();
    // Override released — the picker follows the project default again (ADR-0363).
    expect(rolePicker()).toHaveValue(String(ROLE_SCHEDULER));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('disables the role picker and shows a pending label while the add is in flight', () => {
    mockAddPending = true;
    render();
    expect(rolePicker()).toBeDisabled();
    expect(screen.getByRole('button', { name: /adding…/i })).toBeDisabled();
  });
});
