import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runCpmForwardPass } from './cpmEngine';
import type { CpmEdge, CpmTask } from './cpmWorker.types';

// Why this file exists, and why it checks so little (issue #3091).
//
// `packages/scheduler/tests/test_wasm_conformance.py` proves the Python and Rust
// engines agree on the shared fixtures. Neither of them is what a browser runs
// during a drag: per ADR-0015's 2026-04-13 amendment the preview worker uses this
// native TypeScript engine on purpose, so nothing checked it against the same
// fixtures the two server engines are held to.
//
// The scope boundary USED to be a quote from ADR-0015's 2026-04-13 amendment,
// saying `cpmEngine.ts` "lacks: backward pass, float computation, calendar
// awareness, all four dependency types (SS/FF/SF), and `planned_start` (SNET)
// constraint support". That description went stale without anything noticing:
// the shipped engine implements SS/FF/SF, calendar-aware day stepping and
// negative lag (#1493), the ADR-0132 progress floors (#2813, #3053), and now
// SNET (#3535). The allowlist was still sized to the 2026-04-13 sentence — 3 of
// 32 shared fixtures — which is how BOTH #3535 mechanisms reached production
// under a green conformance gate.
//
// So the scope is now stated as a measured fact rather than a quotation. Every
// fixture is classified exactly once, either in IN_SCOPE_FIXTURES (asserted
// date-for-date against the Python engine) or in OUT_OF_SCOPE with the specific
// capability it needs. `classifies every shared fixture` fails when a new
// fixture is added and named in neither — the ratchet that stops this list
// silently falling behind the engine a second time.
//
// Still deliberately NOT full conformance: only the forward pass
// (`early_start` / `early_finish`) is asserted. Late dates, floats,
// `is_critical` and the critical path are not computed by this engine at all.

const SECONDS_PER_DAY = 86_400;

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../wasm-scheduler/fixtures',
);

/**
 * Fixtures within `cpmEngine.ts`'s measured capability — asserted date-for-date
 * against the Python engine's expected output.
 *
 * The list is explicit rather than derived so the scope decision is reviewable,
 * and `describes a fixture cpmEngine.ts can actually schedule` re-checks each
 * entry against the predicate — a fixture that gains a calendar exception or a
 * SNET constraint fails there rather than producing a mystery date mismatch
 * below.
 *
 * Widened from 3 to 11 in #3535. The eight additions cover the four dependency
 * types, positive and negative lag, and the weekend arithmetic around each —
 * all capability the engine has had since #1493 and that nothing was checking.
 */
const IN_SCOPE_FIXTURES = [
  'basic_fs_chain',
  'diamond_graph',
  'milestone_tasks',
  'fs_lag_weekend',
  'fs_negative_lag',
  'fs_negative_lag_weekend',
  'max_duration_boundary',
  'ff_lag_weekend',
  'sf_lag_weekend',
  'ss_lag_weekend',
  'ss_connected_critical',
] as const;

