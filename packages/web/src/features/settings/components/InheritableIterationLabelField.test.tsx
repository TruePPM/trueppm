import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InheritableIterationLabelField } from './InheritableIterationLabelField';

describe('InheritableIterationLabelField', () => {
  it('shows the inherited value and the "using …" note when inheriting (value null)', () => {
    render(
      <InheritableIterationLabelField
        value={null}
        onChange={vi.fn()}
        inheritedLabel="Iteration"
        inheritFromLabel="the workspace default"
      />,
    );
    // Inherit chip is selected and names the inherited value.
    const inherit = screen.getByRole('radio', { name: /inherit/i });
    expect(inherit).toBeChecked();
    expect(screen.getByText(/using the workspace default:/i)).toBeInTheDocument();
    expect(screen.getByText('Iteration')).toBeInTheDocument();
  });

  it('emits null when "Inherit" is chosen', async () => {
    const onChange = vi.fn();
    render(
      <InheritableIterationLabelField
        value="Cycle"
        onChange={onChange}
        inheritedLabel="Sprint"
        inheritFromLabel="the workspace default"
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /inherit/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('seeds the override from the inherited value when switching to custom', async () => {
    const onChange = vi.fn();
    render(
      <InheritableIterationLabelField
        value={null}
        onChange={onChange}
        inheritedLabel="Iteration"
        inheritFromLabel="the workspace default"
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /set a custom label/i }));
    // Opening the override seeds from the currently-inherited value (not empty).
    expect(onChange).toHaveBeenCalledWith('Iteration');
  });

  it('reveals the preset/custom picker when overriding (value set)', () => {
    render(
      <InheritableIterationLabelField
        value="Sprint"
        onChange={vi.fn()}
        inheritedLabel="Sprint"
        inheritFromLabel="the workspace default"
      />,
    );
    // The #862 IterationLabelField presets are now visible.
    expect(screen.getByRole('radio', { name: 'Iteration' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'PI' })).toBeInTheDocument();
    expect(screen.queryByText(/using the workspace default/i)).not.toBeInTheDocument();
  });
});
