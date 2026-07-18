const STORAGE_KEY = 'trueppm.heatmap.window.v1';
const OPTIONS = [4, 8, 12, 16] as const;
export type WeeksWindow = (typeof OPTIONS)[number];

export function readPersistedWindow(): WeeksWindow {
  try {
    const v = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10);
    return (OPTIONS as readonly number[]).includes(v) ? (v as WeeksWindow) : 8;
  } catch {
    return 8;
  }
}

interface Props {
  value: WeeksWindow;
  onChange: (weeks: WeeksWindow) => void;
}

/**
 * Pill-group toggle for selecting the heatmap week window (4/8/12/16 weeks).
 * Persists selection to localStorage so David's preferred 12/16-week view
 * survives page refreshes.
 */
export function WeeksWindowControl({ value, onChange }: Props) {
  function handleChange(w: WeeksWindow) {
    try {
      localStorage.setItem(STORAGE_KEY, String(w));
    } catch {
      // ignore storage errors (private browsing)
    }
    onChange(w);
  }

  return (
    <div
      role="group"
      aria-label="Week window"
      className="flex items-center gap-0.5"
    >
      {OPTIONS.map((w) => {
        const active = w === value;
        return (
          <button
            key={w}
            type="button"
            onClick={() => handleChange(w)}
            aria-pressed={active}
            className={[
              'h-7 px-2.5 text-xs font-medium rounded border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              active
                ? 'bg-brand-primary/10 border-brand-primary text-brand-primary'
                : 'border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {w}w
          </button>
        );
      })}
    </div>
  );
}
