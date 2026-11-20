// One made-up plumbing sheet, drawn the way CAD plots come: named layers,
// lines plotted as dashes, stroke-font text kept as comments (Hebrew typed on
// Latin keys), a scale bar, a legend, riser tags and symbols. Every length is
// chosen here, so tests can state the exact answer.

import {
  buildPdf,
  type Comment,
  Content,
  type PageSpec,
  type PdfOptions,
} from './pdf.ts';

/** The sheet says 1:100 and is plotted at 98% of it. */
export const PLOT_FACTOR = 0.98;
export const PT_PER_M = (72 / 25.4) * 10 * PLOT_FACTOR;
const m = (metres: number): number => metres * PT_PER_M;

export const SHEET = { width: 1400, height: 900 };
/** The plan, without the legend and the scale bar. */
export const PLAN = '0,0,1000,900';

export const COLORS = {
  sewer: 0xff00ff,
  rain: 0x00bfff,
  fire: 0xff0000,
  water: 0x0000ff,
  waterBranch: 0x00ffff,
  walls: 0xadadad,
  ink: 0x000000,
};

/** A reviewer's remark, long enough to be cut in default output. */
export const REVIEW_NOTE = `Check ${'the falls on this branch and '.repeat(22)}confirm.`;

/** What the sheet holds, in metres, for tests to assert against. */
export const EXPECT = {
  sewer: { total: 43, d160: 30, d160Labelled: 20, d200: 8, unsized: 5 },
  rain: { total: 12, d110: 12 },
  fire: { total: 15 },
  water: { total: 9, branch: 3 },
  tags: { O: 3, G: 2 },
  squares: 4,
  triangles: 2,
  layers: 9,
};

