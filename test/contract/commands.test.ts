// Every command, run as a separate process against the sample drawing. Set
// DRAWING_AXI_BIN=dist to run the built package instead of the source.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { EXPECT, PLAN, REVIEW_NOTE } from '../fixtures/sample.ts';
import {
  body,
  fixtureFolder,
  type Ran,
  rowsOf,
  runBinary,
} from '../helpers.ts';

let dir: string;
const run = (...args: string[]): Promise<Ran> => runBinary(args, dir);
const ok = async (...args: string[]) => {
  const r = await run(...args);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
  assert.equal(r.stderr, '', args.join(' '));
  return body(r.stdout);
};
const fails = async (code: string, exit: number, ...args: string[]) => {
  const r = await run(...args);
  const doc = body(r.stdout);
  assert.equal(doc.code, code, `${args.join(' ')}: ${r.stdout}`);
  assert.equal(r.code, exit, args.join(' '));
  assert.equal(r.stderr, '', args.join(' '));
  assert.equal(typeof doc.message, 'string');
  assert.match(String(doc.usage), /^drawing-axi/);
  return doc;
};

const GROUPS = [
  '--group',
  'sewer=SEWER',
  '--group',
  'rain=RAIN',
  '--group',
  'fire=FIRE',
  '--group',
  'water=WATER@#0000ff',
  '--region',
  PLAN,
];

before(() => {
  // The process reports its folder with links resolved.
  dir = realpathSync(fixtureFolder());
});

describe('home', () => {
  it('lists the PDF files in the folder', async () => {
    const doc = await ok();
    assert.equal(doc.summary, '5 PDF files in this folder');
    const rows = rowsOf(doc, 'drawings');
    assert.deepEqual(
      rows.map((r) => r.file),
      ['locked.pdf', 'odd.pdf', 'plan-packed.pdf', 'plan.pdf', 'scan.pdf'],
    );
    const plan = rows.find((r) => r.file === 'plan.pdf');
    assert.deepEqual(plan, {
      file: 'plan.pdf',
      pages: 2,
      sheet: '494 x 317 mm',
      layers: EXPECT.layers,
      comments: 25,
    });
    assert.equal(rows[0]?.sheet, 'not readable');
  });

  it('says so in a folder with no drawings', async () => {
    const r = await runBinary([], join(dir, '..'), { HOME: dir });
    assert.equal(r.code, 0);
    // The parent of a fresh temporary folder may hold PDFs of its own.
    assert.match(String(body(r.stdout).summary), /PDF files? in this folder$/);
  });
});

