import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesComposer } from './NotesComposer';

const mutateMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskNotes', () => ({
  useCreateNote: useCreateMock,
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
  return screen.getByLabelText('Note body');
}

describe('NotesComposer — basic render', () => {
  it('renders the textarea and an Add note button', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    expect(getTextarea()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();
  });
});

describe('NotesComposer — submit gating', () => {
  it('disables Add note when the body is empty or whitespace-only', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    const add = screen.getByRole('button', { name: 'Add note' });
    expect(add).toBeDisabled();
    fireEvent.change(getTextarea(), { target: { value: '   ' } });
    expect(add).toBeDisabled();
  });

  it('enables Add note after typing real content', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'a real decision' } });
    expect(screen.getByRole('button', { name: 'Add note' })).not.toBeDisabled();
  });
});

describe('NotesComposer — Escape does not destroy unstaged text (#2153)', () => {
  it('swallows Escape while non-empty so it never reaches the drawer close guard', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    const onDocEsc = vi.fn();
    document.addEventListener('keydown', onDocEsc);
    try {
      fireEvent.change(getTextarea(), { target: { value: 'a half-written decision' } });
      fireEvent.keyDown(getTextarea(), { key: 'Escape' });
      expect(onDocEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocEsc);
    }
  });

  it('lets Escape through when empty', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    const onDocEsc = vi.fn();
    document.addEventListener('keydown', onDocEsc);
    try {
      fireEvent.keyDown(getTextarea(), { key: 'Escape' });
      expect(onDocEsc).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocEsc);
    }
  });
});

describe('NotesComposer — character counter', () => {
  it('reflects the typed length', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'short' } });
    expect(screen.getByText('5/10,000')).toBeTruthy();
  });

  it('formats the at-risk count with a thousands separator', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'x'.repeat(9_500) } });
    expect(screen.getByText('9,500/10,000')).toBeTruthy();
  });
});

describe('NotesComposer — submit', () => {
  it('calls mutate with the project, task, and body when Add note is clicked', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    fireEvent.change(getTextarea(), { target: { value: 'decision body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(mutateMock).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', body: 'decision body' },
      expect.anything(),
    );
  });

  it('submits via Cmd+Enter (metaKey) and clears the body on success', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'keyboard note' } });
    type Opts = { onSuccess?: () => void };
    mutateMock.mockImplementation((_vars: unknown, opts?: Opts) => {
      opts?.onSuccess?.();
    });
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(mutateMock).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', body: 'keyboard note' },
      expect.anything(),
    );
    expect(ta.value).toBe('');
  });

  it('submits via Ctrl+Enter as well', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: 'ctrl note' } });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(mutateMock).toHaveBeenCalled();
  });

  it('does not submit on Cmd+Enter when the body is empty', () => {
    render(<NotesComposer projectId="p1" taskId="t1" />);
    fireEvent.keyDown(getTextarea(), { key: 'Enter', metaKey: true });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('shows the pending label and disables Add note while the create is in flight', () => {
    useCreateMock.mockReturnValue({ mutate: mutateMock, isPending: true, isError: false });
    render(<NotesComposer projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  });

  it('surfaces an inline error when the create fails', () => {
    useCreateMock.mockReturnValue({ mutate: mutateMock, isPending: false, isError: true });
    render(<NotesComposer projectId="p1" taskId="t1" />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't add note");
  });
});
