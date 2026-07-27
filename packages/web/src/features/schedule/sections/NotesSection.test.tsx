import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { TaskNote } from '@/types';
import { NotesSection } from './NotesSection';

const useNotesMock = vi.hoisted(() => vi.fn());
const usePinMock = vi.hoisted(() => vi.fn());
const useDecisionMock = vi.hoisted(() => vi.fn());
const useDeleteMock = vi.hoisted(() => vi.fn());
const useUpdateMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());
const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskNotes', () => ({
  useTaskNotes: useNotesMock,
  usePinNote: usePinMock,
  useToggleDecision: useDecisionMock,
  useDeleteNote: useDeleteMock,
  useUpdateNote: useUpdateMock,
  useCreateNote: useCreateMock,
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: useCurrentUserMock,
}));

function note(overrides: Partial<TaskNote> = {}): TaskNote {
  return {
    id: 'n1',
    task: 't1',
    author: { id: 'u1', username: 'alice', display_name: 'Alice' },
    body: 'hello world',
    pinned: false,
    decision: false,
    edited_at: null,
    created_at: '2026-05-19T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePinMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useDecisionMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  // Default current user is the author of the base note.
  useCurrentUserMock.mockReturnValue({
    user: { id: 'u1', username: 'alice', display_name: 'Alice' },
    isLoading: false,
  });
});

describe('NotesSection — list states', () => {
  it('renders the loading skeleton', () => {
    useNotesMock.mockReturnValue({ notes: [], isLoading: true, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    expect(screen.getByLabelText('Loading notes')).toBeTruthy();
  });

  it('renders the error state', () => {
    useNotesMock.mockReturnValue({
      notes: [],
      isLoading: false,
      error: new Error('boom'),
    });
    render(<NotesSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load");
  });

  it('shows the editable empty-state copy + composer when no notes', () => {
    useNotesMock.mockReturnValue({ notes: [], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByText('No notes yet — capture the first decision or why.')).toBeTruthy();
    expect(screen.getByLabelText('Note composer')).toBeTruthy();
  });

  it('shows the read-only empty-state copy and no composer for a viewer', () => {
    useNotesMock.mockReturnValue({ notes: [], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" canEdit={false} userRole={ROLE_VIEWER} />);
    expect(screen.getByText('No notes yet.')).toBeTruthy();
    expect(screen.queryByLabelText('Note composer')).toBeNull();
  });
});

describe('NotesSection — note rendering', () => {
  it('renders the author, relative time, and body', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ body: 'plain body' })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('plain body')).toBeTruthy();
  });

  it('renders the pinned affordance and a pinned aria-label for a pinned note', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ pinned: true })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    // The pin icon advertises its title and the row aria-label includes ", pinned".
    expect(screen.getByTitle('Pinned')).toBeTruthy();
    expect(
      screen.getByRole('listitem', { name: /Note by Alice, .*, pinned/ }),
    ).toBeTruthy();
    // The toggle reads "Unpin" and is pressed.
    const unpin = screen.getByLabelText('Unpin this note');
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('NotesSection — dim-search', () => {
  function twoNotes() {
    return [
      note({ id: 'n1', body: 'database migration plan', author: { id: 'u1', username: 'alice', display_name: 'Alice' } }),
      note({ id: 'n2', body: 'frontend rollout', author: { id: 'u2', username: 'bob', display_name: 'Bob' } }),
    ];
  }

  it('dims non-matching rows and keeps matching rows at full opacity', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), {
      target: { value: 'migration' },
    });
    const match = screen.getByRole('listitem', { name: /Note by Alice/ });
    const nonMatch = screen.getByRole('listitem', { name: /Note by Bob/ });
    expect(match.className).toContain('opacity-100');
    expect(nonMatch.className).toContain('opacity-30');
  });

  it('shows the "N of M notes" status counter only while searching, with correct counts', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    // No counter before typing.
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search notes'), {
      target: { value: 'migration' },
    });
    expect(screen.getByRole('status').textContent).toContain('1 of 2 notes');
  });

  it('matches against the author name as well as the body', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), {
      target: { value: 'bob' },
    });
    expect(screen.getByRole('status').textContent).toContain('1 of 2 notes');
    expect(screen.getByRole('listitem', { name: /Note by Bob/ }).className).toContain(
      'opacity-100',
    );
    expect(screen.getByRole('listitem', { name: /Note by Alice/ }).className).toContain(
      'opacity-30',
    );
  });

  it('clears the query on Escape so rows return to full opacity', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    const input = screen.getByLabelText('Search notes');
    fireEvent.change(input, { target: { value: 'migration' } });
    expect(screen.getByRole('listitem', { name: /Note by Bob/ }).className).toContain(
      'opacity-30',
    );
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('listitem', { name: /Note by Bob/ }).className).toContain(
      'opacity-100',
    );
    expect(screen.getByRole('listitem', { name: /Note by Alice/ }).className).toContain(
      'opacity-100',
    );
  });

  it('leaves the query alone for keys other than Escape', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" />);
    const input = screen.getByLabelText<HTMLInputElement>('Search notes');
    fireEvent.change(input, { target: { value: 'migration' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('migration');
    expect(screen.getByRole('status').textContent).toContain('1 of 2 notes');
  });

  it('wraps the matched body substring in a <mark>', () => {
    useNotesMock.mockReturnValue({ notes: twoNotes(), isLoading: false, error: null });
    const { container } = render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), {
      target: { value: 'migration' },
    });
    const mark = container.querySelector('mark');
    expect(mark?.textContent).toBe('migration');
  });
});

