/**
 * Mint an idempotency key for a write. `crypto.randomUUID` only exists in secure contexts
 * (https or localhost); a self-hosted install on plain http would otherwise throw.
 */
export function mintIdempotencyKey(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  return (
    c?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}
