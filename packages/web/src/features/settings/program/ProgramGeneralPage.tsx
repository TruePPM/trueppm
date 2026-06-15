import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { MemberPicker } from '../components/MemberPicker';
import { DangerZoneLink } from '../components/DangerZoneLink';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { InheritableIterationLabelField } from '../components/InheritableIterationLabelField';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { DEFAULT_ITERATION_LABEL } from '@/lib/iterationLabel';
import { useExportProgramSeed } from '@/hooks/useProgramSeedIo';
import { ROLE_ADMIN } from '@/lib/roles';
import type { ProgramHealth, ProgramMethodology, ProgramVisibility } from '@/api/types';
import { PROGRAM_ACCENT_SWATCHES, contrastText } from '@/features/programs/programColor';

const HEALTH_OPTIONS: Array<{ id: ProgramHealth; label: string }> = [
  { id: 'ON_TRACK', label: 'On track' },
  { id: 'AT_RISK', label: 'At risk' },
  { id: 'CRITICAL', label: 'Critical' },
  { id: 'AUTO', label: 'Auto' },
];

const HEALTH_ACTIVE: Record<ProgramHealth, string> = {
  ON_TRACK: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  AT_RISK: 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  CRITICAL: 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40',
  AUTO: 'bg-brand-primary-light text-brand-primary border-brand-primary/40',
};

const METHODOLOGY_OPTIONS: Array<{ id: ProgramMethodology; label: string }> = [
  { id: 'WATERFALL', label: 'Waterfall' },
  { id: 'AGILE', label: 'Agile' },
  { id: 'HYBRID', label: 'Hybrid' },
];

const VISIBILITY_OPTIONS: Array<{ id: ProgramVisibility; label: string; hint: string }> = [
  { id: 'WORKSPACE', label: 'Workspace', hint: 'Anyone in the workspace can see this program.' },
  { id: 'PRIVATE', label: 'Private', hint: 'Only invited members can see this program.' },
];

/**
 * Program > General settings page (issue #523).
 *
 * Wired fields: name, description, code, health, visibility, methodology, lead
 * (read-only display — the user picker is out of scope for #523; the Change
 * button is disabled and tracked in #966, which will swap in the picker).
 *
 * Save contract: publishes (dirty, save, reset) up to ``SettingsShell`` via
 * ``useDirtyForm``. Initial values re-seed whenever the routed program changes
 * (keyed on ``program.id``) so switching programs refreshes the form, while a
 * same-program refetch (e.g. cache invalidation after another page's mutation)
 * does not blow away the user's in-progress edits.
 */
