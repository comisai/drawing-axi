// The sheet cache seen from outside: commands keep what they read under the
// user's cache folder, read it back on the next command on the same file,
// and never serve a sheet for a file that has changed.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SheetCache } from '../../src/drawing/cache.ts';
import type { Sheet } from '../../src/drawing/model.ts';
import { oddDrawing, sampleDrawing } from '../fixtures/sample.ts';
import { body, rowsOf, runBinary, sampleSheet, tempDir } from '../helpers.ts';

const entries = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sheet')) : [];

const folder = () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'plan.pdf'), sampleDrawing());
  return dir;
};

const layerNames = (stdout: string) =>
  rowsOf(body(stdout), 'layers').map((r) => r.layer);

describe('Cache: between commands', () => {
  it('keeps the sheet under ~/.cache/drawing-axi, private to the user', async () => {
    const dir = folder();
    const first = await runBinary(['layers', 'plan.pdf'], dir);
    assert.equal(first.code, 0, first.stdout);
    const cache = join(dir, '.cache', 'drawing-axi');
    assert.equal(entries(cache).length, 1);
    assert.equal(statSync(cache).mode & 0o777, 0o700);
    assert.equal(
      statSync(join(cache, entries(cache)[0] as string)).mode & 0o777,
      0o600,
    );
    // The next command reads the same sheet back and says the same.
    const second = await runBinary(['layers', 'plan.pdf'], dir);
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.stderr, '');
    assert.equal(entries(cache).length, 1);
  });

  it('reads the kept sheet instead of the PDF', async () => {
    // A sheet kept for this file with one layer renamed: the command shows
    // the kept name, so it read the cache.
    const dir = folder();
    const cache = SheetCache.at(join(dir, '.cache', 'drawing-axi'));
    assert.ok(cache);
    const sheet: Sheet = sampleSheet();
    const layer = sheet.layers.find((l) => l.name === 'SEWER');
    assert.ok(layer);
    layer.name = 'KEPT-SEWER';
    cache.put(cache.keyOf(sampleDrawing(), 1), sheet);
    const r = await runBinary(['layers', 'plan.pdf'], dir);
    assert.ok(layerNames(r.stdout).includes('KEPT-SEWER'), r.stdout);
  });

  it('reads the file again when it changes', async () => {
    const dir = folder();
    const before = await runBinary(['info', 'plan.pdf'], dir);
    assert.match(before.stdout, /page: 1 of 2/);
    writeFileSync(join(dir, 'plan.pdf'), oddDrawing());
    const after = await runBinary(['info', 'plan.pdf'], dir);
    assert.notEqual(after.stdout, before.stdout);
    const fresh = await runBinary(['info', 'plan.pdf'], dir, {
      DRAWING_AXI_CACHE: 'off',
    });
    assert.equal(after.stdout, fresh.stdout);
    assert.equal(entries(join(dir, '.cache', 'drawing-axi')).length, 2);
  });

  it('keeps each page apart', async () => {
    const dir = folder();
    const one = await runBinary(['info', 'plan.pdf'], dir);
    const two = await runBinary(['info', 'plan.pdf', '--page', '2'], dir);
    assert.match(one.stdout, /page: 1 of 2/);
    assert.match(two.stdout, /page: 2 of 2/);
    assert.equal(entries(join(dir, '.cache', 'drawing-axi')).length, 2);
  });

  it('writes nothing with DRAWING_AXI_CACHE=off', async () => {
    const dir = folder();
    const r = await runBinary(['layers', 'plan.pdf'], dir, {
      DRAWING_AXI_CACHE: 'off',
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(existsSync(join(dir, '.cache')), false);
  });

  it('uses the folder DRAWING_AXI_CACHE names', async () => {
    const dir = folder();
    const named = join(tempDir(), 'sheets');
    const r = await runBinary(['layers', 'plan.pdf'], dir, {
      DRAWING_AXI_CACHE: named,
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(entries(named).length, 1);
    assert.equal(existsSync(join(dir, '.cache')), false);
  });

  it('is named in the help', async () => {
    const r = await runBinary(['--help'], folder());
    assert.match(String(body(r.stdout).settings), /DRAWING_AXI_CACHE/);
  });

  it('refuses a relative DRAWING_AXI_CACHE as a usage error', async () => {
    const dir = folder();
    const r = await runBinary(['layers', 'plan.pdf'], dir, {
      DRAWING_AXI_CACHE: 'sheets',
    });
    assert.equal(r.code, 2);
    assert.equal(body(r.stdout).code, 'usage');
    assert.equal(r.stderr, '');
  });

  it('still answers when the cache folder cannot be made', async () => {
    const dir = folder();
    // ~/.cache is a file, so no folder can be made in it.
    writeFileSync(join(dir, '.cache'), 'not a folder');
    const r = await runBinary(['layers', 'plan.pdf'], dir);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.stderr, '');
  });

  it('still answers when the cache folder cannot be written', async () => {
    const dir = folder();
    const cache = join(dir, '.cache', 'drawing-axi');
    mkdirSync(join(dir, '.cache'));
    mkdirSync(cache, { mode: 0o500 });
    const r = await runBinary(['layers', 'plan.pdf'], dir);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.stderr, '');
  });

  it('reads the PDF again when the kept sheet is damaged', async () => {
    const dir = folder();
    const first = await runBinary(['layers', 'plan.pdf'], dir);
    const cache = join(dir, '.cache', 'drawing-axi');
    const entry = join(cache, entries(cache)[0] as string);
    writeFileSync(entry, 'damaged');
    const second = await runBinary(['layers', 'plan.pdf'], dir);
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.stderr, '');
    // And keeps a good copy again.
    assert.ok(statSync(entry).size > 100);
  });
});
