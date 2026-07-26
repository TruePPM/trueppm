/**
 * Local-only Playwright override for running specs from a git worktree.
 *
 * The main config pins the preview server to :4173, which collides when another
 * worktree already has a preview running — the readiness probe then reaches the
 * *other* checkout's build (or nothing at all) and the run times out after 120s
 * with no useful signal.
 *
 * This config is not used by CI (`web:e2e` runs `playwright.config.ts`). Set
 * `TRUEPPM_E2E_PORT` to pick a free port, e.g.
 *   TRUEPPM_E2E_PORT=4273 npx playwright test --config playwright.wt.config.ts e2e/<spec>.spec.ts
 */
import base from './playwright.config';

const PORT = process.env.TRUEPPM_E2E_PORT ?? '4273';
const URL = `http://127.0.0.1:${PORT}`;

export default {
  ...base,
  use: { ...base.use, baseURL: URL },
  webServer: {
    ...base.webServer,
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: URL,
    reuseExistingServer: false,
  },
};
