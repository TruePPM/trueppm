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

export type ProjectNotificationMatrix = Record<
  ProjectNotificationEventType,
  Record<ProjectNotificationChannel, boolean>
>;

export interface ProjectNotificationPreferences {
  matrix: ProjectNotificationMatrix;
  quietHoursEnabled: boolean;
  /** Stored as HH:MM:SS or HH:MM; the UI binds to the HH:MM prefix. */
  quietHoursFrom: string;
  quietHoursUntil: string;
}

interface ApiPreferences {
  matrix: ProjectNotificationMatrix;
  quiet_hours_enabled: boolean;
  quiet_hours_from: string;
  quiet_hours_until: string;
  updated_at?: string;
}

function fromApi(payload: ApiPreferences): ProjectNotificationPreferences {
  return {
    matrix: payload.matrix,
    quietHoursEnabled: payload.quiet_hours_enabled,
    quietHoursFrom: payload.quiet_hours_from,
    quietHoursUntil: payload.quiet_hours_until,
  };
}

const KEY = (projectId: string) => ['project-notification-preferences', projectId] as const;

export interface ProjectNotificationPatch {
  matrix?: Partial<Record<ProjectNotificationEventType, Partial<Record<ProjectNotificationChannel, boolean>>>>;
  quietHoursEnabled?: boolean;
  quietHoursFrom?: string;
  quietHoursUntil?: string;
}

function toApi(patch: ProjectNotificationPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.matrix !== undefined) body.matrix = patch.matrix;
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
          quietHoursEnabled:
            patch.quietHoursEnabled !== undefined
              ? patch.quietHoursEnabled
              : previous.quietHoursEnabled,
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
