import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RagRadio } from './RagRadio';

describe('RagRadio', () => {
  it('is a radio group of glyph plus band word, keyboard operable', async () => {
    const onChange = vi.fn();
    render(<RagRadio legend="Your call" name="r" value="green" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Your call' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /On track/ })).toBeChecked();
    expect(screen.getByTestId('rag-red')).toHaveTextContent('▲Critical');
    await userEvent.click(screen.getByRole('radio', { name: /At risk/ }));
    expect(onChange).toHaveBeenCalledWith('amber');
  });

  it('renders the aside beside the options and honors disabled', () => {
    render(
      <RagRadio
        legend="Your call"
        name="r"
        value={null}
        onChange={vi.fn()}
        disabled
        aside={<span>Computed</span>}
      />,
    );
    expect(screen.getByText('Computed')).toBeInTheDocument();
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
  });
});
