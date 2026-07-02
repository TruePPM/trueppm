import { defineConfig } from '@playwright/test';

/**
 * Config consumed ONLY by `playwright merge-reports` in the web:e2e:report CI
 * job — it is never used to run tests.
 *
 * The blob reports emitted by the two web:e2e shards bake an ABSOLUTE `testDir`,
 * and the shards can land on runners with different builds_dir (/tmp/builds vs
 * /mnt/nvme1/gitlab-runner/builds). merge-reports then refuses to merge blobs
 * whose testDir differs ("Blob reports being merged were recorded with different
 * test directories", issue 1348). Passing this config rebases every blob onto one
 * resolved testDir, making the merge builds_dir-independent.
 *
 * `reporter: 'html'` is set here because the base playwright.config.ts uses 'line'
 * in CI, which would emit no HTML report for web:e2e:report to upload.
 *
 * The `json` reporter is added alongside so scripts/check-flaky.mjs can read the
 * merged, cross-shard outcome and surface any test that only passed on retry
 * (`stats.flaky`) — the gap issue 1514 closed: with CI retries a flaky test
 * greened the job silently. The stitched JSON is the only place the flaky status
 * for the WHOLE suite is visible (each shard's blob sees only its own subset).
 */
export default defineConfig({
  testDir: './e2e',
  reporter: [
    ['html'],
    ['json', { outputFile: 'flaky-report.json' }],
  ],
});
