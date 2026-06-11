import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSampleIndicator } from './ProjectSampleIndicator';

const useProject = vi.fn();
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as { data: unknown },
}));

function renderIndicator() {
  return render(
    <MemoryRouter>
      <ProjectSampleIndicator projectId="p1" />
    </MemoryRouter>,
  );
}

describe('ProjectSampleIndicator', () => {
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
});
