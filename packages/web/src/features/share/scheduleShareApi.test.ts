import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { classifyShareError, fetchPublicSchedule, type PublicSchedule } from './scheduleShareApi';

/** Build an object the real `axios.isAxiosError` recognizes (checks `isAxiosError === true`). */
function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPublicSchedule', () => {
  it('GETs the public schedule endpoint for the given token', async () => {
    const schedule: PublicSchedule = {
      content_kind: 'schedule',
      project: { name: 'Atlas', short_id: 'ATL' },
      tasks: [],
      dependencies: [],
      show_assignees: false,
      truncated: false,
    };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: schedule });
    const result = await fetchPublicSchedule('tok123');
    expect(get).toHaveBeenCalledWith('/api/v1/share/schedule/tok123/');
    expect(result).toEqual(schedule);
  });

  it('URL-encodes the token', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    await fetchPublicSchedule('a/b c');
    expect(get).toHaveBeenCalledWith('/api/v1/share/schedule/a%2Fb%20c/');
  });
});

describe('classifyShareError (schedule re-export)', () => {
  it('maps 410 → revoked (covers revoked + expired)', () => {
    expect(classifyShareError(axiosError(410))).toBe('revoked');
  });

  it('maps 429 → rate_limited', () => {
    expect(classifyShareError(axiosError(429))).toBe('rate_limited');
  });

  it('maps 404 → not_found', () => {
    expect(classifyShareError(axiosError(404))).toBe('not_found');
  });
});
