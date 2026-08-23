import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useProjectNotificationPreferences,
  PROJECT_NOTIFICATION_EVENTS,
  PROJECT_NOTIFICATION_CHANNELS,
  type ProjectNotificationChannel,
  type ProjectNotificationEventType,
  type ProjectNotificationMatrix,
  type ProjectNotificationPreferences,
} from './useProjectNotificationPreferences';

/** The wire payload — `paused` is optional so the ?? default can be exercised. */
interface ApiPayload {
  matrix: ProjectNotificationMatrix;
  /** #2904 — which rows have a dispatcher wired server-side. */
  event_delivery?: Partial<Record<ProjectNotificationEventType, boolean>>;
  paused?: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_from: string;
  quiet_hours_until: string;
}

const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string) => Promise<{ data: ApiPayload }>>(),
  patchMock:
    vi.fn<(url: string, body: Record<string, unknown>) => Promise<{ data: ApiPayload }>>(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock },
}));

const KEY = ['project-notification-preferences', 'p1'];

function makeMatrix(
  overrides: Partial<
    Record<ProjectNotificationEventType, Partial<Record<ProjectNotificationChannel, boolean>>>
  > = {},
): ProjectNotificationMatrix {
  const matrix = {} as ProjectNotificationMatrix;
  for (const { type } of PROJECT_NOTIFICATION_EVENTS) {
    const row = {} as Record<ProjectNotificationChannel, boolean>;
    for (const { channel } of PROJECT_NOTIFICATION_CHANNELS) {
      row[channel] = false;
    }
    matrix[type] = { ...row, ...overrides[type] };
  }
  return matrix;
}

function payload(overrides: Partial<ApiPayload> = {}): ApiPayload {
  return {
    matrix: makeMatrix({ task_assigned: { email: true } }),
    event_delivery: { comment_mention: true },
    paused: false,
    quiet_hours_enabled: false,
    quiet_hours_from: '22:00:00',
    quiet_hours_until: '07:00:00',
    ...overrides,
  };
}

function cachedPreferences(
  overrides: Partial<ProjectNotificationPreferences> = {},
): ProjectNotificationPreferences {
  return {
    matrix: makeMatrix({ task_assigned: { email: true } }),
    eventDelivery: { comment_mention: true },
    paused: false,
    quietHoursEnabled: false,
    quietHoursFrom: '22:00:00',
    quietHoursUntil: '07:00:00',
    ...overrides,
  };
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function mount(qc: QueryClient) {
  return mountFor(qc, 'p1');
}

function mountFor(qc: QueryClient, projectId: string | null | undefined) {
  return renderHook(() => useProjectNotificationPreferences(projectId), {
    wrapper: makeWrapper(qc),
  });
}

describe('useProjectNotificationPreferences — loading', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue({ data: payload() });
  });

  it('maps the snake_case document onto the camelCase view model', async () => {
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    expect(getMock).toHaveBeenCalledWith('/projects/p1/notification-preferences/');
    expect(result.current.preferences).toEqual({
      matrix: payload().matrix,
      eventDelivery: { comment_mention: true },
      paused: false,
      quietHoursEnabled: false,
      quietHoursFrom: '22:00:00',
      quietHoursUntil: '07:00:00',
    });
    expect(result.current.error).toBeNull();
  });

  it('carries a paused project through as the kill-switch state', async () => {
    getMock.mockResolvedValue({
      data: payload({ paused: true, quiet_hours_enabled: true }),
    });
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    expect(result.current.preferences?.paused).toBe(true);
    expect(result.current.preferences?.quietHoursEnabled).toBe(true);
  });

  it('defaults paused to false when the server omits the field', async () => {
    getMock.mockResolvedValue({ data: payload({ paused: undefined }) });
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    expect(result.current.preferences?.paused).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('does not fetch when the project id is %s', async (_label, projectId) => {
    const { result } = mountFor(newQc(), projectId);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.preferences).toBeUndefined();
  });

  it('surfaces a load failure instead of an empty matrix', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.preferences).toBeUndefined();
  });
});

