// The PDF reader: objects, filters, the ways a file indexes its objects, and
// the refusals.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { readSheet } from '../../src/drawing/extract.ts';
import {
  decodeText,
  EncryptedPdf,
  NotPdf,
  PdfDocument,
} from '../../src/pdf/document.ts';
import { decodeStream, UnsupportedFilter } from '../../src/pdf/filters.ts';
import { parseToUnicode } from '../../src/pdf/fonts.ts';
import {
  type Dict,
  isDict,
  Keyword,
  Lexer,
  Name,
  type Obj,
  PdfString,
  Ref,
} from '../../src/pdf/objects.ts';
import {
  buildPdf,
  type Comment,
  Content,
  type PdfOptions,
} from '../fixtures/pdf.ts';
import { sampleDrawing } from '../fixtures/sample.ts';
import { sampleSheet } from '../helpers.ts';

const lex = (text: string, refs = false) =>
  new Lexer(Buffer.from(text, 'latin1')).read(refs);
const str = (o: unknown) =>
  o instanceof PdfString ? Buffer.from(o.bytes).toString('latin1') : null;
const same = (o: Obj) => o;

describe('objects', () => {
  it('reads numbers, names, strings, arrays and dictionaries', () => {
    assert.equal(lex('-12.50'), -12.5);
    assert.equal(lex('.5'), 0.5);
    assert.equal(lex('+7'), 7);
    assert.equal((lex('/A#20B') as Name).name, 'A B');
    assert.equal(str(lex('(a\\(b\\)\\n\\101 (nested))')), 'a(b)\nA (nested)');
    assert.equal(str(lex('<48 65 6C6C 6F>')), 'Hello');
    assert.equal(str(lex('<4>')), '@');
    assert.deepEqual(lex('[1 [2 3] /N]'), [1, [2, 3], new Name('N')]);
    const dict = lex('<< /A 1 /B << /C (x) >> >>');
    assert.ok(isDict(dict));
    assert.equal((dict as Dict).get('A'), 1);
    assert.equal(lex('true'), true);
    assert.equal(lex('null'), null);
  });

  it('reads a reference only when asked to', () => {
    const ref = lex('12 0 R', true);
    assert.ok(ref instanceof Ref);
    assert.equal(ref.num, 12);
    assert.equal(lex('12 0 R'), 12);
    assert.deepEqual(lex('[1 2 3]', true), [1, 2, 3]);
  });

  it('gives operators as keywords and skips comments', () => {
    const l = new Lexer(Buffer.from('% note\n1 0 0 1 5 6 cm BT'));
    const out: unknown[] = [];
    for (let t = l.read(); t !== undefined; t = l.read()) out.push(t);
    assert.equal(out.length, 8);
    assert.equal((out[6] as Keyword).word, 'cm');
    assert.ok(out[7] instanceof Keyword);
  });

  it('refuses nesting deep enough to overflow the stack', () => {
    assert.throws(() => lex('['.repeat(5000)), /nesting is too deep/);
  });
});