describe('NotesSection — read-only viewer', () => {
  it('renders notes but no composer, pin, edit, or delete controls', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ body: 'view me' })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit={false} userRole={ROLE_VIEWER} />);
    expect(screen.getByText('view me')).toBeTruthy();
    expect(screen.queryByLabelText('Note composer')).toBeNull();
    expect(screen.queryByLabelText('Pin this note')).toBeNull();
    expect(screen.queryByLabelText('Unpin this note')).toBeNull();
    expect(screen.queryByLabelText('Edit this note')).toBeNull();
    expect(screen.queryByLabelText('Delete this note')).toBeNull();
  });
});

describe('NotesSection — edit window', () => {
  const nowIso = () => new Date().toISOString();
  const expiredIso = () => new Date(Date.now() - 16 * 60 * 1000).toISOString();

  it('shows Edit on the current user\'s own note created just now', () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u1', username: 'alice', display_name: 'Alice' }, created_at: nowIso() })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByLabelText('Edit this note')).toBeTruthy();
  });

  it('hides Edit on the current user\'s own note created 16+ minutes ago', () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u1', username: 'alice', display_name: 'Alice' }, created_at: expiredIso() })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Edit this note')).toBeNull();
  });

  it("never shows Edit on someone else's note, even when fresh", () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u2', username: 'bob', display_name: 'Bob' }, created_at: nowIso() })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Edit this note')).toBeNull();
  });
});

describe('NotesSection — delete visibility', () => {
  it('shows Delete on the author\'s own note', () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u1', username: 'alice', display_name: 'Alice' } })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('Delete this note')).toBeTruthy();
  });

  it("shows Delete on someone else's note for an ADMIN", () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u2', username: 'bob', display_name: 'Bob' } })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_ADMIN} />);
    expect(screen.getByLabelText('Delete this note')).toBeTruthy();
  });

  it("hides Delete on someone else's note for a plain MEMBER", () => {
    useCurrentUserMock.mockReturnValue({
      user: { id: 'u1', username: 'alice', display_name: 'Alice' },
      isLoading: false,
    });
    useNotesMock.mockReturnValue({
      notes: [note({ author: { id: 'u2', username: 'bob', display_name: 'Bob' } })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    expect(screen.queryByLabelText('Delete this note')).toBeNull();
  });
});

describe('NotesSection — pin interaction', () => {
  it('calls the pin mutation with the note id when Pin is clicked', () => {
    const mutate = vi.fn();
    usePinMock.mockReturnValue({ mutate, isPending: false });
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n9', pinned: false })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Pin this note'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', taskId: 't1', noteId: 'n9' }),
    );
  });
});

