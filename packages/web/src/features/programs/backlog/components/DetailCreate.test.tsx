import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DetailCreate } from './DetailCreate';

describe('DetailCreate', () => {
  it('blocks submit and shows an inline error when the title is empty', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    expect(screen.getByText('Give the item a title before creating it.')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits the form values when a title is provided', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'New telemetry link' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'spike' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New telemetry link', itemType: 'spike' }),
      ),
    );
  });
});
