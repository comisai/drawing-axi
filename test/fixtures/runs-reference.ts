// The run builder as it was before it looked up neighbours by direction:
// every end within the gap, in a square grid. Tests compare the faster
// builder in src/drawing/runs.ts with it; both must join the same pieces.

import type { Run, RunOptions } from '../../src/drawing/runs.ts';

const MIN_PIECE = 0.3;
const LETTER_WORK = 20_000_000;

export function referenceRuns(segs: Float64Array, options: RunOptions): Run[] {
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
