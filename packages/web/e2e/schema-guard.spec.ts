import { test, expect } from '@playwright/test';

import {
  setupAuth,
  setupCatchAll,
  setupApiMocks,
  validateBody,
  enforcedViolations,
  unwaivedViolations,
  decodeFulfillBody,
  resolveResponseSchema,
  isFreeForm,
  allOperationKeys,
  deref,
  type SchemaNode,
  type Violation,
  type SchemaGuardWaiver,
} from './fixtures';

/**
 * The guard's own negative control (#3440).
 *
 * `schema-guard.ts` is the thing that makes 290 specs contract-bound instead of
 * self-confirming, which means it inherits the failure mode it was written to
 * remove: **a gate that cannot fail is indistinguishable from one that works.**
 * Every check below therefore runs against the REAL `docs/api/openapi.json` —
 * never a hand-built stand-in — so a schema edit that quietly stops resolving,
 * a validator that stops reporting, or a page patch that stops being installed
 * all show up here rather than as a suite that went green having checked
 * nothing.
 *
 * The mutation the issue asks for ("rename one serializer field, confirm the web
 * suite reds without touching a spec by hand") is `renaming a declared property
 * makes the old payload fail` below: it takes the live `Me` response schema,
 * renames one property inside it, and asserts the payload every spec sends is
 * now rejected. That is the same operation a serializer rename performs on the
 * regenerated schema.
 *
 * The first group needs no browser — it never touches the `page` fixture, so
 * Playwright does not launch one.
 */

const ME_URL = 'http://127.0.0.1:4173/api/v1/auth/me/';

/** A payload that matches what the server actually sends for GET /auth/me/. */
function validMePayload(): Record<string, unknown> {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    max_project_role: 300,
    workspace_role: 300,
    can_access_admin_settings: true,
    default_landing: 'my_work',
    hidden_views: [],
    dnd_enabled: false,
    timezone: 'UTC',
  };
}

/**
 * Only the rules that fail a spec. `validateBody` also reports `missing-required`,
 * which is measured and never enforced — a fixture that sends `{id, name}` for a
 * Project is a deliberate minimal stand-in, not drift. Asserting on the raw list
 * would make every case below a test of fixture verbosity.
 */
function enforced(body: unknown, schema: SchemaNode): string[] {
  return enforcedViolations(validateBody(body, schema)).map((v: Violation) => `${v.at}:${v.rule}`);
}

function meSchema(): SchemaNode {
  const resolved = resolveResponseSchema('GET', ME_URL, 200);
  if (resolved.kind !== 'resolved') {
    throw new Error(
      `GET /api/v1/auth/me/ no longer resolves to a declared response schema ` +
        `(${resolved.kind === 'skipped' ? resolved.reason : 'unknown'}). The guard is ` +
        `checking nothing for it; fix the resolver or the schema, do not delete this test.`,
    );
  }
  return resolved.response.schema;
}

test.describe('e2e schema guard — the oracle resolves', () => {
  test('the real schema is loadable and covers the operations the suite mocks', () => {
    const keys = allOperationKeys();
    // A tripwire on the oracle itself: if the schema file moves, empties, or the
    // path index stops matching, every "ok" in the suite becomes vacuous. The
    // bound is deliberately loose — it is checking that the document is THERE,
    // not pinning a count that a normal API change would churn.
    expect(keys.length).toBeGreaterThan(400);
    expect(keys).toContain('GET /api/v1/auth/me/');
    expect(keys).toContain('GET /api/v1/tasks/');
  });

  test('a URL with a path parameter resolves to its template, not to a sibling literal', () => {
    // `/projects/health-summary/` and `/projects/{id}/` both match the same
    // shape; only literal-segment preference tells them apart, and getting it
    // backwards would validate every project detail response against the wrong
    // schema while still looking like coverage.
    const literal = resolveResponseSchema(
      'GET',
      'http://127.0.0.1:4173/api/v1/projects/health-summary/',
      200,
    );
    const templated = resolveResponseSchema(
      'GET',
      'http://127.0.0.1:4173/api/v1/projects/e2e-project-1/',
      200,
    );
    expect(literal.kind === 'resolved' && literal.response.template).toBe(
      '/api/v1/projects/health-summary/',
    );
    expect(templated.kind === 'resolved' && templated.response.template).toBe(
      '/api/v1/projects/{id}/',
    );
  });

  test('a query string does not defeat resolution', () => {
    const resolved = resolveResponseSchema(
      'GET',
      'http://127.0.0.1:4173/api/v1/tasks/?project=abc&page_size=200',
      200,
    );
    expect(resolved.kind).toBe('resolved');
  });

  test('a free-form declared schema is reported as free-form, never as a pass', () => {
    // Only 2 operations still declare `{"type":"object"}` with no properties,
    // down from 46 before #3679 typed the projects analytics/rollup reads and
    // #3680 typed the Monte Carlo endpoints (#3652's own sub-issue A). A mock
    // for one of them cannot be wrong here, and calling that "checked" is the
    // exact "the guard's existence is read as coverage" failure this issue is
    // an instance of. projects/{id}/export/ is used as the illustrative
    // example — a downloadable seed document with no fixed response shape —
    // rather than overview/ or monte-carlo/latest/ (both now typed for real).
    const projectExport = resolveResponseSchema(
      'GET',
      'http://127.0.0.1:4173/api/v1/projects/p1/export/',
      200,
    );
    expect(projectExport.kind === 'skipped' && projectExport.reason).toBe(
      'free-form-schema',
    );
    expect(isFreeForm({ type: 'object' })).toBe(true);
    expect(isFreeForm({ type: 'object', properties: { a: { type: 'string' } } })).toBe(false);
  });
});

