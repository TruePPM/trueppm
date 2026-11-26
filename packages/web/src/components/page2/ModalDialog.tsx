import { useId, type ReactNode } from 'react';
import { CloseIcon } from '@/components/Icons';
import { FOCUS_RING } from '@/components/page2/classes';
import { TYPE } from '@/components/page2/typeScale';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface ModalDialogProps {
  open: boolean;
  /** Called by Escape, the scrim and the close button. */
  onClose: () => void;
  title: string;
  /** One sentence under the title, announced with it. */
  description?: string;
  children: ReactNode;
  /** The actions row. */
  footer?: ReactNode;
  /** A write is in flight: Escape, scrim and close do nothing until it ends. */
  busy?: boolean;
}

/**
 * Pass 3 modal dialog (#4802): focus trap and focus restore (`useFocusTrap`),
 * Escape, and a scrim. The ref, role and `aria-modal` sit on the PANEL and the
 * scrim is a plain sibling (rule 419). A dialog that edits data still owns rule
 * 217: guard a dirty dismiss in `onClose`.
 */
export function ModalDialog(props: ModalDialogProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({
  onClose,
  title,
  description,
  children,
  footer,
  busy = false,
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const trapRef = useFocusTrap<HTMLDivElement>(true, close, busy);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        data-testid="modal-scrim"
        className="absolute inset-0 bg-neutral-overlay motion-safe:animate-scrim-fade"
        onPointerDown={close}
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="relative flex max-h-full w-full max-w-lg flex-col gap-3 rounded-lg border border-p1-hairline-strong bg-p1-surface-1 p-4 motion-safe:animate-modal-scale-in focus:outline-none focus:ring-2 focus:ring-p1-focus"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className={`${TYPE.section} text-p1-text-1`}>
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className={`${TYPE.body} text-p1-text-2`}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            aria-disabled={busy || undefined}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-p1-text-2 hover:bg-p1-surface-2 aria-disabled:cursor-default aria-disabled:text-p1-text-3 ${FOCUS_RING}`}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </header>
        {/* A tab stop so a long body with no control of its own scrolls by keyboard (rule 360). */}
        <div
          role="group"
          aria-labelledby={titleId}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- rule 360
          tabIndex={0}
          className={`min-h-0 overflow-y-auto rounded p-1 ${FOCUS_RING}`}
        >
          {children}
        </div>
        {footer && <footer className="flex flex-wrap justify-end gap-2">{footer}</footer>}
      </div>
    </div>
  );
}
