import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { OrgResource } from '@/hooks/useResources';
import {
  useUpdateResource,
  useDeactivateResource,
  useRestoreResource,
  useCreateResource,
} from '@/hooks/useResources';
import { useResourceSkills, useAddResourceSkill, useRemoveResourceSkill } from '@/hooks/useResourceSkills';
import { SkillChip } from '@/features/roster/SkillChip';
import { CapacityInput } from '@/features/roster/CapacityInput';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ViewProps {
  mode: 'view';
  resource: OrgResource;
  onDeactivated: () => void;
  onRestored: () => void;
}

interface CreateProps {
  mode: 'create';
  onCreated: (id: string) => void;
  onCancel: () => void;
}

type Props = ViewProps | CreateProps;

// ---------------------------------------------------------------------------
// View / edit panel
// ---------------------------------------------------------------------------

function ViewPanel({ resource, onDeactivated, onRestored }: Omit<ViewProps, 'mode'>) {
  const updateMutation = useUpdateResource();
  const deactivateMutation = useDeactivateResource();
  const restoreMutation = useRestoreResource();
  const { data: skills = [] } = useResourceSkills(resource.id);
  const addSkill = useAddResourceSkill(resource.id);
  const removeSkill = useRemoveResourceSkill(resource.id);

  const [name, setName] = useState(resource.name);
  const [email, setEmail] = useState(resource.email);
  const [jobRole, setJobRole] = useState(resource.jobRole);
  const [maxUnits, setMaxUnits] = useState(resource.maxUnits);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync form when selection changes
  useEffect(() => {
    setName(resource.name);
    setEmail(resource.email);
    setJobRole(resource.jobRole);
    setMaxUnits(resource.maxUnits);
    setSaveError(null);
    setConfirmDeactivate(false);
  }, [resource.id, resource.name, resource.email, resource.jobRole, resource.maxUnits]);

  function handleSave() {
    setSaveError(null);
    updateMutation.mutate(
      { id: resource.id, name, email, jobRole, maxUnits },
      {
        onError: (err) => {
          setSaveError(err.message ?? 'Save failed. You may not have permission to edit resources.');
        },
      },
    );
  }

  function handleDeactivate() {
    deactivateMutation.mutate(resource.id, { onSuccess: onDeactivated });
    setConfirmDeactivate(false);
  }

  function handleRestore() {
    restoreMutation.mutate(resource.id, { onSuccess: onRestored });
  }

  const isSaving = updateMutation.isPending;
  const hasChanges =
    name !== resource.name ||
    email !== resource.email ||
    jobRole !== resource.jobRole ||
    maxUnits !== resource.maxUnits;

  return (
    <div className="flex flex-col h-full">
      {/* Slot: resources_page.detail_managed_by — Enterprise injects badge here */}
      <div data-slot="resources_page.detail_managed_by" />

      {resource.isDeleted && (
        <div
          role="status"
          className="mx-4 mt-4 px-3 py-2 rounded border border-neutral-border bg-neutral-surface-raised text-xs text-neutral-text-secondary"
        >
          This resource is deactivated and hidden from new assignments.
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {saveError && (
          <div role="alert" className="px-3 py-2 rounded border border-semantic-critical/40 bg-semantic-critical/5 text-xs text-semantic-critical">
            {saveError}
          </div>
        )}

        <Field label="Name">
          <input
            id="resource-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={resource.isDeleted}
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Email">
          <input
            id="resource-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={resource.isDeleted}
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Job role">
          <input
            id="resource-job-role"
            type="text"
            value={jobRole}
            onChange={(e) => setJobRole(e.target.value)}
            disabled={resource.isDeleted}
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Capacity">
          <CapacityInput
            value={maxUnits}
            onChange={setMaxUnits}
            disabled={resource.isDeleted}
          />
        </Field>

        {/* Skills */}
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
            Skills
          </p>
          {skills.length === 0 ? (
            <p className="text-xs text-neutral-text-disabled">No skills tagged.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {skills.map((rs) => (
                <li key={rs.id} className="flex items-center gap-0.5">
                  <SkillChip name={rs.skill.name} proficiency={rs.proficiency} />
                  {!resource.isDeleted && (
                    <button
                      type="button"
                      aria-label={`Remove ${rs.skill.name} skill`}
                      onClick={() => removeSkill.mutate(rs.id)}
                      className="ml-0.5 text-neutral-text-disabled hover:text-semantic-critical
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!resource.isDeleted && (
            <AddSkillRow resourceId={resource.id} onAdd={(skillId, proficiency) =>
              addSkill.mutate({ skillId, proficiency })
            } />
          )}
        </div>
      </div>

      {/* Footer actions */}
      {!resource.isDeleted && (
        <div className="shrink-0 border-t border-neutral-border px-4 py-3 flex items-center justify-between">
          {confirmDeactivate ? (
            <div className="flex items-center gap-2 w-full">
              <p className="text-xs text-neutral-text-secondary flex-1">Deactivate {resource.name}?</p>
              <button
                type="button"
                onClick={() => setConfirmDeactivate(false)}
                className="h-7 px-3 rounded text-xs border border-neutral-border text-neutral-text-secondary hover:border-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeactivate}
                disabled={deactivateMutation.isPending}
                className="h-7 px-3 rounded text-xs bg-semantic-critical text-white hover:bg-semantic-critical/90
                  disabled:opacity-40
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
              >
                Deactivate
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmDeactivate(true)}
                className="h-7 px-3 rounded text-xs text-semantic-at-risk border border-semantic-at-risk/40 hover:bg-semantic-at-risk/5
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1"
              >
                ⚠ Deactivate
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
                className="h-7 px-3 rounded text-xs bg-brand-primary text-white hover:bg-brand-primary/90
                  disabled:opacity-40 disabled:cursor-not-allowed
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {isSaving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      )}

      {resource.isDeleted && (
        <div className="shrink-0 border-t border-neutral-border px-4 py-3">
          <button
            type="button"
            onClick={handleRestore}
            disabled={restoreMutation.isPending}
            className="h-7 px-3 rounded text-xs border border-neutral-border text-neutral-text-secondary hover:border-brand-primary hover:text-neutral-text-primary
              disabled:opacity-40
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {restoreMutation.isPending ? 'Restoring…' : 'Restore resource'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create panel
// ---------------------------------------------------------------------------

function CreatePanel({ onCreated, onCancel }: Omit<CreateProps, 'mode'>) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [jobRole, setJobRole] = useState('');
  const [maxUnits, setMaxUnits] = useState(1.0);
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateResource();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    createMutation.mutate(
      { name: name.trim(), email, jobRole, maxUnits },
      {
        onSuccess: (created) => onCreated(created.id),
        onError: (err) => {
          setError(err.message ?? 'Failed to create resource.');
        },
      },
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Slot: resources_page.create_form_extension — Enterprise injects extra fields */}
      <div data-slot="resources_page.create_form_extension" />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && (
          <div role="alert" className="px-3 py-2 rounded border border-semantic-critical/40 bg-semantic-critical/5 text-xs text-semantic-critical">
            {error}
          </div>
        )}

        <Field label="Name" required>
          <input
            ref={nameRef}
            id="create-resource-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Maria Chen"
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Email">
          <input
            id="create-resource-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. maria@company.com"
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Job role">
          <input
            id="create-resource-job-role"
            type="text"
            value={jobRole}
            onChange={(e) => setJobRole(e.target.value)}
            placeholder="e.g. Senior Engineer"
            className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary bg-neutral-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Capacity">
          <CapacityInput value={maxUnits} onChange={setMaxUnits} />
        </Field>
      </div>

      <div className="shrink-0 border-t border-neutral-border px-4 py-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 rounded text-xs border border-neutral-border text-neutral-text-secondary hover:border-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={!name.trim() || createMutation.isPending}
          className="h-7 px-3 rounded text-xs bg-brand-primary text-white hover:bg-brand-primary/90
            disabled:opacity-40 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {createMutation.isPending ? 'Creating…' : 'Create resource'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------

export function ResourceDetailPanel(props: Props) {
  if (props.mode === 'create') {
    return <CreatePanel onCreated={props.onCreated} onCancel={props.onCancel} />;
  }
  return (
    <ViewPanel
      resource={props.resource}
      onDeactivated={props.onDeactivated}
      onRestored={props.onRestored}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  required?: boolean;
  children: ReactNode;
}

function Field({ label, required, children }: FieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1">
        {label}
        {required && <span aria-hidden="true" className="text-semantic-critical ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// Minimal inline add-skill row — uses the existing skill catalog search.
// Full SkillEditor popover would be wired here in a follow-up; for now a
// simple text + proficiency select matches the pre-alpha scope.
interface AddSkillRowProps {
  resourceId: string;
  onAdd: (skillId: string, proficiency: 1 | 2 | 3) => void;
}

function AddSkillRow(_props: AddSkillRowProps) {
  // Skill addition uses the SkillEditor from RosterDetailPanel — wire up
  // in a follow-up once the skill search combobox is extracted as a shared
  // component. For now surface a placeholder CTA.
  return (
    <p className="mt-2 text-xs text-neutral-text-disabled italic">
      Use the project Team tab to manage skills in detail.
    </p>
  );
}
