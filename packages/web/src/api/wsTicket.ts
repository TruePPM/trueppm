import { apiClient } from '@/api/client';

interface WsTicketResponse {
  ticket: string;
  expires_in: number;
}

/**
 * Mint a single-use WebSocket connection ticket (ADR-0141).
 *
 * Browsers cannot set an `Authorization` header on a WebSocket upgrade, so the
 * credential rides in the URL. A raw JWT there leaks into access logs; instead
 * we POST for a short-lived, single-use ticket and connect with `?ticket=`.
 * Goes through `apiClient`, so the access token is attached and a 401 triggers
 * the normal refresh-and-retry before the ticket is issued.
 *
 * Tickets are single-use, so call this immediately before every connect —
 * including each reconnect attempt.
 */
export async function fetchWsTicket(): Promise<string> {
  const { data } = await apiClient.post<WsTicketResponse>('/ws/ticket/');
  return data.ticket;
}
