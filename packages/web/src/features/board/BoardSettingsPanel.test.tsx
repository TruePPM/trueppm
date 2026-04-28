import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

const COLUMNS: BoardColumnDef[] = [
  { status: 'BACKLOG', label: 'Backlog', visible: true, color: '#94A3B8', wipLimit: null },
  { status: 'NOT_STARTED', label: 'To Do', visible: true, color: '#64748B', wipLimit: null },
  { status: 'IN_PROGRESS', label: 'In Progress', visible: true, color: '#3B82F6', wipLimit: 5 },
  { status: 'REVIEW', label: 'Review', visible: true, color: '#A855F7', wipLimit: 3 },
  { status: 'COMPLETE', label: 'Done', visible: true, color: '#22C55E', wipLimit: null },
];

describe('BoardSettingsPanel', () => {
  it('renders as a dialog and focuses close button on mount', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Column settings' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close board settings' })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Save when the form is pristine', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('enables Save once a label is edited', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    const [firstLabel] = screen.getAllByLabelText('Label');
    fireEvent.change(firstLabel, { target: { value: 'Ideas' } });
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('shows inline error for non-hex custom color and blocks save', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    const [firstCustom] = screen.getAllByLabelText('Custom hex');
    fireEvent.change(firstCustom, { target: { value: 'not-a-color' } });
    expect(screen.getByText('Use #RRGGBB hex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows inline error for invalid WIP limit (zero)', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    const [firstWip] = screen.getAllByLabelText(/WIP limit/);
    fireEvent.change(firstWip, { target: { value: '0' } });
    expect(screen.getByText('Must be a positive integer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('updates color via swatch click', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
    const [firstGreen] = screen.getAllByRole('button', { name: 'Green' });
    fireEvent.click(firstGreen);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
      expect(saved[0].color).toBe('#22C55E');
    });
  });

  it('clears color when ∅ swatch is clicked', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
    const [firstNoColor] = screen.getAllByRole('button', { name: 'No color' });
    fireEvent.click(firstNoColor);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return waitFor(() => {
      const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
      expect(saved[0].color).toBeNull();
    });
  });

  it('clears WIP limit via Clear button', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
    const clears = screen.getAllByRole('button', { name: 'Clear' });
    // IN_PROGRESS is index 2 — first column with a wip limit; first non-disabled Clear.
    const enabled = clears.find((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toBeDefined();
    fireEvent.click(enabled!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return waitFor(() => {
      const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
      expect(saved.find((c) => c.status === 'IN_PROGRESS')?.wipLimit).toBeNull();
    });
  });

  it('toggles visibility via the switch', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
    const [firstSwitch] = screen.getAllByRole('switch', { name: 'Show on board' });
    fireEvent.click(firstSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return waitFor(() => {
      const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
      expect(saved[0].visible).toBe(false);
    });
  });

  it('renders read-only state without Save button', () => {
    render(
      <BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} readOnly />,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/View-only/)).toBeInTheDocument();
    const [firstLabel] = screen.getAllByLabelText('Label');
    expect((firstLabel as HTMLInputElement).disabled).toBe(true);
  });

  it('shows submit error when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Network down'));
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={onClose} />);
    const [firstLabel] = screen.getAllByLabelText('Label');
    fireEvent.change(firstLabel, { target: { value: 'Ideas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText('Network down')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