describe('info and scale', () => {
  it('describes a sheet', async () => {
    const doc = await ok('info', 'plan.pdf');
    assert.equal(doc.file, 'plan.pdf');
    assert.equal(doc.page, '1 of 2');
    assert.equal(doc.sheet, '494 x 317 mm');
    assert.equal(
      doc.scale,
      '1:100, 27.78 pt per m (stated ratio, refined by the scale bar)',
    );
    assert.equal(
      doc.layers,
      `${EXPECT.layers} with ink on this page, ${EXPECT.layers} in the file (1 switched off)`,
    );
    assert.equal(doc.labels, '24 stroke-font, 1 font text, 1 notes');
    assert.equal(
      doc.size_labels,
      '9 (4 carry a slope or a system code, as a label on a pipe does)',
    );
    assert.equal(doc.notes, undefined);
  });

  it('reads another page, and says what a page lacks', async () => {
    const doc = await ok('info', 'plan.pdf', '--page', '2');
    assert.equal(doc.page, '2 of 2');
    assert.match(
      String(doc.scale),
      /^1:50, 56\.69 pt per m \(stated ratio; no scale bar/,
    );
    const scan = await ok('info', 'scan.pdf');
    assert.match(
      String((scan.notes as string[])[0]),
      /^This page is a picture/,
    );
    assert.match(String(scan.scale), /^not stated on the sheet/);
  });

  it('explains the scale', async () => {
    const doc = await ok('scale', 'plan.pdf');
    assert.equal(doc.scale, '1:100');
    assert.equal(doc.pt_per_m, 27.78);
    assert.equal(doc.plotted_at, '98% of the stated scale');
    assert.match(String(doc.scale_bar), /^10 m in 10 cells at x=1090 y=820$/);
    const given = await ok('scale', 'plan.pdf', '--pt-per-m', '30');
    assert.equal(given.pt_per_m, 30);
    assert.equal(given.basis, 'points per metre given by flag');
  });
});

describe('layers and legend', () => {
  it('lists layers with the run length on each', async () => {
    const doc = await ok('layers', 'plan.pdf', '--region', PLAN);
    assert.equal(doc.summary, '8 layers with ink, longest runs first');
    const rows = rowsOf(doc, 'layers');
    const by = (name: string) => rows.find((r) => r.layer === name);
    assert.equal(by('SEWER')?.run_m, EXPECT.sewer.total);
    assert.equal(by('RAIN')?.run_m, EXPECT.rain.total);
    assert.equal(by('FIRE')?.run_m, EXPECT.fire.total);
    assert.equal(by('WATER')?.run_m, EXPECT.water.total + EXPECT.water.branch);
    assert.equal(by('WATER')?.color, '#0000ff +1');
    assert.equal(by('OLD (switched off)')?.run_m, 25);
    assert.equal(by('TEXT')?.color, '#000000');
  });

  it('splits a layer by colour and filters by name', async () => {
    const doc = await ok(
      'layers',
      'plan.pdf',
      '--split',
      '--match',
      'water',
      '--region',
      PLAN,
    );
    assert.deepEqual(rowsOf(doc, 'layers'), [
      { layer: 'WATER', run_m: 9, strokes: 2, color: '#0000ff' },
      { layer: 'WATER', run_m: 3, strokes: 1, color: '#00ffff' },
    ]);
  });

  it('pairs the legend with layers', async () => {
    const doc = await ok('legend', 'plan.pdf');
    assert.deepEqual(
      rowsOf(doc, 'legend').map((r) => [r.text, r.layer, r.color]),
      [
        ['צנרת ביוב', 'SEWER', '#ff00ff'],
        ['צנרת ניקוז מי גשם', 'RAIN', '#00bfff'],
        ['צנרת מים כבוי אש (F)', 'FIRE', '#ff0000'],
        ['צנרת מים קרים', 'WATER', '#00ffff'],
      ],
    );
  });
});

describe('labels and tags', () => {
  it('groups labels, with counts', async () => {
    const doc = await ok('labels', 'plan.pdf', '--match', '^Ø');
    assert.deepEqual(
      rowsOf(doc, 'labels').map((r) => [r.text, r.count]),
      [
        ['Ø110', 3],
        ['Ø75', 2],
        ['Ø110-2%', 1],
        ['Ø160-1%', 1],
        ['Ø200-1%', 1],
      ],
    );
    // A search reads every kind of text, so nothing is left out of it.
    assert.equal(doc.also, undefined);
    const listing = await ok('labels', 'plan.pdf');
    assert.equal(
      listing.also,
      '1 font text labels not shown; add --source all',
    );
  });

  it('lists labels one by one, in reading order, with their place', async () => {
    const doc = await ok('labels', 'plan.pdf', '--match', 'צנרת', '--each');
    const rows = rowsOf(doc, 'labels');
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], {
      text: 'צנרת ביוב',
      x: 1280,
      y: 110,
      source: 'shx',
    });
    const text = await ok('labels', 'plan.pdf', '--source', 'text', '--each');
    assert.deepEqual(rowsOf(text, 'labels')[0], {
      text: 'NOTE A',
      x: 92,
      y: 76,
      source: 'text',
    });
  });

  it('keeps Latin notes and decodes Hebrew ones', async () => {
    const doc = await ok(
      'labels',
      'plan.pdf',
      '--region',
      '200,80,700,120',
      '--each',
    );
    assert.deepEqual(
      rowsOf(doc, 'labels').map((r) => r.text),
      ['פתח 200X20 ס"מ', 'l=15.90', '(HDPE)'],
    );
  });

  it('counts the sizes the labels name', async () => {
    const doc = await ok('labels', 'plan.pdf', '--sizes');
    assert.equal(doc.summary, '6 ways a pipe size is written, in 9 labels');
    assert.deepEqual(rowsOf(doc, 'sizes'), [
      { code: '-', size: 'Ø110', slope: '-', labels: 3 },
      { code: '-', size: 'Ø75', slope: '-', labels: 2 },
      { code: 'W', size: '3"', slope: '-', labels: 1 },
      { code: '-', size: 'Ø110', slope: '2%', labels: 1 },
      { code: '-', size: 'Ø160', slope: '1%', labels: 1 },
      { code: '-', size: 'Ø200', slope: '1%', labels: 1 },
    ]);
  });

  it('pairs riser tags with sizes', async () => {
    const doc = await ok('tags', 'plan.pdf');
    assert.equal(doc.summary, '5 tags with a size, in 2 series and sizes');
    assert.deepEqual(rowsOf(doc, 'tags'), [
      { series: 'G', size: 'Ø75', count: EXPECT.tags.G, tags: 'G1 G2' },
      { series: 'O', size: 'Ø110', count: EXPECT.tags.O, tags: 'O1 O2 O3' },
    ]);
    const each = await ok('tags', 'plan.pdf', '--each', '--match', 'O|Ø');
    assert.deepEqual(rowsOf(each, 'tags')[0], {
      tag: 'O1',
      size: 'Ø110',
      x: 700,
      y: 300,
    });
  });
});

