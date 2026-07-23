import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceProgramsPage } from './WorkspaceProgramsPage';

const usePrograms = vi.fn();
const useCurrentUser = vi.fn();
const useWorkspaceSettings = vi.fn();

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => usePrograms() as { data: unknown; isLoading: boolean; error: Error | null },
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUser() as { user: unknown; isLoading: boolean },
}));
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings() as { data: unknown },
}));
vi.mock('@/hooks/useBulkProgramFields', () => ({
  useBulkProgramFields: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ updated: [], fields: [] }),
    isPending: false,
  }),
}));

// A minimal Program row — the page only reads the methodology/iteration/risk fields.
function program(over: Record<string, unknown> = {}) {
  return {
    id: 'pg-1',
    name: 'Apollo',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    risk_slip_propagation: 'warn',
    risk_escalation_days: 3,
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceProgramsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WorkspaceProgramsPage', () => {
  beforeEach(() => {
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'suggest' } });
    useCurrentUser.mockReturnValue({ user: { workspace_role: 300 }, isLoading: false });
  });

  it('renders skeleton while loading', () => {
    usePrograms.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage();
    expect(screen.getByLabelText(/Loading programs/i)).toBeInTheDocument();
  });

  it('renders error state when query fails', () => {
    usePrograms.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load programs/i);
  });

  it('renders empty state when the workspace has no programs', () => {
    usePrograms.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText(/No programs in this workspace yet/i)).toBeInTheDocument();
  });

  it('renders programs through the bulk-edit matrix for a workspace admin', () => {
    usePrograms.mockReturnValue({
      data: [program({ id: 'pg-1', name: 'Apollo' }), program({ id: 'pg-2', name: 'Gemini' })],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('Apollo')).toBeInTheDocument();
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByText(/2 programs/)).toBeInTheDocument();
    expect(screen.getByTestId('bulk-fields-action-bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Apollo')).toBeInTheDocument();
  });

  it('offers all four workspace-scope fields in the picker when methodology is unlocked', () => {
    usePrograms.mockReturnValue({ data: [program()], isLoading: false, error: null });
    renderPage();
    const picker = screen.getByLabelText('Field to set');
    const options = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Methodology', 'Iteration label', 'Slip propagation', 'Escalation days']);
  });

  it('drops methodology from the picker under a workspace inherit lock (web-rule 196)', () => {
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'inherit' } });
    usePrograms.mockReturnValue({ data: [program()], isLoading: false, error: null });
    renderPage();
    const picker = screen.getByLabelText('Field to set');
    const options = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(options).not.toContain('Methodology');
    expect(options).toEqual(['Iteration label', 'Slip propagation', 'Escalation days']);
    // Methodology is still shown as a read-only column header (not in the picker).
    expect(screen.getByText('Methodology')).toBeInTheDocument();
  });

  it('hides the action bar for a non-admin workspace member (read-only)', () => {
    useCurrentUser.mockReturnValue({ user: { workspace_role: 100 }, isLoading: false });
    usePrograms.mockReturnValue({ data: [program()], isLoading: false, error: null });
    renderPage();
    expect(screen.queryByTestId('bulk-fields-action-bar')).not.toBeInTheDocument();
    // No per-row selection checkbox without edit rights.
    expect(screen.queryByLabelText('Select Apollo')).not.toBeInTheDocument();
  });

  it('exposes a section-level FieldHelp ⓘ explaining the policy columns, deep-linking to the docs (#2266)', async () => {
    const user = userEvent.setup();
    usePrograms.mockReturnValue({ data: [program()], isLoading: false, error: null });
    renderPage();

    const trigger = screen.getByRole('button', {
      name: /About the Program policy fields options/i,
    });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /Program policy fields/i });
    const learnMore = within(dialog).getByRole('link', { name: /Learn more/i });
    expect(learnMore).toHaveAttribute('href', expect.stringContaining('workspace-settings'));
  });
});
