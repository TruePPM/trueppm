import { useRef, useState, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateProject } from '@/hooks/useProjectMutations';
import { usePrograms } from '@/hooks/usePrograms';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';
import { toast } from '@/components/Toast';
import { TemplateGallery } from './TemplateGallery';
import { StartWayCards } from './StartWayCards';
import { StartCalendarPicker } from './StartCalendarPicker';
import { useInheritedCalendar } from './useInheritedCalendar';
import { useStartSheetCompact } from './useStartSheetCompact';
import { deriveStartSheetMethodology, type WayIn } from './deriveStartSheetMethodology';
import {
  useApplyTemplate,
  useProjectTemplates,
  type ProjectTemplate,
} from '@/hooks/useProjectTemplates';
import { ROLE_ADMIN } from '@/lib/roles';
import { SELECT_CHEVRON } from './selectChevron';

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
   * precisely so the existing call sites did not have to change.
   */
  onCreated: (projectId: string, intent?: CreatedProjectIntent) => void;
  /**
   * Preselect the "Import" way (#2710, adapted for #2728's one-screen sheet). Set
   * by the entry points a user reaches *because* they have a spreadsheet — the
   * zero-project sidebar and the My Work empty state — so the way they came for is
   * the one they land on. Still just the default selection: the way cards stay a
   * live, changeable choice like every other way.
   */
  importFirst?: boolean;
  /**
   * Optional route-inferred program to preselect in the picker (ADR-0070,
   * ADR-0764). This only SEEDS the sheet's own `selectedProgramId` state — once the
   * user changes the picker, the payload follows that selection, never this prop
   * (#2673). Caller must already hold ADMIN+ on the target program for it to be a
   * legal initial value — the server gate raises 400 otherwise, and the picker
   * itself only ever offers programs the current user administers.
   */
  programId?: string;
  /**
   * Display name for `programId`, used only until `usePrograms()` resolves and the
   * picker can show the canonical name from the fetched list (ADR-0764 §2) — a
   * transient fallback, not a second source of truth.
   */
  programName?: string;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

const WAY_DETAIL: Record<Exclude<WayIn, 'template'>, { title: string; body: string }> = {
  blank: {
    title: 'Start empty',
    body:
      'Opens straight into the outline with the cursor already in the first row (#2733) — the fastest way in when you already know the shape.',
  },
  import: {
    title: 'Bring in a spreadsheet',
    body:
      'Creates the project, then opens the import wizard so you can paste or upload rows straight into the outline.',
  },
};

/**
 * The Start sheet — one screen for creating a project (#2728), replacing the old
 * 3-step modal (name+description → schedule → template/methodology). Collects only
 * what changes what happens next: name, program, start date, and working calendar,
 * then one choice among three peer ways in (Template / Blank / Import — a fourth,
 * "Seed from a brief", is explicitly cut from this issue). Methodology is derived
 * from that choice and shown read-only; it is never asked and never enforced
 * (ADR-0041), and stays changeable afterward in project settings — same as the
 * fields #2728 cut entirely from this screen (description, "copy settings from",
 * "use program defaults", default member role): every one of them still has a home
 * in project settings after creation, this screen only decides what happens next.
 *
 * Deliberate divergence from the design handoff (issue #2728): the original design
 * writes the project as a `draft` on the first keystroke. This still creates on
 * submit, exactly like the modal it replaces — no `draft` state, no lifecycle-
 * exclusion logic. The full draft lifecycle is separate, later work.
 *
 * Below 900px (`useStartSheetCompact`) this becomes a full-screen surface with the
 * same field order and the way cards stacked 2×2 instead of one row of three.
 *
 * Focus is trapped within the dialog and restored to the trigger element on close.
 */
