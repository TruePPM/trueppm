import { describe, expect, it } from 'vitest';
import type { DrivingChainEdge, DrivingChainNode, ScheduleDrivingChain } from '@/api/types';
import {
  bandKind,
  bandWord,
  buildCopyText,
  buildWhyCriticalView,
  composeSentence,
  isDrivingChain,
  lagLabel,
  notComputableText,
  sentenceText,
  truncationLines,
} from './whyCriticalModel';

const TODAY = new Date(2027, 2, 10);

function node(p: Partial<DrivingChainNode> & { task_id: string; name: string }): DrivingChainNode {
  return {
    status: 'IN_PROGRESS',
    direction: 'upstream',
    hops: 1,
    early_start: '2027-03-10',
    early_finish: '2027-03-14',
    total_float: { value: 0, unit: 'working_days' },
    band: 'critical',
    is_critical: true,
    is_project_finish: false,
    sprint: null,
    ...p,
  };
}

function edge(pred: string, succ: string, p: Partial<DrivingChainEdge> = {}): DrivingChainEdge {
  return {
    predecessor_id: pred,
    successor_id: succ,
    dep_type: 'FS',
    lag: { value: 0, unit: 'calendar_days' },
    is_driving: true,
    via_summary: null,
    ...p,
  };
}

function chain(p: Partial<ScheduleDrivingChain> = {}): ScheduleDrivingChain {
  return {
    schema_version: 1,
    project_id: 'p1',
    task_id: 'self',
    computable: true,
    reason: null,
    project_finish: '2027-06-02',
    depth: 3,
    node_cap: 50,
    truncated: true,
    truncated_reason: 'depth',
    total_links: 23,
    omitted_non_driving_count: 4,
    near_critical_threshold: { value: 10, unit: 'working_days' },
    calendar_id: null,
    nodes: [
      node({
        task_id: 'fin',
        name: 'Handover',
        direction: 'downstream',
        hops: 4,
        is_project_finish: true,
        early_finish: '2027-06-02',
      }),
      node({
        task_id: 'self',
        name: 'Frame walls',
        direction: 'self',
        hops: 0,
        early_finish: '2027-03-21',
      }),
      node({ task_id: 'pour', name: 'Pour foundation', hops: 1 }),
      node({
        task_id: 'rebar',
        name: 'Order rebar',
        hops: 2,
        band: 'near_critical',
        total_float: { value: 7, unit: 'working_days' },
        early_finish: '2027-03-03',
      }),
      node({
        task_id: 's1',
        name: 'Sprint task A',
        hops: 2,
        sprint: { id: 'sp4', finish_date: '2027-03-07' },
      }),
      node({
        task_id: 's2',
        name: 'Sprint task B',
        hops: 2,
        sprint: { id: 'sp4', finish_date: '2027-03-07' },
        total_float: { value: 2, unit: 'working_days' },
      }),
      node({ task_id: 'permit', name: 'Permit approval', hops: 3, early_finish: '2027-02-28' }),
    ],
    edges: [
      edge('pour', 'self'),
      edge('rebar', 'pour', { is_driving: false }),
      edge('s1', 'pour', { via_summary: [{ task_id: 'sum', name: 'Site prep' }] }),
      edge('s2', 's1'),
      edge('permit', 's2', { dep_type: 'SS', lag: { value: 1, unit: 'calendar_days' } }),
    ],
    _provenance: {
      schema_version: 1,
      engine_version: '0.4.3',
      api_version: '1',
      input_hash: 'sha256:abc',
      computed_at: '2027-03-02T14:02:00Z',
    },
    ...p,
  };
}

