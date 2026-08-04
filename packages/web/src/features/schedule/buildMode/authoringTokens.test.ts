import { describe, it, expect } from 'vitest';
import type { ProjectResource } from '@/types';
import {
  DEPENDENCY_TYPE_CYCLE,
  activeTokenFragment,
  cycleDependencyType,
  cycleDependencyTypeInDraft,
  matchParent,
  matchPredecessor,
  parseAuthoringTokens,
  resolveAuthoringDraft,
  segmentAuthoringName,
  type PredecessorCandidate,
  type ParentCandidate,
  type DependencyType,
} from './authoringTokens';

function resource(id: string, name: string): ProjectResource {
  return { resourceId: id, resource: { id, name } } as unknown as ProjectResource;
}

const POOL: ProjectResource[] = [
  resource('r-ana', 'Ana Rivera'),
  resource('r-ben', 'Ben Okafor'),
  resource('r-anb', 'Ana Silva'),
];

const TASKS: PredecessorCandidate[] = [
  { id: 't-survey', name: 'Survey', wbs: '2.3' },
  { id: 't-design', name: 'Design', wbs: '2.4' },
  { id: 't-dev', name: 'Development', wbs: '3.1' },
];

const PHASES: ParentCandidate[] = [
  { id: 'p-design', name: 'Design' },
  { id: 'p-build', name: 'Build' },
];

const CTX = { pool: POOL, tasks: TASKS, phases: PHASES };

// ---------------------------------------------------------------------------
// Lexing — decidable from the input alone, no fixtures involved
// ---------------------------------------------------------------------------

