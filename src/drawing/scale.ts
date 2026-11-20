// The sheet's scale: the ratio its title block states, refined by the printed
// scale bar when one is found. A plot is often a little off its stated scale,
// and the bar is drawn with the plan, so it carries the true factor.

import type { Sheet } from './model.ts';

export interface Scale {
  /** The N of 1:N. */
  ratio: number;
  /** Sheet points per metre in the building. */
  ptPerM: number;
  /**
   * bar: the ratio, refined by the scale bar; label: the ratio the sheet
   * states, taken as true; flag: what the caller gave, taken as true.
   */
  basis: 'flag' | 'bar' | 'label';
  /** Whether the ratio came from the caller instead of the sheet. */
  given: boolean;
  /** Every ratio the sheet states, most likely first. */
  stated: number[];
  /** The bar that was used: its length in metres and where it is. */
  bar?: { metres: number; cells: number; x: number; y: number };
}

export const nominalPtPerM = (ratio: number): number =>
  ((72 / 25.4) * 1000) / ratio;

const RATIO = /(?:^|[^\d.])1\s*[:/]\s*(\d{1,5})(?![\d.])/;
const KEYWORD =
  /scale|sc\.|\u05e7\u05e0"\u05de|\u05e7\u05e0''\u05de|\u05e7\u05e0\u05d4\s*\u05de\u05d9\u05d3\u05d4|[\u00e9e]chelle|ma(?:ss|\u00df)stab|escala/i;

/** Ratios the sheet states, with how strongly each looks like the sheet's own. */
export function statedRatios(sheet: Sheet): number[] {
  const score = new Map<number, number>();
  const keywords = sheet.labels.filter((l) => KEYWORD.test(l.text));
  for (const label of sheet.labels) {
    const m = RATIO.exec(label.text);
    if (!m) continue;
    const ratio = Number(m[1]);
    if (!(ratio >= 1 && ratio <= 50000)) continue;
    let points = 1;
    if (KEYWORD.test(label.text)) points += 10;
    // A bare ratio beside a "scale" caption is the title block's.
    const cx = (label.x0 + label.x1) / 2;
    const cy = (label.y0 + label.y1) / 2;
    if (
      keywords.some(
        (k) =>
          Math.abs((k.x0 + k.x1) / 2 - cx) < 200 &&
          Math.abs((k.y0 + k.y1) / 2 - cy) < 60,
      )
    )
      points += 10;
    if (/^\s*1\s*[:/]\s*\d+\s*$/.test(label.text)) points += 2;
    score.set(ratio, (score.get(ratio) ?? 0) + points);
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([ratio]) => ratio);
}

const ROUND_METRES = [
  0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 100, 150, 200, 250,
  500, 1000, 2000, 5000,
];

interface Edge {
  /** Position across the bar. */
  at: number;
  /** Extent along the bar. */
  from: number;
  to: number;
  horizontal: boolean;
}

/**
 * Find a scale bar: two equal parallel edges whose length is a round number
 * of metres at the stated ratio (within 5%), with alternating dark and light
 * cells between them. Returns points per metre and the bar, or null.
 */
