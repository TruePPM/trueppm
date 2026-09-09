import { appendFileSync } from 'node:fs';

import type { Page, Route } from '@playwright/test';

import { SCHEMA_GUARD_WAIVERS, type SchemaGuardWaiver } from './schema-guard-waivers';
import {
  deref,
  isFreeForm,
  requestPathname,
  resolveResponseSchema,
  type SchemaNode,
} from './openapi-schema';

/**
 * Binds every mocked API response to `docs/api/openapi.json` at test time (#3440).
 *
 * WHY THIS EXISTS. The Playwright mock layer was written by hand and checked
 * against nothing, so `web:e2e` proved the front end agrees with the fixtures —
 * not that either agrees with the server. When a serializer field is renamed,
 * every spec stays green because the mock still sends the old name and the
 * component still reads it. #2633 is the live receipt of that class.
 *
 * WHAT IT DOES. `installSchemaGuard(page)` replaces `page.route` with a wrapper
 * that hands the handler a `Route` whose `fulfill()` first validates the body it
 * is about to serve against the response schema the real server declares for
 * that method, path and status. A mismatch **throws inside the route handler**,
 * which Playwright surfaces as an immediate, named test failure (verified in
 * `e2e/schema-guard.spec.ts`) rather than as a downstream timeout.
 *
 * WHY IT PATCHES `page.route` RATHER THAN EXPOSING A HELPER. The value is in the
 * ~290 specs that register their payloads inline; a helper only ever binds the
 * call sites somebody converts, which is the same "derived from nothing" posture
 * with extra steps. Patching the page means the binding is structural: a spec
 * that calls `setupCatchAll` — which `lint:e2e-catchall` already requires of
 * every API-mocking spec — gets it, and a new spec written next year gets it
 * without knowing it exists. The patch is per-`Page`, installed once, and
 * delegates everything except `fulfill` untouched.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Missing *required* properties. A fixture
 * that sends `{id, name}` for a Project is an intentionally minimal stand-in,
 * and enforcing `required` would red essentially every spec on a signal that is
 * about fixture verbosity, not about drift. It is measured and reported (see
 * `MISSING_REQUIRED` in the observation log) so the count is visible rather than
 * silently dropped, but it does not fail a spec. The four rules that DO fail are
 * the ones that catch the #2633 class: a wrong type, an unknown property, an
 * enum the server cannot emit, and a null on a non-nullable field.
 */

export type ViolationRule =
  | 'type'
  | 'unknown-property'
  | 'enum'
  | 'null-on-non-nullable'
  | 'missing-required';

/** The rules that fail a spec. `missing-required` is measured only — see the header. */
const ENFORCED_RULES: ReadonlySet<ViolationRule> = new Set([
  'type',
  'unknown-property',
  'enum',
  'null-on-non-nullable',
]);

export interface Violation {
  rule: ViolationRule;
  /** JSON path inside the body, e.g. `results[0].owner_id`. */
  at: string;
  message: string;
}

// -----------------------------------------------------------------------------
// Validator — OpenAPI 3.0 dialect, not JSON Schema draft-07
// -----------------------------------------------------------------------------
//
// Written by hand rather than delegated to ajv for two reasons that are both
// load-bearing here:
//
//   1. OpenAPI 3.0 spells nullability `nullable: true` beside `type`, which no
//      JSON-Schema validator understands without a conversion pass — and 954 of
//      the nodes in our schema use it. A validator that ignores `nullable` calls
//      every legitimately-null field an error.
//   2. The single highest-yield check for this bug class is "the mock sends a
//      property the server never sends", and drf-spectacular does not emit
//      `additionalProperties: false`, so a conformant JSON-Schema validator
//      cannot report it. That check is the one that turns a renamed serializer
//      field into a red spec.

