import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasteColumnMappingDialog } from './PasteColumnMappingDialog';
import type { PasteColumnMapping } from './inferColumns';

const COLUMNS: PasteColumnMapping[] = [
  { index: 0, header: 'Task', field: 'name', confidence: 'exact' },
  { index: 1, header: null, field: 'duration', confidence: 'fuzzy' },
  { index: 2, header: 'Who', field: null, confidence: 'none' },
];

const onCancel = vi.fn();
const onConfirm = vi.fn();

beforeEach(() => {
  onCancel.mockReset();
  onConfirm.mockReset();
});

function renderDialog(columns = COLUMNS) {
  return render(
    <PasteColumnMappingDialog columns={columns} onCancel={onCancel} onConfirm={onConfirm} />,
  );
}

describe('PasteColumnMappingDialog', () => {
  it('renders one select per column, labeled by header or ordinal, preselected to the guess', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Map columns' })).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(3);
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Column 2')).toBeInTheDocument();
    expect(screen.getByText('Who')).toBeInTheDocument();
    expect(selects.map((s) => (s as HTMLSelectElement).value)).toEqual(['name', 'duration', '']);
  });

  it('confirms the corrected mapping, marking changed columns as overrides', async () => {
    const user = userEvent.setup();
    renderDialog();
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[2], 'owner');
    await user.selectOptions(selects[1], '');
    await user.click(screen.getByRole('button', { name: 'Apply mapping' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual([
      { index: 0, header: 'Task', field: 'name', confidence: 'exact' },
      { index: 1, header: null, field: null, confidence: 'override' },
      { index: 2, header: 'Who', field: 'owner', confidence: 'override' },
    ]);
  });

  it('cancels from the button, from Escape, and from a pointer-down on the scrim only', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);

    // Inside the card: swallowed. On the scrim itself: cancels.
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Map columns' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
