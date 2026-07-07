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
        currentSubtitle="Hybrid"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    // The current row folds the subtitle into its accessible name and shows it as a
    // visible second line; other rows stay single-line (name only).
    const current = screen.getByRole('option', { name: 'Apollo, current, Hybrid workspace' });
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(within(current).getByText('Hybrid workspace')).toBeInTheDocument();
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

  it('shows a status row when no option matches the query', () => {
    renderSegment();
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project' }), {
      target: { value: 'nope' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('No projects match');
  });
});
