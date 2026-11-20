// A legend row is a caption with a short sample line beside it, and the
// sample is drawn on the layer it stands for. Pairing each caption with the
// sample on its row says which layer and colour carries which system, in the
// drawing's own words.

import type { Label, Stroke } from './model.ts';
import { buildRuns, segmentsOf } from './runs.ts';

export interface LegendEntry {
  text: string;
  layer: number;
  color: number;
  /** The caption's place. */
  x: number;
  y: number;
}

export interface LegendOptions {
  /** Join the dashes of a sample up to this far apart, in points. */
  gap: number;
  /** A sample is at least and at most this long, in points. */
  minSample: number;
  maxSample: number;
  /** A sample is at most this far from its caption, in points. */
  reach: number;
  /** Find the legend by its column of samples, instead of taking every row. */
  aligned: boolean;
}

interface Sample {
  layer: number;
  color: number;
  x0: number;
  x1: number;
  y: number;
}

export function readLegend(
  strokes: readonly Stroke[],
  labels: readonly Label[],
  options: LegendOptions,
): LegendEntry[] {
  const buckets = new Map<string, Stroke[]>();
  for (const stroke of strokes) {
    const key = `${stroke.layer}|${stroke.color}`;
    const list = buckets.get(key);
    if (list) list.push(stroke);
    else buckets.set(key, [stroke]);
  }
  const cell = 64;
  // Stroke-font text is drawn as strokes too. A layer and colour whose strokes
  // mostly sit inside label boxes is lettering, and holds no samples.
  const boxes = new Map<number, Label[]>();
  for (const label of labels) {
    for (
      let gx = Math.floor(label.x0 / cell);
      gx <= Math.floor(label.x1 / cell);
      gx++
    ) {
      for (
        let gy = Math.floor(label.y0 / cell);
        gy <= Math.floor(label.y1 / cell);
        gy++
      ) {
        const k = gx * 100_003 + gy;
        const list = boxes.get(k);
        if (list) list.push(label);
        else boxes.set(k, [label]);
      }
    }
  }
  const isLettering = (list: Stroke[]): boolean => {
    let inside = 0;
    for (const stroke of list) {
      const p = stroke.pts;
      const x = ((p[0] as number) + (p[p.length - 2] as number)) / 2;
      const y = ((p[1] as number) + (p[p.length - 1] as number)) / 2;
      const near = boxes.get(
        Math.floor(x / cell) * 100_003 + Math.floor(y / cell),
      );
      if (
        near?.some(
          (l) =>
            x >= l.x0 - 1 && x <= l.x1 + 1 && y >= l.y0 - 1 && y <= l.y1 + 1,
        )
      )
        inside++;
    }
    return inside > list.length * 0.25;
  };
  const rows = new Map<number, Sample[]>();
  for (const list of buckets.values()) {
    if (isLettering(list)) continue;
    const first = list[0] as Stroke;
    for (const run of buildRuns(segmentsOf(list), { gap: options.gap })) {
      if (Math.abs(run.y1 - run.y0) > 1) continue;
      if (run.length < options.minSample || run.length > options.maxSample)
        continue;
      const sample: Sample = {
        layer: first.layer,
        color: first.color,
        x0: Math.min(run.x0, run.x1),
        x1: Math.max(run.x0, run.x1),
        y: (run.y0 + run.y1) / 2,
      };
      const k = Math.floor(sample.y / cell);
      const row = rows.get(k);
      if (row) row.push(sample);
      else rows.set(k, [sample]);
    }
  }
  const pairs: Array<{ label: Label; sample: Sample }> = [];
  for (const label of labels) {
    const text = label.text.trim();
    // A caption is words, not a number or a single mark.
    if ([...text].filter((c) => /\p{L}/u.test(c)).length < 3) continue;
    if (label.vertical) continue;
    const cy = (label.y0 + label.y1) / 2;
    const half = (label.y1 - label.y0) / 2;
    const k = Math.floor(cy / cell);
    for (const dk of [-1, 0, 1]) {
      for (const sample of rows.get(k + dk) ?? []) {
        if (Math.abs(sample.y - cy) > half * 0.9) continue;
        const gap =
          sample.x1 <= label.x0
            ? label.x0 - sample.x1
            : sample.x0 >= label.x1
              ? sample.x0 - label.x1
              : -1;
        if (gap < 0 || gap > options.reach) continue;
        pairs.push({ label, sample });
      }
    }
  }
  let kept = pairs;
  if (options.aligned) {
    // A legend's samples are one length and start in one column. The column
    // most captions share is the legend; rows beside it belong to it too.
    const columnOf = (sample: Sample) =>
      `${Math.round(sample.x0 / 4)}|${Math.round((sample.x1 - sample.x0) / 4)}`;
    interface Column {
      labels: Set<Label>;
      /** The layers and colours its samples are drawn in. */
      kinds: Set<string>;
      x0: number;
    }
    const columns = new Map<string, Column>();
    for (const { label, sample } of pairs) {
      const kind = `${sample.layer}|${sample.color}`;
      const column = columns.get(columnOf(sample));
      if (column) {
        column.labels.add(label);
        column.kinds.add(kind);
      } else
        columns.set(columnOf(sample), {
          labels: new Set([label]),
          kinds: new Set([kind]),
          x0: sample.x0,
        });
    }
    // A legend shows many systems, so its samples differ; a table of notes
    // with ruled lines does not.
    let best: Column | null = null;
    for (const column of columns.values())
      if (
        !best ||
        column.kinds.size > best.kinds.size ||
        (column.kinds.size === best.kinds.size &&
          column.labels.size > best.labels.size)
      )
        best = column;
    if (!best || best.labels.size < 3 || best.kinds.size < 2) return [];
    let top = Infinity;
    let bottom = -Infinity;
    for (const label of best.labels) {
      top = Math.min(top, label.y0);
      bottom = Math.max(bottom, label.y1);
    }
    const x0 = best.x0;
    kept = pairs.filter(
      ({ label, sample }) =>
        Math.abs(sample.x0 - x0) <= 40 &&
        label.y1 >= top - 60 &&
        label.y0 <= bottom + 60,
    );
  }
  const seen = new Set<string>();
  const entries: LegendEntry[] = [];
  for (const { label, sample } of kept) {
    const key = `${label.x0},${label.y0}|${sample.layer}|${sample.color}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      text: label.text.trim(),
      layer: sample.layer,
      color: sample.color,
      x: (label.x0 + label.x1) / 2,
      y: (label.y0 + label.y1) / 2,
    });
  }
  entries.sort((a, b) => a.y - b.y || a.x - b.x);
  return entries;
}