describe('parseAuthoringTokens', () => {
  it('lifts a duration in days', () => {
    const [t] = parseAuthoringTokens('Survey #5d');
    expect(t).toMatchObject({ kind: 'duration', raw: '#5d', days: 5 });
  });

  it('reads a trailing bare number as days', () => {
    expect(parseAuthoringTokens('Survey #3')[0]).toMatchObject({ kind: 'duration', days: 3 });
  });

  it('converts weeks to working days', () => {
    expect(parseAuthoringTokens('Survey #2w')[0]).toMatchObject({ kind: 'duration', days: 10 });
  });

  it('reads #0 as a milestone, not a zero-duration task', () => {
    // The two encodings must not both be emitted, or the conflict resolver would
    // arbitrate against itself.
    const tokens = parseAuthoringTokens('Launch #0');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('milestone');
  });

  it('lifts a bare ! as a milestone', () => {
    expect(parseAuthoringTokens('Launch !')[0]).toMatchObject({ kind: 'milestone', raw: '!' });
  });

  it('does not read a trailing ! inside a word as a milestone', () => {
    expect(parseAuthoringTokens('Ship it!')).toHaveLength(0);
  });

  it('does not read a bare # mid-name as a duration', () => {
    // "Sprint #3 planning" is ordinary English, and eating its `#3` would be
    // hostile. A bare number is a duration only in trailing position; with a unit
    // it is unambiguous and may sit anywhere.
    expect(parseAuthoringTokens('Sprint #3 planning').filter((t) => t.kind === 'duration')).toEqual(
      [],
    );
    expect(parseAuthoringTokens('Sprint #3d planning')[0]).toMatchObject({
      kind: 'duration',
      days: 3,
    });
  });

  it('lifts a predecessor by WBS', () => {
    expect(parseAuthoringTokens('Design >2.3')[0]).toMatchObject({
      kind: 'predecessor',
      query: '2.3',
      lag: 0,
      depType: 'FS',
    });
  });

  it('lifts a predecessor with positive lag', () => {
    expect(parseAuthoringTokens('Design >2.3+2d')[0]).toMatchObject({ query: '2.3', lag: 2 });
  });

  it('lifts a predecessor with a lead (negative lag)', () => {
    expect(parseAuthoringTokens('Design >2.3-1d')[0]).toMatchObject({ query: '2.3', lag: -1 });
  });

  it('converts a lag in weeks to working days', () => {
    expect(parseAuthoringTokens('Design >2.3+1w')[0]).toMatchObject({ lag: 5 });
  });

  it('lifts a quoted multi-word predecessor', () => {
    expect(parseAuthoringTokens('X >"Design review"')[0]).toMatchObject({
      kind: 'predecessor',
      query: 'Design review',
    });
  });

  it('lifts a delivery mode', () => {
    expect(parseAuthoringTokens('Build ~sprint')[0]).toMatchObject({
      kind: 'deliveryMode',
      mode: 'scrum',
    });
  });

  it('lifts an unknown delivery-mode word as a token with no mode', () => {
    // It still has to reach `unresolved` for the amber underline, rather than
    // vanishing into the task name.
    const [t] = parseAuthoringTokens('Build ~banana');
    expect(t.kind).toBe('deliveryMode');
    expect(t).not.toHaveProperty('mode', expect.anything());
  });

  it('lifts a bracketed parent, spaces included', () => {
    expect(parseAuthoringTokens('Wireframes [Design review]')[0]).toMatchObject({
      kind: 'parent',
      query: 'Design review',
    });
  });

  it('lifts an owner token via the shared owner grammar', () => {
    expect(parseAuthoringTokens('Survey @ana')[0]).toMatchObject({ kind: 'owner', query: 'ana' });
  });

  it('returns tokens sorted by position across kinds', () => {
    const tokens = parseAuthoringTokens('Survey #5d @ana >2.3 ~sprint [Build]');
    expect(tokens.map((t) => t.kind)).toEqual([
      'duration',
      'owner',
      'predecessor',
      'deliveryMode',
      'parent',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Invalid forms never block the row
// ---------------------------------------------------------------------------

describe('invalid tokens stay literal and never block the commit', () => {
  it('keeps an unmatched owner in the name and reports it unresolved', () => {
    const parse = resolveAuthoringDraft('Survey @nobody', CTX);
    expect(parse.name).toBe('Survey @nobody');
    expect(parse.owners).toEqual([]);
    expect(parse.unresolved.map((t) => t.raw)).toEqual(['@nobody']);
  });

  it('treats an ambiguous owner as unresolved rather than guessing', () => {
    // "Ana" matches both Ana Rivera and Ana Silva. Binding work to the wrong person
    // silently is the failure this contract exists to prevent.
    const parse = resolveAuthoringDraft('Survey @Ana', CTX);
    expect(parse.owners).toEqual([]);
    expect(parse.unresolved).toHaveLength(1);
  });

  it('keeps an unmatched predecessor literal', () => {
    const parse = resolveAuthoringDraft('Design >9.9', CTX);
    expect(parse.predecessors).toEqual([]);
    expect(parse.name).toBe('Design >9.9');
    expect(parse.unresolved.map((t) => t.raw)).toEqual(['>9.9']);
  });

  it('treats an ambiguous predecessor name as unresolved', () => {
    // "De" prefixes both Design and Development.
    const parse = resolveAuthoringDraft('X >De', CTX);
    expect(parse.predecessors).toEqual([]);
    expect(parse.unresolved).toHaveLength(1);
  });

  it('keeps an unknown delivery mode literal', () => {
    const parse = resolveAuthoringDraft('Build ~banana', CTX);
    expect(parse.deliveryMode).toBeNull();
    expect(parse.name).toBe('Build ~banana');
    expect(parse.unresolved.map((t) => t.raw)).toEqual(['~banana']);
  });

  it('keeps an unmatched parent literal', () => {
    const parse = resolveAuthoringDraft('Wireframes [Nowhere]', CTX);
    expect(parse.parentId).toBeNull();
    expect(parse.name).toBe('Wireframes [Nowhere]');
    expect(parse.unresolved.map((t) => t.raw)).toEqual(['[Nowhere]']);
  });

  it('commits the resolvable tokens even when a sibling token fails', () => {
    const parse = resolveAuthoringDraft('Survey #5d @nobody', CTX);
    expect(parse.duration).toBe(5);
    expect(parse.name).toBe('Survey @nobody');
    expect(parse.unresolved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolveAuthoringDraft', () => {
  it('resolves all four tokens on one row and strips them from the name', () => {
    const parse = resolveAuthoringDraft('Survey #5d @ben >2.3+2d [Build]', CTX);
    expect(parse.name).toBe('Survey');
    expect(parse.duration).toBe(5);
    expect(parse.owners).toEqual([{ resourceId: 'r-ben', name: 'Ben Okafor', units: 100 }]);
    expect(parse.predecessors).toEqual([
      { taskId: 't-survey', name: 'Survey', lag: 2, depType: 'FS' },
    ]);
    expect(parse.parentId).toBe('p-build');
  });

  it('honors an explicit owner allocation', () => {
    const parse = resolveAuthoringDraft('Survey @ben:50', CTX);
    expect(parse.owners).toEqual([{ resourceId: 'r-ben', name: 'Ben Okafor', units: 50 }]);
  });

  it('matches a predecessor by WBS before name', () => {
    expect(matchPredecessor('2.4', TASKS)?.id).toBe('t-design');
  });

  it('matches a predecessor by exact name', () => {
    expect(matchPredecessor('Development', TASKS)?.id).toBe('t-dev');
  });

  it('matches a parent phase by prefix', () => {
    expect(matchParent('Buil', PHASES)?.id).toBe('p-build');
  });

  it('lets the last duration win, marking the earlier one overridden', () => {
    const parse = resolveAuthoringDraft('Survey #5d #3d', CTX);
    expect(parse.duration).toBe(3);
    expect(parse.overridden.map((t) => t.raw)).toEqual(['#5d']);
  });

  it('lets the last allocation win for a repeated person', () => {
    const parse = resolveAuthoringDraft('Survey @ben @ben:50', CTX);
    expect(parse.owners).toEqual([{ resourceId: 'r-ben', name: 'Ben Okafor', units: 50 }]);
  });

  it('returns a null duration when the draft carries no duration token', () => {
    expect(resolveAuthoringDraft('Survey', CTX).duration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The coupled milestone invariant
// ---------------------------------------------------------------------------

describe('milestone / delivery-mode conflict resolution', () => {
  it('resolves ! + ~scrum to milestone and echoes the loser back', () => {
    const parse = resolveAuthoringDraft('Launch ! ~scrum', CTX);
    expect(parse.isMilestone).toBe(true);
    expect(parse.deliveryMode).toBe('milestone');
    expect(parse.duration).toBe(0);
    expect(parse.overridden.map((t) => t.raw)).toEqual(['~scrum']);
  });

  it('zeroes a duration typed alongside a milestone, and marks it overridden', () => {
    const parse = resolveAuthoringDraft('Launch ! #5d', CTX);
    expect(parse.duration).toBe(0);
    expect(parse.overridden.map((t) => t.raw)).toEqual(['#5d']);
  });

  it('treats ~milestone as the long spelling of !', () => {
    const parse = resolveAuthoringDraft('Launch ~milestone', CTX);
    expect(parse.isMilestone).toBe(true);
    expect(parse.deliveryMode).toBe('milestone');
    expect(parse.duration).toBe(0);
  });

  it('treats #0 as a milestone with the full invariant', () => {
    const parse = resolveAuthoringDraft('Launch #0', CTX);
    expect(parse.isMilestone).toBe(true);
    expect(parse.deliveryMode).toBe('milestone');
    expect(parse.duration).toBe(0);
  });

  it('leaves a non-milestone delivery mode alone', () => {
    const parse = resolveAuthoringDraft('Build ~gated #5d', CTX);
    expect(parse.isMilestone).toBe(false);
    expect(parse.deliveryMode).toBe('waterfall');
    expect(parse.duration).toBe(5);
    expect(parse.overridden).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dependency type cycling (⌥→)
// ---------------------------------------------------------------------------

describe('cycleDependencyType', () => {
  it('cycles FS → SS → FF → SF', () => {
    expect(cycleDependencyType('FS')).toBe('SS');
    expect(cycleDependencyType('SS')).toBe('FF');
    expect(cycleDependencyType('FF')).toBe('SF');
  });

  it('wraps SF back to FS', () => {
    expect(cycleDependencyType('SF')).toBe('FS');
  });

  it('wraps backwards without indexing out of range', () => {
    expect(cycleDependencyType('FS', -1)).toBe('SF');
  });

  it('returns to the start after a full lap', () => {
    let t: DependencyType = DEPENDENCY_TYPE_CYCLE[0];
    for (let i = 0; i < DEPENDENCY_TYPE_CYCLE.length; i++) t = cycleDependencyType(t);
    expect(t).toBe('FS');
  });
});

// ---------------------------------------------------------------------------
// Live caret state
// ---------------------------------------------------------------------------

describe('activeTokenFragment', () => {
  it('opens the owner picker mid @token', () => {
    expect(activeTokenFragment('Survey @an')).toMatchObject({ kind: 'owner', query: 'an' });
  });

  it('opens the predecessor picker mid >token', () => {
    expect(activeTokenFragment('Design >2.')).toMatchObject({ kind: 'predecessor', query: '2.' });
  });

  it('returns the LAST open sigil so a second token takes over', () => {
    expect(activeTokenFragment('Design >2.3 @an')).toMatchObject({ kind: 'owner', query: 'an' });
  });

  it('closes once whitespace ends the token', () => {
    expect(activeTokenFragment('Survey @ana ')).toBeNull();
  });

  it('does not open on a sigil mid-word', () => {
    // An email address must not summon the people picker.
    expect(activeTokenFragment('mail ana@example')).toBeNull();
  });

  it('keeps a bracketed parent fragment open across a space', () => {
    expect(activeTokenFragment('X [Design rev')).toMatchObject({
      kind: 'parent',
      query: 'Design rev',
    });
  });

  it('closes the parent fragment once the bracket is closed', () => {
    expect(activeTokenFragment('X [Design]')).toBeNull();
  });

  it('respects an explicit caret position rather than assuming end of string', () => {
    expect(activeTokenFragment('Survey @an more', 10)).toMatchObject({ query: 'an' });
  });

  it('offers the name without an in-progress `:percent` modifier', () => {
    expect(activeTokenFragment('Survey @ana:2')).toMatchObject({ kind: 'owner', query: 'ana' });
  });

  it('strips the modifier from a bracketed parent fragment carrying a newline', () => {
    // `[…]` is the one kind that survives whitespace, so it is the only fragment that can
    // reach here with a line break in it — the `/:.*$/` form this replaced left the
    // modifier in place on exactly that input.
    expect(activeTokenFragment('X [Design: Phase\n2')).toMatchObject({
      kind: 'parent',
      query: 'Design',
    });
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('segmentAuthoringName', () => {
  it('returns one plain segment when nothing needs marking', () => {
    expect(segmentAuthoringName('Survey', CTX)).toEqual([{ text: 'Survey', state: 'plain' }]);
  });

  it('marks an unresolved token without disturbing the text around it', () => {
    expect(segmentAuthoringName('Survey @nobody done', CTX)).toEqual([
      { text: 'Survey ', state: 'plain' },
      { text: '@nobody', state: 'unresolved' },
      { text: ' done', state: 'plain' },
    ]);
  });

  it('marks an overridden token so the author sees what did not take', () => {
    const segments = segmentAuthoringName('Launch ! ~scrum', CTX);
    expect(segments.find((s) => s.state === 'overridden')?.text).toBe('~scrum');
  });
});

describe('predecessor dependency type', () => {
  it('defaults to FS when no type is spelled', () => {
    expect(parseAuthoringTokens('X >2.3')[0]).toMatchObject({ depType: 'FS' });
  });

  it('reads an explicit type suffix', () => {
    expect(parseAuthoringTokens('X >2.3:SS')[0]).toMatchObject({ query: '2.3', depType: 'SS' });
  });

  it('reads a type and a lag together', () => {
    expect(parseAuthoringTokens('X >2.3:FF-1d')[0]).toMatchObject({
      query: '2.3',
      depType: 'FF',
      lag: -1,
    });
  });

  it('resolves the type through to the committed edge', () => {
    const parse = resolveAuthoringDraft('X >2.3:SS+2d', CTX);
    expect(parse.predecessors).toEqual([
      { taskId: 't-survey', name: 'Survey', lag: 2, depType: 'SS' },
    ]);
  });
});

describe('cycleDependencyTypeInDraft', () => {
  it('cycles the token the caret sits in', () => {
    const draft = 'X >2.3';
    expect(cycleDependencyTypeInDraft(draft, draft.length)).toBe('X >2.3:SS');
  });

  it('preserves the lag while cycling', () => {
    const draft = 'X >2.3+2d';
    expect(cycleDependencyTypeInDraft(draft, draft.length)).toBe('X >2.3:SS+2d');
  });

  it('drops the redundant :FS suffix when it wraps back to the default', () => {
    const draft = 'X >2.3:SF';
    expect(cycleDependencyTypeInDraft(draft, draft.length)).toBe('X >2.3');
  });

  it('cycles backwards for the reverse binding', () => {
    const draft = 'X >2.3';
    expect(cycleDependencyTypeInDraft(draft, draft.length, -1)).toBe('X >2.3:SF');
  });

  it('quotes a multi-word predecessor when rewriting it', () => {
    const draft = 'X >"Design review"';
    expect(cycleDependencyTypeInDraft(draft, draft.length)).toBe('X >"Design review":SS');
  });

  it('returns null when the caret is not on a predecessor token', () => {
    // The caller must let the keystroke fall through rather than swallow an arrow
    // key the author meant for cursor movement.
    expect(cycleDependencyTypeInDraft('Just a name', 5)).toBeNull();
  });
});
