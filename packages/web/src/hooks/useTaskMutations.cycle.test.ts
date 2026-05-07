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
  type CyclicDependencyError,
} from './useTaskMutations';

// ---------------------------------------------------------------------------
// parseCyclicDependencyError
// ---------------------------------------------------------------------------

describe('parseCyclicDependencyError', () => {
  function makeAxiosError(data: unknown) {
    return { response: { data } };
  }

  it('returns the typed payload when the response shape matches', () => {
    const payload = {
      detail: 'cyclic_dependency',
      cycle: [
        { id: 'u1', name: 'A', hex_id: 'aa11' },
        { id: 'u2', name: 'B', hex_id: 'bb22' },
        { id: 'u1', name: 'A', hex_id: 'aa11' },
      ],
    };
    const result = parseCyclicDependencyError(makeAxiosError(payload));
    expect(result).toEqual(payload);
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
      parseCyclicDependencyError(
        makeAxiosError({ detail: 'something_else', cycle: [] }),
      ),
    ).toBeNull();
  });

  it('returns null when cycle is missing or not an array', () => {
    expect(
      parseCyclicDependencyError(makeAxiosError({ detail: 'cyclic_dependency' })),
    ).toBeNull();
    expect(
      parseCyclicDependencyError(
        makeAxiosError({ detail: 'cyclic_dependency', cycle: 'oops' }),
      ),
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

describe('formatCycleMessage', () => {
  it('joins all node names with arrows for short cycles (<= 4)', () => {
    const err: CyclicDependencyError = {
      detail: 'cyclic_dependency',
      cycle: [node('u1', 'A'), node('u2', 'B'), node('u1', 'A')],
    };
    expect(formatCycleMessage(err)).toBe(
      'This would create a circular dependency: A → B → A. Remove one of these edges first.',
    );
  });

  it('renders a 4-node cycle without truncation', () => {
    const err: CyclicDependencyError = {
      detail: 'cyclic_dependency',
      cycle: [node('u1', 'A'), node('u2', 'B'), node('u3', 'C'), node('u1', 'A')],
    };
    expect(formatCycleMessage(err)).toContain('A → B → C → A');
    expect(formatCycleMessage(err)).not.toContain('…');
  });

  it('truncates the middle with … once the path exceeds 4 nodes', () => {
    const err: CyclicDependencyError = {
      detail: 'cyclic_dependency',
      cycle: [
        node('u1', 'Find suppliers'),
        node('u2', 'Validate'),
        node('u3', 'Eng'),
        node('u4', 'Procurement'),
        node('u1', 'Find suppliers'),
      ],
    };
    const out = formatCycleMessage(err);
    expect(out).toContain('Find suppliers → Validate → … → Find suppliers');
    expect(out).not.toContain('Eng');
    expect(out).not.toContain('Procurement');
  });

  it('falls back to hex_id then id when name is empty', () => {
    const err: CyclicDependencyError = {
      detail: 'cyclic_dependency',
      cycle: [node('u1', '', 'aa11'), node('u2', '', ''), node('u1', '', 'aa11')],
    };
    expect(formatCycleMessage(err)).toContain('aa11 → u2 → aa11');
  });
});
