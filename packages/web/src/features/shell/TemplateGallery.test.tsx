import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { TemplateGallery } from './TemplateGallery';
import type { ProjectTemplate } from '@/hooks/useProjectTemplates';

const mockQuery = {
  data: [] as ProjectTemplate[],
  isLoading: false,
  isError: false,
};

vi.mock('@/hooks/useProjectTemplates', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjectTemplates: () => mockQuery,
}));

function makeTemplate(over: Partial<ProjectTemplate> = {}): ProjectTemplate {
  return {
    id: 't1',
    name: 'Delivery skeleton',
    description: 'Phases and gates',
    source_kind: 'workspace',
    provenance: 'Workspace',
    carries: ['structure', 'dependencies'],
    task_count: 12,
    version: 1,
    program: null,
    published_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('TemplateGallery (#2729)', () => {
  beforeEach(() => {
    mockQuery.data = [];
    mockQuery.isLoading = false;
    mockQuery.isError = false;
  });

  it('offers "Blank project" as a first-class choice, selected by default', () => {
    // A gallery that only offers templates makes starting from nothing read as a
    // mistake — and the design's own assumption is that teams delete most of what
    // a template writes, so the blank path has to stay obviously legitimate.
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    const blank = screen.getByRole('radio', { name: /blank project/i });
    expect(blank).toBeInTheDocument();
    expect(blank).toBeChecked();
  });

  it('shows the provenance chip before adoption', () => {
    // Who published a skeleton is the first thing a delivery lead judges it by, so
    // the chip has to be legible *before* adopting, not discovered afterwards.
    mockQuery.data = [makeTemplate({ provenance: 'Yours' })];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Yours')).toBeInTheDocument();
  });

  it('states what a template carries and what it never carries', () => {
    mockQuery.data = [makeTemplate()];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(
      screen.getByText(/never owners, dates, or progress/i),
    ).toBeInTheDocument();
  });

  it('reports the row count so adoption is an informed choice', () => {
    mockQuery.data = [makeTemplate({ task_count: 12 })];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('12 rows')).toBeInTheDocument();
  });

  it('selects a template', async () => {
    const onSelect = vi.fn();
    mockQuery.data = [makeTemplate()];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('radio', { name: /delivery skeleton/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('degrades to the blank path when the gallery fetch fails', () => {
    // A failed gallery must not block creating a project — the user is mid-flow on
    // their most important commitment, and blank is always available.
    mockQuery.isError = true;
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/still start from a blank project/i);
  });
});
