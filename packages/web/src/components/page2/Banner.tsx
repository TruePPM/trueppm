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
  /**
   * `toolbar`: the banner stands in the toolbar row (`PageFrame`'s
   * `toolbarOverride`) and takes that row's compact height. Omit in content.
   */
  row?: 'toolbar';
  'data-testid'?: string;
}

/**
 * Pass 3 banner (#4802): one line with a glyph and words, and at most one action.
 * It is full width and 44px tall. With `row="toolbar"` it takes the toolbar
 * row's own height instead (36px on a fine pointer at `md`+, 44px otherwise), so
 * taking that row does not push the page down.
 * A critical banner is an alert, announced at once; the others are polite status.
 */
export function Banner({ tone, children, action, row, 'data-testid': testId }: BannerProps) {
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
      className={`flex min-h-[44px] w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
        row === 'toolbar' ? 'md:min-h-9 md:py-1 md:[@media(pointer:coarse)]:min-h-11' : ''
      } ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden="true">{STATUS_GLYPH[tone]}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
