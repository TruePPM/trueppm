import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSampleIndicator } from './ProjectSampleIndicator';

const useProject = vi.fn();
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as { data: unknown },
}));

// Read-only demo gate (ADR-1197 D3, #4049) — mocked the same way CommentComposer's
// spec mocks it, so the demo branch here is exercised by its own case below.
const demoMode = vi.hoisted(() => ({
  value: { isDemoReadOnly: false, loginHint: null, isLoading: false },
}));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode.value }));

function renderIndicator() {
  return render(
    <MemoryRouter>
      <ProjectSampleIndicator projectId="p1" />
    </MemoryRouter>,
  );
}

describe('ProjectSampleIndicator', () => {
  afterEach(() => {
    demoMode.value = { isDemoReadOnly: false, loginHint: null, isLoading: false };
  });

  it('renders nothing for a non-sample project', () => {
    useProject.mockReturnValue({ data: { is_sample: false } });
    const { container } = renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the project is still loading', () => {
    useProject.mockReturnValue({ data: undefined });
    const { container } = renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the demo cue, program name, and a manage link for a sample project', () => {
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    renderIndicator();
    expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    expect(screen.getByText('Atlas Platform Launch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage demo data/i })).toHaveAttribute(
      'href',
      '/programs/prog-9',
    );
  });

  it('shows the cue without a link when the project has no program', () => {
    useProject.mockReturnValue({ data: { is_sample: true, program_detail: null } });
    renderIndicator();
    expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('hides the manage link for the read-only interactive demo (#4049)', () => {
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    renderIndicator();
    expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /manage demo data/i })).not.toBeInTheDocument();
  });

  it('shows the manage link outside the read-only demo', () => {
    demoMode.value = { isDemoReadOnly: false, loginHint: null, isLoading: false };
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    renderIndicator();
    expect(screen.getByRole('link', { name: /manage demo data/i })).toHaveAttribute(
      'href',
      '/programs/prog-9',
    );
  });
});
