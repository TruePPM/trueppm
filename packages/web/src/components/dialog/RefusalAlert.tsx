import type { WriteRefusal } from '@/lib/writeRefusal';

export interface RefusalAlertProps {
  /** The refusal to present, or `null` to render nothing. */
  refusal: WriteRefusal | null | undefined;
  /** Stable hook for tests — `<surface>-error`, per web-rule 372b. */
  testId?: string;
  /** Layout/spacing for the host surface; the tone classes are the component's own. */
  className?: string;
}

/**
 * The canonical inline presentation of a refused write (web-rule 372b, #3332).
 *
 * A `role="alert"` **sibling** — never a child of a surface's preview
 * `role="status"`, which carries an implicit `aria-atomic="true"` and would make
 * assistive tech re-read the whole preview before the refusal. Full width, so a
 * two-line refusal is not squeezed into the flex column beside the buttons.
 *
 * The message and the detail are two lines rather than one sentence because they
 * answer different questions: the server says what it refused, the client says
 * what to do about it. Running them together buries the remedy at the end of a
 * sentence the reader is already stuck on.
 */
export function RefusalAlert({ refusal, testId, className = '' }: RefusalAlertProps) {
  if (!refusal) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`leading-snug text-semantic-critical ${className}`.trim()}
    >
      <div>{refusal.message}</div>
      {refusal.detail && <div className="mt-1">{refusal.detail}</div>}
    </div>
  );
}
