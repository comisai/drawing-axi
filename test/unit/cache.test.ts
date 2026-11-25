// The sheet cache: a sheet read once is kept, by the file's content, so the
// next command on the same file does not read the PDF again.

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  cacheFolder,
  decodeSheet,
  encodeSheet,
  SheetCache,
} from '../../src/drawing/cache.ts';
import { readSheet } from '../../src/drawing/extract.ts';
import type { Sheet } from '../../src/drawing/model.ts';
import { PdfDocument } from '../../src/pdf/document.ts';
import {
  greyDrawing,
  oddDrawing,
  pictureDrawing,
  sampleDrawing,
} from '../fixtures/sample.ts';
import { sampleSheet, tempDir } from '../helpers.ts';

const sheets = (): Array<[string, Sheet]> => [
  ['the sample sheet', sampleSheet()],
  ['its second page', sampleSheet({}, 1)],
  ['a rotated sheet', sampleSheet({ rotate: 90 })],
  ['an odd sheet', readSheet(PdfDocument.open(oddDrawing()), 0)],
  ['a picture page', readSheet(PdfDocument.open(pictureDrawing()), 0)],
  [
    'a grey sheet with solid and dashed lines',
    readSheet(PdfDocument.open(greyDrawing(200)), 0),
  ],
];

const entries = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith('.sheet'));

describe('Cache: a kept sheet reads back the same', () => {
  for (const [name, sheet] of sheets())
    it(name, () => {
      assert.deepEqual(decodeSheet(encodeSheet(sheet)), sheet);
    });

  it('keeps minus zero, and numbers that are not whole', () => {
    const sheet = sampleSheet();
    const stroke = sheet.strokes[0];
    assert.ok(stroke);
    stroke.pts[0] = -0;
    stroke.pts[1] = 1 / 3;
    stroke.width = 0.1 + 0.2;
    const back = decodeSheet(encodeSheet(sheet));
    assert.ok(back);
    assert.ok(Object.is(back.strokes[0]?.pts[0], -0));
    assert.deepEqual(back, sheet);
  });

  it('keeps the dash pattern of each stroke', () => {
    const sheet = readSheet(PdfDocument.open(greyDrawing(200)), 0);
    const dashes = new Set(sheet.strokes.map((s) => s.dash));
    assert.ok(dashes.size >= 2, 'the grey sheet has solid and dashed lines');
    assert.deepEqual(
      decodeSheet(encodeSheet(sheet))?.strokes.map((s) => s.dash),
      sheet.strokes.map((s) => s.dash),
    );
  });

  it('refuses a damaged or cut entry instead of reading it', () => {
    const data = encodeSheet(sampleSheet());
    assert.equal(decodeSheet(data.subarray(0, data.length - 9)), null);
    assert.equal(decodeSheet(data.subarray(0, 3)), null);
    assert.equal(decodeSheet(new Uint8Array(0)), null);
    const flipped = Uint8Array.from(data);
    const middle = Math.floor(data.length / 2);
    flipped[middle] = (flipped[middle] as number) ^ 0xff;
    assert.equal(decodeSheet(flipped), null);
  });
});

