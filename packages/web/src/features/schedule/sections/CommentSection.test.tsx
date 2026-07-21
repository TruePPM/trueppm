import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ROLE_ADMIN } from '@/lib/roles';
import type { TaskAttachment, TaskComment } from '@/types';
import { CommentSection } from './CommentSection';

const useCommentsMock = vi.hoisted(() => vi.fn());
const useAttachmentsMock = vi.hoisted(() => vi.fn());
const useAckMock = vi.hoisted(() => vi.fn());
const useReactMock = vi.hoisted(() => vi.fn());
const useCreateCommentMock = vi.hoisted(() => vi.fn());
const useUpdateCommentMock = vi.hoisted(() => vi.fn());
const useDeleteCommentMock = vi.hoisted(() => vi.fn());
const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskComments', () => ({
  useTaskComments: useCommentsMock,
  useAcknowledgeComment: useAckMock,
  useReactToComment: useReactMock,
  useCreateComment: useCreateCommentMock,
  useUpdateComment: useUpdateCommentMock,
  useDeleteComment: useDeleteCommentMock,
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: useCurrentUserMock,
}));

vi.mock('@/hooks/useTaskAttachments', () => ({
  useTaskAttachments: useAttachmentsMock,
}));

vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({ members: [], isLoading: false }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: ROLE_ADMIN, isLoading: false }),
}));

// #1953: CommentRow re-clocks its timestamp via useUserDateFormat (which reads
// useCurrentUser → a query). These tests render CommentRow without a
// QueryClientProvider, so stub the hook with a deterministic UTC formatter.
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({
    prefs: { timeZone: 'UTC', dateFormat: 'us' },
    formatInstant: (iso: string) => iso ?? '',
    formatInstantDate: (iso: string) => iso ?? '',
    formatInstantTime: (iso: string) => iso ?? '',
    fmtDateShort: (iso: string) => iso ?? '',
    fmtDateLong: (iso: string) => iso ?? '',
  }),
}));

// #514: CommentComposer reads useProject to decide whether to offer @program-*
// groups. These tests don't exercise mentions, so a standalone project is fine.
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { program: null } }),
}));

// #2254: CommentComposer reads useMentionGroups (a query) to surface project
// mention groups in the @ menu. These tests render without a QueryClientProvider
// and don't exercise mentions, so stub it with no groups.
vi.mock('@/features/settings/hooks/useMentionGroups', () => ({
  useMentionGroups: () => ({ data: [] }),
}));

function comment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 'c1',
    task: 't1',
    parent: null,
    author: { id: 'u1', username: 'alice', display_name: 'Alice' },
    body: 'hello world',
    edited_at: null,
    created_at: '2026-05-19T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    acknowledged_count: 0,
    reaction_count: 0,
    has_my_acknowledgement: false,
    has_my_reaction: false,
    my_reaction_id: null,
    ...overrides,
  };
}

function attachment(id: string, file_name: string): TaskAttachment {
  return {
    id,
    file: `${id}.pdf`,
    file_name,
    file_size: 1024,
    file_mime: 'application/pdf',
    external_url: '',
    external_title: '',
    is_pinned: false,
    uploaded_by: null,
    deleted_by: null,
    created_at: '2026-05-19T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAckMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useReactMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useCreateCommentMock.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  });
  useUpdateCommentMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  useDeleteCommentMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useAttachmentsMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
  // Default: the current user IS the fixture comment's author ('u1'), so the
  // author-only edit/delete affordances are reachable unless a test overrides it.
  useCurrentUserMock.mockReturnValue({ user: { id: 'u1', username: 'alice' } });
});

describe('CommentSection — list states', () => {
  it('renders the loading skeleton', () => {
    useCommentsMock.mockReturnValue({ comments: [], isLoading: true, error: null });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByLabelText('Loading comments')).toBeTruthy();
  });

  it('renders the error state', () => {
    useCommentsMock.mockReturnValue({
      comments: [],
      isLoading: false,
      error: new Error('boom'),
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load");
  });

  it('renders the empty-state copy + the composer when no comments', () => {
    useCommentsMock.mockReturnValue({ comments: [], isLoading: false, error: null });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByText('Be the first to comment.')).toBeTruthy();
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});

describe('CommentSection — comment rendering', () => {
  it('renders an author + relative timestamp + body', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'plain body' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('plain body')).toBeTruthy();
  });

  it('renders the "edited" marker when edited_at is set', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ edited_at: '2026-05-19T01:00:00Z' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByText(/edited/)).toBeTruthy();
  });

  it('renders "Unknown" when the comment author is missing', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ author: null })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('renders @mention highlight spans inside the body', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'cc @bob please review' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Mention: @bob')).toBeTruthy();
  });

  it('renders \\@name as literal (no mention highlight)', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'escaped \\@bob' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.queryByTitle('Mention: @bob')).toBeNull();
  });

  it('expands [[attachment:uuid]] into an attachment chip when the id resolves', () => {
    const att = attachment('00000000-0000-4000-8000-000000000001', 'rfi.pdf');
    useAttachmentsMock.mockReturnValue({
      attachments: [att],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'see [[attachment:00000000-0000-4000-8000-000000000001]]' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Attachment: rfi.pdf')).toBeTruthy();
  });

  it('renders the deleted-attachment placeholder when the id is missing', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'see [[attachment:00000000-0000-4000-8000-deadbeef0001]]' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByText(/deleted attachment/)).toBeTruthy();
  });
});

