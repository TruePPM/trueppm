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

  it('Cancel with no edits closes immediately, without the unsaved guard (#1996)', () => {
    const onCancel = vi.fn();
    render(<DetailCreate tagSuggestions={[]} onCancel={onCancel} onCreate={vi.fn()} />);

    // Footer "Cancel" (index 0 is the header ✕, which shares the accessible name).
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('guards a typed draft on Cancel and discards only on confirm (#1996)', () => {
    const onCancel = vi.fn();
    render(<DetailCreate tagSuggestions={[]} onCancel={onCancel} onCreate={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Draft title' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);

    // The guard interrupts — the draft is not discarded yet.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
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

  it('submits the entered story-points estimate', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Estimated work' } });
    fireEvent.change(screen.getByLabelText('Story points'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ storyPoints: 5 })),
    );
  });

  it('submits null story points when the estimate is left blank', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Unestimated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ storyPoints: null })),
    );
  });

  it('hides the story-points field for container types (epic/feature) and clears any estimate', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} onCancel={vi.fn()} onCreate={onCreate} />);

    // Default type is Story → points visible and estimable.
    fireEvent.change(screen.getByLabelText('Story points'), { target: { value: '8' } });
    expect(screen.getByLabelText('Story points')).toBeInTheDocument();

    // Switch to Epic → points field disappears and the staged estimate is dropped.
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'epic' } });
    expect(screen.queryByLabelText('Story points')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'A container' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ itemType: 'epic', storyPoints: null }),
      ),
    );
  });
});
