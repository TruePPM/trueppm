import axios from 'axios';

/**
 * Public board share API (#283, ADR-0245). Uses a BARE axios call — NOT the shared
 * `apiClient` — because the public viewer has no auth token and must not trip
 * apiClient's request-interceptor (bearer injection) or its 401 session-expiry
 * flow. Mirrors the password-reset public-page precedent (`resetApi.ts`).
 */

export interface PublicBoardCard {
  short_id: string;
  name: string;
  status: string;
  is_milestone: boolean;
  percent_complete: number;
  due_date: string | null;
  assignee: string | null;
}

export interface PublicBoardColumn {
  key: string;
  label: string;
  cards: PublicBoardCard[];
}

export interface PublicBoard {
  content_kind: string;
  project: { name: string; short_id: string };
  columns: PublicBoardColumn[];
  show_assignees: boolean;
  truncated: boolean;
}

/** 'revoked' → 410, 'not_found' → 404 (invalid/unknown/disabled), 'error' → other. */
export type PublicBoardErrorKind = 'revoked' | 'not_found' | 'error';

export async function fetchPublicBoard(token: string): Promise<PublicBoard> {
  const res = await axios.get<PublicBoard>(`/api/v1/share/board/${encodeURIComponent(token)}/`);
  return res.data;
}

export function classifyShareError(err: unknown): PublicBoardErrorKind {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 410) return 'revoked';
    if (err.response?.status === 404) return 'not_found';
  }
  return 'error';
}
