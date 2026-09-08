import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DetailCreate } from './DetailCreate';

describe('DetailCreate', () => {
  it('blocks submit and shows an inline error when the title is empty', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    expect(screen.getByText('Give the item a title before creating it.')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('Cancel with no edits closes immediately, without the unsaved guard (#1996)', () => {
    const onCancel = vi.fn();
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={onCancel} onCreate={vi.fn()} />);

    // Footer "Cancel" (index 0 is the header ✕, which shares the accessible name).
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('guards a typed draft on Cancel and discards only on confirm (#1996)', () => {
    const onCancel = vi.fn();
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={onCancel} onCreate={vi.fn()} />);

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
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={vi.fn()} onCreate={onCreate} />);

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
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Estimated work' } });
    fireEvent.change(screen.getByLabelText('Story points'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ storyPoints: 5 })),
    );
  });

  it('submits null story points when the estimate is left blank', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Unestimated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ storyPoints: null })),
    );
  });

  it('hides the story-points field for container types (epic/feature) and clears any estimate', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<DetailCreate tagSuggestions={[]} estimationScale="fibonacci" methodology="HYBRID" onCancel={vi.fn()} onCreate={onCreate} />);

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

  // #3644 — ADR-0069 accepted "must not force Agile vocabulary on waterfall
  // users" and the surface read `Program.methodology` nowhere at all.
  describe('methodology-aware vocabulary (#3644)', () => {
    it('names the points field "Estimate" on WATERFALL, in the label AND the accessible name', () => {
      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="WATERFALL"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );

      // `getByLabelText` resolves through the accessible name, so this asserts
      // the `ariaLabel` prop moved too — a visible "Estimate" over an accessible
      // "Story points" is the WCAG 2.5.3 failure the label change exists to
      // avoid, and it would pass a visible-text-only assertion.
      expect(screen.getByLabelText('Estimate')).toBeInTheDocument();
      expect(screen.queryByLabelText('Story points')).not.toBeInTheDocument();
      expect(screen.queryByText('Story points')).not.toBeInTheDocument();
    });

    it('keeps "Story points" on AGILE and HYBRID', () => {
      const { unmount } = render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="AGILE"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Story points')).toBeInTheDocument();
      unmount();

      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="HYBRID"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Story points')).toBeInTheDocument();
    });

    it('starts a WATERFALL draft on Task, and submits that type untouched', async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="WATERFALL"
          onCancel={vi.fn()}
          onCreate={onCreate}
        />,
      );

      expect(screen.getByLabelText('Type')).toHaveValue('task');

      fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Pour foundation' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

      await waitFor(() =>
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'task' })),
      );
    });

    it('starts an AGILE draft on Story', () => {
      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="AGILE"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Type')).toHaveValue('story');
    });

    it('offers the SAME type set on every methodology — only the order moves', () => {
      // The set is load-bearing: `item_type` is persisted, so dropping `story`
      // on WATERFALL would make an existing story item unrepresentable in its
      // own dropdown the moment a program flips preset.
      const optionValues = () =>
        Array.from(
          screen.getByLabelText('Type').querySelectorAll('option'),
        ).map((o) => o.value);

      const { unmount } = render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="WATERFALL"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
      const waterfall = optionValues();
      unmount();

      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="AGILE"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
      const agile = optionValues();

      expect([...waterfall].sort()).toEqual([...agile].sort());
      expect(waterfall[0]).toBe('task');
      expect(agile[0]).toBe('story');
    });

    it('describes what tags are and become, bound to the tag input', () => {
      render(
        <DetailCreate
          tagSuggestions={[]}
          estimationScale="fibonacci"
          methodology="HYBRID"
          onCancel={vi.fn()}
          onCreate={vi.fn()}
        />,
      );

      const hint = screen.getByText('Program-wide free text. On pull, each tag becomes a project label.');
      expect(hint).toBeInTheDocument();
      // A visible sentence nobody's screen reader reaches is half a fix — assert
      // the description is actually wired to the combobox, not merely rendered
      // near it.
      expect(screen.getByRole('combobox', { name: 'Add a tag' })).toHaveAttribute(
        'aria-describedby',
        hint.id,
      );
    });
  });
});
