/**
 * API client boundary. The mobile app is an API consumer with no privileged
 * access (CLAUDE.md API-first principle) — it talks to the same REST/WS surface
 * the web app does.
 *
 * OpenAPI-derived request/response types are shared with packages/web (ADR-0026
 * §2: `src/api/` holds the generated types, shared from web). Wiring the
 * generation/symlink of `packages/web/src/api/types.ts` into this package is
 * done alongside the first networked feature; the scaffold exposes only the
 * runtime client configuration so screens can be written against a stable shape.
 */

/** Resolved API base URL for the current build. Overridden per EAS profile. */
export interface ApiConfig {
  /** Base URL of the TruePPM API, e.g. https://api.example.com */
  baseUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

/** Default client config for local development against the dev stack. */
export const defaultApiConfig: ApiConfig = {
  baseUrl: 'http://localhost:8000',
  timeoutMs: 15000,
};
