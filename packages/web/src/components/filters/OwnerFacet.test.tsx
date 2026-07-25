import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnerFacet } from './OwnerFacet';

const ROSTER = [
  { id: 'r1', name: 'A. Reyes' },
  { id: 'r2', name: 'M. Osei' },
  { id: 'r3', name: 'J. Park' },
  { id: 'r4', name: 'B. Chen' },
  { id: 'r5', name: 'D. Ferreira' },
];

const COUNTS = { r1: 34, r2: 28, r3: 19, r4: 0, r5: 0 };

function setup(overrides: Partial<ComponentProps<typeof OwnerFacet>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <OwnerFacet candidates={ROSTER} counts={COUNTS} selected={[]} onChange={onChange} {...overrides} />,
  );
  return { onChange, view };
}

describe('OwnerFacet trigger', () => {
  it('reads "Owner: any" with nothing selected', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Owner: any' })).toBeInTheDocument();
  });

  it('names the single selection, then collapses to "+N"', () => {
    const { view } = setup({ selected: ['r1'] });
    expect(screen.getByRole('button', { name: /Owner: A\. Reyes$/ })).toBeInTheDocument();
    view.rerender(
      <OwnerFacet candidates={ROSTER} counts={COUNTS} selected={['r1', 'r2']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Owner: A\. Reyes \+1/ })).toBeInTheDocument();
  });

  it('says "none yet" when the project has no resource pool', () => {
    setup({ candidates: [], counts: {} });
    expect(screen.getByRole('button', { name: 'Owner: none yet' })).toBeInTheDocument();
  });
});

describe('OwnerFacet panel', () => {
  it('splits the roster into "On these rows" and "All members"', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    expect(screen.getByRole('group', { name: 'On these rows · 3' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'All members · 2 more' })).toBeInTheDocument();
  });

  it('shows a visible 0 for a member with nothing here', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    // The pre-click signal that makes selecting them a deliberate choice rather
    // than a surprise empty result.
    const chen = screen.getByRole('menuitemcheckbox', { name: /B\. Chen/ });
    expect(chen).toHaveTextContent('0');
  });

  it('orders "on these rows" by count, most first', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    const names = screen
      .getAllByRole('menuitemcheckbox')
      .map((el) => el.textContent ?? '');
    expect(names[0]).toContain('A. Reyes');
    expect(names[1]).toContain('M. Osei');
    expect(names[2]).toContain('J. Park');
  });

  it('drops the group headings when everyone falls in one group', async () => {
    // A heading above every option and none above the other is noise.
    setup({ counts: { r1: 1, r2: 1, r3: 1, r4: 1, r5: 1 } });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    expect(screen.queryByRole('group', { name: /On these rows/ })).not.toBeInTheDocument();
  });

  it('toggles without closing, so results update behind the panel', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /J\. Park/ }));
    expect(onChange).toHaveBeenCalledWith(['r3']);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('explains the OR-within semantics in the footer', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    expect(screen.getByText('Any of the selected owners')).toBeInTheDocument();
  });

  it('Clear owners is disabled until something is selected', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    expect(screen.getByRole('button', { name: 'Clear owners' })).toBeDisabled();
  });

  it('explains where people come from when the pool is empty', async () => {
    setup({ candidates: [], counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: none yet' }));
    expect(screen.getByText('No people on this project yet')).toBeInTheDocument();
  });
});

describe('OwnerFacet at roster scale', () => {
  const BIG = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, name: `Person ${i}` }));

  it('grows a search field once the roster exceeds 8', async () => {
    setup({ candidates: BIG, counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    expect(screen.getByLabelText('Filter owner options')).toBeInTheDocument();
  });

  it('typing the whole query narrows the list — focus stays in the search field', async () => {
    // Regression guard for web rule 280: a roving-focus effect keyed on list
    // length steals focus after the first keystroke, and the rest of the query
    // gets swallowed by the option list's type-ahead.
    setup({ candidates: BIG, counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    const search = screen.getByLabelText('Filter owner options');
    await userEvent.type(search, 'person 1');
    expect(search).toHaveValue('person 1');
    expect(search).toHaveFocus();
    // "Person 1", "Person 10", "Person 11"
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(3);
  });

  it('search filters both groups at once', async () => {
    setup({
      candidates: [...ROSTER, ...BIG],
      counts: COUNTS,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    await userEvent.type(screen.getByLabelText('Filter owner options'), 'e');
    // A name you half-remember shouldn't require knowing which group it's in:
    // "A. Reyes" (on these rows) and "D. Ferreira"/"Person N" (all members).
    const names = screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent ?? '');
    expect(names.some((n) => n.includes('A. Reyes'))).toBe(true);
    expect(names.some((n) => n.includes('D. Ferreira'))).toBe(true);
  });

  it('↓ from the search field enters the list and ↑ from the top returns to it', async () => {
    setup({ candidates: BIG, counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    const search = screen.getByLabelText('Filter owner options');
    search.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Person 0/ })).toHaveFocus();
    // ↑ from the first row goes back up to the field rather than wrapping to the
    // bottom, which would strand anyone correcting a typo.
    await userEvent.keyboard('{ArrowUp}');
    expect(search).toHaveFocus();
  });
});

describe('OwnerFacet keyboard model', () => {
  it('ArrowDown from the trigger opens and focuses the first option', async () => {
    setup();
    screen.getByRole('button', { name: 'Owner: any' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemcheckbox', { name: /A\. Reyes/ })).toHaveFocus();
  });

  it('is a single tab stop — exactly one option is tabbable', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Owner: any' }));
    await userEvent.keyboard('{ArrowDown}');
    const tabbable = screen
      .getAllByRole('menuitemcheckbox')
      .filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('arrow keys walk across the group boundary as one list', async () => {
    setup();
    screen.getByRole('button', { name: 'Owner: any' }).focus();
    // 3 in "On these rows", then straight into "All members" — the grouping is
    // visual, the keyboard walk is flat.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitemcheckbox', { name: /B\. Chen/ })).toHaveFocus();
  });

  it('Space toggles without closing', async () => {
    const { onChange } = setup();
    screen.getByRole('button', { name: 'Owner: any' }).focus();
    await userEvent.keyboard('{ArrowDown}[Space]');
    expect(onChange).toHaveBeenCalledWith(['r1']);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('Escape closes and returns focus to the trigger', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Owner: any' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
