import { describe, it, expect, vi } from 'vitest';
import { formatChord } from '@/lib/platform';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiSprint, ProjectResource, Task } from '@/types';
import type { TaskBulkResponse } from '@/hooks/useTaskMutations';
import { BulkEditSheet, type BulkEditSheetProps } from './BulkEditSheet';
import { OWNER_ARMS } from './bulkEditSpec';

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
    status: 'NOT_STARTED',
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

const SPRINTS = [
  { id: 'sp-plan', name: 'Sprint 8', state: 'PLANNED' },
  { id: 'sp-live', name: 'Sprint 7', state: 'ACTIVE' },
  { id: 'sp-done', name: 'Sprint 6', state: 'COMPLETED' },
] as unknown as ApiSprint[];

function renderSheet(over: Partial<BulkEditSheetProps> = {}) {
  const props: BulkEditSheetProps = {
    tasks: [task('t1'), task('t2')],
    resourcePool: [ANA],
    sprints: SPRINTS,
    isPending: false,
    error: null,
    result: null,
    skippedLocallyIds: [],
    onApply: vi.fn(),
    onReviewFailed: vi.fn(),
    onDone: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<BulkEditSheet {...props} />);
  return props;
}

describe('BulkEditSheet — form phase', () => {
  it('names the selection size in the item noun and says it will not cascade', () => {
    renderSheet();
    const sheet = screen.getByTestId('bulk-edit-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Edit 2 items' })).toBeInTheDocument();
    expect(within(sheet).getByText(/no cascade/)).toBeInTheDocument();
    // The subtree lens is named exactly once, on the group it concerns.
    expect(
      within(sheet).getByText(`${formatChord('mod+shift+m')} for a whole subtree`),
    ).toBeInTheDocument();
  });

  it('is a modal dialog labelled by the selection size', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Edit 2 items' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('groups the fields Plan · Placement & policy · People, People last (S1, S2)', () => {
    renderSheet();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Plan', 'Placement & policy', 'People']);
  });

  it('keeps Apply disabled until a field moves off leave', async () => {
    renderSheet();
    expect(screen.getByTestId('bulk-edit-apply')).toBeDisabled();
    await userEvent.click(screen.getByTestId('bulk_delivery_mode-scrum'));
    expect(screen.getByTestId('bulk-edit-apply')).toBeEnabled();
  });

  it('counts the selection on the Apply button, so the blast radius is on the button', async () => {
    renderSheet({ tasks: [task('a'), task('b'), task('c')] });
    await userEvent.click(screen.getByTestId('bulk_governance_class-flow'));
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Apply to 3 items');
  });

  it('describes Apply with the review block rather than making it a live region (S15)', () => {
    renderSheet();
    const review = screen.getByTestId('bulk-edit-review');
    expect(screen.getByTestId('bulk-edit-apply')).toHaveAttribute('aria-describedby', review.id);
    // It changes on every keystroke, so narrating it continuously is unusable.
    expect(review).not.toHaveAttribute('aria-live');
    expect(review).not.toHaveAttribute('role', 'status');
  });

  it('labels the untouched classification option "Leave — Mixed" when rows disagree', () => {
    renderSheet({
      tasks: [task('a', { deliveryMode: 'scrum' }), task('b', { deliveryMode: 'kanban' })],
    });
    expect(screen.getByTestId('bulk_delivery_mode-leave')).toHaveTextContent('Leave — Mixed');
  });

  it('shows the shared value instead of Mixed when the rows agree', () => {
    renderSheet({
      tasks: [task('a', { deliveryMode: 'scrum' }), task('b', { deliveryMode: 'scrum' })],
    });
    expect(screen.getByTestId('bulk_delivery_mode-leave')).toHaveTextContent('Leave — scrum');
  });

  it('cannot set delivery_mode to milestone — the flag, duration and mode are one fact', () => {
    renderSheet();
    expect(screen.getByTestId('bulk_delivery_mode-milestone-input')).toBeDisabled();
  });

  it('warns up front about rows the server has said this user cannot edit', () => {
    renderSheet({ tasks: [task('a'), task('locked', { canEdit: false })] });
    expect(screen.getByTestId('bulk-edit-warning-not-editable')).toHaveTextContent('1 item');
  });

  it('reveals a date input only once Set is chosen, and explains the SNET floor', async () => {
    renderSheet();
    expect(screen.queryByTestId('bulk-planned-start-value')).toBeNull();
    await userEvent.click(screen.getByTestId('bulk-planned-start-set'));
    await userEvent.type(screen.getByTestId('bulk-planned-start-value'), '2026-05-04');
    expect(screen.getByText(/will start no earlier than 2026-05-04/)).toBeInTheDocument();
  });

  it('has no ✕ at all — Escape and Cancel are the two exits (S21)', () => {
    renderSheet();
    // A `md:hidden` ✕ shipped here briefly "for the phone". It could never be
    // reached: build mode is off below md and the toolbar that opens this sheet
    // renders null there, so the button existed only in the band with no door.
    expect(screen.queryByLabelText('Close bulk edit')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('takes its accessible name FROM the visible heading, not a second copy', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Edit 2 items' });
    const heading = screen.getByRole('heading', { name: 'Edit 2 items' });
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
  });
});