describe('CommentSection — interactions', () => {
  it('toggles ack on click and forwards the inverted acknowledgement state', () => {
    const mutate = vi.fn();
    useAckMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment({ acknowledged_count: 2, has_my_acknowledgement: false })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Acknowledge this comment'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c1', acknowledge: true }),
    );
  });

  it('POSTs a 👍 reaction on click', () => {
    const mutate = vi.fn();
    useReactMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment({ reaction_count: 1 })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('React with 👍'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c1', emoji: '👍' }),
    );
  });

  it('reflects a reacted state with aria-pressed and a toggle-off label (#2171)', () => {
    const mutate = vi.fn();
    useReactMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment({ reaction_count: 1, has_my_reaction: true, my_reaction_id: 'rx1' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    const btn = screen.getByLabelText('Remove your 👍 reaction');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // Clicking un-reacts: the mutation carries the reaction id to DELETE.
    fireEvent.click(btn);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c1', emoji: '👍', reactionId: 'rx1' }),
    );
  });

  it('does not send a reactionId when the user has not reacted (toggle-on) (#2171)', () => {
    const mutate = vi.fn();
    useReactMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment({ has_my_reaction: false, my_reaction_id: null })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('React with 👍'));
    expect(mutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ reactionId: expect.anything() }),
    );
  });

  it('lets the author edit their own comment within the 15-min window (#2171)', () => {
    const mutate = vi.fn();
    useUpdateCommentMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useCommentsMock.mockReturnValue({
      // Fresh comment authored by the current user (u1) → within edit window.
      comments: [comment({ created_at: new Date().toISOString(), body: 'typo here' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    const textarea = screen.getByLabelText('Edit comment');
    fireEvent.change(textarea, { target: { value: 'fixed now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c1', body: 'fixed now' }),
      expect.anything(),
    );
  });

  it('hides Edit once the 15-min window has closed (#2171)', () => {
    useCommentsMock.mockReturnValue({
      // Old fixture created_at (2026-05-19) → window long closed.
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Edit this comment')).toBeNull();
  });

  it('lets the author delete their own comment (#2171)', () => {
    const mutate = vi.fn();
    useDeleteCommentMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Delete this comment'));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ commentId: 'c1' }));
  });

  it('lets an ADMIN delete another user’s comment but not edit it (#2171)', () => {
    useCurrentUserMock.mockReturnValue({ user: { id: 'admin-9', username: 'admin' } });
    useCommentsMock.mockReturnValue({
      comments: [comment({ created_at: new Date().toISOString() })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit userRole={ROLE_ADMIN} />);
    // Delete is author-OR-admin; edit is author-only even within the window.
    expect(screen.getByLabelText('Delete this comment')).toBeTruthy();
    expect(screen.queryByLabelText('Edit this comment')).toBeNull();
  });

  it('hides Delete for a non-author, non-admin viewer (#2171)', () => {
    useCurrentUserMock.mockReturnValue({ user: { id: 'u2', username: 'bob' } });
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Delete this comment')).toBeNull();
  });

  it('groups replies under their parent and indents them', () => {
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply text' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('parent')).toBeTruthy();
    expect(screen.getByText('reply text')).toBeTruthy();
  });

  it('opens the reply composer when the Reply button is clicked', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Reply to this comment'));
    // Two composers now: top-level Post + reply composer (parentId set).
    expect(screen.getAllByRole('combobox').length).toBe(2);
  });

  it('sizes the row-action buttons to the mobile 44px touch floor (#2168)', () => {
    // jsdom can't measure rendered px; assert the responsive sizing token that
    // gives the mobile bottom-sheet controls a 44px target (md: shrinks to the
    // 28px desktop density). Reply / ack / react all share the contract.
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    for (const label of ['Reply to this comment', 'Acknowledge this comment', 'React with 👍']) {
      const btn = screen.getByLabelText(label);
      expect(btn.className).toContain('min-h-11');
      expect(btn.className).toContain('md:min-h-7');
    }
  });
});