describe('runs and measure', () => {
  it('lists runs with their ends', async () => {
    const doc = await ok(
      'runs',
      'plan.pdf',
      '--layer',
      'SEWER',
      '--region',
      PLAN,
    );
    assert.equal(doc.summary, '4 runs, 43 m in all, longest first');
    const rows = rowsOf(doc, 'runs');
    assert.deepEqual(
      rows.map((r) => r.length_m),
      [20, 10, 8, 5],
    );
    assert.equal(rows[0]?.from, '100,200');
    assert.equal(rows[0]?.to, '656,200');
    assert.equal(rows[0]?.group, 'SEWER');
  });

  it('measures groups by pipe size', async () => {
    const doc = await ok('measure', 'plan.pdf', ...GROUPS);
    assert.equal(doc.summary, '4 groups, 79 m in 7 runs');
    assert.deepEqual(rowsOf(doc, 'groups'), [
      { group: 'sewer', length_m: 43, runs: 4, sized_m: 38, unsized_m: 5 },
      { group: 'rain', length_m: 12, runs: 1, sized_m: 12, unsized_m: 0 },
      { group: 'fire', length_m: 15, runs: 1, sized_m: 0, unsized_m: 15 },
      { group: 'water', length_m: 9, runs: 1, sized_m: 9, unsized_m: 0 },
    ]);
    assert.deepEqual(rowsOf(doc, 'sizes'), [
      { group: 'sewer', size: 'Ø160', length_m: 30, labelled_m: 20, runs: 2 },
      { group: 'sewer', size: 'Ø200', length_m: 8, labelled_m: 8, runs: 1 },
      {
        group: 'sewer',
        size: 'unsized',
        length_m: 5,
        labelled_m: null,
        runs: 1,
      },
      { group: 'rain', size: 'Ø110', length_m: 12, labelled_m: 12, runs: 1 },
      {
        group: 'fire',
        size: 'unsized',
        length_m: 15,
        labelled_m: null,
        runs: 1,
      },
      { group: 'water', size: '3"', length_m: 9, labelled_m: 9, runs: 1 },
    ]);
  });

  it('gives the same answer for a packed, compressed copy', async () => {
    const plain = await ok('measure', 'plan.pdf', ...GROUPS);
    const packed = await ok('measure', 'plan-packed.pdf', ...GROUPS);
    assert.deepEqual(packed.groups, plain.groups);
    assert.deepEqual(packed.sizes, plain.sizes);
  });

  it('measures by the scale it is given', async () => {
    const doc = await ok(
      'measure',
      'plan.pdf',
      '--layer',
      'RAIN',
      '--region',
      PLAN,
      '--scale',
      '1:50',
    );
    // At 1:50 the same bar is five metres, so it still sets the factor.
    assert.equal(
      doc.scale,
      '1:50, 55.56 pt per m (given ratio, refined by the scale bar)',
    );
    assert.equal(rowsOf(doc, 'groups')[0]?.length_m, 6);
  });

  it('leaves out what --exclude names', async () => {
    const all = await ok('measure', 'plan.pdf', '--layer', 'SEWER');
    assert.equal(
      rowsOf(all, 'groups')[0]?.length_m,
      45.2,
      'with the legend sample',
    );
    const cut = await ok(
      'measure',
      'plan.pdf',
      '--layer',
      'SEWER',
      '--exclude',
      '1000,0,1400,900',
    );
    assert.equal(rowsOf(cut, 'groups')[0]?.length_m, 43);
  });

  it('saves every run as JSON', async () => {
    const doc = await ok(
      'measure',
      'plan.pdf',
      ...GROUPS,
      '--save',
      'takeoff.json',
    );
    assert.equal(doc.saved, join(dir, 'takeoff.json'));
    const saved = JSON.parse(readFileSync(join(dir, 'takeoff.json'), 'utf8'));
    assert.equal(saved.file, 'plan.pdf');
    assert.equal(saved.scale.ratio, 100);
    assert.equal(saved.runs.length, 7);
    assert.deepEqual(saved.runs[0], {
      group: 'sewer',
      layer: 'SEWER',
      size: 'Ø160',
      basis: 'label',
      label: 'Ø160-1%',
      length_m: 20,
      from: [100, 200],
      to: [655.6, 200],
    });
    // The screen rounds to a tenth of a metre; the file keeps a thousandth.
    assert.deepEqual(
      saved.sizes.map(
        (r: { length_m: number }) => Math.round(r.length_m * 10) / 10,
      ),
      rowsOf(doc, 'sizes').map((r) => r.length_m),
    );
  });
});

