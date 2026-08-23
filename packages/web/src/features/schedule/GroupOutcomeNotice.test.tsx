/**
 * The Group / Ungroup outcome strip (#2955).
 *
 * The two things worth pinning: `left_alone` actually reaches the screen (the issue's
 * explicit requirement, and the part a "the request fired" test cannot see), and the
 * strip is NOT a live region — `recordAct` already announced the same sentence, and a
 * second one here would speak the whole outcome twice.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GroupOutcomeNotice } from './GroupOutcomeNotice';
import { describeGroupOutcome, describeUngroupOutcome } from './buildMode/groupOutcome';
import type { GroupTasksResponse, UngroupTasksResponse } from '@/hooks/useTaskGrouping';

function groupResponse(over: Partial<GroupTasksResponse> = {}): GroupTasksResponse {
  return {
    container: { id: 'c1', name: 'New phase', wbs_path: '2', structure_role: 'container', parent_id: null },
    grouped_ids: ['t1', 't2', 't3', 't4'],
    left_alone: [],
    updated: [],
    warning: null,
    operation_id: 'op-1',
    ...over,
  };
}

describe('GroupOutcomeNotice', () => {
  it('renders nothing with no outcome — a strip with no news must not reserve a row', () => {
    const { container } = render(<GroupOutcomeNotice outcome={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the design’s copy: the consequence, then what is derived, then the undo', () => {
    render(
      <GroupOutcomeNotice outcome={describeGroupOutcome(groupResponse())} onDismiss={vi.fn()} />,
    );
    const strip = screen.getByTestId('group-outcome-notice');
    expect(strip).toHaveTextContent('4 items are now a phase.');
    expect(strip).toHaveTextContent('roll up from the work inside');
    expect(strip).toHaveTextContent('⌘Z undoes the whole group');
  });

  it('surfaces left_alone — the issue’s requirement, and the part a request assertion cannot see', () => {
    render(
      <GroupOutcomeNotice
        outcome={describeGroupOutcome(
          groupResponse({
            grouped_ids: ['t1', 't2'],
            left_alone: [
              { id: 'z1', reason: 'ancestor_selected', ancestor_id: 't1' },
              { id: 'z2', reason: 'different_parent', ancestor_id: null },
            ],
          }),
        )}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('group-left-alone')).toHaveTextContent(
      '2 rows stayed where they were',
    );
    expect(screen.getByTestId('group-left-alone')).toHaveTextContent(
      'already sits inside another row you selected',
    );
  });

  it('omits the left-alone node entirely when the server wrapped everything', () => {
    render(
      <GroupOutcomeNotice outcome={describeGroupOutcome(groupResponse())} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByTestId('group-left-alone')).not.toBeInTheDocument();
  });

  it('renders the has_assignments warning as prose, never as a raw token', () => {
    render(
      <GroupOutcomeNotice
        outcome={describeGroupOutcome(groupResponse({ warning: 'has_assignments' }))}
        onDismiss={vi.fn()}
      />,
    );
    const warning = screen.getByTestId('group-outcome-warning');
    expect(warning).toHaveTextContent('assigned to it directly');
    expect(warning).not.toHaveTextContent('has_assignments');
  });

  it('shows the ungroup outcome, naming what survived', () => {
    const response: UngroupTasksResponse = {
      container_id: 'c1',
      lifted_ids: ['t1', 't2'],
      removed_dependency_ids: ['d1'],
      updated: [],
      warning: null,
      operation_id: 'op-2',
    };
    render(
      <GroupOutcomeNotice
        outcome={describeUngroupOutcome(response, 'Design')}
        onDismiss={vi.fn()}
      />,
    );
    const strip = screen.getByTestId('group-outcome-notice');
    expect(strip).toHaveTextContent('Design is no longer a phase.');
    expect(strip).toHaveTextContent('keeping their links, owners and estimates');
    expect(strip).toHaveTextContent('1 link that pointed at the phase itself went with it');
  });

  it('renders the ungroup warning too — a separate map from the group one, so a separate test', () => {
    render(
      <GroupOutcomeNotice
        outcome={describeUngroupOutcome(
          {
            container_id: 'c1',
            lifted_ids: ['t1'],
            removed_dependency_ids: [],
            updated: [],
            warning: 'has_assignments',
            operation_id: 'op-2',
          },
          'Design',
        )}
        onDismiss={vi.fn()}
      />,
    );
    const warning = screen.getByTestId('group-outcome-warning');
    expect(warning).toHaveTextContent('went with it');
    expect(warning).not.toHaveTextContent('has_assignments');
  });

  it('is NOT a live region — the polite channel already said this (web rule 30)', () => {
    render(
      <GroupOutcomeNotice outcome={describeGroupOutcome(groupResponse())} onDismiss={vi.fn()} />,
    );
    const strip = screen.getByTestId('group-outcome-notice');
    expect(strip).not.toHaveAttribute('role', 'status');
    expect(strip).not.toHaveAttribute('role', 'alert');
    expect(strip).not.toHaveAttribute('aria-live');
  });

  it('dismisses by hand', () => {
    const onDismiss = vi.fn();
    render(
      <GroupOutcomeNotice outcome={describeGroupOutcome(groupResponse())} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
