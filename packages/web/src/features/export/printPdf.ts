/**
 * Dispatch an already-rendered PDF to the browser/OS print dialog (issue 1970).
 *
 * The export pipeline reuses the *identical* rasterized `jsPDF` document the
 * download path produces — print/download parity is the whole point — and only its
 * terminal action differs: `pdf.save()` for download vs. this print dispatch. We
 * deliberately do NOT `window.print()` the live DOM (that would print the canvas
 * Gantt in the app's dark theme, not the paginated light-theme sheet) and we do NOT
 * open a popup (generation is async, so by the time the blob exists the click
 * gesture has expired and the pop-up blocker fires). A hidden same-origin iframe
 * pointed at the blob URL sidesteps both.
 *
 * `pdf.autoPrint()` (called by the caller before the blob is materialized) embeds an
 * OpenAction that auto-fires in Chromium's built-in viewer; Firefox's pdf.js and some
 * Safari builds ignore it, so we also call `iframe.contentWindow.print()` on load as
 * a cross-browser belt-and-suspenders. Either way the dialog is OS-owned and
 * un-cancelable once open, and we CANNOT detect whether the user printed or canceled —
 * callers treat "dialog dispatched" as success, never "printed".
 */

/**
 * Fallback cleanup delay (ms). The iframe + blob URL MUST outlive the open print
 * dialog — revoking either early cancels the print in several browsers — so cleanup
 * normally waits for `afterprint`. This timeout only fires for browsers that never
 * emit `afterprint`, and is deliberately long so it never races a slow user.
 */
export const PRINT_CLEANUP_FALLBACK_MS = 60_000;

/**
 * Append a hidden iframe that loads `blobUrl` and triggers the print dialog, then
 * cleans itself up on `afterprint` (or after {@link PRINT_CLEANUP_FALLBACK_MS}).
 *
 * @param blobUrl Object URL of the PDF blob (owned by this call — revoked on cleanup).
 * @param doc Document to mount into; defaults to the global `document` (injectable for tests).
 * @returns An idempotent cleanup function (also invoked automatically).
 */
export function dispatchPrintViaIframe(blobUrl: string, doc: Document = document): () => void {
  const iframe = doc.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  // Off-screen but NOT display:none — a display:none iframe won't print in some
  // browsers. A 0×0 fixed frame parked bottom-right stays invisible yet printable.
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';

  let cleaned = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      /* already revoked / unsupported */
    }
    try {
      iframe.remove();
    } catch {
      /* already detached */
    }
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (win) {
      // Revoke + detach once the OS dialog closes; do NOT gate "success" on this —
      // afterprint is best-effort and never tells us whether the user actually printed.
      win.onafterprint = cleanup;
      try {
        win.focus();
        win.print();
      } catch {
        /* some viewers reject a programmatic print — autoPrint's OpenAction covers them. */
      }
    }
  };

  iframe.src = blobUrl;
  doc.body.appendChild(iframe);
  // Arm the fallback UNCONDITIONALLY at mount, not inside `onload`: a frame that never
  // loads (blob decode failure, a CSP that forbids `blob:` frames, a backgrounded tab)
  // would otherwise never arm cleanup, leaking the iframe + the full PDF bytes behind
  // its object URL for the session's lifetime.
  fallbackTimer = setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
  return cleanup;
}
