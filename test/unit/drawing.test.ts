// What is read off a sheet: scale, runs, sizes, tags, symbols and the legend.
// The sample sheet's lengths are chosen in test/fixtures/sample.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pictureShare } from '../../src/drawing/extract.ts';
import { readLegend } from '../../src/drawing/legend.ts';
import type { Label, Sheet, Stroke } from '../../src/drawing/model.ts';
import { parseColor } from '../../src/drawing/model.ts';
import {
  buildRuns,
  drawnWithin,
  dropShadows,
  type Run,
  segmentsOf,
} from '../../src/drawing/runs.ts';
import {
  nominalPtPerM,
  ScaleUnknown,
  sheetScale,
  statedRatios,
} from '../../src/drawing/scale.ts';
import {
  codeOf,
  type GroupedRun,
  type SizeLabel,
  sizeLabels,
  sizeOf,
  sizeRuns,
} from '../../src/drawing/sizes.ts';
import { renderSvg } from '../../src/drawing/svg.ts';
import { groupSymbols } from '../../src/drawing/symbols.ts';
import { findTags } from '../../src/drawing/tags.ts';
import { COLORS, EXPECT, PT_PER_M } from '../fixtures/sample.ts';
import { sampleSheet } from '../helpers.ts';

const MM = 72 / 25.4;
const sheet = sampleSheet();
const inPlan = (s: Stroke) =>
  Math.max(...s.pts.filter((_, i) => i % 2 === 0)) < 1000;
const layerStrokes = (name: string, color?: number): Stroke[] => {
  const index = sheet.layers.findIndex((l) => l.name === name);
  return sheet.strokes.filter(
    (s) =>
      s.layer === index &&
      inPlan(s) &&
      (color === undefined || s.color === color),
  );
};
const runsOf = (name: string, color?: number): Run[] =>
  buildRuns(segmentsOf(layerStrokes(name, color)), { gap: 8 * MM }).filter(
    (r) => r.length >= 6 * MM,
  );
const metres = (runs: Run[]) =>
  runs.reduce((s, r) => s + r.length, 0) / PT_PER_M;
const near = (actual: number, expected: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    `${what}: ${actual} is not ${expected}`,
  );

const stroke = (pts: number[]): Stroke => ({
  layer: 0,
  color: 0,
  width: 1,
  dash: '',
  pts,
});
const label = (
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Label => ({
  text,
  raw: text,
  source: 'shx',
  layer: -1,
  x0,
  y0,
  x1,
  y1,
  vertical: y1 - y0 > (x1 - x0) * 1.2,
});
const run = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  group = 0,
): GroupedRun => {
  const length = Math.hypot(x1 - x0, y1 - y0);
  return { x0, y0, x1, y1, length, parts: 1, drawn: [0, length], group };
};

