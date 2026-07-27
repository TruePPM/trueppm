/**
 * Tests for <RiskDrawer> — the risk inspector shell (mobile modal bottom sheet
 * vs. desktop non-modal side panel), its create/edit/detail mode switching, the
 * read-only detail view's optional risk-framework fields, and the append-only
 * Notes section.
 *
 * The child surfaces (RiskForm, RiskLinkedTasksSection) are stubbed — they own
 * their own specs — so the assertions here are about the drawer's own branching.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Breakpoint } from '@/hooks/useBreakpoint';
import type { Risk, RiskComment } from '@/api/types';
import { RiskDrawer } from './RiskDrawer';

type CommentVars = { projectId: string; riskId: string; message: string };
type CommentOpts = { onSuccess: () => void; onError: () => void };

const {
  useBreakpointMock,
  useRiskCommentsMock,
  useCreateRiskCommentMock,
  createCommentMutate,
  formSuccess,
  formCancel,
} = vi.hoisted(() => ({
  useBreakpointMock: vi.fn<() => 'sm' | 'md' | 'lg'>(),
  useRiskCommentsMock: vi.fn(),
  useCreateRiskCommentMock: vi.fn(),
  createCommentMutate: vi.fn<(v: CommentVars, o: CommentOpts) => void>(),
  formSuccess: vi.fn(),
  formCancel: vi.fn(),
}));

vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: useBreakpointMock }));
vi.mock('@/hooks/useRisks', () => ({
  useRiskComments: useRiskCommentsMock,
  useCreateRiskComment: useCreateRiskCommentMock,
}));

// Stubbed children — each has its own spec; here they only need to expose the
// callbacks the drawer wires into them.
vi.mock('./RiskForm', () => ({
  RiskForm: ({
    risk,
    onSuccess,
    onCancel,
  }: {
    projectId: string;
    risk?: Risk;
    onSuccess: () => void;
    onCancel: () => void;
  }) => (
    <div>
      <p>form-mode:{risk ? 'edit' : 'create'}</p>
      <button
        type="button"
        onClick={() => {
          formSuccess();
          onSuccess();
        }}
      >
        stub-save
      </button>
      <button
        type="button"
        onClick={() => {
          formCancel();
          onCancel();
        }}
      >
        stub-cancel
      </button>
    </div>
  ),
}));

vi.mock('./RiskLinkedTasksSection', () => ({
  RiskLinkedTasksSection: () => <div>linked-tasks-stub</div>,
}));

function makeRisk(over: Partial<Risk> = {}): Risk {
  return {
    id: 'risk-1',
    short_id: '7',
    short_id_display: 'R-007',
    qualified_id: 'R-007',
    server_version: 1,
    project: 'p1',
    title: 'Vendor outage',
    description: '',
    status: 'OPEN',
    probability: 3,
    impact: 4,
    severity: 12,
    owner: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    tasks: [],
    notes: '',
    ...over,
  };
}

function makeComment(over: Partial<RiskComment> = {}): RiskComment {
  return {
    id: 'c1',
    author: { id: 'u1', display_name: 'Ada Lovelace' },
    message: 'Watching the vendor closely.',
    created_at: '2026-01-03T10:30:00Z',
    ...over,
  };
}

interface DrawerOverrides {
  risk?: Risk | null;
  isOpen?: boolean;
  initialEditing?: boolean;
  onClose?: () => void;
}

function renderDrawer(over: DrawerOverrides = {}) {
  const onClose = over.onClose ?? vi.fn();
  const result = render(
    <RiskDrawer
      projectId="p1"
      risk={over.risk === undefined ? makeRisk() : over.risk}
      isOpen={over.isOpen ?? true}
      onClose={onClose}
      initialEditing={over.initialEditing}
    />,
  );
  return { ...result, onClose };
}

function setBreakpoint(bp: Breakpoint) {
  useBreakpointMock.mockReturnValue(bp);
}

beforeEach(() => {
  vi.clearAllMocks();
  setBreakpoint('lg');
  useRiskCommentsMock.mockReturnValue({ comments: [], isLoading: false });
  useCreateRiskCommentMock.mockReturnValue({ mutate: createCommentMutate, isPending: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shell selection: desktop non-modal panel vs. mobile modal bottom sheet
// ---------------------------------------------------------------------------

describe('<RiskDrawer> shell selection', () => {
  it('renders exactly one non-modal dialog on desktop', () => {
    renderDrawer();
    const dialogs = screen.getAllByRole('dialog', { hidden: true });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAttribute('aria-modal', 'false');
  });

  it('renders exactly one modal dialog on mobile', () => {
    setBreakpoint('sm');
    renderDrawer();
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAttribute('aria-modal', 'true');
  });

  it('treats the md tier as desktop, not mobile', () => {
    setBreakpoint('md');
    renderDrawer();
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute('aria-modal', 'false');
  });

  it('shows a dismissing backdrop on mobile only while open', () => {
    setBreakpoint('sm');
    const { container, onClose } = renderDrawer({ isOpen: true });
    const backdrop = container.querySelector('div.fixed.inset-0[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the backdrop on mobile when closed', () => {
    setBreakpoint('sm');
    const { container } = renderDrawer({ isOpen: false });
    expect(container.querySelector('div.fixed.inset-0[aria-hidden="true"]')).toBeNull();
    // The sheet itself stays mounted (slid off-screen) so the transition can run.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Title + mode
// ---------------------------------------------------------------------------

describe('<RiskDrawer> title and mode', () => {
  it('labels the dialog with the risk title in read-only detail mode', () => {
    renderDrawer({ risk: makeRisk({ title: 'Vendor outage' }) });
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAccessibleName('Vendor outage');
    expect(screen.getByRole('heading', { name: 'Vendor outage' })).toBeInTheDocument();
    expect(screen.queryByText(/^form-mode:/)).not.toBeInTheDocument();
  });

  it('labels the dialog "New Risk" and shows the create form when risk is null', () => {
    renderDrawer({ risk: null });
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAccessibleName('New Risk');
    expect(screen.getByText('form-mode:create')).toBeInTheDocument();
    // No Edit affordance in create mode.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('opens straight into "Edit Risk" when initialEditing is set', () => {
    renderDrawer({ initialEditing: true });
    expect(screen.getByRole('heading', { name: 'Edit Risk' })).toBeInTheDocument();
    expect(screen.getByText('form-mode:edit')).toBeInTheDocument();
  });

  it('opens in read-only mode when initialEditing is omitted', () => {
    renderDrawer({ initialEditing: undefined });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByText(/^form-mode:/)).not.toBeInTheDocument();
  });

  it('switches to the edit form when Edit is pressed and back on cancel', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('form-mode:edit')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit Risk' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'stub-cancel' }));
    expect(screen.queryByText(/^form-mode:/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vendor outage' })).toBeInTheDocument();
  });

  it('closes the drawer after a successful save from edit mode', () => {
    const { onClose } = renderDrawer({ initialEditing: true });
    fireEvent.click(screen.getByRole('button', { name: 'stub-save' }));
    expect(formSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes the create form Cancel straight to onClose (no read-only state to fall back to)', () => {
    const { onClose } = renderDrawer({ risk: null });
    fireEvent.click(screen.getByRole('button', { name: 'stub-cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets edit mode when the drawer is re-opened', () => {
    const onClose = vi.fn();
    const risk = makeRisk();
    const { rerender } = render(
      <RiskDrawer projectId="p1" risk={risk} isOpen onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('form-mode:edit')).toBeInTheDocument();

    rerender(<RiskDrawer projectId="p1" risk={risk} isOpen={false} onClose={onClose} />);
    rerender(<RiskDrawer projectId="p1" risk={risk} isOpen onClose={onClose} />);
    expect(screen.queryByText(/^form-mode:/)).not.toBeInTheDocument();
  });

  it('supports the same edit → cancel → save cycle inside the mobile sheet', () => {
    setBreakpoint('sm');
    const { onClose } = renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('form-mode:edit')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'stub-cancel' }));
    expect(screen.queryByText(/^form-mode:/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-save' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose from the mobile header × button', () => {
    setBreakpoint('sm');
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose from the header × button', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Focus + Escape (desktop non-modal inspector)
// ---------------------------------------------------------------------------

describe('<RiskDrawer> desktop focus and Escape', () => {
  it('seats focus on the close button shortly after opening', async () => {
    renderDrawer();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus(),
    );
  });

  it('does not seat focus when the desktop panel is closed', () => {
    vi.useFakeTimers();
    try {
      renderDrawer({ isOpen: false });
      vi.advanceTimersByTime(200);
      expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on Escape while open', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not listen for Escape while closed', () => {
    const { onClose } = renderDrawer({ isOpen: false });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape on mobile via the focus trap', () => {
    setBreakpoint('sm');
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Read-only detail view
// ---------------------------------------------------------------------------

describe('<RiskDrawer> detail view', () => {
  it('renders status, the severity arithmetic, and the linked-tasks section', () => {
    renderDrawer({ risk: makeRisk({ status: 'MITIGATING', probability: 3, impact: 4, severity: 12 }) });
    expect(screen.getByText('MITIGATING')).toBeInTheDocument();
    expect(screen.getByText('P3 × I4 = 12')).toBeInTheDocument();
    expect(screen.getByText('linked-tasks-stub')).toBeInTheDocument();
  });

  it.each(['OPEN', 'MITIGATING', 'RESOLVED', 'ACCEPTED', 'CLOSED'] as const)(
    'renders the %s status badge',
    (status) => {
      renderDrawer({ risk: makeRisk({ status }) });
      expect(screen.getByText(status)).toBeInTheDocument();
    },
  );

  it('omits the Description block when the risk has none', () => {
    renderDrawer({ risk: makeRisk({ description: '' }) });
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
  });

  it('renders the Description block when present', () => {
    renderDrawer({ risk: makeRisk({ description: 'Single-source supplier.' }) });
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Single-source supplier.')).toBeInTheDocument();
  });

  it('omits every risk-framework block when none of the fields is populated', () => {
    renderDrawer({
      risk: makeRisk({
        category: null,
        response: null,
        mitigation_due_date: null,
        trigger: '',
        contingency: '',
      }),
    });
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
    expect(screen.queryByText('Response')).not.toBeInTheDocument();
    expect(screen.queryByText('Mitigation Due')).not.toBeInTheDocument();
    expect(screen.queryByText('Trigger')).not.toBeInTheDocument();
    expect(screen.queryByText('Contingency')).not.toBeInTheDocument();
  });

  it('renders only the populated risk-framework blocks', () => {
    renderDrawer({ risk: makeRisk({ trigger: 'Vendor misses a checkpoint' }) });
    expect(screen.getByText('Trigger')).toBeInTheDocument();
    expect(screen.getByText('Vendor misses a checkpoint')).toBeInTheDocument();
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
    expect(screen.queryByText('Contingency')).not.toBeInTheDocument();
  });

  it('renders the full risk-framework set with human labels and a UTC-formatted due date', () => {
    renderDrawer({
      risk: makeRisk({
        category: 'PROJECT_MANAGEMENT',
        response: 'TRANSFER',
        mitigation_due_date: '2026-03-15',
        trigger: 'Two missed checkpoints',
        contingency: 'Switch to the backup supplier',
      }),
    });
    expect(screen.getByText('Project Management')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
    // Formatted with timeZone: 'UTC' so the label does not shift by locale offset.
    expect(screen.getByText('Mar 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('Two missed checkpoints')).toBeInTheDocument();
    expect(screen.getByText('Switch to the backup supplier')).toBeInTheDocument();
  });

  it.each([
    ['TECHNICAL', 'Technical'],
    ['EXTERNAL', 'External'],
    ['ORGANIZATIONAL', 'Organizational'],
  ] as const)('maps the %s category to "%s"', (category, label) => {
    renderDrawer({ risk: makeRisk({ category }) });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    ['AVOID', 'Avoid'],
    ['MITIGATE', 'Mitigate'],
    ['ACCEPT', 'Accept'],
  ] as const)('maps the %s response to "%s"', (response, label) => {
    renderDrawer({ risk: makeRisk({ response }) });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows only the contingency block when contingency is the sole populated field', () => {
    renderDrawer({ risk: makeRisk({ contingency: 'Dual-source the valve' }) });
    expect(screen.getByText('Contingency')).toBeInTheDocument();
    expect(screen.getByText('Dual-source the valve')).toBeInTheDocument();
    expect(screen.queryByText('Trigger')).not.toBeInTheDocument();
  });

  it('shows only the mitigation-due block when the due date is the sole populated field', () => {
    renderDrawer({ risk: makeRisk({ mitigation_due_date: '2026-12-01' }) });
    expect(screen.getByText('Mitigation Due')).toBeInTheDocument();
    expect(screen.getByText('Dec 1, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Notes section
// ---------------------------------------------------------------------------

describe('<RiskDrawer> notes section', () => {
  function notesToggle() {
    return screen.getByRole('button', { name: /^Notes/ });
  }

  it('starts collapsed with no count when there are no comments', () => {
    renderDrawer();
    const toggle = notesToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/^Notes$/);
    expect(screen.queryByText('No notes yet.')).not.toBeInTheDocument();
  });

  it('expands on click and shows the empty state plus the composer', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    expect(notesToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add a note' })).toBeInTheDocument();
  });

  it('collapses again on a second click', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    fireEvent.click(notesToggle());
    expect(notesToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Add a note' })).not.toBeInTheDocument();
  });

  it('auto-expands and shows the count once comments arrive', () => {
    useRiskCommentsMock.mockReturnValue({
      comments: [
        makeComment(),
        makeComment({
          id: 'c2',
          message: 'Second note',
          author: { id: 'u2', display_name: 'Grace Hopper' },
        }),
      ],
      isLoading: false,
    });
    renderDrawer();
    expect(notesToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(notesToggle()).toHaveTextContent('Notes (2)');
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Watching the vendor closely.')).toBeInTheDocument();
    expect(screen.getByText('Second note')).toBeInTheDocument();
  });

  it('renders "Unknown" and a "?" avatar for an author-less comment', () => {
    useRiskCommentsMock.mockReturnValue({
      comments: [makeComment({ author: null })],
      isLoading: false,
    });
    renderDrawer();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('derives at most two uppercase initials from the author display name', () => {
    useRiskCommentsMock.mockReturnValue({
      comments: [
        makeComment({ id: 'a', author: { id: 'u1', display_name: 'Ada Lovelace' } }),
        makeComment({ id: 'b', author: { id: 'u2', display_name: 'cher' } }),
        makeComment({
          id: 'c',
          author: { id: 'u3', display_name: 'Mary Jane Watson' },
        }),
      ],
      isLoading: false,
    });
    renderDrawer();
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('MJ')).toBeInTheDocument();
  });

  it('suppresses the count and the empty state while comments are loading', () => {
    useRiskCommentsMock.mockReturnValue({ comments: [], isLoading: true });
    renderDrawer();
    expect(notesToggle()).toHaveTextContent(/^Notes$/);
    fireEvent.click(notesToggle());
    expect(screen.queryByText('No notes yet.')).not.toBeInTheDocument();
  });

  it('disables the submit button until the draft has non-whitespace content', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    const submit = screen.getByRole('button', { name: 'Add note' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), {
      target: { value: '   ' },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), {
      target: { value: 'Escalated' },
    });
    expect(submit).toBeEnabled();
  });

  it('posts the trimmed message and clears the draft on success', () => {
    createCommentMutate.mockImplementation((_v, opts) => {
      opts.onSuccess();
    });
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: '  Escalated to the vendor  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    expect(createCommentMutate).toHaveBeenCalledTimes(1);
    expect(createCommentMutate.mock.calls[0][0]).toEqual({
      projectId: 'p1',
      riskId: 'risk-1',
      message: 'Escalated to the vendor',
    });
    expect(textarea.value).toBe('');
  });

  it('keeps the draft and shows an alert when the post fails', () => {
    createCommentMutate.mockImplementation((_v, opts) => {
      opts.onError();
    });
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: 'Escalated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to post note. Please try again.');
    expect(textarea.value).toBe('Escalated');
  });

  it('submits on Cmd+Enter from the textarea', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: 'Quick note' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(createCommentMutate).toHaveBeenCalledTimes(1);
  });

  it('submits on Ctrl+Enter from the textarea', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: 'Quick note' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(createCommentMutate).toHaveBeenCalledTimes(1);
  });

  it('does not submit on a bare Enter or on Cmd with another key', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: 'Quick note' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'k', metaKey: true });
    expect(createCommentMutate).not.toHaveBeenCalled();
  });

  it('ignores a Cmd+Enter on a whitespace-only draft', () => {
    renderDrawer();
    fireEvent.click(notesToggle());
    const textarea = screen.getByRole('textbox', { name: 'Add a note' });
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(createCommentMutate).not.toHaveBeenCalled();
  });

  it('shows a pending label and disables the composer while the post is in flight', () => {
    useCreateRiskCommentMock.mockReturnValue({ mutate: createCommentMutate, isPending: true });
    renderDrawer();
    fireEvent.click(notesToggle());
    expect(screen.getByRole('button', { name: 'Posting…' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Add a note' })).toBeDisabled();
  });

  it('replaces the composer with an offline explanation when the browser is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderDrawer();
    fireEvent.click(notesToggle());
    expect(screen.getByText('Notes require a connection.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Add a note' })).not.toBeInTheDocument();
  });
});