/** Flatten `allOf` into one effective schema so unknown-property checks see the union. */
function effectiveSchema(node: SchemaNode): SchemaNode {
  const resolved = deref(node);
  if (!resolved.allOf?.length) return resolved;
  const merged: SchemaNode = { ...resolved };
  delete merged.allOf;
  const properties: Record<string, SchemaNode> = { ...(resolved.properties ?? {}) };
  const required = new Set(resolved.required ?? []);
  for (const member of resolved.allOf) {
    const flat = effectiveSchema(member);
    Object.assign(properties, flat.properties ?? {});
    for (const key of flat.required ?? []) required.add(key);
    if (!merged.type && flat.type) merged.type = flat.type;
    if (flat.additionalProperties !== undefined && merged.additionalProperties === undefined) {
      merged.additionalProperties = flat.additionalProperties;
    }
    if (flat.enum && !merged.enum) merged.enum = flat.enum;
    if (flat.items && !merged.items) merged.items = flat.items;
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(declared: string, value: unknown): boolean {
  switch (declared) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function validate(value: unknown, rawSchema: SchemaNode, at: string, out: Violation[]): void {
  const schema = effectiveSchema(rawSchema);

  if (value === null) {
    // `nullable` is inherited through a `$ref` wrapper: drf-spectacular writes
    // `{allOf: [{$ref: X}], nullable: true}`, and `effectiveSchema` keeps the
    // wrapper's own keys, so this reads the wrapper's flag.
    if (schema.nullable === true) return;
    out.push({
      rule: 'null-on-non-nullable',
      at,
      message: `null, but the schema does not declare this field nullable`,
    });
    return;
  }

  if (schema.oneOf?.length || schema.anyOf?.length) {
    const branches = schema.oneOf ?? schema.anyOf ?? [];
    const anyMatched = branches.some((branch) => {
      const probe: Violation[] = [];
      validate(value, branch, at, probe);
      return probe.length === 0;
    });
    if (!anyMatched) {
      out.push({
        rule: 'type',
        at,
        message: `matches none of the ${branches.length} declared variants`,
      });
    }
    return;
  }

  if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
    out.push({
      rule: 'type',
      at,
      message: `expected ${schema.type}, got ${typeOf(value)} (${JSON.stringify(value)?.slice(0, 80)})`,
    });
    return;
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    out.push({
      rule: 'enum',
      at,
      message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`,
    });
    return;
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      const items = schema.items;
      value.forEach((item, index) => validate(item, items, `${at}[${index}]`, out));
    }
    return;
  }

  if (typeof value === 'object' && schema.properties) {
    const properties = schema.properties;
    const additional = schema.additionalProperties;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const declared = properties[key];
      if (declared) {
        validate(child, declared, at ? `${at}.${key}` : key, out);
        continue;
      }
      if (additional === true || (additional && typeof additional === 'object')) continue;
      out.push({
        rule: 'unknown-property',
        at: at ? `${at}.${key}` : key,
        message: `the server never sends this property (declared: ${
          Object.keys(properties).slice(0, 12).join(', ') || 'none'
        }${Object.keys(properties).length > 12 ? ', …' : ''})`,
      });
    }
    for (const key of schema.required ?? []) {
      if (!(key in (value as Record<string, unknown>))) {
        out.push({
          rule: 'missing-required',
          at: at ? `${at}.${key}` : key,
          message: `the server always sends this property; the mock omits it`,
        });
      }
    }
  }
}

/**
 * The subset of `validateBody`'s output that actually fails a spec.
 *
 * Exported because the boundary between "reported" and "enforced" is a real
 * policy decision (`missing-required` is measured, not enforced — see the file
 * header), and a policy nothing can assert on is a policy that drifts.
 */
export function enforcedViolations(violations: Violation[]): Violation[] {
  return violations.filter((v) => ENFORCED_RULES.has(v.rule));
}

/** Validate a decoded response body against a resolved response schema. */
export function validateBody(body: unknown, schema: SchemaNode): Violation[] {
  if (isFreeForm(schema)) return [];
  const out: Violation[] = [];
  validate(body, schema, '', out);
  return out;
}

// -----------------------------------------------------------------------------
// Observation log — the denominator, written only when asked for
// -----------------------------------------------------------------------------

interface Observation {
  operationKey: string;
  status: number;
  outcome: 'ok' | 'violation' | 'waived' | 'skipped';
  reason?: string;
  rules?: ViolationRule[];
  /** `at: message` for each enforced violation — what the aggregator prints. */
  details?: string[];
}

const REPORT_PATH = process.env.TRUEPPM_E2E_SCHEMA_REPORT;

function record(observation: Observation): void {
  if (!REPORT_PATH) return;
  // Append-only NDJSON: parallel Playwright workers are separate processes, and
  // a single `appendFileSync` of one line under the pipe buffer is atomic enough
  // for a counting report. `scripts/e2e-schema-coverage.mjs` aggregates it.
  appendFileSync(REPORT_PATH, `${JSON.stringify(observation)}\n`);
}

// -----------------------------------------------------------------------------
// The guard
// -----------------------------------------------------------------------------

/**
 * The JSON body a `fulfill()` is about to serve, or `undefined` when there is
 * nothing to check.
 *
 * All three branches are live in the suite: 31 call sites use the `json:` option,
 * ~400 pass a `body:` string, and five specs deliberately fulfil non-JSON
 * (`text/csv`, `application/xml`, `application/gzip`, `text/html`). Getting the
 * first one wrong would silently unbind 31 mocks while every gate stayed green,
 * which is why it is exported and asserted rather than left inline.
 */
export function decodeFulfillBody(options: Parameters<Route['fulfill']>[0]): unknown {
  if (options === undefined) return undefined;
  if ('json' in options && options.json !== undefined) return options.json;
  const body = options.body;
  if (typeof body !== 'string') return undefined;
  const contentType = options.contentType ?? '';
  if (contentType && !contentType.includes('json')) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Collapse array indices so one waiver line covers every row of a list:
 * `results[3].created_by` and `results[0].created_by` are the same drift.
 */
export function normalizeAt(at: string): string {
  return (at || '<root>').replace(/\[\d+\]/g, '[]');
}

/**
 * Drop the violations this operation's ledger entry covers, and keep the rest.
 *
 * Extracted and exported because it is the one place the guard can go quietly
 * wrong in BOTH directions — a broken filter either stops enforcing every waived
 * operation or starts failing all 102 of them — and neither shows up in a
 * payload-level test. `waivers` is injectable so the spec can assert on a
 * synthetic ledger rather than on whatever the real one happens to contain
 * today; a test pinned to a live waiver goes vacuous the moment that waiver is
 * removed, which is exactly how the guard's own negative control briefly broke.
 *
 * `'*'` waives the whole operation; anything else waives only the
 * `<property path>:<rule>` pairs it names.
 */
export function unwaivedViolations(
  operationKey: string,
  violations: Violation[],
  waivers: Readonly<Record<string, SchemaGuardWaiver>> = SCHEMA_GUARD_WAIVERS,
): Violation[] {
  const waiver = waivers[operationKey];
  if (!waiver) return violations;
  if (waiver.allow.includes('*')) return [];
  return violations.filter((v) => !waiver.allow.includes(`${normalizeAt(v.at)}:${v.rule}`));
}

function formatFailure(
  method: string,
  url: string,
  operationKey: string,
  violations: Violation[],
): string {
  const lines = violations.map(
    (v) =>
      `  • ${normalizeAt(v.at)}: ${v.message}\n      waiver key: '${normalizeAt(v.at)}:${v.rule}'`,
  );
  return [
    `E2E mock does not match the API schema (#3440).`,
    ``,
    `  ${method} ${requestPathname(url)}`,
    `  operation: ${operationKey}`,
    `  oracle:    docs/api/openapi.json`,
    ``,
    ...lines,
    ``,
    `This is a mock the server could never produce, so any assertion built on it`,
    `is asserting the front end against itself. Fix the fixture to match the`,
    `serializer. If the SCHEMA is what is wrong, fix the serializer/annotation and`,
    `regenerate with scripts/export-openapi.sh — do not weaken this check.`,
    `A deliberate, tracked exception goes in e2e/fixtures/schema-guard-waivers.ts.`,
  ].join('\n');
}

const guardedPages = new WeakSet<Page>();

/** Original handler → the wrapper actually registered with Playwright. */
type RouteHandler = Parameters<Page['route']>[1];
const wrappedHandlers = new WeakMap<object, RouteHandler>();

/**
 * Wrap `page.route` so every JSON body a mock fulfills is checked against the
 * schema before it reaches the browser. Idempotent per page; a no-op when
 * `TRUEPPM_E2E_SCHEMA_GUARD=off`.
 */
export function installSchemaGuard(page: Page): void {
  if (process.env.TRUEPPM_E2E_SCHEMA_GUARD === 'off') return;
  if (guardedPages.has(page)) return;
  guardedPages.add(page);

  const register = page.route.bind(page);
  const guarded: Page['route'] = (url, handler, options) => {
    const wrapper: RouteHandler = (route, request) => {
      // The handler's return value goes straight back to Playwright, which
      // awaits it when it is a promise. Dropping it here would make every
      // async handler float and fulfil after the assertion it was set up for,
      // so it is returned verbatim — only its `any` is narrowed away.
      const result: unknown = handler(guardRoute(route), request);
      return result;
    };
    wrappedHandlers.set(handler, wrapper);
    return register(url, wrapper, options);
  };
  page.route = guarded;

  // `page.unroute(url, handler)` removes the handler by IDENTITY, and what is
  // registered is the wrapper, not the caller's function — so without this the
  // call would silently remove nothing and the spec would keep serving the mock
  // it thought it had just dropped. Today every call site in the tree uses the
  // one-argument form (which removes all handlers for the URL and is unaffected),
  // so this is insurance against a future call site rather than a live fix; it is
  // here because the failure would be silent, and a silently-ignored unroute is
  // the same shape of bug as the one this whole file exists to close.
  const unregister = page.unroute.bind(page);
  const guardedUnroute: Page['unroute'] = (url, handler) =>
    unregister(url, handler ? (wrappedHandlers.get(handler) ?? handler) : undefined);
  page.unroute = guardedUnroute;
}

function guardRoute(route: Route): Route {
  return new Proxy(route, {
    get(target, property, receiver) {
      if (property === 'fulfill') {
        return (options: Parameters<Route['fulfill']>[0]) => {
          // Throw SYNCHRONOUSLY, before returning the fulfill promise: a handler
          // that calls `route.fulfill(...)` without awaiting (eslint forbids it
          // in this tree, but the guard must not depend on that) still fails in
          // the handler frame, which is what makes Playwright report it as this
          // test's error instead of hanging the request into a timeout.
          checkFulfill(target, options);
          return target.fulfill(options);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      // Everything except `fulfill` is delegated untouched. Methods are rebound
      // to the real Route so `this` is never the proxy — Playwright's Route
      // reads private state off `this`, and a proxied receiver breaks it.
      if (typeof value !== 'function') return value;
      const bound: unknown = (value as (...args: never[]) => unknown).bind(target);
      return bound;
    },
  });
}

function checkFulfill(route: Route, options: Parameters<Route['fulfill']>[0]): void {
  const request = route.request();
  const url = request.url();
  const method = request.method();
  const status = options?.status ?? 200;

  const resolution = resolveResponseSchema(method, url, status);
  if (resolution.kind === 'skipped') {
    if (resolution.reason !== 'not-an-api-path') {
      record({
        operationKey: resolution.operationKey ?? `${method} ${requestPathname(url)}`,
        status,
        outcome: 'skipped',
        reason: resolution.reason,
      });
    }
    return;
  }

  const body = decodeFulfillBody(options);
  if (body === undefined) {
    record({
      operationKey: resolution.response.operationKey,
      status,
      outcome: 'skipped',
      reason: 'no-json-body',
    });
    return;
  }

  const violations = validateBody(body, resolution.response.schema);
  const enforced = enforcedViolations(violations);
  const { operationKey } = resolution.response;

  if (enforced.length === 0) {
    record({
      operationKey,
      status,
      outcome: 'ok',
      rules: violations.map((v) => v.rule),
    });
    return;
  }

  const unwaived = unwaivedViolations(operationKey, enforced);
  if (unwaived.length === 0) {
    record({
      operationKey,
      status,
      outcome: 'waived',
      reason: SCHEMA_GUARD_WAIVERS[operationKey]?.reason,
      rules: enforced.map((v) => v.rule),
    });
    return;
  }

  record({
    operationKey,
    status,
    outcome: 'violation',
    rules: unwaived.map((v) => v.rule),
    details: unwaived.map((v) => `${v.at || '<root>'}: ${v.message}`),
  });
  // `report` mode is how the waiver baseline was measured in the first place: it
  // observes without failing, so one run enumerates every violating operation
  // instead of stopping at the first. It is a measurement tool, and CI must
  // never set it — `scripts/check-e2e-schema-waivers.mjs` asserts that.
  if (process.env.TRUEPPM_E2E_SCHEMA_GUARD === 'report') return;
  throw new Error(formatFailure(method, url, operationKey, unwaived));
}