describe('NotesSection — list semantics', () => {
  it('exposes the list with a total-count aria-label and one listitem per note', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n1' }), note({ id: 'n2', author: { id: 'u2', username: 'bob', display_name: 'Bob' } })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" />);
    const list = screen.getByRole('list', { name: 'Notes — 2 total' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('NotesSection — row metadata', () => {
  it('falls back to "Unknown" when the note has no author', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ author: null, body: 'orphaned note' })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('listitem', { name: /^Note by Unknown,/ })).toBeTruthy();
    // An author-less note is not "yours", so no Delete for a plain member.
    expect(screen.queryByLabelText('Delete this note')).toBeNull();
  });

  it('marks an edited note in the row label and inline', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ edited_at: '2026-05-19T00:05:00Z' })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('listitem', { name: /, edited$/ })).toBeTruthy();
    expect(screen.getByText('· edited')).toBeTruthy();
  });

  it('omits the edited marker on a never-edited note', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ edited_at: null })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" />);
    expect(screen.queryByText('· edited')).toBeNull();
    expect(screen.queryByTitle('Pinned')).toBeNull();
    expect(screen.queryByTitle('Decision')).toBeNull();
  });

  it('hides the search box entirely when there are no notes', () => {
    useNotesMock.mockReturnValue({ notes: [], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Search notes')).toBeNull();
  });
});

describe('NotesSection — highlight segmentation', () => {
  it('marks every occurrence and keeps the surrounding text intact', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ body: 'aa bb aa cc' })],
      isLoading: false,
      error: null,
    });
    const { container } = render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'aa' } });

    const marks = Array.from(container.querySelectorAll('mark'));
    expect(marks.map((m) => m.textContent)).toEqual(['aa', 'aa']);
    const row = screen.getByRole('listitem', { name: /Note by Alice/ });
    expect(row.textContent).toContain('aa bb aa cc');
  });

  it('emits no trailing segment when the match ends the body', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ body: 'plan aa' })],
      isLoading: false,
      error: null,
    });
    const { container } = render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'aa' } });

    const marks = Array.from(container.querySelectorAll('mark'));
    expect(marks.map((m) => m.textContent)).toEqual(['aa']);
    expect(screen.getByRole('listitem', { name: /Note by Alice/ }).textContent).toContain(
      'plan aa',
    );
  });

  it('renders the body unmarked when the query only matches the author', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ body: 'no needle here' })],
      isLoading: false,
      error: null,
    });
    const { container } = render(<NotesSection taskId="t1" projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'Alice' } });

    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('1 of 1 notes');
  });
});

