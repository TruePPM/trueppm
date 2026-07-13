import { describe, it, expect } from 'vitest';
import {
  timeOfDay,
  greeting,
  greetingSubline,
  dateChip,
  buildMyWorkFocusCards,
  myWorkFocusHeading,
  burndownSpark,
  burnPaceDetail,
  utilizationCard,
} from './myWorkFocus';
import type { MyWorkTask, MyWorkActiveSprint, MyWorkSignals } from '@/hooks/useMyWork';

function task(overrides: Partial<MyWorkTask> = {}): MyWorkTask {
  return {
    id: Math.random().toString(36).slice(2),
    short_id: 'PRJ-1',
    name: 'A task',
    project_id: 'p1',
    project_name: 'Project One',
    program_id: null,
    program_name: null,
    program_color: null,
    sprint_id: null,
    sprint_name: null,
    status: 'IN_PROGRESS',
    story_points: null,
    remaining_points: null,
    due: null,
    due_source: null,
    is_critical: false,
    group: 'today',
    is_blocked: false,
    blocked_reason: '',
    blocker_type: '',
    blocked_age_seconds: null,
    server_version: 1,
    url: '/projects/p1/schedule?task=x',
    ...overrides,
  };
}

function sprint(overrides: Partial<MyWorkActiveSprint> = {}): MyWorkActiveSprint {
  return {
    id: 's1',
    name: 'Sprint 9',
    project_id: 'p1',
    project_name: 'Project One',
    finish_date: '2026-07-01',
    days_remaining: 5,
    task_count: 4,
    ...overrides,
  };
}

describe('timeOfDay', () => {
  it('bands the hour into morning / afternoon / evening', () => {
    expect(timeOfDay(0)).toBe('morning');
    expect(timeOfDay(11)).toBe('morning');
    expect(timeOfDay(12)).toBe('afternoon');
    expect(timeOfDay(17)).toBe('afternoon');
    expect(timeOfDay(18)).toBe('evening');
    expect(timeOfDay(23)).toBe('evening');
  });
});

describe('greeting', () => {
  it('names the user when a display name is present', () => {
    const morning = new Date(2026, 5, 17, 9, 0, 0);
    expect(greeting('Anika', morning)).toBe('Good morning, Anika.');
  });

  it('switches lead by time of day', () => {
    expect(greeting('Sam', new Date(2026, 5, 17, 14, 0, 0))).toBe('Good afternoon, Sam.');
    expect(greeting('Sam', new Date(2026, 5, 17, 20, 0, 0))).toBe('Good evening, Sam.');
  });

  it('degrades to a generic greeting when the name is missing/blank', () => {
    const morning = new Date(2026, 5, 17, 9, 0, 0);
    expect(greeting(undefined, morning)).toBe('Good morning.');
    expect(greeting('   ', morning)).toBe('Good morning.');
  });
});

describe('greetingSubline', () => {
  it('composes both clauses with correct pluralization', () => {
    expect(greetingSubline(5, 2)).toBe('5 tasks need you today · 2 on the critical path');
    expect(greetingSubline(1, 1)).toBe('1 task needs you today · 1 on the critical path');
  });

  it('self-suppresses a zero clause', () => {
    expect(greetingSubline(3, 0)).toBe('3 tasks need you today');
    expect(greetingSubline(0, 2)).toBe('2 on the critical path');
  });

  it('reads "all caught up" when nothing is due or critical', () => {
    expect(greetingSubline(0, 0)).toBe("You're all caught up.");
  });
});

describe('dateChip', () => {
  it('formats weekday + month + day', () => {
    // 2026-06-17 is a Wednesday.
    expect(dateChip(new Date(2026, 5, 17))).toBe('Wednesday, June 17');
  });
});

