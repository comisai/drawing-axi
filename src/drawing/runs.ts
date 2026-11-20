// Pipes are plotted as dashes, and broken where a letter or a symbol sits on
// the line. A run is the straight length such pieces add up to: pieces that
// lie on one line, end near each other, are joined and measured end to end.

import type { Stroke } from './model.ts';

export interface Run {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** End to end, in points. */
  length: number;
  /** How many drawn pieces it joins. */
  parts: number;
  /**
   * Where ink lies along the run: start and end of each drawn stretch, in
   * points from (x0, y0), sorted and merged.
   */
  drawn: number[];
}

export interface RunOptions {
  /** Join pieces whose ends are at most this far apart, in points. */
  gap: number;
  /** A piece may sit this far off the line, in points. */
  offset?: number;
  /** Pieces may differ in direction by this many degrees. */
  angle?: number;
  /**
   * Where linetype letters sit. A line is broken wider for a letter than for
   * a dash, so a break with a letter in it is joined up to `letterGap`.
   */
  letters?: ReadonlyArray<{ x: number; y: number }>;
  /** The widest break a letter may bridge, in points. */
  letterGap?: number;
  /** A letter may sit this far off the line, in points. */
  letterOffset?: number;
}

/** Pieces at most this long, in points, are dots: they are not joined. */
const MIN_PIECE = 0.3;

/** The most line ends and pairs looked at when joining across letters. */
const LETTER_WORK = 20_000_000;