describe('BulkEditSheet — duration and percent complete (#3152, S5–S8)', () => {
  it('offers Leave and Set only — there is no value a duration Clear could write', () => {
    renderSheet();
    expect(screen.getByTestId('bulk-duration-leave')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-duration-set')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-duration-clear')).toBeNull();
    expect(screen.queryByTestId('bulk-percent-clear')).toBeNull();
  });

  it('reveals a worded operator select, not a sign glyph (S6)', async () => {
    renderSheet();
    expect(screen.queryByTestId('bulk-duration-op')).toBeNull();
    await userEvent.click(screen.getByTestId('bulk-duration-set'));
    const op = screen.getByTestId('bulk-duration-op');
    expect([...op.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Set to',
      'Increase by',
      'Reduce by',
    ]);
  });

  it('flips the operator when +2 is typed, and the select is still the primary route', async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId('bulk-duration-set'));
    await userEvent.type(screen.getByTestId('bulk-duration-amount'), '+2');
    expect(screen.getByTestId('bulk-duration-op')).toHaveValue('plus');
    expect(screen.getByTestId('bulk-edit-review')).toHaveTextContent('Increase by 2d');

    // …and the select alone still reaches every operation.
    await userEvent.selectOptions(screen.getByTestId('bulk-duration-op'), 'minus');
    expect(screen.getByTestId('bulk-edit-review')).toHaveTextContent('Reduce by 2d');
  });

  it('states the clamped count before Apply, never after (S8)', async () => {
    renderSheet({ tasks: [task('a', { progress: 80 }), task('b', { progress: 10 })] });
    await userEvent.click(screen.getByTestId('bulk-percent-set'));
    await userEvent.type(screen.getByTestId('bulk-percent-amount'), '+50');
    expect(screen.getByTestId('bulk-edit-line-percentComplete')).toHaveTextContent(
      '1 item stop at 0–100%',
    );
  });

  it('discloses the auto-promotion a 100% write would trigger (#2639)', async () => {
    renderSheet({
      tasks: [task('a', { status: 'IN_PROGRESS' as Task['status'] })],
      autoPromoteTarget: 'COMPLETE',
    });
    await userEvent.click(screen.getByTestId('bulk-percent-set'));
    await userEvent.type(screen.getByTestId('bulk-percent-amount'), '100');
    expect(screen.getByTestId('bulk-edit-line-percentComplete')).toHaveTextContent(
      'will also move to Complete',
    );
  });

  it('warns that summary and milestone rows are left alone by a duration write', async () => {
    renderSheet({ tasks: [task('a'), task('sum', { isSummary: true })] });
    await userEvent.click(screen.getByTestId('bulk-duration-set'));
    await userEvent.type(screen.getByTestId('bulk-duration-amount'), '3');
    expect(screen.getByTestId('bulk-edit-warning-duration-locked')).toHaveTextContent('1 item');
  });
});