describe('scale', () => {
  it('reads the stated ratio and refines it from the scale bar', () => {
    const scale = sheetScale(sheet);
    assert.equal(scale.ratio, 100);
    assert.equal(scale.basis, 'bar');
    near(scale.ptPerM, PT_PER_M, 'points per metre');
    assert.equal(scale.bar?.metres, 10);
    assert.equal(scale.bar?.cells, 10);
    assert.ok(Math.abs(scale.ptPerM / nominalPtPerM(100) - 0.98) < 1e-6);
  });

  it('falls back to the stated ratio where there is no bar', () => {
    const scale = sheetScale(sampleSheet({}, 1));
    assert.equal(scale.ratio, 50);
    assert.equal(scale.basis, 'label');
    near(scale.ptPerM, nominalPtPerM(50), 'points per metre');
  });

  it('takes a ratio or a measured factor from the caller', () => {
    assert.equal(sheetScale(sheet, { ratio: 200 }).ratio, 200);
    const measured = sheetScale(sheet, { ptPerM: 30 });
    assert.equal(measured.basis, 'flag');
    assert.equal(measured.ptPerM, 30);
  });

  it('says so when the sheet states no scale', () => {
    const bare: Sheet = { ...sheet, labels: [] };
    assert.deepEqual(statedRatios(bare), []);
    assert.throws(() => sheetScale(bare), ScaleUnknown);
  });

  it('prefers the ratio beside a scale caption to ratios of details', () => {
    const labels = [
      label('1:20', 100, 100, 130, 110),
      label('1:20', 300, 100, 330, 110),
      label('1:20', 500, 100, 530, 110),
      label('SCALE', 900, 800, 940, 810),
      label('1:100', 950, 800, 990, 810),
    ];
    assert.equal(statedRatios({ ...sheet, labels })[0], 100);
  });

  it('does not take a field of paving hatch for the scale bar', () => {
    // A paving hatch inside the plan: rows of alternating filled cells, each
    // band 2 m long at 102.4% of the stated scale, banded by full lines.
    const cell = (nominalPtPerM(100) * 2 * 1.024) / 10;
    const strokes = [...sheet.strokes];
    const fills = [...sheet.fills];
    for (let row = 0; row <= 4; row++)
      strokes.push(
        stroke([100, 600 + row * 4, 100 + cell * 10, 600 + row * 4]),
      );
    for (let row = 0; row < 4; row++)
      for (let i = 0; i < 10; i++)
        if ((i + row) % 2 === 0)
          fills.push({
            layer: -1,
            color: 0,
            x0: 100 + i * cell,
            y0: 600 + row * 4,
            x1: 100 + (i + 1) * cell,
            y1: 604 + row * 4,
            area: cell * 4,
          });
    // Put the field first, so a tie would take it.
    const scale = sheetScale({
      ...sheet,
      strokes: strokes.reverse(),
      fills: fills.reverse(),
    });
    assert.equal(scale.bar?.metres, 10);
    assert.ok(Math.abs(scale.ptPerM / nominalPtPerM(100) - 0.98) < 1e-6);
  });

  it('does not take a ruled table for a scale bar', () => {
    // Two equal lines ten metres long with evenly spread ink between them.
    const strokes = [
      stroke([100, 100, 383.4, 100]),
      stroke([100, 110, 383.4, 110]),
    ];
    for (let x = 105; x < 380; x += 6) strokes.push(stroke([x, 103, x, 107]));
    const scale = sheetScale({
      ...sheet,
      strokes,
      fills: [],
      labels: [label('1:100', 10, 10, 40, 20)],
    });
    assert.equal(scale.basis, 'label');
  });
});

