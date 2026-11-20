// `layers`: every layer with the length of straight runs drawn on it. The
// layers that carry pipes stand out: long runs, one colour.

import type { CommandInput } from '../cli/table.ts';
import { colorHex, type Stroke } from '../drawing/model.ts';
import { buildRuns, segmentsOf } from '../drawing/runs.ts';
import { AxiError } from '../errors.ts';
import { countLine, listOutput, type Row } from '../output/views.ts';
import {
  areaOf,
  clipStrokes,
  openSheet,
  paperMm,
  positiveInt,
  positiveNumber,
  round,
  scaleOf,
  str,
} from './common.ts';
import { scaleLine } from './info.ts';

export function layers(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const split = input.values.split === true;
  const match = str(input.values, 'match')?.toLowerCase();
  const limit = positiveInt(input.values, 'limit', 20);
  const gap = paperMm(positiveNumber(input.values, 'gap', 8, 100));
  const min = paperMm(positiveNumber(input.values, 'min', 6, 1000));
  const area = areaOf(input.values);
  let ptPerM: number | null = null;
  let scaleText = 'not stated; lengths are left out, pass --scale 1:N';
  try {
    const scale = scaleOf(input.values, sheet);
    ptPerM = scale.ptPerM;
    scaleText = scaleLine(scale);
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== 'scale_unknown')
      throw error;
  }
  const buckets = new Map<
    string,
    { layer: number; color: number | null; strokes: Stroke[] }
  >();
  for (const stroke of clipStrokes(sheet.strokes, area)) {
    const key = split ? `${stroke.layer}|${stroke.color}` : `${stroke.layer}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.strokes.push(stroke);
    else
      buckets.set(key, {
        layer: stroke.layer,
        color: split ? stroke.color : null,
        strokes: [stroke],
      });
  }
  const rows: Row[] = [];
  for (const bucket of buckets.values()) {
    const layerName = sheet.layers[bucket.layer]?.name ?? '(no layer)';
    if (match && !layerName.toLowerCase().includes(match)) continue;
    let runLength = 0;
    for (const run of buildRuns(segmentsOf(bucket.strokes), { gap }))
      if (run.length >= min) runLength += run.length;
    // The colour most of the layer's ink is drawn in.
    const inkByColor = new Map<number, number>();
    for (const stroke of bucket.strokes) {
      const p = stroke.pts;
      let ink = 0;
      for (let i = 0; i + 3 < p.length; i += 2)
        ink += Math.hypot(
          (p[i + 2] as number) - (p[i] as number),
          (p[i + 3] as number) - (p[i + 1] as number),
        );
      inkByColor.set(stroke.color, (inkByColor.get(stroke.color) ?? 0) + ink);
    }
    const colors = [...inkByColor].sort((a, b) => b[1] - a[1]);
    const top = colors[0] as [number, number];
    rows.push({
      layer: sheet.layers[bucket.layer]?.hidden
        ? `${layerName} (switched off)`
        : layerName,
      run_m: ptPerM === null ? null : round(runLength / ptPerM, 1),
      strokes: bucket.strokes.length,
      color:
        colors.length > 1
          ? `${colorHex(top[0])} +${colors.length - 1}`
          : colorHex(top[0]),
      _sort: runLength,
    });
  }
  rows.sort(
    (a, b) =>
      (b._sort as number) - (a._sort as number) ||
      String(a.layer).localeCompare(String(b.layer)),
  );
  const shown = input.values.full === true ? rows : rows.slice(0, limit);
  const what = split ? 'layer and colour' : 'layer';
  const whats = split ? 'layers and colours' : 'layers';
  return listOutput({
    key: 'layers',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, what, whats)} with ink${match ? ' matching the text' : ''}, longest runs first`
      : match
        ? `0 layers match; the sheet has ${sheet.layers.length}`
        : '0 layers with ink',
    head: { file: name, scale: scaleText },
    rows: shown,
    columns: ['layer', 'run_m', 'strokes', 'color'],
    full: input.values.full === true,
    narrower: 'drawing-axi layers <file.pdf> --match <text>',
    help: rows.length
      ? [
          'Run `drawing-axi layers <file.pdf> --split --match <layer>` when one layer shows more than one colour',
          'Run `drawing-axi measure <file.pdf> --group <name>=<layer>` to measure a layer by pipe size',
          'Run `drawing-axi render <file.pdf> --layer <layer> --out <file.svg>` to see what a layer draws',
        ]
      : ['Run `drawing-axi layers <file.pdf>` without --match for every layer'],
  });
}
