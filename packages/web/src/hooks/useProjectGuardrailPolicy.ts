/**
 * Per-project sprint/phase/WBS guardrail policy (ADR-0101 §3).
 *
 * Singleton — one row per project, lazy-created server-side on first GET.
 * PATCH semantics are partial: a single-rule level change posts only that
 * key in the `levels` map; the server merges onto the existing map.
 *
 * Escalating a composition rule to BLOCK requires `role >= Role.OWNER`
 * (enforced server-side; the UI mirrors this gate to keep the form honest
 * and avoid a 403 round-trip). Lowering to WARN, and toggling
 * `acknowledged_by_team`, are open to any project member.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Stable rule keys (mirror of {@link GuardrailRule} on the API). */
export type GuardrailRule =
  | 'summary_in_sprint'
  | 'phase_in_sprint'
  | 'task_outside_sprint_window'
  | 'recurring_in_sprint'
  | 'subtasks_split';

export type GuardrailLevel = 'warn' | 'block';

/** Composition rules — escalatable warn→block. `subtasks_split` is advisory only. */
export const COMPOSITION_RULES: readonly GuardrailRule[] = [
  'summary_in_sprint',
  'phase_in_sprint',
  'task_outside_sprint_window',
  'recurring_in_sprint',
] as const;

export const ALL_RULES: readonly GuardrailRule[] = [
  ...COMPOSITION_RULES,
  'subtasks_split',
] as const;

/** Display labels — outcome language, NEVER WBS jargon (ADR-0101 §2 explicitly
 *  forbids "WBS L1 root" and "summary task"). Use "parent task" — the term used
 *  elsewhere in TruePPM for a task with children. */
export const RULE_LABEL: Record<GuardrailRule, { title: string; outcome: string }> = {
  summary_in_sprint: {
    title: 'Parent task in a sprint',
    outcome: 'Double-counts in velocity — the child tasks already carry the points.',
  },
  phase_in_sprint: {
    title: 'Phase in a sprint',
    outcome: 'Phases group work; assign the tasks inside the phase to the sprint instead.',
  },
  task_outside_sprint_window: {
    title: 'Task scheduled outside the sprint window',
    outcome: "The task's dates fall outside the sprint — it won't complete in the sprint.",
  },
  recurring_in_sprint: {
    title: 'Recurring task in a sprint',
    outcome: "Recurring tasks aren't tracked in sprint velocity.",
  },
  subtasks_split: {
    title: 'Subtasks split across sprints',
    outcome: 'Advisory — sibling subtasks under one parent span multiple sprints.',
  },
};

export type GuardrailPolicySource = 'owner' | 'external';

export interface ProjectGuardrailPolicy {
  /** Configured level per rule. Rules absent from the map default to `warn`. */
  levels: Partial<Record<GuardrailRule, GuardrailLevel>>;
  /**
   * Enforced level after the sovereignty gate (ADR-0101). An EXTERNAL composition
   * block reads back as `warn` until the team acknowledges it. The UI must use
   * `effectiveLevels` for "what is enforced right now"; `levels` is the raw
   * configured value (used only to detect inert blocks for the banner).
   */
  effectiveLevels: Record<GuardrailRule, GuardrailLevel>;
  source: GuardrailPolicySource;
  sourceLabel: string;
  acknowledgedByTeam: boolean;
  serverVersion?: number;
}

interface ApiPolicy {
  levels: Partial<Record<GuardrailRule, GuardrailLevel>>;
  effective_levels: Record<GuardrailRule, GuardrailLevel>;
  policy_source: GuardrailPolicySource;
  source_label: string;
  acknowledged_by_team: boolean;
  server_version?: number;
}

function fromApi(payload: ApiPolicy): ProjectGuardrailPolicy {
  return {
    levels: payload.levels ?? {},
    // Default to an empty map so a partial payload can't crash the render loop —
    // the rule matrix falls back to 'warn' per missing key. Matters now that the
    // section mounts alongside every other on the consolidated page (ADR-0146):
    // a single malformed response must degrade this section, not tear down the page.
    effectiveLevels: payload.effective_levels ?? ({} as Record<GuardrailRule, GuardrailLevel>),
    source: payload.policy_source,
    sourceLabel: payload.source_label ?? '',
    acknowledgedByTeam: payload.acknowledged_by_team,
    serverVersion: payload.server_version,
  };
}

export interface UpdatePolicyPayload {
  levels?: Partial<Record<GuardrailRule, GuardrailLevel>>;
  acknowledgedByTeam?: boolean;
}

interface ApiUpdatePayload {
  levels?: Partial<Record<GuardrailRule, GuardrailLevel>>;
  acknowledged_by_team?: boolean;
}

function toApi(payload: UpdatePolicyPayload): ApiUpdatePayload {
  const out: ApiUpdatePayload = {};
  if (payload.levels !== undefined) out.levels = payload.levels;
  if (payload.acknowledgedByTeam !== undefined) out.acknowledged_by_team = payload.acknowledgedByTeam;
  return out;
}

const queryKey = (projectId: string | null | undefined) => ['guardrail-policy', projectId];

export function useProjectGuardrailPolicy(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery<ProjectGuardrailPolicy>({
    queryKey: queryKey(projectId),
    queryFn: async () => {
      const res = await apiClient.get<ApiPolicy>(
        `/projects/${projectId}/guardrail-policy/`,
      );
      return fromApi(res.data);
    },
    enabled: !!projectId,
  });

  const update = useMutation({
    mutationFn: async (payload: UpdatePolicyPayload) => {
      const res = await apiClient.patch<ApiPolicy>(
        `/projects/${projectId}/guardrail-policy/`,
        toApi(payload),
      );
      return fromApi(res.data);
    },
    // Optimistic update — the matrix toggle must flip instantly even on a slow
    // network; roll back on API error.
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: queryKey(projectId) });
      const prev = queryClient.getQueryData<ProjectGuardrailPolicy>(queryKey(projectId));
      if (prev) {
        const next: ProjectGuardrailPolicy = {
          ...prev,
          levels: payload.levels ? { ...prev.levels, ...payload.levels } : prev.levels,
          acknowledgedByTeam:
            payload.acknowledgedByTeam ?? prev.acknowledgedByTeam,
        };
        queryClient.setQueryData(queryKey(projectId), next);
      }
      return { prev };
    },
    onError: (_err, _payload, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKey(projectId), ctx.prev);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey(projectId), data);
    },
  });

  return {
    policy: query.data,
    isLoading: query.isLoading,
    error: query.error,
    update,
  };
}
