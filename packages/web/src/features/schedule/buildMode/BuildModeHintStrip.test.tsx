import { describe, expect, it, vi } from 'vitest';
import { formatChord } from '@/lib/platform';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BuildModeHintStrip } from './BuildModeHintStrip';

describe('BuildModeHintStrip', () => {
  it('renders the build-mode label', () => {
    render(<BuildModeHintStrip mode="NoSelection" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Build mode')).toBeInTheDocument();
  });

  it('shows NoSelection hints when mode is NoSelection', () => {
    render(<BuildModeHintStrip mode="NoSelection" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Select row')).toBeInTheDocument();
    expect(screen.getByText('Edit cell')).toBeInTheDocument();
  });

  it('shows RowFocused hints when mode is RowFocused', () => {
    render(<BuildModeHintStrip mode="RowFocused" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Indent')).toBeInTheDocument();
    expect(screen.getByText('New row below')).toBeInTheDocument();
  });

  it('shows CellEdit hints when mode is CellEdit', () => {
    render(<BuildModeHintStrip mode="CellEdit" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Next field')).toBeInTheDocument();
  });

  it('switches hints when mode changes', () => {
    const { rerender } = render(
      <BuildModeHintStrip mode="NoSelection" hasEditRights onShowCheatsheet={vi.fn()} />,
    );
    expect(screen.getByText('Select row')).toBeInTheDocument();
    rerender(<BuildModeHintStrip mode="RowFocused" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.queryByText('Select row')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('calls onShowCheatsheet when the All shortcuts button is clicked', () => {
    const onShow = vi.fn();
    render(<BuildModeHintStrip mode="NoSelection" hasEditRights onShowCheatsheet={onShow} />);
    fireEvent.click(screen.getByLabelText('Show all keyboard shortcuts'));
    expect(onShow).toHaveBeenCalledOnce();
  });

  it('exposes mode via data attribute for e2e selectors', () => {
    render(<BuildModeHintStrip mode="CellEdit" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByTestId('build-mode-hint-strip')).toHaveAttribute('data-mode', 'CellEdit');
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
        hasEditRights
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
    // Rights, not a withheld handler. The old version of this spec proved the
    // absence by declining to pass `onBulkEdit`, which says nothing about what a
    // reader sees — a caller that passed it anyway would have shipped the
    // control to a Viewer and this spec would still have been green (#3231).
    const onBulkEdit = vi.fn();
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights={false}
        selectionCount={18}
        onBulkEdit={onBulkEdit}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
  });

  it('keeps the mode hints for a selection of one — the chord means nothing yet', () => {
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
        selectionCount={1}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('defaults to the mode hints when no selection count is supplied', () => {
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
    expect(screen.getByText('Indent')).toBeInTheDocument();
  });

  it('shows the selection affordances in every focus mode, not only RowFocused', () => {
    const { rerender } = render(
      <BuildModeHintStrip
        mode="NoSelection"
        hasEditRights
        selectionCount={4}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByTestId('build-mode-bulk-edit')).toBeInTheDocument();
    rerender(
      <BuildModeHintStrip
        mode="CellEdit"
        hasEditRights
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
        hasEditRights
        selectionCount={5}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByTestId('build-mode-bulk-edit')).toBeInTheDocument();
    rerender(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
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
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
        selectionCount={3}
        onShowCheatsheet={onShowCheatsheet}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all keyboard shortcuts' }));
    expect(onShowCheatsheet).toHaveBeenCalled();
  });
});

describe('BuildModeHintStrip — Group hint (#2955)', () => {
  it('advertises ⌥⌘G the moment a multi-row selection exists', () => {
    // The strip is the primary discovery route for the chord while the toolbar buttons
    // ship off, and it appears at exactly the moment the chord starts meaning something.
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
        selectionCount={3}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.getByText('Group into a phase')).toBeInTheDocument();
  });

  it('does not advertise it with no selection to act on', () => {
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights
        selectionCount={0}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByText('Group into a phase')).not.toBeInTheDocument();
  });
});

describe('BuildModeHintStrip — what a reader is taught (#3231, web rule 302)', () => {
  const reader = (
    props: Partial<{
      mode: 'NoSelection' | 'RowFocused' | 'CellEdit';
      selectionCount: number;
    }> = {},
  ) =>
    render(
      <BuildModeHintStrip
        mode={props.mode ?? 'RowFocused'}
        hasEditRights={false}
        selectionCount={props.selectionCount ?? 0}
        onShowCheatsheet={vi.fn()}
      />,
    );

  /**
   * The three mutations the strip used to teach a Viewer. Named once, asserted
   * against every focus state and selection size below — the defect was that
   * `RowFocused` is reachable without rights, and a spec that only checked
   * `RowFocused` would miss the same leak arriving through `CellEdit` or the
   * selection set later.
   */
  const MUTATIONS = [
    'New row below',
    'Indent',
    'Edit',
    'Edit cell',
    'Group into a phase',
    'Delete all selected',
  ];

  it.each([
    ['NoSelection' as const, 0],
    ['RowFocused' as const, 0],
    ['RowFocused' as const, 1],
    ['RowFocused' as const, 18],
    ['CellEdit' as const, 0],
    ['CellEdit' as const, 18],
  ])('names no mutation in %s with a selection of %i', (mode, selectionCount) => {
    reader({ mode, selectionCount });
    for (const label of MUTATIONS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('teaches the two acts a reader can actually perform', () => {
    reader();
    // Both are read off the row reducer's `!canEdit` branch: ↑↓ moves row focus
    // (no rights gate), ⏎ sets `selectedTaskId`, which is the store the task
    // drawer renders from.
    expect(screen.getByText('Select row')).toBeInTheDocument();
    expect(screen.getByText('Open details')).toBeInTheDocument();
  });

  it('keeps the ? All shortcuts route — the strip job that survives without rights', () => {
    const onShowCheatsheet = vi.fn();
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights={false}
        onShowCheatsheet={onShowCheatsheet}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all keyboard shortcuts' }));
    expect(onShowCheatsheet).toHaveBeenCalled();
  });

  it('does not render the bulk-edit control even when a caller passes the handler', () => {
    render(
      <BuildModeHintStrip
        mode="RowFocused"
        hasEditRights={false}
        selectionCount={9}
        onBulkEdit={vi.fn()}
        onShowCheatsheet={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('build-mode-bulk-edit')).toBeNull();
  });

  it('exposes which hint set is up, so the leak is visible to an e2e selector', () => {
    reader();
    expect(screen.getByTestId('build-mode-hint-strip')).toHaveAttribute('data-hints', 'reader');
  });

  it('still teaches an author the mutations — the fix is rights-scoped, not a removal', () => {
    render(<BuildModeHintStrip mode="RowFocused" hasEditRights onShowCheatsheet={vi.fn()} />);
    expect(screen.getByText('New row below')).toBeInTheDocument();
    expect(screen.getByText('Indent')).toBeInTheDocument();
    expect(screen.queryByText('Open details')).toBeNull();
  });
});
