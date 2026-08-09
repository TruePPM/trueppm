import { describe, it, expect } from 'vitest';
import { runCpmForwardPass } from './cpmEngine';
import type { CpmTask, CpmEdge } from './cpmWorker.types';

// Helper: build a task with sensible defaults
function task(
  id: string,
  earlyStart: string,
  earlyFinish: string,
  opts: Partial<CpmTask> = {},
): CpmTask {
  return {
    id,
    earlyStart,
    earlyFinish,
    lateFinish: opts.lateFinish ?? earlyFinish, // zero float by default
    durationDays:
      opts.durationDays ??
      Math.round(
        (new Date(earlyFinish).getTime() - new Date(earlyStart).getTime()) /
          (24 * 60 * 60 * 1000),
      ) + 1,
    isMilestone: opts.isMilestone ?? false,
    name: opts.name ?? id,
    // ADR-0132 progress facts (#2813). Absent by default, so every pre-#2813
    // case in this file continues to exercise the progress-free path.
    isComplete: opts.isComplete,
    actualStart: opts.actualStart ?? null,
    actualFinish: opts.actualFinish ?? null,
    remainingDuration: opts.remainingDuration ?? null,
  };
}

function edge(
  sourceId: string,
  targetId: string,
  type: CpmEdge['type'] = 'FS',
  lag = 0,
): CpmEdge {
  return { sourceId, targetId, type, lag };
}

