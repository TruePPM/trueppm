import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormatPicker } from './FormatPicker';

describe('FormatPicker', () => {
  it('marks .xml supported and .mpp/.mpx not yet supported', () => {
    render(<FormatPicker guidanceOpen={false} onToggleGuidance={() => {}} />);

    expect(screen.getByText('MS Project XML (MSPDI)')).toBeInTheDocument();
    expect(screen.getByText('Supported')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet supported')).toHaveLength(2); // .mpp + .mpx
  });

  it('shows TruePPM as a disabled "coming soon" format and MS Project as selected', () => {
    render(<FormatPicker guidanceOpen={false} onToggleGuidance={() => {}} />);

    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    const truePpm = screen.getByText('TruePPM').closest('[role="radio"]');
    expect(truePpm).toHaveAttribute('aria-disabled', 'true');
    expect(truePpm).toHaveAttribute('aria-checked', 'false');

    const msProject = screen.getByText('MS Project').closest('[role="radio"]');
    expect(msProject).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the disabled .mpp/.mpx rows perceivable (not just dimmed) and described by the guidance', () => {
    render(<FormatPicker guidanceOpen={false} onToggleGuidance={() => {}} />);
    const mpp = screen.getByText('.mpp').closest('[role="radio"]');
    expect(mpp).toHaveAttribute('aria-disabled', 'true');
    expect(mpp).toHaveAttribute('aria-describedby', 'msproject-xml-guidance');
  });

  it('toggles the conversion guidance via the (non-disabled) disclosure button', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <FormatPicker guidanceOpen={false} onToggleGuidance={onToggle} />,
    );

    const disclosure = screen.getByRole('button', { name: /how do i get an \.xml file/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<FormatPicker guidanceOpen onToggleGuidance={onToggle} />);
    expect(screen.getByRole('button', { name: /how do i get an \.xml file/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/Save As/)).toBeVisible();
  });
});
