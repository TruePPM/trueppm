import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { RefObject } from 'react';
import { TaskDescriptionField } from './TaskDescriptionField';

const NOOP = () => {};

function renderField(props: Partial<Parameters<typeof TaskDescriptionField>[0]> = {}) {
  return render(
    <TaskDescriptionField
      value=""
      onChange={NOOP}
      onBlur={NOOP}
      changedElsewhere={false}
      {...props}
    />,
  );
}

describe('TaskDescriptionField', () => {
  describe('read mode rendering (issue 1048)', () => {
    it('renders Markdown to formatted output — bold, lists, inline code', () => {
      renderField({ value: '**Bold AC** and\n\n- first\n- second\n\nUse `token`.' });
      const readBlock = screen.getByRole('button', { name: 'Description' });

      expect(within(readBlock).getByText('Bold AC').tagName).toBe('STRONG');
      const items = within(readBlock).getAllByRole('listitem');
      expect(items.map((li) => li.textContent)).toEqual(['first', 'second']);
      expect(within(readBlock).getByText('token').tagName).toBe('CODE');
      // The raw Markdown source is not shown verbatim.
      expect(readBlock).not.toHaveTextContent('**Bold AC**');
    });

    it('shows an editable empty-state placeholder as a clickable block', () => {
      renderField({ value: '' });
      const readBlock = screen.getByRole('button', { name: 'Description' });
      expect(readBlock).toHaveTextContent('Add a description…');
    });

    it('renders read-only content without a click-to-edit affordance', () => {
      renderField({ value: '**locked**', readOnly: true });
      expect(screen.queryByRole('button', { name: 'Description' })).toBeNull();
      expect(screen.getByText('locked').tagName).toBe('STRONG');
    });

    it('shows a muted "No description" for an empty read-only field', () => {
      renderField({ value: '', readOnly: true });
      expect(screen.queryByRole('button', { name: 'Description' })).toBeNull();
      expect(screen.getByText('No description')).toBeInTheDocument();
    });

    it('does not render raw HTML embedded in the Markdown (XSS floor)', () => {
      renderField({ value: '<img src=x onerror="boom">**safe**', readOnly: true });
      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByText('safe').tagName).toBe('STRONG');
    });
  });

  describe('read/edit swap', () => {
    it('clicking the rendered block swaps in a textarea holding the raw source', () => {
      const onChange = vi.fn();
      renderField({ value: '**raw**', onChange });

      fireEvent.click(screen.getByRole('button', { name: 'Description' }));
      const textarea = screen.getByRole('textbox', { name: 'Description' });
      expect(textarea).toHaveValue('**raw**');

      fireEvent.change(textarea, { target: { value: '**raw** more' } });
      expect(onChange).toHaveBeenCalledWith('**raw** more');
    });

    it('blurring the textarea calls onBlur (if given) and preserves the draft in read mode', () => {
      const onBlur = vi.fn();
      renderField({ value: '**kept**', onBlur });

      fireEvent.click(screen.getByRole('button', { name: 'Description' }));
      const textarea = screen.getByRole('textbox', { name: 'Description' });
      fireEvent.blur(textarea);

      expect(onBlur).toHaveBeenCalledTimes(1);
      // Back to read mode, with the value still rendered (draft not lost).
      expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
      const readBlock = screen.getByRole('button', { name: 'Description' });
      expect(within(readBlock).getByText('kept').tagName).toBe('STRONG');
    });

    it('never enters edit mode for a read-only field', () => {
      renderField({ value: '**locked**', readOnly: true });
      // No editable affordance exists at all.
      expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Description' })).toBeNull();
    });

    it('surfaces the concurrent-edit notice', () => {
      renderField({ value: 'x', changedElsewhere: true });
      fireEvent.click(screen.getByRole('button', { name: 'Description' }));
      expect(screen.getByText(/Updated by someone else/i)).toBeInTheDocument();
    });
  });

  describe('scroll preservation across the edit remount (issue 1048)', () => {
    it('restores the textarea scrollTop when edit mode re-mounts', () => {
      const scrollTopRef: RefObject<number> = { current: 0 };
      renderField({ value: 'long body', scrollTopRef });

      // Enter edit, scroll, and let the handler cache the position.
      fireEvent.click(screen.getByRole('button', { name: 'Description' }));
      const textarea = screen.getByRole('textbox', { name: 'Description' });
      textarea.scrollTop = 42;
      fireEvent.scroll(textarea);
      expect(scrollTopRef.current).toBe(42);

      // Blur back to read mode (the field unmounts the textarea), then re-enter.
      fireEvent.blur(textarea);
      fireEvent.click(screen.getByRole('button', { name: 'Description' }));
      const textareaAgain = screen.getByRole('textbox', { name: 'Description' });
      expect(textareaAgain.scrollTop).toBe(42);
    });
  });
});
