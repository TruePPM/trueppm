import { useId, useMemo } from 'react';
import { AttachmentTypesChecklist } from './AttachmentTypesChecklist';
import { labelForMime } from '@/lib/attachmentTypes';
import type { AttachmentTypeOption, DeniedAttachmentType } from '@/lib/attachmentTypes';

export interface InheritableMultiSelectFieldProps {
  /** The scope's own override. `null` = inherit from the parent scope. */
  value: string[] | null;
  /** Emits the next override: a concrete set to override, or `null` to inherit. */
  onChange: (next: string[] | null) => void;
  /** The set the scope WOULD inherit if its own override were cleared (the
   *  server-resolved parent value — `inherited_allowed_attachment_types`). */
  inherited: string[];
  /** Human description of the inheritance source, e.g. "the workspace default". */
  inheritFromLabel: string;
  /** Accessible name for the radiogroup and the override checklist region. Required. */
  ariaLabel: string;
  /** Owner/Admin (role >= ADMIN). When false the control is a read-only indicator. */
  canEdit: boolean;
  /** Noun for the read-only "set on this {scopeNoun}" line. */
  scopeNoun?: string;
  /** Selectable options for the override checklist (the catalog). */
  groups: readonly AttachmentTypeOption[];
  /** Permanently-blocked types shown disabled in the checklist. */
  deniedTypes: readonly DeniedAttachmentType[];
}

const chipClass = (selected: boolean) =>
  [
    'px-3 py-1 rounded border text-[12px] font-medium transition-colors cursor-pointer',
    'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-primary has-[:focus-visible]:ring-offset-1',
    selected
      ? 'border-2 border-brand-primary bg-brand-primary-light text-brand-primary'
      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
  ].join(' ');

/** Render up to `max` human labels, then a "+K more" summary. */
function summarizeLabels(mimes: readonly string[], max = 6): string {
  if (mimes.length === 0) return 'none';
  const labels = mimes.map(labelForMime);
  if (labels.length <= max) return labels.join(', ');
  const shown = labels.slice(0, max).join(', ');
  return `${shown} +${labels.length - max} more`;
}

/**
 * Inheritable multi-select (allow-list) control for a scope that can INHERIT or
 * OVERRIDE (ADR-0153, issue 976).
 *
 * The set analog of {@link InheritableToggleField} / {@link InheritableSelectField}:
 * an inherit/override radio pair wrapping an {@link AttachmentTypesChecklist}.
 * "Inherit (N types)" emits `null` (reset-to-inherited); "Override" reveals the
 * checklist **seeded from the inherited set** (`onChange(value ?? inherited)`) and
 * emits the chosen array. A non-blocking delta line compares the override to the
 * inherited set (narrower / wider / same) so the admin sees how their override
 * relates to the parent without being prevented from diverging. Below Admin it
 * collapses to a read-only comma-joined list + provenance.
 */
export function InheritableMultiSelectField({
  value,
  onChange,
  inherited,
  inheritFromLabel,
  ariaLabel,
  canEdit,
  scopeNoun = 'scope',
  groups,
  deniedTypes,
}: InheritableMultiSelectFieldProps) {
  const radioName = useId();
  const inheriting = value === null;
  const effective = value ?? inherited;

  // Delta of the override vs the inherited set — purely informational.
  const delta = useMemo(() => {
    if (value === null) return null;
    const inheritedSet = new Set(inherited);
    const ownSet = new Set(value);
    const removed = inherited.filter((m) => !ownSet.has(m));
    const added = value.filter((m) => !inheritedSet.has(m));
    if (removed.length === 0 && added.length === 0) return { kind: 'same' as const };
    if (added.length === 0) return { kind: 'narrower' as const, mimes: removed };
    if (removed.length === 0) return { kind: 'wider' as const, mimes: added };
    return { kind: 'mixed' as const, added, removed };
  }, [value, inherited]);

  if (!canEdit) {
    const provenance = inheriting
      ? `inherited from ${inheritFromLabel}`
      : `set on this ${scopeNoun}`;
    const summary = summarizeLabels(effective);
    return (
      <div
        className="flex flex-col gap-1 text-[13px]"
        aria-label={`${ariaLabel}: ${summary}, ${provenance}. View only.`}
      >
        <span className="font-medium text-neutral-text-primary" aria-hidden="true">
          {summary}
        </span>
        <span className="text-neutral-text-secondary" aria-hidden="true">
          {provenance} · View only.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-2">
        <label className={chipClass(inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={inheriting}
            onChange={() => onChange(null)}
          />
          Inherit
          <span className="font-normal opacity-80">
            {' '}
            ({inherited.length} {inherited.length === 1 ? 'type' : 'types'})
          </span>
        </label>
        <label className={chipClass(!inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={!inheriting}
            // Opening override seeds from the currently-inherited set so the
            // checklist starts from reality rather than empty (ADR-0153).
            onChange={() => onChange(value ?? inherited)}
          />
          Override
        </label>
      </div>

      {inheriting ? (
        <p className="text-[12px] text-neutral-text-secondary">
          Using {inheritFromLabel}:{' '}
          <span className="font-medium text-neutral-text-primary">{summarizeLabels(inherited)}</span>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <AttachmentTypesChecklist
            value={value ?? []}
            onChange={(next) => onChange(next)}
            groups={groups}
            deniedTypes={deniedTypes}
            ariaLabel={ariaLabel}
          />
          {delta && (
            <p className="text-[12px] text-neutral-text-secondary" role="status" aria-live="polite">
              {delta.kind === 'same' && 'Same as parent.'}
              {delta.kind === 'narrower' &&
                `Narrower than parent (removed: ${delta.mimes.map(labelForMime).join(', ')}).`}
              {delta.kind === 'wider' &&
                `Wider than parent (added: ${delta.mimes.map(labelForMime).join(', ')}).`}
              {delta.kind === 'mixed' &&
                `Differs from parent (added: ${delta.added
                  .map(labelForMime)
                  .join(', ')}; removed: ${delta.removed.map(labelForMime).join(', ')}).`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