/** Split strokes into single segments, dropping dots and exact repeats. */
export function segmentsOf(strokes: Iterable<Stroke>): Float64Array {
  const out: number[] = [];
  const seen = new Set<string>();
  for (const stroke of strokes) {
    const p = stroke.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i] as number;
      const y0 = p[i + 1] as number;
      const x1 = p[i + 2] as number;
      const y1 = p[i + 3] as number;
      // A piece too short to have a direction would join runs that meet at
      // a corner into one, and lose the shorter run's length.
      if (Math.hypot(x1 - x0, y1 - y0) <= MIN_PIECE) continue;
      const a = `${x0.toFixed(2)},${y0.toFixed(2)}`;
      const b = `${x1.toFixed(2)},${y1.toFixed(2)}`;
      const key = a < b ? `${a};${b}` : `${b};${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x0, y0, x1, y1);
    }
  }
  return Float64Array.from(out);
}

export function buildRuns(segs: Float64Array, options: RunOptions): Run[] {
  const n = segs.length / 4;
  const gap = options.gap;
  const offset = options.offset ?? 0.8;
  const sinMax = Math.sin(((options.angle ?? 4) * Math.PI) / 180);
  const lengths = new Float64Array(n);
  for (let i = 0; i < n; i++)
    lengths[i] = Math.hypot(
      (segs[i * 4 + 2] as number) - (segs[i * 4] as number),
      (segs[i * 4 + 3] as number) - (segs[i * 4 + 1] as number),
    );
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) {
      const next = parent[i] as number;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const cell = Math.max(gap, 1);
  const grid = new Map<number, number[]>();
  const keyOf = (gx: number, gy: number) => gx * 1_000_003 + gy;
  for (let i = 0; i < n; i++) {
    for (let e = 0; e < 2; e++) {
      const k = keyOf(
        Math.floor((segs[i * 4 + e * 2] as number) / cell),
        Math.floor((segs[i * 4 + e * 2 + 1] as number) / cell),
      );
      const list = grid.get(k);
      // The entry is the segment index and which end, packed.
      if (list) list.push(i * 2 + e);
      else grid.set(k, [i * 2 + e]);
    }
  }
  for (let i = 0; i < n; i++) {
    const li = lengths[i] as number;
    const ax = segs[i * 4] as number;
    const ay = segs[i * 4 + 1] as number;
    const ux = ((segs[i * 4 + 2] as number) - ax) / li;
    const uy = ((segs[i * 4 + 3] as number) - ay) / li;
    for (let e = 0; e < 2; e++) {
      const x = segs[i * 4 + e * 2] as number;
      const y = segs[i * 4 + e * 2 + 1] as number;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = grid.get(keyOf(gx, gy));
          if (!list) continue;
          for (const packed of list) {
            const j = packed >> 1;
            if (j <= i) continue;
            const f = packed & 1;
            const dx = (segs[j * 4 + f * 2] as number) - x;
            const dy = (segs[j * 4 + f * 2 + 1] as number) - y;
            if (dx * dx + dy * dy > gap * gap) continue;
            const lj = lengths[j] as number;
            const bx = segs[j * 4] as number;
            const by = segs[j * 4 + 1] as number;
            const vx = ((segs[j * 4 + 2] as number) - bx) / lj;
            const vy = ((segs[j * 4 + 3] as number) - by) / lj;
            if (Math.abs(ux * vy - uy * vx) > sinMax) continue;
            // Both ends of the shorter piece must sit on the longer one's line.
            const onLine =
              li >= lj
                ? Math.abs((bx - ax) * uy - (by - ay) * ux) <= offset &&
                  Math.abs(
                    ((segs[j * 4 + 2] as number) - ax) * uy -
                      ((segs[j * 4 + 3] as number) - ay) * ux,
                  ) <= offset
                : Math.abs((ax - bx) * vy - (ay - by) * vx) <= offset &&
                  Math.abs(
                    ((segs[i * 4 + 2] as number) - bx) * vy -
                      ((segs[i * 4 + 3] as number) - by) * vx,
                  ) <= offset;
            if (!onLine) continue;
            const ri = find(i);
            const rj = find(j);
            if (ri !== rj) parent[ri] = rj;
          }
        }
      }
    }
  }
  // A break with a linetype letter in it: join the two pieces that face each
  // other across the letter, on one line, at most `letterGap` apart.
  const letterGap = options.letterGap ?? 0;
  if (options.letters?.length && letterGap > gap) {
    const letterOffset = options.letterOffset ?? 6;
    const wide = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      for (let e = 0; e < 2; e++) {
        const k = keyOf(
          Math.floor((segs[i * 4 + e * 2] as number) / letterGap),
          Math.floor((segs[i * 4 + e * 2 + 1] as number) / letterGap),
        );
        const list = wide.get(k);
        if (list) list.push(i * 2 + e);
        else wide.set(k, [i * 2 + e]);
      }
    }
    // Bounded work: a hostile file may pile every line end on one letter.
    let budget = LETTER_WORK;
    for (const letter of options.letters) {
      if (budget <= 0) break;
      // The ends that face the letter: the piece stops short of it, and its
      // line passes through it.
      const facing: number[] = [];
      const cx = Math.floor(letter.x / letterGap);
      const cy = Math.floor(letter.y / letterGap);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const packed of wide.get(keyOf(gx, gy)) ?? []) {
            budget--;
            const i = packed >> 1;
            const e = packed & 1;
            const li = lengths[i] as number;
            if (li <= MIN_PIECE) continue;
            const ax = segs[i * 4 + e * 2] as number;
            const ay = segs[i * 4 + e * 2 + 1] as number;
            const ux = (ax - (segs[i * 4 + (1 - e) * 2] as number)) / li;
            const uy = (ay - (segs[i * 4 + (1 - e) * 2 + 1] as number)) / li;
            const t = (letter.x - ax) * ux + (letter.y - ay) * uy;
            if (t <= 0 || t >= letterGap) continue;
            const off = Math.abs((letter.x - ax) * uy - (letter.y - ay) * ux);
            if (off <= letterOffset) facing.push(packed);
          }
        }
      }
      budget -= facing.length * facing.length;
      for (let a = 0; a < facing.length; a++) {
        const i = (facing[a] as number) >> 1;
        const ei = (facing[a] as number) & 1;
        const li = lengths[i] as number;
        const ax = segs[i * 4 + ei * 2] as number;
        const ay = segs[i * 4 + ei * 2 + 1] as number;
        // The first piece's direction, towards the break.
        const ux = (ax - (segs[i * 4 + (1 - ei) * 2] as number)) / li;
        const uy = (ay - (segs[i * 4 + (1 - ei) * 2 + 1] as number)) / li;
        for (let b = a + 1; b < facing.length; b++) {
          const j = (facing[b] as number) >> 1;
          if (i === j || find(i) === find(j)) continue;
          const ej = (facing[b] as number) & 1;
          const lj = lengths[j] as number;
          const bx = segs[j * 4 + ej * 2] as number;
          const by = segs[j * 4 + ej * 2 + 1] as number;
          const farBx = segs[j * 4 + (1 - ej) * 2] as number;
          const farBy = segs[j * 4 + (1 - ej) * 2 + 1] as number;
          // The second piece carries on along the same line, away from the
          // break: the same direction, and both its ends on the first
          // piece's line. Two pipes side by side are not one pipe.
          const vx = (farBx - bx) / lj;
          const vy = (farBy - by) / lj;
          if (ux * vx + uy * vy <= 0) continue;
          if (Math.abs(ux * vy - uy * vx) > sinMax) continue;
          if (
            Math.abs((bx - ax) * uy - (by - ay) * ux) > offset ||
            Math.abs((farBx - ax) * uy - (farBy - ay) * ux) > offset
          )
            continue;
          const span = (bx - ax) * ux + (by - ay) * uy;
          if (span <= 0 || span > letterGap) continue;
          parent[find(i)] = find(j);
        }
      }
    }
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }
  const runs: Run[] = [];
  for (const list of members.values()) {
    let longest = list[0] as number;
    for (const i of list)
      if ((lengths[i] as number) > (lengths[longest] as number)) longest = i;
    const l = lengths[longest] as number;
    const ux =
      ((segs[longest * 4 + 2] as number) - (segs[longest * 4] as number)) / l;
    const uy =
      ((segs[longest * 4 + 3] as number) - (segs[longest * 4 + 1] as number)) /
      l;
    let lo = Infinity;
    let hi = -Infinity;
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;
    for (const i of list) {
      for (let e = 0; e < 2; e++) {
        const x = segs[i * 4 + e * 2] as number;
        const y = segs[i * 4 + e * 2 + 1] as number;
        const t = x * ux + y * uy;
        if (t < lo) {
          lo = t;
          x0 = x;
          y0 = y;
        }
        if (t > hi) {
          hi = t;
          x1 = x;
          y1 = y;
        }
      }
    }
    const spans: Array<[number, number]> = [];
    for (const i of list) {
      const t0 =
        (segs[i * 4] as number) * ux + (segs[i * 4 + 1] as number) * uy;
      const t1 =
        (segs[i * 4 + 2] as number) * ux + (segs[i * 4 + 3] as number) * uy;
      spans.push(t0 < t1 ? [t0 - lo, t1 - lo] : [t1 - lo, t0 - lo]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const drawn: number[] = [];
    for (const [from, to] of spans) {
      const last = drawn.length - 1;
      if (last >= 0 && from <= (drawn[last] as number) + 0.05)
        drawn[last] = Math.max(drawn[last] as number, to);
      else drawn.push(from, to);
    }
    runs.push({ x0, y0, x1, y1, length: hi - lo, parts: list.length, drawn });
  }
  runs.sort((a, b) => b.length - a.length || a.x0 - b.x0 || a.y0 - b.y0);
  return runs;
}

/** How much of the stretch from `from` to `to` along a run carries ink. */
export function drawnWithin(run: Run, from: number, to: number): number {
  let covered = 0;
  for (let i = 0; i + 1 < run.drawn.length; i += 2) {
    const a = Math.max(from, run.drawn[i] as number);
    const b = Math.min(to, run.drawn[i + 1] as number);
    if (b > a) covered += b - a;
  }
  return covered;
}

/** The distance from a point to a run, in points. */
export function distanceToRun(x: number, y: number, run: Run): number {
  const vx = run.x1 - run.x0;
  const vy = run.y1 - run.y0;
  const l2 = vx * vx + vy * vy;
  const t = l2
    ? Math.max(0, Math.min(1, ((x - run.x0) * vx + (y - run.y0) * vy) / l2))
    : 0;
  return Math.hypot(x - (run.x0 + t * vx), y - (run.y0 + t * vy));
}

/** Whether two runs touch: an end of one lies on the other. */
export function runsTouch(a: Run, b: Run, tolerance: number): boolean {
  return (
    Math.min(
      distanceToRun(a.x0, a.y0, b),
      distanceToRun(a.x1, a.y1, b),
      distanceToRun(b.x0, b.y0, a),
      distanceToRun(b.x1, b.y1, a),
    ) < tolerance
  );
}

/** How far, in points, a shadow run may lie from the run it follows. */
const SHADOW_OFFSET = 5;

/** The share of a run's length that carries ink, from 0 to 1. */
export function inkShare(run: Run): number {
  if (!run.length) return 0;
  let ink = 0;
  for (let i = 0; i < run.drawn.length; i += 2)
    ink += (run.drawn[i + 1] as number) - (run.drawn[i] as number);
  return Math.min(1, ink / run.length);
}

/**
 * Leaves out runs that ride along a longer run: a row of linetype letters
 * plotted as strokes beside its pipe joins into a sparse line a point or two
 * off the pipe. A run is left out when it lies within a few points of a
 * longer run, along at least 70% of its own length, in the same direction,
 * and carries under half as much ink, which the other beats by a fifth. The
 * side lines of a pipe drawn with three lines are solid and stay.
 */
export function dropShadows(runs: readonly Run[]): {
  kept: Run[];
  dropped: number;
} {
  const sinMax = Math.sin((4 * Math.PI) / 180);
  const ink = runs.map(inkShare);
  const boxes = runs.map((r, i) => ({
    i,
    x0: Math.min(r.x0, r.x1) - SHADOW_OFFSET,
    x1: Math.max(r.x0, r.x1) + SHADOW_OFFSET,
    y0: Math.min(r.y0, r.y1) - SHADOW_OFFSET,
    y1: Math.max(r.y0, r.y1) + SHADOW_OFFSET,
  }));
  boxes.sort((a, b) => a.x0 - b.x0);
  const shadow = new Uint8Array(runs.length);
  for (let a = 0; a < boxes.length; a++) {
    const A = boxes[a] as (typeof boxes)[number];
    for (let b = a + 1; b < boxes.length; b++) {
      const B = boxes[b] as (typeof boxes)[number];
      if (B.x0 > A.x1) break;
      if (B.y0 > A.y1 || B.y1 < A.y0) continue;
      for (const [s, p] of [
        [A.i, B.i],
        [B.i, A.i],
      ] as const) {
        const short = runs[s] as Run;
        const long = runs[p] as Run;
        if (shadow[s] || long.length < short.length) continue;
        if (
          !(
            (ink[s] as number) < 0.5 &&
            (ink[p] as number) >= (ink[s] as number) + 0.2
          )
        )
          continue;
        const ux = (long.x1 - long.x0) / long.length;
        const uy = (long.y1 - long.y0) / long.length;
        const vx = (short.x1 - short.x0) / (short.length || 1);
        const vy = (short.y1 - short.y0) / (short.length || 1);
        if (Math.abs(ux * vy - uy * vx) > sinMax) continue;
        const off = (x: number, y: number) =>
          Math.abs((x - long.x0) * uy - (y - long.y0) * ux);
        if (
          off(short.x0, short.y0) > SHADOW_OFFSET ||
          off(short.x1, short.y1) > SHADOW_OFFSET
        )
          continue;
        const t0 = (short.x0 - long.x0) * ux + (short.y0 - long.y0) * uy;
        const t1 = (short.x1 - long.x0) * ux + (short.y1 - long.y0) * uy;
        const over =
          Math.min(long.length, Math.max(t0, t1)) -
          Math.max(0, Math.min(t0, t1));
        if (over >= short.length * 0.7) shadow[s] = 1;
      }
    }
  }
  const kept = runs.filter((_, i) => !shadow[i]);
  return { kept, dropped: runs.length - kept.length };
}
