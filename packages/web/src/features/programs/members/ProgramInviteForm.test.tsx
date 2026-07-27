import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import type { UserSearchResult } from '@/api/types';
import { ProgramInviteForm } from './ProgramInviteForm';

interface AddPayload {
  user: string;
  role: number;
}
type AddOptions = { onSuccess?: () => void } | undefined;

const addSpy = vi.fn<(payload: AddPayload, opts: AddOptions) => void>((_payload, opts) => {
  if (mutationState.succeed) opts?.onSuccess?.();
});

const mutationState: { isPending: boolean; error: unknown; succeed: boolean } = {
  isPending: false,
  error: null,
  succeed: true,
};

const searchState: { data: UserSearchResult[] | undefined; isFetching: boolean } = {
  data: [],
  isFetching: false,
};

vi.mock('../hooks/useProgramMemberMutations', () => ({
  useAddProgramMember: () => ({
    mutate: addSpy,
    isPending: mutationState.isPending,
    error: mutationState.error,
  }),
}));

vi.mock('@/features/settings/hooks/useUserSearch', () => ({
  useUserSearch: () => ({ data: searchState.data, isFetching: searchState.isFetching }),
}));

const dave: UserSearchResult = {
  id: 'user-dave',
  username: 'dave',
  display_name: 'Dave Grohl',
  initials: 'DG',
};

const erin: UserSearchResult = {
  id: 'user-erin',
  username: 'erin',
  display_name: 'Erin Ash',
  initials: 'EA',
};

function renderForm() {
  return renderWithProviders(<ProgramInviteForm programId="prog-1" />);
}

function searchBox() {
  return screen.getByRole('combobox', { name: /search by username or email/i });
}

function addButton() {
  return screen.getByRole('button', { name: /^add(…|\.\.\.)?$/i });
}

/** Type a query and wait for the 300ms debounce to open the listbox. */
async function typeQuery(text: string) {
  await userEvent.type(searchBox(), text);
  return screen.findByRole('listbox', { name: 'Search results' });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchState.data = [];
  searchState.isFetching = false;
  mutationState.isPending = false;
  mutationState.error = null;
  mutationState.succeed = true;
});

describe('ProgramInviteForm — dropdown visibility', () => {
  it('explains the account prerequisite and starts with Add disabled', () => {
    renderForm();
    expect(screen.getByText(/must have an existing TruePPM account/i)).toBeInTheDocument();
    expect(
      screen.getByText(/not gain access to projects in this program automatically/i),
    ).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    expect(searchBox()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the dropdown shut below the two-character threshold', async () => {
    searchState.data = [dave];
    renderForm();
    await userEvent.type(searchBox(), 'd');
    // Give the debounce a chance to settle before asserting the negative.
    await waitFor(() => {
      expect(searchBox()).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens the dropdown with results once the debounced query is long enough', async () => {
    searchState.data = [dave, erin];
    renderForm();
    const list = await typeQuery('da');
    expect(list).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Dave Grohl/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Erin Ash/ })).toBeInTheDocument();
    expect(searchBox()).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a searching row while the query is in flight', async () => {
    searchState.isFetching = true;
    renderForm();
    const list = await typeQuery('da');
    expect(list).toHaveTextContent('Searching…');
    // The no-results row is suppressed while fetching.
    expect(list).not.toHaveTextContent('No users found');
  });

  it('shows a no-results row when the settled search comes back empty', async () => {
    searchState.data = [];
    renderForm();
    const list = await typeQuery('zz');
    expect(list).toHaveTextContent('No users found. Check the username or email.');
    expect(list).not.toHaveTextContent('Searching…');
  });

  it('treats an unresolved query as no results rather than crashing', async () => {
    // The first render of a new query has no cached data yet.
    searchState.data = undefined;
    renderForm();
    const list = await typeQuery('da');
    expect(list).toHaveTextContent('No users found. Check the username or email.');
    expect(within(list).queryByRole('option')).not.toBeInTheDocument();
  });

  it('closes the dropdown shortly after the input loses focus', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    fireEvent.blur(searchBox());
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('reopens the dropdown on focus', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    fireEvent.blur(searchBox());
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    fireEvent.focus(searchBox());
    expect(await screen.findByRole('listbox', { name: 'Search results' })).toBeInTheDocument();
  });
});