describe('buildMyWorkFocusCards', () => {
  it('builds three cards from blocked + critical + open work, worst signal first', () => {
    const tasks = [
      task({ is_blocked: true }),
      task({ is_critical: true }),
      task({ status: 'IN_PROGRESS' }),
    ];
    const cards = buildMyWorkFocusCards(tasks, [], 1);
    expect(cards).toHaveLength(3);
    // Card 1: needs attention = 1 blocked + 1 critical = 2, critical variant
    // (blocked outranks critical).
    expect(cards[0]).toMatchObject({
      key: 'needs_attention',
      value: '2',
      variant: 'critical',
      delta: '1 blocked',
    });
    // Card 2 (no sprint): the critical-path mini.
    expect(cards[1]).toMatchObject({ key: 'critical_path', value: '1', variant: 'at-risk' });
    // Card 3: load = 3 open tasks, due-today delta.
    expect(cards[2]).toMatchObject({ key: 'load', value: '3', delta: '1 due today' });
  });

  it('uses the soonest-ending active sprint as the method card with a spark', () => {
    const tasks = [
      task({ sprint_id: 's2', status: 'COMPLETE' }),
      task({ sprint_id: 's2', status: 'IN_PROGRESS' }),
    ];
    const sprints = [
      sprint({ id: 's1', name: 'Far', days_remaining: 9 }),
      sprint({ id: 's2', name: 'Soon', days_remaining: 2 }),
    ];
    const cards = buildMyWorkFocusCards(tasks, sprints, 0);
    expect(cards[1].key).toBe('sprint');
    expect(cards[1].label).toBe('Soon');
    expect(cards[1].value).toBe('2d');
    // Spark present and ending at the real completion share (1 of 2 done = 0.5).
    expect(cards[1].spark).toBeDefined();
    expect(cards[1].spark?.at(-1)).toBeCloseTo(0.5);
  });

  it('flags a sprint ending in <=1 day as at-risk', () => {
    const cards = buildMyWorkFocusCards([], [sprint({ days_remaining: 1 })], 0);
    expect(cards[1]).toMatchObject({ key: 'sprint', variant: 'at-risk', delta: '1 day left' });
  });

  it('drops the load card (2-up) when there is no open work', () => {
    const tasks = [task({ status: 'COMPLETE' }), task({ status: 'BACKLOG' })];
    const cards = buildMyWorkFocusCards(tasks, [], 0);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.key)).not.toContain('load');
  });

  it('reads calm (on-track) when nothing needs attention', () => {
    const cards = buildMyWorkFocusCards([task()], [], 0);
    expect(cards[0]).toMatchObject({ key: 'needs_attention', value: '0', variant: 'on-track' });
  });
});

describe('cross-program signals enrichment (#1236)', () => {
  it('adds a real schedule-health detail line to the needs-attention card', () => {
    const signals: MyWorkSignals = {
      schedule_health: { band: 'at_risk', project_count: 3 },
    };
    const cards = buildMyWorkFocusCards([task({ is_blocked: true })], [], 0, signals);
    // Value color still reflects local urgency; the health figure is its own line.
    expect(cards[0]).toMatchObject({ key: 'needs_attention', variant: 'critical' });
    expect(cards[0].detail).toEqual({
      text: 'Schedule at risk · 3 projects',
      tone: 'at-risk',
    });
  });

  it('singularizes the schedule-health project count', () => {
    const cards = buildMyWorkFocusCards([task()], [], 0, {
      schedule_health: { band: 'on_track', project_count: 1 },
    });
    expect(cards[0].detail?.text).toBe('Schedule on track · 1 project');
  });

  it('omits the detail line when no schedule_health signal is present', () => {
    const cards = buildMyWorkFocusCards([task()], [], 0);
    expect(cards[0].detail).toBeUndefined();
  });

  it('uses the real burndown series + pace on the matching lead sprint card', () => {
    const sprints = [sprint({ id: 's2', name: 'Soon', days_remaining: 2 })];
    const signals: MyWorkSignals = {
      sprint_burndown: {
        sprint_id: 's2',
        sprint_name: 'Soon',
        committed_points: 40,
        series: [
          { date: '2026-06-20', remaining_points: 40 },
          { date: '2026-06-21', remaining_points: 20 },
          { date: '2026-06-22', remaining_points: 10 },
        ],
        burn_status: 'behind',
        trend_points: -5,
        projected_finish_date: '2026-07-05',
      },
    };
    const cards = buildMyWorkFocusCards([], sprints, 0, signals);
    // Real series → last bar is today's remaining share (10/40 = 0.25).
    expect(cards[1].spark?.at(-1)).toBeCloseTo(0.25);
    expect(cards[1].spark).toHaveLength(3);
    expect(cards[1].detail).toEqual({ text: '5 pts behind', tone: 'at-risk' });
  });

  it('falls back to the direction-only ramp when the burndown is for a different sprint', () => {
    const sprints = [sprint({ id: 's2', name: 'Soon', days_remaining: 2 })];
    const signals: MyWorkSignals = {
      sprint_burndown: {
        sprint_id: 'OTHER',
        sprint_name: 'Other',
        committed_points: 10,
        series: [{ date: '2026-06-20', remaining_points: 5 }],
        burn_status: 'on_track',
        trend_points: 0,
        projected_finish_date: null,
      },
    };
    const cards = buildMyWorkFocusCards([], sprints, 0, signals);
    // 5-step honest ramp, no real-series detail.
    expect(cards[1].spark).toHaveLength(5);
    expect(cards[1].detail).toBeUndefined();
  });
});

