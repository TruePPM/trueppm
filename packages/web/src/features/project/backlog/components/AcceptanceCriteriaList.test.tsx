/**
 * Tests for the acceptance-criteria checklist (#731 / #1043).
 *
 * The component keeps a local optimistic mirror of the server criteria, so the
 * behavior worth pinning is: sorted rendering, the re-seed when the server
 * payload (or the story) changes, each edit path's optimistic commit, and the
 * rollback every failed mutation performs through its `onError` callback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import type { AcceptanceCriterion } from '@/types';
import { AcceptanceCriteriaList } from './AcceptanceCriteriaList';

interface MutateOptions {
  onError?: () => void;
}
interface CreateVars {
  taskId: string;
  text: string;
  position: number;
}
interface UpdateVars {
  criterionId: string;
  patch: { text?: string; met?: boolean; position?: number };
}
interface DeleteVars {
  criterionId: string;
}

const createMutate = vi.fn<(vars: CreateVars, opts?: MutateOptions) => void>();
const updateMutate = vi.fn<(vars: UpdateVars, opts?: MutateOptions) => void>();
const removeMutate = vi.fn<(vars: DeleteVars, opts?: MutateOptions) => void>();

vi.mock('../hooks/useStoryDetail', () => ({
  useCreateCriterion: () => ({ mutate: createMutate }),
  useUpdateCriterion: () => ({ mutate: updateMutate }),
  useDeleteCriterion: () => ({ mutate: removeMutate }),
}));

function ac(overrides: Partial<AcceptanceCriterion> & { id: string }): AcceptanceCriterion {
  return { text: `Criterion ${overrides.id}`, met: false, position: 0, ...overrides };
}

/** Two criteria supplied out of position order, one met and one not. */
const MIXED: AcceptanceCriterion[] = [
  ac({ id: 'ac-2', text: 'Session persists', met: true, position: 1 }),
  ac({ id: 'ac-1', text: 'Signs in with Google', met: false, position: 0 }),
];

function renderList(criteria: AcceptanceCriterion[], taskId = 'task-1') {
  return renderWithProviders(
    <AcceptanceCriteriaList projectId="p1" taskId={taskId} criteria={criteria} />,
  );
}

function rows() {
  return within(screen.getByRole('list')).getAllByRole('listitem');
}

function criterionInput(text: string) {
  return screen.getByLabelText<HTMLInputElement>(`Acceptance criterion: ${text}`);
}

beforeEach(() => {
  createMutate.mockReset();
  updateMutate.mockReset();
  removeMutate.mockReset();
});

