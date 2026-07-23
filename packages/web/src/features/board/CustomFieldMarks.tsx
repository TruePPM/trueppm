/**
 * Custom-field value marks on a board card (#2144, ADR-0528).
 *
 * Renders a task's populated custom-field values as compact, type-aware marks.
 * They are the LOWEST-priority card content (design: docs/design/board-card-custom-fields.md,
 * web-rule 271): appended last, first to collapse into overflow, never displacing the
 * health badge or story-point pill. Unset values render nothing.
 *
 * Two entry points share the mark vocabulary:
 *   - {@link CustomFieldMarks} — comfortable (≤3 inline + "+N more" peek) / detailed
 *     (all inline). A new card row, hairline-separated.
 *   - {@link CustomFieldCompactPeek} — the 36px compact bar: 0 inline, one trailing
 *     ⊕N tap-to-peek button.
 *
 * Accessibility: every mark carries an aria-label naming field + value; an option's
 * color is only ever a dot beside its label text, never the sole channel (WCAG 1.4.1);
 * the boolean check is neutral, never green (green is reserved for health).
 */
import { CardPeekButton } from './CardPeekButton';
import type { CustomFieldOption, ProjectCustomField } from '@/hooks/useProjectCustomFields';
import type { CustomFieldPersonValue, CustomFieldValue } from '@/types';

const COMFORTABLE_INLINE_CAP = 3;
const MULTI_INLINE_CAP = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A field definition paired with its populated value on this task. */
interface PopulatedField {
  field: ProjectCustomField;
  value: CustomFieldValue;
}

/**
 * The custom-field values to render for a task, in author order.
 *
 * Only `showOnCard` fields that actually have a value are returned — a BOOLEAN set to
 * `false` and an empty multi-select array count as unset (they resolve to nothing on
 * the card), so an off checkbox never consumes a slot. `fields` is expected to be the
 * showOnCard subset already sorted by `order`.
 */
export function populatedCardFields(
  fields: ProjectCustomField[],
  values: Record<string, CustomFieldValue> | undefined,
): PopulatedField[] {
  if (!values) return [];
  const out: PopulatedField[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined || value === null) continue;
    if (field.fieldType === 'BOOLEAN' && value !== true) continue;
    if (field.fieldType === 'MULTI_SELECT' && (!Array.isArray(value) || value.length === 0))
      continue;
    if (field.fieldType === 'TEXT' && value === '') continue;
    out.push({ field, value });
  }
  return out;
}

function formatDate(iso: string): string {
  // Parse the ISO parts directly (no Date()) so the label is timezone-stable.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month}`;
}

function optionFor(field: ProjectCustomField, key: string): CustomFieldOption {
  return field.options.find((o) => o.value === key) ?? { value: key, label: key };
}

/** A neutral option chip: the option color as a dot beside the label (never color-only). */
function SelectChip({ option }: { option: CustomFieldOption }) {
  const color = option.color ?? undefined;
  return (
    <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-chip text-xs font-medium border bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary">
      {color && (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
      )}
      <span className="truncate max-w-[14ch]" title={option.label}>
        {option.label}
      </span>
    </span>
  );
}

// Design §3 key:value rule — the field-name key carries the datum's meaning, so it must
// be readable (secondary, ≥4.5:1), never the sub-threshold disabled token; value in primary.
const keyClass = 'text-neutral-text-secondary font-medium shrink-0';
const valClass = 'text-neutral-text-primary font-medium';

