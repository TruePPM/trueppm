import { screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { LocationSegment } from './LocationSegment';
import type { LocationSegmentOption } from './useLocationModel';

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const OPTIONS: LocationSegmentOption[] = [
  { id: 'p1', name: 'Apollo', to: '/projects/p1/board' },
  { id: 'p2', name: 'Gemini', to: '/projects/p2/board' },
  { id: 'p3', name: 'Mercury', to: '/projects/p3/board' },
];

function renderSegment(options = OPTIONS, currentId: string | undefined = 'p1') {
  return renderWithRouter(
    <LocationSegment
      noun="project"
      options={options}
      currentId={currentId}
      currentName={options.find((o) => o.id === currentId)?.name}
    />,
  );
}

describe('LocationSegment (#1643)', () => {
  beforeEach(() => mockNavigate.mockClear());

  it('renders an interactive picker when there are two or more options', () => {
    renderSegment();
    expect(
      screen.getByRole('button', { name: 'Current project: Apollo. Switch project.' }),
    ).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('renders a static, non-interactive row (no chevron) when there is a single option', () => {
    renderSegment([OPTIONS[0]], 'p1');
    // No switch affordance, but the name is still shown (wayfinding is never lost).
    expect(screen.queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument();
    expect(screen.getByText('Apollo')).toBeInTheDocument();
  });

  it('opens the listbox, marks the current option selected, and filters on search', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    const listbox = screen.getByRole('listbox', { name: 'Switch project' });
    expect(within(listbox).getByRole('option', { name: 'Apollo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project' }), {
      target: { value: 'gem' },
    });
    expect(within(listbox).getByRole('option', { name: 'Gemini' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'Apollo' })).not.toBeInTheDocument();
  });

  it('renders the current option as a two-line subtitle row when currentSubtitle is set (#1680)', () => {
    renderWithRouter(
      <LocationSegment
        noun="project"
        options={OPTIONS}
        currentId="p1"
        currentName="Apollo"
        currentSubtitle="Hybrid methodology"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    // The current row folds the subtitle into its accessible name and shows it as a
    // visible second line; other rows stay single-line (name only). Rendered
    // verbatim — this generic component appends no suffix of its own (#2619).
    const current = screen.getByRole('option', { name: 'Apollo, current, Hybrid methodology' });
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(within(current).getByText('Hybrid methodology')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Gemini' })).toBeInTheDocument();
  });

  it('navigates to the selected option and not to the current one', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Gemini' }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p2/board');
  });

  it('selecting the current option is a no-op navigation (just closes)', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Apollo' }));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('two-stage Escape: clears the query first, then closes on the second press', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    const input = screen.getByRole('combobox', { name: 'Find a project' });
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // First Escape clears the query — the listbox is still open, all options back.
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Find a project' })).toHaveValue('');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Find a project' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Enter selects the highlighted option; ArrowDown moves the highlight', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    const input = screen.getByRole('combobox', { name: 'Find a project' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Apollo → Gemini
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p2/board');
  });

  describe('placeholder-picker mode — no current (#2102, ADR-0508 D3)', () => {
    function renderPlaceholder(options = OPTIONS) {
      return renderWithRouter(
        <LocationSegment
          noun="project"
          options={options}
          currentId={undefined}
          currentName={undefined}
          placeholder="Jump to project…"
          placeholderAriaLabel="Jump to a project"
        />,
      );
    }

    it('renders a picker trigger with the placeholder label and aria-label', () => {
      renderPlaceholder();
      const trigger = screen.getByRole('button', { name: 'Jump to a project' });
      expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
      expect(trigger).toHaveTextContent('Jump to project…');
      // Never the current-implying fallback.
      expect(screen.queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument();
    });

    it('renders the picker even with a single option (no static-row shortcut)', () => {
      renderPlaceholder([OPTIONS[0]]);
      fireEvent.click(screen.getByRole('button', { name: 'Jump to a project' }));
      const listbox = screen.getByRole('listbox', { name: 'Jump to a project' });
      expect(within(listbox).getByRole('option', { name: 'Apollo' })).toBeInTheDocument();
    });

    it('marks no option selected and navigates on select', () => {
      renderPlaceholder();
      fireEvent.click(screen.getByRole('button', { name: 'Jump to a project' }));
      const listbox = screen.getByRole('listbox', { name: 'Jump to a project' });
      for (const opt of within(listbox).getAllByRole('option')) {
        expect(opt).toHaveAttribute('aria-selected', 'false');
      }
      fireEvent.click(within(listbox).getByRole('option', { name: 'Gemini' }));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/p2/board');
    });
  });

  it('shows a status row when no option matches the query', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project' }), {
      target: { value: 'nope' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('No projects match');
  });

  // #2669: the program segment opts into `linkToCurrent` because its "current" row
  // can be a genuinely different page than the one you're on (you're browsing a
  // project, not the program's own Overview) — see LocationSwitcher for why the
  // project segment does not opt in. `noun="program"` here matches the real caller.
  describe('current-entry link (#2669, linkToCurrent)', () => {
    const PROGRAM_OPTIONS: LocationSegmentOption[] = [
      { id: 'prog-1', name: 'Apollo', to: '/programs/prog-1/overview' },
      { id: 'prog-2', name: 'Gemini', to: '/programs/prog-2/overview' },
    ];

    it('renders the current name as a direct link to its own page, separate from the switcher chevron', () => {
      renderWithRouter(
        <LocationSegment
          noun="program"
          options={PROGRAM_OPTIONS}
          currentId="prog-1"
          currentName="Apollo"
          linkToCurrent
        />,
      );
      const link = screen.getByRole('link', { name: 'Current program: Apollo. Open program.' });
      expect(link).toHaveAttribute('href', '/programs/prog-1/overview');

      // The chevron trigger is a separate control, labelled as a pure switcher now
      // that the name carries the "go to current" affordance.
      const trigger = screen.getByRole('button', { name: 'Switch program' });
      expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');

      // Clicking the link does not also open the switcher listbox.
      fireEvent.click(link);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('the chevron still opens the switcher, and the checked row inside it stays a no-op', () => {
      renderWithRouter(
        <LocationSegment
          noun="program"
          options={PROGRAM_OPTIONS}
          currentId="prog-1"
          currentName="Apollo"
          linkToCurrent
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch program' }));
      const listbox = screen.getByRole('listbox', { name: 'Switch program' });
      expect(within(listbox).getByRole('option', { name: 'Apollo' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      fireEvent.click(within(listbox).getByRole('option', { name: 'Apollo' }));
      expect(mockNavigate).not.toHaveBeenCalled();

      // A different row still switches.
      fireEvent.click(screen.getByRole('button', { name: 'Switch program' }));
      fireEvent.click(screen.getByRole('option', { name: 'Gemini' }));
      expect(mockNavigate).toHaveBeenCalledWith('/programs/prog-2/overview');
    });

    it('single-option workspace: the static identity row becomes a direct link instead of dead text (no more "no way back")', () => {
      renderWithRouter(
        <LocationSegment
          noun="program"
          options={[PROGRAM_OPTIONS[0]]}
          currentId="prog-1"
          currentName="Apollo"
          linkToCurrent
        />,
      );
      // No switcher — nothing to switch to — but the name is a live link now.
      expect(screen.queryByRole('button', { name: /Switch program/ })).not.toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Current program: Apollo. Open program.' });
      expect(link).toHaveAttribute('href', '/programs/prog-1/overview');
    });

    it('falls back to plain static text when the current entry has no resolvable destination', () => {
      // currentId not present in options — e.g. a transient loading state where the
      // caller's list hasn't caught up with the resolved current entry yet.
      renderWithRouter(
        <LocationSegment
          noun="program"
          options={[]}
          currentId="prog-1"
          currentName="Apollo"
          linkToCurrent
        />,
      );
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByText('Apollo')).toBeInTheDocument();
    });

    it('does not link the current entry when the caller has not opted in (project segment default)', () => {
      // Same shape as the program case above, but without `linkToCurrent` — this is
      // the project segment's default behavior, which is intentionally unchanged by
      // #2669 (its "current" entry already is the page you're on).
      renderSegment();
      expect(
        screen.queryByRole('link', { name: /Current project: Apollo\. Open project\./ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Current project: Apollo. Switch project.' }),
      ).toBeInTheDocument();
    });
  });
});