describe('AcceptanceCriteriaList — rendering', () => {
  it('renders criteria in position order regardless of payload order', () => {
    renderList(MIXED);

    const inputs = rows().map((li) =>
      within(li).getByRole<HTMLInputElement>('textbox', { name: /Acceptance criterion/ }),
    );
    expect(inputs.map((i) => i.value)).toEqual(['Signs in with Google', 'Session persists']);
  });

  it('shows the met/total meter for a partially met list', () => {
    renderList(MIXED);
    expect(screen.getByTitle('1/2 acceptance criteria met')).toBeInTheDocument();
  });

  it('shows the empty state and a 0/0 meter when there are no criteria', () => {
    renderList([]);

    expect(screen.getByText(/No acceptance criteria yet/)).toBeInTheDocument();
    expect(screen.getByTitle('0/0 acceptance criteria met')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('hides the empty state once at least one criterion exists', () => {
    renderList(MIXED);
    expect(screen.queryByText(/No acceptance criteria yet/)).not.toBeInTheDocument();
  });

  it('strikes through met criteria only', () => {
    renderList(MIXED);

    expect(criterionInput('Session persists').className).toContain('line-through');
    expect(criterionInput('Signs in with Google').className).not.toContain('line-through');
  });

  it('checks the box for met criteria and leaves unmet ones unchecked', () => {
    renderList(MIXED);

    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mark "Session persists" met' }),
    ).toBeChecked();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mark "Signs in with Google" met' }),
    ).not.toBeChecked();
  });
});

describe('AcceptanceCriteriaList — re-seeding from the server', () => {
  it('adopts a changed server payload', () => {
    const { rerender } = renderList(MIXED);

    rerender(
      <AcceptanceCriteriaList
        projectId="p1"
        taskId="task-1"
        criteria={[
          ac({ id: 'ac-1', text: 'Signs in with Google', met: true, position: 0 }),
          ac({ id: 'ac-2', text: 'Session persists', met: true, position: 1 }),
          ac({ id: 'ac-3', text: 'Logs the sign-in', met: false, position: 2 }),
        ]}
      />,
    );

    expect(rows()).toHaveLength(3);
    expect(screen.getByTitle('2/3 acceptance criteria met')).toBeInTheDocument();
  });

  it('re-seeds when the story changes even though the criteria signature is unchanged', async () => {
    const user = userEvent.setup();
    const { rerender } = renderList(MIXED, 'task-1');

    await user.click(screen.getByRole('checkbox', { name: 'Mark "Signs in with Google" met' }));
    expect(screen.getByTitle('2/2 acceptance criteria met')).toBeInTheDocument();

    rerender(<AcceptanceCriteriaList projectId="p1" taskId="task-2" criteria={MIXED} />);

    expect(screen.getByTitle('1/2 acceptance criteria met')).toBeInTheDocument();
  });
});

describe('AcceptanceCriteriaList — toggling met', () => {
  it('optimistically ticks a criterion and persists met: true', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    await user.click(screen.getByRole('checkbox', { name: 'Mark "Signs in with Google" met' }));

    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mark "Signs in with Google" met' }),
    ).toBeChecked();
    expect(screen.getByTitle('2/2 acceptance criteria met')).toBeInTheDocument();
    expect(updateMutate.mock.calls[0][0]).toEqual({
      criterionId: 'ac-1',
      patch: { met: true },
    });
  });

  it('un-ticks an already met criterion and persists met: false', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    await user.click(screen.getByRole('checkbox', { name: 'Mark "Session persists" met' }));

    expect(screen.getByTitle('0/2 acceptance criteria met')).toBeInTheDocument();
    expect(updateMutate.mock.calls[0][0]).toEqual({
      criterionId: 'ac-2',
      patch: { met: false },
    });
  });

  it('rolls the tick back when the server rejects it', async () => {
    const user = userEvent.setup();
    updateMutate.mockImplementation((_vars, opts) => opts?.onError?.());
    renderList(MIXED);

    await user.click(screen.getByRole('checkbox', { name: 'Mark "Signs in with Google" met' }));

    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mark "Signs in with Google" met' }),
    ).not.toBeChecked();
    expect(screen.getByTitle('1/2 acceptance criteria met')).toBeInTheDocument();
  });

  it('restores the met state when un-ticking fails', async () => {
    const user = userEvent.setup();
    updateMutate.mockImplementation((_vars, opts) => opts?.onError?.());
    renderList(MIXED);

    await user.click(screen.getByRole('checkbox', { name: 'Mark "Session persists" met' }));

    expect(screen.getByTitle('1/2 acceptance criteria met')).toBeInTheDocument();
  });
});