describe('composeSentence', () => {
  it('FS driver on a critical task', () => {
    expect(sentenceText(composeSentence(chain(), TODAY))).toBe(
      "Can't start until Pour foundation finishes on Mar 14. A delay to any step in this chain moves it.",
    );
  });

  it('links the driver name to its task', () => {
    const seg = composeSentence(chain(), TODAY).find((s) => s.taskId);
    expect(seg).toEqual({ text: 'Pour foundation', taskId: 'pour' });
  });

  it('spells out lag, before for negative, and the near-critical slip', () => {
    const c = chain({
      edges: [edge('pour', 'self', { lag: { value: -2, unit: 'calendar_days' } })],
    });
    c.nodes[1] = {
      ...c.nodes[1],
      band: 'near_critical',
      total_float: { value: 1, unit: 'working_days' },
    };
    expect(sentenceText(composeSentence(c, TODAY))).toBe(
      "Can't start until 2 calendar days before Pour foundation finishes on Mar 14. It can slip 1 working day before it becomes critical.",
    );
  });

  it('uses the SS/FF/SF verbs', () => {
    const verbs: Array<[DrivingChainEdge['dep_type'], string]> = [
      ['SS', "Can't start until Pour foundation starts on Mar 10."],
      ['FF', "Can't finish until Pour foundation finishes on Mar 14."],
      ['SF', "Can't finish until Pour foundation starts on Mar 10."],
    ];
    for (const [dep, expected] of verbs) {
      const c = chain({ edges: [edge('pour', 'self', { dep_type: dep })] });
      expect(sentenceText(composeSentence(c, TODAY))).toContain(expected);
    }
  });

  it('names two drivers, then counts the rest', () => {
    const two = chain({ edges: [edge('pour', 'self'), edge('permit', 'self')] });
    expect(sentenceText(composeSentence(two, TODAY))).toContain(
      'Pour foundation and Permit approval finish on Mar 14.',
    );
    const three = chain({
      edges: [edge('pour', 'self'), edge('permit', 'self'), edge('rebar', 'self')],
    });
    expect(sentenceText(composeSentence(three, TODAY))).toContain(
      'Pour foundation and 2 other tasks finish on Mar 14.',
    );
  });

  it('a sprint driver names the sprint end, never a member or a sprint number', () => {
    const c = chain({ edges: [edge('s1', 'self')] });
    const text = sentenceText(composeSentence(c, TODAY));
    expect(text).toBe(
      "Can't start until the sprint ends on Mar 7. A delay to any step in this chain moves it.",
    );
    expect(text).not.toContain('Sprint task A');
  });

  it('no driving link', () => {
    const c = chain({ edges: [edge('pour', 'self', { is_driving: false })] });
    expect(sentenceText(composeSentence(c, TODAY))).toMatch(/^No earlier task holds up/);
  });

  it('adds the year when it differs from today', () => {
    expect(sentenceText(composeSentence(chain(), new Date(2026, 0, 1)))).toContain('Mar 14, 2027');
  });

  it('an unknown band gets no second sentence', () => {
    const c = chain();
    c.nodes[1] = { ...c.nodes[1], band: 'mystery' };
    expect(sentenceText(composeSentence(c, TODAY))).toBe(
      "Can't start until Pour foundation finishes on Mar 14.",
    );
  });
});

describe('bands', () => {
  it('renders an unknown band neutral, without a word', () => {
    expect(bandKind('mystery')).toBe('unknown');
    expect(bandWord('unknown')).toBeNull();
    expect(bandWord(bandKind('ample'))).toBe('Not critical');
  });
});

