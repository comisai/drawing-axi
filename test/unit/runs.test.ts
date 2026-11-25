// The run builder looks up the pieces an end may join by direction and by
// the line they lie on. It must join exactly the pieces the plain search
// joined, and do it quickly on a sheet full of background hatching.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRuns, type RunOptions } from '../../src/drawing/runs.ts';
import { referenceRuns } from '../fixtures/runs-reference.ts';

/** A fixed generator, so a failing case fails again. */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Pieces of the kinds a sheet holds: dashed runs in every direction, runs
 * whose direction sits on the edge of the angle allowed, pieces a fraction
 * of a point off a line, pieces that meet end to end at a slant, repeats,
 * zero-length pieces, and random clutter.
 */
function pieces(random: () => number, count: number): Float64Array {
  const out: number[] = [];
  const push = (x0: number, y0: number, x1: number, y1: number) =>
    out.push(x0, y0, x1, y1);
  while (out.length / 4 < count) {
    const kind = Math.floor(random() * 7);
    const x = random() * 400;
    const y = random() * 300;
    if (kind <= 1) {
      // A dashed line, perhaps at an angle near a multiple of 4 degrees.
      const angle =
        kind === 0
          ? random() * Math.PI
          : Math.round(random() * 45) * ((4 * Math.PI) / 180) +
            (random() - 0.5) * 0.002;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const dash = 1 + random() * 8;
      const space = random() * 12;
      let t = 0;
      for (let k = 0; k < 2 + random() * 10; k++) {
        const wobble = (random() - 0.5) * 1.8;
        const turn = (random() - 0.5) * 0.15;
        push(
          x + ux * t - uy * wobble,
          y + uy * t + ux * wobble,
          x + (ux + turn * uy) * (t + dash),
          y + (uy - turn * ux) * (t + dash),
        );
        t += dash + space;
      }
    } else if (kind === 2) {
      // Short hatching, all one way.
      push(x, y, x + 6, y + 6);
    } else if (kind === 3) {
      // A piece and its repeat, perhaps reversed.
      const x1 = x + (random() - 0.5) * 50;
      const y1 = y + (random() - 0.5) * 50;
      push(x, y, x1, y1);
      if (random() < 0.5) push(x1, y1, x, y);
      else push(x, y, x1, y1);
    } else if (kind === 4) {
      // A zero-length piece, perhaps on a line.
      push(x, y, x, y);
    } else if (kind === 5) {
      // Two pieces of equal length end to end on one line.
      const ux = random() - 0.5;
      const uy = random() - 0.5;
      push(x, y, x + ux * 20, y + uy * 20);
      push(
        x + ux * (20 + random() * 4),
        y + uy * (20 + random() * 4),
        x + ux * 40,
        y + uy * 40,
      );
    } else {
      push(x, y, x + (random() - 0.5) * 30, y + (random() - 0.5) * 30);
    }
  }
  return Float64Array.from(out);
}

