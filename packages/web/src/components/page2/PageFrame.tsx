import type { ReactNode } from 'react';

/**
 * `contained` caps content at 1120px (Overview, Settings, list pages);
 * `bleed` spans the sheet (Schedule, Board), whose content is a canvas.
 */
export type PageWidth = 'contained' | 'bleed';

export interface PageFrameProps {
  width: PageWidth;
  /** The title row — normally a `PageTitle`, plus any page-level actions. */
  header?: ReactNode;
  /** The page's one toolbar row (view switchers, filters, primary action). */
  toolbar?: ReactNode;
  /**
   * A banner, "filters applied" row or bulk-action bar. When present it TAKES
   * the toolbar row instead of stacking under it: chrome above the page is
   * three rows at most, so a fourth is never available to stack into.
   */
  toolbarOverride?: ReactNode;
  children: ReactNode;
}

/** Gutters 16 / 20 / 24 / 32 at < 768 / 768 / 1024 / 1440 (Pass 2 page frame). */
const GUTTER = 'px-4 md:px-5 lg:px-6 2xl:px-8';

/**
 * The Pass 2 page frame (rule 439): the one owner of a shell v2 page's gutters,
 * its content width, and the single toolbar row.
 *
 * Why the toolbar is a prop and not a child: the redesign's budget is "chrome
 * above the page is three rows maximum" (top bar, context header, toolbar), so a
 * page starts at 191px or less. Every v1 page broke that by rendering its banner
 * as one more row above its toolbar. Taking both as props lets the frame render
 * exactly one of them — `toolbarOverride` wins — so the stacked layout cannot be
 * written.
 *
 * Not a landmark: `AppShell2` owns the one `<main>` (rule 273).
 */
export function PageFrame({ width, header, toolbar, toolbarOverride, children }: PageFrameProps) {
  const toolbarRow = toolbarOverride ?? toolbar;
  const contained = width === 'contained';
  const inner = contained ? 'mx-auto w-full max-w-[1120px]' : 'w-full';
  return (
    <div data-testid="page-frame" data-width={width} className="flex min-h-full flex-col">
      {(header || toolbarRow) && (
        <div className={`${GUTTER} pt-4 md:pt-5`}>
          <div className={`${inner} flex flex-col gap-3`}>
            {header}
            {toolbarRow && (
              <div
                data-testid="page-frame-toolbar"
                data-override={toolbarOverride ? 'true' : undefined}
                className="flex min-h-11 items-center gap-2"
              >
                {toolbarRow}
              </div>
            )}
          </div>
        </div>
      )}
      <div
        data-testid="page-frame-body"
        className={contained ? `${GUTTER} flex-1 py-4 md:py-5` : 'min-h-0 flex-1'}
      >
        <div className={inner}>{children}</div>
      </div>
    </div>
  );
}
