import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  calendarKeys,
  buildUpdatePayload,
  useCalendarDetail,
  type Calendar,
  type ProjectCalendars,
} from './useProjectCalendars';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: apiGet } }));

function cal(id: string, over: Partial<Calendar> = {}): Calendar {
  return {
    id,
    server_version: 1,
    name: `Calendar ${id}`,
    working_days: 31, // Mon–Fri
    hours_per_day: 8,
    timezone: 'UTC',
    exceptions: [],
    ...over,
  };
}

const BASE = cal('base', { name: 'Project calendar' });
const HOL = cal('hol', { name: 'US Federal Holidays 2026' });
const WS = cal('ws', { name: 'Workspace shutdowns' });

const applied: ProjectCalendars = {
  base: BASE,
  overlays: [
    { layer_id: 'L1', role: 'holidays', sort_order: 1, calendar: HOL },
    { layer_id: 'L2', role: 'workspace', sort_order: 2, calendar: WS },
  ],
  applied: [
    { layer_id: null, role: 'project', sort_order: 0, calendar: BASE },
    { layer_id: 'L1', role: 'holidays', sort_order: 1, calendar: HOL },
    { layer_id: 'L2', role: 'workspace', sort_order: 2, calendar: WS },
  ],
};

describe('calendarKeys', () => {
  it('namespaces applied and preview keys by project and window', () => {
    expect(calendarKeys.library()).toEqual(['calendars', 'library']);
    expect(calendarKeys.applied('p1')).toEqual(['calendars', 'applied', 'p1']);
    expect(calendarKeys.preview('p1', '2026-11-01', '2027-01-31')).toEqual([
      'calendars',
      'preview',
      'p1',
      '2026-11-01',
      '2027-01-31',
    ]);
  });

  it('invalidation prefix matches every preview window for a project', () => {
    const prefix = ['calendars', 'preview', 'p1'];
    const key = calendarKeys.preview('p1', '2026-11-01', '2027-01-31');
    expect(key.slice(0, prefix.length)).toEqual(prefix);
  });
});

describe('buildUpdatePayload', () => {
  it('preserves the base and existing overlay roles when adding', () => {
    const payload = buildUpdatePayload(applied, ['new1'], []);
    expect(payload.base_calendar_id).toBe('base');
    expect(payload.overlays).toEqual([
      { calendar_id: 'hol', role: 'holidays' },
      { calendar_id: 'ws', role: 'workspace' },
      { calendar_id: 'new1', role: 'holidays' },
    ]);
  });

  it('drops the removed layer by layer_id, keeping the rest', () => {
    const payload = buildUpdatePayload(applied, [], ['L1']);
    expect(payload.overlays).toEqual([{ calendar_id: 'ws', role: 'workspace' }]);
  });

  it('adds new calendars as holidays overlays', () => {
    const payload = buildUpdatePayload(applied, ['a', 'b'], []);
    const added = payload.overlays.slice(-2);
    expect(added).toEqual([
      { calendar_id: 'a', role: 'holidays' },
      { calendar_id: 'b', role: 'holidays' },
    ]);
  });

  it('sends a null base when no base is applied', () => {
    const noBase: ProjectCalendars = { ...applied, base: null };
    expect(buildUpdatePayload(noBase, [], []).base_calendar_id).toBeNull();
  });

  it('handles a simultaneous add and remove', () => {
    const payload = buildUpdatePayload(applied, ['x'], ['L2']);
    expect(payload.overlays).toEqual([
      { calendar_id: 'hol', role: 'holidays' },
      { calendar_id: 'x', role: 'holidays' },
    ]);
  });
});

describe('useCalendarDetail', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      children,
    );

  it('reads one calendar with its exceptions', async () => {
    apiGet.mockResolvedValue({ data: BASE });
    const { result } = renderHook(() => useCalendarDetail('base'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(BASE));
    expect(apiGet).toHaveBeenCalledWith('/calendars/base/');
  });

  it('issues no request without an id', () => {
    apiGet.mockClear();
    const { result } = renderHook(() => useCalendarDetail(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
