/**
 * Direct tests for the shared facet control (ADR-0624, #2387). The three
 * wrappers (Label / Owner / Status) each cover their own copy and option
 * shaping; this spec drives the paths that only the shared control owns —
 * outside-click dismissal, the sheet presentation, Tab/Escape exits, the
 * type-ahead buffer, and the no-match branch.
 */

import { useState } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiSelectFacet, SEARCH_THRESHOLD } from './MultiSelectFacet';
import type { FacetOptionGroup } from './MultiSelectFacet';

type FacetProps = ComponentProps<typeof MultiSelectFacet>;
type HarnessProps = Partial<Omit<FacetProps, 'open' | 'onOpenChange' | 'selected' | 'onChange'>> & {
  initialSelected?: string[];
  onChangeSpy?: (next: string[]) => void;
};

/** Four options, one flat group — small enough that no search field appears. */
const FLAT: FacetOptionGroup[] = [
  {
    key: 'all',
    options: [
      { id: 'a', name: 'Alpha', count: 3 },
      { id: 'b', name: 'Beta', count: 0 },
      { id: 'c', name: 'Blocked', count: 7 },
      { id: 'd', name: 'Bravo', count: 2 },
    ],
  },
];

/** Nine options — one past SEARCH_THRESHOLD, so the panel grows a search field. */
const BIG: FacetOptionGroup[] = [
  {
    key: 'all',
    options: ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'].map((name, i) => ({
      id: `p${i}`,
      name,
      count: i,
    })),
  },
];

/**
 * The control is open-controlled by its host, so every test drives it through a
 * tiny stateful harness rather than re-rendering by hand. `onChangeSpy` records
 * what the host would have been asked to apply; the harness also applies it, so
 * checked state is observable.
 */
function Harness({ initialSelected = [], onChangeSpy, ...rest }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <MultiSelectFacet
      triggerLabel="Owner: any"
      menuLabel="Filter by owner"
      groups={FLAT}
      clearLabel="Clear owners"
      {...rest}
      selected={selected}
      open={open}
      onOpenChange={setOpen}
      onChange={(next) => {
        onChangeSpy?.(next);
        setSelected(next);
      }}
    />
  );
}

function setup(props: HarnessProps = {}) {
  const onChangeSpy = vi.fn<(next: string[]) => void>();
  render(
    <div>
      <button type="button">Outside</button>
      <Harness onChangeSpy={onChangeSpy} {...props} />
    </div>,
  );
  return { onChangeSpy, trigger: screen.getByRole('button', { name: /Owner:/ }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MultiSelectFacet — open/close', () => {
  it('exposes the threshold that grows a search field', () => {
    expect(SEARCH_THRESHOLD).toBe(8);
  });

  it('opens on click and closes again on a second click', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Filter by owner' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Closed panels drop their aria-controls wiring.
    expect(trigger).not.toHaveAttribute('aria-controls');
  });

  it('closes on a pointer press outside the control, leaving focus where it landed', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    const outside = screen.getByRole('button', { name: 'Outside' });

    outside.focus();
    fireEvent.mouseDown(outside);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // An outside click must not yank focus back to the trigger.
    expect(trigger).not.toHaveFocus();
    expect(outside).toHaveFocus();
  });

  it('stays open when the press lands inside the panel', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');

    fireEvent.mouseDown(menu);

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('Escape from anywhere closes and returns focus to the trigger', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown on the trigger opens the panel and lands focus on the first option', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveFocus();
  });

  it('ignores other keys on the trigger', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('MultiSelectFacet — keyboard exits', () => {
  it('Tab from an option closes the panel without stealing focus back', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const first = screen.getByRole('menuitemcheckbox', { name: /Alpha/ });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Tab' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it('Escape in the search field closes and returns focus to the trigger', async () => {
    const { trigger } = setup({ groups: BIG, searchAriaLabel: 'Filter owner options' });
    await userEvent.click(trigger);
    const search = screen.getByLabelText('Filter owner options');
    search.focus();

    fireEvent.keyDown(search, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown in the search field moves into the option list', async () => {
    const { trigger } = setup({ groups: BIG, searchAriaLabel: 'Filter owner options' });
    await userEvent.click(trigger);
    const search = screen.getByLabelText('Filter owner options');
    search.focus();

    fireEvent.keyDown(search, { key: 'ArrowDown' });

    expect(screen.getByRole('menuitemcheckbox', { name: /Ada/ })).toHaveFocus();
  });

  it('ArrowDown in the search field does nothing when nothing matches', async () => {
    const { trigger } = setup({
      groups: BIG,
      searchAriaLabel: 'Filter owner options',
      noMatchLabel: 'No owners match that.',
    });
    await userEvent.click(trigger);
    const search = screen.getByLabelText<HTMLInputElement>('Filter owner options');
    await userEvent.type(search, 'zzz');
    expect(screen.getByText('No owners match that.')).toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'ArrowDown' });

    // No option to land on — the field keeps focus and the panel stays open.
    expect(search).toHaveFocus();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('ArrowUp from the first option returns to the search field', async () => {
    const { trigger } = setup({ groups: BIG, searchAriaLabel: 'Filter owner options' });
    await userEvent.click(trigger);
    const search = screen.getByLabelText('Filter owner options');
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Ada/ }), { key: 'ArrowUp' });

    expect(search).toHaveFocus();
  });

  it('ArrowUp from the first option wraps to the last when there is no search field', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Bravo/ })).toHaveFocus();
  });
});

