import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import type { BulkFieldValue } from '@/hooks/useBulkProjectFields';
import { BulkFieldsMatrix, type FieldDescriptor } from './BulkFieldsMatrix';

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
    const all = screen.getByLabelText('Select all rows') as HTMLInputElement;
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
    const picker = screen.getByLabelText('Field to set') as HTMLSelectElement;
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