describe('filters', () => {
  const dict = (text: string) => lex(text) as Dict;

  it('decodes Flate, with and without a PNG predictor', () => {
    const raw = Buffer.from('hello hello hello');
    assert.equal(
      Buffer.from(
        decodeStream(
          deflateSync(raw),
          dict('<< /Filter /FlateDecode >>'),
          same,
        ),
      ).toString(),
      'hello hello hello',
    );
    // Two rows of three bytes with the Up predictor: 1 2 3, then +1 each.
    const rows = Uint8Array.from([2, 1, 2, 3, 2, 1, 1, 1]);
    assert.deepEqual(
      [
        ...decodeStream(
          deflateSync(rows),
          dict(
            '<< /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 3 >> >>',
          ),
          same,
        ),
      ],
      [1, 2, 3, 2, 3, 4],
    );
  });

  it('decodes ASCIIHex, ASCII85 and RunLength, alone and chained', () => {
    assert.equal(
      Buffer.from(
        decodeStream(
          Buffer.from('48656C6C6F>'),
          dict('<< /Filter /ASCIIHexDecode >>'),
          same,
        ),
      ).toString(),
      'Hello',
    );
    assert.equal(
      Buffer.from(
        decodeStream(
          Buffer.from('87cURD]i,"Ebo80~>'),
          dict('<< /Filter [/ASCII85Decode] >>'),
          same,
        ),
      ).toString(),
      'Hello World!',
    );
    assert.deepEqual(
      [
        ...decodeStream(
          Uint8Array.from([2, 65, 66, 67, 254, 90, 128]),
          dict('<< /Filter /RunLengthDecode >>'),
          same,
        ),
      ],
      [65, 66, 67, 90, 90, 90],
    );
  });

  it('decodes LZW', () => {
    // "-----A---B" from the PDF specification's example.
    const data = Uint8Array.from([
      0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01,
    ]);
    assert.equal(
      Buffer.from(
        decodeStream(data, dict('<< /Filter /LZWDecode >>'), same),
      ).toString(),
      '-----A---B',
    );
  });

  it('names a filter it does not read', () => {
    assert.throws(
      () =>
        decodeStream(Buffer.from(''), dict('<< /Filter /JBIG2Decode >>'), same),
      UnsupportedFilter,
    );
  });
});

describe('document', () => {
  const summary = (buf: Buffer) => {
    const doc = PdfDocument.open(buf);
    const sheet = readSheet(doc, 0);
    return {
      pages: sheet.pages,
      size: [Math.round(sheet.width), Math.round(sheet.height)],
      layers: sheet.layers.map((l) => l.name),
      strokes: sheet.strokes.length,
      fills: sheet.fills.length,
      labels: sheet.labels.map((l) => l.raw).sort(),
      // Geometry to a hundredth of a point, so rotation rounding does not matter.
      ink: sheet.strokes
        .map((s) => s.pts.map((v) => v.toFixed(2)).join(','))
        .sort()
        .slice(0, 50),
    };
  };
  const plain = summary(sampleDrawing());

  it('reads the sample: pages, size, layers, strokes and labels', () => {
    assert.equal(plain.pages, 2);
    assert.deepEqual(plain.size, [1400, 900]);
    assert.equal(plain.layers.length, 9);
    assert.ok(plain.layers.includes('XREF|Walls'));
    assert.ok(plain.strokes > 200);
    assert.equal(plain.fills, 2);
    assert.ok(plain.labels.includes('%%C160-1%'));
    assert.ok(plain.labels.includes('NOTE A'));
  });

  it('reads the same sheet from compressed, packed, rotated and scaled files', () => {
    for (const options of [
      { compress: true },
      { xref: 'stream', compress: true },
      { rotate: 90, origin: [30, 40] },
      { rotate: 180 },
      { rotate: 270, origin: [-10, 5] },
      { userUnit: 2 },
    ] as const) {
      assert.deepEqual(
        summary(sampleDrawing(options as PdfOptions)),
        plain,
        JSON.stringify(options),
      );
    }
  });

  it('rebuilds a broken object table, for both kinds of file', () => {
    for (const xref of ['table', 'stream'] as const) {
      const doc = PdfDocument.open(sampleDrawing({ xref, breakXref: true }));
      assert.equal(doc.rebuilt, true, xref);
      assert.equal(readSheet(doc, 0).strokes.length, plain.strokes, xref);
    }
  });

  it('marks the layer that is switched off', () => {
    const sheet = sampleSheet();
    assert.deepEqual(
      sheet.layers.filter((l) => l.hidden).map((l) => l.name),
      ['OLD'],
    );
  });

  it('refuses an encrypted file and a file that is not a PDF', () => {
    assert.throws(
      () => PdfDocument.open(sampleDrawing({ encrypted: true })),
      EncryptedPdf,
    );
    assert.throws(
      () =>
        PdfDocument.open(sampleDrawing({ xref: 'stream', encrypted: true })),
      EncryptedPdf,
    );
    assert.throws(() => PdfDocument.open(Buffer.from('hello')), NotPdf);
    assert.throws(() => PdfDocument.open(Buffer.alloc(0)), NotPdf);
  });

  it('trusts a stream length only when endstream follows it', () => {
    const good = sampleDrawing().toString('latin1');
    // Declare every content stream ten bytes too short.
    const bad = good.replace(
      /\/Length (\d+)/g,
      (_m, n: string) =>
        `/Length ${String(Number(n) - 10).padStart(n.length, '0')}`,
    );
    assert.equal(bad.length, good.length);
    const sheet = readSheet(PdfDocument.open(Buffer.from(bad, 'latin1')), 0);
    assert.equal(sheet.strokes.length, plain.strokes);
  });

  it('survives a file cut short', () => {
    const whole = sampleDrawing();
    for (const keep of [0.25, 0.5, 0.9]) {
      const cut = whole.subarray(0, Math.floor(whole.length * keep));
      try {
        const doc = PdfDocument.open(cut);
        for (let i = 0; i < doc.pages().length; i++) readSheet(doc, i);
      } catch (error) {
        assert.ok(error instanceof Error, 'fails with an error, not a hang');
      }
    }
  });
});

