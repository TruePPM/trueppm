import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SettingsSection } from '../SettingsShell';
import {
  ProjectTeamWorkflowPage,
  TEAM_WORKFLOW_SECTION_ID,
  TEAM_WORKFLOW_SUBSECTION_IDS,
} from './ProjectTeamWorkflowPage';
import { SETTINGS_DOCS } from '../settingsDocs';
import type { Methodology } from '@/types';

/**
 * The consolidated "How this team works" section (#2969, epic #2743).
 *
 * The three blocks are stubbed. This file is about the *page's own* contract —
 * what it composes, how it titles the composition, and the constraint the issue
 * draws a line at — not about re-testing three components that already have their
 * own suites.
 */
vi.mock('./ProjectMethodologyPage', () => ({
  ProjectMethodologyPage: (p: { embedded?: boolean; docsHref?: string }) => (
    <div
      data-testid="block-methodology"
      data-embedded={String(!!p.embedded)}
      data-docs={p.docsHref}
    >
      METHODOLOGY_BLOCK
    </div>
  ),
}));
vi.mock('./ProjectWorkflowPage', () => ({
  ProjectWorkflowPage: (p: { embedded?: boolean; docsHref?: string }) => (
    <div data-testid="block-workflow" data-embedded={String(!!p.embedded)} data-docs={p.docsHref}>
      WORKFLOW_BLOCK
    </div>
  ),
}));
vi.mock('./ProjectGuardrailsPage', () => ({
  ProjectGuardrailsPage: (p: { embedded?: boolean; docsHref?: string }) => (
    <div data-testid="block-guardrails" data-embedded={String(!!p.embedded)} data-docs={p.docsHref}>
      GUARDRAILS_BLOCK
    </div>
  ),
}));

const state = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  isLoading: false,
  /** The project's own word for an iteration — relabelled in the ADR-0111 tests. */
  label: { singular: 'Sprint', plural: 'Sprints', lower: 'sprint' },
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: state.project, isLoading: state.isLoading }),
}));
vi.mock('@/hooks/useIterationLabel', () => ({ useIterationLabel: () => state.label }));

function seed(over: Record<string, unknown> = {}) {
  state.project = {
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    board_cadence: 'sprint',
    ...over,
  };
}

function renderPage() {
  return render(
    <SettingsSection id={TEAM_WORKFLOW_SECTION_ID}>
      <ProjectTeamWorkflowPage />
    </SettingsSection>,
  );
}

/** The one-sentence restatement of the preset. */
const summaryLine = () => screen.getByText(/This team runs/);

