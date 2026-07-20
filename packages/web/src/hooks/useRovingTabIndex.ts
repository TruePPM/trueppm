import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Roving-tabindex keyboard model for a single-select segmented control
 * (`role="radiogroup"` / `role="tablist"` built from native buttons), per
 * web-rule 167: only the focused option is tab-reachable, Arrow / Home / End move
 * DOM focus across the options, and focus movement alone NEVER commits — the
 * selection is applied on activation (click / Enter / Space via the native
 * button). This keeps a keyboard user free to scan the segments without firing a
 * side-effect on every option they pass, and it fixes the dead-arrow trap where a
 * roving `tabIndex` strands focus on the selected option with no way to reach the
 * others (WCAG 2.1.1).
 *
 * `RiskSegmentedFilter` is the inline reference this hook generalizes; the
 * pre-existing inline copies (RiskSegmentedFilter, PulseRadioGroup,
 * ScheduleToolbarToggle) stay grandfathered — new segmented controls use this
 * hook (the `useAnchoredPopover` precedent, rule 260).
 *
 * @param count       Number of options.
 * @param selectedIdx Index of the currently-selected option (roving focus tracks
 *                    it so Tab lands on the active option first). `< 0` → falls
 *                    back to the first option.
 * @param options.disabled Predicate marking an option index as disabled; roving
 *                    focus skips it (a `<button disabled>` cannot take focus).
 */
export function useRovingTabIndex(
  count: number,
  selectedIdx: number,
  options?: { disabled?: (i: number) => boolean },
) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);

  // Keep roving focus tracking the selection when it changes elsewhere (e.g. the
  // effective scope snaps back to a default). Arrows still move it independently.
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  const isDisabled = options?.disabled;

  const moveFocus = useCallback(
    (from: number, dir: 1 | -1) => {
      // Walk in `dir` to the next enabled option; stop at the bounds (no wrap —
      // matches RiskSegmentedFilter). Skipping disabled options keeps roving
      // focus off a `<button disabled>`, which the browser cannot focus.
      for (let i = from + dir; i >= 0 && i < count; i += dir) {
        if (!isDisabled?.(i)) {
          setFocusIdx(i);
          itemRefs.current[i]?.focus(); // focus only — commit happens on activation
          return;
        }
      }
    },
    [count, isDisabled],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(focusIdx, 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(focusIdx, -1);
          break;
        case 'Home':
          e.preventDefault();
          moveFocus(-1, 1); // first enabled option
          break;
        case 'End':
          e.preventDefault();
          moveFocus(count, -1); // last enabled option
          break;
        default:
          break;
      }
    },
    [count, focusIdx, moveFocus],
  );

  return { focusIdx, itemRefs, onKeyDown };
}
