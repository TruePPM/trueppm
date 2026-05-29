import { useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { useProgramCeremonies } from '@/features/programs/hooks/useProgramCeremonies';
import {
  useDeleteCeremony,
  useUpdateCeremony,
} from '@/features/programs/hooks/useProgramCeremonyMutations';
import { CeremonyModal } from '@/features/programs/cadence/CeremonyModal';
import { PhaseGateConfigPanel } from '@/features/programs/cadence/PhaseGateConfigPanel';
import { formatCadence, formatDuration } from '@/features/programs/cadence/cadenceCopy';
import { ROLE_ADMIN } from '@/lib/roles';
import type { CeremonyTemplate } from '@/api/types';

const GRID = '1.6fr 1.4fr 90px 1fr 60px 44px';

function Toggle({
  on,
  disabled,
  busy,
  onChange,
  label,
}: {
  on: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onChange}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        on
          ? 'bg-brand-primary border-brand-primary'
          : 'bg-neutral-surface-sunken border-neutral-border',
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-pointer hover:ring-2 hover:ring-brand-primary/30',
        busy ? 'opacity-60' : '',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

interface CeremonyRowProps {
  ceremony: CeremonyTemplate;
  isLast: boolean;
  canEdit: boolean;
  isToggling: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function CeremonyRow({
  ceremony,
  isLast,
  canEdit,
  isToggling,
  onToggle,
  onEdit,
  onDelete,
}: CeremonyRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      className={[
        'grid items-center px-4 py-3 text-[13px]',
        isLast ? '' : 'border-b border-neutral-border/55',
      ].join(' ')}
      style={{ gridTemplateColumns: GRID }}
    >
      <span className="font-medium text-neutral-text-primary">{ceremony.name}</span>
      <span className="text-[12px] text-neutral-text-secondary">{formatCadence(ceremony)}</span>
      <span className="tppm-mono text-[12px] text-neutral-text-secondary">
        {formatDuration(ceremony.duration_minutes)}
      </span>
      <span className="text-[12px] text-neutral-text-secondary truncate">
        {ceremony.owner_role || '—'}
      </span>
      <span className="flex justify-center">
        <Toggle
          on={ceremony.enabled}
          disabled={!canEdit}
          busy={isToggling}
          onChange={onToggle}
          label={`${ceremony.enabled ? 'Disable' : 'Enable'} ${ceremony.name}`}
        />
      </span>
      <div className="relative flex justify-end">
        {canEdit && !confirmDelete && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More options for ${ceremony.name}`}
            className="text-neutral-text-secondary text-[18px] leading-none px-1.5 py-0.5 rounded hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            ⋯
          </button>
        )}
        {menuOpen && (
          <div
            role="menu"
            tabIndex={-1}
            className="absolute right-0 top-full mt-1 z-10 min-w-[140px] rounded-md border border-neutral-border bg-neutral-surface-raised py-1 text-[13px]"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:bg-neutral-surface-sunken"
            >
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setConfirmDelete(true);
              }}
              className="block w-full text-left px-3 py-1.5 text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:bg-semantic-critical/5"
            >
              Delete…
            </button>
          </div>
        )}
        {confirmDelete && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
              className="h-7 px-2 rounded border border-semantic-critical text-xs font-semibold text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="h-7 px-2 rounded border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Cancel
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Program > Cadence & ceremonies settings page (#528, ADR-0079).
 *
 * Lists CeremonyTemplate rows for the program and exposes inline
 * enable/disable, edit, and delete actions. Add ceremony is a centered
 * modal; phase-gate config is a right-side slide-over. Write actions are
 * gated to ADMIN+ both client-side (UX) and server-side (security).
 */
export function ProgramCadencePage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: ceremonies = [], isLoading, isError } = useProgramCeremonies(programId);

  const updateCeremony = useUpdateCeremony(programId ?? '');
  const deleteCeremony = useDeleteCeremony(programId ?? '');

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CeremonyTemplate | null>(null);
  const [phaseGateOpen, setPhaseGateOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  if (!programId) return null;

  const canEdit = (program?.my_role ?? -1) >= ROLE_ADMIN;

  async function handleToggle(ceremony: CeremonyTemplate): Promise<void> {
    setTogglingId(ceremony.id);
    setToggleError(null);
    try {
      await updateCeremony.mutateAsync({
        ceremonyId: ceremony.id,
        patch: { enabled: !ceremony.enabled },
      });
    } catch {
      setToggleError(`Couldn’t update “${ceremony.name}” — try again.`);
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(ceremony: CeremonyTemplate): Promise<void> {
    try {
      await deleteCeremony.mutateAsync(ceremony.id);
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : `Couldn’t delete “${ceremony.name}”.`);
    }
  }

  return (
    <>
      <SettingsPageTitle
        title="Cadence & ceremonies"
        subtitle="Recurring meeting templates. Instances are created when the program starts and linked to milestones."
        action={
          canEdit ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              + Add ceremony
            </button>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        <SettingsCard>
          <div
            className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: GRID }}
          >
            <span>Ceremony</span>
            <span>Cadence</span>
            <span>Duration</span>
            <span>Owner</span>
            <span className="text-center">Active</span>
            <span />
          </div>

          {isLoading && (
            <div
              role="status"
              aria-label="Loading ceremonies"
              className="px-4 py-6 text-xs text-neutral-text-secondary"
            >
              Loading…
            </div>
          )}

          {isError && (
            <div role="alert" className="px-4 py-6 text-xs text-semantic-critical">
              Couldn’t load ceremonies. Please refresh.
            </div>
          )}

          {!isLoading && !isError && ceremonies.length === 0 && (
            <div className="px-6 py-10 text-center">
              <p className="text-[13px] font-medium text-neutral-text-primary">
                No ceremonies configured yet
              </p>
              <p className="text-[12px] text-neutral-text-secondary mt-1 max-w-[460px] mx-auto leading-snug">
                Add recurring meetings like a program sync, steering committee, or risk review to
                keep cadence visible to the team.
              </p>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="mt-4 px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  + Add your first ceremony
                </button>
              ) : (
                <p className="mt-4 text-[12px] text-neutral-text-secondary italic">
                  Program admins can configure ceremonies for this program.
                </p>
              )}
            </div>
          )}

          {!isLoading &&
            !isError &&
            ceremonies.map((c, i) => (
              <CeremonyRow
                key={c.id}
                ceremony={c}
                isLast={i === ceremonies.length - 1}
                canEdit={canEdit}
                isToggling={togglingId === c.id}
                onToggle={() => void handleToggle(c)}
                onEdit={() => setEditing(c)}
                onDelete={() => void handleDelete(c)}
              />
            ))}
        </SettingsCard>

        {toggleError && (
          <div
            role="alert"
            className="rounded border border-semantic-critical/40 bg-semantic-critical-bg px-3 py-2 text-xs text-semantic-critical"
          >
            {toggleError}
          </div>
        )}

        {/* Phase gate calendar */}
        <section
          aria-labelledby="phasegate-heading"
          className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4"
        >
          <h2
            id="phasegate-heading"
            className="text-[13px] font-semibold text-neutral-text-primary mb-1"
          >
            Phase gate calendar
          </h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-snug">
            Gate reviews are automatically scheduled when a phase boundary milestone is saved.
            Attach a calendar invite template here.
          </p>
          <button
            type="button"
            onClick={() => setPhaseGateOpen(true)}
            className="px-3 py-1.5 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {canEdit ? 'Configure gate template…' : 'View gate template…'}
          </button>
        </section>
      </div>

      {addOpen && (
        <CeremonyModal
          programId={programId}
          onClose={() => setAddOpen(false)}
          onSaved={() => setAddOpen(false)}
        />
      )}
      {editing && (
        <CeremonyModal
          programId={programId}
          ceremony={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
      {phaseGateOpen && (
        <PhaseGateConfigPanel
          programId={programId}
          canEdit={canEdit}
          onClose={() => setPhaseGateOpen(false)}
        />
      )}
    </>
  );
}
