/**
 * The polite live-region confirmation every client-triggered download owes its user
 * (rule 297, WCAG 4.1.3), as a hook rather than a pattern to remember.
 *
 * A download is the one user-initiated action that produces no in-page change, so
 * without an announcement it is indistinguishable from a dead button for screen-reader
 * and low-vision users. Rule 297 was written down *because* a second download button
 * was added to a file that already had the pattern, and three more sites qualified
 * afterwards (#2943) — which makes it a rule 300 case: a rule that has needed a second
 * manual sweep does not have a working mechanism, and the fix is the mechanism.
 *
 * So the announcement rides with the helper instead of being something each caller
 * remembers: `download()` wraps `downloadCsv` and sets the text itself, and the
 * conformance test in `utils/exportCsv.conformance.test.ts` fails a module that
 * imports `downloadCsv` without also mounting a region.
 *
 * The region is returned already-rendered and **unconditional**. That is load-bearing:
 * a live region created in the same tick as its content does not reliably announce,
 * which is why it renders an empty `sr-only` span up front rather than appearing only
 * after a download.
 *
 * Usage:
 *   const { download, region } = useDownloadAnnouncer();
 *   <button onClick={() => download(csv, 'members.csv', 'Members downloaded.')}>…</button>
 *   {region}
 */
import { useCallback, useState, type ReactElement } from 'react';
import { downloadCsv } from '@/utils/exportCsv';

export interface DownloadAnnouncer {
  /**
   * Announce `message` politely — for a download this hook did not perform itself.
   *
   * Needed because not every download is a bare `downloadCsv(csv, name)` call: some go
   * through a module-level helper that owns its own filename derivation
   * (`exportRisksToCSV` stamps the local calendar day). Those keep their helper and
   * call `announce` beside it.
   */
  announce: (message: string) => void;
  /** Save the CSV and announce `message` politely — the common case. */
  download: (csv: string, filename: string, message: string) => void;
  /** Mount this once in the component that owns the download button. */
  region: ReactElement;
}

export function useDownloadAnnouncer(): DownloadAnnouncer {
  const [announcement, setAnnouncement] = useState('');

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const download = useCallback((csv: string, filename: string, message: string) => {
    // The announcement follows the save rather than preceding it: if the blob/anchor
    // sequence throws, nothing claims a download that did not happen.
    downloadCsv(csv, filename);
    setAnnouncement(message);
  }, []);

  const region = (
    <span aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );

  return { announce, download, region };
}
