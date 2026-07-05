import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormatPicker } from './FormatPicker';

function renderPicker(
  overrides: Partial<Parameters<typeof FormatPicker>[0]> = {},
) {
  const props = {
    format: 'msproject' as const,
    onSelectFormat: vi.fn(),
    truePpmEnabled: true,
    guidanceOpen: false,
    onToggleGuidance: vi.fn(),
    ...overrides,
  };
  render(<FormatPicker {...props} />);
  return props;
}

describe('FormatPicker', () => {
  it('marks .xml supported and .mpp/.mpx not yet supported (MS Project selected)', () => {
    renderPicker();

    expect(screen.getByText('MS Project XML (MSPDI)')).toBeInTheDocument();
    expect(screen.getByText('Supported')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet supported')).toHaveLength(2); // .mpp + .mpx
  });

  it('offers TruePPM as a real, selectable format tile when enabled', () => {
    renderPicker();

    // No longer "coming soon" — it is a live choice.
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();

    const truePpm = screen.getByText('TruePPM').closest('[role="radio"]');
    expect(truePpm).not.toHaveAttribute('aria-disabled');
    expect(truePpm).toHaveAttribute('aria-checked', 'false'); // MS Project is selected
    expect(truePpm).toHaveAttribute('tabindex', '0');

    const msProject = screen.getByText('MS Project').closest('[role="radio"]');
    expect(msProject).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting the TruePPM tile calls onSelectFormat("trueppm")', async () => {
    const props = renderPicker();
    const truePpm = screen.getByText('TruePPM').closest('[role="radio"]')!;
    await userEvent.click(truePpm);
    expect(props.onSelectFormat).toHaveBeenCalledWith('trueppm');
  });

  it('when TruePPM is selected, shows the .json supported row and hides MS Project file types', () => {
    renderPicker({ format: 'trueppm' });

    expect(screen.getByText('Canonical TruePPM seed')).toBeInTheDocument();
    expect(screen.getByText('Supported')).toBeInTheDocument();
    // MS Project-specific rows and guidance are gone in the TruePPM view.
    expect(screen.queryByText('MS Project XML (MSPDI)')).not.toBeInTheDocument();
    expect(screen.queryByText(/how do i get an \.xml file/i)).not.toBeInTheDocument();

    const truePpm = screen.getByText('TruePPM').closest('[role="radio"]');
    expect(truePpm).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the TruePPM tile disabled with an honest reason when not enabled (within a program)', () => {
    renderPicker({ truePpmEnabled: false });

    const truePpm = screen.getByText('TruePPM').closest('[role="radio"]');
    expect(truePpm).toHaveAttribute('aria-disabled', 'true');
    expect(truePpm).toHaveAttribute('aria-checked', 'false');
    expect(truePpm).toHaveAttribute(
      'title',
      'A TruePPM export is a whole program — import it from the Programs page',
    );
  });

  it('keeps the disabled .mpp/.mpx rows perceivable and described by the guidance', () => {
    renderPicker();
    const mpp = screen.getByText('.mpp').closest('[role="radio"]');
    expect(mpp).toHaveAttribute('aria-disabled', 'true');
    expect(mpp).toHaveAttribute('aria-describedby', 'msproject-xml-guidance');
  });

  it('toggles the conversion guidance via the (non-disabled) disclosure button', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <FormatPicker
        format="msproject"
        onSelectFormat={() => {}}
        truePpmEnabled
        guidanceOpen={false}
        onToggleGuidance={onToggle}
      />,
    );

    const disclosure = screen.getByRole('button', { name: /how do i get an \.xml file/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <FormatPicker
        format="msproject"
        onSelectFormat={() => {}}
        truePpmEnabled
        guidanceOpen
        onToggleGuidance={onToggle}
      />,
    );
    expect(screen.getByRole('button', { name: /how do i get an \.xml file/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/Save As/)).toBeVisible();
  });
});
