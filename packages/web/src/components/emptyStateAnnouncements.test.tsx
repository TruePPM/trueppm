import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { EmptyState } from './EmptyState';
import { EmptyStateAnnouncer } from './EmptyStateAnnouncer';
import {
  getEmptyStateAnnouncement,
  resetEmptyStateAnnouncerForTest,
  subscribeEmptyStateAnnouncement,
} from './emptyStateAnnouncements';
import { ListIcon } from './Icons';

/**
 * The announcement contract from #3198 / ADR-0989.
 *
 * These specs count **emissions**, not the region's text. Asserting the text is
 * vacuous for every suppression arm: a redundant announcement of an unchanged
 * empty surface leaves exactly the sentence a correct implementation leaves, so
 * `toHaveTextContent('No tasks yet')` passes against the defect this issue was
 * filed for. Verified by mutating the freshness check to announce
 * unconditionally — the text-based version of this suite stayed green.
 */

/** Announcements observed since the last reset — one entry per spoken message. */
const spoken: string[] = [];

/** Settle the 500ms coalescing window. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

describe('EmptyState announcements', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    resetEmptyStateAnnouncerForTest();
    spoken.length = 0;
    unsubscribe = subscribeEmptyStateAnnouncement(() => {
      const text = getEmptyStateAnnouncement().trim();
      // A clear notifies too (the session reset empties the region). Emptying a
      // live region speaks nothing, so it is not an announcement.
      if (text !== '') spoken.push(text);
    });
  });
  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  it('announces the heading when a surface first renders empty', () => {
    render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    expect(spoken).toEqual(['No tasks yet']);
    expect(screen.getByTestId('empty-state-announcer')).toHaveTextContent('No tasks yet');
  });

  it('is silent until the window settles — the region never mounts with its text', () => {
    render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    // The region is in the tree from the first paint, and empty. This is the
    // rule-335 requirement: a region mounted together with its content is
    // announced inconsistently across AT.
    expect(screen.getByTestId('empty-state-announcer')).toBeEmptyDOMElement();
    expect(spoken).toEqual([]);
  });

  it('does not re-announce when an already-empty surface remounts', () => {
    const { rerender } = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState key="a" icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    expect(spoken).toEqual(['No tasks yet']);

    // A route change / project switch: the old instance unmounts and a new one
    // mounts in the same commit. Emptiness did not change, so there is no news.
    rerender(
      <>
        <EmptyStateAnnouncer />
        <EmptyState key="b" icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    expect(spoken).toEqual(['No tasks yet']);
  });

  it('is silent on empty → populated', () => {
    const { rerender } = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    spoken.length = 0;

    rerender(
      <>
        <EmptyStateAnnouncer />
        <p>1 task</p>
      </>,
    );
    settle();
    expect(spoken).toEqual([]);
  });

  it('announces again on populated → empty (the filter case)', () => {
    const { rerender } = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks match these filters" />
      </>,
    );
    settle();

    rerender(
      <>
        <EmptyStateAnnouncer />
        <p>3 tasks</p>
      </>,
    );
    settle();
    spoken.length = 0;

    const region = screen.getByTestId('empty-state-announcer');
    const before = region.textContent;
    rerender(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks match these filters" />
      </>,
    );
    settle();

    expect(spoken).toEqual(['No tasks match these filters']);
    // Same sentence as the earlier announcement, so an unchanged text node
    // would be no DOM mutation and therefore no announcement — the trailing
    // pad is what keeps the repeat audible.
    expect(region.textContent).not.toBe(before);
  });

  it('announces once when N blocks are empty at the same time', () => {
    render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No stories in To do" />
        <EmptyState icon={ListIcon} title="No stories in Doing" />
        <EmptyState icon={ListIcon} title="No stories in Review" />
        <EmptyState icon={ListIcon} title="No stories in Done" />
      </>,
    );
    settle();
    // First one wins — four empty Board columns are one piece of news, not four.
    expect(spoken).toEqual(['No stories in To do']);
  });

  it('does not re-announce when one of several empty blocks remounts', () => {
    const { rerender } = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No stories in To do" />
        <EmptyState icon={ListIcon} title="No stories in Doing" />
      </>,
    );
    settle();
    spoken.length = 0;

    rerender(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No stories in To do" />
        <EmptyState key="remounted" icon={ListIcon} title="No stories in Doing" />
      </>,
    );
    settle();
    expect(spoken).toEqual([]);
  });

  it('announces a different empty surface reached from an empty one', () => {
    const { rerender } = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    spoken.length = 0;

    rerender(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No risks yet" />
      </>,
    );
    settle();
    // Different empty surface, different sentence — genuinely new information.
    expect(spoken).toEqual(['No risks yet']);
  });

  it('remounts empty after the shell unmounts — no stale sentence from the last session', () => {
    // `AppShell` genuinely unmounts: a throw bubbling to the `RequireAuth` net
    // takes it down, and so does logging out. The store is module-level and
    // outlives that, so without a session reset the remounted region would
    // enter the tree already carrying the previous session's sentence — the
    // exact rule-335 defect this component exists to remove, with stale text.
    const shell = render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    expect(spoken).toEqual(['No tasks yet']);
    shell.unmount();
    spoken.length = 0;

    render(<EmptyStateAnnouncer />);
    expect(screen.getByTestId('empty-state-announcer')).toBeEmptyDOMElement();

    // And the new session is not deafened: the same surface announces again,
    // because the previous session's settled set went with it.
    render(
      <>
        <EmptyStateAnnouncer />
        <EmptyState icon={ListIcon} title="No tasks yet" />
      </>,
    );
    settle();
    expect(spoken).toEqual(['No tasks yet']);
  });

  it('leaves EmptyState itself with no role and no live region', () => {
    render(<EmptyState icon={ListIcon} title="No tasks yet" description="Add one." />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live]')).toBeNull();
    // The heading stays a real heading, reachable by heading navigation.
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument();
  });
});