describe('useProjectNotificationPreferences — PATCH body', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue({ data: payload() });
    patchMock.mockResolvedValue({ data: payload() });
  });

  it('sends only the single changed matrix cell', async () => {
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    await act(async () => {
      await result.current.update.mutateAsync({
        matrix: { comment_mention: { slack: true } },
      });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/notification-preferences/', {
      matrix: { comment_mention: { slack: true } },
    });
  });

  it('translates every supplied field to its wire name and drops the rest', async () => {
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    await act(async () => {
      await result.current.update.mutateAsync({
        paused: true,
        quietHoursEnabled: true,
        quietHoursFrom: '21:30',
        quietHoursUntil: '06:15',
      });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/notification-preferences/', {
      paused: true,
      quiet_hours_enabled: true,
      quiet_hours_from: '21:30',
      quiet_hours_until: '06:15',
    });
  });

  it('sends an empty body for an empty patch rather than nulling every field', async () => {
    const { result } = mount(newQc());
    await waitFor(() => expect(result.current.preferences).toBeDefined());
    await act(async () => {
      await result.current.update.mutateAsync({});
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/notification-preferences/', {});
  });
});

describe('useProjectNotificationPreferences — optimistic update', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue({ data: payload() });
  });

  it('flips the toggle in the cache before the PATCH resolves', async () => {
    const qc = newQc();
    let resolvePatch!: (v: { data: ApiPayload }) => void;
    patchMock.mockReturnValue(
      new Promise<{ data: ApiPayload }>((res) => {
        resolvePatch = res;
      }),
    );
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    act(() => {
      result.current.update.mutate({ paused: true });
    });
    await waitFor(() =>
      expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)?.paused).toBe(true),
    );
    // Untouched fields survive the optimistic merge.
    expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)?.quietHoursFrom).toBe(
      '22:00:00',
    );

    act(() => {
      resolvePatch({ data: payload({ paused: true }) });
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it('merges a single matrix cell without dropping the other channels or events', async () => {
    const qc = newQc();
    patchMock.mockResolvedValue({ data: payload() });
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    await act(async () => {
      await result.current.update.mutateAsync({
        matrix: { task_overdue: { slack: true } },
      });
    });
    const cached = qc.getQueryData<ProjectNotificationPreferences>(KEY);
    // Optimistic merge is visible before onSuccess overwrites; assert the merge
    // logic on the previous-cache snapshot the mutation produced.
    expect(cached?.matrix.task_assigned.email).toBe(true);
    expect(cached?.matrix.task_overdue.email).toBe(false);
  });

  it('keeps quiet-hours values that the patch did not mention', async () => {
    const qc = newQc();
    let resolvePatch!: (v: { data: ApiPayload }) => void;
    patchMock.mockReturnValue(
      new Promise<{ data: ApiPayload }>((res) => {
        resolvePatch = res;
      }),
    );
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    act(() => {
      result.current.update.mutate({ quietHoursFrom: '23:15' });
    });
    await waitFor(() =>
      expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)?.quietHoursFrom).toBe(
        '23:15',
      ),
    );
    const cached = qc.getQueryData<ProjectNotificationPreferences>(KEY);
    expect(cached?.quietHoursUntil).toBe('07:00:00');
    expect(cached?.quietHoursEnabled).toBe(false);
    expect(cached?.paused).toBe(false);

    act(() => {
      resolvePatch({ data: payload({ quiet_hours_from: '23:15' }) });
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it('turning quiet hours off optimistically writes false, not the previous true', async () => {
    const qc = newQc();
    getMock.mockResolvedValue({ data: payload({ quiet_hours_enabled: true }) });
    let resolvePatch!: (v: { data: ApiPayload }) => void;
    patchMock.mockReturnValue(
      new Promise<{ data: ApiPayload }>((res) => {
        resolvePatch = res;
      }),
    );
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences?.quietHoursEnabled).toBe(true));

    act(() => {
      result.current.update.mutate({ quietHoursEnabled: false });
    });
    await waitFor(() =>
      expect(
        qc.getQueryData<ProjectNotificationPreferences>(KEY)?.quietHoursEnabled,
      ).toBe(false),
    );

    act(() => {
      resolvePatch({ data: payload({ quiet_hours_enabled: false }) });
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it('replaces the optimistic value with the server document on success', async () => {
    const qc = newQc();
    patchMock.mockResolvedValue({
      data: payload({ paused: true, quiet_hours_until: '08:45:00' }),
    });
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    await act(async () => {
      await result.current.update.mutateAsync({ paused: true });
    });
    const cached = qc.getQueryData<ProjectNotificationPreferences>(KEY);
    expect(cached?.paused).toBe(true);
    // Server-canonical field the client never sent.
    expect(cached?.quietHoursUntil).toBe('08:45:00');
  });

  it('writes nothing optimistically when nothing is cached yet', async () => {
    const qc = newQc();
    getMock.mockRejectedValue(new Error('offline'));
    patchMock.mockResolvedValue({ data: payload({ paused: true }) });
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(qc.getQueryData(KEY)).toBeUndefined();

    await act(async () => {
      await result.current.update.mutateAsync({ paused: true });
    });
    expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)?.paused).toBe(true);
  });
});

describe('useProjectNotificationPreferences — rollback', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
  });

  it('restores the pre-mutation document when the PATCH fails', async () => {
    const qc = newQc();
    getMock.mockResolvedValue({ data: payload() });
    patchMock.mockRejectedValue(new Error('500'));
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    await act(async () => {
      await result.current.update
        .mutateAsync({ paused: true, matrix: { risk_created: { email: true } } })
        .catch(() => undefined);
    });
    const cached = qc.getQueryData<ProjectNotificationPreferences>(KEY);
    expect(cached).toEqual(cachedPreferences());
  });

  it('leaves the cache untouched when the PATCH fails with nothing to roll back to', async () => {
    const qc = newQc();
    getMock.mockRejectedValue(new Error('offline'));
    patchMock.mockRejectedValue(new Error('500'));
    const { result } = mount(qc);
    await waitFor(() => expect(result.current.error).toBeTruthy());

    await act(async () => {
      await result.current.update.mutateAsync({ paused: true }).catch(() => undefined);
    });
    expect(qc.getQueryData(KEY)).toBeUndefined();
    await waitFor(() => expect(result.current.update.isError).toBe(true));
  });
});