describe('symbols and render', () => {
  it('counts symbols by kind', async () => {
    const doc = await ok('symbols', 'plan.pdf', '--layer', 'SYMBOLS');
    assert.equal(doc.summary, '6 symbols in 2 kinds, most frequent first');
    assert.deepEqual(rowsOf(doc, 'symbols'), [
      {
        size: '0.2 x 0.2 m',
        parts: 1,
        count: EXPECT.squares,
        first_at: '400,320',
      },
      {
        size: '0.36 x 0.31 m',
        parts: 2,
        count: EXPECT.triangles,
        first_at: '420,380',
      },
    ]);
  });

  it('writes a picture, and replaces one only when told to', async () => {
    const doc = await ok(
      'render',
      'plan.pdf',
      '--layer',
      'SEWER',
      '--layer',
      'RAIN',
      '--region',
      '50,150,700,650',
      '--labels',
      '--grid',
      '--out',
      'crop.svg',
    );
    assert.equal(doc.wrote, join(dir, 'crop.svg'));
    assert.match(String(doc.picture), /^1600 x 1231 px, \d+ bytes$/);
    assert.match(String(doc.shows), /^2 layers, \d+ strokes, \d+ labels$/);
    const svg = readFileSync(join(dir, 'crop.svg'), 'utf8');
    assert.match(svg, /^<svg /);
    assert.match(svg, /stroke="#ff00ff"/);
    assert.match(svg, />Ø160-1%</);
    await fails('exists', 1, 'render', 'plan.pdf', '--out', 'crop.svg');
    await ok('render', 'plan.pdf', '--out', 'crop.svg', '--force');
    assert.ok(existsSync(join(dir, 'crop.svg')));
  });
});

