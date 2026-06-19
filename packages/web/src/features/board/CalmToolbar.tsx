/**
 * CalmToolbar — board toolbar surface refactor (issue #382, epic #361 child B).
 *
 * Collapses the prior 14-control row into:
 *   - Identity block (project name + activity stats)
 *   - Primary chips (Group / Sort / Density popovers)
 *   - Quiet pill toggles (My tasks / At-risk / Cost)
 *   - Layout segmented control (Rail · Drawer · Queue)
 *   - More⋯ overflow popover (Collapse / Expand / WIP / Tints / EVM / Columns / ? / Workshop)
 *
 * No behaviour changes: every control delegates to the same setters previously
 * wired in BoardView.tsx. Sibling MRs #383 (drawer) and #384 (queue) will plug
 * their layout components into the rail/drawer/queue selector wired here.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { BoardSortKey } from '@/hooks/useBoardSavedViews';
import type { BoardDensity, EvmMode } from './BoardCard';
import type { BoardLayoutVariant, BacklogDensity, BoardZoom } from '@/hooks/useBoardToolbarPrefs';
import { BoardViewDropdown } from './BoardViewDropdown';
import { BoardSprintSwitcher } from './BoardSprintSwitcher';
import { BoardSearchControl } from './BoardSearchControl';
import { BoardZoomControl } from './BoardZoomControl';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';
import type { ApiSprint } from '@/types';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ToolbarOverflowMenu,
  type ToolbarOverflowItem,
} from '@/components/toolbar/ToolbarOverflowMenu';

// ---------------------------------------------------------------------------
// Reusable atoms
// ---------------------------------------------------------------------------

interface ToolbarChipProps {
  label: string;
  value: string;
  ariaLabel: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Anchor edge for the popover. 'right' keeps the rightmost chip inside the viewport. */
  align?: 'left' | 'right';
}

