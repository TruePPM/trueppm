import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ImportModal } from './ImportModal';

// Controllable mutation state so the phase-swap focus tests can drive the
// modal through picking → uploading → error/success without a network layer.
const h = vi.hoisted(() => ({
  mut: {
    isSuccess: false,
    isError: false,
    isPending: false,
    error: null as unknown,
    mutate: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@/hooks/useMsProjectImportExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMsProjectImportExport')>();
  return { ...actual, useImportMsProject: () => ({ ...h.mut }) };
});

beforeEach(() => {
  h.mut.isSuccess = false;
  h.mut.isError = false;
  h.mut.isPending = false;
  h.mut.error = null;
});

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

  it('seats focus inside the dialog on open', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Import from MS Project' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('re-seats focus as the body swaps phase, so Tab never escapes the modal (#1776)', () => {
    const view = setup();
    const dialog = screen.getByRole('dialog', { name: 'Import from MS Project' });

    // picking → uploading: every control unmounts; focus falls back to the
    // dialog container instead of dropping to <body>.
    h.mut.isPending = true;
    view.rerender(<ImportModal projectId="p1" onClose={() => {}} />);
    expect(document.activeElement).toBe(dialog);

    // uploading → error: focus moves onto the phase's first control.
    h.mut.isPending = false;
    h.mut.isError = true;
    h.mut.error = new Error('boom');
    view.rerender(<ImportModal projectId="p1" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('seats focus on Done when the import is queued (success phase) (#1776)', () => {
    const view = setup();
    h.mut.isSuccess = true;
    view.rerender(<ImportModal projectId="p1" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });
});

/**
 * The rejection surface (#2891/#2892). `.mpp` is no longer offered here, so the
 * Save-As-XML recipe moved from a post-selection caveat banner into the rejection
 * — which is the only place it can still be reached, and the moment it is useful.
 */
describe('ImportModal — rejection advice', () => {
  function drop(name: string, sizeBytes = 10) {
    const file = new File(['x'], name, { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: sizeBytes });
    const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
  }

  it('offers .xml only — the picker no longer advertises .mpp (#2891)', () => {
    setup();
    expect(screen.getByText('.xml · up to 50 MB')).toBeInTheDocument();
  });

  it('gives the conversion recipe when the extension is wrong', () => {
    setup();
    drop('legacy.mpp');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('.xml only');
    // The recipe must be INSIDE the alert, or a screen-reader user hears the
    // failure and nothing about the fix.
    expect(alert).toHaveTextContent('File → Save As');
    // The sentence FormatPicker carries and the old modal copy had dropped.
    expect(alert).toHaveTextContent("Project for the web can't save XML");
  });

  it('does NOT give the conversion recipe on a size rejection', () => {
    // A >50 MB MSPDI .xml is a valid file that is merely too big. Answering it
    // with "save it as XML" describes exactly what the user already did (#2892).
    setup();
    drop('plan.xml', 60 * 1024 * 1024);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('too large');
    expect(alert).not.toHaveTextContent('File → Save As');
  });

  it('uses a neutral tone for the recipe, not the semantic-warning state', () => {
    // The class string was inherited from the .mpp caveat banner, which was a real
    // warning state. Instructional how-to is not a state (rules 8b/145), and an
    // amber card outshouts the red line that is the actual error.
    setup();
    drop('legacy.mpp');
    const recipe = screen.getByText(/TruePPM imports MS Project XML/);
    expect(recipe.className).toContain('bg-neutral-surface-raised');
    expect(recipe.className).not.toContain('semantic-warning');
  });
});
