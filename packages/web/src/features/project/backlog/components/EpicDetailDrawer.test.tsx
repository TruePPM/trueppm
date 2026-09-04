import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import { EpicDetailDrawer } from './EpicDetailDrawer';
import { axiosRefusal } from '@/test/axiosError';

// EpicDetailDrawer batches its name/description edits through usePatchEpic; mock the hook
// so the test controls the outcome and asserts the batched PATCH payload.
const h = vi.hoisted(() => {
  const mutate =
    vi.fn<
      (
        vars: { epicId: string; patch: { name?: string; notes?: string } },
        opts?: { onSuccess?: () => void },
      ) => void
    >();
  return {
    mutate,
    state: { mutate, isPending: false, isError: false, error: null as unknown },
  };
});

vi.mock('../hooks/useProductBacklog', () => ({
  usePatchEpic: () => h.state,
}));

function makeEpic(overrides: Partial<Task> = {}): Task {
  return {
    id: 'EP1',
    name: 'Platform Core',
    notes: 'Foundational platform work.',
    // A real 8-hex-digit value, never a pretty fake like 'PROJ-EP1' — that
    // shape is exactly what hid the #2671 raw-hex leak (it already looks like
    // a nice identifier, so a render bug dumping the raw field passed silently).
    shortId: '00000005',
    shortIdDisplay: 'T-5',
    qualifiedId: 'PROJ-5',
    taskType: 'epic',
    canEdit: true,
    ...overrides,
  } as unknown as Task;
}

function renderDrawer(epic: Task, onClose = vi.fn()) {
  return render(<EpicDetailDrawer projectId="p1" epic={epic} onClose={onClose} />);
}

// Controlled inputs re-render on every keystroke, so char-by-char userEvent.type can drop
// trailing characters under CI contention — set the value in one change event instead.
function setValue(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.isPending = false;
  h.state.isError = false;
  h.state.error = null;
  // Default: resolve immediately so a Save commits the new snapshot (clears dirty).
  h.mutate.mockImplementation((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
});

describe('EpicDetailDrawer (#1346)', () => {
  it('renders the name + description and shows no Save bar until dirty', () => {
    renderDrawer(makeEpic());
    expect(screen.getByLabelText('Epic name')).toHaveValue('Platform Core');
    expect(screen.getByLabelText('Epic description')).toHaveValue('Foundational platform work.');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders the server-decoded reference in the header, never the raw hex short_id (#2671)', () => {
    renderDrawer(makeEpic());
    expect(screen.getByText('PROJ-5')).toBeInTheDocument();
    expect(screen.queryByText('00000005')).not.toBeInTheDocument();
  });

  it('shows the deferred Save bar and PATCHes only the changed description', async () => {
    const user = userEvent.setup();
    renderDrawer(makeEpic());

    setValue(
      screen.getByLabelText('Epic description'),
      'Foundational platform work. Now with SSO.',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0][0]).toEqual({
      epicId: 'EP1',
      patch: { notes: 'Foundational platform work. Now with SSO.' },
    });
  });

  it('PATCHes only the changed name (description untouched)', async () => {
    const user = userEvent.setup();
    renderDrawer(makeEpic());

    setValue(screen.getByLabelText('Epic name'), 'Platform Core & SSO');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(h.mutate.mock.calls[0][0]).toEqual({
      epicId: 'EP1',
      patch: { name: 'Platform Core & SSO' },
    });
  });

  it('Enter in the name field commits the batched edit (quick rename)', () => {
    renderDrawer(makeEpic());

    const name = screen.getByLabelText('Epic name');
    setValue(name, 'Platform Core & SSO');
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0][0]).toEqual({
      epicId: 'EP1',
      patch: { name: 'Platform Core & SSO' },
    });
  });

  it('a Save commits the snapshot so the bar clears and re-edit only sends new changes', async () => {
    const user = userEvent.setup();
    renderDrawer(makeEpic());

    setValue(screen.getByLabelText('Epic name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // onSuccess snapshotted the draft → no longer dirty → no Save bar.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('Cancel reverts the edits and hides the Save bar without mutating', async () => {
    const user = userEvent.setup();
    renderDrawer(makeEpic());

    setValue(screen.getByLabelText('Epic description'), 'throwaway edit');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Epic description')).toHaveValue('Foundational platform work.');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('blanking the name disables Save and shows "Name is required", protecting a description edit', () => {
    renderDrawer(makeEpic());

    // Edit the description (valid) but also blank the name.
    setValue(screen.getByLabelText('Epic description'), 'New scope.');
    setValue(screen.getByLabelText('Epic name'), '   ');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("surfaces the SERVER's refusal, and no retry advice on a 403 (#3332)", () => {
    h.state.isError = true;
    h.state.error = axiosRefusal(403, { detail: 'Only the PO can rename an epic.' });
    renderDrawer(makeEpic());

    setValue(screen.getByLabelText('Epic description'), 'edited');
    const alert = screen.getByTestId('dialog-footer-error');
    expect(alert).toHaveTextContent('Only the PO can rename an epic.');
    // The hardcoded "Save failed" this slot used to render discarded the sentence
    // above — the one thing that tells the PO why, and who can.
    expect(alert).not.toHaveTextContent('Save failed');
  });

  it('falls back to a plain sentence when the failure carries no readable body', () => {
    h.state.isError = true;
    h.state.error = new Error('Network Error');
    renderDrawer(makeEpic());

    setValue(screen.getByLabelText('Epic description'), 'edited');
    expect(screen.getByTestId('dialog-footer-error')).toHaveTextContent("Couldn't save the epic.");
  });

  it('closing while dirty opens the styled discard dialog and Keep editing keeps the drawer open', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeEpic(), onClose);

    setValue(screen.getByLabelText('Epic description'), 'edited');
    await user.click(screen.getByRole('button', { name: 'Close epic detail' }));

    // The discard prompt is the focus-trapped ConfirmDiscardDialog (issue 1357),
    // not the native window.confirm — assert on its role + copy.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Discard unsaved changes?');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closing while dirty then Discard changes closes the drawer', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeEpic(), onClose);

    setValue(screen.getByLabelText('Epic description'), 'edited');
    await user.click(screen.getByRole('button', { name: 'Close epic detail' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing while clean closes immediately without a discard dialog', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeEpic(), onClose);

    await user.click(screen.getByRole('button', { name: 'Close epic detail' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
