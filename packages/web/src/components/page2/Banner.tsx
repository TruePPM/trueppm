import type { ReactNode } from 'react';
import { STATUS_GLYPH } from '@/components/page2/StatusChip';

export type BannerTone = 'critical' | 'risk' | 'info';

const TONE_CLASS: Record<BannerTone, string> = {
  critical: 'border-p1-critical bg-p1-critical-tint text-p1-critical',
  risk: 'border-p1-risk-text bg-p1-risk-tint text-p1-risk-text',
  info: 'border-p1-info bg-p1-info-tint text-p1-info',
};

export interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** One action, e.g. Retry. */
  action?: ReactNode;
  'data-testid'?: string;
}

/**
 * Pass 3 banner (#4802): one line with a glyph and words, and at most one action.
 * It takes the row it is placed in (the toolbar row, via `PageFrame`'s
 * `toolbarOverride`) and never stacks under it: full width, and the toolbar
 * row's own height (36px on a fine pointer at `md`+, 44px otherwise), so taking
 * the row does not push the page down.
 * A critical banner is an alert, announced at once; the others are polite status.
 */
export function Banner({ tone, children, action, 'data-testid': testId }: BannerProps) {
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
      className={`flex min-h-[44px] w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm md:min-h-9 md:py-1 md:[@media(pointer:coarse)]:min-h-11 ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden="true">{STATUS_GLYPH[tone]}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
