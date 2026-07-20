import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import type { BulkFieldValue } from '@/hooks/useBulkProjectFields';
import { toast } from '@/components/Toast/toast';
import { BulkFieldsMatrix, type FieldDescriptor } from './BulkFieldsMatrix';

vi.mock('@/components/Toast/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

type ApplyFn = (ids: string[], field: string, value: BulkFieldValue) => Promise<unknown>;

interface Row {
  id: string;
  name: string;
  methodology: string;
  inheritedMethodology: string;
  iterationLabel: string | null;
  effectiveIterationLabel: string | null;
}

const ROWS: Row[] = [
  { id: 'r1', name: 'Apollo', methodology: 'AGILE', inheritedMethodology: 'HYBRID', iterationLabel: 'Sprint', effectiveIterationLabel: 'Sprint' },
  { id: 'r2', name: 'Orbital', methodology: 'WATERFALL', inheritedMethodology: 'HYBRID', iterationLabel: null, effectiveIterationLabel: 'Iteration' },
];

function makeFields(opts: { methodologyLocked?: boolean } = {}): FieldDescriptor<Row>[] {
  return [
    {
      key: 'methodology',
      label: 'Methodology',
      kind: 'enum',
      options: [
        { value: 'AGILE', label: 'Agile' },
        { value: 'WATERFALL', label: 'Waterfall' },
        { value: 'HYBRID', label: 'Hybrid' },
      ],
      read: (r) => ({ effective: r.methodology, overridden: r.methodology !== r.inheritedMethodology }),
      resettable: false,
      locked: opts.methodologyLocked,
    },
    {
      key: 'iteration_label',
      label: 'Iteration label',
      kind: 'string',
      maxLength: 32,
      read: (r) => ({ effective: r.effectiveIterationLabel, overridden: r.iterationLabel != null }),
      resettable: true,
    },
  ];
}

let apply: Mock<ApplyFn>;
beforeEach(() => {
  vi.clearAllMocks();
  apply = vi.fn<ApplyFn>().mockResolvedValue({ updated: [], fields: [] });
});

function renderMatrix(props: Partial<Parameters<typeof BulkFieldsMatrix<Row>>[0]> = {}) {
  return render(
    <BulkFieldsMatrix<Row>
      rows={ROWS}
      rowKey={(r) => r.id}
      rowLabel={(r) => r.name}
      rowNoun="Project"
      fields={makeFields()}
      canEdit
      apply={apply}
      isApplying={false}
      entityNoun="projects"
      {...props}
    />,
  );
}

describe('BulkFieldsMatrix', () => {
  it('is read-only for non-admins — no action bar, no checkboxes', () => {
    renderMatrix({ canEdit: false });
    expect(screen.queryByTestId('bulk-fields-action-bar')).toBeNull();
    expect(screen.queryByLabelText('Select Apollo')).toBeNull();
    // Values still display.
    expect(screen.getByText('Apollo')).toBeInTheDocument();
  });

  it('renders the action bar + per-row checkboxes for admins', () => {
    renderMatrix();
    expect(screen.getByTestId('bulk-fields-action-bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Apollo')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all rows')).toBeInTheDocument();
  });

  it('select-all goes indeterminate on partial selection, checked on full', () => {
    renderMatrix();
    const all = screen.getByLabelText<HTMLInputElement>('Select all rows');
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Select Orbital'));
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);
  });

  it('Apply is disabled until rows are selected AND a value is staged', () => {
    renderMatrix();
    const applyBtn = screen.getByTestId('bulk-fields-apply');
    expect(applyBtn).toBeDisabled();
    // Select a row — still no value staged.
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    expect(applyBtn).toBeDisabled();
    // Stage a methodology value (default field is methodology).
    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));
    expect(applyBtn).toBeEnabled();
  });

  it('applies a methodology value to only the selected rows', async () => {
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Select Orbital'));
    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['r2'], 'methodology', 'AGILE'));
  });

  it('does NOT offer Reset for methodology (web-rule 196 — not a null-sentinel field)', () => {
    renderMatrix();
    // Default field is methodology.
    expect(screen.queryByTestId('bulk-fields-reset')).toBeNull();
  });

  it('applies an iteration_label value, and Reset clears the override to null', async () => {
    renderMatrix();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    fireEvent.change(within(bar).getByLabelText('Iteration label'), { target: { value: 'Cadence' } });
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['r1'], 'iteration_label', 'Cadence'));

    // Reset is offered for the resettable field; confirm → applies null.
    fireEvent.click(screen.getByTestId('bulk-fields-reset'));
    fireEvent.click(within(screen.getByTestId('bulk-fields-reset-confirm')).getByText('Clear override'));
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(['r1'], 'iteration_label', null));
  });

  it('drops a locked field from the picker but keeps it as a display column (web-rule 196)', () => {
    renderMatrix({ fields: makeFields({ methodologyLocked: true }) });
    // Methodology is no longer an option in the field picker…
    const picker = screen.getByLabelText<HTMLSelectElement>('Field to set');
    const optionValues = [...picker.options].map((o) => o.value);
    expect(optionValues).toEqual(['iteration_label']);
    // …but the Methodology column header still renders (display-only).
    expect(screen.getByText('Methodology')).toBeInTheDocument();
  });

  it('shows "— inherited" for a row whose resettable field is not overridden', () => {
    renderMatrix();
    // Orbital has iterationLabel=null → inherited.
    expect(screen.getByLabelText(/Iteration label: inherited/)).toBeInTheDocument();
  });

  it('caps selection at maxRows and notes it', () => {
    renderMatrix({ maxRows: 1 });
    expect(screen.getByTestId('bulk-fields-cap')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Select all rows'));
    // Only one row selectable under the cap.
    expect(screen.getByTestId('bulk-fields-apply')).toHaveTextContent('1');
  });
});