describe('errors', () => {
  it('refuses what it cannot read, and says what to do', async () => {
    await fails('not_found', 1, 'info', 'missing.pdf');
    const notPdf = await fails('not_pdf', 1, 'info', 'notes.txt');
    assert.match(String(notPdf.message), /not a PDF/);
    const locked = await fails('encrypted', 1, 'layers', 'locked.pdf');
    assert.match(String(locked.message), /qpdf --decrypt/);
    const page = await fails('no_page', 1, 'info', 'plan.pdf', '--page', '9');
    assert.equal(page.pages, 2);
    await fails('scale_unknown', 1, 'scale', 'scan.pdf');
  });

  it('names an unknown layer and suggests near ones', async () => {
    const doc = await fails(
      'unknown_layer',
      1,
      'measure',
      'plan.pdf',
      '--layer',
      'SEW',
    );
    assert.match(
      String(doc.message),
      /no layer named `SEW`\. Layers that contain it: SEWER\./,
    );
    const lower = await ok(
      'measure',
      'plan.pdf',
      '--layer',
      'sewer',
      '--region',
      PLAN,
    );
    assert.equal(
      rowsOf(lower, 'groups')[0]?.length_m,
      43,
      'case is forgiven when unambiguous',
    );
  });

  it('refuses bad input as a usage error', async () => {
    await fails('usage', 2, 'frobnicate');
    await fails('usage', 2, 'info');
    await fails('usage', 2, 'info', 'plan.pdf', 'extra.pdf');
    await fails('usage', 2, 'layers', 'plan.pdf', '--bogus');
    await fails('usage', 2, 'layers', 'plan.pdf', '--limit', '0');
    await fails(
      'usage',
      2,
      'layers',
      'plan.pdf',
      '--limit',
      '5',
      '--limit',
      '6',
    );
    await fails('usage', 2, 'layers', 'plan.pdf', '--region', '1,2,3');
    await fails('usage', 2, 'labels', 'plan.pdf', '--match', '(');
    await fails('usage', 2, 'labels', 'plan.pdf', '--source', 'pencil');
    await fails('usage', 2, 'measure', 'plan.pdf');
    await fails('usage', 2, 'measure', 'plan.pdf', '--group', 'sewer');
    await fails(
      'usage',
      2,
      'measure',
      'plan.pdf',
      '--layer',
      'SEWER',
      '--scale',
      'big',
    );
    await fails('usage', 2, 'symbols', 'plan.pdf');
    await fails('usage', 2, 'render', 'plan.pdf');
    await fails('usage', 2, 'render', 'plan.pdf', '--out', 'picture.png');
  });

  it('stops at the deadline it is given', async () => {
    const late = await runBinary(['layers', 'plan.pdf'], dir, {
      COMIS_DEADLINE: '1000000000000',
    });
    assert.equal(body(late.stdout).code, 'timed_out');
    assert.equal(late.code, 1);
    const odd = await runBinary(['layers', 'plan.pdf'], dir, {
      COMIS_DEADLINE: 'soon',
    });
    assert.equal(body(odd.stdout).code, 'usage');
    assert.equal(odd.code, 2);
    const fine = await runBinary(['layers', 'plan.pdf'], dir, {
      COMIS_DEADLINE: String(Date.now() + 60_000),
    });
    assert.equal(fine.code, 0);
  });

  it('shows a long note cut, and whole with --full', async () => {
    const cut = await ok('labels', 'plan.pdf', '--source', 'note');
    const shown = String(rowsOf(cut, 'labels')[0]?.text);
    assert.match(
      shown,
      new RegExp(
        ` … \\(truncated, ${REVIEW_NOTE.length} code points total; use --full to see all\\)$`,
      ),
    );
    const whole = await ok('labels', 'plan.pdf', '--source', 'note', '--full');
    assert.equal(rowsOf(whole, 'labels')[0]?.text, REVIEW_NOTE);
  });
});

