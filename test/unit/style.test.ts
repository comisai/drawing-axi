// Line styles: how a stroke's width and dash are read, named and picked, and
// how a sheet in greys is recognised.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inkOf,
  inkText,
  pickLayer,
  pickLayers,
  strokesOf,
} from '../../src/commands/common.ts';
import { readSheet } from '../../src/drawing/extract.ts';
import {
  isGrey,
  type Sheet,
  type Stroke,
  styleText,
} from '../../src/drawing/model.ts';
import { PdfDocument } from '../../src/pdf/document.ts';
import { buildPdf, Content } from '../fixtures/pdf.ts';

const read = (content: Content): Sheet =>
  readSheet(
    PdfDocument.open(buildPdf([{ width: 400, height: 300, content }])),
    0,
  );

const stroke = (over: Partial<Stroke>): Stroke => ({
  layer: -1,
  color: 0x666666,
  width: 0.7,
  dash: '',
  pts: [0, 0, 100, 0],
  ...over,
});

describe('reading a line style', () => {
  it('keeps the dash pattern in points on the sheet, and solid as empty', () => {
    const c = new Content()
      .grey(0.4, 0.35)
      .dash([6, 3])
      .line(10, 10, 200, 10)
      .dash([0, 0])
      .line(10, 20, 200, 20)
      .dash()
      .line(10, 30, 200, 30);
    // Drawn at twice the size: the pattern and the width double with it.
    c.ops.push({ kind: 'raw', text: '2 0 0 2 0 0 cm [1.5 0.5 0 0.5] 0 d' });
    c.line(10, 20, 90, 20);
    const sheet = read(c);
    assert.deepEqual(
      sheet.strokes.map((s) => s.dash),
      ['6-3', '', '', '3-1-0-1'],
    );
    assert.deepEqual(
      sheet.strokes.map((s) => styleText(s)),
      ['w0.35 dash6-3', 'w0.35 solid', 'w0.35 solid', 'w0.70 dash3-1-0-1'],
    );
  });

  it('reads a dash with a negative length as a solid line', () => {
    const c = new Content().grey(0, 1);
    c.ops.push({ kind: 'raw', text: '[-4 2] 0 d' });
    c.line(10, 10, 200, 10);
    const sheet = read(c);
    assert.equal(sheet.strokes[0]?.dash, '');
  });
});

describe('picking a line style', () => {
  const sheet = {
    layers: [
      { name: 'PIPE', hidden: false },
      { name: 'A w1.00', hidden: false },
      { name: 'B+C', hidden: false },
    ],
    strokes: [
      stroke({}),
      stroke({ width: 0.35, dash: '6-3' }),
      stroke({ width: 0.35, dash: '1-2' }),
      stroke({ color: 0, width: 0.5 }),
      stroke({ layer: 0, width: 0.25 }),
      stroke({ layer: 2, width: 0.25, dash: '6-3' }),
    ],
  } as unknown as Sheet;
  const count = (spec: string) =>
    strokesOf(sheet, pickLayer(sheet, spec)).length;

  it('takes a style as layers --by style names it, or any part of it', () => {
    assert.equal(count('(no layer)@#666666 w0.70 solid'), 1);
    assert.equal(count('(no layer)@#666666 w0.35 dash6-3'), 1);
    assert.equal(count('(no layer)@#666666 w0.35'), 2);
    assert.equal(count('(no layer)@#666666 dashed'), 2);
    assert.equal(count('(no layer) solid'), 2);
    assert.equal(count('(no layer) w0.5'), 1);
    assert.equal(count('(no layer)@#666666 solid w0.70'), 1);
    assert.equal(count('PIPE w0.25 SOLID'), 1);
    assert.equal(count('(no layer)'), 4);
  });

  it('finds a layer whose own name looks like a style by that name', () => {
    assert.deepEqual(pickLayer(sheet, 'A w1.00'), {
      layer: 1,
      name: 'A w1.00',
      color: null,
      width: null,
      dash: null,
    });
  });

  it('joins styled layers with +, and keeps a plus inside a name', () => {
    const picks = pickLayers(sheet, 'B+C w0.25 dash6-3+PIPE w0.25');
    assert.deepEqual(
      picks.map((p) => [p.name, p.width, p.dash]),
      [
        ['B+C', 25, '6-3'],
        ['PIPE', 25, null],
      ],
    );
  });

  it('names an unknown layer when the style is not one it reads', () => {
    assert.throws(
      () => pickLayer(sheet, '(no layer)@#666666 w-1'),
      /no layer named/,
    );
  });
});

describe('a sheet in greys', () => {
  it('knows a grey within a few steps of even', () => {
    assert.equal(isGrey(0x7a7a7a), true);
    assert.equal(isGrey(0x7c7a7b), true);
    assert.equal(isGrey(0x0000ff), false);
  });

  it('says all greys, almost all greys, or how many colours', () => {
    const long = [0, 0, 1000, 0];
    const short = [0, 0, 10, 0];
    assert.equal(
      inkText(inkOf([stroke({}), stroke({ color: 0 })])),
      'all greys (2 shades)',
    );
    const almost = inkOf([
      stroke({ pts: long }),
      stroke({ color: 0x0000ff, pts: short }),
    ]);
    assert.equal(almost.greyscale, true);
    assert.equal(
      inkText(almost),
      'almost all greys (99% of the ink, in 1 shade; 1 other colour)',
    );
    const colour = inkOf([
      stroke({ pts: short }),
      stroke({ color: 0xff0000, pts: long }),
    ]);
    assert.equal(colour.greyscale, false);
    assert.equal(inkText(colour), '2 colours, 1 of them grey');
  });
});
