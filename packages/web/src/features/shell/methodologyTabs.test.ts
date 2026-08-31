import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  isTabVisibleForMethodology,
  groupedVisibleViews,
  groupedVisibleViewsForUser,
  surfaceHiddenViews,
  ALWAYS_ON_VIEW_KEYS,
  HIDEABLE_VIEW_KEYS,
  VIEW_GROUPS,
} from './methodologyTabs';

/**
 * The web half of the cross-language nav-vocabulary contract (ADR-0942 §6). Its pytest
 * counterpart is `packages/api/tests/apps/profiles/test_hideable_views_contract.py`,
 * which asserts the same file against `apps/profiles/constants.py`. Read off disk rather
 * than imported so the file has exactly one representation and neither language can
 * "satisfy" the contract with its own copy of it.
 *
 * Walk up for the checkout root instead of counting `../`, so moving this spec produces a
 * clear failure here rather than a path error pointing at the contract.
 */
function readVocabularyContract(): { hideable: string[]; alwaysOn: string[] } {
  // Anchored on a repo marker (`.git` — a file in a git worktree, a directory in a
  // normal checkout), not merely on finding a `contracts/` directory. An unanchored
  // probe that misses the in-repo copy keeps climbing into the CI build dir and `$HOME`,
  // where a stray `contracts/hideable-views.json` would be silently adopted — the drift
  // gate would pass while validating a vocabulary from outside the repo.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.git'))) {
      const contract = resolve(dir, 'contracts/hideable-views.json');
      if (!existsSync(contract)) {
        throw new Error(
          `Found the checkout root at ${dir} but no contracts/hideable-views.json in ` +
            'it — the cross-language nav vocabulary contract is missing (ADR-0942 §6). ' +
            'If you just created it, `git add` it.',
        );
      }
      return JSON.parse(readFileSync(contract, 'utf-8')) as {
        hideable: string[];
        alwaysOn: string[];
      };
    }
    dir = resolve(dir, '..');
  }
  throw new Error(
    'No checkout root (a directory containing .git) found above this spec — cannot ' +
      'locate contracts/hideable-views.json (ADR-0942 §6).',
  );
}

// Encodes the ADR-0041 visibility matrix as a single source of truth.
// Amended by ADR-0053: `wbs` and `list` consolidated into `grid`, visible in
// all three methodologies. Outline mode (formerly WBS) is the default for
// WATERFALL/HYBRID; Flat mode is the default for AGILE.
const MATRIX: Record<'WATERFALL' | 'AGILE' | 'HYBRID', Record<string, boolean>> = {
  WATERFALL: {
    overview: true,
    board: true,
    'product-backlog': false,
    sprints: false,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
  AGILE: {
    overview: true,
    board: true,
    'product-backlog': true,
    sprints: true,
    schedule: false,
    grid: true,
    calendar: false,
    resources: true,
    risk: true,
  },
  HYBRID: {
    overview: true,
    board: true,
    'product-backlog': true,
    sprints: true,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
};

describe('isTabVisibleForMethodology', () => {
  for (const [methodology, expectations] of Object.entries(MATRIX) as Array<
    [keyof typeof MATRIX, Record<string, boolean>]
  >) {
    for (const [view, expected] of Object.entries(expectations)) {
      it(`${methodology}: ${view} is ${expected ? 'visible' : 'hidden'}`, () => {
        expect(isTabVisibleForMethodology(view, methodology)).toBe(expected);
      });
    }
  }

  it('treats unknown views as visible (no false hides)', () => {
    // A future tab that hasn't been added to the matrix should default to
    // visible — methodology preset is a hide-list, not an allow-list.
    expect(isTabVisibleForMethodology('unknown-future-tab', 'WATERFALL')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'AGILE')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'HYBRID')).toBe(true);
  });
});