/** MULTI_SELECT: up to `MULTI_INLINE_CAP` option chips plus a "+N" overflow count. */
function MultiSelectMark({
  field,
  label,
  value,
}: {
  field: ProjectCustomField;
  label: string;
  value: string[];
}) {
  const shown = value.slice(0, MULTI_INLINE_CAP);
  const extra = value.length - shown.length;
  const labels = value.map((v) => optionFor(field, v).label).join(', ');
  return (
    <span
      className="inline-flex items-center gap-1 text-xs min-w-0"
      aria-label={`${label}: ${labels}`}
    >
      <span className={keyClass} aria-hidden="true">
        {label}:
      </span>
      {shown.map((v) => (
        <SelectChip key={v} option={optionFor(field, v)} />
      ))}
      {extra > 0 && (
        <span
          className="inline-flex items-center h-[18px] px-1 rounded-chip text-xs font-semibold bg-neutral-surface-sunken border border-neutral-border text-neutral-text-secondary"
          aria-hidden="true"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

/** USER: an initials chip, optionally trailed by the first name (detailed density). */
function UserMark({
  label,
  value,
  named,
}: {
  label: string;
  value: CustomFieldPersonValue;
  named: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs" aria-label={`${label}: ${value.name}`}>
      <span className={keyClass} aria-hidden="true">
        {label}:
      </span>
      <span
        className="inline-block px-1 py-px rounded-chip text-xs text-brand-primary bg-brand-primary/10 font-bold"
        aria-hidden="true"
      >
        {value.initials}
      </span>
      {named && (
        <span className={valClass} aria-hidden="true">
          {value.name.split(' ')[0]}
        </span>
      )}
    </span>
  );
}

/**
 * TEXT (and any unexpected shape) — key: value, truncated with a title fallback.
 * Coerce without Object's default stringification (never "[object Object]").
 */
function TextMark({ label, value }: { label: string; value: CustomFieldValue }) {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : Array.isArray(value)
          ? value.join(', ')
          : '';
  return (
    <span
      className="inline-flex items-center gap-1 text-xs min-w-0"
      aria-label={`${label}: ${text}`}
    >
      <span className={keyClass} aria-hidden="true">
        {label}:
      </span>
      <span className={`${valClass} truncate max-w-[16ch]`} title={text} aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/**
 * A single custom-field value, dispatched by field type. `named` shows the person's
 * first name (detailed density + peek); at comfortable density the avatar stands alone.
 * The branches carrying their own inner conditionals (multi-select overflow, the named
 * person, the text-coercion fallback) are extracted above so this stays a flat dispatch.
 */
function FieldMark({
  field,
  value,
  named = false,
}: {
  field: ProjectCustomField;
  value: CustomFieldValue;
  named?: boolean;
}) {
  const label = field.name;

  if (field.fieldType === 'SINGLE_SELECT' && typeof value === 'string') {
    const option = optionFor(field, value);
    return (
      <span
        className="inline-flex items-center gap-1 text-xs min-w-0"
        aria-label={`${label}: ${option.label}`}
      >
        <span className={keyClass} aria-hidden="true">
          {label}:
        </span>
        <SelectChip option={option} />
      </span>
    );
  }

  if (field.fieldType === 'MULTI_SELECT' && Array.isArray(value)) {
    return <MultiSelectMark field={field} label={label} value={value} />;
  }

  if (field.fieldType === 'BOOLEAN') {
    // Only ever rendered for `true` (populatedCardFields filters false/unset).
    return (
      <span className="inline-flex items-center gap-1 text-xs" aria-label={`${label}: yes`}>
        <span className={valClass}>{label}</span>
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-neutral-surface-sunken border border-neutral-border text-neutral-text-secondary text-[10px] leading-none"
          aria-hidden="true"
        >
          ✓
        </span>
      </span>
    );
  }

  if (field.fieldType === 'DATE' && typeof value === 'string') {
    const display = formatDate(value);
    return (
      <span className="inline-flex items-center gap-1 text-xs" aria-label={`${label}: ${display}`}>
        <span className={keyClass} aria-hidden="true">
          {label}:
        </span>
        <span className={`${valClass} tppm-mono`}>{display}</span>
      </span>
    );
  }

  if (field.fieldType === 'NUMBER' && typeof value === 'number') {
    const display = value.toLocaleString('en-US');
    return (
      <span className="inline-flex items-center gap-1 text-xs" aria-label={`${label}: ${display}`}>
        <span className={keyClass} aria-hidden="true">
          {label}:
        </span>
        <span className={`${valClass} tppm-mono`}>{display}</span>
      </span>
    );
  }

  if (field.fieldType === 'USER' && isPerson(value)) {
    return <UserMark label={label} value={value} named={named} />;
  }

  return <TextMark label={label} value={value} />;
}

function isPerson(value: CustomFieldValue): value is CustomFieldPersonValue {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'initials' in value
  );
}

/** One `Label: value` row inside a peek popover (full field name + value treatment). */
function PeekRow({ field, value }: PopulatedField) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-neutral-text-secondary w-24 shrink-0">{field.name}</span>
      <span className="min-w-0">
        <FieldMark field={field} value={value} named />
      </span>
    </div>
  );
}

function PeekList({ items }: { items: PopulatedField[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-bold tracking-wide uppercase text-neutral-text-disabled">
        Custom fields
      </div>
      {items.map(({ field, value }) => (
        <PeekRow key={field.id} field={field} value={value} />
      ))}
    </div>
  );
}

/**
 * Comfortable / detailed custom-field row. Comfortable caps at 3 inline marks with the
 * rest behind a "+N more" peek; detailed shows all inline. Renders nothing when no
 * field is populated (no empty band, no placeholder). Sits below the assignees behind a
 * hairline so it reads as a quiet, secondary band.
 */
export function CustomFieldMarks({
  fields,
  values,
  density,
}: {
  fields: ProjectCustomField[];
  values: Record<string, CustomFieldValue> | undefined;
  density: 'comfortable' | 'detailed';
}) {
  const populated = populatedCardFields(fields, values);
  if (populated.length === 0) return null;

  const detailed = density === 'detailed';
  const cap = detailed ? populated.length : COMFORTABLE_INLINE_CAP;
  const inline = populated.slice(0, cap);
  const hidden = populated.slice(cap);

  return (
    <div className="mt-1.5 pt-1.5 border-t border-neutral-border flex items-center gap-x-3 gap-y-1 flex-wrap">
      {inline.map(({ field, value }) => (
        <FieldMark key={field.id} field={field} value={value} named={detailed} />
      ))}
      {hidden.length > 0 && (
        <CardPeekButton
          triggerContent={
            <span className="text-xs font-medium text-neutral-text-disabled">
              +{hidden.length} more
            </span>
          }
          ariaLabel={`${hidden.length} more custom field${hidden.length === 1 ? '' : 's'}`}
          peekAriaLabel="Custom fields"
        >
          <PeekList items={hidden} />
        </CardPeekButton>
      )}
    </div>
  );
}

/**
 * Compact-bar custom fields: zero inline marks, one trailing ⊕N button that peeks the
 * full list (web-rule 256 / #1924-#1925 glyph-only 36px bar). Renders nothing when no
 * field is populated.
 */
export function CustomFieldCompactPeek({
  fields,
  values,
}: {
  fields: ProjectCustomField[];
  values: Record<string, CustomFieldValue> | undefined;
}) {
  const populated = populatedCardFields(fields, values);
  if (populated.length === 0) return null;

  return (
    <span className="shrink-0">
      <CardPeekButton
        triggerContent={
          <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-neutral-text-secondary">
            <span aria-hidden="true">⊕</span>
            <span className="tppm-mono">{populated.length}</span>
          </span>
        }
        triggerClassName="px-1 py-px rounded-chip bg-neutral-surface-sunken border border-neutral-border"
        ariaLabel={`${populated.length} custom field${populated.length === 1 ? '' : 's'}`}
        peekAriaLabel="Custom fields"
      >
        <PeekList items={populated} />
      </CardPeekButton>
    </span>
  );
}
