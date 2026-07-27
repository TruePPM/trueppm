/**
 * AddToRosterCombobox behavior tests.
 *
 * Covers the three interaction surfaces of the combobox: the results dropdown
 * (pointer + keyboard selection), the inline-create option (#155) shown when the
 * search comes back empty, and its failure path (#2150).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { AddToRosterCombobox } from './AddToRosterCombobox';

const { getMock, postMock, toastErrorMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: toastErrorMock } }));

const PEOPLE = [
  { id: 'r1', name: 'Ada Lovelace', job_role: 'Engineer' },
  { id: 'r2', name: 'Grace Hopper', job_role: '' },
];

/** Resolve the candidate search with the given rows. */
function resolveWith(rows: typeof PEOPLE) {
  getMock.mockResolvedValue({ data: { results: rows } });
}

beforeEach(() => {
  getMock.mockReset();
  resolveWith([]);
  postMock.mockReset();
  toastErrorMock.mockReset();
});

function renderCombobox(overrides: Partial<{ onSelect: () => void; onDismiss: () => void }> = {}) {
  const onSelect = vi.fn<(resourceId: string) => void>();
  const onDismiss = vi.fn<() => void>();
  renderWithProviders(
    <AddToRosterCombobox
      projectId="p1"
      onSelect={overrides.onSelect ?? onSelect}
      onDismiss={overrides.onDismiss ?? onDismiss}
    />,
  );
  return { onSelect, onDismiss, input: screen.getByRole('combobox') };
}

describe('AddToRosterCombobox — dropdown open/closed', () => {
  it('keeps the dropdown collapsed when nothing is typed and nothing matches', async () => {
    const { input } = renderCombobox();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('opens the dropdown and lists each candidate, showing the job role only when set', async () => {
    resolveWith(PEOPLE);
    const { input } = renderCombobox();

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(within(options[0]).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(options[0]).getByText('Engineer')).toBeTruthy();
    // Grace has a blank job_role — the secondary line is omitted entirely.
    expect(options[1].textContent).toBe('Grace Hopper');
  });

  it('sends the typed query and the exclude_project filter to the API after the debounce', async () => {
    resolveWith(PEOPLE);
    const { input } = renderCombobox();
    fireEvent.change(input, { target: { value: 'ada' } });

    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith('/resources/', {
        params: { search: 'ada', exclude_project: 'p1' },
      }),
    );
  });
});

describe('AddToRosterCombobox — selecting an existing resource', () => {
  it('selects the clicked candidate', async () => {
    resolveWith(PEOPLE);
    const { onSelect } = renderCombobox();

    const options = await screen.findAllByRole('option');
    fireEvent.pointerDown(options[0]);
    expect(onSelect).toHaveBeenCalledWith('r1');
  });

  it('walks the list with ArrowDown, clamps at the last option, and selects with Enter', async () => {
    resolveWith(PEOPLE);
    const { onSelect, input } = renderCombobox();
    const options = await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    // Already on the last option — ArrowDown must not run past the end.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('r2');
  });

  it('clamps ArrowUp at the first option', async () => {
    resolveWith(PEOPLE);
    const { input } = renderCombobox();
    const options = await screen.findAllByRole('option');

    // From the "nothing highlighted" state ArrowUp lands on the first option…
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    // …and stays there.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('ignores Enter while nothing is highlighted', async () => {
    resolveWith(PEOPLE);
    const { onSelect, input } = renderCombobox();
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drops the highlight when the query changes', async () => {
    resolveWith(PEOPLE);
    const { input } = renderCombobox();
    const options = await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.change(input, { target: { value: 'grace' } });
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toBeNull());
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('false');
  });

  it('dismisses on Escape', async () => {
    resolveWith(PEOPLE);
    const { onDismiss, input } = renderCombobox();
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores unhandled keys', async () => {
    resolveWith(PEOPLE);
    const { onSelect, onDismiss, input } = renderCombobox();
    const options = await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(options[0].getAttribute('aria-selected')).toBe('false');
  });
});

describe('AddToRosterCombobox — inline create (#155)', () => {
  it('offers the create option only once a non-blank name is typed', async () => {
    const { input } = renderCombobox();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).toBeNull();

    // Whitespace alone is not a name — the option stays hidden.
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(input, { target: { value: 'New Person' } });
    expect(
      await screen.findByRole('option', { name: '+ Create "New Person" as a new resource' }),
    ).toBeTruthy();
  });

  it('hides the create option when the search has matches', async () => {
    resolveWith(PEOPLE);
    const { input } = renderCombobox();
    await screen.findAllByRole('option');

    fireEvent.change(input, { target: { value: 'Ada' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByText(/\+ Create/)).toBeNull();
  });

  it('creates the resource, rosters it, and selects the new id on click', async () => {
    postMock
      .mockResolvedValueOnce({ data: { id: 'new-1' } })
      .mockResolvedValueOnce({ data: {} });
    const { onSelect, input } = renderCombobox();
    fireEvent.change(input, { target: { value: 'New Person' } });

    fireEvent.pointerDown(
      await screen.findByRole('option', { name: '+ Create "New Person" as a new resource' }),
    );

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('new-1'));
    expect(postMock).toHaveBeenNthCalledWith(1, '/resources/', {
      name: 'New Person',
      email: '',
      job_role: '',
      max_units: 1.0,
    });
    expect(postMock).toHaveBeenNthCalledWith(2, '/project-resources/', {
      project: 'p1',
      resource: 'new-1',
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('reaches the create option by keyboard and triggers it with Enter', async () => {
    postMock
      .mockResolvedValueOnce({ data: { id: 'new-2' } })
      .mockResolvedValueOnce({ data: {} });
    const { onSelect, input } = renderCombobox();
    fireEvent.change(input, { target: { value: 'Keyboard Person' } });

    const createOption = await screen.findByRole('option', {
      name: '+ Create "Keyboard Person" as a new resource',
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(createOption.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(createOption.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('new-2'));
  });

  it('trims the typed name before creating', async () => {
    postMock
      .mockResolvedValueOnce({ data: { id: 'new-3' } })
      .mockResolvedValueOnce({ data: {} });
    const { input } = renderCombobox();
    fireEvent.change(input, { target: { value: '  Padded Name  ' } });

    fireEvent.pointerDown(
      await screen.findByRole('option', { name: '+ Create "Padded Name" as a new resource' }),
    );

    await waitFor(() =>
      expect(postMock).toHaveBeenNthCalledWith(
        1,
        '/resources/',
        expect.objectContaining({ name: 'Padded Name' }),
      ),
    );
  });

  it('shows a pending label and locks the input while the create is in flight', async () => {
    postMock.mockImplementation(() => new Promise(() => {}));
    const { input } = renderCombobox();
    fireEvent.change(input, { target: { value: 'Slow Person' } });

    fireEvent.pointerDown(
      await screen.findByRole('option', { name: '+ Create "Slow Person" as a new resource' }),
    );

    await screen.findByRole('option', { name: 'Creating…' });
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  it('toasts when creating the new resource fails (#2150)', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    const { onSelect, input } = renderCombobox();
    fireEvent.change(input, { target: { value: 'New Person' } });

    fireEvent.pointerDown(
      await screen.findByRole('option', { name: '+ Create "New Person" as a new resource' }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Couldn't create the resource — try again."),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
