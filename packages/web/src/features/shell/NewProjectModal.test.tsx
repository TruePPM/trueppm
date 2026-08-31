import type { ComponentProps } from 'react';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { NewProjectModal } from './NewProjectModal';
import type { ProjectTemplate } from '@/hooks/useProjectTemplates';

const mutateMock = vi.fn();
const mockMutation = {
  mutate: mutateMock,
  isPending: false,
  isError: false,
};
vi.mock('@/hooks/useProjectMutations', () => ({
  useCreateProject: () => mockMutation,
}));

const applyTemplateMutateMock = vi.fn();
vi.mock('@/hooks/useProjectTemplates', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjectTemplates: () => templatesResult,
  useApplyTemplate: () => ({ mutate: applyTemplateMutateMock }),
}));

// Programs offered by the picker (#2673). Every row already carries
// effective_methodology / effective_calendar / calendar_source (ADR-0107,
// ADR-0441) — the Start sheet reads these directly rather than issuing a second
// request.
interface MockProgram {
  id: string;
  name: string;
  code: string;
  my_role: number | null;
  is_closed: boolean;
  effective_methodology?: string;
  effective_calendar?: { id: string; name: string; working_days: number; hours_per_day: number; holiday_count: number } | null;
  calendar_source?: string;
}
const programsResult = {
  data: [
    { id: 'program-uuid-123', name: 'Apollo', code: '', my_role: 300, is_closed: false, effective_methodology: 'AGILE', effective_calendar: { id: 'cal-apollo', name: 'Apollo Cal', working_days: 31, hours_per_day: 8, holiday_count: 0 }, calendar_source: 'program' },
    { id: 'program-uuid-456', name: 'Zephyr', code: 'ZPH', my_role: 300, is_closed: false, effective_methodology: 'WATERFALL' },
    // Below ADMIN (Member=100) — must never be offered (would 400 at submit, ADR-0070).
    { id: 'program-viewer', name: 'Viewer Only Program', code: '', my_role: 100, is_closed: false },
    // ADMIN but closed — MoveToProgramModal's precedent excludes closed programs too.
    { id: 'program-closed', name: 'Closed Program', code: '', my_role: 300, is_closed: true },
  ] as MockProgram[],
  isLoading: false,
  error: null,
};
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => programsResult,
}));

const workspaceResult = {
  data: { methodology: 'HYBRID', calendar: null } as { methodology: string; calendar: string | null } | undefined,
  isLoading: false,
};
vi.mock('@/features/settings/hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => workspaceResult,
}));

const libraryResult = {
  data: [] as Array<{ id: string; name: string; working_days: number; hours_per_day: number; timezone: string; exceptions: unknown[] }>,
  isLoading: false,
};
vi.mock('@/hooks/useProjectCalendars', () => ({
  useCalendarLibrary: () => libraryResult,
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { display_name: 'Artemis' }, isLoading: false }),
}));

function makeTemplate(over: Partial<ProjectTemplate> = {}): ProjectTemplate {
  return {
    id: 'tmpl-1',
    name: 'Delivery skeleton',
    description: 'Phases and gates',
    source_kind: 'workspace',
    provenance: 'Workspace',
    carries: ['structure'],
    methodology: 'WATERFALL',
    task_count: 5,
    version: 1,
    program: null,
    published_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}
const templatesResult = {
  data: [] as ProjectTemplate[],
  isLoading: false,
  isError: false,
};

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/components/Toast', () => ({
  toast: {
    success: (msg: string) => {
      toastSuccess(msg);
    },
    error: (msg: string) => {
      toastError(msg);
    },
  },
}));

