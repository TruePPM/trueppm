/**
 * The one owner of the ports the Playwright configs bind and probe.
 *
 * WHY THIS IS NOT A CONSTANT — do not "simplify" it back to a literal.
 *
 * `playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, and
 * Playwright identifies "an existing server" by PORT ALONE. In the parallel
 * worktree workflow (`scripts/wt new`, the documented default for multi-issue
 * work) every checkout on the machine would then share one preview server, so a
 * local run silently asserts against WHICHEVER worktree happened to start it —
 * another branch's bundle, with nothing in the output saying so. Three of six
 * branches in the 2026-09-06 batch hit it; one produced a convincing false
 * failure twice (#3514).
 *
 * The dangerous direction is the passing one: a green run against a sibling's
 * bundle proves nothing about the change under test, and reads exactly like a
 * trustworthy result.
 *
 * So the port is per-worktree: `scripts/wt new` derives one from the same slug
 * that names the worktree's Postgres test database and exports it into the
 * worktree's `.envrc`, beside `TRUEPPM_TEST_DB`. Unset — the main checkout and
 * every CI job — the defaults below apply, so CI is byte-identical to before.
 *
 * The value must reach `baseURL`, `webServer.url` AND the `--port` handed to
 * `npm run preview` together. A mismatch between the served port and the
 * asserted one is the same silent-wrong-server class this exists to close,
 * which is why every consumer reads it from here rather than from its own
 * `process.env` lookup.
 */

/** `vite preview` default — the port CI and the main checkout use. */
export const DEFAULT_PREVIEW_PORT = 4173;

/** `vite dev` default — used by the integration and marketing configs. */
export const DEFAULT_DEV_PORT = 5173;

/**
 * Read a port from the environment, falling back to `fallback` when unset.
 *
 * Throws on a value that is present but unusable rather than falling back:
 * a typo'd `TRUEPPM_E2E_PORT` that silently reverted to 4173 would reintroduce
 * exactly the shared-port collision the variable exists to prevent, and would
 * do it while looking configured.
 */
function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${name}="${raw}" is not a usable TCP port (expected an integer in 1024-65535). ` +
        `Unset it to fall back to ${fallback}.`,
    );
  }
  return port;
}

/** Port for the `vite preview` server the mocked e2e suite runs against. */
export function previewPort(): number {
  return readPort('TRUEPPM_E2E_PORT', DEFAULT_PREVIEW_PORT);
}

/** Port for the `vite dev` server the integration and marketing runs use. */
export function devPort(): number {
  return readPort('TRUEPPM_E2E_DEV_PORT', DEFAULT_DEV_PORT);
}
