import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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

  it('ArrowDown/ArrowUp move roving focus like ArrowRight/ArrowLeft', () => {
    renderMatrix();
    const agile = screen.getByRole('radio', { name: 'Agile' });
    const waterfall = screen.getByRole('radio', { name: 'Waterfall' });
    const hybrid = screen.getByRole('radio', { name: 'Hybrid' });
    agile.focus();
    fireEvent.keyDown(agile, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(waterfall);
    fireEvent.keyDown(waterfall, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(agile);
    // Wrap-around downward from the last option lands back on the first.
    hybrid.focus();
    fireEvent.keyDown(hybrid, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(agile);
  });

  it('moves the roving tabstop onto the chosen option once a value is staged', () => {
    renderMatrix();
    const agile = screen.getByRole('radio', { name: 'Agile' });
    const waterfall = screen.getByRole('radio', { name: 'Waterfall' });
    // No value staged → the first option holds the tabstop.
    expect(agile).toHaveAttribute('tabindex', '0');
    expect(waterfall).toHaveAttribute('tabindex', '-1');
    fireEvent.click(waterfall);
    expect(waterfall).toHaveAttribute('tabindex', '0');
    expect(agile).toHaveAttribute('tabindex', '-1');
    expect(waterfall).toHaveAttribute('aria-checked', 'true');
    expect(agile).toHaveAttribute('aria-checked', 'false');
  });
});

describe('BulkFieldsMatrix — nothing to render', () => {
  it('renders nothing at all when there are no rows (page owns the empty state)', () => {
    const { container } = renderMatrix({ rows: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the action bar when every field is locked, keeping the display columns', () => {
    const lockedOnly: FieldDescriptor<Row>[] = [
      {
        key: 'methodology',
        label: 'Methodology',
        kind: 'enum',
        options: [{ value: 'AGILE', label: 'Agile' }],
        read: (r) => ({ effective: r.methodology, overridden: true }),
        resettable: false,
        locked: true,
      },
    ];
    renderMatrix({ fields: lockedOnly });
    expect(screen.queryByTestId('bulk-fields-action-bar')).toBeNull();
    // The locked column is still a read-only display column, and rows still list.
    expect(screen.getByText('Methodology')).toBeInTheDocument();
    expect(screen.getByText('Apollo')).toBeInTheDocument();
  });
});

describe('BulkFieldsMatrix — in-flight (isApplying)', () => {
  it('shows the Applying… label and blocks both Apply and Reset', () => {
    renderMatrix({ isApplying: true, fields: makeFields() });
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const applyBtn = screen.getByTestId('bulk-fields-apply');
    expect(applyBtn).toHaveTextContent('Applying…');
    expect(applyBtn).toBeDisabled();
    expect(screen.getByTestId('bulk-fields-reset')).toBeDisabled();
  });

  it('shows Clearing… on the reset confirm while the call is in flight', () => {
    const { rerender } = render(
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
      />,
    );
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    fireEvent.click(screen.getByTestId('bulk-fields-reset'));
    const confirm = screen.getByTestId('bulk-fields-reset-confirm');
    expect(within(confirm).getByText('Clear override')).toBeEnabled();

    rerender(
      <BulkFieldsMatrix<Row>
        rows={ROWS}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        rowNoun="Project"
        fields={makeFields()}
        canEdit
        apply={apply}
        isApplying
        entityNoun="projects"
      />,
    );
    const busyConfirm = screen.getByTestId('bulk-fields-reset-confirm');
    expect(within(busyConfirm).getByText('Clearing…')).toBeInTheDocument();
    expect(within(busyConfirm).getByText('Cancel')).toBeDisabled();
  });
});

describe('BulkFieldsMatrix — apply guards', () => {
  it('does nothing when the selection is emptied while the reset confirm is open', () => {
    renderMatrix();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    const apollo = screen.getByLabelText<HTMLInputElement>('Select Apollo');
    fireEvent.click(apollo);
    fireEvent.click(screen.getByTestId('bulk-fields-reset'));
    // Row checkboxes stay live behind the confirm — deselecting empties the cohort.
    fireEvent.click(apollo);
    expect(apollo.checked).toBe(false);
    fireEvent.click(within(screen.getByTestId('bulk-fields-reset-confirm')).getByText('Clear override'));
    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a staged value when the chosen field changes', () => {
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));
    expect(screen.getByTestId('bulk-fields-apply')).toBeEnabled();
    // Switching fields must not carry an enum value into a string field.
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    expect(screen.getByTestId('bulk-fields-apply')).toBeDisabled();
    const bar = screen.getByTestId('bulk-fields-action-bar');
    expect(within(bar).getByLabelText<HTMLInputElement>('Iteration label').value).toBe('');
  });

  it('swaps the value control to match the newly chosen field', () => {
    renderMatrix();
    const bar = screen.getByTestId('bulk-fields-action-bar');
    // Methodology (enum) is the default → a radiogroup, no text box.
    expect(within(bar).getByRole('radiogroup', { name: 'Methodology' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    expect(within(bar).queryByRole('radiogroup')).toBeNull();
    expect(within(bar).getByLabelText('Iteration label')).toBeInTheDocument();
  });
});

describe('BulkFieldsMatrix — value formatting', () => {
  const rowsWithNulls: Row[] = [
    { id: 'r1', name: 'Apollo', methodology: 'FUTURE_MODE', inheritedMethodology: 'HYBRID', iterationLabel: null, effectiveIterationLabel: null },
  ];

  it('reads an inherited field with no value as a bare "— inherited" (no parenthetical)', () => {
    renderMatrix({ rows: rowsWithNulls });
    const cell = screen.getByLabelText('Iteration label: inherited, —');
    expect(cell).toHaveTextContent('— inherited');
    expect(cell.textContent).not.toContain('(');
  });

  it('falls back to the raw enum value when it is not in the option list', () => {
    renderMatrix({ rows: rowsWithNulls });
    expect(screen.getByLabelText('Methodology: FUTURE_MODE')).toHaveTextContent('FUTURE_MODE');
  });

  it('renders an em-dash for an overridden numeric field with no value', () => {
    const intField: FieldDescriptor<Row>[] = [
      {
        key: 'sprint_days',
        label: 'Sprint length',
        kind: 'int',
        min: 1,
        max: 30,
        read: () => ({ effective: null, overridden: true }),
        resettable: true,
      },
    ];
    renderMatrix({ rows: rowsWithNulls, fields: intField });
    expect(screen.getByLabelText('Sprint length: —, set on this row')).toHaveTextContent('—');
  });

  it('renders an em-dash for an empty-string value on a string field', () => {
    const stringField: FieldDescriptor<Row>[] = [
      {
        key: 'iteration_label',
        label: 'Iteration label',
        kind: 'string',
        maxLength: 32,
        read: () => ({ effective: '', overridden: true }),
        resettable: true,
      },
    ];
    renderMatrix({ rows: rowsWithNulls, fields: stringField });
    expect(screen.getByLabelText('Iteration label: —, set on this row')).toHaveTextContent('—');
  });
});

describe('BulkFieldsMatrix — control edge cases', () => {
  const intFields: FieldDescriptor<Row>[] = [
    {
      key: 'sprint_days',
      label: 'Sprint length',
      kind: 'int',
      min: 5,
      max: 30,
      read: () => ({ effective: 14, overridden: true }),
      resettable: true,
    },
  ];

  it('clamps an under-min entry up to the field min before applying', async () => {
    renderMatrix({ fields: intFields });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    fireEvent.change(within(bar).getByLabelText<HTMLInputElement>('Sprint length'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByTestId('bulk-fields-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['r1'], 'sprint_days', 5));
  });

  it('emptying the text field unstages it (Apply disabled, no "will inherit" hint)', () => {
    renderMatrix();
    fireEvent.change(screen.getByLabelText('Field to set'), { target: { value: 'iteration_label' } });
    fireEvent.click(screen.getByLabelText('Select Apollo'));
    const bar = screen.getByTestId('bulk-fields-action-bar');
    const input = within(bar).getByLabelText<HTMLInputElement>('Iteration label');
    fireEvent.change(input, { target: { value: 'Cadence' } });
    expect(screen.getByTestId('bulk-fields-apply')).toBeEnabled();
    expect(input.placeholder).toBe('');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('bulk-fields-apply')).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('select-all is inert when the cap allows no rows', () => {
    renderMatrix({ maxRows: 0 });
    const all = screen.getByLabelText<HTMLInputElement>('Select all rows');
    expect(all.checked).toBe(false);
    fireEvent.click(all);
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(false);
    expect(screen.getByTestId('bulk-fields-apply')).toBeDisabled();
  });
});

/**
 * Deviation-from-inherited rendering (#3295) — the flag `ProgramProjectsPage` has
 * always computed and `ValueCell` has always discarded.
 */
describe('BulkFieldsMatrix — deviation markers (#3295)', () => {
  /** `scope` mirrors what `resolve_inherited_methodology` re-parents to. */
  function deviationFields(
    opts: { scope?: string; comparable?: boolean; locked?: boolean } = {},
  ): FieldDescriptor<Row>[] {
    const { scope = 'program', comparable = true, locked } = opts;
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
        read: (r) => ({
          effective: r.methodology,
          overridden: false,
          deviation: comparable
            ? {
                differs: r.methodology !== r.inheritedMethodology,
                scope,
                inherited: r.inheritedMethodology,
                own: r.methodology,
              }
            : undefined,
        }),
        resettable: false,
        locked,
        minWidth: '220px',
      },
    ];
  }

  it('renders the marker as text plus ≠ — no dot, no fill, no row tint (D11)', () => {
    renderMatrix({ fields: deviationFields() });
    const marker = screen.getAllByTestId('deviation-marker-methodology')[0];
    // Both rows deviate from HYBRID in the shared fixture.
    expect(marker).toHaveTextContent('Agile ≠ program (Hybrid)');
    // Non-color-only: the whole statement is words + a glyph, and the accessible
    // name spells the comparison out rather than leaning on the glyph.
    expect(marker).toHaveAttribute(
      'aria-label',
      'Methodology: Agile, differs from program default Hybrid',
    );
    expect(marker.className).not.toMatch(/bg-|rounded-full/);
  });

  it('names the scope actually compared against — workspace under a lock (D32/D37)', () => {
    renderMatrix({ fields: deviationFields({ scope: 'workspace', locked: true }) });
    expect(screen.getAllByTestId('deviation-marker-methodology')[0]).toHaveTextContent(
      'Agile ≠ workspace (Hybrid)',
    );
  });

  it('carries the tally in the column header as label text, constraint first (D10)', () => {
    const { rerender } = renderMatrix({ fields: deviationFields() });
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    // The header is a label, never a control.
    expect(within(screen.getByTestId('bulk-fields-header')).queryByRole('button')).toBeNull();

    rerender(
      <BulkFieldsMatrix<Row>
        rows={ROWS}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        rowNoun="Project"
        fields={deviationFields({ scope: 'workspace', locked: true })}
        canEdit
        apply={apply}
        isApplying={false}
        entityNoun="projects"
      />,
    );
    const header = screen.getByTestId('bulk-fields-header');
    expect(header).toHaveTextContent('Methodology · read-only · 2 differ');
    // A house SVG, never a Unicode emoji (rule 242) — and decorative, so "read-only"
    // is what carries the constraint into the accessible name.
    const glyph = header.querySelector('svg[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(header.textContent).not.toContain('🔒');
  });

  it('reads "none differ", not "0 differ", when every row matches (§C)', () => {
    const matching: Row[] = ROWS.map((r) => ({ ...r, methodology: r.inheritedMethodology }));
    renderMatrix({ rows: matching, fields: deviationFields() });
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('none differ');
    expect(screen.getByTestId('deviation-count')).not.toHaveTextContent('0 differ');
    expect(screen.queryByTestId('deviation-marker-methodology')).toBeNull();
  });

  it('omits markers AND the header count when no row can be compared (D12)', () => {
    renderMatrix({ fields: deviationFields({ comparable: false }) });
    // Absent, not zeroed — a visible zero claims a check that never happened.
    expect(screen.queryByTestId('deviation-count')).toBeNull();
    expect(screen.queryByTestId('deviation-marker-methodology')).toBeNull();
    // Degrades to exactly the pre-#3295 render: the plain effective value.
    expect(screen.getByLabelText('Methodology: Agile')).toBeInTheDocument();
  });

  it('tallies over the unnarrowed set when the mount passes one (one denominator)', () => {
    // Header "N differ" and a facet chip "N deviating" name the same fact; computing
    // one over the filtered rows and the other over all rows makes them disagree.
    renderMatrix({ rows: [ROWS[0]], tallyRows: ROWS, fields: deviationFields() });
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    expect(screen.getAllByTestId('deviation-marker-methodology')).toHaveLength(1);
  });

  it('suppresses the visible marker text from the accessible name (rule 171)', () => {
    renderMatrix({ fields: deviationFields() });
    const marker = screen.getAllByTestId('deviation-marker-methodology')[0];
    // An aria-label on a non-widget container does not suppress descendants, so the
    // visible run has to be hidden or a reader hears the sentence twice.
    expect(marker.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      'Agile ≠ program (Hybrid)',
    );
  });

  it('renders markers and the count for a read-only (non-admin) mount — they are reads (§F)', () => {
    renderMatrix({ canEdit: false, fields: deviationFields() });
    expect(screen.queryByTestId('bulk-fields-action-bar')).toBeNull();
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    expect(screen.getAllByTestId('deviation-marker-methodology')).toHaveLength(2);
  });

  it('widens the value column to the field minWidth so the marker is not clipped (D39)', () => {
    renderMatrix({ fields: deviationFields() });
    const header = screen.getByTestId('bulk-fields-header');
    expect(header.style.gridTemplateColumns).toContain('minmax(220px, 1fr)');
    // Fields that do not ask keep the 140px floor.
    renderMatrix({ fields: makeFields() });
    expect(screen.getAllByTestId('bulk-fields-header')[1].style.gridTemplateColumns).toContain(
      'minmax(140px, 1fr)',
    );
  });

  it('renders the opaque scopeNote in the action bar, and nothing when unset (D35)', () => {
    const { rerender } = renderMatrix({ fields: deviationFields() });
    expect(screen.queryByTestId('bulk-fields-scope-note')).toBeNull();
    rerender(
      <BulkFieldsMatrix<Row>
        rows={ROWS}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        rowNoun="Project"
        fields={deviationFields()}
        canEdit
        apply={apply}
        isApplying={false}
        entityNoun="projects"
        scopeNote={<>2 of 47 shown · Deviates from default</>}
      />,
    );
    expect(screen.getByTestId('bulk-fields-scope-note')).toHaveTextContent(
      '2 of 47 shown · Deviates from default',
    );
  });

  it('clears the selection and announces it when the cohort key changes (D13)', () => {
    const { container, rerender } = render(
      <BulkFieldsMatrix<Row>
        rows={ROWS}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        rowNoun="Project"
        fields={deviationFields()}
        canEdit
        apply={apply}
        isApplying={false}
        entityNoun="projects"
        selectionResetKey="ALL"
      />,
    );
    fireEvent.click(screen.getByLabelText<HTMLInputElement>('Select Apollo'));
    expect(screen.getByLabelText<HTMLInputElement>('Select Apollo').checked).toBe(true);

    rerender(
      <BulkFieldsMatrix<Row>
        rows={[ROWS[0]]}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        rowNoun="Project"
        fields={deviationFields()}
        canEdit
        apply={apply}
        isApplying={false}
        entityNoun="projects"
        selectionResetKey="DEVIATES"
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Select Apollo').checked).toBe(false);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Selection cleared. Showing 1 projects.',
    );
  });
});

/** Narrow viewport (< 768px): read layer intact, write affordances gone (D40). */
describe('BulkFieldsMatrix — narrow viewport card list (#3295, D40)', () => {
  beforeEach(() => {
    // `useBreakpoint` reports `sm` only when the md media query does not match; the
    // shared setup stub answers true to every `(min-width:` query.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function narrowFields(): FieldDescriptor<Row>[] {
    return [
      {
        key: 'methodology',
        label: 'Methodology',
        kind: 'enum',
        options: [{ value: 'AGILE', label: 'Agile' }],
        read: (r) => ({
          effective: r.methodology,
          overridden: false,
          deviation: {
            differs: r.methodology !== r.inheritedMethodology,
            scope: 'program',
            inherited: r.inheritedMethodology,
            own: r.methodology,
          },
        }),
        resettable: false,
      },
    ];
  }

  it('keeps markers and the header count, drops the bar, checkboxes and select-all', () => {
    renderMatrix({ fields: narrowFields(), narrowReadOnly: true });
    // Read layer intact — checking a deviation count from a phone is a real errand.
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    expect(screen.getAllByTestId('deviation-marker-methodology')).toHaveLength(2);
    // Write layer gone — bulk editing on a phone is not.
    expect(screen.queryByTestId('bulk-fields-action-bar')).toBeNull();
    expect(screen.queryByLabelText('Select Apollo')).toBeNull();
    expect(screen.queryByLabelText('Select all rows')).toBeNull();
  });

  it('states one static wall sentence — no icon, no link', () => {
    renderMatrix({ fields: narrowFields(), narrowReadOnly: true });
    const wall = screen.getByTestId('bulk-fields-narrow-wall');
    expect(wall).toHaveTextContent('Bulk edits need a wider screen.');
    expect(wall.querySelector('a')).toBeNull();
    expect(wall.querySelector('svg')).toBeNull();
  });

  it('drops the grid so the marker wraps rather than truncates', () => {
    renderMatrix({ fields: narrowFields(), narrowReadOnly: true });
    expect(screen.getByTestId('bulk-fields-header').style.gridTemplateColumns).toBe('');
    expect(screen.getAllByTestId('deviation-marker-methodology')[0].className).toContain(
      'break-words',
    );
  });

  it('says nothing about bulk edits to a reader who could not make them anyway', () => {
    renderMatrix({ canEdit: false, fields: narrowFields(), narrowReadOnly: true });
    expect(screen.queryByTestId('bulk-fields-narrow-wall')).toBeNull();
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
  });
  it('leaves a mount that did not opt in fully editable at the same width', () => {
    // The collapse is a ruling about one surface's errands, not a property of the
    // matrix — `WorkspaceProgramsPage` never made that call and must not inherit it.
    renderMatrix({ fields: narrowFields() });
    expect(screen.getByTestId('bulk-fields-action-bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Apollo')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all rows')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-fields-narrow-wall')).toBeNull();
  });
});
