// `layers`: every layer with the length of straight runs drawn on it. The
// layers that carry pipes stand out: long runs, one colour. Split by colour,
// or by colour and line style where one grey holds more than one system.

import type { CommandInput } from '../cli/table.ts';
import {
  colorHex,
  type Stroke,
  styleText,
  widthKey,
} from '../drawing/model.ts';
import { buildRuns, segmentsOf } from '../drawing/runs.ts';
import { AxiError, usage } from '../errors.ts';
import { countLine, listOutput, type Row } from '../output/views.ts';
import {
  areaOf,
  clipStrokes,
  inkOf,
  inkText,
  LETTER_GAPS,
  linetypeLetters,
  NO_LAYER,
  openSheet,
  paperMm,
  positiveInt,
  positiveNumber,
  round,
  STYLE_SPLIT,
  save,
  scaleOf,
  str,
} from './common.ts';
import { scaleLine } from './info.ts';

export function layers(input: CommandInput): string {
  const by = str(input.values, 'by')?.toLowerCase();
  if (by !== undefined && !['color', 'colour', 'style'].includes(by))
    throw usage(
      '--by takes color, for one row per colour of each layer, or style, for one row per colour, line width and dash.',
    );
  const byStyle = by === 'style';
  const split = input.values.split === true || by !== undefined;
  const { sheet, name } = openSheet(input);
  const match = str(input.values, 'match')?.toLowerCase();
  const limit = positiveInt(input.values, 'limit', 20);
  const gap = paperMm(positiveNumber(input.values, 'gap', 8, 100));
  const min = paperMm(positiveNumber(input.values, 'min', 6, 1000));
  const area = areaOf(input.values);
  const own = input.values.own === true;
  const letters = linetypeLetters(sheet);
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
  const buckets = new Map<string, { layer: number; strokes: Stroke[] }>();
  for (const stroke of clipStrokes(sheet.strokes, area)) {
    const key = byStyle
      ? `${stroke.layer}|${stroke.color}|${widthKey(stroke.width)}|${stroke.dash}`
      : split
        ? `${stroke.layer}|${stroke.color}`
        : `${stroke.layer}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.strokes.push(stroke);
    else buckets.set(key, { layer: stroke.layer, strokes: [stroke] });
  }
  const rows: Row[] = [];
  for (const bucket of buckets.values()) {
    const layerName = sheet.layers[bucket.layer]?.name ?? NO_LAYER;
    if (match && !layerName.toLowerCase().includes(match)) continue;
    // A layer brought in from a referenced file carries that file's name
    // before a bar: the architect's background, mostly.
    if (own && layerName.includes('|')) continue;
    let runLength = 0;
    for (const run of buildRuns(segmentsOf(bucket.strokes), {
      gap,
      letters,
      letterGap: gap * LETTER_GAPS,
    }))
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
    // Split by style, a row is named by the selector the measuring commands
    // take: `(no layer)@#666666 w0.70 solid`.
    const named = byStyle
      ? `${layerName}@${colorHex(top[0])} ${styleText(bucket.strokes[0] as Stroke)}`
      : layerName;
    rows.push({
      layer: sheet.layers[bucket.layer]?.hidden
        ? `${named} (switched off)`
        : named,
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
  // On a sheet in greys, colour will not tell systems apart; line style may.
  const ink = inkOf(sheet.strokes);
  const inkNote =
    ink.greyscale && !byStyle
      ? `${inkText(ink)}; colour will not tell systems apart. Run \`${STYLE_SPLIT}\` to split by line width and dash too`
      : null;
  const columns = byStyle
    ? ['layer', 'run_m', 'strokes']
    : ['layer', 'run_m', 'strokes', 'color'];
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    scale: scaleText,
    ...(inkNote ? { ink: inkNote } : {}),
    layers: rows.map(({ _sort, ...row }) =>
      byStyle
        ? { layer: row.layer, run_m: row.run_m, strokes: row.strokes }
        : row,
    ),
  });
  const shown = input.values.full === true ? rows : rows.slice(0, limit);
  const what = byStyle
    ? 'layer and line style'
    : split
      ? 'layer and colour'
      : 'layer';
  const whats = byStyle
    ? 'layers and line styles'
    : split
      ? 'layers and colours'
      : 'layers';
  return listOutput({
    key: 'layers',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, what, whats)} with ink${match ? ' matching the text' : ''}, longest runs first`
      : match
        ? `0 layers match; the sheet has ${sheet.layers.length}`
        : '0 layers with ink',
    head: { file: name, scale: scaleText, ink: inkNote, saved },
    rows: shown,
    columns,
    full: input.values.full === true,
    narrower: 'drawing-axi layers <file.pdf> --match <text>',
    help: rows.length
      ? byStyle
        ? [
            "Run `drawing-axi measure <file.pdf> --group <name>='<layer>@#rrggbb w0.70 solid'` with a row's layer as printed, one group per system",
            "Run `drawing-axi render <file.pdf> --layer '<layer>@#rrggbb w0.70 solid' --out <file.png>` to see what one line style draws",
          ]
        : [
            ...(inkNote
              ? [
                  `Run \`${STYLE_SPLIT}\` for one row per colour, line width and dash`,
                ]
              : [
                  'Run `drawing-axi layers <file.pdf> --split --match <layer>` when one layer shows more than one colour',
                ]),
            'Run `drawing-axi measure <file.pdf> --group <name>=<layer> --group <name>=<layer>` to measure by pipe size, every system in one command',
            'Run `drawing-axi render <file.pdf> --layer <layer> --out <file.png>` to see what a layer draws',
          ]
      : ['Run `drawing-axi layers <file.pdf>` without --match for every layer'],
  });
}