describe('NotesSection — editable fallback', () => {
  it('derives write access from the role when canEdit is not threaded', () => {
    useNotesMock.mockReturnValue({ notes: [note()], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('Pin this note')).toBeTruthy();
    expect(screen.getByLabelText('Note composer')).toBeTruthy();
  });

  it('denies write access for a viewer role when canEdit is not threaded', () => {
    useNotesMock.mockReturnValue({ notes: [note()], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    expect(screen.queryByLabelText('Pin this note')).toBeNull();
    expect(screen.queryByLabelText('Note composer')).toBeNull();
  });

  it('lets the server verdict override a low client role', () => {
    useNotesMock.mockReturnValue({ notes: [note()], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_VIEWER} />);
    expect(screen.getByLabelText('Pin this note')).toBeTruthy();
  });

  it('hides Edit and Delete while the current user is still unknown', () => {
    useCurrentUserMock.mockReturnValue({ user: null, isLoading: true });
    useNotesMock.mockReturnValue({
      notes: [note({ created_at: new Date().toISOString() })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    expect(screen.queryByLabelText('Edit this note')).toBeNull();
    expect(screen.queryByLabelText('Delete this note')).toBeNull();
    // Pin and decision remain available — they need no ownership.
    expect(screen.getByLabelText('Pin this note')).toBeTruthy();
  });
});

describe('NotesSection — write actions', () => {
  it('calls the delete mutation with the note id', () => {
    const mutate = vi.fn<(vars: { noteId: string }) => void>();
    useDeleteMock.mockReturnValue({ mutate, isPending: false });
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n7' })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Delete this note'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', taskId: 't1', noteId: 'n7' }),
    );
  });

  it('disables the row actions while their mutations are in flight', () => {
    usePinMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useDecisionMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useNotesMock.mockReturnValue({ notes: [note()], isLoading: false, error: null });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);

    expect(screen.getByLabelText('Pin this note')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Mark as decision')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Delete this note')).toHaveProperty('disabled', true);
  });
});

describe('NotesSection — inline edit', () => {
  type UpdateVars = { projectId: string; taskId: string; noteId: string; body: string };
  type UpdateOpts = { onSuccess?: () => void };

  function freshOwnNote(body = 'original body') {
    return note({ id: 'n5', body, created_at: new Date().toISOString() });
  }

  function openEditor(body = 'original body') {
    useNotesMock.mockReturnValue({
      notes: [freshOwnNote(body)],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Edit this note'));
    return screen.getByLabelText<HTMLTextAreaElement>('Edit note');
  }

  it('swaps the body for a textarea seeded with the note and hides the row actions', () => {
    const textarea = openEditor();
    expect(textarea.value).toBe('original body');
    expect(screen.queryByLabelText('Pin this note')).toBeNull();
    expect(screen.queryByLabelText('Delete this note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('saves the trimmed draft and leaves edit mode on success', () => {
    const mutate = vi.fn<(vars: UpdateVars, opts?: UpdateOpts) => void>((_vars, opts) =>
      opts?.onSuccess?.(),
    );
    useUpdateMock.mockReturnValue({ mutate, isPending: false, isError: false });

    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: '  revised body  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', noteId: 'n5', body: 'revised body' },
      expect.anything(),
    );
    // onSuccess closed the editor and the read view is back.
    expect(screen.queryByLabelText('Edit note')).toBeNull();
    expect(screen.getByLabelText('Pin this note')).toBeTruthy();
  });

  it('disables Save on a whitespace-only draft', () => {
    const mutate = vi.fn<(vars: UpdateVars, opts?: UpdateOpts) => void>();
    useUpdateMock.mockReturnValue({ mutate, isPending: false, isError: false });

    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: '   ' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(save);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses to submit a draft over the 10,000-character cap', () => {
    const mutate = vi.fn<(vars: UpdateVars, opts?: UpdateOpts) => void>();
    useUpdateMock.mockReturnValue({ mutate, isPending: false, isError: false });

    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: 'x'.repeat(10_001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).not.toHaveBeenCalled();
    // Still in edit mode — nothing was silently discarded.
    expect(screen.getByLabelText('Edit note')).toBeTruthy();
  });

  it('restores the original body on Cancel', () => {
    const textarea = openEditor('original body');
    fireEvent.change(textarea, { target: { value: 'scrapped' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Edit note')).toBeNull();
    expect(screen.getByRole('listitem', { name: /Note by Alice/ }).textContent).toContain(
      'original body',
    );
    // Reopening shows the original, not the scrapped draft.
    fireEvent.click(screen.getByLabelText('Edit this note'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Edit note').value).toBe('original body');
  });

  it('shows a pending label and locks both buttons while saving', () => {
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: true, isError: false });
    openEditor();
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  });

  it('surfaces the closed-window error and stays in edit mode', () => {
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: true });
    openEditor();
    expect(screen.getByRole('alert').textContent).toContain('15-minute edit window');
    expect(screen.getByLabelText('Edit note')).toBeTruthy();
  });

  it('shows no error banner on a clean editor', () => {
    openEditor();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('NotesSection — decision chip (ADR-0167, #748)', () => {
  it('calls the decision mutation with the note id when the chip is clicked', () => {
    const mutate = vi.fn();
    useDecisionMock.mockReturnValue({ mutate, isPending: false });
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n9', decision: false })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Mark as decision'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', taskId: 't1', noteId: 'n9' }),
    );
  });

  it('reflects the flagged state via aria-pressed and the header badge', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n9', decision: true })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('Unmark as decision').getAttribute('aria-pressed')).toBe('true');
    // The row's aria-label announces the decision state.
    expect(screen.getByRole('listitem', { name: /decision/ })).toBeTruthy();
  });

  it('shows a read-only Decision badge but no toggle for a viewer', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n9', decision: true })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit={false} userRole={ROLE_VIEWER} />);
    expect(screen.getByTitle('Decision')).toBeTruthy();
    expect(screen.queryByLabelText('Unmark as decision')).toBeNull();
    expect(screen.queryByLabelText('Mark as decision')).toBeNull();
  });

  it('marks the badge and the toggle with the scale SVG, not the ⚖ emoji', () => {
    useNotesMock.mockReturnValue({
      notes: [note({ id: 'n9', decision: true })],
      isLoading: false,
      error: null,
    });
    render(<NotesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />);
    for (const el of [screen.getByTitle('Decision'), screen.getByLabelText('Unmark as decision')]) {
      expect(el.querySelector('svg')).toBeTruthy();
      expect(el.textContent).not.toContain('⚖');
    }
  });
});
