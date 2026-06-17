import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InheritableNumberField } from './InheritableNumberField';

const base = {
  inheritFromLabel: 'the workspace default',
  min: 1,
  max: 500,
  ariaLabel: 'Run history limit',
} as const;

describe('InheritableNumberField', () => {
  it('shows "Inherit (N)" + the using-line and no input when inheriting', () => {
    render(
      <InheritableNumberField {...base} value={null} onChange={vi.fn()} inherited={100} canEdit />,
    );
    const inherit = screen.getByRole('radio', { name: /inherit/i });
    expect(inherit).toBeChecked();
    expect(inherit.closest('label')).toHaveTextContent(/inherit\s*\(100\)/i);
    expect(screen.getByText(/using the workspace default:/i)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('renders the override input seeded with the override value', () => {
    render(
      <InheritableNumberField {...base} value={250} onChange={vi.fn()} inherited={100} canEdit />,
    );
    expect(screen.getByRole('spinbutton', { name: 'Run history limit' })).toHaveValue(250);
    expect(screen.queryByText(/using the workspace default/i)).not.toBeInTheDocument();
  });

  it('seeds the override from the effective value (clamped) when switching to Override', async () => {
    const onChange = vi.fn();
    render(
      <InheritableNumberField {...base} value={null} onChange={onChange} inherited={100} canEdit />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /override/i }));
    expect(onChange).toHaveBeenCalledWith(100);
  });

  it('emits null when "Inherit" is chosen while overriding', async () => {
    const onChange = vi.fn();
    render(
      <InheritableNumberField {...base} value={42} onChange={onChange} inherited={100} canEdit />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /inherit/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('clamps an over-max entry to the hard cap before emitting', () => {
    const onChange = vi.fn();
    render(
      <InheritableNumberField {...base} value={10} onChange={onChange} inherited={100} canEdit />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Run history limit' }), {
      target: { value: '9999' },
    });
    expect(onChange).toHaveBeenCalledWith(500);
  });

  it('clamps a below-min entry up to the floor before emitting', () => {
    const onChange = vi.fn();
    render(
      <InheritableNumberField {...base} value={10} onChange={onChange} inherited={100} canEdit />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Run history limit' }), {
      target: { value: '0' },
    });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  describe('read-only (canEdit=false)', () => {
    it('renders no radiogroup and no input — a read-only indicator only', () => {
      render(
        <InheritableNumberField
          {...base}
          value={null}
          onChange={vi.fn()}
          inherited={100}
          canEdit={false}
        />,
      );
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    });

    it('composite aria-label states the effective value and provenance', () => {
      render(
        <InheritableNumberField
          {...base}
          value={250}
          onChange={vi.fn()}
          inherited={100}
          scopeNoun="project"
          canEdit={false}
        />,
      );
      expect(
        screen.getByLabelText('Run history limit: 250, set on this project. View only.'),
      ).toBeInTheDocument();
    });
  });
});