describe('runCpmForwardPass', () => {
  it('moves a single task to the new start with correct finish', () => {
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')]; // 5 days
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');

    expect(results).toHaveLength(1);
    expect(results[0].earlyStart).toBe('2025-01-13');
    expect(results[0].earlyFinish).toBe('2025-01-17'); // 5 days inclusive
  });

  it('propagates FS dependency to downstream task', () => {
    // A (5d) → FS → B (3d)
    // Drag A to Jan 13 (Mon) → A finishes Jan 17 (Fri) → the day after (Jan
    // 18) is a Saturday, so B's calendar-aware start snaps forward to Jan 20
    // (Mon) → finishes Jan 22 (issue #1493: previously computed as the
    // calendar-blind Jan 18 → Jan 20, ignoring the intervening weekend).
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-11', '2025-01-13'), // original: starts after A
    ];
    const edges: CpmEdge[] = [edge('A', 'B', 'FS')];

    const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-13');
    const a = results.find((r) => r.taskId === 'A')!;
    const b = results.find((r) => r.taskId === 'B')!;

    expect(a.earlyStart).toBe('2025-01-13');
    expect(a.earlyFinish).toBe('2025-01-17');
    expect(b.earlyStart).toBe('2025-01-20');
    expect(b.earlyFinish).toBe('2025-01-22');
  });

  it('propagates SS dependency correctly', () => {
    // A (5d) → SS → B (3d): B starts when A starts
    // Drag A to Jan 13 → B starts Jan 13 → finishes Jan 15
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-06', '2025-01-08'),
    ];
    const { results } = runCpmForwardPass(
      tasks,
      [edge('A', 'B', 'SS')],
      'A',
      '2025-01-13',
    );
    const b = results.find((r) => r.taskId === 'B')!;
    expect(b.earlyStart).toBe('2025-01-13');
    expect(b.earlyFinish).toBe('2025-01-15');
  });

  it('propagates FF dependency correctly', () => {
    // A (5d, finishes Jan 17) → FF → B (3d): B finishes no earlier than A
    // B start = A.finish - B.duration + 1 = Jan 17 - 3 + 1 = Jan 15
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-06', '2025-01-08'), // original 3 days
    ];
    const { results } = runCpmForwardPass(
      tasks,
      [edge('A', 'B', 'FF')],
      'A',
      '2025-01-13',
    );
    const b = results.find((r) => r.taskId === 'B')!;
    // A finishes Jan 17; B should finish Jan 17 (FF), starting Jan 15
    expect(b.earlyFinish).toBe('2025-01-17');
  });

  it('computes deltaDays correctly for slipping task', () => {
    // A originally finishes Jan 10; dragged to finish Jan 17 → delta = +7
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].deltaDays).toBe(7);
  });

  it('marks task as critical when new finish exceeds lateFinish', () => {
    // A has lateFinish Jan 15; after drag it finishes Jan 17 → critical
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-01-15' }),
    ];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].isCritical).toBe(true);
  });

  it('does not mark task as critical when finish is within float', () => {
    // A has lateFinish Jan 20; after drag it finishes Jan 17 — still on track
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-01-20' }),
    ];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].isCritical).toBe(false);
  });

  it('identifies worst milestone', () => {
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('M1', '2025-01-11', '2025-01-11', { isMilestone: true, name: 'Go Live', durationDays: 1 }),
    ];
    const { worstMilestone } = runCpmForwardPass(
      tasks,
      [edge('A', 'M1', 'FS')],
      'A',
      '2025-01-13',
    );
    expect(worstMilestone).not.toBeNull();
    expect(worstMilestone?.name).toBe('Go Live');
    // The day after A's Fri finish is a Saturday, so the milestone's
    // calendar-aware FS start snaps to Mon Jan 20 (issue #1493) — 9 days vs
    // the original Jan 11, not the calendar-blind Jan 18 (7 days).
    expect(worstMilestone?.deltaDays).toBe(9); // Jan 20 vs Jan 11
  });

  it('returns null worstMilestone when no milestones present', () => {
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')];
    const { worstMilestone } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(worstMilestone).toBeNull();
  });

  it('handles chains of 3+ tasks', () => {
    // A (2d) → B (2d) → C (2d); drag A by +7
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-07'),
      task('B', '2025-01-08', '2025-01-09'),
      task('C', '2025-01-10', '2025-01-11'),
    ];
    const edges: CpmEdge[] = [edge('A', 'B'), edge('B', 'C')];
    const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-13');
    const c = results.find((r) => r.taskId === 'C')!;
    // A: Jan 13–14, B: Jan 15–16, C starts Jan 17 (Fri); its own 2-day span
    // skips the weekend before landing on Jan 20 (issue #1493).
    expect(c.earlyStart).toBe('2025-01-17');
    expect(c.earlyFinish).toBe('2025-01-20');
  });

  it('propagates SF dependency correctly', () => {
    // A (5d) → SF → B (3d): B finishes no earlier than A starts.
    // Drag A to Jan 13 (Mon) → the finish-side constraint (Jan 13) walked
    // back 3 working days lands B's earlyStart on Jan 9 (Thu) — skipping the
    // weekend in between (issue #1493) — finishing Jan 13.
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-06', '2025-01-08'), // 3 days, starts before the constraint
    ];
    const { results } = runCpmForwardPass(
      tasks,
      [edge('A', 'B', 'SF')],
      'A',
      '2025-01-13',
    );
    const b = results.find((r) => r.taskId === 'B')!;
    expect(b.earlyStart).toBe('2025-01-09');
    expect(b.earlyFinish).toBe('2025-01-13');
  });

  // -------------------------------------------------------------------------
  // Calendar-aware day math (issue #1493)
  // -------------------------------------------------------------------------

  describe('calendar-aware day math (issue #1493)', () => {
    it('skips the weekend when an FS chain crosses one', () => {
      // A (5d, Mon–Fri) → FS → B (3d). Drag A to start Fri 2025-01-10 (still
      // a working day) → A spans Fri, then skips the weekend and continues
      // Mon–Thu (5 working days: Jan10, Jan13, Jan14, Jan15, Jan16) →
      // finishes Thu 2025-01-16. B must start the next working day, Fri
      // 2025-01-17, and span 3 working days (Fri, Mon, Tue) → finishes
      // 2025-01-21. A calendar-blind engine would finish A on 2025-01-14
      // (raw +4 days) and B on 2025-01-17 — this test would still pass by
      // coincidence for B's start, so the A-finish assertion is the one that
      // catches the calendar-blind bug.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-10'),
        task('B', '2025-01-11', '2025-01-13'),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'FS')];
      const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-10');
      const a = results.find((r) => r.taskId === 'A')!;
      const b = results.find((r) => r.taskId === 'B')!;

      expect(a.earlyStart).toBe('2025-01-10');
      expect(a.earlyFinish).toBe('2025-01-16'); // skips Jan11–12 weekend
      expect(b.earlyStart).toBe('2025-01-17');
      expect(b.earlyFinish).toBe('2025-01-21'); // skips Jan18–19 weekend
    });

    it('snaps a drag onto a weekend forward to the next working day', () => {
      const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')]; // 5d
      // Drag to Saturday 2025-01-11 — must snap to Monday 2025-01-13.
      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-11');
      expect(results[0].earlyStart).toBe('2025-01-13');
      expect(results[0].earlyFinish).toBe('2025-01-17');
    });

    it('recomputes finish from working-day duration, not a fixed calendar-ms span', () => {
      // A explicitly carries durationDays = 5 even though its original dates
      // (Mon–Fri) span exactly 5 calendar days too — dragging it to a start
      // that crosses a weekend must still honor the 5 *working*-day duration.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-10', { durationDays: 5 }),
      ];
      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-08'); // Wed
      // Wed, Thu, Fri, (skip Sat/Sun), Mon, Tue = 5 working days
      expect(results[0].earlyFinish).toBe('2025-01-14');
    });
  });

  // -------------------------------------------------------------------------
  // Lag threading (issue #1493)
  // -------------------------------------------------------------------------

  describe('lag threading (issue #1493)', () => {
    it('applies positive lag on an FS edge', () => {
      // A (2d, Mon–Tue) → FS lag=2 → B (2d). B would start Wed without lag;
      // +2 calendar days lands on Fri (still a working day) → no snap needed.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-07'),
        task('B', '2025-01-08', '2025-01-09'),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'FS', 2)];
      const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-06');
      const b = results.find((r) => r.taskId === 'B')!;
      expect(b.earlyStart).toBe('2025-01-10'); // Fri: Jan8 (no-lag start) + 2d
      expect(b.earlyFinish).toBe('2025-01-13'); // 2 working days: Fri, then Mon (skips weekend)
    });

    it('snaps an FS edge with lag landing on a weekend to the next working day', () => {
      // A (2d, Mon–Tue) → FS lag=3 → B. No-lag start would be Wed Jan8;
      // +3 calendar days = Sat Jan11 → snaps forward to Mon Jan13.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-07'),
        task('B', '2025-01-08', '2025-01-09'),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'FS', 3)];
      const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-06');
      const b = results.find((r) => r.taskId === 'B')!;
      expect(b.earlyStart).toBe('2025-01-13');
    });

    it('applies negative lag (lead) on an SS edge', () => {
      // A (5d) → SS lag=-2 → B: B may start 2 calendar days before A starts.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-10'),
        task('B', '2025-01-06', '2025-01-08'),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'SS', -2)];
      // Drag A to start Jan 13 (Mon) → B's SS-with-lead constraint = Jan 11
      // (Sat) → snaps forward to Jan 13 (Mon) since a lead cannot pull the
      // constraint before the nearest working day.
      const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-13');
      const b = results.find((r) => r.taskId === 'B')!;
      expect(b.earlyStart).toBe('2025-01-13');
    });
  });

  // -------------------------------------------------------------------------
  // Real float / CP-flip fix (issue #1493)
  // -------------------------------------------------------------------------

  describe('CP-flip badge uses real float, not a finish/baseline proxy', () => {
    it('flags critical when the new finish lands exactly on lateFinish (zero float)', () => {
      // Before the fix, `>` (not `>=`) meant a task landing exactly on its
      // late finish — the textbook zero-float definition of "critical" — was
      // never flagged, only an overrun was.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-01-17' }),
      ];
      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
      expect(results[0].earlyFinish).toBe('2025-01-17');
      expect(results[0].isCritical).toBe(true);
    });

    it('does not flag critical when ample real float remains, even though the task slipped', () => {
      // This is the scenario the wrong-proxy bug broke: a task using its own
      // (pre-drag) finish as a lateFinish stand-in would flag ANY slip as
      // critical. With a real, generous lateFinish, a slipping-but-still-safe
      // task must not be flagged.
      const tasks: CpmTask[] = [
        task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-02-01' }),
      ];
      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
      expect(results[0].deltaDays).toBeGreaterThan(0); // it did slip
      expect(results[0].isCritical).toBe(false); // but well within float
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-0132 progress semantics (issue #2813)
//
// Every expectation below is hand-computed against the server's forward pass
// (`engine.py::_forward_pass` / `_pinned_placement` / `_effective_duration_days`
// / `_compute_scheduled_start`), because the whole point of the fix is that the
// preview and the commit agree. All dates are 2026: Jan 5 is a Monday, so
// Mon–Fri weeks fall on 5/12/19/26 and the fixtures read cleanly.
// ---------------------------------------------------------------------------

describe('runCpmForwardPass — ADR-0132 progress semantics', () => {
  describe('completed work is pinned', () => {
    it('does not move a pinned task, and stops the cascade at it', () => {
      // P → FS → C(complete, actuals recorded) → FS → D
      // `_pinned_placement` takes C out of network logic entirely, so dragging
      // P has no effect on C — and therefore none on D either. Before the fix
      // the ripple ran straight through C and pushed both.
      const tasks: CpmTask[] = [
        task('P', '2026-01-05', '2026-01-09'),
        task('C', '2026-01-12', '2026-01-16', {
          isComplete: true,
          actualStart: '2026-01-12',
          actualFinish: '2026-01-16',
        }),
        task('D', '2026-01-19', '2026-01-21'),
      ];
      const edges: CpmEdge[] = [edge('P', 'C', 'FS'), edge('C', 'D', 'FS')];

      const { results } = runCpmForwardPass(tasks, edges, 'P', '2026-03-02');
      const byId = (id: string) => results.find((r) => r.taskId === id)!;

      expect(byId('P').earlyStart).toBe('2026-03-02');
      expect(byId('P').earlyFinish).toBe('2026-03-06');

      expect(byId('C').earlyStart).toBe('2026-01-12');
      expect(byId('C').earlyFinish).toBe('2026-01-16');
      expect(byId('C').deltaDays).toBe(0);

      expect(byId('D').earlyStart).toBe('2026-01-19');
      expect(byId('D').deltaDays).toBe(0);
    });

    it('keeps the pinned finish feeding successors that are not yet clear of it', () => {
      // Same pin, but D currently starts BEFORE C's finish allows. The pin
      // removes C from the recompute without removing it from the network:
      // its unchanged finish still pushes D to the next working day after it.
      const tasks: CpmTask[] = [
        task('C', '2026-01-12', '2026-01-16', {
          isComplete: true,
          actualStart: '2026-01-12',
          actualFinish: '2026-01-16',
        }),
        task('D', '2026-01-06', '2026-01-08'),
      ];
      const edges: CpmEdge[] = [edge('C', 'D', 'FS')];

      const { results } = runCpmForwardPass(tasks, edges, 'C', '2026-04-06');
      const byId = (id: string) => results.find((r) => r.taskId === id)!;

      // The drag target itself is pinned — the drop is ignored, exactly as the
      // server ignores `planned_start` on a task with recorded actuals.
      expect(byId('C').earlyStart).toBe('2026-01-12');
      expect(byId('C').earlyFinish).toBe('2026-01-16');
      // …and its finish still constrains D: Jan 17 is a Saturday → Jan 19.
      expect(byId('D').earlyStart).toBe('2026-01-19');
      expect(byId('D').earlyFinish).toBe('2026-01-21');
    });

    it('still schedules a complete-without-actuals task through the network', () => {
      // `_pinned_placement` returns None for this case: completion by
      // percent_complete alone, with no actuals, takes an ordinary
      // full-duration position. Pinning on `isComplete` alone would be wrong.
      const tasks: CpmTask[] = [
        task('A', '2026-01-05', '2026-01-09'),
        task('B', '2026-01-12', '2026-01-14', { isComplete: true }),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'FS')];

      const { results } = runCpmForwardPass(tasks, edges, 'A', '2026-03-02');
      const b = results.find((r) => r.taskId === 'B')!;

      // A finishes Mar 6 (Fri) → Mar 7 is a Saturday → B starts Mar 9, and
      // keeps its FULL 3-day duration (ADR-0136), not a collapsed remainder.
      expect(b.earlyStart).toBe('2026-03-09');
      expect(b.earlyFinish).toBe('2026-03-11');
    });
  });

  describe('in-progress work contributes only its remaining duration', () => {
    it('lays the remaining duration ahead of the successors, not the full one', () => {
      // B is a 10-day task at 80%: 2 days left. The server pushes 2 days in
      // front of anything downstream; the pre-fix preview pushed all 10.
      const tasks: CpmTask[] = [
        task('A', '2026-01-05', '2026-01-09'),
        task('B', '2026-01-05', '2026-02-03', {
          durationDays: 10,
          remainingDuration: 2,
          actualStart: '2026-01-05',
        }),
      ];
      const edges: CpmEdge[] = [edge('A', 'B', 'FS')];

      const { results } = runCpmForwardPass(tasks, edges, 'A', '2026-03-02');
      const b = results.find((r) => r.taskId === 'B')!;

      // A finishes Mar 6 (Fri); Mar 7 is a Saturday → B's remaining window
      // opens Mar 9 (Mon) and closes Mar 10 — two working days, not ten
      // (which would have landed on Mar 20).
      expect(b.earlyFinish).toBe('2026-03-10');
      // The SPAN start does not move: work began Jan 5 and still did
      // (`_compute_scheduled_start` → actual_start).
      expect(b.earlyStart).toBe('2026-01-05');
    });

    it('floors the dragged in-progress task at its recorded actual start', () => {
      // Dropping a started task before the day work actually began is not a
      // reschedule the server will honor — `es_constraints` includes
      // actual_start, so the early window cannot precede it.
      const tasks: CpmTask[] = [
        task('B', '2026-01-05', '2026-02-03', {
          durationDays: 10,
          remainingDuration: 2,
          actualStart: '2026-01-05',
        }),
      ];

      const { results } = runCpmForwardPass(tasks, [], 'B', '2025-12-01');

      expect(results[0].earlyStart).toBe('2026-01-05');
      expect(results[0].earlyFinish).toBe('2026-01-06');
    });

    it('moves only the finish side when a started task is dragged later', () => {
      // planned_start moves past actual_start, so the span start follows the
      // drop (`max(planned_start, scheduled_start)`) while the window carries
      // the remaining 2 days.
      const tasks: CpmTask[] = [
        task('B', '2026-01-05', '2026-02-03', {
          durationDays: 10,
          remainingDuration: 2,
          actualStart: '2026-01-05',
        }),
      ];

      const { results } = runCpmForwardPass(tasks, [], 'B', '2026-02-16');

      expect(results[0].earlyStart).toBe('2026-02-16');
      expect(results[0].earlyFinish).toBe('2026-02-17');
    });
  });

  describe('the dragged task is floored at the data date', () => {
    it('resolves a drop in the past to the data date', () => {
      const tasks: CpmTask[] = [task('A', '2026-01-05', '2026-01-09')];

      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-12-01', '2026-01-05');

      expect(results[0].earlyStart).toBe('2026-01-05');
      expect(results[0].earlyFinish).toBe('2026-01-09');
    });

    it('applies no data-date floor when the caller supplies none', () => {
      // The `?? today` resolution is the caller's job (ScheduleView), which
      // keeps this engine a pure function and its fixtures from decaying
      // against the wall clock.
      const tasks: CpmTask[] = [task('A', '2026-01-05', '2026-01-09')];

      const { results } = runCpmForwardPass(tasks, [], 'A', '2025-12-01');

      expect(results[0].earlyStart).toBe('2025-12-01');
      expect(results[0].earlyFinish).toBe('2025-12-05');
    });
  });

  it('previews a complete → in-progress → future chain the way the server computes it', () => {
    // C1 complete with actuals (pinned), C2 a 10-day task with 4 days left,
    // C3 not started. Dragging C2 to Feb 16 must leave C1 alone, lay C2's
    // four remaining days from the drop, and cascade only that much onto C3.
    const tasks: CpmTask[] = [
      task('C1', '2026-01-05', '2026-01-09', {
        isComplete: true,
        actualStart: '2026-01-05',
        actualFinish: '2026-01-09',
      }),
      task('C2', '2026-01-12', '2026-01-30', {
        durationDays: 10,
        remainingDuration: 4,
        actualStart: '2026-01-12',
      }),
      task('C3', '2026-02-02', '2026-02-04'),
    ];
    const edges: CpmEdge[] = [edge('C1', 'C2', 'FS'), edge('C2', 'C3', 'FS')];

    const { results } = runCpmForwardPass(tasks, edges, 'C2', '2026-02-16');
    const byId = (id: string) => results.find((r) => r.taskId === id)!;

    // C1: pinned to its actuals, untouched.
    expect(byId('C1').earlyStart).toBe('2026-01-05');
    expect(byId('C1').earlyFinish).toBe('2026-01-09');
    expect(byId('C1').deltaDays).toBe(0);

    // C2: four remaining working days from Mon Feb 16 → Thu Feb 19. With the
    // full ten it would have run to Feb 27.
    expect(byId('C2').earlyStart).toBe('2026-02-16');
    expect(byId('C2').earlyFinish).toBe('2026-02-19');

    // C3: the day after C2's finish is Fri Feb 20 → three working days to
    // Tue Feb 24 (Feb 21/22 are the weekend).
    expect(byId('C3').earlyStart).toBe('2026-02-20');
    expect(byId('C3').earlyFinish).toBe('2026-02-24');
  });

  it('translates an FF constraint through the remaining duration, not the full one', () => {
    // B is a 10-day task with 3 days left, finish-to-finish with A. Backing the
    // FULL ten days off A's finish would put B's window in February and let it
    // finish BEFORE A — silently breaking the very constraint being applied.
    const tasks: CpmTask[] = [
      task('A', '2026-01-05', '2026-01-09'),
      task('B', '2026-01-05', '2026-01-30', {
        durationDays: 10,
        remainingDuration: 3,
        actualStart: '2026-01-05',
      }),
    ];
    const edges: CpmEdge[] = [edge('A', 'B', 'FF')];

    const { results } = runCpmForwardPass(tasks, edges, 'A', '2026-03-02');
    const byId = (id: string) => results.find((r) => r.taskId === id)!;

    expect(byId('A').earlyFinish).toBe('2026-03-06');
    // B lands exactly on A's finish, which is what FF means.
    expect(byId('B').earlyFinish).toBe('2026-03-06');
    expect(byId('B').earlyStart).toBe('2026-01-05');
  });
});
