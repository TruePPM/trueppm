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
});
