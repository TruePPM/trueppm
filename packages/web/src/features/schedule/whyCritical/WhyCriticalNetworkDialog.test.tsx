import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DrivingChainNode, ScheduleDrivingChain } from '@/api/types';
import { buildWhyCriticalView } from './whyCriticalModel';
import { WhyCriticalNetworkDialog } from './WhyCriticalNetworkDialog';

function node(p: Partial<DrivingChainNode> & { task_id: string; name: string }): DrivingChainNode {
  return {
    status: 'NOT_STARTED',
    direction: 'upstream',
    hops: 1,
    early_start: '2027-03-08',
    early_finish: '2027-03-12',
    total_float: { value: 0, unit: 'working_days' },
    band: 'critical',
    is_critical: true,
    is_project_finish: false,
    sprint: null,
    ...p,
  };
}

const edge = (pred: string, succ: string, driving = true) => ({
  predecessor_id: pred,
  successor_id: succ,
  dep_type: 'FS',
  lag: { value: 0, unit: 'calendar_days' as const },
  is_driving: driving,
  via_summary: null,
});

const CHAIN = {
  schema_version: 1,
  project_id: 'p1',
  task_id: 'frame',
  computable: true,
  reason: null,
  project_finish: '2027-06-02',
  depth: 3,
  node_cap: 50,
  truncated: false,
  truncated_reason: null,
  total_links: 3,
  omitted_non_driving_count: 0,
  near_critical_threshold: { value: 10, unit: 'working_days' },
  calendar_id: null,
  nodes: [
    node({ task_id: 'frame', name: 'Frame walls', direction: 'self', hops: 0 }),
    node({ task_id: 'pour', name: 'Pour foundation' }),
    node({
      task_id: 'odd',
      name: 'Odd link',
      band: 'some_future_band',
      is_critical: false,
      total_float: { value: 3, unit: 'working_days' },
    }),
    node({ task_id: 'survey', name: 'Site survey', hops: 2 }),
  ],
  edges: [edge('pour', 'frame'), edge('odd', 'frame', false), edge('survey', 'pour')],
  _provenance: {
    schema_version: 1,
    engine_version: '0.5.0',
    api_version: '1',
    input_hash: 'sha256:0f',
    computed_at: '2027-03-02T14:02:00Z',
  },
} as unknown as ScheduleDrivingChain;

function renderDialog(onClose = vi.fn(), onOpenTask = vi.fn()) {
  const view = buildWhyCriticalView(CHAIN, new Date(2027, 2, 1))!;
  render(
    <WhyCriticalNetworkDialog
      chain={CHAIN}
      view={view}
      copyText="text"
      onClose={onClose}
      onOpenTask={onOpenTask}
    />,
  );
  return { onClose, onOpenTask };
}

function card(name: RegExp) {
  return screen.getByRole('button', { name });
}

describe('WhyCriticalNetworkDialog (#4892)', () => {
  it('moves a roving focus with arrows, Home and End', () => {
    renderDialog();
    const self = card(/^Frame walls\./);
    expect(self).toHaveAttribute('tabindex', '0');
    self.focus();
    fireEvent.keyDown(self, { key: 'ArrowLeft' });
    expect(card(/^Pour foundation\./)).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(card(/^Odd link\./)).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(card(/^Site survey\./)).toHaveFocus();
    expect(card(/^Site survey\./)).toHaveAttribute('tabindex', '0');
    expect(card(/^Frame walls\./)).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(card(/^Frame walls\./)).toHaveFocus();
  });

  it('Enter on another task opens it', () => {
    const { onOpenTask } = renderDialog();
    const pour = card(/^Pour foundation\./);
    fireEvent.keyDown(pour, { key: 'Enter' });
    expect(onOpenTask).toHaveBeenCalledWith('pour');
  });

  it('Escape closes the dialog and does not reach a document listener', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const { onClose } = renderDialog();
    fireEvent.keyDown(card(/^Frame walls\./), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });

  it('prints the legend with the threshold and units', () => {
    renderDialog();
    expect(
      screen.getByText(/Solid link: driving, critical or near-critical · Dashed: Not driving/),
    ).toHaveTextContent('Near-critical: ≤ 10 wd float');
  });

  it('renders an unknown band neutral: no band word in the card or its name', () => {
    renderDialog();
    const odd = card(/^Odd link\./);
    expect(odd.getAttribute('aria-label')).not.toMatch(/Critical|Near-critical|Ample/);
    expect(odd).not.toHaveTextContent(/Critical|Near-critical/);
    expect(odd.className).not.toMatch(/semantic-at-risk/);
  });
});
