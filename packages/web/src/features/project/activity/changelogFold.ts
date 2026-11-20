/**
 * Presentation helpers for the project Activity feed (#3612): fold repeated
 * consecutive changes into one row, and render each changed field as a value
 * change rather than a bare field name.
 *
 * Folding happens on the client, over the pages already loaded, on purpose: the
 * server's keyset cursor addresses individual history rows, and a server-side fold
 * would either split a run across a page boundary or make the cursor point inside
 * a folded row. Folding the flattened pages keeps the cursor honest and lets a run
 * that straddles two pages fold once the second page arrives.
 */

import { fieldLabel, formatDiffValue } from '@/features/schedule/activityFormat';
import type { ChangelogChange, ChangelogEntry } from './useProjectChangelog';

/** One rendered row: the newest entry of a run and how many entries it stands for. */
export interface FoldedChangelogRow {
  entry: ChangelogEntry;
  count: number;
}

/**
 * What a reader sees on a row, as a comparable string: the verb, the object's kind
 * and name, the actor, and every changed field with its old and new value.
 *
 * `object_id` is deliberately NOT part of it. The run the audit found (#3612) was
 * five "updated Task Mitigate: Cutover window too short · Deleted" rows — five
 * rows that read identically whether they are one object or five same-named ones,
 * and either way the reader gains nothing from the repeats. Values ARE part of it:
 * "Status: Not started → In progress" then "Status: In progress → Review" are two
 * different events and stay two rows, and a delete followed by a restore never
 * folds into either.
 */
function foldKey(entry: ChangelogEntry): string {
  const changes = [...entry.changes]
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map((c) => [c.field, c.old, c.new]);
  // `user` is null on every row a below-Admin caller reads, so for them a run by
  // two people folds into one row. That discloses nothing (the actor is hidden from
  // them either way) and it is the row they would otherwise read twice.
  return JSON.stringify([
    entry.object_type,
    entry.object_kind ?? entry.object_type,
    entry.object_label,
    entry.change_type,
    entry.user?.id ?? null,
    changes,
  ]);
}

/**
 * Collapse consecutive entries that would render identically into one row with a
 * count. The feed is newest-first, so the first entry of a run is the newest; the
 * folded row keeps it (its id is a stable React key as more pages load, and its
 * time and click-through are the most recent).
 *
 * Only *consecutive* entries fold. An edit to anything else in between breaks the
 * run, because the interleaving is itself information about what happened.
 */
export function foldChangelog(entries: ChangelogEntry[]): FoldedChangelogRow[] {
  const rows: FoldedChangelogRow[] = [];
  let lastKey: string | null = null;
  for (const entry of entries) {
    const key = foldKey(entry);
    const last = rows[rows.length - 1];
    if (last && key === lastKey) {
      last.count += 1;
      continue;
    }
    rows.push({ entry, count: 1 });
    lastKey = key;
  }
  return rows;
}

/**
 * Fields whose changelog value is an opaque reference (a user id or an object
 * UUID). The changelog carries ids rather than resolved names (see
 * `history/diff_policy.py`), and an id reads as noise, so these render as
 * "<Field> changed" instead of a value change.
 */
const REFERENCE_FIELDS = new Set([
  'assignee',
  'sprint',
  'parent_epic',
  'blocking_task',
  'blocked_by',
  'lead',
  'owner',
  'created_by',
  'calendar',
  'predecessor',
  'successor',
  'task',
  'project',
  'program',
  'risk',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Integer user FKs (`accepted_by`, `archived_by`, ...) are references too, by name. */
function isReferenceField(field: string): boolean {
  return REFERENCE_FIELDS.has(field) || field.endsWith('_by');
}

function isReference(field: string, value: unknown): boolean {
  return isReferenceField(field) || (typeof value === 'string' && UUID_RE.test(value));
}

/** How one changed field renders on an Activity row. */
export type ChangeDisplay =
  | { kind: 'label'; label: string; text: string }
  | { kind: 'value'; label: string; old: string | null; new: string };

/** Longest value shown on a row, so a long `notes` edit cannot flood the accessible name. */
const MAX_VALUE_CHARS = 80;

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

/**
 * Display form of one change. A soft-delete flag reads as the event it is
 * ("Deleted" / "Restored"), a reference field as "<Field> changed", and anything
 * else as "<Field>: old → new" (with no old side on a first value).
 */
export function changeDisplay(change: ChangelogChange): ChangeDisplay {
  const label = fieldLabel(change.field);
  if (change.field === 'is_deleted') {
    return { kind: 'label', label, text: change.new === false ? 'Restored' : 'Deleted' };
  }
  if (isReference(change.field, change.new) || isReference(change.field, change.old)) {
    return { kind: 'label', label, text: `${label} changed` };
  }
  return {
    kind: 'value',
    label,
    old:
      change.old == null
        ? null
        : clip(change.old_display ?? formatDiffValue(change.field, change.old)),
    new: clip(change.new_display ?? formatDiffValue(change.field, change.new)),
  };
}
