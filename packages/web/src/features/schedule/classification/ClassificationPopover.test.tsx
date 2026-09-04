import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type { DeliveryMode, GovernanceClass, Task } from '@/types';
import { ClassificationPopover } from './ClassificationPopover';

function task(
  id: string,
  parentId: string | null,
  opts: {
    isMilestone?: boolean;
    deliveryMode?: DeliveryMode;
    governanceClass?: GovernanceClass;
    parentGovernanceInherited?: boolean;
  } = {},
): Task {
  return {
    id,
    wbs: id,
    name: `Task ${id}`,
    parentId,
    isSummary: false,
    isMilestone: opts.isMilestone ?? false,
    deliveryMode: opts.deliveryMode,
    governanceClass: opts.governanceClass,
    parentGovernanceInherited: opts.parentGovernanceInherited,
    duration: 1,
    progress: 0,
    assignees: [],
    status: 'NOT_STARTED',
  } as unknown as Task;
}

const TREE = [
  task('p', null),
  task('c1', 'p'),
  task('c2', 'p'),
  task('m', 'p', { isMilestone: true, deliveryMode: 'milestone' }),
];

function setup(overrides: Partial<ComponentProps<typeof ClassificationPopover>> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <ClassificationPopover
      anchor={{ x: 10, y: 10 }}
      target={TREE[0]}
      tasks={TREE}
      isPending={false}
      // Default to the caller who CAN undo, so the #3357 note is absent from every
      // pre-existing assertion unless a test opts into it.
      canUndoBatchOperations
      error={null}
      onApply={onApply}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onApply, onClose };
}