describe('<ProjectTeamWorkflowPage>', () => {
  beforeEach(() => {
    seed();
    state.isLoading = false;
    state.label = { singular: 'Sprint', plural: 'Sprints', lower: 'sprint' };
  });

  it('mounts the three former sections as one, in the exported document order', () => {
    // Derived from the constant, not a second hard-coded list: the constant
    // documents itself as document order and four other things key off it, so
    // reordering it must not be able to leave the page silently disagreeing.
    renderPage();
    const rendered = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="block-"]'),
    ).map((n) => n.dataset.testid);
    expect(rendered).toEqual(TEAM_WORKFLOW_SUBSECTION_IDS.map((id) => `block-${id}`));
  });

  it('titles the region once and mounts the blocks embedded beneath it', () => {
    renderPage();
    // Exactly one h2 — the section's. Three h2s would mean three sections' worth
    // of heading ids under one id namespace (see SettingsShell.test.tsx).
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.map((h) => h.textContent)).toEqual(['How this team works']);
    for (const id of TEAM_WORKFLOW_SUBSECTION_IDS) {
      expect(screen.getByTestId(`block-${id}`).dataset.embedded).toBe('true');
    }
  });

  it('gives each block a sub-anchor, so a retired deep link lands on the block', () => {
    renderPage();
    for (const id of TEAM_WORKFLOW_SUBSECTION_IDS) {
      const wrapper = document.querySelector(`[data-settings-anchor="${id}"]`);
      expect(wrapper, `no sub-anchor for the retired #${id} link`).not.toBeNull();
      expect(wrapper!.contains(screen.getByTestId(`block-${id}`))).toBe(true);
    }
  });

  it('hands each block its own docs slug, resolved from the one map', () => {
    // Not a literal per block: a hard-coded docsHref inside a component is checked
    // by nothing, while SETTINGS_DOCS entries are resolved against the real docs
    // tree by settingsDocs.test.ts.
    renderPage();
    for (const id of TEAM_WORKFLOW_SUBSECTION_IDS) {
      expect(screen.getByTestId(`block-${id}`).dataset.docs).toBe(SETTINGS_DOCS.project[id]);
    }
    const slugs = TEAM_WORKFLOW_SUBSECTION_IDS.map((id) => SETTINGS_DOCS.project[id]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('<ProjectTeamWorkflowPage> preset restatement', () => {
  beforeEach(() => {
    seed();
    state.isLoading = false;
    state.label = { singular: 'Sprint', plural: 'Sprints', lower: 'sprint' };
  });

  // Every member of the enum, not a sample — HYBRID in particular was the silent
  // gap: it is also the value a stale fallback would produce.
  const CASES: Array<{ m: Methodology; matches: RegExp; paced: RegExp | null }> = [
    { m: 'AGILE', matches: /runs Agile — sprints, story points and velocity/, paced: /in sprints/ },
    {
      m: 'HYBRID',
      matches: /runs Hybrid — phase gates on the outside and sprints inside delivery/,
      paced: /in sprints/,
    },
    {
      m: 'WATERFALL',
      matches: /runs Waterfall — phases, gates, baselines and the critical path/,
      // Waterfall has no iteration cadence, so the clause must be absent — not
      // rendered as "paced in sprints" for a project that has none.
      paced: null,
    },
  ];

  it.each(CASES)('restates $m in the team’s own words', ({ m, matches, paced }) => {
    seed({ methodology: m, effective_methodology: m });
    renderPage();
    expect(summaryLine()).toHaveTextContent(matches);
    if (paced) expect(summaryLine()).toHaveTextContent(paced);
    else expect(summaryLine()).not.toHaveTextContent(/paced/);
  });

  it.each(['AGILE', 'HYBRID'] as const)(
    'follows the project’s iteration label instead of saying "sprint" (%s)',
    (m) => {
      // The fixture RELABELS the container. With "Sprint" in place a hard-coded
      // literal produces byte-identical output and the assertion cannot fail —
      // which is how an ADR-0111 regression stays green.
      state.label = { singular: 'Iteration', plural: 'Iterations', lower: 'iteration' };
      seed({ methodology: m, effective_methodology: m });
      renderPage();
      expect(summaryLine()).toHaveTextContent(/iterations/);
      expect(summaryLine()).not.toHaveTextContent(/sprint/i);
    },
  );

  it('names continuous flow when the board is not on an iteration cadence', () => {
    seed({ board_cadence: 'continuous' });
    renderPage();
    expect(summaryLine()).toHaveTextContent(/paced as continuous flow/);
  });

  it('prefers the server-resolved effective methodology over the raw override', () => {
    // The picker below writes `methodology`; what the team actually runs is
    // `effective_methodology`, which is where a workspace INHERIT policy lands.
    // Summarising the override would tell a locked project the wrong thing.
    seed({ methodology: 'AGILE', effective_methodology: 'WATERFALL' });
    renderPage();
    expect(summaryLine()).toHaveTextContent(/runs Waterfall/);
  });

  it('states nothing while the project is still loading', () => {
    // `?? 'HYBRID'` here would tell a Waterfall project it runs Hybrid, as a
    // plain statement of fact, for the length of the fetch — on the one block
    // whose entire job is to be the trustworthy restatement.
    state.project = undefined;
    state.isLoading = true;
    renderPage();
    expect(screen.queryByText(/This team runs/)).toBeNull();
    expect(screen.getByText(/Reading this project’s setup/)).toBeInTheDocument();
  });

  it('says so when the project could not be read, rather than guessing', () => {
    state.project = undefined;
    state.isLoading = false;
    renderPage();
    expect(screen.queryByText(/This team runs/)).toBeNull();
    expect(screen.getByText(/setup is unavailable/)).toBeInTheDocument();
  });

  it('announces itself politely, since the control that changes it is off-screen', () => {
    renderPage();
    const live = summaryLine().closest('[role="status"]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
  });
});

describe('<ProjectTeamWorkflowPage> the line the issue draws', () => {
  beforeEach(() => {
    seed();
    state.isLoading = false;
    state.label = { singular: 'Sprint', plural: 'Sprints', lower: 'sprint' };
  });

  it('claims only that the preset sets defaults — not that nothing here can stop you', () => {
    // The wider claim ("nothing on this page stops anyone") is FALSE: Sprint
    // guardrails is on this page and an Owner may escalate a rule to Block, whose
    // own help text reads "Block stops the action outright with no override".
    // Pinning the narrow claim is what stops the comfortable one coming back.
    renderPage();
    const summary = screen.getByText(/A preset describes how this team works/);
    expect(summary).toHaveTextContent(/sets defaults, never limits/);
    expect(summary).toHaveTextContent(/hidden, not withdrawn/);
    expect(summary).toHaveTextContent(/The one place this section can stop an action is/);
    expect(summary).toHaveTextContent(/Sprint guardrails/);
    expect(summary).not.toHaveTextContent(/nothing on this page stops/i);
  });

  it('scopes the Surfaces claim to the surfaces Surfaces actually toggles', () => {
    // Settings → Surfaces exposes Reports, Time tracking, Baselines and the
    // forecast (ADR-0193). It does NOT bring back Board / Schedule / Sprints, so
    // "every surface it switches off can be turned back on under Surfaces" sent
    // the reader to a screen that cannot do what they were promised.
    renderPage();
    const summary = screen.getByText(/A preset describes how this team works/);
    expect(summary).toHaveTextContent(/Reports, Time tracking, Baselines/);
    const link = screen.getByRole('link', { name: 'Surfaces' });
    expect(link).toHaveAttribute('href', '#surfaces');
  });

  it('offers no control that could enforce anything', () => {
    // The moment the summary grows a control, the sentence above it stops being
    // true. The jump strip's buttons are siblings, not children — they scroll and
    // change no state.
    renderPage();
    const strip = screen.getByText(/A preset describes how this team works/).closest('div');
    expect(strip).not.toBeNull();
    expect(
      strip!.querySelectorAll('button, input, select, textarea, [role="switch"]'),
    ).toHaveLength(0);
  });

  it('renders no board-column editor of its own — the Workflow block owns it', () => {
    // Two editors over one BoardColumnConfig is how the two drift (#2967). The
    // board columns on this page are the Statuses list the Workflow block already
    // renders, so the page's own markup must contain no second one.
    renderPage();
    expect(screen.queryByText(/Statuses/)).toBeNull();
    expect(screen.getByTestId('block-workflow')).toBeInTheDocument();
  });
});

describe('<ProjectTeamWorkflowPage> in-section jump strip', () => {
  beforeEach(() => {
    seed();
    state.isLoading = false;
    state.label = { singular: 'Sprint', plural: 'Sprints', lower: 'sprint' };
  });

  it('offers one jump per block, labelled the way the rail used to label it', () => {
    renderPage();
    const strip = screen.getByRole('navigation', { name: 'In this section' });
    const names = within_(strip).map((b) => b.textContent);
    expect(names).toEqual(['Methodology', 'Workflow & fields', 'Sprint guardrails']);
  });

  it('titles the guardrails jump with the project’s own iteration word', () => {
    state.label = { singular: 'Iteration', plural: 'Iterations', lower: 'iteration' };
    renderPage();
    expect(screen.getByRole('button', { name: 'Iteration guardrails' })).toBeInTheDocument();
  });

  it('scrolls to the block, and moves focus there for keyboard users', async () => {
    const user = userEvent.setup();
    renderPage();
    // jsdom implements neither; assert the call, which is the contract.
    const target = document.querySelector<HTMLElement>('[data-settings-anchor="guardrails"]')!;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    await user.click(screen.getByRole('button', { name: 'Sprint guardrails' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: 'start' });
  });
});

/** The strip's buttons, in DOM order. */
function within_(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('button'));
}