/**
 * Every other shared fixture, with the reason it cannot be asserted here.
 *
 * This is the half that keeps the gate honest. An allowlist alone cannot
 * distinguish "deliberately excluded" from "nobody looked", and that ambiguity
 * is exactly what let a 3-fixture list survive four capability expansions. A
 * reason recorded here is a claim someone can check; an absence is not.
 *
 * `engine gap` entries are real divergences from the Python engine, measured in
 * #3535 — not adapter limitations. They are the honest cost of ADR-0599's
 * preview carve-out, and each is reconciled by the server on commit.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  // Adapter limitations — the harness below places exactly one source task.
  all_dep_types: 'adapter: 4 source tasks',
  parallel_critical: 'adapter: 2 source tasks',
  canonical_to_json_roundtrip: 'serialization fixture, not a scheduling scenario',
  // Calendar capability the browser does not have at drag time (ADR-0120).
  calendar_exceptions: 'engine gap: CalendarException holidays not modeled',
  fs_lag_holiday_week: 'engine gap: CalendarException holidays not modeled',
  six_day_mask: 'engine gap: fixed Mon-Fri week, no six-day mask',
  ss_lag_alt_weekend: 'engine gap: fixed Mon-Fri week, alternate weekend mask',
  per_task_calendar_duration: 'engine gap: per-task calendars not modeled',
  per_task_calendar_six_day: 'engine gap: per-task calendars not modeled',
  per_task_calendar_backward_float: 'engine gap: per-task calendars not modeled',
  per_task_calendar_fs_lag_both_directions: 'engine gap: per-task calendars not modeled',
  // The engine applies SNET (#3535) but the harness seeds every task at the
  // project start, which is not how a fixture's own planned_start reads.
  planned_start_snet: 'adapter: seeds all tasks at project start, overriding SNET',
  // Progress fixtures need actuals and a status date threaded through the
  // adapter; the engine implements the floors (#2813), the harness does not
  // feed them. Tracked as the next widening step.
  progress_completed_pin: 'adapter: does not thread actuals/status date',
  progress_completed_percent_only_constraints: 'adapter: does not thread actuals/status date',
  progress_completed_successor_no_backward_constraint:
    'adapter: does not thread actuals/status date',
  progress_in_progress_remaining: 'adapter: does not thread actuals/status date',
  progress_actual_start_floors_early_start: 'adapter: does not thread actuals/status date',
  progress_out_of_sequence: 'adapter: does not thread actuals/status date',
  progress_status_date_floor: 'adapter: does not thread actuals/status date',
  progress_weekend_finish_late_seed: 'adapter: does not thread actuals/status date',
  // A genuine forward-pass divergence, unrelated to calendars or the adapter.
  fs_negative_lag_floored: 'engine gap: negative lag is not floored at the project start',
};

interface FixtureTask {
  id: string;
  name: string;
  duration: number;
  planned_start?: string | null;
  planned_finish?: string | null;
  percent_complete?: number | null;
  actual_start?: string | null;
  actual_finish?: string | null;
  calendar_id?: string | null;
}

interface FixtureDependency {
  predecessor_id: string;
  successor_id: string;
  dep_type: string;
  lag: number;
}

interface Fixture {
  id: string;
  start_date: string;
  tasks: FixtureTask[];
  dependencies: FixtureDependency[];
  calendar: { working_days: number; exceptions: unknown[] };
  calendars?: unknown;
}

interface ExpectedTask {
  id: string;
  early_start: string;
  early_finish: string;
  scheduled_start: string;
}

interface Expected {
  tasks: ExpectedTask[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const loadFixture = (name: string): Fixture =>
  readJson<Fixture>(resolve(FIXTURES_DIR, `${name}.json`));

const loadExpected = (name: string): Expected =>
  readJson<Expected>(resolve(FIXTURES_DIR, 'expected', `${name}.json`));

/** Task ids with no incoming dependency — the tasks the network cannot derive. */
function sourceIds(fixture: Fixture): string[] {
  const withPredecessor = new Set(fixture.dependencies.map((d) => d.successor_id));
  return fixture.tasks.map((t) => t.id).filter((id) => !withPredecessor.has(id));
}

/**
 * Translate a shared fixture into the worker's wire shape.
 *
 * Every task is seeded at the project start, and the pass then places each one
 * AT its binding predecessor constraint — so the seed is a placeholder, not an
 * input to the answer. This used to rest on `relaxForward` being forward-only
 * (a seed at or before the true answer could only be pushed up to it); since
 * #3535 the pass relaxes in both directions, which makes the seed irrelevant
 * rather than merely harmless, and these fixtures produce identical output
 * either way. The single task the network does not derive is the source, which
 * the engine places from `newStartIso` — the same code path a drag uses.
 *
 * `statusDate` is deliberately omitted so no data-date floor applies (the
 * server fixtures carry none either), and no `plannedStart` is threaded, which
 * is why `planned_start_snet` sits in OUT_OF_SCOPE.
 */
