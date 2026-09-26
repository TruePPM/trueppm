import { useCallback, useState } from 'react';
import { useKeySuggestion } from '@/hooks/useKeyCheck';
import type { RefKind } from '@/lib/refPath';
import { normalizeKeyInput } from './keyFormat';
import { useKeyStatus, type KeyStatusResult } from './useKeyStatus';

export interface CreateKeyField extends KeyStatusResult {
  /** What the input shows and what the create sends as `code`. */
  value: string;
  /** Whether the user has taken the key over from Name. */
  touched: boolean;
  /** The input's `onChange` value handler (raw text in). */
  onInput: (raw: string) => void;
  /** Set the field to a server suggestion ("try PM2") — counts as the user's choice. */
  applySuggestion: (suggestion: string) => void;
  /** Record a `400` on `code` from the create, shown verbatim until the value changes. */
  setServerError: (message: string | null) => void;
}

/**
 * State for the key field on a create form (ADR-1237 UX §1).
 *
 * - **Untouched**, the field *follows Name*: its value is the server's suggestion for
 *   the debounced Name (empty for an empty Name). That suggestion is free by
 *   construction, so it reads `✓ Available` without a second request.
 * - The **first keystroke** marks it touched; Name stops driving it and the value
 *   is checked instead.
 * - **Clearing it completely** un-touches it, so it resumes following Name.
 *
 * Input is case-normalized as typed (project keys upper, program keys lower).
 */
export function useCreateKeyField(kind: RefKind, name: string): CreateKeyField {
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const suggestion = useKeySuggestion(kind, name);

  const followed = name.trim() ? (suggestion.data?.suggestion ?? '') : '';
  const value = touched ? typed : followed;

  const status = useKeyStatus(kind, value, {
    check: touched,
    serverError,
    knownAvailable: !touched && !suggestion.isPlaceholderData,
  });

  const onInput = useCallback(
    (raw: string) => {
      const next = normalizeKeyInput(kind, raw);
      setServerError(null);
      setTyped(next);
      setTouched(next !== '');
    },
    [kind],
  );

  const applySuggestion = useCallback((next: string) => {
    setServerError(null);
    setTyped(next);
    setTouched(true);
  }, []);

  return { ...status, value, touched, onInput, applySuggestion, setServerError };
}
