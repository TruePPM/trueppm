import { useRef, useState, useEffect, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateProject } from '@/hooks/useProjectMutations';
import { useProjects } from '@/hooks/useProjects';
import { RolePicker } from '@/features/settings/members/RolePicker';
import { ROLE_MEMBER } from '@/lib/roles';
import type { Methodology } from '@/types';

interface Props {
  onClose: () => void;
  /** Called after the project is created so the caller can navigate to it. */
  onCreated: (projectId: string) => void;
  /**
   * Optional program to assign the new project to at creation time (ADR-0070).
   * When provided, the modal sends ``program`` in the create payload and
   * invalidates the program-projects cache so the source page reflects the
   * new row without a manual refetch. Caller must already hold ADMIN on the
   * target program — the server gate raises 400 otherwise.
   */
  programId?: string;
  /**
   * Optional parent program name, used only to label the "Use program defaults"
   * affordance (#1909). Falls back to a generic label when absent.
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
 * Step 1: Name + description. Step 2: Schedule dates. Step 3: Template.
 * Focus is trapped within the dialog and restored to the trigger element on close.
 */
export function NewProjectModal({ onClose, onCreated, programId, programName }: Props) {
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
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (step < TOTAL_STEPS) { advance(); return; }
    if (!name.trim() || !startDate || createProject.isPending) return;
    // When seeding from the program (#1909), omit `methodology` so the parent
    // program's value is copied server-side — an explicit `methodology` in the
    // payload always wins over the copy (server precedence), which would defeat the
    // opt-in. `inherit_program_defaults` and `copy_settings_from` are mutually
    // exclusive (the server rejects both); the UI already gates them to one at a time.
    const inheritProgram = Boolean(programId) && useProgramDefaults;
    createProject.mutate(
      {
        name: name.trim(),
        start_date: startDate,
        description: description.trim() || undefined,
        ...(inheritProgram ? {} : { methodology }),
        ...(programId ? { program: programId } : {}),
        ...(inheritProgram
          ? { inherit_program_defaults: true }
          : copySettingsFrom
            ? { copy_settings_from: copySettingsFrom }
            : {}),
        default_member_role: defaultMemberRole,
      },
      {
        onSuccess: (data) => {
          if (programId) {
            void queryClient.invalidateQueries({ queryKey: ['programs', programId, 'projects'] });
          }
          onCreated(data.id);
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
          className="w-full max-w-lg rounded-card border border-neutral-border bg-neutral-surface p-6 pointer-events-auto"
        >
          {/* Step indicator */}
          <div className="flex items-center gap-2 mb-5" aria-hidden="true">
            {([1, 2, 3] as Step[]).map((n, i) => (
              <div key={n} className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold
                    ${n === step
                      ? 'bg-brand-primary text-white'
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

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Step 1: Name + Description */}
            {step === 1 && (
              <>
                <h2 className="text-base font-semibold text-neutral-text-primary">Project details</h2>
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
                      text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
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
                      text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-none
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
                    with "Copy settings from", so both manual pickers dim while it is on. */}
                {programId && (
                  <label className="flex items-start gap-2 rounded-control border border-neutral-border p-3 bg-neutral-surface-raised/40">
                    <input
                      type="checkbox"
                      checked={useProgramDefaults}
                      onChange={(e) => setUseProgramDefaults(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-neutral-border text-brand-primary
                        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-neutral-text-primary">
                        Use {programName ? `${programName}'s` : 'program'} defaults
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
                    style={{
                      backgroundImage:
                        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
                    }}
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

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
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
                <button
                  type="submit"
                  disabled={
                    (step === 1 && !canAdvanceStep1) ||
                    (step === 2 && !canAdvanceStep2) ||
                    (step === TOTAL_STEPS && createProject.isPending)
                  }
                  className="h-9 px-4 rounded-control text-sm font-medium bg-brand-primary text-white
                    disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                    focus:outline-none focus:ring-2 focus:ring-white
                    focus:ring-offset-2 focus:ring-offset-brand-primary"
                >
                  {step < TOTAL_STEPS ? 'Next' : createProject.isPending ? 'Creating…' : 'Create project'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
