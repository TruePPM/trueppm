import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SettingsSection } from '../SettingsShell';
import {
  ProjectTeamWorkflowPage,
  TEAM_WORKFLOW_SECTION_ID,
  TEAM_WORKFLOW_SUBSECTION_IDS,
} from './ProjectTeamWorkflowPage';
import { SETTINGS_DOCS } from '../settingsDocs';

/**
 * The consolidated "How this team works" section (#2969, epic #2743).
 *
 * The three blocks are stubbed. This file is about the *page's own* contract —
 * what it composes, how it titles the composition, and the one constraint the
 * issue draws a line at — not about re-testing three components that already have
 * their own suites.
 */
vi.mock('./ProjectMethodologyPage', () => ({
  ProjectMethodologyPage: (p: { embedded?: boolean; docsHref?: string }) => (
    <div data-testid="block-methodology" data-embedded={String(!!p.embedded)} data-docs={p.docsHref}>
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

const project = vi.hoisted(() => ({
  current: {
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    board_cadence: 'sprint',
  } as Record<string, unknown> | undefined,
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: project.current }) }));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ singular: 'Sprint', plural: 'Sprints', lower: 'sprint' }),
}));

function renderPage() {
  return render(
    <SettingsSection id={TEAM_WORKFLOW_SECTION_ID}>
      <ProjectTeamWorkflowPage />
    </SettingsSection>,
  );
}

describe('<ProjectTeamWorkflowPage>', () => {
  beforeEach(() => {
    project.current = {
      methodology: 'AGILE',
      effective_methodology: 'AGILE',
      board_cadence: 'sprint',
    };
  });

  it('mounts the three former sections as one, in document order', () => {
    renderPage();
    const rendered = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="block-"]'),
    ).map((n) => n.dataset.testid);
    expect(rendered).toEqual(['block-methodology', 'block-workflow', 'block-guardrails']);
  });

  it('titles the region once and mounts the blocks embedded beneath it', () => {
    renderPage();
    // Exactly one h2 — the section's. Three h2s would mean three sections' worth
    // of heading ids under one id namespace (see SettingsShell.test.tsx).
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.map((h) => h.textContent)).toEqual(['How this team works']);
    for (const id of ['methodology', 'workflow', 'guardrails']) {
      expect(screen.getByTestId(`block-${id}`).dataset.embedded).toBe('true');
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

  it('restates the preset in the team’s own words', () => {
    renderPage();
    expect(screen.getByText(/This team runs/)).toHaveTextContent(
      'This team runs Agile — sprints, story points and velocity, with the Board leading. Work is paced in sprints.',
    );
  });

  it('follows the project’s iteration label rather than saying "sprint"', () => {
    renderPage();
    expect(screen.getByText(/This team runs/)).toHaveTextContent(/paced in sprints/);
  });

  it('drops the cadence clause for Waterfall, which has no iteration cadence', () => {
    project.current = {
      methodology: 'WATERFALL',
      effective_methodology: 'WATERFALL',
      board_cadence: 'sprint',
    };
    renderPage();
    const line = screen.getByText(/This team runs/);
    expect(line).toHaveTextContent(/Waterfall — phases, gates, baselines and the critical path/);
    expect(line).not.toHaveTextContent(/paced/);
  });

  it('names continuous flow when the board is not on a sprint cadence', () => {
    project.current = {
      methodology: 'AGILE',
      effective_methodology: 'AGILE',
      board_cadence: 'continuous',
    };
    renderPage();
    expect(screen.getByText(/This team runs/)).toHaveTextContent(/paced as continuous flow/);
  });

  it('prefers the server-resolved effective methodology over the raw override', () => {
    // The picker below writes `methodology`; what the team actually runs is
    // `effective_methodology`, which is where a workspace INHERIT policy lands.
    // Summarising the override would tell a locked project the wrong thing.
    project.current = {
      methodology: 'AGILE',
      effective_methodology: 'WATERFALL',
      board_cadence: 'sprint',
    };
    renderPage();
    expect(screen.getByText(/This team runs/)).toHaveTextContent(/runs Waterfall/);
  });

  it('says in words that the preset does not enforce, and offers no control that could', () => {
    // The constraint this page is built under (#2969): the preset communicates and
    // never enforces. The summary is prose and nothing else — the moment it grows
    // a control, the sentence stops being true and this fails.
    renderPage();
    const summary = screen.getByText(/A preset describes how this team works/);
    expect(summary).toHaveTextContent(/sets defaults, never limits/);
    expect(summary).toHaveTextContent(/nothing on this page stops anyone/);

    const strip = summary.closest('div');
    expect(strip).not.toBeNull();
    expect(strip!.querySelectorAll('button, input, select, textarea, [role="switch"]')).toHaveLength(
      0,
    );
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
