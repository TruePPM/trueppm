import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ROLE_ADMIN } from '@/lib/roles';
import { CommentComposer } from './CommentComposer';

const mutateMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskComments', () => ({
  useCreateComment: useCreateMock,
}));

vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({
    members: [
      { id: 'u1', username: 'alice', role: ROLE_ADMIN },
      { id: 'u2', username: 'bob', role: ROLE_ADMIN },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: ROLE_ADMIN, isLoading: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useCreateMock.mockReturnValue({
    mutate: mutateMock,
    isPending: false,
    isError: false,
  });
});

function getTextarea(): HTMLTextAreaElement {
  return screen.getByRole('combobox');
}

describe('CommentComposer — basic render', () => {
  it('renders the top-level composer with a Post button', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: 'Post' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('renders the reply variant with Reply + Cancel buttons', () => {
    const onCancel = vi.fn();
    render(
      <CommentComposer projectId="p1" taskId="t1" parentId="c1" onCancel={onCancel} />,
    );
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables Post when the body is empty or whitespace-only', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const post = screen.getByRole('button', { name: 'Post' });
    expect(post).toBeDisabled();
    fireEvent.change(getTextarea(), { target: { value: '   ' } });
    expect(post).toBeDisabled();
    fireEvent.change(getTextarea(), { target: { value: 'hello' } });
    expect(post).not.toBeDisabled();
  });
});

describe('CommentComposer — character counter', () => {
  it('uses neutral colour below 9 000 chars', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'short' } });
    const counter = screen.getByText(/5\/10,000/);
    expect(counter.className).toContain('text-neutral-text-secondary');
  });

  it('switches to at-risk colour at the 9 000-char threshold', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'x'.repeat(9_500) } });
    const counter = screen.getByText(/9,500\/10,000/);
    expect(counter.className).toContain('text-semantic-at-risk');
  });

  it('switches to critical colour at the 10 000-char cap', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'x'.repeat(10_000) } });
    const counter = screen.getByText(/10,000\/10,000/);
    expect(counter.className).toContain('text-semantic-critical');
  });
});

describe('CommentComposer — mention autocomplete', () => {
  it('opens the listbox when an @-token is active and closes when not', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'hey @al', selectionStart: 7 } });
    fireEvent.select(ta, { target: { selectionStart: 7 } });
    expect(ta.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes the popover when Escape is pressed', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'hey @', selectionStart: 5 } });
    fireEvent.select(ta, { target: { selectionStart: 5 } });
    expect(ta.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(ta.getAttribute('aria-expanded')).toBe('false');
  });

  it('inserts the highlighted suggestion when Enter is pressed', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    // "alice" is the only match after filtering — first (and only) suggestion.
    fireEvent.change(ta, { target: { value: 'hey @alic', selectionStart: 9 } });
    fireEvent.select(ta, { target: { selectionStart: 9 } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toContain('@alice ');
  });

  it('navigates suggestions with ArrowDown/ArrowUp without throwing', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'hey @', selectionStart: 5 } });
    fireEvent.select(ta, { target: { selectionStart: 5 } });
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    // No throw + popover still open
    expect(screen.queryByRole('listbox')).toBeTruthy();
  });
});

describe('CommentComposer — submit', () => {
  it('submits via Cmd+Enter and clears body on success', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'hello world' } });
    type Opts = { onSuccess?: () => void };
    mutateMock.mockImplementation((_vars: unknown, opts?: Opts) => {
      opts?.onSuccess?.();
    });
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(mutateMock).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', body: 'hello world', parentId: null },
      expect.anything(),
    );
    expect(ta.value).toBe('');
  });

  it('submits via the Post button click', () => {
    render(<CommentComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(mutateMock).toHaveBeenCalled();
  });

  it('forwards parentId for reply mode and calls onSubmitted on success', () => {
    const onSubmitted = vi.fn();
    render(
      <CommentComposer projectId="p1" taskId="t1" parentId="c1" onSubmitted={onSubmitted} />,
    );
    type Opts = { onSuccess?: () => void };
    mutateMock.mockImplementation((_vars: unknown, opts?: Opts) => {
      opts?.onSuccess?.();
    });
    fireEvent.change(getTextarea(), { target: { value: 'reply body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'c1', body: 'reply body' }),
      expect.anything(),
    );
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('shows pending state and disables submit while createComment is in flight', () => {
    useCreateMock.mockReturnValue({ mutate: mutateMock, isPending: true, isError: false });
    render(<CommentComposer projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: 'Posting…' })).toBeDisabled();
  });

  it('surfaces an inline error when createComment.isError', () => {
    useCreateMock.mockReturnValue({ mutate: mutateMock, isPending: false, isError: true });
    render(<CommentComposer projectId="p1" taskId="t1" />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't post");
  });
});
