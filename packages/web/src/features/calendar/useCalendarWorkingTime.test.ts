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

const empty = { data: undefined, isError: false, isLoading: false, failureCount: 0 };

function run(over: Partial<Parameters<typeof useCalendarWorkingTime>[0]> = {}) {
  return renderHook(() =>
    useCalendarWorkingTime({
      projectId: 'p',
      effectiveCalendar: effective(),
      calendarSource: 'project',
      projectLoading: false,
      projectFailed: false,
      anchor: new Date(Date.UTC(2026, 11, 16)),
      calView: 'week',
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
    const { workingTime, workingTimeIncomplete } = run();
    expect(workingTime.mask).toBe(SUN_THU);
    expect(workingTime.exceptions).toEqual([]);
    expect(workingTimeIncomplete).toBe(false);
  });

  it('falls back to Mon-Fri when no calendar resolves', () => {
    expect(run({ effectiveCalendar: null, calendarSource: undefined }).workingTime.mask).toBe(31);
  });

  it('requests the preview for the rotated week it will draw', () => {
    run();
    expect(previewMock).toHaveBeenLastCalledWith('p', '2026-12-13', '2026-12-19');
  });

  it('requests the whole drawn month, spilling past the month on both sides', () => {
    run({ calView: 'month' });
    expect(previewMock).toHaveBeenLastCalledWith('p', '2026-11-29', '2027-01-02');
  });

  describe('week start', () => {
    const withOverlay = (working_days: number) => ({
      isError: false,
      data: {
        base: null,
        overlays: [
          {
            layer_id: 'l1',
            role: 'holidays',
            sort_order: 1,
            calendar: calendar({ working_days }),
          },
        ],
        applied: [],
      },
    });

    it('follows the base pattern while the applied stack is unknown', () => {
      expect(run().weekStartDay).toBe(0);
    });

    it('follows the composed pattern once overlays load, so it never opens on a blocked day', () => {
      // Sun-Thu base AND a Mon-Fri overlay leaves Mon-Thu: Sunday is not a working day.
      appliedMock.mockReturnValue(withOverlay(31));
      const { weekStartDay, workingTime } = run();
      expect(workingTime.mask).toBe(SUN_THU & 31);
      expect(weekStartDay).toBe(1);
      expect(previewMock).toHaveBeenLastCalledWith('p', '2026-12-14', '2026-12-20');
    });

    it('keeps the base pattern when an overlay does not narrow it', () => {
      appliedMock.mockReturnValue(withOverlay(127));
      expect(run().weekStartDay).toBe(0);
    });

    it('keeps the base pattern when the applied read fails', () => {
      appliedMock.mockReturnValue({ data: undefined, isError: true });
      expect(run().weekStartDay).toBe(0);
    });
  });

  describe('layout settling', () => {
    it('holds the grid and the preview until the first applied attempt answers', () => {
      appliedMock.mockReturnValue({
        data: undefined,
        isError: false,
        isLoading: true,
        failureCount: 0,
      });
      expect(run().layoutSettling).toBe(true);
      expect(previewMock).toHaveBeenLastCalledWith(null, expect.any(String), expect.any(String));
    });

    it('holds for the project read too', () => {
      expect(run({ projectLoading: true }).layoutSettling).toBe(true);
    });

    it('releases at the first failed attempt rather than after the retries', () => {
      appliedMock.mockReturnValue({
        data: undefined,
        isError: false,
        isLoading: true,
        failureCount: 1,
      });
      expect(run().layoutSettling).toBe(false);
      expect(previewMock).toHaveBeenLastCalledWith('p', expect.any(String), expect.any(String));
    });

    it('does not hold once the reads have answered', () => {
      expect(run().layoutSettling).toBe(false);
    });
  });

  it('carries each calendar pattern so a blocked day can name its source', () => {
    appliedMock.mockReturnValue({
      isError: false,
      data: {
        base: null,
        overlays: [
          {
            layer_id: 'l1',
            role: 'holidays',
            sort_order: 1,
            calendar: calendar({ name: 'UK', working_days: 31 }),
          },
        ],
        applied: [],
      },
    });
    expect(run().workingTime.calendars).toEqual([
      { name: 'Base', workingDays: SUN_THU },
      { name: 'UK', workingDays: 31 },
    ]);
    expect(
      run({ effectiveCalendar: null, calendarSource: undefined }).workingTime.calendars,
    ).toEqual([{ name: 'UK', workingDays: 31 }]);
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
  ])('reports the working time incomplete when %s failed: %#', (_name, failed, expected) => {
    const f = failed as { preview?: boolean; applied?: boolean; detail?: boolean };
    previewMock.mockReturnValue({ data: undefined, isError: !!f.preview });
    appliedMock.mockReturnValue({ data: undefined, isError: !!f.applied });
    detailMock.mockReturnValue({ data: undefined, isError: !!f.detail });
    expect(run().workingTimeIncomplete).toBe(expected);
  });

  it('reports the working time incomplete when the project read failed', () => {
    expect(run({ projectFailed: true }).workingTimeIncomplete).toBe(true);
  });

  it('does not report a failed background refetch that still holds data', () => {
    previewMock.mockReturnValue({ data: { days: [] }, isError: true });
    appliedMock.mockReturnValue({
      data: { base: null, overlays: [], applied: [] },
      isError: true,
    });
    expect(run().workingTimeIncomplete).toBe(false);
  });
});
