/**
 * Tests for BoardSearchControl (issue 323, ADR-0145) — the board card search box:
 * collapse/expand, the result-count chip, clear (×), and Escape-to-clear.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { BoardSearchControl } from './BoardSearchControl';

function setup(over: Partial<Parameters<typeof BoardSearchControl>[0]> = {}) {
  const onChange = vi.fn();
  const inputRef = createRef<HTMLInputElement>();
  render(
    <BoardSearchControl
      value=""
      onChange={onChange}
      matchCount={0}
      isSearching={false}
      inputRef={inputRef}
      {...over}
    />,
  );
  return { onChange, inputRef };
}

describe('BoardSearchControl', () => {
  it('exposes an accessible search input bound to the / shortcut', () => {
    setup();
    const input = screen.getByRole('searchbox', { name: 'Search cards' });
    expect(input).toHaveAttribute('aria-keyshortcuts', '/');
  });

  it('typing forwards the query to onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.type(screen.getByRole('searchbox'), 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('shows the match count chip and a clear button only when a query is present', () => {
    const { rerender } = renderWith({ value: '', matchCount: 0 });
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    rerender({ value: 'foundation', matchCount: 3 });
    expect(screen.getByText('3 matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('singularizes the count chip for a single match', () => {
    setup({ value: 'roof', matchCount: 1 });
    expect(screen.getByText('1 match')).toBeInTheDocument();
  });

  it('shows a spinner placeholder while searching', () => {
    setup({ value: 'roof', matchCount: 0, isSearching: true });
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('clicking × clears the query', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: 'roof', matchCount: 1 });
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('Escape clears the query', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: 'roof', matchCount: 1 });
    const input = screen.getByRole('searchbox');
    input.focus();
    await user.keyboard('{Escape}');
    expect(onChange).toHaveBeenCalledWith('');
  });
});

// Small helper for the rerender-based count-chip test.
function renderWith(over: { value: string; matchCount: number }) {
  const inputRef = createRef<HTMLInputElement>();
  const onChange = vi.fn();
  const ui = (props: { value: string; matchCount: number }) => (
    <BoardSearchControl
      value={props.value}
      onChange={onChange}
      matchCount={props.matchCount}
      isSearching={false}
      inputRef={inputRef}
    />
  );
  const utils = render(ui(over));
  return {
    rerender: (next: { value: string; matchCount: number }) => utils.rerender(ui(next)),
  };
}
