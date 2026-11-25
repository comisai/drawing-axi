// The sheet's scale comes from its title block and can be refined by the
// printed bar. A large discrepancy needs a separate dimension to confirm it.

import type { Label, Sheet } from './model.ts';

interface ScaleBar {
  metres: number;
  cells: number;
  x: number;
  y: number;
  lengthPt: number;
  label?: string;
  ptPerM: number;
  differencePct: number;
  dimensionLabel?: string;
}

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
  /** The detected bar and its evidence, even when the nominal ratio is used. */
  bar?: ScaleBar;
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
const MAX_BAR_DIFFERENCE_PCT = 2;
const LABEL_REACH_PT = 16;

function labelMetres(text: string): number | undefined {
  const match = /^(\d{1,7}(?:\.\d{1,3})?)\s*(mm|cm|m)$/i.exec(text);
  if (!match) return undefined;
  const unit = match[2]?.toLowerCase();
  return Number(match[1]) / (unit === 'mm' ? 1000 : unit === 'cm' ? 100 : 1);
}

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
 * cells between them. Use the printed distance when the terminal label has units.
 */
function findScaleBar(sheet: Sheet, ratio: number): ScaleBar | null {
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
    edge: Edge;
    opposite: Edge;
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
        best = { edge: a, opposite: b, cells, beside };
    }
  }
  if (!best || !ink) return null;
  const { edge, opposite, cells } = best;
  const lengthPt = edge.to - edge.from;
  const inferred = ROUND_METRES.find(
    (r) => Math.abs(lengthPt / nominal / r - 1) <= 0.05,
  );
  if (inferred === undefined) return null;
  const printed = terminalLabel(sheet.labels, edge, opposite, cells, inferred);
  const metres = printed?.metres ?? inferred;
  const ptPerM = lengthPt / metres;
  // Round to hundredths of a percentage point before comparing to 2%.
  const differencePct = Math.round((ptPerM / nominal - 1) * 10_000) / 100;
  const dimensionLabel =
    Math.abs(differencePct) > MAX_BAR_DIFFERENCE_PCT
      ? confirmingDimension(sheet.labels, ink, edge, opposite, ptPerM)
      : undefined;
  return {
    metres,
    cells,
    x: edge.horizontal ? edge.from : edge.at,
    y: edge.horizontal ? edge.at : edge.from,
    lengthPt,
    ...(printed && { label: printed.text }),
    ptPerM,
    differencePct,
    ...(dimensionLabel && { dimensionLabel }),
  };
}

function terminalLabel(
  labels: readonly Label[],
  edge: Edge,
  opposite: Edge,
  cells: number,
  inferred: number,
): { text: string; metres: number } | undefined {
  const reach = Math.min(LABEL_REACH_PT, (edge.to - edge.from) / cells / 2);
  let nearest: { text: string; metres: number } | undefined;
  let best = Infinity;
  for (const { source, text, x0, x1, y0, y1 } of labels) {
    if (source === 'note') continue;
    const [from, to, low, high] = edge.horizontal
      ? [x0, x1, y0, y1]
      : [y0, y1, x0, x1];
    const end = Math.max(from - edge.to, edge.to - to, 0);
    const start = Math.max(from - edge.from, edge.from - to, 0);
    const along = Math.min(start, end);
    const across = Math.max(low - opposite.at, edge.at - high, 0);
    const distance = Math.hypot(along, across);
    if (along <= reach && across <= LABEL_REACH_PT && distance < best) {
      const caption = text.trim();
      // A bare number can identify the label, but it supplies no units.
      const metres =
        labelMetres(caption) ?? (caption === String(inferred) ? inferred : 0);
      if (metres <= 0) continue;
      best = distance;
      nearest = { text: caption, metres };
    }
  }
  return nearest;
}

const INK_CELL = 64;
interface InkMark {
  x: number;
  y: number;
  size: number;
  weight: number;
  axis: 'horizontal' | 'vertical' | null;
}
type InkIndex = Map<number, InkMark[]>;

