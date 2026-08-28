import { describe, it, expect, vi } from 'vitest';
import { formatChord } from '@/lib/platform';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectResource, Task } from '@/types';
import { BulkEditSheet, type BulkEditSheetProps } from './BulkEditSheet';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    wbs: '1',
    name: id,
    start: '2026-03-01',
    finish: '2026-03-05',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'todo',
    assignees: [],
    ...over,
  } as Task;
}

const ANA = {
  id: 'pr-1',
  projectId: 'p1',
  resourceId: 'r-ana',
  resource: {
    id: 'r-ana',
    name: 'Ana Rivera',
    email: 'ana@example.com',
    jobRole: '',
    maxUnits: 1,
    calendarId: null,
    skills: [],
  },
  roleTitle: '',
  unitsOverride: null,
  effectiveMaxUnits: 1,
  notes: '',
} as ProjectResource;

function renderSheet(over: Partial<BulkEditSheetProps> = {}) {
  const props: BulkEditSheetProps = {
    tasks: [task('t1'), task('t2')],
    resourcePool: [ANA],
    isPending: false,
    error: null,
    result: null,
    skippedLocallyCount: 0,
    onApply: vi.fn(),
    onReviewFailed: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<BulkEditSheet {...props} />);
  return props;
}

describe('BulkEditSheet — form phase', () => {
  it('names the selection size and says it will not cascade', () => {
    renderSheet();
    const sheet = screen.getByTestId('bulk-edit-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Edit 2 rows' })).toBeInTheDocument();
    expect(within(sheet).getByText(/no cascade/)).toBeInTheDocument();
    // The subtree lens is named exactly once, on the group it concerns.
    expect(within(sheet).getByText(`${formatChord('mod+shift+m')} for a whole subtree`)).toBeInTheDocument();
  });

  it('is a modal dialog labelled by the selection size', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Edit 2 rows' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('keeps Apply disabled until a field moves off leave', async () => {
    renderSheet();
    const apply = screen.getByTestId('bulk-edit-apply');
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByTestId('bulk_delivery_mode-scrum'));
    expect(apply).toBeEnabled();
  });

  it('counts the selection on the Apply button, so the blast radius is on the button', async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId('bulk_governance_class-flow'));
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Apply to 2');
  });

  it('shows the pending change in the review line before it is applied', async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId('bulk_delivery_mode-kanban'));
    expect(screen.getByTestId('bulk-edit-review')).toHaveTextContent('Progress from kanban');
  });

  it('labels the untouched classification option "Leave — Mixed" when rows disagree', () => {
    renderSheet({
      tasks: [task('t1', { deliveryMode: 'scrum' }), task('t2', { deliveryMode: 'kanban' })],
    });
    expect(screen.getByText('Leave — Mixed')).toBeInTheDocument();
  });

  it('shows the shared value instead of Mixed when the rows agree', () => {
    renderSheet({
      tasks: [task('t1', { deliveryMode: 'scrum' }), task('t2', { deliveryMode: 'scrum' })],
    });
    expect(screen.getByText('Leave — scrum')).toBeInTheDocument();
  });

  it('says Add owner, and states that it never replaces one', () => {
    // `owners` is an upsert (ADR-0774) and there is no removal path on this
    // endpoint — the copy has to be honest about that.
    renderSheet();
    expect(screen.getByText('Add owner')).toBeInTheDocument();
    expect(screen.getByText(/never replaces one/)).toBeInTheDocument();
  });

  it('warns about summary rows only once an owner is actually chosen', async () => {
    renderSheet({ tasks: [task('t1'), task('sum', { isSummary: true })] });
    expect(screen.queryByTestId('bulk-edit-warning-summary')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('bulk-edit-owner'), 'r-ana');
    expect(screen.getByTestId('bulk-edit-warning-summary')).toHaveTextContent(
      /1 of the selected rows is a summary row/,
    );
  });

  it('warns up front about rows the server has said this user cannot edit', () => {
    renderSheet({ tasks: [task('t1'), task('locked', { canEdit: false })] });
    expect(screen.getByTestId('bulk-edit-warning-not-editable')).toHaveTextContent(
      /1 row you can’t edit/,
    );
  });

  it('reveals a date input only once Set is chosen, and explains the SNET floor', async () => {
    renderSheet();
    expect(screen.queryByTestId('bulk-planned-start-value')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('bulk-planned-start-set'));
    const input = screen.getByTestId('bulk-planned-start-value');
    await userEvent.type(input, '2026-03-12');
    // planned_start is the committed SNET constraint, not the CPM early start.
    expect(screen.getByText(/start no earlier than 2026-03-12/)).toBeInTheDocument();
  });

  it('offers Clear on dates, which owner deliberately lacks', () => {
    renderSheet();
    expect(screen.getByTestId('bulk-planned-start-clear')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-planned-finish-clear')).toBeInTheDocument();
  });

  it('cannot set delivery_mode to milestone — the flag, duration and mode are one fact', () => {
    renderSheet();
    expect(screen.getByTestId('bulk_delivery_mode-milestone-input')).toBeDisabled();
  });

  it('hands the assembled spec to onApply', async () => {
    const props = renderSheet();
    await userEvent.selectOptions(screen.getByTestId('bulk-edit-owner'), 'r-ana');
    await userEvent.click(screen.getByTestId('bulk-edit-apply'));
    const applied = vi.mocked(props.onApply).mock.calls[0][0];
    expect(applied.owner).toEqual({
      mode: 'add',
      resourceId: 'r-ana',
      resourceName: 'Ana Rivera',
      percent: 100,
    });
  });

  it('turns Apply into Retry on a transport failure', () => {
    renderSheet({ error: 'Couldn’t apply the changes.' });
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Retry');
    expect(screen.getByText('Couldn’t apply the changes.')).toBeInTheDocument();
  });
});

