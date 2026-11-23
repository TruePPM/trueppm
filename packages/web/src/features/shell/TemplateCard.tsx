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
import { useId, useState } from 'react';
import { ChevronRightIcon } from '@/components/Icons';
import {
  useProjectTemplateOutline,
  type ProjectTemplate,
  type TemplateCounts,
  type TemplateOutlineItem,
} from '@/hooks/useProjectTemplates';

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
      template.description || `${template.task_count} row${template.task_count === 1 ? '' : 's'}`,
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

/** Indent per WBS level, capped so a deep outline cannot push names out of the card. */
const DEPTH_CLASS = ['pl-0', 'pl-3', 'pl-6', 'pl-9'];

/** The suffix that names a row's kind. A plain task carries none. */
const KIND_LABEL: Record<TemplateOutlineItem['kind'], string> = {
  phase: 'phase',
  gate: 'gate',
  milestone: 'milestone',
  task: '',
};

/**
 * "Show the N row names" — the template's phase, gate and task names, in WBS
 * order, before anyone presses Apply (#3084).
 *
 * A delivery manager choosing a stage-gate skeleton is judging its *language* —
 * whether "Gate 2 — approved to execute" is what her steering committee already
 * calls that hold point — and the counts line cannot answer that. The names come
 * from the server's own read of the frozen document `apply` writes from, so the
 * list cannot disagree with what lands on the Schedule.
 *
 * A sibling of `TemplateCardBody`, never a child of it: the body renders inside the
 * gallery's `role="radio"` button, a button may not contain another interactive
 * control, and a list inside it would be flattened into the radio's accessible
 * name. Collapsed by default so it does not compete with the counts line, and the
 * names are fetched only when it is first opened.
 *
 * `tabIndex` follows the gallery's roving index, so only the focused card's toggle
 * is a Tab stop: Tab moves from a card to its own toggle and then out of the list,
 * rather than through one toggle per template.
 */
export function TemplateOutlineDisclosure({
  templateId,
  templateName,
  rowCount,
  tabIndex = 0,
}: {
  templateId: string;
  templateName: string;
  rowCount: number;
  tabIndex?: 0 | -1;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const { data, isLoading, isError } = useProjectTemplateOutline(templateId, open);
  if (rowCount === 0) return null;
  const noun = `row name${rowCount === 1 ? '' : 's'}`;

  return (
    <div className="border-t border-neutral-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        tabIndex={tabIndex}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-1.5 px-3 text-left text-xs font-medium text-brand-primary
                   hover:bg-neutral-surface-raised
                   focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {open ? `Hide the ${rowCount} ${noun}` : `Show the ${rowCount} ${noun}`}
      </button>
      <div id={regionId} hidden={!open} className="px-3 pb-3">
        {open && isLoading && (
          <p role="status" className="text-xs text-neutral-text-secondary">
            Loading row names…
          </p>
        )}
        {open && isError && (
          // Not an alert: the counts above still describe the template, and
          // choosing it remains safe — only the preview of its names is missing.
          <p role="status" className="text-xs text-neutral-text-secondary">
            Couldn&rsquo;t load the row names. The counts above still describe what this template
            writes.
          </p>
        )}
        {open && data && (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focusable scroll region (tabIndex); the handler only stops key bubbling
          <ol
            aria-label={`Rows ${templateName} writes`}
            // Scrolls past ~12 rows, and a scroll region a keyboard cannot reach
            // is unreadable past its fold (WCAG 2.1.1): focusable, on the same
            // roving stop as the toggle that opened it.
            tabIndex={tabIndex}
            // The gallery's radiogroup roves on these keys and preventDefaults
            // them for any target; stop them here so the arrows scroll the list.
            onKeyDown={(e) => {
              if (
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
              ) {
                e.stopPropagation();
              }
            }}
            className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-control text-xs
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            {data.map((row, i) => (
              <li
                // Names repeat ("Review" under two phases), so position is the key.
                key={i}
                className={`${DEPTH_CLASS[Math.min(row.depth, DEPTH_CLASS.length - 1)]} ${
                  row.kind === 'phase'
                    ? 'font-medium text-neutral-text-primary'
                    : 'text-neutral-text-primary'
                }`}
              >
                {row.name}
                {KIND_LABEL[row.kind] && (
                  <span className="text-neutral-text-secondary"> · {KIND_LABEL[row.kind]}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