describe('Cache: entries by content, in a folder of the owner', () => {
  const pdf = sampleDrawing();

  it('keeps one entry per file content and page, and reads it back', () => {
    const dir = join(tempDir(), 'cache');
    const cache = SheetCache.at(dir);
    assert.ok(cache);
    const sheet = sampleSheet();
    const key = cache.keyOf(pdf, 1);
    assert.equal(cache.get(key), null);
    cache.put(key, sheet);
    assert.deepEqual(cache.get(key), sheet);
    assert.equal(entries(dir).length, 1);
    // Another page and another file are other entries.
    assert.notEqual(cache.keyOf(pdf, 2), key);
    const changed = Buffer.from(pdf);
    changed[changed.length - 20] = (changed[changed.length - 20] as number) ^ 1;
    assert.notEqual(cache.keyOf(changed, 1), key);
    assert.equal(cache.get(cache.keyOf(changed, 1)), null);
  });

  it('makes the folder and its entries private to the owner', () => {
    const dir = join(tempDir(), 'cache');
    const cache = SheetCache.at(dir);
    assert.ok(cache);
    cache.put(cache.keyOf(pdf, 1), sampleSheet());
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const entry = entries(dir)[0] as string;
    assert.equal(statSync(join(dir, entry)).mode & 0o777, 0o600);
  });

  it('reads an entry that was damaged on disk as missing', () => {
    const dir = join(tempDir(), 'cache');
    const cache = SheetCache.at(dir);
    assert.ok(cache);
    const key = cache.keyOf(pdf, 1);
    cache.put(key, sampleSheet());
    const file = join(dir, entries(dir)[0] as string);
    const data = readFileSync(file);
    data[data.length - 5] = (data[data.length - 5] as number) ^ 0xff;
    writeFileSync(file, data);
    assert.equal(cache.get(key), null);
    // An entry stored under another key's name is not read either.
    const other = cache.keyOf(sampleDrawing({ rotate: 90 }), 1);
    cache.put(other, sampleSheet({ rotate: 90 }));
    writeFileSync(file, readFileSync(join(dir, `${other}.sheet`)));
    assert.equal(cache.get(key), null);
  });

  it('drops the least recently used entries past its size', () => {
    const dir = join(tempDir(), 'cache');
    const one = encodeSheet(sampleSheet()).length;
    const cache = SheetCache.at(dir, { maxBytes: one * 4.5 });
    assert.ok(cache);
    const keys = [1, 2, 3, 4, 5].map((page) => cache.keyOf(pdf, page));
    const sheet = sampleSheet();
    keys.forEach((key, at) => {
      cache.put(key, sheet);
      // Each entry a minute older than the next.
      const when = new Date(Date.now() - (10 - at) * 60_000);
      utimesSync(join(dir, `${key}.sheet`), when, when);
    });
    assert.equal(entries(dir).length, 4);
    assert.equal(cache.get(keys[0] as string), null);
    assert.ok(cache.get(keys[4] as string));
  });

  it('drops entries past its count', () => {
    const dir = join(tempDir(), 'cache');
    const cache = SheetCache.at(dir, { maxEntries: 2 });
    assert.ok(cache);
    for (const page of [1, 2, 3])
      cache.put(cache.keyOf(pdf, page), sampleSheet());
    assert.equal(entries(dir).length, 2);
  });

  it('does not keep a sheet larger than a quarter of its size', () => {
    const dir = join(tempDir(), 'cache');
    const one = encodeSheet(sampleSheet()).length;
    const cache = SheetCache.at(dir, { maxBytes: one * 3 });
    assert.ok(cache);
    cache.put(cache.keyOf(pdf, 1), sampleSheet());
    assert.equal(entries(dir).length, 0);
  });

  it('uses no folder that others may write to, or that is a link', () => {
    const base = tempDir();
    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    assert.equal(SheetCache.at(open), null);
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    assert.equal(SheetCache.at(link), null);
  });

  it('is off when a folder cannot be made there', () => {
    const base = tempDir();
    writeFileSync(join(base, 'file'), 'not a folder');
    assert.equal(SheetCache.at(join(base, 'file', 'cache')), null);
  });
});

describe('Cache: where it is kept', () => {
  it('under the user cache folder, or the one named, or nowhere', () => {
    assert.equal(
      cacheFolder({ HOME: '/home/u' }),
      '/home/u/.cache/drawing-axi',
    );
    assert.equal(
      cacheFolder({ HOME: '/home/u', XDG_CACHE_HOME: '/var/c' }),
      '/var/c/drawing-axi',
    );
    assert.equal(
      cacheFolder({ HOME: '/home/u', DRAWING_AXI_CACHE: '/srv/sheets' }),
      '/srv/sheets',
    );
    for (const off of ['off', 'OFF', '0', 'false', 'no'])
      assert.equal(
        cacheFolder({ HOME: '/home/u', DRAWING_AXI_CACHE: off }),
        null,
      );
    assert.equal(cacheFolder({}), null);
    // A relative folder is not used: it would depend on where a command runs.
    assert.equal(cacheFolder({ XDG_CACHE_HOME: 'rel' }), null);
  });

  it('refuses a relative DRAWING_AXI_CACHE as a usage error', () => {
    assert.throws(
      () => cacheFolder({ HOME: '/home/u', DRAWING_AXI_CACHE: 'sheets' }),
      (e: Error & { code?: string }) => e.code === 'usage',
    );
  });
});
