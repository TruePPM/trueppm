import { test, expect } from '@playwright/test';
import { findClippedContent } from './fixtures/clipped-content';

/**
 * Contract tests for the clipped-content fixture itself.
 *
 * `clipped-content.spec.ts` runs the fixture across real routes and asserts it
 * finds nothing — a green run there is equally consistent with a working gate
 * and with a gate that reports clean unconditionally. That is the failure the
 * fixture's own comment warns about ("a gate you have not watched fail is not a
 * gate", web rule 300(a)), and it already happened once: the first draft
 * reported clean against the unfixed #3166 tree.
 *
 * These three cases pin the behavior that has no other coverage — that the
 * detector fires at all, and that the `data-clip-ok` escape hatch opens only
 * for a marker carrying a non-empty reason.
 */
const box = (attrs: string) =>
  `<div ${attrs} style="overflow-y:hidden;height:50px;width:200px">
     <div style="height:400px">top</div>
     <div style="height:40px">UNREACHABLE-TEXT</div>
   </div>`;

test('detects a clipping container whose content overflows it', async ({ page }) => {
  await page.setContent(box('data-testid="clip-probe"'));
  const findings = await findClippedContent(page);
  expect(findings).toHaveLength(1);
  expect(findings[0].selector).toContain('[data-testid="clip-probe"]');
  expect(findings[0].firstUnreachableText).toBe('UNREACHABLE-TEXT');
  expect(findings[0].hiddenPx).toBeGreaterThan(300);
});

test('data-clip-ok carrying a reason suppresses the finding', async ({ page }) => {
  await page.setContent(box('data-clip-ok="reviewed: intentional"'));
  expect(await findClippedContent(page)).toHaveLength(0);
});

test('an empty data-clip-ok does not suppress the finding', async ({ page }) => {
  await page.setContent(box('data-clip-ok=""'));
  expect(await findClippedContent(page)).toHaveLength(1);
});