describe('runs', () => {
  it('joins plotted dashes into runs and measures them end to end', () => {
    const sewer = runsOf('SEWER');
    assert.equal(sewer.length, 4);
    near(metres(sewer), EXPECT.sewer.total, 'sewer');
    near((sewer[0] as Run).length / PT_PER_M, 20, 'the longest sewer run');
    assert.ok((sewer[0] as Run).parts > 30, 'made of many dashes');
  });

  it('bridges the breaks left for linetype letters and inline labels', () => {
    const fire = runsOf('FIRE');
    assert.equal(fire.length, 1);
    near(metres(fire), EXPECT.fire.total, 'fire');
    const water = runsOf('WATER', COLORS.water);
    assert.equal(water.length, 1);
    near(metres(water), EXPECT.water.total, 'water');
  });

  it('keeps runs that meet at a corner apart', () => {
    const runs = buildRuns(
      segmentsOf([stroke([0, 0, 100, 0]), stroke([100, 0, 100, 60])]),
      { gap: 20 },
    );
    assert.deepEqual(
      runs.map((r) => Math.round(r.length)),
      [100, 60],
    );
  });

  it('does not let a dot at a corner merge the two runs', () => {
    const runs = buildRuns(
      segmentsOf([
        stroke([0, 0, 100, 0]),
        stroke([100, 0, 100.1, 0.1]),
        stroke([100, 0, 100, 60]),
      ]),
      { gap: 20 },
    );
    assert.deepEqual(
      runs.map((r) => Math.round(r.length)),
      [100, 60],
    );
  });

  it('counts a line drawn twice once', () => {
    const runs = buildRuns(
      segmentsOf([stroke([0, 0, 100, 0]), stroke([100, 0, 0, 0])]),
      { gap: 5 },
    );
    assert.equal(runs.length, 1);
    assert.equal(Math.round((runs[0] as Run).length), 100);
  });

  it('leaves parallel lines and far pieces apart', () => {
    const runs = buildRuns(
      segmentsOf([
        stroke([0, 0, 100, 0]),
        stroke([0, 5, 100, 5]),
        stroke([200, 0, 300, 0]),
      ]),
      { gap: 20 },
    );
    assert.equal(runs.length, 3);
  });

  it('joins across a wider break only where a linetype letter sits in it', () => {
    const pieces = segmentsOf([
      stroke([0, 0, 100, 0]),
      stroke([140, 0, 240, 0]),
      stroke([280, 0, 380, 0]),
    ]);
    // Breaks of 40 points are wider than the gap of 25.
    assert.equal(buildRuns(pieces, { gap: 25 }).length, 3);
    const lettered = buildRuns(pieces, {
      gap: 25,
      letterGap: 50,
      letters: [
        { x: 120, y: 1 },
        { x: 260, y: -2 },
      ],
    });
    assert.deepEqual(
      lettered.map((r) => Math.round(r.length)),
      [380],
    );
    // A letter beside the line, or beyond the break, joins nothing.
    assert.equal(
      buildRuns(pieces, {
        gap: 25,
        letterGap: 50,
        letters: [
          { x: 120, y: 30 },
          { x: 50, y: 0 },
        ],
      }).length,
      3,
    );
    // A break wider than the letter gap stays a break.
    assert.equal(
      buildRuns(pieces, { gap: 25, letterGap: 35, letters: [{ x: 120, y: 0 }] })
        .length,
      3,
    );
    // Two pipes side by side with a letter between their staggered ends
    // stay two pipes.
    const sideBySide = buildRuns(
      segmentsOf([stroke([0, 0, 100, 0]), stroke([130, 5, 300, 5])]),
      { gap: 10, letterGap: 60, letters: [{ x: 115, y: 2 }] },
    );
    assert.deepEqual(
      sideBySide.map((r) => Math.round(r.length)).sort((a, b) => a - b),
      [100, 170],
    );
    // A letter where two lines meet at a corner joins nothing.
    assert.equal(
      buildRuns(
        segmentsOf([stroke([0, 0, 100, 0]), stroke([120, 20, 120, 120])]),
        { gap: 5, letterGap: 60, letters: [{ x: 110, y: 5 }] },
      ).length,
      2,
    );
  });

  it('stays quick when every line end is piled on the letters', () => {
    // 6,000 spokes that all stop short of one point, and a letter on it.
    const spokes = [];
    for (let k = 0; k < 6000; k++) {
      const angle = (k / 6000) * Math.PI * 2;
      spokes.push(
        stroke([
          500 + Math.cos(angle) * 10,
          500 + Math.sin(angle) * 10,
          500 + Math.cos(angle) * 200,
          500 + Math.sin(angle) * 200,
        ]),
      );
    }
    const started = performance.now();
    const runs = buildRuns(segmentsOf(spokes), {
      gap: 5,
      letterGap: 60,
      letters: Array.from({ length: 4000 }, () => ({ x: 500, y: 500 })),
    });
    // Without a bound this is 36 million pairs for each of 4,000 letters.
    assert.ok(performance.now() - started < 3000);
    assert.ok(runs.length >= 1);
  });

  it('measures how much of the page pictures cover', () => {
    assert.equal(pictureShare([], 800, 600), 0);
    // Four tiles of a quarter each, one of them drawn twice.
    const tiles = [
      { x0: 0, y0: 0, x1: 400, y1: 300 },
      { x0: 400, y0: 0, x1: 800, y1: 300 },
      { x0: 0, y0: 300, x1: 400, y1: 600 },
      { x0: 0, y0: 300, x1: 400, y1: 600 },
    ];
    assert.equal(pictureShare(tiles, 800, 600), 0.75);
    // A logo in a corner is about a hundredth of the page.
    const logo = pictureShare(
      [{ x0: 700, y0: 540, x1: 780, y1: 590 }],
      800,
      600,
    );
    assert.ok(logo > 0.005 && logo < 0.015, String(logo));
  });

  it('drops a row of linetype letters that rides along a pipe, and keeps real lines', () => {
    // A pipe dashed 30 on, 6 off; a row of letter bars 2 points above it,
    // 3 long every 15; a solid pipe 4 points below; and a second dashed pipe
    // 3 points further down.
    const dashes = (y: number, on: number, off: number, to: number) => {
      const out = [];
      for (let x = 0; x < to; x += on + off)
        out.push(stroke([x, y, Math.min(to, x + on), y]));
      return out;
    };
    const pipe = dashes(100, 30, 6, 360);
    const letters = dashes(98, 3, 12, 360);
    const solid = [stroke([0, 104, 360, 104])];
    const second = dashes(107, 30, 6, 360);
    const built = buildRuns(
      segmentsOf([...pipe, ...letters, ...solid, ...second]),
      { gap: 14 },
    );
    assert.equal(built.length, 4);
    const { kept, dropped } = dropShadows(built);
    assert.equal(dropped, 1);
    assert.deepEqual(
      kept
        .map((r: Run) => Math.round(r.y0))
        .sort((a: number, b: number) => a - b),
      [100, 104, 107],
    );
    // A short run beside a long one is kept when it is drawn as fully.
    const tee = buildRuns(
      segmentsOf([stroke([0, 100, 360, 100]), stroke([100, 102, 160, 102])]),
      { gap: 8 },
    );
    assert.equal(dropShadows(tee).dropped, 0);
  });

  it('knows where a run carries ink', () => {
    const [only] = buildRuns(
      segmentsOf([stroke([0, 0, 40, 0]), stroke([60, 0, 100, 0])]),
      { gap: 30 },
    ) as [Run];
    assert.equal(Math.round(only.length), 100);
    assert.equal(drawnWithin(only, 42, 58), 0);
    assert.equal(drawnWithin(only, 30, 70), 20);
  });
});