describe('Runs: the direction lookup joins what the plain search joins', () => {
  const settings: Array<{ name: string; options: RunOptions }> = [
    { name: 'the default gap', options: { gap: 8 * (72 / 25.4) } },
    { name: 'a small gap', options: { gap: 2 } },
    { name: 'a gap under a point', options: { gap: 0.4 } },
    { name: 'a wide offset', options: { gap: 10, offset: 3 } },
    { name: 'a narrow angle', options: { gap: 10, angle: 1 } },
    { name: 'a wide angle', options: { gap: 10, angle: 30 } },
    { name: 'an angle of 60 degrees', options: { gap: 10, angle: 60 } },
    { name: 'a right angle', options: { gap: 10, angle: 90 } },
  ];
  for (const { name, options } of settings) {
    it(`with ${name}`, () => {
      for (let round = 0; round < 12; round++) {
        const random = generator(1000 * round + name.length);
        const segs = pieces(random, 300 + round * 60);
        const letters = Array.from({ length: 25 }, () => ({
          x: random() * 400,
          y: random() * 300,
        }));
        const withLetters = { ...options, letters, letterGap: options.gap * 2 };
        for (const opts of [options, withLetters])
          assert.deepEqual(
            buildRuns(segs, opts),
            referenceRuns(segs, opts),
            `round ${round}${opts === withLetters ? ' with letters' : ''}`,
          );
      }
    });
  }

  it('on pieces that turn by nearly the angle allowed across a bin edge', () => {
    // A long piece just short of a direction bin's edge, and a short one just
    // past it, nearly the gap away and nearly the offset off the long one's
    // line: the farthest across its own frame an end that joins can lie.
    const bin = 180 / 44;
    const gap = 20;
    for (let m = 1; m < 44; m++)
      for (const reach of [0.6, 0.95, 0.99])
        for (const side of [-1, 1]) {
          const edge = (m * bin * Math.PI) / 180;
          const ux = Math.cos(edge - (3.95 * Math.PI) / 180);
          const uy = Math.sin(edge - (3.95 * Math.PI) / 180);
          const px = 200 + 100 * ux;
          const py = 200 + 100 * uy;
          const qx = px + gap * reach * ux - side * 0.79 * uy;
          const qy = py + gap * reach * uy + side * 0.79 * ux;
          const turn = edge + (0.01 * Math.PI) / 180;
          const segs = Float64Array.from([
            200,
            200,
            px,
            py,
            qx,
            qy,
            qx + 1.5 * Math.cos(turn),
            qy + 1.5 * Math.sin(turn),
          ]);
          assert.deepEqual(
            buildRuns(segs, { gap }),
            referenceRuns(segs, { gap }),
            `edge ${m}, ${reach} of the gap, side ${side}`,
          );
        }
  });

  it('on pieces far off the sheet and on a point that is not a number', () => {
    const segs = Float64Array.from([
      0,
      0,
      10,
      0,
      12,
      0,
      30,
      0,
      1e6,
      1e6,
      1e6 + 10,
      1e6,
      1e6 + 12,
      1e6,
      1e6 + 30,
      1e6,
      -9e5,
      3,
      -9e5 + 20,
      3,
      Number.NaN,
      0,
      5,
      0,
    ]);
    assert.deepEqual(
      buildRuns(segs, { gap: 5 }),
      referenceRuns(segs, { gap: 5 }),
    );
  });

  it('leaves out a piece with an endless point instead of hanging', () => {
    const segs = Float64Array.from([
      0,
      0,
      10,
      0,
      12,
      0,
      30,
      0,
      31,
      0,
      Number.POSITIVE_INFINITY,
      0,
    ]);
    const runs = buildRuns(segs, { gap: 5 });
    assert.equal(runs[0]?.length, 30);
  });

  it('on no pieces at all', () => {
    assert.deepEqual(buildRuns(new Float64Array(0), { gap: 5 }), []);
  });
});

describe('Runs: dense background hatching', () => {
  it('builds runs over 150,000 hatching strokes in a few seconds', () => {
    // Light hatching all one way, as a background fills a sheet with, and a
    // dashed pipe through it.
    const random = generator(7);
    const out: number[] = [];
    for (let i = 0; i < 150_000; i++) {
      const x = 50 + random() * 2400;
      const y = 50 + random() * 1200;
      out.push(x, y, x + 6, y + 6);
    }
    for (let x = 100; x < 1900; x += 9) out.push(x, 500.3, x + 6, 500.3);
    const segs = Float64Array.from(out);
    const started = performance.now();
    const runs = buildRuns(segs, { gap: 8 * (72 / 25.4) });
    const took = performance.now() - started;
    assert.ok(
      runs.some((r) => r.length > 1790 && Math.abs(r.y0 - 500.3) < 0.01),
      'the pipe is one run',
    );
    // On one machine the plain search took 1.4 s for this and the lookup by
    // direction 0.5 s. The bound is loose, for slow machines: it catches a
    // return to work that grows with the density of the hatching.
    assert.ok(took < 2500, `took ${Math.round(took)} ms`);
  });
});
