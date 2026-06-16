import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWsTicket } from './wsTicket';
import { apiClient } from './client';

describe('fetchWsTicket (ADR-0141, #818)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs /ws/ticket/ and returns the ticket string', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { ticket: 'tkt-xyz', expires_in: 30 } });

    const ticket = await fetchWsTicket();

    expect(post).toHaveBeenCalledWith('/ws/ticket/');
    expect(ticket).toBe('tkt-xyz');
  });

  it('propagates errors so the caller can fall back to a reconnect', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('Session expired'));
    await expect(fetchWsTicket()).rejects.toThrow('Session expired');
  });
});
