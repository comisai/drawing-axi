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
  /**
   * Join piece a and piece b when end ea of one lies within the gap of end
   * eb of the other, they run the same way, and both ends of the shorter lie
   * on the longer one's line. The lower index goes first, so a tie in length
   * is settled the same way whichever end found the other.
   */
  const tryJoin = (a: number, ea: number, b: number, eb: number) => {
    const i = Math.min(a, b);
    const j = Math.max(a, b);
    const dx =
      (segs[b * 4 + eb * 2] as number) - (segs[a * 4 + ea * 2] as number);
    const dy =
      (segs[b * 4 + eb * 2 + 1] as number) -
      (segs[a * 4 + ea * 2 + 1] as number);
    if (dx * dx + dy * dy > gap * gap) return;
    const li = lengths[i] as number;
    const ax = segs[i * 4] as number;
    const ay = segs[i * 4 + 1] as number;
    const ux = ((segs[i * 4 + 2] as number) - ax) / li;
    const uy = ((segs[i * 4 + 3] as number) - ay) / li;
    const lj = lengths[j] as number;
    const bx = segs[j * 4] as number;
    const by = segs[j * 4 + 1] as number;
    const vx = ((segs[j * 4 + 2] as number) - bx) / lj;
    const vy = ((segs[j * 4 + 3] as number) - by) / lj;
    if (Math.abs(ux * vy - uy * vx) > sinMax) return;
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
    if (!onLine) return;
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };
  joinNear(segs, lengths, gap, offset, options.angle ?? 4, tryJoin);
  // A break with a linetype letter in it: join the two pieces that face each
  // other across the letter, on one line, at most `letterGap` apart.
  const letterGap = options.letterGap ?? 0;
  if (options.letters?.length && letterGap > gap) {
    const letterOffset = options.letterOffset ?? 6;
    const keyOf = (gx: number, gy: number) => gx * 1_000_003 + gy;
    // Only the cells next to a letter are looked at, so only their ends are
    // filed.
    const wide = new Map<number, number[]>();
    for (const letter of options.letters) {
      const cx = Math.floor(letter.x / letterGap);
      const cy = Math.floor(letter.y / letterGap);
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gy = cy - 1; gy <= cy + 1; gy++) wide.set(keyOf(gx, gy), []);
    }
    for (let i = 0; i < n; i++) {
      for (let e = 0; e < 2; e++) {
        const k = keyOf(
          Math.floor((segs[i * 4 + e * 2] as number) / letterGap),
          Math.floor((segs[i * 4 + e * 2 + 1] as number) / letterGap),
        );
        wide.get(k)?.push(i * 2 + e);
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

/**
 * Offer `join` every pair of ends that could join: within the gap of each
 * other, on pieces that run nearly the same way, and with the end of one
 * near the other's line. Pieces are sorted by direction into bins at least
 * as wide as the angle allowed, so a piece meets only those of its own bin
 * and the next. Within a bin, ends are filed by how far they lie across the
 * bin's direction, and sorted by how far along it, so an end looks only at
 * ends near its own line, and not at every end within the gap. Background
 * hatching that fills a sheet then costs little: its lines lie side by side.
 */
function joinNear(
  segs: Float64Array,
  lengths: Float64Array,
  gap: number,
  offset: number,
  angle: number,
  join: (a: number, ea: number, b: number, eb: number) => void,
): void {
  const n = lengths.length;
  // Strictly wider than the angle, so two pieces within it are never two
  // bins apart, and at most a right angle.
  const bins = Math.min(720, Math.max(1, Math.ceil(180 / angle) - 1)) || 1;
  const width = Math.PI / bins;
  const cos = new Float64Array(bins);
  const sin = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    cos[b] = Math.cos((b + 0.5) * width);
    sin[b] = Math.sin((b + 0.5) * width);
  }
  const sinOf = (a: number) => Math.sin(Math.min(a, Math.PI / 2));
  // How far across a bin's direction two ends that join may lie: the end of
  // one is within the offset of the other's line, and that line turns from
  // the bin's direction by half a bin within it, by one and a half from the
  // next bin.
  const slack = 1e-6;
  const across = offset + gap * sinOf(width / 2) + slack;
  const acrossNext = offset + gap * sinOf(width * 1.5) + slack;
  const along = gap + slack;
  const row = Math.max(across, 0.01);
  // -1: a piece of no length, which joins only by lying on another's line;
  // -2: a piece with an endless or missing point, which never joins.
  const binOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i] as number;
    if (!Number.isFinite(l)) {
      binOf[i] = -2;
      continue;
    }
    if (l === 0) {
      binOf[i] = Number.isFinite(
        (segs[i * 4] as number) + (segs[i * 4 + 1] as number),
      )
        ? -1
        : -2;
      continue;
    }
    let t = Math.atan2(
      (segs[i * 4 + 3] as number) - (segs[i * 4 + 1] as number),
      (segs[i * 4 + 2] as number) - (segs[i * 4] as number),
    );
    if (t < 0) t += Math.PI;
    binOf[i] = Math.min(bins - 1, Math.max(0, Math.floor(t / width)));
  }
  const perBin = new Int32Array(bins);
  for (let i = 0; i < n; i++) {
    const b = binOf[i] as number;
    if (b >= 0) perBin[b] = (perBin[b] as number) + 1;
  }
  // File every end by bin and row across, in a compressed table.
  const rowKey = (b: number, x: number, y: number) =>
    Math.floor((y * (cos[b] as number) - x * (sin[b] as number)) / row) * bins +
    b;
  const rowOf = new Map<number, number>();
  const endRow = new Int32Array(n * 2).fill(-1);
  let rows = 0;
  for (let i = 0; i < n; i++) {
    const b = binOf[i] as number;
    if (b < 0) continue;
    for (let e = 0; e < 2; e++) {
      const k = rowKey(
        b,
        segs[i * 4 + e * 2] as number,
        segs[i * 4 + e * 2 + 1] as number,
      );
      let r = rowOf.get(k);
      if (r === undefined) {
        r = rows++;
        rowOf.set(k, r);
      }
      endRow[i * 2 + e] = r;
    }
  }
  const start = new Int32Array(rows + 1);
  for (let k = 0; k < n * 2; k++) {
    const r = endRow[k] as number;
    if (r >= 0) start[r + 1] = (start[r + 1] as number) + 1;
  }
  for (let r = 0; r < rows; r++)
    start[r + 1] = (start[r + 1] as number) + (start[r] as number);
  const filled = start.slice(0, rows);
  const ends = new Int32Array(start[rows] as number);
  const at = new Float64Array(start[rows] as number);
  for (let k = 0; k < n * 2; k++) {
    const r = endRow[k] as number;
    if (r < 0) continue;
    const slot = filled[r] as number;
    filled[r] = slot + 1;
    const i = k >> 1;
    const b = binOf[i] as number;
    ends[slot] = k;
    at[slot] =
      (segs[k * 2] as number) * (cos[b] as number) +
      (segs[k * 2 + 1] as number) * (sin[b] as number);
  }
  // Sort each row along the bin's direction.
  for (let r = 0; r < rows; r++) {
    const lo = start[r] as number;
    const hi = start[r + 1] as number;
    if (hi - lo < 2) continue;
    if (hi - lo <= 24) {
      for (let p = lo + 1; p < hi; p++) {
        const v = at[p] as number;
        const k = ends[p] as number;
        let q = p - 1;
        while (q >= lo && (at[q] as number) > v) {
          at[q + 1] = at[q] as number;
          ends[q + 1] = ends[q] as number;
          q--;
        }
        at[q + 1] = v;
        ends[q + 1] = k;
      }
    } else {
      const order = Array.from({ length: hi - lo }, (_, p) => lo + p).sort(
        (p, q) => (at[p] as number) - (at[q] as number),
      );
      const sortedAt = order.map((p) => at[p] as number);
      const sortedEnds = order.map((p) => ends[p] as number);
      at.set(sortedAt, lo);
      ends.set(sortedEnds, lo);
    }
  }
  // Offer `join` the ends of bin b within `reach` across and the gap along
  // of end e of piece i, in bin b's frame; only pieces numbered above
  // `above`, so a pair within one bin is offered once.
  const near = (
    b: number,
    i: number,
    e: number,
    reach: number,
    above: number,
  ) => {
    if (!perBin[b]) return;
    const x = segs[i * 4 + e * 2] as number;
    const y = segs[i * 4 + e * 2 + 1] as number;
    const c = cos[b] as number;
    const s = sin[b] as number;
    const r = y * c - x * s;
    const t = x * c + y * s;
    const from = t - along;
    const to = t + along;
    const last = Math.floor((r + reach) / row);
    for (let cell = Math.floor((r - reach) / row); cell <= last; cell++) {
      const id = rowOf.get(cell * bins + b);
      if (id === undefined) continue;
      let lo = start[id] as number;
      const end = start[id + 1] as number;
      // The first end at or past `from`.
      let hi = end;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((at[mid] as number) < from) lo = mid + 1;
        else hi = mid;
      }
      for (let p = lo; p < end && (at[p] as number) <= to; p++) {
        const k = ends[p] as number;
        if (k >> 1 <= above) continue;
        // A row is wider than the reach, and the gap is a circle: a cheap
        // look first, before the whole test.
        const ox = segs[k * 2] as number;
        const oy = segs[k * 2 + 1] as number;
        if (Math.abs(oy * c - ox * s - r) > reach) continue;
        if ((ox - x) * (ox - x) + (oy - y) * (oy - y) > along * along) continue;
        join(i, e, k >> 1, k & 1);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    const b = binOf[i] as number;
    if (b === -2) continue;
    if (b === -1) {
      // A point joins a piece of any direction whose line it lies on.
      for (let other = 0; other < bins; other++) near(other, i, 0, across, -1);
      continue;
    }
    for (let e = 0; e < 2; e++) {
      near(b, i, e, across, i);
      if (bins > 1) near((b + 1) % bins, i, e, acrossNext, -1);
    }
  }
}
