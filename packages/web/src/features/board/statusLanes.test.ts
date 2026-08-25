/**
 * Named board lanes — the second axis over the five canonical statuses (#2967).
 *
 * The invariant these tests exist to protect is the *unladen identity*: with no
 * lanes configured, a track key must equal the status string exactly. Everything
 * downstream — persisted column widths, the collapsed-column set, droppable ids,
 * keyboard traversal, every E2E selector — is keyed on it, so if that identity
 * ever drifts the board silently loses all of them at once with no type error.
 */
import { describe, it, expect } from 'vitest';
import type { Task, TaskStatus } from '@/types';
import type { BoardColumnDef, BoardLaneDef } from '@/hooks/useBoardConfig';
import {
  buildLaneKeyIndex,
  collapseTracks,
  expandColumnTracks,
  hasNamedLanes,
  parseTrackKey,
  resolveTrackKey,
  slugifyLaneKey,
  trackKey,
  uniqueLaneKey,
  usedLaneKeys,
} from './statusLanes';

function col(
  status: TaskStatus,
  label: string,
  lanes: BoardLaneDef[] = [],
  wipLimit: number | null = null,
): BoardColumnDef {
  return { status, label, visible: true, wipLimit, color: null, ageThresholdDays: null, lanes };
}

function lane(key: string, label: string, wipLimit: number | null = null): BoardLaneDef {
  return { key, label, wipLimit };
}

function task(status: TaskStatus, boardLane?: string): Task {
  return { id: `t-${status}-${boardLane ?? ''}`, status, boardLane } as Task;
}

const UNLADEN: BoardColumnDef[] = [
  col('NOT_STARTED', 'To Do'),
  col('IN_PROGRESS', 'In Progress', [], 5),
  col('REVIEW', 'Review'),
  col('COMPLETE', 'Done'),
];

const LANED: BoardColumnDef[] = [
  col('NOT_STARTED', 'To Do'),
  col('IN_PROGRESS', 'In Progress', [lane('dev', 'Dev', 3), lane('blocked', 'Blocked')], 5),
  col('REVIEW', 'Review', [lane('review', 'Review'), lane('qa', 'QA', 2)]),
  col('COMPLETE', 'Done'),
];

describe('track keys', () => {
  it('is the bare status when there is no lane', () => {
    expect(trackKey('REVIEW', null)).toBe('REVIEW');
  });

  it('round-trips a lane key', () => {
    const key = trackKey('REVIEW', 'qa');
    expect(key).toBe('REVIEW#qa');
    expect(parseTrackKey(key)).toEqual({ status: 'REVIEW', laneKey: 'qa' });
  });

  it('parses a bare status back to a null lane', () => {
    expect(parseTrackKey('IN_PROGRESS')).toEqual({ status: 'IN_PROGRESS', laneKey: null });
  });
});

describe('expandColumnTracks', () => {
  it('leaves an unladen board byte-identical to its column list', () => {
    const tracks = expandColumnTracks(UNLADEN);
    expect(tracks.map((t) => t.key)).toEqual(UNLADEN.map((c) => c.status));
    expect(tracks.every((t) => t.laneKey === null)).toBe(true);
    expect(tracks.map((t) => t.label)).toEqual(['To Do', 'In Progress', 'Review', 'Done']);
  });

  it('emits one track per lane, in configured order, for a laned column', () => {
    const tracks = expandColumnTracks(LANED);
    expect(tracks.map((t) => t.key)).toEqual([
      'NOT_STARTED',
      'IN_PROGRESS#dev',
      'IN_PROGRESS#blocked',
      'REVIEW#review',
      'REVIEW#qa',
      'COMPLETE',
    ]);
  });

  it('labels a lane track with the lane and keeps the column label alongside', () => {
    const qa = expandColumnTracks(LANED).find((t) => t.key === 'REVIEW#qa');
    expect(qa?.label).toBe('QA');
    expect(qa?.columnLabel).toBe('Review');
  });

  it('gives a lane track the LANE wip limit, not the column ceiling', () => {
    // The column's limit is measured across every lane, so repeating it on each
    // track would read as N copies of one ceiling.
    const byKey = new Map(expandColumnTracks(LANED).map((t) => [t.key, t]));
    expect(byKey.get('IN_PROGRESS#dev')?.wipLimit).toBe(3);
    expect(byKey.get('IN_PROGRESS#blocked')?.wipLimit).toBeNull();
    expect(byKey.get('NOT_STARTED')?.wipLimit).toBeNull();
  });

  it('treats an absent lanes key the same as an empty one', () => {
    const legacy = [{ ...col('REVIEW', 'Review'), lanes: undefined }];
    expect(expandColumnTracks(legacy).map((t) => t.key)).toEqual(['REVIEW']);
  });
});