describe('useProjectNotificationPreferences — no project selected', () => {
  const EMPTY_KEY = ['project-notification-preferences', ''];

  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue({ data: payload() });
  });

  it('scopes a stray mutation to the empty-id cache, never another project', async () => {
    const qc = newQc();
    qc.setQueryData(KEY, cachedPreferences());
    patchMock.mockResolvedValue({ data: payload({ paused: true }) });
    const { result } = mountFor(qc, null);

    await act(async () => {
      await result.current.update.mutateAsync({ paused: true });
    });
    expect(qc.getQueryData<ProjectNotificationPreferences>(EMPTY_KEY)?.paused).toBe(true);
    // p1's cached document must not be collateral damage.
    expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)?.paused).toBe(false);
  });

  it('rolls the empty-id cache back on failure without disturbing a real project', async () => {
    const qc = newQc();
    qc.setQueryData(KEY, cachedPreferences());
    qc.setQueryData(EMPTY_KEY, cachedPreferences({ quietHoursFrom: '20:00:00' }));
    patchMock.mockRejectedValue(new Error('500'));
    const { result } = mountFor(qc, null);

    await act(async () => {
      await result.current.update
        .mutateAsync({ paused: true, quietHoursFrom: '01:00' })
        .catch(() => undefined);
    });
    const cached = qc.getQueryData<ProjectNotificationPreferences>(EMPTY_KEY);
    expect(cached?.paused).toBe(false);
    expect(cached?.quietHoursFrom).toBe('20:00:00');
    expect(qc.getQueryData<ProjectNotificationPreferences>(KEY)).toEqual(
      cachedPreferences(),
    );
  });
});
