import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { classifyShareError, fetchPublicBoard, type PublicBoard } from './shareApi';

/** Build an object the real `axios.isAxiosError` recognizes (checks `isAxiosError === true`). */
function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPublicBoard', () => {
  it('GETs the public board endpoint for the given token', async () => {
    const board: PublicBoard = {
      content_kind: 'board',
      project: { name: 'Atlas', short_id: 'ATL' },
      columns: [],
      show_assignees: false,
      truncated: false,
    };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: board });
    const result = await fetchPublicBoard('tok123');
    expect(get).toHaveBeenCalledWith('/api/v1/share/board/tok123/');
    expect(result).toEqual(board);
  });

  it('URL-encodes the token', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    await fetchPublicBoard('a/b c');
    expect(get).toHaveBeenCalledWith('/api/v1/share/board/a%2Fb%20c/');
  });

  it('propagates a transport failure so the caller can classify it', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(axiosError(500));
    await expect(fetchPublicBoard('tok123')).rejects.toBeTruthy();
  });
});

describe('classifyShareError', () => {
  it('maps 410 → revoked', () => {
    expect(classifyShareError(axiosError(410))).toBe('revoked');
  });

  it('maps 404 → not_found', () => {
    expect(classifyShareError(axiosError(404))).toBe('not_found');
  });

  it('maps 429 → rate_limited', () => {
    expect(classifyShareError(axiosError(429))).toBe('rate_limited');
  });

  it('maps any other status → error', () => {
    expect(classifyShareError(axiosError(500))).toBe('error');
  });

  it('maps a non-axios error → error', () => {
    expect(classifyShareError(new Error('boom'))).toBe('error');
  });
});
