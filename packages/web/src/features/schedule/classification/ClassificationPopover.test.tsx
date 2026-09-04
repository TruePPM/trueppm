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
});
