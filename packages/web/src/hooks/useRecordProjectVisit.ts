import { useEffect, useRef } from 'react';
import { apiClient } from '@/api/client';

/**
 * Records a "last visited" ping for the active project (ADR-0150, issue 1182).
 *
 * Fire-and-forget: posts `POST /projects/{id}/visit/` once each time the user
 * navigates to a new project, feeding the real last-visited landing default
 * (server-side `most_recent_project`). It deliberately does NOT invalidate any
 * query — a visit ping must never trigger a refetch — and silently swallows
 * errors: a dropped navigation ping is inconsequential (the next navigation
 * retries, and the server resolver falls back to the membership proxy).
 *
 * The write is coalesced twice over: this effect fires only when `projectId`
 * changes (a `useRef` guards React 18 StrictMode's double-mount), and the
 * server coalesces repeat pings to at most once per minute per (user, project).
 */
export function useRecordProjectVisit(projectId: string | null | undefined): void {
  const lastPingedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || lastPingedRef.current === projectId) {
      return;
    }
    lastPingedRef.current = projectId;
    void apiClient.post(`/projects/${projectId}/visit/`, {}).catch(() => {
      // Best-effort telemetry — never surface a failed visit ping to the user.
    });
  }, [projectId]);
}
