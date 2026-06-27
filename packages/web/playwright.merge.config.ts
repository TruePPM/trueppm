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
 */
export default defineConfig({
  testDir: './e2e',
  reporter: 'html',
});
