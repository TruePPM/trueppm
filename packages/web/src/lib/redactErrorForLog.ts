import axios from 'axios';

/** A console-safe projection of a caught value; never holds headers, bodies or query strings. */
export interface LoggableError {
  name: string;
  message: string;
  /** Stack of a plain `Error`. Omitted for Axios errors. */
  stack?: string;
  /** Axios only: upper-cased HTTP method. */
  method?: string;
  /** Axios only: URL path with the query string and fragment removed. */
  path?: string;
  /** Axios only: HTTP status, when a response arrived. */
  status?: number;
  /** Axios only: transport error code such as `ERR_NETWORK`. */
  code?: string;
}

/** Strip the origin, query string and fragment: query strings can carry tokens. */
function pathOnly(url: string): string {
  try {
    return new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
}

/**
 * Reduce a caught value to something safe to hand to `console.error`.
 *
 * Why: an `AxiosError` embeds `config.headers.Authorization` (the in-memory
 * access token), the request body and the full URL. Logging the raw object puts
 * the token in the browser console for anyone with console access, undercutting
 * the "token dies with the tab" posture (#3562). This keeps the debugging
 * signal (name, message, method, URL path, status) and drops everything else.
 *
 * @param error - Any thrown value.
 * @returns A plain object with only non-sensitive fields.
 */
export function redactErrorForLog(error: unknown): LoggableError {
  if (axios.isAxiosError(error)) {
    const out: LoggableError = { name: error.name, message: error.message };
    if (error.config?.method) out.method = error.config.method.toUpperCase();
    if (error.config?.url) out.path = pathOnly(error.config.url);
    if (error.response?.status !== undefined) out.status = error.response.status;
    if (error.code) out.code = error.code;
    return out;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: typeof error, message: typeof error === 'string' ? error : '' };
}

/**
 * `RouterProvider`'s `onError`. With no handler React Router's own boundary does
 * `console.error("...caught the following error during render", error)` with the
 * raw value, in production builds too, which would re-leak what
 * {@link redactErrorForLog} strips (#3562).
 */
export function logRouterError(error: unknown): void {
  console.error('[Router] caught an error:', redactErrorForLog(error));
}

/**
 * `createRoot` error options. React 19 otherwise logs caught/uncaught render
 * errors itself (dev builds print the raw error with `%o`); route them through
 * the redactor instead.
 */
export const redactedRootErrorOptions = {
  onCaughtError: (error: unknown, info: { componentStack?: string | null }): void => {
    console.error('[React] caught render error:', redactErrorForLog(error), info.componentStack);
  },
  onUncaughtError: (error: unknown, info: { componentStack?: string | null }): void => {
    console.error('[React] uncaught render error:', redactErrorForLog(error), info.componentStack);
  },
};