export function ProgramGeneralPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const exportSeed = useExportProgramSeed();
  const updateProgram = useUpdateProgram();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [health, setHealth] = useState<ProgramHealth>('AUTO');
  const [methodology, setMethodology] = useState<ProgramMethodology>('HYBRID');
  // null = inherit the workspace default (ADR-0116, #1106).
  const [iterationLabel, setIterationLabel] = useState<string | null>(null);
  // null = inherit the workspace value (ADR-0135, #978).
  const [publicSharing, setPublicSharing] = useState<boolean | null>(null);
  const [allowGuests, setAllowGuests] = useState<boolean | null>(null);
  const [visibility, setVisibility] = useState<ProgramVisibility>('WORKSPACE');
  // null = no accent chosen (renders as a health-tinted neutral on the card).
  const [color, setColor] = useState<string | null>(null);
  // null = Unassigned. User id of the program manager / lead (#966).
  const [lead, setLead] = useState<string | null>(null);

  // Re-seed whenever the loaded program's identity changes. React Router reuses
  // this component across `:programId` changes (no `key` → no remount), so a
  // one-shot boolean guard would strand the form on the first program's values
  // when the user switches programs in Settings (#750). Keying on the id — rather
  // than on every `program` reference — still prevents a same-program background
  // refetch from clobbering in-progress edits, which was the original guard's intent.
  // The initial-* setters double as the "last-saved snapshot" used by the discard
  // handler and the useDirtyForm dirty-compare.
  const seededProgramIdRef = useRef<string | null>(null);
  const [initialName, setInitialName] = useState('');
  const [initialDescription, setInitialDescription] = useState('');
  const [initialCode, setInitialCode] = useState('');
  const [initialHealth, setInitialHealth] = useState<ProgramHealth>('AUTO');
  const [initialMethodology, setInitialMethodology] = useState<ProgramMethodology>('HYBRID');
  const [initialIterationLabel, setInitialIterationLabel] = useState<string | null>(null);
  const [initialPublicSharing, setInitialPublicSharing] = useState<boolean | null>(null);
  const [initialAllowGuests, setInitialAllowGuests] = useState<boolean | null>(null);
  const [initialVisibility, setInitialVisibility] = useState<ProgramVisibility>('WORKSPACE');
  const [initialColor, setInitialColor] = useState<string | null>(null);
  const [initialLead, setInitialLead] = useState<string | null>(null);

  useEffect(() => {
    if (!program || seededProgramIdRef.current === program.id) return;
    seededProgramIdRef.current = program.id;
    setName(program.name);
    setDescription(program.description ?? '');
    setCode(program.code ?? '');
    setHealth(program.health);
    setMethodology(program.methodology);
    setIterationLabel(program.iteration_label ?? null);
    setPublicSharing(program.public_sharing ?? null);
    setAllowGuests(program.allow_guests ?? null);
    setVisibility(program.visibility);
    setColor(program.color ?? null);
    setLead(program.lead ?? null);
    setInitialName(program.name);
    setInitialDescription(program.description ?? '');
    setInitialCode(program.code ?? '');
    setInitialHealth(program.health);
    setInitialMethodology(program.methodology);
    setInitialIterationLabel(program.iteration_label ?? null);
    setInitialPublicSharing(program.public_sharing ?? null);
    setInitialAllowGuests(program.allow_guests ?? null);
    setInitialVisibility(program.visibility);
    setInitialColor(program.color ?? null);
    setInitialLead(program.lead ?? null);
  }, [program]);

  const values = useMemo(
    () => ({
      name,
      description,
      code,
      health,
      methodology,
      iterationLabel,
      publicSharing,
      allowGuests,
      visibility,
      color,
      lead,
    }),
    [
      name,
      description,
      code,
      health,
      methodology,
      iterationLabel,
      publicSharing,
      allowGuests,
      visibility,
      color,
      lead,
    ],
  );
  const initialValues = useMemo(
    () => ({
      name: initialName,
      description: initialDescription,
      code: initialCode,
      health: initialHealth,
      methodology: initialMethodology,
      iterationLabel: initialIterationLabel,
      publicSharing: initialPublicSharing,
      allowGuests: initialAllowGuests,
      visibility: initialVisibility,
      color: initialColor,
      lead: initialLead,
    }),
    [
      initialName,
      initialDescription,
      initialCode,
      initialHealth,
      initialMethodology,
      initialIterationLabel,
      initialPublicSharing,
      initialAllowGuests,
      initialVisibility,
      initialColor,
      initialLead,
    ],
  );

  const handleSave = useCallback(async () => {
    if (!programId) return;
    await updateProgram.mutateAsync({
      programId,
      patch: {
        name,
        description,
        code,
        health,
        methodology,
        // null clears the override (inherit); blank custom normalizes to null (ADR-0116).
        iteration_label: iterationLabel === null ? null : iterationLabel.trim() || null,
        // null clears the sharing override so the program inherits the workspace value (ADR-0135).
        public_sharing: publicSharing,
        allow_guests: allowGuests,
        visibility,
        color,
        lead,
      },
    });
    // Bump the snapshot — dirty flips back to false and the save bar collapses.
    setInitialName(name);
    setInitialDescription(description);
    setInitialCode(code);
    setInitialHealth(health);
    setInitialMethodology(methodology);
    setInitialIterationLabel(iterationLabel);
    setInitialPublicSharing(publicSharing);
    setInitialAllowGuests(allowGuests);
    setInitialVisibility(visibility);
    setInitialColor(color);
    setInitialLead(lead);
  }, [
    programId,
    updateProgram,
    name,
    description,
    code,
    health,
    methodology,
    iterationLabel,
    publicSharing,
    allowGuests,
    visibility,
    color,
    lead,
  ]);

  const handleReset = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    setCode(initialCode);
    setHealth(initialHealth);
    setMethodology(initialMethodology);
    setIterationLabel(initialIterationLabel);
    setPublicSharing(initialPublicSharing);
    setAllowGuests(initialAllowGuests);
    setVisibility(initialVisibility);
    setColor(initialColor);
    setLead(initialLead);
  }, [
    initialName,
    initialDescription,
    initialCode,
    initialHealth,
    initialMethodology,
    initialIterationLabel,
    initialPublicSharing,
    initialAllowGuests,
    initialVisibility,
    initialColor,
    initialLead,
  ]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!program,
  });

  // Sharing overrides are Admin+ (ADR-0135); lower roles see a read-only indicator.
  // The server enforces this too — this only gates the affordance.
  const canEditSharing = program?.my_role != null && program.my_role >= ROLE_ADMIN;

  return (
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Program identity and delivery model. Settings here affect all projects within this program."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow label="Program name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Program name"
            className="w-full max-w-[420px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Program code" hint="Used as a prefix for task IDs and exports.">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Program code"
            maxLength={40}
            className="w-[140px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow
          label="Accent color"
          hint="Tints this program's identity square in lists and its rollup-chart accents. Optional."
        >
          <div className="flex items-center gap-2">
            {PROGRAM_ACCENT_SWATCHES.map((swatch) => {
              const selected = color === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  // Clicking the active swatch clears the accent (back to null).
                  onClick={() => setColor(selected ? null : swatch)}
                  aria-pressed={selected}
                  aria-label={`Accent color ${swatch}${selected ? ', selected — activate to clear' : ''}`}
                  title={selected ? `${swatch} — click to clear` : swatch}
                  style={{ backgroundColor: swatch }}
                  className={[
                    'w-7 h-7 rounded-full inline-flex items-center justify-center transition-transform',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2',
                    selected ? 'ring-2 ring-brand-primary ring-offset-2' : 'hover:scale-110',
                  ].join(' ')}
                >
                  {selected && (
                    <svg
                      viewBox="0 0 16 16"
                      className="w-3.5 h-3.5"
                      aria-hidden="true"
                      style={{ color: contrastText(swatch) }}
                    >
                      <path fill="currentColor" d="M6.4 11.3 3.5 8.4l1-1 1.9 1.9 4.1-4.1 1 1z" />
                    </svg>
                  )}
                </button>
              );
            })}
            {color && (
              <button
                type="button"
                onClick={() => setColor(null)}
                className="ml-1 text-[12px] text-brand-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
              >
                Clear
              </button>
            )}
          </div>
        </FieldRow>

        <FieldRow
          label="Description"
          hint="Shown on the program overview and in rollup dashboards."
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            aria-label="Description"
            className="w-full max-w-[540px] px-2.5 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </FieldRow>

        <FieldRow label="Program manager">
          {/* Real manager from the program record (Unassigned when null), set
              via the member picker (#966). Selection updates page state → the
              save bar commits; the server enforces Admin + member-of-scope. */}
          <MemberPicker
            scope="program"
            scopeId={programId}
            value={lead}
            onChange={setLead}
            label="program manager"
            canEdit
            selectedDetail={program?.lead_detail ?? null}
          />
        </FieldRow>

        <FieldRow
          label="Health"
          hint="Drives the health dot in program lists and portfolio rollups."
        >
          <div className="flex gap-2">
            {HEALTH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setHealth(opt.id)}
                aria-pressed={health === opt.id}
                className={[
                  'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  health === opt.id
                    ? HEALTH_ACTIVE[opt.id]
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label="Methodology"
          hint="Default delivery model for new projects added to this program."
        >
          <div className="flex gap-2">
            {METHODOLOGY_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMethodology(opt.id)}
                aria-pressed={methodology === opt.id}
                className={[
                  'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  methodology === opt.id
                    ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label="Iteration terminology"
          hint="The word projects in this program use for their iteration container — unless a project sets its own."
        >
          <InheritableIterationLabelField
            value={iterationLabel}
            onChange={setIterationLabel}
            inheritedLabel={program?.inherited_iteration_label ?? DEFAULT_ITERATION_LABEL}
            inheritFromLabel="the workspace default"
          />
        </FieldRow>

        <FieldRow
          label="Allow guests"
          hint="Guests are external collaborators (vendors, auditors), limited to what they're invited to. Inherits the workspace setting unless you override it here."
        >
          <InheritableToggleField
            value={allowGuests}
            onChange={setAllowGuests}
            inherited={program?.inherited_allow_guests ?? false}
            inheritFromLabel="the workspace default"
            scopeNoun="program"
            ariaLabel="Allow guest access"
            canEdit={canEditSharing}
          />
        </FieldRow>

        <FieldRow
          label="Public sharing"
          hint="Anyone with the link can view selected reports — no sign-in required. Inherits the workspace setting unless you override it here."
        >
          <InheritableToggleField
            value={publicSharing}
            onChange={setPublicSharing}
            inherited={program?.inherited_public_sharing ?? false}
            inheritFromLabel="the workspace default"
            scopeNoun="program"
            ariaLabel="Allow public link sharing"
            canEdit={canEditSharing}
          />
        </FieldRow>

        <FieldRow label="Visibility" hint="Who can see this program and its rollup KPIs.">
          <div className="flex flex-col gap-3">
            {VISIBILITY_OPTIONS.map((opt) => (
              <label key={opt.id} className="flex items-center gap-3 cursor-pointer">
                <span
                  className={[
                    'w-4 h-4 rounded-full border-2 shrink-0 transition-colors',
                    visibility === opt.id
                      ? 'border-brand-primary bg-brand-primary'
                      : 'border-neutral-border',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {visibility === opt.id && (
                    <span className="block w-full h-full rounded-full scale-[0.4] bg-white" />
                  )}
                </span>
                <input
                  type="radio"
                  name="program-visibility"
                  value={opt.id}
                  checked={visibility === opt.id}
                  onChange={() => setVisibility(opt.id)}
                  className="sr-only"
                />
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  {opt.label}
                </span>
                <span className="text-[12px] text-neutral-text-secondary">· {opt.hint}</span>
              </label>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label="Export"
          hint="Download this program as a canonical JSON seed file. Re-importing it reproduces the program."
        >
          <button
            type="button"
            onClick={() => programId && exportSeed.mutate({ programId, code: program?.code })}
            disabled={!programId || exportSeed.isPending}
            className="h-9 rounded border border-neutral-border px-4 text-[13px] font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-60"
          >
            {exportSeed.isPending ? 'Exporting…' : 'Export to JSON'}
          </button>
          {exportSeed.isError && (
            <p role="alert" className="mt-2 text-[12px] text-semantic-critical">
              Export failed — please try again.
            </p>
          )}
        </FieldRow>
      </div>

      {/* Destructive actions live on the Archive / Delete page (#977). */}
      <DangerZoneLink to="../lifecycle" />
    </div>
  );
}
