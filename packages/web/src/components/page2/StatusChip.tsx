import { HEALTH_BAND_LABEL, type HealthBand } from '@/lib/healthBand';

/**
 * The status tones a Pass 2 chip may wear (rule 440). There is deliberately no
 * `brand` tone: brand is for actions and selection, never a status, and leaving
 * it out of the type is what lets `tsc` refuse a sage "On track" chip rather
 * than a reviewer having to spot one.
 *
 * - `critical`, `blocked` — red. Critical path or blocked, nothing else.
 * - `risk` — amber. At risk, near-critical, over-allocated, WIP over limit.
 * - `ok` — done / on track.
 * - `info` — in progress, informational.
 * - `neutral` — not started, no status.
 */
export type StatusTone = 'critical' | 'blocked' | 'risk' | 'ok' | 'info' | 'neutral';

/**
 * The non-color glyph every chip carries (rule 120). `▲ ◆ ✓` match the shipped
 * shell health chip (#4742), so a glyph never means two things across the shell.
 */
export const STATUS_GLYPH: Record<StatusTone, string> = {
  critical: '▲',
  blocked: '■',
  risk: '◆',
  ok: '✓',
  info: '●',
  neutral: '●',
};

/**
 * Text on its own tint, from the shipped `p1` chip tokens only — no new color
 * family. Every pair is pinned ≥ 4.5:1 in both themes by `p1Tokens.test.ts`.
 */
const TONE_CLASS: Record<StatusTone, string> = {
  critical: 'bg-p1-critical-tint text-p1-critical',
  blocked: 'bg-p1-critical-tint text-p1-critical',
  risk: 'bg-p1-risk-tint text-p1-risk-text',
  ok: 'bg-p1-ok-tint text-p1-ok',
  info: 'bg-p1-info-tint text-p1-info',
  neutral: 'bg-p1-surface-2 text-p1-text-2',
};

export interface StatusChipProps {
  tone: StatusTone;
  /** The status word. Required: a glyph or a color alone is never the message. */
  label: string;
  'data-testid'?: string;
}

/** A Pass 2 status chip: tint, glyph, word (rule 440). Not interactive. */
export function StatusChip({ tone, label, 'data-testid': testId }: StatusChipProps) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden="true" className="text-xs leading-none">
        {STATUS_GLYPH[tone]}
      </span>
      {label}
    </span>
  );
}

const BAND_TONE: Record<HealthBand, StatusTone> = {
  critical: 'critical',
  at_risk: 'risk',
  on_track: 'ok',
};

/**
 * The RAG chip (rule 442): a PRESENTATION of the server's health band, with the
 * band word from `HEALTH_BAND_LABEL` (rule 397). It takes a band, not counts or
 * a percentage, so it has nowhere to put a client-side threshold.
 */
export function HealthBandChip({
  band,
  'data-testid': testId,
}: {
  band: HealthBand;
  'data-testid'?: string;
}) {
  return <StatusChip tone={BAND_TONE[band]} label={HEALTH_BAND_LABEL[band]} data-testid={testId} />;
}
