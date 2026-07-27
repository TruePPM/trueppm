import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

const COLUMNS: BoardColumnDef[] = [
  { status: 'BACKLOG', label: 'Backlog', visible: true, color: '#94A3B8', wipLimit: null, ageThresholdDays: null },
  { status: 'NOT_STARTED', label: 'To Do', visible: true, color: '#64748B', wipLimit: null, ageThresholdDays: null },
  { status: 'IN_PROGRESS', label: 'In Progress', visible: true, color: '#3B82F6', wipLimit: 5, ageThresholdDays: null },
  { status: 'REVIEW', label: 'Review', visible: true, color: '#A855F7', wipLimit: 3, ageThresholdDays: null },
  { status: 'COMPLETE', label: 'Done', visible: true, color: '#22C55E', wipLimit: null, ageThresholdDays: null },
];

describe('BoardSettingsPanel', () => {
  it('renders as a dialog and focuses close button on mount', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Board columns' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close board settings' })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={onClose} />);
    // useFocusTrap listens on document; a real Escape inside the dialog bubbles there.
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Board columns' }), { key: 'Escape' });
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

  it('falls back to a generic message when the rejection is not an Error', async () => {
    const onSave = vi
      .fn<(columns: BoardColumnDef[]) => Promise<void>>()
      .mockRejectedValue('kaboom');
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
    const [firstLabel] = screen.getAllByLabelText('Label');
    fireEvent.change(firstLabel, { target: { value: 'Ideas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText('Save failed')).toBeInTheDocument();
    });
  });

  it('closes the panel after a successful save', async () => {
    const onSave = vi
      .fn<(columns: BoardColumnDef[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={onClose} />);
    const [firstLabel] = screen.getAllByLabelText('Label');
    fireEvent.change(firstLabel, { target: { value: 'Ideas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
    expect(saved[0].label).toBe('Ideas');
  });

  it('shows a busy Save button while the save is in flight', async () => {
    let release: () => void = () => {};
    const onSave = vi.fn<(columns: BoardColumnDef[]) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={onClose} />);
    const [firstLabel] = screen.getAllByLabelText('Label');
    fireEvent.change(firstLabel, { target: { value: 'Ideas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    release();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('closes on backdrop click and on Cancel', () => {
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByRole('dialog', { name: 'Board columns' }).firstElementChild;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes when the header ✕ is pressed', () => {
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close board settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('label validation', () => {
    it('flags an empty label, wires aria-describedby, and blocks save', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const [firstLabel] = screen.getAllByLabelText<HTMLInputElement>('Label');
      fireEvent.change(firstLabel, { target: { value: '   ' } });
      expect(screen.getByText('Label is required')).toBeInTheDocument();
      expect(firstLabel).toHaveAttribute('aria-invalid', 'true');
      expect(firstLabel.getAttribute('aria-describedby')).toBe('col-BACKLOG-label-err');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('flags a label longer than 32 characters', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const [firstLabel] = screen.getAllByLabelText<HTMLInputElement>('Label');
      fireEvent.change(firstLabel, { target: { value: 'x'.repeat(33) } });
      expect(screen.getByText('Max 32 characters')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('clears the error and re-disables Save when the original label is restored', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const [firstLabel] = screen.getAllByLabelText<HTMLInputElement>('Label');
      fireEvent.change(firstLabel, { target: { value: '' } });
      expect(screen.getByText('Label is required')).toBeInTheDocument();

      fireEvent.change(firstLabel, { target: { value: 'Backlog' } });
      expect(screen.queryByText('Label is required')).not.toBeInTheDocument();
      expect(firstLabel).toHaveAttribute('aria-invalid', 'false');
      expect(firstLabel.getAttribute('aria-describedby')).toBeNull();
      // Back to the original value — nothing to save.
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('color editing', () => {
    it('accepts a trimmed custom hex without flagging an error', async () => {
      const onSave = vi
        .fn<(columns: BoardColumnDef[]) => Promise<void>>()
        .mockResolvedValue(undefined);
      render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
      const [firstCustom] = screen.getAllByLabelText('Custom hex');
      fireEvent.change(firstCustom, { target: { value: '  #abcdef  ' } });
      expect(screen.queryByText('Use #RRGGBB hex')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
        expect(saved[0].color).toBe('#abcdef');
      });
    });

    it('emptying the custom hex clears the color and selects the ∅ swatch', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const [firstNoColor] = screen.getAllByRole('button', { name: 'No color' });
      expect(firstNoColor).toHaveAttribute('aria-pressed', 'false');

      const [firstCustom] = screen.getAllByLabelText('Custom hex');
      fireEvent.change(firstCustom, { target: { value: '' } });
      expect(firstNoColor).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    });

    it('matches a saved lowercase hex to its swatch case-insensitively', () => {
      const lower: BoardColumnDef[] = [
        {
          status: 'BACKLOG',
          label: 'Backlog',
          visible: true,
          color: '#22c55e',
          wipLimit: null,
          ageThresholdDays: null,
        },
      ];
      render(<BoardSettingsPanel columns={lower} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Green' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Slate' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('renders a column with no color as the ∅ selection', () => {
      const uncolored: BoardColumnDef[] = [
        {
          status: 'BACKLOG',
          label: 'Backlog',
          visible: true,
          color: null,
          wipLimit: null,
          ageThresholdDays: null,
        },
      ];
      render(<BoardSettingsPanel columns={uncolored} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'No color' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByLabelText<HTMLInputElement>('Custom hex').value).toBe('');
    });

    it('wires aria-describedby on the hex field when it is invalid', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const [firstCustom] = screen.getAllByLabelText<HTMLInputElement>('Custom hex');
      fireEvent.change(firstCustom, { target: { value: '#12' } });
      expect(firstCustom.getAttribute('aria-describedby')).toBe('col-BACKLOG-color-err');
      fireEvent.change(firstCustom, { target: { value: '#123456' } });
      expect(firstCustom.getAttribute('aria-describedby')).toBeNull();
    });
  });

  describe('WIP limit editing', () => {
    it('emptying the WIP field clears the limit', async () => {
      const onSave = vi
        .fn<(columns: BoardColumnDef[]) => Promise<void>>()
        .mockResolvedValue(undefined);
      render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
      const wipInputs = screen.getAllByLabelText<HTMLInputElement>(/WIP limit/);
      // IN_PROGRESS (index 2) is the first column with a saved limit.
      fireEvent.change(wipInputs[2], { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
        expect(saved.find((c) => c.status === 'IN_PROGRESS')?.wipLimit).toBeNull();
      });
    });

    it('accepts a positive integer limit', async () => {
      const onSave = vi
        .fn<(columns: BoardColumnDef[]) => Promise<void>>()
        .mockResolvedValue(undefined);
      render(<BoardSettingsPanel columns={COLUMNS} onSave={onSave} onClose={vi.fn()} />);
      const wipInputs = screen.getAllByLabelText<HTMLInputElement>(/WIP limit/);
      fireEvent.change(wipInputs[0], { target: { value: '7' } });
      expect(screen.queryByText('Must be a positive integer')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        const saved = (onSave.mock.calls[0] as [BoardColumnDef[]])[0];
        expect(saved[0].wipLimit).toBe(7);
      });
    });

    it('rejects a fractional limit', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const wipInputs = screen.getAllByLabelText<HTMLInputElement>(/WIP limit/);
      fireEvent.change(wipInputs[0], { target: { value: '2.5' } });
      expect(screen.getByText('Must be a positive integer')).toBeInTheDocument();
      expect(wipInputs[0].getAttribute('aria-describedby')).toBe('col-BACKLOG-wip-err');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('disables Clear for a column with no limit', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      const clears = screen.getAllByRole('button', { name: 'Clear' });
      // BACKLOG has no limit → Clear is inert.
      expect(clears[0]).toBeDisabled();
      expect(clears[2]).not.toBeDisabled();
    });
  });

  describe('custom-fields-on-cards master switch (#2144)', () => {
    it('is absent when the toolbar pref is not wired', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(
        screen.queryByRole('switch', { name: 'Show custom fields on cards' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Display')).not.toBeInTheDocument();
    });

    it('defaults to on when the value is undefined and toggles off', () => {
      const onToggle = vi.fn<(value: boolean) => void>();
      render(
        <BoardSettingsPanel
          columns={COLUMNS}
          onSave={vi.fn()}
          onClose={vi.fn()}
          onToggleCustomFieldsOnCards={onToggle}
        />,
      );
      const master = screen.getByRole('switch', { name: 'Show custom fields on cards' });
      expect(master).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(master);
      expect(onToggle).toHaveBeenCalledWith(false);
    });

    it('reflects an explicit off value and toggles back on', () => {
      const onToggle = vi.fn<(value: boolean) => void>();
      render(
        <BoardSettingsPanel
          columns={COLUMNS}
          onSave={vi.fn()}
          onClose={vi.fn()}
          showCustomFieldsOnCards={false}
          onToggleCustomFieldsOnCards={onToggle}
        />,
      );
      const master = screen.getByRole('switch', { name: 'Show custom fields on cards' });
      expect(master).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(master);
      expect(onToggle).toHaveBeenCalledWith(true);
    });
  });

  describe('read-only mode', () => {
    it('disables every column control', () => {
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} readOnly />);
      expect(screen.getAllByLabelText<HTMLInputElement>('Custom hex')[0]).toBeDisabled();
      expect(screen.getAllByLabelText<HTMLInputElement>(/WIP limit/)[0]).toBeDisabled();
      expect(screen.getAllByRole('button', { name: 'Green' })[0]).toBeDisabled();
      expect(screen.getAllByRole('button', { name: 'No color' })[0]).toBeDisabled();
      expect(screen.getAllByRole('switch', { name: 'Show on board' })[0]).toBeDisabled();
      // Even the column that has a limit cannot be cleared.
      expect(screen.getAllByRole('button', { name: 'Clear' })[2]).toBeDisabled();
    });

    it('still allows dismissing the panel', () => {
      const onClose = vi.fn();
      render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={onClose} readOnly />);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the editable subtitle when not read-only', () => {
    render(<BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Rename, color, and set WIP limits per column')).toBeInTheDocument();
    expect(screen.queryByText(/View-only/)).not.toBeInTheDocument();
  });

  it('renders no column rows and a disabled Save for an empty config', () => {
    render(<BoardSettingsPanel columns={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryAllByLabelText('Label')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('blocks the save and surfaces errors for columns that arrived already invalid', () => {
    // Columns can be persisted (or migrated) into a state the current rules reject.
    // Nothing has been edited on those rows, so no inline error exists yet — the
    // save-time sweep has to catch them and stop the write.
    const invalid: BoardColumnDef[] = [
      { ...COLUMNS[0], label: '' },
      { ...COLUMNS[1], color: 'not-hex' },
      { ...COLUMNS[2], wipLimit: 0 },
      COLUMNS[3],
    ];
    const onSave = vi.fn<(columns: BoardColumnDef[]) => Promise<void>>();
    const onClose = vi.fn();
    render(<BoardSettingsPanel columns={invalid} onSave={onSave} onClose={onClose} />);

    // Dirty a *valid* row so Save is enabled without flagging the broken ones.
    const labels = screen.getAllByLabelText<HTMLInputElement>('Label');
    fireEvent.change(labels[3], { target: { value: 'Reviewing' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Label is required')).toBeInTheDocument();
    expect(screen.getByText('Use #RRGGBB hex')).toBeInTheDocument();
    expect(screen.getByText('Must be a positive integer')).toBeInTheDocument();
  });

  it('treats a column appended after mount as unsaved work', () => {
    const { rerender } = render(
      <BoardSettingsPanel columns={COLUMNS} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    const extra: BoardColumnDef = {
      status: 'ON_HOLD',
      label: 'On hold',
      visible: true,
      color: null,
      wipLimit: null,
      ageThresholdDays: null,
    };
    rerender(
      <BoardSettingsPanel columns={[...COLUMNS, extra]} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});
