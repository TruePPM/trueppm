/**
 * Renders a title with the matched search substring(s) wrapped in <mark>.
 * Uses `highlightSegments` (no dangerouslySetInnerHTML) so arbitrary titles
 * are safe. The mark tint is the amber accent; the surrounding row dimming is
 * what supplies the real contrast (per 04-filters-search).
 */

import { highlightSegments } from '../highlight';

interface HighlightedTitleProps {
  title: string;
  query: string;
}

export function HighlightedTitle({ title, query }: HighlightedTitleProps) {
  const segments = highlightSegments(title, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-[2px] bg-brand-accent-light px-px text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
