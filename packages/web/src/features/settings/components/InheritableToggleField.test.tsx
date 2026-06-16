import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InheritableToggleField } from './InheritableToggleField';

describe('InheritableToggleField', () => {
  it('shows "Inherit (On)" + the using-line and no switch when inheriting (value null, inherited true)', () => {
    render(
      <InheritableToggleField
        value={null}
        onChange={vi.fn()}
        inherited={true}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    // The Inherit chip is selected and names the inherited value.
    const inherit = screen.getByRole('radio', { name: /inherit/i });
    expect(inherit).toBeChecked();
    // The chip suffix ("(On)") lives on the wrapping label, not the input.
    expect(inherit.closest('label')).toHaveTextContent(/inherit\s*\(on\)/i);
    // Body line reflects the inherited value via inheritFromLabel.
    expect(screen.getByText(/using the workspace default:/i)).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    // No override switch is rendered while inheriting.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows "Inherit (Off)" when the inherited value is false', () => {
    render(
      <InheritableToggleField
        value={null}
        onChange={vi.fn()}
        inherited={false}
        inheritFromLabel="the program or workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    const inherit = screen.getByRole('radio', { name: /inherit/i });
    expect(inherit.closest('label')).toHaveTextContent(/inherit\s*\(off\)/i);
    expect(screen.getByText(/using the program or workspace default:/i)).toBeInTheDocument();
  });

  it('renders the override switch with the on-word when overriding (value true)', () => {
    render(
      <InheritableToggleField
        value={true}
        onChange={vi.fn()}
        inherited={false}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    const switchEl = screen.getByRole('switch', { name: 'Public sharing' });
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toBeChecked();
    // The visible word is derived from state → on => onLabel.
    expect(switchEl).toHaveTextContent('On');
    // The inheriting body line is gone once overriding.
    expect(screen.queryByText(/using the workspace default/i)).not.toBeInTheDocument();
  });

  it('renders the override switch with the off-word when overriding (value false)', () => {
    render(
      <InheritableToggleField
        value={false}
        onChange={vi.fn()}
        inherited={true}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    const switchEl = screen.getByRole('switch', { name: 'Public sharing' });
    expect(switchEl).not.toBeChecked();
    expect(switchEl).toHaveTextContent('Off');
  });

  it('seeds the override from the inherited value when switching to Override while inheriting', async () => {
    const onChange = vi.fn();
    render(
      <InheritableToggleField
        value={null}
        onChange={onChange}
        inherited={true}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /override/i }));
    // Opening the override seeds from the currently-inherited boolean (true), not a flip.
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('emits null when "Inherit" is chosen while overriding', async () => {
    const onChange = vi.fn();
    render(
      <InheritableToggleField
        value={true}
        onChange={onChange}
        inherited={false}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /inherit/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('toggling the override switch emits the flipped boolean', async () => {
    const onChange = vi.fn();
    render(
      <InheritableToggleField
        value={false}
        onChange={onChange}
        inherited={false}
        inheritFromLabel="the workspace default"
        onLabel="On"
        offLabel="Off"
        ariaLabel="Public sharing"
        canEdit={true}
      />,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Public sharing' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  describe('read-only (canEdit=false)', () => {
    it('renders no radiogroup and no switch — a read-only indicator only', () => {
      render(
        <InheritableToggleField
          value={null}
          onChange={vi.fn()}
          inherited={true}
          inheritFromLabel="the workspace default"
          onLabel="On"
          offLabel="Off"
          ariaLabel="Public sharing"
          canEdit={false}
        />,
      );
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    });

    it('composite aria-label states the value, inherited provenance, and "View only."', () => {
      render(
        <InheritableToggleField
          value={null}
          onChange={vi.fn()}
          inherited={true}
          inheritFromLabel="the workspace default"
          onLabel="On"
          offLabel="Off"
          ariaLabel="Public sharing"
          canEdit={false}
        />,
      );
      expect(
        screen.getByLabelText(
          'Public sharing: On, inherited from the workspace default. View only.',
        ),
      ).toBeInTheDocument();
    });

    it('composite aria-label uses the override provenance when the value is set', () => {
      render(
        <InheritableToggleField
          value={false}
          onChange={vi.fn()}
          inherited={true}
          inheritFromLabel="the workspace default"
          scopeNoun="project"
          onLabel="On"
          offLabel="Off"
          ariaLabel="Public sharing"
          canEdit={false}
        />,
      );
      // value=false overrides the inherited true → Off, set on this project.
      expect(
        screen.getByLabelText('Public sharing: Off, set on this project. View only.'),
      ).toBeInTheDocument();
    });
  });
});