test.describe('e2e schema guard — the validator reports', () => {
  test('the payload the shared fixture serves for /auth/me/ is clean', () => {
    expect(enforced(validMePayload(), meSchema())).toEqual([]);
  });

  test('a property the server never sends is reported', () => {
    expect(enforced({ ...validMePayload(), first_name: 'E2E' }, meSchema())).toContain(
      'first_name:unknown-property',
    );
  });

  test('a wrong scalar type is reported — the #2633 class', () => {
    // #2633 is six user-id fields typed `string` against an integer PK. The
    // direction here is the mirror: a string where the schema declares an
    // integer. Either way the fixture encodes a value the server cannot send.
    expect(enforced({ ...validMePayload(), max_project_role: 'admin' }, meSchema())).toContain(
      'max_project_role:type',
    );
  });

  test('null is accepted on a nullable field and reported on a non-nullable one', () => {
    expect(enforced({ ...validMePayload(), max_project_role: null }, meSchema())).toEqual([]);
    expect(enforced({ ...validMePayload(), username: null }, meSchema())).toContain(
      'username:null-on-non-nullable',
    );
  });

  test('an enum value the server cannot emit is reported', () => {
    const projects = resolveResponseSchema(
      'GET',
      'http://127.0.0.1:4173/api/v1/projects/e2e-project-1/',
      200,
    );
    test.skip(projects.kind !== 'resolved', 'GET /projects/{id}/ has no declared schema');
    if (projects.kind !== 'resolved') return;
    // 'OPEN' was in 19 fixtures until #3440; the server's value is 'open'.
    expect(
      enforced({ id: 'p1', name: 'P', estimation_mode: 'OPEN' }, projects.response.schema),
    ).toContain('estimation_mode:enum');
    expect(
      enforced({ id: 'p1', name: 'P', estimation_mode: 'open' }, projects.response.schema),
    ).toEqual([]);
  });

  test('a paginated envelope validates through to its rows', () => {
    const tasks = resolveResponseSchema('GET', 'http://127.0.0.1:4173/api/v1/tasks/', 200);
    expect(tasks.kind).toBe('resolved');
    if (tasks.kind !== 'resolved') return;
    // The row index is preserved so a 200-row list names the offending row.
    expect(
      enforced(
        { count: 1, next: null, previous: null, results: [{ id: 't1', invented_field: 1 }] },
        tasks.response.schema,
      ),
    ).toContain('results[0].invented_field:unknown-property');
  });

  test('renaming a declared property makes the old payload fail — the mutation proof', () => {
    // This is the acceptance criterion, performed on the oracle rather than on a
    // serializer: rename `display_name` the way a serializer rename would, and
    // the payload every spec sends must stop validating. Asserting the BEFORE
    // state first is what keeps the mutation from silently no-opping and the
    // test from passing on the broken build.
    const original = deref(meSchema());
    const properties = { ...original.properties };
    expect(Object.keys(properties)).toContain('display_name');
    expect(enforced(validMePayload(), original)).toEqual([]);

    const renamed: SchemaNode = {
      ...original,
      properties: { ...properties, displayName: properties.display_name },
    };
    delete renamed.properties?.display_name;

    expect(enforced(validMePayload(), renamed)).toContain('display_name:unknown-property');
  });
});

test.describe('e2e schema guard — composition and nullability', () => {
  // 64 `oneOf` nodes are live in the schema. A branch matcher that always
  // reports, or never reports, would be invisible from a payload test on any
  // single endpoint — so it is asserted on a synthetic schema where both
  // outcomes are known.
  const oneOfSchema: SchemaNode = {
    oneOf: [
      { type: 'object', properties: { kind: { type: 'string', enum: ['task'] } } },
      { type: 'object', properties: { kind: { type: 'string', enum: ['milestone'] } } },
    ],
  };

  test('a value matching one declared variant passes', () => {
    expect(enforced({ kind: 'milestone' }, oneOfSchema)).toEqual([]);
  });

  test('a value matching no declared variant is reported', () => {
    expect(enforced({ kind: 'sprint' }, oneOfSchema)).toContain(':type');
  });

  test('allOf members are merged, so a property from either side is known', () => {
    // drf-spectacular writes `{allOf: [{$ref: X}], nullable: true}`; a merge that
    // dropped the member's properties would call every real field an unknown
    // property, and a merge that dropped the wrapper's `nullable` would call
    // every legitimate null an error.
    const merged: SchemaNode = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    };
    expect(enforced({ a: 'x', b: 1 }, merged)).toEqual([]);
    expect(enforced({ a: 'x', c: 1 }, merged)).toContain('c:unknown-property');
  });
});

