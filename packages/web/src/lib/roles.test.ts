/**
 * Tests for the role ordinals + UX write-gates in lib/roles (ADR-0072, #784).
 *
 * These functions gate whether a write affordance renders at all. A regression
 * that flips a comparison silently shows a privileged control to a Viewer (a
 * false affordance that 403s on submit) or hides it from a Member — neither is
 * caught by type-checking, so the matrix is pinned here. The ordinal-spacing
 * invariant is asserted too: the 99-unit bands between OSS tiers are the
 * Enterprise custom-role slots (ADR-0029), and a future renumber that closes a
 * band would break the `>=` extensibility semantics these helpers rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  ROLE_VIEWER,
  ROLE_MEMBER,
  ROLE_SCHEDULER,
  ROLE_ADMIN,
  ROLE_OWNER,
  canEditTask,
  canAuthorPlan,
  canEditRisk,
  progressCompleteAutoStatus,
} from './roles';

const LADDER = [ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER];

describe('role ordinals', () => {
  it('are the five OSS tiers at their documented values', () => {
    expect(ROLE_VIEWER).toBe(1);
    expect(ROLE_MEMBER).toBe(100);
    expect(ROLE_SCHEDULER).toBe(200);
    expect(ROLE_ADMIN).toBe(300);
    expect(ROLE_OWNER).toBe(400);
  });

  it('strictly increase from Viewer to Owner', () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i]).toBeGreaterThan(LADDER[i - 1]);
    }
  });

  it('leave a slot band of at least 98 free ordinals between adjacent tiers', () => {
    for (let i = 1; i < LADDER.length; i++) {
      // An Enterprise custom role (e.g. a "Senior Scheduler" at 250, an "Auditor"
      // at 50) registers into the gap without forcing an OSS renumber. Viewer→Member
      // is the narrow one at 98 free slots because VIEWER sits at 1 rather than 0
      // (#2489); every other band has 99.
      const freeSlots = LADDER[i] - LADDER[i - 1] - 1;
      expect(freeSlots).toBeGreaterThanOrEqual(98);
    }
  });

  // The reason VIEWER is 1 and not 0 (#2489, ADR-0072 Amendment 1). The ordinal is a
  // client-visible wire value, and `0` is falsy in JavaScript: `role || ROLE_MEMBER`
  // in any consumer would read a Viewer as absent and silently promote them. Absence
  // is null/undefined — a distinct type — so no ordinal may be falsy.
  it('are all truthy, so `||` can never mistake a real role for an absent one', () => {
    for (const role of LADDER) {
      expect(Boolean(role)).toBe(true);
      expect(role || ROLE_MEMBER).toBe(role);
    }
  });

  it('never assigns 0 — it is permanently unused, not a "no membership" sentinel', () => {
    expect(LADDER).not.toContain(0);
  });
});

describe('canEditTask', () => {
  it('denies a still-loading / unthreaded role (null, undefined)', () => {
    // false-by-default so a write control never flashes before the role resolves.
    expect(canEditTask(null)).toBe(false);
    expect(canEditTask(undefined)).toBe(false);
  });

  it('denies Viewers and allows Member and above', () => {
    expect(canEditTask(ROLE_VIEWER)).toBe(false);
    expect(canEditTask(ROLE_MEMBER)).toBe(true);
    expect(canEditTask(ROLE_SCHEDULER)).toBe(true);
    expect(canEditTask(ROLE_ADMIN)).toBe(true);
    expect(canEditTask(ROLE_OWNER)).toBe(true);
  });

  it('allows an Enterprise custom role in the Member band (>= semantics)', () => {
    expect(canEditTask(ROLE_MEMBER + 50)).toBe(true);
  });

  it('denies a custom role below Member', () => {
    expect(canEditTask(ROLE_VIEWER + 50)).toBe(false);
  });
});

describe('canAuthorPlan (#3034, ADR-0773 §(d))', () => {
  it('takes the server verdict verbatim', () => {
    expect(canAuthorPlan(true)).toBe(true);
    expect(canAuthorPlan(false)).toBe(false);
  });

  it('denies while the project detail is unresolved (undefined)', () => {
    // The apparatus is ABSENT until the server answers (#2949) — a control
    // briefly offered and then refused teaches a reader the product is broken.
    expect(canAuthorPlan(undefined)).toBe(false);
  });

  it('is NOT canEditTask — the Scheduler band is where they disagree', () => {
    // The whole reason this resolver exists. `canEditTask(ROLE_SCHEDULER)` is
    // true (200 >= 100), and the server's answer for that band is false. Any
    // future "simplification" that routes the Designer gate back through an
    // ordinal comparison reintroduces #3034, so the disagreement is pinned here.
    expect(canEditTask(ROLE_SCHEDULER)).toBe(true);
    expect(canAuthorPlan(false)).toBe(false);
  });
});

describe('canEditRisk', () => {
  it('mirrors canEditTask exactly across the role ladder', () => {
    const roles = [
      null,
      undefined,
      ROLE_VIEWER,
      ROLE_MEMBER,
      ROLE_SCHEDULER,
      ROLE_ADMIN,
      ROLE_OWNER,
    ];
    for (const r of roles) {
      expect(canEditRisk(r)).toBe(canEditTask(r));
    }
  });

  it('denies Viewers and allows Member and above', () => {
    expect(canEditRisk(ROLE_VIEWER)).toBe(false);
    expect(canEditRisk(ROLE_MEMBER)).toBe(true);
    expect(canEditRisk(ROLE_OWNER)).toBe(true);
  });
});

describe('progressCompleteAutoStatus (#2639)', () => {
  it('routes below-Admin roles (Viewer, Member, Scheduler) to REVIEW', () => {
    expect(progressCompleteAutoStatus(ROLE_VIEWER)).toBe('REVIEW');
    expect(progressCompleteAutoStatus(ROLE_MEMBER)).toBe('REVIEW');
    expect(progressCompleteAutoStatus(ROLE_SCHEDULER)).toBe('REVIEW');
  });

  it('routes Admin+ roles (Admin, Owner) to COMPLETE', () => {
    expect(progressCompleteAutoStatus(ROLE_ADMIN)).toBe('COMPLETE');
    expect(progressCompleteAutoStatus(ROLE_OWNER)).toBe('COMPLETE');
  });

  it('allows an Enterprise custom role in the Admin band (>= semantics)', () => {
    expect(progressCompleteAutoStatus(ROLE_ADMIN + 50)).toBe('COMPLETE');
  });

  it('treats null/undefined (role still loading) as below-Admin — never over-promises COMPLETE', () => {
    expect(progressCompleteAutoStatus(null)).toBe('REVIEW');
    expect(progressCompleteAutoStatus(undefined)).toBe('REVIEW');
  });
});