describe('AcceptanceCriteriaList — editing text', () => {
  it('persists a changed criterion on blur', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.clear(input);
    await user.type(input, '  Signs in with Okta  ');
    await user.tab();

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({
      criterionId: 'ac-1',
      patch: { text: 'Signs in with Okta' },
    });
    expect(criterionInput('Signs in with Okta')).toBeInTheDocument();
  });

  it('does not persist an unchanged criterion', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    await user.click(criterionInput('Signs in with Google'));
    await user.tab();

    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not persist whitespace that trims back to the saved text', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.type(input, '   ');
    await user.tab();

    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('refuses to persist an emptied criterion', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.clear(input);
    await user.tab();

    expect(updateMutate).not.toHaveBeenCalled();
    // The saved text is still the one the row is labelled with.
    expect(criterionInput('Signs in with Google')).toBeInTheDocument();
  });

  it('commits on Enter without needing an explicit blur', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.clear(input);
    await user.type(input, 'Signs in with Okta{Enter}');

    expect(updateMutate.mock.calls[0][0]).toEqual({
      criterionId: 'ac-1',
      patch: { text: 'Signs in with Okta' },
    });
    expect(input).not.toHaveFocus();
  });

  it('reverts to the saved text on Escape and persists nothing', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.type(input, ' via SAML');
    await user.keyboard('{Escape}');

    expect(input.value).toBe('Signs in with Google');
    expect(input).not.toHaveFocus();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys while typing', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const input = criterionInput('Signs in with Google');
    await user.type(input, 'x');

    expect(input).toHaveFocus();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe('AcceptanceCriteriaList — removing', () => {
  it('optimistically drops the row and persists the delete', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    await user.click(screen.getByRole('button', { name: 'Remove "Signs in with Google"' }));

    expect(rows()).toHaveLength(1);
    expect(screen.getByTitle('1/1 acceptance criteria met')).toBeInTheDocument();
    expect(removeMutate.mock.calls[0][0]).toEqual({ criterionId: 'ac-1' });
  });

  it('shows the empty state after the last criterion is removed', async () => {
    const user = userEvent.setup();
    renderList([ac({ id: 'ac-1', text: 'Only one', position: 0 })]);

    await user.click(screen.getByRole('button', { name: 'Remove "Only one"' }));

    expect(screen.getByText(/No acceptance criteria yet/)).toBeInTheDocument();
  });

  it('restores the row in position order when the delete fails', async () => {
    const user = userEvent.setup();
    removeMutate.mockImplementation((_vars, opts) => opts?.onError?.());
    renderList(MIXED);

    await user.click(screen.getByRole('button', { name: 'Remove "Signs in with Google"' }));

    const inputs = rows().map((li) =>
      within(li).getByRole<HTMLInputElement>('textbox', { name: /Acceptance criterion/ }),
    );
    expect(inputs.map((i) => i.value)).toEqual(['Signs in with Google', 'Session persists']);
  });
});

describe('AcceptanceCriteriaList — adding', () => {
  it('hides the hint until the draft has non-whitespace content', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    expect(screen.queryByText('↵ to add')).not.toBeInTheDocument();

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, '   ');
    expect(screen.queryByText('↵ to add')).not.toBeInTheDocument();

    await user.type(add, 'Audit log written');
    expect(screen.getByText('↵ to add')).toBeInTheDocument();
  });

  it('appends after the highest existing position and clears the draft', async () => {
    const user = userEvent.setup();
    renderList([
      ac({ id: 'ac-1', text: 'First', position: 0 }),
      ac({ id: 'ac-2', text: 'Second', position: 4 }),
    ]);

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, '  Audit log written  {Enter}');

    expect(createMutate.mock.calls[0][0]).toEqual({
      taskId: 'task-1',
      text: 'Audit log written',
      position: 5,
    });
    expect(add.value).toBe('');
  });

  it('uses position 0 for the first criterion on an empty list', async () => {
    const user = userEvent.setup();
    renderList([]);

    await user.type(
      screen.getByLabelText('Add an acceptance criterion'),
      'The very first one{Enter}',
    );

    expect(createMutate.mock.calls[0][0]).toEqual({
      taskId: 'task-1',
      text: 'The very first one',
      position: 0,
    });
  });

  it('does nothing when Enter is pressed on a blank draft', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, '   {Enter}');

    expect(createMutate).not.toHaveBeenCalled();
    expect(add.value).toBe('   ');
  });

  it('restores the draft so the typing is not lost when the create fails', async () => {
    const user = userEvent.setup();
    createMutate.mockImplementation((_vars, opts) => opts?.onError?.());
    renderList(MIXED);

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, 'Audit log written{Enter}');

    expect(add.value).toBe('Audit log written');
  });

  it('discards the draft on Escape without creating anything', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, 'Never mind');
    await user.keyboard('{Escape}');

    expect(add.value).toBe('');
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('leaves an unrelated keystroke to the normal change handler', async () => {
    const user = userEvent.setup();
    renderList(MIXED);

    const add = screen.getByLabelText<HTMLInputElement>('Add an acceptance criterion');
    await user.type(add, 'a');

    expect(add.value).toBe('a');
    expect(createMutate).not.toHaveBeenCalled();
  });
});
