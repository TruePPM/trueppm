/**
 * URL helpers for project and program **keys** (ADR-1237 §7).
 *
 * A project route segment (`/projects/:projectId/…`) is a key (`PLAT`), a retired
 * key, or a UUID; the route boundary resolves it and rewrites the address bar to
 * the current key. These helpers build links in the preferred form and swap the
 * segment during that rewrite. None of them *parse* a reference — splitting
 * `GA-SEC-T-10` into a key and a marker is the resolver's job, never the web's.
 */

/** The two object kinds that own a key namespace. */
export type RefKind = 'project' | 'program';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is shaped like a UUID. Keys can never be (the server reserves
 * the UUID shape), so a UUID-shaped route segment is the object's id and needs no
 * resolver hop — the boundary uses this to skip the network.
 */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Anything with an id and (optionally) a key — a project/program row, detail or list item. */
export interface KeyedObject {
  id: string;
  /** The wire name of the key. Blank or absent → the object is addressed by UUID. */
  code?: string | null;
}

/** The URL segment an object is addressed by: its key when it has one, else its UUID. */
export function refSegment(obj: KeyedObject): string {
  const code = obj.code?.trim();
  return code ? code : obj.id;
}

function join(base: string, rest: ReadonlyArray<string | number>): string {
  const tail = rest
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  return tail ? `${base}/${tail}` : base;
}

/**
 * `/projects/<key-or-uuid>/<…rest>` for a project, preferring its key.
 *
 * @example projectPath({ id, code: 'PLAT' }, 'schedule') // '/projects/PLAT/schedule'
 * @example projectPath({ id, code: '' }, 'board')        // '/projects/<uuid>/board'
 */
export function projectPath(project: KeyedObject, ...rest: Array<string | number>): string {
  return join(`/projects/${encodeURIComponent(refSegment(project))}`, rest);
}

/** `/programs/<key-or-uuid>/<…rest>` for a program, preferring its key. */
export function programPath(program: KeyedObject, ...rest: Array<string | number>): string {
  return join(`/programs/${encodeURIComponent(refSegment(program))}`, rest);
}

/**
 * Replace the object segment of a `/projects/<seg>/…` or `/programs/<seg>/…`
 * pathname with `segment`, keeping every later segment untouched. Returns the
 * pathname unchanged when it is not a route of that kind.
 */
export function replaceRefSegment(pathname: string, kind: RefKind, segment: string): string {
  const prefix = kind === 'project' ? '/projects/' : '/programs/';
  if (!pathname.startsWith(prefix)) return pathname;
  const after = pathname.slice(prefix.length);
  const slash = after.indexOf('/');
  const rest = slash >= 0 ? after.slice(slash) : '';
  return `${prefix}${encodeURIComponent(segment)}${rest}`;
}

/**
 * The view segment right after the object segment of a `/projects/<seg>/<view>`
 * (or `/programs/…`) pathname, or `undefined` when there is none. Positional on
 * purpose: the object segment may be a key, a retired key or a UUID, so looking
 * the id up by value in the path is wrong once key URLs exist.
 */
export function segmentAfterRef(pathname: string, kind: RefKind): string | undefined {
  const prefix = kind === 'project' ? '/projects/' : '/programs/';
  if (!pathname.startsWith(prefix)) return undefined;
  const parts = pathname.slice(prefix.length).split('/');
  const view = parts[1];
  return view ? view : undefined;
}
