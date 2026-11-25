// `symbols`: groups of small strokes and fills on chosen layers, counted by
// size and make-up. `render`: a picture of part of the sheet.

import { existsSync, writeFileSync } from 'node:fs';
import type { CommandInput } from '../cli/table.ts';
import { MM_PER_PT } from '../drawing/model.ts';
import { MAX_PNG_SIDE, renderPng } from '../drawing/png.ts';
import { PictureTooLarge, renderSvg } from '../drawing/svg.ts';
import { groupSymbols } from '../drawing/symbols.ts';
import { AxiError, usage } from '../errors.ts';
import {
  countLine,
  listOutput,
  plural,
  type Row,
  recordOutput,
} from '../output/views.ts';
import {
  areaOf,
  clipStrokes,
  deadlineOf,
  fillsOf,
  inArea,
  list,
  openSheet,
  paperMm,
  parseBox,
  pickLayer,
  positiveInt,
  positiveNumber,
  resolvePath,
  round,
  save,
  scaleOf,
  str,
  strokesOf,
} from './common.ts';

export function symbols(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const specs = list(input.values, 'layer');
  if (!specs.length)
    throw usage(
      'Name the layers to look at: --layer <layer>. Run `drawing-axi layers <file.pdf>` for the names.',
    );
  const picks = specs.map((s) => pickLayer(sheet, s));
  const joinMm = positiveNumber(input.values, 'join', 1.5, 50);
  const maxMm = positiveNumber(input.values, 'max-piece', 30, 2000);
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const area = areaOf(input.values);
  let ptPerM: number | null = null;
  try {
    ptPerM = scaleOf(input.values, sheet).ptPerM;
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== 'scale_unknown')
      throw error;
  }
  // Each layer is grouped on its own: a symbol is drawn on one layer, and
  // pieces of two layers that touch are two things.
  const sizeText = (w: number, h: number): string =>
    ptPerM === null
      ? `${w} x ${h} mm on paper`
      : `${round(w / MM_PER_PT / ptPerM, 2)} x ${round(h / MM_PER_PT / ptPerM, 2)} m`;
  const kinds = new Map<
    string,
    {
      layer: string;
      w: number;
      h: number;
      parts: number;
      count: number;
      x: number;
      y: number;
    }
  >();
  const places: Row[] = [];
  let total = 0;
  for (const pick of picks) {
    const groups = groupSymbols(
      clipStrokes(strokesOf(sheet, pick), area),
      fillsOf(sheet, pick).filter((f) =>
        inArea(area, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2),
      ),
      { join: paperMm(joinMm), maxPiece: paperMm(maxMm) },
    );
    total += groups.length;
    for (const g of groups) {
      const a = Math.round((g.x1 - g.x0) * MM_PER_PT * 2) / 2;
      const b = Math.round((g.y1 - g.y0) * MM_PER_PT * 2) / 2;
      // A symbol and its quarter turn are one kind.
      const w = Math.max(a, b);
      const h = Math.min(a, b);
      const x = (g.x0 + g.x1) / 2;
      const y = (g.y0 + g.y1) / 2;
      places.push({
        layer: pick.name,
        size: sizeText(w, h),
        parts: g.parts,
        x: Math.round(x),
        y: Math.round(y),
      });
      const key = `${pick.name}|${w}|${h}|${g.parts}`;
      const k = kinds.get(key);
      if (k) k.count++;
      else
        kinds.set(key, {
          layer: pick.name,
          w,
          h,
          parts: g.parts,
          count: 1,
          x,
          y,
        });
    }
  }
  const rows: Row[] = [...kinds.values()]
    .sort((a, b) => b.count - a.count || b.parts - a.parts)
    .map((k) => ({
      size: sizeText(k.w, k.h),
      parts: k.parts,
      count: k.count,
      first_at: `${Math.round(k.x)},${Math.round(k.y)}`,
      layer: k.layer,
    }));
  // The saved copy holds every symbol's place, not only the first of a kind.
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    symbols: rows,
    places,
  });
  const shown = full ? rows : rows.slice(0, limit);
  return listOutput({
    key: 'symbols',
    summary: rows.length
      ? `${plural(total, 'symbol')} in ${countLine(shown.length, rows.length, 'kind')}, most frequent first`
      : '0 symbols: the layers hold no small group of strokes',
    head: {
      file: name,
      settings: `pieces within ${joinMm} mm on paper make one symbol; pieces over ${maxMm} mm on paper are lines and are left out`,
      saved,
    },
    rows: shown,
    // With one layer, every row is on it and the column would say nothing.
    columns:
      picks.length > 1
        ? ['size', 'parts', 'count', 'first_at', 'layer']
        : ['size', 'parts', 'count', 'first_at'],
    full,
    narrower:
      'drawing-axi symbols <file.pdf> --layer <layer> --region <x0,y0,x1,y1>',
    help: rows.length
      ? [
          'Run `drawing-axi render <file.pdf> --layer <layer> --region <x0,y0,x1,y1> --out <file.png>` around first_at to see what a kind is',
        ]
      : ['Run `drawing-axi layers <file.pdf>` for the layers with ink'],
  });
}