export function samplePages(): PageSpec[] {
  const c = new Content();
  const comments: Comment[] = [];
  const lettering: Array<[number, number, number, number]> = [];
  /** A stroke-font label: a comment, and a few strokes where its glyphs are. */
  const label = (text: string, cx: number, cy: number, w: number, h = 13) => {
    comments.push({
      text,
      x0: cx - w / 2,
      y0: cy - h / 2,
      x1: cx + w / 2,
      y1: cy + h / 2,
    });
    lettering.push([cx - w / 2, cy - h / 2, w, h]);
  };
  // The building's outline, from an architect's reference file.
  c.layer('XREF|Walls')
    .pen(COLORS.walls, 0.7)
    .polyline(
      [
        [60, 60],
        [980, 60],
        [980, 860],
        [60, 860],
      ],
      's',
    )
    .text('NOTE A', 80, 80)
    .end();

  // Sewer: A 20 m with a size, B 10 m joined to it, C 8 m with a size, D 5 m bare.
  c.layer('SEWER').pen(COLORS.sewer, 2);
  c.dashes(100, 200, 100 + m(20), 200);
  c.dashes(100 + m(20), 200, 100 + m(20), 200 + m(10));
  c.dashes(100, 480, 100 + m(8), 480);
  c.dashes(100, 540, 100 + m(5), 540);
  c.end();
  label('%%C160-1%', 100 + m(10), 194.5, 46);
  label('%%C200-1%', 100 + m(4), 474.5, 46);

  // Rain: 12 m, its size written just above it.
  c.layer('RAIN')
    .pen(COLORS.rain, 2)
    .dashes(100, 620, 100 + m(12), 620)
    .end();
  label('%%C110-2%', 100 + m(6), 614.5, 46);

  // Fire: 15 m passing straight through the middle of the rain pipe's label.
  // It is plotted with breaks for its linetype letter.
  c.layer('FIRE')
    .pen(COLORS.fire, 0.6)
    .dashes(100, 614.5, 100 + m(15), 614.5, 60, 16)
    .end();

  // Water: 9 m, broken to make room for its own label; and a 3 m branch in
  // another colour of the same layer.
  const wx = 100 + m(4.5);
  c.layer('WATER')
    .pen(COLORS.water, 1.5)
    .line(100, 720, wx - 10, 720)
    .line(wx + 10, 720, 100 + m(9), 720)
    .pen(COLORS.waterBranch, 1.5)
    .line(100, 780, 100 + m(3), 780)
    .end();
  label('W-3"', wx, 720, 18, 8);

  // Riser tags: an identifier over a size.
  const tag = (id: string, size: string, x: number, y: number) => {
    label(id, x, y, 22, 12);
    label(size, x, y + 13, 30, 12);
  };
  tag('O1', '%%C110', 700, 300);
  tag('O2', '%%C110', 780, 300);
  tag('O3', '%%C110', 860, 300);
  tag('G1', '%%C75', 700, 380);
  tag('G2', '%%C75', 780, 380);

  // Symbols: four squares, and two triangles each with a filled dot.
  c.layer('SYMBOLS').pen(COLORS.ink, 0.7);
  for (const [x, y] of [
    [400, 320],
    [460, 320],
    [520, 320],
    [580, 320],
  ] as const)
    c.square(x, y, 6);
  for (const [x, y] of [
    [420, 380],
    [500, 380],
  ] as const) {
    c.polyline(
      [
        [x - 5, y + 4],
        [x + 5, y + 4],
        [x, y - 5],
      ],
      's',
    );
    c.polyline(
      [
        [x - 1, y],
        [x + 1, y],
        [x + 1, y + 2],
        [x - 1, y + 2],
      ],
      'f',
    );
  }
  c.end();

  // A layer that is switched off: a line a viewer does not show.
  c.layer('OLD')
    .pen(COLORS.ink, 1)
    .line(100, 840, 100 + m(25), 840)
    .end();

  // Notes in a Hebrew stroke font, a Latin length note, and reversed Latin.
  label('p,j 02X002 x"n', 300, 100, 80);
  label('l=15.90', 500, 100, 40);
  label(')EPDH(', 620, 100, 40);

  // A long remark a reviewer left on the sheet.
  comments.push({
    text: REVIEW_NOTE,
    x0: 840,
    y0: 700,
    x1: 960,
    y1: 760,
    author: 'Reviewer',
  });

  // The legend: a caption with a sample line on the layer it names.
  label('nert', 1300, 85, 30);
  const legend = (caption: string, y: number, layer: string, color: number) => {
    c.layer(layer).pen(color, 1.5).line(1060, y, 1120, y).end();
    label(caption, 1280, y, 140);
  };
  legend('mbr, chuc', 110, 'SEWER', COLORS.sewer);
  legend('mbr, bheuz nh dao', 135, 'RAIN', COLORS.rain);
  legend('mbr, nho fcuh ta )F(', 160, 'FIRE', COLORS.fire);
  legend('mbr, nho erho', 185, 'WATER', COLORS.waterBranch);

  // The scale bar: ten one-metre cells, every other one hatched.
  c.layer('TITLE').pen(COLORS.ink, 0.7);
  const bx = 1090;
  c.line(bx, 820, bx + m(10), 820).line(bx, 826, bx + m(10), 826);
  for (let cell = 0; cell < 10; cell += 2)
    for (let k = 1; k <= 5; k++)
      c.line(
        bx + m(cell) + (m(1) * k) / 6,
        820.6,
        bx + m(cell) + (m(1) * k) / 6,
        825.4,
      );
  c.end();
  label('1 : 100', 1340, 806, 40);
  label('ebwwn', 1290, 806, 30);

  // Lettering: the strokes a stroke font draws inside each label's box.
  c.layer('TEXT').pen(COLORS.ink, 0.5);
  for (const [x, y, w, h] of lettering)
    for (let k = 1; k <= 4; k++)
      c.line(x + (w * k) / 5, y + h * 0.3, x + (w * k) / 5, y + h * 0.7);
  c.end();

  // A second page: a detail at another scale, with no layers and no comments.
  const detail = new Content();
  detail.pen(COLORS.ink, 1).line(20, 100, 220, 100).text('SCALE 1:50', 20, 30);

  return [
    { ...SHEET, content: c, comments },
    { width: 300, height: 200, content: detail },
  ];
}

export function sampleDrawing(options: PdfOptions = {}): Buffer {
  return buildPdf(samplePages(), { hidden: ['OLD'], ...options });
}

/** One metre at a true 1:100, in points. */
const TRUE_M = (72 / 25.4) * 10;

/**
 * A second small sheet for the odd cases: a line broken wide for its linetype
 * letters, a layer whose name holds a plus sign, and a tag whose size is font
 * text. It states its scale in font text and has no scale bar.
 */
