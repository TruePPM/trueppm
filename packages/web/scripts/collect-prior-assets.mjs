/**
 * Selects and copies the previous release's hashed assets into a staging
 * directory for the web image's serve stage (ADR-1249, #4341).
 *
 * Runs at image build time inside packages/web/Dockerfile's `prev-assets`
 * stage, against the prior image's filesystem bind-mounted read-only. Nothing
 * from the prior image is executed: this script only reads its files.
 *
 * Which files: the ones the prior image's OWN `asset-manifest.json` names.
 * Copying its whole `assets/` instead would carry N-2, N-3, ... forward
 * forever, because every image built this way already holds its predecessor's
 * files too. An image built before ADR-1249 has no manifest (0.4.0-beta.6 and
 * beta.7 predate !2965). For that case only, its whole `assets/` is taken,
 * which is still exactly one release: such an image only ever held its own
 * build.
 *
 * Every selected name must be a plain relative path under `assets/` and a
 * regular file (not a symlink, not a directory). Anything else throws, so a
 * malformed or hostile manifest fails the build instead of writing outside
 * the staging directory or being quietly skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * True for a normalized relative path under `assets/` with no `.`/`..`
 * segments, empty segments, backslashes or NUL bytes.
 *
 * @param {unknown} p Candidate path from a manifest or a directory listing.
 * @returns {boolean}
 */
export function isSafeAssetPath(p) {
  if (typeof p !== 'string' || !p.startsWith('assets/')) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return path.posix.normalize(p) === p;
}

/**
 * Collects every string beginning `assets/` anywhere in a Vite manifest. Matching
 * the value rather than specific keys (`file`, `css`, `assets`) survives a
 * manifest-shape change, the same choice scripts/check-served-assets.sh makes.
 *
 * @param {unknown} manifest Parsed `asset-manifest.json`.
 * @returns {string[]} Deduplicated paths, in first-seen order.
 */
export function manifestAssetPaths(manifest) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.startsWith('assets/')) found.add(v);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(manifest);
  return [...found];
}

/**
 * Copies the prior release's assets from `htmlRoot` into `dest/assets/`.
 *
 * @param {object} opts
 * @param {string} opts.htmlRoot The prior image's nginx html root.
 * @param {string} opts.dest Staging directory; `assets/` is created inside it.
 * @param {string} opts.label Name of the prior image, for messages.
 * @returns {{count: number, source: 'manifest' | 'directory'}}
 */
export function collectPriorAssets({ htmlRoot, dest, label }) {
  const assetsDir = path.join(htmlRoot, 'assets');
  const dirStat = fs.lstatSync(assetsDir, { throwIfNoEntry: false });
  if (!dirStat) throw new Error(`${label} has no assets/ directory`);
  if (!dirStat.isDirectory()) throw new Error(`assets/ in ${label} is not a plain directory`);
  // Symlinks resolve against THIS build container's root, not the mounted
  // prior image, so a link anywhere on the path could read files from outside
  // the prior assets/. Every source must resolve inside it.
  const assetsReal = fs.realpathSync(assetsDir);

  const manifestFile = path.join(htmlRoot, 'asset-manifest.json');
  let names;
  let source;
  if (fs.existsSync(manifestFile)) {
    names = manifestAssetPaths(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
    source = 'manifest';
  } else {
    names = fs.readdirSync(assetsDir).map((f) => `assets/${f}`);
    source = 'directory';
  }
  if (names.length === 0) throw new Error(`${label} names no prior assets`);

  // Validate every name before copying any, so a bad entry leaves no partial
  // staging directory behind.
  for (const n of names) {
    if (!isSafeAssetPath(n)) throw new Error(`refusing unsafe asset path ${JSON.stringify(n)}`);
    const st = fs.lstatSync(path.join(htmlRoot, n), { throwIfNoEntry: false });
    if (!st) throw new Error(`${label} lists ${n} but does not contain it`);
    if (!st.isFile()) throw new Error(`${n} in ${label} is not a regular file`);
    if (!fs.realpathSync(path.join(htmlRoot, n)).startsWith(assetsReal + path.sep)) {
      throw new Error(`${n} in ${label} resolves outside its assets/`);
    }
  }
  for (const n of names) {
    const target = path.join(dest, n);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(htmlRoot, n), target);
  }
  return { count: names.length, source };
}

function main() {
  const [htmlRoot, dest] = process.argv.slice(2);
  const label = process.env.PREV_WEB_IMAGE ?? '';
  fs.mkdirSync(path.join(dest, 'assets'), { recursive: true });
  if (!label) {
    console.log('prior-assets: PREV_WEB_IMAGE empty, building with no prior assets');
    return 0;
  }
  try {
    const { count, source } = collectPriorAssets({ htmlRoot, dest, label });
    const how =
      source === 'manifest'
        ? 'named by its asset-manifest.json'
        : 'its whole assets/ (no asset-manifest.json: built before ADR-1249)';
    console.log(`prior-assets: kept ${count} files from ${label}, ${how}`);
    return 0;
  } catch (err) {
    console.error(`prior-assets: ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
