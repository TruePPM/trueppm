import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProjectTemplatesPage } from './ProjectTemplatesPage';

const h = vi.hoisted(() => ({
  role: { role: null as number | null, isLoading: false, isError: false },
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: { name: 'Vega Platform' } }) }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: () => h.role }));
vi.mock('@/hooks/useProjectTemplates', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePublishPreview: () => ({ data: undefined }),
  useTemplatesFromProject: () => ({ data: [] }),
}));

beforeEach(() => {
  h.role = { role: null, isLoading: false, isError: false };
});

describe('ProjectTemplatesPage — role states', () => {
  it('a failed role read is reported as a failed request, not a permission verdict', () => {
    // `useCurrentUserRole` yields role: null both for "no membership" and for a
    // failed fetch, and does not retry. Rendering the permission card on the
    // second tells an Admin they lack a role they hold (rule 246, #2909).
    h.role = { role: null, isLoading: false, isError: true };
    render(<ProjectTemplatesPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn’t check your role/);
    expect(screen.getByRole('alert')).toHaveTextContent(/not a permission decision/);
    expect(screen.queryByText(/needs Project Manager role/)).not.toBeInTheDocument();
  });

  it('a genuine non-Admin gets the rule stated, not a disabled button', () => {
    h.role = { role: 100, isLoading: false, isError: false };
    render(<ProjectTemplatesPage />);

    expect(screen.getByText(/needs Project Manager role/)).toBeInTheDocument();
    // A disabled control teaches nothing and reads as a bug.
    expect(screen.queryByRole('button', { name: /Publish as template/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders neither verdict while the role is still loading', () => {
    h.role = { role: null, isLoading: true, isError: false };
    render(<ProjectTemplatesPage />);

    expect(screen.queryByText(/needs Project Manager role/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
