import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'trueppm.featureFlags';
const URL_PARAM = 'ff';

type FlagMap = Record<string, boolean>;

/**
 * Coerce arbitrary input into the `{flag: boolean}` shape used internally.
 * Exported only for unit testing the validation branches — production code
 * should call `parseEnvDefaults()` or `readStoredFlags()`.
 */
export function coerceFlagMap(raw: unknown): FlagMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FlagMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function parseEnvDefaults(): FlagMap {
  const raw: unknown = import.meta.env.VITE_FEATURE_FLAGS;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return coerceFlagMap(JSON.parse(raw));
  } catch {
    // Malformed VITE_FEATURE_FLAGS — treat as empty.
    return {};
  }
}

const ENV_DEFAULTS = parseEnvDefaults();

function readStoredFlags(): FlagMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return coerceFlagMap(JSON.parse(raw));
  } catch {
    // Corrupted localStorage entry — ignore and treat as empty.
    return {};
  }
}

function writeStoredFlags(flags: FlagMap): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  notifySubscribers();
}

const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    subscribers.delete(cb);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

function getSnapshot(name: string): boolean {
  const stored = readStoredFlags();
  if (name in stored) return stored[name];
  if (name in ENV_DEFAULTS) return ENV_DEFAULTS[name];
  return false;
}

/**
 * Read a runtime feature flag. Resolution order:
 *   1. localStorage runtime override (per-browser, persists)
 *   2. `VITE_FEATURE_FLAGS` env-var build-time defaults (dev/test/CI)
 *   3. Off
 *
 * The hook re-renders when the flag is toggled in this tab (via setFeatureFlag)
 * or in another tab (via the `storage` event).
 */
export function useFeatureFlag(name: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(name),
    () => (name in ENV_DEFAULTS ? ENV_DEFAULTS[name] : false),
  );
}

/** Imperative override — writes to localStorage and re-renders all subscribers. */
export function setFeatureFlag(name: string, value: boolean): void {
  const current = readStoredFlags();
  writeStoredFlags({ ...current, [name]: value });
}

/** Imperative read — for non-React code paths. */
export function isFeatureFlagEnabled(name: string): boolean {
  return getSnapshot(name);
}

/**
 * Apply `?ff=flag_name` URL params on app start. Comma-separates multiple
 * (`?ff=a,b`). Each named flag is set to true in localStorage so it persists
 * across navigations. Strips the `ff` param from the URL after applying.
 */
export function applyFeatureFlagsFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const param = url.searchParams.get(URL_PARAM);
  if (!param) return;
  const names = param
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return;
  const current = readStoredFlags();
  for (const name of names) current[name] = true;
  writeStoredFlags(current);
  url.searchParams.delete(URL_PARAM);
  window.history.replaceState(null, '', url.toString());
}