describe('BulkEditSheet — sprint (#3152)', () => {
  it('offers all three arms and only sprints work can move into', async () => {
    renderSheet();
    expect(screen.getByTestId('bulk-sprint-leave')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-sprint-clear')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('bulk-sprint-set'));
    const labels = [...screen.getByTestId('bulk-sprint-value').querySelectorAll('option')].map(
      (o) => o.textContent,
    );
    // A closed sprint is not a destination — moving work into one is rewriting
    // history, and the server refuses it.
    expect(labels).toEqual(['Choose a sprint…', 'Sprint 8', 'Sprint 7 (running)']);
  });

  it('states sprint sovereignty when the target sprint is running (ADR-0102)', async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId('bulk-sprint-set'));
    await userEvent.selectOptions(screen.getByTestId('bulk-sprint-value'), 'sp-plan');
    expect(screen.queryByTestId('bulk-edit-sprint-pending-note')).toBeNull();

    await userEvent.selectOptions(screen.getByTestId('bulk-sprint-value'), 'sp-live');
    expect(screen.getByTestId('bulk-edit-sprint-pending-note')).toHaveTextContent(
      /held pending until someone accepts/,
    );
  });
});

describe('BulkEditSheet — owner, at its final size (#3153, S9–S12)', () => {
  it('renders four arms in Leave · Add · Remove · Replace order, in ONE radio group', () => {
    renderSheet();
    const inputs = OWNER_ARMS.map((a) => screen.getByTestId(`bulk-owner-${a.mode}-input`));
    expect(inputs.map((i) => i.getAttribute('name'))).toEqual(Array(4).fill('bulk_owner_mode'));
    expect(OWNER_ARMS.map((a) => screen.getByTestId(`bulk-owner-${a.mode}`).textContent)).toEqual([
      'Leave',
      'Add',
      'Remove0.5',
      'Replace0.5',
    ]);
  });

  it('carries the ships-in version out of the accessible name, with a carrier phrase', () => {
    // A bare "0.5" inside the label lands in the radio's accname as an
    // uninterpretable value ("Remove 0.5"). The badge is hidden; the sentence
    // beside it is what AT reads.
    renderSheet();
    expect(screen.getByTestId('bulk-owner-remove-badge')).toHaveAttribute('aria-hidden', 'true');
    // An explicit `aria-label`, because the accname computation trims each text
    // node before joining and the space between two siblings does not survive.
    expect(screen.getByRole('radio', { name: 'Remove — ships in 0.5' })).toBeInTheDocument();
  });

  it('mounts the refusal live region before it has anything to say (rule 335)', () => {
    // A live region inserted together with its own content is announced
    // inconsistently — and this announcement IS the refusal for an AT user.
    renderSheet();
    const region = screen.getByTestId('bulk-owner-refusal');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();
  });

  it('words the refusal as a sentence, not a button label', async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId('bulk-owner-remove'));
    expect(screen.getByTestId('bulk-owner-refusal')).toHaveTextContent(
      'Removing an owner ships in 0.5. Nothing was changed.',
    );
  });

  it('keeps the inert arms aria-disabled and NEVER disabled, so they keep a tab stop', () => {
    // `disabled` would strip the tab stop and the accessible name, and the
    // refusal would then happen silently at Apply instead of at the attempt.
    renderSheet();
    for (const mode of ['remove', 'replace']) {
      const input = screen.getByTestId(`bulk-owner-${mode}-input`);
      expect(input).toHaveAttribute('aria-disabled', 'true');
      expect(input).not.toBeDisabled();
      expect(screen.getByTestId(`bulk-owner-${mode}-badge`)).toHaveTextContent('0.5');
    }
  });

  it('states the reason at rest, before anybody attempts anything', () => {
    renderSheet();
    expect(screen.getByText(/Remove and Replace ship in\s+0\.5/)).toBeInTheDocument();
  });

  it('refuses at the moment of the attempt, and changes nothing', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk-owner-remove'));
    expect(screen.getByTestId('bulk-owner-refusal')).toHaveTextContent(/ships in 0\.5/);
    expect(screen.getByTestId('bulk-owner-remove-input')).not.toBeChecked();
    expect(screen.getByTestId('bulk-owner-leave-input')).toBeChecked();
    expect(screen.getByTestId('bulk-edit-apply')).toBeDisabled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('reserves the payload slot whichever arm is chosen, so 0.5 moves nothing', async () => {
    renderSheet();
    const slot = screen.getByTestId('bulk-owner-payload');
    expect(slot).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('bulk-owner-add'));
    // Same slot element, now filled — not a second container appearing below.
    expect(screen.getByTestId('bulk-owner-payload')).toBe(slot);
    expect(within(slot).getByTestId('bulk-edit-owner')).toBeInTheDocument();
  });

  it('says Add is an upsert and how to reduce someone', () => {
    renderSheet();
    expect(screen.getByText(/Add is an upsert/)).toBeInTheDocument();
  });

  it('warns about summary rows only once an owner is actually chosen', async () => {
    renderSheet({ tasks: [task('a'), task('sum', { isSummary: true })] });
    await userEvent.click(screen.getByTestId('bulk-owner-add'));
    expect(screen.queryByTestId('bulk-edit-warning-summary')).toBeNull();
    await userEvent.selectOptions(screen.getByTestId('bulk-edit-owner'), 'r-ana');
    expect(screen.getByTestId('bulk-edit-warning-summary')).toHaveTextContent('1 item');
  });
});

