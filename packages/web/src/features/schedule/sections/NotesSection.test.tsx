import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { TaskNote } from '@/types';
import { NotesSection } from './NotesSection';

const useNotesMock = vi.hoisted(() => vi.fn());
const usePinMock = vi.hoisted(() => vi.fn());
const useDeleteMock = vi.hoisted(() => vi.fn());
const useUpdateMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());
const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskNotes', () => ({
  useTaskNotes: useNotesMock,
  usePinNote: usePinMock,
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