describe('what a worker found hard', () => {
  it('says which layers have ink on the page, and how to read another page', async () => {
    const r = await run('info', 'plan.pdf', '--page', '2');
    const doc = body(r.stdout);
    assert.equal(
      doc.layers,
      '0 with ink on this page, 9 in the file (1 switched off)',
    );
    assert.match(
      String((doc.notes as string[])[0]),
      /^No line on this page is on a layer/,
    );
    const first = await run('info', 'plan.pdf');
    assert.match(
      first.stdout,
      /drawing-axi info <file\.pdf> --page <n>` for another of the 2 pages/,
    );
  });

  it('measures ink that is on no layer by the name it is listed under', async () => {
    const layers = await ok('layers', 'plan.pdf', '--page', '2');
    assert.equal(rowsOf(layers, 'layers')[0]?.layer, '(no layer)');
    const doc = await ok(
      'runs',
      'plan.pdf',
      '--page',
      '2',
      '--layer',
      '(no layer)',
    );
    assert.deepEqual(
      rowsOf(doc, 'runs').map((r) => r.length_m),
      [3.53],
    );
  });

  it("takes a group name in the legend's own words", async () => {
    const doc = await ok(
      'measure',
      'plan.pdf',
      '--group',
      'צנרת מים כבוי אש (F)=FIRE',
      '--group',
      'rain water=RAIN',
      '--region',
      PLAN,
    );
    assert.deepEqual(
      rowsOf(doc, 'groups').map((g) => [g.group, g.length_m]),
      [
        ['צנרת מים כבוי אש (F)', 15],
        ['rain water', 12],
      ],
    );
    const noName = await fails(
      'usage',
      2,
      'measure',
      'plan.pdf',
      '--group',
      '=FIRE',
    );
    assert.match(String(noName.message), /--group takes <name>=<layer>/);
    const long = await fails(
      'usage',
      2,
      'measure',
      'plan.pdf',
      '--group',
      `${'x'.repeat(61)}=FIRE`,
    );
    assert.match(String(long.message), /A group name is 1 to 60 characters/);
  });

  it('says how many size labels found a run, and what area was read', async () => {
    const all = await ok('measure', 'plan.pdf', ...GROUPS);
    assert.equal(
      all.size_labels,
      '4 of 4 size labels in the area sit on a measured run',
    );
    assert.match(String(all.settings), /; inside the region only$/);
    // Alone, the fire line still takes nothing from the rain label it crosses.
    const fire = await ok(
      'measure',
      'plan.pdf',
      '--layer',
      'FIRE',
      '--exclude',
      '1000,0,1400,900',
    );
    assert.equal(
      fire.size_labels,
      '0 of 4 size labels in the area sit on a measured run; the others belong to pipe that is not in these groups, or fit no run',
    );
    assert.match(
      String(fire.settings),
      /; whole sheet outside 1 excluded box$/,
    );
    assert.equal(rowsOf(fire, 'sizes')[0]?.size, 'unsized');
  });

  it("gives the legend's box, which leaves its samples out of a takeoff", async () => {
    const legend = await ok('legend', 'plan.pdf');
    assert.equal(legend.box, '1050,93,1360,202');
    const doc = await ok(
      'measure',
      'plan.pdf',
      '--layer',
      'SEWER',
      '--exclude',
      String(legend.box),
    );
    assert.equal(rowsOf(doc, 'groups')[0]?.length_m, 43);
  });

  it('saves the lines a workbook quotes, so nothing is retyped', async () => {
    await ok('measure', 'plan.pdf', ...GROUPS, '--save', 'm.json');
    const m = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
    assert.equal(
      m.scale.text,
      '1:100, 27.78 pt per m (stated ratio, refined by the scale bar)',
    );
    assert.match(
      m.settings_text,
      /^pieces up to 8 mm apart on paper are joined/,
    );
    assert.equal(
      m.size_labels,
      '4 of 4 size labels in the area sit on a measured run',
    );
    await ok('scale', 'plan.pdf', '--save', 's.json');
    assert.equal(
      JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')).plotted_at,
      '98% of the stated scale',
    );
    await ok('layers', 'plan.pdf', '--region', PLAN, '--save', 'l.json');
    const l = JSON.parse(readFileSync(join(dir, 'l.json'), 'utf8'));
    assert.equal(
      l.layers.find((row: { layer: string }) => row.layer === 'SEWER').run_m,
      43,
    );
    assert.equal(l.layers[0]._sort, undefined);
  });

  it('shows the stored text only where decoding changed it', async () => {
    const doc = await ok(
      'labels',
      'plan.pdf',
      '--region',
      '200,80,700,120',
      '--each',
      '--full',
    );
    assert.deepEqual(
      rowsOf(doc, 'labels').map((r) => [r.text, r.stored]),
      [
        ['פתח 200X20 ס"מ', 'p,j 02X002 x"n'],
        ['l=15.90', null],
        ['(HDPE)', ')EPDH('],
      ],
    );
  });
});

describe('what real sheets showed', () => {
  it('joins a line across the wider breaks left for its linetype letters', async () => {
    const doc = await ok('runs', 'odd.pdf', '--layer', 'HYDRANT');
    assert.deepEqual(
      rowsOf(doc, 'runs').map((r) => [r.length_m, r.pieces]),
      [[14, 4]],
    );
    assert.match(
      String(doc.settings),
      /^pieces up to 8 mm apart on paper are joined, and up to 16 mm where a linetype letter sits in the break;/,
    );
    // A smaller gap leaves the letter breaks out of reach.
    const tight = await ok(
      'runs',
      'odd.pdf',
      '--layer',
      'HYDRANT',
      '--gap',
      '5',
    );
    assert.equal(rowsOf(tight, 'runs').length, 4);
    const layers = await ok('layers', 'odd.pdf', '--match', 'HYDRANT');
    assert.equal(rowsOf(layers, 'layers')[0]?.run_m, 14);
  });

  it('gives a coded label only to the group named by that code', async () => {
    const named = await ok(
      'measure',
      'plan.pdf',
      '--group',
      'W=WATER@#0000ff',
      '--group',
      'rain=RAIN',
      '--region',
      PLAN,
    );
    assert.match(
      String(named.settings),
      /; labels coded W go only to the groups of those names;/,
    );
    assert.deepEqual(
      rowsOf(named, 'sizes').map((r) => [r.group, r.size, r.length_m]),
      [
        ['W', '3"', 9],
        ['rain', 'Ø110', 12],
      ],
    );
    // Name another group W, and the water line can no longer take the label.
    const other = await ok(
      'measure',
      'plan.pdf',
      '--group',
      'W=RAIN',
      '--group',
      'pipes=WATER@#0000ff',
      '--region',
      PLAN,
    );
    assert.deepEqual(
      rowsOf(other, 'sizes').map((r) => [r.group, r.size, r.length_m]),
      [
        ['W', 'Ø110', 12],
        ['pipes', 'unsized', 9],
      ],
    );
  });

  it('shows which label sized what, and saves it with exact lengths', async () => {
    const doc = await ok('measure', 'plan.pdf', ...GROUPS, '--save', 'e.json');
    assert.deepEqual(rowsOf(doc, 'sized_by'), [
      {
        group: 'sewer',
        size: 'Ø160',
        label: 'Ø160-1%',
        labelled_m: 20,
        runs: 1,
      },
      {
        group: 'sewer',
        size: 'Ø200',
        label: 'Ø200-1%',
        labelled_m: 8,
        runs: 1,
      },
      {
        group: 'rain',
        size: 'Ø110',
        label: 'Ø110-2%',
        labelled_m: 12,
        runs: 1,
      },
      { group: 'water', size: '3"', label: 'W-3"', labelled_m: 9, runs: 1 },
    ]);
    const saved = JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8'));
    assert.deepEqual(saved.labels, doc.sized_by);
    assert.deepEqual(
      saved.runs.map((r: { label: string | null }) => r.label),
      ['Ø160-1%', null, 'Ø200-1%', null, 'Ø110-2%', null, 'W-3"'],
    );
    // A fire line of 15 m exactly, kept to a thousandth of a metre.
    assert.equal(saved.groups[2].length_m, 15);
    assert.equal(
      saved.sizes.every((r: { length_m: number }) =>
        Number.isInteger(Math.round(r.length_m * 1000)),
      ),
      true,
    );
  });

  it('lists a coded label that names a size but sits apart from the pipe', async () => {
    const doc = await ok(
      'measure',
      'odd.pdf',
      '--group',
      'HF=HYDRANT',
      '--save',
      'h.json',
    );
    assert.deepEqual(
      rowsOf(doc, 'sizes').map((r) => [r.group, r.size, r.length_m]),
      [['HF', 'unsized', 14]],
    );
    assert.deepEqual(rowsOf(doc, 'labels_apart'), [
      { group: 'HF', size: '4"', label: 'HF-Ø4"', labels: 1 },
    ]);
    const saved = JSON.parse(readFileSync(join(dir, 'h.json'), 'utf8'));
    assert.deepEqual(saved.labels_apart, doc.labels_apart);
    // A group that is not named by the code does not claim the label.
    const plain = await ok('measure', 'odd.pdf', '--group', 'hydrant=HYDRANT');
    assert.equal(plain.labels_apart, undefined);
  });

  it('takes a layer whose name holds a plus sign, alone or joined to another', async () => {
    const one = await ok('measure', 'odd.pdf', '--group', 'x=A+B');
    assert.deepEqual(
      rowsOf(one, 'groups').map((r) => [r.group, r.length_m]),
      [['x', 5]],
    );
    const two = await ok('measure', 'odd.pdf', '--group', 'x=C+A+B');
    assert.equal(rowsOf(two, 'groups')[0]?.length_m, 8);
    const none = await fails(
      'unknown_layer',
      1,
      'measure',
      'odd.pdf',
      '--group',
      'x=A+Z',
    );
    assert.match(String(none.message), /no layer named `A`/);
  });

  it('pairs a tag with a size written in font text, and saves every place', async () => {
    const doc = await ok('tags', 'odd.pdf', '--save', 't.json');
    assert.deepEqual(rowsOf(doc, 'tags'), [
      { series: 'R', size: '4"', count: 1, tags: 'R1' },
    ]);
    const saved = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8'));
    assert.deepEqual(saved.places, [
      { tag: 'R1', series: 'R', size: '4"', x: 600, y: 200 },
    ]);
  });

  it('groups symbols layer by layer, and saves where each one is', async () => {
    const doc = await ok(
      'symbols',
      'plan.pdf',
      '--layer',
      'SYMBOLS',
      '--layer',
      'RAIN',
      '--save',
      'y.json',
    );
    const rows = rowsOf(doc, 'symbols');
    // Every row names its layer, and a layer's symbols are counted alone.
    assert.deepEqual(
      rows.filter((r) => r.layer === 'SYMBOLS').map((r) => [r.count, r.parts]),
      [
        [4, 1],
        [2, 2],
      ],
    );
    assert.ok(rows.every((r) => r.layer === 'SYMBOLS' || r.layer === 'RAIN'));
    const saved = JSON.parse(readFileSync(join(dir, 'y.json'), 'utf8'));
    assert.equal(
      saved.places.filter((p: { layer: string }) => p.layer === 'SYMBOLS')
        .length,
      6,
    );
    // With one layer the column is left out.
    const single = await ok('symbols', 'plan.pdf', '--layer', 'SYMBOLS');
    assert.equal(rowsOf(single, 'symbols')[0]?.layer, undefined);
    assert.deepEqual(saved.places[0], {
      layer: 'SYMBOLS',
      size: '0.2 x 0.2 m',
      parts: 1,
      x: 400,
      y: 320,
    });
  });

  it("lists only the drawing's own layers when asked", async () => {
    const all = await ok('layers', 'plan.pdf', '--region', PLAN);
    const own = await ok('layers', 'plan.pdf', '--region', PLAN, '--own');
    const names = (doc: Record<string, unknown>) =>
      rowsOf(doc, 'layers').map((r) => String(r.layer));
    assert.ok(names(all).includes('XREF|Walls'));
    assert.ok(!names(own).includes('XREF|Walls'));
    assert.equal(names(own).length, names(all).length - 1);
  });
});
