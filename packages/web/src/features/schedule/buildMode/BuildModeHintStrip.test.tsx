import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
