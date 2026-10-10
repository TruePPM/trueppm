import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPriorAssets,
  isSafeAssetPath,
  manifestAssetPaths,
} from './collect-prior-assets.mjs';

let tmp;
let root;
let dest;

function write(rel, body = 'x') {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

const staged = () => fs.readdirSync(path.join(dest, 'assets')).sort();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-assets-'));
  root = path.join(tmp, 'html');
  dest = path.join(tmp, 'out');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('isSafeAssetPath', () => {
  it.each([
    ['assets/index-AAA.js', true],
    ['assets/fonts/inter-BBB.woff2', true],
    ['assets/../index.html', false],
    ['assets/./x.js', false],
    ['assets//x.js', false],
    ['/assets/x.js', false],
    ['/etc/passwd', false],
    ['index.html', false],
    ['assets/x\\..\\y.js', false],
    ['assets/x\0.js', false],
    [42, false],
  ])('%j -> %s', (p, ok) => {
    expect(isSafeAssetPath(p)).toBe(ok);
  });
});

describe('manifestAssetPaths', () => {
  it('collects file, css[] and assets[] values and ignores bare chunk names', () => {
    const manifest = {
      'src/main.tsx': {
        file: 'assets/index-A.js',
        css: ['assets/index-C.css'],
        imports: ['_x.js'],
      },
      'src/Lazy.tsx': {
        file: 'assets/Lazy-D.js',
        assets: ['assets/Icon-E.svg', 'assets/index-C.css'],
      },
    };
    expect(manifestAssetPaths(manifest)).toEqual([
      'assets/index-A.js',
      'assets/index-C.css',
      'assets/Lazy-D.js',
      'assets/Icon-E.svg',
    ]);
  });
});

describe('collectPriorAssets', () => {
  it('copies only the files the prior asset-files.json lists, not inherited N-2 files', () => {
    write('assets/index-N1.js');
    write('assets/Lazy-N1.js');
    write('assets/index-N2.js'); // carried by the prior image from ITS predecessor
    write(
      'asset-files.json',
      JSON.stringify({ files: ['assets/Lazy-N1.js', 'assets/index-N1.js'] }),
    );
    expect(collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toEqual({
      count: 2,
      source: 'list',
    });
    expect(staged()).toEqual(['Lazy-N1.js', 'index-N1.js']);
  });

  it('keeps the worker chunk the Vite manifest omits', () => {
    write('assets/index-N1.js');
    write('assets/cpmWorker-N1.js');
    // Vite's manifest never names the `new Worker(new URL(...))` chunk.
    write(
      'asset-manifest.json',
      JSON.stringify({ 'src/main.tsx': { file: 'assets/index-N1.js' } }),
    );
    write(
      'asset-files.json',
      JSON.stringify({ files: ['assets/cpmWorker-N1.js', 'assets/index-N1.js'] }),
    );
    collectPriorAssets({ htmlRoot: root, dest, label: 'prev' });
    expect(staged()).toEqual(['cpmWorker-N1.js', 'index-N1.js']);
  });

  it('falls back to the whole assets/ when the prior image predates ADR-1249', () => {
    write('assets/index-B6.js');
    write('assets/index-B6.css');
    // beta.6 shape: no asset-files.json (and, there, no manifest either).
    expect(collectPriorAssets({ htmlRoot: root, dest, label: 'beta.6' })).toEqual({
      count: 2,
      source: 'directory',
    });
    expect(staged()).toEqual(['index-B6.css', 'index-B6.js']);
  });

  it('never writes outside assets/: index.html and other root files stay behind', () => {
    write('index.html', '<html>');
    write('assets/index-A.js');
    write('asset-files.json', JSON.stringify({ m: { file: 'assets/index-A.js' } }));
    collectPriorAssets({ htmlRoot: root, dest, label: 'prev' });
    expect(fs.readdirSync(dest)).toEqual(['assets']);
  });

  it('rejects a listed entry that traverses out of assets/, copying nothing', () => {
    write('assets/index-A.js');
    write('secret.txt');
    write(
      'asset-files.json',
      JSON.stringify({ m: { file: 'assets/index-A.js', css: ['assets/../secret.txt'] } }),
    );
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /unsafe asset path/,
    );
    expect(fs.existsSync(path.join(dest, 'assets', 'index-A.js'))).toBe(false);
  });

  it('rejects a symlink in the prior assets/', () => {
    write('outside.txt');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'assets', 'link.js'));
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /not a regular file/,
    );
  });

  it('rejects a file reached through a symlinked directory', () => {
    write('elsewhere/secret.js');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'assets', 'sub'));
    write('asset-files.json', JSON.stringify({ m: { file: 'assets/sub/secret.js' } }));
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /resolves outside its assets/,
    );
  });

  it('rejects an assets/ that is itself a symlink', () => {
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    write('elsewhere/x.js');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'assets'));
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /not a plain directory/,
    );
  });

  it('fails when asset-files.json lists a file the image does not contain', () => {
    write('asset-files.json', JSON.stringify({ m: { file: 'assets/gone-Z.js' } }));
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /does not contain it/,
    );
  });

  it('fails rather than passing vacuously when nothing is named', () => {
    write('asset-files.json', '{}');
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /names no prior assets/,
    );
  });

  it('fails when the prior image has no assets/ at all', () => {
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    expect(() => collectPriorAssets({ htmlRoot: root, dest, label: 'prev' })).toThrow(
      /no assets\/ directory/,
    );
  });
});
