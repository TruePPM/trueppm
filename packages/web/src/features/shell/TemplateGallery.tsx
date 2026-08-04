import { useProjectTemplates, type ProjectTemplate } from '@/hooks/useProjectTemplates';

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
  Yours: 'bg-semantic-success/10 text-semantic-success border-semantic-success/30',
};

export interface TemplateGalleryProps {
  /** Scopes the gallery; the server adds workspace-wide templates to a program's own. */
  programId?: string | null;
  /** Currently chosen template id, or null for "blank project". */
  selectedId: string | null;
  onSelect: (template: ProjectTemplate | null) => void;
}

/**
 * The template gallery for the Start sheet (#2729).
 *
 * Renders "Blank project" as a first-class, *selected-by-default* option rather
 * than an escape hatch. A gallery that only offers templates makes starting from
 * nothing feel like a mistake, and the design's own working assumption is that
 * teams delete most of what a template writes — so the blank path has to stay
 * obviously legitimate.
 */
export function TemplateGallery({ programId, selectedId, onSelect }: TemplateGalleryProps) {
  const { data: templates, isLoading, isError } = useProjectTemplates(programId);

  if (isLoading) {
    return (
      <p role="status" className="text-xs text-neutral-text-secondary">
        Loading templates…
      </p>
    );
  }

  // A failed gallery fetch must not block creating a project. The blank path is
  // always available, so this degrades to "you can still start" rather than an
  // error that strands the user mid-flow.
  if (isError) {
    return (
      <p role="status" className="text-xs text-neutral-text-secondary">
        Couldn&rsquo;t load templates — you can still start from a blank project.
      </p>
    );
  }

  const rows = templates ?? [];

  return (
    <div
      role="radiogroup"
      aria-label="Start from a template"
      className="flex flex-col gap-2"
    >
      <TemplateOption
        label="Blank project"
        detail="Start with an empty outline."
        selected={selectedId === null}
        onSelect={() => onSelect(null)}
      />
      {rows.map((template) => (
        <TemplateOption
          key={template.id}
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
      {rows.length === 0 && (
        <p className="text-xs text-neutral-text-secondary">
          No templates yet. Publish one from a project&rsquo;s Settings to reuse its shape.
        </p>
      )}
    </div>
  );
}

function TemplateOption({
  label,
  detail,
  chip,
  taskCount,
  carries,
  selected,
  onSelect,
}: {
  label: string;
  detail: string;
  chip?: string;
  taskCount?: number;
  carries?: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
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
