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
  byteSize: 84_000,
  canceled: false,
  blobUrl: 'blob:mock',
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

  it('shows the activity count read-out and calls onExport', () => {
    const onExport = vi.fn();
    render(<ScheduleExportDialog {...makeProps({ onExport, filteredCount: 12 })} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('disables Export when no activities match the options', () => {
    render(<ScheduleExportDialog {...makeProps({ filteredCount: 0 })} />);
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled();
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
