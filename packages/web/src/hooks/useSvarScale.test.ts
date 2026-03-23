import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSvarScale } from './useSvarScale';
import type { IApi } from '@svar-ui/gantt-store';

type ScrollChartPayload = { left?: number; top?: number };
type EventHandler = (payload: ScrollChartPayload) => void;

function makeMockApi(initialScrollLeft = 0) {
  const handlers: Record<string, EventHandler[]> = {};

  const api = {
    getState: vi.fn().mockReturnValue({ scrollLeft: initialScrollLeft, _scales: null }),
    on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    }),
    exec: vi.fn().mockResolvedValue(undefined),
    intercept: vi.fn(),
    setNext: vi.fn(),
    getReactiveState: vi.fn().mockReturnValue({}),
    getStores: vi.fn().mockReturnValue({ data: {} }),
    getTable: vi.fn().mockReturnValue({}),
    getTask: vi.fn().mockReturnValue({}),
    detach: vi.fn(),
    serialize: vi.fn().mockReturnValue([]),
  } as unknown as IApi;

  const trigger = (event: string, payload: ScrollChartPayload) =>
    handlers[event]?.forEach((h) => h(payload));

  return { api, trigger };
}

describe('useSvarScale', () => {
  it('returns zero scrollLeft and null scales when ganttApi is null', () => {
    const { result } = renderHook(() => useSvarScale(null));
    expect(result.current.scrollLeft).toBe(0);
    expect(result.current.scales).toBeNull();
  });

  it('seeds scrollLeft from getState() when ganttApi becomes available', () => {
    const { api } = makeMockApi(42);
    const { result } = renderHook(() => useSvarScale(api));
    expect(result.current.scrollLeft).toBe(42);
  });

  it('subscribes to scroll-chart, zoom-scale, and expand-scale events', () => {
    const { api } = makeMockApi();
    renderHook(() => useSvarScale(api));
    const calls = (api.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls).toContain('scroll-chart');
    expect(calls).toContain('zoom-scale');
    expect(calls).toContain('expand-scale');
  });

  it('updates scrollLeft when a scroll-chart event fires with a left value', () => {
    const { api, trigger } = makeMockApi();
    const { result } = renderHook(() => useSvarScale(api));
    act(() => {
      trigger('scroll-chart', { left: 120 });
    });
    expect(result.current.scrollLeft).toBe(120);
  });

  it('ignores scroll-chart events that carry no left value', () => {
    const { api, trigger } = makeMockApi(10);
    const { result } = renderHook(() => useSvarScale(api));
    act(() => {
      trigger('scroll-chart', {});
    });
    // scrollLeft should remain at the seeded value
    expect(result.current.scrollLeft).toBe(10);
  });

  it('refreshes scales on a zoom-scale event', () => {
    const { api, trigger } = makeMockApi();
    const mockScales = { width: 500, start: new Date(), end: new Date(), diff: () => 0 };
    (api.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      scrollLeft: 0,
      _scales: mockScales,
    });
    const { result } = renderHook(() => useSvarScale(api));
    act(() => {
      trigger('zoom-scale', {});
    });
    expect(result.current.scales).toBe(mockScales);
  });

  it('refreshes scales on an expand-scale event', () => {
    const { api, trigger } = makeMockApi();
    const mockScales = { width: 800, start: new Date(), end: new Date(), diff: () => 0 };
    (api.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      scrollLeft: 0,
      _scales: mockScales,
    });
    const { result } = renderHook(() => useSvarScale(api));
    act(() => {
      trigger('expand-scale', {});
    });
    expect(result.current.scales).toBe(mockScales);
  });
});
