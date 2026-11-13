import { useUserDateFormat } from '@/hooks/useUserDateFormat';

/**
 * Echoes a native `<input type="date">` value in the user's date-format
 * preference. The native control renders in the browser locale and cannot be
 * restyled, so beside it we show the same calendar date the way the rest of the
 * app does (the class #2059 fixed for ShareViewDialog). Visual only: the input
 * already announces its own value.
 */
export function DateFormatEcho({ value }: { value: string | null | undefined }) {
  const { fmtDateLong } = useUserDateFormat();
  if (!value) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="date-format-echo"
      className="tppm-mono text-xs text-neutral-text-secondary"
    >
      {fmtDateLong(value)}
    </span>
  );
}
