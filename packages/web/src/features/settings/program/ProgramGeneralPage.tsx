import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { MemberPicker } from '../components/MemberPicker';
import { StubFieldset } from '../components/StubFieldset';
import { DangerZoneLink } from '../components/DangerZoneLink';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { InheritableIterationLabelField } from '../components/InheritableIterationLabelField';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { InheritableNumberField } from '../components/InheritableNumberField';
import { InheritableSelectField } from '../components/InheritableSelectField';
import { MC_ATTRIBUTION_OPTIONS, MC_ATTRIBUTION_HINT, MC_HISTORY_HINT } from '../forecastHistory';
import { DEFAULT_ITERATION_LABEL } from '@/lib/iterationLabel';
import { useExportProgramSeed } from '@/hooks/useProgramSeedIo';
import { ROLE_ADMIN } from '@/lib/roles';
import type {
  MCAttributionAudience,
  ProgramHealth,
  ProgramMethodology,
  ProgramVisibility,
} from '@/api/types';
import { MC_HISTORY_RETENTION_MAX, MC_HISTORY_RETENTION_MIN } from '@/api/types';
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
  const { data: ws } = useWorkspaceSettings();
  const exportSeed = useExportProgramSeed();
  const updateProgram = useUpdateProgram();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [health, setHealth] = useState<ProgramHealth>('AUTO');
  // '' = no target date (open-ended program). Stored as an ISO `YYYY-MM-DD`
  // string to match the native date input; normalized to null on save (issue 560).
  const [targetDate, setTargetDate] = useState('');
  const [methodology, setMethodology] = useState<ProgramMethodology>('HYBRID');
  // null = inherit the workspace default (ADR-0116, #1106).
  const [iterationLabel, setIterationLabel] = useState<string | null>(null);
  // null = inherit the workspace value (ADR-0135).
  const [publicSharing, setPublicSharing] = useState<boolean | null>(null);
  const [allowGuests, setAllowGuests] = useState<boolean | null>(null);
  // null = inherit the workspace value (ADR-0144, issue 1232).
  const [mcHistoryEnabled, setMcHistoryEnabled] = useState<boolean | null>(null);
  const [mcHistoryRetentionCap, setMcHistoryRetentionCap] = useState<number | null>(null);
  const [mcHistoryAttributionAudience, setMcHistoryAttributionAudience] =
    useState<MCAttributionAudience | null>(null);
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
  const [initialTargetDate, setInitialTargetDate] = useState('');
  const [initialMethodology, setInitialMethodology] = useState<ProgramMethodology>('HYBRID');
  const [initialIterationLabel, setInitialIterationLabel] = useState<string | null>(null);
  const [initialPublicSharing, setInitialPublicSharing] = useState<boolean | null>(null);
  const [initialAllowGuests, setInitialAllowGuests] = useState<boolean | null>(null);
  const [initialMcHistoryEnabled, setInitialMcHistoryEnabled] = useState<boolean | null>(null);
  const [initialMcHistoryRetentionCap, setInitialMcHistoryRetentionCap] = useState<number | null>(
    null,
  );
  const [initialMcHistoryAttributionAudience, setInitialMcHistoryAttributionAudience] =
    useState<MCAttributionAudience | null>(null);
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
    setTargetDate(program.target_date ?? '');
    setMethodology(program.methodology);
    setIterationLabel(program.iteration_label ?? null);
    setPublicSharing(program.public_sharing ?? null);
    setAllowGuests(program.allow_guests ?? null);
    setMcHistoryEnabled(program.mc_history_enabled ?? null);
    setMcHistoryRetentionCap(program.mc_history_retention_cap ?? null);
    setMcHistoryAttributionAudience(program.mc_history_attribution_audience ?? null);
    setVisibility(program.visibility);
    setColor(program.color ?? null);
    setLead(program.lead ?? null);
    setInitialName(program.name);
    setInitialDescription(program.description ?? '');
    setInitialCode(program.code ?? '');
    setInitialHealth(program.health);
    setInitialTargetDate(program.target_date ?? '');
    setInitialMethodology(program.methodology);
    setInitialIterationLabel(program.iteration_label ?? null);
    setInitialPublicSharing(program.public_sharing ?? null);
    setInitialAllowGuests(program.allow_guests ?? null);
    setInitialMcHistoryEnabled(program.mc_history_enabled ?? null);
    setInitialMcHistoryRetentionCap(program.mc_history_retention_cap ?? null);
    setInitialMcHistoryAttributionAudience(program.mc_history_attribution_audience ?? null);
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
      targetDate,
      methodology,
      iterationLabel,
      publicSharing,
      allowGuests,
      mcHistoryEnabled,
      mcHistoryRetentionCap,
      mcHistoryAttributionAudience,
      visibility,
      color,
      lead,
    }),
    [
      name,
      description,
      code,
      health,
      targetDate,
      methodology,
      iterationLabel,
      publicSharing,
      allowGuests,
      mcHistoryEnabled,
      mcHistoryRetentionCap,
      mcHistoryAttributionAudience,
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
      targetDate: initialTargetDate,
      methodology: initialMethodology,
      iterationLabel: initialIterationLabel,
      publicSharing: initialPublicSharing,
      allowGuests: initialAllowGuests,
      mcHistoryEnabled: initialMcHistoryEnabled,
      mcHistoryRetentionCap: initialMcHistoryRetentionCap,
      mcHistoryAttributionAudience: initialMcHistoryAttributionAudience,
      visibility: initialVisibility,
      color: initialColor,
      lead: initialLead,
    }),
    [
      initialName,
      initialDescription,
      initialCode,
      initialHealth,
      initialTargetDate,
      initialMethodology,
      initialIterationLabel,
      initialPublicSharing,
      initialAllowGuests,
      initialMcHistoryEnabled,
      initialMcHistoryRetentionCap,
      initialMcHistoryAttributionAudience,
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
        // '' clears the target date — the program becomes open-ended (issue 560).
        target_date: targetDate || null,
        methodology,
        // null clears the override (inherit); blank custom normalizes to null (ADR-0116).
        iteration_label: iterationLabel === null ? null : iterationLabel.trim() || null,
        // null clears the sharing override so the program inherits the workspace value (ADR-0135).
        public_sharing: publicSharing,
        allow_guests: allowGuests,
        // null clears the forecast-history override so the program inherits the workspace value (ADR-0144).
        mc_history_enabled: mcHistoryEnabled,
        mc_history_retention_cap: mcHistoryRetentionCap,
        mc_history_attribution_audience: mcHistoryAttributionAudience,
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
    setInitialTargetDate(targetDate);
    setInitialMethodology(methodology);
    setInitialIterationLabel(iterationLabel);
    setInitialPublicSharing(publicSharing);
    setInitialAllowGuests(allowGuests);
    setInitialMcHistoryEnabled(mcHistoryEnabled);
    setInitialMcHistoryRetentionCap(mcHistoryRetentionCap);
    setInitialMcHistoryAttributionAudience(mcHistoryAttributionAudience);
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
    targetDate,
    methodology,
    iterationLabel,
    publicSharing,
    allowGuests,
    mcHistoryEnabled,
    mcHistoryRetentionCap,
    mcHistoryAttributionAudience,
    visibility,
    color,
    lead,
  ]);

  const handleReset = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    setCode(initialCode);
    setHealth(initialHealth);
    setTargetDate(initialTargetDate);
    setMethodology(initialMethodology);
    setIterationLabel(initialIterationLabel);
    setPublicSharing(initialPublicSharing);
    setAllowGuests(initialAllowGuests);
    setMcHistoryEnabled(initialMcHistoryEnabled);
    setMcHistoryRetentionCap(initialMcHistoryRetentionCap);
    setMcHistoryAttributionAudience(initialMcHistoryAttributionAudience);
    setVisibility(initialVisibility);
    setColor(initialColor);
    setLead(initialLead);
  }, [
    initialName,
    initialDescription,
    initialCode,
    initialHealth,
    initialTargetDate,
    initialMethodology,
    initialIterationLabel,
    initialPublicSharing,
    initialAllowGuests,
    initialMcHistoryEnabled,
    initialMcHistoryRetentionCap,
    initialMcHistoryAttributionAudience,
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

  // The whole General page is editable only at Admin+ (issue 1084). Reads are open;
  // writes are gated server-side, so this render-gate only spares a sub-Admin the
  // arm-save-bar → 400 round-trip. `my_role` is undefined until the program loads,
  // so we gate pessimistically (read-only until proven Admin). The ADR-0135 sharing
  // toggles already used this exact gate; it now governs every field.
  const canEdit = program?.my_role != null && program.my_role >= ROLE_ADMIN;

  // The workspace locks methodology overrides under INHERIT (ADR-0107, issue 955).
  // OSS never has an active Enterprise ENFORCE provider, so ENFORCE behaves like
  // SUGGEST here; only INHERIT makes the program picker read-only. The server is
  // the source of truth (a PATCH under lock is rejected 403) — this just spares a
  // doomed save. Under the lock the displayed value is the workspace default
  // (`effective_methodology`), not the program's stored override.
  const methodologyLocked = ws?.methodologyOverridePolicy === 'inherit';
  const methodologyEditable = canEdit && !methodologyLocked;
  const methodologyShown = methodologyLocked
    ? (program?.effective_methodology ?? methodology)
    : methodology;

  return (
    <div>
      <SettingsPageTitle
        title="General"
        subtitle="Program identity and delivery model. Settings here affect all projects within this program."
      />

      {/* Below Admin the whole form is read-only (issue 1084): StubFieldset disables
          every native control with the rule-122 recipe, and the custom pickers /
          toggles get canEdit={canEdit} so they render their own read-only view. */}
      <StubFieldset disabled={!canEdit}>
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

          {/* Headline target finish date (issue 560) — a program spans projects with
              independent CPM schedules, so there is no computed end date; the PM
              sets one. Native date input → StubFieldset disables it below Admin
              (rule 122). Empty clears it (open-ended). */}
          <FieldRow
            label="Target date"
            hint="The program's headline finish date — shows on its card and Projects tab. Optional."
          >
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              aria-label="Program target date"
              className="w-[160px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
              canEdit={canEdit}
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
            hint={
              methodologyLocked
                ? 'The workspace requires every program to use its default methodology. A workspace admin can relax this on the workspace Methodology page.'
                : 'Default methodology for projects in this program — unless a project sets its own. Inherits the workspace default until you choose one.'
            }
          >
            <div className="flex gap-2" role="radiogroup" aria-label="Methodology">
              {METHODOLOGY_OPTIONS.map((opt) => {
                const isSelected = methodologyShown === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      if (methodologyEditable) setMethodology(opt.id);
                    }}
                    disabled={!methodologyEditable}
                    role="radio"
                    aria-checked={isSelected}
                    className={[
                      'px-3 py-1 rounded border text-[12px] font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                      !methodologyEditable ? 'cursor-not-allowed' : '',
                      isSelected
                        ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                        : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                      !methodologyEditable && !isSelected ? 'opacity-60' : '',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                );
              })}
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
              onLabel="On"
              offLabel="Off"
              ariaLabel="Allow guest access"
              canEdit={canEdit}
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
              onLabel="On"
              offLabel="Off"
              ariaLabel="Allow public link sharing"
              canEdit={canEdit}
            />
          </FieldRow>

          {/* Forecast history (ADR-0144, issue 1232). Inherits the workspace settings
              unless this program overrides; projects inherit from here in turn. */}
          <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
            Forecast history
          </h3>

          <FieldRow
            label="Keep Monte Carlo run history"
            hint={`${MC_HISTORY_HINT} Inherits the workspace setting unless you override it here.`}
          >
            <InheritableToggleField
              value={mcHistoryEnabled}
              onChange={setMcHistoryEnabled}
              inherited={program?.inherited_mc_history_enabled ?? true}
              inheritFromLabel="the workspace default"
              scopeNoun="program"
              onLabel="On"
              offLabel="Off"
              ariaLabel="Keep Monte Carlo run history"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Run history limit"
            hint="The most recent runs kept per project. Older runs are pruned. Inherits the workspace setting unless you override it here."
          >
            <InheritableNumberField
              value={mcHistoryRetentionCap}
              onChange={setMcHistoryRetentionCap}
              inherited={program?.inherited_mc_history_retention_cap ?? 100}
              inheritFromLabel="the workspace default"
              min={MC_HISTORY_RETENTION_MIN}
              max={MC_HISTORY_RETENTION_MAX}
              ariaLabel="Run history limit"
              overrideHint={`Between ${MC_HISTORY_RETENTION_MIN} and ${MC_HISTORY_RETENTION_MAX} runs.`}
              scopeNoun="program"
              canEdit={canEdit}
            />
          </FieldRow>

          <FieldRow
            label="Run attribution visible to"
            hint={`${MC_ATTRIBUTION_HINT} Inherits the workspace setting unless you override it here.`}
          >
            <InheritableSelectField
              value={mcHistoryAttributionAudience}
              onChange={setMcHistoryAttributionAudience}
              inherited={program?.inherited_mc_history_attribution_audience ?? 'ADMIN_OWNER'}
              options={MC_ATTRIBUTION_OPTIONS}
              inheritFromLabel="the workspace default"
              ariaLabel="Run attribution visible to"
              scopeNoun="program"
              canEdit={canEdit}
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
      </StubFieldset>

      {/* Destructive actions live on the Archive / Delete page (#977). */}
      <DangerZoneLink to="#lifecycle" />
    </div>
  );
}