describe('buildWhyCriticalView', () => {
  const view = buildWhyCriticalView(chain(), TODAY)!;

  it('orders finish, self, then upstream by hops', () => {
    expect(view.cards.map((c) => c.kind)).toEqual([
      'finish',
      'self',
      'task',
      'task',
      'sprint',
      'task',
    ]);
    expect(view.cards[2].title).toBe('Pour foundation');
    expect(view.downstreamGap).toBe('4 steps not listed (downstream)');
  });

  it('collapses consecutive sprint members to one team-owned card', () => {
    const sprint = view.cards.find((c) => c.kind === 'sprint')!;
    expect(sprint.title).toBe('Sprint · team-owned · ends Mar 7');
    expect(sprint.taskId).toBeNull();
    expect(sprint.memberIds).toEqual(['s1', 's2']);
    expect(sprint.float).toBe(0);
    expect(sprint.subtitle).toBe('2 steps back · work inside the sprint is planned by the team');
    // The internal s2 → s1 edge is not shown; the edge out of the group is.
    expect(sprint.outEdges.map((e) => e.label)).toEqual([
      'Finish-to-start into Pour foundation · lag 0 cal d · via Site prep',
    ]);
  });

  it('marks a node whose only out-edge is non-driving', () => {
    const rebar = view.cards.find((c) => c.title === 'Order rebar')!;
    expect(rebar.nonDriving).toBe(true);
    expect(rebar.outEdges[0].label).toMatch(/^Not driving · Finish-to-start into Pour foundation/);
  });

  it('labels units on every number', () => {
    expect(lagLabel(1)).toBe('lag +1 cal d');
    expect(lagLabel(-3)).toBe('lag -3 cal d');
    expect(view.thresholdLine).toBe('Near-critical: ≤ 10 wd float');
    expect(view.unitsLine).toContain('wd = working days');
  });

  it('returns null for a non-computable payload', () => {
    expect(
      buildWhyCriticalView(chain({ computable: false, nodes: [], edges: [] }), TODAY),
    ).toBeNull();
  });
});

describe('truncation', () => {
  it('depth and node-cap forms with singulars', () => {
    expect(truncationLines(chain())).toEqual([
      'Chain cut at 3 steps back. 5 of 23 links shown.',
      "4 more links don't drive any dates and aren't listed.",
    ]);
    expect(
      truncationLines(
        chain({ truncated_reason: 'node_cap', omitted_non_driving_count: 1, depth: 1 }),
      ),
    ).toEqual([
      'Chain cut at the 50-task limit. 5 of 23 links shown.',
      "1 more link doesn't drive any dates and isn't listed.",
    ]);
    expect(
      truncationLines(
        chain({ truncated: false, truncated_reason: null, omitted_non_driving_count: 0 }),
      ),
    ).toEqual([]);
  });
});

describe('buildCopyText (R4: a superset of the screen)', () => {
  const c = chain();
  const view = buildWhyCriticalView(c, TODAY)!;
  const text = buildCopyText(c, view);
  const flat = text.replace(/\n\s*/g, ' ');

  it('contains every rendered card title, subtitle and edge label', () => {
    for (const card of view.cards) {
      expect(flat).toContain(card.title);
      expect(flat).toContain(card.subtitle);
      for (const e of card.outEdges) expect(flat).toContain(e.label);
    }
  });

  it('prints band words, units, truncation, threshold and provenance', () => {
    expect(text).toContain('WHY CRITICAL: Frame walls');
    expect(text).toContain('Critical · 0 wd float · finishes Mar 21, 2027');
    expect(text).toContain('Near-critical');
    for (const l of view.truncationLines) expect(flat).toContain(l);
    expect(text).toContain('Near-critical: ≤ 10 wd float.');
    expect(text).toContain('cal d = calendar days (lag). Not addable.');
    expect(text).toContain('engine 0.4.3');
    expect(text).toContain('Project finish: Handover, Jun 2, 2027');
  });

  it('prints card subtitle dates in the year form', () => {
    const self = view.cards.find((card) => card.kind === 'self')!;
    expect(self.subtitle).toBe('Finishes Mar 21');
    expect(flat).toContain('Finishes Mar 21, 2027');
  });

  it('wraps at 60 characters', () => {
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('notComputableText', () => {
  it('covers each reason, the sprint-only case and unknown reasons', () => {
    expect(notComputableText('backlog', false)).toMatch(/^Backlog items/);
    expect(notComputableText('not_in_network', true)).toBe(
      "Sprint-only items have no dependency links, so they aren't shown here.",
    );
    expect(notComputableText('not_in_network', false)).toMatch(
      /^This task has no dependency links/,
    );
    expect(notComputableText('later_reason', false)).toBe(
      "Why this task is critical can't be shown right now.",
    );
  });
});

describe('isDrivingChain', () => {
  it('rejects the paginated catch-all shape', () => {
    expect(isDrivingChain({ count: 0, next: null, previous: null, results: [] })).toBe(false);
    expect(isDrivingChain(chain())).toBe(true);
  });
});
