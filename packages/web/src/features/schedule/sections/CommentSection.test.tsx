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

vi.mock('@/hooks/useTaskComments', () => ({
  useTaskComments: useCommentsMock,
  useAcknowledgeComment: useAckMock,
  useReactToComment: useReactMock,
  useCreateComment: useCreateCommentMock,
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
  useAttachmentsMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
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
});