/** A separate dimension needs a printed distance, a line and a crossing at each end. */
function confirmingDimension(
  labels: readonly Label[],
  ink: InkIndex,
  edge: Edge,
  opposite: Edge,
  ptPerM: number,
): string | undefined {
  for (const label of labels) {
    if (label.source === 'note') continue;
    const text = label.text.trim();
    const metres = labelMetres(text);
    if (!metres) continue;
    const x = (label.x0 + label.x1) / 2;
    const y = (label.y0 + label.y1) / 2;
    const along = edge.horizontal ? x : y;
    const across = edge.horizontal ? y : x;
    // The scale bar's own numbers and ticks cannot confirm it.
    if (
      along >= edge.from - LABEL_REACH_PT &&
      along <= edge.to + LABEL_REACH_PT &&
      across >= edge.at - LABEL_REACH_PT &&
      across <= opposite.at + LABEL_REACH_PT
    )
      continue;
    const axis = label.vertical ? 'vertical' : 'horizontal';
    for (const line of nearbyInk(ink, x, y, LABEL_REACH_PT)) {
      if (
        line.axis !== axis ||
        line.size < 20 ||
        Math.abs(line.size / (metres * ptPerM) - 1) > 0.01
      )
        continue;
      const dx = axis === 'horizontal' ? line.size / 2 : 0;
      const dy = axis === 'vertical' ? line.size / 2 : 0;
      if (
        crossesEnd(ink, line.x - dx, line.y - dy, axis) &&
        crossesEnd(ink, line.x + dx, line.y + dy, axis)
      )
        return text;
    }
  }
}

function crossesEnd(
  ink: InkIndex,
  x: number,
  y: number,
  axis: InkMark['axis'],
): boolean {
  const crossingAxis = axis === 'horizontal' ? 'vertical' : 'horizontal';
  for (const mark of nearbyInk(ink, x, y, 21)) {
    if (mark.axis !== crossingAxis || mark.size < 2 || mark.size > 40) continue;
    const dx = Math.abs(mark.x - x);
    const dy = Math.abs(mark.y - y);
    const [along, across] = axis === 'horizontal' ? [dx, dy] : [dy, dx];
    if (along <= 0.5 && across <= mark.size / 2 + 0.5) return true;
  }
  return false;
}

function* nearbyInk(
  ink: InkIndex,
  x: number,
  y: number,
  reach: number,
): Iterable<InkMark> {
  for (
    let gx = Math.floor((x - reach) / INK_CELL);
    gx <= Math.floor((x + reach) / INK_CELL);
    gx++
  )
    for (
      let gy = Math.floor((y - reach) / INK_CELL);
      gy <= Math.floor((y + reach) / INK_CELL);
      gy++
    )
      for (const mark of ink.get(gx * 100_003 + gy) ?? [])
        if (Math.abs(mark.x - x) <= reach && Math.abs(mark.y - y) <= reach)
          yield mark;
}

/** Where the sheet's ink is, in a coarse grid: each segment and small fill. */
function inkIndex(sheet: Sheet): InkIndex {
  const index: InkIndex = new Map();
  const add = (
    x: number,
    y: number,
    size: number,
    weight: number,
    axis: InkMark['axis'],
  ) => {
    const key = Math.floor(x / INK_CELL) * 100_003 + Math.floor(y / INK_CELL);
    const list = index.get(key);
    if (list) list.push({ x, y, size, weight, axis });
    else index.set(key, [{ x, y, size, weight, axis }]);
  };
  for (const stroke of sheet.strokes) {
    const p = stroke.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i] as number;
      const y0 = p[i + 1] as number;
      const x1 = p[i + 2] as number;
      const y1 = p[i + 3] as number;
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      const size = Math.hypot(dx, dy);
      const axis = dy <= 0.05 ? 'horizontal' : dx <= 0.05 ? 'vertical' : null;
      add((x0 + x1) / 2, (y0 + y1) / 2, size, size, axis);
    }
  }
  for (const f of sheet.fills)
    add(
      (f.x0 + f.x1) / 2,
      (f.y0 + f.y1) / 2,
      Math.max(f.x1 - f.x0, f.y1 - f.y0),
      Math.sqrt(f.area) * 4,
      null,
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
  const bar = findScaleBar(sheet, ratio);
  const useBar =
    bar !== null &&
    (Math.abs(bar.differencePct) <= MAX_BAR_DIFFERENCE_PCT ||
      bar.dimensionLabel !== undefined);
  return {
    ratio,
    ptPerM: useBar ? bar.ptPerM : nominalPtPerM(ratio),
    basis: useBar ? 'bar' : given ? 'flag' : 'label',
    given,
    stated,
    ...(bar && { bar }),
  };
}