describe('sizes', () => {
  it('reads the size a label states', () => {
    assert.equal(sizeOf('Ø160-1%'), 'Ø160');
    assert.equal(sizeOf('F-Ø3"'), '3"');
    assert.equal(sizeOf('C.W.2- 3"'), '3"');
    assert.equal(sizeOf('1 1/2"'), '1 1/2"');
    assert.equal(sizeOf('DN100'), 'DN100');
    assert.equal(sizeOf('NOTE 12'), null);
    assert.equal(sizeOf('l=15.90'), null);
  });

  it('tells labels written along runs from sizes written alone', () => {
    const found = sizeLabels(sheet.labels);
    const along = found
      .filter((l) => l.onRun)
      .map((l) => l.size)
      .sort();
    assert.deepEqual(along, ['3"', 'Ø110', 'Ø160', 'Ø200']);
    assert.equal(found.filter((l) => !l.onRun).length, 5, 'the five tag sizes');
  });

  it('sizes runs from labels beside them, and their neighbours in the group', () => {
    const groups = [
      runsOf('SEWER'),
      runsOf('RAIN'),
      runsOf('FIRE'),
      runsOf('WATER', COLORS.water),
    ];
    const all: GroupedRun[] = groups.flatMap((runs, group) =>
      runs.map((r) => ({ ...r, group })),
    );
    const sized = sizeRuns(
      all,
      sizeLabels(sheet.labels).filter((l) => l.onRun),
      { reach: 1.5 * MM },
    );
    const total = (group: number, size: string | null, basis?: string) =>
      sized
        .filter(
          (r) =>
            r.group === group &&
            r.size === size &&
            (basis === undefined || r.basis === basis),
        )
        .reduce((s, r) => s + r.length, 0) / PT_PER_M;
    near(total(0, 'Ø160'), EXPECT.sewer.d160, 'sewer 160');
    near(
      total(0, 'Ø160', 'label'),
      EXPECT.sewer.d160Labelled,
      'sewer 160 by label',
    );
    near(total(0, 'Ø160', 'neighbour'), 10, 'sewer 160 by neighbour');
    near(total(0, 'Ø200'), EXPECT.sewer.d200, 'sewer 200');
    near(total(0, null), EXPECT.sewer.unsized, 'sewer unsized');
    near(total(1, 'Ø110'), EXPECT.rain.d110, 'rain 110');
    // The fire line runs through the middle of the rain label: not its pipe.
    near(total(2, null), EXPECT.fire.total, 'fire stays unsized');
    // The water line is broken for its label: that is its pipe.
    near(total(3, '3"', 'label'), EXPECT.water.total, 'water 3 inch');
  });

  it('does not pass a size to a touching run of another group', () => {
    const sized = sizeRuns(
      [run(0, 0, 100, 0), run(100, 0, 100, 80, 1), run(0, 0, 0, 80)],
      sizeLabels([label('Ø160-1%', 30, -12, 76, 1)]),
      { reach: 4 },
    );
    assert.deepEqual(
      sized.map((r) => [r.size, r.basis]),
      [
        ['Ø160', 'label'],
        [null, 'none'],
        ['Ø160', 'neighbour'],
      ],
    );
  });

  it('leaves a run unsized when its neighbours disagree', () => {
    const sized = sizeRuns(
      [run(0, 0, 100, 0), run(100, 0, 100, 80), run(100, 80, 200, 80)],
      sizeLabels([
        label('Ø160-1%', 30, -12, 76, 1),
        label('Ø200-1%', 130, 68, 176, 81),
      ]),
      { reach: 4 },
    );
    assert.deepEqual(
      sized.map((r) => r.size),
      ['Ø160', null, 'Ø200'],
    );
  });

  it('matches an upright label to an upright run only', () => {
    const upright = run(50, 0, 50, 200);
    const flat = run(0, 100, 200, 100);
    const sized = sizeRuns(
      [upright, flat],
      sizeLabels([label('Ø110-1%', 38, 40, 51, 86)]),
      { reach: 4 },
    );
    // The two runs cross; crossing is not touching, so no size passes on.
    assert.deepEqual(
      sized.map((r) => r.basis),
      ['label', 'none'],
    );
    const alone = sizeRuns(
      [flat],
      sizeLabels([label('Ø110-1%', 38, 77, 51, 123)]),
      { reach: 4 },
    );
    assert.equal(alone[0]?.size, null);
  });

  it('keeps a label with a system code for the group that carries that code', () => {
    const fire = run(0, 100, 300, 100, 0);
    const water = run(0, 300, 300, 300, 1);
    const beside = (text: string, y: number) =>
      label(text, 100, y - 12, 146, y + 1);
    const sized = (codes: Array<string | null>, ...labels: Label[]) =>
      sizeRuns([fire, water], sizeLabels(labels), { reach: 4, codes }).map(
        (r) => r.size,
      );
    // With no codes, a water label beside the fire run sizes it.
    assert.deepEqual(sized([null, null], beside('CW1-Ø3"', 100)), ['3"', null]);
    // Named by their codes, each group takes only its own labels.
    assert.deepEqual(sized(['F', 'CW'], beside('CW1-Ø3"', 100)), [null, null]);
    assert.deepEqual(sized(['F', 'CW'], beside('C.W.2- 3"', 300)), [
      null,
      '3"',
    ]);
    assert.deepEqual(sized(['F', 'CW'], beside('F-Ø4"', 100)), ['4"', null]);
    // Another code is another system, even with no group of its own.
    assert.deepEqual(sized(['F', 'CW'], beside('H.F.-Ø4"', 100)), [null, null]);
    // A group named by a code takes only labels of that code: a slope label
    // with no code is a gravity pipe's, not a water line's.
    assert.deepEqual(sized(['F', 'CW'], beside('Ø160-1%', 300)), [null, null]);
    assert.deepEqual(sized(['F', null], beside('Ø160-1%', 300)), [
      null,
      'Ø160',
    ]);
  });

  it('gives a label written in a break of a line to that line, whatever the groups are called', () => {
    // The legend's water line is group W, and has no label. The label W-3"
    // sits in a break of another line, which the caller named otherwise.
    const legendLine = run(0, 100, 300, 100, 0);
    const broken: GroupedRun = {
      ...run(0, 300, 300, 300, 1),
      // Ink on both sides of the label, none under it.
      drawn: [0, 100, 150, 300],
    };
    const inline = label('W-3"', 102, 294, 148, 306);
    const sized = sizeRuns([legendLine, broken], sizeLabels([inline]), {
      reach: 4,
      codes: ['W', null],
    });
    assert.deepEqual(
      sized.map((r) => [r.size, r.label]),
      [
        [null, null],
        ['3"', 'W-3"'],
      ],
    );
    // Beside the other line, and not in a break of it, the code still decides.
    const beside = label('W-3"', 102, 288, 148, 301);
    const whole = run(0, 300, 300, 300, 1);
    assert.deepEqual(
      sizeRuns([legendLine, whole], sizeLabels([beside]), {
        reach: 4,
        codes: ['W', null],
      }).map((r) => r.size),
      [null, null],
    );
  });

  it('lists the labels that found no run', () => {
    const placed = { count: 0, missed: [] as SizeLabel[] };
    sizeRuns(
      [run(0, 100, 300, 100, 0)],
      sizeLabels([
        label('F-Ø4"', 100, 88, 146, 101),
        label('F-Ø3"', 100, 30, 146, 43),
      ]),
      { reach: 4, codes: ['F'] },
      placed,
    );
    assert.equal(placed.count, 1);
    assert.deepEqual(
      placed.missed.map((l) => l.text),
      ['F-Ø3"'],
    );
  });

  it('reads a system code as the letters before the first digit', () => {
    assert.equal(codeOf('OD7A-'), 'OD');
    assert.equal(codeOf('OD10A-'), 'OD');
    assert.equal(codeOf('C.W.2-'), 'CW');
    assert.equal(codeOf('H.F.-'), 'HF');
    assert.equal(codeOf('CW1-'), 'CW');
    assert.equal(codeOf('F-'), 'F');
    assert.equal(codeOf('SPRK'), 'SPRK');
    assert.equal(codeOf('2-'), null);
    const labels = sizeLabels([label('OD7A-Ø3"', 0, 0, 40, 12)]);
    assert.equal(labels[0]?.code, 'OD');
  });

  it('remembers which label sized a run', () => {
    const sized = sizeRuns(
      [run(0, 0, 100, 0), run(100, 0, 100, 80)],
      sizeLabels([label('Ø160-1%', 30, -12, 76, 1)]),
      { reach: 4 },
    );
    assert.deepEqual(
      sized.map((r) => r.label),
      ['Ø160-1%', null],
    );
  });

  it('gives a label to the one run it fits best', () => {
    // Two pipes side by side; the label is written above the upper one.
    const sized = sizeRuns(
      [run(0, 100, 300, 100), run(0, 112, 300, 112, 1)],
      sizeLabels([label('Ø200-1%', 100, 88, 146, 101)]),
      { reach: 4 },
    );
    assert.deepEqual(
      sized.map((r) => r.size),
      ['Ø200', null],
    );
  });
});