describe('BulkEditSheet — result phase', () => {
  const RESULT = {
    applied: [{ index: 0, id: 't1', op: 'update' as const, outcome: 'updated' as const }],
    rejected: [
      { index: 1, id: 't2', code: 'forbidden' as const, message: 'You don’t have edit access.' },
    ],
    skipped: [],
    capabilities_denied: [],
    operation_id: null,
  };

  it('reports applied against the whole selection, not against what was sent', () => {
    renderSheet({ result: RESULT });
    expect(screen.getByTestId('bulk-edit-result')).toHaveTextContent('1 of 2 rows updated');
  });

  it('folds locally-skipped rows into the skipped count so the totals add up', () => {
    renderSheet({
      tasks: [task('t1'), task('t2'), task('sum', { isSummary: true })],
      result: { ...RESULT, rejected: [] },
      skippedLocallyCount: 1,
    });
    expect(screen.getByTestId('bulk-edit-result')).toHaveTextContent('1 skipped');
  });

  it('gives the rejection reason rather than a bare count', () => {
    renderSheet({ result: RESULT });
    expect(screen.getByTestId('bulk-edit-result')).toHaveTextContent('You don’t have edit access.');
  });

  it('hands the failed ids back so they become the new selection', async () => {
    const props = renderSheet({ result: RESULT });
    await userEvent.click(screen.getByTestId('bulk-edit-review-failed'));
    expect(props.onReviewFailed).toHaveBeenCalledWith(['t2']);
  });

  it('offers no Review action when every rejection lacks a navigable id', () => {
    renderSheet({
      result: {
        ...RESULT,
        rejected: [{ index: 0, id: null, code: 'invalid', message: 'Bad row.' }],
      },
    });
    expect(screen.queryByTestId('bulk-edit-review-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-edit-done')).toBeInTheDocument();
  });

  it('announces the whole breakdown politely, not just the count', () => {
    // The reason a row failed is the only actionable part; a live region scoped
    // to the count alone withholds exactly that from a screen-reader user.
    renderSheet({ result: RESULT });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('1 of 2 rows updated');
    expect(status).toHaveTextContent('You don’t have edit access.');
  });
});