describe('geometry from a damaged file', () => {
  const page = (content: Content, comments: Comment[] = [], width = 400) =>
    readSheet(
      PdfDocument.open(buildPdf([{ width, height: 300, content, comments }])),
      0,
    );

  it('drops strokes and labels far outside the sheet, and says so', () => {
    const content = new Content()
      .pen(0, 1)
      .line(10, 10, 200, 10)
      .line(10, 20, 1e9, 20)
      .line(-5000, 30, 100, 30);
    const sheet = page(content, [
      { text: 'near', x0: 20, y0: 40, x1: 60, y1: 52 },
      { text: 'far', x0: 20, y0: 60, x1: 1e15, y1: 72 },
      { text: 'huge', x0: 0, y0: 0, x1: 399, y1: 299 },
      { text: 'wide', x0: -100, y0: 80, x1: 380, y1: 92 },
    ]);
    assert.equal(sheet.strokes.length, 1);
    assert.deepEqual(
      sheet.labels.map((l) => l.raw),
      ['near', 'huge'],
    );
    assert.deepEqual(sheet.skipped, ['4 items far outside the sheet']);
  });

  it('refuses a page whose size is not usable', () => {
    assert.throws(
      () => page(new Content().line(0, 0, 1, 1), [], 1e9),
      /page size is not usable/,
    );
  });
});

describe('text', () => {
  it('decodes PDFDocEncoding, UTF-16 and UTF-8 text strings', () => {
    assert.equal(decodeText(Uint8Array.from([0x41, 0x84, 0x42])), 'A—B');
    assert.equal(
      decodeText(Uint8Array.from([0xfe, 0xff, 0x05, 0xd0, 0x00, 0x41])),
      'אA',
    );
    assert.equal(
      decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0xd7, 0x90])),
      'א',
    );
  });

  it('reads bfchar and bfrange from a ToUnicode map', () => {
    const map = parseToUnicode(
      Buffer.from(
        '1 beginbfchar <0003> <0041> endbfchar\n' +
          '2 beginbfrange <0010> <0012> <05D0> <0020> <0021> [<0058> <0059>] endbfrange',
      ),
    );
    assert.equal(map.get(3), 'A');
    assert.equal(map.get(0x11), 'ב');
    assert.equal(map.get(0x21), 'Y');
  });
});

it('Joined sheets: a page that names its layers only in its own resources keeps them', () => {
  const joined = readSheet(
    PdfDocument.open(sampleDrawing({ noCatalogLayers: true })),
    0,
  );
  const plain = readSheet(PdfDocument.open(sampleDrawing()), 0);
  const names = (sheet: typeof plain) =>
    [...new Set(sheet.strokes.map((s) => sheet.layers[s.layer]?.name))].sort();
  assert.deepEqual(names(joined), names(plain));
  assert.ok(names(joined).includes('SEWER'));
  assert.equal(
    joined.strokes.filter((s) => s.layer < 0).length,
    plain.strokes.filter((s) => s.layer < 0).length,
  );
});
