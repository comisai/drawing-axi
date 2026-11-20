// Pipe sizes are written beside the pipe: "Ø160-1%", "F-Ø3"", "DN100". A run
// takes the size of a label written along it: just above or below the line,
// or in a break left in the line for it. A run with no label of its own takes
// the size of the runs of its group that it touches, when they all agree. The
// rest stays unsized, and is reported as such.
//
// Pipes of different systems run side by side and cross. A line that passes
// straight through a label's text is not that label's pipe, so it is refused.

import type { Label } from './model.ts';
import { drawnWithin, type Run, runsTouch } from './runs.ts';

export interface SizeLabel {
  /** Normalised: Ø110, 3", DN100. */
  size: string;
  /** The label as written. */
  text: string;
  /** The system code it starts with, letters only: F, CW, HF. Null without one. */
  code: string | null;
  /** Written as a run label: it carries a slope or a system prefix. */
  onRun: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  vertical: boolean;
  /** One character: its direction cannot be told from its box. */
  short: boolean;
}

const METRIC = /\u00d8\s*(\d{1,4}(?:\.\d+)?)(?!\s*["\d.])/;
const INCH = /(?:\u00d8\s*)?(\d{1,2}(?:\.\d+)?(?:\s*\d\/\d)?|\d\/\d)\s*"/;
const DN = /\bDN\s*(\d{2,4})\b/i;
const SLOPE = /\d\s*-\s*\d+(?:\.\d+)?\s*%|\d\s*%/;
const PREFIX = /^[A-Za-z][A-Za-z0-9.]{0,5}\s*-/;

/** A system code reduced to its letters: "C.W.2-" and "CW1" are both CW. */
export function codeOf(text: string): string | null {
  const letters = text.replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters || null;
}

/** The pipe size a label states, or null. */
export function sizeOf(text: string): string | null {
  const t = text.trim();
  const dn = DN.exec(t);
  if (dn) return `DN${dn[1]}`;
  const inch = INCH.exec(t);
  const metric = METRIC.exec(t);
  if (inch && (!metric || inch.index <= metric.index))
    return `${(inch[1] as string).replace(/\s+/g, ' ')}"`;
  if (metric) return `\u00d8${metric[1]}`;
  return null;
}

export function sizeLabels(labels: readonly Label[]): SizeLabel[] {
  const out: SizeLabel[] = [];
  for (const label of labels) {
    // One label that lists several sizes is a legend line, not a pipe's size.
    if ((label.text.match(/\u00d8/g)?.length ?? 0) > 1) continue;
    const size = sizeOf(label.text);
    if (!size) continue;
    const prefix = PREFIX.exec(label.text.trim());
    out.push({
      size,
      text: label.text.trim(),
      code: prefix ? codeOf(prefix[0]) : null,
      onRun: SLOPE.test(label.text) || prefix !== null,
      x0: label.x0,
      y0: label.y0,
      x1: label.x1,
      y1: label.y1,
      vertical: label.vertical,
      short: label.text.trim().length <= 1,
    });
  }
  return out;
}

export interface GroupedRun extends Run {
  /** Runs share sizes only within one group. */
  group: number;
}

export interface SizedRun extends GroupedRun {
  size: string | null;
  /** label: a label is written along it; neighbour: taken from touching runs. */
  basis: 'label' | 'neighbour' | 'none';
  /** The label that sized it, as written. Null unless the basis is a label. */
  label: string | null;
}

export interface SizeOptions {
  /** A label beside a run may leave this much clear space to it, in points. */
  reach: number;
  /** Runs within this distance touch, in points. */
  touch?: number;
  /**
   * Each group's system code, by group number; null for a group with none. A
   * label with a code sizes only runs of the group with that code, and never
   * a run of a group with another code.
   */
  codes?: ReadonlyArray<string | null>;
}

interface Vote {
  count: number;
  score: number;
  /** The best-fitting label of this size, as written. */
  label: string;
}

export function sizeRuns(
  runs: readonly GroupedRun[],
  labels: readonly SizeLabel[],
  options: SizeOptions,
  /** Set to how many labels found a run to size. */
  placed?: { count: number; missed?: SizeLabel[] },
): SizedRun[] {
  const out: SizedRun[] = runs.map((r) => ({
    ...r,
    size: null,
    basis: 'none',
    label: null,
  }));
  const codes = options.codes ?? [];
  const bound = new Set(codes.filter((c): c is string => c !== null));
  // Runs in a grid, so each label looks only at those near it. A label names
  // one pipe, so it gives its size to the one run that fits it best.
  const cell = 48;
  const grid = new Map<number, number[]>();
  const keyOf = (gx: number, gy: number) => gx * 1_000_003 + gy;
  out.forEach((run, index) => {
    const steps = Math.max(1, Math.ceil(run.length / (cell / 2)));
    let last = Number.NaN;
    for (let s = 0; s <= steps; s++) {
      const k = keyOf(
        Math.floor((run.x0 + ((run.x1 - run.x0) * s) / steps) / cell),
        Math.floor((run.y0 + ((run.y1 - run.y0) * s) / steps) / cell),
      );
      if (k === last) continue;
      last = k;
      const list = grid.get(k);
      if (list) list.push(index);
      else grid.set(k, [index]);
    }
  });
  const votes: Array<Map<string, Vote>> = out.map(() => new Map());
  for (const label of labels) {
    const cx = (label.x0 + label.x1) / 2;
    const cy = (label.y0 + label.y1) / 2;
    const gx = Math.floor(cx / cell);
    const gy = Math.floor(cy / cell);
    let best = -1;
    let bestScore = Infinity;
    const tried = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of grid.get(keyOf(gx + dx, gy + dy)) ?? []) {
          if (tried.has(index)) continue;
          tried.add(index);
          const groupCode = codes[(out[index] as SizedRun).group] ?? null;
          const score = fit(label, cx, cy, out[index] as SizedRun, options);
          // A label written in a break of a line is that line's, whatever
          // the groups are called. Beside a line, a coded label belongs to
          // the group of that code, when there is one, and never to a group
          // of another code.
          if (score >= 1 && label.code !== null) {
            if (bound.has(label.code) && groupCode !== label.code) continue;
            if (groupCode !== null && groupCode !== label.code) continue;
          }
          if (score < bestScore) {
            best = index;
            bestScore = score;
          }
        }
      }
    }
    if (best < 0) {
      placed?.missed?.push(label);
      continue;
    }
    if (placed) placed.count++;
    const tally = votes[best] as Map<string, Vote>;
    const entry = tally.get(label.size);
    if (entry) {
      entry.count++;
      if (bestScore < entry.score) {
        entry.score = bestScore;
        entry.label = label.text;
      }
    } else
      tally.set(label.size, { count: 1, score: bestScore, label: label.text });
  }
  out.forEach((run, index) => {
    let chosen: string | null = null;
    let top: Vote = { count: 0, score: Infinity, label: '' };
    for (const [size, entry] of votes[index] as Map<string, Vote>) {
      if (
        entry.count > top.count ||
        (entry.count === top.count && entry.score < top.score)
      ) {
        chosen = size;
        top = entry;
      }
    }
    if (chosen) {
      run.size = chosen;
      run.basis = 'label';
      run.label = top.label;
    }
  });

  // Unsized runs take the size of the sized runs they touch, when those agree.
  const touch = options.touch ?? 3;
  interface Boxed {
    run: SizedRun;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    near: Boxed[];
  }
  const boxed: Boxed[] = out
    .map((run) => ({
      run,
      x0: Math.min(run.x0, run.x1) - touch,
      y0: Math.min(run.y0, run.y1) - touch,
      x1: Math.max(run.x0, run.x1) + touch,
      y1: Math.max(run.y0, run.y1) + touch,
      near: [] as Boxed[],
    }))
    .sort((a, b) => a.x0 - b.x0);
  boxed.forEach((a, at) => {
    for (let k = at + 1; k < boxed.length; k++) {
      const b = boxed[k] as Boxed;
      if (b.x0 > a.x1) break;
      if (b.run.group !== a.run.group) continue;
      if (b.y0 > a.y1 || b.y1 < a.y0) continue;
      if (runsTouch(a.run, b.run, touch)) {
        a.near.push(b);
        b.near.push(a);
      }
    }
  });
  for (let round = 0; round < 40; round++) {
    const taken: Array<[SizedRun, string]> = [];
    for (const item of boxed) {
      if (item.run.size) continue;
      const sizes = new Set<string>();
      for (const other of item.near)
        if (other.run.size) sizes.add(other.run.size);
      if (sizes.size === 1) taken.push([item.run, [...sizes][0] as string]);
    }
    if (!taken.length) break;
    for (const [run, size] of taken) {
      run.size = size;
      run.basis = 'neighbour';
    }
  }
  return out;
}

