/**
 * Tests for the pure Epic/Story omni-search helpers (ADR-0508 D4, #2103):
 * grouping by agile type, the agile-vocabulary breadcrumb (never a WBS code),
 * routing (schedule drawer vs. program backlog), and item construction.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OmniSearchResult } from '@/api/types';
import {
  buildOmniSearchItems,
  omniSearchBreadcrumb,
  omniSearchGroup,
  omniSearchRoute,
} from './omniSearch';

function taskResult(over: Partial<OmniSearchResult> = {}): OmniSearchResult {
  return {
    id: 'task-1',
    kind: 'task',
    type: 'story',
    title: 'Login form validation',
    program_id: 'prog-1',
    program_name: 'Q3 Marketing',
    project_id: 'proj-1',
    project_name: 'Website Relaunch',
    parent_epic_id: 'epic-1',
    parent_epic_name: 'Login flow',
    ...over,
  };
}

function backlogResult(over: Partial<OmniSearchResult> = {}): OmniSearchResult {
  return {
    id: 'bi-1',
    kind: 'backlog_item',
    type: 'epic',
    title: 'Billing epic',
    program_id: 'prog-2',
    program_name: 'Platform',
    project_id: null,
    project_name: null,
    parent_epic_id: null,
    parent_epic_name: null,
    ...over,
  };
}

describe('omniSearchGroup', () => {
  it('routes epics to the Epics group and stories to the Stories group', () => {
    expect(omniSearchGroup(taskResult({ type: 'epic' }))).toBe('epic');
    expect(omniSearchGroup(taskResult({ type: 'story' }))).toBe('story');
    expect(omniSearchGroup(backlogResult({ type: 'epic' }))).toBe('epic');
  });
});

describe('omniSearchBreadcrumb', () => {
  it('builds an agile program ▸ project ▸ epic path for a story task', () => {
    expect(omniSearchBreadcrumb(taskResult())).toBe(
      'Q3 Marketing ▸ Website Relaunch ▸ Login flow',
    );
  });

  it('omits the parent epic for an epic (no grandparent)', () => {
    expect(
      omniSearchBreadcrumb(
        taskResult({ type: 'epic', parent_epic_id: null, parent_epic_name: null }),
      ),
    ).toBe('Q3 Marketing ▸ Website Relaunch');
  });

  it('reads {program} ▸ Backlog for a program backlog intake item', () => {
    expect(omniSearchBreadcrumb(backlogResult())).toBe('Platform ▸ Backlog');
  });

  it('never contains a WBS code even when other fields are present', () => {
    const crumb = omniSearchBreadcrumb(taskResult());
    // The PO hard-NO: no dotted WBS path (e.g. "1.2.3") in the breadcrumb.
    expect(crumb).not.toMatch(/\d+\.\d+/);
  });
});

describe('omniSearchRoute', () => {
  it('deep-links a task to the schedule with the drawer opened', () => {
    expect(omniSearchRoute(taskResult())).toBe(
      '/projects/proj-1/schedule?task=task-1',
    );
  });

  it('routes a backlog item to its program backlog', () => {
    expect(omniSearchRoute(backlogResult())).toBe('/programs/prog-2/backlog');
  });

  it('returns null when a task has no project or a backlog item no program', () => {
    expect(omniSearchRoute(taskResult({ project_id: null }))).toBeNull();
    expect(omniSearchRoute(backlogResult({ program_id: null }))).toBeNull();
  });
});

describe('buildOmniSearchItems', () => {
  it('maps results to grouped command items with agile chips and breadcrumbs', () => {
    const go = vi.fn((path: string) => () => path);
    const items = buildOmniSearchItems([taskResult(), backlogResult()], go);

    expect(items).toHaveLength(2);
    const [story, epic] = items;

    expect(story.group).toBe('story');
    expect(story.tag).toBe('Story');
    expect(story.label).toBe('Login form validation');
    expect(story.detail).toBe('Q3 Marketing ▸ Website Relaunch ▸ Login flow');
    expect(story.id).toBe('omni:task:task-1');

    expect(epic.group).toBe('epic');
    expect(epic.tag).toBe('Epic');
    expect(epic.id).toBe('omni:backlog_item:bi-1');

    // The run action is wired through the navigate wrapper with the routed path.
    story.run();
    expect(go).toHaveBeenCalledWith('/projects/proj-1/schedule?task=task-1');
  });

  it('drops results that cannot be routed rather than rendering dead rows', () => {
    const go = vi.fn((path: string) => () => path);
    const items = buildOmniSearchItems([taskResult({ project_id: null })], go);
    expect(items).toEqual([]);
  });

  it('preserves server order (already ranked)', () => {
    const go = vi.fn((path: string) => () => path);
    const items = buildOmniSearchItems(
      [
        taskResult({ id: 'a', title: 'Alpha' }),
        taskResult({ id: 'b', title: 'Beta' }),
      ],
      go,
    );
    expect(items.map((i) => i.label)).toEqual(['Alpha', 'Beta']);
  });
});
