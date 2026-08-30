import { useRef, type KeyboardEvent } from 'react';
import { useRovingTabIndex } from '@/hooks/useRovingTabIndex';
import type { WayIn } from './deriveStartSheetMethodology';

interface WayDef {
  id: WayIn;
  label: string;
  detail: string;
  /** Keyboard-jump letter (#2728: "letter keys jump"), matching the label's
   *  leading letter so the shortcut is guessable without a legend. */
  letter: string;
}

const WAYS: readonly WayDef[] = [
  { id: 'template', label: 'Template', detail: 'Start from a published shape', letter: 't' },
  { id: 'blank', label: 'Blank', detail: 'Start with an empty outline', letter: 'b' },
  { id: 'import', label: 'Import', detail: 'Bring in a spreadsheet', letter: 'i' },
];

export interface StartWayCardsProps {
  value: WayIn;
  onChange: (way: WayIn) => void;
  /** Below 900px the sheet is a full-screen surface and the ways lay out two per
   *  row instead of one row of three (#2728) — with today's three ways that is
   *  2 + 1, not the 2×2 this said while a fourth card was still planned (#3130).
   *  The grid is `grid-cols-2`, so restoring the fourth way (ADR-0913) fills the
   *  second row without touching this component. */
  compact?: boolean;
}

/**
 * The three peer ways into a new project (#2728): Template, Blank, Import — same
 * size, same row, no way privileged over another. Blank is a first-class card here,
 * not a fallback link at the bottom of a template list, matching the same
 * not-a-fallback treatment #2729 already gave it inside the (now retired) nested
 * gallery.
 *
 * A fourth way, "Seed from a brief", is cut, and stays cut rather than shipping
 * disabled — a way-in card that dead-ends is worse than one that is absent.
 * ADR-0913 (#2720) is the decision: the brief is parsed in-process with zero
 * egress, and because that endpoint is agent-writable by its own description it
 * ships no earlier than the 0.6 agent-write gate. `StartWayCards.test.tsx` pins the
 * absence, so restoring the card means answering the ADR first.
 *
 * Keyboard model: ←/→ moves focus across the row (roving tabindex, focus-only —
 * matches `useRovingTabIndex`'s WCAG 2.1.1 contract; arrowing through never commits
 * a selection on its own), a letter key jumps straight to and *commits* the
 * matching way (a single keystroke shortcut, not a scan), and Enter/Space commits
 * whichever card currently has focus. Selecting a way swaps the detail panel
 * beneath it without changing the sheet's height class (enforced by the parent
 * rendering a fixed-height detail region, not by anything in this component).
 */
export function StartWayCards({ value, onChange, compact = false }: StartWayCardsProps) {
  const selectedIdx = WAYS.findIndex((w) => w.id === value);
  const { focusIdx, itemRefs, onKeyDown } = useRovingTabIndex(WAYS.length, selectedIdx);
  const groupRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const letterIdx = WAYS.findIndex((w) => w.letter === e.key.toLowerCase());
    if (letterIdx >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      itemRefs.current[letterIdx]?.focus();
      onChange(WAYS[letterIdx].id);
      return;
    }
    onKeyDown(e);
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Start from"
      // -1: the group container itself is never a Tab stop (roving tabindex
      // lives on the individual cards below) — present only so the
      // interactive `radiogroup` role satisfies jsx-a11y's focusability check
      // (matches RiskSegmentedFilter's precedent, web-rule 167).
      tabIndex={-1}
      className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-3'}`}
      onKeyDown={handleKeyDown}
    >
      {WAYS.map((way, i) => {
        const selected = way.id === value;
        return (
          <button
            key={way.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(way.id)}
            className={`flex flex-col items-center gap-1 rounded-card border p-3 text-center transition
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
              ${
                selected
                  ? 'border-brand-primary bg-brand-primary/5'
                  : 'border-neutral-border hover:border-brand-primary/50'
              }`}
          >
            <span className="text-sm font-medium text-neutral-text-primary">{way.label}</span>
            <span className="text-xs text-neutral-text-secondary">{way.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
