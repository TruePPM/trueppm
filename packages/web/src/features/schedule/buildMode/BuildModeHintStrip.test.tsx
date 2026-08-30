import { describe, expect, it, vi } from 'vitest';
import { formatChord } from '@/lib/platform';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BuildModeHintStrip } from './BuildModeHintStrip';

describe('BuildModeHintStrip', () => {
  it('renders the build-mode label', () => {
    render(<BuildModeHintStrip mode="NoSelection" onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Build mode')).toBeInTheDocument();
  });

  it('shows NoSelection hints when mode is NoSelection', () => {
    render(<BuildModeHintStrip mode="NoSelection" onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Select row')).toBeInTheDocument();
    expect(screen.getByText('Edit cell')).toBeInTheDocument();
  });

  it('shows RowFocused hints when mode is RowFocused', () => {
    render(<BuildModeHintStrip mode="RowFocused" onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Indent')).toBeInTheDocument();
    expect(screen.getByText('New row below')).toBeInTheDocument();
  });

  it('shows CellEdit hints when mode is CellEdit', () => {
    render(<BuildModeHintStrip mode="CellEdit" onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Next field')).toBeInTheDocument();
  });

  it('switches hints when mode changes', () => {
    const { rerender } = render(
      <BuildModeHintStrip mode="NoSelection" onShowCheatsheet={vi.fn()} />,
    );
    expect(screen.getByText('Select row')).toBeInTheDocument();
    rerender(<BuildModeHintStrip mode="RowFocused" onShowCheatsheet={vi.fn()} />);
    expect(screen.queryByText('Select row')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('calls onShowCheatsheet when the All shortcuts button is clicked', () => {
    const onShow = vi.fn();
    render(<BuildModeHintStrip mode="NoSelection" onShowCheatsheet={onShow} />);
    fireEvent.click(screen.getByLabelText('Show all keyboard shortcuts'));
    expect(onShow).toHaveBeenCalledOnce();
  });

  it('exposes mode via data attribute for e2e selectors', () => {
    render(<BuildModeHintStrip mode="CellEdit" onShowCheatsheet={vi.fn()} />);
    expect(screen.getByTestId('build-mode-hint-strip')).toHaveAttribute(
      'data-mode',
      'CellEdit',
    );
  });
});

describe('BuildModeHintStrip — the bulk-edit entry point (#2987, #3152 S23)', () => {
  it('offers a CONTROL, not a hint chip, once a multi-row selection exists', () => {
    // `S23` — a richer sheet needs a stronger front door, and the design solves
    // the #3134 dependency by turning the lesson into a control: a control is
    // exempt from that issue's teaching-surface arbitration, so this ships
    // regardless of how #3134 resolves.
    const onBulkEdit = vi.fn();
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        selectionCount={18}
        onBulkEdit={onBulkEdit}
        onShowCheatsheet={vi.fn()}
      />,
    );
    const button = screen.getByTestId('build-mode-bulk-edit');
    // It names the act, counts the items through the plural helper, and teaches
    // the chord beside itself.
    expect(button).toHaveTextContent('Edit 18 items');
    expect(within(button).getByText(formatChord('mod+shift+k'))).toBeInTheDocument();
    fireEvent.click(button);
    expect(onBulkEdit).toHaveBeenCalled();
  });

  it('is absent for a reader who may not author — never a control that cannot act', () => {
    render(
      <BuildModeHintStrip mode="RowFocused" selectionCount={18} onShowCheatsheet={vi.fn()} />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
  });

  it('keeps the mode hints for a selection of one — the chord means nothing yet', () => {
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        selectionCount={1}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('defaults to the mode hints when no selection count is supplied', () => {
    render(<BuildModeHintStrip mode="RowFocused" onBulkEdit={vi.fn()} onShowCheatsheet={vi.fn()} />);
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('shows the selection affordances in every focus mode, not only RowFocused', () => {
    const { rerender } = render(
      <BuildModeHintStrip
        mode="NoSelection"
        selectionCount={4}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByTestId('build-mode-bulk-edit')).toBeInTheDocument();
    rerender(
      <BuildModeHintStrip
        mode="CellEdit"
        selectionCount={4}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByTestId('build-mode-bulk-edit')).toBeInTheDocument();
  });

  it('swaps back to the mode hints when the selection collapses', () => {
    const { rerender } = render(
      <BuildModeHintStrip
        mode="RowFocused"
        selectionCount={5}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByTestId('build-mode-bulk-edit')).toBeInTheDocument();
    rerender(
      <BuildModeHintStrip
        mode="RowFocused"
        selectionCount={0}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
    expect(screen.getByText('New row below')).toBeInTheDocument();
  });

  it('keeps the cheatsheet affordance available alongside the selection hints', () => {
    const onShowCheatsheet = vi.fn();
    render(
      <BuildModeHintStrip mode="RowFocused" selectionCount={3} onShowCheatsheet={onShowCheatsheet} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all keyboard shortcuts' }));
    expect(onShowCheatsheet).toHaveBeenCalled();
  });
});

describe('BuildModeHintStrip — Group hint (#2955)', () => {
  it('advertises ⌥⌘G the moment a multi-row selection exists', () => {
    // The strip is the primary discovery route for the chord while the toolbar buttons
    // ship off, and it appears at exactly the moment the chord starts meaning something.
    render(<BuildModeHintStrip mode="RowFocused" selectionCount={3} onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Group into a phase')).toBeInTheDocument();
  });

  it('does not advertise it with no selection to act on', () => {
    render(<BuildModeHintStrip mode="RowFocused" selectionCount={0} onShowCheatsheet={vi.fn()} />);
    expect(screen.queryByText('Group into a phase')).not.toBeInTheDocument();
  });
});
