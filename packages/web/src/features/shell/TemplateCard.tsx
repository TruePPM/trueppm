/**
 * The gallery card, and the *only* definition of it (#2970).
 *
 * A publisher's last question before pressing Publish is "what will a delivery
 * lead see when they choose between this and the four shapes already there" —
 * and the honest way to answer it is to show them the same card, not a mock-up
 * of it. So the card body and the two derived lines live here, and both the
 * gallery's radio option and the publish sheet's preview render this component.
 *
 * That is the point rather than a tidiness preference: a hand-built preview is
 * correct on the day it is written and silently wrong the first time the real
 * card gains a chip. This is the same "there is only one" discipline rule 306
 * applies to escapers, on a surface where drift is cosmetic rather than unsafe
 * but no less invisible.
 */
import type { ProjectTemplate, TemplateCounts } from '@/hooks/useProjectTemplates';

/**
 * Tint per provenance tier (ADR-0789 §2).
 *
 * The chip is not decoration: who published a skeleton is the first thing a
 * delivery lead judges it by, and the design requires it to be legible *before*
 * adoption rather than discovered afterwards. Color is paired with the label text
 * — never the only carrier of the distinction — so the tiers stay distinguishable
 * to a colorblind reader and in a screenshot.
 */
export const CHIP_CLASS: Record<string, string> = {
  Workspace: 'bg-brand-primary/10 text-brand-primary border-brand-primary/30',
  Community: 'bg-neutral-surface-raised text-neutral-text-secondary border-neutral-border',
  Yours: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/30',
};

/**
 * The one-line "what this brings" summary under a template's description.
 *
 * Derived from the server's own counts rather than a hard-coded list of classes.
 * The handoff's inventory copy names six carried classes; hard-coding those here
 * would be a second definition of what a template carries, free to drift from
 * the one in `extract_structure` that actually decides it.
 *
 * Takes counts rather than a template so the publish preview — which has counts
 * from the dry run but no template yet — produces the identical string.
 */
export function carriesLine(counts?: TemplateCounts | null): string {
  if (!counts) return '';
  const parts = [
    counts.phase_count > 0 && `${counts.phase_count} phase${counts.phase_count === 1 ? '' : 's'}`,
    counts.gate_count > 0 && `${counts.gate_count} gate${counts.gate_count === 1 ? '' : 's'}`,
    counts.dependency_count > 0 &&
      `${counts.dependency_count} dep${counts.dependency_count === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? `carries ${parts.join(' · ')}` : '';
}

/** Version and adoption, the PMO's house-standard signal. '' when neither applies. */
export function usageLine(args: {
  version: number;
  usageCount?: number;
  sourceKind?: ProjectTemplate['source_kind'];
}): string {
  const used = args.usageCount ?? 0;
  const version = `v${args.version}`;
  if (used === 0) return args.sourceKind === 'community' ? `bundled ${version}` : version;
  return `${version} · ${used} project${used === 1 ? '' : 's'}`;
}

export interface TemplateCardFields {
  label: string;
  detail: string;
  chip?: string;
  /** Groups the list, and predicts where an adopting project will land. */
  methodology?: string;
  taskCount?: number;
  carries?: string[];
  /** "carries 6 phases · 4 gates · 14 deps", from the server's own counts. */
  carriesLine?: string;
  /** "v2 · 9 projects" — the PMO's house-standard signal. */
  usageLine?: string;
  superseded?: boolean;
}

/** Everything the card shows about a published template, in one place. */
export function templateCardFields(template: ProjectTemplate): TemplateCardFields {
  return {
    label: template.name,
    detail:
      template.description ||
      `${template.task_count} row${template.task_count === 1 ? '' : 's'}`,
    chip: template.provenance,
    methodology: template.methodology,
    taskCount: template.task_count,
    carries: template.carries,
    carriesLine: carriesLine(template.counts),
    usageLine: usageLine({
      version: template.version,
      usageCount: template.usage_count,
      sourceKind: template.source_kind,
    }),
    superseded: Boolean(template.is_superseded),
  };
}

/**
 * The card's contents, with no interactive wrapper of its own.
 *
 * Rendered inside the gallery's `role="radio"` button, and inside the publish
 * sheet's inert preview. Keeping the wrapper out means the preview cannot
 * accidentally become a focus stop advertising a choice nobody can make.
 */
export function TemplateCardBody({
  label,
  detail,
  chip,
  methodology,
  taskCount,
  carries,
  carriesLine: carriesText,
  usageLine: usageText,
  superseded,
}: TemplateCardFields) {
  return (
    <>
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
        {methodology && (
          // The methodology chip does double duty: it groups the list, and it
          // predicts the landing surface (an AGILE template opens on a seeded
          // Product Backlog, not an empty Schedule).
          <span className="inline-flex items-center rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs font-medium text-neutral-text-secondary">
            {methodology}
          </span>
        )}
        {superseded && (
          // Still selectable on purpose — projects already created from it are
          // why it has to stay legible.
          <span className="text-xs text-neutral-text-secondary">superseded</span>
        )}
        {typeof taskCount === 'number' && (
          <span className="ml-auto text-xs text-neutral-text-secondary">
            {taskCount} row{taskCount === 1 ? '' : 's'}
            {usageText ? ` · ${usageText}` : ''}
          </span>
        )}
      </span>
      <span className="text-xs text-neutral-text-secondary">{detail}</span>
      {(carriesText || (carries && carries.length > 0)) && (
        // What the template carries, stated before adoption. The complement is the
        // part that actually reassures: a template never brings owners, dates, or
        // anyone else's progress, so adopting one cannot import somebody else's
        // moment into your plan.
        <span className="text-xs text-neutral-text-secondary">
          {carriesText || `Carries ${(carries ?? []).join(', ')}`} — never owners, dates, or
          progress.
        </span>
      )}
    </>
  );
}

/** The card's own box, shared so the preview matches the gallery's geometry. */
export const TEMPLATE_CARD_CLASS = 'flex flex-col gap-1 rounded-card border p-3 text-left';
