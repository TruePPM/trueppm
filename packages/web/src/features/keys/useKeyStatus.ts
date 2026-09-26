import { useEffect, useState } from 'react';
import { useKeyAvailability, KEY_CHECK_DEBOUNCE_MS } from '@/hooks/useKeyCheck';
import type { RefKind } from '@/lib/refPath';
import { KEY_FORMAT_MESSAGE, keyFormatError } from './keyFormat';

/**
 * What the key status line says (ADR-1237 UX §1). One value at a time — the line
 * is a live region, and two competing messages would be announced as one garble.
 */
export type KeyStatus =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken'; suggestion: string }
  | { state: 'reserved' }
  /** A client-side format error or the server's own 400 message, verbatim. */
  | { state: 'error'; message: string };

export interface KeyStatusOptions {
  /**
   * Whether the value is the user's to check. False for an untouched create field
   * (the value is the server's own suggestion, already free) and for a settings
   * field still holding the saved key — nothing to say about either.
   */
  check: boolean;
  /** The object being renamed (settings), so its own keys read as available. */
  objectId?: string;
  /** The last `400` on `code` from POST/PATCH — shown verbatim until the value changes. */
  serverError?: string | null;
  /** Show `✓ Available` without a request (an untouched server suggestion). */
  knownAvailable?: boolean;
}

export interface KeyStatusResult {
  status: KeyStatus;
  /**
   * Submit is blocked only by a format error or a **confirmed** "in use" — never
   * by a pending check, because the server re-validates on save (UX §1).
   */
  blocksSubmit: boolean;
}

/**
 * Derive the key field's status line from its value (ADR-1237 UX §1, §2).
 *
 * The format check is local and instant, and a format error suppresses the network
 * check. Otherwise the value is checked 300 ms after typing stops; `Checking…`
 * appears only if that request itself takes longer than 300 ms, so a fast answer
 * never flashes an intermediate state. While the answer is stale (the user kept
 * typing) the line is empty rather than describing a value no longer in the field.
 */
export function useKeyStatus(
  kind: RefKind,
  value: string,
  options: KeyStatusOptions,
): KeyStatusResult {
  const { check, objectId, serverError, knownAvailable } = options;
  const formatError = check ? keyFormatError(kind, value) : null;
  const availability = useKeyAvailability(kind, value, {
    enabled: check && formatError === null && !serverError,
    objectId,
  });

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!availability.fetching) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), KEY_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [availability.fetching]);

  if (serverError) return { status: { state: 'error', message: serverError }, blocksSubmit: false };
  if (!check || value === '') {
    return {
      status: knownAvailable && value !== '' ? { state: 'available' } : { state: 'none' },
      blocksSubmit: false,
    };
  }
  if (formatError) return { status: { state: 'error', message: formatError }, blocksSubmit: true };
  if (availability.pending) {
    return { status: slow ? { state: 'checking' } : { state: 'none' }, blocksSubmit: false };
  }
  const data = availability.data;
  if (!data || data.available === undefined)
    return { status: { state: 'none' }, blocksSubmit: false };
  if (data.available) return { status: { state: 'available' }, blocksSubmit: false };
  if (data.reason === 'reserved') return { status: { state: 'reserved' }, blocksSubmit: false };
  if (data.reason === 'invalid') {
    return { status: { state: 'error', message: KEY_FORMAT_MESSAGE[kind] }, blocksSubmit: true };
  }
  return { status: { state: 'taken', suggestion: data.suggestion }, blocksSubmit: true };
}
