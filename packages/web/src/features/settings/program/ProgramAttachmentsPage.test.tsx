import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramAttachmentsPage } from './ProgramAttachmentsPage';
import { ROLE_ADMIN, ROLE_VIEWER } from '@/lib/roles';

const useProgram = vi.fn();
const mutateAsync = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('@/hooks/useProgramMutations', () => ({
  useUpdateProgram: () => ({ mutateAsync, isPending: false }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/attachments']}>
        <Routes>
          <Route
            path="/programs/:programId/settings/attachments"
            element={<ProgramAttachmentsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ADMIN = {
  id: 'p-1',
  my_role: ROLE_ADMIN,
  is_closed: false,
  attachments_enabled: null,
  allowed_attachment_types: null,
  inherited_attachments_enabled: true,
  inherited_allowed_attachment_types: ['application/pdf'],
  effective_attachments_enabled: true,
  effective_allowed_attachment_types: ['application/pdf'],
};

describe('ProgramAttachmentsPage (settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an editable toggle for an Admin on an open program', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    renderPage();
    expect(screen.getByRole('radiogroup', { name: 'Allow file attachments' })).toBeInTheDocument();
  });

  it('renders a read-only toggle for a non-admin', () => {
    useProgram.mockReturnValue({ data: { ...ADMIN, my_role: ROLE_VIEWER } });
    renderPage();
    expect(screen.queryByRole('radiogroup', { name: 'Allow file attachments' })).not.toBeInTheDocument();
  });

  // #2549: this page writes through ProgramViewSet.update, gated by
  // IsProgramNotClosed, so an Admin on a closed program must not see a live,
  // saveable toggle — and the page must say why the controls disappeared.
  it('renders a read-only toggle and a closed-specific pill for an Admin on a closed program', () => {
    useProgram.mockReturnValue({ data: { ...ADMIN, is_closed: true } });
    renderPage();

    expect(
      screen.queryByRole('radiogroup', { name: 'Allow file attachments' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTitle('This program is closed and cannot be modified. Reopen it first.'),
    ).toHaveTextContent(/Read-only — program closed/i);
  });
});
