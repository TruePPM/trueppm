import { useId, useMemo } from 'react';
import {
  ATTACHMENT_TYPE_CATALOG,
  ATTACHMENT_TYPE_GROUPS,
  DENIED_ATTACHMENT_TYPES,
  type AttachmentTypeOption,
  type DeniedAttachmentType,
} from '@/lib/attachmentTypes';

export interface AttachmentTypesChecklistProps {
  /** Currently-allowed MIME types. The checked set. */
  value: string[];
  /** Emits the next allowed set whenever a box / group legend toggles. */
  onChange: (next: string[]) => void;
  /** When false every box is disabled (read-only render-gate; the server still enforces). */
  disabled?: boolean;
  /** Selectable options, grouped by `group`. Defaults to the full catalog. */
  groups?: readonly AttachmentTypeOption[];
  /** Permanently-blocked types rendered as disabled rows. Defaults to the denylist. */
  deniedTypes?: readonly DeniedAttachmentType[];
}

/** Lock glyph for the "Always blocked" rows — decorative; the helper text carries the meaning. */
function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Native-checkbox allow-list editor for attachment MIME types (ADR-0153, issue 976).
 *
 * Each catalog group is a `<fieldset><legend>` whose legend is itself a group
 * checkbox: it is `indeterminate` when only some children are checked and toggles
 * all of the group's children when clicked. Every option is a real
 * `<input type="checkbox">` + `<label htmlFor>` for keyboard + screen-reader
 * support (WCAG 2.1 AA — color is never the only signal).
 *
 * The "Always blocked" group at the bottom renders the permanent security
 * denylist as DISABLED, `aria-disabled` rows that are NOT real inputs — they can
 * never enter `value`, so the server denylist is mirrored without ever being
 * representable as "allowed".
 */
export function AttachmentTypesChecklist({
  value,
  onChange,
  disabled = false,
  groups = ATTACHMENT_TYPE_CATALOG,
  deniedTypes = DENIED_ATTACHMENT_TYPES,
}: AttachmentTypesChecklistProps) {
  const idPrefix = useId();
  const checked = useMemo(() => new Set(value), [value]);

  const byGroup = useMemo(() => {
    const map = new Map<string, AttachmentTypeOption[]>();
    for (const g of ATTACHMENT_TYPE_GROUPS) map.set(g, []);
    for (const opt of groups) {
      const list = map.get(opt.group) ?? [];
      list.push(opt);
      map.set(opt.group, list);
    }
    // Preserve catalog group order, then any groups not in the canonical order.
    return [...map.entries()].filter(([, opts]) => opts.length > 0);
  }, [groups]);

  /** Add/remove a single MIME, preserving the input order of the rest. */
  function toggleOne(mime: string, next: boolean) {
    if (next) {
      if (checked.has(mime)) return;
      onChange([...value, mime]);
    } else {
      onChange(value.filter((m) => m !== mime));
    }
  }

  /** Check/uncheck every option in a group at once (the legend checkbox). */
  function toggleGroup(opts: AttachmentTypeOption[], next: boolean) {
    const groupMimes = opts.map((o) => o.mime);
    if (next) {
      const merged = [...value];
      for (const m of groupMimes) if (!merged.includes(m)) merged.push(m);
      onChange(merged);
    } else {
      const groupSet = new Set(groupMimes);
      onChange(value.filter((m) => !groupSet.has(m)));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {byGroup.map(([group, opts]) => {
        const checkedCount = opts.filter((o) => checked.has(o.mime)).length;
        const allChecked = checkedCount === opts.length;
        const someChecked = checkedCount > 0 && !allChecked;
        const legendId = `${idPrefix}-${group}-legend`;
        return (
          <fieldset key={group} className="m-0 p-0 border-0" aria-describedby={legendId}>
            <legend className="contents">
              <label className="flex items-center gap-2 py-2.5 md:py-1.5 min-h-11 md:min-h-0 cursor-pointer">
                <input
                  type="checkbox"
                  // Group checkbox: indeterminate when partially checked. The
                  // ref callback applies `indeterminate` (not a DOM attribute).
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  checked={allChecked}
                  disabled={disabled}
                  onChange={(e) => toggleGroup(opts, e.target.checked)}
                  className="h-4 w-4 shrink-0 accent-brand-primary disabled:cursor-not-allowed"
                  aria-label={`All ${group}`}
                />
                <span
                  id={legendId}
                  className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
                >
                  {group}
                </span>
              </label>
            </legend>
            <div className="flex flex-col gap-0.5 pl-6">
              {opts.map((opt) => {
                const inputId = `${idPrefix}-${opt.mime}`;
                return (
                  <div key={opt.mime} className="flex items-center gap-2 py-2.5 md:py-1 min-h-11 md:min-h-0">
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked.has(opt.mime)}
                      disabled={disabled}
                      onChange={(e) => toggleOne(opt.mime, e.target.checked)}
                      className="h-4 w-4 shrink-0 accent-brand-primary disabled:cursor-not-allowed"
                    />
                    <label
                      htmlFor={inputId}
                      className={[
                        'text-[13px] cursor-pointer',
                        disabled ? 'text-neutral-text-secondary' : 'text-neutral-text-primary',
                      ].join(' ')}
                    >
                      {opt.label}
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {deniedTypes.length > 0 && (
        <fieldset className="m-0 p-0 border-0">
          <legend className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary py-1.5">
            Always blocked
          </legend>
          <div className="flex flex-col gap-0.5 pl-6">
            {deniedTypes.map((opt) => (
              <div
                key={opt.mime}
                // NOT a real input — a permanently-blocked type can never become
                // part of `value`. Rendered for transparency only.
                aria-disabled="true"
                className="flex items-center gap-2 py-2.5 md:py-1 min-h-11 md:min-h-0 text-neutral-text-disabled"
              >
                <span className="shrink-0" aria-hidden="true">
                  <LockGlyph />
                </span>
                <span className="text-[13px]">{opt.label}</span>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-neutral-text-secondary mt-1 pl-6">
            Blocked for security and can&apos;t be enabled.
          </p>
        </fieldset>
      )}
    </div>
  );
}