describe('collapseTracks', () => {
  it('is a pass-through when nothing is collapsed', () => {
    const tracks = expandColumnTracks(LANED);
    expect(collapseTracks(tracks, new Set()).map((t) => t.key)).toEqual(tracks.map((t) => t.key));
  });

  it('gives the folded stub the COLUMN ceiling, not a lane limit', () => {
    // The stub stands for the whole column, so banding it against one lane's
    // limit would misreport the breach the fold is meant to keep visible.
    const folded = collapseTracks(
      expandColumnTracks(LANED),
      new Set<TaskStatus>(['IN_PROGRESS']),
    );
    expect(folded.find((t) => t.key === 'IN_PROGRESS')?.wipLimit).toBe(5);
  });

  it('folds every lane of a collapsed column into ONE status-keyed stub', () => {
    // Collapse is a status-level control: "Collapse Review" hides Review, not
    // Review's second lane. Two stubs would also break the grid alignment the
    // header, rail and lanes share.
    const folded = collapseTracks(expandColumnTracks(LANED), new Set<TaskStatus>(['REVIEW']));
    expect(folded.map((t) => t.key)).toEqual([
      'NOT_STARTED',
      'IN_PROGRESS#dev',
      'IN_PROGRESS#blocked',
      'REVIEW',
      'COMPLETE',
    ]);
    const stub = folded.find((t) => t.key === 'REVIEW');
    expect(stub?.label).toBe('Review');
    expect(stub?.laneKey).toBeNull();
  });
});

describe('resolveTrackKey', () => {
  const index = buildLaneKeyIndex(LANED);

  it('returns the bare status for a card in an unladen column', () => {
    expect(resolveTrackKey(task('NOT_STARTED'), index)).toBe('NOT_STARTED');
  });

  it('honors a configured lane', () => {
    expect(resolveTrackKey(task('REVIEW', 'qa'), index)).toBe('REVIEW#qa');
  });

  it('falls back to the FIRST lane when the card names none', () => {
    expect(resolveTrackKey(task('REVIEW'), index)).toBe('REVIEW#review');
  });

  it('falls back to the first lane when the card names a DELETED lane', () => {
    // This is what makes deleting a lane free of any data migration — and the
    // server counts the same orphan into the same lane, so the header badge and
    // the cards under it can never disagree.
    expect(resolveTrackKey(task('REVIEW', 'gone'), index)).toBe('REVIEW#review');
  });

  it('ignores a lane key belonging to a different column', () => {
    // Keys are project-unique, so `dev` exists — but not in REVIEW.
    expect(resolveTrackKey(task('REVIEW', 'dev'), index)).toBe('REVIEW#review');
  });
});

describe('hasNamedLanes', () => {
  it('is false for the default board', () => {
    expect(hasNamedLanes(UNLADEN)).toBe(false);
  });
  it('is true as soon as one column configures a lane', () => {
    expect(hasNamedLanes(LANED)).toBe(true);
  });
});

describe('lane key minting', () => {
  it('slugifies a label to the server rule', () => {
    expect(slugifyLaneKey('Ready for QA!')).toBe('ready-for-qa');
    expect(slugifyLaneKey('  ')).toBe('');
  });

  it('trims the dashes a leading or trailing separator run produces', () => {
    // The `[^a-z0-9]+` collapse leaves at most ONE dash at each end, which is
    // why the trim can be a bounded `^-|-$` rather than a backtracking `-+`.
    expect(slugifyLaneKey('!!!Blocked!!!')).toBe('blocked');
    expect(slugifyLaneKey('---')).toBe('');
    expect(slugifyLaneKey('__in progress__')).toBe('in-progress');
    expect(slugifyLaneKey('-')).toBe('');
  });

  it('collects keys across the WHOLE config, not one column', () => {
    // The server enforces project-wide uniqueness so a bare key names exactly
    // one (status, lane) pair; the editor has to honor the same scope.
    expect(usedLaneKeys(LANED)).toEqual(new Set(['dev', 'blocked', 'review', 'qa']));
  });

  it('suffixes a colliding key rather than reusing it', () => {
    expect(uniqueLaneKey('QA', LANED)).toBe('qa-2');
    expect(uniqueLaneKey('Triage', LANED)).toBe('triage');
  });

  it('never mints an empty key', () => {
    expect(uniqueLaneKey('!!!', LANED)).toBe('lane');
  });
});
