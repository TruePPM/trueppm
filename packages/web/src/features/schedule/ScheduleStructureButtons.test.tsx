/**
 * The Group / Ungroup toolbar controls (#2955).
 *
 * Two properties do the work here. The accessible **name** must not change as the
 * selection moves — a button that renames itself on every arrow key is disorienting, so
 * the count that changes lives in the description (web rule 316). And a branch that
 * cannot act must be inert *and say why*, rather than firing a handler with no
 * observable outcome.
 */
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScheduleStructureButtons } from './ScheduleStructureButtons';
import type { GroupTarget, UngroupTarget } from './buildMode/groupOutcome';

const READY_GROUP: GroupTarget = { taskIds: ['a', 'b', 'c', 'd'], blocked: null };
const BLOCKED_GROUP: GroupTarget = { taskIds: [], blocked: 'no-selection' };
const READY_UNGROUP: UngroupTarget = { taskId: 'p1', containerName: 'Design', blocked: null };
const BLOCKED_UNGROUP: UngroupTarget = {
  taskId: null,
  containerName: 'Wireframes',
  blocked: 'not-a-phase',
};

function renderButtons(over: Partial<ComponentProps<typeof ScheduleStructureButtons>> = {}) {
  const props = {
    group: READY_GROUP,
    ungroup: READY_UNGROUP,
    onGroup: vi.fn(),
    onUngroup: vi.fn(),
    pending: false,
    readOnly: false,
    ...over,
  };
  render(<ScheduleStructureButtons {...props} />);
  return props;
}

describe('ScheduleStructureButtons', () => {
  it('names both chords in the accessible name so the keyboard route is discoverable', () => {
    renderButtons();
    expect(
      screen.getByRole('button', { name: 'Group selected rows into a phase (Option+Cmd+G)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ungroup this phase (Option+Shift+Cmd+G)' }),
    ).toBeInTheDocument();
  });

  it('keeps the accessible name STABLE as the selection changes, and moves the count to the description', () => {
    const { unmount } = render(
      <ScheduleStructureButtons
        group={READY_GROUP}
        ungroup={READY_UNGROUP}
        onGroup={vi.fn()}
        onUngroup={vi.fn()}
        pending={false}
        readOnly={false}
      />,
    );
    const four = screen.getByTestId('group-rows-button');
    const nameWithFour = four.getAttribute('aria-label');
    const describedByFour = document.getElementById(four.getAttribute('aria-describedby') ?? '');
    expect(describedByFour?.textContent).toContain('wraps 4 rows');
    unmount();

    render(
      <ScheduleStructureButtons
        group={{ taskIds: ['a'], blocked: null }}
        ungroup={READY_UNGROUP}
        onGroup={vi.fn()}
        onUngroup={vi.fn()}
        pending={false}
        readOnly={false}
      />,
    );
    const one = screen.getByTestId('group-rows-button');
    expect(one.getAttribute('aria-label')).toBe(nameWithFour);
    const describedByOne = document.getElementById(one.getAttribute('aria-describedby') ?? '');
    expect(describedByOne?.textContent).toContain('wraps 1 row');
  });

  it('points aria-describedby at a node that is in the accessibility tree, never display:none', () => {
    // `hidden lg:…` would drop the sentence out of the a11y tree at narrow widths, so a
    // screen-reader user would lose the explanation exactly where it was needed most
    // (web rule 316(c)). `sr-only` keeps it readable at every width.
    renderButtons();
    const hint = document.getElementById(
      screen.getByTestId('group-rows-button').getAttribute('aria-describedby') ?? '',
    );
    expect(hint).not.toBeNull();
    expect(hint?.className).toContain('sr-only');
  });

  it('fires its handler', () => {
    const props = renderButtons();
    fireEvent.click(screen.getByTestId('group-rows-button'));
    fireEvent.click(screen.getByTestId('ungroup-rows-button'));
    expect(props.onGroup).toHaveBeenCalledTimes(1);
    expect(props.onUngroup).toHaveBeenCalledTimes(1);
  });

  it('is inert with nothing to act on, and the title says what is missing', () => {
    const props = renderButtons({ group: BLOCKED_GROUP, ungroup: BLOCKED_UNGROUP });
    const group = screen.getByTestId('group-rows-button');
    const ungroup = screen.getByTestId('ungroup-rows-button');
    expect(group).toBeDisabled();
    expect(ungroup).toBeDisabled();
    expect(group).toHaveAttribute('title', 'Select rows to group');
    expect(ungroup).toHaveAttribute('title', 'Focus a phase to ungroup it');
    fireEvent.click(group);
    fireEvent.click(ungroup);
    expect(props.onGroup).not.toHaveBeenCalled();
    expect(props.onUngroup).not.toHaveBeenCalled();
  });

  it('carries no dangling aria-describedby when there is no truthful sentence', () => {
    renderButtons({ group: BLOCKED_GROUP });
    expect(screen.getByTestId('group-rows-button')).not.toHaveAttribute('aria-describedby');
  });

  it('says Read-only rather than naming a target an editor in Read cannot reach', () => {
    renderButtons({ readOnly: true });
    expect(screen.getByTestId('group-rows-button')).toBeDisabled();
    expect(screen.getByTestId('group-rows-button')).toHaveAttribute('title', 'Read-only access');
  });

  it('blocks a double-fire while a restructure is in flight — on BOTH controls', () => {
    // One `pending` flag feeds both, so testing one leaves the other free to fire a
    // second restructure into a transaction that has not landed.
    const props = renderButtons({ pending: true });
    fireEvent.click(screen.getByTestId('group-rows-button'));
    fireEvent.click(screen.getByTestId('ungroup-rows-button'));
    expect(props.onGroup).not.toHaveBeenCalled();
    expect(props.onUngroup).not.toHaveBeenCalled();
  });
});
