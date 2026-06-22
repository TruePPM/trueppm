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
  canEditRisk,
} from './roles';

describe('role ordinals', () => {
  it('are the five OSS tiers at their documented values', () => {
    expect(ROLE_VIEWER).toBe(0);
    expect(ROLE_MEMBER).toBe(100);
    expect(ROLE_SCHEDULER).toBe(200);
    expect(ROLE_ADMIN).toBe(300);
    expect(ROLE_OWNER).toBe(400);
  });

  it('strictly increase from Viewer to Owner', () => {
    const ladder = [ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER];
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
  });

  it('leave a 99-unit slot band between adjacent tiers for Enterprise custom roles', () => {
    const ladder = [ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER];
    for (let i = 1; i < ladder.length; i++) {
      // gap of exactly 100 ⇒ 99 free ordinals (e.g. a "Senior Scheduler" at 250)
      // can register between two OSS tiers without an OSS renumber.
      expect(ladder[i] - ladder[i - 1]).toBe(100);
    }
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
