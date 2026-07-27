import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectLabelsPage } from './ProjectLabelsPage';
import type { Label } from '@/hooks/useLabels';
import { LABEL_COLOR_KEYS } from '@/lib/labelColors';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';

const useProjectId = vi.fn();
const useCurrentUserRole = vi.fn();
const useLabels = vi.fn();
const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();
/** Toggled by the in-flight-create test; reset in beforeEach. */
let createPending = false;

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: (id: string | undefined) => useCurrentUserRole(id) as unknown,
}));

vi.mock('@/hooks/useLabels', () => ({
  useLabels: (id: string | undefined) => useLabels(id) as unknown,
  useCreateLabel: () => ({ mutate: createMutate, isPending: createPending }),
  useUpdateLabel: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteLabel: () => ({ mutate: deleteMutate, isPending: false }),
}));

function label(over: Partial<Label> = {}): Label {
  return {
    id: 'l-1',
    name: 'bug',
    color: LABEL_COLOR_KEYS[0],
    position: 0,
    serverVersion: 1,
    taskCount: 0,
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/labels']}>
        <Routes>
          <Route path="/projects/:projectId/settings/labels" element={<ProjectLabelsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createPending = false;
  useProjectId.mockReturnValue('p-1');
  useLabels.mockReturnValue({ data: [], isLoading: false });
});

describe('ProjectLabelsPage', () => {
  it('shows the loading state', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({ data: [], isLoading: true });
    renderPage();
    expect(screen.getByText(/Loading labels/)).toBeInTheDocument();
  });

  it('empty state invites a creator to add one', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    expect(screen.getByText(/No labels yet/)).toBeInTheDocument();
    expect(screen.getByText(/Create one below/)).toBeInTheDocument();
  });

  it('empty state tells a Viewer they cannot create', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_VIEWER });
    renderPage();
    expect(screen.getByText(/An admin or team member can create one/)).toBeInTheDocument();
    // Viewers get no create form.
    expect(screen.queryByTestId('label-create-add')).not.toBeInTheDocument();
  });

  it('Admin sees an editable manager row and can rename, reorder and delete', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [label({ id: 'l-1', name: 'bug', position: 0 }), label({ id: 'l-2', name: 'debt', position: 1 })],
      isLoading: false,
    });
    renderPage();

    // Rename commits on blur.
    const nameInput = screen.getByTestId('label-name-l-1');
    fireEvent.change(nameInput, { target: { value: 'defect' } });
    fireEvent.blur(nameInput);
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ labelId: 'l-1', name: 'defect' }));

    // Reorder: first row's move-up is disabled; move-down swaps positions.
    expect(screen.getByRole('button', { name: /Move bug up/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Move bug down/ }));
    expect(updateMutate).toHaveBeenCalled();

    // Delete is a two-step confirm.
    fireEvent.click(screen.getByTestId('label-delete-l-1'));
    fireEvent.click(screen.getByTestId('label-delete-confirm-l-1'));
    expect(deleteMutate).toHaveBeenCalledWith('l-1');
  });

  it('delete-confirm quantifies usage from task_count (pluralized, zero hidden)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [
        label({ id: 'l-1', name: 'bug', position: 0, taskCount: 3 }),
        label({ id: 'l-2', name: 'debt', position: 1, taskCount: 1 }),
        label({ id: 'l-3', name: 'idea', position: 2, taskCount: 0 }),
      ],
      isLoading: false,
    });
    renderPage();

    // The confirm strip is an in-flow labeled group (not a focus-trapping
    // alertdialog): it appears inline, doesn't move focus, has no Escape handling.
    fireEvent.click(screen.getByTestId('label-delete-l-1'));
    expect(screen.getByRole('group', { name: /Delete bug\?/ })).toHaveTextContent(
      /Used on 3 tasks/,
    );

    fireEvent.click(screen.getByTestId('label-delete-l-2'));
    expect(screen.getByRole('group', { name: /Delete debt\?/ })).toHaveTextContent(
      /Used on 1 task —/,
    );

    fireEvent.click(screen.getByTestId('label-delete-l-3'));
    expect(screen.getByRole('group', { name: /Delete idea\?/ })).toHaveTextContent(
      /not used on any tasks/,
    );
  });

  it('Member sees existing labels read-only (no rename/delete controls)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    useLabels.mockReturnValue({ data: [label({ id: 'l-1', name: 'bug' })], isLoading: false });
    renderPage();
    expect(screen.getByText('bug')).toBeInTheDocument();
    // Curation controls are Admin-only.
    expect(screen.queryByTestId('label-name-l-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('label-delete-l-1')).not.toBeInTheDocument();
    // ...but a Member can still create.
    expect(screen.getByTestId('label-create-add')).toBeInTheDocument();
  });

  it('creating a label passes the trimmed name and selected color', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: '  frontend  ' } });
    fireEvent.click(screen.getByTestId('label-create-add'));
    expect(createMutate).toHaveBeenCalledWith({ name: 'frontend', color: LABEL_COLOR_KEYS[0] });
  });

  it('the Add button carries an unambiguous accessible name', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    // Anchored /^add$/i must NOT match — it collides with the Members invite form
    // on the stacked settings page (regression guard for the strict-mode E2E break).
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add label' })).toBeInTheDocument();
  });

  it('wraps its body in the padded content container so nothing is clipped (issue 1988)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    // The create row must sit inside the standard px-6 body wrapper — without it the
    // list + "New label" row render flush to the scroll-container edges (clipped right
    // behind the scrollbar gutter, misaligned left with the title strip).
    const body = screen.getByTestId('label-create-name').closest('.px-6');
    expect(body).not.toBeNull();
  });

  it('exposes a section-level contextual-help trigger (#2266)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_VIEWER });
    renderPage();
    // Reachable even for a read-only Viewer — the ⓘ lives in the page title strip,
    // not behind an edit control.
    expect(screen.getByRole('button', { name: /About the Labels options/i })).toBeInTheDocument();
  });

  it('treats an unresolved catalog (data undefined) as empty rather than crashing', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    // TanStack Query yields `data: undefined` on the first settled-but-empty read;
    // the `= []` default keeps the page on its empty state instead of throwing.
    useLabels.mockReturnValue({ data: undefined, isLoading: false });
    renderPage();
    expect(screen.getByText(/No labels yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('labels-manager-list')).not.toBeInTheDocument();
  });

  it('breaks a position tie by name so equal positions still order deterministically', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [
        label({ id: 'l-z', name: 'zeta', position: 5 }),
        label({ id: 'l-a', name: 'alpha', position: 5 }),
      ],
      isLoading: false,
    });
    renderPage();
    const names = screen
      .getAllByRole('textbox')
      .map((el) => (el as HTMLInputElement).value)
      .filter((v) => v !== '');
    expect(names).toEqual(['alpha', 'zeta']);
    // Tie-break also decides which row is first (its Move up is disabled).
    expect(screen.getByRole('button', { name: /Move alpha up/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move zeta up/ })).toBeEnabled();
  });

  it('moving a row up swaps positions with the row above it', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [
        label({ id: 'l-1', name: 'bug', position: 0 }),
        label({ id: 'l-2', name: 'debt', position: 1 }),
      ],
      isLoading: false,
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Move debt up/ }));
    // Two PATCHes: the moved label takes the neighbor's position and vice versa.
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 'l-2', position: 0 }),
    );
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 'l-1', position: 1 }),
    );
  });

  it('the last row cannot be moved down', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [
        label({ id: 'l-1', name: 'bug', position: 0 }),
        label({ id: 'l-2', name: 'debt', position: 1 }),
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByRole('button', { name: /Move debt down/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move bug down/ })).toBeEnabled();
  });

  it('does not PATCH when a rename blur leaves the name unchanged', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({ data: [label({ id: 'l-1', name: 'bug' })], isLoading: false });
    renderPage();
    const nameInput = screen.getByTestId('label-name-l-1');
    // Same text, only re-typed — nothing to persist.
    fireEvent.change(nameInput, { target: { value: 'bug' } });
    fireEvent.blur(nameInput);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not PATCH when a rename blur leaves the name blank', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({ data: [label({ id: 'l-1', name: 'bug' })], isLoading: false });
    renderPage();
    const nameInput = screen.getByTestId('label-name-l-1');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);
    expect(updateMutate).not.toHaveBeenCalled();
    // The draft is kept on screen so the edit is not silently discarded.
    expect(screen.getByTestId<HTMLInputElement>('label-name-l-1').value).toBe('   ');
  });

  it('trims a renamed label before PATCHing it', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({ data: [label({ id: 'l-1', name: 'bug' })], isLoading: false });
    renderPage();
    const nameInput = screen.getByTestId('label-name-l-1');
    fireEvent.change(nameInput, { target: { value: '  defect  ' } });
    fireEvent.blur(nameInput);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 'l-1', name: 'defect' }),
    );
  });

  it('the color dot toggles a swatch picker open and closed', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [label({ id: 'l-1', name: 'bug', color: 'slate' })],
      isLoading: false,
    });
    renderPage();
    // Closed by default — the row shows the dot only. (The create row below has
    // its own always-visible picker, so scope the query to this row.)
    const row = within(screen.getByTestId('label-row-l-1'));
    expect(row.queryByRole('radiogroup', { name: 'Label color' })).not.toBeInTheDocument();

    const dot = screen.getByRole('button', { name: 'Change color for bug' });
    fireEvent.click(dot);
    expect(row.getByRole('radiogroup', { name: 'Label color' })).toBeInTheDocument();
    // The label's current color is the checked swatch; the others are not.
    expect(row.getByRole('radio', { name: 'Slate' })).toBeChecked();
    expect(row.getByRole('radio', { name: 'Teal' })).not.toBeChecked();

    fireEvent.click(dot);
    expect(row.queryByRole('radiogroup', { name: 'Label color' })).not.toBeInTheDocument();
  });

  it('picking a swatch PATCHes the new color and closes the picker', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: [label({ id: 'l-1', name: 'bug', color: 'slate', position: 2 })],
      isLoading: false,
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Change color for bug' }));
    const row = within(screen.getByTestId('label-row-l-1'));
    fireEvent.click(row.getByRole('radio', { name: 'Rose' }));
    expect(updateMutate).toHaveBeenCalledWith({
      labelId: 'l-1',
      name: 'bug',
      color: 'rose',
      position: 2,
    });
    // Picking commits and collapses the picker back to the dot.
    expect(row.queryByRole('radiogroup', { name: 'Label color' })).not.toBeInTheDocument();
  });

  it('cancelling the delete confirmation keeps the label', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({ data: [label({ id: 'l-1', name: 'bug' })], isLoading: false });
    renderPage();
    fireEvent.click(screen.getByTestId('label-delete-l-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Delete bug\?/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('label-row-l-1')).toBeInTheDocument();
  });

  it('Enter in the create field submits the label', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    const input = screen.getByTestId('label-create-name');
    fireEvent.change(input, { target: { value: 'infra' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createMutate).toHaveBeenCalledWith({ name: 'infra', color: LABEL_COLOR_KEYS[0] });
  });

  it('a non-Enter key in the create field does not submit', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    const input = screen.getByTestId('label-create-name');
    fireEvent.change(input, { target: { value: 'infra' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('Enter on a blank create field is a no-op', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    const input = screen.getByTestId('label-create-name');
    // Whitespace only — trims to empty, so there is nothing to create.
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('label-create-add')).toBeDisabled();
  });

  it('creating with a chosen swatch sends that color and resets the form', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    const picker = screen.getByRole('radiogroup', { name: 'Label color' });
    // Default selection is the first palette key.
    expect(screen.getByRole('radio', { name: 'Slate' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Purple' }));
    expect(screen.getByRole('radio', { name: 'Purple' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Slate' })).not.toBeChecked();
    expect(picker).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: 'infra' } });
    fireEvent.click(screen.getByTestId('label-create-add'));
    expect(createMutate).toHaveBeenCalledWith({ name: 'infra', color: 'purple' });

    // Form resets: name cleared, color back to the palette default.
    expect(screen.getByTestId<HTMLInputElement>('label-create-name').value).toBe('');
    expect(screen.getByRole('radio', { name: 'Slate' })).toBeChecked();
    expect(screen.getByTestId('label-create-add')).toBeDisabled();
  });

  it('disables Add while a create is in flight, even with a valid name', () => {
    createPending = true;
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    renderPage();
    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: 'infra' } });
    expect(screen.getByTestId('label-create-add')).toBeDisabled();
  });

  it('hides the create form and shows the cap message at the soft limit', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN });
    useLabels.mockReturnValue({
      data: Array.from({ length: 50 }, (_, i) => label({ id: `l-${i}`, name: `n${i}`, position: i })),
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText(/Label limit reached \(50\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('label-create-add')).not.toBeInTheDocument();
  });
});
