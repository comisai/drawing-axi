import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  buildPdf,
  Content,
  type PageSpec,
  type PdfOptions,
} from '../fixtures/pdf.ts';
import { body, rowsOf, runBinary, tempDir } from '../helpers.ts';

const font = '/Subtype /Type1 /BaseFont /Helvetica';
const numberedFont = `${font} /Encoding << /Differences [1 /MT237 /MT229 /MT236 /MT249 17 /MT65 /MT49] >>`;
const unknownFont = `${font} /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /glyphA /glyphB] >>`;

function labelsPdf(
  content: Content,
  options: PdfOptions,
  comments: PageSpec['comments'] = [],
) {
  return buildPdf([{ width: 250, height: 150, content, comments }], options);
}

async function readLabels(dir: string, pdf: Buffer, ...flags: string[]) {
  writeFileSync(join(dir, 'fixture.pdf'), pdf);
  const result = await runBinary(['labels', 'fixture.pdf', ...flags], dir);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, '');
  return body(result.stdout);
}

it('recovers the legacy Hebrew and ASCII byte values named by the font', async () => {
  const pdf = labelsPdf(
    new Content().text('\x01\x02\x03\x04', 20, 30).text('\x11\x12', 20, 50),
    { font: numberedFont },
  );
  const doc = await readLabels(tempDir(), pdf, '--each', '--full');
  assert.deepEqual(rowsOf(doc, 'labels'), [
    { text: 'שלום', x: 28, y: 26, source: 'text', stored: 'םולש' },
    { text: 'A1', x: 24, y: 46, source: 'text', stored: null },
  ]);
  assert.equal(doc.text_status, undefined);
});

it('uses the font encoding for control mappings and keeps usable ToUnicode mappings', async () => {
  const pdf = labelsPdf(new Content().text('\x11\x01\x02\x03\x04', 20, 30), {
    font: numberedFont,
    toUnicode:
      '4 beginbfchar <01> <0001> <02> <0009> <03> <FFFD> <11> <0058> endbfchar',
  });
  const doc = await readLabels(tempDir(), pdf, '--each');
  assert.deepEqual(rowsOf(doc, 'labels'), [
    { text: 'שלוםX', x: 30, y: 26, source: 'text' },
  ]);
});

it('keeps ordinary text in its declared encoding', async () => {
  const pdf = labelsPdf(new Content().text('Café \x97 forêt', 20, 30), {});
  const doc = await readLabels(tempDir(), pdf, '--each');
  assert.deepEqual(
    rowsOf(doc, 'labels').map((row) => row.text),
    ['Café — forêt'],
  );
});

it('reports unreadable font text even when no label matches', async () => {
  const pdf = labelsPdf(new Content().text('AB', 20, 30), {
    font: unknownFont,
    toUnicode: '2 beginbfchar <41> <0011> <42> <0008> endbfchar',
  });
  const dir = tempDir();
  const doc = await readLabels(
    dir,
    pdf,
    '--each',
    '--full',
    '--save',
    'labels.json',
  );
  assert.deepEqual(rowsOf(doc, 'labels'), []);
  assert.match(
    String(doc.text_status),
    /text not readable in this PDF.*Ask for a PDF/,
  );
  const saved = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  assert.deepEqual(saved.labels, []);
  assert.equal(saved.text_status, doc.text_status);
  const filtered = await readLabels(dir, pdf, '--match', 'A');
  assert.deepEqual(rowsOf(filtered, 'labels'), []);
  assert.equal(filtered.text_status, doc.text_status);
});

it('keeps readable labels and reports text lost to an unknown encoding', async () => {
  const pdf = labelsPdf(
    new Content().text('AB', 20, 30).text('Ø63', 20, 50),
    { font: unknownFont },
    [{ text: 'Ø32', x0: 30, y0: 70, x1: 50, y1: 78 }],
  );
  const doc = await readLabels(tempDir(), pdf, '--sizes');
  assert.deepEqual(
    rowsOf(doc, 'sizes').map((row) => row.size),
    ['Ø32', 'Ø63'],
  );
  assert.match(
    String(doc.text_status),
    /Some font text not readable in this PDF/,
  );
});

it('keeps a page with no font text distinct from a page with unreadable text', async () => {
  const pdf = labelsPdf(new Content().line(10, 10, 100, 100), {});
  const doc = await readLabels(tempDir(), pdf);
  assert.deepEqual(rowsOf(doc, 'labels'), []);
  assert.equal(doc.text_status, undefined);
});

it('does not guess readable ASCII for a composite font with no character map', async () => {
  const pdf = labelsPdf(new Content().text('\x00A\x00B', 20, 30), {
    font: '/Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [<< /Subtype /CIDFontType2 /DW 500 >>]',
  });
  const doc = await readLabels(tempDir(), pdf);
  assert.deepEqual(rowsOf(doc, 'labels'), []);
  assert.match(String(doc.text_status), /text not readable in this PDF/);
});
