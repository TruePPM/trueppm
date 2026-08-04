import { useRef, useState, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateProject } from '@/hooks/useProjectMutations';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { RolePicker } from '@/features/settings/members/RolePicker';
import { toast } from '@/components/Toast';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import type { Methodology } from '@/types';

// Shared chevron affordance for this modal's native <select> controls (matches the
// step-3 "Copy settings from" picker) — defined once so the Program picker (#2673)
// reuses the identical data-URI rather than a hand-retyped copy.
const SELECT_CHEVRON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")";

/** Where the user asked to land after the project exists (#2710). */
export interface CreatedProjectIntent {
  /**
   * Open the CSV/Excel import wizard on arrival instead of landing on an empty
   * project. The wizard needs a project id, so the project is created first and
   * handed in — the flow is one path from the user's side, two steps from the
   * server's.
   */
  importCsv?: boolean;
}

interface Props {
  onClose: () => void;
  /**
   * Called after the project is created so the caller can navigate to it.
   *
   * `intent` carries what the user asked for at the moment of commitment (#2710).
   * Callers that only ever create blank projects can ignore it — it is optional
   * precisely so the four existing call sites did not have to change.
   */
  onCreated: (projectId: string, intent?: CreatedProjectIntent) => void;
  /**
   * Make "Create & import spreadsheet" the primary action rather than the
   * secondary one (#2710). Set by the entry points a user reaches *because* they
   * have a spreadsheet — the zero-project sidebar and the My Work empty state —
   * so the button they came for is the one they land on.
   */
  importFirst?: boolean;
  /**
   * Optional route-inferred program to preselect in the step-1 picker (ADR-0070,
   * ADR-0764). This only SEEDS the modal's own `selectedProgramId` state — once the
   * user changes the picker, the payload and the step-3 "Use program defaults"
   * affordance follow that selection, never this prop (#2673). Caller must already
   * hold ADMIN+ on the target program for it to be a legal initial value — the
   * server gate raises 400 otherwise, and the picker itself only ever offers
   * programs the current user administers.
   */
  programId?: string;
  /**
   * Display name for `programId`, used only until `usePrograms()` resolves and the
   * picker can show the canonical name from the fetched list (ADR-0764 §2) — a
   * transient fallback, not a second source of truth.
   */
  programName?: string;
}

type Step = 1 | 2 | 3;
const TOTAL_STEPS: Step = 3;