test.describe('e2e schema guard — the waiver ledger is applied', () => {
  // The filter is the one place the guard can go quietly wrong in BOTH
  // directions, and neither shows up in a payload test. A synthetic ledger is
  // used on purpose: a test pinned to a live waiver goes vacuous the moment that
  // waiver is removed, which is how the negative control below briefly broke
  // while this branch was being written.
  const drift: Violation[] = [
    { rule: 'unknown-property', at: 'results[0].ghost', message: 'x' },
    { rule: 'type', at: 'owner', message: 'y' },
  ];

  test('no waiver leaves every violation in place', () => {
    expect(unwaivedViolations('GET /api/v1/x/', drift, {})).toHaveLength(2);
  });

  test("a '*' waiver suppresses the whole operation", () => {
    const waivers: Record<string, SchemaGuardWaiver> = {
      'GET /api/v1/x/': { reason: 'see #1', allow: ['*'] },
    };
    expect(unwaivedViolations('GET /api/v1/x/', drift, waivers)).toEqual([]);
  });

  test('a property-level waiver suppresses only the pair it names', () => {
    const waivers: Record<string, SchemaGuardWaiver> = {
      // Array indices collapse, so this one line must cover `results[0]` too.
      'GET /api/v1/x/': { reason: 'see #1', allow: ['results[].ghost:unknown-property'] },
    };
    const left = unwaivedViolations('GET /api/v1/x/', drift, waivers);
    expect(left.map((v) => `${v.at}:${v.rule}`)).toEqual(['owner:type']);
  });

  test('a waiver on another operation does not leak', () => {
    const waivers: Record<string, SchemaGuardWaiver> = {
      'GET /api/v1/y/': { reason: 'see #1', allow: ['*'] },
    };
    expect(unwaivedViolations('GET /api/v1/x/', drift, waivers)).toHaveLength(2);
  });
});

test.describe('e2e schema guard — every fulfill shape is decoded', () => {
  // All three branches are live: 31 call sites use `json:`, ~400 pass a `body:`
  // string, and five specs fulfil non-JSON. A decoder that silently returned
  // undefined for one of them would unbind those mocks with nothing going red.
  test('the json: option is decoded', () => {
    expect(decodeFulfillBody({ status: 200, json: { a: 1 } })).toEqual({ a: 1 });
  });

  test('a JSON body: string is decoded', () => {
    expect(
      decodeFulfillBody({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ a: 1 }),
      }),
    ).toEqual({ a: 1 });
  });

  test('a non-JSON contentType is left alone', () => {
    // csv-import-wizard, msproject-import-export and the export-bundle specs all
    // fulfil text/csv, application/xml and application/gzip.
    expect(decodeFulfillBody({ status: 200, contentType: 'text/csv', body: 'a,b\n1,2' })).toBe(
      undefined,
    );
  });

  test('an unparseable body is skipped rather than throwing', () => {
    expect(
      decodeFulfillBody({ status: 200, contentType: 'application/json', body: 'not json' }),
    ).toBe(undefined);
  });

  test('a fulfill with no body at all is skipped', () => {
    expect(decodeFulfillBody({ status: 204 })).toBe(undefined);
  });
});

// -----------------------------------------------------------------------------
// The end-to-end negative control
// -----------------------------------------------------------------------------
//
// Everything above proves the validator reports. This proves the guard is
// actually WIRED — installed by `setupCatchAll`, patched onto `page.route`, and
// able to turn a drifted mock into a failed test. Without it, deleting the
// `installSchemaGuard(page)` line from `api-mocks.ts` would leave the whole
// suite green and the binding gone.
//
// `test.fail()` inverts the outcome: Playwright requires this test to fail, so
// if the guard ever stops throwing the run reports "expected to fail, but
// passed" and the job reds.

test.describe('e2e schema guard — the guard is wired', () => {
  // `report` counts as disabled here: it observes without throwing, so the
  // control below would "pass" and `test.fail()` would then report a failure
  // that says nothing about the guard. Both non-default modes are measurement
  // tools; CI runs neither, and check-e2e-schema-guard.sh enforces that.
  test.skip(
    process.env.TRUEPPM_E2E_SCHEMA_GUARD === 'off' ||
      process.env.TRUEPPM_E2E_SCHEMA_GUARD === 'report',
    'the guard is not enforcing for this run; there is nothing to prove it can reject',
  );

  test.fail();
  test('a mock the server could never produce fails the spec that serves it', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page);
    // Registered last, so it wins for this URL. `first_name` is not on
    // MeSerializer — it was in twelve fixtures until #3440, read by nothing.
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...validMePayload(), first_name: 'E2E' }),
      }),
    );
    await page.goto('/');
    // The app fetches /auth/me/ on boot; the guard throws inside that route
    // handler, which ends the test. This assertion is never reached — and if it
    // ever is, `test.fail()` turns the pass into the failure that reports it.
    await expect(page.locator('body')).toBeVisible();
  });
});
