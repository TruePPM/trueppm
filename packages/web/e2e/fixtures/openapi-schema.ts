import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads `docs/api/openapi.json` and answers one question: *for this request URL
 * and status, what shape would the real server send?*
 *
 * The e2e mock layer was authored independently of the schema (#3440) — 1,808
 * lines of fixtures plus every inline `page.route(...)` payload, checked against
 * nothing. `grep -rl openapi packages/web/e2e/` returned zero files. So a green
 * `web:e2e` was evidence about the fixtures, not about the API: the front end's
 * model of the server was asserted only against itself, in three artifacts
 * (`types.ts`, the route mocks, the vitest fixtures) that all originate from the
 * same guess. #2633 is the receipt — six user-id fields typed `string` against
 * an integer PK, with 969 vitest files, 295 specs and `tsc --strict` all green
 * over it.
 *
 * This module is the oracle side of the fix; `schema-guard.ts` is the enforcement
 * side. Nothing here mutates or asserts — it only resolves.
 */

/** A JSON-Schema-ish node as drf-spectacular emits it (OpenAPI 3.0 dialect). */
export interface SchemaNode {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  enum?: unknown[];
  additionalProperties?: SchemaNode | boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  format?: string;
  [key: string]: unknown;
}

interface OperationNode {
  responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OperationNode>>;
  components?: { schemas?: Record<string, SchemaNode> };
}

/** Repo-root-relative, resolved from this file so the cwd of the run is irrelevant. */
const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/api/openapi.json',
);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface IndexedPath {
  /** The OpenAPI path template, e.g. `/api/v1/projects/{id}/overview/`. */
  template: string;
  matcher: RegExp;
  /**
   * Count of literal (non-`{param}`) segments. Used to break ties: both
   * `/api/v1/projects/health-summary/` and `/api/v1/projects/{id}/` match the
   * first URL, and only the literal one is the operation that URL invokes.
   */
  literalSegments: number;
  operations: Record<string, OperationNode>;
}

let cachedIndex: IndexedPath[] | null = null;
let cachedDoc: OpenApiDocument | null = null;

function loadDocument(): OpenApiDocument {
  if (cachedDoc) return cachedDoc;
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  cachedDoc = JSON.parse(raw) as OpenApiDocument;
  return cachedDoc;
}

function templateToRegExp(template: string): RegExp {
  const escaped = template
    .split('/')
    .map((segment) => {
      if (segment.startsWith('{') && segment.endsWith('}')) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  // Trailing slash is optional: the client's axios base and a spec's inline
  // route both produce both forms, and DRF's APPEND_SLASH treats them as one.
  return new RegExp(`^${escaped.replace(/\/$/, '/?')}$`);
}

function buildIndex(): IndexedPath[] {
  if (cachedIndex) return cachedIndex;
  const doc = loadDocument();
  cachedIndex = Object.entries(doc.paths).map(([template, operations]) => ({
    template,
    matcher: templateToRegExp(template),
    literalSegments: template.split('/').filter((s) => s && !s.startsWith('{')).length,
    operations,
  }));
  return cachedIndex;
}

/** Strip origin and query string, leaving the path DRF would route on. */
export function requestPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** Follow `$ref` chains into `components.schemas`. Returns the node unchanged if it is not a ref. */
export function deref(node: SchemaNode): SchemaNode {
  const doc = loadDocument();
  let current = node;
  // Bounded: a self-referential $ref chain in a generated schema would otherwise
  // hang the whole suite inside a route handler, which reads as a timeout on an
  // unrelated click rather than as a schema problem.
  for (let hops = 0; hops < 20; hops += 1) {
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    const target = doc.components?.schemas?.[ref.replace('#/components/schemas/', '')];
    if (!target) return current;
    current = target;
  }
  return current;
}

export interface ResolvedResponse {
  /** The OpenAPI path template this URL resolved to. */
  template: string;
  method: string;
  status: number;
  schema: SchemaNode;
  /** The `METHOD /template` key used by the waiver list. */
  operationKey: string;
}

/**
 * The reason a request was not checked. Distinguishing these matters: "the
 * schema declares nothing" and "the mock is unchecked" look identical from a
 * green run, and only one of them is a gap in *this* layer.
 */
export type SkipReason =
  | 'not-an-api-path'
  | 'unknown-path'
  | 'unknown-operation'
  | 'no-declared-response'
  | 'no-json-content'
  | 'free-form-schema';

export type ResolveResult =
  | { kind: 'resolved'; response: ResolvedResponse }
  | { kind: 'skipped'; reason: SkipReason; template?: string; operationKey?: string };

/**
 * A schema that constrains nothing: `{"type": "object"}` with no properties and
 * no composition. 72 of the 596 operations declare their 2xx body this way
 * (`/projects/{id}/overview/` among them), so a mock for one of those can never
 * be wrong here no matter what it sends. That is a gap in the *schema*, not in
 * the guard, and it is counted separately rather than being read as coverage.
 */
export function isFreeForm(schema: SchemaNode): boolean {
  const node = deref(schema);
  if (node.type !== 'object') return false;
  return !node.properties && !node.allOf && !node.oneOf && !node.anyOf;
}

export function resolveResponseSchema(method: string, url: string, status: number): ResolveResult {
  const pathname = requestPathname(url);
  if (!pathname.includes('/api/v1/')) return { kind: 'skipped', reason: 'not-an-api-path' };

  // Requests are issued against the preview origin, so the pathname already
  // matches the schema's `/api/v1/...` templates verbatim.
  const candidates = buildIndex().filter((entry) => entry.matcher.test(pathname));
  if (candidates.length === 0) return { kind: 'skipped', reason: 'unknown-path' };
  candidates.sort((a, b) => b.literalSegments - a.literalSegments);
  const entry = candidates[0];

  const verb = method.toLowerCase();
  if (!HTTP_METHODS.has(verb) || !entry.operations[verb]) {
    return { kind: 'skipped', reason: 'unknown-operation', template: entry.template };
  }
  const operationKey = `${method.toUpperCase()} ${entry.template}`;
  const responses = entry.operations[verb].responses ?? {};
  const declared = responses[String(status)] ?? responses.default;
  if (!declared) {
    return {
      kind: 'skipped',
      reason: 'no-declared-response',
      template: entry.template,
      operationKey,
    };
  }
  const schema = declared.content?.['application/json']?.schema;
  if (!schema) {
    return { kind: 'skipped', reason: 'no-json-content', template: entry.template, operationKey };
  }
  if (isFreeForm(schema)) {
    return { kind: 'skipped', reason: 'free-form-schema', template: entry.template, operationKey };
  }
  return {
    kind: 'resolved',
    response: {
      template: entry.template,
      method: method.toUpperCase(),
      status,
      schema,
      operationKey,
    },
  };
}

/** Every `METHOD /template` the schema declares, for the coverage report. */
export function allOperationKeys(): string[] {
  const keys: string[] = [];
  for (const entry of buildIndex()) {
    for (const verb of Object.keys(entry.operations)) {
      if (HTTP_METHODS.has(verb)) keys.push(`${verb.toUpperCase()} ${entry.template}`);
    }
  }
  return keys.sort();
}
