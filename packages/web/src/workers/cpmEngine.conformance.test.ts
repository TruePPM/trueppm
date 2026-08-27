import { readFileSync } from 'node:fs';
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
// The scope boundary is ADR-0015's own: `cpmEngine.ts` "lacks: backward pass,
// float computation, calendar awareness, all four dependency types (SS/FF/SF),
// and `planned_start` (SNET) constraint support". So this is deliberately NOT
// full conformance — it runs only fixtures inside that reduced capability
// (FS-only, default Mon–Fri calendar, no exceptions, no SNET, no progress) and
// asserts only the forward pass (`early_start` / `early_finish`). Late dates,
// floats, `is_critical` and the critical path are not computed here at all;
// comparing them would fail on a documented capability gap rather than on a
// regression. Widen this only when the engine's capability widens.

const SECONDS_PER_DAY = 86_400;

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../wasm-scheduler/fixtures',
);

/**
 * Fixtures within `cpmEngine.ts`'s declared capability.
 *
 * The list is explicit rather than derived so the scope decision is reviewable,
 * and `describes a fixture cpmEngine.ts can actually schedule` re-checks each
 * entry against the predicate — a fixture that gains an SS edge, a calendar
 * exception or a SNET constraint fails there rather than producing a mystery
 * date mismatch below.
 */
const IN_SCOPE_FIXTURES = ['basic_fs_chain', 'diamond_graph', 'milestone_tasks'] as const;

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
 * Every task is seeded at the project start. `relaxForward` only ever pushes a
 * task FORWARD, so a seed at or before the true answer lands exactly on the
 * binding predecessor constraint; the single task the network does not derive is
 * the source, which the engine places from `newStartIso` — the same code path a
 * drag uses. `statusDate` is deliberately omitted so no data-date floor applies
 * (the server fixtures carry none either).
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

  describe.each(IN_SCOPE_FIXTURES)('%s', (name) => {
    it('describes a fixture cpmEngine.ts can actually schedule', () => {
      const fixture = loadFixture(name);

      // All four dependency types exist in the wire type, but only FS is
      // exercised here: SS/FF/SF are outside ADR-0015's declared scope.
      expect(fixture.dependencies.map((d) => d.dep_type)).toEqual(
        fixture.dependencies.map(() => 'FS'),
      );
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
