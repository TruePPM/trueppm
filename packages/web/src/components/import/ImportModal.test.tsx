import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ImportModal } from './ImportModal';

function setup() {
  return renderWithProviders(<ImportModal projectId="p1" onClose={() => {}} />);
}

describe('ImportModal', () => {
  it('renders the dialog with the dropzone in the idle state', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Import from MS Project' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose file or drag one here/ })).toBeVisible();
    // Import is disabled until a file is selected.
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('applies the mobile full-screen-sheet variant on the dialog (#788)', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Import from MS Project' });
    // Below md the centered card becomes an edge-to-edge, full-height flex column
    // with no rounding/border so header + scrollable body + docked footer stack.
    for (const cls of [
      'max-md:flex',
      'max-md:h-full',
      'max-md:max-w-none',
      'max-md:flex-col',
      'max-md:rounded-none',
      'max-md:border-0',
    ]) {
      expect(dialog).toHaveClass(cls);
    }
    // Desktop card sizing is untouched.
    expect(dialog).toHaveClass('max-w-[560px]');
    expect(dialog).toHaveClass('rounded-card');
  });

  it('docks the footer with a safe-area inset in the mobile sheet (#788)', () => {
    setup();
    // The Cancel/Import action row carries the docked-footer + safe-area classes.
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement;
    expect(footer).not.toBeNull();
    expect(footer).toHaveClass('max-md:pb-[env(safe-area-inset-bottom)]');
    expect(footer).toHaveClass('max-md:border-t');
  });
});
