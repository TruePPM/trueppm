import { useProjectTemplates, type ProjectTemplate } from '@/hooks/useProjectTemplates';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useRovingTabIndex } from '@/hooks/useRovingTabIndex';

/**
 * Tint per provenance tier (ADR-0789 §2).
 *
 * The chip is not decoration: who published a skeleton is the first thing a
 * delivery lead judges it by, and the design requires it to be legible *before*
 * adoption rather than discovered afterwards. Color is paired with the label text
 * — never the only carrier of the distinction — so the tiers stay distinguishable
 * to a colorblind reader and in a screenshot.
 */
const CHIP_CLASS: Record<string, string> = {
  Workspace: 'bg-brand-primary/10 text-brand-primary border-brand-primary/30',
  Community: 'bg-neutral-surface-raised text-neutral-text-secondary border-neutral-border',
  Yours: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/30',
};

export interface TemplateGalleryProps {
  /** Scopes the gallery; the server adds workspace-wide templates to a program's own. */
  programId?: string | null;
  /** Currently chosen template id, or null for "nothing chosen yet". */
  selectedId: string | null;
  onSelect: (template: ProjectTemplate) => void;
}

/**
 * The template list — the Start sheet's detail panel when "Template" is the chosen
 * way in (#2728, superseding #2729's nested gallery that also folded "Blank
 * project" in here). Blank is now a peer way-in card at the sheet's top level, so
 * this list holds only real templates; there is nothing to pick when it's empty,
 * unlike the old gallery where "Blank" was always a valid fallback selection here.
 *
 * Titled "Templates available to {you}" (the design's own detail-list pattern) —
 * naming the reader rather than a generic "Templates" heading, because provenance
 * (workspace-published vs. personal vs. shared) is about *this* reader's access,
 * not a static catalog.
 */
export function TemplateGallery({ programId, selectedId, onSelect }: TemplateGalleryProps) {
  const { data: templates, isLoading, isError } = useProjectTemplates(programId);
  const { user } = useCurrentUser();
  const rows = templates ?? [];
  const selectedIdx = rows.findIndex((t) => t.id === selectedId);
  const { focusIdx, itemRefs, onKeyDown } = useRovingTabIndex(rows.length, selectedIdx);

  const heading = (
    <h3 className="text-xs font-medium text-neutral-text-secondary">
      Templates available to {user?.display_name ?? 'you'}
    </h3>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <p role="status" className="text-xs text-neutral-text-secondary">
          Loading templates…
        </p>
      </div>
    );
  }

  // A failed gallery fetch must not block creating a project. Blank and Import stay
  // available as sibling way-in cards, so this degrades to "pick another way"
  // rather than an error that strands the user mid-flow.
  if (isError) {
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <p role="status" className="text-xs text-neutral-text-secondary">
          Couldn&rsquo;t load templates — try Blank or Import instead.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {heading}
      <div
        role="radiogroup"
        aria-label="Start from a template"
        // -1: the group container itself is never a Tab stop (roving tabindex
        // lives on the individual rows) — present only so the interactive
        // `radiogroup` role satisfies jsx-a11y's focusability check (matches
        // RiskSegmentedFilter's precedent, web-rule 167).
        tabIndex={-1}
        className="flex flex-col gap-2"
        onKeyDown={onKeyDown}
      >
        {rows.map((template, i) => (
          <TemplateOption
            key={template.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            tabIndex={i === focusIdx ? 0 : -1}
            label={template.name}
            detail={
              template.description ||
              `${template.task_count} row${template.task_count === 1 ? '' : 's'}`
            }
            chip={template.provenance}
            taskCount={template.task_count}
            carries={template.carries}
            selected={selectedId === template.id}
            onSelect={() => onSelect(template)}
          />
        ))}
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-neutral-text-secondary">
          No templates yet. Publish one from a project&rsquo;s Settings to reuse its shape, or
          start from Blank or Import instead.
        </p>
      )}
    </div>
  );
}

function TemplateOption({
  ref,
  label,
  detail,
  chip,
  taskCount,
  carries,
  selected,
  tabIndex,
  onSelect,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  label: string;
  detail: string;
  chip?: string;
  taskCount?: number;
  carries?: string[];
  selected: boolean;
  tabIndex: 0 | -1;
  onSelect: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      onClick={onSelect}
      className={`flex flex-col gap-1 rounded-card border p-3 text-left transition
        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
        ${
          selected
            ? 'border-brand-primary bg-brand-primary/5'
            : 'border-neutral-border hover:border-brand-primary/50'
        }`}
    >
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium text-neutral-text-primary">{label}</span>
        {chip && (
          <span
            className={`inline-flex items-center rounded-chip border px-1.5 py-0.5 text-xs font-medium ${
              CHIP_CLASS[chip] ?? CHIP_CLASS.Community
            }`}
          >
            {chip}
          </span>
        )}
        {typeof taskCount === 'number' && (
          <span className="text-xs text-neutral-text-secondary">
            {taskCount} row{taskCount === 1 ? '' : 's'}
          </span>
        )}
      </span>
      <span className="text-xs text-neutral-text-secondary">{detail}</span>
      {carries && carries.length > 0 && (
        // What the template carries, stated before adoption. The complement is the
        // part that actually reassures: a template never brings owners, dates, or
        // anyone else's progress, so adopting one cannot import somebody else's
        // moment into your plan.
        <span className="text-xs text-neutral-text-secondary">
          Carries {carries.join(', ')} — never owners, dates, or progress.
        </span>
      )}
    </button>
  );
}
