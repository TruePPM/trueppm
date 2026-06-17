import { describe, it, expect } from 'vitest';
import {
  timeOfDay,
  greeting,
  greetingSubline,
  dateChip,
  buildMyWorkFocusCards,
  myWorkFocusHeading,
} from './myWorkFocus';
import type { MyWorkTask, MyWorkActiveSprint } from '@/hooks/useMyWork';

function task(overrides: Partial<MyWorkTask> = {}): MyWorkTask {
  return {
    id: Math.random().toString(36).slice(2),
    short_id: 'PRJ-1',
    name: 'A task',
    project_id: 'p1',
    project_name: 'Project One',
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
