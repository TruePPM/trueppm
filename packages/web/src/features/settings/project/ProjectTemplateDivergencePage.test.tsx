import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProjectTemplateDivergencePage } from './ProjectTemplateDivergencePage';
import type { TemplateDivergence } from '@/hooks/useProjectTemplates';

const h = vi.hoisted(() => ({
  query: {
    data: undefined as TemplateDivergence | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({ formatInstantDate: () => 'August 12, 2026' }),
}));
vi.mock('@/hooks/useProjectTemplates', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useTemplateDivergence: () => h.query,
}));

const ADOPTED: TemplateDivergence = {
  project: 'p1',
  adopted: true,
  application: 'app-1',
  application_count: 1,
  template: 'tpl-1',
  template_name: 'Delivery skeleton',
  template_version: 3,
  template_available: true,
  applied_at: '2026-08-12T09:00:00Z',
  applied_by_name: 'Kelly',
  seeded_row_count: 42,
  unchanged: 30,
  adapted: 8,
  removed: 4,
  added: 11,
};

beforeEach(() => {
  h.query = { data: ADOPTED, isLoading: false, isError: false };
});

describe('ProjectTemplateDivergencePage', () => {
  it('names the template, its version, who applied it and when', () => {
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByText(/Delivery skeleton/)).toBeInTheDocument();
    expect(screen.getByText(/v3/)).toBeInTheDocument();
    expect(screen.getByText(/applied by Kelly on August 12, 2026/)).toBeInTheDocument();
  });

  it('renders the four counts as plain numerals with text labels', () => {
    // rule 120: a count carries its meaning in the numeral and its label, never in
    // a color — and this page in particular must not grade the numbers.
    render(<ProjectTemplateDivergencePage />);

    for (const [label, value] of [
      ['Unchanged', '30'],
      ['Adapted', '8'],
      ['Removed', '4'],
      ['Added', '11'],
    ]) {
      const term = screen.getByText(label);
      expect(term).toBeInTheDocument();
      expect(term.parentElement).toHaveTextContent(value);
    }
    expect(screen.getByText(/Of the 42 rows the template wrote/)).toBeInTheDocument();
  });

  it('states that every member sees this same page', () => {
    // The requirement, asserted on the surface the team actually reads. If this
    // sentence goes, the page stops telling a Viewer that nothing fuller exists.
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByText(/Everyone on this project sees exactly this page/)).toBeInTheDocument();
    expect(screen.getByText(/Viewers included/)).toBeInTheDocument();
  });

  it('never renders a verdict, a score, or an action', () => {
    // The governance position from #2970/#2909: a visible signal, never a block.
    render(<ProjectTemplateDivergencePage />);

    // No control to press: there is nothing to submit, approve, or escalate.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // No score: no percentage, no meter, no compliance language. The page states
    // counts and refuses to grade them. (The copy *does* say the words "approves,
    // rejects" — in the sentence promising it does none of those — so this asserts
    // on the shapes a verdict takes, not on the vocabulary.)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/complian/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('says the template is gone without treating it as an error', () => {
    h.query = {
      data: { ...ADOPTED, template: null, template_available: false },
      isLoading: false,
      isError: false,
    };
    render(<ProjectTemplateDivergencePage />);

    // The name survives the row: the adoption record is denormalized for exactly this.
    expect(screen.getByText(/Delivery skeleton/)).toBeInTheDocument();
    expect(screen.getByText(/has since been deleted/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a project with no adoption as an answer, not an empty state', () => {
    h.query = {
      data: {
        ...ADOPTED,
        adopted: false,
        application: null,
        application_count: 0,
        template: null,
        template_name: '',
        template_version: 0,
        template_available: false,
        applied_at: null,
        applied_by_name: '',
        seeded_row_count: 0,
        unchanged: 0,
        adapted: 0,
        removed: 0,
        added: 7,
      },
      isLoading: false,
      isError: false,
    };
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByText(/wasn’t created from a template/)).toBeInTheDocument();
    expect(screen.getByText(/Its 7 rows were all authored here/)).toBeInTheDocument();
    // The symmetry note stays: a team with nothing reported about them still needs
    // to know that this is where it would appear.
    expect(screen.getByText(/Everyone on this project sees exactly this page/)).toBeInTheDocument();
  });

  it('mentions the second template when a project adopted more than one', () => {
    h.query = {
      data: { ...ADOPTED, application_count: 2 },
      isLoading: false,
      isError: false,
    };
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByText(/2 templates have been applied here/)).toBeInTheDocument();
  });

  it('shows a shaped skeleton while loading, not a bare text line (rule 248)', () => {
    h.query = { data: undefined, isLoading: true, isError: false };
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByRole('status', { name: /Loading template divergence/i })).toBeInTheDocument();
    expect(screen.queryByText(/Unchanged/)).not.toBeInTheDocument();
  });

  it('reports a failed read as a failed request, not as "no divergence"', () => {
    // Rendering zeros here would tell a team nothing is being said about them at
    // the exact moment we cannot see what is.
    h.query = { data: undefined, isLoading: false, isError: true };
    render(<ProjectTemplateDivergencePage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/failed request, not an empty report/);
    expect(screen.queryByText(/Unchanged/)).not.toBeInTheDocument();
  });
});