function toWireSubgraph(fixture: Fixture): {
  tasks: CpmTask[];
  edges: CpmEdge[];
  sourceId: string;
} {
  const seed = fixture.start_date;
  const tasks: CpmTask[] = fixture.tasks.map((t) => ({
    id: t.id,
    earlyStart: seed,
    earlyFinish: seed,
    // Only feeds `isCritical`, which this suite does not assert — there is no
    // backward pass to produce a real late finish.
    lateFinish: seed,
    durationDays: t.duration / SECONDS_PER_DAY,
    isMilestone: t.duration === 0,
    name: t.name,
  }));
  const edges: CpmEdge[] = fixture.dependencies.map((d) => ({
    sourceId: d.predecessor_id,
    targetId: d.successor_id,
    type: d.dep_type as CpmEdge['type'],
    lag: d.lag / SECONDS_PER_DAY,
  }));
  return { tasks, edges, sourceId: sourceIds(fixture)[0] };
}

describe('cpmEngine forward-pass conformance with the shared scheduler fixtures', () => {
  it('names at least one in-scope fixture', () => {
    // Non-vacuity: an empty list would make every assertion below unreachable
    // while the suite still reported green.
    expect(IN_SCOPE_FIXTURES.length).toBeGreaterThan(0);
  });

  it('classifies every shared fixture as in scope or explicitly out of scope', () => {
    // The ratchet (#3535). A new shared fixture that this engine is never run
    // against is invisible — which is how a 3-of-32 allowlist survived four
    // capability expansions and let both #3535 mechanisms ship. Adding a
    // fixture now forces a one-line decision: assert it, or say why not.
    const fixtureNames = readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));

    // Guard the guard: a wrong FIXTURES_DIR would make this pass on an empty
    // list while proving nothing.
    expect(fixtureNames.length).toBeGreaterThan(20);

    const classified = new Set<string>([...IN_SCOPE_FIXTURES, ...Object.keys(OUT_OF_SCOPE)]);
    const unclassified = fixtureNames.filter((n) => !classified.has(n));
    expect(unclassified, 'add these to IN_SCOPE_FIXTURES or OUT_OF_SCOPE').toEqual([]);
  });

  it('does not both assert and excuse the same fixture', () => {
    const contradictory = IN_SCOPE_FIXTURES.filter((n) => n in OUT_OF_SCOPE);
    expect(contradictory).toEqual([]);
  });

  describe.each(IN_SCOPE_FIXTURES)('%s', (name) => {
    it('describes a fixture cpmEngine.ts can actually schedule', () => {
      const fixture = loadFixture(name);

      // The engine hardcodes a Mon–Fri week (0b0011111 = 31) and models no
      // holidays, so anything else is a calendar it cannot reproduce.
      expect(fixture.calendar.working_days).toBe(31);
      expect(fixture.calendar.exceptions).toEqual([]);
      expect(fixture.calendars ?? null).toBeNull();
      for (const t of fixture.tasks) {
        expect(t.planned_start ?? null).toBeNull(); // no SNET support
        expect(t.calendar_id ?? null).toBeNull(); // no per-task calendars
        expect(t.actual_start ?? null).toBeNull();
        expect(t.actual_finish ?? null).toBeNull();
        expect(t.percent_complete ?? 0).toBe(0);
      }
      // The adapter derives exactly one task's dates from `newStartIso`; a
      // second source would keep its seeded dates and silently mis-compare.
      expect(sourceIds(fixture)).toHaveLength(1);
    });

    it('matches the expected early_start / early_finish for every task', () => {
      const fixture = loadFixture(name);
      const expected = loadExpected(name);
      const { tasks, edges, sourceId } = toWireSubgraph(fixture);

      const { results } = runCpmForwardPass(tasks, edges, sourceId, fixture.start_date);

      expect(results).toHaveLength(fixture.tasks.length);
      const byId = new Map(results.map((r) => [r.taskId, r]));

      for (const et of expected.tasks) {
        // `PreviewTaskResult.earlyStart` carries the SPAN start (ADR-0752's
        // `scheduled_start`), which coincides with `early_start` only on
        // progress-free work — pin that so the comparison below stays honest if
        // a fixture ever grows an actual start.
        expect(et.scheduled_start).toBe(et.early_start);

        const actual = byId.get(et.id);
        expect(actual, `no preview result for task ${et.id}`).toBeDefined();
        expect(actual!.earlyStart, `${et.id}: early_start`).toBe(et.early_start);
        expect(actual!.earlyFinish, `${et.id}: early_finish`).toBe(et.early_finish);
      }
    });
  });
});
