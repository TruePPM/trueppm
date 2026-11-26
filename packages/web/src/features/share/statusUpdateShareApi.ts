import axios from 'axios';
import type { StatusUpdateMetric } from '@/api/types';
import type { Rag } from '@/lib/ragBand';

/**
 * Public status-update share API (#4803 server, #4805 render). A BARE axios call, not
 * the shared `apiClient`: the viewer holds no session, so it must never trip the
 * bearer interceptor or the 401 session-expiry flow, and it never calls an
 * authenticated endpoint (the share page's only request is this one).
 */

/** The share projection of one update's frozen snapshot. No ids, no live values. */
export interface PublicStatusUpdate {
  content_kind: string;
  project: { name: string; short_id: string };
  seq: number;
  rag: Rag;
  narrative: string;
  posted_at: string;
  /** The PM's name, only when the link shows people. */
  author: string | null;
  computed_health: string;
  as_of: string;
  forecast: {
    p50?: StatusUpdateMetric<string | null>;
    p80?: StatusUpdateMetric<string | null>;
    cpm_finish?: StatusUpdateMetric<string | null>;
    baseline_finish?: string | null;
    baseline_finish_variance_days?: StatusUpdateMetric<number | null>;
  };
  counts: {
    completed_since_previous?: StatusUpdateMetric<number | null>;
    slipped_since_previous?: StatusUpdateMetric<number | null>;
  };
  /** Null when the link does not reveal the section. */
  milestones:
    | {
        name: string;
        cpm_finish: string | null;
        baseline_finish: string | null;
        variance_days: number | null;
      }[]
    | null;
  risks:
    | {
        title: string;
        probability: number;
        impact: number;
        severity: number;
        owner: string | null;
      }[]
    | null;
  decisions: { title: string; due_date: string | null; owner: string | null }[] | null;
  show_assignees: boolean;
  show_milestone_dates: boolean;
  show_risks: boolean;
  show_decisions: boolean;
}

/**
 * The server answers every unavailable outcome (unknown, revoked, expired, Trashed,
 * policy off) with one identical 404, so the page has one "not available" state for
 * all of them and cannot tell a revoked link from a guessed one either.
 */
export type StatusUpdateShareErrorKind = 'unavailable' | 'rate_limited' | 'error';

export async function fetchPublicStatusUpdate(token: string): Promise<PublicStatusUpdate> {
  const res = await axios.get<PublicStatusUpdate>(
    `/api/v1/share/status-update/${encodeURIComponent(token)}/`,
  );
  return res.data;
}

export function classifyStatusUpdateShareError(err: unknown): StatusUpdateShareErrorKind {
  if (axios.isAxiosError(err)) {
    const code = err.response?.status;
    if (code === 404 || code === 410) return 'unavailable';
    if (code === 429) return 'rate_limited';
  }
  return 'error';
}

/** Narrative paragraphs: split on blank lines (or single breaks), empties dropped. */
export function narrativeParagraphs(narrative: string): string[] {
  return narrative
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