export function oddDrawing(): Buffer {
  const c = new Content();
  const comments: Comment[] = [];
  // A hydrant line of 14 m: pieces of 80 points, breaks of 34 points (12 mm),
  // each with the letters HF in it.
  c.layer('HYDRANT').pen(COLORS.fire, 0.6);
  const end = 100 + 14 * TRUE_M;
  for (let x = 100; x < end; x += 114) {
    c.line(x, 300, Math.min(end, x + 80), 300);
    if (x + 114 < end) c.text('HF', x + 91, 304, 8);
  }
  c.end();
  c.layer('A+B')
    .pen(COLORS.water, 1.5)
    .line(100, 400, 100 + 5 * TRUE_M, 400)
    .end();
  c.layer('C')
    .pen(COLORS.rain, 1.5)
    .line(100, 450, 100 + 3 * TRUE_M, 450)
    .end();
  // A line dashed wider than the default gap: 40 points on, 27 off (9.5 mm),
  // over 8 m.
  c.layer('WIDE').pen(COLORS.water, 0.6);
  for (let x = 100; x < 100 + 8 * TRUE_M; x += 67)
    c.line(x, 500, Math.min(100 + 8 * TRUE_M, x + 40), 500);
  c.end();
  // A pipe of 6 m dashed 30 on, 6 off, and its linetype letters plotted as
  // strokes: a bar of 3 points every 15, two points beside the pipe.
  c.layer('SPR').pen(COLORS.fire, 0.6);
  for (let x = 100; x < 100 + 6 * TRUE_M; x += 36)
    c.line(x, 550, Math.min(100 + 6 * TRUE_M, x + 30), 550);
  for (let x = 100; x < 100 + 6 * TRUE_M - 3; x += 15)
    c.line(x, 548, x + 3, 548);
  c.end();
  // A sewer line of 8 m whose size label sits 2.5 mm above it, as an office
  // writes them over a slope arrow: past the default reach of 1.5 mm.
  c.layer('SEW')
    .pen(COLORS.sewer, 0.6)
    .line(520, 200, 520 + 8 * TRUE_M, 200)
    .end();
  comments.push({ text: '%%C160-1%', x0: 600, y0: 180.9, x1: 650, y1: 192.9 });
  // A grey-water line whose size is written alone beside it, as one office
  // writes them; and a riser tag R2 whose size label lies beside another line.
  c.layer('GREY')
    .pen(COLORS.sewer, 0.6)
    .line(100, 150, 100 + 5 * TRUE_M, 150)
    .end();
  comments.push({ text: '%%C63', x0: 140, y0: 136, x1: 160, y1: 147 });
  // A fixture's label with its sizes in it, beside the same line further on.
  comments.push({ text: 'FD4"/2"', x0: 200, y0: 136, x1: 230, y1: 147 });
  // A water line named by its code, with its size written alone beside it.
  c.layer('CWL')
    .pen(COLORS.water, 0.6)
    .line(300, 120, 300 + 4 * TRUE_M, 120)
    .end();
  comments.push({ text: '%%C32', x0: 330, y0: 106, x1: 350, y1: 117 });
  comments.push({ text: 'CW1-%%C32', x0: 380, y0: 60, x1: 420, y1: 72 });
  c.layer('TAGLINE').pen(COLORS.rain, 0.6).line(650, 224, 760, 224).end();
  comments.push({ text: 'R2', x0: 689, y0: 194, x1: 711, y1: 206 });
  comments.push({ text: '%%C110', x0: 690, y0: 208, x1: 710, y1: 220 });
  // A coded size label that sits apart from its line, as one on a leader does.
  comments.push({ text: 'HF-%%C4"', x0: 275, y0: 234, x1: 325, y1: 246 });
  // A tag: a stroke-font identifier with its size in font text under it.
  comments.push({ text: 'R1', x0: 589, y0: 194, x1: 611, y1: 206 });
  c.text('4"', 594, 219, 10);
  c.text('SCALE 1:100', 500, 80, 10);
  return buildPdf([{ width: 800, height: 600, content: c, comments }]);
}

/**
 * A sheet whose drawing is a picture, as a print through a PDF printer makes
 * it: four picture tiles cover the page, and only the column grid and one
 * label are drawn as lines and text over them. It keeps no layers.
 */
export function pictureDrawing(): Buffer {
  const c = new Content();
  const tile = (x: number, y: number) =>
    c.ops.push({
      kind: 'raw',
      text: `q 400 0 0 300 ${x} ${y} cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x88\x88 EI Q`,
    });
  tile(0, 0);
  tile(400, 0);
  tile(0, 300);
  tile(400, 300);
  c.pen(0xff8888, 0.5);
  for (const x of [100, 300, 500, 700]) c.line(x, 50, x, 550);
  for (const y of [100, 300, 500]) c.line(50, y, 750, y);
  c.text('SCALE 1:100', 600, 560, 10);
  return buildPdf([{ width: 800, height: 600, content: c }]);
}

/** A page that is one picture and nothing else, as a scan is. */
export function scanLike(): Buffer {
  const c = new Content();
  c.ops.push({
    kind: 'raw',
    text: 'q 200 0 0 100 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q',
  });
  return buildPdf([{ width: 200, height: 100, content: c }]);
}
