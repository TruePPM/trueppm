/**
 * Per-project notification routing matrix + quiet-hours window — Project
 * Settings → Notifications page (#522).
 *
 * Stores one document per (project, current user). PATCH semantics are
 * partial: a single-cell toggle posts only the changed event/channel.
 * Optimistic updates flip the UI immediately and roll back on API error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { QuietHoursTimezoneSource } from '@/api/types';

export type ProjectNotificationEventType =
  | 'task_assigned'
  | 'task_overdue'
  | 'comment_mention'
  | 'status_change'
  | 'budget_alert'
  | 'risk_created'
  | 'milestone_reached'
  | 'sprint_start'
  | 'sprint_end';

export type ProjectNotificationChannel =
  | 'in_app'
  | 'email'
  | 'slack'
  | 'mobile_push';

export const PROJECT_NOTIFICATION_EVENTS: { type: ProjectNotificationEventType; label: string }[] = [
  { type: 'task_assigned', label: 'Task assigned to me' },
  { type: 'task_overdue', label: 'Task I own is overdue' },
  { type: 'comment_mention', label: 'Mention (@) in a comment' },
  { type: 'status_change', label: 'Task moves to another column' },
  { type: 'budget_alert', label: 'Budget threshold crossed' },
  { type: 'risk_created', label: 'Risk created or escalated' },
  { type: 'milestone_reached', label: 'Milestone reached' },
  { type: 'sprint_start', label: 'Sprint started' },
  { type: 'sprint_end', label: 'Sprint closed' },
];

export const PROJECT_NOTIFICATION_CHANNELS: { channel: ProjectNotificationChannel; label: string }[] = [
  { channel: 'email', label: 'Email' },
  { channel: 'in_app', label: 'In-app' },
  { channel: 'slack', label: 'Slack' },
  { channel: 'mobile_push', label: 'Mobile push' },
];

/**
 * Fallback-only list of channels TruePPM has no delivery path for (#3249).
 *
 * The server now owns this classification and reports it as `channel_delivery`
 * (#3378), for the same reason it owns `eventDelivery`: whether a channel
 * delivers is server state that moves when an ADR-0049 NOTIFICATION_CHANNELS
 * registration lands, so a client-side copy drifts the moment one does. Read
 * {@link ProjectNotificationPreferences.channelDelivery} instead.
 *
 * This constant survives ONLY as the answer for a server that predates
 * `channel_delivery` — dropping it there would silently un-mark two columns that
 * are still dead on that server, which is the #3249 defect returning. Delete it
 * once the oldest supported server sends the key.
 */
export const PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS: ProjectNotificationChannel[] = [
  'slack',
  'mobile_push',
];

/**
 * Should the UI mark `channel` as having no delivery path?
 *
 * The server's answer wins wherever it gave one, so a channel it reports as
 * delivering un-marks itself with no web release — the drift this map exists to
 * end. Where it said nothing about *that channel*, the hardcoded list answers.
 *
 * Per key, not per map, and the asymmetry with `eventDelivery`'s "no claim made"
 * contract is deliberate: there, silence costs a missing badge; here it restores
 * the #3249 defect outright — a dead control rendered as a working one. A
 * well-formed response cannot reach the fallback (the schema marks all four
 * channels `required`), so the only callers are an older server and a partial
 * body, and both are exactly when the safe default matters.
 */
export function isChannelUndeliverable(
  channelDelivery: ProjectNotificationPreferences['channelDelivery'],
  channel: ProjectNotificationChannel,
): boolean {
  if (channel in channelDelivery) {
    return channelDelivery[channel] === false;
  }
  return PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS.includes(channel);
}

export type ProjectNotificationMatrix = Record<
  ProjectNotificationEventType,
  Record<ProjectNotificationChannel, boolean>
>;

export interface ProjectNotificationPreferences {
  matrix: ProjectNotificationMatrix;
  /**
   * Per event: is a dispatcher actually wired server-side (#2904). Eight of the
   * nine rows are not — they were rendered, defaulted ON across in-app, email and
   * Slack, and toggling one had no effect in either direction. Read this rather
   * than hard-coding the list here: the server owns the classification, and a
   * client-side copy would drift the moment #3016 wires one.
   *
   * An older server that does not send it yields an empty record, which the UI
   * treats as "no claim made" — never as "nothing is delivered".
   */
  eventDelivery: Partial<Record<ProjectNotificationEventType, boolean>>;
  /**
   * Per channel: does TruePPM deliver on it at all (#3378). Two of the four
   * columns do not — nothing in the API dispatches to Slack or mobile push and
   * no setting anywhere turns them on — so an unmarked column reads as a working
   * control. Orthogonal to {@link eventDelivery}: a cell is live only when its
   * event is dispatched AND its channel delivers.
   *
   * An older server that does not send it yields an empty record. Unlike
   * `eventDelivery`, a channel this map is silent about is not "no claim made"
   * but "ask the fallback" — see {@link isChannelUndeliverable}, which is the
   * only place that decision is made.
   */
  channelDelivery: Partial<Record<ProjectNotificationChannel, boolean>>;
  /** Per-user-per-project kill-switch (#589). When true, no notifications
   * fire for this user on this project regardless of the matrix. */
  paused: boolean;
  quietHoursEnabled: boolean;
  /** Stored as HH:MM:SS or HH:MM; the UI binds to the HH:MM prefix. */
  quietHoursFrom: string;
  quietHoursUntil: string;
  /**
   * IANA zone `quietHoursFrom`/`quietHoursUntil` are actually read in, e.g.
   * `"Asia/Tokyo"` (#3377). Server-resolved and read-only — a PATCH of it is
   * ignored. Never re-derive it here: resolving the window client-side means
   * re-implementing a four-tier chain across three models and keeping it in
   * sync, and the winning tier is not derivable from the stored values at all.
   *
   * `undefined` when the response predates #3377 (a stale cache), which the UI
   * reads as "no claim made" and renders nothing for — never as UTC.
   */
  quietHoursTimezone?: string;
  /** Which tier of the chain supplied {@link quietHoursTimezone}. */
  quietHoursTimezoneSource?: QuietHoursTimezoneSource;
}

