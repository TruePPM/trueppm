import type { ReactNode } from 'react';
import { BAND_TONE, STATUS_GLYPH } from '@/components/page2/StatusChip';
import { FOCUS_RING } from '@/components/page2/classes';
import { RAGS, RAG_BAND, ragLabel, type Rag } from '@/lib/ragBand';

const CHECKED: Record<Rag, string> = {
  green: 'border-p1-ok bg-p1-ok-tint text-p1-ok',
  amber: 'border-p1-risk-text bg-p1-risk-tint text-p1-risk-text',
  red: 'border-p1-critical bg-p1-critical-tint text-p1-critical',
};

export interface RagRadioProps {
  /** The group's visible label, e.g. "Your call". */
  legend: string;
  name: string;
  value: Rag | null;
  onChange: (rag: Rag) => void;
  disabled?: boolean;
  /**
   * Shown beside the group, e.g. the computed health, so the PM's call reads as a
   * stated opinion beside the plan's band rather than a hidden override.
   */
  aside?: ReactNode;
}

/**
 * Pass 3 RAG radio group (#4802): three native radios in a fieldset, each a glyph
 * plus the band word (rule 440, one vocabulary — `ragBand`). Native inputs give the
 * radiogroup semantics and arrow-key movement for free. 44px targets, 52px on a
 * phone (max-sm), so the call can be made one-handed.
 */
export function RagRadio({ legend, name, value, onChange, disabled, aside }: RagRadioProps) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-xs text-p1-text-2">{legend}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {RAGS.map((rag) => {
          const checked = value === rag;
          return (
            <label
              key={rag}
              className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium max-sm:min-h-[52px] max-sm:flex-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-p1-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-p1-surface-1 ${
                checked ? CHECKED[rag] : 'border-p1-hairline bg-p1-surface-1 text-p1-text-1'
              }`}
              data-testid={`rag-${rag}`}
            >
              <input
                type="radio"
                name={name}
                value={rag}
                checked={checked}
                onChange={() => onChange(rag)}
                className={`sr-only ${FOCUS_RING}`}
              />
              <span aria-hidden="true">{STATUS_GLYPH[BAND_TONE[RAG_BAND[rag]]]}</span>
              {ragLabel(rag)}
            </label>
          );
        })}
        {aside}
      </div>
    </fieldset>
  );
}