describe('MultiSelectFacet — type-ahead', () => {
  it('accumulates typed letters to reach a later same-initial option', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: 'b' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Beta/ })).toHaveFocus();

    // A second keystroke inside the window extends the buffer to "br", which
    // skips past "Blocked" to "Bravo".
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Beta/ }), { key: 'r' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Bravo/ })).toHaveFocus();
  });

  it('resets the buffer after the idle window so the same letter cycles', () => {
    vi.useFakeTimers();
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: 'b' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Beta/ })).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    // Buffer expired — "b" starts over and advances to the next b-option rather
    // than searching for "bb" (which would match nothing and leave focus put).
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Beta/ }), { key: 'b' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Blocked/ })).toHaveFocus();
  });

  it('leaves focus alone when nothing starts with the typed letter', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const first = screen.getByRole('menuitemcheckbox', { name: /Alpha/ });

    fireEvent.keyDown(first, { key: 'z' });

    expect(first).toHaveFocus();
  });

  it('ignores modified and non-printable keys', async () => {
    const { onChangeSpy, trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const first = screen.getByRole('menuitemcheckbox', { name: /Alpha/ });

    fireEvent.keyDown(first, { key: 'PageDown' });
    fireEvent.keyDown(first, { key: 'b', metaKey: true });

    // Neither moved the roving focus nor toggled anything.
    expect(first).toHaveFocus();
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});

describe('MultiSelectFacet — selection', () => {
  it('toggles an option on and back off without closing', async () => {
    const { onChangeSpy, trigger } = setup();
    await userEvent.click(trigger);
    const alpha = screen.getByRole('menuitemcheckbox', { name: /Alpha/ });

    await userEvent.click(alpha);
    expect(onChangeSpy).toHaveBeenLastCalledWith(['a']);
    expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('Enter and Space both toggle from the keyboard', async () => {
    const { onChangeSpy, trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: 'Enter' });
    expect(onChangeSpy).toHaveBeenLastCalledWith(['a']);

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: ' ' });
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
  });

  it('Home and End jump to the ends of the list', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }), { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Bravo/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Bravo/ }), { key: 'Home' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveFocus();
  });

  it('renders each option count, including a visible zero', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    expect(screen.getByRole('menuitemcheckbox', { name: /Beta/ })).toHaveTextContent('0');
  });
});

describe('MultiSelectFacet — footer', () => {
  it('disables the clear action while nothing is selected', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Clear owners' })).toBeDisabled();
  });

  it('clears every selection and renders the hint and host footer controls', async () => {
    const { onChangeSpy, trigger } = setup({
      initialSelected: ['a', 'c'],
      footerHint: 'Any of the selected owners',
      footerExtra: <button type="button">Hide non-matching rows</button>,
    });
    await userEvent.click(trigger);
    expect(screen.getByText('Any of the selected owners')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide non-matching rows' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear owners' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
  });

  it('omits the hint line when the host supplies none', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    expect(screen.queryByText(/Any of the selected/)).not.toBeInTheDocument();
  });
});

