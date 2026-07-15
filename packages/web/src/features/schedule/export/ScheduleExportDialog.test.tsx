import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ScheduleExportDialog, type ScheduleExportDialogProps } from './ScheduleExportDialog';
import { DEFAULT_EXPORT_OPTIONS } from './exportOptions';
import type { ExportResult } from './exportSchedulePdf';

function makeProps(overrides: Partial<ScheduleExportDialogProps> = {}): ScheduleExportDialogProps {
  return {
    phase: 'configuring',
    options: DEFAULT_EXPORT_OPTIONS,
    setOption: vi.fn(),
    filteredCount: 12,
    estimateMs: 1400,
    progress: null,
    result: null,
    error: null,
    visibleWindowAvailable: true,
    onExport: vi.fn(),
    onCancelGenerating: vi.fn(),
    onReset: vi.fn(),
    onOpenInViewer: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const SUCCESS_RESULT: ExportResult = {
  fileName: 'Apollo_Schedule_2026-07-05.pdf',
  pageCount: 1,
  paper: 'letter',
  destination: 'download',
  byteSize: 84_000,
  canceled: false,
  blobUrl: 'blob:mock',
};

const PRINT_RESULT: ExportResult = {
  ...SUCCESS_RESULT,
  destination: 'print',
  // No file lands on disk when printing — the byte size is meaningless and unshown.
  byteSize: 0,
};

describe('ScheduleExportDialog — configuring', () => {
  it('is a labelled modal dialog', () => {
    render(<ScheduleExportDialog {...makeProps()} />);
    expect(screen.getByRole('dialog', { name: 'Export schedule' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
  });

  it('offers Layout A enabled and Layout B disabled (until #1439)', () => {
    render(<ScheduleExportDialog {...makeProps()} />);
    const group = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(within(group).getByRole('radio', { name: 'A — One-page Gantt' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'B — Report' })).toBeDisabled();
  });

  it('reflects Paper as a segmented radiogroup and commits a change', () => {
    const setOption = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ setOption })} />);
    const group = screen.getByRole('radiogroup', { name: 'Paper' });
    expect(within(group).getByRole('radio', { name: 'Letter' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'A4' }));
    expect(setOption).toHaveBeenCalledWith('paper', 'a4');
  });

  it('disables the Visible-window range when it is unavailable', () => {
    render(<ScheduleExportDialog {...makeProps({ visibleWindowAvailable: false })} />);
    const group = screen.getByRole('radiogroup', { name: 'Timeline range' });
    expect(within(group).getByRole('radio', { name: 'Visible window' })).toBeDisabled();
  });

  it('renders the four Include switches and toggles one', () => {
    const setOption = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ setOption })} />);
    expect(screen.getByRole('switch', { name: 'Include dependency arrows' })).toBeChecked();
    // Default is non-critical OFF.
    expect(screen.getByRole('switch', { name: 'Include non-critical tasks' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch', { name: 'Include dependency arrows' }));
    expect(setOption).toHaveBeenCalledWith('includeArrows', false);
  });

  it('offers Download/Print as a segmented radiogroup and commits a change (#1970)', () => {
    const setOption = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ setOption })} />);
    const group = screen.getByRole('radiogroup', { name: 'Destination' });
    expect(within(group).getByRole('radio', { name: 'Download' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Print' }));
    expect(setOption).toHaveBeenCalledWith('destination', 'print');
  });

  it('makes the primary action label track the destination (#1970)', () => {
    const { rerender } = render(<ScheduleExportDialog {...makeProps()} />);
    // Default destination is download → the incumbent label.
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
    rerender(
      <ScheduleExportDialog
        {...makeProps({ options: { ...DEFAULT_EXPORT_OPTIONS, destination: 'print' } })}
      />,
    );
    // Print carries the ellipsis (opens the OS dialog next); Download does not.
    expect(screen.getByRole('button', { name: 'Print…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
  });

  it('disables the single primary for either destination when count is 0 (#1970)', () => {
    const { rerender } = render(<ScheduleExportDialog {...makeProps({ filteredCount: 0 })} />);
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
    rerender(
      <ScheduleExportDialog
        {...makeProps({
          filteredCount: 0,
          options: { ...DEFAULT_EXPORT_OPTIONS, destination: 'print' },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Print…' })).toBeDisabled();
    // The destination control itself stays usable at count 0 — the gate is the button.
    expect(screen.getByRole('radio', { name: 'Print' })).toBeEnabled();
  });

  it('shows the activity count read-out and calls onExport', () => {
    const onExport = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ onExport, filteredCount: 12 })} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('disables Export when no activities match the options', () => {
    render(<ScheduleExportDialog {...makeProps({ filteredCount: 0 })} />);
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  });

  it('Cancel and Escape both close the dialog', () => {
    const onClose = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ScheduleExportDialog — generating', () => {
  it('renders a progressbar with discrete aria values and a stable name', () => {
    render(
      <ScheduleExportDialog
        {...makeProps({ phase: 'generating', progress: { phase: 'paginate', done: 2, total: 3 } })}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Export progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByText('Placing page 2 of 3…')).toBeInTheDocument();
  });

  it('Cancel and Escape both abort the in-flight generation', () => {
    const onCancelGenerating = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ phase: 'generating', onCancelGenerating })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelGenerating).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancelGenerating).toHaveBeenCalledTimes(2);
  });

  it('announces the discrete generating transition, not the ticking percent', () => {
    render(
      <ScheduleExportDialog
        {...makeProps({ phase: 'generating', progress: { phase: 'paginate', done: 2, total: 3 } })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Generating the PDF');
    expect(screen.getByRole('status')).not.toHaveTextContent('%');
  });
});

describe('ScheduleExportDialog — success', () => {
  it('shows the file card with name, pages, paper, and size', () => {
    render(<ScheduleExportDialog {...makeProps({ phase: 'success', result: SUCCESS_RESULT })} />);
    expect(screen.getByRole('heading', { name: /PDF ready/ })).toBeInTheDocument();
    expect(screen.getByText('Apollo_Schedule_2026-07-05.pdf')).toBeInTheDocument();
    expect(screen.getByText(/1 page · Letter · 82 KB/)).toBeInTheDocument();
  });

  it('offers Open in viewer only when a blob URL exists', () => {
    const { rerender } = render(
      <ScheduleExportDialog {...makeProps({ phase: 'success', result: SUCCESS_RESULT })} />,
    );
    expect(screen.getByRole('button', { name: 'Open in viewer' })).toBeInTheDocument();
    rerender(
      <ScheduleExportDialog
        {...makeProps({ phase: 'success', result: { ...SUCCESS_RESULT, blobUrl: null } })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open in viewer' })).not.toBeInTheDocument();
  });

  it('branches to the print card — "dialog opened", no filename/bytes, printable-PDF link (#1970)', () => {
    render(<ScheduleExportDialog {...makeProps({ phase: 'success', result: PRINT_RESULT })} />);
    // Never claims the sheet was printed — we cannot detect the OS dialog outcome.
    expect(screen.getByRole('heading', { name: /Print dialog opened/ })).toBeInTheDocument();
    expect(screen.getByText('Sent to your printer')).toBeInTheDocument();
    // Nothing hit disk: no filename, and the byte size is suppressed.
    expect(screen.queryByText(PRINT_RESULT.fileName)).not.toBeInTheDocument();
    expect(screen.getByText(/1 page · Letter/)).toBeInTheDocument();
    expect(screen.queryByText(/KB|MB|82 KB/)).not.toBeInTheDocument();
    // The blob-backed fallback is relabeled for the print branch.
    expect(screen.getByRole('button', { name: 'Open printable PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in viewer' })).not.toBeInTheDocument();
  });

  it('announces "Print dialog opened" through the live region, never "Printed" (#1970)', () => {
    render(<ScheduleExportDialog {...makeProps({ phase: 'success', result: PRINT_RESULT })} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Print dialog opened');
    expect(status).not.toHaveTextContent(/Printed|download/i);
  });

  it('Export again returns to the options; Done closes', () => {
    const onReset = vi.fn();
    const onClose = vi.fn();
    render(
      <ScheduleExportDialog
        {...makeProps({ phase: 'success', result: SUCCESS_RESULT, onReset, onClose })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export again…' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleExportDialog — error', () => {
  it('surfaces an alert, the machine code, and a Try again that resets', () => {
    const onReset = vi.fn();
    render(
      <ScheduleExportDialog {...makeProps({ phase: 'error', error: 'RASTER_TIMEOUT', onReset })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t generate the PDF/);
    expect(screen.getByText('code: RASTER_TIMEOUT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleExportDialog — focus management', () => {
  it('re-seats focus inside the panel after a phase transition so the trap holds', () => {
    const { rerender } = render(<ScheduleExportDialog {...makeProps({ phase: 'configuring' })} />);
    rerender(
      <ScheduleExportDialog
        {...makeProps({ phase: 'generating', progress: { phase: 'rasterize', done: 0, total: 1 } })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Export schedule' });
    // After the transition the previously-focused control unmounts; focus must
    // move back inside the still-open modal, not fall to <body> (WCAG 2.4.3).
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});