describe('tags, symbols and the legend', () => {
  it('pairs each tag with the size written under it', () => {
    const tags = findTags(sheet.labels);
    assert.deepEqual(tags.map((t) => `${t.id} ${t.size}`).sort(), [
      'G1 Ø75',
      'G2 Ø75',
      'O1 Ø110',
      'O2 Ø110',
      'O3 Ø110',
    ]);
    assert.deepEqual([...new Set(tags.map((t) => t.series))].sort(), [
      'G',
      'O',
    ]);
  });

  it('groups strokes and fills into symbols', () => {
    const index = sheet.layers.findIndex((l) => l.name === 'SYMBOLS');
    const groups = groupSymbols(
      sheet.strokes.filter((s) => s.layer === index),
      sheet.fills.filter((f) => f.layer === index),
      { join: 1.5 * MM, maxPiece: 30 * MM },
    );
    assert.equal(groups.filter((g) => g.parts === 1).length, EXPECT.squares);
    assert.equal(groups.filter((g) => g.parts === 2).length, EXPECT.triangles);
  });

  it('leaves long lines out of symbols', () => {
    const groups = groupSymbols(
      [
        stroke([0, 0, 400, 0]),
        stroke([10, 10, 16, 10]),
        stroke([10, 11, 16, 11]),
      ],
      [],
      { join: 4, maxPiece: 80 },
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.parts, 2);
  });

  it('reads a legend whose samples differ by a point, whose rows run on, and whose one sample is indented', () => {
    // Laid out as a real legend: an indented vent row on top; seven rows whose
    // samples start at 3798 and are 69 points long; two at 3795 and 70 long,
    // as a plotter rounds them; a row with no sample; and two more rows.
    const rows: Array<[number, number | null, number]> = [
      [702, 3873, 69],
      ...[726, 748, 772, 795, 820, 845, 875].map(
        (y) => [y, 3798, 69] as [number, number, number],
      ),
      [907, 3795, 70],
      [935, 3795, 70],
      [962, null, 0],
      [994, 3795, 70],
      [1025, 3795, 70],
    ];
    const strokes: Stroke[] = [];
    const labels: Label[] = [];
    rows.forEach(([y, x0, length], row) => {
      if (x0 !== null)
        strokes.push({
          ...stroke([x0, y + 2, x0 + length, y + 2]),
          layer: row,
          color: row,
        });
      labels.push(label(`system number ${row}`, 3990, y - 7, 4105, y + 7));
    });
    const entries = readLegend(strokes, labels, {
      gap: 8 * MM,
      minSample: 4 * MM,
      maxSample: 60 * MM,
      reach: 110 * MM,
      aligned: true,
    });
    assert.deepEqual(
      entries.map((e) => e.layer),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12],
    );
  });

  it('pairs legend captions with the layer and colour of their samples', () => {
    const entries = readLegend(sheet.strokes, sheet.labels, {
      gap: 8 * MM,
      minSample: 4 * MM,
      maxSample: 60 * MM,
      reach: 110 * MM,
      aligned: true,
    });
    assert.deepEqual(
      entries.map((e) => [sheet.layers[e.layer]?.name, e.color]),
      [
        ['SEWER', COLORS.sewer],
        ['RAIN', COLORS.rain],
        ['FIRE', COLORS.fire],
        ['WATER', COLORS.waterBranch],
      ],
    );
    assert.equal(entries[0]?.text, 'צנרת ביוב');
  });

  it('finds no legend on a sheet without one', () => {
    const plan: Sheet = {
      ...sheet,
      strokes: sheet.strokes.filter(inPlan),
      labels: sheet.labels.filter((l) => l.x1 < 1000),
    };
    assert.deepEqual(
      readLegend(plan.strokes, plan.labels, {
        gap: 8 * MM,
        minSample: 4 * MM,
        maxSample: 60 * MM,
        reach: 110 * MM,
        aligned: true,
      }),
      [],
    );
  });
});

describe('picture', () => {
  it('draws the chosen strokes and labels as SVG', () => {
    const picture = renderSvg(layerStrokes('SEWER'), sheet.labels, {
      x0: 0,
      y0: 0,
      x1: 1000,
      y1: 900,
      width: 800,
      labels: true,
      grid: true,
    });
    assert.match(
      picture.svg,
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="800" height="720"/,
    );
    assert.match(picture.svg, /stroke="#ff00ff"/);
    assert.match(picture.svg, />Ø160-1%<\/text>/);
    assert.ok(picture.strokes > 50);
    assert.ok(picture.svg.endsWith('</svg>\n'));
  });

  it('escapes label text', () => {
    const picture = renderSvg([], [label('<b> & "q"', 10, 10, 60, 20)], {
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 100,
      width: 100,
      labels: true,
      grid: false,
    });
    assert.match(picture.svg, />&lt;b&gt; &amp; &quot;q&quot;<\/text>/);
  });

  it('reads colours with or without a hash', () => {
    assert.equal(parseColor('#ff00ff'), 0xff00ff);
    assert.equal(parseColor('0AF'), 0x00aaff);
    assert.equal(parseColor('magenta'), null);
  });
});
