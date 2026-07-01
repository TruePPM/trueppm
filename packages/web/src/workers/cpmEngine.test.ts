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