describe('NewProjectModal — the Start sheet (#2728)', () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mutateMock.mockReset();
    mockMutation.isPending = false;
    mockMutation.isError = false;
    programsResult.data = [
      { id: 'program-uuid-123', name: 'Apollo', code: '', my_role: 300, is_closed: false, effective_methodology: 'AGILE', effective_calendar: { id: 'cal-apollo', name: 'Apollo Cal', working_days: 31, hours_per_day: 8, holiday_count: 0 }, calendar_source: 'program' },
      { id: 'program-uuid-456', name: 'Zephyr', code: 'ZPH', my_role: 300, is_closed: false, effective_methodology: 'WATERFALL' },
      { id: 'program-viewer', name: 'Viewer Only Program', code: '', my_role: 100, is_closed: false },
      { id: 'program-closed', name: 'Closed Program', code: '', my_role: 300, is_closed: true },
    ];
    programsResult.isLoading = false;
    workspaceResult.data = { methodology: 'HYBRID', calendar: null };
    workspaceResult.isLoading = false;
    libraryResult.data = [];
    templatesResult.data = [];
    templatesResult.isLoading = false;
    templatesResult.isError = false;
  });

  function renderModal(props: Partial<ComponentProps<typeof NewProjectModal>> = {}) {
    return renderWithProviders(
      <NewProjectModal onClose={onClose} onCreated={onCreated} {...props} />,
    );
  }

  async function fillName(name = 'My Project') {
    await userEvent.type(screen.getByRole('textbox', { name: /^name/i }), name);
  }

  /** True when `a` comes before `b` in document order. */
  function precedes(a: Element, b: Element): boolean {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  // ---------------------------------------------------------------------------
  // One screen — every field present at once, no step navigation
  // ---------------------------------------------------------------------------

  it('renders every field on one screen: name, program, start date, calendar, ways', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^program$/i })).toBeInTheDocument();
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /working calendar/i })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /start from/i })).toBeInTheDocument();
    // No step indicator, no Next/Back — collecting everything at once.
    expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Order: the way in leads, the calendar lives in the footer (#3130,
  // design handoff case 01: "template / blank / import, calendar in the footer")
  // ---------------------------------------------------------------------------

  it('leads with the way in, then name → program → start date', () => {
    renderModal();
    const ways = screen.getByRole('radiogroup', { name: /start from$/i });
    const name = screen.getByRole('textbox', { name: /^name/i });
    const program = screen.getByRole('combobox', { name: /^program$/i });
    const startDate = screen.getByLabelText(/start date/i);

    expect(precedes(ways, name)).toBe(true);
    expect(precedes(name, program)).toBe(true);
    expect(precedes(program, startDate)).toBe(true);
  });

  it('puts the working calendar in the footer — after the fields, beside the actions', () => {
    renderModal();
    const form = document.getElementById('new-project-form');
    const startDate = screen.getByLabelText(/start date/i);
    const calendar = screen.getByRole('combobox', { name: /working calendar/i });
    const cancel = screen.getByRole('button', { name: /cancel/i });

    expect(precedes(startDate, calendar)).toBe(true);
    expect(precedes(calendar, cancel)).toBe(true);
    // The footer is pinned outside the scrolling <form>, which is what keeps the
    // calendar on screen however tall the Template list grows.
    expect(form).not.toBeNull();
    expect(form!.contains(startDate)).toBe(true);
    expect(form!.contains(calendar)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The commit note (#3130) — worded to create-on-submit, not to the handoff's
  // draft lifecycle, which this sheet deliberately does not have (#3127,
  // docs/design/handoff/2026-08-v4-beta1-review/README.md §5)
  // ---------------------------------------------------------------------------

  it('states in the footer that nothing is created until Create is pressed', () => {
    renderModal();
    // toBeVisible, not toBeInTheDocument: a stated outcome that renders to zero
    // width or display:none is the same as an absent one (rule 316(c)).
    expect(screen.getByText(/nothing is created until you press create project\./i)).toBeVisible();
  });

  it('the note names whichever commit button is actually on screen (#3130)', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('radio', { name: /^import/i }));
    expect(
      screen.getByText(/nothing is created until you press create & import spreadsheet\./i),
    ).toBeVisible();
    expect(screen.queryByText(/until you press create project\./i)).not.toBeInTheDocument();
  });

  it('does not deny a create that is already in flight', () => {
    // While the mutation is pending the note would be flatly false, and the button
    // it names ("Create project") is not on screen — it reads "Creating…". Rule 316
    // prefers no sentence to a confident wrong one.
    mockMutation.isPending = true;
    renderModal();
    expect(screen.queryByText(/nothing is created/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/until you press creating/i)).not.toBeInTheDocument();
  });

  it('does not state a silent discard the sheet has no unsaved-changes guard for', () => {
    // Rule 217 requires a guard on any dirty dismiss; this sheet has none on its
    // four dismiss paths. Saying "closing discards what you have entered" as
    // reassurance would ship that gap as though it were the intended contract.
    renderModal();
    expect(screen.queryByText(/closing this sheet discards/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be (lost|discarded)/i)).not.toBeInTheDocument();
  });

  it('describes the submit button with the note rather than renaming it', () => {
    renderModal();
    const submit = screen.getByRole('button', { name: /^create project$/i });
    const describedBy = submit.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/nothing is created/i);
  });

  it('never claims the sheet persists anything on its own', () => {
    // Rule 308(d): assert the *capability* is absent, not one retired phrasing.
    //
    // NARROWED in #3233, deliberately, and the narrowing is the point. This used to
    // include a bare `/\bdraft\b/i` on the reasoning that `commit_project()` — the only
    // draft → active transition — had no caller in the web app "until #3129". That was a
    // CONDITIONAL premise, not a permanent one, and #3129 shipped: the sheet now offers
    // an opt-in "Create as a draft" checkbox, so the word is legitimately on screen and
    // the old assertion would fail against correct code.
    //
    // What has NOT changed is the second half of the handoff's design, which #3127
    // rejected on grounds that have not expired: the sheet does not write anything as
    // you type, so any autosave / "we'll keep this for you" / "pick up where you left
    // off" copy would still be a false claim (it would also fire a real `project.created`
    // webhook per abandoned sheet). `handleSubmit` remains the only caller of
    // `useCreateProject`. Those are the claims still asserted absent.
    renderModal();
    for (const claim of [
      /until you open the designer/i,
      /\bautosave|auto-save|automatically saved|saved automatically\b/i,
      /we.?ll (keep|save|remember)/i,
      /pick up where you left off|returning is exact/i,
      /saved as a draft/i,
    ]) {
      expect(screen.queryByText(claim)).not.toBeInTheDocument();
    }
  });

  it('offers create-as-draft, off by default, and omits the flag entirely when unticked', async () => {
    // Off by default so the ordinary create is unchanged — and the flag is OMITTED
    // rather than sent as `false`, so a default payload is byte-identical to pre-#3233.
    renderModal();
    const box = screen.getByRole('checkbox', { name: /create as a draft/i });
    expect(box).not.toBeChecked();
    await fillName('Ordinary');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const payload = mutateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('start_as_draft');
  });

  it('sends start_as_draft when the box is ticked', async () => {
    renderModal();
    await fillName('Unagreed Plan');
    await userEvent.click(screen.getByRole('checkbox', { name: /create as a draft/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ start_as_draft: true }),
      expect.anything(),
    );
  });

  it('states the consequence of choosing draft, in the phrase that owns it', () => {
    // Rule 328: `DRAFT_EXCLUSION_SENTENCE` is the single owner of this fact — the
    // Overview header line and the commit confirm sheet render the same string. A
    // fourth phrasing here is how the three drifted apart the first time (#3129).
    renderModal();
    const box = screen.getByRole('checkbox', { name: /create as a draft/i });
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /held out of program rollup, portfolio health, search and My Work/i,
    );
  });

  it('cut fields (description, copy-settings-from, use-program-defaults, default member role) are not on this screen', () => {
    renderModal();
    expect(screen.queryByPlaceholderText(/optional/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /copy settings from/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /use .*defaults/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /default role for new members/i })).not.toBeInTheDocument();
  });

  it('focuses the name input on mount', () => {
    renderModal();
    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveFocus();
  });

  it('does not scroll the way cards off the top to reach that focus (rule 358)', () => {
    // Name is no longer the sheet's first control, and `focus()` defaults to
    // scrolling every scrollable ancestor until its target is visible — which on a
    // short viewport would scroll the way-in cards, the thing the reorder exists to
    // lead with, out of the body before they are ever read. jsdom does not lay out,
    // so the observable part is the option that suppresses it.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      renderModal();
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      const mountCall = focusSpy.mock.calls.find(
        (_call, i) => focusSpy.mock.instances[i] === nameInput,
      );
      expect(mountCall).toBeDefined();
      expect(mountCall![0]).toEqual({ preventScroll: true });
    } finally {
      focusSpy.mockRestore();
    }
  });

  it('Create is disabled until a name is entered', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('Create is disabled when name is whitespace only', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /^name/i }), '   ');
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape is pressed', async () => {
    renderModal();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the backdrop is clicked', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Program picker (#2666, #2673, ADR-0070/ADR-0764) — unchanged RBAC behavior
  // ---------------------------------------------------------------------------

  it('defaults to standalone with no route-inferred program', () => {
    renderModal();
    const picker = screen.getByRole('combobox', { name: /^program$/i });
    expect(picker).toHaveValue('');
    expect(within(picker).getByRole('option', { name: /none.*standalone/i })).toBeInTheDocument();
  });

  it('preselects the resolved program when creating under one', () => {
    renderModal({ programId: 'program-uuid-123', programName: 'Apollo' });
    const picker = screen.getByRole('combobox', { name: /^program$/i });
    expect(picker).toHaveValue('program-uuid-123');
    expect(within(picker).getByRole('option', { name: 'Apollo', selected: true })).toBeInTheDocument();
  });

  it('offers only open programs where the user holds ADMIN+', () => {
    renderModal();
    const picker = screen.getByRole('combobox', { name: /^program$/i });
    expect(within(picker).getByRole('option', { name: 'Apollo' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Zephyr (ZPH)' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /viewer only program/i })).not.toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /closed program/i })).not.toBeInTheDocument();
  });

  it('omits program from the payload when left standalone', async () => {
    renderModal();
    await fillName('Standalone');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('program');
  });

  it('includes the selected program in the payload', async () => {
    renderModal({ programId: 'program-uuid-123' });
    await fillName('In-Program');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'program-uuid-123' }),
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Methodology is derived, not asked (ADR-0041, ADR-0107, ADR-0791)
  // ---------------------------------------------------------------------------

  it('shows the derived methodology line for the Blank way with no program (workspace default)', () => {
    renderModal();
    expect(screen.getByText(/hybrid — every scheduling and delivery view/i)).toBeInTheDocument();
  });

  it('derives from the selected program’s effective_methodology once one is picked', async () => {
    renderModal();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^program$/i }), 'program-uuid-456');
    expect(screen.getByText(/waterfall — gantt, wbs, and critical path/i)).toBeInTheDocument();
  });

  it('sends the derived methodology explicitly in the create payload', async () => {
    renderModal();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^program$/i }), 'program-uuid-456');
    await fillName('Waterfall Project');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ methodology: 'WATERFALL' }),
      expect.anything(),
    );
  });

  it('derives from the chosen template’s methodology when the Template way is active', async () => {
    templatesResult.data = [makeTemplate({ methodology: 'WATERFALL' })];
    renderModal();
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    expect(screen.getByText(/waterfall — gantt, wbs, and critical path/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Three peer ways in — Template / Blank / Import (#2728)
  // ---------------------------------------------------------------------------

  it('defaults to Blank', () => {
    renderModal();
    expect(screen.getByRole('radio', { name: /^blank/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('importFirst preselects Import instead of Blank', () => {
    renderModal({ importFirst: true });
    expect(screen.getByRole('radio', { name: /^import/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /create & import spreadsheet/i })).toBeInTheDocument();
  });

  it('selecting Template shows the template list and lands on a template already chosen', async () => {
    templatesResult.data = [makeTemplate({ id: 'tmpl-a', name: 'Alpha skeleton' })];
    renderModal();
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    expect(screen.getByRole('radiogroup', { name: /start from a template/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /alpha skeleton/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('Create is disabled on the Template way until a template exists to select', async () => {
    templatesResult.data = [];
    renderModal();
    await fillName('No templates yet');
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('selecting Blank/Import shows static detail copy, not a list', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('radio', { name: /^import/i }));
    expect(screen.getByText(/opens the import wizard/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /start from a template/i })).not.toBeInTheDocument();
  });

  it('fires applyTemplate after create when Template way is active', async () => {
    templatesResult.data = [makeTemplate({ id: 'tmpl-a', name: 'Alpha skeleton' })];
    renderModal();
    await fillName('Templated');
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-1' });

    expect(applyTemplateMutateMock).toHaveBeenCalledWith(
      { templateId: 'tmpl-a', projectId: 'new-proj-1' },
      expect.anything(),
    );
  });

  it('reports methodology + templateApplied intent when Template way is active (#2734)', async () => {
    templatesResult.data = [makeTemplate({ id: 'tmpl-a', name: 'Agile skeleton', methodology: 'AGILE' })];
    renderModal();
    await fillName('Templated Agile');
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-1' });

    // On the template way `onCreated` is deferred until the apply *dispatch*
    // answers (#2731, ADR-0799 §1), so the application id can travel in `intent`
    // and the seeded landing has something to poll on mount. Nothing is reported
    // until that 202 resolves.
    expect(onCreated).not.toHaveBeenCalled();
    const applyOpts = applyTemplateMutateMock.mock.calls[0][1] as {
      onSuccess: (d: { application: string }) => void;
    };
    applyOpts.onSuccess({ application: 'app-1' });

    expect(onCreated).toHaveBeenCalledWith('new-proj-1', {
      methodology: 'AGILE',
      templateApplied: true,
      templateApplicationId: 'app-1',
    });
  });

  it('still reports the intent when the apply dispatch fails, minus the id (#2731)', async () => {
    templatesResult.data = [makeTemplate({ id: 'tmpl-a', name: 'Alpha skeleton' })];
    renderModal();
    await fillName('Templated');
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-1' });

    // A failed dispatch still leaves a real project; landing must proceed without
    // an application id rather than stranding the user on the sheet.
    const applyOpts = applyTemplateMutateMock.mock.calls[0][1] as { onError: () => void };
    applyOpts.onError();

    expect(onCreated).toHaveBeenCalledWith('new-proj-1', {
      methodology: 'WATERFALL',
      templateApplied: true,
    });
  });

  it('does not fire applyTemplate for Blank or Import', async () => {
    renderModal();
    await fillName('Blank one');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-2' });
    expect(applyTemplateMutateMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Working calendar (#2728, ADR-0441) — inherited by default, overridable
  // ---------------------------------------------------------------------------

  it('shows the inherited default calendar and omits `calendar` from the payload when left alone', async () => {
    workspaceResult.data = { methodology: 'HYBRID', calendar: 'cal-ws' };
    libraryResult.data = [{ id: 'cal-ws', name: 'Standard 40h', working_days: 31, hours_per_day: 8, timezone: 'UTC', exceptions: [] }];
    renderModal();
    const picker = screen.getByRole('combobox', { name: /working calendar/i });
    expect(within(picker).getByRole('option', { name: /standard 40h \(inherited\)/i })).toBeInTheDocument();

    await fillName('Inherits calendar');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('calendar');
  });

  it('sends an explicit `calendar` in the payload when the picker is overridden', async () => {
    libraryResult.data = [
      { id: 'cal-1', name: 'Compressed 4x10', working_days: 30, hours_per_day: 10, timezone: 'UTC', exceptions: [] },
    ];
    renderModal();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /working calendar/i }), 'cal-1');
    await fillName('Overrides calendar');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ calendar: 'cal-1' }),
      expect.anything(),
    );
  });

  it('shows the selected program’s effective_calendar as the inherited default', async () => {
    renderModal();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^program$/i }), 'program-uuid-123');
    const picker = screen.getByRole('combobox', { name: /working calendar/i });
    expect(within(picker).getByRole('option', { name: /apollo cal \(inherited\)/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // onCreated intent contract (#2710) — preserved
  // ---------------------------------------------------------------------------

  it('confirms creation with a success toast and reports an empty intent for Blank', async () => {
    renderModal();
    await fillName('  Alpha  ');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-1' });

    expect(toastSuccess).toHaveBeenCalledWith('Created Alpha');
    expect(onCreated).toHaveBeenCalledWith('new-proj-1', {});
  });

  it('reports importCsv intent when Import is the active way', async () => {
    renderModal();
    await fillName('Alpha');
    await userEvent.click(screen.getByRole('radio', { name: /^import/i }));
    await userEvent.click(screen.getByRole('button', { name: /create & import spreadsheet/i }));

    const opts = mutateMock.mock.calls[0][1] as { onSuccess: (d: { id: string }) => void };
    opts.onSuccess({ id: 'new-proj-1' });

    expect(onCreated).toHaveBeenCalledWith('new-proj-1', { importCsv: true });
  });

  it('submits with trimmed name', async () => {
    renderModal();
    await fillName('  Alpha  ');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));
    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.name).toBe('Alpha');
    expect(payload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows error message when the mutation fails', () => {
    mockMutation.isError = true;
    renderModal();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to create project/i);
  });

  it('shows the Creating… state while the mutation is pending', () => {
    mockMutation.isPending = true;
    renderModal();
    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Keyboard model (#2728): ways row ←/→ + letter jump, Enter submits
  // ---------------------------------------------------------------------------

  it('a letter key jumps to and commits a way while focus is inside the way-cards row', async () => {
    renderModal();
    const templateCard = screen.getByRole('radio', { name: /^template/i });
    screen.getByRole('radio', { name: /^blank/i }).focus();
    await userEvent.keyboard('t');
    expect(templateCard).toHaveFocus();
    expect(templateCard).toHaveAttribute('aria-checked', 'true');
  });

  // Since #3130 the way in leads the body, so the dialog's first tab stop is the
  // *selected* way card — its two siblings carry `tabindex="-1"` under the roving
  // model and are not tab stops at all. The trap has to agree with that, or
  // Shift+Tab off the real first stop never matches `first` and focus leaves the
  // modal entirely.
  it('traps focus with Tab cycling — last wraps to the selected way card', async () => {
    renderModal();
    await fillName('Test');
    const createBtn = screen.getByRole('button', { name: /create project/i });
    createBtn.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /^blank/i }));
  });

  it('traps focus with Shift+Tab — first to last', async () => {
    renderModal();
    // Create must be enabled (a disabled button is not a Tab stop) to be the
    // dialog's last focusable element for this assertion to be meaningful.
    await fillName('Test');
    screen.getByRole('radio', { name: /^blank/i }).focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /create project/i }));
  });

  it('Shift+Tab from the name field stays inside the dialog', async () => {
    renderModal();
    await fillName('Test');
    screen.getByRole('textbox', { name: /^name/i }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('dialog', { name: /new project/i })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it('keeps the footer calendar attached to the form it sits outside of', () => {
    // The field moved out of the <form> subtree (#3130); `form="new-project-form"`
    // is what keeps it part of the form for implicit submission, so Enter works
    // from here like it does from Name / Program / Start date.
    //
    // The attribute is the assertable half: jsdom implements implicit submission
    // for text inputs only, never for a <select>, so driving Enter here would pass
    // or fail on jsdom's gap rather than on this wiring. The browser half is
    // covered where a real one is running — e2e/context-create.spec.ts.
    renderModal();
    expect(screen.getByRole('combobox', { name: /working calendar/i })).toHaveAttribute(
      'form',
      'new-project-form',
    );
  });

  it('Tab from the start date reaches the footer calendar, then the actions', async () => {
    renderModal();
    await fillName('Test');
    screen.getByLabelText(/start date/i).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: /working calendar/i }),
    );
    // #3233 inserted the "Create as a draft" checkbox between the calendar and the
    // actions, matching its visual position in the footer.
    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('checkbox', { name: /create as a draft/i }),
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }));
  });

  // ---------------------------------------------------------------------------
  // Compact / full-screen presentation below 900px (#2728) — component-level
  // smoke test; the media-query threshold itself is covered by
  // useStartSheetCompact.test.ts.
  // ---------------------------------------------------------------------------

  it('still renders every field and the same way-card set regardless of viewport tier', () => {
    // useStartSheetCompact defaults to `false` (desktop) under jsdom's stubbed
    // matchMedia, matching every other test above — this test exists to record
    // that the compact branch shares the same field set, not to re-derive the
    // breakpoint logic itself.
    renderModal();
    expect(screen.getByRole('radiogroup', { name: /start from$/i }).querySelectorAll('[role="radio"]')).toHaveLength(3);
  });
});