export function NewProjectModal({
  onClose,
  onCreated,
  programId,
  programName,
  importFirst = false,
}: Props) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [way, setWay] = useState<WayIn>(importFirst ? 'import' : 'blank');
  // Template chosen when way === 'template' (#2729, ADR-0789). Kept even when the
  // user switches to another way and back, so flipping through the ways to compare
  // them doesn't lose a deliberate pick.
  const [template, setTemplate] = useState<ProjectTemplate | null>(null);
  // Explicit working-calendar override; null = follow the inherited default shown
  // by the picker (nothing sent on create — the server resolves it the same way).
  const [calendarOverride, setCalendarOverride] = useState<string | null>(null);
  // The program this project attaches to (#2673, ADR-0764). `programId` only seeds
  // this — it is the single source of truth from here on, read by the picker and
  // the create payload.
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(programId ?? null);

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const compact = useStartSheetCompact();

  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const applyTemplate = useApplyTemplate();
  // Program picker options (#2673, ADR-0764). Fetched unconditionally — usually
  // already warm in the ['programs'] cache from Sidebar, which mounts on every
  // authenticated route. Filtered to the exact RBAC predicate MoveToProgramModal
  // established: open programs where the caller holds ADMIN+ (ADR-0070) — offering
  // anything less would 400 at submit. Every row also already carries
  // `effective_methodology`/`effective_calendar` (ADR-0107/ADR-0441), which is what
  // lets the derived-methodology line and the inherited-calendar default resolve
  // with zero extra requests once a program is picked.
  const { data: programs, isLoading: programsLoading } = usePrograms();
  const { data: workspace } = useWorkspaceSettings();
  const eligiblePrograms = (programs ?? []).filter(
    (p) => !p.is_closed && p.my_role !== null && p.my_role >= ROLE_ADMIN,
  );
  const selectedProgramInEligible = eligiblePrograms.some((p) => p.id === selectedProgramId);
  const selectedProgram = eligiblePrograms.find((p) => p.id === selectedProgramId);
  // Canonical display name for the current selection: prefer the fetched list (the
  // more current source), falling back to the route-inferred `programName` prop only
  // while the selection still equals its original seed and the list hasn't resolved
  // it yet (or, defensively, never resolves it — e.g. the program closed between
  // CreateMenu's gate check and this modal opening).
  const selectedProgramName =
    selectedProgram?.name ??
    (selectedProgramId !== null && selectedProgramId === (programId ?? null)
      ? programName
      : undefined);

  const inheritedCalendar = useInheritedCalendar(selectedProgramId);

  const derived = deriveStartSheetMethodology({
    way,
    template,
    programEffectiveMethodology: selectedProgram?.effective_methodology ?? null,
    workspaceMethodology: workspace?.methodology,
  });

  function handleProgramChange(e: ChangeEvent<HTMLSelectElement>) {
    setSelectedProgramId(e.target.value === '' ? null : e.target.value);
  }

  // Capture trigger before the sheet opens; restore focus on unmount.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Same query TemplateGallery itself issues (identical queryKey → TanStack Query
  // dedupes to the one in-flight/cached request, not a second fetch) — read here
  // too only to auto-select the first template once the Template way is chosen and
  // nothing is picked yet. Mirrors #2733's "cursor already in it" philosophy:
  // landing on Template always lands on a ready-to-create state, never an empty
  // list waiting for a first click.
  const { data: templatesForWay } = useProjectTemplates(selectedProgramId);
  useEffect(() => {
    if (way === 'template' && !template && templatesForWay && templatesForWay.length > 0) {
      setTemplate(templatesForWay[0]);
    }
  }, [way, template, templatesForWay]);

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

  const canSubmit =
    name.trim().length > 0 && startDate.length > 0 && (way !== 'template' || template !== null);

  /**
   * What the user asked for at the moment of commitment (#2710) — fully determined
   * by `way` now that Import is a peer way rather than a second footer button.
   */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || createProject.isPending) return;
    const intent: CreatedProjectIntent = way === 'import' ? { importCsv: true } : {};
    createProject.mutate(
      {
        name: name.trim(),
        start_date: startDate,
        // Sent explicitly so the created project's stored methodology always
        // matches the derived line the sheet just showed — never left to drift
        // from a server-side default the sheet didn't display.
        methodology: derived.methodology,
        ...(selectedProgramId ? { program: selectedProgramId } : {}),
        ...(calendarOverride ? { calendar: calendarOverride } : {}),
      },
      {
        onSuccess: (data) => {
          if (selectedProgramId) {
            void queryClient.invalidateQueries({
              queryKey: ['programs', selectedProgramId, 'projects'],
            });
          }
          // Confirm the create like every other creation moment (rule 185, #2048) —
          // the sheet closes on navigation, so without this the user's first
          // commitment lands silently on an empty Overview.
          toast.success(`Created ${name.trim()}`);
          if (way === 'template' && template) {
            // Fire-and-navigate (#2729, ADR-0789 §4): the sheet never blocks on
            // seeding. The server returns 202 and the rows arrive over the board
            // WebSocket as the job completes, so the user lands on their project
            // and watches it fill rather than waiting on a modal spinner.
            applyTemplate.mutate(
              { templateId: template.id, projectId: data.id },
              {
                // A failed *dispatch* still leaves a real, empty project — say so
                // rather than letting the skeleton silently not appear. The apply
                // itself is durable once queued (outbox + drain); this only
                // catches the request never landing.
                onError: () =>
                  toast.error(
                    `Created ${name.trim()}, but couldn't start "${template.name}". Apply it from the project.`,
                  ),
              },
            );
          }
          onCreated(data.id, intent);
        },
      },
    );
  }

  return (
    <>
      {/* Backdrop — click-to-close but never a Tab stop (tabIndex=-1), so the
          first Tab lands on a control inside the dialog, not this invisible
          full-screen button (issue 1357). Hidden on the compact full-screen
          presentation, where the sheet itself fills the viewport. */}
      {!compact && (
        <button
          type="button"
          aria-label="Close dialog"
          tabIndex={-1}
          className="fixed inset-0 z-50 bg-neutral-overlay cursor-default"
          onClick={onClose}
        />
      )}
      <div
        className={
          compact
            ? 'fixed inset-0 z-[51] flex flex-col'
            : 'fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none'
        }
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="New project"
          className={
            compact
              ? 'flex h-full w-full flex-col overflow-hidden bg-neutral-surface pointer-events-auto'
              : 'w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col rounded-card border border-neutral-border bg-neutral-surface pointer-events-auto'
          }
        >
          <div className="flex items-center justify-between px-6 pt-6 mb-5">
            <h2 className="text-base font-semibold text-neutral-text-primary">New project</h2>
            {compact && (
              <button
                type="button"
                aria-label="Close dialog"
                onClick={onClose}
                className="h-8 w-8 rounded-control text-neutral-text-secondary hover:text-neutral-text-primary
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              >
                ×
              </button>
            )}
          </div>

          {/* Body — the only scrollable region. The footer stays pinned and
              reachable regardless of how tall the Template list gets. */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <form id="new-project-form" onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 pb-4">
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

              {/* Program picker (#2673, ADR-0764) — determines rollup, cadence
                  inheritance, and (via effective_methodology/effective_calendar)
                  two of the derived values below. Options are scoped to open
                  programs the caller administers (ADR-0070) — offering anything
                  less would 400 at submit. */}
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
                  Start date <span aria-hidden="true">*</span>
                </span>
                <input
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

              <StartCalendarPicker
                value={calendarOverride}
                onChange={setCalendarOverride}
                inherited={inheritedCalendar}
              />

              <div className="flex flex-col gap-2 pt-2 mt-1 border-t border-neutral-border">
                <span className="text-xs font-medium text-neutral-text-secondary">Start from</span>
                <StartWayCards value={way} onChange={setWay} compact={compact} />

                {/* Methodology is derived, not asked (ADR-0041) — states which
                    views this project will carry as a consequence of the way
                    chosen above. Never enforces anything and stays changeable in
                    project settings afterward. */}
                <p className="text-xs text-neutral-text-secondary">
                  <span className="font-medium text-neutral-text-primary">Views: </span>
                  {derived.caption}
                </p>

                {/* Detail panel — swaps by way without changing the sheet's height
                    class (a fixed min-height keeps Template's list from growing
                    the dialog while Blank/Import's shorter copy sits inside it). */}
                <div className="min-h-[9rem]">
                  {way === 'template' ? (
                    <TemplateGallery
                      programId={selectedProgramId}
                      selectedId={template?.id ?? null}
                      onSelect={setTemplate}
                    />
                  ) : (
                    <div className="flex flex-col gap-1 rounded-card border border-neutral-border p-3">
                      <span className="text-sm font-medium text-neutral-text-primary">
                        {WAY_DETAIL[way].title}
                      </span>
                      <span className="text-xs text-neutral-text-secondary">
                        {WAY_DETAIL[way].body}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {createProject.isError && (
                <p role="alert" className="text-xs text-semantic-critical">
                  Failed to create project. Please try again.
                </p>
              )}
            </form>
          </div>

          {/* Actions — pinned below the scroller. The submit button is outside the
              <form> DOM subtree but still participates in it via the `form`
              attribute, so Enter-to-submit and the Create click both work. */}
          <div className="flex items-center justify-between gap-2 px-6 pb-6 pt-2">
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
              form="new-project-form"
              disabled={!canSubmit || createProject.isPending}
              className="h-9 px-4 rounded-control text-sm font-medium bg-brand-primary text-neutral-text-inverse
                disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                focus:outline-none focus:ring-2 focus:ring-white
                focus:ring-offset-2 focus:ring-offset-brand-primary"
            >
              {createProject.isPending
                ? 'Creating…'
                : way === 'import'
                  ? 'Create & import spreadsheet'
                  : 'Create project'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
