import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useProjectTemplates, type ProjectTemplate } from '@/hooks/useProjectTemplates';
import type { ProgramMethodology } from '@/api/types';
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

/**
 * How much apparatus surrounds the list, by count (#2909, handoff case 04).
 *
 * Named constants rather than inline numbers because "when does search appear"
 * is a design decision recorded in the handoff, not a judgement call at build
 * time — and the gallery's tests assert against these, so moving a threshold
 * moves the tests with it.
 */
export const FILTER_CHIPS_FROM = 5;
export const SEARCH_AND_GROUPS_FROM = 12;

const METHODOLOGY_ORDER: ProgramMethodology[] = ['AGILE', 'WATERFALL', 'HYBRID'];
const METHODOLOGY_LABEL: Record<string, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

/** Does this row match a free-text query? Name and description, case-insensitive. */
function matches(template: ProjectTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    template.name.toLowerCase().includes(q) ||
    (template.description ?? '').toLowerCase().includes(q)
  );
}

/**
 * The one-line "what this brings" summary under a template's description.
 *
 * Derived from the server's own counts rather than a hard-coded list of classes.
 * The handoff's inventory copy names six carried classes; hard-coding those here
 * would be a second definition of what a template carries, free to drift from
 * the one in `extract_structure` that actually decides it.
 */
