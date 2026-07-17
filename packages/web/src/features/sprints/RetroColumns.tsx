import { useState } from 'react';
import type {
  RetroBoardColumn,
  RetroBoardColumnKey,
  RetroBoardItem,
} from '@/hooks/useRetroBoard';
import { RetroColumn, type PendingSticky } from './RetroColumn';

interface Props {
  columns: RetroBoardColumn[];
  /** All confirmed stickies across every column (unsorted). */
  items: RetroBoardItem[];
  pending: PendingSticky[];
  remoteIds: Set<string>;
  readOnly: boolean;
  convertingId: string | null;
  onAdd: (column: RetroBoardColumnKey, text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onConvert: (id: string) => void;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}

function itemsFor(items: RetroBoardItem[], column: RetroBoardColumnKey): RetroBoardItem[] {
  return items
    .filter((it) => it.column === column)
    .sort((a, b) => a.position - b.position);
}

/**
 * The three-column retro board (ADR-0117 §6).
 *
 * Desktop (≥640px): three equal columns side by side. Mobile (<640px): a
 * segmented control selects one column at a time and only that column renders,
 * so a single column owns the full width and scrolls vertically.
 */
export function RetroColumns(props: Props) {
  const { columns } = props;
  const [activeKey, setActiveKey] = useState<RetroBoardColumnKey>(
    columns[0]?.key ?? 'went_well',
  );

  function renderColumn(col: RetroBoardColumn) {
    return (
      <RetroColumn
        key={col.key}
        columnKey={col.key}
        label={col.label}
        items={itemsFor(props.items, col.key)}
        pending={props.pending.filter((p) => p.column === col.key)}
        remoteIds={props.remoteIds}
        readOnly={props.readOnly}
        convertingId={props.convertingId}
        onAdd={props.onAdd}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
        onConvert={props.onConvert}
        onRetry={props.onRetry}
        onDiscard={props.onDiscard}
      />
    );
  }

  const active = columns.find((c) => c.key === activeKey) ?? columns[0];

  return (
    <>
      {/* Mobile: segmented control + single visible column. */}
      <div className="sm:hidden flex flex-col gap-2">
        <div
          role="tablist"
          aria-label="Retro columns"
          className="inline-flex items-center gap-0.5 rounded border border-neutral-border bg-neutral-surface-raised p-0.5"
        >
          {columns.map((col) => {
            const selected = col.key === activeKey;
            const count = itemsFor(props.items, col.key).length;
            return (
              <button
                key={col.key}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveKey(col.key)}
                className={[
                  'flex-1 min-h-[44px] px-2 rounded text-xs font-medium whitespace-nowrap',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  selected
                    ? 'bg-brand-primary text-neutral-text-inverse'
                    : 'text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                {col.label}
                <span className="ml-1 tppm-mono opacity-80">{count}</span>
              </button>
            );
          })}
        </div>
        {active && renderColumn(active)}
      </div>

      {/* Desktop: three equal columns. */}
      <div className="hidden sm:flex sm:items-start sm:gap-3">
        {columns.map((col) => renderColumn(col))}
      </div>
    </>
  );
}
