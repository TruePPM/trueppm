// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { DemoAdminPreviewPage } from './DemoAdminPreviewPage';

const demo = vi.hoisted(() => ({ value: { isDemoReadOnly: true, isLoading: false } }));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demo.value }));
vi.mock('./WorkspaceRolesPage', () => ({ WorkspaceRolesPage: () => <div>roles-stub</div> }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/demo/admin-preview']}>
      <Routes>
        <Route path="/demo/admin-preview" element={<DemoAdminPreviewPage />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DemoAdminPreviewPage', () => {
  it('renders the labeled static preview with an inert invite control', () => {
    demo.value = { isDemoReadOnly: true, isLoading: false };
    renderPage();
    expect(screen.getByTestId('demo-admin-preview-banner')).toHaveTextContent('Static preview');
    expect(screen.getByRole('table', { name: 'Sample workspace members' })).toBeInTheDocument();
    expect(screen.getByText('roles-stub')).toBeInTheDocument();
    const invite = screen.getByRole('button', { name: 'Invite member' });
    expect(invite).toBeDisabled();
  });

  it('sends a normal install home instead of rendering', () => {
    demo.value = { isDemoReadOnly: false, isLoading: false };
    renderPage();
    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-admin-preview')).toBeNull();
  });

  it('renders nothing while the mode is unsettled', () => {
    demo.value = { isDemoReadOnly: true, isLoading: true };
    const { container } = renderPage();
    expect(container).toBeEmptyDOMElement();
  });
});
