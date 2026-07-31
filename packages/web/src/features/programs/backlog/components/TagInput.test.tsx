import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TagInput } from './TagInput';

function setup(over: Partial<Parameters<typeof TagInput>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <TagInput tags={[]} onChange={onChange} suggestions={['bug', 'ui', 'urgent']} {...over} />,
  );
  return { onChange, user: userEvent.setup() };
}

describe('TagInput combobox', () => {
  it('opens on focus and lists existing program tags as options', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.getByRole('option', { name: 'bug' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'urgent' })).toBeInTheDocument();
  });

  it('filters options by case-insensitive substring', async () => {
    const { user } = setup({ suggestions: ['Bug', 'ui', 'urgent'] });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'ui');
    expect(screen.getByRole('option', { name: 'ui' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'urgent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Bug' })).not.toBeInTheDocument();
  });

  it('offers a Create row for new text and adds it on click', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'newtag');
    await user.click(screen.getByRole('option', { name: 'Create "newtag"' }));
    expect(onChange).toHaveBeenCalledWith(['newtag']);
  });

  it('Enter commits the highlighted row (creates when no match)', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'brandnew');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['brandnew']);
  });

  it('clicking an existing suggestion adds that tag', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'ur');
    await user.click(screen.getByRole('option', { name: 'urgent' }));
    expect(onChange).toHaveBeenCalledWith(['urgent']);
  });

  it('does not offer Create for a tag already on the item, showing an "already added" note', async () => {
    const { onChange, user } = setup({ tags: ['bug'], suggestions: ['bug', 'ui'] });
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'bug');
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('"bug" is already added');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace on an empty query removes the last chip', async () => {
    const { onChange, user } = setup({ tags: ['bug', 'ui'] });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith(['bug']);
  });

  it('does not commit the typed draft on blur (no auto-commit)', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'ephemeral');
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowDown roves the highlight; Enter commits the highlighted option', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    // Options render in suggestion order: bug (0), ui (1), urgent (2).
    await user.keyboard('{ArrowDown}'); // highlight → ui
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['ui']);
  });

  it('Escape is two-stage: first clears the query, then closes the popover', async () => {
    const { user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'zz');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}'); // stage 1 — clears the query, popover stays open
    expect(input).toHaveValue('');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}'); // stage 2 — closes the popover
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('a third Escape, with nothing left to clear or close, is inert', async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard('{Escape}{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TagInput chips', () => {
  it('renders a removable chip per tag and drops the one whose remove button is pressed', async () => {
    const { onChange, user } = setup({ tags: ['bug', 'ui'] });
    expect(screen.getByRole('button', { name: 'Remove tag bug' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove tag ui' }));
    expect(onChange).toHaveBeenCalledWith(['bug']);
  });

  it('prompts with a placeholder while the field is empty', () => {
    setup();
    expect(screen.getByRole('combobox', { name: 'Add a tag' })).toHaveAttribute(
      'placeholder',
      'Type to add or search…',
    );
  });

  it('drops the placeholder once at least one chip is present', () => {
    setup({ tags: ['bug'] });
    expect(screen.getByRole('combobox', { name: 'Add a tag' })).toHaveAttribute('placeholder', '');
  });

  it('never offers a suggestion that is already a chip on this item', async () => {
    const { user } = setup({ tags: ['bug'], suggestions: ['bug', 'ui'] });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.queryByRole('option', { name: 'bug' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ui' })).toBeInTheDocument();
  });
});

describe('TagInput empty states', () => {
  it('invites a first tag when the program has no existing tags', async () => {
    const { user } = setup({ suggestions: undefined });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.getByRole('status')).toHaveTextContent('No tags yet — type to create one.');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('leaves every navigation key inert while the list is empty', async () => {
    const { onChange, user } = setup({ suggestions: [] });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.keyboard('{ArrowDown}{ArrowUp}{Home}{End}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No tags yet');
  });

  // #2668: `filtered` (program suggestions minus tags already on this item) is
  // empty for two very different reasons, and only one of them means the
  // program has no tags. When every existing suggestion is already a chip on
  // this item, saying "No tags yet" is false — tags are visibly attached.
  it('distinguishes "every tag already added" from a genuinely tag-less program', async () => {
    const { onChange, user } = setup({ tags: ['bug', 'ui'], suggestions: ['bug', 'ui'] });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'All existing tags are already added — type to create a new one.',
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TagInput ARIA wiring', () => {
  it('reports collapsed with no active option until it is focused', async () => {
    const { user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await user.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-opt-0$/));
  });

  it('exposes no active option when the open list has no rows', async () => {
    const { user } = setup({ suggestions: [] });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('derives the listbox and option ids from an explicit id prop', async () => {
    const { user } = setup({ id: 'tags-field' });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    expect(input).toHaveAttribute('aria-controls', 'tags-field-listbox');
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'tags-field-listbox');
    expect(screen.getByRole('option', { name: 'bug' })).toHaveAttribute('id', 'tags-field-opt-0');
    expect(input).toHaveAttribute('aria-activedescendant', 'tags-field-opt-0');
  });
});

describe('TagInput keyboard roving', () => {
  it('ArrowUp wraps from the first row to the last', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.keyboard('{ArrowUp}'); // 0 → last (urgent)
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['urgent']);
  });

  it('End jumps to the last row and Home back to the first', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.keyboard('{End}');
    expect(screen.getByRole('option', { name: 'urgent' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('option', { name: 'bug' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['bug']);
  });

  it('ArrowDown reopens a popover that Escape closed', async () => {
    const { user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('ArrowUp reopens a popover that Escape closed', async () => {
    const { user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('typing reopens a popover that Escape closed', async () => {
    const { user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.type(input, 'u');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ui' })).toBeInTheDocument();
  });

  it('hovering a row makes it the active option that Enter then commits', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.hover(screen.getByRole('option', { name: 'urgent' }));
    expect(screen.getByRole('option', { name: 'urgent' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'bug' })).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['urgent']);
  });

  it('stays open and focused after a commit so tags can be added back to back', async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'alpha');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['alpha']);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('TagInput comma shortcut', () => {
  it('commits exactly what was typed', async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'newtag,');
    expect(onChange).toHaveBeenCalledWith(['newtag']);
    expect(input).toHaveValue('');
  });

  it('is an ordinary character when the query is empty', async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.click(input);
    await user.keyboard(',');
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(',');
  });

  it('clears the draft without duplicating a chip that is already present', async () => {
    const { onChange, user } = setup({ tags: ['Bug'], suggestions: ['Bug'] });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'bug,');
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });
});

describe('TagInput value normalization', () => {
  it('trims the query before offering and committing a new tag', async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, '  spaced  ');
    expect(screen.getByRole('option', { name: 'Create "spaced"' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['spaced']);
  });

  it('refuses to add a whitespace-only suggestion', async () => {
    const { onChange, user } = setup({ suggestions: ['   '] });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.click(screen.getByRole('option'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not offer Create for a case-variant of an existing suggestion', async () => {
    const { user } = setup({ suggestions: ['Bug'] });
    await user.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'bug');
    expect(screen.getByRole('option', { name: 'Bug' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
  });
});

describe('TagInput dismissal and Backspace', () => {
  it('discards an uncommitted query on an outside click', async () => {
    const onChange = vi.fn<(next: string[]) => void>();
    render(
      <div>
        <button type="button">Outside</button>
        <TagInput tags={[]} onChange={onChange} suggestions={['bug']} />
      </div>,
    );
    const user = userEvent.setup();
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'draft');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace edits the query rather than removing a chip while text remains', async () => {
    const { onChange, user } = setup({ tags: ['bug'] });
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    await user.type(input, 'ab');
    await user.keyboard('{Backspace}');
    expect(input).toHaveValue('a');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace with no chips and no query does nothing', async () => {
    const { onChange, user } = setup({ tags: [] });
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.keyboard('{Backspace}');
    expect(onChange).not.toHaveBeenCalled();
  });
});
