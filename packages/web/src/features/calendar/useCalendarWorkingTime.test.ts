import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveCalendar } from '@/api/types';
import type { Calendar } from '@/hooks/useProjectCalendars';
import { useCalendarWorkingTime } from './useCalendarWorkingTime';

const previewMock = vi.hoisted(() => vi.fn());
const appliedMock = vi.hoisted(() => vi.fn());
const detailMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useProjectCalendars', () => ({
  useCalendarPreview: previewMock,
  useProjectCalendars: appliedMock,
  useCalendarDetail: detailMock,
}));

const SUN_THU = 64 + 1 + 2 + 4 + 8;

const effective = (over: Partial<EffectiveCalendar> = {}): EffectiveCalendar => ({
  id: 'base',
  name: 'Base',
  working_days: SUN_THU,
  hours_per_day: 8,
  timezone: 'UTC',
  holiday_count: 0,
  ...over,
});

const calendar = (over: Partial<Calendar> = {}): Calendar => ({
  id: 'cal',
  server_version: 1,
  name: 'Calendar',
  working_days: 127,
  hours_per_day: 8,
  timezone: 'UTC',
  exceptions: [],
  ...over,
});

const exc = (description: string) => ({
  id: description,
  exc_start: '2026-12-24',
  exc_end: '2026-12-31',
  description,
});

const empty = { data: undefined, isError: false };

function run(over: Partial<Parameters<typeof useCalendarWorkingTime>[0]> = {}) {
  return renderHook(() =>
    useCalendarWorkingTime({
      projectId: 'p',
      effectiveCalendar: effective(),
      calendarSource: 'project',
      startIso: '2026-12-01',
      endIso: '2026-12-31',
      ...over,
    }),
  ).result.current;
}

describe('useCalendarWorkingTime', () => {
  beforeEach(() => {
    previewMock.mockReturnValue(empty);
    appliedMock.mockReturnValue(empty);
    detailMock.mockReturnValue(empty);
  });
  afterEach(() => vi.clearAllMocks());

  it('falls back to the effective mask while everything is loading', () => {
    const { workingTime, holidaysUnavailable } = run();
    expect(workingTime.mask).toBe(SUN_THU);
    expect(workingTime.exceptions).toEqual([]);
    expect(holidaysUnavailable).toBe(false);
  });

  it('falls back to Mon-Fri when no calendar resolves', () => {
    expect(run({ effectiveCalendar: null, calendarSource: undefined }).workingTime.mask).toBe(31);
  });

  it('requests the preview for the window it was given', () => {
    run();
    expect(previewMock).toHaveBeenCalledWith('p', '2026-12-01', '2026-12-31');
  });

  it('AND-composes overlay masks and types overlay exceptions by role', () => {
    appliedMock.mockReturnValue({
      isError: false,
      data: {
        base: calendar({ name: 'Base', exceptions: [exc('Founders Day')] }),
        overlays: [
          {
            layer_id: 'l1',
            role: 'holidays',
            sort_order: 1,
            calendar: calendar({ name: 'UK', working_days: 31, exceptions: [exc('Boxing Day')] }),
          },
          {
            layer_id: 'l2',
            role: 'workspace',
            sort_order: 2,
            calendar: calendar({ name: 'Plant', exceptions: [exc('')] }),
          },
        ],
        applied: [],
      },
    });
    const { workingTime } = run();
    expect(workingTime.mask).toBe(SUN_THU & 31);
    expect(
      workingTime.exceptions.map(({ name, calendarName, type }) => ({ name, calendarName, type })),
    ).toEqual([
      { name: 'Founders Day', calendarName: 'Base', type: 'holiday' },
      { name: 'Boxing Day', calendarName: 'UK', type: 'holiday' },
      // A blank description displays under its calendar's name.
      { name: 'Plant', calendarName: 'Plant', type: 'shutdown' },
    ]);
  });

  it('skips the detail read when the project overrides its base', () => {
    run({ effectiveCalendar: effective({ holiday_count: 3 }), calendarSource: 'project' });
    expect(detailMock).toHaveBeenCalledWith(null);
  });

  it('skips the detail read when an inherited base has no holidays to fetch', () => {
    run({ calendarSource: 'workspace' });
    expect(detailMock).toHaveBeenCalledWith(null);
  });

  it('reads an inherited base through the detail endpoint, and ignores the applied base', () => {
    detailMock.mockReturnValue({
      isError: false,
      data: calendar({ name: 'Workspace', exceptions: [exc('Winter closure')] }),
    });
    appliedMock.mockReturnValue({
      isError: false,
      // A workspace lock can leave a stale override here that the engine ignores.
      data: { base: calendar({ exceptions: [exc('Stale override')] }), overlays: [], applied: [] },
    });
    const { workingTime } = run({
      effectiveCalendar: effective({ holiday_count: 1 }),
      calendarSource: 'workspace',
    });
    expect(detailMock).toHaveBeenCalledWith('base');
    expect(workingTime.exceptions.map((e) => e.name)).toEqual(['Winter closure']);
  });

  it.each([
    ['the preview alone', { preview: true }, false],
    ['the applied stack alone', { applied: true }, false],
    ['both the preview and the applied stack', { preview: true, applied: true }, true],
    ['the inherited base', { detail: true }, true],
  ])('reports holidays unavailable when %s failed: %#', (_name, failed, expected) => {
    const f = failed as { preview?: boolean; applied?: boolean; detail?: boolean };
    previewMock.mockReturnValue({ data: undefined, isError: !!f.preview });
    appliedMock.mockReturnValue({ data: undefined, isError: !!f.applied });
    detailMock.mockReturnValue({ data: undefined, isError: !!f.detail });
    expect(run().holidaysUnavailable).toBe(expected);
  });
});
