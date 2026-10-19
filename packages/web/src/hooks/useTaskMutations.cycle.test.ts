/**
 * Cycle-detection helpers (issue #356 / ADR-0055).
 *
 * Covers `parseCyclicDependencyError` (server-error → typed payload) and
 * `formatCycleMessage` (payload → user-facing string with truncation).
 * The mutation hooks themselves are tested elsewhere; this file isolates the
 * pure helpers so a failing case fingers the parser/formatter directly.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCyclicDependencyError,
  formatCycleMessage,
  RESTRICTED_CYCLE_NODE_LABEL,
  type CyclicDependencyError,
} from './useTaskMutations';

// ---------------------------------------------------------------------------
// parseCyclicDependencyError
// ---------------------------------------------------------------------------

describe('parseCyclicDependencyError', () => {
  function makeAxiosError(data: unknown) {
    return { response: { data } };
  }

  it('returns the typed payload when the current (#3800) response shape matches', () => {
    const payload = {
      code: 'cyclic_dependency',
      detail: 'cyclic_dependency',
      offending: ['u1', 'u2', 'u1'],
      cycle: [
        { id: 'u1', name: 'A', hex_id: 'aa11' },
        { id: 'u2', name: 'B', hex_id: 'bb22' },
        { id: 'u1', name: 'A', hex_id: 'aa11' },
      ],
    };
    const result = parseCyclicDependencyError(makeAxiosError(payload));
    expect(result).toEqual(payload);
  });

  it('falls back to the legacy detail/cycle-only shape from a pre-#3800 server', () => {
    const payload = {
      detail: 'cyclic_dependency',
      cycle: [
        { id: 'u1', name: 'A', hex_id: 'aa11' },
        { id: 'u2', name: 'B', hex_id: 'bb22' },
        { id: 'u1', name: 'A', hex_id: 'aa11' },
      ],
    };
    const result = parseCyclicDependencyError(makeAxiosError(payload));
    expect(result).toEqual({
      code: 'cyclic_dependency',
      detail: 'cyclic_dependency',
      // offending is derived from cycle's ids when the server omits it.
      offending: ['u1', 'u2', 'u1'],
      cycle: payload.cycle,
    });
  });

  it('prefers the server offending list over a derived one when both are present', () => {
    const payload = {
      code: 'cyclic_dependency',
      detail: 'cyclic_dependency',
      offending: ['server-a', 'server-b', 'server-a'],
      cycle: [
        { id: 'u1', name: 'A', hex_id: 'aa11' },
        { id: 'u2', name: 'B', hex_id: 'bb22' },
        { id: 'u1', name: 'A', hex_id: 'aa11' },
      ],
    };
    const result = parseCyclicDependencyError(makeAxiosError(payload));
    expect(result?.offending).toEqual(['server-a', 'server-b', 'server-a']);
  });

  it('returns null for null/undefined input', () => {
    expect(parseCyclicDependencyError(null)).toBeNull();
    expect(parseCyclicDependencyError(undefined)).toBeNull();
  });

  it('returns null when error has no response.data', () => {
    expect(parseCyclicDependencyError(new Error('network'))).toBeNull();
    expect(parseCyclicDependencyError({ response: {} })).toBeNull();
  });

  it('returns null when detail is not "cyclic_dependency"', () => {
    expect(
      parseCyclicDependencyError(makeAxiosError({ detail: 'something_else', cycle: [] })),
    ).toBeNull();
  });

  it('returns null when cycle is missing or not an array', () => {
    expect(parseCyclicDependencyError(makeAxiosError({ detail: 'cyclic_dependency' }))).toBeNull();
    expect(
      parseCyclicDependencyError(makeAxiosError({ detail: 'cyclic_dependency', cycle: 'oops' })),
    ).toBeNull();
  });

  it('returns null when a cycle node lacks the expected fields', () => {
    expect(
      parseCyclicDependencyError(
        makeAxiosError({
          detail: 'cyclic_dependency',
          cycle: [{ id: 'u1', name: 'A' /* missing hex_id */ }],
        }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatCycleMessage
// ---------------------------------------------------------------------------

function node(id: string, name: string, hex = id): { id: string; name: string; hex_id: string } {
  return { id, name, hex_id: hex };
}

/** Builds a full {@link CyclicDependencyError}; `offending` derives from `cycle`'s ids,
 * matching what the parser does for a legacy-only server response (#3800). */
function cyclicDependencyError(
  cycle: { id: string; name: string; hex_id: string }[],
): CyclicDependencyError {
  return {
    code: 'cyclic_dependency',
    detail: 'cyclic_dependency',
    offending: cycle.map((n) => n.id),
    cycle,
  };
}

describe('formatCycleMessage', () => {
  it('joins all node names with arrows for short cycles (<= 4)', () => {
    const err = cyclicDependencyError([node('u1', 'A'), node('u2', 'B'), node('u1', 'A')]);
    expect(formatCycleMessage(err)).toBe(
      'This would create a circular dependency: A → B → A. Remove one of these edges first.',
    );
  });

  it('renders a 4-node cycle without truncation', () => {
    const err = cyclicDependencyError([
      node('u1', 'A'),
      node('u2', 'B'),
      node('u3', 'C'),
      node('u1', 'A'),
    ]);
    expect(formatCycleMessage(err)).toContain('A → B → C → A');
    expect(formatCycleMessage(err)).not.toContain('…');
  });

  it('truncates the middle with … once the path exceeds 4 nodes', () => {
    const err = cyclicDependencyError([
      node('u1', 'Find suppliers'),
      node('u2', 'Validate'),
      node('u3', 'Eng'),
      node('u4', 'Procurement'),
      node('u1', 'Find suppliers'),
    ]);
    const out = formatCycleMessage(err);
    expect(out).toContain('Find suppliers → Validate → … → Find suppliers');
    expect(out).not.toContain('Eng');
    expect(out).not.toContain('Procurement');
  });

  it('falls back to hex_id then id when name is empty', () => {
    const err = cyclicDependencyError([
      node('u1', '', 'aa11'),
      node('u2', '', ''),
      node('u1', '', 'aa11'),
    ]);
    expect(formatCycleMessage(err)).toContain('aa11 → u2 → aa11');
  });

  it('renders a server-withheld node (all fields blank) as a placeholder (#4588)', () => {
    const err = cyclicDependencyError([
      node('u1', 'Alpha'),
      node('', '', ''),
      node('u2', 'Bravo'),
      node('u1', 'Alpha'),
    ]);
    expect(formatCycleMessage(err)).toBe(
      `This would create a circular dependency: Alpha → ${RESTRICTED_CYCLE_NODE_LABEL} → Bravo → Alpha. Remove one of these edges first.`,
    );
  });

  it('parses a payload carrying a withheld node without rejecting it (#4588)', () => {
    const parsed = parseCyclicDependencyError({
      response: {
        data: {
          code: 'cyclic_dependency',
          detail: 'cyclic_dependency',
          offending: ['u1', '', 'u1'],
          cycle: [node('u1', 'Alpha'), node('', '', ''), node('u1', 'Alpha')],
        },
      },
    });
    if (parsed === null) throw new Error('withheld-node payload was rejected');
    expect(formatCycleMessage(parsed)).toContain(`Alpha → ${RESTRICTED_CYCLE_NODE_LABEL} → Alpha`);
  });
});
