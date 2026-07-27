/**
 * The Changes ↔ Agents sub-view switch on the project Activity tab (#2481, ADR-0677).
 *
 * Manual-activation `tablist` (web-rule 167): Arrow/Home/End move DOM focus only,
 * and activation (click / Enter / Space, via the native button) commits. Automatic
 * activation would be defensible for cheap panels, but each sub-view here owns a
 * different network query — arrowing across the strip must not fire a throwaway
 * fetch for a sub-view the user never chose to open.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ActivitySubView } from './agentActivityUrl';

const TABS: { key: ActivitySubView; label: string }[] = [
  { key: 'changes', label: 'Changes' },
  { key: 'agents', label: 'Agents' },
];

export interface ActivitySubViewTabsProps {
  view: ActivitySubView;
  onChange: (view: ActivitySubView) => void;
}

export function ActivitySubViewTabs({ view, onChange }: ActivitySubViewTabsProps) {
  const selectedIdx = Math.max(
    0,
    TABS.findIndex((t) => t.key === view),
  );
  const [focusIdx, setFocusIdx] = useState(selectedIdx);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Set by the keyboard handler only, so re-renders (a query resolving behind the
  // strip, the selected tab changing from a URL edit) never steal focus into the
  // tablist — the rule-280 focus-theft shape.
  const focusIntentRef = useRef(false);

  // Keep the roving tab stop on the selected tab when the sub-view changes from
  // outside (back/forward navigation, a shared link opening on Agents).
  useEffect(() => setFocusIdx(selectedIdx), [selectedIdx]);

  useEffect(() => {
    if (!focusIntentRef.current) return;
    focusIntentRef.current = false;
    btnRefs.current[focusIdx]?.focus();
  }, [focusIdx]);

  const moveFocus = (next: number) => {
    focusIntentRef.current = true;
    setFocusIdx((next + TABS.length) % TABS.length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(idx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(idx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(TABS.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Activity views"
      className="inline-flex items-center gap-1 rounded-control border border-neutral-border bg-neutral-surface-sunken p-0.5"
    >
      {TABS.map((tab, idx) => {
        const active = tab.key === view;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              btnRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={idx === focusIdx ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={[
              'inline-flex min-h-[44px] items-center rounded-chip px-3 text-xs font-medium transition-colors md:min-h-[32px]',
              // Tabs are standalone controls — `focus:`, never `focus-visible:` (rule 214).
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
              // Selection is carried by FILL, not text shade (rule 179).
              active
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
