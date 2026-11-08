import type { ReactNode } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ArrowLeftIcon } from '@/components/Icons';
import { FOCUS_RING } from './classes';
import { TYPE } from './typeScale';

export interface PageTitleProps {
  /** The page's name. Never its ancestry — the breadcrumb owns that (the eyebrow rule). */
  children: ReactNode;
  /**
   * The parent the phone back control returns to. On a phone the breadcrumb
   * collapses to its leaf, so the back label above the title IS the breadcrumb
   * there, and it is a button. Ignored at `md` and up, where the top bar shows
   * the full trail.
   */
  back?: { label: string; onBack: () => void };
  /**
   * Keep the H1 for the document outline but hide it visually. Use when the
   * shell's context header is on screen: the context header is the visible
   * title then, and a second visible title would repeat it.
   */
  visuallyHidden?: boolean;
  /** Supporting line under the title (one sentence, meta step). */
  description?: ReactNode;
}

/**
 * The page's one H1 on the Pass 2 title scale (20/28) — rule 439.
 *
 * One H1 per page: this renders it, and nothing else on a shell v2 page may.
 * Ancestry is never repeated above the title ("Platform · Atlas · Schedule"):
 * the top bar's breadcrumb already says it, and an eyebrow restating it is the
 * redundancy rule 284 forbids in miniature.
 *
 * The phone back control is rendered once, from `useBreakpoint()`, not hidden
 * with CSS at other widths (rule 211).
 */
export function PageTitle({ children, back, visuallyHidden = false, description }: PageTitleProps) {
  const phone = useBreakpoint() === 'sm';
  return (
    <div className={visuallyHidden ? 'sr-only' : 'flex min-w-0 flex-col gap-1'}>
      {back && phone && !visuallyHidden && (
        <button
          type="button"
          onClick={back.onBack}
          className={`-ml-2 inline-flex h-11 items-center gap-1.5 self-start rounded-md px-2 text-xs font-medium text-p1-text-2 hover:bg-p1-surface-2 hover:text-p1-text-1 ${FOCUS_RING}`}
        >
          <ArrowLeftIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          {back.label}
        </button>
      )}
      {/* A truncated title keeps its full value on hover (rule 255). */}
      <h1
        className={`${TYPE.pageTitle} truncate text-p1-text-1`}
        title={typeof children === 'string' ? children : undefined}
      >
        {children}
      </h1>
      {description && !visuallyHidden && (
        <p className={`${TYPE.meta} text-p1-text-2`}>{description}</p>
      )}
    </div>
  );
}

/** A section heading inside a page (H2, 15/22). */
export function SectionHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className={`${TYPE.section} text-p1-text-1`}>
      {children}
    </h2>
  );
}
