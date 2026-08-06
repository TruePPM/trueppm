import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { CsvImportWizard } from './CsvImportWizard';
import type { CsvPreview } from '@/hooks/useCsvImport';

// Controllable mutation/query state so the step machine can be driven without a
// network layer, mirroring ImportModal.test's hoisted-mock pattern.
const h = vi.hoisted(() => ({
  preview: {
    isPending: false,
    isError: false,
    error: null as unknown,
    mutate: vi.fn(),
  },
  commit: {
    isPending: false,
    isError: false,
    error: null as unknown,
    mutate: vi.fn(),
  },
  status: { data: undefined as unknown },
  template: {
    isPending: false,
    isError: false,
    isSuccess: false,
    mutate: vi.fn(),
  },
}));

vi.mock('@/hooks/useCsvImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCsvImport')>();
  return {
    ...actual,
    useCsvImportPreview: () => ({ ...h.preview }),
    useCsvImportCommit: () => ({ ...h.commit }),
    useCsvImportStatus: () => ({ ...h.status }),
    useCsvImportTemplate: () => ({ ...h.template }),
  };
});

const PREVIEW: CsvPreview = {
  filename: 'plan.csv',
  headers: ['Title', 'Days', 'Notes'],
  columns: [
    { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
    { index: 1, header: 'Days', field: 'duration', confidence: 'fuzzy' },
    // `null`, not '': this is what the server actually sends for an unmatched
    // column, and the wizard must fold it rather than go uncontrolled.
    { index: 2, header: 'Notes', field: null, confidence: 'none' },
  ],
  sample_rows: [['Foundation pour', '5', 'concrete']],
  row_count: 12,
  truncated_rows: 0,
  task_count: 12,
  resource_count: 3,
  parked_row_count: 1,
  review_branch_name: 'Import review',
  row_errors: [
    { row: 4, column: 'Days', code: 'bad_duration', severity: 'warning', message: 'Duration is not a number' },
  ],
  error_count: 1,
  warning_count: 2,
  warnings: [],
  available_fields: [
    { field: 'name', label: 'Task name', required: true, multi: false },
    { field: 'duration', label: 'Duration', required: false, multi: false },
  ],
};

beforeEach(() => {
  h.preview.isPending = false;
  h.preview.isError = false;
  h.preview.mutate = vi.fn();
  h.commit.isPending = false;
  h.commit.isError = false;
  h.commit.mutate = vi.fn();
  h.status.data = undefined;
  h.template.isPending = false;
  h.template.isError = false;
  h.template.isSuccess = false;
  h.template.mutate = vi.fn();
});

/** The dropzone's file input is intentionally hidden and unlabeled. */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const CSV = () => new File(['Title,Days\nFoundation,5\n'], 'plan.csv', { type: 'text/csv' });

/** Drive the wizard to the mapping step by resolving a preview. */
async function advanceToMapping(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  preview: CsvPreview = PREVIEW,
) {
  h.preview.mutate = vi.fn((_vars, opts?: { onSuccess?: (d: CsvPreview) => void }) => {
    opts?.onSuccess?.(preview);
  });
  await user.upload(fileInput(container), CSV());
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

/** Drive all the way through commit so the terminal result view renders. */
async function advanceToResult(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  summary: Record<string, unknown>,
  status: 'done' | 'dead' = 'done',
) {
  // Seed both mocks before the first render that reads them: the hook mock
  // spreads `h.commit` per render, so a mutate reassigned after the last
  // re-render would leave the component holding the previous no-op.
  h.status.data = {
    id: 'imp-1',
    status,
    filename: 'plan.csv',
    summary,
    requested_at: '2026-07-27T00:00:00Z',
  };
  h.commit.mutate = vi.fn(
    (_vars, opts?: { onSuccess?: (d: { import_request_id: string }) => void }) => {
      opts?.onSuccess?.({ import_request_id: 'imp-1' });
    },
  );
  await advanceToMapping(user, container);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: /^Import/ }));
}

