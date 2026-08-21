import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, renderWithProvidersAndRouter } from '@/test/utils';
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
    // The trailing metadata now also carries version/adoption (#2909), so the
    // row count is asserted as a fragment rather than as the whole cell.
    expect(screen.getByText(/12 rows/)).toBeInTheDocument();
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

  it('keeps Blank and Import live when the gallery fetch fails', () => {
    // A failed gallery must not block creating a project — Blank and Import stay
    // available as sibling way-in cards on the Start sheet.
    mockQuery.isError = true;
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    // #2909 restates this as "a list failure is not a creation failure" — the
    // other two ways in are named as still working, not offered as a fallback.
    expect(screen.getByRole('status')).toHaveTextContent(/Blank.*Import.*still work/i);
  });

  it('shows a publish-or-pick-another-way empty state with no "Blank project" row', () => {
    // #2728: Blank is a peer way-in card at the sheet's top level now, not folded
    // into this list as a fallback selection.
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: /blank project/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no templates yet/i)).toBeInTheDocument();
  });
});

describe('TemplateGallery apparatus by count (#2909)', () => {
  beforeEach(() => {
    mockQuery.isLoading = false;
    mockQuery.isError = false;
  });

  function fill(n: number, over: (i: number) => Partial<ProjectTemplate> = () => ({})) {
    mockQuery.data = Array.from({ length: n }, (_, i) =>
      makeTemplate({ id: `t${i}`, name: `Template ${i}`, ...over(i) }),
    );
  }

  it('adds no apparatus below five templates', () => {
    fill(3);
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^All 3$/ })).not.toBeInTheDocument();
  });

  it('adds filter chips at five, but still no search', () => {
    fill(6);
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All 6' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('adds search and methodology groups at twelve', () => {
    fill(12, (i) => ({ methodology: i % 2 === 0 ? 'AGILE' : 'WATERFALL' }));
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByText('Agile')).toBeInTheDocument();
    expect(screen.getByText('Waterfall')).toBeInTheDocument();
  });

  it('keeps the chips and says how many exist when a search matches nothing', async () => {
    // Distinct from the never-published empty state, which offers a completely
    // different remedy — conflating them is how the old copy read as a dead end.
    fill(12);
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByRole('status')).toHaveTextContent(/No templates match “zzzz” — 12 available/);
    expect(screen.getByRole('button', { name: 'All 12' })).toBeInTheDocument();
  });

  it('names a route the reader can walk when nothing has ever been published', () => {
    mockQuery.data = [];
    // Router-aware: the empty state's whole point is that it links to a real
    // route now, so a bare render would be testing the wrong thing.
    renderWithProvidersAndRouter(
      <TemplateGallery
        selectedId={null}
        onSelect={vi.fn()}
        publishFrom={{ id: 'p1', name: 'Vega Platform' }}
      />,
    );
    const link = screen.getByRole('link', { name: /Publish from Vega Platform/ });
    // The screen this points at now exists — the old copy named one that did not.
    expect(link).toHaveAttribute('href', '/projects/p1/settings/templates');
  });

  it('names the path in prose when there is no project to link to', () => {
    mockQuery.data = [];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/Settings → Templates/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows skeleton rows rather than a spinner while loading', () => {
    // The list's height sets the sheet's layout; a centred spinner makes the
    // whole sheet jump when data lands.
    mockQuery.isLoading = true;
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading templates');
    expect(screen.getByRole('status')).toHaveClass('sr-only');
  });

  it('surfaces version and adoption, the house-standard signal', () => {
    mockQuery.data = [makeTemplate({ version: 2, usage_count: 9 })];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/v2 · 9 projects/)).toBeInTheDocument();
  });

  it('derives the carries line from the server counts, not a hard-coded list', () => {
    mockQuery.data = [
      makeTemplate({
        counts: {
          task_count: 82,
          phase_count: 6,
          gate_count: 4,
          milestone_count: 5,
          dependency_count: 14,
          methodology: 'AGILE',
          carries: [],
        },
      }),
    ];
    renderWithProviders(<TemplateGallery selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/carries 6 phases · 4 gates · 14 deps/)).toBeInTheDocument();
  });
});