describe('utilizationCard (#1912)', () => {
  const util = (
    overrides: Partial<NonNullable<MyWorkSignals['utilization']>> = {},
  ): NonNullable<MyWorkSignals['utilization']> => ({
    sprint_id: 's1',
    sprint_name: 'Sprint 9',
    committed_hours: 32,
    available_hours: 40,
    ratio: 0.8,
    is_over: false,
    label: 'on_track',
    ...overrides,
  });

  it('renders the load as a rounded percentage of capacity', () => {
    const card = utilizationCard(util({ ratio: 0.8 }));
    expect(card).toMatchObject({
      key: 'utilization',
      label: 'Load vs target',
      value: '80%',
      delta: 'of capacity',
      variant: 'on-track',
    });
    // The raw hours + window make the ratio auditable; neutral so it never
    // competes with the value color (a11y — text carries the meaning).
    expect(card?.detail).toEqual({ text: '32h of 40h · Sprint 9', tone: 'neutral' });
  });

  it('flags the over-capacity state with the critical semantic tone', () => {
    const card = utilizationCard(
      util({ committed_hours: 60, available_hours: 40, ratio: 1.5, is_over: true, label: 'over_capacity' }),
    );
    expect(card).toMatchObject({ value: '150%', delta: 'over capacity', variant: 'critical' });
  });

  it('maps the at-risk band to the amber at-risk tone with its own delta text', () => {
    const card = utilizationCard(util({ ratio: 0.95, label: 'at_risk' }));
    expect(card?.variant).toBe('at-risk');
    expect(card?.value).toBe('95%');
    // Distinct from the on-track "of capacity" so the state is not color-only
    // (WCAG 1.4.1) — each band's delta text stands alone.
    expect(card?.delta).toBe('near capacity');
  });

  it('returns undefined (empty state) when the server omits the signal', () => {
    expect(utilizationCard(undefined)).toBeUndefined();
  });
});

describe('utilization focus card wiring (#1912)', () => {
  const utilSignal: MyWorkSignals = {
    utilization: {
      sprint_id: 's1',
      sprint_name: 'Sprint 9',
      committed_hours: 46,
      available_hours: 40,
      ratio: 1.15,
      is_over: true,
      label: 'over_capacity',
    },
  };

  it('appends a fourth "load vs target" card when the signal is present', () => {
    // 3 open tasks → needs_attention + method + load, then the utilization card.
    const tasks = [task(), task(), task()];
    const cards = buildMyWorkFocusCards(tasks, [], 1, utilSignal);
    expect(cards).toHaveLength(4);
    expect(cards[3]).toMatchObject({ key: 'utilization', value: '115%', variant: 'critical' });
  });

  it('omits the utilization card when the server supplies no utilization signal', () => {
    const cards = buildMyWorkFocusCards([task(), task(), task()], [], 1, {
      schedule_health: { band: 'on_track', project_count: 1 },
    });
    expect(cards.map((c) => c.key)).not.toContain('utilization');
  });
});

describe('burndownSpark', () => {
  it('normalizes remaining points against the committed baseline', () => {
    const heights = burndownSpark(
      [
        { remaining_points: 40 },
        { remaining_points: 20 },
        { remaining_points: 0 },
      ],
      40,
    );
    expect(heights).toEqual([1, 0.5, 0.06]); // floored at 0.06 so an empty bar still shows
  });

  it('normalizes against the series peak when scope grew past commitment', () => {
    const heights = burndownSpark([{ remaining_points: 50 }, { remaining_points: 25 }], 40);
    expect(heights?.[0]).toBeCloseTo(1);
    expect(heights?.[1]).toBeCloseTo(0.5);
  });

  it('returns undefined for an empty series (honest fallback)', () => {
    expect(burndownSpark([], 40)).toBeUndefined();
  });
});

describe('burnPaceDetail', () => {
  it('phrases behind / ahead with the signed magnitude and tone', () => {
    expect(burnPaceDetail('behind', -5)).toEqual({ text: '5 pts behind', tone: 'at-risk' });
    expect(burnPaceDetail('ahead', 3)).toEqual({ text: '3 pts ahead', tone: 'on-track' });
    expect(burnPaceDetail('behind', -1)).toEqual({ text: '1 pt behind', tone: 'at-risk' });
  });

  it('reads "On track" within the ideal band', () => {
    expect(burnPaceDetail('on_track', 0)).toEqual({ text: 'On track', tone: 'neutral' });
  });

  it('omits the pace when there is no baseline (no_data / null trend)', () => {
    expect(burnPaceDetail('no_data', null)).toBeUndefined();
    expect(burnPaceDetail('on_track', null)).toBeUndefined();
  });
});

describe('myWorkFocusHeading', () => {
  it('reads "Needs attention" when any card is at-risk or critical', () => {
    const cards = buildMyWorkFocusCards([task({ is_critical: true })], [], 0);
    expect(myWorkFocusHeading(cards)).toBe('Needs attention');
  });

  it('reads the calm "Your day" when all cards are neutral/on-track', () => {
    const cards = buildMyWorkFocusCards([task()], [], 0);
    expect(myWorkFocusHeading(cards)).toBe('Your day');
  });
});