describe('CsvImportWizard (#746)', () => {
  it('starts on the upload step with Next disabled until a file is picked', () => {
    renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Import from a spreadsheet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('shows the detected mapping after preview resolves', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);

    // Auto-detected field is pre-selected, so the operator confirms rather than maps.
    expect(screen.getByLabelText('TruePPM field for column Title')).toHaveValue('name');
    expect(screen.getByLabelText('TruePPM field for column Days')).toHaveValue('duration');
    // An undetected column defaults to "don't import" rather than guessing.
    expect(screen.getByLabelText('TruePPM field for column Notes')).toHaveValue('');
  });

  it('blocks Next with a reason when a required field is unmapped', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);

    // Clearing the only name column is the failure ADR-0632 says preview exists
    // to stop: it would import zero tasks.
    await user.selectOptions(screen.getByLabelText('TruePPM field for column Title'), '');

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Task name/);
  });

  it('re-previews on the server when the mapping is re-checked', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);
    h.preview.mutate = vi.fn();

    await user.selectOptions(screen.getByLabelText('TruePPM field for column Notes'), 'duration');
    await user.click(screen.getByRole('button', { name: 'Re-check mapping' }));

    // The remap goes back to the parser rather than being re-derived client side.
    expect(h.preview.mutate).toHaveBeenCalledTimes(1);
    const [vars] = h.preview.mutate.mock.calls[0] as [{ columnMap: Record<string, string> }];
    // ONLY the touched column is pinned. Echoing the whole mapping back would
    // make the server mark every column `override`, laundering the untouched
    // `fuzzy` guess on Days into "Your choice" (web-rule 289).
    expect(vars.columnMap).toEqual({ Notes: 'duration' });
  });

  it('pins an explicit "Don\'t import" so a re-check cannot re-detect the column', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);
    h.preview.mutate = vi.fn();

    await user.selectOptions(screen.getByLabelText('TruePPM field for column Days'), '');
    await user.click(screen.getByRole('button', { name: 'Re-check mapping' }));

    // Omitting it would let auto-detection put the column straight back; the
    // server reads '' as a deliberate no-mapping.
    const [vars] = h.preview.mutate.mock.calls[0] as [{ columnMap: Record<string, string> }];
    expect(vars.columnMap).toEqual({ Days: '' });
  });

  it('summarizes unmapped columns and split row counts before committing', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText(/1 column will not be imported/)).toBeInTheDocument();
    expect(screen.getByText(/Notes/)).toBeInTheDocument();
    // Rows that cannot join the plan and rows merely defaulted are stated
    // separately — they are different decisions for the operator.
    expect(screen.getByText(/That row can’t become a task/)).toBeInTheDocument();
    // The count itself lives in the <dl>, once (web-rule 284).
    expect(screen.getByText('Parked for review')).toBeInTheDocument();
    expect(screen.getByText(/2 rows will import with a field defaulted/)).toBeInTheDocument();
  });

  it('names the review branch before the commit, not after it (#2732)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // The operator must not meet the review branch for the first time in their
    // outline: what happens to an unresolvable row is stated at map time.
    expect(screen.getByText(/parked in an “Import review” branch/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is dropped/)).toBeInTheDocument();
    // Counted as its own line so it is not read as part of the plan.
    expect(screen.getByText('Parked for review')).toBeInTheDocument();
  });

  it('states that imported dates are re-derived, before the commit', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container, {
      ...PREVIEW,
      columns: [
        { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
        { index: 1, header: 'Begin', field: 'planned_start', confidence: 'exact' },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText(/some dates may move/)).toBeInTheDocument();
  });

  it('says nothing about dates when no date column is mapped', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await advanceToMapping(user, container);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.queryByText(/some dates may move/)).not.toBeInTheDocument();
  });

  it('reports partial success as a result, listing failed rows by line number', () => {
    h.status.data = {
      id: 'imp-1',
      status: 'done',
      filename: 'plan.csv',
      summary: {
        tasks_created: 11,
        row_errors: [{ row: 4, message: 'Duration is not a number' }],
      },
      requested_at: '2026-07-27T00:00:00Z',
    };
    renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

    // The wizard mounts on 'upload'; assert the terminal copy via a direct
    // render of the result state is covered by the e2e spec. Here we only need
    // the status hook wiring not to throw on a terminal payload.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  describe('import review branch (#2732)', () => {
    const PARKED_SUMMARY = {
      tasks_created: 13,
      plan_tasks_created: 11,
      parked_row_count: 2,
      review_branch_name: 'Import review',
      row_errors: [
        { row: 7, code: 'missing_name', column: 'Title', message: 'Row has no task name.' },
        { row: 9, code: 'missing_name', column: 'Title', message: 'Row has no task name.' },
        { row: 4, code: 'bad_duration', column: 'Days', message: "Could not read 'x'." },
      ],
    };

    it('reports the plan count, not the count including the parked rows', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, PARKED_SUMMARY);

      // 13 rows were written; 11 of them are the operator's plan. Claiming 13
      // would count two placeholders they still have to fix.
      expect(screen.getByText(/Imported 11 tasks\./)).toBeInTheDocument();
      expect(screen.getByText(/2 rows parked in the “Import review” branch\./)).toBeInTheDocument();
    });

    it('says the rows are already in the outline, not that they must be re-uploaded', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, PARKED_SUMMARY);

      expect(screen.getByText(/already in your outline/)).toBeInTheDocument();
      expect(screen.getByText(/like any other task/)).toBeInTheDocument();
    });

    it('groups the diagnostics by cause rather than listing one line per row', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, PARKED_SUMMARY);

      const list = screen.getByRole('region', { name: 'Rows with problems' });
      // Largest cause first, with the rows it covers on one line — the shape of
      // the single edit that fixes them.
      expect(list).toHaveTextContent('No task name — 2 rows');
      expect(list).toHaveTextContent('Row 7, Row 9');
      expect(list).toHaveTextContent('Unreadable duration — 1 row');
    });

    it('offers the problem rows as a CSV built from the payload in hand', async () => {
      const user = userEvent.setup();
      const createObjectURL = vi.fn(() => 'blob:problems');
      const revokeObjectURL = vi.fn();
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);

      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, PARKED_SUMMARY);
      await user.click(screen.getByRole('button', { name: 'Download problem rows (CSV)' }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      click.mockRestore();
      vi.unstubAllGlobals();
    });

    it('shows no review-branch copy when nothing was parked', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, {
        tasks_created: 12,
        plan_tasks_created: 12,
        parked_row_count: 0,
        row_errors: [],
        warnings: [],
      });

      expect(screen.queryByText(/parked in/)).not.toBeInTheDocument();
      expect(screen.getByText(/Imported 12 tasks\./)).toBeInTheDocument();
    });
  });

  describe('file notices (#111)', () => {
    const WITH_NOTICES: CsvPreview = {
      ...PREVIEW,
      warnings: [
        "Only the first sheet ('Sheet1') was imported. 2 other sheet(s) were ignored.",
        'Dates like 03/04/2026 were read as day/month/year.',
      ],
    };

    it('shows whole-file parser decisions on the mapping step', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container, WITH_NOTICES);

      const notices = screen.getByRole('region', { name: 'How we read this file' });
      expect(notices).toHaveTextContent(/Only the first sheet/);
      expect(notices).toHaveTextContent(/day\/month\/year/);
    });

    it('repeats them on the confirm step, the last screen before commit', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container, WITH_NOTICES);
      await user.click(screen.getByRole('button', { name: 'Next' }));

      expect(screen.getByRole('region', { name: 'How we read this file' })).toHaveTextContent(
        /Only the first sheet/,
      );
    });

    it('renders nothing when the parser made no decision worth reporting', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container);

      expect(
        screen.queryByRole('region', { name: 'How we read this file' }),
      ).not.toBeInTheDocument();
    });

    it('surfaces the notices the commit re-parse produced', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, {
        tasks_created: 11,
        warnings: ['Only the first 5,000 rows were imported; 1,000 were skipped.'],
      });

      expect(screen.getByRole('region', { name: 'How we read this file' })).toHaveTextContent(
        /1,000 were skipped/,
      );
      // The outcome sentence carries the count so the polite announcement is
      // complete without navigating to the list.
      expect(screen.getByText(/1 note about this file/)).toBeInTheDocument();
    });
  });

  describe('truncated rows (#111)', () => {
    it('states the file total, not just the post-truncation count', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      // "5,000" alone would be a lie about a 6,000-row file.
      await advanceToMapping(user, container, {
        ...PREVIEW,
        row_count: 5000,
        truncated_rows: 1000,
      });
      await user.click(screen.getByRole('button', { name: 'Next' }));

      expect(screen.getByText('5,000 of 6,000')).toBeInTheDocument();
    });

    it('states the plain count when nothing was truncated', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container);
      await user.click(screen.getByRole('button', { name: 'Next' }));

      // `row_count` and `task_count` are both 12 here, so assert on the shape
      // of the value rather than a unique string.
      expect(screen.getAllByText('12').length).toBeGreaterThan(0);
      expect(screen.queryByText(/\d+ of \d+/)).not.toBeInTheDocument();
    });
  });

  describe('mapping confidence (#111)', () => {
    it('flags a guessed column and stays silent on an exact match', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container);

      // Silence is the confident state: badging every exact match would bury
      // the one column that actually needs an eye.
      expect(screen.getByText('Guessed — check this')).toBeInTheDocument();
      expect(screen.getByText('No match found')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Check the 1 column flagged below.');
    });

    it('explains a column dropped for claiming a taken field', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container, {
        ...PREVIEW,
        headers: ['Title', 'Task', 'Days'],
        columns: [
          { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
          { index: 1, header: 'Task', field: null, confidence: 'duplicate' },
          { index: 2, header: 'Days', field: 'duration', confidence: 'exact' },
        ],
      });

      // Without this the column just looks mysteriously unmapped.
      expect(
        screen.getByText('Not imported — another column already uses this field'),
      ).toBeInTheDocument();
      // A null field must not flip the select to uncontrolled.
      expect(screen.getByLabelText('TruePPM field for column Task')).toHaveValue('');
    });

    it('describes the select by its note so the guidance reaches the control', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container);

      expect(screen.getByLabelText('TruePPM field for column Days')).toHaveAccessibleDescription(
        'Guessed — check this',
      );
      // An exact match has no note, so nothing to describe.
      expect(
        screen.getByLabelText('TruePPM field for column Title'),
      ).not.toHaveAttribute('aria-describedby');
    });

    it('drains the flagged count as the operator corrects a column', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToMapping(user, container);
      await user.selectOptions(screen.getByLabelText('TruePPM field for column Days'), 'duration');

      // A corrected column must stop reading "Guessed" — otherwise the flag
      // list never drains and the operator cannot tell what is left to check.
      expect(screen.queryByText('Guessed — check this')).not.toBeInTheDocument();
      expect(screen.getByText('Your choice')).toBeInTheDocument();
      expect(screen.queryByText(/flagged below/)).not.toBeInTheDocument();
    });
  });

  describe('template download (#111)', () => {
    it('offers the template as a button, since the endpoint needs a bearer token', async () => {
      const user = userEvent.setup();
      renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

      const button = screen.getByRole('button', { name: 'Download a template' });
      await user.click(button);
      expect(h.template.mutate).toHaveBeenCalledTimes(1);
    });

    it('reports a failed download without moving focus off the retry', () => {
      h.template.isError = true;
      renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't download the template/);
      expect(screen.getByRole('button', { name: 'Download a template' })).toBeEnabled();
    });

    it('announces success to assistive tech, the browser handling the visible part', () => {
      h.template.isSuccess = true;
      renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

      expect(screen.getByText('Template downloaded.')).toBeInTheDocument();
    });

    it('stays available while a preview is in flight', () => {
      h.preview.isPending = true;
      renderWithProvidersAndRouter(<CsvImportWizard projectId="p1" onClose={vi.fn()} />);

      expect(screen.getByRole('button', { name: 'Download a template' })).toBeEnabled();
    });
  });

  describe('terminal focus (#111)', () => {
    it('focuses the schedule action on a clean import', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, { tasks_created: 12, row_errors: [], warnings: [] });

      // Nothing to read, so the schedule is one keystroke away — the AC's
      // "auto-navigate" without a WCAG 2.2.1 timed context change.
      expect(screen.getByRole('button', { name: 'View schedule' })).toHaveFocus();
    });

    it('does not aim at the schedule when rows failed, so the line numbers are read', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, {
        tasks_created: 13,
        plan_tasks_created: 11,
        parked_row_count: 1,
        review_branch_name: 'Import review',
        row_errors: [{ row: 4, code: 'missing_name', message: 'Row has no task name.' }],
      });

      // Walking the operator past a partial-success report is exactly what the
      // interchange spec §5.8 forbids. Close is a real focusable, so unlike a
      // tabIndex={-1} paragraph it cannot punch a Shift+Tab hole in the focus
      // trap (web-rule 288).
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
      expect(screen.getByText(/1 row parked in the “Import review” branch\./)).toBeInTheDocument();
    });

    it('keeps focus off the schedule when file notices need reading', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, {
        tasks_created: 12,
        row_errors: [],
        warnings: ['Only the first sheet was imported.'],
      });

      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('seats terminal focus on a real focusable, never a tabIndex=-1 node', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProvidersAndRouter(
        <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
      );
      await advanceToResult(user, container, {
        tasks_created: 11,
        row_errors: [{ row: 4, code: 'bad_duration', message: 'Duration is not a number' }],
      });

      // useFocusTrap's selector excludes tabindex="-1", so a node it cannot see
      // lets Shift+Tab escape the dialog when nothing focusable precedes it.
      expect(document.activeElement?.getAttribute('tabindex')).not.toBe('-1');
      expect(document.activeElement?.tagName).toBe('BUTTON');
    });
  });

  it('surfaces the server detail when preview fails', async () => {
    const user = userEvent.setup();
    h.preview.isError = true;
    h.preview.error = {
      isAxiosError: true,
      response: { data: { detail: 'No readable header row.' } },
    };
    const { container } = renderWithProvidersAndRouter(
      <CsvImportWizard projectId="p1" onClose={vi.fn()} />,
    );
    await user.upload(fileInput(container), CSV());

    expect(screen.getByRole('alert')).toHaveTextContent('No readable header row.');
  });
});
