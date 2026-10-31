import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard: no two files in one directory may differ only by case.
 *
 * The class: a pure module and the component that renders it share a stem and
 * differ in a capital — `statusSlot.ts` beside `StatusSlot.tsx`. On Linux, where
 * CI runs, they are two files and everything resolves. On a case-insensitive
 * filesystem (macOS APFS by default, Windows) TypeScript sees one path, the
 * component import resolves to the resolver, and `make pre-push` fails with
 * TS1149 / TS1261 on the developer's machine only. `forceConsistentCasingInFileNames`
 * does not catch it — that option guards one file imported under two spellings,
 * not two files whose names collide.
 *
 * So CI is structurally blind to this and a green pipeline proves nothing about
 * it. This test runs on every platform and fails at the moment the second file is
 * created. It walks the tree rather than relying on the module graph because the
 * collision is a property of the directory, not of any import.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, '..');

/**
 * Two collisions are checked, because two different things resolve a name:
 *
 * 1. The filesystem: any two entries (file or directory) whose FULL names match
 *    case-insensitively are one entry on APFS/NTFS.
 * 2. The module resolver: two script FILES whose stems match case-insensitively —
 *    `import './StatusSlot'` probes `.ts`, `.tsx`, `.js`, `.jsx` in turn, so
 *    `statusSlot.ts` and `StatusSlot.tsx` are the same specifier even though their
 *    full names differ, and that is the one TS1149/TS1261 reports.
 *
 * A script file beside a same-stem DIRECTORY (`router.tsx` + `router/`) is
 * deliberately not flagged: the names differ on disk and TypeScript tries file
 * extensions before a directory index, so it resolves the same way everywhere.
 */
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });
  const byFullName = new Map<string, string>();
  const byStem = new Map<string, string>();
  const at = relative(SRC_ROOT, dir) || '.';
  for (const entry of entries) {
    const full = entry.name.toLowerCase();
    const priorFull = byFullName.get(full);
    if (priorFull !== undefined) yield `${at}: ${priorFull} ↔ ${entry.name}`;
    byFullName.set(full, entry.name);

    if (entry.isFile() && SCRIPT_EXT.test(entry.name)) {
      const stem = entry.name.replace(SCRIPT_EXT, '').toLowerCase();
      const priorStem = byStem.get(stem);
      if (priorStem !== undefined && priorStem.toLowerCase() !== full) {
        yield `${at}: ${priorStem} ↔ ${entry.name}`;
      }
      byStem.set(stem, entry.name);
    }
    if (entry.isDirectory()) yield* walk(join(dir, entry.name));
  }
}

describe('file casing', () => {
  it('no two entries under src/ differ only by case', () => {
    const collisions = [...walk(SRC_ROOT)];
    expect(
      collisions,
      `case-only filename collisions (break on case-insensitive filesystems):\n${collisions.join('\n')}`,
    ).toEqual([]);
  });
});