describe('the taxonomy (ADR-0942)', () => {
  it('assigns every view to exactly one band, for every methodology', () => {
    // The "a view in no band silently never renders" guard, now stated as the
    // one-home-per-render rule (ADR-0942 §3): a nav item listed twice is two objects to
    // the person using it. `board` moving between DELIVER and TRACK by methodology is
    // not a violation — it is in exactly one band for any given project — which is why
    // this is asserted per methodology rather than on VIEW_GROUPS alone.
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const views = groupedVisibleViews(m).flatMap((g) => g.visibleViews);
      expect(new Set(views).size).toBe(views.length);
    }
    const superset = VIEW_GROUPS.flatMap((g) => g.views);
    expect(new Set(superset).size).toBe(superset.length);
  });

  it('HYBRID surfaces PLAN / DELIVER / TRACK then the WORKSPACE scope band', () => {
    const groups = groupedVisibleViews('HYBRID');
    expect(groups.map((g) => g.id)).toEqual(['PLAN', 'DELIVER', 'TRACK', 'WORKSPACE']);
    const byId = (id: string) => groups.find((g) => g.id === id)?.visibleViews;
    expect(byId('PLAN')).toEqual(['schedule', 'grid', 'calendar']);
    expect(byId('DELIVER')).toEqual(['product-backlog', 'sprints', 'board']);
    expect(byId('TRACK')).toEqual(['overview', 'today', 'risk', 'reports', 'activity', 'assets']);
    expect(byId('WORKSPACE')).toEqual(['resources', 'settings']);
  });

  it('types the three lifecycle bands as verbs and WORKSPACE as a scope band', () => {
    // The `kind` is what the rail switches its container treatment on (rule + raised
    // ground + pinned position) and what the role lens skips. Asserting it here keeps a
    // future band from defaulting into the wrong container by omission.
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      for (const g of groupedVisibleViews(m)) {
        expect(g.kind).toBe(g.id === 'WORKSPACE' ? 'scope' : 'verb');
      }
    }
    expect(groupedVisibleViews('HYBRID').filter((g) => g.kind === 'scope')).toHaveLength(1);
  });

  it('ends the rail at the scope band — WORKSPACE is always last', () => {
    // ADR-0942 §2: the scope band's position is `margin-top: auto`, never a function of
    // how many bands sit above it. Drop DELIVER and the footer does not move.
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const ids = groupedVisibleViews(m).map((g) => g.id);
      expect(ids[ids.length - 1]).toBe('WORKSPACE');
    }
  });

  it('leads TRACK with overview (Dashboard), then today (ADR-0942 §8)', () => {
    // The landing route leads its own band; `today` leads the tracking sequence proper.
    // This also makes the desktop head order match mobile's, where ADR-0196 already fixes
    // overview first and today second (the #1324 guarantee).
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const track = groupedVisibleViews(m).find((g) => g.id === 'TRACK');
      expect(track?.visibleViews.slice(0, 2)).toEqual(['overview', 'today']);
    }
  });

  it('puts Team and Settings together in WORKSPACE — PEOPLE is retired (ADR-0942 §5)', () => {
    expect(VIEW_GROUPS.map((g) => g.id)).not.toContain('PEOPLE');
    const workspace = VIEW_GROUPS.find((g) => g.id === 'WORKSPACE');
    expect(workspace?.views).toEqual(['resources', 'settings']);
    // `resources` keeps the label "Team"; the band is named for the question it answers.
    expect(workspace?.label).toBe('Workspace');
  });

  // The DELIVER band's label is the fixed, terminology-neutral word — never the
  // configurable iteration term (Sprint/Iteration/Cycle/PI). ADR-0203 §12 invariant #5:
  // the iteration term lives on the *view*, so the band header can never be "Sprint".
  it('labels the DELIVER band with the fixed word "Deliver", never an iteration term', () => {
    const deliver = VIEW_GROUPS.find((g) => g.id === 'DELIVER');
    expect(deliver?.label).toBe('Deliver');
    // No band label may be a configurable iteration term.
    const iterationTerms = [
      'Sprint',
      'Sprints',
      'Iteration',
      'Iterations',
      'Cycle',
      'Cycles',
      'PI',
    ];
    for (const g of VIEW_GROUPS) {
      expect(iterationTerms).not.toContain(g.label);
    }
  });

  it('gives every band a sentence-case label, never its uppercase id', () => {
    // ADR-0942 §11 correction B: the visible header renders `group.id` ("PLAN") and is
    // aria-hidden; the accessible name comes from `label`. If a label ever equalled the
    // id, the band would be announced in uppercase — the exact read the aria-hidden
    // header exists to avoid.
    for (const g of VIEW_GROUPS) {
      expect(g.label).not.toBe(g.id);
      expect(g.label).toBe(g.label[0] + g.label.slice(1).toLowerCase());
    }
  });

  // The core issue-1466 guarantee: on cadence-running methodologies the daily circuit
  // (Backlog → Sprints → Board) is one contiguous, named band. ADR-0942 §4 retains
  // ADR-0195 §A′ in full.
  it.each(['AGILE', 'HYBRID'] as const)(
    '%s co-locates Backlog, Sprints and Board in a dedicated DELIVER band',
    (m) => {
      const deliver = groupedVisibleViews(m).find((g) => g.id === 'DELIVER');
      expect(deliver?.visibleViews).toEqual(['product-backlog', 'sprints', 'board']);
      // Board and Sprints are adjacent (acceptance criterion).
      const idx = deliver!.visibleViews;
      expect(idx.indexOf('board') - idx.indexOf('sprints')).toBe(1);
    },
  );

  it('WATERFALL has no DELIVER band and keeps Board in TRACK (ADR-0195 retained)', () => {
    const groups = groupedVisibleViews('WATERFALL');
    expect(groups.map((g) => g.id)).toEqual(['PLAN', 'TRACK', 'WORKSPACE']);
    expect(groups.find((g) => g.id === 'DELIVER')).toBeUndefined();
    const track = groups.find((g) => g.id === 'TRACK');
    expect(track?.visibleViews).toEqual([
      'overview',
      'today',
      'board',
      'risk',
      'reports',
      'activity',
      'assets',
    ]);
  });

  it('keeps calendar in PLAN on WATERFALL — moving it to DELIVER would delete it', () => {
    // ADR-0942 §4: HIDDEN_FOR_METHODOLOGY hides only sprints and product-backlog on
    // WATERFALL, so calendar is visible there — and WATERFALL has no DELIVER band. The
    // design brief's `DELIVER = Board · Sprints · Calendar` is a defect, not a preference.
    const plan = groupedVisibleViews('WATERFALL').find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toContain('calendar');
  });

  it('today (ADR-0180) is visible for every methodology and is hideable', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const track = groupedVisibleViews(m).find((g) => g.id === 'TRACK');
      expect(track?.visibleViews).toContain('today');
    }
    // It is a hideable view (unlike the always-on `overview`).
    expect(HIDEABLE_VIEW_KEYS.has('today')).toBe(true);
  });

  it('AGILE drops Schedule + Calendar so PLAN degenerates to Grid (ADR-0041 filter within band)', () => {
    const plan = groupedVisibleViews('AGILE').find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['grid']);
  });

  it('WATERFALL keeps the full PLAN (Schedule · Grid · Calendar)', () => {
    const plan = groupedVisibleViews('WATERFALL').find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['schedule', 'grid', 'calendar']);
  });

  it('never returns a band with zero visible views', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      for (const g of groupedVisibleViews(m)) {
        expect(g.visibleViews.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the hideability vocabulary (ADR-0942 §6)', () => {
  it('is authored, NOT derived from band membership', () => {
    // The regression this exists for: `HIDEABLE_VIEW_KEYS` used to be
    // `VIEW_GROUPS.flatMap(g => g.views)`. Under that derivation, moving `settings` into
    // a band silently makes it user-hideable — the client offers a toggle, the server
    // rejects the write with a 400, and the guarantee that a nav can never be emptied is
    // gone. If this assertion ever fails because someone "simplified" the set back to a
    // flatMap, that is the bug, not the test.
    const everyBandMember = VIEW_GROUPS.flatMap((g) => g.views);
    expect([...HIDEABLE_VIEW_KEYS].sort()).not.toEqual([...everyBandMember].sort());
  });

  it('invariant 1 — hideable and always-on are disjoint', () => {
    const overlap = [...HIDEABLE_VIEW_KEYS].filter((v) => ALWAYS_ON_VIEW_KEYS.has(v));
    expect(overlap).toEqual([]);
  });

  it('invariant 2 — every band member is in exactly one of the two sets', () => {
    // So a view added to a band can neither silently become hideable nor silently become
    // un-customizable. Asserted across every methodology, since `board` is only a member
    // of one band at a time.
    const members = new Set(
      (['WATERFALL', 'AGILE', 'HYBRID'] as const).flatMap((m) =>
        groupedVisibleViews(m).flatMap((g) => g.visibleViews),
      ),
    );
    for (const view of members) {
      expect(HIDEABLE_VIEW_KEYS.has(view) !== ALWAYS_ON_VIEW_KEYS.has(view)).toBe(true);
    }
    // And nothing is declared that is not a band member at all.
    for (const view of [...HIDEABLE_VIEW_KEYS, ...ALWAYS_ON_VIEW_KEYS]) {
      expect(members.has(view)).toBe(true);
    }
  });

  it('invariant 3 — matches the checked-in contract the server also asserts against', () => {
    const contract = readVocabularyContract();
    expect([...HIDEABLE_VIEW_KEYS].sort()).toEqual([...contract.hideable].sort());
    expect([...ALWAYS_ON_VIEW_KEYS].sort()).toEqual([...contract.alwaysOn].sort());
  });

  it('never lets overview or settings be hidden', () => {
    expect(HIDEABLE_VIEW_KEYS.has('overview')).toBe(false);
    expect(HIDEABLE_VIEW_KEYS.has('settings')).toBe(false);
    expect(ALWAYS_ON_VIEW_KEYS.has('overview')).toBe(true);
    expect(ALWAYS_ON_VIEW_KEYS.has('settings')).toBe(true);
  });
});

describe('groupedVisibleViewsForUser (ADR-0139)', () => {
  it('with no hidden views equals the plain methodology grouping', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      expect(groupedVisibleViewsForUser(m, new Set())).toEqual(groupedVisibleViews(m));
    }
  });

  it('removes a personally-hidden view from its band', () => {
    const groups = groupedVisibleViewsForUser('HYBRID', new Set(['schedule', 'calendar']));
    const plan = groups.find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['grid']);
  });

  it('hiding Team leaves the WORKSPACE band standing on Settings alone', () => {
    // The scope band renders with both, either, or neither member (ADR-0942 §2) — the
    // reachable case being a Member, for whom `resources` is role-gated away.
    const groups = groupedVisibleViewsForUser('HYBRID', new Set(['resources']));
    const workspace = groups.find((g) => g.id === 'WORKSPACE');
    expect(workspace?.visibleViews).toEqual(['settings']);
  });

  it('hiding the whole DELIVER circuit drops the DELIVER band (ADR-0195/ADR-0203)', () => {
    const groups = groupedVisibleViewsForUser(
      'HYBRID',
      new Set(['product-backlog', 'sprints', 'board']),
    );
    expect(groups.map((g) => g.id)).toEqual(['PLAN', 'TRACK', 'WORKSPACE']);
    expect(groups.find((g) => g.id === 'DELIVER')).toBeUndefined();
  });

  it('composes on top of the methodology filter — hiding an already-methodology-hidden view is a no-op', () => {
    // AGILE already hides schedule/calendar; the personal set cannot re-show them
    // and listing them changes nothing.
    const agile = groupedVisibleViewsForUser('AGILE', new Set(['schedule']));
    expect(agile).toEqual(groupedVisibleViews('AGILE'));
  });

  it('a hidden set covering EVERY hideable view still leaves Dashboard and Settings', () => {
    // The always-on guarantee, asserted at the composition seam rather than left to the
    // presentation. Before ADR-0942 this returned `[]` and the nav was saved by `overview`
    // being rendered outside the bands; now every view is a band member, so if this
    // regressed the user would genuinely empty their own rail.
    const groups = groupedVisibleViewsForUser('HYBRID', HIDEABLE_VIEW_KEYS);
    expect(groups.map((g) => g.id)).toEqual(['TRACK', 'WORKSPACE']);
    expect(groups.flatMap((g) => g.visibleViews)).toEqual(['overview', 'settings']);
  });

  it('ignores an always-on key smuggled into the hidden set', () => {
    // The server rejects these with a 400, so a well-formed profile cannot carry them —
    // but a stale or hand-crafted `hidden_views` must not be able to empty a nav either.
    const groups = groupedVisibleViewsForUser('HYBRID', new Set(['overview', 'settings']));
    expect(groups).toEqual(groupedVisibleViews('HYBRID'));
  });

  it('has no Schedule-in-Deliver placement argument any more (ADR-0942 §3, #3137)', () => {
    // One home per item, per render. `schedule` appears in PLAN and nowhere else.
    const groups = groupedVisibleViewsForUser('HYBRID', new Set());
    const withSchedule = groups.filter((g) => g.visibleViews.includes('schedule'));
    expect(withSchedule.map((g) => g.id)).toEqual(['PLAN']);
    expect(groupedVisibleViewsForUser).toHaveLength(2);
  });
});

describe('surfaceHiddenViews (ADR-0193, #956)', () => {
  it('returns ["reports"] when reporting is false', () => {
    expect(surfaceHiddenViews({ reporting: false })).toEqual(['reports']);
  });

  it('returns [] when reporting is true', () => {
    expect(surfaceHiddenViews({ reporting: true })).toEqual([]);
  });

  it('the other three surfaces do not contribute a tab-hide (they are in-view sub-surfaces)', () => {
    // time_tracking, baselines, monte_carlo gate components within a view, not
    // a tab entry — so they are not in the surfaceHiddenViews result. The function
    // only accepts { reporting }, so passing extra props is the type-level guarantee.
    expect(surfaceHiddenViews({ reporting: true })).not.toContain('schedule');
    expect(surfaceHiddenViews({ reporting: true })).not.toContain('board');
  });
});
