import { describe, expect, it } from 'vitest';

import { aggregate } from './e2e-schema-report.mjs';

// One NDJSON line per observation, exactly as `schema-guard.ts` writes them.
function ndjson(...rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

const ok = (operationKey) => ({ operationKey, status: 200, outcome: 'ok' });
const skipped = (operationKey, reason) => ({ operationKey, status: 200, outcome: 'skipped', reason });
const waived = (operationKey) => ({ operationKey, status: 200, outcome: 'waived', reason: 'see #1' });
const violation = (operationKey, details, rules) => ({
  operationKey,
  status: 200,
  outcome: 'violation',
  rules,
  details,
});

describe('aggregate', () => {
  it('buckets each outcome by operation', () => {
    const r = aggregate(
      ndjson(
        ok('GET /a/'),
        ok('GET /a/'),
        waived('GET /b/'),
        skipped('GET /c/', 'free-form-schema'),
        violation('GET /d/', ['x: bad'], ['type']),
      ),
    );
    expect(r.rows).toHaveLength(5);
    expect([...r.ok]).toEqual(['GET /a/']);
    expect([...r.waived]).toEqual(['GET /b/']);
    expect([...r.violating]).toEqual(['GET /d/']);
    expect([...r.skipped.get('free-form-schema')]).toEqual(['GET /c/']);
  });

  it('counts an operation as both ok and violating when different specs mock it differently', () => {
    // This is the case the headline number must not round away: an operation
    // that conforms in one spec and drifts in another is NOT "checked and
    // clean", and reporting it under `ok` alone would overstate coverage.
    const r = aggregate(ndjson(ok('GET /a/'), violation('GET /a/', ['x: bad'], ['type'])));
    expect(r.ok.has('GET /a/')).toBe(true);
    expect(r.violating.has('GET /a/')).toBe(true);
  });

  it('collapses array indices so one ledger line covers every row of a list', () => {
    const r = aggregate(
      ndjson(
        violation('GET /a/', ['results[0].owner: bad'], ['type']),
        violation('GET /a/', ['results[7].owner: bad'], ['type']),
      ),
    );
    // Two observations, one ledger line — otherwise a 200-row list would write
    // 200 waiver entries for a single drifted field.
    expect([...r.ledger.get('GET /a/').entries()]).toEqual([['results[].owner:type', 2]]);
  });

  it('keeps distinct property/rule pairs on the same operation apart', () => {
    const r = aggregate(
      ndjson(violation('GET /a/', ['owner: bad', 'state: bad'], ['type', 'enum'])),
    );
    expect([...r.ledger.get('GET /a/').keys()].sort()).toEqual(['owner:type', 'state:enum']);
  });

  it('groups several skip reasons for the same operation', () => {
    // An operation can be checked at 200 and unchecked at 404 — the reasons are
    // per status, and reporting only one of them would misstate why.
    const r = aggregate(
      ndjson(skipped('GET /a/', 'no-declared-response'), skipped('GET /a/', 'no-json-content')),
    );
    expect([...r.skipped.keys()].sort()).toEqual(['no-declared-response', 'no-json-content']);
  });

  it('tolerates an empty log', () => {
    const r = aggregate('');
    expect(r.rows).toEqual([]);
    expect(r.ledger.size).toBe(0);
  });
});