describe('MultiSelectFacet — grouping and search', () => {
  const GROUPED: FacetOptionGroup[] = [
    { key: 'here', heading: 'On these rows · 1', options: [{ id: 'a', name: 'Alpha', count: 3 }] },
    { key: 'rest', heading: 'All members · 1 more', options: [{ id: 'b', name: 'Beta', count: 0 }] },
    { key: 'gone', heading: 'Empty', options: [] },
  ];

  it('labels each group by its heading and drops empty groups entirely', async () => {
    const { trigger } = setup({ groups: GROUPED });
    await userEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'On these rows · 1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'All members · 1 more' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Empty' })).not.toBeInTheDocument();
  });

  it('falls back to the panel label when a group has no heading', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    const group = screen.getByRole('group', { name: 'Filter by owner' });
    expect(within(group).getAllByRole('menuitemcheckbox')).toHaveLength(4);
  });

  it('hides the search field at or below the threshold', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    expect(screen.queryByLabelText('Filter options')).not.toBeInTheDocument();
  });

  it('narrows the list as the query is typed, keeping focus in the field', async () => {
    const { trigger } = setup({ groups: BIG });
    await userEvent.click(trigger);
    // Default search copy applies when the host supplies none.
    const search = screen.getByLabelText<HTMLInputElement>('Filter options');
    expect(search.placeholder).toBe('Filter options…');

    await userEvent.type(search, 'ad');

    expect(search).toHaveFocus();
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);
    expect(screen.getByRole('menuitemcheckbox', { name: /Ada/ })).toBeInTheDocument();
  });

  it('shows the default no-match copy when nothing matches', async () => {
    const { trigger } = setup({ groups: BIG });
    await userEvent.click(trigger);
    await userEvent.type(screen.getByLabelText('Filter options'), 'qqq');
    expect(screen.getByText('Nothing matches that.')).toBeInTheDocument();
    expect(screen.queryAllByRole('menuitemcheckbox')).toHaveLength(0);
  });

  it('restores the full list when the panel is reopened after a search', async () => {
    const { trigger } = setup({ groups: BIG });
    await userEvent.click(trigger);
    await userEvent.type(screen.getByLabelText('Filter options'), 'ad');
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);

    await userEvent.click(trigger);
    await userEvent.click(trigger);

    expect(screen.getByLabelText<HTMLInputElement>('Filter options').value).toBe('');
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(9);
  });
});

describe('MultiSelectFacet — empty catalog', () => {
  it('replaces the whole body with the host explanation', async () => {
    const { trigger } = setup({
      groups: [],
      emptyPanel: <p>No owners in this project yet</p>,
    });
    await userEvent.click(trigger);
    expect(screen.getByText('No owners in this project yet')).toBeInTheDocument();
    // No option rows, no clear action — there is nothing to clear.
    expect(screen.queryAllByRole('menuitemcheckbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Clear owners' })).not.toBeInTheDocument();
  });

  it('ArrowDown on the trigger still opens an empty panel without crashing', async () => {
    const { trigger } = setup({ groups: [], emptyPanel: <p>Nothing here</p> });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
});

describe('MultiSelectFacet — sheet presentation', () => {
  it('announces a dialog rather than a menu on the trigger', () => {
    const { trigger } = setup({ presentation: 'sheet' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('renders the same options inside a titled sheet', async () => {
    const { trigger } = setup({ presentation: 'sheet' });
    await userEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Filter by owner' });
    expect(within(dialog).getByRole('heading', { name: 'Filter by owner' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('menuitemcheckbox')).toHaveLength(4);
    expect(within(dialog).getByRole('button', { name: 'Clear owners' })).toBeInTheDocument();
  });

  it('selections apply live behind the sheet — Done only dismisses', async () => {
    const { onChangeSpy, trigger } = setup({ presentation: 'sheet' });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['a']);

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    // Done is a dismissal, not an apply — no extra onChange fired.
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
  });

  it('dismisses on Escape and returns focus to the trigger', async () => {
    const { trigger } = setup({ presentation: 'sheet' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows the host empty explanation inside the sheet too', async () => {
    const { trigger } = setup({
      presentation: 'sheet',
      groups: [],
      emptyPanel: <p>No owners in this project yet</p>,
    });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('No owners in this project yet')).toBeInTheDocument();
  });
});
