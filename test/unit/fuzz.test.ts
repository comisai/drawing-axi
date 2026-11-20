// A drawing comes from outside, so a damaged or hostile file must end in one
// of the reader's own errors, quickly. This damages the sample in fixed,
// repeatable ways and reads every result through the whole pipeline.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  DeadlinePassed,
  DrawingTooLarge,
  readSheet,
} from '../../src/drawing/extract.ts';
import { readLegend } from '../../src/drawing/legend.ts';
import { buildRuns, segmentsOf } from '../../src/drawing/runs.ts';
import { ScaleUnknown, sheetScale } from '../../src/drawing/scale.ts';
import { sizeLabels, sizeRuns } from '../../src/drawing/sizes.ts';
import { findTags } from '../../src/drawing/tags.ts';
import { EncryptedPdf, NotPdf, PdfDocument } from '../../src/pdf/document.ts';
import { UnsupportedFilter } from '../../src/pdf/filters.ts';
import { PdfSyntaxError } from '../../src/pdf/objects.ts';
import { sampleDrawing } from '../fixtures/sample.ts';

const ROUNDS = 240;
const SLOW_MS = 3000;

it('Damaged files: every one ends in a known error or a sheet, and none is slow', () => {
  // A fixed generator, so a failure names a round that fails again.
  let seed = 20261120;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const at = (length: number) => Math.floor(random() * length);
  const bases = [
    sampleDrawing(),
    sampleDrawing({ compress: true }),
    sampleDrawing({ xref: 'stream', compress: true }),
    sampleDrawing({ rotate: 90 }),
  ];
  const outcomes = { read: 0, refused: 0 };
  for (let round = 0; round < ROUNDS; round++) {
    const buf = Buffer.from(bases[round % bases.length] as Buffer);
    const way = round % 5;
    let data: Buffer = buf;
    if (way === 0) {
      // Flip a few bytes anywhere.
      for (let k = 0; k <= at(8); k++) buf[at(buf.length)] = at(256);
    } else if (way === 1) {
      // Overwrite a stretch with one byte: long runs of one digit make absurd numbers.
      const from = at(buf.length);
      buf.fill(at(256), from, Math.min(buf.length, from + at(200)));
    } else if (way === 2) {
      // Copy one stretch over another.
      const from = at(buf.length);
      buf.copy(buf, at(buf.length), from, Math.min(buf.length, from + at(400)));
    } else if (way === 3) {
      // Change digits and delimiters, keeping the file mostly well formed.
      for (let k = 0; k < 6; k++) {
        const i = at(buf.length);
        const c = buf[i] as number;
        if (c >= 48 && c <= 57) buf[i] = 48 + at(10);
        else if ('<>[]()/'.includes(String.fromCharCode(c)))
          buf[i] = '<>[]()/ '.charCodeAt(at(8));
      }
    } else {
      // Cut the file short.
      data = buf.subarray(0, at(buf.length));
    }
    const started = performance.now();
    try {
      const doc = PdfDocument.open(data);
      for (let p = 0; p < Math.min(3, doc.pages().length); p++) {
        const sheet = readSheet(doc, p, { deadline: Date.now() + SLOW_MS });
        try {
          sheetScale(sheet);
        } catch (error) {
          if (!(error instanceof ScaleUnknown)) throw error;
        }
        const runs = buildRuns(segmentsOf(sheet.strokes), {
          gap: 22,
          letterGap: 44,
          letters: sheet.labels.map((l) => ({
            x: (l.x0 + l.x1) / 2,
            y: (l.y0 + l.y1) / 2,
          })),
        });
        sizeRuns(
          runs.map((r) => ({ ...r, group: 0 })),
          sizeLabels(sheet.labels),
          { reach: 4 },
        );
        readLegend(sheet.strokes, sheet.labels, {
          gap: 22,
          minSample: 11,
          maxSample: 170,
          reach: 311,
          aligned: true,
        });
        findTags(sheet.labels);
      }
      outcomes.read++;
    } catch (error) {
      assert.ok(
        error instanceof PdfSyntaxError ||
          error instanceof NotPdf ||
          error instanceof EncryptedPdf ||
          error instanceof UnsupportedFilter ||
          error instanceof DrawingTooLarge ||
          error instanceof DeadlinePassed,
        `round ${round}, way ${way}: ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`,
      );
      outcomes.refused++;
    }
    const took = performance.now() - started;
    assert.ok(
      took < SLOW_MS,
      `round ${round}, way ${way} took ${Math.round(took)} ms`,
    );
  }
  // The damage is real: some files are refused, and some still read.
  assert.ok(outcomes.refused > 20, `${outcomes.refused} refused`);
  assert.ok(outcomes.read > 20, `${outcomes.read} read`);
});
