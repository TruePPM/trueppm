/**
 * Backlog title highlighting.
 *
 * The implementation moved to `@/lib/searchHighlight` when the schedule
 * dependency picker needed the same segmentation with a second anchoring
 * (prefix, for a WBS code). This stays as the backlog's import surface so
 * `HighlightedTitle` and its tests keep one obvious name to reach for.
 */

export { highlightSegments, type HighlightSegment } from '@/lib/searchHighlight';