describe('BulkFieldsMatrix — selection toggles', () => {
  it('toggling a selected row a second time deselects it', () => {
    renderMatrix();
    const apollo = screen.getByLabelText<HTMLInputElement>('Select Apollo');
    fireEvent.click(apollo);
    expect(apollo.checked).toBe(true);
    fireEvent.click(apollo);
    expect(apollo.checked).toBe(false);
    // With nothing selected, Apply is disabled again.
    expect(screen.getByTestId('bulk-fields-apply')).toBeDisabled();
  });

  it('does not add a row beyond the cap once the selection is full', () => {
    renderMatrix({ maxRows: 1 });
    const apollo = screen.getByLabelText<HTMLInputElement>('Select Apollo');
    const orbital = screen.getByLabelText<HTMLInputElement>('Select Orbital');
    fireEvent.click(apollo);
    expect(apollo.checked).toBe(true);
    // Cap is 1 — clicking a second row is a no-op.
    fireEvent.click(orbital);
    expect(orbital.checked).toBe(false);
    expect(apollo.checked).toBe(true);
  });

  it('select-all toggles off when a selection already exists', () => {
    renderMatrix();
    const all = screen.getByLabelText<HTMLInputElement>('Select all rows');
    const apollo = screen.getByLabelText<HTMLInputElement>('Select Apollo');
    const orbital = screen.getByLabelText<HTMLInputElement>('Select Orbital');
    fireEvent.click(all); // select all
    expect(apollo.checked).toBe(true);
    expect(orbital.checked).toBe(true);
    fireEvent.click(all); // now clears (prev.size > 0)
    expect(apollo.checked).toBe(false);
    expect(orbital.checked).toBe(false);
  });
});

describe('BulkFieldsMatrix — apply outcomes', () => {
  it('surfaces an error toast and keeps the selection when apply rejects', async () => {
    apply.mockRejectedValueOnce(new Error('server 500'));
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't apply — no changes were made."));
    expect(toast.success).not.toHaveBeenCalled();
    // Selection is retained after a failure so the admin can retry.
    expect(screen.getByLabelText<HTMLInputElement>('Select Apollo').checked).toBe(true);
  });

  it('announces success and shows a success toast when apply resolves', async () => {
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    fireEvent.click(screen.getByLabelText('Select Orbital'));
    fireEvent.click(screen.getByRole('radio', { name: 'Waterfall' }));
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Updated 2 projects.'));
    expect(apply).toHaveBeenCalledWith(['r1', 'r2'], 'methodology', 'WATERFALL');
  });
});