describe('BulkEditSheet — review block (S14)', () => {
  it('emits one line per written field, each with its OWN denominator', async () => {
    renderSheet({ tasks: [task('a'), task('b'), task('c')] });
    await userEvent.click(screen.getByTestId('bulk_governance_class-flow'));
    await userEvent.click(screen.getByTestId('bulk-duration-set'));
    await userEvent.type(screen.getByTestId('bulk-duration-amount'), '4');

    const review = screen.getByTestId('bulk-edit-review');
    const lines = within(review).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    // Field order, not the order they were touched in.
    expect(lines[0]).toHaveAttribute('data-testid', 'bulk-edit-line-duration');
    expect(lines[1]).toHaveAttribute('data-testid', 'bulk-edit-line-governanceClass');
    expect(lines.every((l) => l.getAttribute('data-denominator') === '3')).toBe(true);
  });

  it('draws no line for a field on Leave (S4)', () => {
    renderSheet();
    expect(screen.getByTestId('bulk-edit-review')).toHaveTextContent(
      'Choose a value on any field.',
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

describe('BulkEditSheet — ⌘⏎ guard (S16)', () => {
  it('applies on the first chord when nothing destructive is set', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk_governance_class-gated'));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it('refuses the first chord over a Clear, seats focus on Apply, and reads the review back', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk-planned-finish-clear'));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    expect(props.onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId('bulk-edit-chord-guard')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-edit-apply')).toHaveFocus();
    // …and the review is what Apply is described by, so seating focus there IS
    // reading it back rather than announcing the button's name alone.
    expect(screen.getByTestId('bulk-edit-apply')).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId('bulk-edit-review').id,
    );

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it('re-arms the guard when the spec changes after the first refusal', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk-planned-finish-clear'));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await userEvent.click(screen.getByTestId('bulk_governance_class-flow'));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

describe('BulkEditSheet — Escape reverts one field, then closes (S22)', () => {
  it('reverts the last touched field instead of closing', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk_delivery_mode-kanban'));
    await userEvent.keyboard('{Escape}');

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('bulk_delivery_mode-leave-input')).toBeChecked();
    expect(screen.getByTestId('bulk-edit-apply')).toBeDisabled();
  });

  it('closes on the next Escape, with no confirmation — nothing was written', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByTestId('bulk_delivery_mode-kanban'));
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes immediately when no field was touched', async () => {
    const props = renderSheet();
    await userEvent.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

function bulkResult(over: Partial<TaskBulkResponse> = {}): TaskBulkResponse {
  return {
    applied: [],
    rejected: [],
    skipped: [],
    capabilities_denied: [],
    operation_id: null,
    ...over,
  } as TaskBulkResponse;
}

/** Sum the four terms a field's result line renders, straight out of the DOM. */
function readLineTerms(el: HTMLElement): { terms: Record<string, number>; denominator: number } {
  const text = el.textContent ?? '';
  const terms: Record<string, number> = {};
  for (const [, n, word] of text.matchAll(
    /(\d+) (to update|updated|unchanged|left alone|refused)/g,
  )) {
    terms[word] = Number(n);
  }
  return { terms, denominator: Number(el.getAttribute('data-denominator')) };
}

describe('BulkEditSheet — result phase (S17–S20)', () => {
  async function applyOver(
    tasks: Task[],
    result: TaskBulkResponse,
    skippedLocallyIds: string[] = [],
  ) {
    const { rerender } = render(
      <BulkEditSheet
        tasks={tasks}
        resourcePool={[ANA]}
        sprints={SPRINTS}
        isPending={false}
        error={null}
        result={null}
        skippedLocallyIds={[]}
        onApply={vi.fn()}
        onReviewFailed={vi.fn()}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('bulk_governance_class-flow'));
    await userEvent.click(screen.getByTestId('bulk-edit-apply'));
    rerender(
      <BulkEditSheet
        tasks={tasks}
        resourcePool={[ANA]}
        sprints={SPRINTS}
        isPending={false}
        error={null}
        result={result}
        skippedLocallyIds={skippedLocallyIds}
        onApply={vi.fn()}
        onReviewFailed={vi.fn()}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it('BALANCES the arithmetic in the rendered DOM (S18)', async () => {
    // This is the assertion S18 asks for by name: an item cannot be silently
    // dropped without breaking addition that is ON SCREEN. It reads the numbers
    // back out of the panel rather than trusting the function that produced them.
    await applyOver(
      [
        task('ok', { governanceClass: 'gated' }),
        task('same', { governanceClass: 'flow' }),
        task('locked', { governanceClass: 'gated', canEdit: false }),
        task('dropped', { governanceClass: 'gated' }),
      ],
      bulkResult({
        applied: [{ index: 0, id: 'ok', op: 'update', outcome: 'updated' }],
        rejected: [
          { index: 2, id: 'locked', code: 'forbidden', message: 'You may not edit this task.' },
        ],
      } as Partial<TaskBulkResponse>),
      ['dropped'],
    );

    const line = screen.getByTestId('bulk-edit-line-governanceClass');
    const { terms, denominator } = readLineTerms(line);
    expect(denominator).toBe(4);
    expect(terms).toEqual({ updated: 1, unchanged: 1, 'left alone': 1, refused: 1 });
    const sum = Object.values(terms).reduce((a, b) => a + b, 0);
    expect(sum).toBe(denominator);
  });

  it('counts CHANGES in the header, never items (S19)', async () => {
    await applyOver([task('a'), task('b')], bulkResult());
    // Two items × one field = two changes. `"2 of 2 items updated"` is exactly
    // the claim the per-field equation forbids.
    expect(screen.getByTestId('bulk-edit-result-header')).toHaveTextContent('2 changes applied');
  });

  it('offers a retry only when something was refused (S20)', async () => {
    await applyOver([task('a')], bulkResult());
    expect(screen.queryByTestId('bulk-edit-review-failed')).toBeNull();
  });

  it('offers the retry for refusals and hands the ids back', async () => {
    const onReviewFailed = vi.fn();
    render(
      <BulkEditSheet
        tasks={[task('a'), task('b')]}
        resourcePool={[ANA]}
        isPending={false}
        error={null}
        result={bulkResult({
          rejected: [
            { index: 1, id: 'b', code: 'forbidden', message: 'You may not edit this task.' },
          ],
        } as Partial<TaskBulkResponse>)}
        skippedLocallyIds={[]}
        onApply={vi.fn()}
        onReviewFailed={onReviewFailed}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('bulk-edit-review-failed'));
    expect(onReviewFailed).toHaveBeenCalledWith(['b']);
  });

  it('tells Done whether the result was clean, so the selection can clear (S20)', async () => {
    const onDone = vi.fn();
    render(
      <BulkEditSheet
        tasks={[task('a')]}
        resourcePool={[ANA]}
        isPending={false}
        error={null}
        result={bulkResult({
          applied: [{ index: 0, id: 'a', op: 'update', outcome: 'updated' }],
        } as Partial<TaskBulkResponse>)}
        skippedLocallyIds={[]}
        onApply={vi.fn()}
        onReviewFailed={vi.fn()}
        onDone={onDone}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('bulk-edit-done'));
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it('announces the whole breakdown politely, and describes the seat target with it (rule 335)', () => {
    render(
      <BulkEditSheet
        tasks={[task('a')]}
        resourcePool={[ANA]}
        isPending={false}
        error={null}
        result={bulkResult()}
        skippedLocallyIds={[]}
        onApply={vi.fn()}
        onReviewFailed={vi.fn()}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const panel = screen.getByTestId('bulk-edit-result');
    expect(panel).toHaveAttribute('role', 'status');
    expect(panel).toHaveAttribute('aria-live', 'polite');
    // (a) The described node is the WHOLE breakdown, and (c) the seat target is
    // focused by script, which is why the announcement cannot rest on focus alone.
    const done = screen.getByTestId('bulk-edit-done');
    expect(done).toHaveAttribute('aria-describedby', panel.id);
    expect(done).toHaveFocus();
    // …and the panel is its own keyboard scroll seat, since rule 335 deliberately
    // leaves it with no focusable descendant of its own.
    expect(panel).toHaveAttribute('tabindex', '0');
  });
});

describe('BulkEditSheet — refusal presentation (#3332, web-rule 372)', () => {
  it('renders the refusal in a role="alert" SIBLING of the review block, not inside it', () => {
    // Before #3332 the message was a bare `<div>` nested inside the review — no
    // live region anywhere on the sheet, so a refused batch announced nothing.
    renderSheet({
      error: {
        message: 'You do not have permission to edit 3 of these rows.',
        detail: null,
        retryable: false,
      },
    });
    const alert = screen.getByTestId('bulk-edit-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('You do not have permission to edit 3 of these rows.');
    // A sibling: the review block must not contain it, or `aria-atomic` on the
    // description makes AT re-read the whole preview before the refusal.
    expect(screen.getByTestId('bulk-edit-review')).not.toContainElement(alert);
  });

  it('keeps "Apply to N items" — not "Retry" — on a refusal a replay cannot fix', () => {
    renderSheet({
      error: { message: 'Only a Scheduler may set a sprint.', detail: null, retryable: false },
    });
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Apply to 2 items');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('switches Apply to "Retry" when the failure is genuinely replayable', () => {
    renderSheet({
      error: { message: 'Couldn’t apply the changes.', detail: null, retryable: true },
    });
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Retry');
  });

  it('shows "Applying…" while in flight even with a prior refusal on screen', () => {
    renderSheet({
      isPending: true,
      error: { message: 'Nope.', detail: null, retryable: true },
    });
    expect(screen.getByTestId('bulk-edit-apply')).toHaveTextContent('Applying…');
  });

  it('mounts the refusal live region before it has anything to say (rule 335)', () => {
    // Matches the `bulk-owner-refusal` region 400 lines up in this same file: a
    // live region inserted together with its content is announced
    // inconsistently, and for an AT user this announcement IS the refusal.
    renderSheet();
    const region = screen.getByTestId('bulk-edit-error');
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toBeEmptyDOMElement();
  });
});