describe('ProgramInviteForm — selection', () => {
  it('fills the input, closes the dropdown, and enables Add when a result is clicked', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('dave');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(addButton()).toBeEnabled();
    expect(document.activeElement).toBe(searchBox());
  });

  it('selects a result with Enter and with Space', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    fireEvent.keyDown(screen.getByRole('option', { name: /Dave Grohl/ }), { key: 'Enter' });
    expect(addButton()).toBeEnabled();

    // Space picks the same way, from a fresh query.
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(addButton()).toBeDisabled();
    await typeQuery('da');
    fireEvent.keyDown(screen.getByRole('option', { name: /Dave Grohl/ }), { key: ' ' });
    expect(addButton()).toBeEnabled();
  });

  it('drops the selection as soon as the query is edited again', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    expect(addButton()).toBeEnabled();
    await userEvent.type(searchBox(), 'x');
    expect(addButton()).toBeDisabled();
  });

  it('clears the whole selection on Escape in the search box', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('');
    expect(addButton()).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('ignores other keys in the search box', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    fireEvent.keyDown(searchBox(), { key: 'Home' });
    expect(screen.getByRole('listbox', { name: 'Search results' })).toBeInTheDocument();
    expect(document.activeElement).toBe(searchBox());
  });
});

describe('ProgramInviteForm — keyboard navigation', () => {
  it('moves focus from the input into the first result with ArrowDown', async () => {
    searchState.data = [dave, erin];
    renderForm();
    await typeQuery('da');
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Dave Grohl/ }));
  });

  it('leaves focus alone when ArrowDown is pressed with no open list', async () => {
    searchState.data = [dave];
    renderForm();
    await userEvent.click(searchBox());
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(searchBox());
  });

  it('walks the results with ArrowDown/ArrowUp', async () => {
    searchState.data = [dave, erin];
    renderForm();
    await typeQuery('da');
    const first = screen.getByRole('option', { name: /Dave Grohl/ });
    const second = screen.getByRole('option', { name: /Erin Ash/ });
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    // Past the ends there is nothing to move to — focus stays put.
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('closes the list and returns focus to the input on Escape in a result', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    fireEvent.keyDown(screen.getByRole('option', { name: /Dave Grohl/ }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(searchBox());
    // Escape in a row only closes the list — the typed query survives.
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('da');
  });
});

describe('ProgramInviteForm — submit', () => {
  it('adds the selected user with the default Team Member role', async () => {
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    await userEvent.click(addButton());
    expect(addSpy).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_MEMBER },
      expect.any(Object),
    );
  });

  it('honors the chosen role and resets the form after a successful add', async () => {
    searchState.data = [dave];
    renderForm();
    const rolePicker = screen.getByRole('combobox', { name: /^role$/i });
    await userEvent.selectOptions(rolePicker, String(ROLE_SCHEDULER));
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    await userEvent.click(addButton());

    expect(addSpy).toHaveBeenCalledWith(
      { user: 'user-dave', role: ROLE_SCHEDULER },
      expect.any(Object),
    );
    // onSuccess clears the query, the selection, and the role override.
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('');
    expect(addButton()).toBeDisabled();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: /^role$/i }).value).toBe(
      String(ROLE_MEMBER),
    );
  });

  it('keeps the form as typed when the mutation does not succeed', async () => {
    mutationState.succeed = false;
    searchState.data = [dave];
    renderForm();
    await typeQuery('da');
    await userEvent.click(screen.getByRole('option', { name: /Dave Grohl/ }));
    await userEvent.click(addButton());
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: /search/i }).value).toBe('dave');
    expect(addButton()).toBeEnabled();
  });

  it('does nothing when the form is submitted without a selected user', () => {
    const { container } = renderForm();
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('shows a pending label and locks the controls while the add is in flight', () => {
    mutationState.isPending = true;
    renderForm();
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^role$/i })).toBeDisabled();
  });
});

describe('ProgramInviteForm — errors', () => {
  it('names the duplicate-membership case on a 409', () => {
    mutationState.error = { response: { status: 409 } };
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent(/already a member of the program/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('falls back to the generic message on any other status', () => {
    mutationState.error = { response: { status: 500 } };
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to add member/i);
  });

  it('falls back to the generic message when the error carries no response at all', () => {
    mutationState.error = new Error('network down');
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to add member/i);
  });

  it('falls back to the generic message when the response has no status', () => {
    mutationState.error = { response: {} };
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to add member/i);
  });

  it('shows no alert when the mutation is healthy', () => {
    renderForm();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
