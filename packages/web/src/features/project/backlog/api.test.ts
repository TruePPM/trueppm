/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked(apiClient.post) references the
   mocked method for assertions; it is never invoked unbound. Mirrors useWorkshopSession.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/api/client';
import {
  createBacklogStory,
  createEpic,
  deleteEpic,
  fromApiProductBacklog,
  patchEpic,
  postReorderBacklog,
} from './api';

vi.mock('@/api/client');

// Minimal ApiTask-shaped story; mapTask tolerates the absent fields.
function apiStory(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'T1',
    wbs_path: null,
    name: 'Story',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 1,
    percent_complete: 0,
    is_critical: false,
    status: 'BACKLOG',
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: null,
    ...over,
  };
}

describe('fromApiProductBacklog', () => {
  it('maps epics, stories, health and scoring from the snake_case payload', () => {
    const raw = {
      epics: [
        {
          epic: apiStory({ id: 'EP1', name: 'Telemetry', type: 'epic' }),
          stories: [
            apiStory({
              id: 'S1',
              name: 'Failover',
              type: 'story',
              parent_epic: 'EP1',
              dor: 'ready',
              story_points: 5,
              criteria_met_count: 4,
              criteria_total: 6,
              prioritization_score: 3.5,
              acceptance_criteria: [
                { id: 'c1', text: 'frame order', met: true, position: 0, met_by_name: 'Sam R' },
              ],
            }),
          ],
          rollup: { story_count: 1, points_total: 5, points_done: 0 },
        },
      ],
      ungrouped: [apiStory({ id: 'S2', name: 'Loose', type: 'story', dor: 'idea' })],
      health: {
        dor_pct: 50,
        ready_count: 1,
        ready_points: 5,
        capacity_points: 26,
        wip_limit: null,
        unestimated: 1,
        ac_met: 4,
        ac_total: 6,
        story_count: 2,
      },
      scoring: { model: 'wsjf' as const },
    };

    const result = fromApiProductBacklog(raw as never);

    expect(result.epics).toHaveLength(1);
    expect(result.epics[0].epic.taskType).toBe('epic');
    const story = result.epics[0].stories[0];
    expect(story.dor).toBe('ready');
    expect(story.parentEpic).toBe('EP1');
    expect(story.acMet).toBe(4);
    expect(story.acTotal).toBe(6);
    expect(story.score).toBe(3.5);
    expect(story.acceptanceCriteria?.[0]).toMatchObject({ text: 'frame order', met: true, metByName: 'Sam R' });
    expect(result.epics[0].rollup).toEqual({ storyCount: 1, pointsTotal: 5, pointsDone: 0 });
    expect(result.ungrouped[0].dor).toBe('idea');
    expect(result.health).toEqual({
      dorPct: 50,
      readyCount: 1,
      readyPoints: 5,
      capacityPoints: 26,
      unestimated: 1,
      acMet: 4,
      acTotal: 6,
      storyCount: 2,
    });
    expect(result.scoring).toEqual({ model: 'wsjf' });
  });
});

describe('postReorderBacklog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts the ordered {id, server_version} list and returns the updated count', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 2 } } as never);
    const stories = [
      { id: 'b', server_version: 7 },
      { id: 'a', server_version: 3 },
    ];
    const result = await postReorderBacklog('proj-1', stories);
    expect(apiClient.post).toHaveBeenCalledWith('/projects/proj-1/product-backlog/reorder/', {
      stories,
    });
    expect(result).toEqual({ updated: 2 });
  });

  it('propagates a 409 conflict to the caller', async () => {
    const err = Object.assign(new Error('conflict'), { response: { status: 409 } });
    vi.mocked(apiClient.post).mockRejectedValue(err);
    await expect(postReorderBacklog('proj-1', [{ id: 'a', server_version: 1 }])).rejects.toBe(err);
  });
});

describe('createBacklogStory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a title-only BACKLOG story of type story', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    await createBacklogStory('proj-1', 'New idea');
    expect(apiClient.post).toHaveBeenCalledWith('/tasks/', {
      project: 'proj-1',
      name: 'New idea',
      status: 'BACKLOG',
      type: 'story',
    });
  });
});

describe('epic CRUD (#1339)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createEpic posts a task of type epic', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    await createEpic('proj-1', 'Platform Core');
    expect(apiClient.post).toHaveBeenCalledWith('/tasks/', {
      project: 'proj-1',
      name: 'Platform Core',
      status: 'BACKLOG',
      type: 'epic',
    });
  });

  it('patchEpic sends only the changed scalar fields', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: {} } as never);
    await patchEpic('EP1', { name: 'Platform Core & SSO', notes: 'OIDC + group sync.' });
    expect(apiClient.patch).toHaveBeenCalledWith('/tasks/EP1/', {
      name: 'Platform Core & SSO',
      notes: 'OIDC + group sync.',
    });
  });

  it('patchEpic omits undefined keys so a description-only edit never clobbers the name', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: {} } as never);
    await patchEpic('EP1', { notes: 'Just the description.' });
    expect(apiClient.patch).toHaveBeenCalledWith('/tasks/EP1/', { notes: 'Just the description.' });
  });

  it('deleteEpic deletes the task (children reparent to Ungrouped server-side)', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: {} } as never);
    await deleteEpic('EP1');
    expect(apiClient.delete).toHaveBeenCalledWith('/tasks/EP1/');
  });

  it('createEpic propagates a 403 to the caller', async () => {
    const err = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    vi.mocked(apiClient.post).mockRejectedValue(err);
    await expect(createEpic('proj-1', 'No perms')).rejects.toBe(err);
  });
});