describe('BulkFieldsMatrix — reset confirm dismissal', () => {
  it('Cancel dismisses the reset confirmation without applying anything', () => {
    renderMatrix();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    fireEvent.click(screen.getByTestId('bulk-fields-reset'));
    const confirm = screen.getByTestId('bulk-fields-reset-confirm');
    fireEvent.click(within(confirm).getByText('Cancel'));
    // Confirmation gone, field picker back, no apply fired.
    expect(screen.queryByTestId('bulk-fields-reset-confirm')).toBeNull();
    expect(screen.getByLabelText('Field to set')).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('BulkFieldsMatrix — string field clear-to-inherit', () => {
  it('stages null via "Clear → inherit" and applies null to clear the override', async () => {
    renderMatrix();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    // Clicking the inline clear button stages an explicit null (distinct from Reset).
    fireEvent.click(screen.getByTestId('bulk-fields-clear-inherit'));
    // The staged-null state shows the "will inherit" placeholder on the text input.
    const input = within(bar).getByLabelText<HTMLInputElement>('Iteration label');
    expect(input.placeholder).toBe('will inherit');
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['r1'], 'iteration_label', null));
  });
});

describe('BulkFieldsMatrix — integer field control', () => {
  const intFields: FieldDescriptor<Row>[] = [
    {
      key: 'sprint_days',
      label: 'Sprint length',
      kind: 'int',
      min: 1,
      max: 30,
      read: () => ({ effective: 14, overridden: true }),
      resettable: true,
    },
  ];

  it('renders the effective integer value with a day suffix in the cell', () => {
    renderMatrix({ fields: intFields });
    // formatValue int branch: `${value}d`; one cell per row (2 rows).
    const cells = screen.getAllByLabelText('Sprint length: 14d, set on this row');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent('14d');
  });

  it('clamps an over-max entry down to the field max before applying', async () => {
    renderMatrix({ fields: intFields });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    const input = within(bar).getByLabelText<HTMLInputElement>('Sprint length');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['r1'], 'sprint_days', 30));
  });

  it('clears the staged value (disables Apply) when the number input is emptied', () => {
    renderMatrix({ fields: intFields });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    const input = within(bar).getByLabelText<HTMLInputElement>('Sprint length');
    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.getByTestId('bulk-fields-apply')).toBeEnabled();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('bulk-fields-apply')).toBeDisabled();
  });
});

describe('BulkFieldsMatrix — enum radiogroup keyboard navigation', () => {
  it('ArrowRight/ArrowLeft move roving focus without committing a value', () => {
    renderMatrix();
    const agile = screen.getByRole('radio', { name: 'Agile' });
    const waterfall = screen.getByRole('radio', { name: 'Waterfall' });
    const hybrid = screen.getByRole('radio', { name: 'Hybrid' });
    agile.focus();
    fireEvent.keyDown(agile, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(waterfall);
    // Moving focus must NOT stage a value (Apply stays disabled with no selection).
    fireEvent.keyDown(waterfall, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(agile);
    // Wrap-around: ArrowLeft from the first option lands on the last.
    fireEvent.keyDown(agile, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(hybrid);
  });

  it('Home and End jump focus to the first and last options', () => {
    renderMatrix();
    const agile = screen.getByRole('radio', { name: 'Agile' });
    const hybrid = screen.getByRole('radio', { name: 'Hybrid' });
    agile.focus();
    fireEvent.keyDown(agile, { key: 'End' });
    expect(document.activeElement).toBe(hybrid);
    fireEvent.keyDown(hybrid, { key: 'Home' });
    expect(document.activeElement).toBe(agile);
  });

  it('ignores unrelated keys (no focus change)', () => {
    renderMatrix();
    const agile = screen.getByRole('radio', { name: 'Agile' });
    agile.focus();
    fireEvent.keyDown(agile, { key: 'a' });
    expect(document.activeElement).toBe(agile);
  });
});