// Methodology options per ADR-0041. Order matches the ADR's matrix
// (Waterfall, Agile, Hybrid). Hybrid is the default — keeps all tabs visible
// for users who haven't yet decided which planning model fits.
const METHODOLOGIES: ReadonlyArray<{
  id: Methodology;
  label: string;
  description: string;
}> = [
  { id: 'WATERFALL', label: 'Waterfall', description: 'Phase-gate scheduling with Gantt, WBS, and critical path' },
  { id: 'AGILE',     label: 'Agile',     description: 'Sprint-based delivery with Board, velocity, and burndown' },
  { id: 'HYBRID',    label: 'Hybrid',    description: 'Both scheduling models — all views available (default)' },
];

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * Multi-step modal for creating a new project.
 * Step 1: Name + description, plus a program picker (#2666, #2673) so the project's
 * program attachment is always a deliberate choice, never a silent route-inferred fact.
 * Step 2: Schedule dates. Step 3: Template.
 * Focus is trapped within the dialog and restored to the trigger element on close.
 */
export function NewProjectModal({
  onClose,
  onCreated,
  programId,
  programName,
  importFirst = false,
}: Props) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [methodology, setMethodology] = useState<Methodology>('HYBRID');
  // Optional source project to seed settings from at create time (#1659, ADR-0242).
  // Empty string = no copy (today's blank-defaults behavior).
  const [copySettingsFrom, setCopySettingsFrom] = useState('');
  // "Use program defaults" opt-in (#1909) — only meaningful when creating under a
  // program. When on, the server seeds the new project's planning model and
  // visibility from the parent program (a one-time copy, not locked inheritance),
  // so the manual planning-model picker and the project-source copy are disabled to
  // signal the program is providing those values.
  const [useProgramDefaults, setUseProgramDefaults] = useState(false);
  // The program this project attaches to (#2673, ADR-0764). `programId` only seeds
  // this — it is the single source of truth from here on, read by the step-1
  // picker, the step-3 "Use program defaults" affordance, and the create payload.
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(programId ?? null);
  // Default RBAC role applied to members later added without an explicit role
  // (ADR-0363, #157). Defaults to Team Member; the picker offers Viewer..Project
  // Manager (Owner is never a sensible blanket default).
  const [defaultMemberRole, setDefaultMemberRole] = useState<number>(ROLE_MEMBER);

  const nameRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  // Membership-scoped project list drives the "Copy settings from" options; the
  // field's queryset is IDOR-safe server-side, so we simply offer every readable
  // project as a source (ADR-0242).
  const { data: projects, isLoading: projectsLoading } = useProjects();
  // Program picker options (#2673, ADR-0764). Fetched unconditionally — usually
  // already warm in the ['programs'] cache from Sidebar, which mounts on every
  // authenticated route. Filtered to the exact RBAC predicate MoveToProgramModal
  // established: open programs where the caller holds ADMIN+ (ADR-0070) — offering
  // anything less would 400 at submit.
  const { data: programs, isLoading: programsLoading } = usePrograms();
  const eligiblePrograms = (programs ?? []).filter(
    (p) => !p.is_closed && p.my_role !== null && p.my_role >= ROLE_ADMIN,
  );
  const selectedProgramInEligible = eligiblePrograms.some((p) => p.id === selectedProgramId);
  // Canonical display name for the current selection: prefer the fetched list (the
  // more current source), falling back to the route-inferred `programName` prop only
  // while the selection still equals its original seed and the list hasn't resolved
  // it yet (or, defensively, never resolves it — e.g. the program closed between
  // CreateMenu's gate check and this modal opening).
  const selectedProgramName =
    eligiblePrograms.find((p) => p.id === selectedProgramId)?.name ??
    (selectedProgramId !== null && selectedProgramId === (programId ?? null)
      ? programName
      : undefined);

  // Changing the picker always resets "Use program defaults" (ADR-0764 §3) — an
  // opt-in reviewed against Program A must never silently carry over to Program B.
  // The checkbox's own re-render (new program name, unchecked) is the only signal;
  // no separate transition toast/hint (ux-design #2673).
  function handleProgramChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value === '' ? null : e.target.value;
    setSelectedProgramId(next);
    setUseProgramDefaults(false);
  }

  // Capture trigger before modal opens; restore focus on unmount.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Move focus to the primary input when the step changes.
  useEffect(() => {
    if (step === 1) nameRef.current?.focus();
    if (step === 2) startRef.current?.focus();
  }, [step]);

  // Escape closes; Tab/Shift+Tab cycles within the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const canAdvanceStep1 = name.trim().length > 0;
  const canAdvanceStep2 = startDate.length > 0;

  function advance() {
    if (step === 1 && canAdvanceStep1) setStep(2);
    else if (step === 2 && canAdvanceStep2) setStep(3);
  }

  function back() {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  }

  // Form submit handles both Enter-to-advance (steps 1–2) and final create (step 3).
  /**
   * What the user asked for on the click that submitted (#2710).
   *
   * Held in a ref rather than state because it is read inside the mutation's
   * `onSuccess`, which closes over the render that fired it — a state update in
   * the same click would not be visible there, and the user would silently land
   * on an empty project instead of the wizard they asked for.
   */
  const submitIntentRef = useRef<CreatedProjectIntent>({});
  /**
   * Mirror of the ref for rendering (#2710). The ref is the source of truth the
   * mutation callback reads; this is what decides which of the two buttons wears
   * the "Creating…" label. Both are needed: a ref is invisible to render, and
   * state is invisible to the closure `onSuccess` runs in.
   *
   * Only the clicked button changes label — two buttons both reading "Creating…"
   * is ambiguous to anyone navigating by accessible name.
   */
  const [pendingImport, setPendingImport] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (step < TOTAL_STEPS) { advance(); return; }
    if (!name.trim() || !startDate || createProject.isPending) return;
    // When seeding from the program (#1909), omit `methodology` so the parent
    // program's value is copied server-side — an explicit `methodology` in the
    // payload always wins over the copy (server precedence), which would defeat the
    // opt-in. `inherit_program_defaults` and `copy_settings_from` are mutually
    // exclusive (the server rejects both); the UI already gates them to one at a time.
    // Both read `selectedProgramId` — the picker's current value, not the
    // route-inferred `programId` prop (#2673, ADR-0764 §2).
    const inheritProgram = Boolean(selectedProgramId) && useProgramDefaults;
    createProject.mutate(
      {
        name: name.trim(),
        start_date: startDate,
        description: description.trim() || undefined,
        ...(inheritProgram ? {} : { methodology }),
        ...(selectedProgramId ? { program: selectedProgramId } : {}),
        ...(inheritProgram
          ? { inherit_program_defaults: true }
          : copySettingsFrom
            ? { copy_settings_from: copySettingsFrom }
            : {}),
        default_member_role: defaultMemberRole,
      },
      {
        onSuccess: (data) => {
          if (selectedProgramId) {
            void queryClient.invalidateQueries({
              queryKey: ['programs', selectedProgramId, 'projects'],
            });
          }
          // Confirm the create like every other creation moment (rule 185, #2048) —
          // the modal closes on navigation, so without this the user's first
          // commitment lands silently on an empty Overview.
          toast.success(`Created ${name.trim()}`);
          onCreated(data.id, submitIntentRef.current);
        },
      },
    );
  }

  return (
    <>
      {/* Backdrop — click-to-close but never a Tab stop (tabIndex=-1), so the
          first Tab lands on a control inside the dialog, not this invisible
          full-screen button (issue 1357). */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-neutral-overlay cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`New project — step ${step} of ${TOTAL_STEPS}`}
          className="w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col rounded-card border border-neutral-border bg-neutral-surface pointer-events-auto"
        >
          {/* Step indicator — pinned above the scroller (#2665) */}
          <div className="flex items-center gap-2 px-6 pt-6 mb-5" aria-hidden="true">
            {([1, 2, 3] as Step[]).map((n, i) => (
              <div key={n} className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold
                    ${n === step
                      ? 'bg-brand-primary text-neutral-text-inverse'
                      : n < step
                        ? 'bg-brand-primary/20 text-brand-primary'
                        : 'bg-neutral-surface-raised text-neutral-text-disabled'}`}
                >
                  {n}
                </div>
                {i < TOTAL_STEPS - 1 && (
                  <div className={`h-px w-8 ${n < step ? 'bg-brand-primary/40' : 'bg-neutral-border'}`} />
                )}
              </div>
            ))}
          </div>

          {/* Step body — the only scrollable region (#2665). Step 3 (Planning
              model) stacks enough content to exceed a laptop-height viewport, so
              this must scroll independently of the pinned step indicator above
              and the action footer below, or the Create button becomes
              pointer-unreachable. The submit button lives in the footer outside
              this <form>; it targets the form via `form="new-project-form"`
              (same pattern as TaskFormModal's renderHeader/renderBody/renderFooter split). */}
          <div className="flex-1 overflow-y-auto min-h-0">
          <form id="new-project-form" onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 pb-4">
            {/* Step 1: Name + Description */}
            {step === 1 && (
              <>
                <h2 className="text-base font-semibold text-neutral-text-primary">Project details</h2>
                {/* Program picker (#2673, ADR-0764) — the program a project attaches to
                    determines its rollup, cadence inheritance, and the step-3 defaults, so
                    it belongs here as a first-class field rather than only surfacing
                    (optionally) on step 3. Unconditional: renders whether or not a program
                    was inferred from the route, because a user creating a project with no
                    route context should still be able to attach it to a program they
                    administer, not only clear an inferred one. Options are scoped to open
                    programs the caller administers (ADR-0070) — offering anything less
                    would 400 at submit. */}
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">Program</span>
                  <select
                    value={selectedProgramId ?? ''}
                    onChange={handleProgramChange}
                    disabled={programsLoading}
                    aria-label="Program"
                    style={{ backgroundImage: SELECT_CHEVRON }}
                    className="h-9 pl-3 pr-8 rounded-control border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.5rem_center]
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">None — standalone project</option>
                    {/* Synthetic option for a selection not (yet, or ever) present in the
                        fetched list — the route-inferred seed while usePrograms() is still
                        loading, or defensively if it never resolves as eligible (ADR-0764 §5).
                        Guarantees the select never points at a value with no matching
                        <option>, which would otherwise render blank. */}
                    {selectedProgramId && !selectedProgramInEligible && (
                      <option value={selectedProgramId}>
                        {selectedProgramName ?? (programsLoading ? 'Loading…' : 'Unnamed program')}
                      </option>
                    )}
                    {eligiblePrograms.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code ? `${p.name} (${p.code})` : p.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-neutral-text-secondary">
                    Groups this project for shared rollup and cadence. You can move it to a
                    different program later from project settings.
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    Name <span aria-hidden="true">*</span>
                  </span>
                  <input
                    ref={nameRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={255}
                    required
                    aria-required="true"
                    placeholder="My Project"
                    className="h-9 px-3 rounded-control border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Optional"
                    className="px-3 py-2 rounded-control border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary resize-none
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  />
                </label>
              </>
            )}

            {/* Step 2: Schedule */}
            {step === 2 && (
              <>
                <h2 className="text-base font-semibold text-neutral-text-primary">Schedule</h2>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    Start date <span aria-hidden="true">*</span>
                  </span>
                  <input
                    ref={startRef}
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                    aria-required="true"
                    className="h-9 px-3 rounded-control border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  />
                </label>
              </>
            )}

            {/* Step 3: Methodology (ADR-0041) */}
            {step === 3 && (
              <>
                <h2 className="text-base font-semibold text-neutral-text-primary">Planning model</h2>
                <p className="text-xs text-neutral-text-secondary -mt-2">
                  Sets which views your team sees by default. You can change it later in project settings.
                </p>
                {/* "Use program defaults" opt-in (#1909) — shown only when the project
                    is created under a program. Seeds the planning model and visibility
                    from the parent program at create time (a one-time copy; everything
                    stays editable in project settings afterward). Mutually exclusive
                    with "Copy settings from", so both manual pickers dim while it is on.
                    Follows the step-1 picker's current selection, not the route-inferred
                    `programId` prop (#2673, ADR-0764 §3) — the picker resets this opt-in
                    to false on every change, so by the time it's visible it always
                    reflects `selectedProgramId`. */}
                {selectedProgramId && (
                  <label className="flex items-start gap-2 rounded-control border border-neutral-border p-3 bg-neutral-surface-raised/40">
                    <input
                      type="checkbox"
                      checked={useProgramDefaults}
                      onChange={(e) => setUseProgramDefaults(e.target.checked)}
                      aria-label={`Use ${selectedProgramName ? `${selectedProgramName}'s` : 'program'} defaults`}
                      className="mt-0.5 h-4 w-4 rounded border-neutral-border text-brand-primary
                        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-neutral-text-primary">
                        Use {selectedProgramName ? `${selectedProgramName}'s` : 'program'} defaults
                      </span>
                      <span className="text-xs text-neutral-text-secondary">
                        Copies this program&rsquo;s planning model and visibility. A one-time
                        copy — you can change everything later in project settings.
                      </span>
                    </span>
                  </label>
                )}
                <div
                  className={`flex flex-col gap-2 ${useProgramDefaults ? 'opacity-50' : ''}`}
                  role="radiogroup"
                  aria-label="Project methodology"
                  aria-disabled={useProgramDefaults || undefined}
                >
                  {METHODOLOGIES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={methodology === m.id}
                      disabled={useProgramDefaults}
                      onClick={() => setMethodology(m.id)}
                      className={`flex flex-col gap-1 rounded-control border p-3 text-left
                        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                        disabled:cursor-not-allowed
                        ${methodology === m.id
                          ? 'border-brand-primary bg-brand-primary/5'
                          : 'border-neutral-border hover:border-brand-primary/40'}`}
                    >
                      <span className="text-sm font-medium text-neutral-text-primary">{m.label}</span>
                      <span className="text-xs text-neutral-text-secondary">{m.description}</span>
                    </button>
                  ))}
                </div>
                {/* Copy settings from another project (#1659, ADR-0242). Optional —
                    an empty selection keeps today's blank-defaults behavior. Dimmed
                    and disabled while "Use program defaults" is on (#1909): the two
                    settings sources are mutually exclusive. */}
                <label
                  className={`flex flex-col gap-1 pt-2 mt-1 border-t border-neutral-border ${
                    useProgramDefaults ? 'opacity-50' : ''
                  }`}
                >
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    Copy settings from
                  </span>
                  <select
                    value={copySettingsFrom}
                    onChange={(e) => setCopySettingsFrom(e.target.value)}
                    aria-label="Copy settings from"
                    disabled={projectsLoading || useProgramDefaults}
                    style={{ backgroundImage: SELECT_CHEVRON }}
                    className="h-9 pl-3 pr-8 rounded-control border border-neutral-border bg-neutral-surface
                      text-sm text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.5rem_center]
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">
                      {projectsLoading ? 'Loading projects…' : 'None — start with blank defaults'}
                    </option>
                    {(projects ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-neutral-text-secondary">
                    Copies the source project&rsquo;s calendar, default view, board cadence,
                    visibility, and sharing, attachment &amp; Monte Carlo policies. The name,
                    dates, and planning model you enter here always take precedence.
                  </span>
                </label>
                {/* Default role for new members (ADR-0363, #157). Applied when a
                    member is added later without an explicit role — editable
                    afterward on Settings → Members. */}
                <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-neutral-border">
                  {/* Explicit htmlFor association (not a wrapping <label>) — the
                      control is the RolePicker component, which jsx-a11y can't see
                      as nested; htmlFor→id satisfies label-has-associated-control. */}
                  <label
                    htmlFor="new-project-default-member-role"
                    className="text-xs font-medium text-neutral-text-secondary"
                  >
                    Default role for new members
                  </label>
                  <RolePicker
                    id="new-project-default-member-role"
                    variant="form"
                    value={defaultMemberRole}
                    onChange={setDefaultMemberRole}
                  />
                  <span className="text-xs text-neutral-text-secondary">
                    The role a person gets when you add them to this project without
                    choosing one. You can change it any time and override it per person.
                  </span>
                </div>
                {createProject.isError && (
                  <p role="alert" className="text-xs text-semantic-critical">
                    Failed to create project. Please try again.
                  </p>
                )}
              </>
            )}
          </form>
          </div>

          {/* Actions — pinned below the scroller (#2665). The submit button is
              outside the <form> DOM subtree but still participates in it via the
              `form` attribute (HTML form association), so Enter-to-advance and
              the final create submit both keep working. */}
          {/* flex-wrap + justify-end (#2710): step 3 carries four controls
              (Back / Cancel / Create & import spreadsheet / Create project) and they
              no longer fit one nowrap row inside a max-w-lg dialog on a narrow
              viewport — without wrapping, the create action slides out of reach. */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-6 pt-2">
            <div>
              {step > 1 && (
                <button
                  type="button"
                  onClick={back}
                  disabled={createProject.isPending}
                  className="h-9 px-4 rounded-control text-sm font-medium border border-neutral-border
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                >
                  Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={createProject.isPending}
                className="h-9 px-4 rounded-control text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              >
                Cancel
              </button>
              {/* "Create & import spreadsheet" (#2710). Before this, reaching the
                  CSV/Excel wizard required creating an empty project, navigating
                  into its Schedule, and finding an overflow menu — the import wall
                  was still in front of the import. Offering it at the moment of
                  commitment collapses that to one path.

                  Rendered only on the final step, where the create actually fires;
                  on steps 1–2 the single button is "Next" and a second action would
                  imply it skips the rest of the form. Which of the two is primary is
                  the caller's call via `importFirst` — an entry point the user
                  reached *because* they have a spreadsheet should not make them pick
                  the secondary button. */}
              {step === TOTAL_STEPS && (
                <button
                  type="submit"
                  form="new-project-form"
                  onClick={() => {
                    submitIntentRef.current = { importCsv: true };
                    setPendingImport(true);
                  }}
                  disabled={createProject.isPending}
                  className={
                    importFirst
                      ? `h-9 px-4 rounded-control text-sm font-medium bg-brand-primary text-neutral-text-inverse
                         disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                         focus:outline-none focus:ring-2 focus:ring-white
                         focus:ring-offset-2 focus:ring-offset-brand-primary`
                      : `h-9 px-4 rounded-control text-sm font-medium border border-neutral-border
                         text-neutral-text-secondary hover:text-neutral-text-primary
                         disabled:opacity-50 disabled:cursor-not-allowed
                         focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1`
                  }
                >
                  {createProject.isPending && pendingImport
                    ? 'Creating…'
                    : 'Create & import spreadsheet'}
                </button>
              )}
              <button
                type="submit"
                form="new-project-form"
                onClick={() => {
                  // Reset explicitly: the ref survives a failed submit, so without
                  // this a user who clicked "Create & import", hit a validation
                  // error, then clicked plain "Create project" would still be sent
                  // to the wizard.
                  submitIntentRef.current = {};
                  setPendingImport(false);
                }}
                disabled={
                  (step === 1 && !canAdvanceStep1) ||
                  (step === 2 && !canAdvanceStep2) ||
                  (step === TOTAL_STEPS && createProject.isPending)
                }
                className={
                  step === TOTAL_STEPS && importFirst
                    ? `h-9 px-4 rounded-control text-sm font-medium border border-neutral-border
                       text-neutral-text-secondary hover:text-neutral-text-primary
                       disabled:opacity-50 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1`
                    : `h-9 px-4 rounded-control text-sm font-medium bg-brand-primary text-neutral-text-inverse
                       disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                       focus:outline-none focus:ring-2 focus:ring-white
                       focus:ring-offset-2 focus:ring-offset-brand-primary`
                }
              >
                {step < TOTAL_STEPS
                  ? 'Next'
                  : createProject.isPending && !pendingImport
                    ? 'Creating…'
                    : 'Create project'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