export function renderCommand(input: CommandInput): string {
  const outFlag = str(input.values, 'out');
  if (outFlag === undefined)
    throw usage('Name the picture to write: --out <file.png|file.svg>.');
  const png = /\.png$/i.test(outFlag);
  if (!png && !/\.svg$/i.test(outFlag))
    throw usage('--out must end in .png or .svg.');
  const out = resolvePath(input.io, outFlag);
  const force = input.values.force === true;
  const alreadyExists = () =>
    new AxiError(
      'exists',
      'A file is already at the --out path. Choose another name, or add --force to replace it.',
    );
  if (!force && existsSync(out)) throw alreadyExists();
  const { sheet, name } = openSheet(input);
  const picks = list(input.values, 'layer').map((s) => pickLayer(sheet, s));
  const regionFlag = str(input.values, 'region');
  const region =
    regionFlag === undefined
      ? { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height }
      : parseBox(regionFlag, 'region');
  if (Object.values(region).some((v) => Math.abs(v) > 1e9))
    throw usage(
      '--region coordinates must be within a billion points of the page origin.',
    );
  const width = positiveInt(input.values, 'width', 1600, 8000);
  const strokes = picks.length
    ? picks.flatMap((p) => strokesOf(sheet, p))
    : sheet.strokes;
  // On a CAD plot the labels are its stroke-font text; font text there is
  // mostly the background plan.
  const hasShx = sheet.labels.some((l) => l.source === 'shx');
  const shownLabels = sheet.labels.filter(
    (l) => l.source !== 'text' || !hasShx,
  );
  let picture: ReturnType<typeof renderSvg>;
  try {
    picture = renderSvg(strokes, shownLabels, {
      ...region,
      pictures: sheet.pictures,
      width,
      ...(png ? { maxSide: MAX_PNG_SIDE } : {}),
      labels: input.values.labels === true,
      grid: input.values.grid === true,
    });
  } catch (error) {
    if (error instanceof PictureTooLarge)
      throw new AxiError(
        'too_large',
        'That is too much to draw in one picture. Name fewer layers with --layer, or a smaller --region.',
      );
    throw error;
  }
  const deadline = deadlineOf(input.io) ?? Infinity;
  const image = png
    ? renderPng(
        picture.svg,
        picture.labels > 0 || input.values.grid === true,
        deadline - input.io.now().getTime(),
      )
    : picture.svg;
  try {
    writeFileSync(out, image, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw alreadyExists();
    throw new AxiError(
      'not_found',
      `The --out file cannot be written (${code ?? 'unknown error'}).`,
    );
  }
  const record: Row = {
    wrote: out,
    file: name,
    picture: `${picture.width} x ${picture.height} px, ${Buffer.byteLength(image)} bytes`,
    shows: `${picks.length ? plural(picks.length, 'layer') : 'every layer'}, ${plural(picture.strokes, 'stroke')}, ${plural(picture.labels, 'label')}`,
    region: `${Math.round(region.x0)},${Math.round(region.y0)},${Math.round(region.x1)},${Math.round(region.y1)}`,
  };
  return recordOutput(record, true, 'drawing-axi render', [
    ...(png
      ? []
      : [
          'Run `drawing-axi render <file.pdf> --out <file.png>` for a PNG preview',
        ]),
    'Run `drawing-axi render <file.pdf> --region <x0,y0,x1,y1> --labels --grid --out <file.png>` to zoom in with labels and a coordinate grid',
  ]);
}