/** Primary toolbar chip — rounded-full pill that opens a popover. */
export function ToolbarChip({
  label,
  value,
  ariaLabel,
  isOpen,
  onToggle,
  children,
  align = 'left',
}: ToolbarChipProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Click outside closes the popover. Pointerdown on the button is excluded so
  // the toggle flow (open → click button again) works without a double-fire.
  useEffect(() => {
    if (!isOpen) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      onToggle();
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [isOpen, onToggle]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        className={[
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs',
          'border border-neutral-border text-neutral-text-primary',
          'hover:bg-neutral-surface-raised',
          'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          'focus-visible:outline-none',
          isOpen ? 'bg-neutral-surface-raised' : 'bg-neutral-surface',
        ].join(' ')}
      >
        <span className="text-neutral-text-secondary">{label}:</span>
        <span className="font-medium">{value}</span>
        <span aria-hidden="true" className="text-neutral-text-disabled">
          ▾
        </span>
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={ariaLabel}
          className={[
            'absolute top-full z-20 mt-1 min-w-[220px] rounded-md border border-neutral-border bg-neutral-surface p-2',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface ToolbarToggleProps {
  icon: string;
  label: string;
  ariaLabel?: string;
  pressed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
  /** Per #568 rule 114 — render icon-only when `true`; keep the full label
   *  text on `aria-label`/`title`. Used by the `md:` tier (rule 111). */
  hideLabel?: boolean;
}

/** Quiet pill toggle — borderless at rest, sunken-fill when active. */
export function ToolbarToggle({
  icon,
  label,
  ariaLabel,
  pressed,
  onToggle,
  disabled,
  title,
  hideLabel = false,
}: ToolbarToggleProps) {
  const effectiveAriaLabel = ariaLabel ?? label;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      aria-label={effectiveAriaLabel}
      disabled={disabled}
      title={hideLabel ? effectiveAriaLabel : title}
      className={[
        'inline-flex items-center rounded-full text-xs',
        hideLabel ? 'justify-center w-7 h-7' : 'gap-1 px-2.5 py-1',
        'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        'focus-visible:outline-none',
        'disabled:opacity-50 disabled:cursor-wait',
        pressed
          ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
          : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
      ].join(' ')}
    >
      <span aria-hidden="true">{icon}</span>
      {!hideLabel && label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout segmented control
// ---------------------------------------------------------------------------

interface LayoutSwitcherProps {
  layout: BoardLayoutVariant;
  onChange: (layout: BoardLayoutVariant) => void;
}

const LAYOUTS: ReadonlyArray<{ id: BoardLayoutVariant; label: string }> = [
  { id: 'rail', label: 'Rail' },
  { id: 'drawer', label: 'Drawer' },
  { id: 'queue', label: 'Queue' },
];

/** Three-way segmented control for backlog layout variants.
 *  All three persist; rail is the only rendered variant until #383/#384 land. */
export function LayoutSwitcher({ layout, onChange }: LayoutSwitcherProps) {
  return (
    <div
      role="group"
      aria-label="Backlog layout"
      className="inline-flex rounded-full border border-neutral-border bg-neutral-surface p-0.5"
    >
      {LAYOUTS.map(({ id, label }) => {
        const active = layout === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={[
              'rounded-full px-2.5 py-0.5 text-xs',
              'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              'focus-visible:outline-none',
              active
                ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
                : 'text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalmToolbar
// ---------------------------------------------------------------------------

export interface CalmToolbarProps {
  // Identity
  projectId: string;
  projectName?: string;
  activeCount: number;
  backlogCount: number;
  // Card search (#323) — query is mirrored to ?q= by BoardView; the dim set is
  // applied there. The control is keyboard-focused via `/` (searchInputRef).
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchMatchCount: number;
  isSearching: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  // Saved views
  currentViewConfig: BoardViewConfig;
  activeViewId: string | null;
  onApplyView: (cfg: Partial<BoardViewConfig>, viewId: string | null) => void;
  // Sprint view (#429) — scope the phase columns to a single sprint vs the
  // whole project. Distinct axis from saved views.
  sprints: ApiSprint[];
  selectedSprintId: string | null;
  onSelectSprint: (id: string | null) => void;
  // Group (single option for now — chip kept for future grouping modes)
  groupBy: string;
  // Sort
  sort: BoardSortKey;
  onSortChange: (s: BoardSortKey) => void;
  // Board card density (existing)
  density: BoardDensity;
  onDensityChange: (d: BoardDensity) => void;
  // Board-local zoom (#379) — independent spacing axis from Density.
  zoom: BoardZoom;
  onZoomChange: (z: BoardZoom) => void;
  // Backlog density (new — persisted via useBoardToolbarPrefs)
  backlogDensity: BacklogDensity;
  onBacklogDensityChange: (d: BacklogDensity) => void;
  // Layout switcher (new)
  layout: BoardLayoutVariant;
  onLayoutChange: (l: BoardLayoutVariant) => void;
  // Toggles
  myTasksEnabled: boolean;
  myTasksLoading: boolean;
  onMyTasksToggle: () => void;
  riskLinkedOnly: boolean;
  onRiskLinkedToggle: () => void;
  debtOnly: boolean;
  onDebtOnlyToggle: () => void;
  showCost: boolean;
  onShowCostToggle: () => void;
  // More⋯ controls
  onCollapseAll: () => void;
  onExpandAll: () => void;
  showWip: boolean;
  onShowWipToggle: () => void;
  showColTints: boolean;
  onShowColTintsToggle: () => void;
  evmMode: EvmMode;
  onEvmChange: (m: EvmMode) => void;
  onOpenColumns: () => void;
  onOpenCheatsheet: () => void;
  workshopMode: boolean;
  onWorkshopToggle: () => void;
  workshopDisabled: boolean;
  workshopButtonRef: RefObject<HTMLButtonElement | null>;
}

const SORT_LABELS: Record<BoardSortKey, string> = {
  priority: 'Priority',
  start_date: 'Start date',
  percent_complete: '% complete',
};

const DENSITY_LABELS: Record<BoardDensity, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  detailed: 'Detailed',
};

const BACKLOG_DENSITY_LABELS: Record<BacklogDensity, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  full: 'Full',
};

const EVM_LABELS: Record<EvmMode, string> = {
  off: 'Off',
  spi: 'SPI',
  cpi: 'CPI',
  both: 'Both',
};

export function CalmToolbar(props: CalmToolbarProps) {
  const [openChip, setOpenChip] = useState<'group' | 'sort' | 'density' | 'more' | null>(null);
  const toggle = (chip: typeof openChip) => setOpenChip((prev) => (prev === chip ? null : chip));

  // #568 rules 110–112: My tasks / At-risk / Cost are secondary. Icon-only at
  // md, collapse into ToolbarOverflowMenu at sm. Group / Sort / Density and
  // LayoutSwitcher remain visible at every width.
  const breakpoint = useBreakpoint();
  const hideQuietToggleLabels = breakpoint === 'md';
  const showQuietTogglesInline = breakpoint !== 'sm';

  return (
    <div
      role="toolbar"
      aria-label="Board toolbar"
      className="flex-shrink-0 border-b border-neutral-border bg-neutral-surface px-4 h-10 flex flex-nowrap items-center gap-3 text-xs"
    >
      {/* Identity block — project name truncates and activity stats hide
          below lg to keep the toolbar inside its h-10 row at md (#568 rule 113).
          Block is flex-shrink-0 so the name never collapses to zero width when
          the toolbar is crowded; secondary controls (toggles, overflow) absorb
          the space pressure instead. */}
      <div className="flex flex-shrink-0 items-center gap-2">
        <BoardViewDropdown
          projectId={props.projectId}
          currentConfig={props.currentViewConfig}
          activeViewId={props.activeViewId}
          onApply={props.onApplyView}
        />
        <BoardSprintSwitcher
          sprints={props.sprints}
          selectedSprintId={props.selectedSprintId}
          onSelectSprint={props.onSelectSprint}
        />
        {props.projectName && (
          <span className="text-neutral-text-primary font-medium truncate max-w-[160px]">
            {props.projectName}
          </span>
        )}
        <span className="hidden lg:inline text-neutral-text-secondary tppm-mono whitespace-nowrap">
          {props.activeCount} active · {props.backlogCount} in backlog
        </span>
      </div>

      <span aria-hidden="true" className="h-4 w-px bg-neutral-border" />

      {/* Card search (#323) — leads the primary controls. */}
      <BoardSearchControl
        value={props.searchQuery}
        onChange={props.onSearchQueryChange}
        matchCount={props.searchMatchCount}
        isSearching={props.isSearching}
        inputRef={props.searchInputRef}
      />

      <span aria-hidden="true" className="h-4 w-px bg-neutral-border" />

      {/* Primary chips */}
      <ToolbarChip
        label="Group"
        value={props.groupBy}
        ariaLabel="Group lanes by"
        isOpen={openChip === 'group'}
        onToggle={() => toggle('group')}
      >
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-xs bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary"
            disabled
          >
            Phase (WBS rollup)
          </button>
          <p className="px-2 py-1 text-xs text-neutral-text-secondary">
            More grouping modes coming in a later release.
          </p>
        </div>
      </ToolbarChip>

      <ToolbarChip
        label="Sort"
        value={SORT_LABELS[props.sort]}
        ariaLabel="Sort tasks by"
        isOpen={openChip === 'sort'}
        onToggle={() => toggle('sort')}
      >
        <div role="radiogroup" aria-label="Sort tasks by" className="flex flex-col gap-0.5">
          {(Object.keys(SORT_LABELS) as BoardSortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={props.sort === key}
              onClick={() => {
                props.onSortChange(key);
                setOpenChip(null);
              }}
              className={[
                'rounded px-2 py-1 text-left text-xs',
                'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                props.sort === key
                  ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
                  : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              {SORT_LABELS[key]}
            </button>
          ))}
        </div>
      </ToolbarChip>

      <ToolbarChip
        label="Density"
        value={DENSITY_LABELS[props.density]}
        ariaLabel="Card density"
        isOpen={openChip === 'density'}
        onToggle={() => toggle('density')}
      >
        <div className="flex flex-col gap-2">
          <fieldset className="flex flex-col gap-0.5">
            <legend className="px-2 py-1 text-xs font-semibold text-neutral-text-secondary uppercase tracking-wide">
              Board cards
            </legend>
            {(Object.keys(DENSITY_LABELS) as BoardDensity[]).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={props.density === key}
                aria-label={`Board card density: ${DENSITY_LABELS[key]}`}
                onClick={() => props.onDensityChange(key)}
                className={[
                  'rounded px-2 py-1 text-left text-xs',
                  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                  props.density === key
                    ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
                    : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
                ].join(' ')}
              >
                {DENSITY_LABELS[key]}
              </button>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-0.5 border-t border-neutral-border pt-2">
            <legend className="px-2 py-1 text-xs font-semibold text-neutral-text-secondary uppercase tracking-wide">
              Backlog cards
            </legend>
            {(Object.keys(BACKLOG_DENSITY_LABELS) as BacklogDensity[]).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={props.backlogDensity === key}
                aria-label={`Backlog card density: ${BACKLOG_DENSITY_LABELS[key]}`}
                onClick={() => props.onBacklogDensityChange(key)}
                className={[
                  'rounded px-2 py-1 text-left text-xs',
                  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                  props.backlogDensity === key
                    ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
                    : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
                ].join(' ')}
              >
                {BACKLOG_DENSITY_LABELS[key]}
              </button>
            ))}
          </fieldset>
        </div>
      </ToolbarChip>

      {/* Board zoom (#379) — desk task, hidden on mobile; independent of Density. */}
      {breakpoint !== 'sm' && (
        <BoardZoomControl zoom={props.zoom} onZoomChange={props.onZoomChange} />
      )}

      <span aria-hidden="true" className="h-4 w-px bg-neutral-border" />

      {showQuietTogglesInline && (
        <>
          {/* Quiet pill toggles — secondary controls (#568 rule 110) */}
          <ToolbarToggle
            icon="★"
            label="My tasks"
            pressed={props.myTasksEnabled}
            onToggle={props.onMyTasksToggle}
            disabled={props.myTasksLoading}
            title="Show only tasks assigned to you"
            hideLabel={hideQuietToggleLabels}
          />
          <ToolbarToggle
            icon="⚠"
            label="At-risk"
            ariaLabel="Risk-linked only"
            pressed={props.riskLinkedOnly}
            onToggle={props.onRiskLinkedToggle}
            title="Only show tasks linked to a risk"
            hideLabel={hideQuietToggleLabels}
          />
          <ToolbarToggle
            icon="⚒"
            label="Tech debt"
            ariaLabel="Tech-debt only"
            pressed={props.debtOnly}
            onToggle={props.onDebtOnlyToggle}
            title="Only show tech-debt tasks"
            hideLabel={hideQuietToggleLabels}
          />
          <ToolbarToggle
            icon="$"
            label="Cost"
            ariaLabel="Show cost"
            pressed={props.showCost}
            onToggle={props.onShowCostToggle}
            title="Show planned vs. actual cost on cards"
            hideLabel={hideQuietToggleLabels}
          />

          <span aria-hidden="true" className="h-4 w-px bg-neutral-border" />
        </>
      )}

      {breakpoint === 'sm' && (
        <ToolbarOverflowMenu
          triggerAriaLabel="Board secondary controls"
          align="left"
          items={
            [
              {
                kind: 'checkbox',
                id: 'my-tasks',
                label: 'My tasks',
                checked: props.myTasksEnabled,
                onChange: props.onMyTasksToggle,
                disabled: props.myTasksLoading,
                icon: '★',
              },
              {
                kind: 'checkbox',
                id: 'at-risk',
                label: 'Risk-linked only',
                checked: props.riskLinkedOnly,
                onChange: props.onRiskLinkedToggle,
                icon: '⚠',
              },
              {
                kind: 'checkbox',
                id: 'tech-debt',
                label: 'Tech-debt only',
                checked: props.debtOnly,
                onChange: props.onDebtOnlyToggle,
                icon: '⚒',
              },
              {
                kind: 'checkbox',
                id: 'cost',
                label: 'Show cost',
                checked: props.showCost,
                onChange: props.onShowCostToggle,
                icon: '$',
              },
            ] as ToolbarOverflowItem[]
          }
        />
      )}

      <LayoutSwitcher layout={props.layout} onChange={props.onLayoutChange} />

      <div className="ml-auto">
        <ToolbarChip
          label="More"
          value="⋯"
          ariaLabel="More board controls"
          isOpen={openChip === 'more'}
          onToggle={() => toggle('more')}
          align="right"
        >
          <div className="flex flex-col gap-1 min-w-[240px]">
            <MoreItem onClick={props.onCollapseAll}>Collapse all lanes</MoreItem>
            <MoreItem onClick={props.onExpandAll}>Expand all lanes</MoreItem>
            <MoreCheckbox
              checked={props.showWip}
              onChange={props.onShowWipToggle}
              label="Show WIP limits"
            />
            <MoreCheckbox
              checked={props.showColTints}
              onChange={props.onShowColTintsToggle}
              label="Column tints"
              ariaLabel="Show column tints"
            />
            <label className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-neutral-text-primary">
              <span>EVM</span>
              <select
                value={props.evmMode}
                onChange={(e) => props.onEvmChange(e.target.value as EvmMode)}
                aria-label="EVM indicators"
                className="border border-neutral-border rounded px-1.5 py-0.5 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              >
                {(Object.keys(EVM_LABELS) as EvmMode[]).map((m) => (
                  <option key={m} value={m}>
                    {EVM_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <MoreItem onClick={props.onOpenColumns} ariaLabel="Open board column settings">
              ⚙ Columns…
            </MoreItem>
            <MoreItem onClick={props.onOpenCheatsheet}>? Keyboard shortcuts</MoreItem>
            <button
              ref={props.workshopButtonRef}
              type="button"
              onClick={props.onWorkshopToggle}
              disabled={props.workshopDisabled}
              aria-pressed={props.workshopMode}
              aria-label={props.workshopMode ? 'Exit workshop mode' : 'Start workshop session'}
              className={[
                'rounded px-2 py-1 text-left text-xs',
                'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                'disabled:opacity-50',
                props.workshopMode
                  ? 'bg-brand-primary/10 text-brand-primary-dark dark:text-brand-primary'
                  : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              ◎ {props.workshopMode ? 'In Workshop' : 'Workshop'}
            </button>
          </div>
        </ToolbarChip>
      </div>
    </div>
  );
}

function MoreItem({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="rounded px-2 py-1 text-left text-xs text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function MoreCheckbox({
  checked,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  ariaLabel?: string;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-text-primary cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-brand-primary"
        aria-label={ariaLabel ?? label}
      />
      {label}
    </label>
  );
}
