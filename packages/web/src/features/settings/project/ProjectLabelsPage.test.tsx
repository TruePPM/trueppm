import { render, screen, fireEvent } from '@testing-library/react';
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

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: (id: string | undefined) => useCurrentUserRole(id) as unknown,
}));

vi.mock('@/hooks/useLabels', () => ({
  useLabels: (id: string | undefined) => useLabels(id) as unknown,
  useCreateLabel: () => ({ mutate: createMutate, isPending: false }),
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