export function findScaleBar(
  sheet: Sheet,
  ratio: number,
): { ptPerM: number; bar: NonNullable<Scale['bar']> } | null {
  const nominal = nominalPtPerM(ratio);
  const edges: Edge[] = [];
  for (const stroke of sheet.strokes) {
    const p = stroke.pts;
    if (p.length > 10) continue;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i] as number;
      const y0 = p[i + 1] as number;
      const x1 = p[i + 2] as number;
      const y1 = p[i + 3] as number;
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      const length = Math.max(dx, dy);
      if (length < 40 || length > 1500 || Math.min(dx, dy) > 0.05) continue;
      const metres = length / nominal;
      if (!ROUND_METRES.some((r) => Math.abs(metres / r - 1) <= 0.05)) continue;
      edges.push(
        dx > dy
          ? {
              at: y0,
              from: Math.min(x0, x1),
              to: Math.max(x0, x1),
              horizontal: true,
            }
          : {
              at: x0,
              from: Math.min(y0, y1),
              to: Math.max(y0, y1),
              horizontal: false,
            },
      );
    }
  }
  let best: {
    ptPerM: number;
    bar: NonNullable<Scale['bar']>;
    cells: number;
    beside: number;
  } | null = null;
  // Twin edges start at the same place, so only those are compared.
  const buckets = new Map<string, Edge[]>();
  const bucketKey = (e: Edge, shift: number) =>
    `${e.horizontal ? 'h' : 'v'}${Math.round(e.from) + shift}`;
  for (const e of edges) {
    const list = buckets.get(bucketKey(e, 0));
    if (list) list.push(e);
    else buckets.set(bucketKey(e, 0), [e]);
  }
  const seen = new Set<string>();
  let ink: InkIndex | null = null;
  for (const a of edges) {
    const near = [-1, 0, 1].flatMap((d) => buckets.get(bucketKey(a, d)) ?? []);
    for (const b of near) {
      if (a === b) continue;
      const depth = b.at - a.at;
      if (depth < 1.5 || depth > 40) continue;
      if (Math.abs(a.from - b.from) > 0.5 || Math.abs(a.to - b.to) > 0.5)
        continue;
      const key = `${a.horizontal}:${a.at.toFixed(1)}:${b.at.toFixed(1)}:${a.from.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const length = a.to - a.from;
      const metres = ROUND_METRES.find(
        (r) => Math.abs(length / nominal / r - 1) <= 0.05,
      ) as number;
      ink ??= inkIndex(sheet);
      const cells = barCells(ink, a, b);
      if (cells < 4) continue;
      // A scale bar stands alone. A hatch, such as paving drawn in the plan,
      // is a field: the same ink goes on beyond the band on both sides. Of
      // equal bars, the one with the least ink beside it is taken.
      const beside = besideInk(ink, a, b);
      if (beside === null) continue;
      if (
        !best ||
        cells > best.cells ||
        (cells === best.cells && beside < best.beside)
      )
        best = {
          beside,
          ptPerM: length / metres,
          cells,
          bar: {
            metres,
            cells,
            x: a.horizontal ? a.from : a.at,
            y: a.horizontal ? a.at : a.from,
          },
        };
    }
  }
  return best ? { ptPerM: best.ptPerM, bar: best.bar } : null;
}

const INK_CELL = 64;
type InkIndex = Map<
  number,
  Array<{ x: number; y: number; size: number; weight: number }>
>;

/** Where the sheet's ink is, in a coarse grid: each segment and small fill. */
function inkIndex(sheet: Sheet): InkIndex {
  const index: InkIndex = new Map();
  const add = (x: number, y: number, size: number, weight: number) => {
    const key = Math.floor(x / INK_CELL) * 100_003 + Math.floor(y / INK_CELL);
    const list = index.get(key);
    if (list) list.push({ x, y, size, weight });
    else index.set(key, [{ x, y, size, weight }]);
  };
  for (const stroke of sheet.strokes) {
    const p = stroke.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i] as number;
      const y0 = p[i + 1] as number;
      const x1 = p[i + 2] as number;
      const y1 = p[i + 3] as number;
      const size = Math.hypot(x1 - x0, y1 - y0);
      add((x0 + x1) / 2, (y0 + y1) / 2, size, size);
    }
  }
  for (const f of sheet.fills)
    add(
      (f.x0 + f.x1) / 2,
      (f.y0 + f.y1) / 2,
      Math.max(f.x1 - f.x0, f.y1 - f.y0),
      Math.sqrt(f.area) * 4,
    );
  return index;
}

/**
 * How many alternating cells lie between two edges, or 0. A bar is one row of
 * dark and light cells, or two rows in a checker pattern.
 */
/** The ink that lies within a band along a bar, at an offset across it. */
function bandInk(ink: InkIndex, a: Edge, from: number, to: number): number {
  const length = a.to - a.from;
  const x0 = a.horizontal ? a.from : from;
  const x1 = a.horizontal ? a.to : to;
  const y0 = a.horizontal ? from : a.from;
  const y1 = a.horizontal ? to : a.to;
  let total = 0;
  for (
    let gx = Math.floor(x0 / INK_CELL);
    gx <= Math.floor(x1 / INK_CELL);
    gx++
  )
    for (
      let gy = Math.floor(y0 / INK_CELL);
      gy <= Math.floor(y1 / INK_CELL);
      gy++
    )
      for (const mark of ink.get(gx * 100_003 + gy) ?? []) {
        if (mark.size > length * 0.35) continue;
        if (mark.x > x0 && mark.x < x1 && mark.y > y0 && mark.y < y1)
          total += mark.weight;
      }
  return total;
}

/**
 * The ink beside a bar's band, as a share of the band's own: the bands of
 * the same depth on each side. Null when the bar sits in a field of the same
 * ink, both sides holding at least half as much as the bar.
 */
function besideInk(ink: InkIndex, a: Edge, b: Edge): number | null {
  const depth = b.at - a.at;
  const own = bandInk(ink, a, a.at, b.at);
  if (own <= 0) return 0;
  const before = bandInk(ink, a, a.at - depth, a.at) / own;
  const after = bandInk(ink, a, b.at, b.at + depth) / own;
  return before >= 0.5 && after >= 0.5 ? null : before + after;
}

function barCells(ink: InkIndex, a: Edge, b: Edge): number {
  const length = a.to - a.from;
  const depth = b.at - a.at;
  // Ink inside the band, as positions along the bar and across it (0 to 1).
  const marks: Array<{ along: number; across: number; weight: number }> = [];
  const x0 = a.horizontal ? a.from : a.at;
  const y0 = a.horizontal ? a.at : a.from;
  const x1 = a.horizontal ? a.to : b.at;
  const y1 = a.horizontal ? b.at : a.to;
  for (
    let gx = Math.floor(x0 / INK_CELL);
    gx <= Math.floor(x1 / INK_CELL);
    gx++
  ) {
    for (
      let gy = Math.floor(y0 / INK_CELL);
      gy <= Math.floor(y1 / INK_CELL);
      gy++
    ) {
      for (const mark of ink.get(gx * 100_003 + gy) ?? []) {
        // A line along the whole bar is a frame or divider, not a cell's ink.
        if (mark.size > length * 0.35) continue;
        const along = ((a.horizontal ? mark.x : mark.y) - a.from) / length;
        const across = ((a.horizontal ? mark.y : mark.x) - a.at) / depth;
        if (along > 0 && along < 1 && across > 0.02 && across < 0.98)
          marks.push({ along, across, weight: mark.weight });
      }
    }
  }
  if (marks.length < 4) return 0;
  for (const cells of [10, 20, 5, 4, 8, 6]) {
    const top = new Array<number>(cells).fill(0);
    const bottom = new Array<number>(cells).fill(0);
    for (const m of marks) {
      const i = Math.min(cells - 1, Math.floor(m.along * cells));
      if (m.across < 0.5) top[i] = (top[i] as number) + m.weight;
      else bottom[i] = (bottom[i] as number) + m.weight;
    }
    const all = top.map((t, i) => t + (bottom[i] as number));
    const mean = all.reduce((s, v) => s + v, 0) / cells;
    if (mean <= 0) continue;
    // One row: dark and light cells alternate along the bar.
    const dark = all.map((v) => v > mean * 1.4);
    const light = all.map((v) => v < mean * 0.6);
    const oneRow =
      all.every((_, i) => (i % 2 === 0 ? dark[i] : light[i])) ||
      all.every((_, i) => (i % 2 === 0 ? light[i] : dark[i]));
    // Two rows: the dark half swaps sides from cell to cell.
    const side = top.map((t, i) => {
      const bt = bottom[i] as number;
      if (t > bt * 3 && t > mean * 0.3) return 1;
      if (bt > t * 3 && bt > mean * 0.3) return -1;
      return 0;
    });
    const checker =
      side.every((s) => s !== 0) &&
      side.every((s, i) => i === 0 || s === -(side[i - 1] as number));
    if (oneRow || checker) return cells;
  }
  return 0;
}

export class ScaleUnknown extends Error {
  readonly stated: number[];
  constructor(stated: number[]) {
    super('the scale is not known');
    this.name = 'ScaleUnknown';
    this.stated = stated;
  }
}

export interface ScaleOptions {
  /** A ratio the caller gives: the N of 1:N. */
  ratio?: number;
  /** Points per metre the caller measured; overrides everything. */
  ptPerM?: number;
}

export function sheetScale(sheet: Sheet, options: ScaleOptions = {}): Scale {
  const stated = statedRatios(sheet);
  if (options.ptPerM !== undefined) {
    return {
      ratio: options.ratio ?? Math.round(nominalPtPerM(1) / options.ptPerM),
      ptPerM: options.ptPerM,
      basis: 'flag',
      given: true,
      stated,
    };
  }
  const ratio = options.ratio ?? stated[0];
  if (ratio === undefined) throw new ScaleUnknown(stated);
  const given = options.ratio !== undefined;
  const found = findScaleBar(sheet, ratio);
  if (found)
    return {
      ratio,
      ptPerM: found.ptPerM,
      basis: 'bar',
      given,
      stated,
      bar: found.bar,
    };
  return {
    ratio,
    ptPerM: nominalPtPerM(ratio),
    basis: given ? 'flag' : 'label',
    given,
    stated,
  };
}
