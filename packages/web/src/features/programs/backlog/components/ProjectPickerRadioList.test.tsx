import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberProject } from '../types';
import { ProjectPickerRadioList } from './ProjectPickerRadioList';

/**
 * This component had no unit spec at all while its ACCESSIBLE NAME changed twice
 * on #3644 — once to carry the methodology token, once to split that token into a
 * visible `aria-hidden` label plus an `sr-only` disambiguated phrase. Both changes
 * were covered only by e2e, and the whole design rationale for choosing text over
 * a chip rests on what that name contains, so it is the one property that most
 * needed pinning here.
 */
const PROJECTS: MemberProject[] = [
  { id: 'p-waterfall', name: 'Pad 39B Refit', methodology: 'WATERFALL' },
  { id: 'p-agile', name: 'Avionics', methodology: 'AGILE' },
];

function renderList(projects: MemberProject[] = PROJECTS, value: string | null = null) {
  return render(
    <ProjectPickerRadioList projects={projects} value={value} onChange={vi.fn()} />,
  );
}

describe('ProjectPickerRadioList', () => {
  it('carries the methodology into each radio’s accessible name', () => {
    renderList();

    // The button has no `aria-label`, so its name is computed from content —
    // which is the entire reason the methodology is rendered as text rather than
    // as a colored chip. If that ever changes, this fails.
    expect(
      screen.getByRole('radio', { name: /Pad 39B Refit.*Waterfall/s }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Avionics.*Agile/s })).toBeInTheDocument();
  });

  it('speaks the disambiguated phrase while showing the bare label', () => {
    const { container } = renderList();

    // Visible text stays the bare noun — it reads as a metadata column.
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getAllByText('Waterfall', { selector: '[aria-hidden="true"]' })).toHaveLength(1);

    // AT gets "Waterfall methodology", not a bare noun buried in a run-on.
    expect(
      screen.getByRole('radio', { name: /Waterfall methodology/ }),
    ).toBeInTheDocument();
  });

  it('degrades to name-only when a row carries no methodology', () => {
    // Defensive: `ProgramProjectRow` marks `effective_methodology` required, so
    // production does not reach this. It exists so an older cached roster renders
    // a usable row instead of the string "undefined".
    renderList([{ id: 'p-x', name: 'Legacy Project' }]);

    const radio = screen.getByRole('radio', { name: /Legacy Project/ });
    expect(radio).toBeInTheDocument();
    expect(radio.textContent).not.toMatch(/undefined/);
    expect(radio.textContent).not.toMatch(/methodology/i);
  });

  it('marks only the selected row as checked', () => {
    renderList(PROJECTS, 'p-agile');

    expect(screen.getByRole('radio', { name: /Avionics/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Pad 39B Refit/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
