/**
 * Bottom-sheet multi-select for the Type / Tags facets on mobile (the chip
 * triggers can't host a popover comfortably on a phone). Local working copy,
 * committed on Confirm.
 */

import { useEffect, useId, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import type { FacetOption } from '../FacetDropdown';
import { BTN_PRIMARY, FOCUS_RING } from '../styles';

interface MobileFilterSheetProps {
  open: boolean;
  title: string;
  options: FacetOption[];
  selected: string[];
  onClose: () => void;
  onConfirm: (next: string[]) => void;
}

export function MobileFilterSheet({
  open,
  title,
  options,
  selected,
  onClose,
  onConfirm,
}: MobileFilterSheetProps) {
  const [working, setWorking] = useState(selected);
  const headingId = useId();

  useEffect(() => {
    if (open) setWorking(selected);
  }, [open, selected]);

  function toggle(value: string) {
    setWorking((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  return (
    <BottomSheet isOpen={open} onClose={onClose} titleId={headingId} size="large">
      <div className="flex h-full flex-col px-4 pb-[env(safe-area-inset-bottom)]">
        <h2 id={headingId} className="px-1 py-2 text-sm font-semibold text-neutral-text-primary">
          Filter by {title.toLowerCase()}
        </h2>
        <ul className="flex-1 overflow-y-auto">
          {options.length === 0 && (
            <li className="px-1 py-3 text-xs text-neutral-text-secondary">Nothing to filter.</li>
          )}
          {options.map((option) => {
            const checked = working.includes(option.value);
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => toggle(option.value)}
                  className={`flex min-h-[44px] w-full items-center gap-3 px-1 text-left text-sm text-neutral-text-primary ${FOCUS_RING}`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-control border text-xs ${
                      checked
                        ? 'border-brand-primary bg-brand-primary text-white'
                        : 'border-neutral-border'
                    }`}
                  >
                    {checked ? '✓' : ''}
                  </span>
                  {option.label}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={`${BTN_PRIMARY} my-3 h-11 w-full`}
          onClick={() => {
            onConfirm(working);
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </BottomSheet>
  );
}
