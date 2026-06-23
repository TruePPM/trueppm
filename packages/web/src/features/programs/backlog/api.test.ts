/**
 * api.ts — the snake_case ↔ camelCase boundary mapper for the program backlog
 * (#737). The regression-prone parts are the status-enum translation in both
 * directions, the falsy-coercion of optional fields (`description`, `tags`),
 * the `pulled_at` → `updated_at` fallback, and the "only send touched fields"
 * contract of `toPatchPayload`. These are pure functions, so they get direct
 * unit coverage with no React.
 */

import { describe, expect, it } from 'vitest';
import { fromApiItem, toMemberProject, toPatchPayload, type ApiBacklogItem } from './api';
import type { BacklogItem } from './types';

function makeApiItem(overrides: Partial<ApiBacklogItem> = {}): ApiBacklogItem {
  return {
    id: 'bi-1',
    server_version: 7,
    program: 'prog-1',
    title: 'Telemetry intake',
    description: 'Collect device telemetry',
    item_type: 'story',
    status: 'proposed',
    tags: ['alpha', 'beta'],
    priority_rank: 3,
    story_points: 5,
    pulled_task: null,
    pulled_at: null,
    pulled_by: null,
    created_by: 'user-1',
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-02T10:00:00Z',
    ...overrides,
  };
}

describe('fromApiItem', () => {
  it('maps every snake_case field onto its camelCase counterpart', () => {
    const result = fromApiItem(makeApiItem());
    expect(result).toMatchObject({
      id: 'bi-1',
      programId: 'prog-1',
      title: 'Telemetry intake',
      description: 'Collect device telemetry',
      itemType: 'story',
      status: 'PROPOSED',
      tags: ['alpha', 'beta'],
      priorityRank: 3,
      storyPoints: 5,
      serverVersion: 7,
      createdAt: '2026-03-01T09:00:00Z',
      updatedAt: '2026-03-02T10:00:00Z',
    });
  });

  it.each([
    ['proposed', 'PROPOSED'],
    ['pulled', 'PULLED'],
    ['archived', 'ARCHIVED'],
  ] as const)('translates wire status %s → UI status %s', (apiStatus, uiStatus) => {
    expect(fromApiItem(makeApiItem({ status: apiStatus })).status).toBe(uiStatus);
  });

  it('coerces an empty description to undefined rather than an empty string', () => {
    expect(fromApiItem(makeApiItem({ description: '' })).description).toBeUndefined();
  });

  it('defaults a null tags array to an empty array', () => {
    // The serializer always sends an array, but a partial WS/sync payload may not.
    const raw = makeApiItem();
    // @ts-expect-error — exercising the `?? []` guard against a non-conforming payload
    raw.tags = null;
    expect(fromApiItem(raw).tags).toEqual([]);
  });

  it('omits pulledTo when the item has not been pulled', () => {
    expect(fromApiItem(makeApiItem({ pulled_task: null })).pulledTo).toBeUndefined();
  });

  it('builds pulledTo with the pull timestamp when pulled_at is present', () => {
    const result = fromApiItem(
      makeApiItem({
        status: 'pulled',
        pulled_task: 'task-99',
        pulled_at: '2026-03-05T12:00:00Z',
      }),
    );
    expect(result.pulledTo).toEqual({ taskId: 'task-99', at: '2026-03-05T12:00:00Z' });
  });

  it('falls back to updated_at when a pulled item has no pulled_at', () => {
    const result = fromApiItem(
      makeApiItem({
        status: 'pulled',
        pulled_task: 'task-99',
        pulled_at: null,
        updated_at: '2026-03-02T10:00:00Z',
      }),
    );
    expect(result.pulledTo).toEqual({ taskId: 'task-99', at: '2026-03-02T10:00:00Z' });
  });

  it('preserves a null storyPoints (unestimated item)', () => {
    expect(fromApiItem(makeApiItem({ story_points: null })).storyPoints).toBeNull();
  });
});

describe('toPatchPayload', () => {
  it('emits only the fields that are explicitly present on the patch', () => {
    expect(toPatchPayload({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
  });

  it('returns an empty body when the patch is empty (no spurious writes)', () => {
    expect(toPatchPayload({})).toEqual({});
  });

  it('translates the UI status enum back to the wire enum', () => {
    expect(toPatchPayload({ status: 'ARCHIVED' })).toEqual({ status: 'archived' });
  });

  it('maps itemType and priorityRank onto their snake_case keys', () => {
    expect(toPatchPayload({ itemType: 'bug', priorityRank: 12 })).toEqual({
      item_type: 'bug',
      priority_rank: 12,
    });
  });

  it('sends an empty string to blank the description column', () => {
    // The API wants "" to clear the column, not a dropped key.
    expect(toPatchPayload({ description: '' })).toEqual({ description: '' });
  });

  it('coerces a null description to an empty string via the `?? ""` guard', () => {
    const patch: Partial<BacklogItem> = { description: null as unknown as string };
    expect(toPatchPayload(patch)).toEqual({ description: '' });
  });

  it('passes through tags as-is', () => {
    expect(toPatchPayload({ tags: ['x', 'y'] })).toEqual({ tags: ['x', 'y'] });
  });

  it('serializes a multi-field patch in a single body', () => {
    expect(
      toPatchPayload({ title: 'New', status: 'PROPOSED', tags: ['k'], priorityRank: 1 }),
    ).toEqual({ title: 'New', status: 'proposed', tags: ['k'], priority_rank: 1 });
  });
});

describe('toMemberProject', () => {
  it('maps a program project into a pull target with its color dot', () => {
    expect(toMemberProject({ id: 'p-1', name: 'Apollo', colorDot: '#3366ff' })).toEqual({
      id: 'p-1',
      name: 'Apollo',
      color: '#3366ff',
    });
  });

  it('leaves color undefined when the project has no color dot', () => {
    expect(toMemberProject({ id: 'p-2', name: 'Gemini' })).toEqual({
      id: 'p-2',
      name: 'Gemini',
      color: undefined,
    });
  });
});