/**
 * How well a label fits a run: lower is better, Infinity is no fit. A label
 * fits when it sits in a break in the line, or beside the line with at most
 * `reach` of clear space.
 */
function fit(
  label: SizeLabel,
  cx: number,
  cy: number,
  run: Run,
  options: SizeOptions,
): number {
  const length = run.length;
  if (!length) return Infinity;
  const ux = (run.x1 - run.x0) / length;
  const uy = (run.y1 - run.y0) / length;
  const along = (cx - run.x0) * ux + (cy - run.y0) * uy;
  if (along < -6 || along > length + 6) return Infinity;
  const off = Math.abs((cx - run.x0) * uy - (cy - run.y0) * ux);
  const width = label.x1 - label.x0;
  const height = label.y1 - label.y0;
  if (Math.abs(ux) > 0.2 && Math.abs(uy) > 0.2) {
    // A sloping run: the label's box says little about its text line.
    const half = Math.min(width, height) / 2;
    return off <= half + options.reach ? 2 + off : Infinity;
  }
  const runVertical = Math.abs(uy) > Math.abs(ux);
  // A label is written along its pipe.
  if (!label.short && label.vertical !== runVertical) return Infinity;
  const half = (runVertical ? width : height) / 2;
  const span = (runVertical ? height : width) / 2;
  // A label's box is padded, so its own pipe may graze the box's edge. A line
  // through the middle of the text is another pipe passing under it, unless
  // the line is broken there to make room for the label.
  if (off < half * 0.5) {
    const inked = drawnWithin(run, along - span * 0.8, along + span * 0.8);
    return inked <= span * 0.2 ? off / 100 : Infinity;
  }
  return off - half <= options.reach
    ? 1 + Math.abs(off - half * 0.8)
    : Infinity;
}
