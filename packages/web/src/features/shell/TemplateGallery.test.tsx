import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
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

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { display_name: 'Artemis' }, isLoading: false }),
}));

function makeTemplate(over: Partial<ProjectTemplate> = {}): ProjectTemplate {
  return {
    id: 't1',
    name: 'Delivery skeleton',
    description: 'Phases and gates',
    source_kind: 'workspace',
    provenance: 'Workspace',
    carries: ['structure', 'dependencies'],
    methodology: 'HYBRID',
    task_count: 12,
    version: 1,
    program: null,
    published_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('TemplateGallery (#2728, superseding #2729)', () => {
  beforeEach(() => {
    mockQuery.data = [];
    mockQuery.isLoading = false;
    mockQuery.isError = false;
  });

  it('titles the list "Templates available to {reader}" — the detail-list pattern', () => {
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/templates available to artemis/i)).toBeInTheDocument();
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

  it('selects a template, carrying its methodology (ADR-0791)', async () => {
    const onSelect = vi.fn();
    mockQuery.data = [makeTemplate({ methodology: 'WATERFALL' })];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('radio', { name: /delivery skeleton/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', methodology: 'WATERFALL' }),
    );
  });

  it('navigates the list with the down/up arrows (roving tabindex, focus-only)', async () => {
    mockQuery.data = [
      makeTemplate({ id: 't1', name: 'Alpha skeleton' }),
      makeTemplate({ id: 't2', name: 'Beta skeleton' }),
    ];
    renderWithProviders(<TemplateGallery selectedId="t1" onSelect={vi.fn()} />);
    const radiogroup = screen.getByRole('radiogroup', { name: /start from a template/i });
    const first = within(radiogroup).getByRole('radio', { name: /alpha skeleton/i });
    const second = within(radiogroup).getByRole('radio', { name: /beta skeleton/i });
    first.focus();
    expect(first).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    // Focus-only: arrowing to the second row must not itself commit a selection.
    expect(second).toHaveAttribute('aria-checked', 'false');

    await userEvent.keyboard('{ArrowUp}');
    expect(first).toHaveFocus();
  });

  it('degrades to "try Blank or Import instead" when the gallery fetch fails', () => {
    // A failed gallery must not block creating a project — Blank and Import stay
    // available as sibling way-in cards on the Start sheet.
    mockQuery.isError = true;
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/try blank or import instead/i);
  });

  it('shows a publish-or-pick-another-way empty state with no "Blank project" row', () => {
    // #2728: Blank is a peer way-in card at the sheet's top level now, not folded
    // into this list as a fallback selection.
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: /blank project/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no templates yet/i)).toBeInTheDocument();
  });
});