interface ApiPreferences {
  matrix: ProjectNotificationMatrix;
  event_delivery?: Partial<Record<ProjectNotificationEventType, boolean>>;
  channel_delivery?: Partial<Record<ProjectNotificationChannel, boolean>>;
  paused: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_from: string;
  quiet_hours_until: string;
  // Declared optional despite being `required` in the published schema: a
  // response cached before #3377 shipped carries neither, and the UI degrades
  // by staying silent rather than by rendering an undefined zone.
  quiet_hours_timezone?: string;
  quiet_hours_timezone_source?: QuietHoursTimezoneSource;
  updated_at?: string;
}

function fromApi(payload: ApiPreferences): ProjectNotificationPreferences {
  return {
    matrix: payload.matrix,
    eventDelivery: payload.event_delivery ?? {},
    channelDelivery: payload.channel_delivery ?? {},
    paused: payload.paused ?? false,
    quietHoursEnabled: payload.quiet_hours_enabled,
    quietHoursFrom: payload.quiet_hours_from,
    quietHoursUntil: payload.quiet_hours_until,
    quietHoursTimezone: payload.quiet_hours_timezone,
    quietHoursTimezoneSource: payload.quiet_hours_timezone_source,
  };
}

const KEY = (projectId: string) => ['project-notification-preferences', projectId] as const;

export interface ProjectNotificationPatch {
  matrix?: Partial<Record<ProjectNotificationEventType, Partial<Record<ProjectNotificationChannel, boolean>>>>;
  paused?: boolean;
  quietHoursEnabled?: boolean;
  quietHoursFrom?: string;
  quietHoursUntil?: string;
}

function toApi(patch: ProjectNotificationPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.matrix !== undefined) body.matrix = patch.matrix;
  if (patch.paused !== undefined) body.paused = patch.paused;
  if (patch.quietHoursEnabled !== undefined) body.quiet_hours_enabled = patch.quietHoursEnabled;
  if (patch.quietHoursFrom !== undefined) body.quiet_hours_from = patch.quietHoursFrom;
  if (patch.quietHoursUntil !== undefined) body.quiet_hours_until = patch.quietHoursUntil;
  return body;
}

export function useProjectNotificationPreferences(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId);

  const query = useQuery({
    queryKey: KEY(projectId ?? ''),
    queryFn: async () => {
      const res = await apiClient.get<ApiPreferences>(
        `/projects/${projectId}/notification-preferences/`,
      );
      return fromApi(res.data);
    },
    enabled,
    staleTime: 30_000,
  });

  const update = useMutation({
    mutationFn: async (patch: ProjectNotificationPatch) => {
      const res = await apiClient.patch<ApiPreferences>(
        `/projects/${projectId}/notification-preferences/`,
        toApi(patch),
      );
      return fromApi(res.data);
    },
    onMutate: async (patch) => {
      const key = KEY(projectId ?? '');
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProjectNotificationPreferences>(key);
      if (previous) {
        const next: ProjectNotificationPreferences = {
          ...previous,
          paused: patch.paused ?? previous.paused,
          quietHoursEnabled: patch.quietHoursEnabled ?? previous.quietHoursEnabled,
          quietHoursFrom: patch.quietHoursFrom ?? previous.quietHoursFrom,
          quietHoursUntil: patch.quietHoursUntil ?? previous.quietHoursUntil,
          matrix: previous.matrix,
        };
        if (patch.matrix) {
          const merged: ProjectNotificationMatrix = {
            ...previous.matrix,
          };
          for (const [evt, cells] of Object.entries(patch.matrix) as [
            ProjectNotificationEventType,
            Partial<Record<ProjectNotificationChannel, boolean>>,
          ][]) {
            merged[evt] = { ...merged[evt], ...cells };
          }
          next.matrix = merged;
        }
        queryClient.setQueryData(key, next);
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      // Roll back optimistic update on failure.
      if (context?.previous) {
        queryClient.setQueryData(KEY(projectId ?? ''), context.previous);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(KEY(projectId ?? ''), data);
    },
  });

  return {
    preferences: query.data,
    isLoading: query.isLoading,
    error: query.error,
    update,
  };
}
