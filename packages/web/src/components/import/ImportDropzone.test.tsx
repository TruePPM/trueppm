import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportDropzone } from './ImportDropzone';

function setup(overrides: Partial<Parameters<typeof ImportDropzone>[0]> = {}) {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const onReject = vi.fn();
  render(
    <ImportDropzone
      accept={['.csv', '.xlsx']}
      maxSizeMb={50}
      file={null}
      onSelect={onSelect}
      onClear={onClear}
      onReject={onReject}
      {...overrides}
    />,
  );
  return { onSelect, onClear, onReject };
}

function drop(file: File) {
  const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });
}

describe('<ImportDropzone>', () => {
  it('renders the empty state with accepted formats and size cap', () => {
    setup();
    expect(screen.getByText('Drag a file here, or browse…')).toBeInTheDocument();
    expect(screen.getByText('.csv, .xlsx · up to 50 MB')).toBeInTheDocument();
    // The dropzone mark is a house SVG, not the 📂 emoji it replaced.
    const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
    expect(zone.querySelector('svg')).toBeTruthy();
    expect(zone.textContent).not.toContain('📂');
  });

  it('accepts a valid file via drop', () => {
    const { onSelect, onReject } = setup();
    const file = new File(['a,b'], 'plan.csv', { type: 'text/csv' });
    drop(file);
    expect(onSelect).toHaveBeenCalledWith(file);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension', () => {
    const { onSelect, onReject } = setup();
    drop(new File(['x'], 'plan.docx', { type: 'application/octet-stream' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('.csv, .xlsx only'));
  });

  it('rejects a file over the size cap', () => {
    const { onSelect, onReject } = setup({ maxSizeMb: 1 });
    const big = new File(['x'], 'plan.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 });
    drop(big);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('shows the selected file with a Remove control', () => {
    const { onClear } = setup({
      file: new File(['a,b'], 'plan.csv', { type: 'text/csv' }),
    });
    const name = screen.getByText('plan.csv');
    expect(name).toBeInTheDocument();
    // The file mark is a house SVG, not the 📄 emoji it replaced.
    const card = name.closest('div')?.parentElement as HTMLElement;
    expect(card.querySelector('svg')).toBeTruthy();
    expect(card.textContent).not.toContain('📄');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('announces the selected file to assistive tech', () => {
    setup();
    drop(new File(['a,b'], 'plan.csv', { type: 'text/csv' }));
    // The persistent polite region voices the selection (no visual focus change).
    expect(screen.getByText('plan.csv selected, 3 B')).toBeInTheDocument();
  });

  it('highlights on drag-over and announces "Drop to upload"', () => {
    setup();
    const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
    fireEvent.dragOver(zone);
    expect(screen.getAllByText('Drop to upload').length).toBeGreaterThan(0);
  });
});
