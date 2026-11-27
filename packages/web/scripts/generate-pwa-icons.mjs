#!/usr/bin/env node
/**
 * Regenerate the PWA PNG icon set from public/app-icon.svg (ADR-1523 §3).
 *
 * iOS ignores an SVG `apple-touch-icon` (a Home Screen icon then becomes a page
 * screenshot), and the web app manifest needs raster 192/512 icons plus a
 * full-bleed maskable one. The PNGs are committed so the build needs no
 * rasterizer; rerun this only when the SVG changes:
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Rendering uses the Playwright Chromium the repo already pins, so the output is
 * byte-stable on one Playwright version and needs no image library.
 *
 * Two variants:
 * - `any`: the SVG as drawn (rounded square on transparent corners).
 * - full-bleed (`maskable`, `apple-touch-icon`): the corner radius removed so the
 *   platform's own mask (Android adaptive icon, the iOS squircle) never shows a
 *   transparent or white corner. The glyph already sits inside the central 50%,
 *   well within the maskable 80% safe zone.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const svg = readFileSync(resolve(publicDir, 'app-icon.svg'), 'utf-8');
const fullBleed = svg.replace(/\s+rx="\d+"/, '');

const targets = [
  { file: 'pwa-192x192.png', size: 192, source: svg },
  { file: 'pwa-512x512.png', size: 512, source: svg },
  { file: 'pwa-maskable-512x512.png', size: 512, source: fullBleed },
  { file: 'apple-touch-icon.png', size: 180, source: fullBleed },
];

const browser = await chromium.launch();
try {
  for (const { file, size, source } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const sized = source.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${sized}</body></html>`,
    );
    await page.screenshot({
      path: resolve(publicDir, file),
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    await page.close();
    console.log(`wrote public/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
