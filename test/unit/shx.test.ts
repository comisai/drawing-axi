// Stroke-font text: control codes, Hebrew typed on Latin keys, digits stored
// back to front, DOS Hebrew, and the Latin text that must be left alone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Label } from '../../src/drawing/model.ts';
import {
  controlCodes,
  decodeLabels,
  visualToLogical,
} from '../../src/drawing/shx.ts';

const HEBREW_SHEET = [
  'mbr, nho erho',
  'mbr, chuc',
  'eupx, cheur,',
  'njxuo rhmpv',
];

/** Decode labels as they would be on a sheet that uses a Hebrew stroke font. */
function decode(raws: string[], context: string[] = HEBREW_SHEET): string[] {
  const labels: Label[] = [...context, ...raws].map((raw) => ({
    text: '',
    raw,
    source: 'shx',
    layer: -1,
    x0: 0,
    y0: 0,
    x1: 10,
    y1: 10,
    vertical: false,
  }));
  decodeLabels(labels);
  return labels.slice(context.length).map((l) => l.text);
}

describe('stroke-font text', () => {
  it('turns control codes into the signs they draw', () => {
    assert.equal(controlCodes('%%C110'), 'Ø110');
    assert.equal(controlCodes('%%c200-1%'), 'Ø200-1%');
    assert.equal(controlCodes('45%%d'), '45°');
    assert.equal(controlCodes('%%p0.5'), '±0.5');
    assert.equal(controlCodes('%%uTITLE%%u'), 'TITLE');
    assert.equal(controlCodes('100%%%'), '100%');
    assert.equal(controlCodes('%%065'), 'A');
  });

  it('reads Hebrew typed on Latin keys', () => {
    assert.deepEqual(
      decode(['mbr, nho erho', 'nert', 'r/d/', 'nxw', 'ebwwn', 'kghui']),
      ['צנרת מים קרים', 'מקרא', 'ר.ג.', "מס'", 'קנ"מ', 'לעיון'],
    );
  });

  it('puts digits and Latin letters inside Hebrew back in reading order', () => {
    assert.deepEqual(
      decode([
        'p,j 02X002 x"n',
        'cehcuk, 0063 khyr',
        'nprhs auni 1M',
        'cnhsu, 002X051X003 x"n',
      ]),
      [
        'פתח 200X20 ס"מ',
        'בקיבולת 3600 ליטר',
        'מפריד שומן M1',
        'במידות 300X150X200 ס"מ',
      ],
    );
  });

  it('turns brackets and inch marks the way the sheet shows them', () => {
    assert.deepEqual(
      decode([
        'mbr, nho fcuh ta )F(',
        'gns, fcuh ta )c/a/"2+dkdkui(',
        'bphkv n-n/r/"4\\"8',
        'crz arhpv "2',
      ]),
      [
        'צנרת מים כבוי אש (F)',
        'עמדת כבוי אש (ב.ש.2"+גלגלון)',
        'נפילה מ-מ.ר.8"\\4"',
        'ברז שריפה 2"',
      ],
    );
  });

  it('leaves Latin text alone on a Hebrew sheet', () => {
    const latin = [
      'l=15.90',
      '-l=12.50-',
      "E'Mail",
      'office@example.com',
      'S=100/50 L=12m',
      'o.k.=10.00',
      'CW1-%%C3"',
      'F-%%C3"',
      'PLAN-A 100',
      '200x20',
    ];
    assert.deepEqual(
      decode(latin),
      latin.map((s) => controlCodes(s)),
    );
  });

  it('decodes nothing on a sheet with no Hebrew stroke font', () => {
    const english = [
      'sanitary sewer',
      'storm drain',
      'cold water',
      'fire main',
      'see detail',
    ];
    assert.deepEqual(decode(['vent', 'text', ...english], english), [
      'vent',
      'text',
      ...english,
    ]);
  });

  it('reverses Latin text fed to a right-to-left font', () => {
    assert.deepEqual(decode([')EPDH(']), ['(HDPE)']);
  });

  it('reads DOS Hebrew that reached the file as Windows-1252 punctuation', () => {
    // Bytes 97 89 83 85 87 (qof yod dalet vav het) stored in sheet order.
    assert.deepEqual(decode(['1-‡…ƒ‰—']), ['קידוח-1']);
  });

  it('keeps comments people wrote as they are', () => {
    const note: Label = {
      text: '',
      raw: 'check %%C size, mbr,',
      source: 'note',
      layer: -1,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      vertical: false,
    };
    decodeLabels([note]);
    assert.equal(note.text, 'check %%C size, mbr,');
  });

  it('puts text stored in sheet order into reading order', () => {
    assert.equal(visualToLogical('plain text'), 'plain text');
    // "abc 12" in Hebrew letters, stored left to right as the sheet shows it.
    assert.equal(visualToLogical('12 גבא'), 'אבג 12');
    assert.equal(visualToLogical('(\u05d1\u05d0)'), '(\u05d0\u05d1)');
  });
});

it('Stroke-font labels: a Latin system code in brackets after Hebrew words stays Latin', () => {
  const labels = [
    'mbr, nh dav',
    'mbr, chuc kprhs auni',
    'eu xbhev kchuc )o(',
    'eu xbhev knprhs auni )Do(',
  ].map((raw) => ({
    text: raw,
    raw,
    source: 'shx' as const,
    layer: -1,
    x0: 0,
    y0: 0,
    x1: 1,
    y1: 1,
    vertical: false,
  }));
  decodeLabels(labels);
  assert.deepEqual(
    labels.map((l) => l.text),
    [
      '\u05e6\u05e0\u05e8\u05ea \u05de\u05d9 \u05d2\u05e9\u05d4',
      '\u05e6\u05e0\u05e8\u05ea \u05d1\u05d9\u05d5\u05d1 \u05dc\u05e4\u05e8\u05d9\u05d3 \u05e9\u05d5\u05de\u05df',
      '\u05e7\u05d5 \u05e1\u05e0\u05d9\u05e7\u05d4 \u05dc\u05d1\u05d9\u05d5\u05d1 (O)',
      '\u05e7\u05d5 \u05e1\u05e0\u05d9\u05e7\u05d4 \u05dc\u05de\u05e4\u05e8\u05d9\u05d3 \u05e9\u05d5\u05de\u05df (OD)',
    ],
  );
});
