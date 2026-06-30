/**
 * Auth token storage boundary (ADR-0026 §Authentication). EMPTY TYPED BOUNDARY.
 *
 * The shipping implementation persists JWT access + refresh tokens in
 * `expo-secure-store` (iOS Keychain / Android Keystore) and is wired in by the
 * auth feature (ADR-0026 implementation order, step 4). That feature adds the
 * `expo-secure-store` dependency; the scaffold keeps it out of the install so
 * the lint/typecheck gates stay lean. Until then, a non-persistent in-memory
 * store backs the interface so screens and tests can depend on the contract.
 */

/** JWT pair returned by the auth endpoints. */
export interface TokenPair {
  access: string;
  refresh: string;
}

/** Secure persistence contract for the JWT pair. */
export interface SecureTokenStore {
  getTokens(): Promise<TokenPair | null>;
  setTokens(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

/**
 * In-memory scaffold store. NOT secure and NOT persistent — replaced by the
 * expo-secure-store-backed implementation when the auth feature lands. Exists so
 * the interface has a usable default during scaffold/feature bring-up.
 */
export function createMemoryTokenStore(): SecureTokenStore {
  let current: TokenPair | null = null;
  return {
    getTokens: () => Promise.resolve(current),
    setTokens: (tokens) => {
      current = tokens;
      return Promise.resolve();
    },
    clear: () => {
      current = null;
      return Promise.resolve();
    },
  };
}
