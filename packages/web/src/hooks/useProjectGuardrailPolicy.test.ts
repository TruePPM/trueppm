/**
 * useProjectGuardrailPolicy unit tests (#784 coverage backfill, ADR-0101 §3).
 *
 * The guardrail-policy hook carries logic a stale regression would silently
 * corrupt:
 *  - fromApi maps the snake_case singleton to camelCase and DEFAULTS levels /
 *    effectiveLevels / sourceLabel so one malformed response degrades the section
 *    rather than tearing down the consolidated settings page (ADR-0146);
 *  - toApi sends only the keys the caller supplied (partial PATCH merge);
 *  - update applies an optimistic merge of the levels map (the matrix toggle must
 *    flip instantly) and rolls back to the pre-mutation snapshot on API error.
 * The exported rule constants drive the matrix render and are asserted for shape.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useProjectGuardrailPolicy,
  COMPOSITION_RULES,
  ALL_RULES,
  RULE_LABEL,
  type ProjectGuardrailPolicy,
} from './useProjectGuardrailPolicy';

const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** A fully-populated API singleton payload (snake_case, as the server returns it). */
function apiPolicy(overrides: Record<string, unknown> = {}) {
  return {
    levels: { summary_in_sprint: 'block' },
    effective_levels: {
      summary_in_sprint: 'block',
      phase_in_sprint: 'warn',
      task_outside_sprint_window: 'warn',
      recurring_in_sprint: 'warn',
      subtasks_split: 'warn',
    },
    policy_source: 'owner',
    source_label: 'This project',
    acknowledged_by_team: false,
    server_version: 7,
    ...overrides,
  };
}

const KEY = ['guardrail-policy', 'p1'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('exported rule constants', () => {
  it('COMPOSITION_RULES are the four escalatable rules and exclude the advisory one', () => {
    expect(COMPOSITION_RULES).toEqual([
      'summary_in_sprint',
      'phase_in_sprint',
      'task_outside_sprint_window',
      'recurring_in_sprint',
    ]);
    expect(COMPOSITION_RULES).not.toContain('subtasks_split');
  });

  it('ALL_RULES appends the advisory subtasks_split after the composition rules', () => {
    expect(ALL_RULES).toEqual([...COMPOSITION_RULES, 'subtasks_split']);
    expect(Object.keys(RULE_LABEL)).toEqual([...ALL_RULES]);
  });
});

describe('useProjectGuardrailPolicy query (fromApi mapping)', () => {
  it('maps the snake_case singleton to the camelCase shape', async () => {
    getMock.mockResolvedValueOnce({ data: apiPolicy() });
    const qc = makeQC();
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.policy).toBeDefined());
    expect(getMock).toHaveBeenCalledWith('/projects/p1/guardrail-policy/');
    const policy = result.current.policy as ProjectGuardrailPolicy;
    expect(policy.levels).toEqual({ summary_in_sprint: 'block' });
    expect(policy.effectiveLevels.phase_in_sprint).toBe('warn');
    expect(policy.source).toBe('owner');
    expect(policy.sourceLabel).toBe('This project');
    expect(policy.acknowledgedByTeam).toBe(false);
    expect(policy.serverVersion).toBe(7);
  });

  it('defaults levels/effectiveLevels/sourceLabel when the payload omits them', async () => {
    // A partial/malformed response must not crash the render loop — the section
    // degrades to "all warn" rather than tearing down the page (ADR-0146).
    getMock.mockResolvedValueOnce({
      data: {
        policy_source: 'external',
        acknowledged_by_team: true,
        // levels, effective_levels, source_label all absent
      },
    });
    const qc = makeQC();
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.policy).toBeDefined());
    const policy = result.current.policy as ProjectGuardrailPolicy;
    expect(policy.levels).toEqual({});
    expect(policy.effectiveLevels).toEqual({});
    expect(policy.sourceLabel).toBe('');
    expect(policy.source).toBe('external');
    expect(policy.acknowledgedByTeam).toBe(true);
  });

  it('does not fetch when projectId is null (enabled gate)', () => {
    const qc = makeQC();
    renderHook(() => useProjectGuardrailPolicy(null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useProjectGuardrailPolicy update (toApi + optimistic merge)', () => {
  function seed(qc: QueryClient) {
    qc.setQueryData<ProjectGuardrailPolicy>(KEY, {
      levels: { summary_in_sprint: 'block' },
      effectiveLevels: {
        summary_in_sprint: 'block',
        phase_in_sprint: 'warn',
        task_outside_sprint_window: 'warn',
        recurring_in_sprint: 'warn',
        subtasks_split: 'warn',
      },
      source: 'owner',
      sourceLabel: 'This project',
      acknowledgedByTeam: false,
      serverVersion: 7,
    });
  }

  it('sends only the supplied keys (toApi omits undefined acknowledgedByTeam)', async () => {
    patchMock.mockResolvedValueOnce({ data: apiPolicy() });
    const qc = makeQC();
    seed(qc);
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.update.mutate({ levels: { phase_in_sprint: 'block' } });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/guardrail-policy/', {
      levels: { phase_in_sprint: 'block' },
    });
  });

  it('optimistically MERGES the levels map (not replace) before the request resolves', async () => {
    // Never-resolving PATCH keeps the mutation pending so we observe ONLY the
    // optimistic onMutate write. The new key must merge onto the existing map —
    // a replace would drop summary_in_sprint.
    patchMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    seed(qc);
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.update.mutate({ levels: { phase_in_sprint: 'block' } });

    await waitFor(() => {
      const cached = qc.getQueryData<ProjectGuardrailPolicy>(KEY);
      expect(cached?.levels).toEqual({
        summary_in_sprint: 'block',
        phase_in_sprint: 'block',
      });
    });
  });

  it('rolls back to the snapshot when the PATCH fails', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    seed(qc);
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.update.mutate({ levels: { phase_in_sprint: 'block' } });

    await waitFor(() => expect(result.current.update.isError).toBe(true));
    const cached = qc.getQueryData<ProjectGuardrailPolicy>(KEY);
    expect(cached?.levels).toEqual({ summary_in_sprint: 'block' });
  });

  it('writes the server response into the cache on success', async () => {
    patchMock.mockResolvedValueOnce({
      data: apiPolicy({ acknowledged_by_team: true, source_label: 'Acknowledged' }),
    });
    const qc = makeQC();
    seed(qc);
    const { result } = renderHook(() => useProjectGuardrailPolicy('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.update.mutate({ acknowledgedByTeam: true });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/guardrail-policy/', {
      acknowledged_by_team: true,
    });
    const cached = qc.getQueryData<ProjectGuardrailPolicy>(KEY);
    expect(cached?.acknowledgedByTeam).toBe(true);
    expect(cached?.sourceLabel).toBe('Acknowledged');
  });
});