describe('ClassificationPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the subtree it will act on', () => {
    setup();
    const dialog = screen.getByTestId('classification-popover');
    expect(within(dialog).getByText(/Task p/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3 descendants/)).toBeInTheDocument();
  });

  it('refuses to apply until an axis is named', async () => {
    const { onApply } = setup();
    // The API 400s a request naming neither axis; the button is the client's
    // half of that contract rather than a redundant guard.
    expect(screen.getByTestId('classification-apply')).toBeDisabled();
    await userEvent.click(screen.getByTestId('classification-apply'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('writes both axes from a preset', async () => {
    const { onApply } = setup();
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    await userEvent.click(screen.getByTestId('classification-apply'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        subtree: 'p',
        governance_class: 'flow',
        delivery_mode: 'scrum',
      }),
    );
  });

  it('lets a blended team set one axis without the other', async () => {
    // "flow + kanban without learning Scrum vocabulary" is the reason the two
    // axis rows stay visible under the presets.
    const { onApply } = setup();
    await userEvent.click(screen.getByRole('radio', { name: 'kanban' }));
    await userEvent.click(screen.getByTestId('classification-apply'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ governance_class: null, delivery_mode: 'kanban' }),
    );
  });

  it('disables the milestone delivery mode — a cascade cannot create gates', () => {
    setup();
    expect(screen.getByRole('radio', { name: 'milestone' })).toBeDisabled();
  });

  it('previews what changes, and names the milestone it will not touch', async () => {
    setup();
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    const preview = screen.getByTestId('classification-preview');
    // p, c1, c2 change; the milestone is skipped on both axes.
    expect(preview).toHaveTextContent('3 tasks change');
    expect(preview).toHaveTextContent('1 milestone unchanged');
    expect(preview).toHaveTextContent('a gate is not a delivery mode');
  });

  it('states that delivery mode has no inherit bit, and counts overrides only for governance', async () => {
    setup();
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    const preview = screen.getByTestId('classification-preview');
    expect(preview).toHaveTextContent('governance overrides kept');
    expect(preview).toHaveTextContent('has no inherit bit');
  });

  it('re-previews when the scope narrows to the root alone', async () => {
    setup();
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    expect(screen.getByTestId('classification-preview')).toHaveTextContent('3 tasks change');
    await userEvent.click(screen.getByTestId('classification-cascade'));
    expect(screen.getByTestId('classification-preview')).toHaveTextContent('1 task change');
    expect(screen.getByTestId('classification-apply')).toHaveTextContent('Apply to task');
  });

  it('counts a preserved governance override rather than silently changing it', async () => {
    const tree = [
      task('p', null),
      task('c1', 'p', { governanceClass: 'gated', parentGovernanceInherited: false }),
      task('c2', 'p'),
    ];
    setup({ target: tree[0], tasks: tree });
    await userEvent.click(screen.getByRole('radio', { name: 'flow' }));
    expect(screen.getByTestId('classification-preview')).toHaveTextContent(
      '1 governance overrides kept',
    );
  });

  it('sends preserve_governance_overrides=true by default', async () => {
    const { onApply } = setup();
    await userEvent.click(screen.getByTestId('classification-preset-gated'));
    await userEvent.click(screen.getByTestId('classification-apply'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ preserve_governance_overrides: true, skip_milestones: true }),
    );
  });

  it('submits on Enter from inside, so the keyboard path needs no Tab to Apply', async () => {
    const { onApply } = setup();
    await userEvent.click(screen.getByRole('radio', { name: 'scrum' }));
    await userEvent.keyboard('{Enter}');
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('ignores an Enter that originated outside the popover', async () => {
    // The window-level listener is global; without the containment guard an
    // Enter in an unrelated surface (an inline rename still committing, say)
    // would fire the cascade.
    const { onApply } = setup();
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onApply).not.toHaveBeenCalled();
    outside.remove();
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the failure inline and offers a retry rather than closing', () => {
    setup({
      error: { message: "Couldn't apply the classification.", detail: null, retryable: true },
    });
    expect(screen.getByTestId('classification-error')).toHaveTextContent("Couldn't apply");
    expect(screen.getByTestId('classification-apply')).toHaveTextContent('Retry');
  });

  it('keeps the refusal out of the preview status region', () => {
    // `role="status"` is implicitly atomic, so an error nested inside it makes AT
    // re-read the whole preview before the sentence that matters (#3302).
    setup({ error: { message: 'Nope.', detail: null, retryable: false } });
    const slot = screen.getByTestId('classification-error');
    expect(slot).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('classification-preview')).not.toContainElement(slot);
  });

  it('drops a refusal as soon as the spec it described changes', async () => {
    // The cap refusal's own copy tells the planner to turn off the cascade, so
    // leaving the message up would instruct them to do what they just did.
    setup({
      error: {
        message: 'Subtree resolves 2500 tasks, above the 2000-task cap.',
        detail: 'Classify a smaller branch, or turn off \u201cCascade to descendants\u201d.',
        retryable: false,
      },
    });
    expect(screen.getByTestId('classification-error')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('classification-cascade'));
    expect(screen.queryByTestId('classification-error')).not.toBeInTheDocument();
  });

  it('keeps the Apply label on a refusal a retry cannot clear (#3302)', () => {
    // The 403 is the case that made this matter: the popover used to relabel to
    // "Retry", which is the one action guaranteed to be refused identically.
    setup({
      error: {
        message: 'Your role cannot author 3 of the 12 tasks in this subtree.',
        detail: null,
        retryable: false,
      },
    });
    expect(screen.getByTestId('classification-error')).toHaveTextContent(
      'Your role cannot author 3 of the 12 tasks in this subtree.',
    );
    expect(screen.getByTestId('classification-apply')).toHaveTextContent('Apply to subtree');
    expect(screen.getByTestId('classification-apply')).not.toHaveTextContent('Retry');
  });

  it('renders the structured second line under the message', () => {
    setup({
      error: {
        message: 'Subtree resolves 2500 tasks, above the 2000-task cap.',
        detail: '2500 tasks matched — the cap is 2000.',
        retryable: false,
      },
    });
    const slot = screen.getByTestId('classification-error');
    expect(slot).toHaveTextContent('Subtree resolves 2500 tasks');
    expect(slot).toHaveTextContent('the cap is 2000');
  });

  it('blocks a second submit while the first is in flight', async () => {
    const { onApply } = setup({ isPending: true });
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    expect(screen.getByTestId('classification-apply')).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The reversal floor, disclosed before the act (#3357, web rule 373(d))
  //
  // #3304 stopped OFFERING an Undo to a caller who cannot use one, which left
  // them told nothing at all. These pin the other half: the disclosure is on the
  // standing surface that commits the act, keyed on the server's own verdict.
  // -------------------------------------------------------------------------

  it('says the cascade is not reversible by this caller, before they apply it', () => {
    setup({ canUndoBatchOperations: false });
    const note = screen.getByTestId('classification-undo-floor');
    expect(note).toHaveTextContent('You won’t be able to reverse this');
    // The recovery route is required by rule 373(d), not decoration — a reader
    // told only that they cannot undo has no idea anyone can. Phrased as "rights"
    // rather than naming ROLE_ADMIN's label: Owner clears the same floor and shows
    // as "Project Admin", an Enterprise 301-399 custom role clears it under an
    // arbitrary label, and #3355 may move the floor out from under any of them.
    expect(note).toHaveTextContent('someone with Project Manager rights can');
    // …and so is the second sentence: the cascade deletes nothing and this surface
    // stays reachable, so the first alone overstates the harm into a dead end it is
    // not. Scope-independent wording, because "each row's previous mix" is false-
    // sounding the moment the user unchecks Cascade and the header says "X only".
    expect(note).toHaveTextContent('won’t restore what each row had before');
  });

  it('says nothing to a caller who can undo', () => {
    setup({ canUndoBatchOperations: true });
    expect(screen.queryByTestId('classification-undo-floor')).not.toBeInTheDocument();
  });

  it('says nothing while the project detail is still unresolved', () => {
    // `undefined` is "not answered yet", not "no". Defaulting it to the note
    // would tell a Project Manager they lack a right they hold, on every open
    // before the project query lands — see `shouldDiscloseUndoFloor`.
    setup({ canUndoBatchOperations: undefined });
    expect(screen.queryByTestId('classification-undo-floor')).not.toBeInTheDocument();
  });

  it('keeps the note out of the live preview region', () => {
    // Same trap the error slot documents: `role="status"` is implicitly atomic,
    // so a standing sentence nested inside it would be re-announced on every
    // keystroke that changes the preview.
    setup({ canUndoBatchOperations: false });
    const note = screen.getByTestId('classification-undo-floor');
    expect(screen.getByTestId('classification-preview')).not.toContainElement(note);
    expect(note).not.toHaveAttribute('role');
    expect(note).not.toHaveAttribute('aria-live');
  });

  it('binds the note to the DIALOG, not only to Apply', () => {
    // The binding that actually delivers it (rule 380). Enter submits from anywhere
    // in this popover and `useFocusTrap` seats focus on the first preset chip, so
    // the fastest keyboard path never focuses Apply — a build bound only at the
    // button passes an Apply-only assertion while announcing nothing on that path.
    setup({ canUndoBatchOperations: false });
    const note = screen.getByTestId('classification-undo-floor');
    expect(note.id).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Classification' })).toHaveAttribute(
      'aria-describedby',
      note.id,
    );
    // …and the redundant half.
    expect(screen.getByTestId('classification-apply')).toHaveAttribute(
      'aria-describedby',
      note.id,
    );
  });

  it('leaves both undescribed when the note is absent', () => {
    // A dangling `aria-describedby` pointing at a removed node is announced as
    // nothing at all on some readers and as a stale string on others.
    setup({ canUndoBatchOperations: true });
    expect(screen.getByRole('dialog', { name: 'Classification' })).not.toHaveAttribute(
      'aria-describedby',
    );
    expect(screen.getByTestId('classification-apply')).not.toHaveAttribute('aria-describedby');
  });

  it('does not change the Apply affordance itself', async () => {
    // Rule 373(c)/302: the act is still on offer — only its reversal is not. A
    // caller who cannot undo may still cascade, so nothing here is disabled or
    // relabelled, and the note must not have leaked into the button. The preset
    // click is what makes the assertion non-vacuous: Apply is disabled until an
    // axis is named regardless of role, so asserting on the initial render would
    // pass on a build that disabled it for this caller too.
    const { onApply } = setup({ canUndoBatchOperations: false });
    await userEvent.click(screen.getByTestId('classification-preset-scrum'));
    const apply = screen.getByTestId('classification-apply');
    expect(apply).toHaveTextContent('Apply to subtree');
    expect(apply).not.toBeDisabled();
    expect(apply).not.toHaveTextContent('Project Manager');
    await userEvent.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
