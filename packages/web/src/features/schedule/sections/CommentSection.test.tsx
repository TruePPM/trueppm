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

  it('marks both attachment chips with the paperclip SVG, not the 📎 emoji', () => {
    useAttachmentsMock.mockReturnValue({
      attachments: [attachment('00000000-0000-4000-8000-000000000001', 'rfi.pdf')],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ body: 'live [[attachment:00000000-0000-4000-8000-000000000001]]' }),
        comment({ id: 'c9', body: 'gone [[attachment:00000000-0000-4000-8000-deadbeef0001]]' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    for (const chip of [
      screen.getByTitle('Attachment: rfi.pdf'),
      screen.getByText(/deleted attachment/),
    ]) {
      expect(chip.querySelector('svg')).toBeTruthy();
      expect(chip.textContent).not.toContain('📎');
    }
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
    // Exact args — no `reactionId` key means the mutation POSTs a new reaction.
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 't1',
      commentId: 'c1',
      emoji: '👍',
    });
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

  it('confirms before deleting a top-level comment that has replies (#2171)', () => {
    const mutate = vi.fn();
    useDeleteCommentMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    // Two Delete buttons (parent + reply). The parent's Delete opens a confirm
    // instead of firing immediately.
    fireEvent.click(screen.getAllByLabelText('Delete this comment')[0]);
    expect(mutate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('alertdialog', { name: /Confirm delete comment with replies/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ commentId: 'p1c' }));
  });

  it('deletes a reply immediately with no confirm (matches flat Notes) (#2171)', () => {
    const mutate = vi.fn();
    useDeleteCommentMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    // The reply's Delete (second button) fires straight away — no alertdialog.
    fireEvent.click(screen.getAllByLabelText('Delete this comment')[1]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ commentId: 'r1' }));
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

// ---------------------------------------------------------------------------
// Body rendering edge branches — the segment splitter has boundary cases that
// only show up when a ref/mention sits at position 0 or runs to end-of-string.
// ---------------------------------------------------------------------------

const ATT_ID = '00000000-0000-4000-8000-000000000001';

describe('CommentSection — body rendering boundaries', () => {
  it('renders a body that is nothing but an attachment ref (no leading/trailing text)', () => {
    useAttachmentsMock.mockReturnValue({
      attachments: [attachment(ATT_ID, 'plan.pdf')],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: `[[attachment:${ATT_ID}]]` })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Attachment: plan.pdf')).toBeInTheDocument();
  });

  it('renders two attachment refs back to back with the text between them', () => {
    const second = '00000000-0000-4000-8000-000000000002';
    useAttachmentsMock.mockReturnValue({
      attachments: [attachment(ATT_ID, 'a.pdf'), attachment(second, 'b.pdf')],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ body: `[[attachment:${ATT_ID}]] and [[attachment:${second}]] done` }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Attachment: a.pdf')).toBeInTheDocument();
    expect(screen.getByTitle('Attachment: b.pdf')).toBeInTheDocument();
    expect(screen.getByText(/done/)).toBeInTheDocument();
  });

  it('labels an external-link attachment chip by its title', () => {
    useAttachmentsMock.mockReturnValue({
      attachments: [
        {
          ...attachment(ATT_ID, ''),
          external_url: 'https://example.test/spec',
          external_title: 'Spec doc',
        },
      ],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: `see [[attachment:${ATT_ID}]]` })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Attachment: Spec doc')).toBeInTheDocument();
  });

  it('falls back to the raw URL when an external attachment has no title', () => {
    useAttachmentsMock.mockReturnValue({
      attachments: [
        {
          ...attachment(ATT_ID, ''),
          external_url: 'https://example.test/spec',
          external_title: '',
        },
      ],
      isLoading: false,
      error: null,
    });
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: `see [[attachment:${ATT_ID}]]` })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Attachment: https://example.test/spec')).toBeInTheDocument();
  });

  it('renders a comment whose body is empty without crashing the row', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: '' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    // The row still identifies its author even with nothing to render inside.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Comment by Alice/)).toBeInTheDocument();
  });

  it('highlights a mention that starts the body and runs to the very end', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: '@bob' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Mention: @bob')).toBeInTheDocument();
  });

  it('highlights every mention in a body with several of them', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'hi @ann and @bob' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByTitle('Mention: @ann')).toBeInTheDocument();
    expect(screen.getByTitle('Mention: @bob')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Inline edit — save guards, pending, and error surfaces.
// ---------------------------------------------------------------------------

function freshOwnComment(overrides: Partial<TaskComment> = {}): TaskComment {
  return comment({ created_at: new Date().toISOString(), ...overrides });
}

describe('CommentSection — inline edit branches', () => {
  it('surfaces the edit-window error when the update mutation failed', () => {
    useUpdateCommentMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: true });
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    expect(screen.getByRole('alert').textContent).toContain('15-minute edit window');
  });

  it('shows "Saving…" and locks both buttons while the update is in flight', () => {
    useUpdateCommentMock.mockReturnValue({ mutate: vi.fn(), isPending: true, isError: false });
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('disables Save when the draft is whitespace only', () => {
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment({ body: 'typo' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    fireEvent.change(screen.getByLabelText('Edit comment'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses to save a draft longer than the 10 000-char cap', () => {
    const mutate = vi.fn();
    useUpdateCommentMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment({ body: 'short' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    fireEvent.change(screen.getByLabelText('Edit comment'), {
      target: { value: 'x'.repeat(10_001) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('Cancel discards the draft and restores the original body', () => {
    const mutate = vi.fn();
    useUpdateCommentMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment({ body: 'original text' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    fireEvent.change(screen.getByLabelText('Edit comment'), { target: { value: 'scrapped' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Edit comment')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    // Re-opening the editor shows the server body again, not the discarded draft.
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Edit comment').value).toBe('original text');
  });

  it('closes the editor once the save succeeds', () => {
    const mutate = vi.fn(
      (
        _vars: { projectId: string; taskId: string; commentId: string; body: string },
        opts?: { onSuccess?: () => void },
      ) => opts?.onSuccess?.(),
    );
    useUpdateCommentMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment({ body: 'typo here' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    fireEvent.change(screen.getByLabelText('Edit comment'), { target: { value: 'fixed now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    // Editor collapses back to the read view; the action bar returns.
    expect(screen.queryByLabelText('Edit comment')).toBeNull();
    expect(screen.getByLabelText('Acknowledge this comment')).toBeInTheDocument();
  });

  it('hides the whole action bar while the editor is open', () => {
    useCommentsMock.mockReturnValue({
      comments: [freshOwnComment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Edit this comment'));
    expect(screen.queryByLabelText('Acknowledge this comment')).toBeNull();
    expect(screen.queryByLabelText('React with 👍')).toBeNull();
    expect(screen.queryByLabelText('Delete this comment')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Action-bar branches: already-acknowledged, in-flight mutations, confirm exit.
// ---------------------------------------------------------------------------

describe('CommentSection — action bar branches', () => {
  it('un-acknowledges when the viewer already acknowledged', () => {
    const mutate = vi.fn();
    useAckMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [comment({ acknowledged_count: 3, has_my_acknowledgement: true })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    const btn = screen.getByLabelText('Remove your acknowledgement');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c1', acknowledge: false }),
    );
  });

  it('POSTs a fresh reaction when has_my_reaction is set but the id is missing', () => {
    const mutate = vi.fn();
    useReactMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      // Defensive shape: the flag is on but the server sent no reaction id.
      comments: [comment({ has_my_reaction: true, my_reaction_id: null })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Remove your 👍 reaction'));
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 't1',
      commentId: 'c1',
      emoji: '👍',
    });
  });

  it('disables ack / react / delete while their mutations are in flight', () => {
    useAckMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useReactMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useDeleteCommentMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByLabelText('Acknowledge this comment')).toBeDisabled();
    expect(screen.getByLabelText('React with 👍')).toBeDisabled();
    expect(screen.getByLabelText('Delete this comment')).toBeDisabled();
  });

  it('hides the count chips when acknowledgements and reactions are zero', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ acknowledged_count: 0, reaction_count: 0 })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByLabelText('Acknowledge this comment').textContent).toBe('✅');
    expect(screen.getByLabelText('React with 👍').textContent).toBe('👍');
  });

  it('"Keep it" dismisses the confirm without deleting (#2171)', () => {
    const mutate = vi.fn();
    useDeleteCommentMock.mockReturnValue({ mutate, isPending: false });
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getAllByLabelText('Delete this comment')[0]);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('closes the reply composer when it is cancelled', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment()],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByLabelText('Reply to this comment'));
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('gives a reply row no Reply button — nesting stops at one level', () => {
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getAllByLabelText('Reply to this comment')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Viewer-permission branches on the section itself.
// ---------------------------------------------------------------------------

describe('CommentSection — permission branches', () => {
  it('shows the read-only empty copy and no composer for a non-editor', () => {
    useCommentsMock.mockReturnValue({ comments: [], isLoading: false, error: null });
    render(<CommentSection taskId="t1" projectId="p1" canEdit={false} />);
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('hides every write affordance from a non-editor viewing an existing thread', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ body: 'read me' })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit={false} />);
    expect(screen.getByText('read me')).toBeInTheDocument();
    expect(screen.queryByLabelText('Acknowledge this comment')).toBeNull();
    expect(screen.queryByLabelText('React with 👍')).toBeNull();
    expect(screen.queryByLabelText('Reply to this comment')).toBeNull();
  });

  it('falls back to the client role rule when the server sent no canEdit verdict', () => {
    useCommentsMock.mockReturnValue({
      comments: [comment({ created_at: new Date().toISOString() })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" userRole={ROLE_ADMIN} />);
    // ADMIN can edit tasks → the action bar is live even with canEdit undefined.
    expect(screen.getByLabelText('Acknowledge this comment')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit this comment')).toBeInTheDocument();
  });

  it('withholds Edit and Delete while the current user is still unknown', () => {
    useCurrentUserMock.mockReturnValue({ user: undefined });
    useCommentsMock.mockReturnValue({
      comments: [comment({ created_at: new Date().toISOString() })],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByLabelText('Edit this comment')).toBeNull();
    expect(screen.queryByLabelText('Delete this comment')).toBeNull();
    // Ack/react stay available — they are not author-scoped.
    expect(screen.getByLabelText('Acknowledge this comment')).toBeInTheDocument();
  });

  it('names the list with the total comment count including replies', () => {
    useCommentsMock.mockReturnValue({
      comments: [
        comment({ id: 'p1c', body: 'parent' }),
        comment({ id: 'r1', parent: 'p1c', body: 'reply' }),
      ],
      isLoading: false,
      error: null,
    });
    render(<CommentSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('list', { name: 'Comments — 2 total' })).toBeInTheDocument();
  });
});
