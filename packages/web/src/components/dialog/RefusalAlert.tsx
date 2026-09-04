import type { WriteRefusal } from '@/lib/writeRefusal';

export interface RefusalAlertProps {
  /** The refusal to present, or `null` to render nothing. */
  refusal: WriteRefusal | null | undefined;
  /** Stable hook for tests — `<surface>-error`, per web-rule 372b. */
  testId?: string;
  /**
   * Layout/spacing for the host surface. Tone **and type scale** are the
   * component's own: four of the five call sites were passing `text-xs` and the
   * fifth survived only on an ambient class from its sheet root, which is the
   * drift this component exists to end (`ux-review`, #3332).
   */
  className?: string;
  /**
   * Mount the live region **before** it has anything to say (web-rule 335).
   *
   * A region inserted together with its own content is announced inconsistently
   * across AT. Pass this wherever the host **outlives** the refusal — a sheet or
   * popover that is already open when the write is refused — which is the case
   * `BulkEditSheet`'s own `bulk-owner-refusal` region already handles this way.
   *
   * Deliberately NOT the default: `DialogFooter` and `UnsavedChangesDialog` are
   * themselves mounted at the moment the refusal appears (`{dirty && <Footer/>}`,
   * and the guard fires on the swap), so a persistent region inside them is
   * inserted with its content anyway and the flag would only promise a guarantee
   * it cannot keep. `empty:hidden` keeps the layout cost at zero either way.
   */
  persistent?: boolean;
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
export function RefusalAlert({
  refusal,
  testId,
  className = '',
  persistent = false,
}: RefusalAlertProps) {
  if (!refusal && !persistent) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      // `break-words`: DRF sentences routinely embed a UUID, a path or a URL
      // ('pk "550e8400-…" does not exist.'), and an unbroken token will not wrap
      // inside the ~324px content box of the mobile bottom sheet.
      // `empty:hidden` so a persistent-but-silent region costs no layout.
      className={`text-xs leading-snug break-words text-semantic-critical empty:hidden ${className}`.trim()}
    >
      {refusal && <div>{refusal.message}</div>}
      {refusal?.detail && <div className="mt-1">{refusal.detail}</div>}
    </div>
  );
}
