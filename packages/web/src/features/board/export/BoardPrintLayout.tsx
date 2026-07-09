/**
 * Boardroom-clean print layout for the board PDF export (ADR-0159, issue 326).
 *
 * A static, non-interactive projection of the board: a header band, a column
 * header row, one swimlane block per phase (lane label + per-column compact card
 * stacks), and a footer band (project · timestamp · exporting user · filter
 * context · community watermark). No chrome, no gradients, no editing
 * affordances. Rendered off-screen by `BoardView`; `exportBoardPdf` rasterizes
 * this node and paginates it.
 *
 * Styling uses Design System tokens only (no raw hex, no shadow utilities) so
 * html-to-image captures the theme's resolved colors and the design-system-v2
 * gate stays green. Assignees render as initials, never remote avatar images —
 * cross-origin `<img>` can silently drop from the rasterizer.
 */
import { forwardRef } from 'react';
import type { TaskStatus } from '@/types';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { boardExportFooterWatermark } from './boardExportEdition';
import type { BoardPrintCard, BoardPrintData } from './boardPrintData';

/** Fixed print width ≈ A4 landscape at 96 dpi, giving the rasterizer a stable
 *  canvas independent of the viewport the board happens to be rendered at. */
const PRINT_WIDTH_PX = 1123;

function PrintCard({ card }: { card: BoardPrintCard }) {
  const due = card.due ? fmtUtcShort(card.due) : null;
  return (
    <div
      data-print-text="card"
      className="rounded-card border border-neutral-border bg-neutral-surface px-2 py-1.5"
    >
      <div className="flex items-start gap-1.5">
        {card.isCritical && (
          <span
            aria-hidden="true"
            title="On the critical path"
            className="mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-semantic-critical"
          />
        )}
        <span className="text-xs leading-snug text-neutral-text-primary">{card.name}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-text-secondary">
        {card.shortId && <span className="tppm-mono">{card.shortId}</span>}
        {card.assigneeInitials && (
          <span className="inline-flex items-center gap-1">
            {/* Primary ink, not secondary: #6B6965 on the sunken chip is 4.35:1
                (< AA); navy primary clears it comfortably (issue #1683). */}
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-neutral-surface-sunken text-xs font-medium text-neutral-text-primary">
              {card.assigneeInitials}
            </span>
          </span>
        )}
        {due && <span>{due}</span>}
        {card.storyPoints != null && <span>{card.storyPoints}pts</span>}
        {card.isBlocked && <span className="text-semantic-critical">Blocked</span>}
        {card.isMilestone && <span>◆</span>}
      </div>
    </div>
  );
}

function bucket(cards: BoardPrintCard[], status: TaskStatus): BoardPrintCard[] {
  return cards.filter((c) => c.status === status);
}

interface BoardPrintLayoutProps {
  data: BoardPrintData;
}

/**
 * Off-screen print surface. The parent positions this node out of view; we only
 * own its visual structure. `forwardRef` so `exportBoardPdf` can hand the node
 * to html-to-image.
 */
export const BoardPrintLayout = forwardRef<HTMLDivElement, BoardPrintLayoutProps>(
  function BoardPrintLayout({ data }, ref) {
    const watermark = boardExportFooterWatermark();
    const cardCount = data.lanes.reduce((n, lane) => n + lane.cards.length, 0);
    const cols = data.columns;
    // Column-header + per-lane grids share one template: a fixed lane-label rail
    // plus an equal fraction per visible status column.
    const gridTemplate = { gridTemplateColumns: `160px repeat(${cols.length}, minmax(0, 1fr))` };

    return (
      <div
        ref={ref}
        style={{ width: PRINT_WIDTH_PX }}
        // `theme-light` (issue #1683): pin the export to the light token palette
        // so a dark-mode app doesn't rasterize light ink on this white sheet.
        className="theme-light bg-white p-6 font-sans text-neutral-text-primary"
      >
        {/* Header band */}
        <header data-print-text="masthead" className="mb-4 border-b border-neutral-border pb-3">
          <h1 className="text-lg font-semibold">{data.projectName}</h1>
          <p className="mt-0.5 text-xs text-neutral-text-secondary">
            Board{data.sprintName ? ` · ${data.sprintName}` : ''} · {cardCount} cards
          </p>
        </header>

        {/* Column header row */}
        <div className="grid gap-2" style={gridTemplate}>
          <div />
          {cols.map((col) => (
            <div
              key={col.status}
              data-print-text="column"
              className="border-b-2 border-neutral-border pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
            >
              {col.label}
            </div>
          ))}
        </div>

        {/* Swimlanes */}
        {data.lanes.map((lane) => (
          <div
            key={lane.id}
            className="mt-3 grid gap-2 border-t border-neutral-border pt-2"
            style={gridTemplate}
          >
            <div data-print-text="lane" className="text-xs font-semibold text-neutral-text-primary">
              {lane.name}
              <span className="ml-1 font-normal text-neutral-text-secondary">
                ({lane.cards.length})
              </span>
            </div>
            {cols.map((col) => (
              <div key={col.status} className="flex flex-col gap-1.5">
                {bucket(lane.cards, col.status).map((card) => (
                  <PrintCard key={card.id} card={card} />
                ))}
              </div>
            ))}
          </div>
        ))}

        {/* Footer band */}
        <footer
          data-print-text="footer"
          className="mt-6 border-t border-neutral-border pt-2 text-xs text-neutral-text-secondary"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {data.projectName} · Generated {data.footer.generatedAtLabel}
              {data.footer.userName ? ` by ${data.footer.userName}` : ''}
            </span>
            <span>{data.footer.contextLabel}</span>
          </div>
          {watermark && <div className="mt-1">{watermark}</div>}
        </footer>
      </div>
    );
  },
);
