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
}

/** Pieces at most this long, in points, are dots: they are not joined. */
const MIN_PIECE = 0.3;

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