function carriesSummary(template: ProjectTemplate): string {
  const c = template.counts;
  if (!c) return '';
  const parts = [
    c.phase_count > 0 && `${c.phase_count} phase${c.phase_count === 1 ? '' : 's'}`,
    c.gate_count > 0 && `${c.gate_count} gate${c.gate_count === 1 ? '' : 's'}`,
    c.dependency_count > 0 && `${c.dependency_count} dep${c.dependency_count === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? `carries ${parts.join(' · ')}` : '';
}

/** Version and adoption, the PMO's house-standard signal. '' when neither applies. */
function usageSummary(template: ProjectTemplate): string {
  const used = template.usage_count ?? 0;
  const version = `v${template.version}`;
  if (used === 0) return template.source_kind === 'community' ? `bundled ${version}` : version;
  return `${version} · ${used} project${used === 1 ? '' : 's'}`;
}

export interface TemplateGalleryProps {
  /** Scopes the gallery; the server adds workspace-wide templates to a program's own. */
  programId?: string | null;
  /** Currently chosen template id, or null for "nothing chosen yet". */
  selectedId: string | null;
  onSelect: (template: ProjectTemplate) => void;
  /**
   * A project the reader could publish from, if we know of one.
   *
   * Decides which empty state they get: naming a route they can walk, or naming
   * the path in prose. The old copy was the second case written for the first,
   * which is why it read as a dead end — it named a screen that did not exist.
   */
  publishFrom?: { id: string; name: string } | null;
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
export function TemplateGallery({
  programId,
  selectedId,
  onSelect,
  publishFrom = null,
}: TemplateGalleryProps) {
  const { data: templates, isLoading, isError } = useProjectTemplates(programId);
  const { user } = useCurrentUser();
  const all = useMemo(() => templates ?? [], [templates]);
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<string>('all');

  // Apparatus by count, not by preference (handoff case 04 annot 1).
  const showChips = all.length >= FILTER_CHIPS_FROM;
  const showSearch = all.length >= SEARCH_AND_GROUPS_FROM;
  const showGroups = showSearch;

  const rows = useMemo(
    () =>
      all.filter((t) => {
        if (!matches(t, showSearch ? query : '')) return false;
        if (facet === 'all') return true;
        if (facet === 'bundled') return t.source_kind === 'community';
        if (facet === 'local') return t.source_kind !== 'community';
        return t.methodology === facet;
      }),
    [all, query, facet, showSearch],
  );

  // Groups are a presentation layer over one flat radio list: arrow keys move
  // across group boundaries and headers are never focus stops, so the roving
  // index stays keyed to `rows` and not to any per-group array.
  const groups = useMemo(() => {
    if (!showGroups) return [{ label: '', items: rows }];
    return METHODOLOGY_ORDER.map((m) => ({
      label: METHODOLOGY_LABEL[m],
      items: rows.filter((t) => t.methodology === m),
    })).filter((g) => g.items.length > 0);
  }, [rows, showGroups]);

  const selectedIdx = rows.findIndex((t) => t.id === selectedId);
  const { focusIdx, itemRefs, onKeyDown } = useRovingTabIndex(rows.length, selectedIdx);

  const heading = (
    <h3 className="text-xs font-medium text-neutral-text-secondary">
      Templates available to {user?.display_name ?? 'you'}
    </h3>
  );

  if (isLoading) {
    // Skeleton rows in the shape of a TemplateOption, never a centred spinner:
    // this list's height sets the sheet's layout, and a spinner makes the whole
    // sheet jump when data lands.
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <p role="status" className="sr-only">
          Loading templates…
        </p>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="flex flex-col gap-2 rounded-card border border-neutral-border p-3"
          >
            <span className="h-3 w-2/5 rounded bg-neutral-surface-sunken" />
            <span className="h-3 w-4/5 rounded bg-neutral-surface-sunken" />
          </div>
        ))}
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
          Couldn&rsquo;t load templates. <strong>Blank</strong> and <strong>Import</strong> still
          work — this is a template-list problem, not a project-creation problem.
        </p>
      </div>
    );
  }

  // Nothing has ever been published AND nothing ships — the state the ticket
  // was filed about. Distinct from "your search matched nothing" below.
  if (all.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <div className="rounded-card border border-neutral-border p-4">
          <p className="text-sm font-medium text-neutral-text-primary">No templates yet</p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-text-secondary">
            A template is a project&rsquo;s shape — its phases, tasks and dependencies — with the
            dates, people and history stripped out. You publish one from a project you already
            run.
          </p>
          {/* The empty state names a screen that now exists (#2909). It used to
              point at "a project's Settings" when no such page had been built,
              which is why it read as a dead end. */}
          {publishFrom ? (
            <Link
              to={`/projects/${publishFrom.id}/settings/templates`}
              className="mt-3 inline-flex h-11 items-center rounded-control border border-neutral-border px-3
                         text-sm font-medium text-brand-primary hover:bg-neutral-surface-raised
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Publish from {publishFrom.name}…
            </Link>
          ) : (
            <p className="mt-3 text-xs text-neutral-text-secondary">
              Templates are published from a project&rsquo;s{' '}
              <strong>Settings → Templates</strong>, by anyone with Project Manager role on it.
            </p>
          )}
          <p className="mt-3 text-xs text-neutral-text-secondary">
            <strong>Blank</strong> and <strong>Import</strong> are ready to use now.
          </p>
        </div>
      </div>
    );
  }

  const facets: { key: string; label: string }[] = [
    { key: 'all', label: `All ${all.length}` },
    ...METHODOLOGY_ORDER.map((m) => ({
      key: m,
      label: `${METHODOLOGY_LABEL[m]} ${all.filter((t) => t.methodology === m).length}`,
    })).filter((f) => !f.label.endsWith(' 0')),
    { key: 'local', label: `Published here ${all.filter((t) => t.source_kind !== 'community').length}` },
    { key: 'bundled', label: `Bundled ${all.filter((t) => t.source_kind === 'community').length}` },
  ];

  let index = -1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <span className="text-xs text-neutral-text-secondary">
          {all.length} available
        </span>
        {showSearch && (
          <label className="ml-auto flex items-center gap-1.5 text-xs">
            <span className="sr-only">Search templates</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              className="h-9 w-40 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs
                         focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            />
          </label>
        )}
      </div>

      {showChips && (
        <div className="flex flex-wrap gap-1.5">
          {facets.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={facet === f.key}
              onClick={() => setFacet(f.key)}
              className={`rounded-chip border px-2 py-1 text-xs font-medium transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                ${
                  facet === f.key
                    ? 'border-brand-primary bg-brand-primary text-neutral-text-inverse'
                    : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div
        role="radiogroup"
        aria-label="Start from a template"
        // -1: the group container itself is never a Tab stop (roving tabindex
        // lives on the individual rows) — present only so the interactive
        // `radiogroup` role satisfies jsx-a11y's focusability check (matches
        // RiskSegmentedFilter's precedent, web-rule 167).
        tabIndex={-1}
        className={`flex flex-col gap-2 ${showGroups ? 'max-h-[21rem] overflow-y-auto' : ''}`}
        onKeyDown={onKeyDown}
      >
        {groups.map((group) => (
          <div key={group.label || 'all'} className="flex flex-col gap-2">
            {group.label && (
              // Not a focus stop: arrows move across group boundaries, so a
              // header in the tab order would interrupt a single radio group.
              <p className="sticky top-0 z-[1] bg-neutral-surface py-1 text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
                {group.label} <span className="font-normal">({group.items.length})</span>
              </p>
            )}
            {group.items.map((template) => {
              index += 1;
              const i = index;
              return (
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
                  methodology={template.methodology}
                  taskCount={template.task_count}
                  carries={template.carries}
                  carriesLine={carriesSummary(template)}
                  usageLine={usageSummary(template)}
                  superseded={Boolean(template.is_superseded)}
                  selected={selectedId === template.id}
                  onSelect={() => onSelect(template)}
                />
              );
            })}
          </div>
        ))}
      </div>

      {rows.length === 0 && (
        // A filtered-to-nothing list keeps the chips and says how many exist —
        // otherwise it is indistinguishable from the never-published empty state
        // above, which offers a completely different remedy.
        <p role="status" className="text-xs text-neutral-text-secondary">
          No templates match{query.trim() ? ` “${query.trim()}”` : ' this filter'} —{' '}
          {all.length} available.
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
  methodology,
  taskCount,
  carries,
  carriesLine,
  usageLine,
  superseded,
  selected,
  tabIndex,
  onSelect,
}: {
  ref: (el: HTMLButtonElement | null) => void;
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
            {usageLine ? ` · ${usageLine}` : ''}
          </span>
        )}
      </span>
      <span className="text-xs text-neutral-text-secondary">{detail}</span>
      {(carriesLine || (carries && carries.length > 0)) && (
        // What the template carries, stated before adoption. The complement is the
        // part that actually reassures: a template never brings owners, dates, or
        // anyone else's progress, so adopting one cannot import somebody else's
        // moment into your plan.
        <span className="text-xs text-neutral-text-secondary">
          {carriesLine || `Carries ${(carries ?? []).join(', ')}`} — never owners, dates, or
          progress.
        </span>
      )}
    </button>
  );
}
